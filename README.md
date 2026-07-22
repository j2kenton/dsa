# Algo Coach

### An AI DSA coach that helps you learn how to solve problems—not just see the answer.

[Install Algo Coach from the Chrome Web Store](https://chromewebstore.google.com/detail/dsa-templates/ollnhakcihdpbakabcdgagaciipklehd)

![Algo Coach screenshot](store-assets/screenshot-1.png)

Algo Coach is a deliberately designed DSA learning experience for LeetCode. It combines a library of reusable JavaScript patterns with an AI coach that behaves more like a strong technical interviewer than an answer generator.

The product is built around a simple principle: the learner should do the thinking. Algo Coach captures the problem, asks the next useful question, and reveals help progressively—from recognition and tradeoffs to hints, pseudocode, and finally code. The result is a reusable problem-solving habit, not just another copied solution.

## How the coaching helps you

1. Open a LeetCode problem and launch Algo Coach from the extension icon or context menu.
2. Review the captured problem statement before anything is sent to the provider.
3. Work through a staged conversation that helps you identify patterns, compare approaches, reason about complexity, and test edge cases.
4. Ask questions and get the next useful hint without immediately giving away the solution.
5. Move backward or forward through the stages, then reveal pseudocode, code, and a matching template when you are ready.

Existing sessions are resumable, interrupted requests can be retried, and the panel tracks the active tab so a conversation does not silently attach itself to the wrong problem.

## The interview experience

Interviewer mode is designed for practice under realistic constraints. It keeps the conversation focused on your reasoning, asks follow-up questions, and gives you space to explain tradeoffs before moving on. The goal is to rehearse the communication that matters in a technical interview: clarifying the problem, stating assumptions, choosing an approach, analyzing complexity, and responding to edge cases.

You can switch between the guided Coach conversation and the more demanding Interviewer conversation from the same session.

## Under the hood

The extension coordinates several difficult boundaries:

- A Chrome Manifest V3 service worker that can stop and restart at any time.
- A side panel that must open within Chrome’s user-gesture rules.
- Content scripts that safely capture structured LeetCode content and best-effort visible editor code.
- Persistent session state with serialized updates, stale-request protection, recovery, and URL/tab ownership.
- A provider boundary that keeps API keys out of prompts, UI state, and stored coaching sessions.
- Strict response shaping so the coach follows the current learning stage instead of leaking the final answer too early.

The project also includes unit coverage for capture, provider behavior, session concurrency, storage modes, panel launch behavior, and extension architecture, plus a Chrome smoke suite for the built extension.

## Privacy by design

Algo Coach uses a bring-your-own-key model. Your OpenAI key stays in the extension’s storage and is never included in coaching prompts. Session-only storage is the default; persistent storage is opt-in and local to the device.

Only problem text that you review and confirm is sent to OpenAI. Editor code is optional, sent only for the individual turn where **Attach my editor code** is enabled, and limited to the visible editor content that the extension can read. The extension does not collect an account, analytics profile, or background browsing history.

See the [privacy policy](store-assets/privacy-policy.md) and the [provider decision record](docs/decisions/0001-provider-byok.md).

## Templates included

The template library is organized around patterns that show up repeatedly in interviews:

`BFS` · `DFS` · `Backtracking` · `Binary Search` · `Dynamic Programming` · `Sliding Window` · `Two Pointers` · `Prefix Sum` · `Stack` · `Trie` · `Linked List` · `Union Find`

Templates are plain, readable JavaScript intended to be copied into an editor and adapted—not opaque framework code.

## For contributors

```bash
npm install
npm run build
npm test
```

To try an unpacked build, load the `extension/` directory from `chrome://extensions` with Developer mode enabled. The Chrome smoke suite is available through `npm run test:chrome`; the full side-panel gate runs with `DSA_SMOKE_HEADFUL=1 npm run test:chrome` in a desktop session.

Templates and coaching patterns live in `templates/` and `coaching-knowledge.json`.

## Project direction

Current engineering work is focused on making panel launch behavior reliable across normal page loads, service-worker restarts, and extension reloads while preserving a clear distinction between genuine site-access failures and recoverable panel state.
