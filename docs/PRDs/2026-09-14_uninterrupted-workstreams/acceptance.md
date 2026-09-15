# Acceptance evidence and remaining checks

This is an implementation acceptance record, not a declaration that the feature has shipped. The PR remains open until the outstanding checks and author decisions are complete.

| PRD requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| 1. Uninterrupted conversation | Real Bind tool delegation and a subsequent foreground answer while the worker provider is held, in `automation-post-result.test.ts`. | Three participants in the real desktop with a configured model; measure useful response time against an agreed target. |
| 2. Delegation and continuation | Real creation, stable replay identity, name/description listing, independent run, final reply, continuation, and nested creation in the workerd suite. | Verify model judgment in the live flow. |
| 3. Stop and archive | Held model settles through Bind after stop; recursive owned stops; independent Sidekick survives archive; archived destinations refuse continuation. The combined stop/continuation test passed 20 consecutive isolated runs after atomic admission. | Foreground stop leaves a held worker running; continuing a worker leaves its descendant stopped. Both checks fail under representative mutations. The registration/stop race is fenced before descendant enumeration and tested with a start at that boundary. |
| 4. Messaging | Durable send/reply identity and sender context; attachment manifests and image projection; 11-resource exchange; full generated response beyond composer limits. | Concurrent Sidekick exchanges through actual running conversations. |
| 5. Teams | `agent-teams.test.ts` uses WorkspaceDO to prove separate rosters for a shared Sidekick, original-team reply routing, replay identity, and ownership distinct from membership. | No additional team-management surface is planned. |
| 6. Minimal UI | Real control-socket count and hidden-child authorization tests. Electron screenshots show singular/plural counts, unknown state hidden, and usable composer. | Repeat the desktop flow with actual workers; screenshots previously used explicit count fixtures. |
| 7. Sidekick setup | Real authoring Bind tools save and revise the same workstream-owned Sidekick; directory discovers that ID. Drafting tools are confined to authoring. | Frontier-model choice to reuse a suitable workstream Sidekick over personal/workspace alternatives. |
| 8. Tool access | Shared normal harness, inherited principal, independent plugin discovery, authorized read/write surface, and host contact checks. | Exercise a representative authorized write in a live background agent. |
| 9. Hints and judgment | Image tools expose advisory long-running metadata. No mandatory delegation gate exists. | Model evaluation of delegation, direct asynchronous-tool use, and avoiding unnecessary recursive delegation. |
| 10. Recovery and verification | Reply delivery followed by lost confirmation, DO eviction, and recovery yields one accepted reply and one inference run. Mutation of the stable effect identity yields two replies and fails. Oversized-output regressions also fail their tests. | Exact-head CI/reviews, medium fallback model and desktop acceptance. |

## Gates

The focused result/Sidekick/agent workerd file passes 19 tests, including the two latest review regressions. The retired inline-child runtime/storage cutover passes 115 focused Node tests. Lint, typecheck, and document checks pass. The full repository suite passed: 2,942 desktop tests, 2,916 API Node tests, 921 workerd tests, and all other package suites. This establishes the broad regression gate for the implementation cutover.

The existing model-tool contract proposals and attachment-sharing consequence are collected in [the plan](plan.md). Live inference requires an approved configured development provider; do not infer model behavior from the scripted provider used in runtime tests.

CI later exposed a test-provider acknowledgment loop in the descendant-continuation check. An isolated reproduction captured fresh “Acknowledged” exchanges waking the descendant; this was ordinary message continuation, not a recursive restart caused by the foreground request. The scripted provider now uses the existing `end_turn` tool for acknowledgment-only input, as the production instructions already require. The affected file passes 19 tests and the formerly intermittent case passed 20 consecutive runs. A new full-suite run is required after this fixture correction and remains pending.
