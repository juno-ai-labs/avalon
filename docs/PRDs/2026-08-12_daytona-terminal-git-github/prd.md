# Daytona terminal plugin: code, Git, and GitHub pull requests

> Created 2026-08-12.
>
> An Avalon work stream can lazily acquire an isolated Daytona workspace in
> which the agent writes and runs code, creates artifacts, edits one repository
> with real `git`, and publishes an authorized pull request through Avalon.
> Companion design: [`design.md`](./design.md). Research record:
> [`research.md`](./research.md). Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Avalon adds a Bind plugin with production-harness-shaped file and command tools
backed by one isolated Daytona sandbox per work stream. Loading the plugin does
not allocate a sandbox. The first file or command call creates or explicitly
starts it; subsequent calls reuse it until retention expires.

The model can write and run Bash, Python, JavaScript, TypeScript, and SQLite,
install packages with a deliberately small manager set, and export generated
files such as graphs, images, datasets, reports, and archives. It can clone,
inspect, edit, validate, and commit one authorized GitHub repository using real
`git` and read-only `gh` commands.

Publication is a separate typed operation. No GitHub write credential enters the
sandbox. When the participant explicitly grants publication, Avalon transfers
the committed branch to a trusted regional publisher, validates the fixed branch
and diff, and creates or updates one pull request with a short-lived,
single-repository GitHub App token.

Workspace administrators choose **Trusted only** or **Full internet**. Trusted
only uses Daytona's native domain allow-list, an immutable baseline, and optional
workspace domains. It does not introduce an Avalon egress proxy in this release.

## Motivation

Avalon can call typed connector tools but cannot perform the repository loop
behind “change this and open a PR”: clone, inspect, make a coherent edit, run the
project's checks, review the diff, commit, publish a branch, and create a pull
request. Nor can it use short programs to solve calculation, transformation,
analysis, or artifact-generation tasks.

Reimplementing every shell, `git`, package-manager, and test-runner operation as a
Bind tool would be incomplete and would discard command shapes coding models know
well. Giving ordinary Avalon workers a shell would violate the current isolation
contract. A lazily started Daytona sandbox provides the required execution
boundary while Bind keeps lifecycle, authorization, output, and external writes
under host control.

## Goals

1. A participant can ask Avalon to inspect, edit, validate, and locally commit a
   change to one authorized GitHub repository from an ordinary work stream.
2. With explicit publication intent, Avalon can publish the fixed work-stream
   branch and create or update one pull request without placing GitHub write
   credentials in the sandbox.
3. The model receives familiar typed file tools, a bounded non-interactive shell,
   and real `git` and read-only `gh` CLIs.
4. No sandbox starts because the plugin loads or code is mentioned. The first
   sandbox-dependent tool call creates or explicitly starts it exactly once.
5. One current sandbox preserves a work stream's files across turns, stop/start,
   and short-term Daytona archive/restore.
6. Commands are bounded, cancellable, observable, and reconciled after a Worker
   failure without spending model turns polling or blindly replaying a command.
7. The model can write and execute Bash, Python, JavaScript, TypeScript, and
   SQLite for common calculation, transformation, analysis, automation, and
   generation tasks.
8. The supported package-manager set is `apt`/`dpkg`, `pip`, `uv`, `npm`, and
   `pnpm`.
9. The plugin system prompt makes the supported languages, managers, and useful
   task patterns conspicuous so the model chooses one when code is the clearest
   reliable solution.
10. Attached work-stream resources can become guarded local files for code, and
    generated graphs, images, tables, datasets, reports, and archives can become
    durable regional resources using the attachment and visibility subsystem
    merged in PR #144.
11. An owner or administrator can select Trusted only or Full internet. Trusted
    only is the default and accepts additional exact or wildcard domains.
12. Trusted only visibly includes non-removable named groups for GitHub and
    Avalon, system packages, Python packages, and JavaScript packages.
13. Secrets, repository content, command data, outputs, and audit records remain
    in the workspace's selected region; EU availability waits for vendor assurance.

## Non-goals

1. This is not a full coding harness, autonomous issue picker, IDE, user-visible
   terminal, debugger, SSH endpoint, or hosted application runtime.
2. PTYs, interactive commands, detached daemons, inbound services, and arbitrary
   long-running background processes are deferred.
3. Perl and other languages, alternative managers such as Poetry, Yarn, Bun, and
   Deno, arbitrary historical runtimes, private package feeds, and package
   publication are not launch promises.
4. Multiple repositories, Git submodules, Git LFS, cross-repository changes, and
   SSH Git transport are deferred.
5. Direct default-branch updates, arbitrary refs, force pushes, ref deletion,
   workflow-file changes, merges, releases, deployments, and GitHub
   administration are rejected.
6. CIDR/IP allow-lists and a custom Avalon egress gateway are deferred. The launch
   policy is domain-based and uses Daytona's primitive.
7. An expired sandbox is not transparently rebuilt from an R2 filesystem backup.
   Durable outputs survive, but unpublished local filesystem state may expire.
8. Daytona persistence is not Avalon's receipt or audit system.

## Product behavior

### Plugin availability and repository selection

The plugin is registered and eligible for every workspace in a supported region;
there is no workspace, user, or server-side feature flag. Bind's normal plugin
selection loads it when the request calls for bounded file, code, package,
command, or artifact work. Loading does not start Daytona. Scratch work requires
no GitHub connection. Repository work requires an active GitHub App installation
with access to exactly one selected repository. An attached repository or PR is
authoritative; otherwise Avalon uses an exact `owner/repo` in the request or asks
the participant to choose.

The plugin's canonical ID is `avalon:terminal`, model ID is `avalon_terminal`,
and its Bind short wire name is `terminal`. Canonical `read_file` therefore
reaches the model as `terminal_read_file`; every tool below follows the same
rule. Durable policy and receipts store the unprefixed canonical tool name,
avoiding a doubled plugin prefix.

When the plugin loads, Bind exposes its complete tool family together. There are
no `sandbox:work`, `repository:work`, or `repository:publish` scopes and no
intent-based tool filtering. Scratch, repository, resource, terminal, and
publication tools all remain visible so the model does not have to infer which
tool subset a host selected.

Visibility is not authorization. Repository-dependent calls require a currently
authorized selected repository, and `publish_branch_and_pr` requires explicit
participant publication intent plus the normal current external-write checks.
The executor returns a model-visible precondition or authorization error when
those conditions are absent; it does not remove the tool or ask Bind to rerun
with a wider tool set.

### Workspace network access

An owner or administrator manages **Settings → Workspace → Terminal workspace →
Network access**:

- **Trusted only** is the default. Avalon configures Daytona's native
  `domainAllowList` with the immutable baseline plus workspace-approved domains.
- **Full internet** removes the sandbox domain allow-list on a Daytona tier that
  supports public internet access. The confirmation warns that code, repository
  content, attachments, and generated data may reach arbitrary third parties.

The launch release accepts exact domains such as `api.example.com` and wildcards
such as `*.example.com`. Values contain no scheme, port, path, query, or
credentials; Avalon normalizes internationalized names and rejects public-suffix
wildcards. Daytona currently limits a domain allow-list to 20 entries, so Avalon
reserves the entries required by its baseline and shows the remaining custom
capacity instead of promising a separate product limit.

The baseline is shown as four compact, non-removable groups:

| Settings group | Purpose |
| --- | --- |
| GitHub and Avalon | Clone/fetch, read-only GitHub CLI access, and required Avalon endpoints |
| System packages | Signed base-image `apt` repositories |
| Python packages | PyPI package files and the reviewed `uv` distribution endpoints |
| JavaScript packages | npm package files and the reviewed `pnpm` distribution endpoints |

A reviewed server manifest expands these groups into exact domains. The primary
settings screen names the groups; the exact expansion and before/after changes
are available in the regional audit view and as a download. Reachability does not
imply package trust, credentials, publishing rights, or account administration.

Daytona documents GitHub, npm, PyPI, and signed system repositories as essential
services. Provider acceptance tests must prove that they remain reachable with a
custom `domainAllowList` and that unlisted domains, direct-IP attempts, metadata
endpoints, and organization-denied targets remain blocked. A failed assertion
blocks Trusted-only launch; this PRD does not add a proxy fallback.

Members can view the mode and named groups but cannot mutate them. The model sees
the effective mode and a bounded domain summary but receives no network-policy
tool. A denied request returns `network_policy_denied` and says an owner or
administrator may approve the domain.

Every mode or domain mutation is regional, audited, and creates a workspace
activity event. Any change cancels active commands and stops affected sandboxes.
Avalon applies and verifies the new native Daytona setting while each sandbox is
stopped; the next sandbox-dependent call explicitly starts it under the current
policy. There is no hot policy migration. An already running sandbox never gains
a wider policy: the policy change stops it before later work can start under the
new configuration.

### Starting and restoring the workspace

Loading the plugin does not contact Daytona. The first file, command, or resource
transfer tool obtains a work-stream lease. Avalon atomically creates a sandbox from a
pinned snapshot or explicitly starts the current stopped or archived sandbox,
checks its workspace identity and network revision, and executes the call.
Concurrent first calls converge on one sandbox.

The transcript shows “Starting terminal workspace,” “Resuming terminal
workspace,” or “Restoring terminal workspace.” A failure remains visible with a
stable reason; it is never represented as an empty successful workspace.

Scratch mode begins with an empty task directory and host-owned resource output
directory. Repository mode clones over HTTPS, records the requested base ref and
SHA, and creates `avalon/<work-stream-suffix>/<slug>`. The server fixes the
repository, base, and branch; repository instructions cannot expand tools,
change the selected repository, weaken network policy, or relax server limits.

### File tools

The plugin exposes `read_file`, `edit_file`, `write_file`, `apply_patch`, and
`import_resource`. The model uses familiar shell commands such as `ls -la`,
`find`, `rg --files`, and `rg` through `run_terminal_cmd` for discovery and
search; there are no model-facing list, glob, grep, stat, cursor, or file-revision
tools.

Paths are relative to the repository or scratch root and are checked after
symlink resolution. Reads are explicitly truncated. The first sandbox-dependent
call gives its Terminal run an exclusive work-stream mutation lease through run
completion; another run cannot interleave filesystem or command calls. Within
the owning run, typed mutations and terminal commands serialize under an
operation lock. Exact edits and patch contexts are checked while holding that
lock; patches apply all-or-nothing. The host records
internal before/after content hashes for receipts and response-loss
reconciliation, but those hashes are neither model arguments nor optimistic
concurrency tokens.

File operations appear as concise activity rows. Avalon persists the final diff
as a durable regional output before retention can delete unpublished files.

### Model-facing tool contracts

These are the complete launch tools. The shapes below are normative pseudo-
TypeScript for the JSON schema exposed to the model: `?` means optional, all
paths use `/` separators, timestamps are RFC 3339 UTC strings, and omitted
numeric limits use server defaults. The schema contains descriptions and
server-advertised maxima so the model does not have to discover limits by
failure.

Every tool accepts exactly one JSON object containing the arguments shown below.
Unknown fields are rejected by a strict runtime schema as well as declared with
`additionalProperties: false`. Arguments and output fields use the repository's
existing camel-case convention. The names below are canonical names local to the
terminal plugin; Bind adds the plugin's short wire prefix when exposing
them to the model.

A successful executor returns the output object shown below as
`HarnessToolResult.output`; the host-only `summary` labels transcript activity
and is not part of model output. Bind puts that output in its existing wrapper:

```ts
type BindSuccessfulToolResult<T> = {
  success: true;
  data: T;
};
```

Each `*Output` below is the `T` in that model-visible result. This PRD does not
add another `{ok, data}` envelope inside it.

A tool throws a typed error for failure. Bind projects its fixed message plus the
allowlisted structured recovery shape merged by PR
[#144](https://github.com/juno-ai-labs/avalon/pull/144):

```ts
type TerminalFailureData = {
  code: string;
  details?: {
    reason?: string;
    field?: string;
    expected?: string;
    available?: string[];
    reconnectRequired?: boolean;
    retryAfterMs?: number;
  };
};

type BindFailedToolResult = {
  success: false;
  kind: "validation" | "authz" | "external";
  error: string;
  data?: TerminalFailureData;
};
```

Only `data` is the model-recoverable structured detail; human `summary` text is
never used as the sole remediation. Details never contain secrets, raw provider
errors, host paths, object keys, or Daytona identifiers. Common codes are
`invalid_arguments`, `sandbox_start_failed`, `sandbox_unavailable`,
`path_outside_root`, `not_found`, and `limit_exceeded`.
Tools add the stable codes named below. Deterministic input/policy failures are
definitive; only genuinely transient failures are eligible for host retry under
Bind's existing classification.

Typed file mutations use durable invocation receipts and internal hashes to
reconcile a lost response. If the host cannot prove that the intended result is
present or absent, it returns `ambiguous_external_write` and never blindly
replays the mutation. This is crash recovery, not model-visible compare-and-swap.

#### `read_file`

Use for UTF-8 text. `offset` is a one-based starting line and defaults to one;
`limit` is a line count capped by the server.

```ts
type ReadFileArguments = {
  filePath: string;
  offset?: number;
  limit?: number;
};

type ReadFileOutput = {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
};
```

`content` is the exact raw text for the returned line range; line numbers are
rendered separately from `startLine` and are never inserted into the content a
model might reuse in `oldString`. Non-regular or non-text files return
`not_text_file`; an offset beyond EOF returns an empty successful page.

#### `edit_file`

Use for an exact replacement in an existing UTF-8 file. The model should read
the file first and copy enough surrounding text for an unambiguous match.

```ts
type EditFileArguments = {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

type EditFileOutput = {
  filePath: string;
  replacements: number;
  additions: number;
  deletions: number;
};
```

Without `replaceAll`, `oldString` must occur exactly once. Zero matches return
`match_not_found` and multiple matches return `match_not_unique`. Matching and
replacement happen atomically under the operation lock.

#### `write_file`

Use to create a complete UTF-8 file or deliberately replace one. Existing
content is replaced in full, so the tool description tells the model to use
`read_file` and `edit_file` when it does not intend a complete overwrite.

```ts
type WriteFileArguments = {
  filePath: string;
  content: string;
};

type WriteFileOutput = {
  filePath: string;
  created: boolean;
  bytes: number;
  additions: number;
  deletions: number;
};
```

Parent directories may be created only beneath the applicable root. The write
is size-limited and atomic.

#### `apply_patch`

Use for a multi-file UTF-8 unified diff. The model should inspect affected files
first. Path validation and every hunk are checked before any file changes.

```ts
type ApplyPatchArguments = {
  patch: string;
};

type ApplyPatchOutput = {
  files: Array<{
    path: string;
    previousPath?: string;
    operation: "created" | "edited" | "renamed" | "deleted";
    additions: number;
    deletions: number;
  }>;
  additions: number;
  deletions: number;
};
```

For a rename, `path` is the destination and `previousPath` is the source. Path,
context, or hunk failure returns `patch_does_not_apply`; partial application is
forbidden.

#### `run_terminal_cmd`

Use for one bounded, non-interactive Bash command. The command executes as a Bash
script fragment in `cwd`, which defaults to the applicable root. `timeoutMs` is
clamped to the server maximum. `description` is a short participant-facing
activity label and does not affect execution.

```ts
type RunTerminalCmdArguments = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  description?: string;
};

type RunTerminalCmdOutput = {
  state: "completed" | "failed" | "timed_out" | "cancelled";
  terminationReason:
    | "exited"
    | "timed_out"
    | "cancelled"
    | "output_limit_exceeded";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputResourceId?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};
```

The model always receives one final result; Bind may suspend and auto-resume
internally. There is no running result or poll/input tool. Stable failures include
`command_rejected`, `network_policy_denied`, `unsupported_runtime`, and
`unsupported_package_manager`. Once a command is accepted, nonzero exit,
timeout, cancellation, and output-limit termination are successful tool calls
whose `state` and `terminationReason` tell the model what happened; they are not
transport failures. The self-healing catalog below defines when another command
is safe. A nonzero exit uses `state: "failed"` and
`terminationReason: "exited"`.
The stable provider task ID stays in host reconciliation state because no later
model tool accepts it.

#### `import_resource`

Use to copy the original bytes of one currently authorized work-stream resource
into the repository or scratch filesystem. When `destinationPath` is omitted,
Avalon chooses a deterministic collision-resistant path beneath
`.avalon/resources/`; repository mode excludes that host-managed directory
through `.git/info/exclude`. Automatic placement is create-or-reuse.

When `destinationPath` is supplied, the import is create-only by default. The
model must set `overwrite: true` to replace an existing regular file
deliberately. `overwrite` is rejected without `destinationPath`.

```ts
type ImportResourceArguments =
  | {
      resourceId: string;
      destinationPath?: never;
      overwrite?: never;
    }
  | {
      resourceId: string;
      destinationPath: string;
      overwrite?: boolean;
    };

type ImportResourceOutput = {
  resourceId: string;
  filePath: string;
  outcome: "created" | "reused" | "replaced";
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
};
```

Avalon reauthorizes the exact `workstream_resources` relationship and current-
principal visibility before reading bytes. It streams the original from regional
R2 through the host into Daytona, verifies byte count and hash, and never gives
the sandbox an R2 credential, object key, or signed URL. Automatic placement
reuses an existing file only when its resource identity, size, and source hash
match. A changed automatic destination returns `destination_exists` rather than
overwriting it or silently choosing another path. An explicit destination that
already exists also returns `destination_exists` unless `overwrite: true`.

Stable failures include `resource_not_found`, `resource_not_importable`,
`resource_limit_exceeded`, and `destination_exists`. Import is a sandbox write
with `record_before_execute` receipt policy; the host reconciles destination
content hash, resource identity, and source hash before any retry.

#### `publish_resource`

Use after a command creates one stable regular file beneath
`AVALON_RESOURCE_DIR`. `filePath` is relative to that directory, not the
repository.

```ts
type PublishResourceArguments = {
  filePath: string;
  displayName?: string;
  description?: string;
};

type PublishResourceOutput = {
  resourceId: string;
  title: string;
  resourceType: "generated_file";
  provider: "avalon_generated";
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
  attachmentKind:
    | "image"
    | "markdown"
    | "pdf"
    | "document"
    | "spreadsheet"
    | "presentation"
    | "text"
    | "other";
  contentMode: "read" | "view" | "unsupported";
  derivativeStatus: "pending" | "ready" | "unsupported";
  canonicalUrl?: string;
  createdAt: string;
};
```

This output deliberately matches the resource vocabulary shipped by PR #144.
The tool creates a normal regional `resources` row, attaches it to the current
work stream, and returns the identity required by the existing
`workstream_list_resources`, `workstream_read_resource`,
`workstream_search_resource`, `workstream_view_resource`, and
`workstream_summarize_resource` tools. Verified MIME bytes, not the supplied
display name or extension, determine `attachmentKind`, `contentMode`, and the
reusable derivative path. The optional URL is an authorized Avalon canonical
address, never a raw R2 or Daytona URL.
`sourceSha256` identifies the published original and is intentionally distinct
from PR #144's later derivative-version hash.

The originating activity is the command or file write that last produced the
resource. Stable failures include `resource_not_ready`, `resource_empty`, and
`resource_limit_exceeded`. A verified but non-readable type still publishes as
kind `other` with content mode `unsupported`, so archives and other download-only
outputs are not mislabeled as failures. A retry of the same durable tool
invocation returns its persisted resource. A later invocation may intentionally
publish another resource with the same bytes; content hash alone does not
collapse resource identity, title, relationship, or retention.
Provenance is stored on the resource but omitted from this model output because
no follow-up tool consumes an activity or work-stream ID.

#### `publish_branch_and_pr`

Use only after repository changes are validated and committed and the participant
has explicitly requested publication. The tool is always exposed with the rest
of the plugin, but its executor revalidates current publication authorization.
The repository, base, head, commit, and remote are intentionally absent from the
model arguments.

```ts
type PublishBranchAndPrArguments = {
  title: string;
  body: string;
};

type PublishBranchAndPrOutput = {
  repository: string;
  baseRef: string;
  headRef: string;
  commitSha: string;
  publishedSha: string;
  outcome: "created" | "updated" | "unchanged";
  pullRequest: {
    number: number;
    url: string;
    title: string;
    state: "open";
  };
};
```

Stable failures include `repository_not_configured`,
`publication_not_authorized`, `working_tree_dirty`, `nothing_to_publish`,
`publication_policy_denied`, `publication_conflict`, `connection_revoked`, and
`github_unavailable`. Response-loss retries converge on the same branch commit
and head/base PR through the durable receipt.
The receipt ID is host state and is not exposed merely because the write uses
one; the model receives the commit and PR identity it needs next.

### Model-visible failures and loop recovery

Errors are part of the tool protocol, not transcript decoration. The `error`
sentences and recovery behavior below are normative; variable values belong in
allowlisted `data.details`, not interpolated provider messages. Every `error`
states the shortest safe next action in addition to the failure; a code or
diagnosis alone is insufficient. Each
`details.reason` contains the bounded next-step guidance. A reason that says
**stop** means the same invocation must not be retried: the participant,
authorization, policy, or external state must change first. The six detail keys
are exactly PR #144's current forwarding allowlist; the plugin does not invent a
field that Bind would silently discard.

Common failures apply consistently across the family:

| Tools | `data.code` | Model-visible `error` | Required recovery detail |
| --- | --- | --- | --- |
| all | `invalid_arguments` | “The tool arguments do not match its schema. Fix the identified field, remove undeclared fields, and call it again.” | `field` and `expected`. |
| all sandbox tools | `sandbox_start_failed` | “The terminal workspace could not be started safely. Retry only if a delay is provided; otherwise report the failure.” | Bounded `reason` and optional `retryAfterMs`. |
| all sandbox tools | `sandbox_unavailable` | “The terminal workspace is unavailable. Retry once only after a provided delay; without one, stop and report the failure.” | Bounded `reason` and optional `retryAfterMs`. |
| all sandbox tools | `network_policy_unavailable` | “The workspace network policy could not be verified. Stop and report the failure; do not run or weaken the policy.” | Bounded `reason`; never retry unless a later result supplies `retryAfterMs`. |
| path/cwd tools | `path_outside_root` | “The path must stay inside the terminal workspace. Use a relative path with `/` separators and no `..`.” | `field`. |
| file tools | `not_found` | “The requested file was not found. Use `terminal_run_terminal_cmd` with `pwd` and `ls -la` or `find` to inspect available paths before trying another file.” | Bounded `reason` names the applicable root. |
| bounded tools | `limit_exceeded` | “The request exceeds this tool’s limit. Reduce the identified range, bytes, output, or file count and try again.” | `field` and `expected`. |
| all `record_before_execute` writes | `ambiguous_external_write` | “The write may have completed but its result cannot be confirmed. Stop and report the ambiguity; do not repeat the write.” | Bounded `reason`; host reconciliation has already failed to prove success or absence. |

Read failures:

| Tool | `data.code` | Model-visible `error` | Self-healing next step |
| --- | --- | --- | --- |
| `read_file` | `not_text_file` | “This is not a regular UTF-8 text file. Use `terminal_run_terminal_cmd` with `file` or `ls -l` for metadata, or use resource tools for binary bytes.” | Bounded `reason` names the applicable resource route. |

File mutation and import failures:

| Tool | `data.code` | Model-visible `error` | Self-healing next step |
| --- | --- | --- | --- |
| `edit_file` | `match_not_found` | “`oldString` was not found. Read the file again, copy exact current text, and rebuild the edit.” | Reason names `terminal_read_file` for the same path. |
| `edit_file` | `match_not_unique` | “`oldString` matches more than once. Include more surrounding text, or use `replaceAll: true` only if every match should change.” | Bounded `reason` may report the match count. |
| `apply_patch` | `patch_does_not_apply` | “The patch does not apply to the current contents. Read the affected files again and regenerate the whole patch.” | Bounded reason names the paths. The host applies none of the patch. |
| `import_resource` | `resource_not_found` | “That work-stream resource is unavailable. List resources and choose a currently visible resource ID.” | Reason names `workstream_list_resources`. |
| `import_resource` | `resource_not_importable` | “The original bytes cannot be imported. Use an available resource read or view tool instead.” | `available` names `workstream_read_resource` or `workstream_view_resource`; reason explains which one to call with the same ID. |
| `import_resource`, `publish_resource` | `resource_limit_exceeded` | “The resource exceeds the allowed size or count. Select, split, resize, or compress it before trying a new invocation.” | `field` and `expected`. |
| `import_resource` | `destination_exists` | “The destination already contains different bytes. Choose another path, or use a new explicit import with `overwrite: true` only when replacement is intended.” | Bounded `reason` identifies whether the collision was at the automatic or explicit destination. |

An accepted command returns `RunTerminalCmdOutput`, even when the program does
not finish successfully. The loop branches on this result rather than treating
normal process outcomes as tool transport errors:

| Result | Model-visible meaning | Self-healing next step |
| --- | --- | --- |
| `state: "failed"`, `terminationReason: "exited"` | The process exited nonzero; stdout, stderr, and `exitCode` are authoritative. | Diagnose the captured output, change the command or files, and do not rerun the identical command without a reason. |
| `state: "timed_out"` | The host killed the process at its deadline; partial output and filesystem effects may exist. | Inspect output and relevant files or Git status first; then narrow the work or increase `timeoutMs` within the advertised cap. |
| `state: "cancelled"` | A participant or host cancelled the process. | Stop; do not restart unless the participant asks to continue. |
| `terminationReason: "output_limit_exceeded"` | The host killed a process producing unsafe output volume. | Reduce verbosity or redirect expected non-secret output to a workspace file and inspect it with bounded file tools. |

Pre-execution command errors remain failed tool results:

| `data.code` | Model-visible `error` | Self-healing next step |
| --- | --- | --- |
| `command_rejected` | “This command requests forbidden behavior. Use one bounded non-interactive command, dedicated file tools, or the authorized publication tool instead.” | Bounded `reason` names the rejected behavior and applicable route. |
| `network_policy_denied` | “This workspace does not allow that network destination. Stop retrying it and tell the participant an owner/admin must approve it or choose Full internet.” | Bounded `reason`; the model cannot change workspace policy. |
| `unsupported_runtime` | “This runtime is unsupported. Choose one of the available runtimes or report the limitation.” | `available` lists Bash, Python, JavaScript, TypeScript, and SQLite. |
| `unsupported_package_manager` | “This package manager is unsupported. Use the repository’s available supported manager or report the limitation; do not rewrite the project merely to proceed.” | `available` lists apt/dpkg, pip/uv, and npm/pnpm. |

Publication failures:

| Tool | `data.code` | Model-visible `error` | Self-healing next step |
| --- | --- | --- | --- |
| `publish_resource` | `resource_not_ready` | “The output is not a stable regular file. Wait for its command to finish, then write or rename the final file beneath `AVALON_RESOURCE_DIR` and use a new invocation.” | Bounded `reason` identifies instability without leaking a host path. |
| `publish_resource` | `resource_empty` | “The output file is empty. Inspect its producer, regenerate a non-empty result, and publish that file.” | Bounded `reason` may identify the producing invocation. |
| `publish_resource` | `not_found` | “No output file exists there. Use a path relative to `AVALON_RESOURCE_DIR`, not a repository-relative or absolute path.” | `field` is `filePath`. |
| `publish_branch_and_pr` | `repository_not_configured` | “No authorized repository is selected for this work stream. Stop and ask the participant to attach or select one before publishing.” | Bounded `reason`; never retry until repository context changes. |
| `publish_branch_and_pr` | `publication_not_authorized` | “Publication is not currently authorized. Stop and ask the participant to request publication or restore repository access; do not retry until authorization changes.” | Bounded `reason`; never retry until participant intent or connection authority changes. |
| `publish_branch_and_pr` | `working_tree_dirty` | “The working tree is dirty. Run `git status --short`, review and validate the diff, then commit the intended changes before publishing.” | Bounded `reason` names no untrusted content. |
| `publish_branch_and_pr` | `nothing_to_publish` | “There is no committed change to publish. Stop, or make and commit the requested change without creating an empty commit.” | Bounded `reason` may state that `HEAD` equals the base. |
| `publish_branch_and_pr` | `publication_policy_denied` | “The committed diff contains a forbidden change. Inspect the full base diff and stop unless the request can be satisfied without it.” | Bounded `reason` names the paths. |
| `publish_branch_and_pr` | `publication_conflict` | “The remote branch or base changed. Fetch read-only state, rebase or resolve without force, rerun validation, commit, and publish again.” | Bounded `reason` describes the conflicting ref state without credentials. |
| `publish_branch_and_pr` | `connection_revoked` | “The GitHub connection no longer authorizes this repository. Stop and ask the participant to reconnect or restore App access.” | `reconnectRequired: true`. |
| `publish_branch_and_pr` | `github_unavailable` | “GitHub is temporarily unavailable and publication was not confirmed. Retry once only after a provided delay.” | Optional `retryAfterMs`; reconciliation runs before the retry to prevent a duplicate PR. |

Contract tests assert every row's code, message, allowlisted structured details,
and retry classification. Prompt evaluations include wrong first
attempts so a medium routed model must recover without a hidden host instruction
or access to the human-only `summary`.

### Explicit language and package support

This table is the exhaustive launch support promise:

| Language | Pinned snapshot capability | Supported managers/hosts |
| --- | --- | --- |
| Bash | Bash, POSIX `sh`, standard Unix tools | `apt`/`dpkg` for sandbox-local system packages |
| Python | One pinned Python 3, `venv` | `pip`, `uv`, and PyPI |
| JavaScript | Node.js 22 | `npm`, `pnpm`, and the npm registry |
| TypeScript | Node.js 22, pinned `typescript` and `tsx` | `npm`, `pnpm`, and the npm registry |
| SQLite | Pinned SQLite 3 CLI and Python/Node bindings in fixtures | Local database files; host-language manager when needed |

Manager binaries and runtime versions are pinned in the snapshot and may not
self-update globally. Installs are repository-local, virtual-environment-local,
or sandbox-local. For an existing repository, the agent uses a supported manager
declared by its lockfile or `packageManager` field. It does not translate an
unsupported manager or rewrite a lockfile merely to make validation pass; it
returns `unsupported_package_manager` or `unsupported_runtime`. New scratch work
uses the smallest suitable supported manager.

There is no custom package-manager resolver. The model uses the native CLIs and
repository declarations it already understands. Frozen/locked install modes are
preferred for validation when the chosen manager provides one. A package that
redirects to an unlisted domain receives `network_policy_denied` in Trusted only.

The plugin injects a concise, high-salience system-prompt block alongside the
tool descriptions. It must say, in substance:

> You have a Daytona terminal workspace with Bash, Python, JavaScript (Node.js
> 22), TypeScript, and SQLite. Use these tools when code is the clearest reliable way
> to calculate, transform data, analyze files, validate a repository, or create a
> graph, image, dataset, report, or archive. Prefer Bash for simple CLI/file
> pipelines, Python for analysis and generated artifacts, JavaScript/TypeScript
> for Node and web-shaped data, and SQLite for relational transforms. Supported
> installers are apt/dpkg, pip/uv, and npm/pnpm. Do not install another runtime or
> manager; report an unsupported requirement. Use `ls`, `find`, `rg --files`, and
> `rg` through the terminal for discovery and search. For deliberate text
> changes, read first and use the exact edit or patch tools; use `write_file` only
> for intentional complete replacement.

This guidance makes code execution discoverable without telling the model to start a
sandbox speculatively. The first chosen tool call still owns lazy start.

### Running commands and workflow auto-resume

`run_terminal_cmd` runs one bounded, non-interactive command in the repository or
scratch root, or a relative directory below it. The caller supplies the command,
working directory, and a timeout up to the server cap. It cannot request a PTY,
daemon, arbitrary environment secret, Daytona ID, or host path.

Short commands return their final structured result directly. For a command that
outlives the current request window, Avalon starts a Daytona session command,
persists its task ID, suspends the Bind run, and consumes Daytona's WebSocket log
stream. Command exit persists bounded stdout/stderr and automatically wakes and
resumes the Bind run with the final tool result. The model does not receive a
poll-output tool and spends no turns checking status.

If the stream drops, a low-frequency host reconciler checks the provider task
until it reaches a terminal state or its wall-clock deadline. This is resilience,
not model polling. Participant cancellation and the server deadline can kill the
task. A lost result is reconciled from the task record and sandbox state; Avalon
never blindly submits the command again.

The transcript shows command, working directory, state, duration, exit code, and
bounded output. When a participant-facing complete log is retained beyond the
inline cap, Avalon registers it as a generated text resource and returns its
`outputResourceId`; an internal receipt object is never presented as a download.
Secrets and terminal controls are scrubbed before model or participant display.

`git` and read-only `gh` are ordinary commands within this boundary. The sandbox
has no GitHub write credential, and command policy rejects `git push` and
mutating `gh` operations. Publication uses the typed operation below.

### Resource exchange and generated artifacts

`import_resource` copies an authorized resource's original bytes into the
repository or scratch root. Its automatic `.avalon/resources/` destination is
host-managed and excluded from Git without modifying tracked ignore files. An
explicit destination may intentionally place the file elsewhere in the root,
including a path the participant wants edited or committed. It is create-only by
default and requires `overwrite: true` for deliberate replacement.

Programs write requested outputs into a host-owned resource directory outside the
Git working tree. `publish_resource` validates path, stability, size, count,
verified MIME type, and hash, then publishes the file through the resource system
merged in PR #144. It creates one `avalon_generated`/`generated_file` resource,
attaches it to the current work stream with relationship type `attachment`, and
creates an open/download affordance. It does not commit the file unless the
participant separately asked for it as a repository change.

The publication cap is no larger than the resource subsystem's upload cap, and
the existing source-byte, Office expansion, PDF page, image dimension/pixel, and
derivative-character limits continue to govern later hydration. A resource may
therefore be safely downloadable even when its content mode is `unsupported` or
its derivative fails; publication never claims that every file can enter model
context.

The write follows the existing regional object lifecycle. Avalon derives the
resource ID from the durable tool invocation, pre-registers its generation-
unique R2 object in `resource_object_deletion_outbox`, writes the bytes, and
atomically publishes the `resources` and `workstream_resources` rows before
cancelling the winning cleanup entry. A failed or stale publisher leaves cleanup
reaper-owned. Resource deletion queues the source and derivative objects;
detaching one work-stream relationship revokes that view but does not delete a
potentially shared resource.

Attaching the resource advances the work stream's inventory revision. The
resource therefore appears in the right sidebar, pageable resource discovery,
and the deterministic current-principal inventory after compaction. Every later
read, search, view, summary, replay, and historical protocol reconstruction uses
PR #144's current-principal visibility predicate and exact derivative dependency
checks. Knowledge of the returned resource ID or canonical URL never grants
access.

`displayName`, `description`, filenames, detected content, and derivative text
remain untrusted resource data. They are length-bounded and never enter a plugin
system message, authorization decision, object key, or executable command.

Generated-resource provenance is intentionally modest: content hash, byte size,
media type,
originating command or file-write invocation, work-stream ID, creation time, and
optional repository commit. Avalon does not claim full reproducibility from an
exhaustive runtime, package, host, lockfile, and source-path graph.

Published resources follow normal work-stream resource retention rather than the
Daytona sandbox's 30-day filesystem expiry. Their bytes never pass through model
context during publication. The agent uses the existing authorized resource
tools when it later needs to read or view the result.

### Local Git and host-side publication

The model uses real `git status`, `git diff`, tests, `git add`, and `git commit`.
Commits use the Avalon bot identity. If the participant has not requested
publication, it stops at the local commit or diff and reports what is ready.

When publication was explicitly requested, the model calls:

```text
publish_branch_and_pr({ title, body })
```

The repository, base ref, deterministic head ref, and current committed `HEAD`
come from recorded server state, not model arguments. The operation requires a
clean working tree and rejects workflow-file changes. Avalon asks Daytona to
produce a bounded Git bundle for the committed branch, transfers it to the
trusted regional publisher, validates repository identity, ancestry, expected
old SHA, fixed ref, and diff policy, and then fast-forwards that one branch with
a fresh single-repository GitHub App token. The publisher creates or updates the
single PR for the recorded head/base and returns its canonical URL.

The publisher rejects default-branch writes, force/non-fast-forward updates, ref
deletion, caller-selected refs, workflow changes, and caller-supplied credentials.
A durable publication receipt keyed by tool invocation and canonical request
makes response-loss retries converge on the same remote commit and PR. The
repository/head/base uniqueness rule prevents duplicate PRs, while a later
authorized invocation with a new title or body may deliberately update that PR.

### Stop, archive, expiry, cancellation, and offline behavior

The model receives no lifecycle tools. Avalon holds a lease while a tool or
command is active, keeps the sandbox warm for five minutes, then stops it.
Daytona's 15-minute auto-stop is a backstop. A stopped sandbox is archived after
60 minutes of work-stream inactivity to release active compute and disk.

The Daytona archive is retained for 30 days from repository or scratch activity.
Before expiry, Avalon preserves only durable product outputs: bounded command
output, published artifacts, final repository status and diff, publication
receipts, and user-visible activity. It then deletes the sandbox and its secrets.
Avalon does not maintain a second restorable filesystem or Git-bundle archive in
R2. The UI warns that unpublished and unexported local files expire on the stated
date.

A later sandbox-dependent call after expiry starts a fresh sandbox and reclones
the authorized repository at current server-recorded state, or creates an empty
scratch directory. It does not silently apply an old patch. The participant can
download the preserved final diff and explicitly ask Avalon to apply it in a new
run.

Cancellation stops new commands, kills the active task, captures available
output and final diff, releases the lease, and stops the sandbox after a short
grace period. If the desktop disconnects, bounded server work continues and the
transcript reconciles on reconnect. Connection or installation revocation blocks
new repository calls and publication and removes the sandbox's read credential
before the next start.

## Impact on the product contract

The current implementation brief says the agent never receives a shell,
terminal, or arbitrary code execution. When this feature ships, that clause
becomes:

> The agent uses typed, authorized tools. A sandbox-capable run may execute
> bounded commands through typed command and file tools inside an isolated,
> workspace-network-policy-governed environment when the Terminal plugin is
> enabled. The agent never receives host access, a
> user-visible terminal, or a user-authored workflow runtime.

The implementation brief changes only in the shipping change. Its regional,
bounded-run, visible-action, and external-write requirements remain unchanged.

## Key design decisions

1. **One lazy Daytona sandbox per work stream.** Per-message sandboxes repeat
   clone/install cost; workspace-wide sandboxes mix unrelated authority.
2. **Typed mutations plus shell-native discovery.** Models use familiar `ls`,
   `find`, and `rg` commands for discovery and search. Bounded reads, exact edits,
   complete writes, and atomic patches keep consequential mutations structured.
3. **Five languages and five manager commands at launch.** Bash, Python,
   JavaScript, TypeScript, SQLite, `apt`/`dpkg`, `pip`, `uv`, `npm`, and `pnpm`
   cover the requested code-mode tasks without turning snapshot support into a
   general build-platform matrix.
4. **Make language choice obvious in the plugin system prompt.** Tool presence
   alone is too subtle; compact usage guidance helps the model recognize when a
   short supported program is preferable to prose or bespoke tools.
5. **Use native Daytona domain policy.** Domains cover the launch need and avoid a
   custom DNS-aware regional proxy. CIDR support is deferred rather than forcing
   incompatible domain/CIDR primitives into a union.
6. **Stop on every network-policy change.** Applying one current policy at the
   next explicit start is easier to reason about than migrating live sandboxes.
7. **Auto-resume Bind, not the sandbox.** A command-completion event resumes the
   suspended workflow; the model never polls. A stopped Daytona sandbox still
   starts explicitly on the next tool call.
8. **No launch PTY.** Bounded non-interactive commands satisfy validation and
   generation tasks while avoiding terminal input, background lease, and
   cancellation complexity.
9. **Keep GitHub write authority host-side.** The model uses real Git locally,
   while one typed publisher protects refs and PR convergence without a custom
   smart-HTTP Git proxy or write token in untrusted code.
10. **Keep file concurrency internal.** One Terminal run owns the work-stream
    mutation lease at a time. File writes use exact-match or patch-context checks
    plus internal before/after hashes; commands use task state and
    reconciliation. Durable receipts cover imports, publication, artifacts, and
    administrative policy changes without exposing compare-and-swap tokens to
    the model.
11. **Publish through the resource subsystem merged in PR #144.** Generated files
    need the same durable identity, visibility, derivatives, sidebar display,
    compaction rediscovery, replay fencing, and cleanup lifecycle as uploaded
    attachments. A parallel artifact catalog or raw download reference would
    recreate those solved boundaries. Provenance stays modest: hash, size, type,
    invocation, time, and optional commit.
12. **Use Daytona archives, then expire local state.** Duplicating sandboxes into
    R2 adds a reconstruction subsystem. Durable outputs survive; the UI makes the
    30-day local-state limit explicit.
13. **Show named target groups first.** Exact domain expansions are useful for
    audit and debugging, not for the primary settings decision.

## Data model

The implementation adds regional records at sketch level; migrations and
[`../../data-model.md`](../../data-model.md) become authoritative when code lands.

- `workstream_sandboxes`: one row per work stream with mode, Daytona ID, snapshot
  version, logical state, last activity, applied network-policy revision,
  stop/archive/expiry timestamps, and optimistic version. Repository identity,
  base ref/SHA, fixed branch, and known published tip are nullable. No secret is
  stored.
- `workspace_sandbox_network_policies`: workspace mode, monotonic revision,
  manifest version, actor, and timestamps.
- `workspace_sandbox_network_domains`: normalized exact or wildcard custom
  domain, creator, timestamps, and policy revision. Baseline groups remain in
  reviewed server configuration.
- `workspace_sandbox_network_policy_mutations`: append-only regional audit of
  mode and domain changes.
- `sandbox_tasks`: stable task ID, tool invocation, Daytona session command ID,
  working directory, state, deadline, exit code, bounded-output reference, and
  timestamps. This is reconciliation state, not a second receipt ledger.
- `repository_publications`: tool invocation, canonical request hash, repository,
  base/head refs, expected old SHA, committed SHA, pushed SHA, PR number/URL,
  state, and timestamps. Invocation/request uniqueness converges retries;
  repository/head/base uniqueness prevents duplicate PRs.
- Imported files add no resource copy outside the sandbox and expire with it.
  Generated resources do not add a second artifact catalog. They use PR #144's
  existing `resources`, `workstream_resources`, content/derivative identity,
  `resource_object_deletion_outbox`, inventory revision, visibility query, and
  attachment receipt dependencies. The resource provider is
  `avalon_generated`, its type is `generated_file`, and bounded provenance lives
  in resource metadata. R2 stores the selected source/derivative objects under
  that lifecycle plus internal receipts and final diffs, not a cold sandbox
  image.

Local file writes need no separate owner table. An import reconciles its
authorized resource identity, destination content hash, and source hash. A
terminal command is recorded before provider submission so Bind can
reconcile it, but the record does not make arbitrary shell effects replay-safe.
Durable receipt semantics apply to resource import, resource publication, branch
publication, and workspace network-policy mutation.
Replaying a completed resource publication rechecks that the resulting resource
is still visible in this work stream at its recorded source hash; deletion or
detachment never resurrects it from an old receipt.

## Regional and security impact

Each regional API uses a distinct least-privilege Daytona principal and creates
sandboxes only in an approved region. D1 stores mappings, task state, audit, and
publication receipts; R2 stores bounded outputs, artifacts, and final diffs. The
Global registry and other region receive none of the repository content,
commands, outputs, branch data, or GitHub credentials.

The Daytona API key and GitHub App private key remain regional Worker secrets.
For clone/fetch and read-only `gh`, the regional API mints a short-lived,
single-repository, read-scoped installation token and places it behind Daytona's
host-scoped secret substitution. The sandbox sees only an opaque placeholder.
Git uses a URL-scoped pre-encoded Basic header so the placeholder itself is
substituted; no plaintext credential helper, remote URL token, environment value,
or command argument is created.

The trusted publisher alone receives a fresh contents-write and pull-request
token. It validates current participant intent, connection, repository, branch,
ancestry, expected old SHA, and diff before each write. It never accepts a token
from the sandbox or model.

The sandbox runs non-root by default and receives no Docker socket, host mount,
metadata access, inbound public port, or Avalon infrastructure credential. A
narrow sandbox-local elevation path may run the pinned system manager. Repository
content, package scripts, and command output are untrusted. Paths are root-
confined, resources are bounded, output and placeholders are scrubbed, and
current grants remain host-enforced.

Full internet deliberately permits exfiltration of non-secret data visible to the
sandbox. It never broadens secret substitution or the publisher's authorization.
Daytona organization policy remains a ceiling in both modes.

## Agent behavior

The plugin surface is:

- structured read, exact-edit, complete-write, and atomic-patch tools;
- `import_resource` for an authorized work-stream resource;
- `run_terminal_cmd` for one bounded non-interactive command;
- `publish_resource` for a generated file; and
- `publish_branch_and_pr` for the typed, host-authorized GitHub write.

The agent uses terminal-native discovery and search, prefers file tools for
bounded reads and exact edits, uses the terminal for repository/package/test
operations, checks the diff before committing, and never publishes without
explicit participant intent and current executor authorization. A successful
answer names changed files, validation and exit status, resource links, commit
SHA, and PR URL when present.
It reports unsupported runtimes, managers, network denials, and unrun validation
instead of silently substituting another environment.

## Provider configuration and operations

1. Upgrade the Avalon GitHub App's repository `Contents` permission to write while
   retaining Pull requests read/write. Do not add Workflows permission.
   Installations that have not approved the upgrade can still use every Terminal
   tool, but publication returns a reconnect/permission error.
2. Provision one least-privilege Daytona principal and secret namespace per
   enabled region, on a tier supporting archive, native domain allow-lists, and
   Full internet.
3. Publish an immutable snapshot containing the five language capabilities,
   supported managers, `git`, read-only `gh`, `rg`, and `jq`, and verify versions
   and smoke fixtures before marking a region supported.
4. Configure the trusted regional branch/PR publisher and GitHub App access. All
   tools remain exposed when publication is unhealthy; publication calls fail
   closed with an actionable error.
5. Validate Daytona's essential-service interaction, 20-entry domain limit,
   wildcard behavior, blocked-target behavior, WebSocket command completion,
   archive/restore, and regional location against the provider contract.

There is no plugin feature flag, per-user rollout, or read/edit/publish mode. A
supported region always registers the complete tool family. Global becomes a
supported region after synthetic repository and provider acceptance tests pass.
EU remains unsupported until legal and technical review confirms compute,
persistence, backup, deletion, and subprocessor residency.

Provider operations retain a regional emergency circuit breaker. It blocks new
sandbox leases and publication starts, cancels unstarted work, lets bounded
active commands finish or reach deadline, captures final diffs, and stops
sandboxes. It does not hide the plugin, alter its tool family, or delete retained
work. A call blocked by the breaker returns the normal model-visible
`sandbox_unavailable` failure with operator-supplied retry guidance when known.

## Acceptance

1. Every workspace in a supported region is eligible without a feature flag.
   Loading the plugin or discussing code creates no sandbox. Two concurrent first
   tools converge on one sandbox; different work streams receive different IDs.
   Activating the regional circuit breaker leaves all tools visible but makes a
   first sandbox call fail with non-retryable `sandbox_unavailable` unless an
   operator supplies `retryAfterMs`.
2. Bash, Python, JavaScript, TypeScript, and SQLite fixtures run, fail once in a
   controlled way, are revised, and pass. Snapshot verification fails on version
   drift.
3. `apt`/`dpkg`, `pip`, `uv`, `npm`, and `pnpm` fixtures install from their
   baseline groups in Trusted only.
   Unsupported languages/managers fail explicitly without conversion.
4. Prompt evaluation shows that the agent recognizes calculation, transformation,
   analysis, repository validation, graph/image generation, and archive tasks as
   candidates for one of the five languages without starting a sandbox for an
   unrelated request.
5. Traversal, symlink escape, oversized files/output, detached processes, timeout
   bypass, and forbidden egress return stable failures and do not escape bounds.
6. A short command returns directly. A long command suspends Bind, streams on the
   host, auto-resumes once on exit, and gives the model one final result without a
   polling tool. Stream-loss reconciliation neither loses nor duplicates it.
7. A private fixture repository can clone, edit, validate, diff, and commit with
   real Git while token-exposure attacks reveal at most opaque placeholders.
8. Every Terminal tool is exposed together whenever the plugin is loaded; there
   are no read/edit or publication tool subsets. Terminal commands still cannot
   push or mutate a PR. `publish_branch_and_pr` fast-forwards only the fixed
   branch and creates or updates exactly one expected PR after current
   authorization succeeds.
9. Publication rejects a dirty tree, wrong repository/ref/base, non-fast-forward,
   default-branch update, force/delete, workflow change, revoked connection, and
   caller credential. A response-loss retry returns the same PR.
10. Attached text, image, and dataset resources import at an automatic path. An
    explicit destination is create-only unless the model supplies
    `overwrite: true`; existing, missing, unauthorized, detached, oversized, or
    mismatched resources fail without overwriting a file or exposing an R2
    address. Graph image, structured dataset, and archive fixtures publish as
    `avalon_generated` resources with verified MIME, source hash, attachment
    kind, content mode, invocation, timestamp, and optional commit. They appear
    in the right sidebar and current-principal inventory and are usable through
    the existing read/search/view/summarize tools as their kind permits.
    Oversized/excessive resources fail explicitly.
11. New and existing workspaces default to Trusted only. An owner/admin can add
    and remove exact and wildcard domains; members cannot. Settings show four
    named baseline groups and remaining provider capacity; audit/download shows
    exact expansions.
12. Trusted only denies an unlisted domain and Full internet admits it after
    confirmation. Any policy change cancels active commands, stops the sandbox,
    applies the new native policy, and the next tool explicitly starts it.
13. Provider tests prove essential targets still work with `domainAllowList` and
    unlisted domains, direct IP, redirects, metadata targets, and alternate-host
    secret substitution do not bypass the effective policy.
14. Five-minute stop, 60-minute archive, archive restore within 30 days,
    cancellation, disconnect/reconnect, and explicit fresh start after expiry
    match the transcript and retention UI. Expiry preserves published resources,
    outputs, final diff, and receipts but not arbitrary local files.
15. Durable receipts exist for resource import, resource publication, branch
    publication, and network policy changes. Internal file-hash and command-task
    tests prove that concurrent mutating runs serialize and local operations
    reconcile without a second general receipt framework or blind replay.
16. Global/EU integration tests prove no regional data crossing, and EU production
    targeting remains impossible until the vendor gate is satisfied.
17. Generated JSON-schema snapshots exactly match every required, optional, and
    forbidden argument and every success/failure envelope in the model-facing
    tool contracts. Contract tests cover exact edits, atomic patch failure,
    explicit import overwrite, nonzero command exits, output truncation,
    same-invocation resource retry, and publication response-loss convergence.
    Every failed-tool snapshot asserts that `error` itself contains the shortest
    safe recovery or stop action and that contextual remediation survives Bind's
    detail allowlist.
18. Evaluation on the configured medium fallback model completes schema-only
    create, read/edit/edit, complete replacement, multi-file patch, automatic
    import, explicit binary replacement, command-failure diagnosis, and
    dirty-tree publication recovery fixtures. It uses shell-native discovery,
    rereads after exact-match or patch-context failures, and stops on
    authorization/policy failures instead of looping.
19. Resource integration tests use PR #144's shared visibility loader, inventory
    revision, derivative tools, receipt reauthorization, and deletion outbox.
    Detach/revoke/delete makes old IDs and replay results unavailable without
    deleting a shared object early or resurrecting a deleted resource; compaction
    rediscovery exposes only the currently authorized inventory.

## Open questions

1. **Does Daytona provide a contractually acceptable EU compute and persistence
   location for Avalon's selected-region promise?** This blocks EU availability,
   not Global implementation, and requires vendor evidence.
2. **Do Daytona essential services and a custom `domainAllowList` compose exactly
   as the launch policy assumes?** The provider test is a release gate. If the
   answer is no, product scope must change; a custom gateway is not an implicit
   fallback in this PRD.
