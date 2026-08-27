# Terminal workspaces

Terminal is Rally's deferred Bind plugin for bounded code execution, file
mutation, resource exchange, and GitHub repository work. It gives a
work stream one private Daytona sandbox without turning Rally into an
interactive coding harness: the model receives nine typed tools, not a PTY or a
provider API, and a sandbox is allocated only when one of those tools executes.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/terminal/contract.ts` | Canonical plugin prompt, nine tool descriptors and strict argument schemas, and regional configuration contract. |
| `apps/api/src/services/terminal/plugin.ts` | Regional composition boundary and allocation-free deferred plugin registration. |
| `apps/api/src/services/terminal/coordinator.ts` | One-sandbox-per-work-stream acquisition, authority fencing, exclusive mutation leases, and recovery after ambiguous provider calls. |
| `apps/api/src/services/terminal/daytona-provider.ts` | The only Daytona SDK adapter: private sandbox, process, file, network, lifecycle, and host-scoped secret primitives. |
| `apps/api/src/services/terminal/tools.ts`, `runtime.ts` | Model-facing behavior, safe paths, bounded file/patch/command execution, durable command tasks, and self-healing failures. |
| `apps/api/src/services/terminal/resource-bridge.ts` | Authorized regional R2 import and generated-resource publication. |
| `apps/api/src/services/terminal/repository.ts`, `repository-selection.ts`, `workstream-state.ts` | Model-driven GitHub App repository selection, recovery backup, scoped credential bootstrap, prepared work-stream branch, optional typed publisher, and work-stream state API. |
| `apps/api/src/services/terminal/network-policy.ts`, `settings.ts` | Trusted-only policy compiler and preview/confirm workspace settings transition. |
| `apps/api/src/services/terminal/lifecycle.ts`, `apps/api/src/services/workspace-schedule-execution.ts` | Stop, archive, expiry, final-diff preservation, claims, retries, and the `terminal` alarm target WorkspaceDO drains. |
| `apps/api/src/services/terminal/snapshot-manifest.ts`, `apps/api/scripts/verify-terminal-provider.ts` | Executable snapshot contract and real-provider acceptance probe. |
| `apps/api/src/observability/terminal-platform-observability.ts`, `scripts/report-terminal-analytics.mjs` | Content-free Daytona phase measurements in Analytics Engine and their human-readable decision report. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx`, `components/inspector-rail.tsx` | Workspace network and GitHub connector policy controls plus participant-visible work-stream state. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Authoritative per-work-stream Terminal tables. Migration `0075_terminal_workspaces.sql` is the frozen pre-cutover D1 source. |
| `apps/api/src/durable-objects/workstream-terminal-storage.ts`, `workstream-terminal-protocol.ts` | The only reader and writer of those tables, and the operation contract derived from it. |
| `apps/api/src/services/terminal/object-port.ts` | The Worker-side handle every Terminal service holds instead of a database. |

## How it works

### Loading and allocation

`rally:terminal` is a built-in deferred plugin. Bind can discover and load it,
which exposes all nine tools and the language guidance but performs no provider
operation. The first tool execution asks `TerminalSandboxCoordinator` for the
work stream's exclusive Terminal mutation lease. It creates, starts, or restores
the stable private sandbox and records the provider result in the owning
SubstreamAgent. That successful acquisition, authority/policy decision, and
repository preparation are reused for later tools in the same harness run.
Repository checkout explicitly invalidates the run-local acquisition because it
can replace the sandbox generation; a later tool then acquires and prepares the
replacement once. A new harness run performs its own acquisition.

Rally uses Daytona's managed `daytona-small` container snapshot. On first
creation an idempotent compatibility bootstrap creates the owned `/workspace`,
installs only missing SQLite/`gh`/pnpm/`tsx` capabilities through the compiled
Trusted-only apt/npm hosts, and then executes the complete manifest. That
manifest probes Bash, Python, JavaScript/Node.js, TypeScript, SQLite, apt/dpkg,
pip/uv, npm/pnpm, Git, `gh`, and passwordless sudo. A compatible Daytona update
is adopted automatically; a breaking update fails creation closed. The plugin prompt tells the model to use those languages when code is
the clearest way to calculate, transform data, analyze files, validate a
repository, or create a graph, image, dataset, report, or archive. It tells the
model not to install another runtime or manager.

### Files and commands

The model receives `read_file`, `edit_file`, `write_file`, `apply_patch`, and
`run_command`. File paths are workspace-relative and their syntax is validated
before provider I/O. For reads, writes, and generated publication, symlink/root
containment is checked inside the same sandbox command that inspects or replaces
the requested file, instead of by a separate provider command immediately
before it. `ls`, `find`, and `rg` through
`run_command` own discovery; there is deliberately no `list_files` tool.
Model-facing revisions are also absent. Exact-match edits and context-bearing
patches provide useful drift detection without forcing a medium model to manage
content versions, while the coordinator keeps exclusive mutation locking and
internal hashes.

Participant-authored `run_command` calls are non-interactive foreground Bash.
The provider runs each such command in a named process session under GNU
`timeout`, sends TERM at the deadline, sends KILL five seconds later, and
retains the named session until the terminal local result is durable. It then
deletes the session best-effort; an ordinary cleanup
failure does not stop an otherwise healthy sandbox. After a Worker interruption,
Bind re-enters only an exact incomplete Terminal command receipt, verifies the
command hash and sandbox generation, and reattaches to the sole command in that
session. A linked run cannot use an interrupted accepted command's sandbox until
Rally has stopped the whole sandbox and restarted it; deleting or failing to
find the named session is not process-quiescence evidence. A pre-acceptance
`planned` or `submitting` task instead retires the provider sandbox and advances
the generation. All other incomplete writes keep the harness's fail-closed ambiguity
behavior. The model receives one final result; provider observation is never a
tool. The SubstreamAgent stores the task, command hash,
deadline, exit, termination reason, output byte counts, and bounded head/tail.
Output beyond the inline allowance is also published as a generated log
resource, capped at 25 MB.

Rally-authored utility commands for file handling, resource transfer,
repository preparation/inspection, backup, cleanup, and trusted publication use
Daytona's direct `process.executeCommand` operation. These inputs are fixed by
Rally and need neither participant-command replay nor a recoverable named
session. They still run in the same bounded Bash envelope, working directory,
and session environment. Daytona's direct response exposes one stdout-shaped
result and no separate stderr stream, so these internal utilities use exit
status plus fixed private stdout markers; participant `run_command` continues
to preserve separate stdout and stderr through its named session. Cancellation
of an accepted direct utility stops and restarts the sandbox before Rally lets
the abandoned invocation return, establishing process quiescence without adding
named-session setup to the success path. The trusted publisher uses the direct
operation in its fresh ephemeral sandbox as well.

Command results expose three deliberately different clocks. `durationMs` is
the provider command interval derived from the durable task timestamps;
`acquisitionDurationMs` is the time needed to make the existing or new sandbox
ready for this invocation; and `totalDurationMs` is the Terminal runtime wall
time from acquisition through durable settlement. Callers must not present
`durationMs` as the participant's total wait.

### Resources

`import_resource` copies the original bytes of one currently authorized
work-stream resource from regional R2 into the sandbox. With no destination it
uses deterministic placement beneath `.rally/resources/`; an explicit
destination is create-only unless `overwrite` is true. The sandbox never
receives R2 credentials or a signed R2 URL.

`publish_resource` copies one stable nonempty regular file beneath
`AVALON_RESOURCE_DIR` into regional R2, creates a normal generated `resources`
row, attaches it to the work stream, and uses the existing cleanup outbox. The
published bytes do not enter model context. The resource inventory and existing
attachment tools become the durable participant/model surface.

### Git and GitHub

The model chooses exactly one repository from the authorized results of a
healthy regional GitHub App connection and calls `checkout_repository` with its
exact `owner/name`. The connection's versioned Settings policy may expose every
App-installation repository or an explicit immutable-ID set; each effective
entry is `read_only` or `full_access`. Read-only is remote-only: local file edits
and local commits remain allowed. Rally records the immutable GitHub repository
ID, exact full name, default branch, base SHA, fixed
`avalon/adjective-adjective-adjective-noun` head ref, and connection. The branch
slug reuses Rally's existing work-stream address vocabulary and a previously
stored valid branch remains stable. Before a different selection
destroys an existing sandbox, the harness creates and verifies a compressed
recovery resource containing source, untracked files, databases, and artifacts,
plus a portable Git bundle of local refs. It excludes credentials, the live
`.git` directory, and regenerable dependency trees.
If the copy fails, changes during transfer, or exceeds 50 MiB compressed, the
existing workspace remains untouched.

Before initial model-facing repository access, Rally mints a
one-hour installation token narrowed to that repository and the connector's
current access level and the model's durable requested ceiling, mounts it through Daytona host-scoped secret substitution,
creates or restores the recorded branch, switches to it, and exports the exact
name as `AVALON_GIT_BRANCH` and base as `AVALON_GIT_BASE_BRANCH`. If the branch
already exists remotely, bootstrap restores that head so later sessions continue
the same PR history; otherwise Rally creates the branch locally at the recorded
base and defers remote creation until the model first pushes. Later tools attempt
to restore the prepared branch, but an active merge, rebase, bisect, or conflicting
local edit does not lock the model out of the Terminal tools it needs to inspect
and repair that Git state. A `read_only` token technically blocks remote mutation while still
allowing local edits and commits. A `full_access` token permits ordinary trained
`git push` and `gh pr` workflows. The plugin prompt tells the model to remain on
the prepared branch, push only it, and target the prepared base branch. GitHub
does not provide branch-scoped installation tokens, and Rally deliberately does
not emulate one with a smart-HTTP proxy.

Connector policy is revalidated before every bootstrap. Saving a policy clears
the cached credential expiry for affected work streams, so the next tool rotates
the mounted token before any model command runs. The typed
`publish_branch_and_pr` operation remains available as an optional convergent
publisher, but it is not a gate around standard Git and GitHub CLI use.

### Network policy and lifecycle

Every workspace chooses Trusted only or Full internet. Trusted only compiles an
internal immutable baseline for Rally/GitHub, Debian packages, Python packages,
and JavaScript packages plus up to the remainder of Daytona's 20 exact/wildcard
domain targets. Settings shows only workspace-approved domains; the managed
baseline is not a participant-facing policy surface. Full internet clears
`domainAllowList`. Schemes, ports, paths, IP addresses, CIDR, public suffixes,
and private names are rejected. An admin previews canonical workspace-domain
changes and affected sandboxes against a revision, then confirms. Rally cancels
active tasks, preserves a final diff, stops each
affected sandbox, applies and reads back the provider policy, and does not
auto-restart it.

The workspace's alarm stops an idle running sandbox after five minutes,
archives it after sixty minutes, and deletes it after thirty days. Daytona's
15-minute auto-stop is only a provider backstop. Due transitions use a bounded
object-local claim that outlives the provider request limit and reconcile
observed provider state after ambiguous calls. Before stop
or deletion Rally saves a bounded Git diff (or a summary when the diff is too
large) as a generated resource. Filesystem archives are not copied to R2; after
expiry a participant explicitly starts fresh and the next tool gets a new root.

A participant stop aborts the live harness observation, not a Daytona process
out of band. The still-owning attempt first settles the in-flight Terminal
receipt under its exact attempt, owner, and live lease even though the parent
has a cancellation request. An interrupted `record_before_execute` command is
therefore durably ambiguous before the parent becomes stopped; it cannot remain
as a green or indefinitely started activity row, and it is never automatically
replayed. Provider-task reconciliation remains the authority for the command's
actual outcome.

### Product measurement

Every authoritative Terminal lifecycle transition reports its work-stream UUID,
closed action/result, bounded duration, whether a repository was selected, the
canonical connector class or `none`, and whether local files were retained. A
durable network-policy change reports previous/applied mode, bounded custom-domain
and active-sandbox counts, and result. Tool invocation events separately report
canonical Terminal capability use and terminal outcome through the shared harness
contract. Repository names/remotes, branches, paths, domain names, commands,
output, diffs, provider sandbox IDs, and error text never enter product telemetry.
The existing Analytics Engine provider-phase dataset remains operational and
personless; it is not duplicated into these product events.

## Invariants

- **One regional sandbox generation belongs to one work stream and one frozen
  authority fingerprint.** Reusing it after a principal, resource visibility,
  GitHub connection, or repository change would make old filesystem bytes a new
  caller's unauthorized input, so a mismatch destroys and reprovisions it.
- **Loading Terminal never allocates provider compute.** Discovery is common
  and execution is exceptional; allocating at load would turn model routing
  mistakes into cost and persistent state.
- **Every mutation is serialized through the coordinator and every command has
  one durable task receipt.** Parallel file operations or automatic retry after
  an ambiguous write could corrupt the sandbox or repeat a side effect.
- **A stopped parent does not strand its in-flight tool receipt.** The live
  lease owner settles that receipt before terminalizing the run, retaining
  ambiguity for an interrupted command rather than guessing whether it ran.
- **GitHub authority follows connector policy and branch choice follows the
  prepared workspace.** Read-only is enforced by GitHub token permissions.
  Full access intentionally trusts the model with a repository-scoped token;
  prompt guidance and automatic branch restoration keep ordinary work on the
  Rally branch without pretending GitHub supports branch-scoped tokens.
- **Resources cross through authorized regional services.** Giving Daytona R2
  credentials or treating a resource ID as authorization would break workspace,
  work-stream, principal, and residency boundaries.
- **Network policy is host compiled, revision fenced, stopped before mutation,
  and read back.** Letting the model edit egress or assuming a provider update
  succeeded would make Trusted only a UI label rather than an enforced state.
- **No model-facing revisions, lifecycle, directory-listing, polling, PTY,
  network, credential, or raw-Daytona tools exist.** These duplicate trained CLI
  behavior or expose control-plane authority that the task does not need.

## Boundary

Terminal owns the typed sandbox capability, its regional state, and its Daytona
adapter. Bind owns deferred-plugin discovery, durable tool receipts, transcript
streaming, and execution-principal context; see
[`agent-harness.md`](agent-harness.md). The attachment subsystem owns generated
resource lifecycle and current-authority reads; see
[`agent-attachments.md`](agent-attachments.md). The GitHub connector owns the App
installation and webhook boundary. WorkspaceDO owns alarm serialization through
its shared alarm list — see [`durable-object-alarms.md`](durable-object-alarms.md)
— while Terminal supplies only its due-row projection and transition
reconciler.

Terminal is not a user-visible terminal, a general workflow runtime, a hosted
development environment, a PTY, a background service runner, a model-managed
network proxy, or a general GitHub administration surface.

## Failure modes and limits

- A region defaults to `unsupported`. It becomes available only with an exact
  supported configuration, the managed snapshot compatibility probe, and a passing real-provider
  probe. The emergency switch keeps the plugin and its complete tool family
  discoverable, but new executions fail closed with `sandbox_unavailable` while
  retained work remains available for lifecycle reconciliation.
- An opted-in but incomplete Daytona environment degrades to `unsupported`
  instead of failing Worker startup. This keeps ordinary local development
  usable without provider credentials; a complete but malformed configuration
  still fails validation rather than guessing.
- A provider create timeout is reconciled by stable sandbox name. Provider,
  lifecycle, and policy failures remain durable and retryable; policy read-back
  mismatch leaves verification failed rather than claiming the new policy.
- Files are UTF-8 regular files and at most 10 MiB. Reads return at most 1,000
  lines and 256 KiB. A patch is at most 2 MiB and 100 files.
- A command is at most 32 KiB, defaults to 120 seconds, and is capped at 900
  seconds. Inline stdout and stderr are each head/tail bounded to 128 KiB; the
  complete generated log is capped at 5 MB and then the command reports
  `output_limit_exceeded`.
- Generated publication accepts one nonempty stable regular file, not a
  directory, symlink, device, or changing file. Resource bridge byte and count
  limits are enforced before R2 publication.
- Trusted only has 20 effective Daytona targets. The immutable baseline consumes
  thirteen; duplicate custom targets do not consume another slot.
- Git publication allows one fixed branch and convergent PR, a 50 MiB Git
  bundle, bounded changed paths/objects, no `.github/workflows/` changes, and no
  protected/default-ref push. Closed or merged convergent PRs are not reopened.
- Every expected model-repairable error names the next action: re-read a drifted
  file, inspect paths with `pwd`/`ls`/`find`, narrow an ambiguous edit, repair Git
  state, reconnect or reselect GitHub, or ask a participant for fresh publication
  intent. Provider internals and credentials are never copied into that message.
- An object-local Terminal mutation has three explicit phases:

  1. Validate the typed operation and commit its object-local SQLite
     transaction. An invalid operation or identity is a non-retryable typed
     rejection.
  2. Only a transaction that rolls back returns
     `terminal_operation_not_committed`, with `outcome=not_committed` and
     `retryable=true`; the raw storage cause stays only in structured logs.
  3. Schedule the follow-up alarm after commit. A scheduling failure is logged
     as diagnostic state and cannot change the successful response, because
     retrying a committed write could duplicate it. The committed regional
     directory effect and scheduler sweep own recovery.
- If run recovery terminalizes a durable tool receipt without a live harness
  publisher, schema migration 14 and the runtime receipt trigger project the
  same terminal status, summary, completion time, and member-safe error into
  the visible tool part. A stale write therefore becomes `ambiguous` rather
  than remaining `started` indefinitely.
- The shared runtime-SQL receipt port uses the same commit boundary: a failed
  transaction logs `workstream_runtime_sql_commit_failed` and returns only
  `workstream_runtime_sql_not_committed`; alarm scheduling after a successful
  receipt commit is diagnostic-only and cannot turn the receipt into a retry.

## Testing

The focused API suites are `apps/api/test/terminal-*.test.ts`; they use injected
Daytona, GitHub, R2, clock, and D1 fakes and never require network access. The
schema those fixtures are built on is proved by
`packages/db/test/baseline-migration.test.ts`. Renderer states are covered by
`workspace-settings.test.tsx` and `inspector-rail.test.tsx`.
Run the API set with:

```text
pnpm --filter @rally/api exec vitest run terminal-
```

`pnpm --filter @rally/api terminal:verify-provider-interface` is the disposable
real-provider smoke gate that needs only the normal supported Daytona variables.
It verifies create/read-back, managed bootstrap, a binary buffered upload and
download, command sessions, stop/restart, stop/archive/restore, policy update
read-back, persistence across every transition, deletion, and observed absence.
The buffered upload deliberately exercises `uploadFile`; Daytona's
`uploadFileStream` is unavailable in Cloudflare Workers and must not be used by
the provider. This smoke gate does not prove network escape resistance.

`pnpm --filter @rally/api terminal:verify-provider` is the destructive,
ephemeral real-provider acceptance gate. It requires the normal supported
Daytona configuration plus controlled HTTPS redirect and private-DNS probe URLs,
creates one private sandbox, checks a binary file round-trip, the snapshot
manifest and Trusted-only escape cases, verifies stop/restart,
stop/archive/restore, deletion, and observed absence. The explicit second stop
is required because Daytona rejects archive requests for running sandboxes.
The regional activation record must separately include controlled DNS-rebinding
and alternate-host secret-substitution evidence. A region remains `unsupported`
when any automated or controlled gate cannot run or fails.

Production config sets `DAYTONA_TERMINAL_SNAPSHOT=daytona-small`. The provider
probe must pass against the current managed revision before a region is enabled;
the per-sandbox compatibility probe protects the interval between activation
reviews.

## Data model

Migration `0075_terminal_workspaces.sql` created the legacy D1 source. Serving
contract 1 imports work-stream-owned rows into the main SubstreamAgent and
workspace policy into WorkspaceDO:

- WorkspaceDO `workspace_sandbox_network_policies`, `_domains`, and `_mutations`
  for the revisioned preview/confirm/read-back protocol and full history;
- `terminal_workspace` for generation, authority, provider, lease, lifecycle,
  retention, and final-diff state;
- `terminal_tasks` for durable command submission and one final result;
- `terminal_imported_resources` for generation-scoped deterministic imports;
- `terminal_repository` for the exact GitHub repository, refs, and
  selected remote-access ceiling;
- `terminal_publication_grants` for run/principal provenance retained by the
  optional typed publisher; and
- `repository_publications` for convergent trusted-write reconciliation.

The two object identities supply the workspace and work-stream tenant
boundaries. WorkspaceDO is authoritative for workspace network policy, GitHub
connection state, and resource metadata; those are read separately from the
SubstreamAgent's repository/import/task rows and rechecked before local
mutations. A multi-table SQL statement never pretends to join the two objects.
Provider IDs are
reconciliation facts and never authorize a request.

## Regional impact

All Terminal local rows, regional resource bytes, generated logs/diffs, GitHub App
installation-token creation, and tool execution records stay in the workspace's
owning Rally region. Daytona processes the sandbox filesystem in the configured
regional target and is therefore a regional subprocessor boundary, not a
cross-region Rally bridge. Global and EU advertise capability independently;
both checked-in deployments remain `unsupported` until their target, residency,
snapshot, egress, and lifecycle probes pass. No Terminal record falls back to
Global.

## Security and trust model

Model commands, repository contents, package output, imported resources, and
provider output are untrusted. Paths remain beneath `/workspace`; ANSI/control
characters and recognizable token forms are scrubbed before model or transcript
projection. Command arguments are never interpolated into a host shell. The
Daytona SDK is reachable only through the regional adapter.

The Daytona project credential stays a Worker secret. GitHub installation tokens
are minted just in time, narrowed to the selected repository and operation,
mounted through host-scoped Daytona placeholders, rotated, and removed on
revocation/expiry. The trusted publisher uses a separate ephemeral sandbox and
credential. Logs include IDs, state, error code, duration, and byte counts—not
commands, output, diffs, tokens, or resource contents.

The account-level `avalon_terminal_operations` Analytics Engine dataset is even
narrower: it contains operation, outcome, Rally region, configured snapshot,
source lifecycle state, failed phase, release identity, phase durations, and the
fixed names of compatibility tools installed. It contains no workspace,
work-stream, run, user, provider-sandbox, command, path, resource, repository, or
credential identifier. It is sampled aggregate telemetry, never authority or a
recovery ledger.

## Operations

A sandbox's warm-stop, archive, and expiry deadlines are workspace alarm
entries derived from `next_terminal_action_at` in the workspace directory
([`durable-object-alarms.md`](durable-object-alarms.md)). When the pass finds
the sandbox held by a live run it is re-checked a minute later; after a
transition it is re-checked thirty seconds later, which is how long the
directory effect takes to land off the Queue. Neither counts toward the stall
report; a deadline the pass finds nothing to do for does.

See [`runbook.md`](runbook.md#terminal-provider-activation-and-recovery) for
activation and recovery. Structured events are
`terminal_plugin_activation_finished`, `terminal_tool_finished`,
`terminal_sandbox_lifecycle_transition`, and `terminal_sandbox_lifecycle_failed`, plus
`terminal_operation_commit_failed` and
`terminal_operation_alarm_schedule_failed` for the typed object-port boundary,
plus
`workstream_runtime_sql_commit_failed` and
`workstream_runtime_sql_alarm_schedule_failed` for its durable receipt port,
plus
`terminal_tool_receipt_recovered` or
`terminal_tool_receipt_recovery_ambiguous` for interrupted commands and PR
publication. Each provider create, managed-image bootstrap, and start also emits
`terminal_daytona_operation_finished` and one non-blocking
`TERMINAL_ANALYTICS` point. Create separates provider allocation from policy
read-back; bootstrap separates directory/package installation from the complete
capability manifest; start records whether it warmed a stopped sandbox or
restored an archived one. Durable
task, policy mutation, sandbox, and publication rows supply exit, duration,
bytes, retained lifetime, and convergence metrics without logging content. The
emergency disable is the first response to a provider-wide isolation, secret,
or egress failure; it prevents new leases and publication starts while the
plugin stays discoverable and retained rows remain available for
reconciliation.

## Performance and cost

An explicit Terminal `load_plugin` starts and initializes the sandbox because
the next model action is overwhelmingly likely to use one of its tools. A
restored durable activation remains lazy so an unrelated later run does not
allocate merely because an earlier run used Terminal. Reuse is scoped to one
work stream. Five-minute warm stop reduces compute time, sixty-minute archive
reduces retained live-disk cost, and thirty-day deletion bounds provider storage. Only user-visible generated files,
complete eligible command logs, and the last bounded Git diff are copied to R2;
Rally does not pay to maintain a second cold filesystem archive. Provider time
and output bytes are derivable from local `terminal_workspace` and
`terminal_tasks`, so cost changes can be measured without exposing commands.

Within one harness run, acquisition, authority/policy validation, repository
preparation, and the loaded Daytona SDK sandbox object are reused rather than
looked up before every tool or provider operation. The cached acquisition is
discarded and performed again when its existing sixteen-minute exclusive
operation lease expires; ordinary tools do not renew or recheck that lease one
by one. Provider lifecycle changes evict every SDK-object alias so a stopped,
archived, or deleted object cannot be returned by another cached key. A
model-facing file read runs containment, regular-file validation, the 10 MiB
limit, strict UTF-8 decoding, line selection, and the 256 KiB response bound in
one sandbox-side Python operation; it does not download the complete file. A
single UTF-8 line over that response bound returns actionable guidance to use a
bounded CLI extraction instead of a non-advancing page cursor. A
complete write uses one upload and one containment/metadata/atomic-replacement
command; that command reports whether the file existed and its previous line
count, so Rally does not download content that the model asked to replace.
An exact edit passes its already-read UTF-8 content into replacement bookkeeping
and does not repeat containment for that same path in the same tool invocation.
Generated publication folds containment into its first of two stability
inspections, leaving one download between them.

Every Daytona SDK request emits `terminal_provider_request_finished` with a
fixed content-free operation name, outcome, duration, request count, poll
count, and transferred byte count. It includes the harness run, tool call,
effect receipt when one exists, and model-facing tool name, but never includes
the command, path, output, repository, resource title, or file contents. The
operation vocabulary distinguishes sandbox get/create/refresh/lifecycle/policy,
file upload/download, direct utility execution, named-session get/create/
submit/poll/log/delete, and secret list/create/update/delete.

The exact `operation` vocabulary is `sandbox.get`, `sandbox.refresh`,
`sandbox.create`, `sandbox.start`, `sandbox.stop`, `sandbox.archive`,
`sandbox.delete`, `sandbox.update_network`, `sandbox.update_secrets`,
`file.download`, `file.upload`, `process.execute_utility`,
`process.session_get`, `process.session_create`, `process.session_submit`,
`process.session_poll`, `process.session_logs`, `process.session_delete`,
`secret.list`, `secret.create`, `secret.update`, and `secret.delete`. A direct
utility additionally supplies one fixed `operation_detail`: `path.resolve`,
`file.inspect`, `file.read_page`, `file.replace`, `file.apply_patch`,
`file.temp_cleanup`, `resource.publish.inspect_before`,
`resource.publish.inspect_after`, `resource.import.inspect`,
`resource.import.finalize`, `repository.bootstrap`, one of the six
`repository.publish.*` inspection phases, `lifecycle.final_diff`,
`lifecycle.backup`, or `lifecycle.backup_cleanup`.

Each `terminal_provider_request_finished` record carries
`workspace_id`, `workstream_id`, `harness_run_id`, nullable
`tool_invocation_id`, `tool_call_id`, and `tool_name`, plus `operation`, nullable
`operation_detail`, `provider_operation_index`, `state`, `duration_ms`,
`provider_request_count`, `provider_poll_count`, and `bytes`. Each
`terminal_tool_finished` record carries those correlation identities and
`state`, failure `code` when applicable, `duration_ms`,
`acquisition_duration_ms`, nullable `acquisition_cache_hit`,
`provider_duration_ms`, provider request/poll/operation counts,
`provider_bytes`, and residual `rally_duration_ms`.

The terminal `terminal_tool_finished` event retains end-to-end duration and now
also reports acquisition duration/cache hit, summed provider request duration,
request/poll/operation counts, and transferred bytes. The residual wall-time
estimate makes Rally-side work visible when Daytona calls are fast. These
application events complement Cloudflare's automatic outbound-fetch spans: the
automatic spans prove the HTTP path, while the semantic events identify which
Terminal tool and provider operation caused it.

`terminal_plugin_activation_finished` uses the same acquisition and provider
timing fields under the fixed `terminal_plugin_activation` tool identity. It
also records `repository_state` as `prepared` or `deferred` and a bounded
`repository_code` when the repair belongs to the visible Terminal tool surface.
This separates cold sandbox/repository preparation from the subsequent tool and
makes first-tool improvement measurable without logging repository identity or
content.

`pnpm terminal:analytics -- --days 7` queries Cloudflare's SQL API and prints
the actual first/last observation time, sampled and sampling-weighted counts,
and average/p50/p95/max latency for create, bootstrap, stopped warming, and
archived restore. It separately prints provider-create, policy-read-back,
compatibility-install, and manifest-verification percentiles plus how often each
missing executable was installed. Region and snapshot filters are available.

Do not replace `daytona-small` from a handful of cold starts. The report waits
for at least 100 successful bootstraps in the selected cohort. When
compatibility-install p95 then exceeds ten seconds it recommends a controlled
prebuilt-snapshot benchmark. Verification remains in both variants, because a
custom image can remove installation time but cannot remove the fail-closed
runtime contract. Compare at least the same target/region and include create,
warm, restore, failure-rate, snapshot-build/activation maintenance, and managed
update lag before changing the default.

## Changelog

### 2026-08-27 — Explicit Terminal loading initializes the sandbox

**What changed:** The explicit Terminal `load_plugin` path now acquires the
work-stream sandbox and prepares a selected repository before exposing the nine
tools. Repairable repository failures are deferred so checkout remains visible.
Restored activation hints skip preparation and retain first-tool acquisition.
Activation emits correlated acquisition, provider-operation, repository-state,
and residual Rally timing. Eight repeated explicit loads single-flight one
activation, and a 64-operation utility burst proves one acquisition and one
repository preparation.

**Why:** Production use shows that loading Terminal is nearly always immediately
followed by a Terminal tool. Cold setup therefore belonged in the load latency,
where it can complete before the next model turn, instead of appearing as a
surprise first-tool delay.

**Considered and rejected:** Prewarming every restored hint, rerunning sandbox
security/policy checks before every tool, and failing the whole plugin for a
stale or repairable repository selection. They respectively allocate for
unrelated runs, repay setup after the authority is already established, or hide
the only repair operation.

**Consequences:** Explicit load may take the bounded acquisition-plus-repository
budget, but the first Terminal tool should be warm. Activation remains
convergent and cancellation-fenced; provider details remain out of the model and
traces. Performance comparisons must count `load_plugin` plus the first tool,
not claim a faster tool by moving cold setup outside the measured boundary.

### 2026-08-27 — Direct utilities, request tracing, and setup pay once

**What changed:** A successful sandbox acquisition and repository preparation
are memoized for the rest of that harness run. Repository checkout invalidates
the memoized generation. Read and publication fold root containment into their
existing file-inspection command, and complete writes fold containment,
old-file metadata, and atomic replacement into one command after the upload.
`write_file` no longer downloads the old file solely to calculate its result
summary, and `edit_file` reuses the path/content validation from its required
read instead of checking the same path again before replacement. All fixed
Rally-authored commands use Daytona's direct execution API; only participant
`run_command` retains a named session. `read_file` performs bounded UTF-8 line
paging inside the sandbox. The provider SDK sandbox object is cached for the
harness run. Each provider request and the aggregate tool execution now emit
correlated content-free latency, request, poll, byte, and acquisition fields.
Review hardening made the acquisition cache expire with its existing operation
lease, evicts every alias on lifecycle changes, rejects oversized text lines
without a stuck cursor, cleans uploaded temp files after provider failures, and
quiesces cancelled direct utilities by stopping and restarting the sandbox.
Named-session cancellation also repeats cleanup after an in-flight session
creation settles, so an abort cannot leave a late-created empty session behind.

**Why:** Production timing for a simple create-and-publish task showed that the
implementation was paying repeated provider and authority round trips rather
than doing useful work. A new text write took six Daytona operations: path
check, metadata, old-byte download, the same path check again, upload, and
replacement. It also entered the same sandbox acquisition/preparation path
twice. Those steps did not represent independent trust decisions.
Cloudflare's automatic trace also showed every fixed command paying named
session get/create/submit/poll/log/delete operations, but automatic fetch spans
could not assign those costs to a semantic Terminal sub-operation.

**Considered and rejected:** Revalidating workspace policy, repository
authority, repository credentials, and sandbox preparation before every tool,
and retaining a standalone `realpath` provider command before each file
operation or a named session for fixed Rally utilities. Explicit policy and repository mutations already stop, replace, or
version the affected sandbox, while per-input containment can run in the command
that consumes that input.

**What a future change has to respect:** A new harness run acquires for itself,
and an operation that can replace the sandbox generation must invalidate the
run-local acquisition. Input-specific path validation remains at the consuming
provider operation. Participant commands retain durable named-session recovery;
fixed utilities must not silently acquire that overhead. Trace operation names
must remain bounded and content-free. The operation lease is the cache lifetime:
reacquire at expiry, not before every tool. Do not restore a separate preflight
or per-tool setup check unless it protects a distinct authority transition that
has no existing invalidation path. An accepted direct utility must establish
process quiescence before cancellation returns.

### 2026-08-25 — Start fresh authorizes once at the participant authority

**What changed:** `startFresh` checks the calling member directly against the
work stream's authoritative participant rows, then returns state through an
internal post-authorization reader. It no longer checks the workspace directory
before that participant lookup or calls the public visibility-checking `get`
method afterward.

**Why:** Starting fresh requires participation, which is stricter than visibility
for workspace-scoped work streams and is already decided by WorkstreamDO. The
two directory reads repeated weaker authorization before and after the mutation
without protecting a separate resource.

**Considered and rejected:** Keeping one visibility read to preserve the exact
404/403 distinction for nonparticipants. That distinction would require a
second authority lookup on every successful start and does not alter who may
replace a Terminal workspace.

**What a future change has to respect:** Public state reads still require
visibility. Mutations that require participation authorize at the participant
authority once and must use internal readers after that boundary rather than
re-entering public authorization.

### 2026-08-25 — Sandbox paths are .rally

**What changed:** `/workspace/.avalon` and `/workspace/.avalon-output` are
`/workspace/.rally` and `/workspace/.rally-output`, along with the
`resources/`, `tmp/`, `logs/`, and `publications/` trees beneath them and the
`rally-publisher-*` session names. `AVALON_RESOURCE_DIR`, which carries the
output path into the sandbox, keeps its name.

**Why:** The rename. Safe to do without a compatibility path because the
snapshot bootstrap that creates these directories is idempotent and a sandbox
is per work stream and short-lived — one already running against an older
snapshot keeps its `.avalon` directories until it is replaced, and nothing
reads them afterwards. The env var stayed because renaming a variable the
sandbox image's own scripts read is a coordinated change with that image, not
with this repository.

### 2026-08-23 — Terminal receipt cleanup acknowledges its terminal-first handoff

**What changed:** Stopped Terminal runs write their authoritative terminal state
first, settle residual tool receipts under that exact terminal stamp, and then
write an immutable acknowledgment. A direct stopped retry or the existing
bounded activation sweep repairs a terminal row missing that marker. The same
operation and acknowledgment cover stale roots and inline children.

**Why:** The ordering is intentionally fail-safe but crosses two object calls. A
transient settlement failure or lost response left the run terminal, so the
direct path returned `already_terminal` and the live-only stale sweep never
revisited it. The tool receipt and visible card could remain started forever.

**Considered and rejected:** Receipt-first terminalization can corrupt a live or
successor-owned run. A new alarm, queue, schema column, or second cleanup method
would duplicate existing authority. The lifecycle ledger and activation sweep
already provide the durable marker and bounded retry owner; the obsolete
root-only settlement method was removed.

**Consequences:** A lost settlement response is idempotent: retry writes the
marker without adding another checkpoint or changing the terminal receipt. A
BlockDashboard-only sweep excludes ordinary roots because it intentionally has
no automation database; the fully authorized Substream sweep settles the
receipt, automation row, and marker together. The injected production error UX
gate remains open even though the failure-first regressions pass locally.

### 2026-08-23 — Accepted-command recovery requires a whole-sandbox stop

**What changed:** Foreground and scheduled recovery no longer treat deletion or
absence of a Daytona named session as proof that an accepted `running` command
stopped. Under the existing exact cleanup token, they stop the whole provider
sandbox before cancelling the durable task or handing the operation lease to a
linked run; acquisition then restarts the same sandbox and retains its files. A
`planned` or `submitting` task still retires the provider sandbox and advances
the generation, because an in-flight submission could otherwise arrive after
stop/restart.
Multiple residual running tasks share the one provider stop and are then settled
under the same token. Pre-acceptance residue is selected before running residue; a
lost delete response followed by provider absence is reconciled inside that
token-held loop, so every task is cancelled before handoff or final expiry.
Normal completed-command session cleanup remains
best-effort and does not stop a healthy sandbox.

**Why:** Fresh signed-in production Computer Use after PR #249 stopped a warm
command whose start marker was durable and whose 120-second sleep still had
about a minute remaining. The linked run acquired Terminal with no
`sandbox_busy` and initially observed the late marker absent, but a second read
after the original deadline found `PR249_STRICT_LATE_SHOULD_NOT_EXIST`. Daytona
had removed the named session used for observation while the shell continued
inside the sandbox. The previous proof therefore established liveness but not
provider quiescence.

**Considered and rejected:** Continuing to trust successful session deletion,
polling the task or lease deadline, or adding another grace timer. Production
disproved the first, neither durable deadline observes provider process state,
and a timer would only guess how long an already-unobserved command can mutate.
Whole-sandbox stop is an existing provider lifecycle boundary, preserves the
filesystem, and is already token-fenced against a successor.

**Consequences:** Recovery of an accepted ambiguous command pays one stop/start
cycle before a linked tool can run. That cost occurs only on an already-abnormal
path and buys a provider-authoritative non-overlap boundary. Runtime and
lifecycle regressions pause the stop, keep contenders fenced and the task
unsettled, then prove stop and restart precede the linked read. Removing either
call-site stop made its named regression fail before restoration. Pre-expiry
scheduled cleanup of pre-acceptance residue is intentionally destructive: it
deletes the sandbox, advances the generation, and clears any prior final-diff
reference. Final expiry preserves the existing generation and final-diff
reference, but skips a new preservation capture on that path because a possibly
in-flight submission could make the snapshot torn; no new diff is safer than a
falsely authoritative one. A future optimization must preserve provider-proven
quiescence before reusing that sandbox or publishing a final diff. PR #251's
fresh production sequence stopped an accepted 120-second command, immediately
admitted linked reads, and still found the late marker absent after the original
deadline. The ambiguous command was never replayed or declared resolved.

### 2026-08-22 — A yielded harness run no longer holds Terminal for sixteen minutes

**What changed:** The work-stream operation lease now distinguishes a harness
execution that can still run (`admitted`, `running`, `waiting`, or `steering`)
from one that yielded as `needs_input`. A linked run may take over from the
yielded holder before the lease's sixteen-minute safety deadline, but no foreign
run may take over while that holder has a `planned`, `submitting`, or `running`
Terminal task. Task admission is fenced on the exact live run, operation owner,
generation, and provider sandbox. It is recorded as `submitting` until Daytona
returns the exact command ID; during the provider-request window,
that state is exclusive provider-await authority and cleanup cannot begin.
Daytona revalidates and renews that exact authority immediately before every
provider session-create, replacement, and command-submit mutation. Once Daytona
accepts the command, the same atomic update changes the task to `running` and
moves its deadline to the requested command-plus-observation horizon. The
initial repair treated deletion of the exact retained Daytona session as
quiescence; the 2026-08-23 entry records why production disproved that assumption
and replaced it with mandatory whole-sandbox stop. A pre-acceptance `planned` or
`submitting` task is different: Rally deletes the old
sandbox and advances to a fresh generation so a late request targets only the
retired provider id. Before final expiry, provider-level 404 follows the same
token-fenced task cancellation and generation-retirement path; once expiry is
due, the same evidence settles `expired` and preserves the recorded final diff
instead of creating a replacement generation. An exact object-local cleanup
token excludes competing tools and lifecycle work across each provider await;
that token is renewed before every provider mutation and cannot be revived
after expiry, so a stale cleanup continuation cannot stop or delete a
successor's sandbox. Foreground and scheduled recovery reuse Terminal's
established sixteen-minute operation-authority window rather than introducing
another defensive timeout. Each claim is renewed before another provider
mutation. Scheduled lifecycle cleanup retires every pre-acceptance task's provider
sandbox without waiting for a later human-linked run;
ordinary successful-command cleanup never stops the whole sandbox on a session
deletion error. Aborted commands remain unsettled until recovery confirms
quiescence. A transient recovery failure releases its internal claim without
publishing a stale member-facing lifecycle failure. If a late provider call
returns a definitive result after recovery settled first, the obsolete runtime
keeps the bounded value locally, but the harness receipt fence discards it. It
publishes no command-log attachment, performs no provider cleanup, and cannot
rewrite the durable cancellation. Automatic command-log publication begins
only after the exact active task wins terminal settlement. The lifecycle sweep never clears a missing sandbox reference while
an unsettled task survives. The five-second
`sandbox_busy.retryAfterMs` remains retry cadence, not a promise that the
exclusive lease has already become available.

**Why:** Fresh post-deployment Computer Use stopped a command, then deliberately
submitted a different command rather than replaying the ambiguous write. That
second command lost provider observation, retained its named Daytona session,
and terminalized its harness run as `needs_input`. The lease liveness query had
preserved the retired compatibility vocabulary in which `needs_input` counted
as active. Because answering or following up admits a new linked run, the old
execution had no path that could release its lease; five later read attempts
received `sandbox_busy` for more than four minutes and would have remained
blocked until the fixed sixteen-minute deadline.

**Considered and rejected:** Treating every `needs_input` row as immediately
free, or using the nominal execution deadline as a quiescence boundary.
`command_outcome_unknown` is raised before its durable Terminal task is settled,
and Daytona retains that named session for exact-receipt recovery. Before
acceptance, the deadline covers only the bounded provider request; after
acceptance, the task moves to a command-plus-observation horizon. Neither clock
is accepted as quiescence evidence: a lost response can outlive Rally's local
observation. The current repair requires whole-sandbox stop for an accepted
command or deletion and fresh-generation replacement before acceptance. It never
replays or declares the ambiguous command resolved.

**Consequences:** A linked run may inspect or repair a Terminal workspace once
provider quiescence is confirmed, without waiting for an unrelated sixteen-minute
operation lease. Active harness executions still return `sandbox_busy` while
their operation lease is valid; every unsettled retained task does so regardless
of task or lease expiry. Exact-token task settlement blocks a late continuation
from rewriting the cancellation or deleting the successor's provider session.
Cleanup has no item cap: the input is the finite set of durable tasks already
present, and each successful iteration settles one before handoff. An unexpired
lifecycle token blocks operation acquisition, and expiry does not convert it
into operation authority. Scheduled lifecycle reconciliation remains the only
successor for that transitional state. Exact renewal before each provider
mutation cannot revive an expired token, so the obsolete continuation cannot
start another provider mutation after the scheduler replaces its claim. Real-
workerd tests pin the lease/task/claim predicates, runtime
tests pin pre-admission and pre-provider-confirmation races, contender
exclusion, mandatory whole-sandbox stop, and cleanup-failure behavior, and Daytona
provider tests pin cancellation rechecks plus exact idempotent named-session
deletion without a hidden whole-sandbox stop.

### 2026-08-22 — Member stop closes the in-flight Terminal receipt first

**What changed:** After durable cancellation, the current harness attempt may
settle any terminal event already returned by Bind for that exact receipt,
provided its attempt id, owner, running state, unexpired lease, and
unterminalized parent still match. Any receipt still `pending` or `started` at
the stopped commit is classified immediately afterward under the exact terminal
stamp — an unresolved write becomes ambiguous and a read fails — whether it came
from the current executor or survived an expired attempt. The immutable marker
above makes that second call retryable.

**Why:** Production Computer Use stopped a sleeping command and correctly
prevented its late marker, but its tool row remained `started`; a follow-up
reconciled the record-before-execute command as `command_outcome_unknown`.
`finalizeToolInvocationFailure` used the ordinary ownership predicate, which
rejects every write after `cancellation_requested_at` is set, including the
failure event emitted by the owner that just observed that request.

**Considered and rejected:** Inferring the receipt state from the stopped parent
in the renderer, automatically retrying the command, or removing cancellation
from all ownership fences. The first hides contradictory durable state, the
second can duplicate a write, and the third would let ordinary post-cancel work
continue. Only terminal receipt settlement by the exact live owner and the
terminal-stamp-fenced residual cleanup receive the narrow exception; ordinary
tool work remains fenced. An obsolete executor defers and terminates its drain instead of
writing an unfenced failure over the successor.

**Consequences:** A stopped command is displayed from its durable completed,
failed, or ambiguous receipt rather than a stale started row. This includes a
tool that naturally returns inside the stop poll window, not only the aborted
path, and a residual set of any size is closed inside one object transaction.
Provider outcome remains conservative, and every other post-cancellation write
stays fenced.

### 2026-08-22 — A held deadline is re-checked, not counted

**What changed:** The workspace alarm's Terminal deadline pass answers the
alarm's stall check: a sandbox held by a live run is re-checked a minute
later, a transition just made is re-checked thirty seconds later, and neither
counts as an attempt; a deadline the pass finds nothing to do for takes the
stall rule. The mapping is `terminalReconcileOutcome` in
`workspace-schedule-execution.ts`.

**Why:** The alarm base now holds an entry that runs and comes back due at the
identical instant ([`durable-object-alarms.md`](durable-object-alarms.md)), and
a Terminal deadline does that legitimately twice: its due time lives in the
workspace directory, which only the work stream's own effect moves, off the
Queue. Read as a stall, every warm stop would have been held behind a growing
backoff and reported to an operator at the third attempt.

**Consequences:** A deadline behind a live run is re-examined every minute
rather than on every alarm wake, which before this was a hot loop for the
run's whole duration. A stale directory row — a deadline with nothing behind
it — is what the stall report now names.

### 2026-08-22 — Terminal takes its effect identity from the tool context

**What changed:** `HarnessToolContext` carries an optional `effectIntentId` —
the receipt row the host recorded for this tool call — and the three places
Terminal used to read it out of `tool_invocations` now take it from there:
`runtime.ts` (the provider task name and the `terminal_tasks` row),
`resource-bridge.ts` (the `terminal:<id>` provider resource identity), and
`repository.ts` (the bundle path and the publication row). Terminal no longer
names `tool_invocations` anywhere, and `createDaytonaTerminalRuntime` lost the
`D1Database` parameter that existed only for that query.

**Why:** The typed port removed Terminal's D1-shaped SQL over its own tables,
and left three statements over a table Terminal does not own, reached through
the `_runtime_tool_invocations` compatibility view. Each was asking the same
question the harness had already answered a moment earlier: which receipt is
this call. The identity now travels with the call instead of being looked up
from it, which is both one fewer object round trip per Terminal write and one
fewer reason for the shared runtime vocabulary to exist.

**Considered and rejected:** Deriving the identity in the harness — hashing
`toolCallId`, or minting it in Bind and passing it down as the receipt id.
`toolCallId` is stable across a resumed run but its receipt row is created once
and kept, so an id computed on the second attempt would not match the one the
first attempt already wrote provider work against; a resumed run would start a
second sandbox task rather than reattach to the first. Only the host knows the
identity it stored, so the flow is host to harness, through the
`resolveToolEffectIntentId` port.

**Consequences:** The field is optional, because only a host that implements
receipt ports can supply it. All three call sites fail closed with the existing
`tool_receipt_missing` — the same error the missing-row branch raised — rather
than substituting `toolCallId`, which would key an external effect to a
coordinate no receipt ever used. `terminal_tasks.effect_intent_id` still
references the receipt, so a command still cannot record a task the harness
never planned; that check moved from a query Terminal ran to a foreign key the
object enforces.

The guard also moved earlier. While the identity came from a query, each path
acquired its sandbox first and checked afterwards, so a call that was always
going to be rejected could still create or start a Daytona sandbox, take the
mutation lease, and burn a generation on the way out. `requireTerminalEffectIntent`
now runs as the first statement of `runCommand`, `publishResource`, and
`publishBranchAndPr` — it is a field read, so there is no longer a reason for it
to run late.

**Still keyed to the call, not the receipt:** `createTerminalWorkspaceBackup`
derives `terminal-workspace-backup:${toolCallId}`, its archive path, and its
provider task name from `context.toolCallId`. It is the one Terminal effect this
change did not convert, and converting it is a resource-identity migration
rather than a rename: existing backups are addressed by the old identity, so a
resumed checkout would publish a second one instead of finding the first. "No
Terminal source names `tool_invocations`" is true; "every Terminal effect is
receipt-keyed" is not yet.

### 2026-08-22 — Resident agents keep Terminal authority in their owning event

**What changed:** A Bind loop already running inside the main `SubstreamAgent`
receives an in-object `TerminalPortFactory` and resource-link attacher. Terminal
coordination, task receipts, repository selection/bootstrap, resource
publication, and publication grants therefore use the same local operation and
product mutation bodies as their RPC endpoints without RPCing back into the
object that is currently executing them. Worker and scheduler callers still use
the typed RPC ports. Both Terminal paths retain the same identity check,
`commitRuntimeMutation` directory effect, typed not-committed failure, and
post-commit alarm scheduling boundary; generated-resource links retain
`WorkstreamObjectProductService.attachRuntimeResource` and its regional effect.
The local port uses the identity requested at the factory boundary, and both
local mutation bodies reject any object whose external substream ID is not the
main child `0`. Plugin construction accepts the local Terminal and resource
boundaries only as a complete pair, so future harness wiring cannot localize
one while silently leaving the other on same-object RPC.

**Why:** The production check after #224 deployed still completed the first
command and failed the second before `terminal_tool_finished`. The live trace
showed the alarm owned the complete run from its first instruction, so no
heartbeat ever joined it; instead, the first command generated a chain of
nested `executeTerminalOperation` events against the same object. Returning
from those self-RPC events and then resuming receipt, D1, and provider work in
the outer alarm recreated the request-context violation that the heartbeat fix
had removed in the opposite event ordering.

**Considered and rejected:** Another retry, extending leases, suppressing the
receipt failure, or moving Terminal state back to D1. Those respectively repeat
an unsafe write workflow, leave request ownership unchanged, hide the safety
fence, or undo the object-authority cutover. Calling raw storage directly was
also rejected because it would skip directory effects and post-commit alarm
semantics; the local port uses the same operation boundary as RPC.

**Consequences:** A resident main-child run performs sequential Terminal
operations and generated-resource attachment in one Durable Object event and no
longer pays or crosses a self-RPC per storage call. Non-main substreams and
external callers keep the serialized typed ports, and real-workerd plus plugin
integration tests pin both local authority paths and their propagation through
Terminal setup, resource publication, and repository backup. A future wiring
error cannot silently create a second Terminal or resource-link authority in a
non-main child.

### 2026-08-21 — Production recovery distinguishes execution, persistence, and commit state

**What changed:** Keep-alive alarms no longer join an already active agent
drain or spin on an already-due dispatch row. Both agent object types arm a
bounded follow-up heartbeat and use current drain progress plus the durable
harness attempt lease to distinguish a healthy long run from a stranded
promise; an expired owner can be replaced in the same isolate. The Terminal
object port returns a typed, participant-safe
`terminal_operation_not_committed` envelope and logs its private cause; a
post-commit alarm-scheduling failure is logged without changing the successful
operation response. The shared runtime-SQL receipt path observes the same
pre-/post-commit boundary. Bind now preserves `tool_receipt_persistence_failed` and
`run_state_persistence_failed` instead of collapsing both into
`harness_execution_failed`. Workstream schema 14 projects receipt-only terminal
settlement into the visible tool part, including a one-time repair for stranded
rows. Malformed object responses fail closed as non-retryable protocol errors,
and command replay refuses terminal rows without complete timestamps. Command
results retain provider `durationMs` and add acquisition and total wall clocks.

**Why:** Production QA reproduced successful first Terminal calls followed by
sub-second failures in the same run, one write card left `started` until its
five-minute run lease expired, and returned command durations that excluded
most participant-visible latency. The exact multi-step failure was a request-
context race: a heartbeat alarm joined the live run's drain promise and could
hold the alarm across the model/tool loop or make later I/O belong to the wrong
Durable Object event. Separate error boundaries then hid that cause and could
report an operation as failed after its SQLite transaction had committed.

**Considered and rejected:** Awaiting the active drain from every alarm,
returning immediately forever on a stranded in-isolate promise, returning an
alarm failure after commit, inferring rollback safety from an unvalidated
response, retrying or masking stale writes only in the desktop, exposing raw
SQLite reasons, and renaming provider
`durationMs`. Those choices respectively cross request contexts, invite a
permanent stall, invite a duplicate write, guess at safety, leave other readers
inconsistent, leak internals, or break the existing command-duration contract.

**Consequences:** The durable dispatch row, harness attempt lease, and re-armed
alarm—not a promise created by another event—remain the recovery owner. A
caller may repeat only a typed not-committed Terminal operation; receipt
failures retain conservative
write guidance; stale cards converge from receipt authority; and latency
consumers can distinguish provider work from acquisition and total wait. The
production matrix must still be rerun in both regions after deployment.

### 2026-08-21 — Terminal writes republish the directory deadline again

**What changed:** `/internal/terminal` runs each operation through
`commitRuntimeMutation` and then `scheduleNextAlarm`, the way
`/internal/runtime-sql` always did. Operations that cannot move a deadline —
reads, and the task, import, and publication writes — are exempted by name;
anything else, including anything added later, publishes.

**Why:** the typed port called its storage method directly, which committed the
row and told nobody. `workspace_workstream_directory.next_terminal_action_at`
is the only input `WorkspaceScheduler` has for Terminal work and the
`directory_common` effect is its only writer, so a sandbox could hold three
durable deadlines with nothing enqueued. The pre-cutover path published by
accident: `affectsDirectory` was a table-name regex naming
`workstream_sandboxes`, so every Terminal statement matched it. Removing that
vocabulary removed the publication with it, and the regex — which can no longer
match anything — is gone too. The sweeper's own transitions were the worst case:
stop, archive, and expire produced no other directory-affecting write, so the
chain stalled after whatever value was published last, and nothing ever cleared
a stale one.

**Considered and rejected:** treating every operation as directory-affecting.
Task settlement runs once per command, and republishing the whole directory row
plus a per-participant effect on that path is real parent work for a projection
that cannot have changed. The exemption list is explicit and the default falls
the other way, so a new operation over-publishes rather than stranding the
scheduler.

**Consequences:** an operation added to `WorkstreamTerminalStorage` publishes a
directory effect unless it is named in `NON_DIRECTORY_OPERATIONS`. Adding a name
there is a claim that the operation cannot change `terminal_workspace`, and it
is only checked by review.

### 2026-08-21 — Policy transitions keep their per-path lease semantics

**What changed:** `settlePolicyTransition` takes `clearOperationLease` instead
of always clearing the mutation lease.

**Why:** the five D1 statements it replaced were not uniform. The stop and the
two failure paths that lose the sandbox released the lease; the rollback and the
settle that only records the applied revision left it with its holder. Folding
them into one operation quietly made all five release it, which is a change to a
mutual-exclusion guard that nothing asked for.

**Considered and rejected:** keeping the uniform clear and documenting it. The
lease is what stops two runs mutating one workspace; changing when it drops
belongs in a change that argues for it, not in a refactor.

**Consequences:** each call site states its own answer, and the two that keep
the lease are the two that leave a sandbox a run may still be using.

### 2026-08-21 — Terminal addresses its own tables through a typed port

**What changed:** The Terminal services no longer hold a `D1Database`. A new
`WorkstreamTerminalStorage` inside the SubstreamAgent is the only reader and
writer of `terminal_workspace`, `terminal_tasks`,
`terminal_imported_resources`, `terminal_repository`,
`terminal_publication_grants`, and `repository_publications`; the services
reach it through `/internal/terminal` and a typed `TerminalObjectPort` whose
operation list is derived from the storage class. WorkstreamDO schema
migration 12 promotes the nine fields that lived in `lifecycle_json` to real
columns and drops the 32 `_runtime_terminal_*` compatibility view and trigger
statements. The dead pre-cutover branches in `workspace-scheduler.ts` and
`connection-service.ts` — which queried tables migration `0090` dropped — go
with them.

**Why:** The vocabulary the code used stopped describing what it did. A
statement reading `UPDATE workstream_sandboxes` named a table that had not
existed in D1 since the legacy product schema was retired; it was rewritten
onto a compatibility view whose INSTEAD OF triggers converted ISO-8601 to unix
milliseconds and packed nine fields into a JSON blob. That layer existed so one
body of code could run against both D1 and the object during the cutover, and
the cutover is over. Its remaining cost was real: `archive_due_at` — a deadline
the workspace scheduler sorts alarms by — had no type, no CHECK, and no index,
because it was a JSON key. Worse, a load-then-claim sequence crossed the Worker
boundary between its two statements, so the operation lease could be decided on
state that had already moved; the same sequence now runs inside one
synchronous object call.

**Considered and rejected:** Keeping the SQL and renaming only the handle. That
removes the misleading signature and nothing else — the blob, the timestamp
conversion, and the split transactions all survive. Also rejected: converting
the whole runtime compatibility vocabulary at once. `tool_invocations`,
`harness_runs`, `resources`, and `notes` are shared by every subsystem, so
retiring them is a change per subsystem rather than a wider version of this
one; `runtime.ts` still reached `tool_invocations` through the routed handle
and said so. (The 2026-08-22 entry above removed Terminal's last reader of
that table by handing the receipt id to the tool instead.)

**Consequences:** Two invariants the blob could not express are now enforced by
the table: a lease or a claim without its deadline is rejected, because an
unreleasable lease holds the workspace forever. `authority_epoch` is gone — the
compatibility triggers set it equal to `version` on every write and nothing
read it back. Terminal state is now reachable only with the agent binding, so
three helpers in `repository.ts` that took `Pick<Env, "DB">` take a full `Env`.
The Node suite keeps its real-SQL coverage through a local-storage seam on the
port; what the runtime decides belongs in `test-workers/`.

### 2026-08-21 — `terminal_commands` retired from the object schema

**What changed:** WorkstreamDO schema migration 11 drops `terminal_commands`.
`terminal_tasks` remains the sole durable record of a Terminal command.

**Why:** The table was created during the D1 retirement for per-command
receipts, but nothing ever wrote it — every field it declared (command hash,
timeout, status, exit code, settle time) is already carried by the durable task
row that the run-command path actually settles. Two plausible command
authorities in one schema is an invitation to write the wrong one.

**Considered and rejected:** Keeping it for a future split between "command"
and "task". Nothing has needed that split, and a table kept for a hypothesis
cannot be trusted to have the right columns when the hypothesis arrives.

**Consequences:** A per-command receipt distinct from the task is now an
explicit design change, not an empty table waiting to be filled.

### 2026-08-18 — Workspace Terminal policy moves into WorkspaceDO

**What changed:** Terminal network/egress policy, domains, verified revision,
and preview/confirm mutation history now live in WorkspaceDO. The main
SubstreamAgent continues to own sandbox generation, tasks, imported-resource
provenance, selected repository, grants, and publication receipts. Runtime
reads split those authorities explicitly; each bootstrap rechecks WorkspaceDO
connector state before reusing a child repository.

**Why:** Policy and connector/resource authority apply to every work stream in
one workspace, while sandbox execution receipts belong to one substream. D1 was
neither ownership boundary.

**Considered and rejected:** Copying policy into every SubstreamAgent,
broadcasting revocation to all children, and joining resource metadata to child
links in one compatibility SQL statement. Those choices create stale copies,
unbounded fan-out, or impossible cross-object transactions.

**Consequences:** Disabling a connector needs no fleet fan-out to all children:
the next bootstrap/use fails its WorkspaceDO check. The layered repository
adapter routes workspace and child reads to their separate objects, and R2
remains only the byte store.

### 2026-08-17 — Terminal persistence follows its work stream into the object

**What changed:** Sandbox generations, command/task receipts, imports,
repository selection, publication grants, and publication receipts are served
from the owning WorkstreamDO. Workspace network policy and connector credentials
remain regional D1 inputs.

**Why:** A Terminal lease and tool receipt participate in the same run and
authority fingerprint as the transcript. Leaving them writable in D1 after the
work-stream cutover would split one recovery transaction across authorities.

**Considered and rejected:** Keeping Terminal in D1 because Daytona is external.
The execution provider boundary does not change who owns Rally's run state.

**Consequences:** The workspace scheduler discovers only projected due work and
then claims the exact lifecycle transition in the object. Daytona remains the
sandbox provider.

### 2026-08-13 — Terminal lifecycle telemetry observes transitions, not tool reuse

**What changed:** Sandbox acquisition reports `start`, `restore`, or
`repository_replace` only when that acquire actually performs the corresponding
lifecycle transition. Reusing an already-running sandbox emits no lifecycle
event.

**Why:** Every Terminal command calls `acquire`. Treating the running fast path
as `start` multiplied adoption counts by ordinary tool usage.

**Considered and rejected:** Deduplicating downstream by sandbox ID. A later
real restore or replacement belongs to the same work stream and must remain
observable; transition truth is available only in the coordinator.

**Consequences:** Provider operation metrics and product lifecycle metrics retain
their distinct meanings. New acquire fast paths must explicitly decide whether
they performed a lifecycle transition before invoking the observer.
### 2026-08-13 — Git trusts Daytona's secret-substitution proxy CA

**What changed:** Repository bootstrap and the ephemeral trusted publisher now
map Daytona's `CURL_CA_BUNDLE` to Git's `GIT_SSL_CAINFO` before their first
authenticated remote operation. Bootstrap persists that mapping in the Terminal
session environment for later fetches and pushes. Both paths fail if Daytona
advertises a CA bundle that is not a readable, nonempty regular file. The
ephemeral publisher additionally requires Daytona to advertise the bundle
because its fresh home and `GIT_CONFIG_NOSYSTEM=1` deliberately leave no other
Git trust configuration to inherit. Executed Bash regressions prove that a
quoted CA path survives the session-file round trip and that an invalid path
stops both setup modes before the next operation.

**Why:** Live production testing proved that authenticated `curl` requests using
a mounted Daytona Secret succeeded while the identical Git request failed with
`unable to get local issuer certificate`. Daytona's secret-substitution path is
signed by its Netleash CA. The managed image configures curl to trust that CA,
but Git otherwise uses the system bundle and rejects it.

**Considered and rejected:** Disabling Git TLS verification, copying the GitHub
token into the sandbox, and hard-coding Daytona's current Netleash certificate
path. They respectively remove transport authentication, break the placeholder
secret boundary, or bind Rally to a provider-internal path when Daytona already
publishes the correct bundle through a process environment variable.

**Consequences:** Git retains full certificate verification while authenticated
clone, fetch, and push can traverse Daytona's host-scoped secret proxy. Managed
snapshot verification now requires the advertised bundle, and the Trusted-only
provider acceptance gate proves that Git accepts it with a real `ls-remote`.

### 2026-08-13 — Repository replacement joins the sandbox lease and lifecycle

**What changed:** Model-driven checkout now reserves and claims the same
work-stream operation lease used by every file, resource, and command tool
before it backs up or replaces state. A stopped or archived sandbox that is
started only for backup is restored to its prior lifecycle on failure. Repeating
checkout refreshes an advanced default-branch SHA while retaining the existing
`avalon/adjective-adjective-adjective-noun` head ref, and recoverable connector
statuses are revalidated rather than preemptively omitted. A requested
`read_only` level is stored as a credential ceiling, checkout receipts are
recoverable, backups carry local Git refs, initial bootstrap no longer pushes an
empty remote branch, and later branch restoration is repairable rather than a
Terminal-wide lockout.

**Why:** A command-table check did not cover file tools from another run; checkout
could delete their sandbox. Backup failure could also leave an archived sandbox
running and accruing cost, while an unchanged-identity shortcut made ordinary
default-branch advancement impossible to repair.

**Considered and rejected:** A second repository-only lock, polling active tasks
as the sole fence, and a new branch naming system. The existing sandbox lease and
existing work-stream word generator already express the required boundaries.

**Consequences:** Any future repository replacement path must hold the shared
operation lease through backup and the generation-fenced D1 update. Temporary
lifecycle changes require compensation, and a branch ref remains stable across
base refreshes and sandbox generations. Remote branch creation belongs to an
actual model push, and recovery archives must retain local commit history.

### 2026-08-13 — Standard Git and GitHub CLI replace a second publication gate

**What changed:** Full-access repository sandboxes now receive a short-lived,
single-repository write token through Daytona secret substitution. Rally
creates or restores a persisted `avalon/adjective-adjective-adjective-noun`
branch, switches to it before every model-facing operation, and lets the model
use normal `git push` and `gh pr` commands. Read-only credentials still enforce
remote immutability. Publication provenance no longer parses request prose or
limits a run to one update.

**Why:** Models are trained on standard Git and GitHub CLI workflows, and a PR
commonly receives several commits or updates. GitHub cannot scope an
installation token to one branch; emulating that with a proxy and a second
single-use authorization state machine would add complexity while fighting the
desired model behavior.

**Considered and rejected:** A smart-HTTP/API proxy, one token per push, and a
prose-derived single-publication grant. The connector's explicit read-only or
full-access policy is the authorization boundary. Future changes must preserve
automatic branch preparation and policy-triggered credential rotation, but must
not reintroduce a participant chooser or bespoke Git command surface.

**Consequences:** A full-access model credential is repository-scoped rather
than branch-scoped. The system prompt tells the model to push only the prepared
branch and target its base; repository rulesets remain an optional provider-side
backstop. Existing typed publication receipts remain available for convergence,
not as the only write route.

### 2026-08-13 — The model chooses repositories behind a recovery boundary

**What changed:** Terminal adds `checkout_repository` as its ninth tool. The
model chooses an exact authorized repository, sees whether its remote access is
read-only or full, and may always edit or commit locally. Before replacing a
different sandbox repository, Rally saves a verified attached recovery archive
and only then destroys the old sandbox. The participant transcript chooser was
removed; repository policy now lives in connector Settings.

**Why:** The chooser interrupted and eventually timed out runs even though the
model could search GitHub itself. Silent replacement was not acceptable either:
a model-selected repository change can invalidate the sandbox authority
fingerprint and otherwise discard untracked work.

**Considered and rejected:** Resuming through another participant elicitation,
keeping one repository forever, and permitting replacement after only a Git
diff. Those respectively preserve the interruption, prevent legitimate
cross-task work, or lose untracked source, databases, and generated artifacts.

**Consequences:** A repository switch may cost one bounded archive transfer and
a fresh sandbox generation. Checkout fails closed above 50 MiB compressed, so
large durable outputs should be published separately. Connector `read_only`
must never disable local mutation; it blocks only GitHub remote writes. Future
repository-selection paths must call the same policy and backup boundary rather
than writing selection rows directly. GitHub repository permissions are not a
substitute for the publisher's exact-ref checks because GitHub does not issue
branch-scoped installation tokens.

### 2026-08-13 — Worker-safe uploads and durable repository requests fix first use

**What changed:** Provider file and Git-bundle transfers now use Daytona's
bounded `uploadFile` API with a cross-runtime Buffer, reject cancellation before
the atomic target move, and have a disposable real-interface probe. Session
commands preserve Daytona's parent shell and normalize both `null` and omitted
in-progress exit codes before polling. The managed-image acceptance check uses
the promised passwordless `sudo` boundary for apt metadata. Tool deadlines
reserve two minutes for lazy sandbox acquisition in addition to their operation
budget. The transcript repository chooser now appears only for the latest run's
durable nested `repository_not_configured` failure, excludes HyperSight
background runs from that participant-facing latest-run fence, and lets only
that request identity trigger its one continuation. Repository selection and
continuation now share one server operation: the durable invocation identity
fences both message persistence and run admission, while an already-selected
matching repository and an already-persisted message are safe retry points.

**Why:** The first production `terminal_write_file` reached Daytona but timed
out after one minute because `uploadFileStream` throws in serverless runtimes.
Daytona also reports an accepted asynchronous command with `exitCode: null`, and
exiting its persistent session shell prevents a final status from being stored.
The renderer independently inferred that every repository-less Terminal work
stream needed GitHub, so a local Python request displayed an unrelated chooser.
Cold allocation also consumed the same deadline intended for the requested
operation.

**Considered and rejected:** Keeping the streaming API because Node-based
acceptance passed, showing repository selection proactively in the transcript,
and increasing only the write timeout. Those choices preserve the Worker/runtime
mismatch, conflate optional rail configuration with model-required input, or
leave every other cold-start tool vulnerable to the same budget error.

**Consequences:** Transfers buffer at most the existing 10 MiB file or 50 MiB
publication limit and work in Node and Workers. Manual rail selection does not
manufacture a participant message; a genuine repository request resumes with
its invocation UUID as the idempotency key. A lost response can retry without
destroying the selected sandbox, duplicating the message, or superseding a newer
run; a stale request returns `terminal_repository_request_stale`. The full
provider gate now includes file and asynchronous-session round-trip evidence,
while the lighter interface gate can run with only the standard Daytona
variables.

### 2026-08-13 — Terminal product adoption is separate from provider operations

**What changed:** Workspace lifecycle and network-policy mutations now emit
regional product events with bounded resource, result, repository-present,
connector, retention, policy, and active-sandbox dimensions. Canonical tool
admission/outcome continues through the harness telemetry path.

**Why:** Provider phase timings answer whether Daytona is healthy, but not whether
people start, restore, replace, or abandon Terminal workspaces or which policy
modes they adopt.

**Considered and rejected:** Reusing the Analytics Engine operations dataset as
product analytics, or adding repository names, remotes, domains, commands,
output, paths, and sandbox IDs. The former has no product identity/journey
contract; the latter exposes workspace content and infrastructure identifiers.

**Consequences:** Product and platform dashboards remain separate and can be
correlated only through bounded classes. Telemetry failure cannot alter a
provider transition, policy revision, or cleanup decision.
### 2026-08-13 — Provider acceptance stops before archive

**What changed:** The real-provider acceptance probe now performs the archive
transition as stop, archive, then start before checking the restored workspace.
Its restart-and-restore lifecycle order has a focused regression test.

**Why:** The probe restarted the sandbox to verify warm start and then attempted
to archive that running sandbox. Daytona requires a stopped sandbox before
archive, so a valid provider and snapshot failed the acceptance gate.

**Considered and rejected:** Making the provider silently stop on every archive
request. Lifecycle callers own state transitions, and hiding an extra provider
mutation would weaken their read-back and durable-state assumptions.

**Consequences:** The acceptance probe performs one additional stop operation
and now exercises the same explicit transition required by Daytona. Production
lifecycle behavior is unchanged.

### 2026-08-13 — Provider replay and durable receipts reject stale state

**What changed:** The command envelope now stops when its working directory or
session environment cannot be entered, and a named Daytona session is reused
only when its stored command exactly matches. Git bootstrap clears incomplete
clone staging and avoids duplicate excludes. Publication receipts are unique to
the tool invocation rather than overwritten by the next update to the same
branch. Imports refuse non-regular destinations, policy reconciliation uses
generation/provider guards, and complete command-log capture is capped at 5 MB.

**Why:** A stale provider session could return another operation's output, a
failed clone could wedge later starts, branch-target uniqueness erased earlier
audit receipts, and unguarded state updates could mutate a replacement sandbox.
The former 25 MB log cap also required several simultaneous Worker-sized copies
before Rally could publish the bounded resource.

**Considered and rejected:** Blindly adopting the only named-session command,
using the Git branch as the receipt key, writing through a resolved link, and
streaming an unbounded provider log through the request. None preserves the
exact operation or generation boundary that makes response-loss recovery safe.

**Consequences:** Exact response-loss retries remain recoverable; a changed
command recreates the provider session, each publication invocation retains its
own evidence, and noisy commands fail with a bounded generated log instead of
risking isolate exhaustion.

### 2026-08-13 — Daytona phase telemetry makes the image decision empirical

**What changed:** Provider create, compatibility bootstrap, manifest
verification, stopped warming, and archived restore now produce separate
content-free timing dimensions in the dedicated `avalon_terminal_operations`
Analytics Engine dataset. The managed bootstrap reports only the allowlisted
tool names it actually installed. `pnpm terminal:analytics` prints the observed
window, weighted latency percentiles, outcomes, installed gaps, and the sample
threshold for benchmarking a prebuilt image.

**Why:** One combined bootstrap timer could show that first use was slow but
could not distinguish Daytona allocation, policy read-back, missing-package
installation, or the verification Rally must retain with any image. That would
make an owned-image decision guess at both the removable latency and its sample
size.

**Considered and rejected:** Logging a single end-to-end number, persisting raw
provider output, adding tenant/run identifiers for joins, and immediately
maintaining a Rally image. They respectively cannot identify the improvable
phase, expand the content boundary, misuse sampled analytics as a ledger, or
commit maintenance before measuring a recurring cost.

**Consequences:** Each provider operation adds one non-blocking Analytics Engine
write and keeps Workers Logs as the exact diagnostic copy. The account-level
dataset has Cloudflare's sampling and three-month retention behavior and no
regional-jurisdiction guarantee. A custom snapshot is considered only after a
meaningful cohort shows installation—not unavoidable create or verification—is
the material tail-latency source.

### 2026-08-13 — Live Daytona verification hardens the managed default snapshot

**What changed:** Terminal now uses Daytona's managed `daytona-small` snapshot.
First creation idempotently creates the private workspace, installs only missing
SQLite/`gh`/pnpm/`tsx` capabilities through Trusted-only hosts, and executes the
full compatibility manifest. Provider HTTP calls have a bounded client deadline,
delete response loss is reconciled from observed absence, and the command
envelope uses a shell-neutral exit variable. The manifest also probes Git,
`gh`, and passwordless sudo.

**Why:** A live `daytona-small` probe proved provider policy read-back and
deletion, but also showed that the stock image has no `/workspace`, SQLite CLI,
pnpm, or `gh`; toolbox commands stay unprivileged even when sandbox creation asks
for root; and Daytona's default zsh treats `status` as read-only. Registry
inspection showed the full 0.9/0.10 images are roughly 6.9 GiB compressed, while
the separate slim image is much smaller.

**Considered and rejected:** Owning a custom snapshot based on Daytona's slim
image, a generic Node image, VM sandboxes, unconditional runtime installation on
every cold start, and trusting a requested sandbox user. They respectively make
Rally own refresh/activation compatibility, recreate Daytona conventions, buy
unused isolation features, slow every first use, or conflict with observed
toolbox identity.

**Consequences:** Rally accepts the managed snapshot's larger footprint in
exchange for Daytona's common, coordinated path. The bootstrap skips capabilities
Daytona already supplies and fails closed if a managed update breaks sudo,
workspace ownership, a promised runtime, or a manager fixture.

### 2026-08-13 — Review hardens recovery, authority, and fail-closed transitions

**What changed:** Sandbox creation now verifies Daytona's observed egress
policy; command observation is named, bounded, sanitized before persistence, and
recoverable after response loss; resource imports record intent before transfer
and verify existing bytes before reuse. Network-policy changes stop or quarantine
every current sandbox before committing the new revision without stamping a
late generation as verified. Expiry reconciles a lost delete response from
provider absence, and Bind preserves ambiguous command receipts for exact
reattachment. GitHub publication
revalidates the immutable repository ID, current work-stream participation, and
explicit non-negated intent. The desktop exposes recovery actions and canonical
workspace-domain changes while keeping the managed baseline internal,
repository replacement confirmation, transcript continuation, and live
lifecycle refresh.

**Why:** Adversarial review found places where requested provider state was
mistaken for observed state, a first failure could leave another sandbox running
under broader egress, ambiguous command outcomes invited duplicate execution,
and mutable repository names or stale participant grants could cross authority
boundaries. It also found UI paths that could discard retained files or strand a
blocked run without explaining how to recover.

**Considered and rejected:** Trusting Daytona create input as read-back,
stopping sandboxes only until the first provider failure, converting unknown
command results into ordinary failures, authorizing PR publication from keyword
proximity alone, and silently replacing a retained workspace. Each made a
provider or UI race look successful without proving the corresponding security
or durability invariant.

**Consequences:** Provider activation requires real read-back and redirect/private
network probes. Policy mutations may quarantine or delete a sandbox that cannot
be stopped safely, but never commit an unverified revision. Exact command replay
reattaches to the same named session; changed calls stop on ambiguity. Repository
replacement is explicit, preserves a final diff where possible, and resumes the
requesting work stream once.

### 2026-08-13 — Resource paths and first-use policy are verified at the boundary

**What changed:** Automatic imports now write to the exact path already checked
for root/symlink containment. Generated resources resolve beneath
`AVALON_RESOURCE_DIR`, must be non-empty stable regular files, and are checked by
size and SHA-256 before and after transfer. The snapshot probe requires both
host-owned working directories, and first sandbox creation compares Daytona's
reported allow-list with the compiled workspace policy before use.

**Why:** Deriving a title-based sibling after containment validation checked the
wrong import path; repository-relative publication bypassed the promised output
directory; and accepting an unverified create response could make Trusted only
a UI claim rather than an enforced provider fact.

**Considered and rejected:** Trusting snapshot convention, resource titles, or
the create request as evidence. Each is an input or intention, not observed
state at the boundary where bytes or network access are granted.

**Consequences:** Snapshot activation fails until `.rally/tmp` and
`.rally-output` exist. Publication performs two bounded file inspections, and a
create-policy mismatch discards the sandbox and leaves durable failed state.

### 2026-08-13 — Named command sessions close the Worker response-loss window

**What changed:** Terminal retains each stable Daytona command session until its
terminal result is durable. A matching incomplete Bind receipt can re-enter the
frozen `run_command` executor, verify the task's sandbox generation and command
hash, and observe that session's sole command before returning one final result.

**Why:** A Worker can disappear after Daytona accepted or finished a command but
before the tool receipt is complete. Treating that as an ordinary ambiguous
write would strand the agent; deleting the session before D1 terminalization
would also remove the evidence needed to prove whether replay is safe.

**Considered and rejected:** A second Terminal-command Workflow, continuation
table, WebSocket event pipeline, and model-facing poll protocol. The existing
harness Workflow retry plus Daytona's stable named session provides the required
recovery boundary with less orchestration state.

**Consequences:** Bind may re-enter only `run_command` and the convergent
`publish_branch_and_pr` operation after an exact matching incomplete receipt.
Any generation, input, canonical-policy, session, repository, ref, or grant
ambiguity still fails closed, and provider-session cleanup happens only after D1
records a terminal result.

### 2026-08-13 — Terminal adds lazy, authority-fenced Daytona workspaces

**What changed:** Rally gains a deferred eight-tool Terminal plugin backed by
one private Daytona sandbox per work stream, workspace egress policy, generated
resource exchange, read-only GitHub bootstrap, one trusted pull-request
publisher, participant-visible state, and scheduled stop/archive/expiry.

**Why:** General work-stream agents often need trained CLI/code behavior for
calculation, transformation, artifact creation, repository inspection, and
small edits. Reimplementing every CLI as a custom tool would make the surface
less familiar to models, while handing a sandbox broad credentials or exposing
its control plane would make that convenience an authority escalation.

**Considered and rejected:** A user-visible/PTY coding harness; Cloudflare
Dynamic Workers as the only execution substrate; one sandbox per command; a cold
filesystem copy in R2; CIDR/proxy egress; model-facing revisions, polling,
directory listing, or lifecycle tools; and GitHub write credentials inside the
work-stream sandbox. Each either expands product scope, duplicates trained shell
behavior, costs more state churn, or weakens the authorization boundary.

**Consequences:** A region is truthfully unavailable until its real Daytona
acceptance probe passes. Future runtimes/managers require a prompt update, a
snapshot-manifest probe, and provider acceptance together. Any new Terminal tool
must retain the documented argument/output/error contract and authority fence.

Shipped in the pull request for this change. Design:
[`docs/PRDs/2026-08-12_daytona-terminal-git-github/prd.md`](PRDs/2026-08-12_daytona-terminal-git-github/prd.md).
