# Scope grant directory

The scope grant directory finds candidate workstreams for a user's current
workspace relationship. WorkstreamDO remains the grant authority; WorkspaceDO
stores a discovery projection. The projection alone never authorizes a read.
The lite browser consumes a canonical directory endpoint for shared navigation.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/scope-grant-storage.ts` | Grant mutation, delivery intent and alarm in one transaction. |
| `apps/api/src/durable-objects/workstream-do.ts` | Alarm transfers intents into the existing parent outbox. |
| `packages/contracts/src/conversation-effects.ts` | Typed parent effect carrying the grant. |
| `apps/api/src/queues/activity-consumer.ts` | Existing Queue delivery to WorkspaceDO. |
| `apps/api/src/durable-objects/scope-grant-directory.ts` | Versioned projection and incarnation-specific candidate query. |
| `apps/api/src/durable-objects/workspace-do.ts` | Workspace identity checks, schema and typed RPC boundary. |
| `apps/api/src/services/shared-directory-service.ts` | Candidate lookup followed by canonical owner reads and relationship revalidation. |
| `apps/api/src/routes/sharing.ts` | Authenticated `/sharing/directory` route. |

## How it works

A changed grant writes `scope_grant_deliveries` and schedules
`scope_grant_directory/pending` inside the grant transaction. The alarm writes
one parent projection per user and exact scope, acknowledging the intent in the
same local transaction. The existing durable outbox sends it to ACTIVITY_QUEUE.
WorkstreamDO migration 15 extends its outbox kind constraint while preserving
pending and inflight rows.

WorkspaceDO migration 60 adds `scope_grant_directory`. The consumer checks the
workspace, region, parent, effect hash, source generation and per-scope version.
It retains revoked rows as tombstones. Candidate lookup selects distinct parent
IDs for an active grant and the exact membership incarnation. It returns no
conversation title, transcript, resource, or scope authorization. Legacy grants
without an incarnation remain stored but cannot match a current relationship.

The serving service reads the current relationship, finds candidate parents, and
asks each WorkstreamDO for its readable conversations. After its relationship
read, the owner synchronously evaluates current grants and lifecycle before
releasing labels. Only readable Main admits the parent title; child-only access
returns a null parent title, displayed as Shared workstream. Restricted or
unready children are omitted. Archived content stays discoverable under the
existing read-only policy. The service rechecks membership incarnation/revision
before returning the assembled response. The browser refreshes on focus and
provides a refresh action; this directory does not open a workspace socket.

## Invariants

- Intent acknowledgement and outbox insertion are atomic. Otherwise a crash can
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

The shared alarm retries an interrupted handoff. Queue transport failure leaves
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
opening the member directory.
