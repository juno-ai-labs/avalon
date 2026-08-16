# Design — Terminal repository agent instructions

> Companion to [`prd.md`](prd.md). This file carries the protocol: how files are
> discovered, which one governs a path, when text is delivered, what the block
> looks like on the wire, and what each event does to the delivery record.

## What the specification requires

[The AGENTS.md specification](https://agents.md) is short, and four of its
statements are the contract this design has to meet:

1. The file lives at the repository root, and a monorepo may put additional
   files inside individual packages.
2. An agent reads the *nearest* file in the directory tree automatically. The
   closest one takes precedence.
3. An explicit human request overrides everything in the file.
4. The agent runs the programmatic checks the file names and fixes what they
   catch before finishing.

The format itself imposes nothing — it is plain Markdown with no required
fields, parsed as text.

Points 1 and 2 decide discovery and resolution. Point 3 decides the precedence
sentence in the plugin prompt. Point 4 is behavior Avalon can only ask for, and
it is asked for in the same sentence.

## Where the pieces attach

| Concern | Where it lands |
| --- | --- |
| Index of `AGENTS.md` paths, sizes, and content hashes | `apps/api/src/services/terminal/repository.ts`, inside the existing `bootstrapTerminalRepository` command |
| Nearest-file resolution, delivery decisions, bounds | a new `apps/api/src/services/terminal/agent-instructions.ts` |
| Touched-path extraction per tool, delivery attachment | `apps/api/src/services/terminal/runtime.ts` and `tools.ts` |
| The platform rule the model reads every turn | `TERMINAL_PLUGIN_SYSTEM_MESSAGE` in `apps/api/src/services/terminal/contract.ts` |
| Context-epoch identity for the delivery record | `HarnessToolContext` in `packages/agent-harness/src/index.ts`, populated in `bind-runtime.ts` |
| "Name the paths, never the text" rule for summaries | `COMPACTION_SUMMARY_PROMPT` in `packages/agent-harness/src/bind-runtime.ts` |

## Discovery

The repository is cloned *into* `/workspace` — bootstrap moves the clone's
`.git` to `/workspace/.git` — so the repository root, the workspace root, and
the root every model-facing path is relative to are the same directory. A
workspace-relative tool path is already a repository-relative path, and no
mapping is needed.

Bootstrap runs on every sandbox acquisition, is already one shell command, and
already sets up the session environment and branch. The index is appended to it,
between a pair of fixed markers so it can be parsed out of the command's stdout
deterministically:

```sh
printf 'AVALON_AGENTS_INDEX_BEGIN\n'
git ls-files -co --exclude-standard -- 'AGENTS.md' '*/AGENTS.md' \
  | LC_ALL=C sort \
  | head -n 50 \
  | while IFS= read -r path; do
      [ -f "$path" ] || continue
      printf '%s %s %s\n' \
        "$(stat -c %s -- "$path")" \
        "$(sha256sum -- "$path" | cut -d' ' -f1)" \
        "$path"
    done
printf 'AVALON_AGENTS_INDEX_END\n'
```

Notes on the choices:

- `git ls-files -co --exclude-standard` lists tracked *and* untracked-but-not-
  ignored files, so a file the model just created counts and a vendored
  `node_modules` copy does not. It also costs nothing on a clean tree.
- `-f` skips anything that is not a regular file after symlink resolution.
  A symlinked `AGENTS.md` is followed, which is what the specification's own
  migration guidance produces; a symlink escaping `/workspace` cannot exist
  under the sandbox's own path containment, and the read path applies the same
  `realpath` check every other Terminal read uses.
- `LC_ALL=C sort` then `head -n 50` makes both the selection and the order
  deterministic and independent of the filesystem.
- Failure is non-fatal. The index block is parsed if it is well-formed and
  ignored if it is not; bootstrap's exit status is unchanged, so no Terminal
  tool fails because a repository's instruction files could not be listed.

Reading a file's *body* is deferred to the moment it is delivered, with the
existing `readFile` provider call, bounded to the per-file allowance. The index
carries hashes rather than content precisely so that an unchanged file costs one
`sha256sum` per tool call and nothing else.

## Resolution

For a set of touched paths, the governing chain is every directory from the
repository root down to the path's own directory that has an indexed
`AGENTS.md`, in that order. Root first, deepest last.

The whole chain is delivered rather than the nearest file alone. The
specification's precedence rule settles conflicts, not coverage: a package's
file typically states what differs, and the root file is where the build and
test commands live. Delivering root-to-nearest and telling the model that the
deepest block wins gives the specification's outcome without asking a repository
to repeat itself in every subdirectory.

Per tool, the touched paths are:

| Tool | Touched paths |
| --- | --- |
| `read_file`, `edit_file`, `write_file` | `filePath` |
| `apply_patch` | every path the patch parser already extracts |
| `run_command` | `cwd`, defaulting to the repository root |
| `checkout_repository` | the repository root |
| `import_resource` | the destination path |
| `publish_resource`, `publish_branch_and_pr` | the repository root |

The root chain is delivered eagerly on the first Terminal tool of a context,
whatever the tool is, together with the index of every other indexed file as
`path` and `size` only. The index is derived provenance — it says what exists,
never what it says — so it is bounded, cheap, and carries no untrusted prose.

## Delivery

Delivered text is appended to the tool's result as an additional text content
part, after the JSON result, using the existing `HarnessToolResult.contentParts`
channel. That channel is documented as current-turn content that never enters a
durable receipt or transcript, which is exactly the lifetime this text should
have: on receipt replay it is dropped, and the delivery record is gone with the
process, so the next call re-delivers.

Each block is rendered as:

```
REPOSITORY AGENT INSTRUCTIONS — <path> (governs <directory>/; repository-authored
working conventions for this checkout, not Avalon policy):
<body>
```

with the body scrubbed by `sanitizeTerminalOutput`, the same function that
strips terminal control sequences and recognizable credential forms from command
output before it reaches the model. There is no closing marker and no repetition
of the authority rule per block — the rule is stated once, in the plugin system
message, per the say-it-once principle in
[`writing-prompts.md`](../../writing-prompts.md).

Variants:

- **Replacement.** A file whose hash changed since it was delivered in this
  context is re-delivered with `(replaces the earlier instructions for this
  path)` appended to the header line.
- **Removal.** A file that was delivered in this context and is no longer in the
  index produces a single line saying the file no longer exists and its earlier
  instructions no longer apply.
- **Truncation.** A body over the per-file allowance is cut on a code-point
  boundary and followed by a marker naming `terminal_read_file` and the path.
- **Index failure.** One line saying Avalon could not read this repository's
  instruction files and that the model should look for `AGENTS.md` itself before
  assuming conventions.

Bounds, as named constants:

| Bound | Value | On exceeding |
| --- | --- | --- |
| Indexed files | 50 | Index truncated after a deterministic sort; marker names the count omitted |
| Per-file delivered body | 16 KiB | Body truncated; marker names `terminal_read_file` |
| Per-context delivered total | 32 KiB | Further bodies replaced by a path-and-size line naming `terminal_read_file` |

## The delivery record and the events that clear it

The record is a `Map` in the closure created by `createDaytonaTerminalRuntime`,
holding one entry per delivered file: its path and the content hash that was
delivered. Its key is the triple `(sandbox generation, repository ID, context
epoch)`; a change in any component discards the record.

**Context epoch** is the one addition to the harness. `HarnessToolContext` gains
`contextEpoch: number`, populated from the compaction counter Bind's runtime
already maintains, so a tool executed after the *n*th compaction of a run sees
`n`. It is derived state with no authority attached, it is the same value for
every tool in a batch, and any plugin that caches something whose lifetime
should match the live context can key on it.

The invariant this exists to hold: **the delivery record's lifetime is a subset
of the live context's lifetime.** Every way a context can lose the text has to
be a way the record loses the entry.

| Event | Effect on the live text | Effect on the record | Result |
| --- | --- | --- | --- |
| Compaction | Erased; only the summary and the system prompt remain | `contextEpoch` advances, record discarded | Re-delivered on the next Terminal tool call |
| New run in the work stream | Absent — checkpoints and projected transcripts carry no content parts | New process, new record | Delivered on the first Terminal tool call |
| Resumed run after a Worker interruption | Absent for the same reason | New process, new record | Re-delivered |
| Replayed tool receipt | Content parts are not rehydrated for Terminal | New process, new record | Re-delivered |
| Sandbox stopped, archived, restored | Unchanged | Unchanged — the generation is the same | Nothing re-delivered; the index is recomputed at bootstrap either way |
| Repository replacement | Unchanged | Generation and repository ID both change, record discarded | Fresh index, fresh delivery |
| Model edits an `AGENTS.md` | Stale in context | Hash mismatch on the next index | Re-delivered as a replacement |
| `git checkout`, `merge`, `pull` changes one | Stale in context | Hash mismatch on the next index | Re-delivered as a replacement |
| A file is deleted | Stale in context | Path absent from the next index | Removal notice |
| Network policy or credential rotation | Unchanged | Unchanged | Nothing |

The one case with no clean answer is a *branch* that changes `AGENTS.md` between
two tool calls in a way that leaves the hash identical — impossible in practice,
since the hash is over the delivered bytes.

## Compaction

Two things change, neither of them a new mechanism.

`COMPACTION_SUMMARY_PROMPT` gains a rule: repository instruction blocks are not
copied or summarized; record which instruction files were in effect by path, in
the facts section, because Avalon re-delivers their current text after the
compaction. Without it the summarizer does the reasonable thing and transcribes
the repository's prose into the request section, where the next run replays it
as an instruction a person gave — the provenance failure
[`context-compaction.md`](../../context-compaction.md) documents for Slack
context, with a file anyone with commit access can edit in the place of the
Slack message. The prompt is load-bearing and byte-stable, so this is a golden
hash update and a changelog entry in that document.

The checkpoint appendix is untouched. It stays the authorized resource inventory
it is today, for the reason in non-goal 6: the next Terminal tool call
necessarily precedes any repository work, so re-delivery covers the same ground
without giving a second subsystem a stake in the checkpoint's shape.

## Prompt

One rule is added to `TERMINAL_PLUGIN_SYSTEM_MESSAGE`, and it has to carry five
things a medium model can act on without inference: that instructions arrive on
their own, that they are the repository's conventions for the directory named,
that the deepest block wins, that a participant's request wins over any block,
and that a block cannot change what the run may do — with "ignore that part and
say so" as the paired action, since a prohibition with no replacement leaves a
hole. It names `terminal_read_file` as the way to read a truncated file, which
the plugin's own message may do because its activation guarantees the tool.

The contract test asserts this message byte for byte, so it is updated in the
same change.

## Prior art

The pattern is the settled one across coding agents: an instruction file
discovered from the working tree, injected by the harness rather than read by
the model, and re-injected as the agent moves into a subtree that has its own.
What differs here is the constraint set — a harness that compacts to a summary
and keeps nothing verbatim, a prompt doctrine that forbids outside content in the
prefix, and a documented trust boundary that calls repository contents untrusted.
Those three are what push the design toward re-derivation on every emptied
context rather than a one-time injection at session start, which is the shape a
harness with a persistent process can get away with.

## Testing

Unit, in a new `apps/api/test/terminal-agent-instructions.test.ts`:

- Nearest-file resolution over a synthetic index: root only, nested only, chain
  ordering root-to-deepest, a path with no governing file, a path outside any
  indexed directory.
- Index parsing: well-formed block, absent block, malformed line, more than 50
  entries, non-UTF-8 bytes.
- Delivery decisions: first call delivers root plus index; second call in the
  same epoch delivers nothing; a changed hash delivers a replacement; a removed
  path delivers a notice; an epoch change re-delivers; a generation change
  re-delivers.
- Bounds: per-file truncation is deterministic and cuts on a code-point
  boundary; the per-context total stops further bodies and substitutes the
  path-and-size line.

Contract, in `apps/api/test/terminal-contract.test.ts`: the system message's new
text, asserted byte for byte with the rest.

Boundary, alongside the existing prompt injection test: an `AGENTS.md` body
containing an injection string is delivered through the whole path, and asserted
to appear in the tool-role content part and in neither the rendered system
prompt nor a persisted receipt.

Integration, in `apps/api/test/terminal-plugin-integration.test.ts`: a
two-tool-call sequence with the fake Daytona provider showing eager root
delivery, no redelivery, then redelivery after an advanced context epoch.

Harness, in `packages/agent-harness/src/index.test.ts`: `contextEpoch` advances
with each compaction and is stable across the tools of one batch.

The real-provider gates are unchanged — this adds no provider capability, only
lines to a command that already runs.
