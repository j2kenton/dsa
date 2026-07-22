importScripts("templates.js", "coaching-knowledge.js", "providers.js");

const MENU_ID_ROOT = "dsa-templates";
const COACH_MENU_ID = "dsa-coach-start";
const SESSION_KEY = "dsaCoach.sessions";
const CREDENTIAL_KEY = "dsaCoach.credential";
const TOMBSTONE_KEY = "dsaCoach.credTombstone";
const HEALTH_KEY = "dsaCoach.areaHealth";
const PROBE_KEY = "dsaCoach.healthProbe";
const MAX_CAPTURE = 8000;
const MIN_MEANINGFUL_CAPTURE_CHARS = 40;
const MAX_EDITOR_CODE = 4000;
const MAX_TURNS = 40;
const MAX_HISTORY_BYTES = 128 * 1024;
const MAX_SESSIONS = 8;
const PERSISTENT_SESSION_KEY = "dsaCoach.sessionsByUrl";
const MISMATCH_MESSAGE = "This conversation belongs to another page. Continue anyway to reuse its original problem text, or start a new capture.";
const STAGES = [
  { id: "restate", label: "Read & restate", fields: ["question", "discussion", "hint"],
    objective: "Help you read through the problem carefully, restate it in your own words, make notes in your editor, and confirm your understanding with the interviewer before moving on.",
    userPrompt: "Read through the problem carefully. Restate it in your own words and make notes in your editor. When you're ready, confirm your understanding with the interviewer.",
    placeholder: "" },
  { id: "clarify", label: "Clarify", fields: ["question", "discussion", "hint"],
    objective: "Help you ask clarifying questions about the problem's input, output, and constraints before you commit to any approach. Remind you to check the examples first — if the answer is already obvious from them, state your assumption aloud to the interviewer rather than asking. Do not suggest an approach, pattern, or data structure yet.",
    userPrompt: "Ask clarifying questions about the input, output, or edge cases. Check the examples first — if something is already clear, state your assumption aloud instead of asking.",
    placeholder: "" },
  { id: "examples", label: "Examples & pattern", fields: ["question", "discussion", "hint"],
    objective: "Walk through the given examples together and ask you to describe what they have in common. Help you name the pattern the examples suggest. Do not name the pattern or an approach yourself — ask questions that let you notice it.",
    userPrompt: "Look at the examples. What do they have in common? What pattern do they suggest?",
    placeholder: "" },
  { id: "brute-force", label: "Brute force", fields: ["question", "discussion", "hint"],
    objective: "Get a brute-force solution stated in plain language before anything else. Treat a brute-force idea you propose as the correct starting move: affirm it and ask you to state it precisely (what you would iterate over, what you would check). Do not raise time complexity, nested loops, or optimization at this stage, and do not volunteer the iteration strategy or the data structure yourself — ask a question that lets you arrive at it.",
    userPrompt: "Describe the simplest brute-force approach you can think of, even if it's slow.",
    placeholder: "" },
  { id: "optimize", label: "Optimize", fields: ["question", "discussion", "hint"],
    objective: "Now that a brute force exists, help you find and remove its repeated or unnecessary work. Ask about what the brute force recomputes before naming a data structure or technique, and let you propose one first.",
    userPrompt: "Where does your brute force repeat work it doesn't need to?",
    placeholder: "" },
  { id: "edge-cases", label: "Edge cases", fields: ["question", "discussion", "hint"],
    objective: "Help you enumerate edge cases your approach must handle: empty input, single-element input, duplicates, and boundary sizes. Point out specific cases you may have overlooked.",
    userPrompt: "What edge cases could break your approach? Think about empty input, single elements, duplicates, and boundaries.",
    placeholder: "" },
  { id: "pseudocode", label: "Pseudocode", fields: ["question", "discussion", "hint", "pseudocode"],
    objective: "Help you turn your approach into step-by-step pseudocode. You should write it in your editor; discuss specific steps here rather than having the coach write it for you.",
    userPrompt: "Write your pseudocode in your editor, then ask about a specific step here.",
    placeholder: "" },
  { id: "code", label: "Code", fields: ["question", "discussion", "hint", "pseudocode", "code"],
    objective: "Help you finish and debug real code. You should write it in your editor. If you ask what the coach thinks of your code, read your actual editor contents (attached via the \"Attach my editor code\" checkbox) and critique that — never substitute the coach's own pseudocode or code for an answer.",
    userPrompt: "Write your code in your editor, then ask what you'd like feedback on.",
    placeholder: "" },
];
const STAGE_KICKOFF_LINES = {
  restate: "Take a moment to read through the problem carefully. When you're ready, try restating it in your own words — what is it really asking you to do?",
  clarify: "Now let's think about clarifying questions. What about this problem is ambiguous or unclear? Remember to check the examples first — if something is already obvious from them, just state your assumption aloud to the interviewer.",
  examples: "Let's look at the examples together. What do you notice they have in common? Walk through one of them step by step and describe what's happening.",
  "brute-force": "Good, you've got a solid understanding. Now let's think about the simplest possible approach — a brute force. What's the most straightforward way you could solve this, even if it's slow?",
  optimize: "Nice — you've got a working brute force. Now let's look for where it's doing unnecessary or repeated work. What's the bottleneck?",
  "edge-cases": "Before you start coding, let's think about edge cases. What inputs could break your approach? Think about empty input, single elements, very large or very small values, duplicates.",
  pseudocode: "Let's turn your approach into step-by-step pseudocode. Write it in your editor and we can discuss specific steps here.",
  code: "Time to write real code. Write your implementation in your editor, and ask me about anything you're unsure of.",
};
const STAGE_FIELDS = STAGES.map((stage) => stage.fields);
function clampStage(index) { return Math.min(Math.max(Number(index) || 0, 0), STAGES.length - 1); }
function stageFor(index) { return STAGES[clampStage(index)]; }
function stageFieldsFor(index) { return stageFor(index).fields; }
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
function totalCaptureChars(capture) {
  return (capture?.title || "").length + (capture?.description || "").length + (capture?.examples || "").length + (capture?.constraints || "").length;
}
function meaningfulDescription(description) {
  // Strip Follow-up section heading it is not part of the core problem text.
  return (description || "").replace(/\s*Follow-up[\s\S]*$/i, "").trim();
}
function hasCaptureText(capture) {
  if (!capture) return false;
  if (totalCaptureChars(capture) < MIN_MEANINGFUL_CAPTURE_CHARS) return false;
  const bodyLen = (capture.description || "").length + (capture.examples || "").length + (capture.constraints || "").length;
  if (bodyLen < 20) return false;
  if (meaningfulDescription(capture.description).length < 20) return false;
  return true;
}
function publicSession(session) {
  if (!session) return null;
  const { tabId, windowId, origin, capture, key, apiKey, ...safe } = session;
  const stageIndex = clampStage(session.stageIndex);
  const stage = stageFor(stageIndex);
  return {
    ...safe,
    stageIndex,
    stage: { index: stageIndex, id: stage.id, label: stage.label, userPrompt: stage.userPrompt, fields: stage.fields },
    stages: STAGES.map(({ id, label }) => ({ id, label })),
    canReadEditor: /^https:\/\/leetcode\.com\/problems\//.test(session.url || ""),
    maxCaptureChars: MAX_CAPTURE,
    capture: capture && { title: capture.title, description: capture.description, examples: capture.examples, constraints: capture.constraints, sourceUrl: capture.sourceUrl, truncated: capture.truncated },
  };
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
    // Persist only the mutated session when the mutator returns a single session.
    // For batch operations (null/array returns) persist all confirmed sessions.
    const mutated = result && typeof result === "object" && !Array.isArray(result)
      ? (result.id ? result : (result.session || null))
      : null;
    if (mutated && mutated.url && mutated.confirmed) {
      void persistSessionByUrl(mutated.url, publicSession(mutated));
    } else {
      for (const session of Object.values(sessions)) {
        if (session.url && session.confirmed) void persistSessionByUrl(session.url, publicSession(session));
      }
    }
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
      if (session.pendingInterviewerRequest) {
        session.pendingInterviewerRequest = null; touch(session);
      }
      const clamped = clampStage(session.stageIndex);
      if (clamped !== session.stageIndex) { session.stageIndex = clamped; touch(session); }
      if (!session.stageKickoffsSent) session.stageKickoffsSent = [];
      if (session.stageKickoffsSent.length === 0 && session.confirmed) {
        for (let i = 0; i <= clamped; i++) { const sid = STAGES[i].id; if (!session.stageKickoffsSent.includes(sid)) session.stageKickoffsSent.push(sid); }
      }
    }
    return null;
  });
}
const sessionReady = rehydrateSessions();
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "leetcode.com") return u.origin + u.pathname.replace(/\/+$/, "");
    return u.origin + u.pathname;
  } catch { return url; }
}
async function persistSessionByUrl(url, sessionData) {
  const key = normalizeUrl(url);
  if (!key) return;
  try {
    const store = (await chrome.storage.local.get(PERSISTENT_SESSION_KEY))[PERSISTENT_SESSION_KEY] || {};
    store[key] = { ...sessionData, savedAt: now() };
    const entries = Object.entries(store).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
    const trimmed = Object.fromEntries(entries.slice(0, MAX_SESSIONS));
    await chrome.storage.local.set({ [PERSISTENT_SESSION_KEY]: trimmed });
  } catch {}
}
async function loadSessionByUrl(url) {
  const key = normalizeUrl(url);
  if (!key) return null;
  try {
    const store = (await chrome.storage.local.get(PERSISTENT_SESSION_KEY))[PERSISTENT_SESSION_KEY] || {};
    return store[key] || null;
  } catch { return null; }
}
async function removeSessionByUrl(url) {
  const key = normalizeUrl(url);
  if (!key) return;
  try {
    const store = (await chrome.storage.local.get(PERSISTENT_SESSION_KEY))[PERSISTENT_SESSION_KEY] || {};
    delete store[key];
    await chrome.storage.local.set({ [PERSISTENT_SESSION_KEY]: store });
  } catch {}
}
async function activeTabFor(windowId) { const tabs = await chrome.tabs.query({ active: true, windowId }); return tabs[0] || null; }

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function clipCapture(capture) {
  const fields = ["title", "description", "examples", "constraints"];
  let remaining = MAX_CAPTURE; const clipped = {};
  for (const field of fields) { const value = String(capture[field] || ""); clipped[field] = value.slice(0, Math.max(remaining, 0)); remaining -= clipped[field].length; }
  return { ...clipped, sourceUrl: capture.sourceUrl || "", truncated: fields.some((field) => String(capture[field] || "").length > clipped[field].length) };
}
function requestLeetCodeCapture(session) {
  const requestId = crypto.randomUUID();
  return new Promise(async (resolve, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setTimeout(() => { captureRequests.delete(requestId); reject(new Error("Timed out waiting for page capture.")); }, 10000);
    captureRequests.set(requestId, { tabId: session.tabId, frameId: 0, origin: session.origin, resolve: (capture) => { clearTimeout(timer); resolve(capture); } });
    while (Date.now() < deadline) {
      try { await chrome.tabs.sendMessage(session.tabId, { type: "capture:leetcode", requestId }); return; }
      catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
    }
    clearTimeout(timer); captureRequests.delete(requestId); reject(new Error("Timed out waiting for page capture."));
  });
}
function requestEditorCode(session) {
  const requestId = crypto.randomUUID();
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => { captureRequests.delete(requestId); reject(new Error("Timed out reading the editor.")); }, 3500);
    captureRequests.set(requestId, { tabId: session.tabId, frameId: 0, origin: session.origin, resolve: (code) => { clearTimeout(timer); resolve(code); } });
    try { await chrome.tabs.sendMessage(session.tabId, { type: "editor:read", requestId }); }
    catch (error) { clearTimeout(timer); captureRequests.delete(requestId); reject(error); }
  });
}
// Reading is opt-in per message (the panel's "Attach my editor code" checkbox) and
// never persisted — only a boolean codeAttached flag reaches session history.
async function readEditorCode(session) {
  if (!/^https:\/\/leetcode\.com\/problems\//.test(session.url || "")) return "";
  try { const code = await requestEditorCode(session); return String(code || "").slice(0, MAX_EDITOR_CODE); }
  catch { return ""; }
}
async function captureFor(session) {
  let capture = null;
  const deadline = Date.now() + 10000;
  if (/^https:\/\/leetcode\.com\/problems\//.test(session.url)) {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0) {
      try { capture = await withTimeout(requestLeetCodeCapture(session), remaining); } catch { /* Selection remains an intentional fallback. */ }
    }
  }
  if (!hasCaptureText(capture)) {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0) {
      try {
        const [result] = await withTimeout(chrome.scripting.executeScript({ target: { tabId: session.tabId }, func: () => ({ selected: String(getSelection()), sourceUrl: location.href }) }), remaining);
        const selected = result?.result?.selected || "";
        capture = { title: selected ? "Selected problem text" : "", description: selected, sourceUrl: result?.result?.sourceUrl || session.url };
      } catch {}
    }
  }
  return clipCapture(capture || {});
}
function isRestrictedProtocol(urlString) {
  if (!urlString) return false;
  try {
    const protocol = new URL(urlString).protocol;
    return protocol === "chrome:" || protocol === "about:" || protocol === "data:" || protocol === "chrome-extension:";
  } catch {
    return true;
  }
}

const KNOWN_DISABLED_SIGNATURES = [
  "side panel is not enabled for this tab",
];
const KNOWN_ACCESS_DENIED_SIGNATURES = [
  "cannot access this page",
  "access denied",
];

async function ensurePanelOpen(tab, { gesture = true } = {}) {
  if (!tab?.id) return;
  if (gesture) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (openError) {
      const openMessage = String(openError?.message || openError || "");
      const openLower = openMessage.toLowerCase();
      const knownDisabled = KNOWN_DISABLED_SIGNATURES.some((sig) => openLower === sig);
      const knownAccessDenied = KNOWN_ACCESS_DENIED_SIGNATURES.some((sig) => openLower === sig);

      let options = null;
      try {
        options = await chrome.sidePanel.getOptions({ tabId: tab.id });
      } catch {
        options = null;
      }

      if (knownDisabled && options !== null && options.enabled === false) {
        try {
          await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true });
          badgeError("Coach is ready for this tab — click the icon again to open it.", tab.id);
        } catch (setError) {
          const setLower = String(setError?.message || setError || "").toLowerCase();
          if (KNOWN_ACCESS_DENIED_SIGNATURES.some((sig) => setLower === sig)) {
            badgeError("Chrome could not open the coaching panel for this page. Has access to this site?", tab.id);
          } else {
            badgeError("Could not open the coaching panel for this page.", tab.id);
          }
        }
        return;
      }

      if (isRestrictedProtocol(tab.url) || knownAccessDenied) {
        badgeError("Chrome could not open the coaching panel for this page. Has access to this site?", tab.id);
        return;
      }

      console.warn("[coach] Unexpected sidePanel.open() failure:", openMessage, "(tab:", tab.id, tab.url, ")");
      badgeError("Could not open the coaching panel for this page.", tab.id);
    }
  } else {
    try {
      await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true });
    } catch {}
  }
}
function launchCoach(tab) {
  if (!tab?.id) { badgeError("No active tab to coach."); return; }
  const captureId = crypto.randomUUID();
  void ensurePanelOpen(tab);
  void (async () => {
    await sessionReady;
    const existing = await loadSessionByUrl(tab.url || "");
    if (existing && existing.confirmed && existing.stage !== undefined) {
      const session = await commitSession((sessions) => {
        const normalized = normalizeUrl(tab.url || "");
        for (const [sid, s] of Object.entries(sessions)) {
          if (s.url && normalizeUrl(s.url) === normalized) delete sessions[sid];
        }
        const id = crypto.randomUUID();
        let stageKickoffsSent = existing.stageKickoffsSent || [];
        if (stageKickoffsSent.length === 0) {
          for (let i = 0; i <= clampStage(existing.stageIndex || 0); i++) { const sid = STAGES[i].id; if (!stageKickoffsSent.includes(sid)) stageKickoffsSent.push(sid); }
        }
        const record = { id, tabId: tab.id, windowId: tab.windowId, origin: (() => { try { return new URL(tab.url || "").origin; } catch { return ""; } })(), url: tab.url || "", captureId, capture: existing.capture || null, captureStatus: "preview", confirmed: true, mismatchAck: null, stageIndex: existing.stageIndex || 0, history: existing.history || [], interviewerHistory: existing.interviewerHistory || [], pendingRequest: null, epoch: 0, revision: 1, createdAt: now(), updatedAt: now(), stageKickoffsSent };
        sessions[id] = record; return record;
      });
      await pushSession(session);
      return;
    }
    const session = await commitSession((sessions) => {
      const id = crypto.randomUUID();
      const record = { id, tabId: tab.id, windowId: tab.windowId, origin: (() => { try { return new URL(tab.url || "").origin; } catch { return ""; } })(), url: tab.url || "", captureId, capture: null, captureStatus: "capturing", confirmed: false, mismatchAck: null, stageIndex: 0, history: [], interviewerHistory: [], pendingRequest: null, epoch: 0, revision: 1, createdAt: now(), updatedAt: now(), stageKickoffsSent: [] };
      sessions[id] = record; return record;
    });
    await pushSession(session);
    try {
      const capture = await captureFor(session);
      const updated = await commitSession((sessions) => {
        const current = sessions[session.id];
        if (!current || current.captureId !== captureId || current.epoch !== session.epoch) return null;
        current.capture = capture; current.captureStatus = hasCaptureText(capture) ? "preview" : "empty"; touch(current); return current;
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

const COACH_PERSONA = "You are a calm, encouraging JavaScript DSA interview coach. Always address the user directly as 'you' — never say 'the learner'. Respond to what the user actually said: reference their specific words, acknowledge what they noticed, catch their mistakes (off-by-one errors, confusing concepts, wrong assumptions), and guide them in baby steps toward the next stage. Be specific and encouraging, not generic. When the user proposes something good, say so and explain why briefly, then nudge them to the next step. When the user makes a mistake, point it out gently with a concrete counter-example. Work through problems the way a strong interview candidate does: study the given examples together with the user and help them name the pattern, derive the most intuitive approach from that pattern, get a brute-force solution stated in plain language, and only then optimize it. When the user proposes a brute-force approach, affirm it as the correct place to start and ask them to state it precisely. Never spell out the iteration strategy or name the data structure yourself; ask a question that lets the user get there. Prefer modern JavaScript in any discussion, pseudocode, or code: refer to Map, Set, or Object.groupBy by name, and use current syntax.";
const INTERVIEWER_PERSONA = "You are playing the role of a friendly but professional technical interviewer in a coding interview for a JavaScript position. Answer the candidate's clarifying questions directly and concisely, as a real interviewer would. Provide specific answers about input ranges, expected outputs, edge case handling, and constraints. Stay in character as the interviewer — do not coach, teach, or guide. Just answer questions about the problem specification. If the candidate asks something not specified in the problem, give a reasonable answer that a real interviewer would give. Always address the candidate as 'you'.";
function promptFor(session, userText, reminder = "", editorCode = "", codeRequested = false) {
  const stage = stageFor(session.stageIndex);
  const allowed = stage.fields.join(", ");
  const elapsed = Math.floor((now() - session.createdAt) / 60000);
  const nudge = elapsed >= 20 ? " Offer one concise time-management nudge: pick an approach and move toward pseudocode." : "";
  // History is deliberately part of the provider context, not just panel display.
  // This makes a retry and every later turn continue the same Socratic discussion.
  const history = (session.history || []).flatMap((turn) => {
    if (turn.role === "user") return [{ role: "user", content: `User message: ${turn.text}` }];
    const reply = {};
    for (const field of ["question", "discussion", "hint", "pseudocode", "code"]) {
      if (turn[field] && stage.fields.includes(field)) reply[field] = turn[field];
    }
    return Object.keys(reply).length ? [{ role: "assistant", content: JSON.stringify(reply) }] : [];
  });
  const codeGuidance = !codeRequested
    ? ` If asked what you think of the user's code, say plainly that you cannot see it and ask them to tick "Attach my editor code" and resend — never invent or substitute your own pseudocode or code for an answer.`
    : !editorCode
    ? ` The user ticked "Attach my editor code" for this message, but nothing could be read from it (the editor may be empty, or the read failed) — do not ask them to tick it again. If asked what you think of their code, say plainly that no code came through this time and ask them to make sure the editor has code in it and resend — never invent or substitute your own pseudocode or code for an answer.`
    : "";
  const messages = [
    { role: "system", content: `${COACH_PERSONA} Current stage: ${stage.id} — ${stage.objective} Return JSON only with question, discussion, hint, pseudocode, code, matchedPatternId. Only these fields may be non-empty: ${allowed}. Do not put source code in question, discussion, or hint. Ask the user to reason before revealing help.${codeGuidance}${nudge} ${reminder}\nCoaching knowledge: ${JSON.stringify(COACHING_KNOWLEDGE)}` },
    { role: "user", content: `Confirmed problem:\n${JSON.stringify(session.capture)}` },
    ...history,
  ];
  if (editorCode) messages.push({ role: "user", content: `The user's current editor contents, attached because they asked. This is a best-effort read of the rendered DOM: for a long file it may include only the lines currently scrolled into view, not the whole file. If the code looks like it might be cut off (e.g. it doesn't start at the function signature, or trails off mid-statement), say so and ask the user to scroll and resend rather than assuming you're seeing everything:\n${editorCode}` });
  messages.push({ role: "user", content: `User message: ${userText}` });
  return messages;
}
function interviewerPromptFor(session, userText) {
  const stage = stageFor(session.stageIndex);
  const history = (session.interviewerHistory || []).flatMap((turn) => {
    if (turn.role === "user") return [{ role: "user", content: turn.text }];
    if (turn.role === "interviewer") return [{ role: "assistant", content: turn.text }];
    return [];
  });
  return [
    { role: "system", content: `${INTERVIEWER_PERSONA}\nCurrent stage: ${stage.id}. The candidate is working through a coding interview problem. Answer their questions about the problem specification directly.` },
    { role: "user", content: `Problem:\n${JSON.stringify(session.capture)}` },
    ...history,
    { role: "user", content: userText },
  ];
}
function containsCode(value) {
  return /```|^\s{4,}(?:if|for|while|return|const|let|function|class)\b|(?:^|\n)\s*(?:for|while|if)\s*\(|=>|\breturn\s+[^.\n]+;|[{}]\s*$/m.test(value || "");
}
function validateReply(raw, stageIndex) {
  const data = JSON.parse(raw);
  const allowed = new Set(stageFieldsFor(stageIndex));
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
  const allowed = new Set(stageFieldsFor(stageIndex));
  const clean = { matchedPatternId: typeof data.matchedPatternId === "string" ? data.matchedPatternId : "" };
  for (const field of ["question", "discussion", "hint", "pseudocode", "code"]) {
    const value = typeof data[field] === "string" ? data[field] : "";
    if (!value || !allowed.has(field) || ((field !== "pseudocode" && field !== "code") && containsCode(value))) continue;
    clean[field] = value;
  }
  return Object.keys(clean).some((key) => key !== "matchedPatternId") ? clean : null;
}
async function safeCoachReply(session, text, editorCode = "", codeRequested = false) {
  // activeCredential uses the independent credential queue. No session commit is
  // held while waiting here, so a slow storage read or provider call cannot block
  // commits for this or another coaching session.
  const credential = await activeCredential();
  if (!credential) throw new Error("Configure an OpenAI API key in extension settings first.");
  let raw = await providerChat(credential.provider, promptFor(session, text, "", editorCode, codeRequested), { apiKey: credential.key, jsonMode: true });
  try { return validateReply(raw, session.stageIndex); }
  catch {
      raw = await providerChat(credential.provider, promptFor(session, text, "Your last reply violated the stage contract. Return valid JSON with only permitted fields and no code-like prose.", editorCode, codeRequested), { apiKey: credential.key, jsonMode: true });
    try { return validateReply(raw, session.stageIndex); }
    catch { const partial = validatedFieldsOnly(raw, session.stageIndex); if (partial) return partial; throw new Error("The provider response could not be displayed safely. Try again."); }
  }
}
function templateOutcome(reply, stageIndex) {
  if (clampStage(stageIndex) !== STAGES.length - 1) return null;
  const pattern = COACHING_KNOWLEDGE.find((item) => item.id === reply.matchedPatternId);
  if (pattern?.templateKey && TEMPLATES[pattern.templateKey]) return { key: pattern.templateKey, label: `Open template: ${pattern.templateKey}` };
  return { key: "", label: "No built-in template matches this pattern; use the coach's pseudocode and code as the reference." };
}
async function beginProviderRequest(sessionId, text, retry = false, includeCode = false) {
  const requestId = crypto.randomUUID();
  const begun = await commitSession((sessions) => {
    const current = sessions[sessionId];
    if (!current) return null;
    if (current.pendingRequest && !retry) { current.error = "A request is already in progress."; touch(current); return { refused: true, session: current }; }
    if (retry && current.pendingRequest) { current.epoch++; current.pendingRequest = null; }
    current.pendingRequest = { requestId, epoch: current.epoch }; current.lastUserMessage = text; current.lastIncludeCode = includeCode; current.error = ""; touch(current); return { session: current };
  });
  if (!begun) return null;
  if (begun.refused) { await pushSession(begun.session); return null; }
  const pending = begun.session; await pushSession(pending);
  void (async () => {
    try {
      // Re-read fresh on every attempt (including retry) rather than replaying a
      // stored copy — the editor's contents are never persisted in session state.
      const editorCode = includeCode ? await readEditorCode(pending) : "";
      const reply = await safeCoachReply(pending, text, editorCode, includeCode);
      const updated = await commitSession((sessions) => {
        const current = sessions[sessionId];
        if (!current || current.pendingRequest?.requestId !== requestId || current.pendingRequest.epoch !== pending.epoch) return null;
        current.pendingRequest = null; current.history.push({ role: "user", text, codeAttached: Boolean(editorCode), at: now() }, { role: "coach", ...reply, templateOutcome: templateOutcome(reply, current.stageIndex), at: now() }); capHistory(current); touch(current); return current;
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
    const updated = await commitSession((sessions) => {
      const current = sessions[session.id]; if (!current || current.captureId !== message.captureId) return null;
      current.confirmed = true;
      if (!current.stageKickoffsSent) current.stageKickoffsSent = [];
      const firstStage = STAGES[0];
      if (!current.stageKickoffsSent.includes(firstStage.id)) {
        current.stageKickoffsSent.push(firstStage.id);
        current.history.push({ role: "coach", discussion: STAGE_KICKOFF_LINES[firstStage.id], at: now() });
      }
      touch(current); return current;
    });
    return pushSession(updated);
  }
  if (message.type === "coach:advance") {
    if (!session.confirmed) return port.postMessage({ type: "coach:error", error: "Confirm the captured problem text before advancing the coaching stages." });
    const updated = await commitSession((sessions) => {
      const current = sessions[session.id]; if (!current) return null;
      current.stageIndex = clampStage(current.stageIndex + 1);
      const newStage = stageFor(current.stageIndex);
      if (!current.stageKickoffsSent) current.stageKickoffsSent = [];
      if (!current.stageKickoffsSent.includes(newStage.id)) {
        current.stageKickoffsSent.push(newStage.id);
        const kickoff = STAGE_KICKOFF_LINES[newStage.id] || `Welcome to the ${newStage.label} stage. What would you like to discuss?`;
        current.history.push({ role: "coach", discussion: kickoff, at: now() });
      }
      capHistory(current); touch(current); return current;
    });
    return pushSession(updated);
  }
  if (message.type === "coach:go-back") {
    if (!session.confirmed) return port.postMessage({ type: "coach:error", error: "Confirm the captured problem text before changing the coaching stage." });
    const updated = await commitSession((sessions) => {
      const current = sessions[session.id]; if (!current) return null;
      current.stageIndex = clampStage(current.stageIndex - 1);
      const newStage = stageFor(current.stageIndex);
      if (!current.stageKickoffsSent) current.stageKickoffsSent = [];
      if (!current.stageKickoffsSent.includes(newStage.id)) {
        current.stageKickoffsSent.push(newStage.id);
        const kickoff = STAGE_KICKOFF_LINES[newStage.id] || `Back to the ${newStage.label} stage. What would you like to revisit?`;
        current.history.push({ role: "coach", discussion: kickoff, at: now() });
      }
      capHistory(current); touch(current); return current;
    });
    return pushSession(updated);
  }
  if (message.type === "coach:rescan-capture") {
    if (session.captureStatus === "capturing") return port.postMessage({ type: "coach:error", error: "A re-scan is already in progress." });
    const rescanCaptureId = crypto.randomUUID();
    const priorCapture = session.capture;
    const priorStatus = session.captureStatus;
    const updated = await commitSession((sessions) => {
      const current = sessions[session.id];
      if (!current || current.captureId !== session.captureId) return null;
      current.captureId = rescanCaptureId; current.captureStatus = "capturing"; current.capture = null; current.error = ""; touch(current); return current;
    });
    if (!updated) return;
    await pushSession(updated);
    void (async () => {
      try {
        const capture = await captureFor(session);
        if (hasCaptureText(capture)) {
          const result = await commitSession((sessions) => {
            const current = sessions[session.id];
            if (!current || current.captureId !== rescanCaptureId) return null;
            current.capture = capture; current.captureStatus = "preview"; current.error = ""; touch(current); return current;
          });
          await pushSession(result);
        } else {
          const result = await commitSession((sessions) => {
            const current = sessions[session.id];
            if (!current || current.captureId !== rescanCaptureId) return null;
            current.capture = priorCapture; current.captureStatus = priorStatus; current.error = "Re-scan did not find meaningful content. Restored the prior capture."; touch(current); return current;
          });
          await pushSession(result);
        }
      } catch {
        const result = await commitSession((sessions) => {
          const current = sessions[session.id];
          if (!current || current.captureId !== rescanCaptureId) return null;
          current.capture = priorCapture; current.captureStatus = priorStatus; current.error = "Rescan failed. Restored prior capture."; touch(current); return current;
        });
        await pushSession(result);
      }
    })();
    return;
  }
  if (message.type === "coach:update-capture") {
    if (!session.confirmed) return port.postMessage({ type: "coach:error", error: "Confirm the problem before editing." });
    const updated = await commitSession((sessions) => {
      const current = sessions[session.id]; if (!current) return null;
      current.capture = clipCapture({ ...current.capture, ...message.capture }); touch(current); return current;
    });
    return pushSession(updated);
  }
  if (message.type === "coach:send-interviewer") {
    if (!session.confirmed) return port.postMessage({ type: "coach:error", error: "Confirm the captured problem text before sending it to the interviewer." });
    const text = String(message.text || "").trim();
    if (!text) return;
    const requestId = crypto.randomUUID();
    const begun = await commitSession((sessions) => {
      const current = sessions[session.id];
      if (!current) return null;
      current.pendingInterviewerRequest = { requestId }; current.error = ""; touch(current); return { session: current };
    });
    if (!begun) return;
    const pending = begun.session; await pushSession(pending);
    void (async () => {
      try {
        const credential = await activeCredential();
        if (!credential) throw new Error("Configure an API key in extension settings first.");
        const raw = await providerChat(credential.provider, interviewerPromptFor(pending, text), { apiKey: credential.key });
        const replyText = raw.trim();
        const updated = await commitSession((sessions) => {
          const current = sessions[session.id];
          if (!current || current.pendingInterviewerRequest?.requestId !== requestId) return null;
          current.pendingInterviewerRequest = null;
          current.interviewerHistory = current.interviewerHistory || [];
          current.interviewerHistory.push({ role: "user", text, at: now() }, { role: "interviewer", text: replyText, at: now() });
          touch(current); return current;
        });
        await pushSession(updated);
      } catch (error) {
        const updated = await commitSession((sessions) => {
          const current = sessions[session.id];
          if (!current || current.pendingInterviewerRequest?.requestId !== requestId) return null;
          current.pendingInterviewerRequest = null; current.error = error.message || "The interviewer request failed."; touch(current); return current;
        });
        await pushSession(updated);
      }
    })();
    return;
  }
  if (message.type === "coach:get-template") {
    if (clampStage(session.stageIndex) !== STAGES.length - 1 || !TEMPLATES[message.templateKey]) return port.postMessage({ type: "coach:error", error: "A matching template is available only after the full-code stage." });
    return port.postMessage({ type: "coach:template", key: message.templateKey, code: TEMPLATES[message.templateKey] });
  }
  if (message.type === "coach:reset") {
    const sessionUrl = session.url;
    const isLeetCode = /^https:\/\/leetcode\.com\/problems\//.test(sessionUrl || "");
    await commitSession((sessions) => { const current = sessions[session.id]; if (!current) return null; current.epoch++; delete sessions[session.id]; return null; });
    if (sessionUrl) await removeSessionByUrl(sessionUrl);
    context.currentSessionId = null;
    if (isLeetCode && tab?.id) {
      void ensurePanelOpen(tab, { gesture: false });
      void (async () => {
        await sessionReady;
        const newCaptureId = crypto.randomUUID();
        const session = await commitSession((sessions) => {
          const id = crypto.randomUUID();
          const record = { id, tabId: tab.id, windowId: tab.windowId, origin: (() => { try { return new URL(tab.url || "").origin; } catch { return ""; } })(), url: tab.url || "", captureId: newCaptureId, capture: null, captureStatus: "capturing", confirmed: false, mismatchAck: null, stageIndex: 0, history: [], interviewerHistory: [], pendingRequest: null, epoch: 0, revision: 1, createdAt: now(), updatedAt: now(), stageKickoffsSent: [] };
          sessions[id] = record; return record;
        });
        await pushSession(session);
        try {
          const capture = await captureFor(session);
          if (hasCaptureText(capture)) {
            const updated = await commitSession((sessions) => {
              const current = sessions[session.id];
              if (!current || current.captureId !== newCaptureId || current.epoch !== session.epoch) return null;
              current.capture = clipCapture(capture); current.captureStatus = "preview"; current.confirmed = true;
              current.captureId = crypto.randomUUID();
              if (!current.stageKickoffsSent) current.stageKickoffsSent = [];
              const firstStage = STAGES[0];
              if (!current.stageKickoffsSent.includes(firstStage.id)) {
                current.stageKickoffsSent.push(firstStage.id);
                current.history.push({ role: "coach", discussion: STAGE_KICKOFF_LINES[firstStage.id], at: now() });
              }
              touch(current); return current;
            });
            await pushSession(updated);
          } else {
            const updated = await commitSession((sessions) => {
              const current = sessions[session.id];
              if (!current || current.captureId !== newCaptureId) return null;
              current.capture = clipCapture(capture); current.captureStatus = "empty"; touch(current); return current;
            });
            await pushSession(updated);
          }
        } catch {
          const updated = await commitSession((sessions) => {
            const current = sessions[session.id]; if (!current || current.captureId !== newCaptureId) return null;
            current.captureStatus = "error"; current.error = "Could not capture this page on reset."; touch(current); return current;
          });
          await pushSession(updated);
        }
      })();
      return;
    }
    return sendPortState(port, context);
  }
  if (!session.confirmed) return port.postMessage({ type: "coach:error", error: "Confirm the captured problem text before sending it to a provider." });
  if (message.type === "coach:send") return beginProviderRequest(session.id, String(message.text || ""), false, Boolean(message.includeCode));
  if (message.type === "coach:retry") return beginProviderRequest(session.id, session.lastUserMessage || "Please continue coaching me.", true, Boolean(session.lastIncludeCode));
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
        // Keep session.url current for the tab that captureFor/readEditorCode actually
        // target (session.tabId), so canReadEditor and the editor-read LeetCode-path
        // check reflect where the tab navigated to, not just where coaching started.
        // Only trust a verified same-origin navigation of that exact tab — never the
        // mismatchAck substitute tab, which capture/editor reads don't target.
        if (session.tabId === tabId && currentOrigin && currentOrigin === expectedOrigin) session.url = changeInfo.url || tab?.url || session.url;
        touch(session); updated.push(session);
      }
      return updated;
    });
    for (const session of changed || []) {
      for (const [port, context] of panelPorts) if (context.windowId === session.windowId) await sendPortState(port, context);
    }
  })();
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const [port, context] of panelPorts) if (context.windowId === windowId) void sendPortState(port, context);
});
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
  if (message?.type === "editor:result") {
    const request = captureRequests.get(message.requestId);
    let senderOrigin = ""; try { senderOrigin = sender.url ? new URL(sender.url).origin : ""; } catch {}
    if (request && sender.id === chrome.runtime.id && sender.tab?.id === request.tabId && sender.frameId === request.frameId && senderOrigin === request.origin) { captureRequests.delete(message.requestId); request.resolve(message.code || ""); }
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
