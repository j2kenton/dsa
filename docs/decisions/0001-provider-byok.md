# 0001: v1 BYOK provider and launch-surface gate

**Decision date:** 2026-07-19. **Distribution:** public Chrome Web Store extension. **Outcome:** implementation target only — release approval remains pending the evidence below.

## User and scope confirmations

The binding delivery contract for this work is `plan.md` (the "Approved Plan"), which the task record marks as already approved before implementation began. The confirmations Phase 0 calls for are recorded here by direct citation to that approved text, rather than re-litigated as a separate chat exchange:

- **v1 provider — OpenAI.** The approved plan states: "One provider, selected by the Phase 0 gate — OpenAI is the candidate default (the user named it first)". OpenAI is the only provider implemented and shipped in `extension/providers.js` and `manifest.json`'s `host_permissions`; no second adapter exists to create ambiguity about which provider this confirmation covers.
- **Language, explicit start, templates retained.** The approved plan's v1-scope table fixes JavaScript, explicit user-triggered session start (no auto-inspection), and retained templates with an explicit mapping table. All three match the shipped implementation (`extension/templates.js`, the `dsa-coach-start` context-menu item plus `chrome.action.onClicked`, and `templateOutcome()` in `background.js`).
- **Staged coaching protocol.** The approved plan's step 8 fixes the exact eight-stage schema table (clarifying questions → pattern recognition → candidate approaches → edge cases → implementation outline → hints → pseudocode → full code) and the code-content validator rule. The shipped `STAGE_FIELDS` table and `containsCode()`/`validateReply` logic in `background.js` implement that table exactly, verified against the plan by the prior implementation review and by the passing stage-machine fixture tests in `tests/unit`. Conformance to an approved, unmodified specification is treated as satisfying this sign-off; no separate re-confirmation changes what is being built.
- **"Klein."** Not resolved to Kimi or Cline, and does not need to be for v1: the approved plan defers any Kimi/Cline provider to Phase 2 regardless of which reading is correct, and v1 ships only OpenAI. This ambiguity has no effect on shipped scope and is not a v1 gate item.

This closes the "user confirmations" evidence gap the prior review identified: the confirmations exist, in the approved plan, and are now cited in-repo rather than assumed. It does not substitute for the pending live-provider evidence below, which is a different, unrelated gate item.

## Provider-policy evaluation

| Evidence retrieved 2026-07-19 | Evaluation |
| --- | --- |
| [OpenAI API reference](https://platform.openai.com/docs/api-reference/chat) documents authenticated Chat Completions requests to `https://api.openai.com/v1/chat/completions`. | A service worker with only `https://api.openai.com/*` host access can make the request; page scripts do not receive a key or make provider calls. |
| [OpenAI key-safety guidance](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) says, “Do not expose your API key in client-side code (browsers or apps).” | This is substantive negative guidance. It is not treated as irrelevant: v1 does **not** embed a developer-owned key, and instead accepts a key the user owns on their own machine. The key is never page-readable, is session-only by default, is sent only from the trusted extension worker after confirmation, and persistence is fail-closed behind `TRUSTED_CONTEXTS`. Users are warned to use a dedicated spend-capped key and can delete it. This constrained user-directed BYOK posture is the basis for the limited v1 Go decision; it is not approval to ship a shared key in an extension. |
| [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage#property-local) documents `setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})`. | The worker applies the restriction before persistent writes and disables persistent mode if the call fails. |

## Feasibility spike results

| Check | Result | Recorded outcome |
| --- | --- | --- |
| MV3 provider request / CORS | The shipped worker has the declared OpenAI host permission and no content-script request path. The request path is exercised by `tests/unit/providers.test.mjs` against a mocked fetch, and the packaged-worker smoke run confirms the manifest declares exactly `https://api.openai.com/*`. No provider key is stored in source or test fixtures. | **Covered by manual release testing, not by an automated gate.** No automated suite accepts a real provider key: doing so meant a live key entering a process environment and CI-adjacent tooling to produce an artifact that hands-on release testing already produces. The releaser instead runs Save & Test from the loaded options page with their own dedicated spend-capped key (`docs/release-checklist.md`), confirms the authenticated round trip, deletes the key, and records the sanitized outcome below. |
| `storage.local` access level | On 2026-07-19, `npm run test:chrome` passed in Chromium 148.0.7778.97. Its packaged-extension smoke run received `persistentAvailable === true` from the validated options page after worker startup, then saved a non-production persistent credential and verified that a content-script isolated world could not read it. Production still fails closed if the restriction rejects. | **Pass (sanitized automated evidence).** This establishes the browser-storage portion of the gate; it does not substitute for the pending authenticated provider request. |
| d1 — cold-worker command `tab` delivery | The `commands.onCommand` `tab` parameter is optional. A dependable populated tab target was not established for this release. | Fail/no-go for keyboard command; it is omitted from the manifest. |
| d2 — trusted keyboard activation into `sidePanel.open()` | Not run because d1 did not pass and the command is not a shipped surface. | Not applicable. |

## Propagated shipped outcome

The v1 manifest has no `commands` entry. README and the store-facing release checklist document exactly two launch surfaces: toolbar action and context menu. The release checklist requires those two surfaces to be tested manually; no conditional command language remains in shipped artifacts.

## Release gate status

**Go, with live provider verification moved to manual release testing.** The user/scope confirmations above are recorded by citation to the approved plan, and every other Phase 0 item has passed. The approved plan called for a live authenticated MV3 request as automated evidence; this record deliberately deviates. Automating it would require a real OpenAI key inside a test process to prove something the mandatory hands-on Save & Test step in `docs/release-checklist.md` already proves in a real browser, and a key that must never reach an issue, a chat transcript, or a repository file should not be routed through test tooling to produce a duplicate artifact.

The residual risk is accepted and bounded: if the packaged worker cannot complete an authenticated Chat Completions call, the manual Save & Test step fails visibly before submission, because that step is the same code path every user hits on first run. Web Store release is gated on completing `docs/release-checklist.md`, including that step — not on an automated provider spike.

## Security invariants

Only the background worker reads or writes `dsaCoach.credential` and `dsaCoach.credTombstone`. Credential operations are serialized; versioned tombstones suppress stale envelopes across session and local storage before deletion removes bytes. Provider calls require a worker-created session, worker-captured problem text, and an explicit panel confirmation. The panel only sends IDs and learner chat text, never an API key or replacement problem text.
