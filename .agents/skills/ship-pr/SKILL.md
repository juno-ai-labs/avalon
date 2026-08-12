---
name: ship-pr
description: Use this skill whenever the user wants to open a pull request for a change in this repo, or says things like "ship this", "create a PR", "put this up for review", "merge this once it's green", or "follow the usual process" for landing code.
user-invocable: true
---

# Shipping a pull request in avalon

## 1. Before you start

Read [`docs/pull-requests.md`](../../docs/pull-requests.md) if you haven't already
this session — it's the actual spec this skill implements, and it can change
independently of this file. Also skim [`docs/README.md`](../../docs/README.md) to
find which other docs the change you're shipping should update in the same PR.

## 2. Write the PR

Never rely on the GitHub "create PR" button's autofill — write the description
yourself against [`docs/pull-requests.md`](../../docs/pull-requests.md)'s spec.

**Never open it as a draft** (`docs/pull-requests.md`, "Never open a draft pull
request") — no `--draft` flag, no `draft: true` through the API. An open PR in
this repo means "this wants a review", and a draft silently opts out of the
review queue this skill exists to move the change through.

## 3. Check for human and bot reviewer comments

Monitor the PR for human and bot review comments (timers every 5 minutes or so but stop after 30 minutes). First verify if the finding is valid. If it is, fix it. If it's not, write a substantive correction citing the exact code, not just an assertion that they're wrong.

## 4. Merging

If you have a new migration, before merging check if a new migration has been merged into main since the PR was opened. If so, rebase the PR and re-number your migrations to be the next number after the latest migration in main.

## 5. Validate publishing — don't stop at "the merge succeeded"

A merge landing and a deploy succeeding are different facts, and this repo
auto-deploys to production on every merge to `main` that touches `apps/api` or
`packages` (`docs/RUNBOOK.md`: "a merge to `main` is a production release").
Confirm the deploy, not just the merge:
