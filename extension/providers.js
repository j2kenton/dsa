const PROVIDERS = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    async chat(messages, options) {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: options.model || "gpt-4o-mini", messages, temperature: 0.35, response_format: { type: "json_object" } }),
      });
      if (!response.ok) {
        const error = new Error(response.status === 401 ? "The API key was rejected." : response.status === 429 ? "The provider is rate limiting requests." : `Provider request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      const body = await response.json();
      return body.choices?.[0]?.message?.content || "";
    },
    async test(apiKey) {
      await this.chat([{ role: "user", content: "Reply with {\"ok\":true}." }], { apiKey });
    },
  },
};

async function providerChat(provider, messages, options) {
  if (!PROVIDERS[provider]) throw new Error("That provider is not available in this release.");
  return PROVIDERS[provider].chat(messages, options);
}
