# PRDs

Design documents for changes large enough that the reasoning matters as much as
the result — where the useful record is *why this shape and not another one*,
not just what shipped.

Small changes do not need one. A PRD earns its cost when a change spans several
subsystems, forecloses an alternative worth naming, or will be revisited by
someone who was not in the room.

For product requirements as a whole, see [`../PRD.md`](../PRD.md). That document
describes what Avalon is; these describe individual changes to it.

## Index

| PRD | Status | Summary |
|---|---|---|
| [2026-08-03 — Borrowing from Monad's harness & orchestration model](./2026-08-03_todo_monad-runtime-and-orchestration-adoption/prd.md) | `todo` | Bound the agent chain, summarize context instead of truncating it, and put both run-start paths behind one admission check. Rejects adopting Monad's full model on scope; records the rest as deferred with triggers. |

## Conventions

**Folder name:** `YYYY-MM-DD_<status>_<kebab-case-name>/`, containing `prd.md`.
The date is when the document was created, not when the work shipped — it stays
fixed so the folder name remains a stable reference.

**Status** is part of the folder name, so it is visible in a directory listing
and in any path already written down:

| Status | Meaning |
|---|---|
| `todo` | Written, not started. |
| `in-progress` | Being implemented. |
| `completed` | Shipped. Any commitment that did **not** ship is recorded in the document with its reason, rather than quietly dropped. |
| `superseded` | A later design replaced it. Kept, because a rejected direction is part of the record — mark it clearly at the top and say what replaced it. |

Renaming a folder on a status change breaks every link into it, so update the
references in the same commit — including any code comments that cite the path.

**Structure.** No fixed template, but the sections that repeatedly earn their
place:

- **Verified facts** up front, each tied to a file and line, with the date they
  were checked. A PRD's claims about the current system decay; saying when they
  were true lets a later reader tell a stale premise from a wrong one.
- **Problem** before solution, and ranked — a prototype and a production system
  rank the same list differently, and the ranking is the decision.
- **Design space** with the alternatives actually considered, including the ones
  rejected and *why*. A rejected design that is only rejected in someone's head
  gets re-proposed every quarter.
- **Non-goals**, explicitly. Scope creep enters through the gap between what a
  document says it is doing and what a reader assumes.
- **Invariants** that are cheap to honour now and expensive to retrofit.
- **Deferred work with triggers** — an observable event that should cause the
  work to happen, not a judgement call. Without one, "deferred" becomes
  "forgotten".
- **Open questions**, separated from decisions, so a reader can tell what is
  settled from what is merely written down.

**Verify what you assert.** Run the SQL, apply the migration against the real
schema, resolve the line numbers. A PRD is read as authoritative long after its
author has moved on, and a plausible-but-wrong fact in one is more expensive
than in ordinary prose.
