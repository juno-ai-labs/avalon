# Research: agent harnesses, terminal tools, and sandbox backends

> Point-in-time research record for the [Daytona terminal-plugin PRD](prd.md)
> and [design](design.md), updated 2026-08-12. This document records the
> alternatives and evidence behind the product requirements; it does not add
> requirements of its own.

## Scope and evidence

This research began with a broad question: what could Daytona add to Rally's
Bind agent loop? It then narrowed through comparisons with Cloudflare Code Mode,
Dynamic Workers, Workers for Platforms, Codex, Claude Code, OpenCode, and Grok
Build. Later rounds examined file mutation, Git and GitHub authorization,
network policy, cost and lifecycle, artifacts, and work-stream resources.

The first transcript called the xAI harness “Rock Build.” That was corrected to
**Grok Build**, and only Grok Build is evaluated below.

Three kinds of evidence are deliberately separated:

- **Documented** means an official product document or public first-party
  source file states the behavior.
- **Observed** means the behavior or schema was visible in the harness used for
  this research. It is useful evidence, but not necessarily a stable public API.
- **Inferred** means a design conclusion, such as expecting models to use
  familiar shell or Git commands more reliably than a novel collection of
  one-command tools. No claim is made about a vendor's private RL corpus.

Source snapshots used for source-level comparisons were:

- Rally `origin/main` at `a1e1c376c8a01b1df56d7e88e8f2da0e17a12459`,
  including merged PR
  [#144](https://github.com/juno-ai-labs/avalon/pull/144);
- Grok Build at
  [`e5fd4816`](https://github.com/xai-org/grok-build/tree/e5fd4816d43260c15ba785f103990c1ed6cea230c);
- OpenCode at
  [`cc4b4561`](https://github.com/anomalyco/opencode/tree/cc4b45612974f735ddec46009ede07729511fba4).

Pricing changes independently of code. All pricing examples use the public
rates visible on 2026-08-12 and must be refreshed before a purchase decision.

## Executive synthesis

The mature coding harnesses converge on a small set of primitives:

1. a broad shell command with an explicit working directory and timeout;
2. bounded `list`, `glob`, `grep`, and ranged `read` tools;
3. an exact-string edit and a complete-file write;
4. a multi-file patch tool;
5. explicit handling for long-running work, output truncation, and cancellation;
6. policy and authorization outside the command string;
7. ordinary `git` and `gh` CLIs for the large command surface models already
   understand.

The convergence is more important than any vendor's exact field spelling.
Shell-only agents suffer from quoting, path, stale-file, and output-size
failures. Agents with hundreds of tiny command-specific tools spend context on
schemas and ask the model to relearn mature CLIs. The useful middle is a broad
shell plus a few typed file and publication tools at the boundaries where
correctness, authorization, or durable replay matter.

Daytona and Cloudflare solve different problems:

- **Daytona** is a persistent Linux computer. It is the fit for package
  installation, repository state, Git, arbitrary CLI programs, Bash, Python,
  JavaScript, TypeScript, SQLite, and artifact files.
- **Dynamic Workers** are the fit for low-latency, request-shaped Code Mode:
  model-written JavaScript or Python calls typed host capabilities, filters
  intermediate data, and returns a compact result.
- **Workers for Platforms** is the fit for a platform that deploys and routes
  durable user Worker scripts at large scale. It is not a Linux development
  environment.

They can coexist. Rally can use Dynamic Workers for connector composition and
Daytona for stateful code or repository work. Workers for Platforms becomes
relevant if Rally offers deployed, addressable user applications rather than
one-shot agent computation.

The launch PRD therefore uses one lazy Daytona sandbox per work stream, familiar
file and terminal tools, non-interactive commands, host-driven suspend/resume,
read-scoped GitHub access, and a host-side typed PR publication tool. It does
not clone an entire coding harness.

## Daytona snapshot and image comparison

Daytona's current snapshot documentation distinguishes reusable container
snapshots from VM snapshots, permits snapshots built from a Dockerfile, requires
tagged or digest-pinned base images, and automatically deactivates an unused
snapshot after two weeks. Container snapshots preserve the filesystem and are
the correct class for Rally's command/file/Git workload; VM-only hot memory
snapshots, nested Docker/Kubernetes, and a separate kernel do not justify their
cost here ([snapshot documentation](https://www.daytona.io/docs/en/snapshots.md)).

Registry manifests and a live `us` account probe on 2026-08-13 produced this
comparison:

| Candidate | Manifest-layer total (amd64) | Runtimes and useful contents | Rally gaps | Decision |
| --- | ---: | --- | --- | --- |
| Managed `daytona-small` snapshot (0.9.0 when observed) | 6.85 GiB compressed underlying image | Daytona's best-supported default: Node, Python, TypeScript, uv, Git, `rg`, GUI tooling, ML/data/image libraries, and coding harness CLIs | No `/workspace`, SQLite CLI, pnpm, or `gh` in the observed revision | **Use with an idempotent compatibility bootstrap** |
| `daytonaio/sandbox:0.10.0` image | 6.91 GiB compressed | Same architecture as 0.9.0 with refreshed Daytona, Claude Code, Codex, OpenCode, and Python agent-package versions | Direct image use makes Rally own snapshot refresh and activation | Reject direct pinning; accept when Daytona promotes it behind the managed snapshot and probes pass |
| `daytonaio/sandbox:v0.185.0-slim-amd64` | 457 MiB compressed | Node 22.14, Python 3.14, TypeScript, uv, `rg`, sudo, NumPy, pandas, and matplotlib | Needs Git, `gh`, SQLite CLI, pnpm, `tsx`, common archive/build utilities, and an Rally-owned snapshot lifecycle | Reject in favor of the managed default |
| Generic `node:22-*-bookworm-slim` | Smallest base | Node 22 and apt | Rebuilds Daytona's user/sudo/Python/data-tool conventions and loses its curated agent baseline | Reject |

The slim image minimizes storage and cold-start weight, but it also makes Rally
own image builds, snapshot activation, and refresh compatibility. The managed
`daytona-small` snapshot is more common, exercises Daytona's standard path, and
is more likely to receive coordinated SDK/toolbox updates. Rally therefore
accepts its broader contents and adapts only the missing launch contract at
first creation. The separate executable manifest remains the authority for what
Rally advertises, so a managed update cannot silently change the prompt
contract.

The live `daytona-small` image was `0.9.0`; its toolbox ran
as unprivileged `daytona` despite a requested `user: "root"`, and its default
shell treated `status` as a reserved zsh variable. Those observations led to an
owned runtime workspace, passwordless-sudo bootstrap verification, and a
shell-neutral `avalon_status` command envelope.

Image size alone does not establish user-visible startup cost, and one live
probe does not establish a tail distribution. Rally therefore measures
provider allocation, policy read-back, compatibility installation, full
manifest verification, stopped warming, and archived restore separately in the
dedicated `avalon_terminal_operations` Analytics Engine dataset. The
human-readable report uses sampling-weighted counts and percentiles and records
which of the fixed SQLite/`gh`/pnpm/`tsx` gaps were actually installed. A custom
image can credibly claim only the recurring installation portion; it must still
pass the same verification and be compared on create/warm/restore reliability
plus snapshot maintenance.

## Harness comparison

| Harness | Command surface | File mutation surface | Long-running work | Git/GitHub posture | Main lesson for Rally |
| --- | --- | --- | --- | --- | --- |
| Codex host observed during this research | `exec_command` with `cmd`, `workdir`, output budget, wait budget, and optional TTY; `write_stdin` continues a live session | Distinct `apply_patch`; file inspection is normally done with fast CLI search/read operations | A running command yields a session identifier; later calls write or poll that session | Uses ordinary `git` and `gh` in the shell | Keep the command envelope small, make `workdir` explicit, and keep patching distinct |
| Claude Code | `Bash` with `command`, optional `timeout`, `description`, and `run_in_background` | `Read`, `Edit`, `Write`, `Glob`, and `Grep`; edit is exact and read-before-edit guarded | Background shell IDs and task controls; full oversized output is written to a file | Shell is the normal Git surface; permissions can gate command patterns | Exact edit and visible truncation rules prevent common recovery loops |
| OpenCode | `bash`/shell with `command`, optional `timeout`, and `workdir` in current source | `read`, `edit`, `write`, `glob`, `grep`, `list`, and `apply_patch` | Current shell is bounded and stores full truncated output for later read/search | Per-command permission patterns can distinguish `git diff` from `git push` | Schema/runtime agreement and recoverable truncation are production concerns, not polish |
| Grok Build | `run_terminal_cmd` with `command`, `timeout`, required `description`, and `is_background` | `read_file`, exact `search_replace`, `list_dir`, `grep`, Codex-style `apply_patch`, plus newer hash-line editing experiments | Background task ID, task output, kill, completion reminders, and streamed deltas | Ordinary CLI in an isolated workspace; worktree and checkpoint support live above tools | Tool names and shapes can stay familiar while the runtime behind them becomes sophisticated |
| Rally/Bind | No general shell before this PRD; strict typed plugin tools with capability, mode, idempotency, and timeout policy | The PRD adds bounded reads and exact mutation primitives while leaving discovery/search to familiar shell commands | Cloudflare Workflow, leases, receipts, checkpoints, and continuation already provide durable suspension | Existing GitHub App is host-owned; PRD gives the sandbox read access and keeps writes host-side | Use Bind's durable authority and Daytona's computer; do not put a second agent loop inside either |

### Codex

The Codex host used for this research exposed three relevant shapes:

```ts
type ExecCommandInput = {
  cmd: string;
  workdir?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
  shell?: string;
  tty?: boolean;
};

type ExecCommandOutput = {
  output: string;
  exit_code?: number;
  session_id?: number;
  wall_time_seconds: number;
};

type WriteStdinInput = {
  session_id: number;
  chars?: string;
  yield_time_ms?: number;
};
```

`apply_patch` is separate from command execution. This is an observed host
contract, not a claim that every Codex integration has this exact schema.
OpenAI's public model documentation independently confirms that the current
tool family includes hosted shell and apply-patch primitives, alongside MCP and
tool search
([model documentation](https://developers.openai.com/api/docs/models/gpt-5.4)).

The useful design properties are:

- the shell accepts a normal command rather than an invented command DSL;
- `workdir` avoids repeated `cd` quoting and accidental directory drift;
- a short host wait can return a stable session handle without pretending the
  process has finished;
- output is bounded independently from process lifetime;
- PTY allocation is an explicit choice rather than an accidental default;
- file patches are structured and reviewable.

Rally adopts the first, second, fourth, and sixth properties. It intentionally
does not expose a Codex-style session handle or `write_stdin` at launch. A
shared, asynchronous work stream has no reliable person continuously attached
to an interactive prompt, and Bind already has a durable suspend/resume path.

### Claude Code

Claude Code documents the following `Bash` input and output through its Agent
SDK:

```ts
type ClaudeBashInput = {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
};

type ClaudeBashOutput = {
  output: string;
  exitCode: number;
  killed?: boolean;
  shellId?: string;
};
```

The same reference documents `Read({file_path, offset?, limit?})`,
`Write({file_path, content})`, and exact-string
`Edit({file_path, old_string, new_string, replace_all?})`
([Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/python)).
Claude Code's tool reference adds several production details:

- Bash defaults to a two-minute timeout, can request up to ten minutes, and
  bounds output;
- oversized output is saved to a session file so the model can read or search
  it rather than rerun the command;
- a main-session working-directory change may persist, but exported environment
  variables do not;
- `Edit` requires a prior read, verifies that the file has not changed, requires
  an exact match, and requires uniqueness unless `replace_all` is requested
  ([tool reference](https://code.claude.com/docs/en/tools-reference)).

Its permission system also demonstrates an important boundary: denying the
`Read` tool does not prevent `cat` through Bash. Filesystem or network policy
that must apply to every process belongs in the sandbox, not only in model tool
permissions
([permission documentation](https://code.claude.com/docs/en/permissions)).

Anthropic's newer managed-agent toolset uses lower-case built-ins and a somewhat
different Bash session contract. That variation reinforces the conclusion that
the stable idea is the primitive, not one vendor's exact casing or session
semantics
([managed tools](https://platform.claude.com/docs/en/managed-agents/tools)).

### OpenCode

OpenCode's public documentation lists `bash`, `edit`, `write`, `read`, `grep`,
`glob`, and `apply_patch`. It explicitly describes exact-string edit and ranged
read, and groups all file mutation behind the same edit permission
([tool documentation](https://opencode.ai/docs/tools/)).

Current source makes the shell schema especially instructive:

```ts
type OpenCodeShellInput = {
  command: string;
  timeout?: number;
  workdir?: string;
};
```

The prompt tells the model to use `workdir` instead of `cd`, use dedicated
search/read/edit tools instead of shell approximations, run independent commands
in parallel, and chain dependent commands. Its current Git section also tells
the model to use `gh` for PRs, issues, checks, and releases, with explicit
pre-commit and pre-PR inspection rules. The executor parses the command to
identify external-directory access and permission patterns, ignores stdin,
applies a timeout, stores full oversized output, and returns a bounded tail with
the saved path
([schema and prompt](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/tool/shell/prompt.ts),
[Git/GitHub prompt](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/tool/shell/shell.txt),
[executor](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/tool/shell.ts)).

OpenCode permissions can be specified per command pattern. A review agent can,
for example, allow `git diff` and `git log` while asking before `git push`
([agent permissions](https://opencode.ai/docs/agents/)). Rally should not copy
shell-string permissions as its primary authorization system: quoting, wrappers,
and nested shells make that insufficient. The useful part is the separation
between broad local execution and a distinct external-write decision.

OpenCode's issue history also shows why strict schema agreement is a reliability
requirement. One released integration required a `description` value that was
not exposed to the model, making normal Bash calls fail; another class of reports
describes models rerunning commands after truncation instead of reading the saved
output
([schema mismatch](https://github.com/anomalyco/opencode/issues/13146),
[truncation retry loop](https://github.com/anomalyco/opencode/issues/11313)).
Rally must test the exact schema rendered to the model against the strict
executor schema and return an explicit continuation path for truncated output.

### Grok Build

Grok Build is now a public, first-party Rust harness. Its repository separates
the agent runtime, tools, workspace/VCS layer, and terminal UI
([repository](https://github.com/xai-org/grok-build),
[product documentation](https://docs.x.ai/build/overview)). That separation is
directly relevant to Rally: a terminal UI is not required to expose a terminal
command tool.

Its primary command is literally named `run_terminal_cmd`:

```ts
type GrokBuildTerminalInput = {
  command: string;
  timeout?: number;
  description: string;
  is_background: boolean;
};
```

The output is tagged as either a foreground Bash result or a background task
handle. The implementation supports streamed output deltas, a bounded prompt
view, a full output file, explicit timeout/kill reasons, background completion
reminders, task output, and task cancellation
([source](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230c/crates/codegen/xai-grok-tools/src/implementations/grok_build/bash/mod.rs)).

The file surface contains several generations of production learning:

- `read_file` takes `target_file`, `offset`, `limit`, and optional PDF page and
  format controls; returned line anchors are display metadata, not file bytes
  ([source](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230c/crates/codegen/xai-grok-tools/src/implementations/grok_build/read_file/mod.rs));
- `search_replace` takes `file_path`, `old_string`, `new_string`, and
  `replace_all`, requires a unique exact match by default, and has explicit
  recovery hints for user edits
  ([source](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230c/crates/codegen/xai-grok-tools/src/implementations/grok_build/search_replace/mod.rs));
- `grep` exposes regex, path, glob, context, case, type, output limit, and
  multiline controls over ripgrep rather than requiring shell quoting
  ([source](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230c/crates/codegen/xai-grok-tools/src/implementations/grok_build/grep/mod.rs));
- the repository includes Codex-style patch/read/list implementations,
  OpenCode-compatible tools, and experimental hash-line edit variants. The
  explicit attributions are useful evidence that production harnesses borrow
  familiar shapes rather than forcing a unique tool language.

Rally's `run_command` core fields align closely with Grok Build, while the
shorter canonical name avoids `terminal_run_terminal_cmd` after Bind adds its
plugin prefix. The deliberate divergence is backgrounding: Grok Build has a continuously
present local harness and task UI, while Rally has a durable Bind workflow and
shared transcript. Rally returns one final result after a host continuation;
the model does not receive a task ID to poll.

### Rally and Bind after PR #144

Bind owns model/tool iteration, plugin activation, deterministic routing, and
tool scheduling. Rally owns admission, authorization, leases, receipts,
regional stores, cancellation, and terminal state. The current architecture is
documented in [the agent harness](../../agent-harness.md).

Every Rally tool is a model-visible schema plus host policy:

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: object;
  capability: string;
  mode: "read" | "write";
  idempotency: "safe" | "provider_key" | "record_before_execute";
  timeoutMs?: number;
};
```

The executor must strictly parse its own arguments. JSON Schema's
`additionalProperties: false` tells the model what to send, but is not the
runtime enforcement point. Bind may overlap independent reads, serializes
writes, preserves model call order, and relies on Rally's durable receipts to
prevent unsafe replay. These rules are documented in
[Creating agent tools](../../agent-tools.md).

PR #144 also changed the artifact boundary. Attachments and generated files are
normal `resources` related to a work stream, not an independent artifact
catalog. The Daytona PRD consequently uses the existing resource inventory,
visibility, derivatives, deletion outbox, compaction appendix, and resource
tools described in
[agent attachments and resources](../../agent-attachments.md).

## What “Code Mode” means

Cloudflare defines Code Mode as a **tool-use pattern**: the model receives one
code-execution tool, writes a compact program against typed methods, and keeps
intermediate data inside the sandbox. It is most useful for dependent calls,
loops, branching, filtering, result shaping, and progressive tool discovery
([Code Mode](https://developers.cloudflare.com/agents/tools/codemode/)).

That definition separates three concerns:

1. **Model interface:** one code tool or many direct tools.
2. **Execution substrate:** Dynamic Worker, Daytona sandbox, browser, or another
   isolated runtime.
3. **Capability boundary:** typed host methods that authorize and execute the
   underlying operation.

Cloudflare's single-code-tool MCP pattern exposes methods under a `codemode`
namespace. Its search-and-execute pattern keeps a large OpenAPI document inside
the sandbox and returns only selected operations to the model. Direct external
network access is blocked; authenticated calls cross a host callback that owns
authorization
([MCP patterns](https://developers.cloudflare.com/agents/model-context-protocol/codemode/)).

Rally can recreate this pattern on Daytona later:

```ts
type ExecuteCodeArguments = {
  language: "python" | "javascript" | "typescript";
  code: string;
  description?: string;
};

type ExecuteCodeOutput = {
  value: unknown;
  stdout: string;
  stderr: string;
  artifacts: Array<{ resourceId: string; title: string }>;
};
```

The important part would not be the outer schema. Generated code would receive
typed proxies for already-authorized Bind tools, not provider credentials. Each
side-effecting proxy call would still need Rally's capability check, approval
policy, durable receipt, replay result, and audit record. Completed internal
calls must replay when an approval or Workflow suspension resumes the same
program. Cloudflare's durable Code Mode runtime already implements this
abort-and-replay idea; Rally would have to implement the equivalent across
Bind and Daytona.

This is a credible second plugin, but it is not the launch terminal plugin. The
launch tool family serves open-ended local computation and repository work. A
single Code Mode tool serves connector composition and context reduction.

## Terminal tool design

### Common geometry

Across the harnesses, the durable core is:

```ts
type TerminalArguments = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  description?: string;
};

type TerminalResult = {
  state: "completed" | "failed" | "timed_out" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};
```

Field-by-field conclusions:

- **`command`** should be a normal Bash script fragment. A command AST would be
  easier to policy-check but would discard the model's learned CLI fluency and
  still fail to represent pipelines, redirection, or package scripts.
- **`cwd`** should be a separate root-relative field. It avoids quoting errors,
  makes root confinement explicit, and stops hidden `cd` state from leaking
  between calls.
- **`timeoutMs`** should be optional and server-clamped. The description must
  state the actual default and maximum; a stale advertised timeout causes models
  to override operator policy.
- **`description`** is valuable for participant-facing activity, but it cannot
  affect authorization or execution. If optional in the model schema, it must
  also be optional in strict runtime validation.
- **`env`** should not be model-controlled at launch. It encourages secret
  plumbing and creates confusing persistence semantics. The host supplies a
  fixed, scrubbed environment.
- **stdout and stderr** should remain separate. Combining them is convenient for
  a local UI but loses diagnostics and makes safe redaction harder.
- **nonzero exit** is a completed tool call whose command state is `failed`; it
  is not a Bind transport error and must not trigger blind tool retry.
- **truncation** must be visible. Full output may become an authorized resource,
  but the model must never mistake a truncated view for complete output.
- **timestamps and duration** make timeout and lifecycle behavior auditable
  without exposing a provider task ID.

### Long-running commands

The harnesses demonstrate three viable shapes:

1. block until exit with a bounded timeout;
2. return a task or shell ID and expose output/input/kill tools;
3. move the command to host background work and notify the model on completion.

The initial design explored a fourth presentation built from the second and
third runtime shapes: start one Daytona session command, persist its stable
identity, suspend Bind, and issue a Workflow continuation after an event. The
implemented design found a smaller equivalent boundary: the existing regional
harness Workflow retries the exact Bind call after interruption, and the
Terminal executor reattaches to the sole command in its stable Daytona session.
The model still sees one final tool result. A host observer reads the command's
stable status after a lost response or Worker restart and never resubmits merely
because observation was interrupted.

This removes model polling, `sleep`, duplicate commands, and task-ID leakage.
It also makes a five-minute test command compatible with a short Worker request
without keeping an HTTP request open.

### PTY decision

Daytona provides a complete PTY primitive: create, connect, send input, resize,
wait, kill, and disconnect
([PTY documentation](https://www.daytona.io/docs/en/pty/)). Codex, Claude Code,
and Grok Build show that a PTY or live task channel can be useful for development
servers, REPLs, debuggers, and interactive installers.

Rally should not expose it at launch:

- interactive programs can wait forever for invisible input;
- prompts can display secrets or terminal control sequences;
- reconnect, resize, input ownership, and concurrent viewers add a second
  session protocol;
- a shared work stream has no single terminal owner;
- package managers, tests, Git, `gh`, and artifact generation all have
  non-interactive forms.

The Daytona implementation may use a non-PTY session command internally. A
later PTY feature should be a separately authorized capability with explicit
input, output cursor, cancel, lease, and human-ownership semantics.

### Start and stop

Loading the `avalon:terminal` plugin must not create a sandbox. The first
sandbox-dependent tool performs an idempotent get-or-create/start operation for
the work stream. Concurrent first calls converge on the same generation.

After the last activity:

- Rally stops the sandbox after five warm minutes;
- Daytona's 15-minute auto-stop remains a provider backstop;
- a stopped container is archived after 60 minutes;
- the archive expires 30 days after repository or scratch activity;
- durable resources and receipts outlive the sandbox under their own policies.

Auto-wake is preferable to model polling. A tool call starts or restores the
sandbox; a command completion wakes the suspended Bind run. The model never
calls `sandbox_start`, `sandbox_status`, or `sandbox_stop`.

## File discovery and mutation

The harnesses demonstrate two viable discovery styles: Claude Code, OpenCode,
and Grok Build add list/glob/grep tools, while Codex commonly uses `ls`, `find`,
`rg --files`, and `rg` through its command tool. Rally chooses the latter for
discovery and search, then retains typed tools where they materially constrain a
mutation:

| Operation | Mature-harness shape | Failure it contains | Rally addition |
| --- | --- | --- | --- |
| List/glob/grep | shell-native `ls`, `find`, and `rg` | extra schemas duplicate commands models already know | bounded `run_command` output and prompt guidance |
| Read | path, offset, limit | entire-file context blowup | exact raw text with separate line metadata |
| Edit | path, exact old/new strings, optional replace-all | fuzzy or ambiguous edits | exact unique match and atomic replacement |
| Write | path and complete content | partial or quoted shell writes | explicit complete replacement with a diff summary |
| Patch | unified patch | many fragile sequential edits | context validation and all-or-nothing multi-file apply |

An earlier draft added model-visible file revisions. They would have protected
typed mutations against state changes between calls, but Bash could still write
the same files without a revision. The resulting guarantee was partial while
every common edit acquired an observe-copy-token-mutate loop. The launch design
instead gives one Terminal run an exclusive work-stream mutation lease,
serializes commands and typed mutations within it, validates exact matches and
patch contexts atomically, and retains internal before/after hashes for
response-loss reconciliation. Those hashes never enter the model schema.

The jagged edges to cover are:

- normalize paths before authorization, then resolve symlinks without allowing
  escape from the repository or scratch root;
- distinguish regular files, directories, and symlinks;
- never inject display line numbers into raw content that may be reused as
  `oldString`;
- reject binary data from text tools and route it through resource or file
  transfer paths;
- reject zero-match and multiple-match edits with different stable codes;
- never partially apply a patch;
- bound terminal discovery/search output and make truncation visible;
- make `import_resource` create-only unless replacement is explicit;
- apply byte, line, output, and file-count limits before model context grows;
- return a fixed remediation in the model-visible failed result, not only a human
  summary.

PR #144 narrows that last point further: Bind forwards nine allowlisted keys from
a typed error—`reason`, `field`, `expected`, `available`,
`reconnectRequired`, `retryAfterMs`, `actualMimeType`, `attachmentKind`, and
`suggestedCall`. Terminal uses the first six general recovery keys; the last three
remain attachment-specific. A plugin-local `hint`, path, or arbitrary object can
look structured in adapter code but is silently absent from the model's failed
tool result. The Daytona contracts therefore put the bounded next action and any
conflicting root-relative paths in `reason`, use `available` only for genuine
choices, and test the serialized failure rather than the error object before
filtering.

These conclusions produced the launch tools `read_file`, `edit_file`,
`write_file`, and `apply_patch`, with discovery and search handled by
`run_command`. Their complete schemas are in the
[PRD](prd.md#model-facing-tool-contracts).

## Languages, package managers, and package hosts

The broader research found Daytona's essential-service list covers ecosystems
for JavaScript, Python, Rust, Go, C/C++, PHP Composer, NuGet, Elixir/Erlang,
Ruby, Debian/Ubuntu packages, container registries, and Maven. That makes many
languages technically possible
([network policy documentation](https://www.daytona.io/docs/en/network-limits/)).

Technical reach is not a support promise. The first version should pin only the
languages models use consistently for general problem solving and that Rally
can test as a small snapshot:

| Language | Launch runtime | Managers and hosts |
| --- | --- | --- |
| Bash | Bash and POSIX `sh` | `apt`/`dpkg` and signed Debian/Ubuntu repositories |
| Python | Daytona-managed Python 3 and `venv` | `pip`, `uv`, and PyPI |
| JavaScript | Daytona-managed Node.js | `npm`, `pnpm`, and the npm registry |
| TypeScript | Daytona-managed Node.js with tested `typescript` and `tsx` | `npm`, `pnpm`, and the npm registry |
| SQLite | Tested SQLite 3 CLI plus Python/Node bindings | local database files and the chosen host-language manager |

Competing managers and hosts were considered rather than assuming the official
default was the only model-familiar path. Poetry, PDM, Conda, Yarn, Bun, Deno,
Homebrew, APK, DNF, Cargo, Go modules, Maven/Gradle, RubyGems/Bundler, Composer,
and NuGet remain candidates, but adding them at launch expands snapshot size,
egress targets, lockfile behavior, security updates, and acceptance tests. The
launch set deliberately includes the most useful competing manager in each
supported ecosystem: `uv` beside `pip`, and `pnpm` beside `npm`. Alternate
package hosts are not part of the launch promise.

The plugin prompt must explicitly tell the model that these languages exist and
should be used for calculation, transformation, file analysis, repository
validation, graphs, images, datasets, reports, and archives. Discoverability is
part of the capability; a sandbox that exists only in a tool catalog will be
underused.

## Daytona primitives and the Rally mapping

Daytona supplies the needed computer substrate without requiring Rally to
expose Daytona's API to the model:

| Daytona primitive | Rally use | Model-visible? |
| --- | --- | --- |
| isolated sandbox with filesystem, network stack, CPU, RAM, and disk | one workspace generation per work stream | no |
| start, stop, archive, delete | lazy lifecycle and retention | no |
| session command and WebSocket log stream | one bounded terminal call with durable continuation | only final result |
| filesystem list/search/upload/download/stream | typed file tools, resource import, resource publication | through Rally schemas |
| native domain allow-list | Trusted-only workspace policy | mode and denials only |
| HTTPS secret placeholder proxy | read-scoped Git and `gh` auth | placeholder is not returned |
| PTY | possible later interactive capability | no at launch |

Daytona containers start quickly, preserve files across stop/start, and can be
archived to provider object storage. Current persistence documentation says
stopped containers retain their filesystem and bill disk, while archived
containers free quota and are not billed
([persistence](https://www.daytona.io/docs/en/persistence/),
[billing](https://www.daytona.io/docs/billing)).

Daytona log streaming provides both a WebSocket follow mode and a snapshot of
existing command logs. Rally should use follow for normal completion and the
snapshot/status APIs for reconciliation
([log streaming](https://www.daytona.io/docs/en/log-streaming/)).

## Network policy

The workspace-level product choice is:

- **Trusted only**: Daytona's native `domainAllowList`, an immutable Rally
  baseline, and optional workspace-added domains.
- **Full internet**: clear the per-sandbox allow-list on a Daytona organization
  tier that permits unrestricted access.

The native firewall supports a maximum of 20 domain entries, a maximum of ten
IPv4 CIDR entries, or a block-all flag. Those settings are mutually exclusive.
Higher tiers can update a running sandbox; organization policy remains the
ceiling
([network limits](https://www.daytona.io/docs/en/network-limits/)).

Although the original product request included workspace-added CIDR blocks, the
adversarial simplification found no launch need that justified two policy
languages. Domains compose with package registries and Git hosts; a domain and
CIDR union would require a proxy or gateway because Daytona does not accept both
lists together. The PRD therefore uses domain policy only and defers CIDR.

The Trusted-only baseline cannot be removed. It relies on Daytona's documented
essential services for signed system repositories, GitHub, npm-related traffic,
and PyPI/uv-related traffic, then adds only the tested hosts the pinned
snapshot needs. A package redirect to an unapproved domain fails visibly. A
network-policy change stops any current sandbox generation so a long-lived
connection cannot continue under stale rules.

Full internet changes destination reach, not authority. GitHub write tokens,
Daytona credentials, R2 credentials, and connector credentials still do not
enter the sandbox.

### Why not a custom egress proxy at launch

A custom proxy could combine domains and CIDRs, inspect requests, meter traffic,
and broker arbitrary secrets. It would also add TLS behavior, DNS rebinding
defense, WebSocket and package-manager compatibility, regional availability,
logging redaction, and another outage boundary. Daytona already provides the
launch firewall and HTTPS secret substitution. A proxy should be reconsidered
only if a required use case cannot be expressed by the native primitive.

## Git and GitHub

### Why retain the CLIs

Models know `git status`, `git diff`, `git add`, `git commit`, `git log`,
`git branch`, `git fetch`, `git rebase`, and the `gh` command family. Recreating
each command as a custom tool would consume schemas, omit useful flags, and
diverge from repository instructions. The sandbox should therefore contain the
real, pinned `git` and `gh` CLIs.

Typed tools remain appropriate where authority crosses the sandbox boundary:
selecting the authorized repository, importing it, granting credentials, and
publishing a branch/PR.

### Read authorization inside the sandbox

GitHub App installation tokens can be restricted to specific repositories and
permissions and expire after one hour
([GitHub documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).
The host should mint a single-repository, read-scoped token for each active
sandbox generation.

Daytona Secrets keep plaintext outside the sandbox. The sandbox receives an
opaque placeholder. Daytona substitutes the real secret only when that
placeholder appears in an HTTPS request header to an allowed host
([Daytona Secrets](https://www.daytona.io/docs/en/secrets/)).

There is a Git-specific edge: Git HTTP Basic authentication base64-encodes
`username:password`. If Git encodes a Daytona placeholder, the proxy cannot see
and replace the placeholder inside the encoded text. The host must instead store
the already encoded `x-access-token:<installation-token>` credential as the
Daytona secret value and configure Git to send:

```text
Authorization: Basic <daytona-placeholder>
```

The proxy then substitutes the placeholder with the complete encoded credential
for `github.com`. Read-only `gh` can use a separate placeholder through
`GH_TOKEN`; GitHub CLI officially gives `GH_TOKEN` precedence for headless
authentication
([GitHub CLI environment](https://cli.github.com/manual/gh_help_environment)).
The corresponding secret is host-limited to `api.github.com`.

The token is still read-scoped. Local branches, commits, rebases, and bundles
are allowed. Remote push, PR creation, workflow mutation, and repository
administration are not.

### Host-side publication

Putting a write-scoped token in a general shell would make every package script
and prompt-injected command a GitHub publisher. Command-string filtering cannot
repair that boundary. Publication therefore uses a typed Bind write:

```ts
type PublishBranchAndPrArguments = {
  title: string;
  body: string;
};
```

The model does not choose the repository, remote, base branch, head branch, or
credential. Rally derives those from current authorized host state and the
durable receipt. It
asks Daytona to create a Git bundle, downloads the bundle through the file API,
validates repository identity, commit ancestry, tree policy, clean status, size,
and prohibited workflow changes, then mints a fresh host-side GitHub App token.
The host pushes the deterministic branch and creates or updates the matching PR.

Creating a pull request requires GitHub's Pull requests write permission; Git
over HTTPS requires Contents permission. The app should receive only the
minimum required repository permissions and should not receive Actions/Workflow
write permission
([GitHub App permissions](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[pull request API](https://docs.github.com/en/rest/pulls/pulls)).

This split preserves model fluency for local Git while making the one external
write idempotent, auditable, capability-gated, and revocable.

## Resources into and out of the sandbox

### Publishing a resource

`publish_resource` takes one completed regular file below the sandbox resource
directory, verifies its bytes and MIME type, streams it into Rally's resource
storage, creates a normal `resources` row, attaches it to the current work
stream, and returns the resource identity. It is the bridge from disposable
sandbox state to durable product state.

Examples include a chart image, PDF, CSV, SQLite database, archive, generated
report, or converted document. Publication does not mean public internet
hosting. The returned URL, when present, is an authorized Rally address; the
model never receives a raw R2 object key or Daytona download URL.

### Pulling a work-stream resource into Daytona

PR #144 gives the model bounded ways to list, read, search, view, and summarize
attached resources, but those model-oriented derivatives are not always the
original bytes a program needs. A CSV may need Pandas, a workbook may need a
spreadsheet library, and an image may need a local transformation.

The symmetrical counterpart is `import_resource`:

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

When Rally chooses the destination, it creates or reuses a deterministic
collision-resistant path beneath `.avalon/resources/`; the caller must omit
`overwrite`. When the caller supplies `destinationPath`, the operation is
create-only by default; `overwrite: true` requests deliberate replacement of an
existing regular file.

The host would:

1. reauthorize the resource through the current execution principal and
   `workstream_resources` relationship;
2. enforce visibility, MIME, size, filename, destination-root, and overwrite
   policy;
3. choose the original or an explicitly documented safe derivative;
4. stream R2 bytes through the regional host into Daytona;
5. verify byte count and hash and return the imported file metadata.

Daytona's TypeScript filesystem supports `uploadFileStream` from a Web
`ReadableStream`, and download streams for the reverse direction
([filesystem SDK](https://www.daytona.io/docs/en/typescript-sdk/file-system/)).
That permits R2-to-Daytona transfer without buffering the complete object and
without giving the sandbox an R2 URL or credential.

The current PRD includes this tool. Text-only analysis can still use PR #144's
existing resource tools without starting a sandbox; import exists when a local
program needs the original bytes.

## Daytona, Dynamic Workers, and Workers for Platforms

### Capability comparison

| Dimension | Daytona sandbox | Dynamic Worker | Workers for Platforms user Worker |
| --- | --- | --- | --- |
| Primary unit | persistent work-stream computer | code loaded at runtime for one or repeated executions | deployed tenant/user script in a dispatch namespace |
| Environment | Linux container or VM with filesystem and processes | Cloudflare Worker isolate | Cloudflare Worker isolate |
| Languages | anything installed; Rally launch pins five | JavaScript and Python; TypeScript must be compiled | Worker-supported languages/modules |
| CLI and Git | full Bash, package managers, `git`, `gh` | no general Linux shell or Git workspace | no general Linux shell or Git workspace |
| State | mutable disk across stop/start/archive | external bindings or cached Worker identity | external bindings such as R2, D1, KV, Durable Objects |
| Startup model | create/start/restore sandbox | `load()` one-shot or `get()` cached by ID | deploy script, then dispatch requests |
| Network control | native domain/CIDR/block firewall | host controls bindings and outbound capability | dispatch/outbound Worker and platform policy |
| Best workload | repo editing, package install, data/media conversion, multi-step artifacts | compact Code Mode plans and request-shaped transforms | long-lived multi-tenant applications and programmable platforms |

Dynamic Workers let a host load arbitrary code at runtime and choose its
bindings and outbound access. `load()` is intended for one-time Code Mode work;
`get(id, callback)` caches repeated code. JavaScript and Python are supported,
while TypeScript needs bundling or compilation first
([getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)).
Cloudflare's playground demonstrates runtime TypeScript bundling with npm
dependencies, cache reuse, and streamed logs
([playground](https://developers.cloudflare.com/dynamic-workers/examples/dynamic-workers-playground/)).

Workers for Platforms uses a dispatch namespace, dynamic dispatch Worker, user
Workers, and optional outbound Worker. It supplies isolation, dynamic routing,
per-customer limits, and platform bindings at tenant scale
([architecture](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)).

The deciding question is not “which sandbox is better?” It is “does the task
want an operating system or a request runtime?” A generated JavaScript plan that
calls three connectors and filters JSON wants Dynamic Workers. A request to
clone a private repository, run `pnpm install`, edit five files, execute tests,
and create a PR wants Daytona.

### Potential plugin families

The research produced a broad menu that can work together or separately:

| Plugin | Best substrate | Why |
| --- | --- | --- |
| Code scratchpad for calculations and transformations | Daytona now; Dynamic Workers for compatible JS/Python one-shots | Daytona maximizes language/package reach; Dynamic Workers minimize startup and cost |
| Data analysis and SQLite joins | Daytona | local datasets, Python libraries, and durable intermediate files |
| Chart, image, PDF, dataset, report, and archive generation | Daytona | packages and binary artifacts need a filesystem |
| Repository inspect/edit/test | Daytona | real Git, lockfiles, package managers, builds, and tests |
| GitHub branch and PR publication | Daytona plus host GitHub App | local Git fluency with host-side external write |
| Connector Code Mode | Dynamic Workers or a later Daytona code executor | typed host methods, loops, filters, and small final results |
| OpenAPI search-and-execute | Dynamic Workers | large schema stays outside model context and network stays host-mediated |
| Saved reusable integration snippets | Dynamic Workers | cached code identity and request-shaped execution |
| Deployed user webhook or mini-application | Workers for Platforms | addressable, durable tenant script and dispatch routing |
| Media transcoding or native binary conversion | Daytona | operating-system packages and process execution |
| Browser-driven frontend inspection | Cloudflare Browser/Code Mode or a separately scoped browser sandbox | browser session semantics differ from a shell workspace |

Some choices are intentionally incompatible within one tool. A one-shot
Dynamic Worker should not pretend to preserve an arbitrary repository
filesystem. A Daytona terminal should not receive connector credentials just to
imitate Code Mode. Bind can expose both plugins and select the right one from
their descriptions.

## Cost analysis

### Rate models

Daytona's published pay-as-you-go rates on the research date were:

- `$0.00001400` per vCPU-second;
- `$0.00000450` per GiB-second of memory;
- `$0.00000003` per billable GiB-second of storage, with the first 5 GiB free.

The same page shows hourly equivalents of `$0.0504` per vCPU and `$0.0162`
per GiB of memory
([Daytona pricing](https://www.daytona.io/pricing)). The approximate active
cost of a sandbox is therefore:

```text
seconds × (
  vCPU × $0.00001400
  + RAM GiB × $0.00000450
  + billable disk GiB × $0.00000003
)
```

For a sandbox receiving the full 5 GiB storage allowance, the standard sizes
cost approximately:

| Size | Resources | Approximate active cost/hour |
| --- | --- | ---: |
| Small | 1 vCPU, 1 GiB RAM, 3 GiB disk | $0.0666 |
| Medium | 2 vCPU, 4 GiB RAM, 8 GiB disk | $0.1659 |
| Large | 4 vCPU, 8 GiB RAM, 10 GiB disk | $0.3317 |

The free disk allowance is organization-wide in practice, so fleet estimates
should charge most disk. Disk is a very small part of active cost but dominates
large stopped fleets.

Dynamic Workers currently require the `$5` Workers Paid plan. The plan includes
1,000 unique Dynamic Worker creations per month, 10 million requests, and 30
million CPU milliseconds. Overage is `$0.002` per unique Worker created per day,
`$0.30` per million requests, and `$0.02` per million CPU milliseconds
([Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)).
A change in Worker ID or code creates another unique billable identity.

Workers for Platforms currently has a `$25` monthly base including 20 million
requests, 60 million CPU milliseconds, and 1,000 scripts. Overage is `$0.30`
per million requests, `$0.02` per million CPU milliseconds, and `$0.02` per
script
([Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)).

### Example Rally plugins

These examples price only execution and use simple assumptions. They exclude
model tokens, Bind/Workflow/D1 operations, R2 operations, network egress,
enterprise contracts, taxes, and human support.

| Example | Assumption | Daytona | Dynamic Workers | Workers for Platforms |
| --- | --- | ---: | ---: | ---: |
| Small chart or data transform | 10,000 runs/month, 3 active minutes on Small | about $33.30 | about $5 if compatible code is reused and CPU stays included; add unique-code charges | $25 base if implemented as deployed scripts and inside allowances |
| General scratch computation | 10,000 runs/month, 5 active minutes on Small | about $55.50 | usually cheaper for JS/Python request-shaped work; unique one-shot code may add up to $18 for 10,000 monthly creations beyond allowance | $25 plus script overage if each distinct program is deployed |
| Repository edit, install, test, PR preparation | 1,000 runs/month, 20 active minutes on Medium | about $55.31 | not functionally equivalent: no general Git/package-manager workspace | not functionally equivalent |
| Heavy package or conversion job | 1,000 runs/month, 30 active minutes on Medium | about $82.96 | only suitable if libraries bundle and runtime limits fit | generally the wrong execution shape |
| Connector Code Mode | 1 million calls, 50 ms CPU each, one/few reusable programs | Daytona would be at least $18.50 even at an unrealistic one active second per call | about $5.40: base plus 20 million CPU-ms overage | $25: 50 million CPU-ms fits the included amount |
| 10,000 deployed customer scripts | low traffic and CPU | poor fit and persistent fleet overhead | about $23 if each script is created only once in the month; much more if recreated daily | about $205: base plus 9,000 script overage |

The earlier Rally session review led to workload **archetypes**, not a precise
traffic forecast: short connector operations, bursty multi-minute code/data
work, longer repository validation, and long idle gaps between work-stream
messages. The table intentionally exposes the variables so production telemetry
can replace assumptions. The main result is robust: Dynamic Workers win
request-shaped code; Daytona's extra cost buys the operating-system features
those requests do not have.

### Idle storage: Daytona or R2

Current Daytona billing distinguishes lifecycle states:

- started/transitioning: CPU, RAM, and disk billed;
- stopped or paused: disk billed;
- archived container: CPU, RAM, and disk not billed;
- deleted: no sandbox billing.

At the published storage rate, a stopped 3 GiB sandbox costs about `$0.2333` per
30-day month after the free allowance. One thousand such stopped sandboxes would
cost about `$233.28` per month even if their actual files were small, because
reserved disk is billed.

R2 Standard storage is `$0.015` per GB-month after its 10 GB-month free tier,
with Class A/B operation charges and no egress fee
([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Storing 3 TB of
archive bytes would therefore be about `$45` per month before operations and
compression effects. R2 is materially cheaper than leaving container sandboxes
stopped.

However, Daytona currently bills **archived containers at zero**. On raw
provider cost, the ordering is:

```text
Daytona archive ($0 metered sandbox resources)
  < R2 copy (storage and operations)
  < stopped Daytona container (reserved disk)
```

Keeping the native Daytona archive also preserves an immediately restorable
filesystem, installed packages, Git metadata, and sandbox configuration.
Exporting the whole workspace to R2 would require packaging, transfer, integrity
metadata, reconstruction, snapshot compatibility, and another deletion path.

The launch recommendation is therefore: stop quickly, archive natively after
60 minutes, and delete after 30 days. Use R2 for durable Rally resources,
receipts, command overflow, and published artifacts—not as a duplicate cold copy
of every sandbox. Reconsider an R2 workspace export only for provider
portability, contractual retention, legal hold, or restore objectives Daytona
cannot meet.

## Production failure modes to design out

The cross-harness research and Rally's distributed runtime imply the following
test matrix:

### Tool schema and model behavior

- schema shown to the model differs from strict runtime validation;
- optional field in one layer is required in another;
- unknown input is silently stripped;
- a deterministic validation error is thrown as transient and retried;
- a recovery hint exists only in human `summary`, not model-visible output;
- output says “success” without returning the identity required for the next
  call.

### Commands and processes

- command waits for stdin or launches a detached daemon;
- PTY control sequences or secrets appear in output;
- timeout kills a child but leaves grandchildren running;
- Worker/WebSocket failure is mistaken for command failure and the command is
  executed again;
- nonzero exit is treated as transport failure;
- stdout/stderr exceed model limits or split a UTF-8 sequence;
- truncation causes the model to rerun a write instead of reading overflow;
- cancellation races with completion;
- a stopped sandbox is auto-restored for a stale continuation after authority
  was revoked.

### Files

- `..`, absolute paths, or symlinks escape the applicable root;
- an exact replacement matches zero or multiple locations;
- a file changes after read but before edit;
- a multi-file patch partially applies;
- line-number decoration is copied into replacement text;
- a binary file is decoded as UTF-8;
- a directory changes between cursor pages;
- create silently overwrites or overwrite silently creates;
- artifact publication races deletion and leaves an orphaned R2 object or row.

### Network and credentials

- policy lists exceed provider limits or combine mutually exclusive modes;
- DNS redirects move a package download to an unapproved host;
- full internet is mistaken for permission to inject secrets;
- a placeholder is base64-encoded before Daytona can substitute it;
- a secret has no exact host allow-list;
- `git push` or `gh pr create` finds an unintended stored credential;
- an expired installation token is reported as a missing repository;
- a GitHub write is repeated after response loss;
- a PR bundle changes `.github/workflows` despite the app intentionally lacking
  workflow authority.

### Lifecycle and cost

- plugin discovery creates thousands of unused sandboxes;
- five-minute host stop and provider auto-stop fight each other;
- stopped disk accumulates because archive transitions are never reconciled;
- an archive is deleted while a resource publication or PR bundle still needs
  it;
- a network-policy update leaves an old generation running;
- unique Dynamic Worker code churn dominates a cost estimate that assumed cache
  reuse.

## Alternatives rejected or deferred

The adversarial overengineering review produced eight simplifications that were
adopted in the PRD:

1. **Do not clone a full coding harness.** Launch with Bash, Python,
   JavaScript, TypeScript, SQLite, and a small manager set.
2. **Do not expose raw Daytona APIs.** Give the model familiar file, command,
   resource-import, and publication tools.
3. **Do not expose a PTY/task protocol.** Use one non-interactive command and a
   final result.
4. **Do not build a network proxy for the first release.** Use native domain
   policy; defer CIDR composition.
5. **Do not make the model poll.** Suspend Bind and auto-wake from a durable
   completion event, with status reconciliation as a backstop.
6. **Do not put GitHub write credentials in the sandbox.** Allow local Git and
   read-only `gh`; publish through one host-side typed write.
7. **Do not create an artifact subsystem beside resources.** Reuse PR #144's
   resource rows, attachments, derivatives, visibility, retention, and tools.
8. **Do not duplicate every Daytona archive into R2.** Native archive is
   currently unbilled and avoids a reconstruction subsystem.

Other deferred options are a browser, user-visible terminal, arbitrary daemon
hosting, SSH, debugger, additional language ecosystems, CIDR allow-lists,
cross-provider sandbox export, and a single-tool connector Code Mode runtime.

## Conclusions carried into the PRD

The research directly supports these choices:

- always register Terminal for workspaces in supported regions, with no plugin
  feature flag or per-user rollout;
- one lazy Daytona sandbox per work stream, not per message or plugin load;
- a familiar `terminal` wire prefix and a prompt that makes the supported
  languages and use cases obvious;
- familiar command and file tool names with strict camelCase schemas;
- shell-native discovery and search, exact-match edits, atomic patches, and no
  model-visible file revisions;
- one bounded, non-interactive terminal command with final stdout/stderr and no
  model-visible task handle;
- host-side Workflow suspension, event completion, and reconciliation;
- real `git` and `gh` CLIs, read-scoped GitHub App credentials behind Daytona's
  HTTPS placeholder proxy, and no sandbox write token;
- a typed `publish_branch_and_pr` with durable receipt and deterministic branch;
- symmetrical `import_resource` and `publish_resource` tools around Rally's
  normal resource system;
- Trusted-only native domain policy plus a Full-internet workspace option;
- five-minute host stop, 15-minute provider backstop, 60-minute native archive,
  and 30-day expiry;
- Daytona for operating-system work, Dynamic Workers for a potential later Code
  Mode plugin, and Workers for Platforms only for deployed tenant programs.

Work-stream resource originals cross into Daytona only through
`import_resource`; generated files cross back only through `publish_resource`.
Neither direction exposes an R2 or Daytona credential to the model.

## Primary sources

### Harnesses and tool design

- [OpenAI shell tool](https://developers.openai.com/api/docs/guides/tools-shell)
- [OpenAI apply-patch tool](https://developers.openai.com/api/docs/guides/tools-apply-patch)
- [Codex sandbox](https://learn.chatgpt.com/docs/sandboxing)
- [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)
- [Claude Agent SDK Python reference](https://code.claude.com/docs/en/agent-sdk/python)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [OpenCode tools](https://opencode.ai/docs/tools/)
- [OpenCode agents and command permissions](https://opencode.ai/docs/agents/)
- [OpenCode permission boundary](https://opencode.ai/v2/docs/permissions)
- [OpenCode current shell schema](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/tool/shell/prompt.ts)
- [OpenCode current shell prompt](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/tool/shell/shell.txt)
- [OpenCode current shell executor](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/tool/shell.ts)
- [Grok Build overview](https://docs.x.ai/build/overview)
- [Grok Build permissions](https://docs.x.ai/build/features/permissions)
- [Grok Build sandbox](https://docs.x.ai/build/features/sandbox)
- [Grok Build background tasks](https://docs.x.ai/build/features/background-tasks)
- [Grok Build public source](https://github.com/xai-org/grok-build)
- [Grok Build terminal tool](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230c/crates/codegen/xai-grok-tools/src/implementations/grok_build/bash/mod.rs)
- [Rally agent-tool design](../../agent-tools.md)
- [Rally Bind harness](../../agent-harness.md)
- [Rally agent attachments and resources](../../agent-attachments.md)

### Daytona

- [Sandboxes](https://www.daytona.io/docs/en/sandboxes/)
- [Persistence](https://www.daytona.io/docs/en/persistence/)
- [Billing](https://www.daytona.io/docs/billing)
- [Pricing](https://www.daytona.io/pricing)
- [Network limits](https://www.daytona.io/docs/en/network-limits/)
- [Secrets](https://www.daytona.io/docs/en/secrets/)
- [Log streaming](https://www.daytona.io/docs/en/log-streaming/)
- [PTY](https://www.daytona.io/docs/en/pty/)
- [TypeScript filesystem SDK](https://www.daytona.io/docs/en/typescript-sdk/file-system/)

### Cloudflare

- [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/)
- [Code Mode MCP server patterns](https://developers.cloudflare.com/agents/model-context-protocol/codemode/)
- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Dynamic Workers getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)
- [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
- [Workers for Platforms architecture](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

### GitHub

- [Generating a GitHub App installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Choosing GitHub App permissions](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Creating pull requests through the REST API](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment)
