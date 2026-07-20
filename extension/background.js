importScripts("templates.js", "coaching-knowledge.js", "providers.js");

const MENU_ID_ROOT = "dsa-templates";
const COACH_MENU_ID = "dsa-coach-start";
const SESSION_KEY = "dsaCoach.sessions";
const CREDENTIAL_KEY = "dsaCoach.credential";
const TOMBSTONE_KEY = "dsaCoach.credTombstone";
const HEALTH_KEY = "dsaCoach.areaHealth";
const PROBE_KEY = "dsaCoach.healthProbe";
const MAX_CAPTURE = 8000;
const MAX_TURNS = 40;
const MAX_HISTORY_BYTES = 128 * 1024;
const MAX_SESSIONS = 8;
const MISMATCH_MESSAGE = "This conversation belongs to another page. Continue anyway to reuse its original problem text, or start a new capture.";
const STAGES = ["clarify", "patterns", "approach", "edge-cases", "outline", "hint", "pseudocode", "code"];
const STAGE_FIELDS = [
  ["question", "discussion"], ["question", "discussion"], ["question", "discussion"], ["question", "discussion"],
  ["question", "discussion", "hint"], ["question", "discussion", "hint"], ["discussion", "hint", "pseudocode"], ["discussion", "hint", "pseudocode", "code"],
];
const GROUPS = [
  { id: "bfs", label: "BFS", prefix: "BFS: " }, { id: "dfs", label: "DFS", prefix: "DFS: " },
  { id: "backtracking", label: "Backtracking", prefix: "Backtracking: " }, { id: "binary-search", label: "Binary Search", prefix: "Binary Search: " },
  { id: "dp", label: "Dynamic Programming", prefix: "Dynamic Programming: " }, { id: "sliding-window", label: "Sliding Window", prefix: "Sliding Window: " },
  { id: "two-pointers", label: "Two Pointers", prefix: "Two Pointers: " }, { id: "prefix-sum", label: "Prefix Sum", prefix: "Prefix Sum" },
  { id: "stack", label: "Stack", prefix: "Stack" }, { id: "trie", label: "Trie", prefix: "Trie" },
  { id: "linked-list", label: "Linked List", prefix: "Linked List" }, { id: "union-find", label: "Union Find", prefix: "Union Find" },
];

let credentialQueue = Promise.resolve();
let sessionQueue = Promise.resolve();
const panelPorts = new Map();
const captureRequests = new Map();
const encoder = new TextEncoder();
const now = () => Date.now();
const fingerprint = (key) => key ? `${key.slice(0, 4)}…${key.slice(-4)}` : "";
const extensionUrl = (path) => chrome.runtime.getURL(path);

function enqueueCredential(work) {
  const next = credentialQueue.then(work, work);
  credentialQueue = next.catch(() => {});
  return next;
}
function enqueueSession(work) {
  const next = sessionQueue.then(work, work);
  sessionQueue = next.catch(() => {});
  return next;
}
// Kept as a small, explicit synchronization point for lifecycle diagnostics and
// tests. It never starts work or holds the queue; it only observes commits that
// have already been scheduled.
function waitForSessionCommits() { return sessionQueue; }
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: COACH_MENU_ID, title: "Coach me through this problem", contexts: ["page", "selection"] });
    chrome.contextMenus.create({ id: MENU_ID_ROOT, title: "Insert DSA Template", contexts: ["editable"] });
    for (const group of GROUPS) {
      const keys = Object.keys(TEMPLATES).filter((key) => key.startsWith(group.prefix));
      if (!keys.length) continue;
      if (keys.length === 1) chrome.contextMenus.create({ id: `template:${keys[0]}`, parentId: MENU_ID_ROOT, title: group.label, contexts: ["editable"] });
      else {
        chrome.contextMenus.create({ id: `group:${group.id}`, parentId: MENU_ID_ROOT, title: group.label, contexts: ["editable"] });
        keys.forEach((key) => chrome.contextMenus.create({ id: `template:${key}`, parentId: `group:${group.id}`, title: key.replace(group.prefix, "").trim(), contexts: ["editable"] }));
      }
    }
  });
}

function badgeError(message, tabId) {
  chrome.action.setBadgeText({ text: "!", ...(tabId ? { tabId } : {}) });
  chrome.action.setBadgeBackgroundColor({ color: "#b42318", ...(tabId ? { tabId } : {}) });
  chrome.action.setTitle({ title: message, ...(tabId ? { tabId } : {}) });
  setTimeout(() => chrome.action.setBadgeText({ text: "", ...(tabId ? { tabId } : {}) }), 5000);
}
async function restrictLocalStorage() {
  if (!chrome.storage.local.setAccessLevel) return false;
  try { await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); return true; }
  catch { return false; }
}

// Credential storage is intentionally worker-only. Tombstones suppress stale copies in both areas.
async function credentialState() {
  const [session, local, health] = await Promise.all([
    chrome.storage.session.get([CREDENTIAL_KEY, TOMBSTONE_KEY]),
    chrome.storage.local.get([CREDENTIAL_KEY, TOMBSTONE_KEY]),
    chrome.storage.session.get(HEALTH_KEY),
  ]);
  return { session, local, health: health[HEALTH_KEY] || {} };
}
function normalizeEnvelope(value) {
  if (!value) return null;
  // One-time compatibility with the originally shipped 1.1.0 envelope.
  if (value.key && Number.isFinite(value.gen)) return value;
  if (value.apiKey) return { gen: Number(value.savedAt) || 0, mode: value.persistent ? "persistent" : "session", provider: value.provider || "openai", key: value.apiKey, fingerprint: value.fingerprint || fingerprint(value.apiKey) };
  return null;
}
function resolveCredential(state) {
  const envelopes = [normalizeEnvelope(state.session[CREDENTIAL_KEY]), normalizeEnvelope(state.local[CREDENTIAL_KEY])].filter(Boolean);
  const tombstone = Math.max(Number(state.session[TOMBSTONE_KEY]?.gen) || -1, Number(state.local[TOMBSTONE_KEY]?.gen) || -1);
  return envelopes.filter((item) => item.gen > tombstone).sort((a, b) => b.gen - a.gen)[0] || null;
}
function nextGeneration(state) {
  const values = [normalizeEnvelope(state.session[CREDENTIAL_KEY]), normalizeEnvelope(state.local[CREDENTIAL_KEY]), state.session[TOMBSTONE_KEY], state.local[TOMBSTONE_KEY]];
  return Math.max(-1, ...values.filter(Boolean).map((value) => Number(value.gen) || 0)) + 1;
}
async function markAreaUnhealthy(area) {
  const health = (await chrome.storage.session.get(HEALTH_KEY))[HEALTH_KEY] || {};
  health[area] = true;
  await chrome.storage.session.set({ [HEALTH_KEY]: health });
}
async function removeArea(area, key) {
  try { await chrome.storage[area].remove(key); return true; }
  catch { await markAreaUnhealthy(area); return false; }
}
async function probeArea(area) {
  const marker = crypto.randomUUID();
  try {
    await chrome.storage[area].set({ [PROBE_KEY]: marker });
    const result = await chrome.storage[area].get(PROBE_KEY);
    if (result[PROBE_KEY] !== marker) throw new Error("Storage probe did not round-trip.");
    await chrome.storage[area].remove(PROBE_KEY);
    return true;
  } catch { return false; }
}
async function reconcileCredentials() {
  return enqueueCredential(async () => {
    const localRestricted = await restrictLocalStorage();
    let state = await credentialState();
    const globalTombstone = Math.max(Number(state.session[TOMBSTONE_KEY]?.gen) || -1, Number(state.local[TOMBSTONE_KEY]?.gen) || -1);
    for (const area of ["session", "local"]) {
      const envelope = normalizeEnvelope(state[area][CREDENTIAL_KEY]);
      const other = normalizeEnvelope(state[area === "session" ? "local" : "session"][CREDENTIAL_KEY]);
      if (envelope && (envelope.gen <= globalTombstone || (other && other.gen > envelope.gen))) await removeArea(area, CREDENTIAL_KEY);
    }
    state = await credentialState();
    const stillSuppressed = [normalizeEnvelope(state.session[CREDENTIAL_KEY]), normalizeEnvelope(state.local[CREDENTIAL_KEY])].some((value) => value && value.gen <= globalTombstone);
    if (!stillSuppressed) {
      if (state.session[TOMBSTONE_KEY]) await removeArea("session", TOMBSTONE_KEY);
      if (state.local[TOMBSTONE_KEY]) await removeArea("local", TOMBSTONE_KEY);
    }
    const previousHealth = (await chrome.storage.session.get(HEALTH_KEY))[HEALTH_KEY] || {};
    const health = { ...previousHealth };
    for (const area of ["session", "local"]) {
      if (area === "local" && !localRestricted) { health.local = true; continue; }
      if (previousHealth[area] && await probeArea(area)) delete health[area];
    }
    await chrome.storage.session.set({ [HEALTH_KEY]: health });
  });
}
const credentialReady = reconcileCredentials();
async function activeCredential() {
  await credentialReady;
  return enqueueCredential(async () => resolveCredential(await credentialState()));
}
async function credentialStatus() {
  await credentialReady;
  return enqueueCredential(async () => {
    const state = await credentialState();
    const credential = resolveCredential(state);
    const persistentAvailable = !(state.health.local) && await restrictLocalStorage();
    return { credential: credential && { provider: credential.provider, fingerprint: credential.fingerprint, persistent: credential.mode === "persistent" }, persistentAvailable };
  });
}
async function setCredential({ apiKey, persistent, provider = "openai" }) {
  await credentialReady;
  return enqueueCredential(async () => {
    const key = String(apiKey || "").trim();
    if (!key) throw new Error("Enter an API key.");
    const state = await credentialState();
    const target = persistent ? "local" : "session";
    if (persistent && (!(await restrictLocalStorage()) || state.health.local)) throw new Error("Persistent storage is unavailable or unhealthy. Session-only storage is still available.");
    if (state.health[target]) throw new Error(`${target === "local" ? "Persistent" : "Session"} storage is unhealthy. Restart Chrome and try again.`);
    const envelope = { gen: nextGeneration(state), mode: persistent ? "persistent" : "session", provider, key, fingerprint: fingerprint(key) };
    try { await chrome.storage[target].set({ [CREDENTIAL_KEY]: envelope }); }
    catch { await markAreaUnhealthy(target); throw new Error("Could not save the key; the previous key remains active."); }
    const source = target === "local" ? "session" : "local";
    const cleaned = await removeArea(source, CREDENTIAL_KEY);
    return { provider, fingerprint: envelope.fingerprint, persistent: persistent, warning: cleaned ? "" : "Old copy pending cleanup; it is inactive and will be removed at startup." };
  });
}
// A mode change deliberately does not accept key material.  It moves the
// worker-resolved active envelope through the same serialized, generation-based
// transition used by Save, so options UI never needs to read the saved key.
async function setCredentialMode({ persistent }) {
  await credentialReady;
  return enqueueCredential(async () => {
    const state = await credentialState();
    const active = resolveCredential(state);
    if (!active) throw new Error("Save a key before changing its storage mode.");
    const target = persistent ? "local" : "session";
    if (active.mode === (persistent ? "persistent" : "session")) {
      return { provider: active.provider, fingerprint: active.fingerprint, persistent, warning: "" };
    }
    if (persistent && (!(await restrictLocalStorage()) || state.health.local)) throw new Error("Persistent storage is unavailable or unhealthy. Session-only storage is still available.");
    if (state.health[target]) throw new Error(`${target === "local" ? "Persistent" : "Session"} storage is unhealthy. Restart Chrome and try again.`);
    const envelope = { ...active, gen: nextGeneration(state), mode: persistent ? "persistent" : "session" };
    try { await chrome.storage[target].set({ [CREDENTIAL_KEY]: envelope }); }
    catch { await markAreaUnhealthy(target); throw new Error("Could not change storage mode; the previous key remains active."); }
    const cleaned = await removeArea(target === "local" ? "session" : "local", CREDENTIAL_KEY);
    return { provider: envelope.provider, fingerprint: envelope.fingerprint, persistent, warning: cleaned ? "" : "Old copy pending cleanup; it is inactive and will be removed at startup." };
  });
}
async function deleteCredential() {
  await credentialReady;
  return enqueueCredential(async () => {
    const state = await credentialState();
    const hasLocal = Boolean(normalizeEnvelope(state.local[CREDENTIAL_KEY]));
    const hasSession = Boolean(normalizeEnvelope(state.session[CREDENTIAL_KEY]));
    if (!hasLocal && !hasSession) return { deleted: true };
    const tombstone = { gen: nextGeneration(state) };
    let localGuard = false; let sessionGuard = false;
    try { await chrome.storage.local.set({ [TOMBSTONE_KEY]: tombstone }); localGuard = true; } catch { await markAreaUnhealthy("local"); }
    try { await chrome.storage.session.set({ [TOMBSTONE_KEY]: tombstone }); sessionGuard = true; } catch { await markAreaUnhealthy("session"); }
    const safe = (!hasLocal || localGuard) && (!hasSession || localGuard || sessionGuard);
    if (!safe) {
      const rollbackLocal = localGuard ? await removeArea("local", TOMBSTONE_KEY) : true;
      const rollbackSession = sessionGuard ? await removeArea("session", TOMBSTONE_KEY) : true;
      throw new Error(deleteRollbackMessage({ rollbackLocal, rollbackSession }));
    }
    const localRemoved = await removeArea("local", CREDENTIAL_KEY);
    const sessionRemoved = await removeArea("session", CREDENTIAL_KEY);
    return { deleted: true, warning: localRemoved && sessionRemoved ? "" : "Key removed from use; physical erase is pending and will be retried at startup." };
  });
}
function deleteRollbackMessage({ rollbackLocal, rollbackSession }) {
  if (!rollbackLocal) return "Delete failed partway — the key is disabled and stays disabled; cleanup will finish at next startup.";
  if (!rollbackSession) return "Delete failed — the key is disabled this session and may return after browser restart; please retry.";
  return "Delete failed — the existing key remains active. Please retry.";
}

async function readSessions() { return (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] || {}; }
function historyBytes(history) { return encoder.encode(JSON.stringify(history)).length; }
function capHistory(session) {
  let dropped = false;
  while (session.history.length > MAX_TURNS || historyBytes(session.history) > MAX_HISTORY_BYTES) { session.history.shift(); dropped = true; }
  if (dropped) session.historyNotice = "Older conversation turns were dropped to keep this session within its privacy and storage limit.";
}
function publicSession(session) {
  if (!session) return null;
  // Session records should never contain credentials, but strip credential-like
  // fields defensively before a worker-to-panel message is assembled.
  const { tabId, windowId, origin, capture, key, apiKey, ...safe } = session;
  return { ...safe, capture: capture && { title: capture.title, constraints: capture.constraints, examples: capture.examples, description: capture.description, sourceUrl: capture.sourceUrl, truncated: capture.truncated } };
}
async function pushSession(session) {
  if (!session) return;
  for (const [port, context] of panelPorts) {
    if (!context.ready) continue;
    const active = await activeTabFor(context.windowId);
    if (active?.id === session.tabId || active?.id === session.mismatchAck?.tabId || context.currentSessionId === session.id) {
      context.currentSessionId = session.id;
      try { port.postMessage({ type: "coach:update", session: publicSession(session) }); } catch {}
    }
  }
}
// The only writer of dsaCoach.sessions. Every state change, including rehydration/pruning, uses this queue.
async function commitSession(mutator) {
  return enqueueSession(async () => {
    const sessions = await readSessions();
    const result = await mutator(sessions);
    const ordered = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const stale of ordered.slice(MAX_SESSIONS)) delete sessions[stale.id];
    await chrome.storage.session.set({ [SESSION_KEY]: sessions });
    return result;
  });
}
function touch(session) { session.revision = (session.revision || 0) + 1; session.updatedAt = now(); }
function findSessionForTab(sessions, tabId) {
  return Object.values(sessions)
    .filter((session) => session.tabId === tabId || session.mismatchAck?.tabId === tabId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision || String(b.id).localeCompare(String(a.id)))[0] || null;
}
async function rehydrateSessions() {
  const openTabs = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
  return commitSession(async (sessions) => {
    for (const session of Object.values(sessions)) {
      if (!openTabs.has(session.tabId)) { delete sessions[session.id]; continue; }
      if (session.pendingRequest) {
        session.pendingRequest = null; session.error = "Request interrupted — tap Retry to try again."; touch(session);
      }
    }
    return null;
  });
}
const sessionReady = rehydrateSessions();
async function activeTabFor(windowId) { const tabs = await chrome.tabs.query({ active: true, windowId }); return tabs[0] || null; }

function clipCapture(capture) {
  const fields = ["title", "constraints", "examples", "description"];
  let remaining = MAX_CAPTURE; const clipped = {};
  for (const field of fields) { const value = String(capture[field] || ""); clipped[field] = value.slice(0, Math.max(remaining, 0)); remaining -= clipped[field].length; }
  return { ...clipped, sourceUrl: capture.sourceUrl || "", truncated: fields.some((field) => String(capture[field] || "").length > clipped[field].length) };
}
function requestLeetCodeCapture(session) {
  const requestId = crypto.randomUUID();
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => { captureRequests.delete(requestId); reject(new Error("Timed out waiting for page capture.")); }, 3500);
    captureRequests.set(requestId, { tabId: session.tabId, frameId: 0, origin: session.origin, resolve: (capture) => { clearTimeout(timer); resolve(capture); } });
    try { await chrome.tabs.sendMessage(session.tabId, { type: "capture:leetcode", requestId }); }
    catch (error) { clearTimeout(timer); captureRequests.delete(requestId); reject(error); }
  });
}
async function captureFor(session) {
  let capture = null;
  if (/^https:\/\/leetcode\.com\/problems\//.test(session.url)) {
    try { capture = await requestLeetCodeCapture(session); } catch { /* Selection remains an intentional fallback. */ }
  }
  if (!capture?.description && !capture?.title) {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: session.tabId }, func: () => ({ selected: String(getSelection()), sourceUrl: location.href }) });
    const selected = result?.result?.selected || "";
    // An empty selection is not a capture. Keeping a synthetic title here made
    // the panel present an empty preview that users could accidentally confirm.
    capture = { title: selected ? "Selected problem text" : "", description: selected, sourceUrl: result?.result?.sourceUrl || session.url };
  }
  return clipCapture(capture || {});
}
function launchCoach(tab) {
  if (!tab?.id) { badgeError("No active tab to coach."); return; }
  const captureId = crypto.randomUUID();
  // Must remain before every await: Chrome consumes user activation at the first async boundary.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => badgeError("Chrome could not open the coaching panel for this page.", tab.id));
  void (async () => {
    await sessionReady;
    const session = await commitSession((sessions) => {
      const id = crypto.randomUUID();
      const record = { id, tabId: tab.id, windowId: tab.windowId, origin: (() => { try { return new URL(tab.url || "").origin; } catch { return ""; } })(), url: tab.url || "", captureId, capture: null, captureStatus: "capturing", confirmed: false, mismatchAck: null, stageIndex: 0, history: [], pendingRequest: null, epoch: 0, revision: 1, createdAt: now(), updatedAt: now() };
      sessions[id] = record; return record;
    });
    await pushSession(session);
    try {
      const capture = await captureFor(session);
      const updated = await commitSession((sessions) => {
        const current = sessions[session.id];
        if (!current || current.captureId !== captureId || current.epoch !== session.epoch) return null;
        current.capture = capture; current.captureStatus = capture.description || capture.title ? "preview" : "empty"; touch(current); return current;
      });
      await pushSession(updated);
    } catch {
      const updated = await commitSession((sessions) => {
        const current = sessions[session.id]; if (!current || current.captureId !== captureId) return null;
        current.captureStatus = "error"; current.error = "Could not capture this page. Select the problem text and start coaching again."; touch(current); return current;
      });
      await pushSession(updated);
    }
  })();
}

function promptFor(session, userText, reminder = "") {
  const allowed = STAGE_FIELDS[session.stageIndex].join(", ");
  const elapsed = Math.floor((now() - session.createdAt) / 60000);
  const nudge = elapsed >= 20 ? " Offer one concise time-management nudge: pick an approach and move to an implementation outline." : "";
  // History is deliberately part of the provider context, not just panel display.
  // This makes a retry and every later turn continue the same Socratic discussion.
  const history = (session.history || []).flatMap((turn) => {
    if (turn.role === "user") return [{ role: "user", content: `Learner message: ${turn.text}` }];
    const reply = {};
    // Pattern metadata is used locally for the final template link. Replaying it
    // to the provider on every turn adds tokens without helping the conversation.
    for (const field of ["question", "discussion", "hint", "pseudocode", "code"]) {
      if (turn[field]) reply[field] = turn[field];
    }
    return Object.keys(reply).length ? [{ role: "assistant", content: JSON.stringify(reply) }] : [];
  });
  return [
    { role: "system", content: `You are a calm JavaScript DSA interview coach. Current stage: ${STAGES[session.stageIndex]}. Return JSON only with question, discussion, hint, pseudocode, code, matchedPatternId. Only these fields may be non-empty: ${allowed}. Do not put source code in question, discussion, or hint. Ask the learner to reason before revealing help.${nudge} ${reminder}\nCoaching knowledge: ${JSON.stringify(COACHING_KNOWLEDGE)}` },
    { role: "user", content: `Confirmed problem:\n${JSON.stringify(session.capture)}` },
    ...history,
    { role: "user", content: `Learner message: ${userText}` },
  ];
}
function containsCode(value) {
  return /```|^\s{4,}(?:if|for|while|return|const|let|function|class)\b|(?:^|\n)\s*(?:for|while|if)\s*\(|=>|\breturn\s+[^.\n]+;|[{}]\s*$/m.test(value || "");
}
function validateReply(raw, stageIndex) {
  const data = JSON.parse(raw);
  const allowed = new Set(STAGE_FIELDS[stageIndex]);
  for (const key of ["question", "discussion", "hint", "pseudocode", "code"]) {
    data[key] = typeof data[key] === "string" ? data[key] : "";
    if (!allowed.has(key) && data[key]) throw new Error(`The response revealed ${key} too early.`);
    if (key !== "pseudocode" && key !== "code" && data[key] && containsCode(data[key])) throw new Error("The response revealed code too early.");
  }
  data.matchedPatternId = typeof data.matchedPatternId === "string" ? data.matchedPatternId : "";
  return data;
}
function validatedFieldsOnly(raw, stageIndex) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  const allowed = new Set(STAGE_FIELDS[stageIndex]);
  const clean = { matchedPatternId: typeof data.matchedPatternId === "string" ? data.matchedPatternId : "" };
  for (const field of ["question", "discussion", "hint", "pseudocode", "code"]) {
    const value = typeof data[field] === "string" ? data[field] : "";
    if (!value || !allowed.has(field) || ((field !== "pseudocode" && field !== "code") && containsCode(value))) continue;
    clean[field] = value;
  }
  return Object.keys(clean).some((key) => key !== "matchedPatternId") ? clean : null;
}
async function safeCoachReply(session, text) {
  // activeCredential uses the independent credential queue. No session commit is
  // held while waiting here, so a slow storage read or provider call cannot block
  // commits for this or another coaching session.
  const credential = await activeCredential();
  if (!credential) throw new Error("Configure an OpenAI API key in extension settings first.");
  let raw = await providerChat(credential.provider, promptFor(session, text), { apiKey: credential.key });
  try { return validateReply(raw, session.stageIndex); }
  catch {
    raw = await providerChat(credential.provider, promptFor(session, text, "Your last reply violated the stage contract. Return valid JSON with only permitted fields and no code-like prose."), { apiKey: credential.key });
    try { return validateReply(raw, session.stageIndex); }
    catch { const partial = validatedFieldsOnly(raw, session.stageIndex); if (partial) return partial; throw new Error("The provider response could not be displayed safely. Try again."); }
  }
}
function templateOutcome(reply, stageIndex) {
  if (stageIndex !== STAGES.length - 1) return null;
  const pattern = COACHING_KNOWLEDGE.find((item) => item.id === reply.matchedPatternId);
  if (pattern?.templateKey && TEMPLATES[pattern.templateKey]) return { key: pattern.templateKey, label: `Open template: ${pattern.templateKey}` };
  return { key: "", label: "No built-in template matches this pattern; use the coach's pseudocode and code as the reference." };
}
async function beginProviderRequest(sessionId, text, retry = false) {
  const requestId = crypto.randomUUID();
  const begun = await commitSession((sessions) => {
    const current = sessions[sessionId];
    if (!current) return null;
    if (current.pendingRequest && !retry) { current.error = "A request is already in progress."; touch(current); return { refused: true, session: current }; }
    if (retry && current.pendingRequest) { current.epoch++; current.pendingRequest = null; }
    current.pendingRequest = { requestId, epoch: current.epoch }; current.lastUserMessage = text; current.error = ""; touch(current); return { session: current };
  });
  if (!begun) return null;
  if (begun.refused) { await pushSession(begun.session); return null; }
  const pending = begun.session; await pushSession(pending);
  void (async () => {
    try {
      const reply = await safeCoachReply(pending, text);
      const updated = await commitSession((sessions) => {
        const current = sessions[sessionId];
        if (!current || current.pendingRequest?.requestId !== requestId || current.pendingRequest.epoch !== pending.epoch) return null;
        current.pendingRequest = null; current.history.push({ role: "user", text, at: now() }, { role: "coach", ...reply, templateOutcome: templateOutcome(reply, current.stageIndex), at: now() }); capHistory(current); touch(current); return current;
      });
      await pushSession(updated);
    } catch (error) {
      const updated = await commitSession((sessions) => {
        const current = sessions[sessionId];
        if (!current || current.pendingRequest?.requestId !== requestId || current.pendingRequest.epoch !== pending.epoch) return null;
        current.pendingRequest = null; current.error = error.message || "The provider request failed."; touch(current); return current;
      });
      await pushSession(updated);
    }
  })();
  return pending;
}

async function sessionForPort(context, message) {
  const tab = await activeTabFor(context.windowId);
  const sessions = await readSessions();
  const requested = message.sessionId ? sessions[message.sessionId] : null;
  const session = requested || findSessionForTab(sessions, tab?.id);
  if (!session || !tab?.id) return { tab, session: null, mismatch: false };
  let currentOrigin = "";
  try { currentOrigin = tab.url ? new URL(tab.url).origin : ""; } catch {}
  const sameOrigin = !currentOrigin || session.origin === currentOrigin;
  const acknowledged = session.mismatchAck?.tabId === tab.id && (!currentOrigin || session.mismatchAck?.origin === currentOrigin);
  // activeTab access is revoked on cross-origin navigation, which can leave
  // tab.url unavailable. Treat a navigation whose origin cannot be verified as
  // a mismatch until the learner explicitly acknowledges reusing this session.
  const originUnverified = session.navigationUnverified?.tabId === tab.id;
  const allowed = !originUnverified && ((session.tabId === tab.id && sameOrigin) || acknowledged);
  return { tab, session, mismatch: !allowed };
}
async function sendPortState(port, context) {
  // A port follows the window's currently active tab.  Do not feed the last
  // displayed session back as a requested session here: doing so would make a
  // tab activation keep rendering the old tab's session as a mismatch instead
  // of resolving the newly active tab's own session.
  const { tab, session, mismatch } = await sessionForPort(context, {});
  if (session) { context.currentSessionId = session.id; port.postMessage({ type: "coach:update", session: publicSession({ ...session, mismatch: mismatch ? { currentTabId: tab?.id, message: MISMATCH_MESSAGE } : null }) }); }
  else {
    // Without this, a stale currentSessionId from a previously displayed
    // session would let pushSession's identity fallback later deliver a
    // background completion for that old session to this port even though
    // the panel now shows (and the active tab has) no session at all.
    context.currentSessionId = null;
    port.postMessage({ type: "coach:update", session: null });
  }
}
async function handlePanelMessage(port, context, message) {
  if (message.windowId !== undefined) { port.disconnect(); return; }
  if (message.type === "coach:get-active-session") return sendPortState(port, context);
  const { tab, session, mismatch } = await sessionForPort(context, message);
  if (!session || !tab?.id) return port.postMessage({ type: "coach:error", error: "Open a coaching session from the problem tab first." });
  context.currentSessionId = session.id;
  if (message.type === "coach:continue-anyway") {
    if (!mismatch) return port.postMessage({ type: "coach:error", error: "This session already belongs to the active tab." });
    let origin = ""; try { origin = tab.url ? new URL(tab.url).origin : ""; } catch {}
    const updated = await commitSession((sessions) => { const current = sessions[session.id]; if (!current) return null; current.mismatchAck = { tabId: tab.id, origin }; current.navigationUnverified = null; touch(current); return current; });
    return pushSession(updated);
  }
  if (mismatch) return port.postMessage({ type: "coach:mismatch", sessionId: session.id, currentTabId: tab.id, message: MISMATCH_MESSAGE });
  if (message.type === "coach:confirm-capture") {
    if (message.captureId !== session.captureId || session.captureStatus !== "preview") return port.postMessage({ type: "coach:error", error: "That capture is no longer available. Start a new session." });
    const updated = await commitSession((sessions) => { const current = sessions[session.id]; if (!current || current.captureId !== message.captureId) return null; current.confirmed = true; touch(current); return current; });
    return pushSession(updated);
  }
  if (message.type === "coach:advance") {
    if (!session.confirmed) return port.postMessage({ type: "coach:error", error: "Confirm the captured problem text before advancing the coaching stages." });
    const updated = await commitSession((sessions) => { const current = sessions[session.id]; if (!current) return null; current.stageIndex = Math.min(current.stageIndex + 1, STAGES.length - 1); touch(current); return current; });
    return pushSession(updated);
  }
  if (message.type === "coach:get-template") {
    if (session.stageIndex !== STAGES.length - 1 || !TEMPLATES[message.templateKey]) return port.postMessage({ type: "coach:error", error: "A matching template is available only after the full-code stage." });
    return port.postMessage({ type: "coach:template", key: message.templateKey, code: TEMPLATES[message.templateKey] });
  }
  if (message.type === "coach:reset") {
    const updated = await commitSession((sessions) => { const current = sessions[session.id]; if (!current) return null; current.epoch++; delete sessions[session.id]; return null; });
    context.currentSessionId = null; return sendPortState(port, context);
  }
  if (!session.confirmed) return port.postMessage({ type: "coach:error", error: "Confirm the captured problem text before sending it to a provider." });
  if (message.type === "coach:send") return beginProviderRequest(session.id, String(message.text || ""));
  if (message.type === "coach:retry") return beginProviderRequest(session.id, session.lastUserMessage || "Please continue coaching me.", true);
}

async function insertTemplate(tab, frameId, text) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ["content.js"] });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "dsa-insert", text }, { frameId });
    if (!response?.ok) throw new Error(response?.error || "Insert failed");
    chrome.action.setBadgeText({ text: "", tabId: tab.id });
  } catch (error) { badgeError(error.message || "Could not insert the template on this page.", tab?.id); }
}

chrome.runtime.onInstalled.addListener(() => { buildMenus(); void reconcileCredentials(); });
chrome.runtime.onStartup.addListener(() => { buildMenus(); void reconcileCredentials(); });
chrome.action.onClicked.addListener((tab) => launchCoach(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === COACH_MENU_ID) launchCoach(tab);
  if (typeof info.menuItemId === "string" && info.menuItemId.startsWith("template:") && tab?.id) void insertTemplate(tab, typeof info.frameId === "number" ? info.frameId : 0, TEMPLATES[info.menuItemId.slice(9)]);
});
chrome.tabs.onRemoved.addListener((tabId) => { void commitSession((sessions) => { for (const session of Object.values(sessions)) if (session.tabId === tabId || session.mismatchAck?.tabId === tabId) delete sessions[session.id]; }); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // URL is a sensitive Tab property and may be absent after activeTab is
  // revoked. A loading event is still enough to conservatively stop the panel
  // from silently continuing a session against a potentially new page.
  if (changeInfo.status !== "loading" && !changeInfo.url) return;
  void (async () => {
    const changed = await commitSession((sessions) => {
      const updated = [];
      for (const session of Object.values(sessions)) {
        if (session.tabId !== tabId && session.mismatchAck?.tabId !== tabId) continue;
        const expectedOrigin = session.mismatchAck?.tabId === tabId ? session.mismatchAck.origin : session.origin;
        let currentOrigin = "";
        try { currentOrigin = new URL(changeInfo.url || tab?.url || "").origin; } catch {}
        session.navigationUnverified = !currentOrigin || currentOrigin !== expectedOrigin ? { tabId } : null;
        touch(session); updated.push(session);
      }
      return updated;
    });
    for (const session of changed || []) {
      for (const [port, context] of panelPorts) if (context.windowId === session.windowId) await sendPortState(port, context);
    }
  })();
});
chrome.tabs.onActivated.addListener(({ windowId }) => { for (const [port, context] of panelPorts) if (context.windowId === windowId) void sendPortState(port, context); });
chrome.windows.onFocusChanged.addListener((windowId) => { for (const [port, context] of panelPorts) if (context.windowId === windowId) void sendPortState(port, context); });

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "coach-panel" || port.sender?.id !== chrome.runtime.id || port.sender?.url !== extensionUrl("sidepanel.html")) { port.disconnect(); return; }
  const context = { ready: false, windowId: null, currentSessionId: null };
  panelPorts.set(port, context);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.onMessage.addListener((message) => {
    void (async () => {
      await sessionReady;
      if (!context.ready) {
        if (message?.type !== "coach:handshake" || !Number.isInteger(message.windowId)) { port.disconnect(); return; }
        try { await chrome.windows.get(message.windowId); } catch { port.disconnect(); return; }
        context.ready = true; context.windowId = message.windowId; port.postMessage({ type: "coach:ready" }); return;
      }
      await handlePanelMessage(port, context, message || {});
    })();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "capture:result") {
    const request = captureRequests.get(message.requestId);
    let senderOrigin = ""; try { senderOrigin = sender.url ? new URL(sender.url).origin : ""; } catch {}
    if (request && sender.id === chrome.runtime.id && sender.tab?.id === request.tabId && sender.frameId === request.frameId && senderOrigin === request.origin) { captureRequests.delete(message.requestId); request.resolve(message.capture || {}); }
    return;
  }
  if (!message?.type?.startsWith("credential:") || sender.id !== chrome.runtime.id || sender.url !== extensionUrl("options.html")) return;
  void (async () => {
    try {
      if (message.type === "credential:get") sendResponse({ ok: true, ...(await credentialStatus()) });
      else if (message.type === "credential:set") sendResponse({ ok: true, credential: await setCredential(message) });
      else if (message.type === "credential:delete") sendResponse({ ok: true, result: await deleteCredential() });
      else if (message.type === "credential:set-mode") sendResponse({ ok: true, credential: await setCredentialMode(message) });
      else if (message.type === "credential:test") { const credential = await activeCredential(); if (!credential) throw new Error("Save a key before testing it."); await PROVIDERS[credential.provider].test(credential.key); sendResponse({ ok: true }); }
      else throw new Error("Unsupported credential operation.");
    } catch (error) { sendResponse({ ok: false, error: error.message || "Credential operation failed." }); }
  })();
  return true;
});
