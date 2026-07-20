# Privacy Policy — Algo Coach

This extension does not collect personal data for the developer.

Template insertion operates locally: selected template text is inserted directly into the active text field.

If you opt into AI coaching, the extension sends only the problem text shown in its preview after you explicitly confirm it, plus your coaching messages, directly to the AI provider you configure (OpenAI in v1). This data is used to obtain that provider's response and is not sent to an extension-owned backend.

Your LeetCode editor's code is read and sent to that same AI provider only when you tick "Attach my editor code" for a given message. It is never read or sent otherwise, and it is never written to extension storage — only a yes/no "code was attached" flag is kept with that message in the conversation history.

API keys are stored session-only by default. You may opt into persistent local storage on your device; when supported, Chrome restricts that storage to trusted extension contexts. Keys are not placed in prompts, UI state, or content-script messages. You can delete a saved key from Extension settings at any time.
