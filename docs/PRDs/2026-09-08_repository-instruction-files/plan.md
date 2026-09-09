# Plan: repository instruction files

> Companion to [the PRD](prd.md); state in [state.md](state.md). Phases carry
> an acceptance gate each. The subsystem document that outlives this plan is
> [`resident-context.md`](../../resident-context.md).

## Phase 1 — Discovery, ledger, delivery, and the Terminal kind

- [x] Pure chain primitive and probe script (`instruction-files.ts`), proved
  under real `bash` and `python3`, symlink refusal included.
- [x] Resident context core (`blocks.ts`): kind registry, transitions, message
  and section renderers, code-point truncation, open limits.
- [x] Substream migration 51: `resident_context_blocks`,
  `resident_context_compactions`; storage class; `residentContext` object-port
  authority, RPC entry, and local registration.
- [x] Derived inputs at the settled step, closed in the same commit, replay-safe.
- [x] Terminal runtime: probe after reads, abort-mode probe before mutations
  with the `instructions_pending` refusal, root probe in the repository
  bootstrap for `cloned` and `refreshed`, invalidation on checkout.
- [x] Standing sentence in the plugin system message; contract test.
- [x] Gate: a read delivers the root once; a first mutation beneath an unread
  file is refused and the retry proceeds; the bootstrap records the root; the
  checkout retires every block. All in `apps/api/test/terminal-*.test.ts`.

## Phase 2 — Compaction residency

- [x] `residentContext` harness port: `render()` last in the stable prompt,
  `prepareCompaction()` before the summary turn, summary input filtered by the
  positions the host owns, compacted system message rendered from the proposed
  state, revision bumped when the bytes change.
- [x] Host side: `prepareCompaction` pure over the ledger,
  `applyCompactionInTransaction` inside `commitBindCompaction`, keyed by event.
- [x] Gate: the harness test proves the section is in the compacted system
  prompt, the owned position is out of the summary, and the persisted checkpoint
  carries neither; the ledger test proves the two-compaction lifetime and the
  superseded retirement.

## Phase 3 — Ship

- [x] Owning documents updated: `resident-context.md` (new),
  `terminal-workspaces.md`, `agent-harness.md`, `context-compaction.md`,
  `writing-prompts.md` (principle 12 exception), `security.md`,
  `data-model.md`, `workstream-durable-object.md`, `docs/README.md`.
- [ ] Product owner sets the two limits (open question 4) and answers the flag
  question (open question 2); the numbers land in `blocks.ts` and the `content`
  column gains its `CHECK` in a follow-up migration.
- [ ] Gate: `pnpm lint`, `pnpm typecheck`, the suites above, and the numbers
  finite. Then `state.md` moves to `completed`.
