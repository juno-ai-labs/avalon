# Creating a GitHub pull request

This document defines the **required shape of every pull request description**
in this repository, and the rules for opening and landing the pull request
itself. Read it before opening a PR. The diff shows _how_ something changed; the
description is the durable record of _what_ changed and _why_, and it is the
reviewer's map through the change.

[`.github/pull_request_template.md`](../.github/pull_request_template.md)
pre-fills a new PR with this shape. The template is the layout; this document is
the specification behind it, and the two are updated together.

## Required sections

Every PR description **must** include these sections, in this order, as Markdown
`##` headings:

1. **Summary** — One or two paragraphs. Lead with the user- or system-visible
   outcome rather than a file list, and keep rationale to a single framing
   clause; the deeper reasoning belongs in **Motivation**. A reviewer should be
   able to read only this section and know whether the PR concerns them. It is
   also what appears in notifications and in the merge commit, so keep it
   self-contained.
2. **Motivation** — The case for the change, in enough depth that a reviewer who
   was not in the room understands the problem before reading the solution.
   - **For a bug fix**: the symptom someone hit, how it triggers, who is
     affected and how badly, and the root cause where known. A reviewer should
     understand what was broken without opening the linked issue.
   - **For a feature**: the job to be done, the gap in the current product, and
     the cost of not doing it. Link the issue, PRD section, or request that
     motivated it.
   - **For a refactor, chore, or tooling change**: the friction being removed
     and what it unblocks. "It was bothering me" is not motivation; "this
     failure cost three sessions this week" is.

   Include what is genuinely relevant and skip what is not. The test: a reader
   should come away understanding why this change is worth making now.

3. **Key changes** — The substantive changes, grouped by area with bold
   lead-ins (`**Worker:**`, `**Desktop renderer:**`, `**Connectors:**`,
   `**Contracts:**`). Every reviewer-relevant change appears here.
4. **Implementation details** — How it works underneath: the data flow, the
   validation path, the Durable Object or Workflow boundary it crosses, why this
   approach rather than the obvious alternative. This is the non-obvious
   mechanics a reviewer would otherwise reverse-engineer from the diff.
5. **Notable internals** — The subtle, easy-to-miss parts a future maintainer
   needs. If a reviewer would ask "wait, why does _that_ work?", answer it here.

## Optional sections

Include these when they apply, and omit them entirely — no empty headings — when
they do not.

- **Key design decisions** — Decisions that were debated or that a reader might
  otherwise second-guess, numbered, each with its rationale.
- **Architecture highlights** — The structural shape of a larger change: new
  tables, bindings, Durable Objects, Workflows, connector adapters, or registry
  entries.
- **Database migrations** — Every migration the PR adds under
  `packages/db/migrations/`, by its real `NNNN_name.sql` filename, with a
  one-line description and a note on whether it is safe to re-run. **Required
  whenever the PR adds a migration.** Confirm the numeric prefix is unique and
  strictly greater than every migration on the base branch: two branches that
  each claim the next number merge cleanly in Git and collide in the migration
  sequence. The repository already carries three such collisions — `0039`,
  `0041`, and `0046` are each used by two migrations — so this is the failure
  mode to actually watch for, not a hypothetical one. Call out any merge-time
  renumber hazard under **Reviewer notes**. A migration is applied to both
  regions; say so if the two diverge.
- **Regional impact** — What changes in Global, in the European Union, or in the
  routing between them. **Required in spirit** for anything touching identity,
  the Global registry, cross-region bridges, provider ingress routing, or data
  residency. Read [Regionalization](regionalization.md) first.
- **Security and trust model** — The trust surface the change opens or closes:
  renderer isolation, connector credential scope, session and ticket handling,
  webhook signature verification, untrusted model or provider payloads, secrets
  placement. **Required in spirit** whenever the change touches any of those;
  [Security model](security.md) defines the boundaries. A change that adds a
  defensive limit lists every one it leaves open here, and again under **Reviewer
  notes** as deferred work, per
  [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md).
- **Provider configuration** — Any change requiring a Slack, GitHub, Linear,
  Notion, Google, Resend, or Cloudflare setting to be updated outside the repo,
  and in which region. A reviewer must be able to see what will break if the
  configuration is not applied before merge.
- **Related or new documentation** — The `docs/` files added or updated in this
  change. When a PR changes a subsystem, the matching doc update ships in the
  same PR. A PR that creates or substantially changes an architecture or large
  module also carries that module's document and a new entry in its **Changelog**
  saying why the change was made, per
  [`module-documents.md`](module-documents.md); a reviewer who sees neither
  should ask for them.
- **Reviewer notes** — What the reviewer needs that is not part of the change:
  a merge-time migration collision, deferred work, a known-failing check.
- **Validation** — How it was verified. Name the commands you actually ran and
  their outcome: `pnpm lint` and `pnpm typecheck`, the tests that cover what you
  touched per
  [how much to run](testing.md#how-much-to-run), `pnpm test:scripts` and the
  Wrangler dry-run builds where those surfaces moved, and — for anything visible
  — the screens captured from a real window per
  [the development environment guide](dev-environment.md#driving-and-screenshotting-it).
  `pnpm test` in full is CI's gate: never write an outcome for a run you did not
  produce, and "none — documentation-only" is a complete answer where it is the
  true one. Call out pre-existing failures as pre-existing.

## Never open a draft pull request

Every pull request is opened **ready for review** — never as a draft. Do not
pass `--draft` to `gh pr create`, do not set `draft: true` through the API, and
do not use GitHub's "Create draft pull request" button. If a change is not ready
for a reviewer to read, leave it on the branch and open the PR when it is.

Use the description — **Reviewer notes** for deferred work, **Validation** for a
known-failing check — to say what is still in flight, rather than the draft state.

If you inherit a draft PR, mark it ready (`gh pr ready <n>`) rather than leaving
it in that state.

## Branch style and merge style

These are two different rules that point in opposite directions, and both are
deliberate.

**Only rebase a branch if there is a conflict otherwise merge the pull request.**
Do not rebase just because `main` has moved; only rebase when there is a conflict
or a dependency on new changes in `main`.

### While the pull request is open: rebase

Bring a branch up to date with `main` by **rebasing onto it**, never by merging
`main` into the branch:

```bash
git fetch origin main
git rebase origin/main
git push --force-with-lease
```

A branch therefore contains only its own commits, in order, on top of current
`main`. The diff a reviewer reads is exactly the change under review, with no
merge commits interleaving unrelated work into it. That also keeps the branch's
own history bisectable and makes it obvious which `main` the change was tested
against.

Rebase when the branch needs `main`'s content — a conflict, a dependency on
something that just landed — not on a schedule and **not as a pre-merge ritual**;
a clean branch merges as it is, per [A moving `main` is not a reason to hold a
clean merge](#a-moving-main-is-not-a-reason-to-hold-a-clean-merge) below.

Two things to know before rebasing:

- **A rebase silently drops merge commits and everything unique to them.** If a
  branch already contains a `Merge main into …` commit — including the
  conflict resolutions and any work committed alongside them — replaying it will
  discard that content without a conflict or a warning. Before force-pushing,
  compare against the pre-rebase state (`git diff <backup-ref> HEAD`) and
  re-commit anything the rebase dropped. Keeping to rebases from the start
  avoids the situation entirely.

### When the pull request lands: merge

Pull requests land as **merge commits** — never squash, never rebase-merge:

```bash
gh pr merge <n> --merge
```

`main`'s history is deliberately a sequence of `Merge <description>` commits
over preserved per-branch work: each merge commit is one reviewed change that
can be reverted as a unit, and the individual commits underneath it stay intact.
Configure branch protection and auto-merge accordingly — allow merge commits,
disable squash merging and rebase merging.

### A moving `main` is not a reason to hold a clean merge

A branch is ready to merge as soon as two conditions are met: the pull request's
own head is green, and the repository's own merge requirements are satisfied —
no conflict, plus whatever reviews and required checks branch protection asks
for. `main` having advanced since those checks started is **not** a third
condition.

Do not rebase, force-push, and wait for a replacement run purely to
have CI observe a head that sits on the newest `main`: by the time that run
finishes `main` has usually moved again, so each attempt costs a cycle and
reopens the same gap it just closed. What that gap is, and what it is worth, is
the last part of this section.

```bash
gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup
```

`mergeable` answers one question only — whether Git can produce the merge
without a conflict — and it has three values, not two. `CONFLICTING` is the case
the rebase above exists for: bring the branch up to date, re-run the gates,
force-push, and merge on the replacement run. `UNKNOWN` means GitHub has not
finished computing the merge yet, which is the state a branch is in for the
first seconds after any push, and so the one a reader of this section is most
likely to catch it in: poll again, and do not rebase.

`MERGEABLE` is not permission to merge. That is `mergeStateStatus`, the second
field the command fetches: `BLOCKED` means a required review or required check
is outstanding, `UNSTABLE` means checks are still running or a non-required one
is red, and `CLEAN` means nothing is left. A branch can be `MERGEABLE` and
`BLOCKED` at the same time, so read both fields rather than treating the first
as the whole answer.

Leave branch protection's _Require branches to be up to date before merging_
off, because turning it on encodes exactly the chase this section forbids. It is
also the setting that produces the `BEHIND` state: with it off, `BEHIND` never
appears, which is the mechanical reason this section's rule can be a binary on
mergeability rather than a judgement about distance from `main`.

Rebase before merging a _mergeable_ branch only when something concrete about
`main`'s new commits interacts with this change — a migration prefix that now
collides per **Database migrations** above, a rename or signature change landing
in the same files, a contract both sides edited. That is a judgement about two
specific diffs, not a reflex triggered by any new commit on `main`.

The residual risk is a semantic conflict: two changes that Git merges without a
conflict and that break each other. Be precise about what the chase would buy,
because it is not nothing. A `pull_request` run tests GitHub's merge of the
branch into `main` **as of when that run started**, so re-running against a
newer `main` genuinely does test a newer combination. What it cannot do is close
the window — `main` can move between the run finishing and the merge landing —
so the choice is between a window of minutes and a rebase loop that never ends,
not between a risk and no risk.

Know where that risk actually lands here. `.github/workflows/ci.yml` triggers on
`pull_request` only: **nothing runs the suite on `main` after a merge.** The
deployment workflows that do trigger on a push to `main` are path-filtered and
verify a deployment, not the tree. So the first run to exercise the merged
content is the _next_ pull request's, which merges its branch into the `main`
this change just became part of — soon, on a repository this active, and by
someone who did not write it. That is the cost being accepted, and it is why the
exceptions above are worth applying with some care rather than waved through.

A merge queue with a `merge_group` trigger on CI is the option that would give
both: GitHub tests the combined state itself, without an author rebasing for it.
Nobody has set one up, and whether the wait it adds to every merge is worth it
here is the team's call, not a rule this document should invent.

When it does go wrong, the merge-commit style keeps the fix small: `git revert
-m 1 <merge-sha>` on `main` takes the whole change back out as a unit. Note the
trap on the way back in — the reverted merge is still in `main`'s ancestry, so
re-merging the same branch brings back nothing. Revert the revert, or land the
work as new commits.

## Conventions

- Markdown `##` for each top-level section; `**bold:**` lead-ins to group
  bullets within **Key changes**.
- Descriptive past tense ("Added the regional bridge…", "Replaced the polling
  fallback…").
- Reference files, tables, bindings, and migrations by their real names so a
  reviewer can jump straight to them.
- A **required** section with genuinely nothing to say keeps its heading and
  gets `N/A — <reason>`. Only _optional_ sections disappear entirely.

## Skeleton

```markdown
## Summary

<one or two paragraphs: the outcome, with a one-line framing>

## Motivation

<why this is worth making now, with links to the motivating issue or evidence>

## Key changes

**<Area>:**

- <change>

## Implementation details

- <how it works underneath>

## Notable internals

- <the subtle parts>

## Key design decisions <!-- optional -->

## Architecture highlights <!-- optional -->

## Database migrations <!-- optional; required when the PR adds one -->

## Regional impact <!-- optional -->

## Security and trust model <!-- optional -->

## Provider configuration <!-- optional -->

## Related or new documentation <!-- optional -->

## Reviewer notes <!-- optional -->

## Validation <!-- optional -->
```

## Worked example

```markdown
## Summary

Adds a per-work-stream mute window so a participant can silence a busy work
stream for a fixed period without leaving it. A muted work stream stops
producing notifications until the timestamp passes, after which delivery
resumes on its own.

## Motivation

A work stream that an automation is actively driving can produce dozens of
events an hour, and the only way to escape it today is to leave — which loses
the participant's place in the transcript and removes them from the record. The
requests we have collected are all time-boxed in nature ("mute until this
deploy is done"), so a window that expires by itself covers them without the
user having to remember to turn anything back on.

## Key changes

**Data model:**

- Added `workstream_participant_mutes` (`workstream_id`, `user_id`,
  `muted_until`).

**Worker:**

- `PUT /workstreams/:id/mute` sets or clears the window.

**Desktop renderer:**

- Added a mute item to the work-stream header menu (1h / 8h / until cleared).

## Implementation details

- The mute is read once per delivery batch and cached on the routing context,
  so a fan-out to N participants stays a single lookup.
- Expiry is lazy: a row whose `muted_until` has passed is ignored at read time
  rather than swept by a scheduled job.

## Notable internals

- The check runs after direct-mention handling, so an explicit mention still
  breaks through a muted work stream by design.

## Database migrations

- `0049_workstream_participant_mutes.sql` — Creates the table. Uses
  `CREATE TABLE IF NOT EXISTS`; safe to re-run. Applies identically in both
  regions.

## Related or new documentation

- Updated `docs/data-model.md`.

## Validation

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and both Wrangler dry-run builds
  clean. Muted and unmuted header states captured from the running desktop
  client.
```
