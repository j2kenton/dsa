const $ = (selector) => document.querySelector(selector);
let port = null;
let current = null;
let windowId = null;
let retryTimer = null;
let reconnectDelay = 250;

function escapeHtml(value) { return String(value || "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function send(type, extra = {}) { if (port) port.postMessage({ type, sessionId: current?.id, ...extra }); }
function clearRetryTimer() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }
function armRetryTimer() {
  clearRetryTimer();
  if (current?.pendingRequest) retryTimer = setTimeout(() => { $("#error").textContent = "This request may have been interrupted. Tap Retry to continue."; $("#retry").hidden = false; }, 60000);
}
function render() {
  $("#error").textContent = current?.error || "";
  $("#empty").hidden = Boolean(current);
  $("#session").hidden = !current;
  if (!current) return;
  const capture = current.capture;
  $("#capture").innerHTML = capture ? `<div class="card"><strong>${escapeHtml(capture.title || "Captured problem")}</strong><pre>${escapeHtml([capture.constraints, capture.examples, capture.description].filter(Boolean).join("\n\n"))}</pre>${capture.truncated ? "<p class=\"warning\">Capture was trimmed to 8,000 characters.</p>" : ""}</div>` : `<p>${current.captureStatus === "capturing" ? "Capturing problem text…" : current.captureStatus === "empty" ? "No problem text was found. Select text on the page and start a new coaching session." : "Capture unavailable."}</p>`;
  $("#confirmation").hidden = !capture || current.confirmed;
  $("#controls").hidden = !current.confirmed || Boolean(current.mismatch);
  $("#mismatch").hidden = !current.mismatch;
  $("#mismatch-text").textContent = current.mismatch?.message || "This conversation belongs to another page. Continue only if you want to reuse its original problem text.";
  $("#advance").textContent = current.stageIndex >= 7 ? "Full code unlocked" : `Reveal next stage (${["Clarify", "Patterns", "Approach", "Edge cases", "Outline", "Hint", "Pseudocode", "Code"][current.stageIndex + 1] || ""})`;
  $("#advance").disabled = current.stageIndex >= 7;
  $("#send").disabled = Boolean(current.pendingRequest);
  $("#retry").hidden = !current.error?.includes("interrupted") && !current.pendingRequest;
  $("#history-note").textContent = current.historyNotice || "";
  $("#conversation").innerHTML = (current.history || []).map((item) => item.role === "user"
    ? `<article class="user"><strong>You</strong><p>${escapeHtml(item.text)}</p></article>`
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
$("#confirm").onclick = () => send("coach:confirm-capture", { captureId: current?.captureId });
$("#advance").onclick = () => send("coach:advance");
$("#send").onclick = () => { const text = $("#message").value.trim(); if (text) { $("#message").value = ""; send("coach:send", { text }); } };
$("#retry").onclick = () => send("coach:retry");
$("#continue").onclick = () => send("coach:continue-anyway");
$("#reset").onclick = () => send("coach:reset");
$("#settings").onclick = () => chrome.runtime.openOptionsPage();
$("#template-form").onsubmit = (event) => { event.preventDefault(); const code = $("#template-key").value; if (code) navigator.clipboard.writeText(code).then(() => { $("#template-status").textContent = "Template copied to the clipboard."; }); };
start();
