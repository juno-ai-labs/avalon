# Convex data plane — design

> Companion to [`prd.md`](prd.md). It carries what the PRD deliberately does
> not: the full document model in the shape `convex/schema.ts` takes, the
> function-layer transaction protocols, the streaming/steering/watchdog
> protocol, the run driver on the Workflow component, and the import and
> cutover mechanics. Product semantics are the PRD's; where this document and
> the PRD disagree about behavior, the PRD wins.

## Conventions

- **One deployment per region.** Every table below exists once per deployment.
  There is no cross-deployment reference, join, or transaction.
- **Documents, not rows.** Convex assigns `_id` and `_creationTime`. Fields
  named `...Id` are `v.id("table")` references; identifiers that must survive
  export and appear in APIs (`workstreamId` on an audit row, an operation key)
  are also carried as opaque strings where the reference alone is insufficient.
- **Validators are the schema.** Every table is declared with `defineTable`
  and an argument validator on every exported function. Unknown fields are
  rejected, not ignored.
- **Every product document carries `workspaceId`** and is indexed by it first,
  so a visibility helper can always establish tenancy in one indexed read.
- **Epochs and revisions are `v.int64()` counters** written inside the mutation
  that changes their subject: `revision` (common compare-and-set),
  `controlRevision` (steering), `streamEpoch` (attempt retraction),
  `authorizationEpoch` (access change), `scopeRevision` (context invalidation).
  A reader that must not act on stale access carries the epoch it read.
- **Hashes** are lowercase hex strings of a named algorithm, and every unique
  key includes its semantic scope.
- **Sealed documents are immutable** to application code after `sealedAt`.
  Corrections append a replacement or tombstone relation; nothing is patched in
  place.
- **Indexes are declared, never implicit.** Every predicate a query filters on
  — including every membership and audience predicate — has a supporting index.
  Convex reads are bounded by index range scans and document counts, so a query
  that cannot be expressed as a bounded indexed range is a design error, not a
  slow query.
- **Naming.** Tables are lowerCamelCase plural (`workstreamUserState`),
  functions are `module:functionName`, and public functions live in a small
  number of modules named for the surface they serve.

## Data model

### Identity, workspace, and authorization

```ts
platformIdentities: defineTable({
  subject: v.string(),            // JWT `sub` from Avalon's identity plane
  issuer: v.string(),
  platformUserId: v.string(),     // stable Avalon person ID
  sessionEpoch: v.int64(),        // bumped on global revocation
  state: v.union(v.literal("active"), v.literal("suspended"), v.literal("deleted")),
  updatedAt: v.number(),
}).index("by_issuer_subject", ["issuer", "subject"])
  .index("by_platform_user", ["platformUserId"]),

workspaces: defineTable({
  regionKey: v.string(),          // must equal this deployment's region
  routeEpoch: v.int64(),
  name: v.string(),
  state: v.union(v.literal("active"), v.literal("suspended"),
                 v.literal("deleting"), v.literal("deleted")),
  timezone: v.string(),
  authorizationEpoch: v.int64(),
  retentionPolicyId: v.optional(v.id("retentionPolicies")),
  activityCursor: v.int64(),      // allocator for activityEvents.eventSeq
  deletingAt: v.optional(v.number()),
}).index("by_state", ["state"]),

workspaceMembers: defineTable({
  workspaceId: v.id("workspaces"),
  platformUserId: v.string(),
  role: v.union(v.literal("owner"), v.literal("admin"),
                v.literal("member"), v.literal("guest")),
  state: v.union(v.literal("active"), v.literal("invited"),
                 v.literal("suspended"), v.literal("removed")),
  membershipEpoch: v.int64(),
  joinedAt: v.number(),
  removedAt: v.optional(v.number()),
}).index("by_workspace_user", ["workspaceId", "platformUserId"])
  .index("by_user_state", ["platformUserId", "state"]),

resourceGrants: defineTable({
  workspaceId: v.id("workspaces"),
  subjectKind: v.union(v.literal("user"), v.literal("group"), v.literal("role")),
  subjectId: v.string(),
  resourceKind: v.union(v.literal("workstream"), v.literal("substream"),
                        v.literal("connectorResource"), v.literal("contentRef")),
  resourceId: v.string(),
  capability: v.union(v.literal("view"), v.literal("contribute"),
                      v.literal("administer"), v.literal("execute")),
  grantEpoch: v.int64(),
  state: v.union(v.literal("live"), v.literal("revoked")),
  revokedAt: v.optional(v.number()),
}).index("by_resource", ["workspaceId", "resourceKind", "resourceId", "state"])
  .index("by_subject", ["workspaceId", "subjectKind", "subjectId", "state"]),

audiences: defineTable({
  workspaceId: v.id("workspaces"),
  kind: v.union(v.literal("workstream"), v.literal("explicit"),
                v.literal("personal"), v.literal("agent")),
  revision: v.int64(),
  state: v.union(v.literal("live"), v.literal("retired")),
}).index("by_workspace", ["workspaceId", "state"]),

audienceMembers: defineTable({
  audienceId: v.id("audiences"),
  workspaceId: v.id("workspaces"),
  subjectKind: v.string(),
  subjectId: v.string(),
  membershipEpoch: v.int64(),
  revokedAt: v.optional(v.number()),
}).index("by_audience_subject", ["audienceId", "subjectKind", "subjectId"])
  .index("by_subject", ["workspaceId", "subjectKind", "subjectId"]),

retentionPolicies: defineTable({
  workspaceId: v.id("workspaces"),
  version: v.int64(),
  state: v.union(v.literal("active"), v.literal("superseded")),
  conversationDays: v.number(), activityDays: v.number(),
  rawIngressDays: v.number(), auditDays: v.number(),
  exportDays: v.number(), terminalArtifactDays: v.number(),
  legalHoldMode: v.union(v.literal("none"), v.literal("hold")),
}).index("by_workspace_version", ["workspaceId", "version"]),
```

The `platformIdentities` document is the bridge every function crosses: the
custom-JWT provider gives `ctx.auth.getUserIdentity()` an issuer and subject,
and the visibility helper resolves it to `platformUserId` and asserts
`sessionEpoch` before any authorization read. Removing a member writes
`workspaceMembers.state = "removed"`, bumps `membershipEpoch` and the
workspace's `authorizationEpoch`, and — because that document is in every
subscribed query's read set — that single commit is what re-executes the removed
person's subscriptions.

### Work stream head document and sidebar

```ts
workstreams: defineTable({
  workspaceId: v.id("workspaces"),
  title: v.string(),
  description: v.optional(v.string()),
  originKind: v.union(v.literal("human"), v.literal("suggestion"),
                      v.literal("automation"), v.literal("import")),
  originId: v.optional(v.string()),
  visibility: v.union(v.literal("workspace"), v.literal("restricted")),
  audienceId: v.id("audiences"),

  // exact state and its derived family (both stored; family is indexed)
  state: v.string(),                 // scheduled | preparing_context | running | ...
  stateReason: v.optional(v.string()),
  lifecycleFamily: v.union(v.literal("in_progress"), v.literal("completed"),
                           v.literal("error"), v.literal("hidden")),

  // allocators and fences — the reason this document is the serialization anchor
  nextSeq: v.int64(),
  latestSeq: v.int64(),
  attentionOrdinal: v.int64(),
  revision: v.int64(),
  controlRevision: v.int64(),
  streamEpoch: v.int64(),
  contextScopeRevision: v.int64(),
  authorizationEpoch: v.int64(),

  // denormalized card fields (no separate cards table)
  previewText: v.optional(v.string()),
  previewContentRefId: v.optional(v.id("contentRefs")),
  activeAgentSummary: v.optional(v.object({ label: v.string(), stepNo: v.number() })),
  needsInput: v.boolean(),
  lastActivityAt: v.number(),
  completedAt: v.optional(v.number()),
  errorAt: v.optional(v.number()),

  activeRunId: v.optional(v.id("runs")),
  rootSubstreamId: v.optional(v.id("substreams")),
  createdBy: v.string(),
})
  .index("by_workspace_family_activity", ["workspaceId", "lifecycleFamily", "lastActivityAt"])
  .index("by_workspace_activity", ["workspaceId", "lastActivityAt"])
  .index("by_workspace_completed", ["workspaceId", "completedAt"])
  .index("by_active_run", ["activeRunId"]),

workstreamUserState: defineTable({
  workspaceId: v.id("workspaces"),
  workstreamId: v.id("workstreams"),
  platformUserId: v.string(),
  seenAttentionOrdinal: v.int64(),
  latestUnreadOrdinal: v.int64(),
  latestMentionOrdinal: v.int64(),
  mentionedAt: v.optional(v.number()),
  needsYourInput: v.boolean(),
  pinned: v.boolean(), muted: v.boolean(), dismissed: v.boolean(),
  interestReasonBits: v.number(),
  lastOpenedAt: v.optional(v.number()),
  userRevision: v.int64(),
  authorizationEpoch: v.int64(),
})
  .index("by_stream_user", ["workstreamId", "platformUserId"])
  .index("by_user_unread", ["workspaceId", "platformUserId", "latestUnreadOrdinal"])
  .index("by_user_mention", ["workspaceId", "platformUserId", "latestMentionOrdinal"])
  .index("by_user_flags", ["workspaceId", "platformUserId", "pinned", "needsYourInput"]),

attentionEvents: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  attentionOrdinal: v.int64(),
  partId: v.optional(v.id("parts")),
  kind: v.union(v.literal("message"), v.literal("mention"), v.literal("assignment"),
                v.literal("state")),
  audienceId: v.id("audiences"),
}).index("by_stream_ordinal", ["workstreamId", "attentionOrdinal"])
  .index("by_audience", ["audienceId", "attentionOrdinal"]),

partMentions: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  partId: v.id("parts"), mentionedUserId: v.string(), mentionOrdinal: v.int64(),
}).index("by_user", ["workspaceId", "mentionedUserId", "mentionOrdinal"])
  .index("by_part", ["partId"]),

participants: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  platformUserId: v.string(), participantKind: v.string(),
  firstContributedSeq: v.int64(), lastContributedSeq: v.int64(),
  state: v.union(v.literal("active"), v.literal("left")),
}).index("by_stream_user", ["workstreamId", "platformUserId"]),

assignments: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  platformUserId: v.string(), assignmentKind: v.string(),
  state: v.union(v.literal("open"), v.literal("completed"), v.literal("cancelled")),
  assignmentRevision: v.int64(), assignedBy: v.string(),
  completedAt: v.optional(v.number()),
}).index("by_stream_user_kind", ["workstreamId", "platformUserId", "assignmentKind"]),
```

**Why the card fields live on the head document.** The sibling design needs a
separate `workstream_cards` projection because a sidebar query joining canonical
tables would be too expensive under Postgres load, and a separate table is
cheap to keep synchronous. Here the head document is already the document every
append writes, so the card fields cost nothing extra to maintain and one fewer
document means one fewer thing that can be stale. The trade-off is a wider hot
document: every sidebar subscription reads it, so every append re-runs every
sidebar query for that workspace page. That is intended — it is the mechanism —
but it is also the dominant reactive-spend line, and it is what the pilot
measures.

### Conversation

```ts
substreams: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  kind: v.union(v.literal("main"), v.literal("private_chat"), v.literal("human_fork"),
                v.literal("subagent_fresh"), v.literal("subagent_fork"),
                v.literal("document_chat")),
  parentSubstreamId: v.optional(v.id("substreams")),
  baseSeq: v.optional(v.int64()),
  inheritanceMode: v.union(v.literal("none"), v.literal("frozen"),
                           v.literal("document_version")),
  audienceId: v.id("audiences"),
  resourceId: v.optional(v.string()), resourceRevision: v.optional(v.int64()),
  scopeRevision: v.int64(),
  depth: v.number(),                       // ≤ 4, checked in the creating mutation
  state: v.union(v.literal("active"), v.literal("completed"),
                 v.literal("abandoned"), v.literal("deleted")),
  createdBy: v.string(),
}).index("by_stream_kind", ["workstreamId", "kind"])
  .index("by_parent", ["parentSubstreamId"]),

turns: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  substreamId: v.id("substreams"),
  kind: v.union(v.literal("user"), v.literal("agent"),
                v.literal("tool_exchange"), v.literal("control")),
  firstSeq: v.optional(v.int64()), lastSeq: v.optional(v.int64()),
  admissionOrdinal: v.optional(v.int64()),
  status: v.union(v.literal("open"), v.literal("complete"),
                  v.literal("superseded"), v.literal("redacted")),
  runId: v.optional(v.id("runs")), stepNo: v.optional(v.number()),
  admissionBatchId: v.optional(v.id("admissionBatches")),
}).index("by_substream_admission", ["substreamId", "admissionOrdinal"])
  .index("by_stream_status", ["workstreamId", "status"])
  .index("by_run", ["runId"]),

parts: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  substreamId: v.id("substreams"), turnId: v.id("turns"),
  seq: v.int64(), ordinalInTurn: v.number(),
  role: v.union(v.literal("system"), v.literal("user"),
                v.literal("assistant"), v.literal("tool")),
  kind: v.string(),        // text | tool_call | tool_result | attachment | terminal | summary
  authorKind: v.string(), authorId: v.string(),
  inlineText: v.optional(v.string()),      // ≤ 8 KiB; larger goes to contentRefs
  contentRefId: v.optional(v.id("contentRefs")),
  structuredPayload: v.optional(v.any()),  // bounded, versioned
  providerCallId: v.optional(v.string()),
  relatedPartId: v.optional(v.id("parts")),
  audienceId: v.id("audiences"),
  authorizationEpoch: v.int64(), scopeRevision: v.int64(),
  contentHash: v.string(),
  sourceOperationKey: v.optional(v.string()),
  sealedAt: v.number(),
  redactedByPartId: v.optional(v.id("parts")),
})
  .index("by_stream_seq", ["workstreamId", "seq"])
  .index("by_substream_seq", ["substreamId", "seq"])
  .index("by_turn_ordinal", ["turnId", "ordinalInTurn"])
  .searchIndex("search_text", { searchField: "inlineText",
    filterFields: ["workspaceId", "audienceId", "workstreamId"] }),

admissionBatches: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  substreamId: v.id("substreams"),
  firstSeq: v.int64(), lastSeq: v.int64(),
  mode: v.union(v.literal("queue"), v.literal("steer"), v.literal("system")),
  controlRevision: v.int64(),
  runId: v.optional(v.id("runs")),
  state: v.union(v.literal("pending"), v.literal("admitted"),
                 v.literal("superseded"), v.literal("cancelled")),
}).index("by_stream_state", ["workstreamId", "state"]),

admissionBatchTurns: defineTable({
  batchId: v.id("admissionBatches"), turnId: v.id("turns"),
  admissionOrdinal: v.int64(),
}).index("by_batch_ordinal", ["batchId", "admissionOrdinal"])
  .index("by_turn", ["turnId"]),

deltaChunks: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  substreamId: v.id("substreams"), turnId: v.id("turns"),
  runId: v.id("runs"), stepNo: v.number(),
  epoch: v.int64(),                 // must equal workstreams.streamEpoch to be visible
  chunkNo: v.number(),
  text: v.string(),                 // one 250–500 ms batch
  byteOffset: v.int64(),
  audienceId: v.id("audiences"),
  state: v.union(v.literal("live"), v.literal("sealed"), v.literal("tombstoned")),
}).index("by_turn_epoch_chunk", ["turnId", "epoch", "chunkNo"])
  .index("by_state_created", ["state"]),

compactionJobs: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  substreamId: v.id("substreams"),
  firstSeq: v.int64(), lastSeq: v.int64(),
  sourceMerkleHash: v.string(),
  authorizationEpoch: v.int64(), scopeRevision: v.int64(),
  formatVersion: v.string(), model: v.string(),
  modelVersion: v.string(), promptVersion: v.string(),
  compactionKey: v.string(),
  state: v.union(v.literal("queued"), v.literal("running"), v.literal("ready"),
                 v.literal("invalid"), v.literal("failed")),
  summaryPartId: v.optional(v.id("parts")),
  attempts: v.number(), lastError: v.optional(v.string()),
}).index("by_key", ["compactionKey"])
  .index("by_substream_state", ["substreamId", "state"]),

compactionSources: defineTable({
  jobId: v.id("compactionJobs"), partId: v.id("parts"),
  seq: v.int64(), contentHash: v.string(),
}).index("by_job_seq", ["jobId", "seq"]),

promotions: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  sourceSubstreamId: v.id("substreams"), targetSubstreamId: v.id("substreams"),
  sourceFirstSeq: v.int64(), sourceLastSeq: v.int64(),
  sourceScopeRevision: v.int64(), authorizationEpoch: v.int64(),
  promotedPartId: v.id("parts"), contentHash: v.string(), createdBy: v.string(),
}).index("by_target", ["targetSubstreamId"]),
```

`parts` is append-only and immutable after `sealedAt`. `deltaChunks` is the
only mutable-in-aggregate conversation table, and it is transient by
construction: a scheduled sweep deletes tombstoned chunks older than the
recovery window.

### Runs, control, and effects

```ts
runs: defineTable({
  workspaceId: v.id("workspaces"),
  ownerKind: v.union(v.literal("workstream"), v.literal("automation"),
                     v.literal("meeting"), v.literal("digest"), v.literal("suggestion")),
  ownerId: v.string(),
  substreamId: v.optional(v.id("substreams")),
  admissionBatchId: v.optional(v.id("admissionBatches")),
  state: v.string(),      // admitted | ready | running | waiting_* | interrupting | terminal
  nextAction: v.optional(v.string()),
  runRevision: v.int64(), controlRevision: v.int64(),
  authorizationEpoch: v.int64(), scopeRevision: v.int64(),
  nextStepNo: v.number(),
  workflowId: v.optional(v.string()),   // Workflow component instance
  driverVersion: v.string(),
  nextWakeAt: v.optional(v.number()),
  modelProvider: v.string(), modelName: v.string(), providerConfigRevision: v.int64(),
  tokenBudget: v.int64(), toolBudget: v.number(), costBudgetMicros: v.int64(),
  stepBudget: v.number(), elapsedBudgetMs: v.number(), childBudget: v.number(),
  tokensUsed: v.int64(), toolsUsed: v.number(), costUsedMicros: v.int64(),
  stepsUsed: v.number(),
  terminalReason: v.optional(v.string()), lastErrorClass: v.optional(v.string()),
  startedAt: v.optional(v.number()), lastProgressAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
}).index("by_owner", ["ownerKind", "ownerId"])
  .index("by_owner_batch", ["ownerKind", "ownerId", "admissionBatchId"])
  .index("by_state_wake", ["state", "nextWakeAt"])
  .index("by_workflow", ["workflowId"]),

runStepRecords: defineTable({
  workspaceId: v.id("workspaces"), runId: v.id("runs"),
  stepNo: v.number(), attemptNo: v.number(),
  kind: v.union(v.literal("model"), v.literal("tool"), v.literal("terminal"),
                v.literal("compaction"), v.literal("reconcile"), v.literal("wait"),
                v.literal("delivery")),
  state: v.union(v.literal("planned"), v.literal("started"), v.literal("waiting"),
                 v.literal("succeeded"), v.literal("failed"),
                 v.literal("superseded"), v.literal("unknown")),
  expectedRunRevision: v.int64(), expectedControlRevision: v.int64(),
  authorizationEpoch: v.int64(), scopeRevision: v.int64(),
  projectionVersion: v.optional(v.string()), projectionHash: v.optional(v.string()),
  inputRefId: v.optional(v.id("contentRefs")), outputRefId: v.optional(v.id("contentRefs")),
  providerRequestId: v.optional(v.string()), providerResultId: v.optional(v.string()),
  retryClass: v.optional(v.string()), attempts: v.number(),
  heartbeatAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
}).index("by_run_step_attempt", ["runId", "stepNo", "attemptNo"])
  .index("by_run_state", ["runId", "state"]),

runControl: defineTable({                 // the steering document — one per run
  workspaceId: v.id("workspaces"), runId: v.id("runs"),
  workstreamId: v.optional(v.id("workstreams")),
  controlRevision: v.int64(),
  latestInputSeq: v.int64(),
  interruptMode: v.union(v.literal("none"), v.literal("at_boundary"),
                         v.literal("immediate")),
  interruptRequestedAt: v.optional(v.number()),
  requestedBy: v.optional(v.string()),
  authorizationEpoch: v.int64(),
}).index("by_run", ["runId"]),

runWaits: defineTable({
  runId: v.id("runs"), stepNo: v.number(),
  waitKind: v.union(v.literal("event"), v.literal("time"),
                    v.literal("user"), v.literal("provider")),
  eventKey: v.string(),
  state: v.union(v.literal("open"), v.literal("consumed"), v.literal("expired")),
  expectedRevision: v.int64(), deadlineAt: v.optional(v.number()),
  consumedAt: v.optional(v.number()),
}).index("by_run_event", ["runId", "eventKey", "state"]),

runWaitEvents: defineTable({              // early events land here before a waiter exists
  runId: v.id("runs"), eventKey: v.string(), eventIdempotencyKey: v.string(),
  payloadRefId: v.optional(v.id("contentRefs")), payloadHash: v.optional(v.string()),
  consumedByWaitId: v.optional(v.id("runWaits")),
}).index("by_run_event_key", ["runId", "eventKey", "eventIdempotencyKey"])
  .index("by_run_unconsumed", ["runId", "consumedByWaitId"]),

toolEffects: defineTable({
  workspaceId: v.id("workspaces"), runId: v.id("runs"), stepNo: v.number(),
  effectKind: v.string(), effectKey: v.string(), requestHash: v.string(),
  state: v.union(v.literal("planned"), v.literal("started"), v.literal("succeeded"),
                 v.literal("failed"), v.literal("unknown"), v.literal("reconciled")),
  cancellability: v.union(v.literal("none"), v.literal("cooperative"),
                          v.literal("provider")),
  provider: v.optional(v.string()), providerReference: v.optional(v.string()),
  resultRefId: v.optional(v.id("contentRefs")), resultHash: v.optional(v.string()),
  startedControlRevision: v.int64(), authorizationEpoch: v.int64(),
  attempts: v.number(), nextReconcileAt: v.optional(v.number()),
  lastErrorClass: v.optional(v.string()), settledAt: v.optional(v.number()),
}).index("by_run_step_effect", ["runId", "stepNo", "effectKind", "effectKey"])
  .index("by_state_reconcile", ["state", "nextReconcileAt"]),

terminalSessions: defineTable({
  workspaceId: v.id("workspaces"), workstreamId: v.id("workstreams"),
  runId: v.id("runs"), daytonaWorkspaceId: v.string(),
  state: v.string(), expiresAt: v.optional(v.number()),
}).index("by_run", ["runId"]),

terminalCommands: defineTable({
  sessionId: v.id("terminalSessions"), effectId: v.id("toolEffects"),
  commandKey: v.string(), providerCommandId: v.optional(v.string()),
  state: v.string(), exitCode: v.optional(v.number()),
  stdoutRefId: v.optional(v.id("contentRefs")), stderrRefId: v.optional(v.id("contentRefs")),
  lastOutputOffset: v.int64(), reconciledAt: v.optional(v.number()),
}).index("by_effect", ["effectId"])
  .index("by_command_key", ["commandKey"]),
```

There is no `driver_bindings` table. The Workflow instance lives in the same
deployment and its ID is a field on `runs`; there is no second system whose
existence must be reconciled with the database's belief about the run.

### Connectors, activity, digests, suggestions

These tables translate the sibling PRD's connector and opportunity model
one-for-one; only the mechanism changes. Fields are listed compactly, with the
keys and indexes that carry the semantics called out.

```ts
connectorInstallations: { workspaceId, provider, externalInstallationId, state:
  active|paused|revoked|deleting, credentialRef /* env-var name, never the
  secret */, authorizationEpoch, webhookCursor?, backfillCursor? }
  .index("by_provider_external", ["provider", "externalInstallationId"])
  .index("by_workspace_provider", ["workspaceId", "provider", "state"])

ingressReceipts: { workspaceId, installationId, providerEventId, bodyHash,
  byteSize, rawContentRefId?, boundedBody?, providerSchemaVersion,
  signatureVersion, state: accepted|queued|normalized|rejected|quarantined|dead,
  receivedAt, normalizedAt?, attempts, lastErrorClass? }
  .index("by_installation_event", ["installationId", "providerEventId"])   // dedup key
  .index("by_state_received", ["state", "receivedAt"])

ingressConflicts: { canonicalReceiptId, conflictingBodyHash, byteSize,
  rawContentRefId?, state: quarantined|reviewed|discarded }
  .index("by_receipt_hash", ["canonicalReceiptId", "conflictingBodyHash"])

connectorResources: { workspaceId, installationId, providerResourceKind,
  providerResourceId, providerVersion, currentContentRefId?, audienceId, state,
  tombstonedAt? }
  .index("by_installation_resource",
         ["installationId", "providerResourceKind", "providerResourceId"])

activityEvents: { workspaceId, installationId, receiptId,
  eventSeq /* allocated from workspaces.activityCursor */, eventKind, actorKind,
  actorRef, objectKind, objectRef, providerOccurredAt, ingestedAt,
  normalizedPayload, contentRefId?, audienceId, authorizationEpoch,
  sourceVersion, parserVersion, supersedesEventId?, tombstoneForEventId?,
  contentHash }
  .index("by_workspace_seq", ["workspaceId", "eventSeq"])
  .index("by_object", ["workspaceId", "objectKind", "objectRef"])
  .index("by_audience_seq", ["audienceId", "eventSeq"])

activityLinks: { activityEventId, workspaceId, targetKind, targetId,
  relationKind }
  .index("by_target", ["workspaceId", "targetKind", "targetId"])

activityCursors: { installationId, cursorKind, cursorValue, sourceWatermark,
  state } .index("by_installation_kind", ["installationId", "cursorKind"])

digestSchedules: { workspaceId, targetUserId, timezone, cadence, nextDueAt,
  lastSourceWatermark, state, revision } .index("by_due", ["state", "nextDueAt"])

digestJobs: { scheduleId, workspaceId, sourceFirstSeq, sourceLastSeq,
  authorizationEpoch, promptVersion, modelVersion, state, attempts }
  .index("by_schedule_range", ["scheduleId", "sourceFirstSeq", "sourceLastSeq"])

digests: { jobId, workspaceId, targetUserId, audienceId, inlineText?,
  contentRefId?, contentHash, revision, state, deliveredEffectId?,
  invalidatedAt? }
  .index("by_job", ["jobId"])
  .index("by_user_state", ["workspaceId", "targetUserId", "state"])

suggestions: { workspaceId, kind: workstream|action, targetUserId?, audienceId,
  targetWorkstreamId?, title, summary, actionKind?, actionPayloadRefId?,
  detectorVersion, modelVersion, promptVersion, semanticKey, score,
  explanationRefId?, sourceWatermark, authorizationEpoch, scopeRevision,
  state: proposed|shown|accepted|dismissed|expired|invalidated,
  acceptedWorkstreamId?, acceptedRunId?, acceptedEffectId?, expiresAt }
  .index("by_semantic", ["workspaceId", "kind", "targetUserId", "semanticKey"])
  .index("by_user_state_score", ["workspaceId", "targetUserId", "state", "score"])
  .index("by_expiry", ["state", "expiresAt"])

suggestionSources: { suggestionId, activityEventId, sourceRevision, contentHash }
  .index("by_suggestion", ["suggestionId"])

suggestionFeedback: { suggestionId, platformUserId, decision, reasonCode? }
  .index("by_suggestion_user", ["suggestionId", "platformUserId"])
```

Digests and suggestions are derived artifacts with explicit fences: a digest job
freezes `sourceFirstSeq..sourceLastSeq` plus `authorizationEpoch`, and a
suggestion carries `sourceWatermark`, `authorizationEpoch`, and `scopeRevision`
so acceptance can revalidate rather than trust. `acceptedWorkstreamId`,
`acceptedRunId`, and `acceptedEffectId` are the exactly-once outcome fields —
a retry that finds one set returns it instead of creating a second work stream.

The `semanticKey` uniqueness the sibling enforces with a partial unique index is
enforced here by the creating mutation: it reads the index range for the same
scope and window, and a concurrent duplicate loses the OCC race and retries into
the now-visible row. There is no `NULLS NOT DISTINCT` problem because a missing
`targetUserId` is a distinct, explicitly written sentinel in the key.

### Content, search, and operations

```ts
contentRefs: { workspaceId, storageId? /* v.id("_storage") */,
  state: pending|ready|deleting|deleted|orphaned|corrupt, contentHash?, byteSize?,
  mediaType, audienceId, authorizationEpoch, sourceKind, sourceId?,
  sourceRevision, uploadedByKind, uploadedById, uploadOperationKey?, expiresAt?,
  verifiedAt? }
  .index("by_workspace_state", ["workspaceId", "state"])
  .index("by_upload_key", ["workspaceId", "uploadOperationKey"])
  .index("by_source", ["sourceKind", "sourceId"])

embeddings: { workspaceId, sourceKind, sourceId, sourceRevision, chunkNo, model,
  dimensions, embedding: v.array(v.float64()), contentHash, audienceId,
  authorizationEpoch, state: live|invalidated }
  .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536,
      filterFields: ["workspaceId", "audienceId", "state"] })
  .index("by_source_chunk", ["sourceKind", "sourceId", "chunkNo", "model"])

searchDocuments: { workspaceId, sourceKind, sourceId, sourceRevision, audienceId,
  authorizationEpoch, title, body, contentHash, state: live|invalidated }
  .searchIndex("search_body", { searchField: "body",
      filterFields: ["workspaceId", "audienceId", "state"] })
  .index("by_source", ["sourceKind", "sourceId"])

commandReceipts: { workspaceId, actorId, operationKey, operationKind,
  requestHash, state: started|completed|rejected, resultKind?, resultId?,
  resultRevision?, errorCode?, expiresAt }
  .index("by_actor_key", ["workspaceId", "actorId", "operationKey"])
  .index("by_expiry", ["expiresAt"])

auditEvents: { workspaceId?, actorKind, actorId, action, targetKind, targetId,
  authorizationEpoch, decision, requestId?, operationKey?,
  detail /* IDs, counts, hashes, error classes only */ }
  .index("by_workspace_time", ["workspaceId"])
  .index("by_target", ["targetKind", "targetId"])

exportJobs: { workspaceId, requestedBy, authorizationEpoch, sourceFence, state,
  manifestContentRefId?, expiresAt } .index("by_workspace_state", [...])

deletionJobs: { workspaceId, phase, targetKind, targetCursor, state,
  legalHoldState, attempts, nextAttemptAt } .index("by_state_attempt", [...])

importReceipts: { workspaceId, semanticTargetKey, sourceHash, resultHash,
  rowCount } .index("by_workspace_target", ["workspaceId", "semanticTargetKey"])
```

`contentRefs` is the one table that spans two systems, so its state machine is
the authority on what exists: only `ready` references are served, `pending` past
expiry becomes `orphaned`, and `deleted` is written only after the file's
absence is verified. `commandReceipts` gives every client command scoped
idempotency, and `auditEvents` is durable product evidence — deliberately not
the platform's own function logs, which are diagnostic and short-lived.

## The function layer

Convex clients invoke exported functions and nothing else, so the function
module boundary is the API and the authorization tier at once.

| Module | Kind | Contents |
| --- | --- | --- |
| `workspace.ts` | queries | sidebar page, collection counts, work-stream header, member list |
| `conversation.ts` | queries | transcript page, live tail, substream tree, projection preview |
| `commands.ts` | mutations | `appendUserInput`, `updateWorkstream`, `markSeen`, `createSubstream`, `promote`, `acceptSuggestion` |
| `runs.ts` | mutations | `admitRun`, `beginStep`, `checkpoint`, `completeStep`, `failStep`, `beginEffect`, `settleEffect`, `terminate` |
| `turn.ts` | actions | one model turn: provider stream, checkpoint loop, watchdog, seal |
| `tools.ts` | actions | one tool call, one Daytona command start/attach/reconcile |
| `ingress.ts` | HTTP actions | connector webhooks with signature verification |
| `internal/*` | internal | jobs invoked only by the scheduler, Workpool, or Workflow |

Three rules hold across all of them:

1. **Every public function begins with `requirePrincipal(ctx)`**, which resolves
   the JWT identity to `platformIdentities`, asserts `sessionEpoch` and state,
   and returns `{ platformUserId, identityDoc }`. Every function that names a
   workspace then calls `requireMember(ctx, workspaceId, capability)`, which
   reads the membership document — placing it in the query's read set, which is
   what makes revocation a delivery-time property rather than a poll.
2. **Every visibility decision is one helper**, `canSeeWorkstream`,
   `canSeePart`, `canSeeActivity`, each taking the principal and the document
   and reading grants and audience membership through indexes. Search and vector
   paths call the same helpers on their candidate sets; no read path has its own
   copy of the rule.
3. **Every client-callable function passes through the rate limiter** before
   doing work: a per-principal token bucket for mutations, a tighter one for
   action-initiating calls, and a per-workspace ceiling. Limits are configuration
   documents so they can be raised for a workspace without a deploy, and a
   rejection returns a typed `rate_limited` error with `retryAfterMs` rather
   than a timeout.

Trusted paths — scheduled jobs, Workpool workers, Workflow steps, HTTP action
follow-ups — are `internalMutation`/`internalAction` and are unreachable from a
client. They still take an explicit `workspaceId` and still call the same
visibility helpers for anything audience-sensitive; being internal removes the
authentication step, never the authorization step.

## Cross-function transaction protocols

These protocols define how the tables connect. Implementing the documents
without these boundaries is non-conforming. Each numbered protocol is one
mutation unless it says otherwise; a mutation that fails its OCC check is
retried automatically by the platform, and a mutation that fails a *fence*
check returns a typed conflict the caller must handle by rereading.

### `appendUserInput` (mutation)

1. `requirePrincipal`, `requireMember(workspaceId, "contribute")`, rate limit.
2. Claim `commandReceipts` by `(workspaceId, actorId, operationKey)`. A prior
   completed receipt with the same `requestHash` returns its stored result; a
   different hash is a conflict.
3. Read the `workstreams` head document; check `expectedRevision`.
4. Allocate `seq = nextSeq`, write back `nextSeq + 1` and `latestSeq`; allocate
   `attentionOrdinal`. **The write to the head document is what serializes
   concurrent appenders** — a competing mutation's read set overlaps this write,
   so it retries and re-reads the new value. Sequence order is commit order.
5. Insert or extend the `turns` document; insert the `parts` document with
   `audienceId`, epochs, and `contentHash`; insert `partMentions`.
6. Update card fields on the head document (`previewText`, `lastActivityAt`,
   `needsInput`, `revision + 1`) and upsert only the affected
   `workstreamUserState` documents — the sender's, and each mentioned or
   assigned person's. Never a document per member.
7. Insert `attentionEvents`; insert `auditEvents`.
8. Mode `queue`: insert or extend the pending `admissionBatches` document.
   Mode `steer`: patch `runControl` — `controlRevision + 1`,
   `interruptRequestedAt`, `requestedBy` — and patch `runs.controlRevision`.
9. If admission is possible now, `ctx.scheduler.runAfter(0, internal.runs.admit,
   …)`; scheduling is part of this transaction, so a committed message always
   has its follow-up scheduled and an aborted one never does.
10. Complete the receipt.

No provider call, file upload, or external HTTP happens inside this mutation.

### `updateWorkstream` (mutation)

Reads the head document, validates `expectedRevision` and capability, writes the
canonical fields, recomputes exactly one `lifecycleFamily` from the exact state
using the mapping table in the PRD, updates preview and timestamps, bumps
`revision`, patches affected overlays, and appends `auditEvents`. There is no
asynchronous work-stream-to-workspace projection to lag, because the card fields
and the canonical fields are the same document.

### `beginStep` / `completeStep` (mutations) with the action between them

`beginStep` reads the run and, when the owner is a work stream, its head
document; validates `runRevision`, `controlRevision`, `authorizationEpoch`,
`scopeRevision`, and every budget; inserts `runStepRecords` in `planned`;
advances `runs.nextStepNo`; and returns a bounded action descriptor (IDs,
revisions, projection fence — never provider credentials).

The action then performs exactly one externally meaningful operation. For an
irreversible effect it first calls `beginEffect`, which re-reads the run and
`runControl` in a fresh transaction, refuses if the control revision moved, and
inserts `toolEffects` in `started` with its idempotency key. The provider call
happens outside any transaction.

`completeStep` re-reads run, step, and head document; rejects a stale attempt by
`(runRevision, controlRevision, streamEpoch)`; records the result; appends the
sealed `parts` for a tool result or assistant output; updates run state and
counters; updates card fields and overlays; appends `auditEvents`; and schedules
the next action — all atomically. A crash between the provider call and
`completeStep` leaves the effect `started`; the reconciler looks it up by
`providerReference` before anything retries.

### `markSeen` (mutation)

Proves visibility, upserts only the caller's `workstreamUserState`, advances
`seenAttentionOrdinal` with a max against the current value, caps at the highest
attention ordinal the caller may see, recomputes the personal predicates, and
bumps `userRevision`. It never touches another member's document, and it never
writes the head document — so marking seen does not re-run every viewer's
sidebar query.

### `acceptSuggestion` (mutation)

Reads the suggestion and its `suggestionSources`; validates expiry, current
audience, `authorizationEpoch`, and every source's `sourceRevision`; claims a
command receipt; creates the work stream, its root substream, and initial parts,
or a run and effect intent for an action suggestion; writes
`acceptedWorkstreamId` / `acceptedRunId` / `acceptedEffectId` on the suggestion
and moves it to `accepted`; updates sidebar documents; appends `auditEvents`;
and schedules follow-up. A retry with the same operation key returns the same
work stream: the suggestion and its result cannot disagree after a crash.

### `finalizeUpload` (action + mutation)

1. `createUploadSlot` (mutation) inserts a `pending` `contentRefs` with expected
   hash, size, audience, source, and expiry, and returns a Convex upload URL.
2. The client or a trusted action uploads the bytes; Convex returns a
   `storageId`.
3. `finalizeContentRef` (mutation) re-reads the pending document, verifies size
   and hash against file metadata, attaches `storageId`, marks `ready`, and
   inserts the domain reference (part, activity, digest, export) in the same
   transaction.
4. A scheduled reconciler resolves both crash directions: a `pending` document
   past its expiry with no file becomes `orphaned`; a stored file with no ready
   reference is deleted after its grace window.

Only `ready` references are ever served, and serving re-checks audience and
epoch at read time.

### `completeCompaction` (mutation)

Re-reads the job, its `compactionSources`, and the head document; verifies that
every source hash, `authorizationEpoch`, and `scopeRevision` still matches;
appends the summary `parts` document with lineage; marks the job `ready`;
appends `auditEvents`. Parts above `lastSeq` are neither read nor affected — a
message sent during compaction simply has a higher sequence. Any mismatch marks
the job `invalid` and schedules a new fence.

## Streaming, steering, and the watchdog

The turn action is the only place Avalon holds a provider stream, and it is one
Convex-runtime action per model turn.

```
turnAction(runId, stepNo, turnId, epoch):
  fence      = await runQuery(internal.runs.loadFence)        # revisions + projection
  messages   = await runQuery(internal.conversation.project)  # authorized array
  stream     = await fetch(provider, messages)                # streaming response
  buffer     = ""; chunkNo = 0; lastCommit = now()
  watchdog   = setInterval(500ms, () => wake(commitLoop))
  for await (token of stream) {
    buffer += token
    if (now() - lastCommit >= CHECKPOINT_MS or watchdogFired) {
      { controlRevision, streamEpoch, stopped } =
        await runMutation(internal.runs.checkpoint, {
          runId, turnId, epoch, chunkNo, text: buffer, byteOffset })
      if (streamEpoch != epoch or controlRevision != fence.controlRevision) {
        abort(stream); return "superseded"
      }
      buffer = ""; chunkNo += 1; lastCommit = now()
    }
  }
  await runMutation(internal.runs.sealTurn, { runId, turnId, epoch })
```

Four properties follow from that shape:

- **Cadence.** `CHECKPOINT_MS` is 250–500 ms, chosen per region and reflected
  directly in spend. Each checkpoint is one small append plus a head-document
  read; it is never a rewrite of the accumulated buffer.
- **The watchdog is the steering bound.** The 500 ms timer fires a checkpoint
  mutation even with an empty buffer, so the loop reads `runControl` on a wall
  clock rather than on token arrival. A stalled provider, a slow first byte, and
  a long tool wait all halt within one interval. This is the fix for the defect
  the challenge round found in the token-driven-only design, and it is the
  reason the PRD can state a one-second bound as a product fact.
- **The epoch is the single CAS authority.** `checkpoint` refuses to write when
  `epoch != workstreams.streamEpoch`, so a superseded attempt cannot append and
  cannot seal. Retracting a dead attempt is one `patch` that bumps
  `streamEpoch`; every tail query filters chunks on the current epoch, so the
  retraction is simultaneous for every viewer.
- **Seal is a copy, not a rename.** `sealTurn` reads the live chunks in order,
  concatenates them into one immutable `parts` document with its content hash,
  marks the chunks `tombstoned`, updates the head document's card fields, and —
  when this was the final step — terminates the run. A scheduled sweep deletes
  tombstoned chunks after the recovery window, which is how the streaming tier
  is compacted rather than accumulated.

The tail query a viewer subscribes to is:

```ts
export const tail = query({
  args: { workstreamId: v.id("workstreams"), turnId: v.id("turns") },
  handler: async (ctx, args) => {
    const principal = await requirePrincipal(ctx);
    const head = await ctx.db.get(args.workstreamId);
    await requireMember(ctx, head.workspaceId, "view");     // in the read set
    if (!(await canSeeWorkstream(ctx, principal, head))) return null;
    const chunks = await ctx.db.query("deltaChunks")
      .withIndex("by_turn_epoch_chunk",
        q => q.eq("turnId", args.turnId).eq("epoch", head.streamEpoch))
      .collect();
    return { epoch: head.streamEpoch, text: chunks.map(c => c.text).join("") };
  },
});
```

Every checkpoint commit overlaps this query's read set, so it re-executes and
pushes — and because `requireMember` and `canSeeWorkstream` run inside it, the
frame a viewer receives is authorized at the snapshot it was computed at. A
mid-stream joiner's first result costs one bounded chunk scan; every later frame
is incremental. There is no client-side offset arithmetic, no duplicate
detection, and no gap handling, because the client is never given a delta to
reassemble.

## The run driver on the Workflow component

One Workflow instance per full loop, created inside the admitting mutation's
scheduled follow-up and recorded as `runs.workflowId`.

- **Step shape.** Each step is one `beginStep` → bounded action → `completeStep`
  triple. Steps are individually durable and retried by the component's policy;
  the database, not the component, decides what the next action is, so a
  replayed step re-reads the fence and becomes a no-op if it already committed.
- **Binding.** Because the instance and the run live in the same deployment,
  creation and the run document commit together — there is no create-then-bind
  protocol, no binding epoch, and no reconciliation of an instance the database
  does not know about. A lost instance is detected by a scheduled sweep over
  `runs.by_state_wake` and recreated from the run's own state.
- **Waits and early events.** `runWaits` records an installed wait;
  `runWaitEvents` records a signal that arrived before its waiter. Consumption
  is one mutation that matches by `(runId, eventKey, eventIdempotencyKey)` and
  sets `consumedByWaitId`, so an early event is consumed exactly once and a
  duplicate signal is a no-op. A workflow wait is an accelerator over these
  documents, never the record itself.
- **Budgets.** Token, tool, cost, step, elapsed, idle, output-byte, and child
  budgets live on `runs` and are enforced in `beginStep` and `completeStep`.
  Platform maxima are not budgets: a loop that exhausts a product budget
  terminates with `budget_exhausted`, which the sidebar maps to the `error`
  family.
- **The 30-minute ceiling.** A model turn is one Convex-runtime action, capped
  at 30 minutes. The action watches its own elapsed time and, at 27 minutes,
  seals what it has as a superseded attempt, marks the step `failed` with
  `retryClass = "runtime_ceiling"`, and lets the workflow retry from the last
  durable step. That re-spends the provider call, which is the named regression;
  three or more occurrences a week is a tripwire, and the designed fallback is
  an external turn host for that one step, invoked from the same `beginStep` /
  `completeStep` contract so nothing else moves. **No action may use
  `"use node"`** — that would drop the ceiling to 10 minutes — and CI fails the
  build if the directive appears in any file under `convex/`.
- **Terminal reconciliation.** `toolEffects.by_state_reconcile` is swept on a
  schedule: `started` effects past their deadline are looked up by
  `providerReference` (Daytona command ID, provider request ID) and settled to
  `succeeded`, `failed`, or `unknown`. Nothing retries an ambiguous external
  write; `unknown` surfaces as `needs_input` with an intervention reason.

## Search and retrieval

Text search uses `searchIndex` on `parts.inlineText` and on
`searchDocuments.body`, always with `workspaceId` as a filter field and always
followed by the same visibility helper on the returned documents. Vector search
runs in an action against `embeddings.by_embedding` with `workspaceId`,
`audienceId`, and `state` as filter fields, then re-reads each candidate through
a query that applies the helper before anything is returned to a caller. An
embedding is derived and rebuildable: changed, deleted, or revoked source
content marks its embeddings `invalidated` in the same mutation that changes the
source, and a scheduled job rebuilds them. Neither index is ever authoritative
and neither is consulted without the relational check.

## Import and cutover

**Export.** D1 tables are exported per workspace to JSONL, transformed into the
document shapes above by a checked-in script with a fixed mapping table, and
loaded with `npx convex import` into the target deployment. R2 objects are
re-uploaded to Convex file storage and their `contentRefs` are written with the
returned `storageId`. Every chunk carries a row count and content hash, and
`importReceipts` makes a replayed chunk idempotent.

**The gate.** The linearization point stays on the D1 side, exactly as the
sibling PRD designs it, because a cross-system compare-and-set does not exist:

1. `workspaceAuthorityGates(workspaceId, authorityEpoch, state, targetRegion,
   finalSourceCursor, heldThroughCursor, closureReceiptHash)` in the D1 schema,
   with `state ∈ {source_open, source_holding, source_closed}`.
2. Moving to `source_holding` stops accepting new canonical writes; commands
   that arrive during the hold are recorded in `sourceHeldCommands` with their
   operation keys and request hashes, and the client sees a brief, explicit
   "saving" state rather than an error.
3. Import the final delta; validate counts, hashes, materializations at fixed
   fences, sidebar state, and file readiness.
4. In one D1 transaction, seal the final and held cursors and move the gate to
   `source_closed` at the next epoch. **This receipt is the sole linearization
   point.**
5. Verify the closure receipt in Convex and write `importReceipts` for the
   workspace at the same epoch; only then does the deployment accept writes for
   it.
6. Converge the Global route as a derived, retryable copy. Until it converges,
   the old endpoint reads its closed gate and returns a route correction without
   accepting writes.
7. Release `sourceHeldCommands` to the Convex mutations in accepted order, using
   their original operation keys so a duplicate returns the original result.

A crash at step 5 or later is an availability gap, never two writers. The gate
never reopens at a closed epoch; recovery moves forward.

**Deletions from the port.** `WorkstreamRoom` and its checkpoint, replay,
resync, and eviction machinery; the REST route surface; the D1 repositories and
their ~460 tenancy predicates; the Queue consumers; the Cloudflare Workflow
definitions; the renderer's WebSocket and cursor client. These are deleted, not
ported — a ported copy would be dead code with live failure modes.

## Retention, deletion, and export

Retention is a scheduled internal mutation per class, driven by
`retentionPolicies` and executed as bounded indexed range deletes: tombstoned
delta chunks after the recovery window, raw ingress bodies after
`rawIngressDays`, activity after `activityDays`, audit after `auditDays`,
completed export artifacts after `exportDays`. Because every cursor is allocated
from a counter document rather than derived from a physical row, deleting old
documents never disturbs monotonicity, and there is no partition scheme to
retrofit.

Workspace deletion runs in phases with receipts: close admission, then
relational documents, then file storage (verified by absence), then search and
vector documents, then external provider cleanup, then a non-content receipt per
target. Database deletion never stands as proof of byte deletion. Export freezes
an authorized fence, writes chunks with hashes and a manifest, and generates
download URLs only after a live authorization check.

## What deliberately has no analog

- **No client cursor, replay, or resync protocol.** The sibling PRD's
  `workspace_events` / `workstream_events` cursor tables, `scanned_through`
  watermark, subscribe-buffer-snapshot handshake, and `snapshot_required`
  fallback have no counterpart. A resubscribed query is recomputed
  server-side, so there is nothing for a client to catch up on. `auditEvents`
  exists for history and export, and clients never page it for recovery.
- **No realtime hint schema.** There are no topics, no envelopes, no frame
  coordinates, and no "coordinates only" delivery tier — content rides the same
  authorized subscription as everything else, so the sibling's revocable-lease
  gate before streaming bodies is not a gate that exists here.
- **No separate card projection table.** Card fields are the head document's
  own fields; there is no projector to lag and no rebuild job.
- **No driver binding table.** The Workflow instance is in the same deployment
  as the run.
- **No partition plan.** Retention is indexed deletion, not partition rotation.
- **No connection pooler, statement timeout, or vacuum budget.** They are not
  hidden; they do not exist on this substrate, and their absence is part of what
  the maintainability score pays for.

The honest inverse: **there is no SQL**, so every operational question is a
typed query or a warehouse query; **there is no Terraform provider**, so
environment variables are the drift surface and CI asserts them; **restore is a
destructive wipe**, so drills run on scratch deployments; and **one deployment
is one logical database**, so past roughly S≈2,000 the answer is application-level
per-workspace sharding across deployments, which nothing in this schema
prevents but nothing in it implements either.
