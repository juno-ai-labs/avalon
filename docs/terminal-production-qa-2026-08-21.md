# Production Terminal plug-in QA report — 2026-08-21

## Executive summary

The 2026-08-21 production pass found that Terminal was not release-healthy for multi-step work. Plug-in discovery, lazy loading, a cold scratch command, a same-workstream follow-up command, and read-only repository checkout worked, but repeated Terminal calls in one agent run did not: three independent workstreams produced sub-second Terminal call failures followed by `harness_execution_failed`, and one filesystem write remained `started` until the five-minute run lease was reaped.

## 2026-08-22 post-deploy verification correction

PR #224 merged as `19ecb3555a9902a388bc5b57eddfac233eae5b67`; deployment run
`32580512573` succeeded for that exact merge in configured deployments, including the
remote migration ledger and two-region health check. A signed-in production
window then reran the two-command control in private workstream
`01a02a06-79b0-7328-abe4-b75bf747ab24`. The first command completed; the
second failed in one second with the newly deployed
`tool_receipt_persistence_failed` guidance. A single safe retry reproduced the
same sequence under harness run `01a02a08-f154-77b4-b0ab-b04cefdc8341`.

That result corrects the earlier claim that the heartbeat join was the complete
root cause. The fresh run's `SubstreamAgent` alarm owned the drain from its first
instruction through its 25.2-second terminal outcome; no later heartbeat joined
it. The successful first command instead issued a chain of same-object
`executeTerminalOperation` RPCs from inside that alarm. The second tool failed
before `terminal_tool_finished`, after returning control to the alarm's receipt
and regional-I/O path. The remaining request-context violation was therefore
the resident agent RPCing back into its own object, not the inverse heartbeat
ordering fixed by #224.

The follow-up repair gives the resident Bind loop an in-object Terminal port
that shares the RPC endpoint's identity, transaction, directory-effect, typed
failure, and post-commit alarm semantics. It also keeps generated-resource link
attachment—including oversized command output and repository-replacement
backups—inside that same event instead of preserving a second self-RPC path.
External Worker callers continue to use RPC. The Global production sequence below
verified the resident path after that follow-up merged and deployed.

## 2026-08-22 Global production acceptance

Fresh private workstream `01a02af9-7c6f-7b85-8738-a8afce00dd99` completed
harness run `01a02af9-83e0-7f82-97e6-3dbfa1793cc4`. Production Global logs
record one resident `SubstreamAgent` event with `outcome: ok` across 323,153 ms.
The harness completed in 319,526 ms with 28 tool calls over 29 iterations, and
`agent_run_outcome` recorded `completed` with no error code. Neither
`tool_receipt_persistence_failed` nor `terminal_resident_runtime_incomplete`
appeared.

| Area | Global result | Production evidence |
|---|---|---|
| Sequential receipts | PASS | The exact first/second-command regression completed, followed by another successful command after an expected exit 7. |
| Runtime and process execution | PASS | Node 25.9.0, Python 3.14.6, SQLite 3.46.1, and Git 2.55.0 reported; a two-second delayed command completed normally. |
| Filesystem mutation | PASS | Write, read, shell `cat`, edit, and an atomic two-file patch produced the expected final contents. |
| Local Git | PASS | A scratch repository initialized, committed `PR228_LOCAL_GIT`, and reported branch `master` and commit `4402a6a` without a remote. |
| Binary handling | PASS | Terminal generated exactly 262,144 bytes with SHA-256 `7f8184e28d0c5f650a841d179a6c9fdcf4e247ef74c171130a3e51e2591a492a`. |
| Generated resources | PASS | Text resource `01a02afd-499e-7f7b-bfef-669f19061823` and binary resource `01a02afd-7ece-7e61-acdd-9d4c950dd550` published sequentially and were visible in the workstream inspector. |
| Resource round trip | PASS | Importing the published text resource produced the same 37-byte content and SHA-256 `55d152ee40abc1621f0963b14780a27ca33c9db7b1235660dcd4d7e72d911332`. |
| Final durable state | PASS | The workstream inspector showed both resources, `Harness status: completed`, and the same run and workstream IDs as the Worker trace. |

## 2026-08-22 Global concurrency, alarms, subagents, and timeout acceptance

The signed-in production desktop updated to Rally 1.132.0, then exercised the
Global Worker deployed from main revision
`5c830bf7fb23dbb19277ccca662f79c3454acc5b` by successful deployment run
`32601569285`. A read-only Worker tail correlated every fresh work stream with
its durable run. The two Terminal sleeps overlapped from 22:30:20Z through
22:31:05Z, proving two cold sandboxes were active at the same time rather than
merely finishing near each other.

| Area | Result | Production evidence |
|---|---|---|
| Parallel inline subagents | PASS at the enforced three-child ceiling | Workstream `01a02b96-eafd-7661-befd-67a5a04cd533`, parent run `01a02b96-f24c-7c87-8821-f9135b1f9f65`. Three child inference requests began within 272 ms (22:28:42.128Z–22:28:42.400Z), completed in 7–10 s, and returned correct independent results. The parent issued all four requested tool calls in one turn; the fourth was deterministically refused as `chain_budget_exhausted`. |
| Child ceiling | PASS in code; documentation defect found | `HARNESS_CHILD_MAX_CHAIN_RUNS=4` counts the root run, so production admits at most three inline children. Admission, UI, and the existing unit test agree. The runbook incorrectly said “four children per chain”; it now says four total runs, root plus three children. |
| Two cold Terminal sandboxes | PASS | Workstream `01a02b97-b5cb-7242-ae1e-1cb207835334`, run `01a02b97-bc67-7b4b-927d-a0859347bf10`, slept from 22:29:52Z to 22:31:07Z. Workstream `01a02b98-34b9-7807-a300-fd802c2a0697`, run `01a02b98-3be9-7c79-84d5-a1c9ac28b018`, slept from 22:30:20Z to 22:31:05Z. Both exited 0 and immediately completed a second command in the same sandbox. |
| Keep-alive alarms during a long tool | PASS | The 75-second command crossed the 30-second and 60-second keep-alive windows and returned `QA_SLEEP_75_COMPLETE`, exit 0, provider 78,302 ms, acquisition 11,328 ms, total 89,824 ms. Its follow-up returned `QA_POST_SLEEP_RECOVERY_OK` in 1,892 ms total. |
| Scheduled wake-up due during active sleep | PASS | Wake-up `01a02b97-e88b-7ba5-ae73-60fcc0975e99` was due at 22:30:30.891Z while the 75-second command was active. It did not interrupt or duplicate the live run, appeared once after that run completed, and produced the requested scheduled-test response without tools. |
| Timeout and process termination | PASS | Workstream `01a02b9a-d74e-7717-85f8-3f2522a2fd2a`, run `01a02b9a-dcf7-7308-9fb0-1e4ad8ca28a9`, returned `state=timed_out`, `terminationReason=timed_out`, and `exitCode=null` for a 3-second deadline. The immediate command returned `QA_TIMEOUT_RECOVERY_OK` and `LATE_ABSENT`; a second check 22 seconds later still returned `LATE_ABSENT`, proving GNU `timeout` terminated the original process rather than only abandoning observation. |
| Visible desktop state | PASS | Computer Use inspected the completed tool cards, exact timing fields, scheduled wake-up transcript, sidebar terminal states, and timeout report in the production window. No card remained `started`, no run needed intervention, and no duplicate wake-up appeared. |

### 2026-08-23 stop-recovery follow-ups close lease and quiescence gates

PR #247 fixed the stopped receipt itself: in fresh Global workstream
`01a02ca6-9b16-761b-b61f-08f8f612d9ae`, run
`01a02ca6-a2fa-781c-8ae5-d6f33348eb12` changed its sleeping command card from
`started` to `ambiguous` and the parent visibly stopped. The separate recovery
sequence then found a lease-liveness defect. Run
`01a02ca9-7aac-700c-9027-65bf6e9d5cfe` submitted a deliberately different
command, received conservative `command_outcome_unknown`, and yielded as
`needs_input`. Three later linked runs (`01a02caa-2a79-7bb5-8b69-13409aeb0a78`,
`01a02caa-b399-76e8-a0fe-21d0292cfed1`, and
`01a02cae-3566-7833-9d70-0c731f19735f`) produced five failed read rows with
`sandbox_busy` from 03:29:10Z through 03:33:38Z.

The status-only holder was terminalized and could never execute again; a reply
always admits a new linked run. The object-local lease nevertheless preserved
the retired compatibility rule that counted `needs_input` as live, so it waited
for the fixed sixteen-minute lease deadline. The repair treats the
run as yielded while every foreign takeover remains fenced by any unsettled
named Terminal task, regardless of either nominal deadline. Command admission
is fenced on the exact live run, operation owner, generation, and provider
sandbox; the durable task remains `submitting` through the provider-request
window so a not-yet-visible submission cannot race cleanup.
Daytona revalidates that authority immediately before every mutating submission
step. Provider acceptance atomically changes the task to `running` and installs
the requested command-plus-observation horizon. The follow-up repair now stops
the whole sandbox before settling an accepted command; deleting a named session
is not accepted as process-quiescence evidence. A pre-acceptance `planned` or
`submitting` command instead retires the old provider sandbox and advances to a
fresh generation before handoff. A due expiry settles `expired` and preserves
its final-diff reference
instead of creating a replacement generation. An
object-local cleanup token keeps competing tools and lifecycle work
excluded across each provider await. It is renewed before every provider
mutation and cannot be revived after expiry, so a stale cleanup continuation
cannot touch a successor. Transient cleanup failure does not become a stale
member-facing sandbox failure. A definitive late result is preserved only
inside the obsolete runtime; the harness receipt fence discards it, and no
command-log attachment or provider cleanup runs after recovery wins. Scheduled lifecycle cleanup cancels every retained task under that token before
retiring the provider sandbox; every pre-acceptance task takes that path without
waiting for a later human-linked run. That provider boundary matters because
`command_outcome_unknown` does not prove the command stopped. The earlier
command remains ambiguous and must not be replayed or called resolved.

Every fresh work stream also emitted an otherwise hidden error before its
creation request completed:

```text
workstream_runtime_sql_commit_failed
code=workstream_runtime_sql_not_committed
reason=workstream_runtime_authority_fenced
harness_run_id=null
```

This was not caused by Terminal, alarms, or parallel execution; the same event
preceded all four fresh runs. During
`WorkstreamObjectProductService.initialize`, the object creates an identity row
in `preparing` mode and must commit the authoritative root, opening message, and
first run atomically. Before that transaction,
first-run model selection called the ordinary flag resolver with the new
work-stream id. The targeting loader routed its work-stream-fact query back to
the object, where `executeWorkstreamRuntimeSql` correctly rejected every access
before `authority_mode='authoritative'`. The loader degraded to the remaining
workspace attributes, but rules requiring loaded work-stream product facts
could not match and the failed-read cache suppressed the now-readable row for
ten seconds, including a possible immediately-started inline child. Explicit
rules on the work-stream id could still match because the id remained in the
evaluation context.

The branch-local repair keeps the work-stream id in the Flagship evaluation
context for identity and bucketing, while loading only already-authoritative
workspace attributes during the preparing window. Later runs use the ordinary
full attribute resolver. Allowing reads through the fence was rejected because
the preparing row contains placeholder scope/state/origin facts; committing the
root early was rejected because it would expose an incomplete object. Focused
unit and real-workerd creation-path tests pin the distinct evaluation and
attribute-read subjects. At this point in the acceptance record, those tests
were green but the repair had not yet deployed or received its fresh-workstream
production retest. Review then found the same not-yet-populated interval in the
two scheduled creation callers: the activity consumer resolves before runtime
bootstrap, while automation creation resolves from a bootstrapped shell before
its product insert. The scheduled resolver now uses the same workspace-only
attribute boundary, avoiding both the fence and placeholder targeting facts.

## Follow-up remediation status

The first remediation merged and deployed through PR #224, but the signed-in
production retest above proved that it fixed only one ordering of the
request-context race. The post-QA real-workerd reproduction correctly showed
that a keep-alive alarm must not await another event's active drain promise.
The follow-up correction also removes the resident alarm's same-object
Terminal-operation and generated-resource-link RPCs. It is merged, deployed,
and production-retested in the Global acceptance above. Recovery continues to
belong to the durable dispatch row and harness attempt lease. A healthy long run
retains its unexpired attempt lease; a promise with no progress for five minutes
and no live lease can be replaced inside the same isolate.

The remediation and review hardening also:

- separates pre-commit Terminal and runtime-receipt failures from alarm scheduling after commit, so a committed write is never reported as safe to retry;
- emits content-free structured causes and preserves `tool_receipt_persistence_failed` / `run_state_persistence_failed` instead of the generic harness category;
- advances receipt-only stale settlements into the visible tool card with schema migration 14, including a v13-to-v14 repair;
- uses the compatibility trigger's semantic change counter on real workerd, rather than counting its receipt, bookkeeping, and transcript-projection rows as three logical writes;
- retains provider `durationMs` and adds `acquisitionDurationMs` and `totalDurationMs`;
- gives both agent object types a bounded heartbeat plus durable harness-lease takeover for a stranded in-isolate drain, avoiding both an already-due alarm loop and a permanent stall;
- validates typed object-port failure envelopes instead of manufacturing a retryable rollback from any non-success response;
- chooses harness persistence categories explicitly at each required port and classifies tool lifecycle-event failures as receipt failures;
- refuses to replay terminal command rows whose timing evidence is incomplete.

Regression evidence is recorded in real-workerd and Node tests. The new heartbeat test failed against the original code because the alarm joined the active drain; the post-commit Terminal-operation test failed because the endpoint returned 409 after committing; and the stale-card test failed because the receipt became terminal while the part stayed `started`. Real-workerd validation also caught that its cursor counts every internal trigger row; the port now returns one semantic receipt change, preserving first-write/replay behavior after transcript projection. All now pass, as do the full repository tests, lint, typecheck, documentation check, and both regional Wrangler dry-run builds. On 2026-08-22 the signed-in production window first reproduced the old deployment's 454 ms second-command failure, then the Global acceptance above verified the corrected command, receipt, and resource cards after #228 deployed.

## Environment

- Date: 2026-08-21, approximately 12:15–13:04 PDT.
- Desktop: production `/Applications/Rally.app`, version 1.121.0.
- API: `avalon-api-global`, application version 0.24.0.
- Worker deployment version: `532796e3-718c-4471-b1ad-b6eb38a182f2`, deployed at 2026-08-21 12:35 PDT.
- Current main: `c9bba244c9ea5de5a43333b65ebe9dc85397cf23`, “Give Terminal a typed port onto its own tables, and retire six reader-less ones” (PR #212).
- Model selected by the production workstreams: `google/gemini-3.7-flash`.
- UI exercised through macOS Computer Use against the signed-in production desktop. Server correlation used a read-only Wrangler tail of the Global Worker.

## Test results

| Area | Result | Production evidence |
|---|---|---|
| Plug-in discovery and load | PASS | Terminal loaded in 685 ms–2 s and exposed 9 tools in five QA workstreams. |
| Lazy allocation contract | PASS | A run that loaded Terminal but called no Terminal tool returned `TERMINAL_PLUGIN_LOADED`; no sandbox operation was required. This matches the current production contract. |
| Cold scratch command | PASS | `printf 'MINIMAL_E_OK\n'` returned exact stdout, empty stderr, `completed`, exit 0, provider duration 2,629 ms. |
| Same-workstream persistence across runs | PASS | A later run in the same E workstream returned exact `PERSISTENCE_FIRST` output from the existing workspace. |
| Multiple Terminal operations in one run | FAIL | E: second `run_command` failed in 454 ms. D retry: first `run_command` succeeded, the next failed in about 1 s. C: short `pwd` succeeded between two sub-second failed command attempts. Every affected run ended `harness_execution_failed`. |
| File write | FAIL / unresolved | B's first `terminal_write_file` stayed `started` for 5 m 26 s and the run ended `stale_run_reaped`. No file result or stable Terminal error was returned. |
| Read-only repository checkout | PASS | `juno-ai-labs/avalon-terminal-sandbox` checked out with `requiredRemoteAccess: read_only` in about 4 s. No permission escalation or remote mutation occurred. |
| Git after checkout | BLOCKED | The command immediately after checkout failed before producing stdout/stderr. On retry, a discovery command found `/workspace/.git`, but the following Git inspection command failed the same way. |
| Runtime inventory | PARTIAL | A successful command reported `/workspace/tqa-c`; the cold activation check reported `/workspace` and `x86_64`. The full Node/Python/SQLite inventory command was blocked by the pre-executor failure. |
| Edit, patch, timeout, sanitization, package install, local Git, resource publish | BLOCKED | The broad matrix could not be completed without repeatedly submitting writes after ambiguous failures. Continuing would have weakened the safety boundary the Terminal contract is designed to enforce. |
| Concurrent startup | FAIL / confounded | Of concurrently started QA workstreams, some completed a cold operation while B was reaped and C initially produced no tool activity. This is consistent with capacity or lease starvation, but the later sequential reproductions prove a separate non-concurrency defect. |
| Recovery UX | FAIL | Retry frequently produced another `harness_execution_failed` or a truncated plan without replaying/settling the prior tool card. |

### Reproduction

1. Create a private production workstream and load Terminal.
2. Execute one Terminal operation successfully.
3. Ask for a second Terminal operation in the same agent run.
4. Observe the tool card fail in 454 ms–1 s with its input echoed but no stdout, stderr, Terminal error code, or recovery guidance.
5. The run ends `harness_execution_failed` and “Retrying is unlikely to help.”

This reproduced in a scratch sandbox (E), after an authorized checkout (D), and among runtime-inventory calls (C). The E control is especially small:

- First command: `printf 'PERSISTENCE_FIRST\n'` — completed; server `terminal_tool_finished` duration 4,726 ms.
- Second command: `printf 'PERSISTENCE_SECOND\n'; node --version; python3 --version; sqlite3 --version` — failed in 454 ms with no command result.
- Harness run: `01a025dc-cce9-730f-aec7-1417bea1221d`.
- Workstream: `01a025db-ab9b-7bb9-90a5-45deafa286e3`.

### Root-cause analysis

Confidence: high for the fault boundary and precise failed invariant after the post-QA real-workerd reproduction.

The direct cause was the SubstreamAgent keep-alive heartbeat, not a Terminal SQL admission collision. A heartbeat alarm is a distinct Durable Object event. During a long first Terminal operation it called `drainRunsToCompletion()`, which joined the already-active `DurableAgentDrain` promise created by the run request. The alarm then awaited the other event's complete model/tool loop. That both held the alarm lane open and crossed workerd request contexts, explaining why later tool operations failed only after a successful long first call and why a write could remain owned until the five-minute lease reaper ran. A real-workerd regression that holds an active drain and invokes the alarm separately received `joined` before the fix and `returned` after it.

The production evidence correctly placed the symptom upstream of command execution:

- Successful commands emit `terminal_tool_finished` and return provider-owned `startedAt`/`completedAt` output. The failed calls returned neither.
- The failure takes less than one second, while a healthy already-warm command takes roughly 4.7 s end-to-end and a cold command roughly 17 s.
- The same sandbox runs commands successfully immediately before or after a failed attempt, ruling out missing runtimes, a bad working directory, repository authorization, and a generally unavailable Daytona sandbox.
- The production trace shows SubstreamAgent `executeTerminalOperation` RPCs during the failing boundary, followed by repeated WorkstreamDO regional-effect reads, but no participant-safe Terminal error.

The authority cutover made the race more visible and its diagnostic boundary lossy:

- Terminal now calls `SUBSTREAM_AGENTS.executeTerminalOperation` through `services/terminal/object-port.ts` for each lifecycle/receipt operation.
- `acceptTerminalOperation` catches the underlying storage error and returns only `{ error }` with status 409; it emits no structured failure event.
- The harness persists every write tool through the compatibility `tool_invocations` view before execution and again while settling failure/completion. A failure in that host callback becomes `FatalHarnessPortError` and is surfaced as the generic `harness_execution_failed` code.
- `terminal_tool_finished` is emitted only inside the observed Terminal executor. A receipt/port failure before that wrapper, or a second failure while persisting the tool failure, leaves exactly the production symptom: an input-only failed card plus a generic run error.

The receipt rows themselves admit sequential effects correctly. The missing invariant was that a separate heartbeat event must never join the run's in-memory drain. Durable single-flight is deduplication within the isolate, not authority that can be awaited across request contexts.

Implemented validation:

1. Real workerd proves a heartbeat returns rather than joining an active drain.

2. Real workerd proves both Terminal-operation and runtime-receipt commits remain successful when their follow-up alarm scheduling fails.

3. Caught object-port and receipt failures log IDs, operation/request, stable code, and a private cause without command, output, or statement text.

4. Bind retains participant-safe durable-host failure categories.

### Reproduction and evidence

In workstream B, the first `terminal_write_file` card remained `started` for 5 m 26 s. The run then changed to Needs intervention with:

- code: `stale_run_reaped`
- message: “This run stopped after its execution lease expired”
- request ID: `01a025d1-a16f-704a-90bf-c224fbbba33d`
- workstream: `01a025d1-99f4-7d12-81cd-dd628b5ed27f`

Retry did not reconcile the tool; it produced a partial plan and returned to Needs intervention.

### Root-cause analysis

Confidence: high after reproducing the shared heartbeat/drain race and the transcript projection gap locally.

This occurred while several fresh Terminal workstreams were started concurrently, but the exact five-minute lease boundary follows from the same request-context join: the live drain stopped making durable progress and its lease expired. The stale-run reaper correctly terminalized the authoritative write receipt as ambiguous. The visible card stayed `started` because that generic recovery path updated `tool_effects` but had no live harness publisher to rewrite the same-id `parts` row.

Schema migration 14 now repairs existing receipt-only settlements and rebuilds the runtime tool-invocation update trigger so every future terminal receipt update projects status, summary, completion, error, and tool status into the visible part inside the same transaction. The stale-write regression failed before that change and passes after it.

Implemented validation:

- Existing provider-phase and tool-finish telemetry is now joined by structured Terminal-operation and runtime-receipt commit/alarm events, retaining the private cause without command, output, or SQL text.
- Stale-run reconciliation settles every started receipt and schema 14 projects that terminal state into the visible card with actionable ambiguity guidance.
- Real workerd proves a heartbeat does not join the active run; the durable runtime test proves lease reaping settles a pending write receipt and its visible card together; the v13-to-v14 migration test proves already-stranded cards are repaired.

Production status: not re-triggered in the final Global pass. A healthy run that
never expires its lease does not prove that the production reaper settles a
pending write receipt and visible card together. That recovery remains covered
by real-workerd and migration tests and remains an open production acceptance
item.

### Evidence

For the E cold command:

- Tool card: 18 s.
- Server `terminal_tool_finished`: 17,043 ms.
- Returned `durationMs`: 2,629 ms.

The A control showed a similar gap: roughly 29 s on the activity card versus approximately 2,003 ms returned by the command result.

### Root-cause analysis

Confidence: high.

`terminal_run_command` derives `durationMs` from the durable task's `startedAt` and `completedAt`. Those timestamps are created after sandbox acquisition, policy reconciliation, and receipt lookup. The activity card and `terminal_tool_finished` measure the full executor wall clock. Both numbers are internally consistent, but the API field reads like end-to-end duration and materially understates what the participant waited for.

Implemented: `durationMs` remains the provider-command duration for compatibility; Terminal results now add and document `acquisitionDurationMs` and `totalDurationMs`. Tests require all three meanings and require total runtime duration to be at least acquisition duration.

### Evidence

Every fast failure showed the attempted input and generic run code, but no stable Terminal code, causal message, stdout/stderr, receipt state, or retry policy. The participant cannot tell whether the command ran. The agent consequently attempted improvised probes in C and D, while B's retry could not reconcile the prior write. The Global Worker tail remained attached for more than 16 minutes after E's UI had terminalized the run and still emitted neither a correlated `agent_run_outcome` nor the causal exception for that harness ID.

### Root-cause analysis

Confidence: high.

Several error boundaries collapse distinct faults:

- `acceptTerminalOperation` returns an untyped error string without a structured log.
- `object-port.ts` converts every unsuccessful envelope to a plain `Error`.
- A failure in the harness's durable host callbacks is intentionally fatal but maps to `harness_execution_failed`.
- The UI displays that generic member-safe code and offers Retry even when the write outcome is unknown or a durable receipt is missing.

Implemented and deployed: the Terminal object port returns `terminal_operation_not_committed` with `outcome=not_committed` and `retryable=true` only when the transaction rolled back. A later alarm failure is logged but returns the committed result. The shared runtime receipt path applies the same boundary. Bind carries `tool_receipt_persistence_failed` and `run_state_persistence_failed`, while stale write receipts settle the card to `ambiguous` with conservative do-not-repeat guidance.

## Additional observations

- Production behavior matches the current lazy-allocation documentation: loading Terminal alone does not start a sandbox. The proposed plug-in-activation prewarm is not production behavior; PR #173 (“Start Terminal sandbox on plugin activation”) remains open and unmerged.
- Historical production QA workstreams visible from 2026-08-13 show successful sanitization, output overflow, package installation, patch atomicity, SQLite/Git, resource, and checkout tests. They are useful regression context, not current proof.
- The Mac locked before Global acceptance and no API-only claim replaced the UI
  gate. After unlock, Computer Use reran the matrix in a fresh production window
  and visually inspected the completed workstream and both generated resources.

## Release recommendation
