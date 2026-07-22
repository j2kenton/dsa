const PROVIDERS = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    async chat(messages, options) {
      const body = { model: options.model || "gpt-4o-mini", messages, temperature: 0.35 };
      if (options.jsonMode) body.response_format = { type: "json_object" };
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // Surface the provider's own message for statuses we do not map. A bare
        // status code cannot distinguish a malformed request from a quota
        // problem, which makes a 400 undebuggable from the options page. The
        // error body describes the request, never the key.
        let detail = "";
        if (response.status !== 401 && response.status !== 429) {
          const body = await response.json().catch(() => null);
          detail = body?.error?.message ? ` ${body.error.message}` : "";
        }
        const error = new Error(response.status === 401 ? "The API key was rejected." : response.status === 429 ? "The provider is rate limiting requests." : `Provider request failed (${response.status}).${detail}`);
        error.status = response.status;
        throw error;
      }
      const result = await response.json();
      return result.choices?.[0]?.message?.content || "";
    },
    async test(apiKey) {
      // chat() sets response_format json_object, which the API rejects with a
      // 400 unless the word "json" appears in the messages. Keep it in this
      // prompt verbatim.
      await this.chat([{ role: "user", content: "Reply with the json object {\"ok\":true}." }], { apiKey, jsonMode: true });
    },
  },
};

async function providerChat(provider, messages, options) {
  if (!PROVIDERS[provider]) throw new Error("That provider is not available in this release.");
  return PROVIDERS[provider].chat(messages, options);
}
