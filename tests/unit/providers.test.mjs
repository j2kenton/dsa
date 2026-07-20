import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const source = fs.readFileSync(path.join(root, "extension", "providers.js"), "utf8");

function providerWith(fetch) {
  const context = vm.createContext({ fetch });
  vm.runInContext(`${source}\nglobalThis.__provider = { PROVIDERS, providerChat };`, context, { filename: "providers.js" });
  return context.__provider;
}

describe("OpenAI provider adapter", () => {
  it("maps a chat request and response without putting the key in the body", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{"discussion":"Try a map."}' } }] }) });
    const { providerChat } = providerWith(fetch);
    await expect(providerChat("openai", [{ role: "user", content: "help" }], { apiKey: "sk-secret" })).resolves.toContain("Try a map");
    const [, request] = fetch.mock.calls[0];
    expect(request.headers.Authorization).toBe("Bearer sk-secret");
    expect(request.body).not.toContain("sk-secret");
    expect(JSON.parse(request.body).response_format).toEqual({ type: "json_object" });
  });

  it.each([[401, "rejected"], [429, "rate limiting"], [500, "500"]])("maps provider status %s to a safe message", async (status, message) => {
    const { providerChat } = providerWith(vi.fn().mockResolvedValue({ ok: false, status }));
    await expect(providerChat("openai", [], { apiKey: "sk-secret" })).rejects.toThrow(message);
  });

  it("reports unavailable providers before making a request", async () => {
    const fetch = vi.fn();
    const { providerChat } = providerWith(fetch);
    await expect(providerChat("unknown", [], { apiKey: "sk-secret" })).rejects.toThrow("not available");
    expect(fetch).not.toHaveBeenCalled();
  });
});
