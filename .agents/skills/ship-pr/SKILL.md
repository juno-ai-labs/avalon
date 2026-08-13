---
name: ship-pr
description: Use this skill whenever the user wants to open a pull request for a change in this repo, or says things like "ship this", "create a PR", "put this up for review", etc.
user-invocable: true
---

# Shipping a pull request in avalon

## 1. Before you start

Read `docs/pull-requests.md` if you haven't already this session — it's the actual spec this skill implements, and it can change independently of this file. Also skim `docs/README.md` to find which other docs the change you're shipping should update in the same PR.

Trust CI to run the tests, linting, and type checks. It will run faster there than you can run locally. Don't waste time running them locally before opening a PR unless you have a specific reason to do so.

## 2. Write the PR

Write the description yourself against `docs/pull-requests.md`'s spec.

**Never open it as a draft** as that would not follow `docs/pull-requests.md`.

## 3. Check for human and bot reviewer comments

Monitor the PR for human and bot review comments (timers every 5 minutes or so but stop after 30 minutes). First verify if the finding is valid. If it is, fix it. If it's not, write a substantive correction citing the exact code, not just an assertion that they're wrong.

## 4. Merging

If you have a new migration, before merging check if a new migration has been merged into main since the PR was opened. If so, rebase the PR and re-number your migrations to be the next number after the latest migration in main.

## 5. Validate publishing — don't stop at "the merge succeeded"

A merge landing and a deploy succeeding are different facts, and this repo auto-deploys to production on every merge to `main`, after merge understand expected deployment and then confirm the deploy, not just the merge.
