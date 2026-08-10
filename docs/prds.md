# Product requirement documents

This document defines **where a product requirement document lives, how its
folder is named, and when it stops being editable**. Read it before writing a
PRD, before renaming one, and before citing one as current guidance.

A PRD here is a *point-in-time* document: it argues for a change, defines its
scope, and records the decisions taken while it was being built. It is not the
durable reference for the subsystem it created — that is the matching document
in [the documentation index](README.md), which is updated alongside the code
long after the PRD is frozen.

**This is not [`PRD.md`](PRD.md).** That document is the standing product
contract for Avalon as a whole — what a work stream is, what the agent may do,
what the visual language is — and it stays current. The documents this file
governs are the numbered, dated proposals under `docs/PRDs/`, each covering one
change.

## Where a PRD lives

Every PRD is a **folder** under `docs/PRDs/`, named:

```
<yyyy>-<mm>-<dd>_<status>_<kebab-case-short-description>
```

For example:

```
docs/PRDs/2026-08-10_in-progress_workstream-mute-windows/prd.md
```

The date is the date the PRD was **created**, and it never changes — not when
work starts, not when it ships, not when something supersedes it. The folder is
therefore stable enough to link to, and a directory listing sorts into a
chronological record of what the product has proposed.

One folder is one PRD. A change large enough to split into focused parts becomes
several folders that link to each other, not several PRDs in one folder.

## The status segment

The status segment is one of exactly four values, so that enumerating PRDs — by
a person or by an agent — always lands every document in a defined bucket:

| Status | Meaning |
| --- | --- |
| `todo` | Proposed and agreed as a direction. No implementation has started. |
| `in-progress` | Being built now. The PRD is live and may still change. |
| `completed` | Shipped. A historical document. |
| `superseded` | Replaced by one or more newer PRDs, or abandoned in favour of a different direction. A historical document. |

`todo` and `in-progress` are the active buckets; `completed` and `superseded` are
the historical ones. There is no fifth value — a PRD that was written and never
pursued is `superseded`, with the banner saying so.

**Changing status means renaming the folder**, leaving the date and description
segments alone:

```bash
git mv docs/PRDs/2026-08-10_todo_workstream-mute-windows \
       docs/PRDs/2026-08-10_in-progress_workstream-mute-windows
```

Update the status banner in the body in the same commit, so the folder name and
the document never disagree. When they do disagree, **the folder name is
authoritative** — it is what enumeration reads.

## Historical documents are frozen

**Once a PRD is `completed` or `superseded`, it is not edited again.** It records
what was decided at the time, and its value is that a later reader can trust it
to say what was actually believed and agreed then, rather than a version quietly
reconciled with what shipped afterwards.

If the shipped system drifts from a completed PRD, the drift is recorded in the
subsystem document that owns the area — not by editing the PRD. If the direction
itself changes, write a new PRD and mark the old one `superseded`.

Two edits are still allowed on a frozen PRD, because they are about *finding*
it rather than about its content: adding or correcting the status banner
(including links to the successors that replaced it), and fixing a link that
broke when another document moved.

## Files inside the folder

| File | Purpose |
| --- | --- |
| `prd.md` | **Required.** The PRD itself: the problem, the goals and non-goals, the proposed product behavior, and the decisions. This is the file other documents link to. |
| `plan.md` | The phased build checklist for the PRD, with an acceptance gate per phase. Add it when the work is large enough that sequencing matters. |
| `design.md` | Architecture and rationale too detailed for the PRD body — schemas, protocols, migration strategy. |
| `research.md` | Prior art, competitor behavior, or investigation that informed the PRD but is not itself a proposal. |
| `README.md` | Only for a folder that has grown into a bundle: a short map saying which file is actionable and which are supporting provenance. |

Anything else follows the same shape — lower-kebab, `.md`, descriptive of its
role. Split a file out when it is long enough that the PRD body suffers for
carrying it; keep everything in `prd.md` otherwise.

## The status banner

Every `prd.md` opens with an H1 title and then a blockquote banner, before any
other prose:

```markdown
# Work-stream mute windows

> **Status: in-progress.** Created 2026-08-10. Owner: <name>.
>
> A participant can silence a busy work stream for a fixed period without
> leaving it. Companion plan: [`plan.md`](./plan.md). Standing contract:
> [`../../PRD.md`](../../PRD.md).
```

The banner carries the status, the creation date, the owner, a one-line scope,
and links to the companion files and to the documents a reader needs alongside
it. Keep it to what orients a reader who arrived from a search result.

A `superseded` PRD's banner must **name its successors and link them**, because
that banner is the only thing standing between a future reader and a design that
was deliberately abandoned:

```markdown
> **Status: superseded** by
> [`2026-09-02_in-progress_workstream-notification-rules`](../2026-09-02_in-progress_workstream-notification-rules/prd.md),
> which replaces per-work-stream mute windows with general notification rules.
> Design only — no code shipped from this PRD. Do not build against it.
```

The successor's own banner should point back, so the pair reads correctly from
either end.

## Relationship to the rest of `docs/`

- **PRDs are not registered individually in [the documentation
  index](README.md).** That index registers the durable documents that own an
  area, and it would churn beyond usefulness with one row per proposal. This
  document is the `docs/PRDs/` tree's entry in it; the folder listing is the
  tree's own index.
- **A PRD does not replace the subsystem document.** When a PRD ships, the
  behavior it introduced is described in the document that owns the area —
  [`ARCHITECTURE.md`](ARCHITECTURE.md), [`DATA_MODEL.md`](DATA_MODEL.md),
  [`CONNECTORS.md`](CONNECTORS.md), and so on — updated in the same change as
  the code, per [the agent rule sheet](../AGENTS.md). If a PRD introduced a
  subsystem that no existing document covers, add `docs/<NAME>.md` and register
  it in the index.
- **A subsystem document may cite a PRD** for the reasoning behind a decision.
  Link to the folder's `prd.md` by its full path, not by its status — the status
  segment is part of the path and the link breaks when the folder is renamed, so
  re-point the link in the renaming commit.
- **[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)** remains the phased
  checklist for the product build as a whole. A PRD's own `plan.md` covers only
  that PRD.
- **A pull request implementing a PRD** links to it from the **Motivation**
  section of its description, per [`pull-requests.md`](pull-requests.md).

## Creating one

1. Pick today's date, a status of `todo` or `in-progress`, and a short
   kebab-case description. Create
   `docs/PRDs/<yyyy>-<mm>-<dd>_<status>_<description>/prd.md`.
2. Write the title, then the status banner: status, creation date, owner,
   one-line scope, companion links.
3. Write the body — the problem, the goals, the explicit non-goals, the proposed
   behavior, and the decisions with their rationale. Say what is *not* in scope
   as plainly as what is; an unstated non-goal is the thing that gets built
   anyway.
4. Split out `plan.md`, `design.md`, or `research.md` if the body is carrying
   material that belongs in one of them.
5. As work proceeds, rename the folder's status segment and update the banner in
   the same commit.
6. When it ships, rename to `completed`, make sure the subsystem documents
   describe the shipped behavior, and stop editing the PRD.
