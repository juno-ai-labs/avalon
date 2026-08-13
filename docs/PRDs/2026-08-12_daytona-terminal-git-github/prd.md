# Daytona terminal, Git, and GitHub pull requests

> Created 2026-08-12.
>
> An Avalon work stream can lazily acquire an isolated Daytona workspace in
> which the agent inspects and edits one repository, runs bounded terminal
> commands, uses real `git` and `gh` CLIs, and publishes an authorized pull
> request. Companion documents: [`design.md`](./design.md) and
> [`plan.md`](./plan.md). Standing contract: [the Avalon implementation
> brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

When a participant asks Avalon to inspect or change code in a GitHub repository,
the work-stream agent gains a small production-harness toolset backed by one
isolated Daytona workspace for that work stream. The workspace is created or
resumed only on the first file or terminal operation. The agent can navigate and
mutate files with typed tools, run bounded shell commands, and use the actual
`git` and `gh` CLIs that coding models already understand. It does not receive a
Daytona lifecycle API, host access, a user-visible terminal, or a general
internet-connected runtime.

Private repository access comes from Avalon's existing regional GitHub App. The
regional API mints short-lived, single-repository installation access tokens;
Daytona's secret proxy exposes only opaque placeholders to the sandbox and
substitutes credentials in HTTPS headers for approved hosts. Read/edit authority
is distinct from publication authority. A push or pull request is possible only
when the participant's request, frozen connection scope, repository installation,
and current run all authorize publication. The resulting branch, commit, checks,
and pull-request URL appear in the transcript and durable activity history.

## Motivation

Avalon can currently call typed connector tools but cannot perform the basic
repository loop behind a request such as “update this configuration and open a
PR”: clone the repository, inspect several files, make a coherent edit, run the
project's own checks, review the diff, commit it, push a branch, and create the
pull request. Recreating every `git`, package-manager, test-runner, and GitHub
operation as a bespoke Bind tool would be a large and permanently incomplete API.
It would also discard the command structures on which current coding models have
substantial production and training experience.

The standing implementation brief deliberately forbids shell, terminal, and
arbitrary code execution. That is the correct default for ordinary connector
work, but it also means repository changes cannot be added as a small GitHub
connector extension. The capability needs an explicit product boundary: one
untrusted, network-restricted sandbox per work stream; no host credentials; a
bounded tool and process lifecycle; and a separate publication grant.

Daytona now supplies the primitives needed for that boundary. Its
[sandboxes](https://www.daytona.io/docs/en/sandboxes/) expose processes and
lifecycle controls, its [PTY API](https://www.daytona.io/docs/en/pty/) supports
interactive and long-running commands, its
[filesystem persistence](https://www.daytona.io/docs/en/persistence/) survives
stop/start and archive/restore, and its
[secret proxy](https://www.daytona.io/docs/en/secrets/) keeps plaintext
credentials out of sandbox environment variables, files, arguments, and logs.
GitHub App installation tokens can be narrowed to one repository and a subset of
the App's permissions and expire after one hour, giving Avalon a short-lived
credential to place behind that proxy.

## Goals

1. A participant can ask Avalon to inspect, edit, validate, commit, and publish a
   pull request for one authorized GitHub repository from an ordinary work stream.
2. The model uses familiar file, terminal, `git`, and `gh` interfaces while Bind
   retains authorization, lifecycle, receipt, output, and audit control.
3. No Daytona sandbox starts merely because the plugin is available, a work
   stream opens, or a message mentions code; the first sandbox-dependent tool call
   starts or resumes it exactly once.
4. One current Daytona workspace preserves repository state for one work stream
   across turns, retries, stop/start cycles, and short-term archive/restore.
5. GitHub App private keys, user access tokens, refresh tokens, and plaintext
   installation tokens never enter a sandbox, model context, transcript, command,
   Git configuration, or persisted command output.
6. Read/edit authority never implies publication authority. Push and PR creation
   require an explicit publish intent and a frozen run grant for the exact GitHub
   connection and repository.
7. Publication is limited to a deterministic Avalon branch for the work stream;
   direct default-branch updates, force pushes, ref deletion, and workflow-file
   mutation are rejected independently of model behavior.
8. Terminal and file operations remain bounded, cancellable, observable, and
   recoverable after a Worker or model failure without blindly replaying an
   ambiguous command.
9. Idle compute stops promptly, long-idle files leave Daytona's active disk tier,
   and a work stream can resume without treating the sandbox as the canonical
   audit record.
10. Workspace data, outputs, GitHub credentials, and control-plane records stay in
    the workspace's selected region, with EU rollout blocked until the Daytona
    deployment and contract satisfy Avalon's residency requirements.

## Non-goals

1. A full coding harness, autonomous issue picker, or replacement for Codex,
   Claude Code, OpenCode, or Grok Build is deferred. Avalon responds to a
   participant's repository-scoped request; it does not roam a backlog or keep
   coding indefinitely.
2. A user-visible terminal, IDE, SSH endpoint, debugger UI, or collaborative shell
   is deferred. The transcript shows structured command activity and bounded
   output, not a terminal emulator.
3. A user-authored workflow runtime, hosted application, preview deployment, or
   long-lived server is rejected for this feature. Background processes exist only
   to finish bounded validation work and cannot turn the sandbox into a service.
4. Arbitrary internet access is rejected. Each sandbox receives a checked-in
   egress profile; GitHub is the initial profile, and public package registries may
   be added individually only after their risk and required hosts are documented.
5. Multiple repositories, Git submodules, Git LFS, monorepo-to-monorepo
   coordination, and cross-repository pull requests are deferred. One work stream
   has one primary repository in the first release.
6. SSH Git transport is rejected. HTTPS is required so Daytona's header secret
   substitution and Avalon's publishing bridge can mediate credentials.
7. Direct pushes to the default branch, arbitrary remote refs, branch deletion,
   non-fast-forward pushes, and edits under `.github/workflows/` are rejected.
   Repository owners keep those operations outside Avalon.
8. Human commit attribution, commit signing, release creation, merge, deployment,
   and GitHub administration are deferred. Commits identify the Avalon GitHub App
   bot; the feature stops at an open pull request.
9. Replacing Git and GitHub with a large custom tool vocabulary is rejected. Bind
   owns a narrow execution boundary; real `git` and `gh` own their established
   command surfaces.
10. Treating Daytona persistence as the durable receipt or audit system is
    rejected. Regional D1 and R2 remain authoritative for execution state,
    bounded output, patches, and publication records.

## Product behavior

### Admission and repository selection

The Daytona repository plugin is eligible only when the server-side feature flag
is enabled for the workspace. It becomes loadable for a run when the participant
has an active GitHub connection and the request identifies a repository the App
installation can access. An attached GitHub repository or pull request is
authoritative; otherwise an exact `owner/repo` in the request is used. If neither
resolves one repository, Avalon elicits a choice rather than cloning a guess.

The run freezes two independent scopes:

- `repository:work` permits clone/fetch, file reads and edits, local commands,
  diffs, and local commits; and
- `repository:publish` additionally permits the fixed work-stream branch to be
  pushed and a pull request from that branch to be created or updated.

An explicit request such as “open a PR,” “push this change,” or “send this for
review” admits `repository:publish`. A request to inspect, explain, or make local
edits does not. The model cannot upgrade the frozen scope. A later participant
message can start a new run with publication authority.

### Starting and restoring the workspace

Loading the plugin does not contact Daytona. The first `read_file`, `grep`,
`apply_patch`, or `run_terminal_cmd` call acquires a work-stream workspace lease.
Avalon creates a sandbox from a pinned snapshot or restores the current sandbox,
checks its snapshot version and repository identity, rotates its short-lived
GitHub credentials, and then executes the tool. Concurrent first calls converge
on the same sandbox.

The transcript shows one activity row while this happens: “Starting repository
workspace” for a new sandbox, “Resuming repository workspace” for a stopped one,
or “Restoring repository workspace” for an archived one. The row resolves to the
repository, base ref and SHA, branch, and workspace state. A startup failure stays
visible with a stable reason and retryability; it is never presented as an empty
repository.

For a new workspace, Avalon clones the selected repository over HTTPS, checks out
the requested base ref at a recorded SHA, and creates
`avalon/<work-stream-suffix>/<slug>`. The branch name is server-derived and cannot
be supplied by the model. Repository files are untrusted input: instruction files
may inform the requested work but cannot expand tools, network access, frozen
scope, or credential permissions.

### Inspecting and editing

The agent receives typed tools for listing, searching, reading, applying an exact
edit or patch, and writing a bounded file. All paths are repository-relative and
resolved after symlinks; a path that escapes the repository root is rejected.
Reads are paged and include an explicit truncation marker. Writes use an expected
revision when replacing existing content, so a stale model edit does not silently
overwrite a newer tool result.

The transcript groups file operations beneath the repository activity. It shows
paths and a concise mutation summary, not entire files. A participant can inspect
the final diff artifact even if the sandbox later stops or is deleted.

### Running commands

`run_terminal_cmd` executes a shell command in the repository root or a
repository-relative directory. Commands are non-interactive by default, have a
hard timeout and bounded inline output, and receive a deterministic environment.
The model may request a PTY only for a command that genuinely requires terminal
semantics. A long command returns a task ID; the model reads incremental output,
sends input to a PTY task, or kills the task through separate typed tools.

The transcript shows the command, working directory, running/completed/failed/
timed-out/cancelled state, duration, exit code, and bounded stdout/stderr. Output
beyond the inline cap spills to regional R2 and is linked by an opaque authorized
artifact reference. Secrets and secret-like values are redacted before either
destination. The agent cannot disable timeouts, start a detached daemon, address a
Daytona sandbox directly, or choose a host working directory.

`git` and `gh` are ordinary commands inside this boundary. The pinned snapshot
also contains `rg`, `jq`, a shell, Git, GitHub CLI, Node.js 22, pnpm 11.13.0, and
the minimal runtimes approved for the first release. Project dependency downloads
work only when the sandbox's egress profile explicitly allows every required
host; otherwise the command fails with `network_policy_denied` and the agent
reports which validation it could not run.

### Committing, pushing, and opening a pull request

The agent reviews `git status` and `git diff` before committing. Commits use the
Avalon App bot identity and contain no generated credential helper or token.
Without `repository:publish`, the agent stops after the local commit or diff and
returns what is ready plus the action the participant must request next.

With `repository:publish`, `git push` uses a separate push URL owned by Avalon's
regional Git publishing bridge. The sandbox authenticates to the bridge with an
opaque, one-work-stream capability; the bridge, not the sandbox, mints and uses
the contents-write GitHub token. It accepts only the recorded repository and
Avalon branch, rejects the default branch, deletion and non-fast-forward updates,
and records the expected old and resulting new SHA before reporting success.

The agent then uses `gh pr create` or `gh pr edit` against `api.github.com` with a
single-repository installation token narrowed to contents-read and
pull-request-write. It uses the recorded branch and requested base, produces a title and body
that summarize the reason, changes, and validation, and verifies the resulting PR
by head/base before returning its canonical URL. A retry searches for the existing
head/base PR before creating another. Avalon never merges the PR.

### Stopping, archiving, cancellation, and offline behavior

The model does not receive start, stop, archive, or delete tools. Avalon holds a
lease while a foreground command or monitored background task is active. After
the last lease is released, the workspace remains warm for five minutes and then
stops. Daytona's 15-minute auto-stop is a backstop for an abandoned idle lease;
because Daytona does not consider an unmonitored background process activity, a
bounded background-task lease disables auto-stop only while Avalon actively
monitors it. Every task also has a wall-clock deadline.

A stopped container is archived after 60 minutes of work-stream inactivity so its
filesystem moves to Daytona object storage and releases active disk quota. After
30 days without repository activity, Avalon persists the base SHA, branch tip,
Git bundle, tracked-file patch, bounded untracked-file archive, command-output
references, and publication record in regional R2, deletes the Daytona sandbox
and its per-sandbox secrets, and marks the logical workspace cold. Avalon does not
delete the sandbox if it cannot verify a complete cold artifact within the
documented limits. A later tool call creates a replacement sandbox and
reconstructs the branch. These thresholds are server configuration with these
values as the initial defaults; flags may turn the feature off but never weaken
retention or authorization policy.

Cancelling the run stops accepting new commands, kills its active tasks, captures
available output and the working-tree diff, releases the lease, and stops the
sandbox after a short grace period. If the desktop is offline, already running
server-side work continues to its bounded deadline and is reconciled into the
transcript on reconnect; new terminal input is unavailable offline.

Connection revocation immediately prevents new tool calls and publication. Avalon
deletes or rotates the sandbox secrets and blocks sandbox egress before the next
resume. Existing uncommitted files remain available under normal work-stream
retention, but no stale GitHub credential is renewed.

## Impact on the product contract

This deliberately narrows one clause of the Avalon implementation brief. The
current clause says:

> The agent uses typed, authorized tools. It never receives a shell, terminal,
> arbitrary code execution, or a user-authored workflow runtime.

When this PRD ships, the standing contract changes to:

> The agent uses typed, authorized tools. A repository-capable run may execute
> bounded commands through typed terminal and file tools inside an isolated,
> network-restricted workspace when the participant's request and frozen scope
> authorize it. The agent never receives host access or a user-authored workflow
> runtime.

The implementation brief is updated in the final shipping change, not while this
PRD is merely planned. Its rules for regional data, visible audited actions,
idempotent attempts, bounded runs, and no global approval gate remain unchanged.
Publication is an ordinary authorized external write once the explicit request and
frozen grant exist; it does not add a universal confirmation dialog.

## Decision log

None yet.

## Key design decisions

1. **Use a Bind plugin with production-harness-shaped tools, not a new agent.**
   The work-stream agent keeps the conversation and decides when repository work
   is relevant. A second coding agent would introduce handoff, memory, and
   attribution behavior outside this capability's scope.
2. **Expose real `git` and `gh` through a bounded terminal.** Models already know
   these command languages, and repositories rely on their complete semantics.
   Reimplementing clone, status, diff, branch, commit, push, and PR operations as
   custom tools was rejected as a lower-capability interface with a larger
   maintenance surface.
3. **Keep first-class file tools beside the terminal.** Models are more reliable
   when common reads, searches, and exact edits have structured results and path
   checks. Requiring `cat`, `sed`, and shell redirection for every mutation was
   rejected because quoting, output size, and stale-write failures become harder
   to constrain.
4. **Create one current sandbox per work stream, lazily.** Per-message sandboxes
   lose branch state and repeat clone/install cost; workspace-wide sandboxes mix
   unrelated conversations and authority. A work stream is Avalon's durable unit
   of context and is therefore the matching isolation and persistence unit.
5. **Use Daytona Secrets for GitHub reads and `gh`, with pre-encoded Basic auth
   for Git.** Daytona substitutes only literal placeholders in HTTPS headers.
   Allowing Git to base64-encode a placeholder would prevent substitution, so
   Avalon stores the already encoded `x-access-token:<installation-token>` value
   and configures a URL-scoped `Authorization: Basic <placeholder>` extra header.
   Plaintext credential helpers and tokens in remote URLs were rejected.
6. **Keep GitHub write credentials out of Daytona.** A single-repository,
   read-scoped token is sufficient for clone/fetch and a PR-scoped token is
   sufficient for `gh`. Push travels through an Avalon Git bridge that enforces
   repository and branch policy and mints contents-write authority in the trusted
   regional control plane. Giving arbitrary sandbox commands a repository-wide
   contents-write token was rejected.
7. **Separate work from publication at run admission.** A participant can ask for
   investigation or a patch without granting an external write. Inferring publish
   authority because a GitHub connection exists was rejected.
8. **Treat every terminal command as `record_before_execute`.** Shell commands can
   mutate files, GitHub, or another allowed host and rarely have provider
   idempotency keys. A timeout or lost result is `ambiguous_external_write`; Bind
   inspects state rather than blindly rerunning it.
9. **Use Daytona archive for resumable short-term state and regional R2 for
   durable evidence and cold reconstruction.** Copying a live filesystem to R2 on
   every stop duplicates storage and rebuild logic; retaining every inactive
   sandbox in Daytona forever makes long-tail work streams an unbounded vendor
   bill.
10. **No model-facing sandbox lifecycle controls.** Lazy acquisition and
    lease-based release let the host reason about cost, cancellation, and background
    work. Letting the model start or keep sandboxes alive was rejected because
    lifecycle is not part of the repository task.

## Data model

The implementation adds regional records at sketch level; the migration and
[`../../data-model.md`](../../data-model.md) become authoritative when code lands.

- `workstream_repository_workspaces` has one row per work stream and records the
  GitHub connection, repository node ID and display name, Daytona sandbox ID and
  snapshot version, logical state, base ref/SHA, fixed branch ref/tip, last
  activity, stopped/archived/cold timestamps, and an optimistic version. The
  work-stream ID is unique. No GitHub or Daytona secret value is stored.
- `sandbox_tasks` records the stable task ID, owning `tool_invocation`, provider
  process or PTY ID, command hash, relative working directory, state, deadlines,
  exit code, bounded-output reference, and timestamps. It is execution state,
  not a second receipt authority.
- `repository_publications` records the publication receipt, repository, base and
  head refs, expected old SHA, pushed SHA, PR number, canonical URL, state, and
  timestamps. `(repository, head_ref, base_ref)` prevents duplicate PR creation.
- Existing `tool_invocations` remains the receipt authority. Terminal calls use
  `record_before_execute`; file reads are `safe`; revision-checked file writes are
  `record_before_execute`; verified push and PR results persist their external IDs.
- Large output, final diffs, cold Git bundles, and patches live behind opaque
  regional R2 references. Existing rows require no backfill.

## Regional impact

Each regional API uses a distinct Daytona organization or least-privilege API
principal and creates sandboxes only in the deployment region approved for that
workspace. The regional Worker stores the mapping, receipts, and R2 objects and
mints GitHub installation tokens from that region's existing App private key.
Neither the Global registry nor the other Avalon region receives repository
contents, commands, outputs, tokens, diffs, branch names, or PR bodies.

The only external data flows are to the workspace's regional Daytona control and
compute plane and to GitHub hosts required for the selected repository. Global
rollout may proceed after vendor review. EU rollout remains disabled until legal
and technical verification confirms Daytona's processing location, persistence
location, backups, subprocessors, deletion behavior, and data-processing terms
meet Avalon's selected-region contract. This is a rollout gate, not a flag that
can waive residency.

## Security and trust model

- The Daytona API key and GitHub App private key remain regional Worker secrets.
  User refresh/access tokens never leave the existing connection service.
- Every GitHub installation token is minted for one repository, narrowed to the
  minimum permission set, and accepted as expired no later than GitHub's one-hour
  expiry. It is rotated before resume and after an authorization change.
- Each mounted Daytona secret has an exact host allowlist. The sandbox sees only
  the opaque placeholder; responses are scrubbed by Daytona. Secret names are
  per region and work-stream workspace, and deletion follows sandbox deletion.
- Git clone/fetch uses a URL-scoped Git extra header containing only a Daytona
  placeholder. `.gitconfig`, remotes, process arguments, environment inspection,
  shell history, and output must never contain a plaintext token.
- Daytona network policy blocks all egress except the selected profile. GitHub
  secrets are substitutable only for `github.com` or `api.github.com`; the push
  capability is substitutable only for the regional Git bridge host.
- The publishing bridge validates the signed workspace capability, frozen
  publication grant, connection state, installation, repository, fixed branch,
  expected old SHA, and operation kind. It never accepts a caller-supplied GitHub
  token.
- The base snapshot runs as a non-root user, exposes no Docker socket, host mount,
  metadata endpoint, inbound public port, or Avalon infrastructure credential.
  Sandbox filesystem and process limits are enforced independently of prompts.
- Repository content, dependency scripts, command output, and terminal control
  sequences are untrusted. Output is normalized before the model or desktop sees
  it; paths are root-confined after symlink resolution; instructions in the repo
  cannot alter frozen grants or system policy.
- Commands and outputs are scanned for known secret forms and Daytona placeholders
  before persistence or transcript projection. Security tests attempt environment,
  process, Git-config, response-echo, alternate-host, redirect, and output-based
  exfiltration.

## Agent behavior

The model-facing surface and lifecycle protocol are specified in
[`design.md`](./design.md). The plugin exposes file navigation/mutation plus:

- `run_terminal_cmd` for one foreground or background command, optionally with a
  PTY;
- `get_task_output` for bounded incremental output and terminal state;
- `send_task_input` only for an active PTY task; and
- `kill_task` for cancellation.

The agent uses file tools for ordinary inspection and exact mutations, then the
terminal for repository-native tools and validation. It does not invent a shell
command when a safer typed file read or edit expresses the same operation. It
checks the diff before commit, never publishes without `repository:publish`,
never changes the fixed branch, and reports validation it could not run. A
successful response names changed files, validation and exit status, commit SHA,
and PR URL when one exists. It does not claim success from command submission;
the terminal result, remote ref, and PR verification must agree.

## Provider configuration

1. Upgrade the existing Avalon GitHub App repository permission `Contents` from
   read to write. Keep Pull requests read/write and existing metadata, issues,
   actions, and checks permissions. Do not add Workflows permission.
2. GitHub requires every installation owner to approve new repository permissions.
   Until approval arrives, that installation remains clone/read-only and Avalon
   explains that publication is unavailable; it does not fall back to a user's
   broad personal token.
3. Provision a distinct least-privilege Daytona API principal and secret namespace
   for each enabled Avalon region. It needs sandbox lifecycle, toolbox, network,
   and per-sandbox secret attachment operations; administrative billing and
   organization operations remain separate.
4. Publish a versioned Daytona snapshot containing the pinned CLI/runtime set and
   record its immutable identifier in regional configuration. A mutable `latest`
   tag is not allowed in production.
5. Configure the regional Git publishing bridge and its GitHub App key access
   before enabling publication. Read/edit mode remains available if the bridge is
   unhealthy; push/PR mode fails closed.

## Rollout

The server-side JSON flag is `agent-repository-workspace`. It fails closed to
`{"mode":"off"}` and supports `off`, `read_edit`, and `publish` modes plus
operational limits. Targeting is configured in Flagship, never hard-coded. The
flag enables availability but cannot override connection grants, region, egress,
retention, branch policy, or any other security rule.

Rollout follows [`plan.md`](./plan.md): internal synthetic repositories first;
then selected Global workspaces in read/edit mode; then GitHub publication for
installations that approved Contents write; then broader Global availability.
EU stays off until the regional gate above is met. Turning the flag off prevents
new leases and publication, cancels unstarted work, lets bounded active commands
finish or reach their deadline, captures diffs, and stops affected sandboxes.
Rollback never deletes a participant's uncommitted work immediately.

## Acceptance

1. Opening a work stream, loading the plugin, or discussing code without a file or
   terminal call creates no Daytona sandbox and incurs no sandbox compute charge.
2. Two concurrent first tool calls converge on one sandbox; later turns in the
   same work stream resume the same files and branch, while another work stream
   receives a different sandbox.
3. The agent clones a private fixture repository, reads and edits files, runs a
   fixture check, reviews the diff, and commits with real `git` without any
   plaintext credential appearing inside or outside expected regional stores.
4. File traversal and symlink escapes, unbounded reads/writes, detached daemons,
   excessive output, timeout bypass, and forbidden egress return stable structured
   failures and do not escape the sandbox policy.
5. Environment, Git config, process arguments, shell history, redirect, echo, and
   response-reflection attacks reveal at most Daytona placeholders and cannot send
   a real GitHub credential to an unapproved host.
6. A read/edit-only run cannot push or create/edit a PR. A publish-authorized run
   can push only its deterministic branch and cannot update the default branch,
   delete or force-update a ref, or change `.github/workflows/`.
7. A publish-authorized fixture flow creates one PR with the expected head/base,
   title, body, commit, and URL. Retrying after a lost response returns the same PR
   rather than creating another.
8. Revoking the GitHub connection or App installation blocks the next Git or `gh`
   operation, removes publication authority, and does not renew a stale token.
9. A foreground task and a PTY background task can be observed and cancelled. A
   crash or timeout produces `ambiguous_external_write` where appropriate and is
   reconciled from task, Git, and GitHub state rather than automatically repeated.
10. Five-minute stop, 60-minute archive, 30-day cold reconstruction, cancellation,
    desktop disconnect/reconnect, and cold resume preserve the documented files,
    receipts, output references, and branch tip.
11. Transcript activity covers loading, running, populated, failed, timed-out,
    cancelled, offline/reconnected, stopped, archived, and restored states without
    exposing raw control sequences or unbounded output.
12. Global and EU integration tests prove that no repository data or credential
    crosses Avalon's regional boundary; EU production targeting remains impossible
    until the vendor residency gate is explicitly satisfied.

## Open questions

1. **Which public dependency registries enter the first build egress profile?**
   This does not block clone/edit/commit/publish. It blocks claiming general test
   execution for repositories whose dependencies are not already present. Each
   registry needs exact hosts, redirect behavior, size limits, and a decision on
   install scripts before it is added.
2. **Does Daytona provide a contractually acceptable EU compute and persistence
   location for Avalon's selected-region promise?** This blocks EU rollout, not
   the Global implementation. Vendor review must answer it with deployment and
   deletion evidence rather than a product flag.
