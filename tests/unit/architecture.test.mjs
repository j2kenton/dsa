import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const background = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));

describe("coach architecture guardrails", () => {
  it("ships the Chrome 116 side panel without the unverified command route", () => {
    expect(manifest.minimum_chrome_version).toBe("116");
    expect(manifest.side_panel.default_path).toBe("sidepanel.html");
    expect(manifest.commands).toBeUndefined();
  });
  it("keeps session writes and credential tombstones on their named serialized paths", () => {
    expect(background).toContain("async function commitSession");
    expect(background).toContain("TOMBSTONE_KEY");
    expect(background).toContain("async function deleteCredential");
    expect(background.match(/chrome\.storage\.session\.set\(\{ \[SESSION_KEY\]: sessions \}\)/g)).toHaveLength(1);
    const start = background.indexOf("async function commitSession");
    const end = background.indexOf("function touch", start);
    expect(background.slice(start, end)).toContain("chrome.storage.session.set({ [SESSION_KEY]: sessions })");
  });
  it("uses a panel window handshake and never falls back to a pre-open lookup", () => {
    expect(background).toContain('message?.type !== "coach:handshake"');
    expect(background).toContain("chrome.windows.get(message.windowId)");
    expect(background).toContain("chrome.sidePanel.open({ tabId: tab.id })");
    expect(background).not.toContain("chrome.commands.onCommand");
  });
  it("keeps content-script access narrow and secrets out of prompts", () => {
    expect(manifest.content_scripts[0].matches).toEqual(["https://leetcode.com/problems/*"]);
    expect(manifest.permissions).not.toContain("tabs");
    expect(background).toContain("...history,");
    expect(background).not.toContain("console.log(credential.key");
    const replayBlock = background.slice(background.indexOf("function promptFor"), background.indexOf("function containsCode"));
    expect(replayBlock).not.toContain('reply.matchedPatternId');
    expect(replayBlock).toContain('for (const field of ["question", "discussion", "hint", "pseudocode", "code"])');
  });
});
