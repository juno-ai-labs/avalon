# Terminal workspaces

Terminal is Rally's deferred Bind plugin for bounded code execution, file
mutation, resource exchange, and GitHub repository work. It gives a
Thread, Breakout or Sidekick one private Daytona sandbox. A Sidekick shares
its sandbox with its wizard, activations and background agents; ordinary
conversations share theirs with the background agents they start. It is not an
interactive coding harness: the model receives ten typed tools, not a PTY or a provider API, and a
sandbox is allocated only when one of those tools executes.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/terminal/contract.ts` | Canonical plugin prompt, ten tool descriptors and strict argument schemas, and regional configuration contract. |
| `apps/api/src/services/terminal/plugin.ts` | Regional composition boundary and allocation-free deferred plugin registration. |
| `apps/api/src/services/terminal/authority.ts` | Resolves the sandbox owner once at plugin composition: the Sidekick's wizard, or an ordinary conversation and its background agents. |
| `apps/api/src/services/terminal/coordinator.ts` | Shared-sandbox acquisition, authority fencing, exclusive mutation leases — including a lease held by a run in another conversation — and recovery after ambiguous provider calls. |
| `apps/api/src/services/terminal/daytona-provider.ts` | The only Daytona SDK adapter: private sandbox, process, file, network, lifecycle, and host-scoped secret primitives. |
| `apps/api/src/services/terminal/tools.ts`, `runtime.ts` | Model-facing behavior, safe paths, bounded file/patch/command execution, durable command tasks, and self-healing failures. |
| `apps/api/src/services/terminal/patch-format.ts`, `vendor/apply_patch.py` | The two patch texts `apply_patch` reads: the unified-diff and `*** Begin Patch` parsers that validate paths and shape the result, and OpenAI's reference applier for the second, vendored unmodified (MIT; provenance in `vendor/README.md`) and written into the sandbox beside a patch that needs it. |
| `apps/api/src/services/terminal/resource-bridge.ts` | Authorized regional R2 import and generated-resource publication. |
| `apps/api/src/services/terminal/instruction-files.ts`, `instructions.ts` | Discovery of a checkout's own `AGENTS.md` files: the candidate chain, the probe a sandbox command carries, and the glue that records what it found in the context-residency ledger ([`resident-context.md`](resident-context.md)). |
| `apps/api/src/services/terminal/repository.ts`, `repository-selection.ts`, `workstream-state.ts` | Model-driven GitHub App repository selection, recovery backup, scoped credential bootstrap, prepared work-stream branch, optional typed publisher, and work-stream state API. |
| `apps/api/src/services/terminal/network-policy.ts`, `settings.ts` | Trusted-only policy compiler and preview/confirm workspace settings transition. |
| `apps/api/src/services/terminal/lifecycle.ts`, `apps/api/src/services/workspace-schedule-execution.ts` | Stop, archive, expiry, final-diff preservation, claims, retries, and the `terminal` alarm target WorkspaceDO drains. |
| `apps/api/src/services/terminal/snapshot-manifest.ts`, `apps/api/scripts/verify-terminal-provider.ts` | Executable snapshot contract and real-provider acceptance probe. |
| `apps/api/scripts/build-terminal-snapshot.ts`, `terminal-snapshot-acceptance.ts` | Builds the Rally-owned snapshot by baking the runtime bootstrap into the image, so the four managed capabilities are preinstalled rather than installed per sandbox, and refuses one Daytona built smaller than requested. Does not adopt it; the acceptance probe above is still the gate. |
| `apps/api/src/services/terminal/snapshot-manifest.ts` (`TERMINAL_SNAPSHOT_RESOURCES`) | The one source of how large every Terminal sandbox is. Checked in rather than configured, because the weekly rebuild builds from the repository — read the Operations section before moving it to a GitHub variable. |
| `.github/workflows/rebuild-terminal-snapshot.yml` | The weekly rebuild that bounds how stale an owned snapshot may become against Daytona's managed base, proves each rebuild with the acceptance probe, and pushes the config bump to main. Owning a snapshot is only safe with this running. |
| `apps/api/src/observability/terminal-platform-observability.ts`, `scripts/report-terminal-analytics.mjs` | Content-free Daytona phase measurements in Analytics Engine and their human-readable decision report. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx`, `components/inspector-rail.tsx` | Workspace network and GitHub connector policy controls plus participant-visible work-stream state. The network policy is the whole of the **Security** page, a top-level entry in the settings navigation. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Authoritative per-work-stream Terminal tables. Migration `0075_terminal_workspaces.sql` is the frozen pre-cutover D1 source. |
| `apps/api/src/durable-objects/workstream-terminal-storage.ts`, `workstream-terminal-protocol.ts` | The only reader and writer of those tables, and the operation contract derived from it. |
| `apps/api/src/services/terminal/object-port.ts` | The Worker-side handle every Terminal service holds instead of a database. |

### Loading and allocation

`rally:terminal` is a built-in deferred plugin. Bind can discover it without
any provider operation. An explicit load exposes all ten tools and the language
guidance and starts the sandbox acquisition in the background: activation
registers the shared per-run acquisition promise and returns without holding
the model, so the sandbox is built while the model does work that needs no
sandbox. The first Terminal tool awaits that same promise, collecting the work
in flight rather than starting it, and it — not activation — is where a
provider failure reaches the model, with the coordinator's own guidance. The
acquisition asks `TerminalSandboxCoordinator` for the conversation's exclusive
Terminal mutation lease. It creates, starts, or restores the stable private
sandbox and records the provider result in the owning SubstreamAgent. That
successful acquisition, authority/policy decision, and
repository preparation are reused for later tools in the same harness run.

Which conversation owns the sandbox is decided once, when the plugin is
composed (`authority.ts`), and bound into the Terminal port factory. Ordinary
conversations have their own sandboxes. A Sidekick's wizard (substream `0`),
activations, and background agents all use the sandbox owned by that Sidekick's
wizard. Each activation retains its own transcript, execution records and direct
attachments, plus resources visible to its execution user in the
Sidekick's home and explicitly attached conversations. Sharing files does not
copy conversation context.
Different Sidekicks and the Thread that requested one remain separate.

A work-stream background agent uses the sandbox of the conversation that
started it, through further delegation to the first conversation nobody
delegated. Each shared caller records its actual execution conversation on its
mutation lease. That lets the sandbox owner check the holder's liveness in the
correct object. Overlapping tool mutations contend for the existing lease;
sharing a sandbox does not make a whole multi-tool workflow atomic.
The plugin loads Sidekick delegation with its tool inventory and reuses that
snapshot for preparation and tool calls, including cached reads. Continuations
and later runs rebuild the inventory; a stale snapshot may finish work. Only eligible delegates can
use its files; management rights alone do not grant Terminal access. The
Sidekick retains a stable file identity across coordinating users, using its
preserved legacy account identity (or creator for a new Sidekick) to keep
existing sandbox fingerprints compatible. This identifier confers no execution
authority. Completed imports remain shared Sidekick state after a delegate
withdraws or loses source access; every new import still checks current access.
Ordinary conversations retain their principal and import-visibility fences.
A primary run may replace a changed repository; a background agent cannot
destroy its owner's workspace and must wait for a primary run.
Files may need recovery after a permission reset, provider loss or expiry, so
saved refresh instructions retain the published resource and import paths.
The main conversation's Daytona name keeps the derivation every deployed
sandbox was created under; any other sandbox owner folds its substream in.

The lease is held for one tool call, not one run. Readiness — creating,
starting or restoring the sandbox under the run's authority and policy, and
preparing its repository — is paid once per run and cached; each write tool
then claims the lease, does its provider work, and releases it when the call
ends, whether it returned or threw. A release that fails is attempted once
more and, failing again, logged as `terminal_lease_release_failed` with its
reason; the lease then stays with the run until its next call releases it,
the run yields, or the lease deadline passes. A claim that finds the row no longer
describing the cached sandbox (the generation replaced, the sandbox stopped by
the sweep or a policy change) runs readiness again under the lease. So a
conversation and the agents it starts interleave at call granularity: a
sibling's `sandbox_busy` is a wait of seconds, for the length of one call or
one command, and the model is told to retry rather than to wait for a run.
The reads, `read_file` and `view_image`, take no lease at all: it needs the sandbox running and the
authority fingerprint to be this caller's, both read from the row, and it
neither waits on another run's call nor blocks one. The bargain is that a read
can observe a file another run is mid-way through writing. A run whose command
lost observation keeps its lease past the release, because the retained task is
resolved either by that run reattaching on its retry or by a successor's
recovery, and both are keyed to the holder.
Repository checkout explicitly invalidates the run-local acquisition because it
can replace the sandbox generation; a later tool then acquires and prepares the
replacement once. A new harness run performs its own acquisition.

Within one run the harness may run a turn's tool calls in parallel, and the
lease is re-entrant for a run, so the runtime gives a run's write calls turns:
each write waits for the previous write of the same run to end, in process,
since every call of a run executes in the one isolate that holds the runtime.
A read takes no turn. An edit replaces only the bytes it read: `edit_file`
reads without the lease, and its write carries the digest of what it read,
which the replacement checks in the sandbox before moving the new bytes into
place and answers `file_changed` when another call wrote in between. A read
joins this run's own readiness before it looks at the row, because the row is
marked running before the checkout is prepared, and it takes the sandbox from
the row only when the checks readiness makes also hold, the authority
fingerprint, no revoked import, and a selected repository bootstrapped into
this generation; otherwise it goes through readiness like a write.

Rally creates sandboxes from its own `rally-terminal-1` snapshot: Daytona's
managed `daytonaio/sandbox:0.10.0` base with SQLite, `gh`, pnpm, and `tsx`
preinstalled by `terminal:build-snapshot`, plus Playwright with its Chromium
under `/opt/rally/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`), which the
acceptance gate requires rather than a per-sandbox probe (the changelog entry
of 2026-10-15 says why). On first creation an idempotent
compatibility bootstrap creates the owned `/workspace`, installs only missing
SQLite/`gh`/pnpm/`tsx` capabilities through the compiled Trusted-only apt/npm
hosts — a no-op against the owned snapshot — and then executes the complete
manifest. That manifest probes Bash, Python, JavaScript/Node.js, TypeScript,
SQLite, apt/dpkg, pip/uv, npm/pnpm, Git, `gh`, and passwordless sudo. Daytona's
base-image updates reach the snapshot only through the weekly rebuild described
under Operations; a breaking update fails creation closed at the manifest. The plugin prompt tells the model to use those languages when code is
the clearest way to calculate, transform data, analyze files, validate a
repository, or create a graph, image, dataset, report, or archive. It tells the
model not to install another runtime or manager.

### Files and commands

The model receives `read_file`, `view_image`, `edit_file`, `write_file`,
`apply_patch`, and `run_command`. `view_image` reads a PNG, JPEG, GIF, WebP,
TIFF or HEIF through the contained whole-file read an `edit_file` starts with,
and returns the picture to the model for that turn only, normalized by the
attachment image pipeline (`normalizeModelImageBytes`): scaled by the region's
Images binding to the model's edge limit and refused past its byte limit. A
chart or a Playwright screenshot can then be checked by looking at it. A file it
cannot deliver is refused with `not_an_image`, `image_too_large` or
`image_not_convertible`. The picture is not kept in the tool receipt, so a
replayed `view_image` reads the file again rather than returning a success with
nothing to see. File paths are relative to the workspace root, `/workspace`,
which `cwd` may name as `.` or leave out; `publish_resource` alone resolves its
path against `$AVALON_RESOURCE_DIR` (`/workspace/.rally-output`). Path syntax
is validated before provider I/O, and a refusal echoes the value it refused,
names the root the parameter is relative to, and gives the accepted form. For reads, writes, and generated publication, symlink/root
containment is checked inside the same sandbox command that inspects or replaces
the requested file, instead of by a separate provider command immediately
before it. `ls`, `find`, and `rg` through
`run_command` own discovery; there is deliberately no `list_files` tool.
Model-facing revisions are also absent. Exact-match edits and context-bearing
patches provide useful drift detection without forcing a medium model to manage
content versions, while the coordinator keeps exclusive mutation locking and
internal hashes.

`apply_patch` reads two formats, and the first non-blank line decides. A
unified diff is applied by `git apply` after a dry run. A patch that opens
with `*** Begin Patch` is the format OpenAI's models emit for a tool of this
name: `*** Add File:`, `*** Update File:` (optionally followed by
`*** Move to:`) and `*** Delete File:` sections whose hunks carry no line
numbers and are placed by their context lines, with whitespace tolerance. That
one is applied by OpenAI's reference implementation, vendored unmodified under
`services/terminal/vendor/` and written into the sandbox beside the patch for
that call. Every path the patch names passes the rules every `filePath` gets
before any provider I/O, and is contained in its own right before the applier
runs, because the applier follows symlinks. A path an `*** Add File:` or
`*** Move to:` section would create is refused if it already exists, because
the applier would truncate it and report success; `git apply` refuses the same
collision in a unified diff. The applier needs `pydantic`, pinned as
`TERMINAL_PYDANTIC_REQUIREMENT` in `snapshot-manifest.ts` and baked into the
Rally-owned snapshot under `/opt/rally/pylib` by the same bootstrap that
installs `pnpm` and `tsx`. A sandbox whose snapshot predates that installs the
same pin from PyPI, which the trusted-only baseline permits, into
`/workspace/.rally/pylib`, staged and moved into place so a killed install never
leaves a directory that imports and then fails; a sandbox that cannot refuses
with `patch_tooling_unavailable` carrying pip's last line. On success the
applier's whole output is `Done!`; anything else, a non-zero exit, or a timeout
is reported with the applier's own line rather than a blank.

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
the generation.

Transient failures reading a named session, polling its command, or collecting
its logs retry within the existing command observation budget (command timeout
plus 15 seconds), with the existing 250 ms to 2 second backoff. A cancellable
timer bounds each read by the remaining budget and is disposed afterward. The
SDK exposes no per-read abort option, so deadline expiry abandons only the
read-only observation; submission is never raced against that timer. Only a session
lookup's 404 permits session creation. Other client refusals (except 408/429)
fail immediately. A failed log stream discards that attempt's partial prefix
before retrying, so the final output cannot duplicate it. Submission itself is
never retried by this read-recovery loop; persistent uncertainty still retains
the durable task and fails closed.

Three other Terminal writes are re-enterable after an interruption, and each
earns it differently. `publish_branch_and_pr` reattaches to the publication its
run recorded. `checkout_repository` converges: it never reads the effect
identity, and re-entry re-selects the same repository at the same access, so an
interrupted replacement is repaired by finishing it. `publish_resource` can do
neither — it resolves a document by `(work stream, published path)`, which says
what is published there now rather than what this attempt published — so it
carries a `reconcileEffect` that reads the `resource_versions` ledger, and the
host runs the executor only when that ledger proves the attempt is absent. Every
remaining incomplete write keeps the harness's fail-closed ambiguity behaviour.
[`agent-harness.md`](agent-harness.md) owns the repair walk itself. The model receives one final result; provider observation is never a
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
operation in the already-authorized full-access work-stream sandbox as well.

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
attachment tools become the durable participant/model surface, and the desktop
rail renders supported text and Markdown publications through the resource
preview route.

A published file's identity is the document's own coordinates — the work stream
and the normalized published path, as `terminal:<workstream-id>:<path>` — so
publishing the same path again updates the resource the first publish created
instead of minting a sibling, and the same file name published from another work
stream stays a different document. For a work-stream-scoped Sidekick the work
stream in that identity is the **room that owns it**, not the automation's own
conversation: its run executes under the automation, using the Sidekick's shared
sandbox and its own transcript, but the documents it publishes are the room's, so "refresh the
dashboard" lands on the dashboard the room already has. The sandbox belongs to the Sidekick's authoring
conversation. Its wizard, activations and workers resolve and re-admit the
home at each publication or recovery lookup. A refused home blocks publication,
not commands or imports. Main retains `terminal:<thread>:<path>` identities;
a Breakout uses `terminal:<thread>:substream:<breakout>:<path>` for files,
sites and reconciliation. Existing publications must be attached to that
destination before reuse, except when repairing the exact receipt that created
them before its attachment committed. If the home has no publication at the
path, a visible legacy wizard publication under the Sidekick ID is updated in
place, preserving its resource ID and URL, including during recovery.

Imports use the [shared live resource scope](agent-attachments.md#authorized-work-stream-discovery-and-text-hydration),
also rechecked for import revocation; a publication target grants no read access.
A Sidekick can import any known resource its execution user can read through
canonical authorization, without attaching it first. Later sandbox acquisition
rechecks that access, so an authorized unattached import stays usable and a
revoked grant cannot be kept alive by retained files. This expands reads only;
publication still follows the destination and identity rules above.
A known site ID missing from a list should
still be tried with `import_resource`. The site skill
backs up existing files and imports the current publication before each refresh
so retained files cannot silently overwrite newer layout edits. Resource links
and the artifact registry follow the publication identity, so the document appears in the owning room's
resource list rather than the automation's. An equal content hash returns the existing
resource untouched, which covers both a crash-replay of a settled call and a
republish that changed nothing; a different hash swaps the content in place
under a compare-and-swap against the pointer that was read, applying a title
only when the call supplies one. WorkspaceDO's resource versions retain the
superseded original, so a revision does not destroy its predecessor, and the
swap names the run that published it — author kind `agent`, cause `created` on
the publish that mints the document and `published` on each revision of it — so
the history a participant reads says which run wrote each state rather than
only when it appeared. Publications
recorded under the earlier per-call identity keep it, and a path-identity miss
falls back to looking that identity up, so an attempt that already published a
file cannot publish it twice across the change. A receipt is still required
before any bytes reach R2.

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
existing workspace remains untouched. That resource is attached to the work
stream but **unlisted**: the checkout receipt's `backup.resourceId` still opens
and imports it, while the artifacts rail and the model's inventory keep showing
what the work produced rather than a compressed copy of the workspace it
replaced. `agent-attachments.md` owns the flag; a preserved final diff is the
work's own output and stays listed.

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

A Sidekick's shell retains its selected repository connection, without
cross-account shell retry. Repository bootstrap and the typed publisher check
that a personal connection's owner is in the inventory's eligible delegation
snapshot. An unavailable owner does not block local files. Existing mounted
credentials follow their ordinary lifecycle; delegation does not add an unmount
protocol or a scan before every shell command.

### Network policy and lifecycle

Every workspace chooses Trusted only or Full internet. Trusted only compiles an
internal immutable baseline for Rally/GitHub, Debian packages, Python packages,
JavaScript packages, and Rally sites with Playwright's browser downloads
(`*.rallyusercontent.com`, `cdn.playwright.dev`,
`playwright.download.prss.microsoft.com`) plus up to the remainder of Daytona's
20 exact/wildcard domain targets. A stored Trusted-only policy carries the
baseline version it was compiled under; the first settings read after
`TERMINAL_NETWORK_MANIFEST_VERSION` changes rewrites a settled policy to the
current baseline plus its custom domains under a new revision, and each sandbox
re-applies and reads the list back on its next acquisition through the
ordinary reconcile path. That reconcile stops a running sandbox, so every
active Terminal in a Trusted-only workspace is stopped once, mid-run, after a
baseline change deploys, ending any dev server or background process. Only a
caller on the object's own baseline version moves a policy, so an older
Worker serving during a deploy cannot roll one back. A policy with a change in flight, a Full internet one,
and one whose upgraded list would pass the 20-target cap are left as they are;
an applied change records the baseline version it was compiled under, so the
next read does not move it again. Settings shows only workspace-approved domains; the managed
baseline is not a participant-facing policy surface. Full internet clears
`domainAllowList`. Schemes, ports, paths, IP addresses, CIDR, public suffixes,
and private names are rejected. An admin confirms one warning that running
cloud computers may be interrupted; the client then previews against a revision
and applies that preview in one step. Preview only checks the revision, compiles
the policy and issues a mutation id; it does not walk the organization's
sandboxes, which apply does once. For each sandbox Rally cancels active
tasks and reads Daytona's state, not its own row; for one Daytona reports
running it also preserves a final diff and stops it. It then
applies and reads back the provider policy on every sandbox, stopped and
archived ones included, without stopping or restarting them. A sandbox whose
observation, stop, policy write or read-back fails gets applied revision 0 and a
`policy_transition:<step>:<reason>` failure code, where the
reason is Rally's own code or the provider error's class, HTTP status and
machine-readable code (`TerminalProviderError.code`, carried across the
provider RPC hop) and never the provider's message, and the change still lands
for the organization: a run already holding the sandbox sees its claim go
stale, and the next acquisition reapplies the policy, reads it back, and only
then stamps the revision and resumes. A failure never deletes a sandbox.

The workspace's alarm stops an idle running sandbox after five minutes,
archives it after sixty minutes, and deletes it after thirty days. Idle means
no tool call in the window: every lease claim stamps `last_command_at`, and
the sweep holds a running sandbox whose stamp is inside the warm window
whether or not anyone holds the lease at that instant, since a busy run holds
nothing between two of its calls. Daytona's
15-minute auto-stop is only a provider backstop. Due transitions use a bounded
object-local claim that outlives the provider request limit and reconcile
observed provider state after ambiguous calls. The workspace directory carries
one Terminal deadline per work stream: the earliest across every conversation
under it, which the Channel's parent in `WorkspaceDO` folds into the main
conversation's projection (see
[`hosted-conversation-parents.md`](hosted-conversation-parents.md)). When that
entry comes due the sweep asks the work stream's parent which
conversations are due (`childTerminalDeadlines`) and reconciles each one's
sandbox on its own row; a work stream that lists none is treated as the main
conversation's, as every work stream was before conversations reported their
own. A policy change enumerates the same way and always asks the main
conversation whatever the parent lists, because the list is a projection that
lands after a sandbox exists; a side thread's sandbox created inside that gap
is missed by the application and converges at its next claim, which finds the
row's applied revision behind the workspace's and re-runs readiness against
the new policy. A sandbox whose lease holder ran in another conversation is
held while that conversation says the run is active.

A row a side thread or background agent reserved before a sandbox belonged to
a conversation names the main conversation's sandbox under the work stream's
one name. Readiness recognises such a row by its name, drops it without a
provider call and reserves the conversation's own name; the sweep and the
policy application, which now reach every conversation's row, refuse to act
through it. The main conversation's derivation is unchanged, so its rows never
match.

None of that reaches a sandbox under a Sidekick. Its parent projects no
Terminal deadline into the workspace directory, so the sweep and workspace
policy-change walk do not reach its sandbox. The provider retires it instead:
Daytona auto-stops it after fifteen idle minutes and deletes it thirty days
after that stop. Later activations reopen the same sandbox while it is available;
acquisition rechecks permissions and network policy before reuse. Existing
per-activation sandboxes from before sharing retain their provider cleanup
policy; they are not copied into the shared wizard sandbox. Published resources
remain the recovery source for missing files. No migration changes their identity.

**Daytona owns provider state; Rally owns identity, authority, leases, and
retention intent.** Acquisition reads metadata before reusing the recorded
sandbox. A stale `running` row over a Daytona archive is restored with `start`,
preserving the sandbox ID, generation, and filesystem.

| Provider observation | Acquisition action |
| --- | --- |
| Running | Reuse and refresh Rally's retention deadlines. |
| Stopped or archived | Start the same sandbox; Daytona restores archived files. |
| Error with `recoverable: true` | Recover the same sandbox from Daytona's backup. |
| Error with no recoverability verdict | Preserve the identity and return unavailable. |
| Explicitly unrecoverable error or explicit deleted state | Confirm deletion, then replace the generation. |
| Unexpected metadata 404 | Preserve the ID and generation; return unavailable and reconcile again. |
| Transitional or unknown | Preserve the identity and retry after the transition. |

**How long a restore may take is the acquisition budget's to say.** Starting an
archived sandbox restores its filesystem, and the Daytona call that asks for
that also waits for it — but the two are separable, and only the request is
what makes the restore happen. So acquisition hands the provider the instant
its work must not outlive: `acquisitionStartedAt` plus
`TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS`, the same number every Terminal tool's
`timeoutMs` is sized from. `startSandbox` and `recoverSandbox` carry it as
`deadlineAtMs`, and the adapter subtracts `Date.now()` from it immediately
before the SDK call. Repository checkout does not acquire — it takes the
mutation lease and restores the sandbox itself — so it anchors its own deadline
from `TERMINAL_REPOSITORY_PREPARATION_BUDGET_MS`, the budget its tool deadline
reserves for that phase. Between them no restore path is left on the SDK
default.

**An instant, not a remaining duration.** A duration is only true when it is
computed, and three things sit between the coordinator and the wait: the policy
read, authority replacement and network reconciliation before the call; the
provider RPC session; and the adapter's own sandbox lookup. A duration
snapshotted at the coordinator would let the wait outlive the budget by however
long those took — with a 120s budget and 20s of session and lookup, Daytona
would still be asked to wait a further 120s. An instant survives every hop
unchanged, so each of those is charged against it wherever it is spent.

Rounding to the SDK's seconds is **down**, so a wait can never outrun the
instant it was given. A deadline already reached still sends the start and
waits one second, the smallest finite value the SDK accepts — `0` means "wait
forever" there. That sub-second overshoot is the floor's unavoidable cost, not
a grace.

Be exact about what that floor buys, because it is the case it exists for: the
SDK spends the same number on the start request as on the wait, so at one
second the request carries a 1000ms timeout and Daytona's control plane may not
answer within it. The start is *sent*; it is not guaranteed to be accepted, and
nothing re-issues it. What makes that safe is not the floor but
`resumeProviderSandbox` re-observing provider state afterwards, which it does
whether the wait succeeded, timed out, or threw. A caller with no deadline of
its own — only the lifecycle alarm now — passes none and gets the SDK's own
default; that path never starts an archived sandbox, so it cannot reach the
restore measurement.

A start or recovery timeout does not establish loss. Acquisition reads metadata
again and accepts a completed start, waits out a transition, or replaces only
when the provider explicitly establishes loss. Failed deletion does not release
the old generation while the sandbox still exists. Authority changes remain an
independent reason to replace for ordinary conversations. Sidekick files and
completed imports instead remain shared across eligible delegates, while a
repository selection change still replaces its generation.

`observeTerminalSandbox`, `stopTerminalSandbox`, and `deleteTerminalSandbox`
share the metadata boundary across acquisition and task cleanup. A runner,
command, file, or session `404` is not sandbox absence. Only the sandbox metadata
lookup records observed absence; unexpected absence alone cannot retire the
binding. An archived sandbox has no runner but retains its filesystem. A failed
explicit deletion may still reconcile against metadata absence, because the
caller already chose deletion; an incidental stop failure has no such authority.

Scheduled lifecycle work also reads metadata before preservation or mutation.
If Daytona already archived the sandbox, Rally records `archived` without
attempting a toolbox command. Daytona SDK `archive()` only accepts the operation;
Rally retains the due archive deadline on its last stable `stopped` intent
and uses the existing scheduled retry until metadata confirms completion, even
when an accepted archive request still reads back as stopped. Expiry recovers
a recoverable failed sandbox before attempting final-diff preservation. A
sandbox Daytona reports unrecoverable is deleted and settled by whichever
transition was due: expiry clears it, and a warm stop or archive retires the
generation so the next Terminal call starts fresh, as acquisition does. A
leftover command whose stop fails on such a sandbox retires it the same way.
Each such deletion logs `terminal_sandbox_retired_after_loss` at warn. SDK
`start()` and `recover()` wait for provider lifecycle state, which is insufficient
proof of toolbox availability. Restore and recovery run a no-op command and
download `/etc/hostname` before admitting work. Both read-only probes must
succeed. Healthy running acquisitions do not preflight the toolbox: the first
requested operation establishes its own availability, and an operation failure
preserves the sandbox binding. File absence comes from a successful filesystem
inspection, never a download-endpoint 404. Failed restore probes return `sandbox_unavailable`;
no user command is replayed and no fixed readiness sleep is imposed. The two
extra toolbox requests apply only to restore/recovery, including adopting a
running provider sandbox when Rally's intent is still stopped. Scheduled
cleanup likewise retains unexpected missing metadata before expiry and restores
its stable due state so the existing scheduler can retry.
These semantics were verified against the installed SDK 0.204.0 and Daytona's
[sandbox lifecycle](https://www.daytona.io/docs/sandboxes) and
[recovery guidance](https://www.daytona.io/docs/en/troubleshooting/).

Provider state is persisted separately in `terminal_provider_observation`.
Acquisition, signed Daytona events, and WorkspaceDO's existing Terminal alarm
all use `refreshTerminalProviderObservation`. Each read reserves an object-owned
request token before calling Daytona; settlement checks that token, sandbox ID,
and generation. Polling never takes a mutation lease or extends retention. A
failed lookup preserves the last successful observation and records
`provider_unavailable`; it does not record a lost sandbox.

**The periodic check belongs to the conversation that owns the sandbox, not
to the workspace sweep.** Each Channel conversation's object derives an alarm
candidate from its own `terminal_provider_observation.next_observe_at` (a
sandbox never observed is due at once) and, when it comes due, reserves the
read, asks Daytona, and settles the answer — one provider call and no RPC.
Reserving the read is what moves the deadline, so a failing provider waits a
full interval rather than spinning the alarm; the failure is logged as
`terminal_provider_observation_failed` with its code. The check does not delay
the conversation's run lane: it starts beside it and is joined before the alarm
re-arms. A Sidekick's conversation and an archived Channel are not observed,
as before.

The observation deadline is **not** in the directory. The directory's Terminal
deadline is the lifecycle one alone — warm stop, archive, expiry, a live claim —
so a check, which moves only the observation deadline, publishes nothing, and
neither reserving nor settling a read is a directory-affecting operation.

A running sandbox (and one in any state other than stopped or archived) is
checked every sixty seconds (`TERMINAL_PROVIDER_OBSERVATION_INTERVAL_MS`). A
stopped or archived one is checked every ten minutes
(`TERMINAL_STOPPED_SANDBOX_OBSERVATION_INTERVAL_MS`), a number the team set,
recorded in the changelog; the interval is chosen from Rally's lifecycle intent when the read is reserved.
Between checks, Daytona's signed webhooks below carry a state change as it
happens, and each one resets the interval, so the poll only bounds how stale
the view can get when a webhook is missed. This is an eventual view: provider
latency, alarm retries and a missed webhook can add up to one interval of
delay. The state API exposes `providerObservation` with `observedAt`,
`nextObserveAt`, recovery verdict, and error code; its existing `state` field
remains Rally's lifecycle intent. Callers must not present the intent as a
fresh Daytona observation.

`POST /ingest/daytona` verifies Svix signatures against the raw body and the
standard five-minute replay window, then checks the configured organization.
Events only trigger metadata readback; their state and timestamp do not overwrite
storage. Provider labels route to an active workspace in the receiving region
and to the conversation whose object owns the sandbox (`rally.substream`; a
sandbox created before the label existed belongs to the main conversation),
and the current sandbox ID/generation must match. Each configured regional endpoint can
subscribe to the shared organization; Global is currently the only deployment. Duplicate and out-of-order delivery is
safe. An already-deleted sandbox has no routing labels to read, so its owning
alarm detects absence; there is deliberately no second ownership database.
Daytona documents `sandbox.created` and `sandbox.state.updated`, not a separate
sandbox-deleted subscription.

Before stopping a running sandbox Rally captures a bounded Git diff where
possible. It cannot capture a fresh diff from an archive without restoring it.
Daytona retains the full archived filesystem; published resources are separate
Rally objects, and unpublished files must not be presumed expendable.

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

- **An intermediate lifecycle state keeps projecting the deadline it claimed.**
  `stopping` publishes the warm stop and `archiving` the archive. Moving the
  published instant resets the alarm entry's backoff, so a claim that swapped
  it out, and a failure that put it back, would retry a broken transition at
  its first step forever.
- **A provider measurement is reported per call, bound to the caller's tool
  trace, and awaited at every hop.** Reported out of band — through a
  session-scoped callback, or fired and not awaited — it is not measured at
  all: it lands with no trace, attributed to no tool, or after the row it
  belonged in. Each of those failures looks like a plausible number rather
  than an error, which is why `terminal-provider-rpc-boundary.test.ts` and
  `terminal-provider-session-target.test.ts` pin all three.
- **Whoever creates a provider RPC client disposes it.** An undisposed
  session holds an invocation open in the provider Worker, and a caller in a
  Durable Object never ends the context that would release it. Sessions left
  behind every status check ran that Worker out of memory.
- **One regional sandbox generation belongs to one conversation and one frozen
  authority fingerprint.** Ordinary conversations replace it after a principal
  or imported-resource visibility change. Sidekick files and completed imports
  stay shared across eligible coordinators, with delegation checked separately;
  their stable file identity preserves existing generations. GitHub connection
  and repository changes still require replacement. The
  conversation is the one that owns the sandbox rows, which for a background
  agent is the conversation that started it, never the agent's own; two
  conversations of one work stream never share a generation, and a run never
  uses a sandbox under another work stream.
- **A lease held by a run in another conversation is judged by that
  conversation, never by this object's own run table.** The row records which
  conversation the holder ran in; the claim SQL reads liveness from `runs` only
  for a holder that ran here, and the coordinator and the lifecycle sweep ask
  the holder's conversation before taking over or stopping. Treating a missing
  run row as a yielded run would let two runs hold one sandbox. Inside the
  object, such a holder is live while its lease is or while a command of its
  own on the generation is unsettled, since a command may outrun the lease and
  only the run that submitted it can settle it.
- **A published document's identity is the owning work stream plus its
  normalized publish path, and that derivation is frozen once documents
  exist.** "Owning" is the room for a work-stream-scoped Sidekick and the run's
  own conversation for everything else. Changing
  the normalization, or how `publish_resource` resolves a path against
  `AVALON_RESOURCE_DIR`, re-keys every published document: each one's next
  republish mints a sibling instead of updating it, silently and with no failing
  test, because a test that publishes and republishes within one run sees only
  one derivation. Widen it only with a migration of the stored identities.
- **Discovering Terminal never allocates provider compute; only an explicit
  load does, and it never holds the model.** Discovery is common and execution
  is exceptional. An explicit `load_plugin` is a stated intent to use a
  sandbox, so activation starts the acquisition in the background and returns;
  a restored durable activation stays lazy so an unrelated later run does not
  allocate because an earlier one used Terminal. Anything added to the
  activation path must fail the shared acquisition rather than clean up after
  it: a later tool may already be awaiting that promise, and an eviction after
  it resolves never reaches that waiter.
- **Every mutation is serialized through the coordinator and every command has
  one durable task receipt.** Parallel file operations or automatic retry after
  an ambiguous write could corrupt the sandbox or repeat a side effect. The
  unit of exclusion is the tool call: the lease is claimed and released per
  call, so two runs never mutate at once but do interleave between calls.
  Reads are outside it by design and may see a write in progress.
- **A background agent inherits its starter's execution principal, and that
  is checked at the same authorization boundaries.** Ordinary conversations
  bind files to that principal; Sidekicks bind files to their stable original
  identity and check current delegation separately. The repository authority
  is shared by the agent and its owner. Bootstrap and publication check the
  selected connection owner against the inventory delegation snapshot in their
  existing connection-policy read. Should those fingerprints differ, or
  should an ordinary conversation's imported resource become unreadable,
  the agent refuses with `sandbox_authority_mismatch` rather than replace a
  checkout that is not its own; only the owning conversation's run replaces
  its sandbox.
- **A row reserved under another conversation's name is not this
  conversation's sandbox.** A non-main conversation whose row carries a name
  other than its own derivation holds a legacy alias of the main
  conversation's sandbox; it is dropped, never reused, stopped or deleted
  through. The main derivation is frozen, so the rule never fires for it.
- **An import is judged in the conversation that authorized it.**
  The import row names that conversation when it is not the sandbox's own,
  and the revocation check asks it; asking the acquiring run's conversation
  instead would read an agent's imports against its owner's attachments and
  revoke both. A Sidekick also accepts current canonical read access held by
  the execution user; the import does not need a local attachment.
- **A run's own write calls take turns, and an edit replaces only the bytes
  it read.** The lease answers a run's second claim "held", so it is the
  runtime's turn that keeps two of one run's writes apart, and the digest
  carried by an edit's write that keeps it from overwriting what another call
  wrote after the read.
- **A run with an unsettled command keeps its lease.** Release is fenced on
  the holder having no unsettled task on the generation; a lease nobody held
  over a retained command would be one no successor could recover from, and
  the holder itself reattaches past its own unsettled task.
- **A sandbox the workspace sweep cannot reach carries its retention from
  creation.** The sweep finds sandboxes through the Terminal deadlines a work
  stream's parent projects; an automation projects none, so a sandbox under
  one is created with Daytona's auto-delete set, and a new kind of
  conversation parent must either project a deadline or do the same. A
  sandbox with neither is one Rally pays for until somebody finds it by hand.
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
- **Network policy is host compiled, revision fenced, applied to a running
  sandbox only after it stops, and read back.** Letting the model edit egress or assuming a provider update
  succeeded would make Trusted only a UI label rather than an enforced state.
- **Trusted only limits which hosts a sandbox reaches; it does not stop data
  leaving through them.** The baseline admits every Rally site in both regions
  (`*.rallyusercontent.com`) so an agent can screenshot the active site it
  published. A site's own `index.js` runs on an anonymous `GET` and may store
  what the request carries, so a prompt-injected agent can send data to a site
  another Rally user owns, who can then read it in that site's Data view.
  This was accepted on 2026-10-16 so the building-live-sites skill can check a
  public active site at its published URL; the help center tells
  administrators so. Nothing may describe Trusted only as a guard against
  data leaving through Rally sites. Narrowing it means removing the wildcard,
  which leaves active sites unchecked in Trusted only, or having the serving
  Worker refuse sandbox requests to sites that keep storage; a check inside
  the agent cannot work, since the agent is what is misled.
- **No model-facing revisions, lifecycle, directory-listing, polling, PTY,
  network, credential, or raw-Daytona tools exist.** These duplicate trained CLI
  behavior or expose control-plane authority that the task does not need. The
  instruction-file probe is not a tool: it rides the command a tool already
  runs, looks only at the ancestors of the path that tool addressed, and the
  model neither calls it nor sees its raw output.
- **The probe never decides a tool's outcome, and no mutation waits for it.**
  The fragment rides the reads only: the `read_file` page read, and the
  whole-file read that `edit_file` starts with and `view_image` makes, runs in an isolated subshell whose status
  never escapes, and reports what it found; the instructions arrive with that
  batch, and a write, a patch, a command or an import is never refused for an
  instruction file it has not seen (the gate that did so was removed on
  2026-09-19; the changelog records why). Every probe failure leaves the
  tool's or the bootstrap's own exit code alone. Each candidate is checked in its own
  right for symlink and root containment before it is read, because a
  repository controls what `AGENTS.md` points at. The trailer the probe prints
  starts with a marker minted for that invocation, so output the repository
  controls cannot end a tool's result early or pass itself off as the probe's.
- **Every path a `*** Begin Patch` names is contained by `realpath -m`, and
  every path it would create is absent, in the same sandbox command and before
  the vendored applier runs.** The applier follows symlinks and opens a new
  file for writing without looking, and `git apply` is not there to refuse
  either; the runtime test executes that preflight in a real shell.
- **`vendor/apply_patch.py` is never edited.** A test pins its SHA-256, so a
  behavior Rally needs goes in the wrapper around it, and a re-vendoring
  updates the hash and the README's provenance together.

## Boundary

Terminal owns the typed sandbox capability, its regional state, and its Daytona
adapter. Bind owns deferred-plugin discovery, durable tool receipts, transcript
streaming, and execution-principal context; see
[`agent-harness.md`](agent-harness.md). The attachment subsystem owns generated
resource lifecycle and current-authority reads; see
[`agent-attachments.md`](agent-attachments.md), which also owns the model-image
normalization `view_image` uses. The GitHub connector owns the App
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
- A sandbox gets 2 vCPU, 4 GiB of memory, and 8 GiB of disk, fixed by the
  snapshot it was created from. Nothing inside reports the ceiling, so exhausting
  memory is an OOM kill of whatever the model was running, and exhausting disk is
  a write failure; neither reaches the model as a Terminal error code. Raising it
  is a snapshot rebuild and its adoption merge, described under Operations.
- Activation never fails the model. A provider failure during the background
  acquisition is a `terminal_plugin_activation_finished` row at `warn` and
  reaches the model on the first Terminal tool, which reacquires and reports
  with the coordinator's guidance; a run that never reaches a Terminal tool
  leaves only the row, and nothing posts to operators from here. An
  acquisition abandoned when its run ends can leave a sandbox reserved before
  its provider id was recorded; the expiry sweep does not resolve such a row
  by stable name, so it cannot reclaim that sandbox, and the next acquisition
  for the work stream adopts it by name instead. That is an accepted gap, not a
  design: the started/finished pair shows whether it happens, and a sweep by
  stable name is the fix if it does.
- A lease release that fails twice leaves the lease with its run.
  `terminal_lease_release_failed` at `warn` names the run, the call and the
  reason, and siblings see `sandbox_busy` until the run's next call releases
  it, the run yields, or the sixteen-minute lease deadline passes. Nothing
  retries past the second attempt; the deadline is the backstop.
- A live run that goes more than five minutes between Terminal calls can have
  its sandbox stopped by the sweep mid-run, since nothing is held between two
  calls. Anything left running inside, a development server say, does not
  survive the stop, and the run's next call starts the sandbox again. The
  run-long lease held the sandbox for the whole run.
- A background agent whose fingerprint no longer matches its owner's sandbox,
  or whose owner's sandbox holds a revoked import, is refused with
  `sandbox_authority_mismatch` until the owning conversation's next Terminal
  call reprovisions the sandbox.
- An `edit_file` whose target changed since it was read answers `file_changed`
  and writes nothing; the model reads the file again.
- A republish that loses the content compare-and-swap to a concurrent one
  releases the bytes it wrote to asynchronous cleanup and reports what the
  document now holds, rather than clobbering the winner. A failed WorkspaceDO
  response is ambiguous and leaves staging intact, because it cannot prove
  whether the pointer commit landed. The model is handed a successful result
  whose hash is not the bytes it published, so a revision can be dropped
  without a run-visible signal.
- An opted-in but incomplete Daytona environment degrades to `unsupported`
  instead of failing Worker startup. This keeps ordinary local development
  usable without provider credentials; a complete but malformed configuration
  still fails validation rather than guessing.
- A provider create timeout is reconciled by stable sandbox name. Provider,
  lifecycle, and policy failures remain durable and retryable; policy read-back
  mismatch leaves verification failed rather than claiming the new policy.
- Files are regular files and at most 10 MiB; the text tools read UTF-8 only. Reads return at most 1,000
  lines and 256 KiB. A patch is at most 2 MiB and 100 files, in either format.
- An instruction file's delivered content and a kind's prompt section are
  bounded by two limits that are open placeholders until the team sets them;
  [`resident-context.md`](resident-context.md#failure-modes-and-limits) owns
  them. The probe rides the read commands only; no mutation carries one
  or pays a probe command of its own.
- A command is at most 32 KiB, defaults to 120 seconds, and is capped at 900
  seconds. Inline stdout and stderr are each head/tail bounded to 128 KiB; the
  complete generated log is capped at 5 MB and then the command reports
  `output_limit_exceeded`.
- Generated publication accepts one nonempty stable regular file, not a
  directory, symlink, device, or changing file. Resource bridge byte and count
  limits are enforced before R2 publication.
- Trusted only has 20 effective Daytona targets. The immutable baseline consumes
  fifteen, leaving five for a workspace's own domains; duplicate custom targets
  do not consume another slot. A saved list a larger baseline pushed past the
  cap still loads in settings, showing no slots left, so the admin can remove
  domains; only a new list is refused.
- Git publication allows one fixed branch and convergent PR, bounded changed
  paths, no `.github/workflows/` changes, and no
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
`workspace-settings.test.tsx` and `inspector-rail.test.tsx`. Which conversation
a run's sandbox belongs to is `terminal-run-scope.test.ts` over a table of
delegations; a side thread's own Daytona name, and a background agent holding
its owner's lease from another conversation until it yields, are in
`terminal-coordinator.test.ts`; the sweep holding such a sandbox is in
`terminal-lifecycle.test.ts`, as are an unrecoverable sandbox deleted and
settled rather than retried, including one whose leftover command could not
be stopped, a failed delete that keeps the sandbox, a failure with no
recoverability verdict that deletes nothing, and a live claim waited out
without a provider call; the port resolution rule is in
`workstream-tool-receipt-locality.test.ts`. The coordinator also proves that a
Sidekick activation or worker retains a pre-delegation generation across a
coordinator change. The plugin integration suite checks that consent withdrawal
blocks cached callers, retained imports survive, and a withdrawn repository
owner cannot bootstrap fresh credentials or use the typed publisher. Existing
mounts follow their normal lifecycle. Earlier negative controls for credential
removal are historical evidence for scope since removed; consent and shared-file
identity checks remain. On real workerd, `test-workers/terminal-sidekick-sandbox.test.ts`
proves that the wizard and successive activations share the same persisted
sandbox and exclusive mutation lease across eviction, while another Sidekick
remains separate. Reverting the routing or the primary-run reset guard makes
these focused tests fail. On real workerd,
`test-workers/terminal-authority.test.ts` proves the lease SQL for a holder
that ran elsewhere, that a factory bound to the owner's conversation leaves
the agent's object, and that a stop or archive claim and its failure leave the
published deadline where it was; `test-workers/durable-object-runtime.test.ts`
proves a Channel's parent forwards the earliest conversation deadline and lists
the conversations that own one. The per-call lease is `terminal-runtime.test.ts`:
one run's writes release between calls and re-run readiness when the row moved,
and a read proceeds while another run's write holds the lease where a write
waits; every recovery case there drives the successor through a write, since
a read recovers nothing. `terminal-lifecycle.test.ts` holds a running sandbox
whose last call is inside the warm window, and the workerd suite proves a
release keeps the lease over the holder's own unsettled command, frees it once
settled, and that the owner of an unsettled command reattaches past it. An
automation-parented scope handing Daytona the auto-delete where a work
stream's passes none is in `terminal-coordinator.test.ts`, and the provider's
mapping of that field onto Daytona's create call is in
`terminal-provider.test.ts`. A legacy alias row dropped at readiness, skipped
by the sweep and left to the main conversation by the policy application is
in the coordinator, lifecycle and settings suites; a run's write calls taking
turns, an edit refused on a changed digest, a read joining this run's
preparation, a read refused under another principal, and a background agent's
command recorded in its owner's object without the agent's run or receipt are
in `terminal-runtime.test.ts`; an import judged by its own conversation and
an agent refusing rather than replacing its owner's sandbox are in
`terminal-coordinator.test.ts`; an unresolved authority taking only Terminal
away, and a background agent composed onto its owner's object, are in
`terminal-plugin-integration.test.ts`; the sweep reconciling two conversations
the parent lists, and asking Daytona nothing when no lifecycle action is due,
is in `terminal-webhook.test.ts`. On real workerd,
`test-workers/terminal-authority.test.ts` also proves a check publishes no
directory effect while the directory carries the lifecycle deadline, and that a
stopped sandbox is checked on its own object's alarm at the ten-minute
interval.
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

Production config sets `DAYTONA_TERMINAL_SNAPSHOT=rally-terminal-1` in both
regions. The provider probe must pass against a snapshot before a region serves
from it — it passed against `rally-terminal-1` on 2026-09-08 — and the weekly
rebuild re-proves each replacement; the per-sandbox compatibility probe protects
the interval between those reviews.

## Data model

Migration `0075_terminal_workspaces.sql` created the legacy D1 source. Serving
contract 1 imports work-stream-owned rows into the main SubstreamAgent and
workspace policy into WorkspaceDO:

- WorkspaceDO `workspace_sandbox_network_policies`, `_domains`, and `_mutations`
  for the revisioned preview/confirm/read-back protocol and full history;
- `terminal_workspace` for generation, authority, provider, lease, lifecycle,
  retention, and final-diff state — including, since conversation schema 63,
  `operation_run_substream_id`: the conversation the lease holder's run
  executes in when that is not this object's own, `NULL` otherwise;
- `terminal_provider_observation` for generation-fenced provider readback, freshness,
  errors, and the next observation deadline (SubstreamAgent schema 57);
- `terminal_tasks` for durable command submission and one final result; since
  conversation schema 65 no longer keyed to this object's `runs` and
  `tool_effects`, with `run_substream_id` naming a holder from another
  conversation, so that a background agent's command records its task here
  while its run and its receipt stay in its own object;
- `terminal_imported_resources` for generation-scoped deterministic imports,
  with `attached_substream_id` (schema 64) naming the conversation whose
  attachment authorized an import made from another conversation;
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
owning Rally region. Daytona is one shared environment: the configured Global Worker is
`supported` on `DAYTONA_TARGET=us` and the `rally-terminal-1` snapshot. Sandbox files therefore run on that one Daytona fleet regardless of
the Rally workspace region. That is a subprocessor exception, not a Rally
cross-region bridge — no Terminal D1, R2, or GitHub-token record falls back to
Global.

## Security and trust model

Model commands, repository contents, package output, imported resources, and
provider output are untrusted. Paths remain beneath `/workspace`; ANSI/control
characters and recognizable token forms are scrubbed before model or transcript
projection. Command arguments are never interpolated into a host shell. The
Daytona SDK is reachable only through the regional adapter.

The Daytona project credential stays a Worker secret. GitHub installation tokens
are minted just in time and narrowed to the selected repository and operation.
Read credentials remain mounted through host-scoped Daytona placeholders and
are rotated or removed on revocation/expiry. A full-access checkout establishes
the same short-lived, single-repository write credential once in the work-stream
sandbox; ordinary Git and the typed publisher share that already-authorized
credential until the existing refresh boundary rotates it. The typed publisher
still revalidates participant, grant, repository, branch, ancestry, expected
remote SHA, and final PR state before completing its durable receipt. Logs
include IDs, state, error code, duration, and byte counts—not
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
([`durable-object-alarms.md`](durable-object-alarms.md)); its provider
observation is its own conversation object's alarm, above. When the pass finds
the sandbox held by a live run it is re-checked a minute later; after a
transition it is re-checked thirty seconds later, which is how long the
directory effect takes to land off the Queue. A pass that finds another pass's
lifecycle claim still live waits a minute the same way. None of these counts
toward the stall report; a deadline the pass finds nothing to do for does, and
the pass also republishes that conversation's deadline (`republishDeadline`),
which the object skips when the projection has not changed. A deadline that
stays stale therefore keeps backing off and reporting rather than polling
quietly. The republish is rollout scaffolding for the observation deadlines an
older version stamped into the directory; remove it once this version has run
in every region for a day, by which time every such entry has come due and been
corrected.


See [`runbook.md`](runbook.md#terminal-provider-activation-and-recovery) for
activation and recovery. Structured events are
`terminal_plugin_activation_started` and `terminal_plugin_activation_finished`
(a started row with no finished row for the same `tool_call_id` is an
activation whose sandbox work was abandoned in flight), `terminal_tool_finished`,
`terminal_sandbox_lifecycle_transition`, and `terminal_sandbox_lifecycle_failed`, plus
`terminal_operation_commit_failed` and
`terminal_operation_alarm_schedule_failed` for the typed object-port boundary,
plus
`workstream_runtime_sql_commit_failed` and
`workstream_runtime_sql_alarm_schedule_failed` for its durable receipt port,
plus
`terminal_tool_receipt_recovered` or
`terminal_tool_receipt_recovery_ambiguous` for interrupted commands and PR
publication. Ambiguous recovery diagnostics retain the safe declared reason and
plugin identity. Once a tool proves a recovered result, startup repair can settle
its already-ambiguous receipt through the existing reconciliation flag. Recovery
deadlines are disposed on landed and unresolved reconciliation as well as on
executor completion. Each provider create, managed-image bootstrap, and start also emits
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

### The owned snapshot and its weekly rebuild

Configured deployments create sandboxes from the snapshot
`DAYTONA_TERMINAL_SNAPSHOT` names — `rally-terminal-20260914-0610` as of this
writing, adoption having replaced the original `rally-terminal-1` with dated
names — built by
`pnpm --filter @rally/api terminal:build-snapshot` from the base image pinned
as `TERMINAL_SNAPSHOT_BASE_IMAGE` in `snapshot-manifest.ts`
(`daytonaio/sandbox:0.10.0`; the environment variable of the same name
overrides it for a one-off build) on the Juno AI Labs Daytona organization. Owning the image means Daytona's base fixes stop arriving
on their own, and the manifest cannot see a stale-but-working base.
`.github/workflows/rebuild-terminal-snapshot.yml` rebuilds every Monday at
06:00 UTC and on dispatch: it builds a minute-stamped `rally-terminal-<date>`,
runs `terminal:verify-provider` against it, and pushes a commit that points
`wrangler.global.jsonc` — the one config that carries the variable — at the
result.
Adoption is that push, rollback is its revert, and existing sandboxes are
untouched either way. A red Monday job means the current snapshot keeps serving
and Rally's own layers go a week staler. The pin is a fixed release tag, so the
rebuild refreshes only the layers Rally adds: the Daytona base, its OS packages
included, moves only when someone bumps the pin, which
`hub.docker.com/r/daytonaio/sandbox/tags` lists. How stale the base may get is
therefore not bounded by the rebuild. Each build stamps its Dockerfile with a build time so
Daytona cannot hand back a cached image, and the stamp is readable inside every
sandbox as `RALLY_TERMINAL_SNAPSHOT_BUILT_AT`; a build that finishes in seconds
is a reused image, not a rebuild.

Sandbox size is set by the snapshot, not by the create call that makes a sandbox
from it. Daytona fixes a snapshot's size when the image is built — the snapshots
API creates, activates, deactivates and removes a snapshot, and never resizes one,
while `resources` exists only on the SDK's create-*from-image* parameters — so a
sandbox created from a snapshot inherits whatever that snapshot was built with.
One live sandbox can still be changed afterwards through `Sandbox.resize`, which
grows CPU and memory hot and disk only while it is stopped; that is the lever for
a single sandbox in trouble, not for what new ones get, and Rally's create path
does not call it. Builds request
`TERMINAL_SNAPSHOT_RESOURCES` from `snapshot-manifest.ts`, 2 vCPU / 4 GiB / 8 GiB,
and fail naming each field that came back short, because an under-sized image
passes every capability probe the acceptance gate runs and surfaces only as a
work stream the kernel killed. A field the provider rounds up is reported in the
build log instead: it is Rally's size and more, and a cost nobody chose is worth
seeing without taking the rebuild red. A rejected candidate is
deleted before the build throws, so a run that keeps failing does not leave one
unusable snapshot per attempt under the organization's quota. That decision lives
in `scripts/terminal-snapshot-acceptance.ts` rather than in the build script, so
it is exercised against a stubbed delete the way the provider lifecycle helper
beside it is. Changing the size is therefore
a rebuild and an adoption push like any other, existing sandboxes keep the size
they were created at, and the number belongs in the checked-in manifest: the
weekly job builds from the repository, so a size set as a GitHub variable is one
the next weekly push silently reverts.

The workflow reads its configuration from the `api-production` GitHub
environment: the `DAYTONA_API_KEY` secret and the `DAYTONA_API_URL`,
`DAYTONA_TARGET`, `TERMINAL_PROBE_REDIRECT_URL`, and
`TERMINAL_PROBE_PRIVATE_DNS_URL` variables, plus `TERMINAL_SNAPSHOT_PR_TOKEN`
(a fine-grained token with contents write). The job fails before the build if
that token is missing, because a push authenticated with `GITHUB_TOKEN` starts
no workflows — including the `deploy-api.yml` run that is the only reason to
adopt. The checkout uses the PAT so the later `git push origin HEAD:main`
triggers deploy.

The gate's two probe endpoints are Rally's own, on `rallywith.ai`:
`probe-redirect` is a proxied record with a Cloudflare redirect rule answering
302 to `https://example.org/`, and `probe-private` is an unproxied A record to
`10.0.0.1`. The [runbook](runbook.md#terminal-provider-activation-and-recovery)
holds the operator steps.

## Performance and cost

**The status poll is the recurring cost that scales with retention, not with
use.** Every sandbox is checked for up to thirty days whether anyone opens it,
so a check must stay one Daytona `GET` made by the owning object, with no RPC
and no directory update, and a stopped or archived sandbox is checked a tenth
as often as a running one. What it cost before that is in the 2026-09-28
changelog entry. Webhooks cost two `GET`s each (routing, then the ordered
read).

An explicit Terminal `load_plugin` starts and initializes the sandbox because
the next model action is overwhelmingly likely to use one of its tools — in
the background, so the model is not held behind it: measured across runs that
use Terminal, the median run does 16.5s of unrelated work between activation
and its first Terminal tool, against an ~18s median cold start. A
restored durable activation remains lazy so an unrelated later run does not
allocate merely because an earlier run used Terminal. Reuse is scoped to one
work stream. Five-minute warm stop reduces compute time, sixty-minute archive
reduces retained live-disk cost, and thirty-day deletion bounds provider storage.

Sandbox size multiplies both against the Daytona organization's quota. Memory is
bounded by concurrency — 4 GiB each means the organization's memory limit divided
by four the number of work streams that can hold a live sandbox at once, and
exhausting it shows up as creation failing rather than as anything slower. Disk
is not bounded that way: 8 GiB is held by every sandbox that exists, including
stopped ones, until the thirty-day deletion reclaims it, so it accumulates with
how many work streams have ever used Terminal rather than with how many are
running now. That makes disk the size worth watching first as usage grows. Only user-visible generated files,
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
count, and transferred byte count. Failed requests also carry `error_code`,
composed from the provider error class, HTTP status and machine code, never its
message. It includes the harness run, tool call,
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
`resource.import.stage`, `resource.import.finalize`, `repository.bootstrap`, one
of the six `repository.publish.*` inspection phases, `lifecycle.final_diff`,
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

The provider runs in its own Worker, so a request it measures has to reach the
tool that asked for it across an RPC hop. The caller's tool trace lives in
`AsyncLocalStorage`, which follows an async chain inside one Worker and does
not survive that hop: a callback the provider Worker invokes arrives in the API
Worker as a fresh entry point with no trace in scope. Two things carry it
across.

`bindToTerminalToolTrace` binds the reporting callback to the trace that is
live where the callback is *created* — inside the tool invocation about to
issue the request — and the callback travels with that one call rather than
with the session, because one session serves every concurrent tool on a run and
could not say which of them a measurement belongs to.
`terminalProviderRpcCall` holds that callback for the duration of the call it
arrived with.

Delivery is then awaited at every hop it crosses: the provider awaits the
report before its request completes, and the client awaits the caller's own
reporting, which the contract types as `void | Promise<void>` and so may
itself be asynchronous. A tool's totals are whole by the time it writes its
own row, for every request that call awaited — a cancelled command abandons
its in-flight provider execution by design, and that request's measurement
goes with it. The rule this leaves behind is in [Invariants](#invariants).

`terminal_plugin_activation_finished` uses the same acquisition and provider
timing fields under the fixed `terminal_plugin_activation` tool identity. It
also records a one-based `activation_attempt`, gives every retry a distinct
synthetic tool-call ID, and records `repository_state` as `prepared` or
`deferred` and a bounded `repository_code` when the repair belongs to the
visible Terminal tool surface.
This separates cold sandbox/repository preparation from the subsequent tool and
makes first-tool improvement measurable without logging repository identity or
content.

`pnpm terminal:analytics -- --days 7` queries Cloudflare's SQL API and prints
the actual first/last observation time, sampled and sampling-weighted counts,
and average/p50/p95/max latency for create, bootstrap, stopped warming, and
archived restore. Restore samples from before the acquisition budget reached
the provider are censored at 60_000ms and recorded as failures, so a restore
tail read across that boundary is measuring the old ceiling rather than
Daytona. The bucket is keyed on operation and source state alone, with no field
separating call sites, so a censored sample from any restore path merges into
**Restore archived sandbox** indistinguishably from a budgeted one — which is
why leaving even one restore unbudgeted would make the row a mixture of
ceilings rather than a distribution. It separately prints provider-create, policy-read-back,
compatibility-install, and manifest-verification percentiles plus how often each
missing executable was installed. Region and snapshot filters are available.

Do not replace the default snapshot from a handful of cold starts. The report waits
for at least 100 successful bootstraps in the selected cohort. When
compatibility-install p95 then exceeds ten seconds it recommends a controlled
prebuilt-snapshot benchmark. Verification remains in both variants, because a
custom image can remove installation time but cannot remove the fail-closed
runtime contract. Compare at least the same target/region and include create,
warm, restore, failure-rate, snapshot-build/activation maintenance, and managed
update lag before changing the default.

## Changelog

### 2026-10-23 — Retry observation without repeating a Terminal command

**What changed:** Named-session GET, command polling and log reads recover from
transient failures within the existing observation deadline and backoff. Only
404 authorizes session creation. Failed provider measurements retain a
content-free error code; repeated log reads discard partial earlier output.
Each read is bounded by the remaining observation time, including a stalled SDK
request, rather than waiting for its independent 120-second HTTP timeout.

**Why:** A single failed provider read stranded an accepted command as ambiguous
and stopped its run. A failed GET also entered the session-creation path without
establishing absence, while its log omitted the underlying provider error code.

**Considered and rejected:** Retrying command submission could repeat an external
write. Adding a separate retry count or timeout would introduce a second budget;
observation already has a deadline and safe stable command identity.

**Consequences:** Recovery observes the same command and settles the existing
durable task. Cancellation, non-transient refusals and exhausted observation
still retain the existing fail-closed recovery behavior.

### 2026-10-22 — Retain Sidekick files across eligible delegates

**What changed:** Sidekick Terminal access follows an inventory-scoped eligible
delegation snapshot, including cached reads. A refreshed inventory observes
withdrawal without synchronous grant RPCs for every command. Its file identity remains stable across coordinating
users and retains the pre-delegation fingerprint. Completed imports remain
shared. Repository bootstrap and the typed publisher check the selected personal
connection owner against the loaded delegation snapshot using the selection and
connection-policy reads they already perform. The plugin adds no separate
repository selection or connection query for delegation; local files survive.
Mounted credentials retain their normal lifecycle, without a new cleanup protocol.
The shared recovery path also durably settles proven ambiguous results and
cleans up its deadline when a reconciler returns or refuses before execution.

**Why:** The old run-as fence prevented an eligible delegate from continuing
shared work and erased retained content when coordination moved to another
person. Fresh GitHub bootstrap and typed publication still need an eligible
connection owner. Repeating repository selection and connection reads in an
outer delegation guard added serial work; the existing repository authorization
read has all the facts needed for that decision. A recovered effect
without the reconciliation settlement flag stayed ambiguous despite proof of
completion; an early reconciler return also left its deadline timer running.

**Considered and rejected:** Rebuilding on every coordinator change, pooling
personal credentials in the sandbox, generic cross-account command retries,
and a synchronous revocation barrier. They respectively lose shared state,
combine unrelated authority, risk repeating effects, or exceed the product's
eventual authorization contract.

**Consequences:** Ordinary conversation isolation and repository replacement
rules remain. The fixed file identity is compatibility metadata, never a grant.
New imports and publications still require current destination/source access;
restoring delegation permits fresh credential preparation on a later run.

### 2026-10-22 — Give setup the same home publication identity as activations

The wizard could neither import its home Thread's site nor publish back to that
Thread, although scheduled activations had a narrow recovery exception. Setup,
activations, workers and interrupted-write repair now resolve the admitted home
at each publication and recovery lookup, without taking away other Terminal
tools on a home-access refusal. Breakout identities include the child address
to prevent same-path outputs from overwriting another audience's publication.
Imports and revocation use live inherited
resource access rather than attaching a recovered site to each run. Creating a
Sidekick-owned replacement was rejected because it changes the site's identity
and URL. Preserve internal command captures in the producing conversation and
keep home Breakout publications attached to that exact Breakout.

### 2026-10-21 — One sandbox for a Sidekick's wizard and all activations

**What changed:** Terminal resolves every primary Sidekick run and delegated worker
to its authoring conversation's sandbox. Run records and resource permissions
stay in the execution conversation. Existing foreign-run mutation leases serialize
shared writes. Shared-output workflows claim a durable coordination row across
multiple tool calls, rather than treating that per-call lease as a workflow lock.
Reimports of the same resource and destination replace their authorizing
activation, so provenance checks follow retained source paths, not run history.
Primary activations may rebuild changed authority; background
agents still cannot replace their owner's files. Every plugin activation and
tool call checks the live run-as user, so another editor cannot repeatedly
replace the shared sandbox. Generated sites can be recovered from the configured
publishing Thread without inheriting its other resources. Provider retention is unchanged.

**Why:** Recreating the working directory for every activation made recurring
site updates recover the same files repeatedly and prevented wizard preparation
from carrying into execution. Sharing the existing authoring owner reuses the
platform's identity and lease primitives, rather than adding a filesystem-copy
service or a second sandbox registry. Permission changes and provider loss still
require recovery, and sandbox sharing must not share transcripts or merge
separate Sidekicks. Old activation sandboxes expire through their existing policy.

### 2026-10-15 — The agent can look at an image it made

**What changed:** A new read tool, `view_image`, returns an image file from
the workspace to the model as a picture for that turn, through the attachment
image pipeline (`normalizeModelImageBytes`). A completed `view_image` receipt is
never replayed: the host discards it and the read runs again.

**Why:** #1246 put Playwright in the snapshot so an agent can screenshot the
site it built (that entry tells the incident); without a way to see the
screenshot, the step was pointless. A Terminal tool, not `view_resource`,
because a screenshot is scratch work, and publishing each one as a resource
would put it in front of the participants and write it to R2.

**Considered and rejected:** Replaying the receipt with only its JSON, which
every other Terminal read does. The model would get a success with no picture
and announce a layout it never saw. The picture cannot be rebuilt from regional
state either, because the file lives in the sandbox and may have changed.

**Consequences:** The terminal now depends on the attachment image limits and
the region's `IMAGES` binding: without Images, an image with an edge over
2048px is refused rather than scaled, and a change to those limits in
`attachment-model-content.ts` changes what this tool accepts. Nothing bounds how
many images a run may view; each one stays in the live window and is resent on
every later model call.

Shipped in [#1248](https://github.com/juno-ai-labs/avalon/pull/1248).

### 2026-10-15 — The weekly snapshot carries Playwright, and Trusted only reaches Rally sites

**What changed:** The Rally-owned snapshot image installs Playwright
(`TERMINAL_PLAYWRIGHT_VERSION`) and its Chromium in a build step of its own,
and the provider acceptance gate requires a working screenshot. The
Trusted-only baseline adds `*.rallyusercontent.com`, `cdn.playwright.dev` and
`playwright.download.prss.microsoft.com` under `terminal-network-v2`, and a
stored policy from an older baseline is rewritten to the current one under a
new revision on its next settings read.

**Why:** A generated site rendered one word per line in Rally's narrow
panel, and the agent that built it had no way to see that. A browser in the
sandbox lets it screenshot a page before publishing, under the workspace's
own network setting. A Cloudflare Browser Rendering tool was considered and
dropped: it can only see published sites, from outside the sandbox.

**Consequences:** Playwright stays image-only: installing it from the
runtime bootstrap would exceed the bootstrap's 120-second budget. Making it a
per-sandbox probe would refuse every sandbox until a rebuilt snapshot is
adopted, so anything that tells the model to use it must handle its absence.
The download hosts let an agent in a sandbox from an older snapshot install
the browser itself. Before this, a baseline change reached only new workspaces and
re-saved policies; the version-triggered rewrite is what lets a future baseline
change reach every workspace. The baseline now uses fifteen of twenty slots; no
production workspace had a custom domain when it was raised.

### 2026-10-08 — A failed policy change no longer deletes sandboxes

**What changed:** Applying an organization network policy stops only the
sandboxes Daytona reports running and writes the policy to stopped and archived
ones as they are. A sandbox that fails any step keeps applied revision 0,
records the step and a code-only reason in `failure_code`, and is logged as
`terminal_policy_sandbox_failed`; the change still commits. Acquisition now
reads the policy back before stamping a revision. Provider RPC failures carry a
code (class, status, provider code). The rollback, the delete-on-failure
fallback and the `terminal_policy_verification_failed` 502 are gone. Settings
replaced the inline review panel with one Continue/Cancel warning, and preview
no longer walks every sandbox or returns `affectedWorkstreamIds`,
`affectedWorkstreams` or `warning`.

**Why:** Apply called `stopSandbox` on every sandbox with an id, archived ones
included. Daytona refuses to stop an archived sandbox, and a failed stop meant
delete, so switching Juno Labs to Full internet on 2026-10-08 deleted nearly
every idle sandbox in the organization, with no final diff because none was
running. Any one failure, a final diff included, also rolled back and could
delete every other sandbox. The stored code was always
`provider_policy_mismatch`, whatever had failed.

**Considered and rejected:** Keeping the organization-wide rollback and only
skipping archived sandboxes. One failing sandbox would still undo everyone's
change and, if its rollback did not read back, still delete it. Acquisition
already reapplies the policy to a sandbox whose revision is stale, so leaving a
failed sandbox behind costs nothing a member can lose.

**Consequences:** A sandbox whose stop fails during a switch to Trusted only
keeps its old egress until its next claim or its five-minute idle stop; revision
0 makes a run already holding it go stale on its next operation. Revision 0 is
the "not applied" value and must stay outside the policy's own `revision >= 1`
range. A future change must not turn a per-sandbox failure back into a deletion
or an organization-wide rollback, and must not record a revision the provider
has not read back. Desktop builds from before this change parse the preview
with those three fields required, so they cannot save the policy until they
update; that was accepted to halve the time a save takes.

Shipped in #1168.

### 2026-09-29 — The owner of a provider RPC client disposes it

**What changed:** `createTerminalProviderRpcClient` returns a `Disposable`.
Disposing it releases the provider Worker session once the calls in flight
settle, and a call made after that gets a session of its own that is released
when it goes idle. Every caller disposes its client when done: the per-channel
status check, the workspace lifecycle pass, the Daytona webhook, the Terminal
settings routes, and the harness run, which disposes its plugins when
`runHarness` settles and so releases the Terminal plugin's session.

**Why:** The client opened a session on first use and never disposed it. A
session is an `RpcTarget`, and Cloudflare keeps the provider Worker's
invocation open until every stub to it is disposed. A caller in a Durable
Object never ends the context that would dispose it for us, and the status
check made a new client every minute for every channel with a sandbox. Sessions
piled up in `avalon-api-terminal-global` until an instance hit 128 MB and
everything in it was killed, in-flight Terminal tool calls included: about
8,900 killed invocations a day, with the `default.jsrpc` errors and the
"waitUntil cancelled" warnings as side effects.

**Considered and rejected:** A session per call, which would drop the sandbox
objects the provider caches for a run and add a Daytona `GET` to every tool
call. Releasing the session whenever the client goes idle, for the same reason,
since a run's tool calls are separated by model turns. A harness-level teardown
hook, which the harness package does not need: the host already knows when a
run ends.

**Consequences:** Anything that creates this client owns disposing it. A
plugin that holds run-scoped resources makes itself `Disposable`, and
`runWorkstreamHarness` releases it. Local workerd does not run an `RpcTarget`'s
disposer in the Workers test pool, so
`terminal-provider-rpc-boundary.test.ts` pins that the real stub is disposed,
not that the provider side ran its disposer.

### 2026-09-28 — The sandbox status check moves into its conversation, stops publishing, and slows for stopped sandboxes

**What changed:** The periodic Daytona status check runs on the sandbox's own
conversation object's alarm, not in the workspace's lifecycle sweep, and its
deadline left the `directory_common` projection: `next_terminal_action_at`
carries lifecycle deadlines only, and reserving or settling a read publishes
nothing. A stopped or archived sandbox is checked every ten minutes, a running
one every minute. A sweep that finds a due entry with nothing behind it
republishes that conversation's deadline (`republishDeadline`), which is how
the observation deadlines older versions published get replaced.

**Why:** Measured in production on 2026-09-27, the check was the most-called
RPC in the system: about 14,700 Terminal calls and 1,800
`receiveChildEffects` calls an hour, about 285 s of CPU. Each check made six
Terminal object calls, two of them duplicate reads, and both writes offered a
directory update because the observation deadline was projected; about 99% of
directory updates changed nothing else. The workspace could learn when to
check only through the directory, so every check was a directory write. The
2026-09-14 entry's "one `GET` per sandbox per minute" left out that churn and
charged stopped sandboxes, which only a webhook-delivered event will change,
at the running rate for thirty days; this reverses its cadence decision. Adam
set the ten minutes on 2026-09-27; it is the team's number, not a measurement.

**Considered and rejected:** Keeping the check in the sweep minus the duplicate
reads — the first publish is what fed the sweep its next check, so the churn
stays. A per-sandbox timer in the workspace — it would need its own copy of
which sandboxes exist and in what state. Webhooks alone — a missed one would
leave the observation stale until the next tool call. A one-time object
migration instead of the sweep's republish — migrations are SQL, cannot build
a projection, and run only when the object is next woken, which for a dormant
sandbox is that same sweep.

**Consequences:** A missed webhook can leave a stopped sandbox's view, or a
missed deletion, up to ten minutes stale. Nothing added to `directory_common`
may move on every check, or the churn returns. A new conversation parent that
owns a sandbox must decide whether its object observes it, as a Channel's does
and a Sidekick's does not. At rollout each stale entry is swept once, reported
once as a stall, and republished. `republishDeadline` is scaffolding for that:
remove it with its protocol entry and the sweep's call once this version has
run a day in every region.

### 2026-09-27 — An unrecoverable sandbox is retired, and a failing pass backs off

**What changed:** The scheduled lifecycle deletes a sandbox Daytona reports as
`error` with `recoverable: false`, including when a leftover command's stop
fails on it, and settles the due transition: expiry clears it, and a warm stop
or archive retires the generation. It logs `terminal_sandbox_retired_after_loss`.
A lifecycle claim no longer moves `next_terminal_action_at`: `stopping` and
`archiving` keep projecting the deadline they claimed. A refused claim now
defers instead of returning `none`.

**Why:** One Channel's sandbox had sat in Daytona's unrecoverable `error`
state since 2026-09-18. Its warm stop threw
`terminal_lifecycle_provider_transition_pending` on every pass: 2,047 times in
the six hours to 01:30 UTC on 2026-09-27, 860 of them in the last 90 minutes.
It would have
kept on until its expiry in October, which would also have failed trying to
preserve a diff from it. Acquisition already deleted and replaced a lost
sandbox; the sweep never had the same check. The rate came from a second fault:
the claim swapped the published deadline for its own expiry and the failure
restored it, and each move reset the alarm entry's backoff, so 796 of those 860
failures were "attempt 1".

**Considered and rejected:** Making the alarm store keep an entry's attempt
count when its due time moves. A move is how a caller says something changed,
and the store cannot tell a real reschedule from a claim's churn; the fix
belongs where the churn is. Leaving the warm stop to Daytona's backstop was
rejected because the backstop does not delete, and the row would still claim a
sandbox that cannot serve.

**Consequences:** Anything that writes an intermediate lifecycle state has to
keep the deadline it is acting on in the projection. Because the claimed
deadline is already past, a claim held by a crashed pass is now re-checked
every minute until it lapses, where the directory used to wait for the claim's
own expiry; that polling is bounded by the 16-minute lease and costs one row
read a minute. A pass that dies between deleting a lost sandbox and settling
the row leaves one that later reads as missing metadata, the same window
acquisition and task cleanup already have.

Shipped in #1003.

### 2026-09-19 — A provider request reports to the tool call that issued it

**What changed:** `observeRequest` moves off the session-scoped RPC
instrumentation and onto the per-call `TerminalProviderRpcCallbacks`. The
client builds it inside the tool invocation that is about to issue the request
and wraps it in `bindToTerminalToolTrace`, a new primitive in `tracing.ts` that
captures the ambient tool trace and re-enters it when the callback is invoked
from elsewhere. `terminalProviderRpcCall` scopes the callback to the one call
it arrived with, and delivery is awaited at each hop: `measureRequest` in the
Daytona provider awaits the report instead of leaving it to `waitUntil`, and
the client awaits the caller's own reporting rather than discarding its
promise. Only `observe`, which needs
nothing but the environment, still crosses as a session callback.

**Why:** `provider_duration_ms` read `0` on 100% of `terminal_tool_finished`
rows, and the counts beside it — requests, polls, operations, bytes — were
equally empty, so the event built to separate Rally-side latency from Daytona
latency could answer neither. `AsyncLocalStorage` propagates along an async
chain within a Worker; the Terminal provider is a separate Worker, and its
callback re-entered the API Worker outside that chain, so
`recordTerminalProviderRequest` found no trace and returned. The field that
made it diagnosable was the one beside it: `acquisition_duration_ms` populated,
and it is the only one recorded locally. A second defect rode the same path —
the measurement was dispatched through `ctx.waitUntil`, so even with the trace
intact it raced its own call's result and could land after the tool had logged.

**Considered and rejected:** Returning the measurements in band on the RPC
result envelope, which needs no callback at all. It buffers: one `runCommand`
polls at up to 2s for the length of the command, so the rows would arrive only
when the call ended — exactly the case, a hung command, where watching polls
arrive is the point — and the buffer would need a cap this team has no basis to
set. Also rejected: keying traces by tool-call ID in a registry the callback
looks up, which replaces a leaked async context with a map that has to be
cleaned up on every path a call can end on.

**Consequences:** Each provider request now costs one awaited RPC hop, which is
sub-millisecond against Daytona calls measured in tens of milliseconds and poll
sleeps measured in hundreds. Anything added to `TerminalProviderRpcCallbacks`
that needs the caller's trace must be bound the same way; anything put back on
the session instrumentation silently loses it. `terminal-provider-rpc-boundary.test.ts`
holds the standing proof, including a test that pins the platform behaviour
itself, so the regression is visible as a failure rather than as a column of
zeroes.

### 2026-09-19 — Weekly snapshot adoption pushes to main

**What changed:** After `terminal:verify-provider` passes, the weekly rebuild
rewrites `DAYTONA_TERMINAL_SNAPSHOT` in `wrangler.global.jsonc` and pushes that
commit to main. The checkout and push authenticate with
`TERMINAL_SNAPSHOT_PR_TOKEN`. A missing token fails the job before the build.

**Why:** Owning the snapshot was judged safe only because a weekly rebuild
bounds how stale the image can get. The rebuild already proves the image; the
remaining hop was a pull request in the review queue while production aged.
[#844](https://github.com/juno-ai-labs/avalon/pull/844) was that sitting: a
one-line, pre-verified config bump that waited on a person. Opening a PR, even
one that auto-merges, is still that hop.

**Considered and rejected:** Auto-merging a labelled adoption pull request.
That kept the series and a revert-as-PR-unit, and it is how GitHub starts
`deploy-api.yml` after a merge, but it is still a PR when the point was to
stop waiting. A `GITHUB_TOKEN` push was also rejected: GitHub starts no
workflows for those events, so production would keep the previous image with
a green job.

**Consequences:** Adoption is a push; rollback is reverting that commit. The
job rebases onto `origin/main` after the build so a 45-minute rebuild is not
a non-fast-forward, and a conflict is a red job rather than a force-push.
Do not fall back to `GITHUB_TOKEN` for the push. The PAT needs contents
write; pull-requests write is unused. The acceptance gate remains the proof
the image is usable.

Shipped in #858.

### 2026-09-19 — A sandbox restore is bounded by the acquisition budget, not the SDK's default

**What changed:** `startSandbox` and `recoverSandbox` take a
`TerminalSandboxWaitOptions` across the provider contract and its RPC hop,
carrying a deadline as an absolute `deadlineAtMs`. The coordinator computes it
once per acquisition from `terminalAcquisitionDeadlineAt`; repository checkout,
which restores outside `acquire`, computes its own from
`terminalRepositoryPreparationDeadlineAt`. The Daytona adapter subtracts
`Date.now()` immediately before the SDK call, rounds the remainder down to the
SDK's seconds, and floors it at one so a reached deadline never arrives as the
SDK's "wait forever" zero. The lifecycle alarm passes nothing and keeps the SDK
default; it never starts an archived sandbox, so it is not a restore path. No
number moved: `TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS` is still 120s and
`TERMINAL_REPOSITORY_PREPARATION_BUDGET_MS` still 180s.

**Why:** Archived-restore latency was bimodal — p50 4.7s, p90 59.6s — with
observations landing on exactly 60s. That 60 was not a bound anyone chose: the
adapter passed `60` to `Sandbox.start`, which is that method's own default
signature value re-typed as an argument. It bounded nothing real, because a
wait that runs out does not stop Daytona restoring, and `resumeProviderSandbox`
already re-reads provider state precisely for that case. What it did do was
record every restore past a minute as a `sandbox_start` failure at exactly
60_000ms, censoring the distribution that anyone choosing a real ceiling would
have to read. Raising it to a larger guess was rejected for that reason: it
moves the censor without answering the question, and
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)
puts the number outside a change author's gift anyway. Meanwhile
`TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS` already existed, was already what the
model was promised, and had never travelled past `contract.ts` — so the
provider silently gave up at half the advertised deadline. Deleting the second
deadline rather than raising it leaves one number, owned where it is
advertised, and lets `pnpm terminal:analytics` show the real restore tail.

**What a future change has to respect:** the deadline crosses the RPC hop as an
instant and is subtracted at the point of use, never carried as a remaining
duration. Review of the first draft caught exactly that: it passed a `waitMs`
computed in the coordinator, which the RPC session handshake and the adapter's
sandbox lookup then spent without deducting, so a 120s budget could authorize a
wait ending at 140s. Rounding is down for the same reason.

Review also caught the created-sandbox start having no re-observation
fallback. `resumeProviderSandbox` had one from the start; the create path did
not, and a bounded wait is what made that reachable — a wait running out there
would have escaped as an unclassified provider error rather than a retryable
`sandbox_unavailable`. **A bounded wait obliges the caller to re-observe**, so
any future call site that passes a deadline owes that catch too.

Review also caught the draft budgeting `acquire` alone while claiming the
measurement was fixed. It was not: repository checkout restores outside
`acquire`, kept the SDK default implicitly, and fed censored samples into the
same analytics bucket — so the report would have mixed two ceilings while
reading as one distribution. **Any new call site that can start an archived
sandbox owes a deadline**, or it silently re-censors the row that tells the
team whether a budget needs to move.

**What this bounds, and what it does not.** Only the *restore wait* is
budgeted. The adapter still passes the SDK's `60` to `stop`, `delete` and
`create`, and two of those — the `stop` in `reconcileNetworkPolicy` and the
`delete` in `replaceForAuthority` — run inside acquisition, so a slow one can
still spend the budget that the restore after it then finds gone. The restore
handles that correctly, because the deadline is absolute and it simply gets
what is left, but the acquisition as a whole can still overrun. Bounding those
is a separate change and a separate set of numbers.

What is fully bounded is the *measurement*: `operation: "sandbox_start"` is
emitted only from the provider's `startSandbox`, so no unbudgeted call can
reach the **Restore archived sandbox** row. The direct `sandbox.start` calls
inside `configureGitHubReadAccess` and command cancellation emit a request
measurement only.

If a restore ceiling ever does need to be its own number, it is one of the two
budgets that moves; do not reintroduce a bound on a restore inside the adapter. And the wait
is not a durability decision: a timeout must keep re-observing rather than
treating the sandbox as lost — which is also the only thing that makes a
floored one-second start safe, since that request can be aborted before Daytona
accepts it.

### 2026-09-19 — A mutation no longer waits for its instructions, and `apply_patch` takes the model's own format

**What changed:** Two things, from one analysis of a production run.

`apply_patch` accepts the `*** Begin Patch` format beside a unified diff. The
first non-blank line decides; `patch-format.ts` holds both parsers, and the
envelope is applied by OpenAI's reference `apply_patch.py`, vendored byte for
byte under `vendor/` (MIT, provenance and hash in its README, the hash pinned
by a test) and written into the sandbox beside the patch. Both parsers hold
every path to the shared Terminal path rules, and the envelope command refuses
to create a file that already exists before the applier runs, because the
applier opens a new file for writing without looking. The applier's one
dependency, `pydantic`, is pinned in `snapshot-manifest.ts`, baked into the
snapshot by its bootstrap, and installed from PyPI into `/workspace/.rally/pylib`
only by a sandbox whose snapshot lacks it, staged and moved into place. Success
is the applier's whole output being `Done!`, which a patch's own context cannot
forge; a timeout, a crash and a failed install each report their own reason.
The Worker bundles gained a Text-module rule for `.py` imports and the Node
test run a matching Vite plugin.

The instruction-file probe rides only the two reads: the
`read_file` page read and the read an `edit_file` starts with. It reports what
it finds and the instructions arrive with that batch. `write_file`,
`apply_patch`, `run_command` and `import_resource` carry no probe and pay no
probe command; the `abort` mode, exit 52, the `instructions_pending` and
`instructions_unavailable` refusals, the `instructions.probe` utility
operation, and the system message's sentence about a refused mutation are
gone. This reverses the gate half of the 2026-09-09 entry below; discovery,
recording, delivery and the bootstrap's root probe are unchanged.

**Why:** In the same run, GPT-5.6 answered a tool named `apply_patch` with
the format it was trained on, was refused, then wrote two unified diffs from
memory whose context no longer matched, and fell back to `edit_file`. The
model's format has no line numbers and matches on context, which is the more
forgiving of exactly that mistake, so accepting it fixes both failure modes,
and the reference applier is the one implementation the training distribution
was built against; a re-implementation in this repository would drift from it.

The gate fired on the first action of nearly every fresh agent,
because that action is a mutation more often than not: a `run_command` used
for discovery, a `write_file`, an import. In the "Avalon scroll gradients"
substream of 2026-09-18 both the parent and its background agent paid it, and
the parent's refused call was the one that had also carried the 57-second
sandbox boot. The decision on 2026-09-19 was that a repository's instructions
load as a side effect of reading, and that a mutation is never refused for
them.

**Considered and rejected:** Renaming the tool to escape the model's prior:
the prior is also for the format, and the name is the one the 2026-09-18 entry
chose deliberately. Re-implementing the applier in TypeScript: smaller to ship
than a vendored script plus a Python dependency, but every divergence from the
reference would be a patch the model wrote correctly and Rally rejected.
Embedding the script as a TypeScript string like the two probe scripts: it
would no longer be the file as shipped, which is the whole point of vendoring.

Keeping a report-mode probe on mutations, so a
write beneath an unread file still delivers the file one batch later. The two
tools that cannot carry the fragment would still pay a probe command each, and
the read that precedes an edit already delivers the same files. Injecting the
root file at sandbox acquisition instead of on the first read: cheaper still
for the root, but it does not reach a nested `AGENTS.md`, and the read path
covers both.

**Consequences:** A `.py` file under `apps/api/src` is now text to the
bundler and to Vitest; a script that should run in the Worker must not take
that extension. The first envelope patch in a fresh sandbox pays a PyPI
install inside the command's 60-second budget, so a slow network can turn it
into a timeout the retry survives. Updating the vendored script means updating
the hash and re-checking the stdin, `Done!` and exit-0 contract the runtime
reads.

A whole-file write, a patch, a command or an import beneath
a file no read has touched proceeds without its instructions; the next read
delivers them. The Terminal prompt's rule to read a file before editing it is
now what puts a file's instructions in context before the edit, so weakening
that sentence weakens this. `apps/api/test/terminal-runtime.test.ts` pins that
a write is not refused and that the read records the chain.

### 2026-09-19 — Terminal sandboxes are built at 2 vCPU / 4 GiB / 8 GiB

**What changed:** `TERMINAL_SNAPSHOT_RESOURCES` in `snapshot-manifest.ts` gives
the Rally-owned snapshot 2 vCPU, 4 GiB of memory, and 8 GiB of disk, and
`build-terminal-snapshot.ts` requests it and fails the build when the snapshot
Daytona reports back is smaller in `cpu`, `mem`, or `disk`, deleting the rejected
candidate first so repeated failures do not accumulate unusable snapshots. A
field the provider rounds up is printed rather than rejected, so a runner minimum
cannot take the weekly rebuild red over an image that works. Nothing about how a sandbox is created changes; the weekly rebuild
carries the size into the next adoption pull request.

**Why:** Every Terminal sandbox had been running at 1 vCPU / 1 GiB / 3 GiB — not
a decision, but Daytona's default for a build that passes no `resources`, which
is what every snapshot through `rally-terminal-20260914-0610` was built with. One
core and a gigabyte is a thin allowance for what the plugin prompt tells the
model to do in there — install a toolchain, check a repository out, run its
tests — and the snapshot is where that is decided, because its size is fixed when
the image is built and every sandbox made from it inherits that. (`Sandbox.resize`
can grow one live sandbox, but nothing in Rally's create path calls it, so it
remedies a sandbox rather than setting what new ones get.) 2 / 4 / 8 is the team's number, chosen
rather than measured; it matches Daytona's own `daytona-medium` shape instead of
being a lopsided one.

**Considered and rejected:** Sizing at sandbox creation instead, which would let
the number change without a rebuild. The SDK accepts `resources` only when
creating *from an image*, so taking it would mean giving up the prebuilt snapshot
and paying the ~14s capability install on every cold start that the owned image
exists to avoid.

**Consequences:** Per-sandbox memory now costs 4x against the Daytona
organization's quota, so the ceiling on concurrent Terminal work streams drops
by roughly the same factor; that ceiling is the provider's to raise when it is
reached. The new size reaches production only through a snapshot rebuild, so
`wrangler.global.jsonc` keeps pointing at the 1 GiB image until an adoption pull
request merges, and sandboxes already created stay at the size they were made
with. A future change to these numbers has to stay in this manifest: the weekly
job builds from the repository, and a size configured anywhere else is reverted
by the next adoption pull request without anyone noticing.

### 2026-09-19 — A sandbox belongs to a conversation, its agents share it per tool call, and a Sidekick's is retired by Daytona

**What changed:** Three things, in the order the branch found them.

The sandbox is scoped to a conversation rather than a work stream, and a
background agent uses the sandbox of the conversation that (transitively)
started it. `authority.ts` resolves that once at plugin composition from
WorkspaceDO's delegation records and binds it into the Terminal port factory;
the port and the generic object ports now read an explicit substream as
"exactly that conversation" and no substream as "the conversation this run
executes in", so a factory bound to the owner's conversation leaves a
background agent's object over the wire. A side thread's Daytona name folds
its substream in while the main conversation keeps the derivation every
deployed sandbox was created under. `terminal_workspace` gained
`operation_run_substream_id` (conversation schema 63): the claim SQL reads
holder liveness from `runs` only for a holder that ran in this object, the
task fences do the same, and the coordinator takes over a holder that ran
elsewhere only after that conversation's own harness-run authority says it
yielded, naming the exact holder. `WorkstreamDO` forwards the earliest
Terminal deadline of any conversation under it and lists them
(`childTerminalDeadlines`); the workspace sweep and the settings policy
application reconcile each conversation's sandbox, the policy application
asking the main conversation whatever the parent lists, and the Daytona
webhook routes by a `rally.substream` label.

The operation lease is claimed at the start of each write tool call and
released when the call ends; the per-run cache holds the readiness handle
only, and a claim that finds the row moved on re-runs readiness. `read_file`
takes no lease: `peekRunning` hands it the sandbox when the row is running and
the authority fingerprint is the caller's, and falls back to readiness
otherwise. `releaseOperation` is new and fenced on the exact holder, and it
keeps the lease while the holder has an unsettled command on the generation;
the claim's takeover fence ignores the claimant's own unsettled tasks, and
every claim stamps `last_command_at`, which the lifecycle sweep reads as
activity inside the warm window. Both lease operations are non-directory. A
release that fails is attempted once more and then logged with its reason
rather than swallowed. The `sandbox_busy` guidance tells the model to retry
in seconds.

`TerminalRunScope` carries the conversation's parent kind, and
`createReservedSandbox` passes `autoDeleteAfterStoppedMinutes`, Rally's
thirty-day expiry in minutes, to the provider for a sandbox whose parent is
an automation; the Daytona provider maps it onto `autoDeleteInterval`, which
stays disabled when the field is absent. Nothing else about a Sidekick's
Terminal changed: the authoring conversation has a sandbox of its own and
every triggered run, being a conversation of its own, provisions a fresh one,
as before.

Review of the pull request found what the first cut left open, and this entry
records it with the rest. A row a side thread or agent reserved before a
sandbox belonged to a conversation, under the work stream's one name and
holding the main conversation's sandbox, is recognised by its name and dropped
without a provider call rather than reused, swept or policy-applied. A run's
write calls take turns in the runtime, since the lease is re-entrant for a run
and the harness overlaps a turn's calls. `edit_file`'s write carries the
digest of what it read and the replacement is fenced on it in the sandbox. A
read joins this run's readiness before it peeks, and the peek makes the checks
readiness makes: fingerprint, revoked import, repository bootstrapped into the
generation. An import records the conversation whose attachment authorized it
(conversation schema 64) and the revocation check asks that conversation. A
background agent refuses with `sandbox_authority_mismatch` rather than replace
its owner's sandbox. `terminal_tasks` no longer keys the run and the receipt
to this object's own tables (schema 65), so a background agent's command
records its task in its owner's object. Composition catches an unresolved
authority and takes only Terminal away, logged as
`terminal_authority_unresolved`. A failed release is attempted once more and
then logged. A holder from another conversation counts as live, for the
fences that settle and renew its own command, while that command is
unsettled, not only while its lease is: a command may run longer than the
sixteen-minute lease, and only the run that submitted it can settle it.

**Why:** Terminal was documented as one sandbox per work stream, but its rows
had followed the conversation into the object: a background agent's Terminal
port resolved to the agent's own tables, reserved the work stream's stable
name, and, because Daytona names are unique, was handed the main
conversation's sandbox by the create-then-lookup fallback, under a second,
independent lease and lifecycle. Two authorities over one sandbox, neither
seeing the other's commands, and the agent's never swept. Sharing was the
product intent; it had to become a decision rather than an accident.

Once it was one, the run-long lease meant a sibling background agent could do
nothing at all, reads included, until the holder's whole run yielded, and the
first sibling to load Terminal took the lease at activation for the length of
its run. The lease's three jobs were separated: exclusivity for file mutation
is a per-call need, exclusivity for whole-sandbox transitions is unchanged and
still taken by readiness, checkout, policy application and the sweep, and the
durable command receipt is keyed to the holder by the retained-task rule
above rather than by the run never releasing.

The lifecycle sweep finds a sandbox through the Terminal deadline a work
stream's parent projects into the workspace directory. An automation forwards
no child effect and its directory row has no Terminal deadline, so no sweep
has ever stopped, archived or deleted a Sidekick's sandbox, and Daytona was
told never to delete one either: every triggered run that used Terminal left
an archived sandbox behind for good. The sandbox per run is kept on purpose,
one box per run being the simplest shape and the one that matches each run
being its own conversation; what was missing was an end to its life.

**Considered and rejected:** Carrying the owning conversation in
`WorkstreamWorkflowInput` or a child column instead of reading delegation at
composition: cheaper per run, but a second copy of an ownership fact
WorkspaceDO already owns. Making `WorkstreamDO` aggregate every child
projection: a side thread's title or state is its own affair; only the
deadline crosses. A sandbox per agent loop rather than one shared with the
conversation's agents: the runtime assumes one root for path containment,
publish paths and the instruction probe, and the shared files are the point
of delegation.

Keeping the run-long lease, which the first cut of this change did with a
`sandbox_busy` wait for a sibling: it serialized whole runs where the
corruption the lease exists to prevent is two calls mutating one checkout at
once. Releasing unconditionally and letting a successor recover a holderless
retained task: recovery is keyed to a yielded holder, so a lease nobody held
over an unsettled command would be one no linked run could ever recover; the
sweep would eventually quiesce it, but only at a deadline. Refreshing
`idle_expires_at` on every claim instead of stamping `last_command_at`: the
deadline is projected to the workspace directory, so that would have been a
projection envelope and a workspace write per tool call. Concurrent commands,
so a sibling can edit while another's tests run: not taken; a command holds
the lease for its duration, which is also what keeps a sibling from editing
the files a running test is reading. Per-agent git worktrees inside the shared
sandbox, which would remove file conflicts rather than serialize them: the
runtime assumes one root, so that is a separate piece of work.

Teaching the sweep about automations, with a Terminal deadline projected from
`SidekickDO` and a column on the automation directory: the sweep's machinery
(deadline aggregation, directory projection, a per-conversation reconcile) for
a sandbox that is used once and never reopened is more than the product
needs, and Daytona already has the timer. Sharing one sandbox across a
Sidekick's runs so a checkout survives between them: a run's sandbox sits
under the run's own authority fingerprint, and sharing it would need the
ownership walk background agents got, for a benefit nobody has asked for. A
shorter retention for a run's sandbox than a work stream's: that is a limit
with a number of its own, and the number is the team's to set, which the
constant's comment says.

A migration clearing every non-main conversation's `terminal_workspace` row
instead of recognising a legacy row by its name: the object cannot tell in SQL
which conversation it is without a read the migration runner does not make,
and a row that is not legacy would go with the rest. Keeping the task table's
foreign keys and recording a background agent's task in the agent's own
object: the lease fence, recovery and settlement all read `terminal_tasks` on
the sandbox's own object, and a task elsewhere is one none of them can see.
Binding the resource port to the sandbox's conversation for every import
rather than recording each import's conversation: an agent imports what its
own conversation has attached, which the owner's conversation need not hold.
Serializing a run's writes in the object rather than in the runtime: every
call of a run executes in the one isolate, and a durable turn would be a write
per call for a fact the isolate already knows.

**Consequences:** A conversation and the agents it starts share one
filesystem, one checkout, and one exclusive lease, and they interleave at
call granularity: `sandbox_busy` lasts one call or one command, a read can
observe another run's write in progress, and a background agent's
`run_command` is fenced by its lease deadline rather than by a run row the
owner's object cannot see. A run between two calls holds nothing, so the
sweep's idle decision rests on `last_command_at` rather than on a live
holder; a sandbox whose run died mid-call is freed by the sixteen-minute
deadline as before, and so is one whose release failed twice, which the log
names. The activation pre-warm still starts the sandbox in the
background but releases the lease when its readiness settles, so a sibling is
no longer blocked by an activation that happened to come first. The sweep's
directory entry for a work stream is now the earliest of several
conversations, so one due entry may reconcile several sandboxes. A side
thread's sandbox created after a policy application listed the parent's
children is missed by that application and converges at its next claim. The
desktop's per-work-stream Terminal card still reads the main conversation's
sandbox; a side thread's is reachable only through the sweep, the settings
policy application, and its own runs.

A Sidekick's sandbox stops fifteen idle minutes after its last command on
Daytona's auto-stop rather than the sweep's five, is archived by Daytona's
sixty-minute auto-archive, and is deleted thirty days after it stopped. A
sandbox created under an automation before this change keeps auto-delete
disabled and stays until somebody deletes it at Daytona. A workspace
network-policy change still does not reach a Sidekick's sandboxes, since the
policy enumerator walks the same work-stream directory; a run's sandbox is
created under the policy current at its start, which for a once-used sandbox
is the policy it runs under throughout.

A run between two calls holds nothing, so the sweep can stop its sandbox after
five idle minutes mid-run, which the run-long lease prevented; anything left
running inside does not survive, and the next call starts the sandbox again.
Two write calls of one run no longer overlap. An edit of a file another call
changed answers `file_changed` and writes nothing. A background agent whose
authority differs from its owner's is refused until the owner's next call.
Rows that side threads and agents reserved before this change are dropped on
first contact and their conversations reserve their own names, with the main
conversation's sandbox untouched.

Pull request: [#849](https://github.com/juno-ai-labs/avalon/pull/849).

### 2026-09-18 — Terminal's tools take the names the model already knows

**What changed:** `rally:terminal` declares an empty short wire name, so its
nine tools reach the model as `read_file`, `edit_file`, `write_file`,
`apply_patch`, `run_command`, `checkout_repository`, `import_resource`,
`publish_resource`, and `publish_branch_and_pr`. The plugin system message, the
tool descriptions, and every runtime remediation string that names a tool
(`runtime.ts`, `tools.ts`, `repository.ts`, the resident-context instruction
blocks, and the attachment contracts) were updated with it. The tools themselves,
their capabilities, modes, idempotency and timeouts are untouched.

**Why:** `read_file` and `run_command` are among the most heavily represented
tool names in any model's pretraining, and `terminal_` pushed all nine off that
vocabulary for a namespace that was distinguishing them from nothing. This is
the third design test in `docs/agent-tools.md` — does every name match what the
model already learned — and Terminal was the plugin failing it hardest.

**Considered and rejected:** Widening Bind's duplicate-wire-name check from core
plugins to every plugin as part of this. It was proposed and explicitly declined
in favour of the smaller change, so read the consequence below as a known,
accepted gap rather than an oversight.

**Consequences:** Terminal is the first *loadable* plugin with no prefix, and
Bind's duplicate-wire-name guard (`bind-runtime.ts`) covers core plugins only.
Two loadable plugins advertising the same wire name resolve to whichever sorts
first by canonical id, with nothing raised — so `read_file`, `run_command` and
the other seven are now a standing claim, and the next plugin that wants one has
no mechanism stopping it from taking it. Check by hand, or widen that guard when
a second unprefixed loadable plugin is proposed. Separately, these nine tools had
no `AVALON_TOOL_PROSE` entry and were rendering in the transcript as the
humanized wire name ("Terminal run command"); they have real prose now, keyed
under both spellings, because a durable tool event stores the name it was called
under and old and new rows for one action would otherwise read differently in the
same feed.

### 2026-09-14 — Preserve Daytona identity through archive and error recovery

**What changed:** Provider snapshots carry Daytona's recovery verdict, the
provider Worker exposes `recoverSandbox`, and acquisition recovers recoverable
errors without replacing the generation. Shared stop/delete reconciliation
reconciles explicit deletion against metadata. Unexpected metadata absence
preserves the binding, and restore/recovery independently check command and
file readiness before admitting work. Healthy acquisitions use the requested
operation itself to establish availability, avoiding two extra requests per run. Scheduled cleanup adopts provider
archival and confirms asynchronous archival before recording completion.
Provider observation now has its own persisted ordering and freshness, shared by
acquisition, signed webhook readback, and periodic workspace scheduling. The setup
command provisions Svix through Daytona API-key authentication and seeds refresh
for existing provider sandboxes. Endpoint upserts explicitly carry their UID
and subsequent secret/readback calls use the returned endpoint ID; Svix does
not assign a path UID to an omitted body field.

**Why:** PR #740 restored archived sandboxes correctly but equated every error
with permanent loss. Its replacement path could delete a recoverable filesystem
and abandon an identity after failed deletion. Existing cleanup also treated a
runner `404` as sandbox deletion and trusted archive submission as completion.
Retention deadlines alone left the internal view stale between tool calls; an
archived sandbox could remain labelled running for weeks. Live archive tests
also reproduced toolbox 404s while metadata remained 200, including approximately
29 seconds after a successful start. A fresh SDK object showed the same failure;
replacing the workspace or adding a guessed sleep would not model readiness.

**Considered and rejected:** Reverting the whole PR would remove necessary
provider read-back and independent site import support. Adding another retry
loop or copying archived files to Rally storage would duplicate Daytona's own
lifecycle instead of honoring its recovery and persistence contract. A successful start response is not a
substitute for checking both command and file availability during restore.
Preflighting every healthy acquisition was also rejected: it adds two sequential
round trips when the requested operation can establish its own availability.

**Consequences:** Restore and recovery keep the same ID and generation. Unknown
recoverability fails closed; only an explicit loss verdict permits automatic
replacement. Provider lookup failures cannot authorize deletion. The original
2026-09-13 entry below records the superseded all-errors-are-lost policy.
Webhook setup is a deployment step, and observed state is explicitly timestamped.
Periodic reconciliation pays one metadata GET per retained sandbox per minute,
even when no lifecycle transition is due; webhooks add two GETs (routing then
ordered readback). We accept this simple polling cost to recover missed events
without introducing a routing index or a second state machine.

Pull request: [#774](https://github.com/juno-ai-labs/avalon/pull/774).

### 2026-09-13 — Acquisition asks Daytona what the sandbox is, and replaces one it has lost

**What changed:** `TerminalSandboxCoordinator.acquire` no longer branches on
`lifecycle_state` for a row that already names a sandbox. It reads the provider
state back once per acquisition, before any other provider call, and drives from
that — use `running`, start `stopped` or `archived`, retry everything else, and
replace a sandbox reported `expired`, `failed`, or absent by bumping the
generation through `replaceGeneration` and provisioning its successor under the
same lease. The replacement emits `terminal_sandbox_replaced_after_loss` and a
`start_fresh` acquisition action. A start that throws re-observes before
deciding, so a restore still in flight is a retry rather than a discarded
workspace, and provider failures leave acquisition as a typed
`sandbox_unavailable` instead of Daytona's own text. `sandboxState` now names
all twenty-two states the Daytona SDK publishes and answers `unknown` for
anything it does not, so the mapping's fallback is no longer a verdict.

**Why:** A work stream that published a site could never update it again. The
row said `running` while Daytona had auto-archived the sandbox, archiving
releases the runner, and every file and command call answered `404 Sandbox with
ID … does not have a runner`. Nothing recovered: the raw provider error went to
the model, which reported a platform outage and advised waiting, and an
`archived` row has no pending deadline for the lifecycle pass to act on, so the
dead id survived to the thirty-day expiry. The two schedules were always going
to diverge — Rally stops at five minutes and archives at sixty, Daytona stops at
fifteen and archives at sixty on its own clock — and the row was being trusted
as though only Rally could move the sandbox.

**Considered and rejected:** *Reporting the loss and letting a participant start
fresh*, which is what the error strings have always said to do — except that
`startFresh` is behind no route and refuses any state but `expired` or `failed`,
so the advice named a repair nobody could perform. *Replacing on any failed
start*, which would discard a workspace for a restore that merely outran its
own deadline. *Trusting the row and retrying the tool*, which is the behavior
this replaces.

**What a future change has to respect:** the read-back is one provider GET per
acquisition — once per harness run, not once per tool, because the run-local
acquisition cache still holds — it happens before anything else touches the
provider, and every branch below it decides from the observed state rather than
the row. **Replacement is entered only from states Daytona reports as
destroyed or errored.** Review caught this the wrong way round: the state
mapping collapsed thirteen of Daytona's twenty-two states into `failed`, so a
tool call landing inside the auto-stop or auto-archive this document describes
would have deleted the workspace a retry five seconds later would have restored
— the recovery causing the loss it exists to prevent. A new provider state is
therefore added to the mapping deliberately or it arrives as `unknown` and
waits. A replacement is destructive by design: it costs the run its scratch
files, which is acceptable only because nothing durable lives solely in a
sandbox. If that ever stops being true — a file the product cannot reconstruct
from R2, the repository, or the final diff — this path needs a preservation step
before `replaceGeneration`, not a quieter failure.

### 2026-09-11 — A work-stream Sidekick publishes into the room that owns it

**What changed:** `createTerminalResourceBridge` takes a
`publicationWorkstreamId`, threaded from the automation definition's
`owningWorkstreamId` through `createAvalonTerminalPlugin`. When set, it is the
work stream in `terminal:<workstream-id>:<path>`, the target of the resource
link, and the `workstream_id` on the artifact registry row. It is null for
personal and workspace-scoped automations and for every ordinary run, which
publish into their own conversation exactly as before.

**Why:** A work-stream-scoped Sidekick's run executes in its own conversation
under the automation, so `context.workstreamId` was the automation id and the
publish identity was `terminal:<automation-id>:<path>`. That can never collide
with the room's `terminal:<room-id>:<path>`, so a Sidekick told to refresh a
document the room already had created a private copy at version 1 on its first
run and re-created nothing after that. Found in production: an hourly PR
dashboard reported a successful refresh every run while the copy in the room's
sidebar stayed frozen at the version an interactive run had left there, and the
`resource://` embed in each delivered result rendered as bare label text because
the room could not resolve a resource that was never linked to it.

**Considered and rejected:** *linking the Sidekick's copy into the room at
delivery*, which makes the embed resolve and leaves the fork — the room would
then carry two documents with the same title, and the next refresh would still
miss the one a person had open. *Redirecting `context.workstreamId` wholesale*,
which would also move the sandbox and the readable-resource set into the room
and is a much larger change than the defect needs.

**Both links, not one:** a redirected document is linked to the owning room
*and* to the conversation that produced it. Visibility is resolved from the
links the run's own object holds (`loadVisibleRows` starts at `attachedLinks`),
so a document linked only to the room is one its own run cannot read back —
`publish_resource` followed by `import_resource` on the id just returned would
answer `resource_not_found`, and "publish a refresh, then diff it against the
last one" is the natural shape of the work these Sidekicks do. The room is where
the document belongs; the producing link is what keeps the round trip working.

**The carve-out:** an internal capture is not redirected. A command log
(`terminal-command-log:<effect-intent>`) and a checkout backup name their own
namespace through `providerResourceId` rather than deriving one from a path, and
they are recovery artifacts a run never chose to deliver. Redirecting them would
put raw command output — the output the Sidekick's delivered result deliberately
left out — in the owning room's resource list. The redirect therefore keys on the
same condition the identity does: a publication that supplies its own
`providerResourceId` stays in the conversation that produced it.

**What a future change has to respect:** the redirect is publication only. A
Sidekick and its owning room now share one publish namespace, so two Sidekicks
owned by the same room that publish the same path share a document — that is
the intended reading of "same path, same document" and is why the path is
normalized, but it means a Sidekick cannot assume a private path. Existing
forked resources are left where they are; this fixes forward rather than
migrating rows, so a room that already has a fork keeps it until someone
deletes it.

### 2026-09-11 — The recovery backup is reachable without being advertised

**What changed:** `createTerminalWorkspaceBackup` marks its archive unlisted, so
it leaves the artifacts rail, `list_resources`, the compaction inventory, the
`resource_attached` socket event and search, while keeping its work-stream link
and therefore the by-id paths the checkout receipt and `terminal_import_resource`
use. WorkspaceDO migration 52 marks the backups already written. Final-diff
preservation is unchanged.

**Why:** Checkout cannot replace a repository in place, so it archives the
workspace it is about to delete. That archive was attached as an ordinary
generated resource — the only durable byte store to hand — and so was presented
as a deliverable: a 21 MiB `application/gzip` in the rail beside real output,
and a row of the model's inventory for something `model_content_status =
'unsupported'` already says it cannot read.

**Considered and rejected:** Not attaching it — `importResource` resolves only
attached resources, so the restore path goes with the rail entry. Moving the
archive out of the resource graph into Terminal's own state — reimplements R2
staging, cleanup fencing, download and import for one producer. The rejected
alternatives for the flag itself are in `agent-attachments.md`.

**What a future change has to respect:** A Terminal capture nobody asked for is
unlisted; one that is the work's own output is not. The distinction is the
producer's to make at the insert, not a filter a reading surface applies, and
the backup must stay attached — unlisting is not detaching, and detaching it
would make the archive unrecoverable.

### 2026-09-10 — The network policy gets its own settings page

**What changed:** **Terminal network access** left the Workspace preferences
pane for an **Internet access** page indented under it. The `internet-access`
section owns the four Terminal definitions, and the
`terminal-workspace-settings` read is gated on that section rather than on
`workspace`.

**Why:** Choosing **Full internet** and confirming it stops every running
sandbox in the workspace. That flow had been sitting between the default
timezone dropdown and the invitation form, where a reader scrolling for
something else meets it by accident and where its own review-and-confirm step
reads as one more preference row.

**Considered and rejected:** A sub-heading inside the Workspace pane, which
leaves the destructive control one scroll from the invite form and keeps the
Terminal read firing for anyone opening Workspace to change a timezone.

**Consequences:** The policy is deep-linkable on its own
(`?section=internet-access`), and its read no longer runs when Workspace opens.
Anything else that becomes a workspace-wide network decision belongs on this
page rather than back in preferences.

### 2026-09-09 — A checkout's own instructions are read without being asked

**What changed:** Every Terminal tool that takes a path probes the `AGENTS.md`
chain from the work-space root down to that path inside its own sandbox
command: after a read, and before a mutation in abort mode, where a file not yet
in context stops the command with exit 52 and the tool returns
`instructions_pending` having changed nothing. `run_command` (its `cwd` chain)
and `import_resource` (its destination) probe in one command of their own first.
`bootstrapTerminalRepository` probes the root after the checkout, for `cloned`
and `refreshed` alike, isolated from its `set -euo pipefail`. What the probe
finds is recorded in the conversation's context-residency ledger through the
new `residentContext` object-port authority, and `terminal_checkout_repository`
retires every block when it replaces the work space. The plugin system message
gained one byte-stable sentence saying what an `Instructions added from` message
is and how far it reaches.

**Why:** A repository that carries an `AGENTS.md` expects it to be read, and
Rally read it only when the model happened to. The probe rides the tool's own
command because a second round trip per touch would have been paid on every
read; the exceptions are the two tools whose commands cannot carry it. A
mutation waits because a rule that forbids an edit is worthless if the edit
that discovers it has already run. Delivery, residency, and compaction are the
ledger's, in [`resident-context.md`](resident-context.md).

**Considered and rejected:** A `terminal_read_instructions` tool (turns
automatic back into "if the model remembers"); delivering the content inside the
tool result (the same file would have two shapes and less salience than every
other derived input); making `terminal_checkout_repository` clone before it
returns so its result could carry the root (holds the model for the clone,
which non-blocking activation exists to avoid).

**Consequences:** Anything that adds a path parameter to a Terminal tool decides
whether that path feeds the chain and whether the tool mutates. The bootstrap
command's tail is now load-bearing for the probe's isolation; a change that
moves the fragment inside `set -e` fails every checkout without an `AGENTS.md`.
The two limits in `blocks.ts` are open and the PRD says the change does not
ship until they are set.

### 2026-09-08 — The workspace root is a legal working directory, and the tools say where the root is

**What changed:** `safeRelativePath` accepts `.` and `./` as `cwd` (the
runtime's default, the workspace root) instead of refusing them as
`path_outside_root`; a `filePath` that names the root is refused as
`invalid_path` with its own message. The `path_outside_root` error now echoes
the refused value, gives two accepted examples, and says to omit `cwd` for the
root. The nine tools' path descriptions say "relative to the workspace root"
rather than "workspace-relative", `cwd` says how to name the root, and
`publish_resource` says in both its description and its `not_found` error that
it alone resolves against `$AVALON_RESOURCE_DIR` (`/workspace/.rally-output`).
The Terminal system message gains one sentence naming `/workspace` as the root
and `$AVALON_RESOURCE_DIR` as the one exception. Review of the adopting pull
request (#606) added: the refusal names the root the parameter is relative to,
so a refused `publish_resource` path is pointed at the output directory rather
than the workspace root; it names the parameter the tool actually has
(`destinationPath` for imports, the patch itself for `apply_patch`); an empty
`cwd` is accepted like `.`; the echoed value is cut to the path schema's
4,096 limit and passed through `sanitizeTerminalOutput`, since it reaches the
transcript; and `/workspace` and `/workspace/.rally-output` are exported once
from `contract.ts` and used by the runtime and the coordinator, with the
prompt's literals pinned to them by test.

**Why:** A recorded document-generating run (2026-09-08, `gpt-5.6-terra`)
wasted eight of its twenty-six tool calls on this. The model sent `cwd: "."`,
`"./"`, and `"<file>/.."` to name the root and was refused four times; the
message said to use `/` separators and no `..`, which it had already done, so
it read as confirmation and the model retried, then guessed `work`, `tmp`, and
`workspace` as directory names until a `cd` failure leaked the real root. It
then published a file it had written under the workspace root and got
`not_found`, because publication resolves against the output directory and
only the publish side said so. Each failed call is a full model round trip,
about nine seconds here; the run was four minutes. The normalization treated
an empty result as an escape, but the boundary checks (`..`, a leading `/`,
backslash, NUL) run separately and the sandbox re-checks with `realpath`, so
accepting the root weakens nothing.

**Considered and rejected:** Stating the root only in the system message. The
error is what the model reads at the moment it is wrong, and
[`agent-tools.md`](agent-tools.md) records the same retry loop for a blank
cursor: an error that names neither the offending value nor the accepted form
is retried. Truncating the echoed value with a new cap: the schema already
bounds it at 4,096 bytes, so no new limit was needed.

**Consequences:** `cwd: ""` and `cwd: "."` reach the runtime as an omitted
`cwd`. Anything that adds a path parameter to a Terminal tool states which
root it is relative to in the parameter's own description and passes that root
to `safeRelativePath`, so its refusal names the right one. The one-root rule
is stated once in the system message and the exception once. The Terminal
system message is asserted verbatim in `terminal-contract.test.ts`, and its
directory literals are pinned to the exported constants, so a wording change
edits both and a moved directory fails the test rather than the prompt.

### 2026-09-08 — Configured deployments create sandboxes from the Rally-owned snapshot

**What changed:** `DAYTONA_TERMINAL_SNAPSHOT` is `rally-terminal-1` in both
regional Wrangler configs. The snapshot was built by `terminal:build-snapshot`
from `daytonaio/sandbox:0.9.0` on the Juno AI Labs Daytona organization
(created 2026-09-07T15:27:23Z, region `us`), and `terminal:verify-provider`
passed against it the same day; its `sandbox_bootstrap` measurement was
`install=225ms verify=1782ms installed=none`, the bootstrap finding all four
managed capabilities present and installing nothing, against ~14.4s when they
are missing. Review of the adopting pull request (#597) changed seven more
things in the same change: the per-run operator notice on activation failure
and its unset rate limit are gone; the manifest ids a failed verification names
now travel on the `sandbox_bootstrap` measurement as `missing_capabilities`;
the `git-ca` probe is required rather than optional for a sandbox created with
a domain allow list; `checkout_repository` lets an in-flight activation
acquisition settle before replacing the generation it is preparing;
`discardPreparation` is deleted; the base image is pinned in
`snapshot-manifest.ts` with `TERMINAL_SNAPSHOT_BASE_IMAGE` demoted to an
override; and the rebuild workflow reads its dispatch input through the
environment, validates the name, commits the two configs by path,
minute-stamps its default name, and opens its pull request with
`TERMINAL_SNAPSHOT_PR_TOKEN` when one is configured. The build stamps each
Dockerfile with a build time.

**Why:** This reinstates the adoption that "Stay on daytona-small until a
snapshot can pass the acceptance gate" reverted on 2026-09-05, now with the
evidence that revert said was missing. The gate had only ever been run against
a personal Daytona account on a tier that rejects every post-creation network
update, so its policy-update step failed on every snapshot; the Juno
organization accepts them, and the gate's stop → update → read-back → start
sequence passed. The `git-ca` probe (the entry below) no longer fails
full-internet sandboxes, which had hidden the earlier custom snapshots' real
state. Each review change closes a gap the diff had opened. The notice would
have posted once per failing run for the length of a provider outage, against
[`ops-alerting.md`](ops-alerting.md)'s one-notice-per-episode rule, and a
module-level gate in a per-work-stream object cannot dedupe across runs
anyway. The failed-capability list was discarded by the coordinator's catch,
so a snapshot that lost `gh` still reported only that verification failed. A
Trusted-only sandbox without its advertised CA passed the optional probe and
would have failed at its first Git operation. With activation no longer
blocking, the model's first tool can be `checkout_repository` while
activation's own repository bootstrap is still cloning into the same sandbox;
evicting the cached acquisition and replacing the generation at that moment is
two operations on one sandbox, which the blocking version could never produce.
The workflow interpolated a
dispatch input into shell in a job holding the Daytona key, and a pull request
opened with `GITHUB_TOKEN` runs no CI, which for the one automated change to
configured deployments' production config meant merging ungated.

**Considered and rejected:** Landing the branch first and letting the weekly
rebuild open the adoption pull request: two merges for one outcome, and the
workflow only exists once this branch is on `main`. Adopting the date-stamped
name the workflow will produce instead of `rally-terminal-1`: the verified
artifact is this one, and the next Monday rebuild replaces it through its own
pull request. Keeping the operator notice behind a durable once-per-episode
gate: no call site needs that table yet and the first Terminal tool already
carries the failure to the model; add the gate if the warn rows show outages
nobody noticed. Making the expiry sweep reclaim a sandbox reserved before its
id was recorded, the shape an acquisition abandoned at run end leaves: the
started/finished pair shows whether it happens and the next acquisition adopts
the sandbox by stable name, so the sweep waits for evidence.

**Consequences:** Daytona keys built images by Dockerfile content: the first
build's image reference was the SHA-256 of the Dockerfile, it returned
`active` in one second with an empty build log, and its reported size was
roughly double the base's, so an image built earlier from the identical
Dockerfile was reused. The build-time stamp forces a real build each time;
whether Daytona's builder re-pulls a moved base tag on that build is
unconfirmed, and a rebuild that finishes in seconds should be read as a reused
image. The operational configuration the rebuild needs is under Operations.
Adding a manifest probe now has to hold for both network modes, and a
Trusted-only sandbox whose CA Daytona did not advertise fails closed at
creation rather than at `git clone`. The two production paths the 2026-09-05
revert flagged as failing under the rejecting tier — `reconcileNetworkPolicy`
on acquisition and the settings rollback — succeed on the Juno organization
and were not changed; a return to a rejecting tier would surface them again.

### 2026-09-03 — The Git CA probe stops requiring what Daytona only sometimes gives

**What changed:** The `git-ca` manifest probe now verifies the advertised CA
bundle only when `CURL_CA_BUNDLE` is set, instead of requiring it. Provider
failures also name the capabilities that failed, and `clearReadSecrets` no longer
aborts a sandbox deletion when the credential cannot list secrets.

**Why:** Daytona advertises its proxy CA only to sandboxes created with a domain
allow list. A full-internet sandbox is not intercepted and needs no extra trust,
so the unconditional requirement failed every such sandbox — on **every**
snapshot, the managed `daytona-small` included. Two consequences followed. No
snapshot could pass the acceptance gate, which is what made a custom snapshot
look broken for two days; and, more seriously, any workspace on full-internet
Terminal networking could not create a sandbox at all, because `acquire` passes
an empty allow list in that mode, the probe rejected the result, and the
coordinator discarded it.

The probe was stricter than the code it protects:
`terminalGitCaSetupCommands({ required: false })`, which the repository bootstrap
actually runs, already wires Git to the bundle when one is advertised and accepts
its absence otherwise. The probe now matches that contract.

The two provider changes came out of the same investigation. The verification
failure discarded stdout, so a snapshot that failed reported only that
initialization failed while the probe had already named every missing capability
— that diagnostic is what finally identified `git-ca`. And `deleteSandbox` called
`clearReadSecrets` first, whose unguarded `list` answered 403 for a credential
without the Secrets scope, so the sandbox was never deleted: a live filesystem
left accruing cost because tidying its secrets failed.

**Considered and rejected:** Creating the probe sandboxes with a Trusted-only
allow list so the CA is always present. That would make the gate prove something
narrower than what runs — full-internet sandboxes are a supported mode, and a
gate that never exercises them is how this reached production. Removing `git-ca`
from the manifest entirely: an advertised-but-broken bundle is a real failure and
still fails closed.

**Consequences:** The manifest now encodes that the CA is conditional on network
mode, so anything added here must hold for both modes. A full-internet workspace
can create Terminal sandboxes again. The `required: true` form of
`terminalGitCaSetupCommands`, used by the trusted publisher, is untouched and
still demands the bundle — whether publication can succeed from a full-internet
workspace is a separate question this change does not answer.

### 2026-08-30 — Terminal activation starts the sandbox without holding the model

**What changed:** `onActivate` no longer awaits `runtime.prepare`. It starts the
acquisition, registers the shared per-run promise every Terminal tool already
awaits, and returns; the completion log is emitted when that promise settles.
Activation therefore always succeeds — a provider failure now surfaces on the
first tool that needs a sandbox rather than as a
`HarnessPluginActivationError`. A repository that cannot be prepared rejects
the shared acquisition with its original `TerminalToolError` instead of being
evicted from the cache afterwards.

**Why:** The sandbox was being built in front of work that did not need it. In
one recorded run, provisioning finished at 08:27:43 and the first Terminal tool
did not run until 08:28:54 — the sandbox sat ready and idle for **70 seconds**
while the model loaded plugins and read GitHub, Linear and Slack. Across all
runs that use Terminal, the median gap between a run's first tool call and its
first Terminal tool is **16.5s**, against an ~18s median cold start, so for most
runs this wait stops being visible at all. It is not free for everyone: in 6 of
18 runs a Terminal tool *was* the first tool, and those see no overlap and no
improvement.

**Considered and rejected:** Starting acquisition at run start rather than at
activation — it would allocate a sandbox for every run including the many that
never touch Terminal, which is the speculative cost the lazy restored-activation
rule already exists to avoid. Keeping activation blocking and shrinking the
bootstrap instead — that is worth doing too, but it is a ~14s problem inside a
~70s one. Evicting the cached acquisition after preparation fails, as before —
see below.

Because activation stopped awaiting its own work, the runtime — not Rally —
decides whether that work survives to settle, and a cancelled continuation
cannot log its own death. So activation now writes
`terminal_plugin_activation_started` alongside the existing
`terminal_plugin_activation_finished`: a started row with no finished row for
the same `tool_call_id` is the shape of a sandbox abandoned in flight, and the
pair is the only way to see it. The rejection path also calls `notifyOps`,
because a failure that used to reach the model as an activation error now
reaches only a log row.

**Consequences:** The eviction that made a failed repository preparation safe no
longer works, and this is the subtle part. It was only ever safe because nothing
else could be awaiting the acquisition while activation blocked. Now a Terminal
tool from the following turn can already be waiting on that same promise, and an
eviction after it resolves never reaches an in-flight waiter — which would then
operate on a sandbox whose checkout is stale or whose repository authorization
was revoked. Preparation therefore rethrows the original error so the promise
rejects and there is nothing to observe; rethrowing the original
`TerminalToolError` rather than a sentinel is what keeps the waiter's error
actionable (`repository_access_revoked` and friends). Anything added to the
activation path must preserve that: fail the acquisition, do not clean up after
it. `HarnessPluginActivationError` is no longer raised from this plugin.

### 2026-08-30 — A Rally-owned snapshot can preinstall the managed capabilities

**What changed:** `apps/api/scripts/build-terminal-snapshot.ts`
(`pnpm --filter @rally/api terminal:build-snapshot`) builds a named Daytona
snapshot from a required `TERMINAL_SNAPSHOT_BASE_IMAGE`, applying
`terminalManagedSnapshotBootstrapCommand()` as the image's build step. Nothing
adopts it: the operator points `DAYTONA_TERMINAL_SNAPSHOT` at the result and
runs the existing `terminal:verify-provider` acceptance gate before any region
serves from it.

**Why:** Daytona's managed default image ships none of `sqlite3`, `gh`, `pnpm`,
`tsx`, so every new work-stream sandbox installs all four before the
participant's first Terminal tool can run — inside `prepareSandbox`, inside the
blocking `load_plugin` activation. Measured on the pinned command text in a
Linux container: ~14.4s with the capabilities missing against **117ms** with
them present, since the bootstrap's `command -v` guards then skip every install.
`apt-get update` alone is 5.7s of that. Production telemetry localises the cost
the same way: every recorded `restore` acquisition, which skips this phase,
lands in 1–5s, while no `start`, which runs it, has ever landed under 5s.

The weekly rebuild opens a labelled `Daytona Snapshot Upgrade` pull request
rather than writing a job summary. A verified snapshot nobody adopts is this
workflow's most likely failure: the job goes green every Monday, the rebuild
sits unused, and production runs an image that ages anyway. A pull request lands
in the queue the team already works, so adoption is one merge and rollback is
one revert, while a human still sits between a rebuilt image and every new
sandbox.

The build step is the bootstrap base64-encoded into a single line, not the
script itself. Daytona renders each build command as one Dockerfile `RUN`, and a
Dockerfile instruction cannot span raw newlines, so handing it the multi-line
bootstrap made that script's second line its own instruction and the create call
failed with `dockerfile parse error on line 3: unknown instruction: sudo`.
Shell quoting does not help — the parser splits the line before any shell sees
the quotes. Encoding removes newlines, quotes, and metacharacters together while
keeping the script byte-identical to the one the runtime would have run.

**Considered and rejected:** A second package list maintained beside the
bootstrap — it would drift from the runtime, and a snapshot that disagrees with
the manifest fails closed at acceptance rather than obviously. A
`SNAPSHOT_PREBUILT` flag letting the runtime skip the bootstrap — the `command
-v` guards already make it a 117ms no-op, and a flag that lies would skip the
manifest verification that fails closed on a breaking image update. Defaulting
the base image — the manifest probes fifteen capabilities and a wrong guess
ships a sandbox missing a runtime the prompt promises the model.

**Consequences:** The snapshot and the runtime share one source of truth, so
adding a capability means editing the bootstrap and rebuilding, not editing two
lists. The runtime bootstrap stays on the create path unchanged and still
verifies the manifest, so a snapshot that silently loses a capability is still
caught. **This script had not been executed against Daytona when this was written** (it was on 2026-09-07; see the 2026-09-08 entry) — this environment
has no `DAYTONA_API_KEY` — so the base image, the build, and the resulting
snapshot are unverified; the acceptance probe is what must establish them.

Owning a snapshot also gives up what the 2026-08-13 entry below bought
deliberately: Daytona's managed base updates no longer reach Rally on their own.
The manifest probe does not close that gap — it fails closed on a capability
that is *missing or broken*, not on one that is merely stale, so a pinned base
that is months behind passes every probe. The concrete case is the Netleash CA
that the managed image bakes into curl's trust store and Rally reads through
`$CURL_CA_BUNDLE`: rotate it under a pinned snapshot and `git-ca` still passes
while real Git operations fail. `rebuild-terminal-snapshot.yml` is the mitigation
and the condition — a weekly rebuild bounds staleness to a week and proves each
one with the acceptance probe. Do not adopt an owned snapshot without it.

### 2026-08-30 — The managed-snapshot bootstrap stops paying for work it can batch

**What changed:** The two `npm install --global` calls that add `pnpm` and `tsx`
became one call carrying both, accumulated through a `node_packages` variable in
the same shape as the `system_packages` branch above it. The fifteen snapshot
probes now run concurrently against per-probe marker files and are swept after
`wait`, rather than executing one after another under `set -e`.

**Why:** Both sit on the critical path of a participant's first Terminal tool,
inside the blocking `load_plugin` activation. Measured in a Linux container on
the pinned command text: the split `npm` calls cost 3.3s against 1.5s combined,
because each invocation pays npm's own start-up and registry handshake before
installing anything; the sequential probe cost 1.3–2.3s, of which `pnpm
--version` alone is 770ms and `python3 -m pip --version` 250ms — fifteen
interpreters booting in series. Concurrent probing bounds that phase by its
slowest single probe, measured at 727ms.

This is the cheap half of a larger finding. The same measurements show the
bootstrap costs ~14.4s when the snapshot lacks `sqlite3`/`gh`/`pnpm`/`tsx` and
117ms when it ships them, because the `command -v` guards then skip every
install. Production telemetry agrees on where that lands: across all recorded
acquisitions, every `restore` (which skips `prepareSandbox`) completes in 1–5s
while no `start` (which runs it) has ever completed in under 5s. A Rally-owned
snapshot carrying those four capabilities is the change that removes the ~13s;
this entry only removes what could be removed without one.

**Considered and rejected:** Merging install and verify into a single provider
`executeCommand` to save one round trip — it would collapse the `install` and
`verify` failure phases that `sandbox_bootstrap` reports separately, trading
deliberate observability for less than a second. Caching probe results per
snapshot version across sandboxes — that needs shared state for a 727ms phase.
Dropping probes from the manifest — the manifest is the fail-closed contract
against a breaking managed-image update, not overhead.

**Consequences:** The probe reports *every* missing capability as
`AVALON_PROBE_MISSING=<ids>` rather than failing at the first, so a breaking
image update is one diagnostic instead of one per redeploy. A probe that fails
still writes no marker and the sweep still exits non-zero, so the phase remains
fail-closed; anything added to `TERMINAL_SNAPSHOT_PROBES` must stay independent
of the others, because they no longer run in a defined order. The probe now
writes into `/workspace/.rally/tmp`, which the bootstrap already owns and the
probe already asserts.

### 2026-08-29 — The Terminal network policy moves behind typed WorkspaceDO methods

**What changed:** `terminalNetworkSettings`, `terminalNetworkMode`,
`recordTerminalPolicyPreview`, `claimTerminalPolicyApplication`,
`failTerminalPolicyApplication` and `commitTerminalPolicyApplication` replace
the fifteen statements `terminal/settings.ts`, `terminal/plugin.ts` and
`terminal/coordinator.ts` sent through the workspace runtime facade. The SQL
lives in `workspace-terminal-network-storage.ts`. `TerminalSandboxCoordinator`
now takes the Worker environment rather than a D1 handle, because it needs the
object as well as the regional reads it still makes. The apply path's
`restoreCurrentPolicy` compensation and its `markMutation` helper are deleted.

**Why:** the facade routes by table name and sends anything it does not
recognise to the regional database — the defect that took automation run work
streams down. The apply path had a second problem the routing risk hides:
reading the preview, checking the revision, claiming the policy row and
claiming the preview row were four round trips, so the policy could be left
`pending` with nobody applying anything. The service carried
`restoreCurrentPolicy` for exactly that window, and a compensating write can
fail too. One `transactionSync` has no window and needs no compensation: a
refused claim wrote nothing.

Settlement is fenced on the mutation rather than on the revision. A failed
application leaves the revision unchanged, so the next preview claims the same
number; fenced on revision alone, a retried failure for the first application
would release the second's claim, and a replayed commit would replace the
domain rows a person is looking at. Both settlements now transition their own
ledger row first, on a returned witness, and answer `stale` having written
nothing when it is not theirs.

**Considered and rejected:** giving the agent path the same creating read the
settings screen uses. It runs on every turn, and a workspace that has never
opened the setting would have a policy row written for it by the agent loop.
`terminalNetworkMode` answers `null` instead and the caller applies the same
default. Also rejected: keeping `coordinator.ts` on a bare `D1Database` and
passing a stub separately — two ways to reach the same workspace, and the next
read would have had to choose.

**What a future change has to respect:** `parseEffectiveDomains` changed twice
here, both fail-closed, and both rest on the same assumption. An empty stored
list is now an error rather than an allow-list of nothing, and the
malformed-JSON guard is gone because `policyView` parses the column directly.
Neither is reachable while `compileTerminalNetworkPolicy` always emits the
platform baseline for `trusted_only` and only this code writes the column — a
manifest that could compile to nothing would turn the first into a hard error
on every sandbox acquisition, and a corrupt column now reaches the agent as an
opaque RPC failure rather than the actionable "ask a workspace owner to save
and verify it again" the deleted `catch` produced.

`effective_domains_json` is returned as stored rather than recompiled on read. It is what the sandbox provider was
actually told, and recompiling would answer what the current manifest *would*
send — identical until the manifest changes, and silently wrong afterwards.
(A baseline version change is the one rewrite, and it is not silent: it moves
the revision, so every sandbox re-applies the list it now reports.)
The three tables stay named in `WORKSPACE_LOCAL_TABLES` even though nothing
routes to them now, so an accidental generic statement reaches the object
rather than falling through to regional D1. Whether the object then refuses it
is a second decision, made by `WORKSPACE_TYPED_RPC_ONLY_TABLES` in
`workspace-do.ts`; these three are not in that list, so such a statement still
executes. Adding them would close the domain the way the notification-intent
table is closed, and is the obvious follow-up once the ledger has no other
reader.

### 2026-08-28 — Generated files stay staged until their pointer commits

**What changed:** `publish_resource`, final-diff preservation, and repository
backup publication register their R2 objects as staged. The cleanup alarm may
clear that row after the resource pointer exists, but cannot delete the object
while the publisher is between its R2 write and WorkspaceDO commit. Known
failures release the object to cleanup; ambiguous commits preserve it for retry.

**Why:** Production reproduced a generated Markdown resource with two retained
versions and valid citation routing, while the current and historical content
routes all returned 404. The cleanup alarm could win the gap between upload and
pointer commit, delete the bytes, and still let the later metadata write
succeed.

**Considered and rejected:** Client-side fallback, because no client fetch can
recover bytes the server deleted; and a time-based cleanup grace period, because
its safety would depend on an arbitrary request-duration ceiling.

**Consequences:** Ambiguous publication favors a recoverable storage leak over a
broken document. A staged inactive object remains durable for retry or operator
reconciliation but does not arm an alarm whose pass cannot act on it. A later
supersession or deletion promotes the row to cleanup ownership. Every future
Terminal publication path must use the same staging fence.

Shipped in [#395](https://github.com/juno-ai-labs/avalon/pull/395).

### 2026-08-27 — A published document is identified by its path, not by the call

**What changed:** `resource-bridge.ts` derives a publication's
`provider_resource_id` from `terminal:<workstream-id>:<normalized-path>` rather
than `terminal:<effect-intent-id>`. A hit with an equal content hash returns the
existing resource unchanged; a hit with a different hash swaps content, mime
type, metadata and title onto the same row under a compare-and-swap against the
pointer that was read, resets the derivative to pending, and keeps the resource
id and its work-stream link. A path miss still looks up the per-call identity.

**Why:** The per-call identity is unique by construction, so the
workspace-scoped lookup behind it could only ever recognize a replay of that one
call. Publishing a revised draft of the same file was a legitimately different
call and minted a sibling resource: three revisions read as four documents in
the rail, and a revision had no stable object to land on. Standing policy now
steers document-shaped requests through this path
([`agent-harness.md`](agent-harness.md)), which makes republishing the ordinary
case rather than an edge one.

**Considered and rejected:** A new resource per publish, which is what shipped
before — it is honest about provenance and wrong about identity, and it leaves
resource versioning nothing to hang history on. Keying identity to the tool call
and reconciling siblings afterwards, which needs a second concept of sameness
that only the path can supply anyway. Enqueuing the superseded object for
cleanup, which the pre-versioning design assumed was necessary — the version row
still names that object and the reaper treats a ref a version names as active,
so enqueuing it would be a deletion the reaper immediately cancels.

**Consequences:** A revision keeps its predecessor readable, because the
WorkspaceDO version triggers capture the superseded state on the same update;
the "latest-only until versioning lands" limitation the terminal-artifact
generation PRD accepted does not ship, since that layer landed first. Two work
streams publishing `report.md` stay distinct, and two different files in one
work stream stay distinct. A lost compare-and-swap deletes the bytes this call
wrote and reports what the document now holds rather than clobbering the winner.
The model-facing contract — name, inputs, outputs, receipt behavior — does not
change, and an unreceipted publish is still refused before anything is written.
`createTerminalWorkspaceBackup` remains keyed to `toolCallId`, unchanged by this.

### 2026-08-27 — Typed publication reuses the authorized repository sandbox

**What changed:** `terminal_publish_branch_and_pr` now performs its expected-old
SHA check, push, and post-push verification as one Rally-authored direct utility
inside the selected full-access work-stream sandbox. It no longer creates a
second Daytona sandbox, builds and transfers a Git bundle, uploads another
credential, or boots a second Git environment. Fixed safe stage markers and the
durable publication/PR convergence receipt remain. The direct command uses the
validated repository URL rather than mutable local remote configuration and
uses a per-publication URL alias that outranks broad model-authored Git URL
rewrites. It disables repository-local Git hooks and automatic follow-tag pushes
for the Rally-authored exact-ref push.

**Why:** Two merged production repairs changed secret injection and then process
environment injection in the disposable publisher, but the same live typed
publication still ended with Daytona `exitCode: -1` and no script output. In
the same repository, the normal full-access sandbox had already completed an
authenticated `git push` and PR creation. The separate publisher duplicated an
authorization and Git runtime boundary that checkout had already established,
added 22 seconds to the final failed attempt, and supplied no additional branch
scope because both credentials were repository-scoped GitHub App tokens.

**Considered and rejected:** A third disposable-publisher launch mechanism,
another provider retry, and preserving the bundle transfer only for validation.
The first two keep debugging the redundant boundary; the last retains its
largest transfers after local status, branch, ancestry, and changed-path checks
have already validated the exact committed head.

**Consequences:** Typed publication now pays one direct `process.executeCommand`
against the warm sandbox and one GitHub API token boundary for remote fencing
and convergent PR mutation. Immediately before that remote mutation, Rally
mounts the freshly minted publication token into the already-authorized sandbox
and records its expiry. The token remains the sandbox credential after the PR
operation, so later ordinary Git/`gh` commands do not inherit a revoked token;
there is no repeated credential check on ordinary tools. Read-only selections
still fail before token minting or any push. A failed direct push keeps the same
ambiguity receipt and reports `remote_verify`, `remote_push`,
`post_push_verify`, or `unknown_stage` without retrying the remote write.

### 2026-08-27 — Trusted publication launches from uploaded payloads

**What changed:** The fresh private publisher now receives its Git bundle,
short-lived credential, and fixed publication script as three concurrent file
uploads. Its one direct process call executes the uploaded script without a
per-command environment payload. The script keeps the credential out of Git
configuration, removes the credential file on success or failure, and retains
the fixed safe stage markers. Cleanup waits for every concurrent upload to
settle before deleting the publisher sandbox, including when a sibling upload
has already failed.

**Why:** Production Daytona returned `exitCode: -1` with no output before the
first script marker whenever the direct process request carried the Git
configuration environment. That made the operation both fail and report only
`unknown_stage`; the same sandbox had already accepted file uploads, so the
fragile boundary was process-environment injection rather than sandbox setup or
Git publication.

**Considered and rejected:** Reintroducing Daytona Secret lifecycle calls,
putting the credential in the command string, or retrying the ambiguous
publication. Those choices respectively restore the latency and provider bug
removed by the prior change, expose the credential to command telemetry, or risk
repeating a remote write.

**Consequences:** Publication pays one parallel upload boundary plus one short
direct command in its disposable publisher sandbox. The credential exists only
in that isolated sandbox for the duration of the script and is deleted by the
script and again with the sandbox. A pre-script command-launch failure remains
`unknown_stage`; every script failure names its fixed stage.

### 2026-08-27 — Trusted publication pays one credential boundary

**What changed:** The ephemeral trusted publisher now passes its short-lived,
repository-scoped GitHub credential directly to the one fixed Git process
instead of creating, listing, mounting, and deleting a separate Daytona Secret
for every publication. Git receives the header through transient process
configuration rather than a repository config file. The process emits a content-free stage marker on failure,
which turns Daytona's otherwise opaque `exitCode=-1` into a safe publication
phase while keeping command output and credentials out of logs and tool results.

**Why:** Production verification reached the correct fixed work-stream branch,
created a clean commit, and then failed inside the fresh publisher sandbox with
`Trusted Git publication failed with exit code -1`. Repository checkout and a
standard push from the prepared agent sandbox both succeeded, isolating the
failure to the publisher's extra secret lifecycle. The write credential is
already short-lived and repository-scoped, and the publisher sandbox is already
single-purpose and ephemeral; another persisted provider-secret boundary paid
four control-plane requests without creating an additional product authority.

**Considered and rejected:** Passing the write credential into the agent
sandbox would remove the publisher entirely but expose it to participant code
and retained processes. Keeping the Daytona Secret lifecycle and merely adding
retries would preserve the failing boundary and repeat an external write whose
outcome may be ambiguous.

**What a future change has to respect:** The write token may enter only the
fresh publisher process environment, never the agent sandbox, provider logs, or
durable state. Publication must still verify the bundle, base ancestry, expected
remote SHA, pushed SHA, participant authority, and convergent receipt before it
reports success.

### 2026-08-27 — Terminal preservation follows resource authority into WorkspaceDO

**What changed:** Repository-replacement backups and final-diff preservation
now write their generated `resources` row and
`resource_object_deletion_outbox` receipt through the routed WorkspaceDO
database already installed on the Terminal plugin environment. The
work-stream resource link remains a separate WorkstreamDO mutation after the
resource row is durable.

**Why:** Production repository checkout after the D1 product-state retirement
successfully used the same sandbox and resource bridge, then failed while
creating its mandatory recovery backup with `D1_ERROR: no such table:
resource_object_deletion_outbox`. These two preservation helpers were still
calling the old work-stream database's `regionalDatabase` escape hatch. That
peeled both runtime routers and sent WorkspaceDO-owned resource SQL to the
retired D1 copy. Ordinary `publish_resource` already used the routed database
and passed in the same run, isolating the stale route.

**Considered and rejected:** Restoring the outbox table in D1, falling back to
D1 when the object call fails, or writing cleanup ownership into both stores.
Each would recreate a second product-state authority instead of repairing the
one stale caller.

**What a future change has to respect:** `resources` and
`resource_object_deletion_outbox` are WorkspaceDO authority. A Terminal helper
that creates resource bytes must use the routed workspace database for both
rows, then attach the resource through the work-stream object; regional
database escape hatches are only for control-plane tables that D1 still owns.

### 2026-08-27 — Explicit Terminal loading initializes the sandbox

**What changed:** The explicit Terminal `load_plugin` path now acquires the
work-stream sandbox and prepares a selected repository before exposing the nine
tools. Repairable repository failures are deferred so checkout remains visible;
a selected repository that failed preparation is removed from the shared
preparation cache so ordinary tools revalidate it before touching retained
files. A missing selection keeps the sandbox warm because there is no repository
authorization to recheck.
Restored activation hints skip preparation and retain first-tool acquisition.
Explicit preparation populates the same per-run promise used by every tool, so
the first tool does not reacquire or bootstrap the selected repository again.
Activation emits correlated acquisition, provider-operation, repository-state,
residual Rally timing, and a distinct attempt identity for each retry. Eight
repeated explicit loads single-flight one activation, and a 64-operation utility
burst proves one acquisition and one repository preparation.

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
traces. A revoked or stale selected repository cannot reuse activation's sandbox
cache, while `checkout_repository` remains available to repair the selection.
Performance comparisons must count `load_plugin` plus the first tool, not claim
a faster tool by moving cold setup outside the measured boundary.

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
production matrix must still be rerun in configured deployments after deployment.

### 2026-08-21 — Terminal writes republish the directory deadline again, and policy transitions keep their per-path lease semantics

**What changed:** `/internal/terminal` runs each operation through
`commitRuntimeMutation` and then `scheduleNextAlarm`, the way
`/internal/runtime-sql` always did. Operations that cannot move a deadline —
reads, and the task, import, and publication writes — are exempted by name;
anything else, including anything added later, publishes. Separately,
`settlePolicyTransition` takes `clearOperationLease` instead of always clearing
the mutation lease.

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

The lease change: the five D1 statements `settlePolicyTransition` replaced were
not uniform. The stop and the two failure paths that lose the sandbox released
the lease; the rollback and the settle that only records the applied revision
left it with its holder. Folding them into one operation quietly made all five
release it, which is a change to a mutual-exclusion guard that nothing asked
for.

**Considered and rejected:** treating every operation as directory-affecting.
Task settlement runs once per command, and republishing the whole directory row
plus a per-participant effect on that path is real parent work for a projection
that cannot have changed. The exemption list is explicit and the default falls
the other way, so a new operation over-publishes rather than stranding the
scheduler.

For the lease: keeping the uniform clear and documenting it. The lease is what
stops two runs mutating one workspace; changing when it drops belongs in a
change that argues for it, not in a refactor.

**Consequences:** an operation added to `WorkstreamTerminalStorage` publishes a
directory effect unless it is named in `NON_DIRECTORY_OPERATIONS`. Adding a name
there is a claim that the operation cannot change `terminal_workspace`, and it
is only checked by review.

Each `settlePolicyTransition` call site states its own answer, and the two that
keep the lease are the two that leave a sandbox a run may still be using.

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

### 2026-08-13 — The model chooses repositories behind a recovery boundary, and standard Git and GitHub CLI replace a second publication gate

**What changed:** Terminal adds `checkout_repository` as its ninth tool. The
model chooses an exact authorized repository, sees whether its remote access is
read-only or full, and may always edit or commit locally. Before replacing a
different sandbox repository, Rally saves a verified attached recovery archive
and only then destroys the old sandbox. The participant transcript chooser was
removed; repository policy now lives in connector Settings.

Full-access repository sandboxes receive a short-lived, single-repository
write token through Daytona secret substitution. Rally creates or restores a
persisted `avalon/adjective-adjective-adjective-noun` branch, switches to it
before every model-facing operation, and lets the model use normal `git push`
and `gh pr` commands. Read-only credentials still enforce remote immutability.
Publication provenance no longer parses request prose or limits a run to one
update.

**Why:** The chooser interrupted and eventually timed out runs even though the
model could search GitHub itself. Silent replacement was not acceptable either:
a model-selected repository change can invalidate the sandbox authority
fingerprint and otherwise discard untracked work.

Models are trained on standard Git and GitHub CLI workflows, and a PR commonly
receives several commits or updates. GitHub cannot scope an installation token
to one branch; emulating that with a proxy and a second single-use
authorization state machine would add complexity while fighting the desired
model behavior.

**Considered and rejected:** Resuming through another participant elicitation,
keeping one repository forever, and permitting replacement after only a Git
diff. Those respectively preserve the interruption, prevent legitimate
cross-task work, or lose untracked source, databases, and generated artifacts.

For publication: a smart-HTTP/API proxy, one token per push, and a
prose-derived single-publication grant. The connector's explicit read-only or
full-access policy is the authorization boundary. Future changes must preserve
automatic branch preparation and policy-triggered credential rotation, but
must not reintroduce a participant chooser or bespoke Git command surface.

**Consequences:** A repository switch may cost one bounded archive transfer and
a fresh sandbox generation. Checkout fails closed above 50 MiB compressed, so
large durable outputs should be published separately. Connector `read_only`
must never disable local mutation; it blocks only GitHub remote writes. Future
repository-selection paths must call the same policy and backup boundary rather
than writing selection rows directly. GitHub repository permissions are not a
substitute for the publisher's exact-ref checks because GitHub does not issue
branch-scoped installation tokens.

A full-access model credential is repository-scoped rather than branch-scoped.
The system prompt tells the model to push only the prepared branch and target
its base; repository rulesets remain an optional provider-side backstop.
Existing typed publication receipts remain available for convergence, not as
the only write route.

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

### 2026-08-13 — Terminal adds lazy, authority-fenced Daytona workspaces, verified live and hardened by review

**What changed:** Rally gains a deferred eight-tool Terminal plugin backed by
one private Daytona sandbox per work stream, workspace egress policy, generated
resource exchange, read-only GitHub bootstrap, one trusted pull-request
publisher, participant-visible state, and scheduled stop/archive/expiry.

Terminal uses Daytona's managed `daytona-small` snapshot. First creation
idempotently creates the private workspace, installs only missing
SQLite/`gh`/pnpm/`tsx` capabilities through Trusted-only hosts, and executes
the full compatibility manifest, which also probes Git, `gh`, and passwordless
sudo. Provider HTTP calls have a bounded client deadline, delete response loss
is reconciled from observed absence, and the command envelope uses a
shell-neutral exit variable.

Terminal retains each stable Daytona command session until its terminal result
is durable. A matching incomplete Bind receipt can re-enter the frozen
`run_command` executor, verify the task's sandbox generation and command hash,
and observe that session's sole command before returning one final result.

Automatic imports write to the exact path already checked for root/symlink
containment. Generated resources resolve beneath `AVALON_RESOURCE_DIR`, must be
non-empty stable regular files, and are checked by size and SHA-256 before and
after transfer. The snapshot probe requires both host-owned working
directories, and first sandbox creation compares Daytona's reported allow-list
with the compiled workspace policy before use.

Review hardening: sandbox creation verifies Daytona's observed egress policy;
command observation is named, bounded, sanitized before persistence, and
recoverable after response loss; resource imports record intent before
transfer and verify existing bytes before reuse. Network-policy changes stop or
quarantine every current sandbox before committing the new revision without
stamping a late generation as verified. Expiry reconciles a lost delete
response from provider absence, and Bind preserves ambiguous command receipts
for exact reattachment. GitHub publication revalidates the immutable
repository ID, current work-stream participation, and explicit non-negated
intent. The desktop exposes recovery actions and canonical workspace-domain
changes while keeping the managed baseline internal, repository replacement
confirmation, transcript continuation, and live lifecycle refresh.

**Why:** General work-stream agents often need trained CLI/code behavior for
calculation, transformation, artifact creation, repository inspection, and
small edits. Reimplementing every CLI as a custom tool would make the surface
less familiar to models, while handing a sandbox broad credentials or exposing
its control plane would make that convenience an authority escalation.

A live `daytona-small` probe proved provider policy read-back and deletion, but
also showed that the stock image has no `/workspace`, SQLite CLI, pnpm, or
`gh`; toolbox commands stay unprivileged even when sandbox creation asks for
root; and Daytona's default zsh treats `status` as read-only. Registry
inspection showed the full 0.9/0.10 images are roughly 6.9 GiB compressed,
while the separate slim image is much smaller.

A Worker can disappear after Daytona accepted or finished a command but before
the tool receipt is complete. Treating that as an ordinary ambiguous write
would strand the agent; deleting the session before D1 terminalization would
also remove the evidence needed to prove whether replay is safe.

Deriving a title-based sibling after containment validation checked the wrong
import path; repository-relative publication bypassed the promised output
directory; and accepting an unverified create response could make Trusted only
a UI claim rather than an enforced provider fact.

Adversarial review found places where requested provider state was mistaken
for observed state, a first failure could leave another sandbox running under
broader egress, ambiguous command outcomes invited duplicate execution, and
mutable repository names or stale participant grants could cross authority
boundaries. It also found UI paths that could discard retained files or strand
a blocked run without explaining how to recover.

**Considered and rejected:** A user-visible/PTY coding harness; Cloudflare
Dynamic Workers as the only execution substrate; one sandbox per command; a
cold filesystem copy in R2; CIDR/proxy egress; model-facing revisions, polling,
directory listing, or lifecycle tools; and GitHub write credentials inside the
work-stream sandbox. Each either expands product scope, duplicates trained
shell behavior, costs more state churn, or weakens the authorization boundary.

For the snapshot: owning a custom snapshot based on Daytona's slim image, a
generic Node image, VM sandboxes, unconditional runtime installation on every
cold start, and trusting a requested sandbox user. They respectively make
Rally own refresh/activation compatibility, recreate Daytona conventions, buy
unused isolation features, slow every first use, or conflict with observed
toolbox identity.

For command recovery: a second Terminal-command Workflow, continuation table,
WebSocket event pipeline, and model-facing poll protocol. The existing harness
Workflow retry plus Daytona's stable named session provides the required
recovery boundary with less orchestration state.

For boundary verification: trusting snapshot convention, resource titles, or
the create request as evidence. Each is an input or intention, not observed
state at the boundary where bytes or network access are granted.

For the review round: trusting Daytona create input as read-back, stopping
sandboxes only until the first provider failure, converting unknown command
results into ordinary failures, authorizing PR publication from keyword
proximity alone, and silently replacing a retained workspace. Each made a
provider or UI race look successful without proving the corresponding
security or durability invariant.

**Consequences:** A region is truthfully unavailable until its real Daytona
acceptance probe passes. Future runtimes/managers require a prompt update, a
snapshot-manifest probe, and provider acceptance together. Any new Terminal
tool must retain the documented argument/output/error contract and authority
fence.

Rally accepts the managed snapshot's larger footprint in exchange for
Daytona's common, coordinated path. The bootstrap skips capabilities Daytona
already supplies and fails closed if a managed update breaks sudo, workspace
ownership, a promised runtime, or a manager fixture.

Bind may re-enter only `run_command` and the convergent
`publish_branch_and_pr` operation after an exact matching incomplete receipt.
Any generation, input, canonical-policy, session, repository, ref, or grant
ambiguity still fails closed, and provider-session cleanup happens only after
D1 records a terminal result.

Snapshot activation fails until `.rally/tmp` and `.rally-output` exist.
Publication performs two bounded file inspections, and a create-policy
mismatch discards the sandbox and leaves durable failed state.

Provider activation requires real read-back and redirect/private network
probes. Policy mutations may quarantine or delete a sandbox that cannot be
stopped safely, but never commit an unverified revision. Exact command replay
reattaches to the same named session; changed calls stop on ambiguity.
Repository replacement is explicit, preserves a final diff where possible, and
resumes the requesting work stream once.

Shipped in the pull request for this change. Design:
[`docs/PRDs/2026-08-12_daytona-terminal-git-github/prd.md`](PRDs/2026-08-12_daytona-terminal-git-github/prd.md).
