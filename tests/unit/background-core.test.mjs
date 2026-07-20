import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const backgroundSource = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); }, trigger(...args) { return listeners.map((listener) => listener(...args)); } };
}

function createStorage(seed, failures = {}, delays = {}) {
  const state = structuredClone(seed);
  const area = (name) => ({
    async get(keys) {
      const source = state[name];
      const selected = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(source);
      return Object.fromEntries(selected.filter((key) => key in source).map((key) => [key, structuredClone(source[key])]));
    },
    async set(values) {
      if (failures[`${name}:set`]?.(values)) throw new Error(`${name} set failed`);
      Object.assign(state[name], structuredClone(values));
    },
    async remove(keys) {
      const values = Array.isArray(keys) ? keys : [keys];
      if (failures[`${name}:remove`]?.(values)) throw new Error(`${name} remove failed`);
      values.forEach((key) => delete state[name][key]);
    },
    async setAccessLevel() {
      await delays[`${name}:access`]?.();
      if (failures[`${name}:access`]?.()) throw new Error("access denied");
    },
  });
  return { state, local: area("local"), session: area("session") };
}

async function loadWorker({ seed = { local: {}, session: {} }, failures = {}, delays = {}, tabs = [{ id: 1, windowId: 1, url: "https://leetcode.com/problems/two-sum/" }], selection = "", templates = {}, knowledge = [], waitForReady = true } = {}) {
  const storage = createStorage(seed, failures, delays);
  const actionCalls = [];
  const scriptingCalls = [];
  const tabMessages = [];
  const chrome = {
    storage,
    runtime: {
      id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`,
      onInstalled: event(), onStartup: event(), onConnect: event(), onMessage: event(),
    },
    contextMenus: { removeAll(callback) { callback(); }, create() {}, onClicked: event() },
    action: { onClicked: event(), setBadgeText(value) { actionCalls.push(["badge", value]); }, setBadgeBackgroundColor() {}, setTitle(value) { actionCalls.push(["title", value]); } },
    sidePanel: { open() { actionCalls.push(["open"]); return Promise.resolve(); } },
    tabs: {
      onRemoved: event(), onUpdated: event(), onActivated: event(),
      async query(query) { return tabs.filter((tab) => (!query?.windowId || tab.windowId === query.windowId) && (!query?.active || tab.active !== false)); },
      async sendMessage(...args) { tabMessages.push(args); throw new Error("No content script in this unit harness"); },
    },
    windows: { onFocusChanged: event(), async get(id) { if (!tabs.some((tab) => tab.windowId === id)) throw new Error("missing window"); return { id }; } },
    scripting: { async executeScript(...args) { scriptingCalls.push(args); return [{ result: { selected: selection, sourceUrl: tabs[0]?.url || "" } }]; } },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, URL, setTimeout, clearTimeout, console, importScripts() {}, TEMPLATES: templates, COACHING_KNOWLEDGE: knowledge });
  vm.runInContext(`${backgroundSource}\nglobalThis.__core = { credentialReady, sessionReady, resolveCredential, nextGeneration, setCredential, setCredentialMode, deleteCredential, deleteRollbackMessage, activeCredential, credentialState, clipCapture, capHistory, historyBytes, promptFor, validateReply, validatedFieldsOnly, commitSession, readSessions, touch, publicSession, pushSession, launchCoach, captureFor, findSessionForTab, templateOutcome, sessionForPort, handlePanelMessage, beginProviderRequest, rehydrateSessions, waitForSessionCommits, STAGE_FIELDS, MAX_CAPTURE, MAX_HISTORY_BYTES, CREDENTIAL_KEY, SESSION_KEY };`, context, { filename: "background.js" });
  if (waitForReady) {
    await context.__core.credentialReady;
    await context.__core.sessionReady;
  }
  return { core: context.__core, context, chrome, storage, actionCalls, scriptingCalls, tabMessages, tabs };
}

async function runtimeMessage(chrome, message, sender) {
  let response;
  let responded = false;
  const listener = chrome.runtime.onMessage.listeners[0];
  const keptAlive = listener(message, sender, (value) => { response = value; responded = true; });
  if (!keptAlive) return { keptAlive, responded, response };
  for (let index = 0; index < 20 && !responded; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { keptAlive, responded, response };
}

function panelPort(sender) {
  const onMessage = event();
  const onDisconnect = event();
  return {
    name: "coach-panel", sender, onMessage, onDisconnect, posts: [], disconnected: false,
    postMessage(message) { this.posts.push(message); },
    disconnect() { this.disconnected = true; onDisconnect.trigger(); },
  };
}

describe("background worker core", () => {
  it("resolves credentials by global tombstone and generation", async () => {
    const { core } = await loadWorker();
    const state = { local: { "dsaCoach.credential": { gen: 10, key: "local" }, "dsaCoach.credTombstone": { gen: 8 } }, session: { "dsaCoach.credential": { gen: 9, key: "session" }, "dsaCoach.credTombstone": { gen: 7 } } };
    expect(core.resolveCredential(state)).toMatchObject({ gen: 10, key: "local" });
    state.local["dsaCoach.credTombstone"] = { gen: 10 };
    expect(core.resolveCredential(state)).toBeNull();
  });

  it("serializes simultaneous saves with a single active highest generation", async () => {
    const { core } = await loadWorker();
    await Promise.all([
      core.setCredential({ apiKey: "first-key", persistent: false }),
      core.setCredential({ apiKey: "second-key", persistent: false }),
    ]);
    expect((await core.activeCredential()).key).toBe("second-key");
    expect((await core.activeCredential()).gen).toBe(1);
  });

  it("holds credential messages behind startup reconciliation", async () => {
    let releaseRestriction;
    const restrictionPending = new Promise((resolve) => { releaseRestriction = resolve; });
    const { core, chrome, storage } = await loadWorker({
      waitForReady: false,
      delays: { "local:access": () => restrictionPending },
    });
    let response;
    const keptAlive = chrome.runtime.onMessage.listeners[0](
      { type: "credential:set", apiKey: "queued-key", persistent: false },
      { id: "test-extension", url: "chrome-extension://test-extension/options.html" },
      (value) => { response = value; },
    );
    expect(keptAlive).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.state.session[core.CREDENTIAL_KEY]).toBeUndefined();
    releaseRestriction();
    await core.credentialReady;
    for (let index = 0; index < 20 && !response; index++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(response).toMatchObject({ ok: true });
    expect(storage.state.session[core.CREDENTIAL_KEY]).toMatchObject({ key: "queued-key" });
  });

  it("uses a durable local tombstone before deleting a stale session copy", async () => {
    const failures = { "session:remove": (keys) => keys.includes("dsaCoach.credential") };
    const { core, storage } = await loadWorker({ seed: { local: { "dsaCoach.credential": { gen: 10, key: "live" } }, session: { "dsaCoach.credential": { gen: 9, key: "stale" } } }, failures });
    const result = await core.deleteCredential();
    expect(result.deleted).toBe(true);
    expect(storage.state.local["dsaCoach.credTombstone"].gen).toBeGreaterThan(10);
    expect((await core.activeCredential())).toBeNull();
  });

  it("does not remove a local envelope when its delete guard cannot be written", async () => {
    const failures = { "local:set": (values) => "dsaCoach.credTombstone" in values };
    const { core, storage } = await loadWorker({ seed: { local: { "dsaCoach.credential": { gen: 3, key: "still-live" } }, session: {} }, failures });
    await expect(core.deleteCredential()).rejects.toThrow("existing key remains active");
    expect(storage.state.local["dsaCoach.credential"].key).toBe("still-live");
    expect((await core.activeCredential()).key).toBe("still-live");
  });

  it("reports the session-only failed-rollback state without claiming deletion", async () => {
    const failures = {
      "local:set": (values) => "dsaCoach.credTombstone" in values,
      "session:remove": (keys) => keys.includes("dsaCoach.credTombstone"),
    };
    const { core, storage } = await loadWorker({ seed: { local: { "dsaCoach.credential": { gen: 3, key: "still-live" } }, session: {} }, failures });
    await expect(core.deleteCredential()).rejects.toThrow("disabled this session and may return after browser restart");
    expect(storage.state.local["dsaCoach.credential"].key).toBe("still-live");
  });

  it("uses honest wording for either surviving rollback tombstone", async () => {
    const { core } = await loadWorker();
    expect(core.deleteRollbackMessage({ rollbackLocal: false, rollbackSession: true })).toContain("stays disabled");
    expect(core.deleteRollbackMessage({ rollbackLocal: true, rollbackSession: false })).toContain("may return after browser restart");
  });

  it("refuses a persistent save while the persistent area is unhealthy", async () => {
    const { core, storage } = await loadWorker({ failures: { "local:access": () => true } });
    await expect(core.setCredential({ apiKey: "blocked-key", persistent: true })).rejects.toThrow("unavailable or unhealthy");
    expect(storage.state.local[core.CREDENTIAL_KEY]).toBeUndefined();
  });

  it("puts previous learner and coach turns into the next provider request", async () => {
    const { core } = await loadWorker();
    const messages = core.promptFor({ stageIndex: 2, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [
      { role: "user", text: "I think a hash map." },
      { role: "coach", question: "What invariant would it keep?", matchedPatternId: "two-pointers" },
    ] }, "It stores complements.");
    expect(messages.map((message) => message.content).join("\n")).toContain("I think a hash map.");
    expect(messages.map((message) => message.content).join("\n")).toContain("What invariant would it keep?");
    expect(messages.at(-1).content).toContain("It stores complements.");
    expect(messages.map((message) => message.content).join("\n")).not.toContain("two-pointers");
  });

  it("keeps a saved key out of prompts, panel state, and credential responses", async () => {
    const { core, chrome } = await loadWorker();
    const secret = "credential-leak-check";
    const saved = await runtimeMessage(chrome, { type: "credential:set", apiKey: secret, persistent: false }, { id: "test-extension", url: "chrome-extension://test-extension/options.html" });
    expect(JSON.stringify(saved.response)).not.toContain(secret);
    expect(JSON.stringify(core.promptFor({ stageIndex: 0, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [] }, "Help"))).not.toContain(secret);
    expect(JSON.stringify(core.publicSession({ id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { title: "Two Sum" }, key: secret }))).not.toContain(secret);
  });

  it("enforces pre-code response policy and retains only clean fallback fields", async () => {
    const { core } = await loadWorker();
    expect(() => core.validateReply(JSON.stringify({ discussion: "```js\nreturn x;\n```" }), 0)).toThrow("code too early");
    expect(core.validatedFieldsOnly(JSON.stringify({ discussion: "Reason about the invariant.", hint: "for (let i = 0; i < n; i++)" }), 0)).toEqual({ matchedPatternId: "", discussion: "Reason about the invariant." });
  });

  it("clips captures in field priority order and caps UTF-8 history bytes", async () => {
    const { core } = await loadWorker();
    const clipped = core.clipCapture({ title: "T".repeat(20), constraints: "C".repeat(9000), examples: "E", description: "D" });
    expect(clipped.title).toHaveLength(20);
    expect(clipped.constraints).toHaveLength(core.MAX_CAPTURE - 20);
    expect(clipped.examples).toBe("");
    const session = { history: [{ text: "😀".repeat(40000) }] };
    core.capHistory(session);
    expect(core.historyBytes(session.history)).toBeLessThanOrEqual(core.MAX_HISTORY_BYTES);
    expect(session.historyNotice).toContain("dropped");
  });

  it("serializes concurrent commits for different sessions without losing either", async () => {
    const { core } = await loadWorker();
    await Promise.all([
      core.commitSession((sessions) => { sessions.a = { id: "a", updatedAt: 1, revision: 1 }; return sessions.a; }),
      core.commitSession((sessions) => { sessions.b = { id: "b", updatedAt: 2, revision: 1 }; return sessions.b; }),
    ]);
    expect(Object.keys(await core.readSessions()).sort()).toEqual(["a", "b"]);
  });

  it("drops a late provider completion after reset instead of resurrecting the session", async () => {
    const { core, context } = await loadWorker();
    await core.setCredential({ apiKey: "session-key", persistent: false });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 0, history: [], epoch: 0, pendingRequest: null, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    let finish;
    context.providerChat = () => new Promise((resolve) => { finish = resolve; });
    await core.beginProviderRequest("s1", "Try a map");
    await core.commitSession((sessions) => { delete sessions.s1; return null; });
    finish('{"question":"What would the map store?","discussion":"Describe the lookup invariant."}');
    await Promise.resolve();
    await core.waitForSessionCommits();
    expect((await core.readSessions()).s1).toBeUndefined();
  });

  it("refuses a second provider request while the first one is pending", async () => {
    const { core, context } = await loadWorker();
    await core.setCredential({ apiKey: "session-key", persistent: false });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 0, history: [], epoch: 0, pendingRequest: null, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    let calls = 0;
    context.providerChat = () => { calls++; return new Promise(() => {}); };
    await core.beginProviderRequest("s1", "first");
    await core.beginProviderRequest("s1", "second");
    expect(calls).toBe(1);
    expect((await core.readSessions()).s1.error).toContain("already in progress");
  });

  it("takes the badge-only branch without a synchronous launch target", async () => {
    const { core, actionCalls } = await loadWorker();
    core.launchCoach();
    expect(actionCalls.some(([type]) => type === "open")).toBe(false);
    expect(actionCalls).toContainEqual(["badge", { text: "!" }]);
  });

  it("uses the executeScript selection path verbatim off LeetCode and marks an empty selection empty", async () => {
    const session = { tabId: 1, url: "https://example.test/problem", origin: "https://example.test" };
    const selected = "line one\n    indented line\nline three";
    const filled = await loadWorker({ tabs: [{ id: 1, windowId: 1, url: session.url }], selection: selected });
    const capture = await filled.core.captureFor(session);
    expect(filled.tabMessages).toHaveLength(0);
    expect(filled.scriptingCalls).toHaveLength(1);
    expect(capture.description).toBe(selected);
    expect(capture.title).toBe("Selected problem text");

    const empty = await loadWorker({ tabs: [{ id: 1, windowId: 1, url: session.url }], selection: "" });
    expect(await empty.core.captureFor(session)).toMatchObject({ title: "", description: "" });
  });

  it("prefers the structured LeetCode route before falling back to selection", async () => {
    const { core, tabMessages, scriptingCalls } = await loadWorker();
    const pending = core.captureFor({ tabId: 1, url: "https://leetcode.com/problems/two-sum/", origin: "https://leetcode.com" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tabMessages).toHaveLength(1);
    // The mocked content-script channel fails, so the defined selection fallback runs.
    await pending;
    expect(scriptingCalls).toHaveLength(1);
  });

  it("enforces every stage's field contract and catches fenced, indented, and unfenced code", async () => {
    const { core } = await loadWorker();
    for (let stage = 0; stage < core.STAGE_FIELDS.length; stage++) {
      const payload = Object.fromEntries(core.STAGE_FIELDS[stage].map((field) => [field, field === "pseudocode" ? "walk through the loop" : "Explain the invariant in plain language."]));
      expect(core.validateReply(JSON.stringify(payload), stage)).toMatchObject(payload);
      const forbidden = ["question", "discussion", "hint", "pseudocode", "code"].find((field) => !core.STAGE_FIELDS[stage].includes(field));
      if (forbidden) expect(() => core.validateReply(JSON.stringify({ [forbidden]: "not yet" }), stage)).toThrow("too early");
    }
    for (const code of ["```js\nconst x = 1;\n```", "    for (let i = 0; i < n; i++) {}", "for (let i = 0; i < n; i++) {"]) {
      expect(() => core.validateReply(JSON.stringify({ discussion: code }), 0)).toThrow("code too early");
    }
  });

  it("caps turns, evicts the LRU ninth session, and resolves equal timestamps deterministically", async () => {
    const { core } = await loadWorker();
    const session = { history: Array.from({ length: 41 }, (_, index) => ({ role: "user", text: String(index) })) };
    core.capHistory(session);
    expect(session.history).toHaveLength(40);
    expect(session.history[0].text).toBe("1");
    await Promise.all(Array.from({ length: 9 }, (_, index) => core.commitSession((sessions) => {
      const id = `s${index}`; sessions[id] = { id, updatedAt: index, revision: 1 }; return sessions[id];
    })));
    expect(Object.keys(await core.readSessions())).toHaveLength(8);
    expect(core.findSessionForTab({ a: { id: "a", tabId: 1, updatedAt: 1, revision: 2 }, b: { id: "b", tabId: 1, updatedAt: 1, revision: 3 } }, 1).id).toBe("b");
  });

  it("clears pending requests during rehydration before panel work is served", async () => {
    const seed = { local: {}, session: { "dsaCoach.sessions": { s1: { id: "s1", tabId: 1, pendingRequest: { requestId: "dead", epoch: 0 }, revision: 1, updatedAt: 1 } } } };
    const { core } = await loadWorker({ seed });
    const session = (await core.readSessions()).s1;
    expect(session.pendingRequest).toBeNull();
    expect(session.error).toContain("interrupted");
  });

  it("moves a saved credential without exposing its key and refuses mode changes without a saved key", async () => {
    const { core, storage } = await loadWorker();
    await expect(core.setCredentialMode({ persistent: true })).rejects.toThrow("Save a key");
    await core.setCredential({ apiKey: "move-me", persistent: false });
    const result = await core.setCredentialMode({ persistent: true });
    expect(result).toMatchObject({ persistent: true, fingerprint: "move…e-me" });
    expect(storage.state.local[core.CREDENTIAL_KEY].key).toBe("move-me");
    expect(storage.state.session[core.CREDENTIAL_KEY]).toBeUndefined();
  });

  it("keeps original capture text after an explicit cross-tab continue acknowledgement", async () => {
    const tabs = [{ id: 1, windowId: 1, url: "https://leetcode.com/problems/two-sum/", active: true }, { id: 2, windowId: 1, url: "https://example.test/other", active: false }];
    const { core } = await loadWorker({ tabs });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { description: "original problem" }, captureId: "c1", captureStatus: "preview", confirmed: true, stageIndex: 0, history: [], epoch: 0, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    tabs[0].active = false; tabs[1].active = true;
    const messages = [];
    await core.handlePanelMessage({ postMessage(message) { messages.push(message); }, disconnect() {} }, { windowId: 1, currentSessionId: "s1" }, { type: "coach:continue-anyway", sessionId: "s1" });
    const stored = (await core.readSessions()).s1;
    expect(stored.mismatchAck).toEqual({ tabId: 2, origin: "https://example.test" });
    expect(stored.capture.description).toBe("original problem");
    expect(messages).toHaveLength(0);
  });

  it("flags a navigation with an unavailable URL until the learner explicitly continues", async () => {
    const tabs = [{ id: 1, windowId: 1, url: "", active: true }];
    const { core, chrome } = await loadWorker({ tabs });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { description: "original problem" }, confirmed: true, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    chrome.tabs.onUpdated.trigger(1, { status: "loading" }, { id: 1 });
    await core.waitForSessionCommits();
    const context = { windowId: 1, currentSessionId: "s1" };
    expect((await core.sessionForPort(context, { sessionId: "s1" })).mismatch).toBe(true);
    const port = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });
    chrome.runtime.onConnect.trigger(port);
    port.onMessage.trigger({ type: "coach:handshake", windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    port.onMessage.trigger({ type: "coach:get-active-session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.posts.at(-1)).toMatchObject({ type: "coach:update", session: { mismatch: { currentTabId: 1 } } });
    const messages = [];
    await core.handlePanelMessage({ postMessage(message) { messages.push(message); }, disconnect() {} }, context, { type: "coach:continue-anyway", sessionId: "s1" });
    expect((await core.sessionForPort(context, { sessionId: "s1" })).mismatch).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("returns mapped and explicit unmapped template outcomes only at the final stage", async () => {
    const { core } = await loadWorker({ templates: { "Stack: Monotonic": "code" }, knowledge: [{ id: "monotonic-stack", templateKey: "Stack: Monotonic" }, { id: "quickselect" }] });
    expect(core.templateOutcome({ matchedPatternId: "monotonic-stack" }, 6)).toBeNull();
    expect(core.templateOutcome({ matchedPatternId: "monotonic-stack" }, 7)).toMatchObject({ key: "Stack: Monotonic" });
    expect(core.templateOutcome({ matchedPatternId: "quickselect" }, 7).label).toContain("No built-in template");
  });

  it("rejects credential messages from non-options contexts before they can mutate storage", async () => {
    const { core, chrome } = await loadWorker();
    const forged = await runtimeMessage(chrome, { type: "credential:set", apiKey: "forged-key", persistent: false }, { id: "page", url: "https://example.test/" });
    expect(forged).toMatchObject({ keptAlive: undefined, responded: false });
    expect(await core.activeCredential()).toBeNull();

    const accepted = await runtimeMessage(chrome, { type: "credential:set", apiKey: "trusted-key", persistent: false }, { id: "test-extension", url: "chrome-extension://test-extension/options.html" });
    expect(accepted).toMatchObject({ keptAlive: true, responded: true, response: { ok: true } });
    expect((await core.activeCredential()).key).toBe("trusted-key");
  });

  it("drops unsolicited capture results without changing a session or starting provider work", async () => {
    const { core, chrome } = await loadWorker();
    await core.commitSession((sessions) => { sessions.s1 = { id: "s1", tabId: 1, revision: 1, updatedAt: 1, capture: null }; return sessions.s1; });
    const result = await runtimeMessage(chrome, { type: "capture:result", requestId: "unsolicited", capture: { description: "forged" } }, { id: "test-extension", tab: { id: 1 }, frameId: 0, url: "https://leetcode.com/problems/two-sum/" });
    expect(result.responded).toBe(false);
    expect((await core.readSessions()).s1.capture).toBeNull();
  });

  it("binds a verified panel port to one window, pulls persisted state, and disconnects identity changes", async () => {
    const { core, chrome } = await loadWorker();
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { title: "Two Sum" }, confirmed: false, revision: 3, updatedAt: 3 };
      return sessions.s1;
    });
    const port = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });
    chrome.runtime.onConnect.trigger(port);
    port.onMessage.trigger({ type: "coach:handshake", windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.posts).toContainEqual({ type: "coach:ready" });
    port.onMessage.trigger({ type: "coach:get-active-session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.posts.at(-1)).toMatchObject({ type: "coach:update", session: { id: "s1", revision: 3 } });
    port.onMessage.trigger({ type: "coach:get-active-session", windowId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.disconnected).toBe(true);
  });

  it("hydrates capture-before-connect and pushes a later capture completion to a connected panel", async () => {
    const { core, chrome } = await loadWorker();
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { title: "Two Sum" }, captureId: "c1", captureStatus: "preview", confirmed: false, revision: 4, updatedAt: 4 };
      return sessions.s1;
    });
    const first = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });
    chrome.runtime.onConnect.trigger(first);
    first.onMessage.trigger({ type: "coach:handshake", windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.onMessage.trigger({ type: "coach:get-active-session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.posts.at(-1)).toMatchObject({ type: "coach:update", session: { id: "s1", revision: 4, captureStatus: "preview" } });

    const second = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });
    chrome.runtime.onConnect.trigger(second);
    second.onMessage.trigger({ type: "coach:handshake", windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.onMessage.trigger({ type: "coach:get-active-session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.posts.at(-1)).toMatchObject({ session: { revision: 4 } });

    await core.commitSession((sessions) => {
      sessions.s1.capture = null; sessions.s1.captureStatus = "capturing"; sessions.s1.revision = 5; sessions.s1.updatedAt = 5;
      return sessions.s1;
    });
    second.onMessage.trigger({ type: "coach:get-active-session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.posts.at(-1)).toMatchObject({ session: { revision: 5, captureStatus: "capturing", capture: null } });

    const completed = await core.commitSession((sessions) => {
      sessions.s1.capture = { title: "Two Sum" }; sessions.s1.captureStatus = "preview"; sessions.s1.revision = 6; sessions.s1.updatedAt = 6;
      return sessions.s1;
    });
    await core.pushSession(completed);
    expect(second.posts.at(-1)).toMatchObject({ type: "coach:update", session: { revision: 6, captureStatus: "preview" } });
    second.onMessage.trigger({ type: "coach:confirm-capture", sessionId: "s1", captureId: "c1" });
    await core.waitForSessionCommits();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.posts.at(-1)).toMatchObject({ type: "coach:update", session: { confirmed: true, revision: 7 } });
  });

  it("keeps panel state isolated by window and pushes the newly active tab's session", async () => {
    const tabs = [
      { id: 1, windowId: 1, url: "https://leetcode.com/problems/one/", active: true },
      { id: 2, windowId: 1, url: "https://leetcode.com/problems/two/", active: false },
      { id: 3, windowId: 2, url: "https://leetcode.com/problems/three/", active: true },
    ];
    const { core, chrome } = await loadWorker({ tabs });
    await core.commitSession((sessions) => {
      sessions.a = { id: "a", tabId: 1, windowId: 1, origin: "https://leetcode.com", revision: 1, updatedAt: 1 };
      sessions.b = { id: "b", tabId: 2, windowId: 1, origin: "https://leetcode.com", revision: 1, updatedAt: 2 };
      sessions.c = { id: "c", tabId: 3, windowId: 2, origin: "https://leetcode.com", revision: 1, updatedAt: 3 };
      return sessions.a;
    });
    const one = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });
    const two = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });
    chrome.runtime.onConnect.trigger(one); one.onMessage.trigger({ type: "coach:handshake", windowId: 1 });
    chrome.runtime.onConnect.trigger(two); two.onMessage.trigger({ type: "coach:handshake", windowId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    one.onMessage.trigger({ type: "coach:get-active-session" }); two.onMessage.trigger({ type: "coach:get-active-session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(one.posts.at(-1)).toMatchObject({ session: { id: "a" } });
    expect(two.posts.at(-1)).toMatchObject({ session: { id: "c" } });
    tabs[0].active = false; tabs[1].active = true;
    chrome.tabs.onActivated.trigger({ tabId: 2, windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(one.posts.at(-1)).toMatchObject({ session: { id: "b" } });
    expect(two.posts.at(-1)).toMatchObject({ session: { id: "c" } });
  });

  it("stops delivering a late background completion once the panel has moved to a session-less tab", async () => {
    const tabs = [
      { id: 1, windowId: 1, url: "https://leetcode.com/problems/two-sum/", active: true },
      { id: 3, windowId: 1, url: "https://example.test/unrelated", active: false },
    ];
    const { core, chrome } = await loadWorker({ tabs });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { description: "original" }, confirmed: true, stageIndex: 0, history: [], epoch: 0, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    const port = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });
    chrome.runtime.onConnect.trigger(port);
    port.onMessage.trigger({ type: "coach:handshake", windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    port.onMessage.trigger({ type: "coach:get-active-session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.posts.at(-1)).toMatchObject({ type: "coach:update", session: { id: "s1" } });

    // Switch the window's active tab to an unrelated, session-less tab, as a
    // user would while a provider request for s1 is still in flight.
    tabs[0].active = false; tabs[1].active = true;
    chrome.tabs.onActivated.trigger({ tabId: 3, windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.posts.at(-1)).toMatchObject({ type: "coach:update", session: null });

    // The in-flight request for s1 now completes and reaches pushSession.
    // Without clearing the stale currentSessionId, this would silently
    // re-render tab 1's session in a panel now looking at tab 3.
    const postCountBeforeCompletion = port.posts.length;
    const completed = await core.commitSession((sessions) => {
      sessions.s1.history = [{ role: "assistant", text: "late reply" }]; sessions.s1.revision = 2; sessions.s1.updatedAt = 2;
      return sessions.s1;
    });
    await core.pushSession(completed);
    expect(port.posts).toHaveLength(postCountBeforeCompletion);
    expect(port.posts.at(-1)).toMatchObject({ type: "coach:update", session: null });
  });

  it("disconnects forged panel ports and unknown handshake windows before handling coach traffic", async () => {
    const { chrome } = await loadWorker();
    const forged = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/not-panel.html" });
    chrome.runtime.onConnect.trigger(forged);
    expect(forged.disconnected).toBe(true);

    const unknownWindow = panelPort({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });
    chrome.runtime.onConnect.trigger(unknownWindow);
    unknownWindow.onMessage.trigger({ type: "coach:handshake", windowId: 99 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unknownWindow.disconnected).toBe(true);
  });
});
