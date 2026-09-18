# Scope grant directory

The scope grant directory finds candidate workstreams for a user's current
workspace relationship. WorkstreamDO remains the grant authority; WorkspaceDO
stores a discovery projection. The projection alone never authorizes a read.
The lite browser consumes a canonical directory endpoint for shared navigation.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/scope-grant-storage.ts` | Grant mutation and existing parent outbox enqueue in one transaction. |
| `apps/api/src/durable-objects/workstream-do.ts` | Owns grant mutation and projection delivery through the existing parent outbox. |
| `packages/contracts/src/conversation-effects.ts` | Typed parent effect carrying the grant. |
| `apps/api/src/queues/activity-consumer.ts` | Existing Queue delivery to WorkspaceDO. |
| `apps/api/src/durable-objects/scope-grant-directory.ts` | Versioned projection and incarnation-specific candidate query. |
| `apps/api/src/durable-objects/workspace-do.ts` | Workspace identity checks, schema and typed RPC boundary. |
| `apps/api/src/services/shared-directory-service.ts` | Candidate lookup followed by canonical owner reads and relationship revalidation. |
| `apps/api/src/routes/sharing.ts` | Authenticated `/sharing/directory` route. |

## How it works

Every grant mutation invokes the parent's existing projection writer within its
SQLite transaction, including invitation acceptance. The same durable outbox owns
versioning, retries and WorkspaceDO delivery; there is no intermediate delivery alarm.
Migration 17 drains pending legacy delivery rows into that outbox transactionally,
then removes their old alarm. The empty legacy table remains for schema compatibility.

The WorkspaceDO index supplies candidates only. Directory reads admit each candidate
at its canonical parent concurrently and preserve ordering. A final relationship
incarnation/revision check fences the combined response. Main-derived titles and
appearance are withheld for child-only shares; workspace identity remains visible.

## Invariants

- Grant mutation and outbox insertion are atomic. Otherwise a crash can
  make an accepted share permanently undiscoverable.
- Revocation retains its version. Deleting the row would let a delayed addition
  recreate a stale candidate.
- Membership incarnation is part of lookup. Rejoining a workspace must not
  expose grants from the user's previous membership lifetime.
- Candidates require current owner admission before returning product content.
  Queue lag must never extend access after revocation.
- The generic WorkspaceDO SQL API rejects this table. Only the typed projection
  and candidate RPCs own its lifecycle.

## Boundary

This module owns discovery delivery and candidate indexing. Identity and active
relationships belong to D1; canonical grants belong to WorkstreamDO. Invitation
redemption is described in [scope invitations](scope-invitations.md). Browser
entry and its limited collaboration surface belong to
[browser client](browser-client.md). There is no new Queue or socket multiplexer.

## Failure modes and limits

The existing outbox alarm retries interrupted delivery. Queue transport failure leaves
the durable outbox row available for retry. Identical deliveries are idempotent;
older deliveries are ignored. Equal-version conflicting payloads fail rather
than silently selecting one. Malformed addresses or hashes fail delivery.
Discovery can lag grant acceptance, but the direct shared link still uses the
canonical owner. No new numeric limits are introduced.

## Testing

Run the API workerd files `scope-grant-authority.test.ts`,
`scope-grant-directory.test.ts` and `scope-grant-storage.test.ts`. The authority
test refuses Queue transport, inspects the real persisted outbox, and delivers
its exact bodies through the production consumer. Receiver tests exercise
revocation ordering, replay, replacement incarnations and generation fences.
A populated migration test preserves both pending and inflight deliveries.
Negative controls remove the source handoff and stale-delivery guard separately;
the corresponding tests must fail. Additional canonical tests prove that a stale
candidate cannot expose revoked content, Main labels do not leak through child
shares, and unready/restricted children are absent. Negative controls bypass
canonical admission or expose the Main title; both fail the corresponding tests.

## Changelog

### 2026-09-17 — Discover independent shares through the existing outbox

Guests can hold unrelated grants under multiple parents, so the member directory
cannot serve as their discovery authority. A small WorkspaceDO candidate index
avoids scanning every parent. Reusing the durable parent outbox preserves retry
and ordering semantics without introducing a second transport. Canonical owner
admission remains mandatory because an asynchronous index can be stale. The
serving endpoint now performs that admission and withholds Main-derived labels
for independent child grants. Browser navigation consumes those results without
opening the member directory. Grant transactions now enqueue directly into that
outbox; retaining an intermediate delivery table and alarm duplicated its
responsibility. Migration 17 moves pending old intents transactionally before
retiring their alarm. Parent reads run concurrently with a final relationship fence.
