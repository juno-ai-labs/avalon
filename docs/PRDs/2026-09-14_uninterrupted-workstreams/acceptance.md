# Acceptance evidence and remaining checks

This is an implementation acceptance record, not a declaration that the feature has shipped. The PR remains open until the outstanding checks and author decisions are complete.

| PRD requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| 1. Uninterrupted conversation | Real Bind tool delegation and a subsequent foreground answer while the worker provider is held, in `automation-post-result.test.ts`. | Three participants in the real desktop with a configured model; measure useful response time against an agreed target. |
| 2. Delegation and continuation | Real creation, stable replay identity, name/description listing, independent run, explicit reply, continuation, and nested creation in the workerd suite. | Verify model judgment in the live flow. |
| 3. Stop and archive | Held model settles through Bind after stop; recursive owned stops; independent Sidekick survives archive; archived destinations refuse continuation. The combined stop/continuation test passed 20 consecutive isolated runs after atomic admission. | Foreground stop leaves a held worker running; continuing a worker leaves its descendant stopped. Both checks fail under representative mutations. The registration/stop race is fenced before descendant enumeration and tested with a start at that boundary. |
| 4. Messaging | Durable send/reply identity and sender context; attachment manifests and image projection; explicit attachment exchange within existing message limits; large final responses remain local. | Concurrent Sidekick exchanges through actual running conversations. |
| 5. Teams | `agent-teams.test.ts` uses WorkspaceDO to prove separate rosters for a shared Sidekick, original-team reply routing, replay identity, and ownership distinct from membership. | No additional team-management surface is planned. |
| 6. Minimal UI | Real control-socket count and hidden-child authorization tests. Electron screenshots show singular/plural counts, unknown state hidden, and usable composer. | Repeat the desktop flow with actual workers; screenshots previously used explicit count fixtures. |
| 7. Sidekick setup | Real authoring Bind tools save and revise the same workstream-owned Sidekick; directory discovers that ID. Drafting tools are confined to authoring. | Frontier-model choice to reuse a suitable workstream Sidekick over personal/workspace alternatives. |
| 8. Tool access | Shared normal harness, inherited principal, independent plugin discovery, authorized read/write surface, and host contact checks. | Exercise a representative authorized write in a live background agent. |
| 9. Hints and judgment | Image tools expose advisory long-running metadata. No mandatory delegation gate exists. | Model evaluation of delegation, direct asynchronous-tool use, and avoiding unnecessary recursive delegation. |
| 10. Recovery and verification | Explicit message admission replay after lost confirmation and recipient crash and cold restart is covered by the updated suite. Ordinary final responses must create no recipient input. | Exact-head CI/reviews, medium fallback model and desktop acceptance. |

## Current contract and validation

On 2026-09-15 the user removed automatic forwarding. Results, questions, and updates travel only through explicit send_message/reply calls. Standard assistant responses stay local; needs-input states do not generate messages to another agent. The user subsequently approved a single host-generated failure notice to the owning parent, using the terminal diagnostic code and agent ID. The end_turn proposal and staged Bind dependency are withdrawn. Rally uses its pinned Bind 15 package and ordinary completion protections.

The previous full-suite run passed 2,942 desktop tests, 2,916 API Node tests, 925 workerd tests, and the other package suites. That run covered the superseded forwarding design, so it does not prove the new explicit-only contract. Updated scoped validation and mutation evidence are pending below.

Archive settlement and broader-audience attachment forwarding are approved, as recorded in [plan.md](plan.md). Live inference requires a configured development provider; scripted-provider tests prove runtime integration, not model judgment or responsiveness with three real participants.

The explicit reply recovery fixture passes 20 fresh cases after replacing graceful eviction with a targeted recipient crash. Graceful eviction could wait for in-flight requests past the test deadline; aborting all objects also reset Miniflare’s D1 and broke fixture isolation. The final test crashes only the recipient, verifies a new instance, and checks that replay creates one message and one run. Breaking stable delivery identity creates two messages and fails the test. Reinstating automatic forwarding fails the worker and Sidekick local-response regressions.

The approved failure notice is covered by real-workerd settlement and repeated-delivery assertions. Removing the production notification makes the parent-activation test fail. The focused communication and migration suites pass 30 tests. Local lint and typecheck pass. The full rebased suite found stale meeting-retirement migration expectations (corrected) and an unresolved search-authorization test failure (`records retry intent before an initial authority lookup can fail`); full-suite acceptance remains incomplete. Attachment forwarding to authorized Sidekicks with broader audiences is approved.

The prompt and metadata audit puts role guidance first, shortens coordination and Sidekick instructions, clarifies agentId versus messageId, and gives expected communication errors a next action. Runtime tests exercise actual tool definitions and message delivery. No OpenRouter, Azure OpenAI, or OpenAI key is configured in the checked development environment, so comprehension by a small live model remains unverified.
