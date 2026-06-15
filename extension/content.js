window.addEventListener("dsa-insert", () => {
  const text = window.__dsaInsertText;
  if (!text) return;

  const el = document.activeElement;
  if (!el) return;

  // Standard textarea / input
  if (
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && el.type !== "checkbox" && el.type !== "radio")
  ) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // contenteditable (e.g. LeetCode's Monaco-based editor or CodeMirror)
  if (el.isContentEditable || el.closest("[contenteditable='true']")) {
    document.execCommand("insertText", false, text);
    return;
  }

  // Fallback: copy to clipboard and notify
  navigator.clipboard.writeText(text).then(() => {
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      background: "#1e1e2e",
      color: "#cdd6f4",
      padding: "10px 16px",
      borderRadius: "8px",
      fontSize: "14px",
      zIndex: "999999",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    });
    toast.textContent = "Template copied to clipboard";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  });
});
