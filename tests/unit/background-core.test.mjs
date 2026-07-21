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

async function loadWorker({ seed = { local: {}, session: {} }, failures = {}, delays = {}, tabs = [{ id: 1, windowId: 1, url: "https://leetcode.com/problems/two-sum/" }], selection = "", templates = {}, knowledge = [], waitForReady = true, editorCodeResponse = undefined } = {}) {
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
      async sendMessage(tabId, message) {
        tabMessages.push([tabId, message]);
        if (message?.type === "editor:read" && editorCodeResponse !== undefined) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          chrome.runtime.onMessage.listeners[0](
            { type: "editor:result", requestId: message.requestId, code: editorCodeResponse },
            { id: "test-extension", tab: { id: tabId }, frameId: 0, url: tab?.url || "" },
            () => {},
          );
          return { ok: true };
        }
        throw new Error("No content script in this unit harness");
      },
    },
    windows: { onFocusChanged: event(), async get(id) { if (!tabs.some((tab) => tab.windowId === id)) throw new Error("missing window"); return { id }; } },
    scripting: { async executeScript(...args) { scriptingCalls.push(args); return [{ result: { selected: selection, sourceUrl: tabs[0]?.url || "" } }]; } },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, URL, setTimeout, clearTimeout, console, importScripts() {}, TEMPLATES: templates, COACHING_KNOWLEDGE: knowledge });
  vm.runInContext(`${backgroundSource}\nglobalThis.__core = { credentialReady, sessionReady, resolveCredential, nextGeneration, setCredential, setCredentialMode, deleteCredential, deleteRollbackMessage, activeCredential, credentialState, clipCapture, capHistory, historyBytes, promptFor, validateReply, validatedFieldsOnly, commitSession, readSessions, touch, publicSession, pushSession, launchCoach, captureFor, findSessionForTab, templateOutcome, sessionForPort, handlePanelMessage, beginProviderRequest, rehydrateSessions, waitForSessionCommits, STAGES, STAGE_FIELDS, clampStage, stageFor, stageFieldsFor, hasCaptureText, readEditorCode, MAX_CAPTURE, MAX_EDITOR_CODE, MAX_HISTORY_BYTES, CREDENTIAL_KEY, SESSION_KEY };`, context, { filename: "background.js" });
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

async function flushWork(core) {
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  await core.waitForSessionCommits();
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

  it("clips captures in field priority order (title, description, examples, constraints) and caps UTF-8 history bytes", async () => {
    const { core } = await loadWorker();
    const clipped = core.clipCapture({ title: "T".repeat(20), constraints: "C".repeat(9000), examples: "E", description: "D" });
    expect(clipped.title).toHaveLength(20);
    expect(clipped.description).toBe("D");
    expect(clipped.examples).toBe("E");
    expect(clipped.constraints).toHaveLength(core.MAX_CAPTURE - 22);
    expect(clipped.truncated).toBe(true);
    const session = { history: [{ text: "😀".repeat(40000) }] };
    core.capHistory(session);
    expect(core.historyBytes(session.history)).toBeLessThanOrEqual(core.MAX_HISTORY_BYTES);
    expect(session.historyNotice).toContain("dropped");
  });

  it("prioritizes description over examples/constraints in the capture budget, so a long problem keeps its statement", async () => {
    const { core } = await loadWorker();
    const longDescription = "D".repeat(9000);
    const clipped = core.clipCapture({ title: "Title", description: longDescription, examples: "E".repeat(500), constraints: "C".repeat(500) });
    expect(clipped.description.length).toBeGreaterThan(7900);
    expect(clipped.examples).toBe("");
    expect(clipped.constraints).toBe("");
    expect(clipped.truncated).toBe(true);
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

  it("refreshes session.url on a verified same-origin navigation of the tracked tab, so canReadEditor reflects where it navigated", async () => {
    const tabs = [{ id: 1, windowId: 1, url: "https://leetcode.com/problems/two-sum/", active: true }];
    const { core, chrome } = await loadWorker({ tabs });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", capture: { title: "Two Sum" }, confirmed: true, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    expect(core.publicSession((await core.readSessions()).s1).canReadEditor).toBe(true);
    chrome.tabs.onUpdated.trigger(1, { status: "complete", url: "https://leetcode.com/discuss/general" }, { id: 1, url: "https://leetcode.com/discuss/general" });
    await core.waitForSessionCommits();
    const stored = (await core.readSessions()).s1;
    expect(stored.url).toBe("https://leetcode.com/discuss/general");
    expect(core.publicSession(stored).canReadEditor).toBe(false);
  });

  it("does not adopt the mismatchAck substitute tab's URL, since capture/editor reads still target the original session.tabId", async () => {
    const tabs = [
      { id: 1, windowId: 1, url: "https://leetcode.com/problems/two-sum/", active: false },
      { id: 2, windowId: 1, url: "https://leetcode.com/problems/two-sum/", active: true },
    ];
    const { core, chrome } = await loadWorker({ tabs });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", mismatchAck: { tabId: 2, origin: "https://leetcode.com" }, capture: { title: "Two Sum" }, confirmed: true, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    chrome.tabs.onUpdated.trigger(2, { status: "complete", url: "https://leetcode.com/discuss/general" }, { id: 2, url: "https://leetcode.com/discuss/general" });
    await core.waitForSessionCommits();
    const stored = (await core.readSessions()).s1;
    expect(stored.url).toBe("https://leetcode.com/problems/two-sum/");
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

  it("clamps a legacy out-of-range stageIndex during rehydration, and promptFor/validateReply tolerate an unclamped index", async () => {
    const seed = { local: {}, session: { "dsaCoach.sessions": { s1: { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 7, history: [], epoch: 0, revision: 1, updatedAt: 1 } } } };
    const { core } = await loadWorker({ seed });
    const rehydrated = (await core.readSessions()).s1;
    expect(rehydrated.stageIndex).toBe(core.STAGES.length - 1);

    const messages = core.promptFor({ stageIndex: 7, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [] }, "hi");
    expect(messages[0].content).toContain(core.STAGES.at(-1).objective);
    expect(() => core.validateReply(JSON.stringify({ code: "const x = 1;" }), 7)).not.toThrow();
  });

  it("injects the current stage's objective into the system prompt", async () => {
    const { core } = await loadWorker();
    const messages = core.promptFor({ stageIndex: 2, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [] }, "hi");
    expect(messages[0].content).toContain(core.STAGES[2].objective);
  });

  it("sends the current stage's allowed fields to the panel, so it can gate stage-specific controls", async () => {
    const { core } = await loadWorker();
    const session = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", capture: { title: "Two Sum" }, stageIndex: 2 };
    expect(core.publicSession(session).stage.fields).toEqual(core.STAGES[2].fields);
  });

  it("encourages a learner-proposed brute force and prefers modern JS phrasing over 'hash map or object'", async () => {
    const { core } = await loadWorker();
    const system = core.promptFor({ stageIndex: 2, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [] }, "hi")[0].content;
    expect(system).toContain("affirm it as the correct place to start");
    expect(system).not.toContain("a hash map or object");
    expect(system).toMatch(/Map, Set, or Object\.groupBy/);
  });

  it("attaches editor code as one ephemeral message ahead of the final user message", async () => {
    const messages = (await loadWorker()).core.promptFor({ stageIndex: 7, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [] }, "what do you think?", "", "function twoSum() {}");
    const codeMessage = messages.find((message) => message.content.includes("function twoSum"));
    expect(codeMessage).toBeDefined();
    expect(messages.at(-1).content).toBe("User message: what do you think?");
  });

  it("does not replay a code-stage assistant turn's code field once back at an earlier stage", async () => {
    const { core } = await loadWorker();
    const session = { stageIndex: 0, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [
      { role: "coach", code: "function twoSum() { return []; }", discussion: "Here is a full solution." },
    ] };
    const messages = core.promptFor(session, "What next?");
    expect(messages.map((message) => message.content).join("\n")).not.toContain("function twoSum");
  });

  it("coach:go-back clamps at 0 and re-locks stage-gated fields", async () => {
    const { core } = await loadWorker();
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 7, history: [], epoch: 0, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    const port = { postMessage() {}, disconnect() {} };
    const context = { windowId: 1, currentSessionId: "s1" };
    for (let index = 0; index < 8; index++) await core.handlePanelMessage(port, context, { type: "coach:go-back", sessionId: "s1" });
    const stored = (await core.readSessions()).s1;
    expect(stored.stageIndex).toBe(0);
    expect(() => core.validateReply(JSON.stringify({ code: "const x = 1;" }), stored.stageIndex)).toThrow("too early");
  });

  it("hasCaptureText treats any non-empty field as a capture, so an examples-only result is kept", async () => {
    const { core } = await loadWorker();
    expect(core.hasCaptureText({ title: "", description: "", examples: "Example 1: ...", constraints: "" })).toBe(true);
    expect(core.hasCaptureText({ title: "", description: "", examples: "", constraints: "" })).toBe(false);
    expect(core.hasCaptureText(null)).toBe(false);
  });

  it("readEditorCode refuses to read on a non-LeetCode session even when asked to", async () => {
    const { core } = await loadWorker({ tabs: [{ id: 1, windowId: 1, url: "https://example.test/other" }], editorCodeResponse: "leaked code" });
    const code = await core.readEditorCode({ tabId: 1, url: "https://example.test/other", origin: "https://example.test" });
    expect(code).toBe("");
  });

  it("coach:send without includeCode never reads the editor", async () => {
    const { core, context, tabMessages } = await loadWorker({ editorCodeResponse: "should not be read" });
    await core.setCredential({ apiKey: "session-key", persistent: false });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 0, history: [], epoch: 0, pendingRequest: null, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    context.providerChat = () => Promise.resolve('{"discussion":"Sure, tell me more."}');
    await core.beginProviderRequest("s1", "hello", false, false);
    await flushWork(core);
    expect(tabMessages.some(([, message]) => message.type === "editor:read")).toBe(false);
    const stored = (await core.readSessions()).s1;
    expect(stored.history[0]).toMatchObject({ codeAttached: false });
  });

  it("coach:send with includeCode reads and attaches editor code (truncated), and never persists the raw code", async () => {
    const longCode = Array.from({ length: 500 }, (_, index) => `// line ${index}`).join("\n");
    const { core, context, tabMessages } = await loadWorker({ editorCodeResponse: longCode });
    await core.setCredential({ apiKey: "session-key", persistent: false });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 7, history: [], epoch: 0, pendingRequest: null, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    let capturedPrompt;
    context.providerChat = (provider, messages) => { capturedPrompt = messages; return Promise.resolve('{"discussion":"Looks reasonable so far."}'); };
    await core.beginProviderRequest("s1", "What do you think of my code?", false, true);
    await flushWork(core);
    expect(tabMessages.some(([, message]) => message.type === "editor:read")).toBe(true);
    expect(capturedPrompt.some((message) => message.content.includes("// line 0"))).toBe(true);
    expect(capturedPrompt.some((message) => message.content.includes("// line 499"))).toBe(false);
    const stored = (await core.readSessions()).s1;
    expect(stored.history[0]).toMatchObject({ role: "user", text: "What do you think of my code?", codeAttached: true });
    expect(JSON.stringify(stored)).not.toContain("// line 0");
  });

  it("a failed editor read is non-fatal: the request still completes with no code attached", async () => {
    const { core, context } = await loadWorker(); // editorCodeResponse left undefined -> the content-script round trip fails
    await core.setCredential({ apiKey: "session-key", persistent: false });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 7, history: [], epoch: 0, pendingRequest: null, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    context.providerChat = () => Promise.resolve('{"discussion":"Let\'s look at it together."}');
    await core.beginProviderRequest("s1", "What do you think?", false, true);
    await flushWork(core);
    const stored = (await core.readSessions()).s1;
    expect(stored.error).toBe("");
    expect(stored.history[0]).toMatchObject({ codeAttached: false });
  });

  it("coach:retry reuses the original includeCode choice from session.lastIncludeCode", async () => {
    const marker = "// retry-marker-42";
    const { core, context } = await loadWorker({ editorCodeResponse: marker });
    await core.setCredential({ apiKey: "session-key", persistent: false });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 7, history: [], epoch: 0, pendingRequest: null, lastUserMessage: "check my code", lastIncludeCode: true, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    let lastPrompt;
    context.providerChat = (provider, messages) => { lastPrompt = messages; return Promise.resolve('{"discussion":"Noted."}'); };
    const port = { postMessage() {}, disconnect() {} };
    const panelContext = { windowId: 1, currentSessionId: "s1" };
    await core.handlePanelMessage(port, panelContext, { type: "coach:retry", sessionId: "s1" });
    await flushWork(core);
    expect(JSON.stringify(lastPrompt)).toContain("retry-marker-42");
  });

  it("warns the model that attached editor code may only be the visible portion of a long file", async () => {
    const { core } = await loadWorker();
    const messages = core.promptFor({ stageIndex: 7, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [] }, "what do you think?", "", "function twoSum() {}", true);
    const codeMessage = messages.find((message) => message.content.includes("function twoSum"));
    expect(codeMessage.content).toContain("may include only the lines currently scrolled into view, not the whole file");
  });

  it("distinguishes 'never asked to attach code' from 'asked but nothing could be read' in the system prompt", async () => {
    const { core } = await loadWorker();
    const base = { stageIndex: 7, createdAt: Date.now(), capture: { title: "Two Sum" }, history: [] };
    const notRequested = core.promptFor(base, "what do you think?")[0].content;
    expect(notRequested).toContain('ask them to tick "Attach my editor code" and resend');

    const requestedButEmpty = core.promptFor(base, "what do you think?", "", "", true)[0].content;
    expect(requestedButEmpty).toContain("nothing could be read from it");
    expect(requestedButEmpty).not.toContain('ask them to tick "Attach my editor code" and resend');

    const requestedWithCode = core.promptFor(base, "what do you think?", "", "function twoSum() {}", true)[0].content;
    expect(requestedWithCode).not.toContain('ask them to tick "Attach my editor code" and resend');
    expect(requestedWithCode).not.toContain("nothing could be read from it");
  });

  it("does not replay a previously attached editor code into a later turn where includeCode is now false", async () => {
    const { core, context, tabMessages } = await loadWorker({ editorCodeResponse: "function twoSum() { return secretMarker; }" });
    await core.setCredential({ apiKey: "session-key", persistent: false });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 7, history: [], epoch: 0, pendingRequest: null, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    context.providerChat = () => Promise.resolve('{"discussion":"Looks reasonable."}');
    await core.beginProviderRequest("s1", "look at my code", false, true);
    await flushWork(core);

    let secondPrompt;
    context.providerChat = (provider, messages) => { secondPrompt = messages; return Promise.resolve('{"discussion":"Sure, go on."}'); };
    await core.beginProviderRequest("s1", "what about now, no code this time", false, false);
    await flushWork(core);

    expect(secondPrompt.map((message) => message.content).join("\n")).not.toContain("secretMarker");
    expect(tabMessages.filter(([, message]) => message.type === "editor:read")).toHaveLength(1);
  });

  it("carries attached editor code into the contract-violation retry prompt inside safeCoachReply", async () => {
    const { core, context } = await loadWorker({ editorCodeResponse: "function twoSum() {}" });
    await core.setCredential({ apiKey: "session-key", persistent: false });
    await core.commitSession((sessions) => {
      sessions.s1 = { id: "s1", tabId: 1, windowId: 1, origin: "https://leetcode.com", url: "https://leetcode.com/problems/two-sum/", capture: { title: "Two Sum" }, confirmed: true, stageIndex: 7, history: [], epoch: 0, pendingRequest: null, revision: 1, updatedAt: 1 };
      return sessions.s1;
    });
    const prompts = [];
    let call = 0;
    context.providerChat = (provider, messages) => {
      prompts.push(messages);
      call++;
      return Promise.resolve(call === 1 ? "not valid json" : '{"discussion":"ok"}');
    };
    await core.beginProviderRequest("s1", "what do you think of my code?", false, true);
    await flushWork(core);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt.some((message) => message.content.includes("function twoSum"))).toBe(true);
    }
  });

  it("clipCapture reserves budget for description before examples and constraints, so a long problem statement survives", async () => {
    const { core } = await loadWorker();
    const longDescription = "d".repeat(core.MAX_CAPTURE - 100);
    const clipped = core.clipCapture({ title: "T", description: longDescription, examples: "e".repeat(500), constraints: "c".repeat(500) });
    expect(clipped.description).toBe(longDescription);
    expect(clipped.examples.length).toBeLessThan(500);
    expect(clipped.constraints).toBe("");
    expect(clipped.truncated).toBe(true);
  });
});
