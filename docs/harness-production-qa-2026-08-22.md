# Production agent-harness QA report — 2026-08-22

## Executive summary

Signed-in Computer Use attempted every plugin visible to the tested production
run, loaded every built-in skill, and exercised the Terminal, workstream,
attachment, memory, table, elicitation, automation-draft, HyperSight, alarm,
sleep, cancellation, and parallel-child surfaces. Representative happy and
error paths covered every external connector that activated; Granola activation
was blocked. Read-only Worker tailing correlated the visible results with
durable runs. Local library, API, script, desktop-release, type, lint, and both
regional build gates supplied the lower-level matrix.

The pass found five Avalon defects:

1. deterministic plugin, skill, and wake-up refusals were returned as successful
   tool results, so the model, durable receipt, audit, activity icon, and prose
   all recorded a failure as completed;
2. stopping an in-flight Terminal command left its durable tool row `started`
   because the same cancellation request that stopped the parent also fenced the
   live owner out of settling the child receipt;
3. malformed attachment-tool arguments were labelled as execution failures and
   could create a false `Attachment content unverified` boundary even though the
   executor never read content;
4. `search_plugins` required the complete query to appear as one literal
   substring, so a natural cross-capability query returned no plugins; and
5. HyperSight and meeting-notes inference callers used source values that the D1
   payload-log table still rejected, causing the logger to delete the just-written
   R2 object and discard the entire opt-in capture while leaving the visible
   inference successful.

All five have narrow branch-local repairs with mutation-proven regression tests.
They are not deployed and have not received a fresh production Computer Use
retest at the time of this report. Granola also failed live activation because
its hosted MCP request could not be completed. Logs classify that result as
authorization indeterminate rather than revoked; the evidence does not isolate
Avalon code from provider/session/transport state, so it remains an unresolved
live acceptance blocker rather than a confirmed code defect.

## Environment and safety boundary

- Date: 2026-08-22 PDT / 2026-08-23 UTC.
- Desktop: production `/Applications/Avalon.app`, version 1.132.0.
- Region: Global production API, application version 0.24.0 in the correlated
  Worker records.
- Model observed in the correlated runs: `google/gemini-3.7-flash`.
- UI driver: macOS Computer Use against the signed-in production application.
- Correlation: read-only `wrangler tail` for `avalon-api-global`.
- Exact correlated Worker script version:
  `d1662f96-02b9-4367-97f3-00c6a98e962d`.
- Local checkout baseline before the repairs: `fbe7f512`. Production Worker
  logs exposed `build_sha: null`; the local commit is therefore a source-review
  baseline, not the identity of the deployed Worker revision above.
- External tools were read-only. GitHub, Linear, Gmail, Drive, Slack, X, Web,
  and Granola received no external mutations. Terminal writes were confined to
  private QA workstreams and a scratch sandbox. Memory/table records and one
  attachment were QA-only. The automation remained an inactive draft and no
  delivery was created.

## Production catalog coverage

The discovery run at workstream `01a02be8-4fdc-7c6f-a6b7-a2425005c86d`, run
`01a02be8-54e7-7d7c-9da7-ff5c164e090f`, found eleven user-facing plugins.
“Available” means present in the frozen run catalog; “active” means preloaded
for that run.

| Plugin id | Display name | Production state | Live coverage |
| --- | --- | --- | --- |
| `avalon_terminal` | Terminal | available | Load, command, sleep, stop, recovery, sandbox persistence. |
| `avalon_web` | Web | available | Search, fetch, invalid URL. |
| `avalon_workstream` | Workstream | active | Resources, wake-ups, delegation-related surface. |
| `plugin_github` | GitHub | available | Tool discovery, repository list, missing contents. |
| `plugin_linear` | Linear | available | Team list, missing issue. |
| `plugin_google` | Google Mail + Calendar | available | Gmail profile, missing message. |
| `plugin_google_2` | Google Drive + Docs + Sheets | available | Search, missing metadata. |
| `plugin_google_3` | Google Drive + Docs + Sheets | available | Search, missing metadata. |
| `plugin_slack` | Slack | available | Channel lookup, missing channel. |
| `plugin_x` | X | available | Timeline read, invalid input. |
| `plugin_granola` | Granola | available | Activation attempted; hosted MCP unavailable. |

The run also offered and loaded all three built-in skills:
`deep-research`, `scheduling-a-calendar-event`, and `writing-an-email`.
The hidden discovery, core, memory, tables, and skills bundles were exercised
through their tools. Notion was not in this run's production catalog, so no
claim is made about a signed-in production Notion connection; its connector
adapter is covered by the local connector library suite.

## Production Computer Use matrix

| Surface | Result | Evidence |
| --- | --- | --- |
| Catalog and activation | PASS, with classification defect on refusal | Exact inventory returned all eleven plugins and three skills. Valid Web and X loads succeeded. A nonexistent plugin stayed outside the frozen scope but its refusal was visibly completed instead of failed. |
| GitHub, Linear, Granola | PASS / PASS / UNRESOLVED LIVE BLOCKER | Workstream `01a02be7-5ef5-77c9-a9c6-bcc2a59cfb57`, run `01a02be7-6491-7494-bee7-1f334baf084f`. GitHub exposed 20 tools and listed `juno-ai-labs/avalon`; a missing content path returned provider `Not Found`. Linear exposed 9 tools, listed teams, and returned provider `Entity not found` for a bogus issue. Granola activation returned `plugin_authorization_unavailable`; Worker event `connector_plugin_reauthorization_failed` named “Granola MCP request could not be completed.” |
| Gmail, Drive, Slack | PASS | Workstream `01a02be7-d3c8-7899-8462-646033498799`, run `01a02be7-dc1e-7636-a31b-6c213bcf9174`. Gmail profile succeeded and a bogus message returned provider 400. Both Drive connections searched successfully and returned 404 for bogus metadata. Slack channel lookup succeeded and a bogus channel returned `channel_not_found`. |
| Discovery, skills, core, workstream, Web, X | PARTIAL; two defects found | Workstream `01a02be8-4fdc-7c6f-a6b7-a2425005c86d`, run `01a02be8-54e7-7d7c-9da7-ff5c164e090f`. Web search/fetch and X timeline succeeded; malformed X input was rejected. Exact skill loads and current time succeeded. Missing plugin, skill/resource, and wake-up cases were wrongly completed. `public web social timeline` returned `[]`. |
| Memory and tables | PASS | Workstream `01a02beb-1ad8-7224-ba1d-268a63191d64`, run `01a02beb-2064-700a-80ed-86b43d6108e4`. Create/read/update, revision conflict, and cleanup paths completed with the intended compare-and-swap behavior. |
| Elicitation | PASS | Workstream `01a02beb-753e-7672-a1ba-5a5e43d720bd`, run `01a02beb-7df8-78dc-850b-c533fad6048c`. A structured ALPHA/BETA single-choice block rendered, BETA was selected, and the resumed agent emitted `ELICITATION_RESUMED_BETA 2026-08-23T00:01:25.366Z`. |
| Terminal stop and recovery | DEFECT FOUND; provider process termination passed | Workstream `01a02bec-9bc9-7c4c-a4a0-03785277f9d2`, initial run `01a02bec-a42d-75f5-b3af-793cfe5156aa`. A command wrote a start marker, slept 60 seconds, then would write a late marker. Stop terminalized the parent as `stopped` with `ambiguous_external_write` while leaving the card `started`. Follow-up run `01a02bef-5b48-773c-bbee-b73e72a87dc3` conservatively returned `command_outcome_unknown`. A later command returned `START_PRESENT LATE_ABSENT RECOVERY_OK`, proving the stopped process did not write late and the sandbox remained recoverable. |
| Attachments | PARTIAL; defect found | Workstream `01a02bf2-a4b5-78ae-a676-63faddc80487`, run `01a02bf2-aaac-760d-a25c-84b5406fcb60`, resource `9558b15b-48ef-4482-bff0-fa4744d76761`. List, exact search, text read, and summary succeeded. Viewing a text resource as an image returned `resource_tool_mismatch`; a nonexistent UUID returned `resource_not_found`. A malformed empty-argument read was mislabelled as execution and remained in the grounding guard even though no content was accessed. |
| HyperSight | PARTIAL; payload-log defect found | Source workstream `01a02bf2-a4b5-78ae-a676-63faddc80487`, block `351faecd-995a-4cd7-bc03-d7eafd61d33a`, harness request `01a02bf5-5b41-749d-a4c6-fdb9f57fb2aa`. The QA block rendered a compact Markdown evidence table, but every opt-in D1 payload-log write failed the stale source check for `block_dashboard`; the logger then deleted the corresponding R2 object, so no payload capture remained. |
| Automation architect | PASS, intentionally not activated | Draft `01a02bf6-fbcf-7b2b-b3b5-0ffe55c1e505`, request `3bad0071-9269-4165-a93a-492cd1ab08ce`. The compiler elicited the missing URL, local time, and timezone, accepted `https://example.com/`, `9:07 AM`, and `America/Los_Angeles`, and produced the inactive draft “Harness QA public-page monitor.” No external delivery or subscription was created. |
| Parallel children, cold sandboxes, alarms, and sleeps | PASS at enforced bounds | The same production acceptance window recorded three parallel children starting within 272 ms and the fourth refused at the documented root-plus-three chain ceiling; two cold Terminal sandboxes overlapped; a 75-second command crossed both keep-alive windows; a wake-up due during the sleep fired once after the active run; and timeout recovery returned `LATE_ABSENT`. Exact workstream/run evidence remains in [`terminal-production-qa-2026-08-21.md`](terminal-production-qa-2026-08-21.md#2026-08-22-global-concurrency-alarms-subagents-and-timeout-acceptance). |

## Finding HQA-01 — P1: deterministic refusals are stored as successes

### Reproduction

In production, call any of these deterministic error cases:

- `load_plugin` with an unavailable plugin id;
- `load_skill` with a name outside the frozen catalog; or
- `workstream_cancel_wakeup` with a valid UUID that is not a pending wake-up.

The returned object contained an `error` code, but the activity row used the
green completed state. The model protocol also described the tool result as
successful. For wake-up cancellation the completed-row prose was “Cancelled…”;
for plugin loading it was “Loaded…”.

### Root cause

Confidence: high; traced end to end and reproduced in production.

The producers returned a normal `HarnessToolResult` with `output.error`. Bind
correctly treats every returned result as completion: it emits
`tool_completed`, checkpoints `completed`, and serializes
`{success: true, data: result.output}`. The API persists that lifecycle without
interpreting domain fields, and the desktop correctly renders the completed
receipt. The renderer was faithful to a dishonest stored protocol.

This was not required for recoverability. A thrown code-bearing error already
stays inside the harness loop, emits `tool_failed`, persists a failed receipt,
and projects `{success: false}` with allowlisted recovery details. The current
skill code is `skill_not_available`, not `skill_not_found`.

### Branch-local repair and verification

- Plugin activation refusals now throw `plugin_not_available`,
  `plugin_not_authorized`, `plugin_authorization_unavailable`, or
  `plugin_tools_unavailable` with a bounded next action.
- Skill scope, budget, activation, and resource misses now throw typed failures.
- Wake-up time/cap/input errors and cancel misses now throw `WakeupInputError`
  with `details.reason` and bounded `available` ids when safe.
- Cross-workstream wake-up lookup remains a flat not-found boundary; no foreign
  existence is disclosed.
- Harness tests assert `success: false`, one `tool_failed`, zero
  `tool_completed`, and no authority/persistence widening. Direct wake-up tests
  pin the typed code and remediation. A deliberate return-to-success mutation
  made the new lifecycle assertion fail before the repair was restored.

Status: fixed locally; deployment and fresh production UI/receipt retest pending.

## Finding HQA-02 — P1: member stop strands the in-flight Terminal receipt

### Root cause

Confidence: high; the process outcome and receipt outcome were independently
observed.

Stopping persisted `cancellation_requested_at`, which the live Bind loop
observed and converted into a `tool_failed` event. The host then called
`finalizeToolInvocationFailure`, but its ordinary ownership predicate requires
`cancellation_requested_at IS NULL`. The same durable stop that caused the
failure therefore rejected its settlement. The parent was terminalized stopped
while the child receipt remained `started`.

The later `LATE_ABSENT` marker proves the provider process was terminated in
this reproduction; it does not make automatic command replay safe. The durable
receipt correctly remains conservative because a record-before-execute command
can be unknown in other interruption timings.

### Branch-local repair and verification

Every terminal tool event already returned by Bind may settle after a durable
cancellation request while the attempt still owns its exact live lease. The
shared settlement predicate still requires the exact run, current attempt,
lease owner, running status, unexpired lease, and no prior terminalization; only
the cancellation-null check is relaxed. This covers a cancellation failure and
a tool that completes or fails naturally inside the stop poll window. Parent
`stopped` terminalization is rejected while any receipt for the run remains
`pending` or `started`, including a receipt left by an expired prior attempt.

Runtime regressions drive the production root completion and failure helpers:
they cover a record-before-execute Terminal write settling ambiguous after
cancellation and a returned read result reaching R2 and D1 after the member
stop. They also prove the parent cannot stop before those receipts settle, a
successor cannot stop around an unsettled effect that survived an expired claim,
and attachment dependency registration happens only after completion ownership
is accepted and only while the invocation remains `completed` at that exact
`output_ref`. The successor replan also repeats the absence of both attachment
dependencies and coordinate-keyed child runs inside the atomic checkpoint/row
compare-and-swap, so neither can race past its preliminary read. Restoring the
ordinary cancellation fence, moving attachment registration before it, removing
its output-reference fence, removing the atomic dependent-state predicates, and
removing the parent guard made the corresponding tests fail before the repair
was restored.

Status: fixed locally; deployment and a fresh stop/card/recovery UI retest pending.

## Finding HQA-03 — P2: argument rejection creates a false attachment-content gap

### Root cause

Confidence: high.

Bind emitted every executor throw with `phase: execution`, including a Zod throw
whose normalized input also failed the advertised schema. The attachment guard
records the resource access at `tool_started`; an execution failure is supposed
to remain unresolved until a verified retry. Because the malformed call carried
the wrong phase, the guard treated rejected arguments as a failed content read
and replaced the final answer with `Attachment content unverified`.

The fail-closed boundary itself is correct for the separate nonexistent-resource
call: content genuinely could not be verified, so the agent must retry with a
valid resource or report the boundary without inventing file contents.

### Branch-local repair and verification

Bind now emits `phase: validation` for declared argument errors. The grounding
guard always removes and ignores validation-phase access, even when a started
record exists. Harness and host regressions assert both halves. Each test failed
for the expected reason when its corresponding repair was deliberately reverted.

Status: fixed locally; deployment and fresh malformed-call UI retest pending.

## Finding HQA-04 — P2: plugin discovery requires one literal full phrase

### Root cause

Confidence: high.

`search_plugins` concatenated id, display name, aliases, and description and
called `.includes()` with the entire lower-cased query. X contained `public`,
`social`, and `timeline`; Web contained `public web`; neither contained the
complete string `public web social timeline`, so discovery returned no matches.
Whitespace normalized to the empty string also matched the entire catalog via
JavaScript's `includes("")` behavior.

### Branch-local repair and verification

Search now normalizes Unicode, case, punctuation, hyphens, and whitespace;
preserves meaningful one-character searches such as X; ranks exact field/phrase
matches above distinct-token overlap; includes OR-token matches; breaks ties by
canonical id; returns no results for a normalized-empty query; and caps results
at twenty. The regression returns X before Web for the production query. Forcing
token overlap to zero made that test fail with an empty result before the
implementation was restored.

Status: fixed locally; deployment and production discovery retest pending.

## Finding HQA-05 — P2: HyperSight payload logs violate the D1 source vocabulary

### Root cause

Confidence: high; the production exception named the failed constraint and the
runtime/database vocabularies were compared directly.

The typed runtime source union includes `block_dashboard` and `meeting_notes`,
but migration `0034_agent_inference_payload_logging.sql` still permits only
`workstream`, `automation_compiler`, and `inline_child`. HyperSight inference
therefore completed and rendered while each best-effort diagnostic index insert
failed with `D1_ERROR: CHECK constraint failed: source IN (...)`. Because the
logger writes R2 first and deletes that object when D1 indexing fails, neither
the payload nor its lookup row survived. The same stale constraint would discard
meeting-notes payload captures.

### Branch-local repair and verification

Migration `0093_expand_agent_inference_log_sources.sql` rebuilds the table with
the complete five-value runtime vocabulary, copies every existing row, and
recreates both indexes. It deliberately rejects unknown sources. A database
migration test applies the real history through 0092, preserves rows for all
three previously valid sources, admits both missing sources, rejects `unknown`,
and verifies foreign keys. The test failed when either a prior or new source was
deliberately removed from the migration before the repair was restored.

Status: fixed locally; application of migration 0093 to both Global and EU D1
is pending. Fresh opt-in HyperSight and meeting-notes verification must find the
D1 row and the exact R2 object referenced by its `object_key`.

## Unresolved live acceptance blocker — Granola hosted MCP unavailable

Granola's catalog entry and authorization record were visible, but activation
could not materialize its hosted MCP tools. Production logged
`connector_plugin_reauthorization_failed` with connector type `granola` and the
bounded reason “Granola MCP request could not be completed”; automation-draft
startup later logged `dynamic_connector_tools_unavailable` for the same
connection. The harness correctly classified authority as indeterminate, not
revoked. No secret, provider response body, or meeting content was logged.

This evidence proves the live Granola acceptance gate failed. It does not prove
whether the cause is provider availability, session/credential state, or
Avalon's hosted-MCP transport. No code change follows without a provider-aware
reproduction or a more specific private diagnostic.

## Local library and build matrix

The pre-fix baseline was fully green, which demonstrates that these production
defects were coverage gaps rather than already-failing gates.

| Gate | Result |
| --- | --- |
| `@avalon/agent-harness` library | 180 tests passed before the new regressions. |
| `@avalon/connectors` library | 218 tests passed across 13 files. |
| Targeted API harness matrix | 189 tests passed across 14 files. |
| Root production build | PASS. |
| EU Wrangler dry-run build | PASS. |
| Root lint | PASS, zero warnings. |
| Root typecheck | PASS. |
| Full root tests | PASS. |
| Repository script tests | 357 passed. |
| Desktop release invariants | 110 passed. |

After the repairs, the focused harness suites pass 112 tests, the focused API
durability, wake-up, attachment, and cancellation suites pass 124 tests, and the
six-test attachment-receipt suite and the new database migration test pass. The
new search, failure-classification,
wake-up, attachment, cancellation, and migration regressions were each proven
capable of failing through a deliberate implementation mutation before
restoration. The final branch source and documentation passed root lint with
zero warnings, typecheck, the full root test command, all 357 repository script
tests, all 110 desktop release-invariant tests, the root production build, the
EU Wrangler dry-run build, `docs:check`, and `git diff --check`.

## Remaining acceptance work

- Deploy the branch-local repairs and rerun all five reproductions in a fresh
  signed-in production workstream. Green local tests do not satisfy that UI gate.
- Recheck Granola with provider-aware diagnostics; do not report a revoked
  connection unless authorization actually returns denied.
- A production Notion connection was absent, so only adapter/library coverage is
  available for Notion in this pass.
- External write happy/error paths were intentionally not stress-tested because
  this QA did not authorize email, calendar, Slack, GitHub, Linear, X, Drive, or
  other third-party mutations.
- The prior Terminal acceptance still owns EU functional execution,
  stale-attempt recovery, and injected durable-host-error guidance; health checks
  alone do not close those gates.

## Release recommendation

Do not describe the current production harness as fully accepted yet. The broad
happy-path matrix is strong, provider-owned negative paths were bounded, and the
five confirmed Avalon defects have focused, mutation-proven local repairs.
However, the exact failure receipts, ranked discovery results, attachment guard,
stopped Terminal card, and inference-payload index must be observed after
deployment before the fixes are called production-verified. Granola and the
previously documented EU/injected recovery gates remain explicit unresolved or
regional follow-up work.
