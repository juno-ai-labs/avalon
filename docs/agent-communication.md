# Agent communication

Agent communication reuses conversation identities, workspace-local teams,
message references, and separate delegation ownership. A Sidekick can join
several teams without becoming a child of any of them. The complete execution
and UI work is tracked in the [implementation plan](PRDs/2026-09-14_uninterrupted-workstreams/plan.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/agent-communication.ts` | Conversation addresses and strict message schemas with attachments. |
| `apps/api/src/durable-objects/agent-team-storage.ts` | Teams, additive membership, ownership, and immutable message routes. |
| `apps/api/src/durable-objects/workspace-do.ts` | Migration 57 and internal host RPCs. |
| `apps/api/test-workers/agent-teams.test.ts` | Real workerd migration and RPC coverage. |

## How it works

An agent ID encodes `parentKind/parentId/substreamId` within the host's workspace.
Creation and discovery supply it; no independent agent identity is allocated.
Different Sidekick authoring conversations can each have substream `0`.

The originating conversation supplies its implicit team's stable identity.
Ensuring a team adds its origin. A host-authorized Sidekick contact adds the
Sidekick. Recording delegation adds the worker to the owner's team and records
ownership independently. Repeating those operations preserves existing records.
Membership has no removal operation.

Discovery reads a team's roster after checking the requester belongs to it.
Send requires a shared team. The host prefers the incoming exchange's scope;
otherwise the stable first common team supplies the scope. Reply uses the
received message's original sender and team, and only its recipient can reply.

`agent_message_routes` stores addresses, not bodies or delivery receipts.
Recording a route does not prove a recipient accepted a message: recipient
input admission owns delivery. Replays cannot change the original route.
Recursive ownership queries return descendants, not teammates; reparenting and
cycles are refused.

## Invariants

- Membership and ownership are separate, so a shared Sidekick is not stopped
  just because one team stops its workers.
- Sharing a member never merges rosters, preventing accidental transitive
  discovery and message authorization.
- Reply uses immutable received-message references, so concurrent Sidekick
  exchanges return to their original conversations.
- Related checks and writes commit synchronously in SQLite; interruption cannot
  record an ownership edge without its membership.
- WorkspaceDO is the sole team authority; a D1 fallback would create divergent
  membership decisions.

## Boundary

These are internal host RPCs, not model-callable team-management tools. Callers
check execution and Sidekick domain authority before adding contacts. Membership
grants no credentials, transcript access, resource access, or control over peers.
SubstreamAgent owns content and execution. Conversation parents retain archive
and viewer authority; SidekickDO owns setup, definitions, and schedules.

## Failure modes and limits

Expected membership, received-message, ownership, and route conflicts return
typed refusals. Storage and transport errors remain failures. Tool integration
must translate domain codes into actionable model-facing explanations.
No new membership or descendant-depth caps are introduced. Message contracts
reuse existing name, description, message and attachment bounds. Unknown input
fields are rejected, including model-selected authority and team selectors.

## Testing

`pnpm --filter @rally/contracts exec vitest run src/agent-communication.test.ts`
checks address round trips, explicit context, attachments, and distinct send/reply
parameters. `pnpm --filter @rally/api test:workers test-workers/agent-teams.test.ts`
exercises real WorkspaceDO migrations and RPCs for multi-team Sidekicks, scoped
rosters, reply routes, replay, and descendant ownership. The latter clears only
its own dedicated workspace's new tables between tests. These checks establish
the primitive, not complete background execution or desktop behavior.

## Changelog

### 2026-09-14 — Separate communication membership from execution ownership

Long work must leave Rally's foreground loop without introducing a parallel task
system. Teams provide one communication scope for parents, workers, and Sidekicks;
separate ownership supports descendant stops. Conversation IDs and message
references replace new agent identities, friendship records, and return-routing
machinery. Multi-team membership stays additive, with models managing context.
