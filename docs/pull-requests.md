# Creating a GitHub pull request

This document defines the **required shape of every pull request description**
in this repository. Read it before opening a PR. The diff shows *how* something
changed; the description is the durable record of *what* changed and *why*, and
it is the reviewer's map through the change.

The repository has no `.github/pull_request_template.md` — this document is the
template.

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
   needs. If a reviewer would ask "wait, why does *that* work?", answer it here.

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
  residency. Read [Regionalization](REGIONALIZATION.md) first.
- **Security and trust model** — The trust surface the change opens or closes:
  renderer isolation, connector credential scope, session and ticket handling,
  webhook signature verification, untrusted model or provider payloads, secrets
  placement. **Required in spirit** whenever the change touches any of those;
  [Security model](SECURITY.md) defines the boundaries.
- **Provider configuration** — Any change requiring a Slack, GitHub, Linear,
  Notion, Google, Resend, or Cloudflare setting to be updated outside the repo,
  and in which region. A reviewer must be able to see what will break if the
  configuration is not applied before merge.
- **Related or new documentation** — The `docs/` files added or updated in this
  change. When a PR changes a subsystem, the matching doc update ships in the
  same PR.
- **Reviewer notes** — What the reviewer needs that is not part of the change:
  a merge-time migration collision, deferred work, a known-failing check.
- **Validation** — How it was verified. Name the commands and their outcome:
  `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, both Wrangler
  dry-run builds, and — for anything visible — the screens captured from a real
  window per
  [the development environment guide](dev-environment.md#driving-and-screenshotting-it).
  Call out pre-existing failures as pre-existing.

## Merge style

Branches land as **merge commits**. The history is deliberately a sequence of
`Merge <description>` commits over preserved per-branch work; do not squash and
do not rebase onto main. Configure branch protection and auto-merge accordingly.

## Conventions

- Markdown `##` for each top-level section; `**bold:**` lead-ins to group
  bullets within **Key changes**.
- Descriptive past tense ("Added the regional bridge…", "Replaced the polling
  fallback…").
- Reference files, tables, bindings, and migrations by their real names so a
  reviewer can jump straight to them.
- A **required** section with genuinely nothing to say keeps its heading and
  gets `N/A — <reason>`. Only *optional* sections disappear entirely.

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

## Key design decisions          <!-- optional -->
## Architecture highlights       <!-- optional -->
## Database migrations           <!-- optional; required when the PR adds one -->
## Regional impact               <!-- optional -->
## Security and trust model      <!-- optional -->
## Provider configuration        <!-- optional -->
## Related or new documentation  <!-- optional -->
## Reviewer notes                <!-- optional -->
## Validation                    <!-- optional -->
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

- Updated `docs/DATA_MODEL.md`.

## Validation

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and both Wrangler dry-run builds
  clean. Muted and unmuted header states captured from the running desktop
  client.
```
