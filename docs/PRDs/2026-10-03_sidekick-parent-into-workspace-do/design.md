# Sidekick parents move into WorkspaceDO: design inventory

> Companion to [`prd.md`](prd.md). This file lists what moves: every hop
> between the two objects, every caller of `SidekickDO`, every subsystem that
> knows the class, and the import's edge cases. Line references are to
> `apps/api/src/` as of 2026-10-03 and will drift; the names will not.

## Hops between the two objects today

| Direction | Hop | Kind | After the move |
| --- | --- | --- | --- |
| `SidekickDO` → `WorkspaceDO` | `directory_automation` effect via `durable_outbox` → `ACTIVITY_QUEUE` → `applyAutomationDirectory` | Queue, two legs | Deleted. The rail reads `sidekicks`. |
| `SidekickDO` → `WorkspaceDO` | `applyExternalEventRegistrations` from `apply`'s tail (`sidekick-do.ts` ~2040) | RPC | Same transaction as apply. |
| `SidekickDO` → `WorkspaceDO` | `authorizeViewer`, `readManagementAccess`, `workstreamParticipant` from `SidekickDO.authorizeViewer` (~1468 to 1507) | RPC | Local reads. |
| `WorkspaceDO` → `SidekickDO` | `setOwningRoomArchived` on room archive (`workspace-do.ts` ~11461) | RPC, best effort per Sidekick | Same transaction as the archive. |
| `WorkspaceDO` → `SidekickDO` | `workspace_external_event_delivery_v1` → `ACTIVITY_QUEUE` → `semantic-trigger-admission.ts` → `externalEventAdmissionPlan` / `admitExternalEvent` | Queue, then two RPCs | The Queue stays (the classifier runs in the Worker); both RPCs address `WorkspaceDO`. |
| `WorkspaceDO` → `SidekickDO` | `workstream_automations` → `automation` revocation hop → `listChildren` | Queue | The workspace and Channel hops list Sidekick children locally; the `automation` hop kind is deleted. |
| Worker | `actorRequest`: `WorkspaceDO.automationOwner` + `readManagementAccess`, then the `SidekickDO` method | Two sequential RPCs | One `WorkspaceDO` call. |
| Worker | Open: `resolveHostedParent` miss → `SidekickDO.authority` → `SidekickDO.authorizeViewer` | Three sequential RPCs (plus the three inside `authorizeViewer`) | One `resolveHostedParent` call, as for a Channel. |
| `SubstreamAgent` → parent | `conversation_effect` → `ACTIVITY_QUEUE` → `receiveChildEffects` | Queue | Stays. Addresses `WorkspaceDO`. |
| `SubstreamAgent` → parent | `continueRun` (`sidekick-run-continuation.ts`), `authority` | RPC | Addresses `WorkspaceDO`. |

## `SidekickDO` methods and where they land

Every method moves to the `WorkspaceDO` facade with a `sidekickId` argument
and dispatches to the hosted parent. Callers change only the stub they ask.

| Method | Callers |
| --- | --- |
| `create`, `saveDefinition`, `submitDefinition`, `apply`, `readDetail`, `setAppearance`, `pause`, `resume`, `remove`, `runNow`, `listRuns`, `claimExecutionPrincipal`, `runSeeded` | `services/automation-service.ts`; `services/integrations.ts` (drafting); `routes/dev.ts`; `services/demo-seeder.ts` |
| `setOwningRoomArchived` | `WorkspaceDO` only. Becomes a private write. |
| `externalEventAdmissionPlan`, `admitExternalEvent` | `services/semantic-trigger-admission.ts` |
| `admitInboundEmail` | `services/resend-inbound-email-service.ts` |
| `readSkillSource`, `readSkillSummary` | `services/sidekick-skills.ts`, `services/workstream-service.ts` |
| `readRunDefinition`, `readRunState` | `services/integrations.ts`, `services/slack-agent-service.ts` |
| `continueRun` | `services/sidekick-run-continuation.ts` |
| `authorizeViewer`, `authority`, `reserveAgentChild`, `listChildren`, `receiveChildEffects` | The parent contract. Already on the facade for Channels and Spaces. |
| `readAuthorizationFacts`, `authorizationDiscoveryChildren` | `services/authorization-service.ts`, `authorization-projection-service.ts`, `workstream-service.ts`, `space-service.ts`. Discovery for a hosted Sidekick runs in the object, as it already does for a hosted Channel, instead of a Queue message whose consumer calls back in. |
| `childrenForRetirement`, `retireObject` | Retirement. The Sidekick node kind goes; its children are enumerated from `parent_children`. |
| `runInspectionSql`, `forceMigration` | Engineering MCP and migration tracker. Removed with the class. |
| `reconcileLoadable`, `reserveChild` | No external caller. |

## Subsystems that name the class

| Subsystem | Change | Document to update in the same change |
| --- | --- | --- |
| Hosted parents | Third role, new tables, storage budget line | [`hosted-conversation-parents.md`](../../hosted-conversation-parents.md) |
| Sidekick lifecycle | Where state lives, apply's single transaction, the deleted directory projection | [`automation-lifecycle.md`](../../automation-lifecycle.md) |
| Object hierarchy | `WorkspaceDO → {hosted Channel, Space and Sidekick parents} → SubstreamAgent` | [`workstream-durable-object.md`](../../workstream-durable-object.md) |
| Alarms | Sidekick kinds become `WorkspaceDO` stored entries | [`durable-object-alarms.md`](../../durable-object-alarms.md) |
| Revocation | `automation` hop kind removed | [`access-revocation.md`](../../access-revocation.md) |
| Retirement | Sidekick node kind and gate removed; `applyAutomationDirectory` receiver removed | [`workspace-retirement.md`](../../workspace-retirement.md) |
| Migration tracking | `SidekickDO` and `AutomationDO` labels removed from `REPORTING_CLASSES`, the dispatcher and `MIGRATION_COMMAND_HEADS`, after step 3 | [`durable-object-migration-tracking.md`](../../durable-object-migration-tracking.md) |
| Engineering MCP | `run_sidekick_sql` removed; `list_sidekicks` reads `sidekicks` | [`engineering-mcp.md`](../../engineering-mcp.md) |
| Queue/RPC rules | Sidekick parents no longer "keep the Queue" for authorization discovery | [`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md) |

## Import edge cases

- **An object at an older schema.** The reduced `SidekickDO` keeps its
  migration ledger, so an object that has not woken since an earlier release
  migrates to version 13 before it exports. The export reads one schema.
- **A directory row with no object.** A Sidekick whose directory row exists
  but whose object never materialized exports nothing. The import records it
  `done` with no `sidekicks` row, and the directory row is dropped with the
  table. Retirement already treats this case as a tombstone-only object.
- **A run mid-loop.** The child keeps running. Its next `continueRun`,
  `readRunState` or effect reaches `WorkspaceDO`, which imports the Sidekick
  first. A call routed by an older Worker reaches the frozen object and gets
  `sidekick_parent_moved`; a Queue consumer retries, and an RPC caller fails
  that one call and retries on its own path.
- **A schedule due during the freeze.** The legacy alarm is cleared on the
  first export page. The last import transaction re-arms the entry at its
  exported due instant; a past instant fires on the next alarm. The occurrence
  key's uniqueness keeps it from running twice.
- **An outbox row in flight.** `durable_outbox` rows are imported into
  `parent_outbox` with their message ids, so a send that had already left
  before the freeze is deduplicated downstream by the same key it carried.
- **A retired Organization.** Its tombstone refuses the import; its `pending`
  rows are ignored by the gate, as six were for the Channel move.
