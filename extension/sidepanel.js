const $ = (selector) => document.querySelector(selector);
let port = null;
let current = null;
let windowId = null;
let retryTimer = null;
let reconnectDelay = 250;
let resetArmed = false;
let resetTimer = null;
let lastRenderedSessionId = null;
let activeTab = "coach";
let lastCoachHistoryLen = 0;
let lastInterviewerHistoryLen = 0;

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
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
  $("#conversation").hidden = tab !== "coach";
  $("#interviewer-conversation").hidden = tab !== "interviewer";
  if (tab === "interviewer") {
    lastInterviewerHistoryLen = (current?.interviewerHistory || []).length;
  }
  if (tab === "coach") {
    lastCoachHistoryLen = (current?.history || []).length;
  }
}
function renderCapture() {
  const capture = current.capture;
  const captureLimit = (current.maxCaptureChars || 8000).toLocaleString();
  if (!capture) {
    $("#capture").innerHTML = `<p>${current.captureStatus === "capturing" ? "Capturing problem text…" : current.captureStatus === "empty" ? "No problem text was found. Select text on the page and start a new coaching session." : "Capture unavailable."}</p>`;
    return;
  }
  const statusLabel = current.confirmed ? '<span class="status-confirmed">Confirmed problem</span><button id="edit-capture" class="secondary edit-btn">Edit</button>' : "";
  $("#capture").innerHTML = `<div class="card capture-card"><div class="capture-header">${statusLabel}</div><strong>${escapeHtml(capture.title || "Captured problem")}</strong>${["description", "examples", "constraints"].filter((field) => capture[field]).map((field) => `<pre>${escapeHtml(capture[field])}</pre>`).join("")}${capture.truncated ? `<p class="warning">Capture was trimmed to ${captureLimit} characters.</p>` : ""}</div>`;
  const editBtn = $("#edit-capture");
  if (editBtn) {
    editBtn.onclick = () => {
      $("#edit-title").value = capture.title || "";
      $("#edit-description").value = capture.description || "";
      $("#edit-examples").value = capture.examples || "";
      $("#edit-constraints").value = capture.constraints || "";
      $("#capture").hidden = true;
      $("#capture-edit-form").hidden = false;
    };
  }
}
function render() {
  $("#error").textContent = current?.error || "";
  $("#empty").hidden = Boolean(current);
  $("#session").hidden = !current;
  if ((current?.id || null) !== lastRenderedSessionId) { disarmReset(); lastRenderedSessionId = current?.id || null; lastCoachHistoryLen = (current?.history || []).length; lastInterviewerHistoryLen = (current?.interviewerHistory || []).length; }
  if (!current) return;
  renderCapture();
  $("#capture-edit-form").hidden = true;
  $("#capture").hidden = false;
  $("#confirmation").hidden = !current.capture || current.confirmed;
  $("#controls").hidden = !current.confirmed || Boolean(current.mismatch);
  $("#chat-tabs").hidden = !current.confirmed;
  $("#mismatch").hidden = !current.mismatch;
  $("#mismatch-text").textContent = current.mismatch?.message || "This conversation belongs to another page. Continue only if you want to reuse its original problem text.";

  const stage = current.stage || { index: 0, label: "" };
  const stages = current.stages || [];
  $("#stage-title").textContent = stages.length ? `Stage ${stage.index + 1} of ${stages.length}: ${stage.label}` : "";
  $("#stage-prompt").textContent = stage.userPrompt || "";
  $("#back").disabled = !stage.index;
  const nextStage = stages[stage.index + 1];
  $("#advance").textContent = nextStage ? `Reveal next stage (${nextStage.label})` : "Full code unlocked";
  $("#advance").disabled = !nextStage;

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
  $("#send").textContent = activeTab === "interviewer" ? "Ask interviewer" : "Ask coach";
  $("#retry").hidden = !current.error?.includes("interrupted") && !current.pendingRequest;
  $("#history-note").textContent = current.historyNotice || "";

  const coachHistory = current.history || [];
  if (coachHistory.length > lastCoachHistoryLen && activeTab !== "coach") {
    switchTab("coach");
  }
  lastCoachHistoryLen = coachHistory.length;

  $("#conversation").innerHTML = coachHistory.map((item) => item.role === "user"
    ? `<article class="user"><strong>You</strong><p>${escapeHtml(item.text)}</p>${item.codeAttached ? `<p class="subtle">Editor code attached</p>` : ""}</article>`
    : `<article class="coach"><strong>Coach</strong>${[item.question, item.discussion, item.hint, item.pseudocode, item.code].filter(Boolean).map((text) => `<p>${escapeHtml(text)}</p>`).join("")}${item.templateOutcome ? `<p class="template-outcome">${item.templateOutcome.key ? `<button class="template-link" data-template="${escapeHtml(item.templateOutcome.key)}">${escapeHtml(item.templateOutcome.label)}</button>` : escapeHtml(item.templateOutcome.label)}</p>` : ""}</article>`).join("");

  const interviewerHistory = current.interviewerHistory || [];
  if (interviewerHistory.length > lastInterviewerHistoryLen && activeTab !== "interviewer") {
    switchTab("interviewer");
  }
  lastInterviewerHistoryLen = interviewerHistory.length;

  $("#interviewer-conversation").innerHTML = interviewerHistory.map((item) => item.role === "user"
    ? `<article class="user"><strong>You</strong><p>${escapeHtml(item.text)}</p></article>`
    : `<article class="interviewer"><strong>Interviewer</strong><p>${escapeHtml(item.text)}</p></article>`).join("");

  document.querySelectorAll(".template-link").forEach((button) => { button.onclick = () => send("coach:get-template", { templateKey: button.dataset.template }); });
  armRetryTimer();
}
function applyUpdate(session) {
  if (!session) { current = null; render(); return; }
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
  if (activeTab === "interviewer") {
    send("coach:send-interviewer", { text });
    return;
  }
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
$("#edit-save").onclick = () => {
  send("coach:update-capture", {
    capture: {
      title: $("#edit-title").value,
      description: $("#edit-description").value,
      examples: $("#edit-examples").value,
      constraints: $("#edit-constraints").value,
    },
  });
  $("#capture-edit-form").hidden = true;
  $("#capture").hidden = false;
};
$("#edit-cancel").onclick = () => {
  $("#capture-edit-form").hidden = true;
  $("#capture").hidden = false;
};
document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => switchTab(btn.dataset.tab);
});
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
document.addEventListener("click", (event) => {
  if (resetArmed && event.target !== $("#reset")) {
    disarmReset();
  }
});
$("#settings").onclick = () => chrome.runtime.openOptionsPage();
$("#template-form").onsubmit = (event) => { event.preventDefault(); const code = $("#template-key").value; if (code) navigator.clipboard.writeText(code).then(() => { $("#template-status").textContent = "Template copied to the clipboard."; }); };
start();
