- [x] planned
- [x] in progress
- [x] completed

Partly stale as of 2026-11-08. The lifecycle it defines still holds as
`draft`, `active`, `paused` and `deleted` (`AutomationLifecycleStateSchema`);
the `activating` state is gone. The per-automation Durable Object it specifies
(`SidekickDO` by the time it went) was deleted by
[`2026-10-03_sidekick-parent-into-workspace-do`](../2026-10-03_sidekick-parent-into-workspace-do/prd.md):
a Sidekick is hosted in `WorkspaceDO`. See
[`automation-lifecycle.md`](../../automation-lifecycle.md).
