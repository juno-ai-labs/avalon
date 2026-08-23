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

The original pass found five Avalon defects:

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

The post-deployment pass found a sixth Avalon defect: a
`command_outcome_unknown` run terminalized as `needs_input` but retained
Terminal's exclusive operation lease for sixteen minutes, blocking every linked
recovery run.

PR #247 merged and deployed the first five repairs. Fresh Global Computer Use
verified the reproduced failure-protocol, discovery, attachment-validation,
stopped-receipt, and HyperSight paths; migration 0093 is applied to both
regional D1 databases. The EU functional and meeting-notes payload paths remain
open. The sixth defect's provider-quiesced lease repair is branch-local and
mutation-proven, but not deployed or production-retested yet. Granola also failed a second fresh
activation because its hosted MCP authorization could not be verified. The
evidence still does not isolate Avalon code from provider/session/transport
state, so Granola remains an unresolved live acceptance blocker rather than a
confirmed code defect.

## Environment and safety boundary

- Date: 2026-08-22 PDT / 2026-08-23 UTC.
- Desktop: production `/Applications/Avalon.app`; original pass 1.132.0,
  post-deployment pass 1.133.0.
- Region: Global production API, application version 0.24.0 in the correlated
  Worker records.
- Model observed in the correlated runs: `google/gemini-3.7-flash`.
- UI driver: macOS Computer Use against the signed-in production application.
- Correlation: read-only `wrangler tail` for `avalon-api-global`.
- Exact correlated Worker script version:
  `d1662f96-02b9-4367-97f3-00c6a98e962d` before the repair. PR #247 deployed
  Global `00b5ed2e-8abe-46a5-b648-c66f495de50a` and EU
  `0f665acb-cfbd-415c-b437-5d662e244d9f` from merge commit
  `22d2fc101934e45c6628fd97eb25074ccf22b9de` in workflow run `32614933942`.
- Local checkout baseline before the repairs: `fbe7f512`. Production Worker
  logs exposed `build_sha: null`; the local commit is therefore a source-review
  baseline, not the identity of the deployed Worker revision above.
- External tools were read-only. GitHub, Linear, Gmail, Drive, Slack, X, Web,
  and Granola received no external mutations. Terminal writes were confined to
  private QA workstreams and a scratch sandbox. Memory/table records and one
  attachment were QA-only. The automation remained an inactive draft and no
  delivery was created.

## 2026-08-23 post-deployment Computer Use acceptance

Both regional health endpoints were green after PR #247, and both regional
migration listings reported no pending migrations after applying 0093. The
signed-in Global desktop then exercised fresh workstreams against exact Worker
version `00b5ed2e-8abe-46a5-b648-c66f495de50a`.

| Surface | Result | Fresh evidence |
| --- | --- | --- |
| Failure protocol, discovery, and validation | PASS | Workstream `01a02ca6-5325-7345-b8f3-a434dd70e881`, run `01a02ca6-5aa0-7089-9e94-f7395676593e`. `public web social timeline` returned `plugin_x`, then `avalon_web`, with `totalMatches: 2`. Missing plugin, skill, and wake-up calls rendered failed rows with `success: false` and codes `plugin_not_available`, `skill_not_available`, and `wakeup_not_found`. Empty resource arguments rendered `kind: validation` with the exact missing-`resourceId` error and no false `Attachment content unverified` boundary. |
| HyperSight payload logging | PASS in Global | HyperSight request `01a02ca7-fcf6-7029-8bbd-16f04de60826` rendered `HYPERSIGHT_PR247_POSTDEPLOY_OK`. D1 row `80f51d15-c8a4-4dd2-98dc-b9041c780e01` recorded source `block_dashboard` and object key `agent-inference/019fc068-22e8-739a-8394-a760fdc7c376/2026-08-23/80f51d15-c8a4-4dd2-98dc-b9041c780e01.json`; the exact 44,510-byte R2 object existed and carried the same request identity. No payload contents were exposed. |
| Stop receipt | PASS; linked-run lease defect found | Workstream `01a02ca6-9b16-761b-b61f-08f8f612d9ae`, initial run `01a02ca6-a2fa-781c-8ae5-d6f33348eb12`. Stop moved the sleeping command card from `started` to `ambiguous` and visibly stopped the parent. A deliberately different follow-up command in run `01a02ca9-7aac-700c-9027-65bf6e9d5cfe` returned conservative `command_outcome_unknown`; three later runs produced five `sandbox_busy` read failures from 03:29:10Z through 03:33:38Z. This is HQA-06 below. |
| Parallel children, alarm, and sleep | PASS | Workstream `01a02cab-74f9-7536-8b97-7623305b3c88`, root run `01a02cab-7c72-702f-9506-2aaeeea06001`. Three same-turn children completed independently in 4–5 seconds. A 40-second Terminal sleep completed in 42,813 ms while wake-up `01a02cab-abcc-7ae2-8e12-c9b5a7fbae37` became due; it fired once afterward in linked run `01a02cad-1c92-76d8-84bd-b328ad2a4ca7` and returned `PR247_ALARM_OK 2026-08-23T03:32:27.718Z`. |
| Granola | UNRESOLVED LIVE BLOCKER | Fresh workstream `01a02cbd-3593-74ab-89c1-8241f4015b76`, run `01a02cbd-3b75-7c34-a5f2-49e2e33a3226`. `load_plugin` rendered a failed row in 897 ms with `success: false`, `kind: external`, code `plugin_authorization_unavailable`, and bounded retry guidance. No Granola content tool was exposed or called. |

The Global HyperSight artifact proves both sides of the repaired D1/R2 commit.
Migration and health are verified in EU, but no signed-in EU workspace was
available for a fresh EU inference payload, so this report does not substitute
Global functional evidence for that regional UI/artifact gate.

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

Status: production-verified after PR #247. All three refusals rendered failed
rows and model-visible `success: false` with their stable codes.

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
a tool that completes or fails naturally inside the stop poll window. Any
receipt still `pending` or `started` when the leased owner commits `stopped` is
classified and closed in that same batch, whether it came from the current
executor or survived an expired attempt: an unresolved write becomes ambiguous
and a read fails. A definite completion or failure that wins first remains
terminal. An obsolete executor defers its local dispatch to adopt the
successor's result instead of writing an unfenced product failure.

Runtime regressions drive the production root completion and failure helpers:
they cover a record-before-execute Terminal write settling ambiguous after
cancellation and a returned read result reaching R2 and D1 after the member
stop. They also prove stopped terminalization atomically closes a residual
effect that survived an expired claim,
and attachment dependency registration happens only after completion ownership
is accepted and only while the invocation remains `completed` at that exact
`output_ref`. The successor replan also repeats the absence of both attachment
dependencies and coordinate-keyed child runs inside the atomic checkpoint/row
compare-and-swap, so neither can race past its preliminary read. Restoring the
ordinary cancellation fence, moving attachment registration before it, removing
its output-reference fence, removing the atomic dependent-state predicates, and
removing the parent guard made the corresponding tests fail before the repair
was restored.

Status: the stopped parent and ambiguous receipt are production-verified after
PR #247. The separate linked-run lease recovery is reopened as HQA-06; the
earlier command remains ambiguous, and the no-late-marker check must be repeated
after that repair deploys.

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
record exists. Root and inline-child hosts distinguish a failure emitted after
`tool_started` from one rejected before start: the former settles the exact
real-input receipt recorded in memory, while only the latter creates a
validation-only empty-input receipt. Harness and host regressions assert all
three boundaries. Each test failed for the expected reason when its
corresponding repair was deliberately reverted.

Status: production-verified after PR #247. The malformed call rendered as a
validation failure and did not produce `Attachment content unverified`.

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
at twenty while returning the full `totalMatches` count so the model can narrow
a truncated search. The regressions return X before Web for the production query
and expose 26 total broad matches alongside the top twenty. Forcing token
overlap to zero made the first test fail with an empty result, and replacing the
full count with the slice count made the second report 20 instead of 26, before
both implementations were restored.

Status: production-verified after PR #247 for ranked discovery and the
model-visible count: X preceded Web and `totalMatches` was 2. The broader
26-match/20-return cap remains mutation-proven in the library regression.

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

Status: migration 0093 is applied to Global and EU. Fresh Global HyperSight
verification found both the D1 row and its exact 44,510-byte R2 object. A fresh
EU functional payload and meeting-notes payload remain unexercised.

## Finding HQA-06 — P1: `needs_input` retains Terminal's operation lease

### Reproduction and root cause

Confidence: high; reproduced through signed-in Computer Use and traced through
the object-local run, task, and lease authorities.

After the stopped receipt was fixed, workstream
`01a02ca6-9b16-761b-b61f-08f8f612d9ae` deliberately submitted a different
command instead of replaying the prior ambiguous one. Run
`01a02ca9-7aac-700c-9027-65bf6e9d5cfe` lost provider observation, returned
`command_outcome_unknown`, and terminalized as `needs_input`. Runs
`01a02caa-2a79-7bb5-8b69-13409aeb0a78`,
`01a02caa-b399-76e8-a0fe-21d0292cfed1`, and
`01a02cae-3566-7833-9d70-0c731f19735f` then produced five `sandbox_busy`
reads between 03:29:10Z and 03:33:38Z.

The harness considers `needs_input` terminal, writes `terminalized_at`, clears
the attempt lease, and admits a new linked run when a person follows up. The
Terminal lease query instead preserved the retired compatibility vocabulary in
which `needs_input` counted as a live run. No release RPC exists, so the old run
could not release `terminal_workspace.operation_run_id`; the five-second retry
value was only polling guidance while the actual lease deadline was sixteen
minutes. The lifecycle sweep used the same stale status list and logged a
deferred transition every minute.

### Branch-local repair and verification

The operation lease now treats `needs_input` as yielded, while every takeover
from another run remains fenced by any `planned`, `submitting`, or `running`
Terminal task. Neither that task's nominal command deadline nor the broader
sixteen-minute lease deadline is accepted as proof that Daytona stopped the
process. Command admission is now one object-local transaction fenced by the
exact sandbox generation, provider sandbox, live run, operation owner, and
absence of a cleanup or lifecycle claim. The task remains `submitting` until
Daytona returns the exact command ID; an unexpired provider-request window
excludes recovery, so cleanup cannot observe a not-yet-visible session
and hand the sandbox away while submission can still arrive. Daytona rechecks
that exact durable authority immediately before every session-create,
session-replace, and command-submit mutation and renews the bounded submission
window each time. Provider acceptance atomically changes the task to `running`
and installs the requested command-plus-observation horizon instead of extending
the pre-submit fence. When a linked run encounters a retained accepted command,
Avalon deletes its exact named Daytona session (or confirms the whole sandbox
stopped), then settles the exact durable task as cancelled and atomically hands
the lease to the cleanup claimant. If a `submitting` task has no provider
session, or Daytona reports the sandbox absent, Avalon instead confirms provider
deletion, advances to a fresh sandbox generation, and only then admits the
successor. An object-local cleanup token excludes competing tools and lifecycle
work across those provider awaits. The exact token is renewed before every
provider mutation and cannot be revived after expiry, so a degraded cleanup
cannot leave an obsolete stop/delete continuation behind after a successor
takes over. The lifecycle sweep uses the same provider-cleanup-before-
settlement order and token-fenced generation retirement for provider absence or
a `submitting` task whose named session is missing before final expiry; when
expiry is due, provider absence settles `expired` and preserves the final diff
instead of creating a replacement generation. Scheduled cleanup does not
depend on a later human-linked run. An aborted or late provider continuation stays unsettled
until that cleanup wins and cannot delete the successor's session. A transient
recovery failure releases its internal claim without leaving a member-facing
failure on an otherwise healthy sandbox. A definitive late result is still
preserved inside the obsolete runtime, but the harness receipt fence discards
it; no command-log attachment or provider cleanup runs after recovery wins, and
the continuation cannot overwrite durable cancellation. Automatic log
publication starts only after exact active-task settlement. `admitted`,
`running`, `waiting`, and `steering`
holders continue to block while their operation lease is valid; an unsettled
task blocks regardless of either deadline.

The real-workerd regression proves both nominal deadlines can pass without
admitting a contender, then proves exact task settlement permits takeover. A
runtime integration forces `command_outcome_unknown` and asserts that the
provider cleanup call precedes a distinct linked-run read while a concurrent
contender remains fenced. Causal cases terminalize and hand off while the old
runtime is paused both before durable task admission and after task admission
but before provider confirmation. The latter resumes only after sandbox
retirement and fails its durable pre-submit check before the modeled provider
mutation; the Daytona-provider regression separately proves that check runs
after session creation and immediately before `executeSessionCommand`. Neither
stale continuation can submit or revive the retired command. Other cases keep the read fenced when neither session
cleanup nor sandbox stop is confirmed, exercise the confirmed-stop/restart
fallback, and prove a late command cannot clean up the successor. The provider
unit suite pins exact named-session deletion, idempotent already-missing
sessions, cancellation checks after in-flight session creation, and
non-destructive ordinary cleanup failure. These tests prove
Avalon orders admission after the provider cleanup contract; the required fresh
production pass remains the evidence for a live Daytona process. The lifecycle
regressions prove expired tasks are cleaned before sandbox stop and a contender
cannot enter during a provider-await claim. Claim expiry does not turn
lifecycle authority into operation authority; the scheduled lifecycle path is
the only reconciler for the transitional state. Exact renewal before each
provider mutation cannot revive an expired token, so an obsolete claimant
cannot begin another mutation after the scheduler replaces its claim; the
degraded-cleanup race proves it cannot stop its successor.
Cleanup has no agent-selected item cap: every successful iteration settles one
of the finite durable tasks already present, and handoff waits for the set to be
empty. Both linked-operation and scheduled-lifecycle 21-task regressions prove
all residue is settled under the exact claim, including after a whole-sandbox
fallback stop. Provider-404 cases prove linked recovery and pre-expiry scheduled
lifecycle cleanup cancel retained tasks under the cleanup token, retire the
missing sandbox, and advance the generation before another operation can claim
it; expiry instead commits `expired` without discarding its final-diff
reference. Removing the yielded-
status rule, retained-task or phase-specific submission fence, lifecycle-claim
fence, late-publication guard, expiry settlement, transient-failure cleanup, or
lifecycle status repair made the corresponding test fail before restoration.

Status: fixed locally; deployment and fresh Computer Use recovery retest
pending. The repair restores access only after provider cleanup is confirmed;
it does not replay, reconcile, or declare the unknown command resolved.

## Review-driven durable-authority hardening

The final authority review also hardened cancellation recovery beyond the live
reproduction. Checkpoint, successful-completion, failure, and root-stop batches
carry their first live-lease admission through the immediately serialized
receipt update rather than sampling wall-clock expiry twice. Root and child
cleanup allocate after the greatest existing checkpoint index, healing a
receipt stranded by an older partial settlement. Parent terminalization remains
lease-fenced. Expired cancelled or orphaned inline children bulk-settle every
pending or started descendant receipt before their child result becomes
terminal. The Substream and BlockDashboard in-memory drains receive revocable
identities; Substream rechecks identity after its pre-claim await, and every
executor-owned dispatch release and transition to a durable terminal outcome is
fenced by the exact row lease token. Substream product failure carries the same
token; BlockDashboard delivery retries start only after its terminal outcome is
durable. An abandoned continuation therefore cannot clear a successor lease,
claim another row, or fail the successor's product run. Focused
regressions cover checkpoint admission before and across a lease deadline, both
terminal-settlement deadline crossings, inherited orphan checkpoints, read/write
child receipts, renewed-child and obsolete-root cleanup races, sixty root receipts,
stale Substream and BlockDashboard tokens, and replacement of a stranded drain.
The final full gate also exposed that the workerd dispatch-reliability fixture
created queue and run rows without the authoritative workstream root required by
the product mutation it asserted. That path failed on the first
isolated run. Seeding the production authority shape made the complete 12-test
file pass in twenty consecutive workerd runs.

## Unresolved live acceptance blocker — Granola hosted MCP unavailable

Granola's catalog entry and authorization record were visible, but activation
could not materialize its hosted MCP tools. Production logged
`connector_plugin_reauthorization_failed` with connector type `granola` and the
bounded reason “Granola MCP request could not be completed”; automation-draft
startup later logged `dynamic_connector_tools_unavailable` for the same
connection. The harness correctly classified authority as indeterminate, not
revoked. No secret, provider response body, or meeting content was logged.

The post-PR #247 retry in fresh workstream
`01a02cbd-3593-74ab-89c1-8241f4015b76`, run
`01a02cbd-3b75-7c34-a5f2-49e2e33a3226`, failed the same way in 897 ms. The
repaired protocol correctly rendered `success: false`, `kind: external`, code
`plugin_authorization_unavailable`, and the bounded reason “Retry after the
authorization service is available.” No Granola content tool was exposed or
called.

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

After the repairs, the focused harness suites pass 114 tests, the focused API
durability, dispatch, wake-up, attachment, and cancellation suites pass 178 tests, and the
six-test attachment-receipt suite and the new database migration test pass. The
new search, failure-classification,
wake-up, attachment, cancellation, and migration regressions were each proven
capable of failing through a deliberate implementation mutation before
restoration. The final branch source and documentation passed root lint with
zero warnings, typecheck, the full root test command, all 357 repository script
tests, all 110 desktop release-invariant tests, the root production build, the
EU Wrangler dry-run build, `docs:check`, and `git diff --check`.

The HQA-06 follow-up leaves the full Terminal authority file at 37/37 and the
focused runtime, lifecycle, coordinator, and provider files at 61/61 (22
runtime, 11 lifecycle, 9 coordinator, and 19 provider). The
pre-fix status predicate, a deliberate retained-task-fence removal, and a
deliberate lifecycle-status rollback each failed the named regression before
the repair was restored. The complete branch gates are rerun after the final
provider-cleanup repair and recorded before merge.

The final full-test run also exposed a workerd fixture race in three dispatch
lifecycle cases: each posted a dispatch and parked its one-millisecond alarm in
separate object invocations, allowing the automatic alarm to start between the
two setup calls. The pre-fix full suite observed one terminal run whose test
assertion raced its still-held dispatch token, while the isolated shuffled file
passed 20/20. Reusing the file's existing atomic `dispatchWithoutDraining`
helper removes that input-gate gap; the repaired shuffled file passed 20/20 and
the complete root test command then passed, including all 233 workerd tests.

## Remaining acceptance work

- Deploy the HQA-06 lease repair and rerun the exact stop, unknown-command,
  linked-read, `START_PRESENT`, and `LATE_ABSENT` sequence in a
  fresh signed-in production workstream. Green local tests do not satisfy that
  UI gate.
- Granola has failed twice, including after PR #247. Continue with
  provider-aware diagnostics; do not report a revoked connection unless
  authorization actually returns denied.
- A production Notion connection was absent, so only adapter/library coverage is
  available for Notion in this pass.
- External write happy/error paths were intentionally not stress-tested because
  this QA did not authorize email, calendar, Slack, GitHub, Linear, X, Drive, or
  other third-party mutations.
- The prior Terminal acceptance still owns EU functional execution,
  stale-attempt recovery, and injected durable-host-error guidance; health checks
  alone do not close those gates.

## Release recommendation

Do not describe the current production harness as fully accepted yet. PR #247's
failure receipts, ranked discovery, attachment validation, stopped receipt, and
Global HyperSight payload commit are production-verified. HQA-06 still requires
deployment and a fresh stop/recovery retest, and Granola remains unavailable.
The prior EU Terminal, stale-attempt, injected-error, fresh EU payload, and
meeting-notes payload gates remain explicit regional or targeted follow-up work.
