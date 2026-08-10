---
name: ship-pr
description: Use this skill whenever the user wants to open a pull request for a change in this repo, or says things like "ship this", "create a PR", "put this up for review", "merge this once it's green", or "follow the usual process" for landing code. Also use it proactively once a code change is complete and the user's intent was clearly to get it merged, even if they don't say the word "PR". Covers the whole lifecycle: writing the PR description by hand against this repo's spec, running a from-scratch multi-persona review swarm (this repo has no local review-swarm skill to reuse), fixing what the swarm and any human/bot reviewers find, waiting for CI, merging as a merge commit, and confirming the production deploy that follows actually succeeded. Do not use this for opening a PR the user explicitly wants to write and manage themselves, or for read-only PR review of someone else's change (use /review for that).
user-invocable: true
---

# Shipping a pull request in avalon

This is the standard path from "the code is ready" to "it's live in production and
confirmed healthy." It exists because a PR that only gets a rubber-stamp review and
an untracked merge is how a fix ships half-finished — a real incident on this repo
started exactly that way: the first pass at a fix only patched one of four places
the same bug reached, and it took a genuine review swarm plus a human reviewer to
catch the other three before merge. Move through every step; don't skip the review
swarm because the change looks small, and don't skip the post-merge validation
because the merge itself succeeded — a green merge and a healthy deploy are
different facts.

## 0. Before you start

Read [`docs/pull-requests.md`](../../docs/pull-requests.md) if you haven't already
this session — it's the actual spec this skill implements, and it can change
independently of this file. Also skim [`docs/README.md`](../../docs/README.md) to
find which other docs the change you're shipping should update in the same PR.

The default Node on this machine is older than this repo requires. Prefix every
`pnpm`/`node` command with:

```bash
PATH="/opt/homebrew/opt/node/bin:$PATH"
```

## 1. Branch and implement

Branch off current `origin/main` (`git fetch origin main && git checkout -b
<name> origin/main`), implement the change, and if the change touches a
subsystem a doc in `docs/` owns, update that doc in the same branch — a
Documentation Reviewer persona checks this later, but it's cheaper to just do it
now than to add a second commit for it.

## 2. Run the local gates before opening anything

A PR that fails CI wastes the review swarm's time re-reviewing a fix instead of
the original change, so clear these first:

```bash
PATH="/opt/homebrew/opt/node/bin:$PATH" pnpm lint
PATH="/opt/homebrew/opt/node/bin:$PATH" pnpm typecheck
PATH="/opt/homebrew/opt/node/bin:$PATH" pnpm test
PATH="/opt/homebrew/opt/node/bin:$PATH" pnpm dotenv -e .env.local -- pnpm --filter @avalon/api build
PATH="/opt/homebrew/opt/node/bin:$PATH" pnpm dotenv -e .env.local -- pnpm --filter @avalon/api build:eu
```

`apps/desktop`'s `vitest run` can show pre-existing failures tied to this
machine's environment rather than your change (e.g. a jsdom/localStorage gap
under a newer Node than the repo pins). Don't assume that — prove it: `git
stash`, `git checkout main`, rerun the same suite, and confirm the identical
failures reproduce on unmodified `main`. Only then is it safe to note them as
pre-existing in the PR's Validation section instead of investigating further.

## 3. Write the PR description by hand and open it

Never rely on the GitHub "create PR" button's autofill — write the description
yourself against [`docs/pull-requests.md`](../../docs/pull-requests.md)'s spec:
`##` sections in this order — **Summary, Motivation, Key changes, Implementation
details, Notable internals** are required; add **Key design decisions,
Architecture highlights, Database migrations, Regional impact, Security and
trust model, Provider configuration, Related or new documentation, Reviewer
notes, Validation** only when they apply, and never as an empty heading. Write
it to a file, then:

```bash
gh pr create --title "..." --body-file <path> --base main --head <branch>
```

## 4. Run a review swarm before waiting on CI

Don't wait for CI first and review second — the swarm often finds things worth
fixing before CI even finishes, and fixing them now means one clean review
cycle instead of two.

This repo has no local review-swarm skill to invoke (the sibling `monad` repo
has one at `.agents/skills/review-swarm/SKILL.md`, but its personas are written
against Next.js/Postgres/authz specifics that don't exist here — don't reuse
them verbatim). Author the personas fresh, grounded in avalon's actual docs.
Launch them all as `Agent` calls in **one message** so they run concurrently
(`subagent_type: general-purpose`, `model: opus`, `run_in_background: false`
since you need the findings before deciding what to fix). Give each persona the
PR number, the diff (`git diff origin/main...<branch>`), and tell it explicitly
which dimension is *not* its job — overlapping findings from five agents
reviewing the same five things wastes the pass.

A good default panel, adapted to what the diff actually touches — drop personas
that genuinely don't apply, but don't drop one just because the diff looks
simple, since "looks simple" is exactly how the four-site bug above stayed
half-fixed at first glance:

- **Backend Engineer** — Workers/Hono/D1/Zod boundary correctness on the
  touched service/route files. General staff-engineer judgment (edge cases,
  sloppy implementation, over-engineering), not a checklist.
- **Security Specialist** — reads [`docs/SECURITY.md`](../../docs/SECURITY.md)
  first, then the diff for trust-boundary and DoS-shaped issues (can one bad
  row or one untrusted field take down a whole resource for every user, the
  way the original incident did?).
- **QA Architect** — static review only, don't run the suite. Coverage gaps
  weighted by blast radius, test rigor (tautological assertions, over-mocking),
  and whether the new tests match this repo's convention (real in-memory
  `node:sqlite` migrated from `packages/db/migrations/`, not mocks — see any
  `apps/api/test/workstream-*.test.ts` file for the pattern).
- **System Architect** — reads [`docs/README.md`](../../docs/README.md), then
  whichever of `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`,
  `docs/REGIONALIZATION.md`, `docs/RUNBOOK.md` the change actually touches.
  Judges multi-node/stateless correctness, graceful degradation, and whether
  the fix addresses the real boundary or just the one symptom that got
  reported — explicitly not code quality, style, or tests.
- **Documentation Reviewer** — reads `CLAUDE.md` and `docs/README.md` first,
  checks whether every doc whose "update when..." trigger fired was actually
  updated, and separately holds the PR description itself to
  `docs/pull-requests.md`'s spec.

Each persona classifies every finding P0 (must fix) / P1 (should fix) / P2
(backlog) / nitpick.

**Safety note:** these are general-purpose agents with full write access to
your actual working directory — there's no worktree isolation, because they're
meant to be read-only reviewers, but nothing stops a subagent from deciding to
"helpfully" edit something anyway. It has happened: a review pass once produced
an unrelated doc file and an edit to `docs/README.md` that had nothing to do
with the change being reviewed. After every swarm run, before staging anything,
run `git status --porcelain` and account for every file listed. Revert or
delete anything you didn't ask for.

## 5. Fix what the swarm found

Address every P0 and P1 with a real code change, not a written acknowledgment
in the PR description. Re-run the full gate list from step 2. Commit as a new
commit — never amend or force-push over a commit a reviewer may have already
looked at — with a message that says what the swarm found and how you fixed
it. Push, then update the PR description with `gh pr edit <n> --body-file` so
it reflects the fuller fix, not just the first pass.

P2s and genuine follow-up work (a broader refactor, an audit of sites outside
this change's blast radius) don't belong in this PR. Flag them as separate
follow-up tasks instead of folding them in — a fix PR that keeps growing is
harder to review than the bug it's fixing.

## 6. Check for human and bot reviewer comments

These can land at any point, including after the swarm and after CI goes
green, so check again right before merging even if there was nothing earlier:

```bash
gh pr view <n> --json reviews -q '.reviews[]'
```

For each finding: if the swarm already fixed it, confirm that and say so. If
it's new, fix it — or, if the reviewer's claim doesn't actually hold, write a
substantive correction citing the exact code, not just an assertion that
they're wrong. Reply with `gh pr comment <n> --body-file` addressing every
point before merging, not a generic "thanks, addressed."

## 7. Wait for the merge gate, then merge

Merge only once **both** of these are true:

- At least ~20 minutes have passed since the PR was last substantively
  updated — this is deliberate slack for a human reviewer to weigh in, not
  just a CI timer.
- The required checks are green: `gh pr checks <n>` should show `verify` and
  `secrets` both passing.

If you start a background wait for the 20-minute gate, don't just let it run
unsupervised — a human can merge the PR manually while your wait is still in
progress. Poll `gh pr view <n> --json state,mergedAt` periodically; if `state`
is already `MERGED`, stop trying to merge it yourself and move straight to
step 8 with the actual merge commit.

This repo merges as **merge commits only** — never squash, never rebase-merge
(`docs/pull-requests.md`, "Branch style and merge style"):

```bash
gh pr merge <n> --merge
```

Note that the rule for the *branch* is the opposite one: while the pull request
is open, bring it up to date by rebasing onto `main` and force-pushing with
`--force-with-lease`, not by merging `main` into it. Rebase only between review
rounds — a force-push marks inline review threads outdated — and if the branch
somehow already carries a merge commit, check what the rebase dropped before
pushing, because a rebase discards merge commits and anything unique to them
without reporting a conflict.

## 8. Validate publishing — don't stop at "the merge succeeded"

A merge landing and a deploy succeeding are different facts, and this repo
auto-deploys to production on every merge to `main` that touches `apps/api` or
`packages` (`docs/RUNBOOK.md`: "a merge to `main` is a production release").
Confirm the deploy, not just the merge:

```bash
gh run list --repo juno-ai-labs/avalon --workflow deploy-api.yml --branch main \
  --json databaseId,headSha,status,conclusion
```

Find the run whose `headSha` matches the merge commit, poll until `status ==
completed`, and confirm `conclusion == success`. Then run the regional health
check and confirm both regions report healthy before telling the user the task
is done:

```bash
PATH="/opt/homebrew/opt/node/bin:$PATH" node scripts/check-regional-health.mjs
```

## Two things that hold regardless of how far along this process you are

**This process authorizes shipping the change you're already working on — it
does not blanket-authorize new production mutations you discover along the
way.** If a review swarm or a live investigation turns up something that needs
a direct production fix (a database patch, a manual remediation), that's a new
action outside this PR's scope and still needs the user's explicit go-ahead,
even though "follow the usual process" was already said once for the PR
itself.

**Fix the root cause, not the first symptom that goes away.** The incident that
motivated this skill was originally "fixed" by truncating one field at one
read site — which made the reported error disappear without closing the other
three places in the codebase the same bad data could reach, one of which would
have turned a transient read failure into a permanently corrupted row. Before
calling a fix complete, ask what else shares the same root cause, not just
whether the one reported symptom is gone.
