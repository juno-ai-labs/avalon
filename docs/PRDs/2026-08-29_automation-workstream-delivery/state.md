- [x] planned
- [ ] in progress
- [ ] completed

Superseded on 2026-11-07 by
[`2026-11-06_canvases-and-sidekicks`](../2026-11-06_canvases-and-sidekicks/prd.md),
which removes work streams (Threads). Design only — never built. No Thread owns
a Sidekick: each Sidekick has one shared conversation, and its runs post into
it with `conversation_post` rather than delivering into an owning room. See
[`automation-lifecycle.md`](../../automation-lifecycle.md). Do not build
against this PRD.
