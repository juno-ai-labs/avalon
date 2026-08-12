<!--
The full specification is docs/pull-requests.md. Read it before filling this in.

Open this pull request ready for review — this repository does not use draft
pull requests. If the change isn't ready for a reviewer, leave it on the branch.

The five sections below are required and always keep their headings. If one has
genuinely nothing to say, write `N/A — <reason>` rather than deleting it.

Optional sections are collected at the bottom. Uncomment the ones that apply and
delete the rest — do not leave empty headings behind.
-->

## Summary

<!--
One or two paragraphs. Lead with the user- or system-visible outcome, not a file
list, and keep rationale to a single framing clause. This is what appears in
notifications and in the merge commit, so keep it self-contained: a reviewer
should be able to read only this section and know whether the PR concerns them.
-->

## Motivation

<!--
Why this is worth making now, in enough depth that a reviewer who was not in the
room understands the problem before reading the solution.

- Bug fix: the symptom, how it triggers, who is affected and how badly, and the
  root cause where known.
- Feature: the job to be done, the gap in the product today, the cost of not
  doing it. Link the issue, PRD section, or request behind it.
- Refactor, chore, or tooling: the friction removed and what it unblocks.
-->

## Key changes

<!--
The substantive changes, grouped by area with bold lead-ins. Every
reviewer-relevant change appears here.

**Worker:**
- …

**Desktop renderer:**
- …

**Connectors:**
- …

**Contracts:**
- …
-->

## Implementation details

<!--
How it works underneath: the data flow, the validation path, the Durable Object
or Workflow boundary it crosses, why this approach over the obvious alternative.
The mechanics a reviewer would otherwise reverse-engineer from the diff.
-->

## Notable internals

<!--
The subtle, easy-to-miss parts a future maintainer needs. If a reviewer would
ask "wait, why does that work?", answer it here.
-->

<!-- OPTIONAL SECTIONS — uncomment what applies, delete the rest.

## Key design decisions

1. <decision> — <rationale>

## Architecture highlights

- <new tables, bindings, Durable Objects, Workflows, adapters, registry entries>

## Database migrations

Required whenever this PR adds a migration under `packages/db/migrations/`.
Confirm the numeric prefix is unique and strictly greater than every migration
on the base branch — 0039, 0041, and 0046 are each already claimed twice, so
check rather than assume — and flag any merge-time renumber hazard under
Reviewer notes.

- `NNNN_name.sql` — <what it does; safe to re-run? does it differ by region?>

## Regional impact

Required in spirit for identity, the Global registry, cross-region bridges,
provider ingress routing, or data residency. See docs/regionalization.md.

- <what changes in Global, in the EU, or in the routing between them>

## Security and trust model

Required in spirit whenever the change touches renderer isolation, connector
credential scope, session or ticket handling, webhook signature verification,
untrusted model or provider payloads, or secrets placement. See docs/security.md.

- <the trust surface this opens or closes>

## Provider configuration

- <the Slack, GitHub, Linear, Notion, Google, Resend, or Cloudflare setting that
  must be applied outside the repo, in which region, and what breaks without it>

## Related or new documentation

A PR that creates or substantially changes an architecture or large module also
carries that module's document in docs/ and a new entry in its Changelog saying
why the change was made. See docs/module-documents.md.

- <the docs/ files added or updated in this change, naming any module document
  whose Changelog gained an entry>

## Reviewer notes

- <merge hazards, deferred work, known-failing checks>

## Validation

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, and both
  Wrangler dry-run builds: <outcome>
- <for visible changes: the screens captured from a running window>
- <pre-existing failures, called out as pre-existing>

-->
