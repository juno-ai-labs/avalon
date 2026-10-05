# Sidekick parents move into WorkspaceDO: design inventory

> Companion to [`prd.md`](prd.md). This file lists what moves: every hop
> between the two objects, every table, every caller of `SidekickDO`, every
> reader of `automation_directory`, every subsystem and document that names the
> class, the tests that bind it, and the import's edge cases. Paths are under
> `apps/api/src/` unless they say otherwise.

## Hops between the two objects today

| Direction | Hop | Kind | After the move |
| --- | --- | --- | --- |
| `SidekickDO` → `WorkspaceDO` | `directory_automation` effect via `durable_outbox` → `ACTIVITY_QUEUE` → `applyAutomationDirectory` | Queue, two legs | The rail reads `sidekicks`. Until step 3 the receiver seeds the ledger and keeps the directory row for Sidekicks not yet imported (decision 10). |
| `SidekickDO` → `WorkspaceDO` | `applyExternalEventRegistrations` from `apply`'s tail | RPC | Same transaction as the change (decision 5). Until step 3 it refuses an imported Sidekick. |
| `SidekickDO` → `WorkspaceDO` | `authorizeViewer`, `readManagementAccess`, `workstreamParticipant` from `SidekickDO.authorizeViewer` | RPC | Local reads in `sidekickViewer` and `sidekickGrantViewer`. |
| `SidekickDO` → `WorkspaceDO` | `materializeAutomationMemoryTables` (`services/memory-table-service.ts`) | RPC | Local, inside the transaction; a D1 part rides `sidekick_memory_tables`. |
| `WorkspaceDO` → `SidekickDO` | `setOwningRoomArchived` on a Channel or Breakout archive | RPC, best effort per Sidekick | Same transaction as the archive. |
| `WorkspaceDO` → `SidekickDO` | `workspace_external_event_delivery_v1` → `ACTIVITY_QUEUE` → `semantic-trigger-admission.ts` → `externalEventAdmissionPlan` / `admitExternalEvent` | Queue, then two RPCs | The Queue stays (the classifier runs in the Worker); both RPCs address `WorkspaceDO`. |
| `WorkspaceDO` → `SidekickDO` | `workstream_automations` → `automation` revocation hop → `listChildren` | Queue | The workspace and Channel hops list an imported Sidekick's children locally. The `automation` hop stays for pending Sidekicks until step 3. |
| Worker | `actorRequest`: `WorkspaceDO.automationOwner` + `readManagementAccess`, then the `SidekickDO` method | Two sequential RPCs | One `WorkspaceDO` call. |
| Worker | Open: `resolveHostedParent` miss → `SidekickDO.authority` → `SidekickDO.authorizeViewer` | Three sequential RPCs, plus the three inside `authorizeViewer` | One `resolveHostedParent` call, as for a Channel. |
| `WorkspaceDO` alarm → child | `provisionRun`: bootstrap, provision, append opening, admit harness run, activate | Five or more RPCs, awaited | One `sidekick_run_provision` Queue message (decision 7). |
| `SubstreamAgent` → parent | `conversation_effect` → `ACTIVITY_QUEUE` → `receiveChildEffects` | Queue | Stays. Addresses `WorkspaceDO`. |
| `SubstreamAgent` → parent | `continueRun` (`services/sidekick-run-continuation.ts`), `authority` | RPC | Addresses `WorkspaceDO`. |

## Table mapping

| `SidekickDO` table | `WorkspaceDO` destination | Notes |
| --- | --- | --- |
| `automation` | `sidekicks` | Merged with `automation_directory`. |
| `definition_revisions` | `sidekick_revisions` | |
| `schedules` | `sidekick_schedules` | |
| `runs` | `sidekick_runs` | |
| `inbound_email_receipts` | `sidekick_email_receipts` | |
| `conversation_children` | `parent_children` | |
| `substream_directory` | `parent_child_projections` | |
| `substream_user_directory` | `parent_child_viewer_projections` | |
| `workstream_state_clock`, `workstream_state_changes` | `parent_state_clock`, `parent_state_changes` | |
| `child_effect_receipts` | not imported | Replays converge on per-key waterlines, as in the Channel move. |
| `projection_keys` | not imported | It only keys `directory_automation`, which has no successor. |
| `durable_outbox` | not imported | `forwardsChildEffect` is false, so it holds only `directory_automation` rows, which `parent_outbox` refuses and `sidekicks` supersedes. Any other kind fails the import with a code. |
| `_internal_durable_alarms` | `WorkspaceDO`'s list | `automation_schedule` and `automation_run` entries are rekeyed `<sidekickId>:<key>`. `sidekick_publication` entries are dropped; the import arms `sidekick_memory_tables` for the accepted revision instead. |
| `object_retirement` | not imported | A retired Sidekick has no rows to import; the Organization's own tombstone covers the rest. |

## `SidekickDO` methods and where they land

Every method moves to the `WorkspaceDO` facade with a `sidekickId` argument
and dispatches to the hosted parent. Callers change only the stub they ask.

| Method | Callers |
| --- | --- |
| `create`, `saveDefinition`, `submitDefinition`, `apply`, `readDetail`, `setAppearance`, `pause`, `resume`, `remove`, `runNow`, `listRuns`, `claimExecutionPrincipal`, `runSeeded` | `services/automation-service.ts`; `services/integrations.ts` (drafting); `routes/dev.ts`; `services/demo-seeder.ts` |
| `setOwningRoomArchived` | `WorkspaceDO` only. Becomes a private write. |
| `externalEventAdmissionPlan`, `admitExternalEvent` | `services/semantic-trigger-admission.ts`, from `queues/activity-consumer.ts`, which builds the stub |
| `admitInboundEmail` | `services/resend-inbound-email-service.ts` |
| `readSkillSource`, `readSkillSummary` | `services/sidekick-skills.ts`, `services/workstream-service.ts` |
| `readRunDefinition`, `readRunState` | `services/integrations.ts`, `services/slack-agent-service.ts` |
| `continueRun` | `services/sidekick-run-continuation.ts` |
| `authorizeViewer`, `authority`, `reserveAgentChild`, `listChildren`, `receiveChildEffects` | The parent contract: `services/conversation-parent-client.ts`, `services/conversation-service.ts` (its own `automation` branch), `services/agent-communication-service.ts`, `services/authorization-service.ts`, `queues/activity-consumer.ts`, `queues/access-revocation-consumer.ts`, `durable-objects/substream-agent.ts` |
| `readAuthorizationFacts`, `authorizationDiscoveryChildren` | `services/authorization-service.ts`, `services/authorization-projection-service.ts`, `services/workstream-service.ts`, `services/space-service.ts`. Discovery for an imported Sidekick runs in the object, as it does for a Channel. |
| `childrenForRetirement`, `retireObject` | `services/workspace-retirement-service.ts`. The node kind stays for pending Sidekicks until step 3. |
| `runInspectionSql` | `engineering-inspection-bridge.ts`. Removed in step 3. |
| `forceMigration` | `queues/migration-command-consumer.ts`. Removed in step 3. |
| `reconcileLoadable`, `reserveChild` | No external caller. |

Also naming the class or binding: the ESLint rule
`scripts/eslint-rules/durable-object-region-routing.mjs`,
`apps/api/wrangler.global.jsonc`, `apps/api/wrangler.test.jsonc`, `env.ts`,
`durable-objects/automation-do.ts` (the `AutomationDO` alias) and the
`test-workers/` helpers.

## Readers of `automation_directory`

Each reads `sidekicks` plus pending directory rows during steps 1 and 2, then
`sidekicks` alone:

- `durable-objects/channel-rails.ts`, including the rail triggers
- `durable-objects/search-authorization-projection.ts`,
  `durable-objects/search-authorization-universe.ts`
- `durable-objects/workspace-digests-protocol.ts`
- `durable-objects/workspace-sidekick-conversation-storage.ts`
- `durable-objects/workspace-space-storage.ts`
- `durable-objects/workspace-do.ts`: the library, `automationOwner`,
  `automationIdsOwnedByWorkstream`, the external-event audience filter, the
  retirement graph and the authorization backfill
- `services/workspace-runtime-database.ts`
- `engineering-inspection-bridge.ts`

## Subsystems that name the class

| Subsystem | Change | Document to update |
| --- | --- | --- |
| Hosted parents | Third role, new tables, storage budget line | [`hosted-conversation-parents.md`](../../hosted-conversation-parents.md) |
| Sidekick lifecycle | Where state lives, one-transaction changes, the four access functions, provisioning handoff, the deleted directory projection | [`automation-lifecycle.md`](../../automation-lifecycle.md) |
| Object hierarchy | `WorkspaceDO → {hosted Channel, Space and Sidekick parents} → SubstreamAgent` | [`workstream-durable-object.md`](../../workstream-durable-object.md), [`architecture.md`](../../architecture.md) |
| Tables | New tables, dropped directory | [`data-model.md`](../../data-model.md) |
| Access | The four functions; the library fix | [`authorization.md`](../../authorization.md) |
| Alarms | Sidekick kinds become `WorkspaceDO` entries scoped by key prefix | [`durable-object-alarms.md`](../../durable-object-alarms.md) |
| Revocation | `automation` hop kind removed in step 3 | [`access-revocation.md`](../../access-revocation.md) |
| Retirement | Sidekick node kind and gate removed in step 3 | [`workspace-retirement.md`](../../workspace-retirement.md) |
| Migration tracking | `SidekickDO` and `AutomationDO` labels removed from `REPORTING_CLASSES`, the dispatcher and `MIGRATION_COMMAND_HEADS` in step 3 | [`durable-object-migration-tracking.md`](../../durable-object-migration-tracking.md) |
| Engineering MCP | `retry_sidekick_import` added in step 1; it and `run_sidekick_sql` removed in step 3 | [`engineering-mcp.md`](../../engineering-mcp.md), [`internal-admin-mcp-server.md`](../../internal-admin-mcp-server.md) |
| Operations | The gate query and the retry procedure | [`runbook.md`](../../runbook.md) |
| Queue/RPC rules | Sidekick parents no longer "keep the Queue" for authorization discovery | [`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md) |
| Email, bindings, triggers | Their Sidekick addressing moves to `WorkspaceDO` | [`workstream-email-addresses.md`](../../workstream-email-addresses.md), [`external-conversation-bindings.md`](../../external-conversation-bindings.md), [`semantic-activity-triggers.md`](../../semantic-activity-triggers.md) |
| Index | Rows whose one-line scope names `SidekickDO` | [`docs/README.md`](../../README.md) |

## Tests that bind the class

About 20 files under `apps/api/test-workers/` bind `SidekickDO` or
`AUTOMATION_DOS`. In step 1 each moves to `WorkspaceDO`, except the import
tests, which bind the reduced `SidekickDO` to build frozen objects and are
removed with it in step 3.

## Import edge cases

The common path is decision 9. These are the cases it does not spell out.

- **An object at an older schema.** The reduced `SidekickDO` keeps its
  migration ledger, so an object that has not woken since an earlier release
  migrates to head (including the migration that persists the freeze) before
  it exports.
- **A directory row with no object.** A Sidekick whose directory row exists but
  whose object never materialized exports nothing. The import records it done
  with no `sidekicks` row. Retirement already treats this case as a
  tombstone-only object.
- **An object with no directory row.** Seeded by its directory message or by
  the first request naming it, and held back from step 3 by the tracker check
  (decision 10).
- **A run mid-loop.** The child keeps running. Its next `continueRun`,
  `readRunState` or effect reaches `WorkspaceDO`, which imports the Sidekick
  first.
- **A retired Organization.** Its tombstone refuses the import; its `pending`
  rows are ignored by the gate, as six were for the Channel move.
