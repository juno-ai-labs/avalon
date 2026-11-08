- [x] planned
- [x] in progress
- [x] completed

Superseded by [`2026-11-06_canvases-and-sidekicks`](../2026-11-06_canvases-and-sidekicks/prd.md)
on 2026-11-08: the hierarchy it shipped (Organization, Space, Channel,
Breakout) was renamed by
[`2026-10-10_channels-threads-navigation`](../2026-10-10_channels-threads-navigation/prd.md),
which made the Space a Channel and the Channel a Thread, and then deleted
whole. The `spaces`, `channels` and `parent_*` tables that survive are
recorded in
[`architecture.md`](../../architecture.md#2026-11-08--retirement-records-spaces-space-access-sources-projects-the-implementation-plan)
and go once `retire_threads`
([`workspace-retirement.md`](../../workspace-retirement.md#retiring-threads-breakouts-and-channels))
has run in every Organization. Do not build against this PRD.
