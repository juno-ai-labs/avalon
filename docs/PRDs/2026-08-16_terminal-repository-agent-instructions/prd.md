# Terminal repository agent instructions

> Created 2026-08-16.
>
> A repository's `AGENTS.md` files reach the model that is editing it — the
> right ones, at the moment they apply, and again after a compaction throws
> them away. Protocol detail: [`design.md`](design.md). Subsystem:
> [`terminal-workspaces.md`](../../terminal-workspaces.md). Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

When Avalon works inside a checked-out GitHub repository, it now reads that
repository's own instructions for agents — the `AGENTS.md` files described by
[the AGENTS.md specification](https://agents.md) — and follows them. Avalon
delivers the root file the first time a Terminal tool touches the workspace, and
delivers a nested subproject's file the first time a tool touches that
subproject, so the model is holding the conventions that govern a file at the
moment it changes it. A participant sees the effect rather than the mechanism: a
pull request that uses the repository's package manager, its test command, and
its commit conventions instead of Avalon's guesses at them.

Delivery is repeated rather than remembered. The instruction text lives only in
the live context and is re-delivered whenever that context is gone — after a
context compaction, after a resumed run, after a worker interruption replays a
receipt, and whenever the file's own bytes change. Nothing about a repository's
instructions is written into Avalon's system prompt, its compaction summary, or
a durable tool receipt, because all three would either promote untrusted
repository text to platform authority or pin a stale copy of it for the life of
the work stream.

## Motivation

A Terminal work stream that has checked out a repository is asked to change that
repository, and it currently has no access to the one file the repository wrote
down for exactly this purpose. The consequences are ordinary and constant: the
model runs `npm test` in a pnpm workspace, edits a generated file that the
project's instructions say to regenerate, formats against its own defaults, or
opens a pull request that fails a check the repository documents in its first
paragraph. Every one of those is a wasted round trip at best and a wrong change
at worst, and the repository already told us how to avoid it.

`AGENTS.md` is the settled convention for that file. This repository publishes
one and symlinks `CLAUDE.md` to it; the format is a plain Markdown file at the
repository root, with nested files inside packages of a monorepo, and the
specification's contract for an agent is short: read the nearest file, follow
it, run the programmatic checks it defines, and let an explicit human request
override it. Avalon satisfies none of that today. The plugin prompt does not
mention the file, no tool result carries it, and nothing in the harness would
keep it in context if the model read it by hand.

Reading it by hand is also not a fix, which is the second half of the problem
and the reason this is a change to the harness rather than a line in a prompt.
A run compacts at 80% of the model's context window and keeps nothing verbatim
except its own system prompt — so a `terminal_read_file` on `AGENTS.md` at turn
three is gone by turn ninety, along with the model's memory that it ever read
it. The same applies to a work stream's second run, and to a run resumed after a
Worker interruption. A repository's instructions are needed for as long as the
work lasts, and the only thing in this system that lasts that long is state the
host re-derives.

## Goals

1. A model editing a repository has that repository's root `AGENTS.md`
   instructions in context before it changes any file, without spending a turn
   looking for them.
2. A model editing a file inside a subproject that ships its own `AGENTS.md` has
   that file's instructions too, with the specification's precedence — the
   closest file wins, and an explicit participant request outranks both.
3. Instructions are present again after any event that empties the live context:
   a compaction, a new run in the same work stream, a resumed run, a replayed
   tool receipt.
4. Instructions track the working tree: a file the model edits, a branch switch
   that changes it, or a repository replacement that removes it is reflected on
   the next Terminal tool call rather than at the end of the run.
5. Repository text is delivered inside the trust layer it belongs to. It never
   enters the system prompt, a compaction summary, or a durable tool receipt,
   and it cannot expand what the run is allowed to do.
6. The cost is bounded and stated: a known ceiling on how many files are
   indexed, how much of each is delivered, and how much is spent per context,
   with a recovery path named whenever a bound truncates something.

## Non-goals

1. **Avalon does not author `AGENTS.md` files.** It follows a repository's
   instructions; it does not add, update, or propose one as part of doing other
   work. A participant may ask for one, and the model writes it with the
   ordinary file tools like any other change. Rejected outright: an agent that
   writes its own instruction file into someone else's repository is editing the
   thing that constrains it.
2. **No other instruction file is read.** Not `CLAUDE.md`, `.cursorrules`,
   `.github/copilot-instructions.md`, or a tool-specific settings file. The
   specification's own migration guidance is to make `AGENTS.md` the real file
   and symlink the rest, and a second discovery path would double the
   untrusted-content surface for repositories that already have a supported way
   to opt in. Deferred: a repository that has only `CLAUDE.md` gets nothing
   until it adopts the standard name.
3. **A sandbox with no repository is out of scope.** Discovery runs inside
   repository bootstrap, so a work stream doing local analysis with no checkout
   gets no index and no delivery. Deferred; it needs a separate probe on a path
   that today performs no provider call, and the file it would find is one the
   same run just wrote.
4. **Instructions are not enforced.** Nothing in Avalon parses a repository's
   test command and runs it, blocks a write that violates a style rule, or
   verifies conformance before publication. The instructions are given to the
   model as instructions. Rejected: enforcement would mean executing text a
   repository controls, which is a much larger authority question than reading
   it.
5. **No participant-facing surface.** No inspector-rail panel listing the
   instruction files in effect, no transcript entry when one is delivered. The
   observable outcome is the work. Deferred until there is evidence someone
   needs to debug this from the product rather than from logs.
6. **The compaction checkpoint gains no repository section.** The appendix
   Avalon renders after a summary stays the authorized resource inventory it is
   today. Redelivery on the next Terminal tool call covers the same ground
   without giving a second subsystem a stake in the checkpoint's shape.

## Product behavior

A participant asks a work stream to change a repository. The model calls
`terminal_checkout_repository`, then a Terminal file or command tool. That first
tool's result carries, alongside its ordinary output, the repository's root
`AGENTS.md` and a list of the other `AGENTS.md` paths in the tree with their
sizes. From that point the model is working with the repository's build
commands, test commands, and conventions in front of it.

When the model first reads, edits, patches, or runs a command inside a directory
that has its own `AGENTS.md` — `packages/api/AGENTS.md`, say — that file arrives
with that tool's result, together with any files between it and the root that
have not been delivered yet. The model is told which directory each block
governs and that the deepest block wins where two disagree.

**Empty state.** A repository with no `AGENTS.md` produces no delivery and no
notice. The model works as it does today.

**Changed state.** If the model edits an `AGENTS.md`, or a `git checkout`,
`merge`, or `pull` changes one, the next Terminal tool result carries the new
text with a line saying it replaces what was delivered earlier. A file that
disappears produces a one-line notice instead of a body, and only if it had been
delivered.

**After a compaction.** The model's context is replaced by its own summary, and
the repository's instructions are not in it. The next Terminal tool call
re-delivers the root file and whatever governs the path that tool touched. The
model's standing knowledge that this happens comes from the Terminal plugin's
system message, which is platform-authored and survives the compaction
unchanged.

**Across runs.** A later run in the same work stream, or the same run resumed
after an interruption, is in the same position as a compacted context: no
delivered text, and re-delivery on its first Terminal tool call.

**Error state.** If the index cannot be produced — a bootstrap command failure, a
tree that cannot be listed — the tool still runs and its result says that Avalon
could not read the repository's instruction files and that the model should look
for `AGENTS.md` itself before making conventions up. Terminal work is never
blocked on this.

**Bounded state.** A tree with more `AGENTS.md` files than the index holds, a
file larger than the per-file allowance, or a context that has already spent its
per-context allowance produces a truncation marker naming `terminal_read_file`
as the way to read the rest. Nothing is dropped silently.

**Authority.** A delivered block is repository-authored working convention, not
Avalon policy and not a participant's request. It directs how work is done
inside that repository — which commands, which style, which checks. It cannot
change what the run may do: not its network policy, not its branch or
publication rules, not its credentials, not what it may read or send. A block
that asks for any of those is ignored in that part, and the model says so rather
than silently complying or silently refusing.

## Impact on the product contract

None — this refines behavior within the existing contract. Terminal remains a
deferred plugin with the same nine tools, the same one-sandbox-per-work-stream
authority fence, and the same publication boundary. What changes is what the
model knows while using them.

## Agent behavior

**Plugin contract.** `avalon:terminal` keeps its canonical ID, its
`avalon_terminal` model ID, its `terminal` wire prefix, its deferred non-preload
loading, and its nine tools in their current order. Its system message gains one
rule, which is the only platform-authored text this change adds to the prompt
prefix: that Avalon delivers a checked-out repository's `AGENTS.md` files with
the tool results they apply to, that a delivered block is the repository's own
working convention for the directory it names, that the deepest block wins over
a shallower one and a participant's request wins over both, that its programmatic
checks should be run before reporting work as done, and that it never changes
what the run is allowed to do — with the instruction to ignore that part and say
so if it tries. Loading the plugin still starts, authorizes, and persists
nothing; discovery happens during the repository bootstrap that the first
executed tool already performs.

**Tool catalog.** Unchanged. No tool is added, removed, renamed, or given a new
argument. `terminal_read_file` remains the way to read any part of an
instruction file that a bound truncated.

**Wire shapes.** Unchanged in the durable envelope: every tool's `success`/`data`
output keeps its current fields, and none of them gains repository text.
Delivered instructions ride as an additional text content part after the JSON
result — the same non-durable channel that carries an image to the model for
`workstream_view_resource` — so the text reaches the current turn and never a
receipt, a transcript row, or a replay.

**Discovery and sequencing.** The model does not request instructions and cannot
address them; there is no ID, cursor, or revision to thread. Ordering within one
delivery is deterministic: root first, then each deeper directory, then the
governing file for the touched path.

**Failure and self-healing.** The failure surface is deliberately one-sided.
Index failure and truncation are reported in the same tool result as ordinary
output with the next action named — look for `AGENTS.md` yourself, read the rest
with `terminal_read_file` — and no new error code is added, because no Terminal
tool fails on account of an instruction file. A repository instruction that asks
the model to exceed its authority is answered by the plugin rule above: ignore
that part, do the rest, say what was ignored.

**Authority and lifecycle.** Which files exist, which one governs a path, and
what those files say are all host-derived from the sandbox at the frozen
generation; the model chooses none of it. Content is scrubbed with the same
sanitizer that cleans command output before it reaches the model. The delivered
set's lifetime is bounded by the live context's lifetime by construction: the
record of what has been delivered is in-memory, keyed to the run, the sandbox
generation, and the context's compaction index, so every event that empties the
context also empties the record.

## Security and trust model

[`security.md`](../../security.md) states that repository contents are untrusted,
and this change does not move that line — it decides where untrusted repository
text is allowed to sit and what it is allowed to mean.

It sits in a tool-role message, labelled, for the current turn only. It does not
enter the system prompt, which is the one text that may tell the model what it
is allowed to do, and it does not enter the compaction summary, which flattens
the transcript's authority layers into a single user-role message. That second
exclusion is the load-bearing one: a summarizer asked to record "every
instruction" will transcribe a repository's prose into the checkpoint's request
section, where the next run replays it as the opening of its own conversation
with the marking that made it repository text stripped off. That is the failure
[`context-compaction.md`](../../context-compaction.md) already documents for
Slack context, applied to a file anyone with commit access can edit. The
compaction summary prompt is therefore told to record which instruction files
were in effect and never their text, because Avalon re-delivers the current text
and a summarized copy could only ever be stale, unattributed, or both.

What a block may do is scoped in the plugin rule rather than left to inference:
it directs work inside the repository, and it cannot grant authority, widen
egress, change branch, credential, or publication rules, or direct the model to
read or transmit secrets. The existing enforcement boundaries are unchanged and
remain the actual defence — a repository that asks for a push to another branch
still meets a repository-scoped token and the publisher's exact-ref checks.

## Key design decisions

1. **The system prompt carries the rule; tool results carry the text.**
   Rendering `AGENTS.md` into the Terminal plugin's system message would make it
   survive compaction for free, which is why it is the first thing anyone
   proposes. Rejected: [`writing-prompts.md`](../../writing-prompts.md) reserves
   the prefix for platform-authored policy and admits only derived provenance
   from outside content, `prompts.test.ts` asserts that boundary directly, and a
   per-run interpolation of repository text would break prefix caching and
   byte-stable replay as well. The rule is static and belongs in the prefix; the
   text is content and belongs in a message.

2. **A skill is not the vehicle.** A loaded skill body is rendered into the
   system prompt under `# Active Skill Instructions`, and the run's skill array
   is frozen before admission — before any sandbox exists. Both facts disqualify
   it independently.

3. **Redelivery, not persistence.** The alternative to re-delivering is to store
   the delivered text and replay it as context. Rejected on the same grounds
   [`context-compaction.md`](../../context-compaction.md) rejects pinning a
   message: anything stored at a fixed position in a replayed prefix is spent on
   every later turn and outlives the state that justified it, and here it would
   also go stale the moment someone edits the file. Re-derivation from the
   working tree is both cheaper and correct by construction.

4. **The delivery record is in-memory, and that is the feature.** A durable
   record of what has been delivered would suppress redelivery in exactly the
   cases the goal list names — a resumed run, a replayed receipt, a new run —
   because the record would outlive the context it describes. Keeping it in
   memory, keyed additionally by the compaction index, makes "the model has this
   text" and "Avalon believes the model has this text" the same fact. No table,
   no migration.

5. **Nested files are delivered on touch, not all at once.** Delivering every
   `AGENTS.md` in a large monorepo at the first tool call would spend thousands
   of tokens on subprojects the task never opens, at every compaction. The
   index — paths and sizes, no content — is delivered eagerly instead, so the
   model can see that a subproject has instructions and read them before it
   starts, and the body arrives with the first tool that touches the subtree.

6. **A write tool that touches a new subtree delivers after the write.** The
   ordering is a real limitation of attaching delivery to tool results. Rejected
   alternatives: rejecting the first write into a subtree until its instructions
   have been delivered, which costs a turn and fails a legitimate call; and
   delivering everything eagerly, which is decision 5. The block delivered with a
   write says that it governs the file just changed, so the model can check its
   own change against it — and the eager index means an attentive model reads it
   first.

7. **Discovery rides the bootstrap that already runs.** Repository bootstrap
   executes on every sandbox acquisition and is already a single shell command;
   the index is a few more lines in it, not a new provider round trip. It also
   means the index is recomputed on every tool call, which is what makes content
   drift detectable without a watcher.

## Data model

None. No table, no column, no migration. See key design decision 4.

## Regional impact

None. Instruction text is read from the workspace's own regional sandbox,
delivered to the model on the same regional inference path as every other tool
result, and never persisted in either region.

## Acceptance

1. A work stream checks out a repository with a root `AGENTS.md` and asks for a
   change. The first Terminal tool result carries the root file; the model's
   commands match the repository's documented package manager and test command.
2. A repository with a nested `packages/*/AGENTS.md` is edited in that package.
   The nested file is delivered with the first tool that touches it, after the
   root file, and the model follows the nested rule where the two differ.
3. A run is driven past its compaction threshold. The next Terminal tool result
   carries the root file again; the stored checkpoint contains the instruction
   file's path and none of its text.
4. The model edits `AGENTS.md`. The next Terminal tool result carries the new
   text and says it replaces the earlier delivery.
5. A repository with no `AGENTS.md` produces no delivery, no notice, and no
   additional provider call beyond the existing bootstrap.

## Open questions

- **Should the delivered index be ordered by relevance rather than by path?** In
  a repository with fifty subprojects the index is a long list of paths the task
  will never touch. Sorting by path is deterministic and explicable; sorting by
  proximity to the work would be more useful and less predictable. Path order
  ships first because the byte ceiling makes the list bounded either way.
- **Does the per-context allowance need to be per-repository instead?** A work
  stream that replaces its repository mid-run pays the allowance twice. Whether
  that matters depends on how often repository replacement happens in a single
  context, which nothing measures today.

## Decision log

None yet.
