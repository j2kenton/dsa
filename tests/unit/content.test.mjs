import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const source = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");
const dailyTemperaturesSnapshot = fs.readFileSync(path.join(root, "tests", "fixtures", "leetcode-daily-temperatures.html"), "utf8");

function page(html = "", url = "https://leetcode.com/problems/example/") {
  const dom = new JSDOM(`<body>${html}</body>`, { url, runScripts: "dangerously" });
  const listeners = [];
  const outbound = [];
  dom.window.chrome = { runtime: { onMessage: { addListener(listener) { listeners.push(listener); } }, sendMessage(message) { outbound.push(message); } } };
  dom.window.eval(source);
  return { dom, listeners, outbound };
}

describe("content script", () => {
  it("is reinjection-safe and inserts a template only once", () => {
    const { dom, listeners } = page('<textarea id="editor">ab</textarea>');
    dom.window.eval(source);
    expect(listeners).toHaveLength(1);
    const editor = dom.window.document.querySelector("#editor");
    editor.focus(); editor.selectionStart = editor.selectionEnd = 1;
    let response;
    listeners[0]({ type: "dsa-insert", text: "XYZ" }, {}, (value) => { response = value; });
    expect(editor.value).toBe("aXYZb");
    expect(response).toEqual({ ok: true });
  });

  it("returns a structured LeetCode capture through the worker request channel", () => {
    const { dom, listeners, outbound } = page(dailyTemperaturesSnapshot);
    Object.defineProperty(dom.window.document.querySelector("[data-cy='question-title']"), "innerText", { value: "Daily Temperatures" });
    const content = dom.window.document.querySelector("[data-track-load]");
    Object.defineProperty(content, "innerText", { value: "Example 1: warmer day\nConstraints\n1 <= n <= 100" });
    listeners[0]({ type: "capture:leetcode", requestId: "capture-1" }, {}, () => {});
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ type: "capture:result", requestId: "capture-1", capture: { title: "Daily Temperatures" } });
    expect(outbound[0].capture.constraints).toContain("Constraints");
    // Stripping both the examples and constraints sections out of this fixture
    // leaves nothing behind, so the empty-description guard falls back to the
    // original full text instead of sending a blank description.
    expect(outbound[0].capture.description).toBe("Example 1: warmer day\nConstraints\n1 <= n <= 100");
  });

  it("strips constraints and examples out of description once each, instead of duplicating them", () => {
    const { dom, listeners, outbound } = page('<div data-track-load="description_content"></div>');
    const content = dom.window.document.querySelector("[data-track-load]");
    Object.defineProperty(content, "innerText", {
      value: "Given an array, return the widget count.\n\nExample 1:\nInput: [1,2]\nOutput: 2\n\nConstraints:\n1 <= n <= 100",
    });
    listeners[0]({ type: "capture:leetcode", requestId: "capture-2" }, {}, () => {});
    const { capture } = outbound[0];
    expect(capture.description).toBe("Given an array, return the widget count.");
    expect(capture.examples).toContain("Input: [1,2]");
    expect(capture.constraints).toContain("1 <= n <= 100");
    expect(capture.description).not.toContain("Constraints");
    expect(capture.description).not.toContain("Input: [1,2]");
  });

  it("reads the learner's Monaco editor contents ordered by each line's absolute top offset", () => {
    const { dom, listeners, outbound } = page(
      '<div class="monaco-editor"><div class="view-lines">' +
        '<div class="view-line" style="top:36px">line two</div>' +
        '<div class="view-line" style="top:0px">line one</div>' +
        '<div class="view-line" style="top:18px">line one and a half</div>' +
        "</div></div>",
    );
    listeners[0]({ type: "editor:read", requestId: "editor-1" }, {}, () => {});
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toEqual({ type: "editor:result", requestId: "editor-1", code: "line one\nline one and a half\nline two" });
  });

  it("returns an empty editor read when no Monaco editor is present on the page", () => {
    const { dom, listeners, outbound } = page("<p>no editor here</p>");
    listeners[0]({ type: "editor:read", requestId: "editor-2" }, {}, () => {});
    expect(outbound).toEqual([{ type: "editor:result", requestId: "editor-2", code: "" }]);
  });
});
