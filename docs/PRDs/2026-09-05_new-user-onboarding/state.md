- [x] planned
- [x] in progress
- [x] completed

Implementation and local verification are complete. External OAuth still needs credentialed release verification; onboarding no longer starts an agent run; see
[verification.md](verification.md).

Partly stale as of 2026-11-08. The creator and member journeys still hold:
creating a workspace, connecting tools and inviting people for a creator,
skipping those for a member, the persisted avatar and color, and resumable
progress (goals 2, 3, 4 and 6). The first-use example in a durable work
stream (goals 1 and 5) no longer runs: the journey's stages are `connectors`,
`people`, `profile` and `complete` (`packages/contracts/src/onboarding.ts`),
and finishing lands on the Canvases home, whose empty state offers "Start from
a prompt", under
[`2026-11-06_canvases-and-sidekicks`](../2026-11-06_canvases-and-sidekicks/prd.md).
See [`new-user-onboarding.md`](../../new-user-onboarding.md).
