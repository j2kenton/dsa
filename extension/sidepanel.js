const $ = (selector) => document.querySelector(selector);
let port = null;
let current = null;
let windowId = null;
let retryTimer = null;
let reconnectDelay = 250;
let resetArmed = false;
let resetTimer = null;
let lastRenderedSessionId = null;

function escapeHtml(value) { return String(value || "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function send(type, extra = {}) { if (port) port.postMessage({ type, sessionId: current?.id, ...extra }); }
function clearRetryTimer() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }
function armRetryTimer() {
  clearRetryTimer();
  if (current?.pendingRequest) retryTimer = setTimeout(() => { $("#error").textContent = "This request may have been interrupted. Tap Retry to continue."; $("#retry").hidden = false; }, 60000);
}
function disarmReset() {
  resetArmed = false;
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  $("#reset").textContent = "Reset session";
  $("#reset").classList.remove("danger");
}
function render() {
  $("#error").textContent = current?.error || "";
  $("#empty").hidden = Boolean(current);
  $("#session").hidden = !current;
  // A reset armed on one session should never carry over to a different session
  // (e.g. after switching tabs), so any identity change disarms it.
  if ((current?.id || null) !== lastRenderedSessionId) { disarmReset(); lastRenderedSessionId = current?.id || null; }
  if (!current) return;
  const capture = current.capture;
  const captureLimit = (current.maxCaptureChars || 8000).toLocaleString();
  $("#capture").innerHTML = capture ? `<div class="card"><strong>${escapeHtml(capture.title || "Captured problem")}</strong>${["description", "examples", "constraints"].filter((field) => capture[field]).map((field) => `<pre>${escapeHtml(capture[field])}</pre>`).join("")}${capture.truncated ? `<p class="warning">Capture was trimmed to ${captureLimit} characters.</p>` : ""}</div>` : `<p>${current.captureStatus === "capturing" ? "Capturing problem text…" : current.captureStatus === "empty" ? "No problem text was found. Select text on the page and start a new coaching session." : "Capture unavailable."}</p>`;
  $("#confirmation").hidden = !capture || current.confirmed;
  $("#controls").hidden = !current.confirmed || Boolean(current.mismatch);
  $("#mismatch").hidden = !current.mismatch;
  $("#mismatch-text").textContent = current.mismatch?.message || "This conversation belongs to another page. Continue only if you want to reuse its original problem text.";

  const stage = current.stage || { index: 0, label: "" };
  const stages = current.stages || [];
  $("#stage-info").textContent = stages.length ? `Stage ${stage.index + 1} of ${stages.length} — ${stage.label}. ${stage.objective || ""}` : "";
  $("#back").disabled = !stage.index;
  const nextStage = stages[stage.index + 1];
  $("#advance").textContent = nextStage ? `Reveal next stage (${nextStage.label})` : "Full code unlocked";
  $("#advance").disabled = !nextStage;
  $("#message").placeholder = stage.placeholder || "";

  const stageFields = stage.fields || [];
  const stageHasCode = stageFields.includes("pseudocode") || stageFields.includes("code");
  const canAttachCode = current.canReadEditor && stageHasCode;
  $("#include-code").disabled = !canAttachCode;
  $("#include-code-reason").textContent = !current.canReadEditor
    ? "Only available on a LeetCode problem page."
    : !stageHasCode
    ? "Available once you reach the pseudocode or code stage."
    : "Best-effort read of the visible editor — for a long file, scroll to the part you're asking about first.";
  if (!canAttachCode) $("#include-code").checked = false;

  $("#send").disabled = Boolean(current.pendingRequest);
  $("#retry").hidden = !current.error?.includes("interrupted") && !current.pendingRequest;
  $("#history-note").textContent = current.historyNotice || "";
  $("#conversation").innerHTML = (current.history || []).map((item) => item.role === "user"
    ? `<article class="user"><strong>You</strong><p>${escapeHtml(item.text)}</p>${item.codeAttached ? `<p class="subtle">Editor code attached</p>` : ""}</article>`
    : `<article class="coach"><strong>Coach</strong>${[item.question, item.discussion, item.hint, item.pseudocode, item.code].filter(Boolean).map((text) => `<p>${escapeHtml(text)}</p>`).join("")}${item.templateOutcome ? `<p class="template-outcome">${item.templateOutcome.key ? `<button class="template-link" data-template="${escapeHtml(item.templateOutcome.key)}">${escapeHtml(item.templateOutcome.label)}</button>` : escapeHtml(item.templateOutcome.label)}</p>` : ""}</article>`).join("");
  document.querySelectorAll(".template-link").forEach((button) => { button.onclick = () => send("coach:get-template", { templateKey: button.dataset.template }); });
  armRetryTimer();
}
function applyUpdate(session) {
  if (!session) { current = null; render(); return; }
  // Tab-mismatch state is derived by the worker from the active tab and can change
  // without a persisted session mutation/revision. Treat that field as authoritative
  // even when a same-revision push races the panel's pull response.
  const mismatchChanged = current && session.id === current.id && Boolean(session.mismatch) !== Boolean(current.mismatch);
  if (!current || session.id !== current.id || session.revision > current.revision || mismatchChanged) { current = session; render(); }
}
function connect() {
  port = chrome.runtime.connect({ name: "coach-panel" });
  port.onMessage.addListener((message) => {
    if (message.type === "coach:ready") { reconnectDelay = 250; send("coach:get-active-session"); }
    if (message.type === "coach:update") applyUpdate(message.session);
    if (message.type === "coach:error") $("#error").textContent = message.error;
    if (message.type === "coach:mismatch") { if (current) { current = { ...current, mismatch: { currentTabId: message.currentTabId, message: message.message } }; render(); } }
    if (message.type === "coach:template") { $("#template-key").value = message.code; $("#template-form").hidden = false; }
  });
  port.onDisconnect.addListener(() => {
    clearRetryTimer(); port = null;
    setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 3000);
  });
  port.postMessage({ type: "coach:handshake", windowId });
}

async function start() { windowId = (await chrome.windows.getCurrent()).id; connect(); }
function submitMessage() {
  const text = $("#message").value.trim();
  if (!text) return;
  $("#message").value = "";
  const includeCode = $("#include-code").checked;
  send("coach:send", { text, includeCode });
}
$("#confirm").onclick = () => send("coach:confirm-capture", { captureId: current?.captureId });
$("#back").onclick = () => send("coach:go-back");
$("#advance").onclick = () => send("coach:advance");
$("#send").onclick = submitMessage;
$("#message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitMessage(); }
});
$("#retry").onclick = () => send("coach:retry");
$("#continue").onclick = () => send("coach:continue-anyway");
$("#reset").onclick = () => {
  if (!resetArmed) {
    resetArmed = true;
    $("#reset").textContent = "Confirm reset?";
    $("#reset").classList.add("danger");
    resetTimer = setTimeout(disarmReset, 5000);
    return;
  }
  disarmReset();
  send("coach:reset");
};
$("#settings").onclick = () => chrome.runtime.openOptionsPage();
$("#template-form").onsubmit = (event) => { event.preventDefault(); const code = $("#template-key").value; if (code) navigator.clipboard.writeText(code).then(() => { $("#template-status").textContent = "Template copied to the clipboard."; }); };
start();
