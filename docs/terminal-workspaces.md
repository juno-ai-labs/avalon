# Terminal workspaces

Terminal is Avalon's deferred Bind plugin for bounded code execution, file
mutation, resource exchange, and one authorized GitHub pull request. It gives a
work stream one private Daytona sandbox without turning Avalon into an
interactive coding harness: the model receives eight typed tools, not a PTY or a
provider API, and a sandbox is allocated only when one of those tools executes.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/terminal/contract.ts` | Canonical plugin prompt, eight tool descriptors and strict argument schemas, and regional configuration contract. |
| `apps/api/src/services/terminal/plugin.ts` | Regional composition boundary and allocation-free deferred plugin registration. |
| `apps/api/src/services/terminal/coordinator.ts` | One-sandbox-per-work-stream acquisition, authority fencing, exclusive mutation leases, and recovery after ambiguous provider calls. |
| `apps/api/src/services/terminal/daytona-provider.ts` | The only Daytona SDK adapter: private sandbox, process, file, network, lifecycle, and host-scoped secret primitives. |
| `apps/api/src/services/terminal/tools.ts`, `runtime.ts` | Model-facing behavior, safe paths, bounded file/patch/command execution, durable command tasks, and self-healing failures. |
| `apps/api/src/services/terminal/resource-bridge.ts` | Authorized regional R2 import and generated-resource publication. |
| `apps/api/src/services/terminal/repository.ts`, `workstream-state.ts` | GitHub App repository selection/read bootstrap, participant-intent grant, isolated trusted publisher, and work-stream state API. |
| `apps/api/src/services/terminal/network-policy.ts`, `settings.ts` | Trusted-only policy compiler and preview/confirm workspace settings transition. |
| `apps/api/src/services/terminal/lifecycle.ts`, `apps/api/src/durable-objects/workspace-scheduler.ts` | Stop, archive, expiry, final-diff preservation, claims, retries, and alarms. |
| `apps/api/src/services/terminal/snapshot-manifest.ts`, `apps/api/scripts/verify-terminal-provider.ts` | Executable snapshot contract and real-provider acceptance probe. |
| `apps/api/src/observability/terminal-platform-observability.ts`, `scripts/report-terminal-analytics.mjs` | Content-free Daytona phase measurements in Analytics Engine and their human-readable decision report. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx`, `components/inspector-rail.tsx` | Workspace network controls and participant-visible work-stream state/repository selection. |
| `packages/db/migrations/0075_terminal_workspaces.sql` | Authoritative regional Terminal schema. |

## How it works

### Loading and allocation

`avalon:terminal` is a built-in deferred plugin. Bind can discover and load it,
which exposes all eight tools and the language guidance but performs no provider
operation. The first tool execution asks `TerminalSandboxCoordinator` for the
work stream's exclusive Terminal mutation lease. It creates, starts, or restores
the stable private sandbox and records the provider result in D1. A later tool in
the same work stream reuses that generation only while its execution-principal,
selected repository, connection, and visible-resource authority fingerprint
still match.

Avalon uses Daytona's managed `daytona-small` container snapshot. On first
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
`run_command`. File paths are workspace-relative and validated both before the
provider call and inside the sandbox. `ls`, `find`, and `rg` through
`run_command` own discovery; there is deliberately no `list_files` tool.
Model-facing revisions are also absent. Exact-match edits and context-bearing
patches provide useful drift detection without forcing a medium model to manage
content versions, while the coordinator keeps exclusive mutation locking and
internal hashes.

Commands are non-interactive foreground Bash. The provider runs each command in
a named process session under GNU `timeout`, sends TERM at the deadline, sends
KILL five seconds later, and retains the named session until the terminal D1
result is durable. It then deletes the session; if deletion fails it stops the
sandbox. After a Worker interruption, Bind re-enters only an exact incomplete
Terminal command receipt, verifies the command hash and sandbox generation, and
reattaches to the sole command in that session. All other incomplete writes keep
the harness's fail-closed ambiguity behavior. The model receives one final
result; provider observation is never a tool. D1 stores the task, command hash,
deadline, exit, termination reason, output byte counts, and bounded head/tail.
Output beyond the inline allowance is also published as a generated log
resource, capped at 25 MB.

### Resources

`import_resource` copies the original bytes of one currently authorized
work-stream resource from regional R2 into the sandbox. With no destination it
uses deterministic placement beneath `.avalon/resources/`; an explicit
destination is create-only unless `overwrite` is true. The sandbox never
receives R2 credentials or a signed R2 URL.

`publish_resource` copies one stable nonempty regular file beneath
`AVALON_RESOURCE_DIR` into regional R2, creates a normal generated `resources`
row, attaches it to the work stream, and uses the existing cleanup outbox. The
published bytes do not enter model context. The resource inventory and existing
attachment tools become the durable participant/model surface.

### Git and GitHub

A participant selects exactly one repository from a healthy regional GitHub App
installation. Avalon records the immutable GitHub repository ID, exact full
name, default branch, base SHA, fixed `avalon/<workstream-id>` head ref, and
connection. The next sandbox generation receives a one-hour read-only
installation token through Daytona host-scoped secret placeholders for
`github.com` and `api.github.com`; the token is not stored in D1 or written into
Git configuration. The model may use local `git` and read-only `gh` through
`run_command`.

Remote writes are different. `run_command` rejects obvious `git push` and
mutating `gh` forms. A current participant's explicit request to publish a pull
request creates a single-use, run/repository/ref-bound grant. The
`publish_branch_and_pr` tool verifies a clean committed fixed branch, base
ancestry, limits, and forbidden workflow-file changes; creates a Git bundle;
then hands the bundle to a fresh isolated publisher sandbox with a fresh
narrowed GitHub App credential. The host converges on one fixed branch and one
open pull request and records enough state to reconcile an ambiguous provider
outcome.

### Network policy and lifecycle

Every workspace chooses Trusted only or Full internet. Trusted only compiles an
internal immutable baseline for Avalon/GitHub, Debian packages, Python packages,
and JavaScript packages plus up to the remainder of Daytona's 20 exact/wildcard
domain targets. Settings shows only workspace-approved domains; the managed
baseline is not a participant-facing policy surface. Full internet clears
`domainAllowList`. Schemes, ports, paths, IP addresses, CIDR, public suffixes,
and private names are rejected. An admin previews canonical workspace-domain
changes and affected sandboxes against a revision, then confirms. Avalon cancels
active tasks, preserves a final diff, stops each
affected sandbox, applies and reads back the provider policy, and does not
auto-restart it.

The workspace scheduler stops an idle running sandbox after five minutes,
archives it after sixty minutes, and deletes it after thirty days. Daytona's
15-minute auto-stop is only a provider backstop. Due transitions use a short D1
claim and reconcile observed provider state after ambiguous calls. Before stop
or deletion Avalon saves a bounded Git diff (or a summary when the diff is too
large) as a generated resource. Filesystem archives are not copied to R2; after
expiry a participant explicitly starts fresh and the next tool gets a new root.

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
- **The sandbox has read credentials only; GitHub writes cross the trusted
  publisher.** A reusable write token in model-controlled code would let prompt
  injection bypass repository/ref/grant constraints.
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
installation and webhook boundary. `WorkspaceScheduler` owns alarm serialization,
while Terminal supplies only its due-row projection and transition reconciler.

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

## Testing

The focused API suites are `apps/api/test/terminal-*.test.ts`; they use injected
Daytona, GitHub, R2, clock, and D1 fakes and never require network access. The
migration contract is in `packages/db/test/migrations.test.ts`. Renderer states
are covered by `workspace-settings.test.tsx` and `inspector-rail.test.tsx`.
Run the API set with:

```text
pnpm --filter @avalon/api exec vitest run terminal-
```

`pnpm --filter @avalon/api terminal:verify-provider-interface` is the disposable
real-provider smoke gate that needs only the normal supported Daytona variables.
It verifies create/read-back, managed bootstrap, a binary buffered upload and
download, command sessions, stop/restart, stop/archive/restore, policy update
read-back, persistence across every transition, deletion, and observed absence.
The buffered upload deliberately exercises `uploadFile`; Daytona's
`uploadFileStream` is unavailable in Cloudflare Workers and must not be used by
the provider. This smoke gate does not prove network escape resistance.

`pnpm --filter @avalon/api terminal:verify-provider` is the destructive,
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

Migration `0075_terminal_workspaces.sql` adds:

- `workspace_sandbox_network_policies`, `_domains`, and `_mutations` for the
  revisioned preview/confirm/read-back protocol;
- `workstream_sandboxes` for generation, authority, provider, lease, lifecycle,
  retention, and final-diff state;
- `sandbox_tasks` for durable command submission and one final result;
- `sandbox_imported_resources` for generation-scoped deterministic imports;
- `workstream_terminal_repositories` for the exact GitHub repository and refs;
- `terminal_publication_grants` for participant intent; and
- `repository_publications` for convergent trusted-write reconciliation.

Every tenant-owned primary key and lookup starts with `workspace_id`; database
triggers verify that work streams and GitHub connections belong to that same
workspace. Provider IDs are reconciliation facts and never authorize a request.

## Regional impact

All Terminal D1 rows, resource bytes, generated logs/diffs, GitHub App
installation-token creation, and tool execution records stay in the workspace's
owning Avalon region. Daytona processes the sandbox filesystem in the configured
regional target and is therefore a regional subprocessor boundary, not a
cross-region Avalon bridge. Global and EU advertise capability independently;
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
narrower: it contains operation, outcome, Avalon region, configured snapshot,
source lifecycle state, failed phase, release identity, phase durations, and the
fixed names of compatibility tools installed. It contains no workspace,
work-stream, run, user, provider-sandbox, command, path, resource, repository, or
credential identifier. It is sampled aggregate telemetry, never authority or a
recovery ledger.

## Operations

See [`runbook.md`](runbook.md#terminal-provider-activation-and-recovery) for
activation and recovery. Structured events are
`terminal_tool_finished`, `terminal_sandbox_lifecycle_transition`, and
`terminal_sandbox_lifecycle_failed`, plus
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

Allocation is lazy and reuse is scoped to one work stream. Five-minute warm stop
reduces compute time, sixty-minute archive reduces retained live-disk cost, and
thirty-day deletion bounds provider storage. Only user-visible generated files,
complete eligible command logs, and the last bounded Git diff are copied to R2;
Avalon does not pay to maintain a second cold filesystem archive. Provider time
and output bytes are derivable from `workstream_sandboxes` and `sandbox_tasks`,
so cost changes can be measured without exposing commands.

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
before Avalon could publish the bounded resource.

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
installation, or the verification Avalon must retain with any image. That would
make an owned-image decision guess at both the removable latency and its sample
size.

**Considered and rejected:** Logging a single end-to-end number, persisting raw
provider output, adding tenant/run identifiers for joins, and immediately
maintaining an Avalon image. They respectively cannot identify the improvable
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
Avalon own refresh/activation compatibility, recreate Daytona conventions, buy
unused isolation features, slow every first use, or conflict with observed
toolbox identity.

**Consequences:** Avalon accepts the managed snapshot's larger footprint in
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

**Consequences:** Snapshot activation fails until `.avalon/tmp` and
`.avalon-output` exist. Publication performs two bounded file inspections, and a
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

**What changed:** Avalon gains a deferred eight-tool Terminal plugin backed by
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
