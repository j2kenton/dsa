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
  });
});
