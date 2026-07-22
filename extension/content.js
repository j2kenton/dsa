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
    const fullText = content?.innerText?.trim() || "";
    // Constraints is stripped out of the full text first, then examples is
    // stripped out of what remains — so each section is sent once, in the same
    // title -> description -> examples -> constraints order the LeetCode page uses,
    // instead of description containing (and thus duplicating) both sections.
    const constraintsMatch = fullText.match(/Constraints[\s\S]*?(?=Follow-up|$)/i);
    const constraints = constraintsMatch ? constraintsMatch[0].trim() : "";
    const withoutConstraints = constraintsMatch
      ? fullText.slice(0, constraintsMatch.index) + fullText.slice(constraintsMatch.index + constraintsMatch[0].length)
      : fullText;
    const examplesMatch = withoutConstraints.match(/Example[\s\S]*?(?=Constraints|Follow-up|$)/i);
    const examples = examplesMatch ? examplesMatch[0].trim() : "";
    const withoutExamples = examplesMatch
      ? withoutConstraints.slice(0, examplesMatch.index) + withoutConstraints.slice(examplesMatch.index + examplesMatch[0].length)
      : withoutConstraints;
    // Strip Follow-up section from description — it is a post-problem heading,
    // not part of the core statement.  Consistent with how Constraints and
    // Example sections are removed earlier so they don't inflate the
    // meaningful-content character check.
    const followUpStripped = withoutExamples.replace(/\s*Follow-up[\s\S]*$/i, "").trim();
    // If stripping Follow-up leaves nothing (e.g. the body was just
    // headings/follow-up), do NOT fall back to the original text — this
    // prevents Follow-up-only placeholder text from prematurely ending the
    // capture polling loop. The poll condition below separately checks the
    // Follow-up-stripped description length.
    const description = withoutExamples.match(/\s*Follow-up[\s\S]*$/i) ? followUpStripped : (followUpStripped || fullText);
    return { title, description, examples, constraints, sourceUrl: location.href };
  }

  // Monaco virtualizes long files, so only currently-rendered lines exist in the
  // DOM. Reconstructing by each line's absolute `top` offset keeps the visible
  // portion in the right order; it is a best-effort read, not a full-file guarantee.
  function readEditorCode() {
    const container = document.querySelector(".monaco-editor .view-lines") || document.querySelector(".view-lines");
    if (!container) return "";
    const lines = Array.from(container.querySelectorAll(".view-line"));
    if (!lines.length) return "";
    return lines
      .map((line) => ({ top: parseFloat(line.style.top) || 0, text: line.innerText ?? line.textContent ?? "" }))
      .sort((a, b) => a.top - b.top)
      .map((line) => line.text)
      .join("\n");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "dsa-insert") {
      try { insertTemplate(message.text); sendResponse({ ok: true }); }
      catch (error) { sendResponse({ ok: false, error: error.message }); }
      return;
    }
    if (message?.type === "capture:leetcode") {
      void (async () => {
        const deadline = Date.now() + 10000;
        let capture = extractLeetCode();
        while (((capture.description + capture.examples + capture.constraints).length < 20 || (capture.title + capture.description + capture.examples + capture.constraints).length < 40 || capture.description.length < 20) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          capture = extractLeetCode();
        }
        chrome.runtime.sendMessage({ type: "capture:result", requestId: message.requestId, capture: capture || {} });
      })();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "editor:read") {
      chrome.runtime.sendMessage({ type: "editor:result", requestId: message.requestId, code: readEditorCode() });
      sendResponse({ ok: true });
    }
  });
})();
