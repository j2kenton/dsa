(() => {
  if (globalThis.__dsaContentScriptLoaded) return;
  globalThis.__dsaContentScriptLoaded = true;

  function insertTemplate(text) {
    const el = document.activeElement;
    if (!el) throw new Error("Focus an editor before inserting a template.");
    if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio"].includes(el.type))) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (el.isContentEditable || el.closest("[contenteditable='true']")) {
      document.execCommand("insertText", false, text);
      return;
    }
    navigator.clipboard.writeText(text);
  }

  function text(selector) {
    return document.querySelector(selector)?.innerText?.trim() || "";
  }

  function extractLeetCode() {
    const title = text('[data-cy="question-title"]') || text("div.text-title-large");
    const content = document.querySelector('[data-track-load="description_content"]') || document.querySelector(".elfjS");
    const description = content?.innerText?.trim() || "";
    const constraints = (description.match(/Constraints[\s\S]*?(?=Follow-up|$)/i) || [""])[0];
    const examples = (description.match(/Example[\s\S]*?(?=Constraints|Follow-up|$)/i) || [""])[0];
    return { title, constraints, examples, description, sourceUrl: location.href };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "dsa-insert") {
      try { insertTemplate(message.text); sendResponse({ ok: true }); }
      catch (error) { sendResponse({ ok: false, error: error.message }); }
      return;
    }
    if (message?.type === "capture:leetcode") {
      chrome.runtime.sendMessage({ type: "capture:result", requestId: message.requestId, capture: extractLeetCode() });
      sendResponse({ ok: true });
    }
  });
})();
