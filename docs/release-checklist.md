# Release checklist

- Run `npm run build`, `npm test`, and `npm run test:chrome`. The Chrome command validates the generated ZIP's production manifest, then loads a fixture-only unpacked copy with its two fixture origins added solely because CDP cannot grant the transient `activeTab` permission a real user gesture provides. It checks trusted-context content-script isolation, dynamic injection on a genuinely non-LeetCode host, the worker storage gate, panel handshake, and worker-restart rehydration of an interrupted request.
- Load the unpacked `extension/` directory in Chrome 116+ and verify trusted-context persistent storage, session-only storage, Save & Test, update, and deletion.
- In two separate Chrome windows, open a coach session in each and confirm that each side panel follows only its own window/tab.
- Confirm a LeetCode capture, then verify the selected-text fallback on another page and template insertion on both a LeetCode and non-LeetCode editor.
- Kill the extension service worker while a provider request is pending; reconnect the panel and use Retry without recapturing.
- Verify the toolbar and context-menu coach launch surfaces by hand. The keyboard command is intentionally not shipped: the Phase 0 d1 tab-delivery spike did not establish a dependable command target.
- With a dedicated spend-capped OpenAI test key, run Save & Test by hand from the loaded options page and confirm the authenticated round trip succeeds, then delete the key. Record only the sanitized fields — date, Chrome version, provider endpoint, pass/fail — in `docs/decisions/0001-provider-byok.md`. No automated suite accepts a real key; do not record the key, request headers, or problem text anywhere.
