# Access revocation

Every Rally socket is authorized once, when it connects, and then holds until
something closes it. Nothing an object can observe tells it that a session was
revoked or that a membership ended — those facts live in D1, with the Worker that
wrote them. **This module is the one path from such a fact to an open socket:** a
message on a dedicated Cloudflare Queue, and a consumer that walks the object
hierarchy telling each holder to drop what the person has open.

Read this before adding anything that ends somebody's access, before adding a
Durable Object that accepts sockets, and before adding any mechanism that
re-checks authorization on a socket that is already open — the last of those is
the thing this module replaced, and it is not to come back.

Ordinary member search and resource reads use the [authorization primitive](authorization.md):
five-minute freshness is a design goal, not a permission lease or request timeout.
Canonical permission checks share observations only within one batch; persisted grants are not
reused. Queue-maintained attachment discovery can lag source changes, while a
positive result still requires its canonical grant. New requests pass session and
workspace-membership middleware, which reads D1. Checks inside `WorkspaceDO`
(grants, invitations, Space writes, breakout creation, Channel viewer checks)
read its local copy, `workspace_member_status`, which the
`workspace_relationship_changed` consumer updates before it walks a revocation
([`hosted-conversation-parents.md`](hosted-conversation-parents.md#workspace-relationships-are-local)).
This does not relax mutation checks, socket
admission, or local socket visibility/revocation. Missing authority remains a
retryable failure for direct reads and explicit partial status for search/lists.

SubstreamAgent product RPCs reuse a positive session-and-membership observation
in that conversation object's memory for at most 300 seconds, capped by session
expiry. The revocation walk clears it when it reaches that object. Direct object
callers can use cached admission, including for writes, until it expires if the
walk is delayed; ordinary HTTP requests still pass fresh Worker session admission.
A Worker-verified role change refreshes the object's cached role. Socket ticket
admission still reads D1 and existing sockets are closed by the same revocation
walk. The owning mechanism is documented in
[`workstream-durable-object.md`](workstream-durable-object.md).

Membership removal/leave use the durable relationship dispatcher as their sole
immediate producer. The consumer performs revocation and directory synchronization;
the service does not also publish those effects directly. Dispatch failure leaves
the D1 intent for the existing scheduled recovery path.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/access-revocation.ts` | The message schema, the publish helpers, the expired-session sweep, and `revocationClosesSocket` — the one place that decides whether a socket belongs to a revocation. Every producer goes through here. |
| `apps/api/src/queues/access-revocation-consumer.ts` | One hop per message: resolve the object, call it, publish the children it names. |
| `apps/api/src/routes/workspace-membership.ts` | The administrator removal route and `DELETE /workspaces/:workspaceId/membership`, where a member leaves for themself. |
| `apps/api/src/services/workspace-service.ts` | `removeMember` and `leaveWorkspace` — end the D1 membership and immediately dispatch its trigger-recorded relationship intent in the same request. Final-member leave suspends the row during atomic workspace abandonment instead of deleting it, but publishes the same membership-wide revocation. |
| `apps/api/src/services/auth-service.ts` | `logout` — publishes for each session row it revoked. |
| `apps/api/src/worker-events.ts` | Queue dispatch by name — ahead of the work-stream maintenance gate — and session expiry plus durable relationship dispatch on the existing cron. |
| `apps/api/src/services/workspace-relationship-delivery.ts` | Retries D1-recorded membership changes through the existing revocation queue. Queue acceptance marks dispatch, not application. |
| `apps/api/src/durable-objects/{workspace-do,substream-agent,artifact-host-do}.ts` | `revokeSocketAccess` on each socket-holding object. `WorkspaceDO.revokeSocketAccess` also runs every hosted Channel's step (`HostedParent.revokeSocketAccess` in `hosted-parent.ts`) in the same call; `revokeParentSocketAccess` runs one Channel's step for a `workstream` hop. `AutomationDO` holds no socket; the consumer asks it `listChildren` instead. |
| `packages/db/migrations/0091_seed_expired_session_revocations.sql` | Marks the expired-session backlog older than seven days revoked so the sweep starts clean, and indexes the query it runs every five minutes. The cutoff matters: marking a row suppresses its announcement forever, and migrations run before the Worker deploys, so anything recent is left for the sweep to announce properly. |

### The producer writes the fact and publishes it

Membership changes now also write `workspace_relationship_deliveries` through
database triggers in the same transaction. The existing immediate revocation
publishers remain; the cron retries the durable intent if a request failed to
publish. A `workspace_relationship_changed` message first applies the
relationship to `WorkspaceDO`'s `workspace_member_status` (sequence-fenced, so
a redelivery changes nothing), then revokes removed/suspended relationships and
publishes workspace profile, member and directory invalidation. Last, it seats
an active member in General and their Personal Channel
([`spaces.md`](spaces.md#the-personal-channel)), so a failure there retries a
message whose earlier steps are fenced against applying twice. The table goes
first so that a revocation hop that throws, retries or dead-letters has not left
the Organization's own checks answering active for the person it removes.
Promotion invalidates those views without closing otherwise valid conversations.

`dispatched_at` records Queue acceptance; `processed_at` records root handling.
Neither means every descendant has acknowledged application. Failure leaves the
intent pending or the Queue message retryable. A send followed by a failed marker
write can duplicate delivery, so processing remains idempotent. This does not yet
replace session revocation publication or provide the planned per-descendant
completion tracker.

Membership revocation carries its incarnation through every descendant hop.
Each socket or artifact viewer session is compared with its immutable D1 session
binding before closure; a delayed removal closes the old relationship's sessions
without closing sessions admitted after rejoining. Missing legacy session bindings
fail closed. Socket admission already checks the current relationship incarnation.
Promotion preserves the incarnation and does not revoke the conversation.

Revoked workstream grants use their existing durable `scope_grant_directory`
effect as the publication intent. After applying its directory projection,
WorkspaceDO reads the Sidekicks the Channel owns from its own
`automation_directory`, publishes one `automation` hop per Sidekick (nothing when
it owns none), and deletes the effect's outbox row only after Queue acceptance. A failed send retries the effect; repeated
application is safe. The grant's membership incarnation travels with the message.
This connects separately seated Sidekick authoring/run conversations to parent
grant revocation without adding checks to frame publication or ordinary turns.

Other revocation producers still publish in the request that writes their fact.

The producers are:

- **A membership ends.** `WorkspaceService.removeMember` deletes the
  `workspace_members` row and publishes with `sessionId: null` — the membership
  is gone, so none of that person's windows is admissible any longer. Their
  session rows are deliberately left alone: every authorization query joins
  membership, so a session stops resolving the moment the row is gone.
  Organization settings calls this "Suspend" in each roster row's menu.
- **A member leaves.** `WorkspaceService.leaveWorkspace` deletes the caller's
  membership, or atomically suspends it while abandoning a workspace whose last
  active member is leaving, then publishes the same membership-wide message.
  The self-leave route cannot skip the producer by performing its own delete.
- **A room participant is removed.** `WorkstreamService.removeParticipant`
  tells the room, which closes its own sockets, then publishes with
  `sessionId: null` and a `workstream_automations` target naming the room:
  the automations the room owns admitted this person through the room, and
  nothing inside the room reaches those objects.
- **A workstream grant is revoked.** The durable grant-directory effect publishes
  the owned Sidekicks' `automation` hops before acknowledgment. Main and child
  conversation membership is independently handled by participant projections.
- **A session is revoked.** `AuthService.logout` returns the rows it revoked
  (`RETURNING id, user_id, workspace_id`) and publishes one message per row,
  carrying that session's id. Only the windows that presented that session are
  closed; the person's other windows are still theirs.
- **Rally access ends.** `revokeSupportSessions` (`services/support-access.ts`)
  expires support sessions at once, publishes one message per row, and marks
  revoked only the rows it announced. One whose message fails stays expired
  but unmarked, so the expiry sweep below announces it on its next run rather
  than its sockets staying open with nothing left to retry. It runs when an
  Organization revokes Rally access, and when a Juno Labs relationship delivery
  says a staff membership ended, for that membership's incarnation only.
  An expired grant needs no producer: a support session's `expires_at` never
  passes its grant's, so the expiry sweep below closes it.
  [`impersonation.md`](impersonation.md#support-access) owns the mechanism.
- **A session expires.** Nobody performs an expiry, so no request would ever
  publish one. `reapExpiredSessions` is that writer: on the five-minute cron it
  marks up to 200 expired rows revoked and publishes each one.

### The consumer walks the hierarchy, one hop per message

A message names exactly one object. The consumer resolves that object's stub,
calls `revokeSocketAccess`, and receives back the children that object knows
about; each child becomes its own message on the same queue.

```
workspace              ──▶ WorkspaceDO    ──▶ [substreams of every hosted Channel] + [automationIds] + [artifactIds]
                                              (+ a workstream hop per Channel still awaiting its import)
workstream_automations ──▶ WorkspaceDO    ──▶ [automationIds the room owns]  (automationIdsOwnedByWorkstream)
workstream             ──▶ WorkspaceDO    ──▶ [substreamIds]   (revokeParentSocketAccess)
workstream_audience_narrowed
                       ──▶ WorkspaceDO    ──▶ [substreams per closed reader] + [automationIds the room owns]
                                              (revokeNarrowedAudienceAccess)
automation             ──▶ WorkspaceDO    ──▶ [substreamIds]   (listChildren; a Sidekick holds no socket)
space                  ──▶ WorkspaceDO    ──▶ [substreamIds]   (listChildren; a Space holds no socket)
substream              ──▶ SubstreamAgent ──▶ (leaf)
artifact               ──▶ ArtifactHostDO ──▶ (leaf)
```

A Channel's parent, its control sockets and its children all live in
WorkspaceDO, so a hop that reaches WorkspaceDO runs the Channel step there
rather than publishing a `workstream` or `workstream_automations` message that
would only come back to the same object. The workspace hop answers `channels`,
one entry per hosted Channel whose step it ran, beside the full
`workstreamIds`; the consumer publishes a `workstream` hop only for a Channel
not in `channels`. The narrowing hop answers `substreams` and `automationIds`
beside `closedUserIds`. Both keep the older fields so a consumer from before
this change still reaches everything, and the consumer falls back to the older
hops when an object from before it answers without the new ones. The
`workstream` and `workstream_automations` hops stay: Workers still publish
`workstream_automations` for a removed participant, and messages of both kinds
may already be queued at a deploy.

The fan-out is queue-driven rather than one long call chain for three reasons: a
hop that fails is retried alone rather than restarting the walk; no single
invocation holds the whole hierarchy open while a hundred objects wake; and the
objects stay ignorant of the transport — they return lists, and the consumer
decides what carries them onward. An object that later needs a different carrier,
or a sixth object type, changes the consumer and nothing else.

A **live artifact** is a sibling for the same reason, and holds no socket at all:
what it holds is viewer sessions, and one that outlived a membership would keep
serving a page to somebody no longer in the workspace. Its list comes from
`artifact_registry`, which lives in WorkspaceDO beside the resource authority —
so this is the only object that can name artifacts, and a work stream could not.
Its `revokeSocketAccess` drops `viewer_sessions` rows under the same method name
and the same child-naming contract, and returns no children. The list is
deliberately unfiltered by person, matching the generosity the rest of this walk
is built on: resource exposure can grant access through multiple conversations,
so the walk must not infer a viewer list from one parent roster. A hop that finds
no session to drop costs one call. Canonical resource authorization admits the
viewer before the session is minted; serving then trusts that durable session
until this walk removes it or its fixed lifetime expires.

Every child list the consumer reads is defaulted to empty. That is about deploys
rather than tidiness: the consumer and WorkspaceDO are separate deployments of
one Worker, so during a rollout a consumer that knows about a new child kind can
reach an object that does not yet name it, and reading `undefined.map` there
would throw and drop a retraction.

An automation is a *sibling* of the work streams under a workspace rather than a
child of one, and like a work stream it is a parent of conversations: its own
chat is substream `0` under it and each run is a further substream, all of them
`SubstreamAgent`s with sockets. A Sidekick holds no socket, so its hop is the
Organization's `listChildren` for the Sidekick and one `substream` message per child,
keyed by the automation id as the parent. Its list comes from
`automation_directory`, the one place the workspace knows an automation exists,
and is unfiltered by person for the reason the artifact list is: an
automation's conversation admits its author, its run-as principal, any member
when it is workspace-scoped, and any participant of the room that owns it, so
the workspace cannot tell which automations a person holds a socket on, and a
hop that finds nothing to drop costs one call. A room-owned automation has one
more way to lose a reader: the room removes a participant, a write the room
makes locally that no membership revocation follows. The room's writer
publishes a `workstream_automations` hop, and WorkspaceDO names the room's
automations for it.

A **narrowed audience** is the one hop that names nobody. Every other message
is about one person, because every other way access ends names one: a member is
removed, a session is revoked, a participant is taken out of a room. A work
stream that stops being Organization-wide takes access from every member who is
not a participant, which is a set nothing outside the room can enumerate and
nobody wants one message per name for. What *is* enumerable is who is holding a
socket right now, and only the room knows that — so the hop asks it to close
what it can no longer admit and to answer with whose sockets those were. In the
same call WorkspaceDO runs each of those people's Channel step (with the
`workstream_participant_removed` reason the narrowing carries) and reads the
automations the room owns, so the consumer publishes the substream and
automation leaves for each name directly. The message carries `userId: null`, and the schema
refuses that in any other combination: a per-user hop that lost its user would
close every socket it found.

This is the one place an object re-asks its own admission question, and it is
not the polling the invariant below rules out. It runs once, because the
audience it is about was just written; it is the same `authorizeViewer` a
reconnect would run; and a holder it cannot confidently admit is closed rather
than spared, which costs a reconnect where sparing keeps a reader reading a
room that no longer admits them.

A **Space** is the third sibling, and the simplest hop here. Its parent state
is hosted in `WorkspaceDO` under a role whose `admitsClientSockets` is false
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)), so it
admits no client socket and there is nothing on it to close. The hop does not
ask it to revoke anything. A Space created before 2026-09-26 also has a hidden
main conversation, an ordinary `SubstreamAgent` that *does* hold whatever was
opened against it, and only the Space's parent rows name it. So the hop is
`WorkspaceDO.listChildren` for the Space id and one `substream` message per
child, keyed by the Space id as the parent, exactly as an automation's
conversations are keyed by its own; for a newer Space the message reaches an
object holding nothing.

**Only the object knows its own children.** A work stream's participants and a
dashboard's blocks live in Durable Object SQL storage, not in D1, so no query the
producer could write would enumerate them. That is why the walk exists at all
rather than the producer publishing a flat list.

The lists are deliberately generous. `WorkspaceDO` returns the person's own
viewer rows plus every workspace-scoped work stream, because a workspace-scoped
work stream is readable by any member and can therefore hold a socket the object
never wrote a viewer row for. For each of those Channels (inside the workspace
hop, or in a `workstream` hop), `WorkspaceDO` closes that Channel's control sockets (tagged `parent-control:<id>`) and names every child
in the Channel's `parent_children` rows, which always include `"0"`, plus any
substream in `parent_child_projections`. When the reason is
`workstream_participant_removed`, it keeps `"0"` and drops breakouts the person
can still read, because a breakout's roster is its own. A hop that finds nothing
to close costs one call.

### What each object does

Three of the four `revokeSocketAccess` methods walk `state.getWebSockets()`, read
the hibernation attachment, and ask `revocationClosesSocket`, one shared
predicate rather than an inline copy each. Those roles disagree about their own attachments:
`SubstreamAgent` alone makes `sessionId` and the admitted `role` optional,
because sockets accepted before their respective command gateways carry none.
Written out per role, the natural
`attachment.sessionId !== request.sessionId` reads as *skip* for `undefined`,
which is how the transcript feed came to be exempt from every logout and expiry
in the first place. Shared, a schema change on one role cannot silently diverge
from the rule. Close code
`WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE` tells the desktop this was a retraction
rather than a network drop.

A Sidekick has no `revokeSocketAccess` at all: it holds no socket, and the
consumer asks `WorkspaceDO.listChildren` for it and fans out one substream hop per child, so
the conversations under it close through `SubstreamAgent`'s shared predicate
like every other conversation.

`SubstreamAgent` re-broadcasts presence afterwards, because `webSocketClose`
fires only for a *client*-initiated close: without it the people still in the
room would go on seeing an evicted reader listed as present.

## Invariants

- **The queue is the only way an open socket is closed for losing access to the
  workspace.** No object polls, revalidates on a timer, or asks D1 anything while
  publishing. An object still enforces its *own* visibility from its own SQL —
  see [Boundary](#boundary) — and that is a different question, not a second
  answer to this one. The line to hold: no D1 read on a publish path, ever. Adding any of those back reintroduces a per-broadcast D1 read on
  the hot path, and — as the changelog records — an ordering bug that silently
  dropped invalidations. If you are here because you grepped for
  `AUTHORIZATION_REVALIDATE_MS`, `SOCKET_AUTHORIZATION_REVALIDATE_MS`,
  `ACCESS_RETRACTING_TOPICS`, `retractsReadAccess`,
  `evictListenersWhoMayNoLongerListen`, `evictReadersWhoMayNoLongerRead`, or
  `workspace-socket-authorization.ts`: each of those was one of the four
  mechanisms this replaced, and none of them is to come back.
- **The producer publishes in the request that wrote the fact.** A fact written
  without a message is a socket that stays open until it reconnects. If you add a
  way to end access, you add a producer; there is nothing else to catch it.
- **A message names one person, or one room's whole audience, never half of
  each.** `workstream_audience_narrowed` is the only target carried with
  `userId: null`, and the only one that may be; the schema enforces the
  biconditional and names `userId` when it is broken. A per-user hop that lost
  its user would close every socket it found.
- **A message with a `sessionId` closes only that session's sockets.** Closing
  the rest would sign a person out of every window because one of them logged
  out.
- **A message without a `sessionId` closes all of that person's sockets.** It is
  published only when the membership itself is gone, where no window survives.
- **Every hop is idempotent.** A socket already closed is not found again, and a
  re-published list is a list of hops that each find nothing to do. Retries are
  therefore free of consequence, which is what lets the consumer retry at all.
- **An object returns lists; it does not publish.** Keeping the transport in the
  consumer is what keeps the five objects independent of the queue. The one
  exception is WorkspaceDO applying a revoked Channel grant from its own outbox:
  no consumer is involved there, so it publishes the owned Sidekicks'
  `automation` hops itself, as it published the `workstream_automations` hop
  before.
- **Every object that accepts a socket is on this walk.** A room admits on a
  ticket and never re-authorizes, so an object added to the tree without a
  `revokeSocketAccess` and a hop to reach it keeps serving somebody who has lost
  access, and nothing will report it.
- **Publishing never fails the request that wrote the fact.** The removal
  committed; failing the response would tell the operator it did not. A producer
  that *can* still retry (the expiry sweep, which owns its own schedule) reads the
  returned flag and leaves the work for the next run instead. **Every producer
  reads the flag**; one that cannot retry names the refusal in a log rather than
  discarding it, because a discarded `false` is a retraction recorded as
  delivered when nothing was sent.

## Known gaps

### A narrowing published from the Channel's own scope change has no durable gate

`WorkstreamService.update` reads the Channel before the update and publishes
`workstream_audience_narrowed` when its scope goes from `workspace` to
`personal`, and nothing durable
stands behind that send: a refusal is logged
`channel_narrowing_publish_unannounced` and the Organization's non-participant
readers keep whatever sockets they have open until they reconnect.

This is a gap rather than a regression. Before the Spaces branch that path
published *nothing at all*, so the announcement is strictly new and the missing
gate is the part that was never built.

A guest losing a Channel's public threads
([the Channel reader](spaces.md#a-channel-lends-its-public-threads-to-its-guests))
is not announced that way: removed from the Channel, the thread taken out or
moved, or the Channel archived. The narrowing hop finds people only through a
thread's control sockets, and a client that opens conversation sockets
directly holds none, so it would leave the guest's conversation open.
WorkspaceDO's `guestChannelReachMoved` already knows which guests may have
lost the thread; after the write commits it asks the thread whether each can
still read Main, and for each who cannot publishes the `workstream` and
`workstream_automations` revocations a participant removal sends, naming
them, in queue batches of 100. It shares the gap above: a send that fails is
logged `channel_reach_revocation_publish_failed`, and the guest keeps an open
socket until they reconnect.

Closing it means giving the direct narrowing a durable intent of its own, which
is a change with a table behind it rather than a line in this one; it is named
here so the next person to narrow something does not have to rediscover it.

## Boundary

This module owns the path from *access ended* to *socket closed*. It does not
own:

- **Admission.** Whether a socket may open at all is
  [`realtime-sockets.md`](realtime-sockets.md) and the objects' own connect
  paths. This module never re-runs admission; it only closes.
- **Object-local visibility.** Whether one work stream still admits one reader
  is held in that parent's rows — `HostedParent.canRead`, `product.canRead` —
  and the object enforces it itself when it publishes. No message here carries it,
  and none should: it is not a D1 fact, and routing it through a queue would put
  a round trip between a scope change and the reader it excludes.
- **Authorization queries.** Membership and session validity are D1 facts owned
  by `middleware/auth.ts` and the services that write them. `WorkspaceDO`'s
  local copy of each relationship, `workspace_member_status`, is owned by
  [`hosted-conversation-parents.md`](hosted-conversation-parents.md); this
  module's consumer only feeds it.
- **What flows over a socket while it is open.** That is
  [`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md).
- **The object hierarchy itself.** [`hosted-conversation-parents.md`](hosted-conversation-parents.md)
  owns Channel and Space parents inside `WorkspaceDO`,
  [`workstream-durable-object.md`](workstream-durable-object.md) owns the
  conversations under them, and
  [`automation-lifecycle.md`](automation-lifecycle.md) owns Sidekicks;
  this module adds one method to each socket-holding object and reads the
  parent contract's `listChildren` from the one that holds none.
- **Choosing a queue over RPC for a new hop.** [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md)
  owns that decision and records this one.

Callers: any Worker code that ends access calls `publishAccessRevocation`. The
`revokeSocketAccess` methods are called by the consumer and by nothing else.

- **The queue is unavailable when a producer publishes.** Logged as
  `access_revocation_publish_failed` and swallowed by the immediate publisher.
  Membership changes also have a transactional delivery intent; the cron retries
  dispatch until Queue acceptance. A socket can outlive the write until that
  retry is applied or it reconnects and fails admission. Other producers retain
  their retry behavior below; durable membership delivery does not yet fix a
  dropped logout publication.

- **The expiry sweep re-asserts its predicate when it marks.** The rows were
  selected in an earlier round trip and D1 auto-commits between statements, so a
  logout landing in between has already written its own `revoked_at`; marking by
  id alone would overwrite it with the sweep's later timestamp and move the
  recorded moment access ended.

- **The expiry sweep publishes before it marks**, which is what stops the same
  failure being permanent there. Marking first would exclude the row from every
  later sweep, so a transient queue outage would lose that expiry for good; in
  this order the row stays unmarked and the next run retries it. The cost is a
  duplicate message when the mark fails, and a duplicate revocation is a hop
  that finds nothing left to close.

- **A message cannot be parsed.** Acknowledged, not retried — nothing will make
  it readable later, and retrying it only delays the batch behind it. Logged as
  `access_revocation_message_invalid` with the failing field paths and the
  body's `kind`, because a producer and this consumer disagreeing about the
  schema is otherwise invisible: the message is gone from the queue and nothing
  else records it.

- **A logout's message is dropped.** Logged as `session_revocation_unannounced`.
  Unlike expiry there is no later run to pick it up — the row is already
  revoked — so that session's sockets stay open until they reconnect.

- **Batch settings.** `max_batch_size: 10`, `max_batch_timeout: 1`. One message
  is one person losing access and each is handled independently, so batching buys
  fewer invocations and nothing else; the short timeout matters because this
  message is the only thing standing between a revoked session and an open
  socket.

- **`sendBatch` caps at 100 messages**, so `publishDescendantRevocations` chunks.
  A workspace with more than 100 work streams fans out over several sends.

- **The expiry sweep is bounded at 200 rows per run**, which is 40 sessions a
  minute. That is a real ceiling: a sustained expiry rate above it grows a
  backlog indefinitely. It is sized for the steady state, where a five-minute
  window holds a handful of expiries, and the historical backlog is not its
  problem because migration `0091` marked it revoked once. If the ceiling is
  ever reached the visible symptom is expired sessions staying connected longer
  and longer; the fix is paging within one invocation under a time budget, not a
  bigger single page.

- **Not covered by the queue, and deliberately not left to it:** losing
  participation in, or visibility of, one work stream. Those are facts in the
  object's *own* SQL, not in D1, so no producer here can publish them — and the
  object that holds them enforces them itself, synchronously, on its own publish
  paths (`HostedParent.broadcastMetadata` and `SubstreamAgent` on an event that
  narrows visibility). That is not a second
  answer to this module's question. This module answers "does this person still
  have access to the workspace", which only D1 knows; those checks answer "does
  this work stream still admit this reader", which only that object knows. The
  distinction to hold on to: what was removed from those paths is the **D1**
  read, not the object-local one.

- **Genuinely not covered:** a block's visibility narrowing within a dashboard
  the reader still has access to. That closes on their next reconnect.

- **A hop against a retired workspace is done, not failed.** Retirement closes
  every socket an object holds when it writes the tombstone, so a hop that
  reaches a retired object has nothing left to find. `revokeSocketAccess` is
  permitted on every gated class, and the permit covers the whole call rather
  than that one method name; the enumerations the other hops ask for
  (`listChildren`, `automationIdsOwnedByWorkstream`) stay refused, and the
  consumer acknowledges that refusal through `isRetirementRefusal` rather than
  retrying it — a retry would dead-letter one message per retired object,
  spending this module's own monitoring signal on a condition somebody designed.
  See [`workspace-retirement.md`](workspace-retirement.md#background-callers).

- **A revocation is not versioned.** A message names `(workspaceId, userId)` and
  nothing more, so one delayed or dead-letter-replayed message can close sockets
  belonging to a membership that was since restored. Admission decides what
  reopens, so this costs a reconnect rather than access, but a replay procedure
  should confirm the membership is still absent before replaying.

## Testing

| Suite | What it proves |
| --- | --- |
| `pnpm --filter @rally/api exec vitest run test/access-revocation.test.ts` | The producers write and publish, the guards refuse, the route refuses a foreign workspace, the consumer's fan-out publishes the right children (one message per automation the workspace names, and one substream hop per child the automation lists), and a failed hop retries while an unreadable one is acknowledged. Runs against the checked-in migrations through `sqlite-d1`. |
| `pnpm --filter @rally/api test:workers` | `revokeSocketAccess` on real workerd: sockets actually close, a session-scoped revocation closes only the windows that presented it, and each object names its children. `test-workers/queue-dispatch.test.ts` covers the Worker's own queue entry point, which cannot be imported in the Node suite because it pulls in `cloudflare:workers`. |

Traps:

- The Node suite's `WorkspaceService` path calls `publishWorkspaceSync`, which
  resolves a `WorkspaceDO` stub. A test env therefore needs `AVALON_REGION` and a
  `WORKSPACE_DOS` double even when the test is about the queue.
- The object side needs real hibernation attachments, which is why it lives in
  the workers suite; a Node double of `getWebSockets()` would prove nothing about
  what the runtime hands back after a hibernation round trip.

## Security and trust model

The message is trusted: it is written by our own Worker and read by our own
consumer, and it carries no authority beyond *close this person's sockets*. A
malformed one is dropped rather than acted on.

`revokeSocketAccess` is deliberately given less than the full message — reason,
workspace, user, session, and nothing else. An object has no use for the target
that addressed it and no business deciding whether the retraction was
legitimate; it closes what it is told to close.

The membership route is the one protected route that names a workspace in its
path rather than taking it from the session, so it refuses a path that names a
different workspace before the service sees it. Without that check the parameter
would be a way into somebody else's workspace.

## Operations

- `access_revocation_publish_failed` — a fact was written but no message went
  out. The affected sockets stay open until reconnect.
- `access_revocation_hop_failed` — one object could not be reached; the hop is
  retrying.
- `access_revocation_message_invalid` — a producer and this consumer disagree
  about the schema; a deploy is mid-flight or a producer is wrong.
- `workspace_socket_access_revoked` — the successful case, with the socket count.
- The dead-letter queues are the alarm: empty is healthy, non-empty means
  somebody kept access they should have lost.

## Changelog

### 2026-10-07 — Organization settings can suspend a member

**What changed:** Each row in the Organization settings roster has a menu, and
its "Suspend" item, after a confirmation, calls the existing
`DELETE /workspaces/:workspaceId/membership/member/:userId`, which had no
client caller until now.

**Why:** Administrators had no way in the product to take someone out of an
organization. The removal write and its revocation publish already existed, so
the menu reuses them rather than adding a second way to end a membership.

**Considered and rejected:** A new `status = 'suspended'` write that keeps the
row. `listMembers` hides suspended rows, so nobody could see a suspended person
to restore them, and the `suspended` status today means "the last member left
and the workspace closed". Removal is the reversible option that exists: an
invitation brings the person back.

**Consequences:** "Suspend" in the UI is removal on the server. If suspension
ever needs to be undone in place, it needs its own status, a roster that shows
it, and a restore write; this entry is where that change should start.

### 2026-09-25 — The Channel step runs inside the Organization object

**What changed:** `WorkspaceDO.revokeSocketAccess` runs every hosted Channel's
step (close its control sockets, name its conversations) in the same call and
answers `channels`; the consumer publishes substream leaves for those and a
`workstream` hop only for a Channel still awaiting its legacy import.
`revokeNarrowedAudienceAccess` also answers each closed reader's conversations
and the Channel's owned Sidekicks, so the consumer publishes leaves instead of a
`workstream` and a `workstream_automations` hop per reader. A revoked Channel
grant applied from WorkspaceDO's outbox publishes `automation` hops from its own
`automation_directory`, and nothing when the Channel owns none. The
relationship consumer applies the event to `workspace_member_status` before the
revocation walk rather than after it: WorkspaceDO's checks now read that table,
and after the walk a failing hop left it saying active for as long as the
message retried.

**Why:** Channel parents moved into WorkspaceDO, so each of those intermediate
messages was a Queue round trip from WorkspaceDO back into WorkspaceDO before a
conversation heard. A membership removal paid one per revocable Channel. The
revocation reaches the conversations one Queue hop sooner, with fewer messages.

**Considered and rejected:** Importing a pending legacy Channel inside the
workspace hop, which would put a remote call per such Channel into one
invocation; it keeps its own hop instead. Dropping `workstreamIds` from the
answer, which would leave a consumer from before `channels` reaching no Channel
during a rollout.

**Consequences:** The workspace hop is now one invocation per Organization
whatever its Channel count, bounded by the in-memory walk over its hosted
Channels and a D1 session read per matching control socket when the message
carries an incarnation. The `workstream` and `workstream_automations` hops and
the consumer's fallbacks are still needed for Worker producers and for
messages queued before a deploy.

### 2026-09-21 — Artifact serving trusts admitted sessions until retraction

**What changed:** ArtifactHostDO no longer re-runs canonical resource
authorization for every authenticated document and asset request. The open path
proves access once, and the durable viewer-session row remains the serving
capability until this queue deletes it or its fixed lifetime expires.

**Why:** Per-request polling duplicated the admission decision across every
asset and made a page's latency proportional to the number of requests it made.
It also made the queue advisory for the revocations it already owns. An admitted
session should assume access until the authority publishes contrary evidence.

**Considered and rejected:** A periodic visibility TTL still places D1 and
WorkspaceDO on the serving hot path and introduces a staleness number unrelated
to the durable revocation mechanism. New cache infrastructure was unnecessary;
the viewer-session row is already durable and bounded by expiry.

**Consequences:** Resource-scope changes that do not currently publish an
artifact-session retraction leave an existing session usable until its 24-hour
expiry. If those changes need immediate interruption, their writers must extend
this existing walk; they must not restore per-request authorization polling.

### 2026-09-19 — A Space is a hop that names children and closes nothing, and a narrowing asks the room who is still reading

**What changed:** The target union gains `{ scope: "space", spaceId }`, and the
consumer resolves it through `SPACE_DOS`, calls `listChildren`, and publishes one
`substream` message per child keyed by the Space id. It does not call
`revokeSocketAccess`.

`workstream_audience_narrowed` joins the target union,
carried with `userId: null`, and `WorkstreamDO.revokeNarrowedAudienceAccess`
closes the sockets it can no longer admit and answers with whose they were. The
consumer turns each of those names into the ordinary `workstream` and
`workstream_automations` hops. Both narrowings publish it: a Space's retraction
when its plan sets `narrowScope`, and `WorkstreamService.update` when the
Channel's own scope goes from `workspace` to `personal`.

**Why:** A Space is `WorkstreamDO` under a role that refuses client socket
upgrades, so the object itself holds nothing this queue exists to close. Its
hidden main conversation is an ordinary `SubstreamAgent` and does hold what was
opened against it, and only the Space knows that conversation exists.

Neither narrowing published anything at all. A work stream that stopped
being Organization-wide left every member who was reading it still reading it,
because the room closes sockets only for somebody it was *told* about and a
narrowing tells it about nobody. The set it takes access from is the
Organization minus the participants, which no producer can enumerate and which
would be absurd to publish a message per name for.

**Considered and rejected:** Reusing the `workstream` hop by passing the Space id
as a work-stream id. It would resolve a *real object* — a different, empty one in
`WORKSTREAM_DOS` — rather than failing, leaving the Space's conversation open
with nothing reporting a problem. Also rejected: calling `revokeSocketAccess`
anyway for symmetry with the work-stream hop, which buys one subrequest per Space
per revocation to be told what the role already guarantees.

publishing one per-user message for the departing
Space's roster, which is bounded and was tempting. It is the wrong set twice
over — those readers usually *keep* access through the seating the retraction
does first, and it names none of the members who were reading through the wide
scope. Also rejected: having the canonical `update` close the sockets inside the
room. That reaches the room's own sockets and nothing else, and the automations
it owns are exactly the case `workstream_automations` exists for.

**Consequences:** Nothing publishes this target yet — no product path creates a
Space, and the workspace hop enumerates Spaces only once WorkspaceDO holds the
Space directory. The hop and its fan-out are in place and tested so that the
release which creates Spaces does not also have to add the walk.

the `userId` biconditional. Adding a
target that names nobody means adding an object method that decides for itself
who lost access, because `revokeSocketAccess` cannot be told "everybody" — and a
per-user target that ever arrives without its user must fail by name rather than
fan out.

### 2026-09-16 — Recover membership and grant revocation publication

The membership transaction now records a delivery intent. Removal, leave and guest promotion
immediately dispatch that intent to the existing revocation queue; the cron
recovers interrupted publication. Direct removal fanout was removed because it
duplicated the same revocation and directory invalidation. This closes the gap where a
committed removal could lose its only queue publication. Active relationship
changes publish directory/profile invalidation; removals and suspension use the
same object walk. Queue acceptance and root processing have separate markers;
neither claims descendant completion. Real-workerd tests exercise real D1, queue
sends, WorkspaceDO invalidation and WebSocket closure, including recovery after
a send succeeds but its D1 marker fails. Revocation also carries the removed
incarnation through the walk and checks each session binding before closure;
using user ID alone would let a delayed removal disconnect a rejoined member.
Parent-grant directory delivery also publishes the existing owned-Sidekick
revocation hop before acknowledgment. Its ordinary participant projection cannot
reach those sibling conversation objects. Reusing the durable effect and queue
walk avoids polling and per-frame permission calls. Per-descendant acknowledgment
remains unfinished.

### 2026-09-08 — A retired object's refusal ends the hop

**What changed:** `consumeAccessRevocationQueue` acknowledges a message whose
hop met a `workspace_retired` refusal (`isRetirementRefusal`), logging
`access_revocation_hop_terminal`. Retirement itself now closes every socket an
object holds, so the permit on `revokeSocketAccess` is no longer what keeps a
retired workspace's sockets closed.

**Why:** The `automation` and `workstream_automations` hops call `listChildren`
and `automationIdsOwnedByWorkstream`, neither permitted; and the workspace hop
against a retired workspace — which `reapExpiredSessions` publishes on every
expired session — answered with its automation ids, so every retired workspace
with an automation and a session produced a dead letter by construction.

**Considered and rejected:** Permitting the two enumerations — they are product
reads, and the same class of defect recurs with the next method this consumer
calls; a rule at the consumer holds for all of them.

**Consequences:** A new hop kind needs no permit; its refusal is acknowledged.
A retired workspace still receives revocation messages for its expired
sessions, each acknowledged with one info line.

### 2026-09-05 — Parent access and membership incarnation both fence child admission

The child authorization branch now checks Main-derived parent visibility as well
as ready status and active child membership. Signed membership versions must
equal the local mirror, not merely be older than it: removal followed by re-add
must not revive a previously issued ticket. Workerd regressions cover both
parent removal while child membership remains active and old-ticket replay
after re-addition.

### 2026-09-04 — Private-child removal has a durable local revocation leg

**What changed:** WorkstreamDO participant add/remove operations persist a
versioned parent-to-child effect before delivery. SubstreamAgent applies it only
to an already-provisioned exact child, updates the local participant mirror and
closes removed readers. Effects for reserved or failed children are not alarm
work; ready publication first delivers that child's pending initial roster.

**Why:** Closing only on ticket expiry leaves an already-open private branch
readable after removal, while an unrecorded RPC to the child can be lost between
the parent write and delivery.

**Considered and rejected:** A plain parent write followed by best-effort RPC,
and reusing the workspace-wide Queue for this same-object-region relationship.
The parent outbox is the smaller durable boundary and makes readiness depend on
the mirror actually existing.

**Consequences:** The per-user membership version, not a global child counter,
fences tickets; changing user B never invalidates user A's unchanged receipt.

### 2026-09-04 — The walk reaches every automation a person could read, and a lost room

**What changed:** `WorkspaceDO.revokeSocketAccess` names every non-deleted
automation for a user revocation instead of only the ones the person
authored. A new `workstream_automations` target, published by
`WorkstreamService.removeParticipant` with the reason
`workstream_participant_removed`, is answered by
`WorkspaceDO.automationIdsOwnedByWorkstream` and fans out to one `automation`
hop per automation the room owns.

**Why:** Pull request review. `AutomationDO.authorizeViewer` admits any
member on a workspace-scoped automation and any room participant on a
room-owned one, but the walk narrowed to the author, so a removed member's
sockets on every other readable automation and its runs outlived their
membership. Removing a room participant published nothing at all: the room
evicted its own readers locally, and the automations it owns, which had
admitted the person through the room, never heard.

**Consequences:** A membership revocation costs one hop per automation in the
workspace, most of which find nothing to drop, the same trade the artifact
list already made. A room participant's removal is now a producer like the
other four, with the same rule: it publishes in the request that wrote the
fact.

### 2026-09-03 — The automation hop lists children instead of closing a room

**What changed:** The `automation` target resolves `AutomationDO`, asks it
`listChildren`, and publishes one `substream` hop per child with the automation
id as the parent; the automation object has no `revokeSocketAccess`. The
`workstream` hop names the children `conversation_children` registers, plus any
that spoke before the registry existed.

**Why:** The automation object stopped holding a socket: its chat and its runs
are `SubstreamAgent`s under it, and the parent contract's `listChildren` is
what any parent answers. Reusing the substream hop means a conversation closes
the same way whichever kind of parent it has, through the one shared predicate,
which also retires the inline attachment comparison the previous entry of
2026-08-28 recorded as a divergence to fix.

**Consequences:** The workspace's automation list is still filtered by
authorship when a user is named, while an automation's conversation admits more
than its author for a workspace-scoped automation, so a non-author reader's
socket on such a conversation is outside the walk until that filter is widened
the way the work-stream list's is. Recorded rather than fixed here: it is the
list's generosity to change, not the hop's.

### 2026-09-01 — Closing the room socket ends its message authority

**What changed:** The SubstreamAgent socket now spends its admitted attachment
identity for `create_message` instead of sending the command through WorkspaceDO
for a second session query. The existing revocation walk still closes that
socket for workspace, work-stream, participant, or session loss.

**Why:** Admission already verifies membership and local readability, and the
queue is the system's one mechanism for ending open-socket access. Re-asking D1
on every message made the revocation queue advisory for writes and added a
second, slower authority boundary.

**Considered and rejected:** Polling or per-command session verification would
put D1 back on the hot path and allow its answer to race the queue that closes
all sibling sockets. Trusting attachment identity without the close walk would
let a disconnected authority continue writing, so the two changes cannot be
separated.

**Consequences:** A successful revocation delivery is now both read and write
revocation proof. New authorization-loss cases must extend the same walk rather
than adding a command-local check.

### 2026-09-01 — ArtifactHostDO joins the walk, holding sessions rather than sockets

**What changed:** A live artifact's supervisor is now a child the workspace hop
names, from `artifact_registry`. Its `revokeSocketAccess` drops viewer-session
rows and returns no children. Every child list the consumer reads is defaulted
to empty.

**Why:** An artifact keeps its own viewer sessions, and nothing it can see would
tell it a membership ended — the same reason every other object is on this queue.
It hangs off the **workspace** rather than a work stream because
`artifact_registry` lives in WorkspaceDO beside the resource authority, and this
module's rule is that only the object holding a list can name its children; the
work-stream framing that was first drafted would have needed a second copy of a
fact WorkspaceDO already owns, which is the divergence that rule exists to
prevent.

The defaults are about rollouts, not tests: the consumer and WorkspaceDO are
separate deployments of one Worker, so a consumer that knows about artifacts can
reach an object that does not yet name them, and `undefined.map` there would
throw and drop the retraction rather than merely reaching nothing new.

**Considered and rejected:** filtering the artifact list by principal, to cut the
fan-out. An artifact is readable by anyone who can see its work stream, so
WorkspaceDO cannot tell which artifacts a person holds a session on without
asking every work stream a question it would then have to cache — and the
generous-list precedent already accepts that a hop finding nothing costs one
call.

### 2026-08-31 — Self-leave and final-member abandonment publish the membership revocation

**What changed:** `DELETE /workspaces/:workspaceId/membership` is the fourth
producer. Ordinary leave deletes the caller's membership; final-member leave
suspends it while setting `abandoned_at`. Both publish a message without a
session id, so every socket that membership held closes through the existing
walk.

**Why:** Multiple workspaces make leaving a normal account action rather than
an administrator-only removal. Committing that membership transition without a
publish would leave the departed workspace live on another device until its
next reconnect.

**Considered and rejected:** Revoking only the desktop session that issued the
leave. A membership can have several regional sessions and open sockets, and
abandonment must close all of them rather than the one device that confirmed it.

**Consequences:** Every future self-service membership exit must continue to
publish in the request that writes the transition. Operator reversal of an
abandoned workspace is a separate, paired membership reactivation and does not
reopen old sockets.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-28 — AutomationAgent joins the walk as a sibling of the work streams

**What changed:** The revocation target union gains an `automation` scope.
`WorkspaceDO.revokeSocketAccess` now returns `automationIds` alongside
`workstreamIds` — the person's own authored automations when the message names a
user, every non-deleted one when a membership ended and it names none — and the
consumer publishes one hop per automation, which `AutomationAgent.revokeSocketAccess`
answers by closing that person's rooms. It is a leaf.

**Why:** `AutomationAgent` holds its own hibernating socket, and like every other
room here it admits on a ticket and never re-authorizes. Without this hop, a
member removed from a workspace kept a live draft feed — snapshots and compiler
narration included — until their client happened to reconnect. This is the
failure the module exists to prevent, and a new socket-holding object is exactly
where it comes back.

**Considered and rejected:** Hanging automations off the work-stream hop, which
is where a generated run's work stream already is. An automation is a workspace
sibling, not a child of any one work stream, and threading it through the
work-stream walk would have made a draft with no runs unreachable. Deriving the
list from the Durable Object namespace instead of `automation_directory`, which
is the enumeration rule the automation cutover deliberately refused — the
administrative namespace is not a product index.

**Consequences:** `automation_directory` is now load-bearing for revocation, so a
row that is missing or stale by author is a room the walk does not reach; the
directory's own author column is a security-relevant field, not just a filter.
The next socket-holding object has to be added here too, and there is no test
that would fail if it were not. One rough edge is deliberately left in place and
recorded above: `AutomationAgent` compares the attachment inline rather than
through `revocationClosesSocket`, which is safe only while its attachments always
carry a session.

Shipped in the pull request for this change. Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md).

### 2026-08-22 — Review pass: the queue owns workspace access, the object owns its own

**What changed:** Six fixes from review, all on the mechanism this module made
load-bearing. Revocations now dispatch ahead of the work-stream maintenance gate
in the queue handler. `SubstreamAgent` closes a socket whose attachment carries
no `sessionId` instead of skipping it. `removeMember`'s delete re-asserts the
caller's own active membership in the same statement. The expiry sweep publishes
before it marks. Migration `0091` marks every already-expired session revoked and
indexes the sweep's query. And — the substantive one —
`WorkstreamDO.broadcastMetadata`, `broadcastBlockDashboardEvent`, and
`SubstreamAgent`'s publish path enforce *object-local* visibility again, which
the first pass had removed along with the D1 read.

**Why:** The first pass treated "an object must not re-check authorization
before publishing" as one rule, and it is two. Asking **D1** whether somebody is
still a workspace member is a question the object cannot answer, costs a round
trip on a hot path, and produced the waterline ordering bug — that read is gone
for good. Asking its **own SQL** whether this work stream still admits this
reader is a question only that object can answer, is synchronous, and has no
alternative: no queue message carries work-stream scope, because scope is not a
D1 fact. Removing it did not delay a retraction, it stopped enforcing one — an
excluded reader's open socket kept receiving the live transcript, title,
description and preview until the window closed, which for a desktop left open
is days. That is a content-visibility regression against the previous behaviour,
not a latency trade.

The other five are holes in the single mechanism. The maintenance gate threw
before the queue was dispatched, so during maintenance — including the ordinary
version-skew window of a rolling deploy — every revocation retried five times and
dead-lettered while the cron kept producing more. `undefined !== "<id>"` exempted
pre-command-gateway transcript sockets from every logout and expiry. Two owners
removing each other concurrently both passed the guards and both deletes landed,
leaving no owner. Marking a session revoked before publishing made a transient
queue failure permanent. And nothing has ever deleted from `sessions`, so the
sweep's first run would have drained years of dead sessions at a full workspace
fan-out each, against a query no index could serve.

**Considered and rejected:**

- *Documenting the work-stream case as a known gap rather than fixing it*, which
  is what the first pass did. The doc called it "takes effect on the next
  reconnect", which described a delay; the code had stopped enforcing it
  entirely. A note cannot stand in for a check that used to exist.
- *Routing work-stream visibility through the queue too*, for symmetry. It puts a
  queue round trip between a scope change and the reader it excludes, and makes
  one object's private SQL into a message contract.
- *Returning no children from `WorkspaceDO.revokeSocketAccess` when it closed
  nothing*, to cut the fan-out for dead sessions. It assumes a child socket
  cannot outlive its window's workspace socket, which nothing guarantees; the
  seeding migration removes the same cost without betting on that.

**Consequences:**

- **Two questions, two mechanisms, and they must not be merged again.** A future
  reader who deletes the `canRead` checks "because the queue handles revocation"
  will reintroduce exactly this regression. The rule is narrower than it looks:
  no *D1* read on a publish path.
- **`0091` must run before the first deploy of the sweep**, or that deploy spends
  its first hours fanning out revocations for sessions that expired years ago.
- **A revocation is still not versioned**, so a replayed message can close
  sockets of a membership since restored. Costs a reconnect, not access.
- **The durable-producer gap stands**: a dropped publish on the membership path
  is retried by nothing. Stated in Failure modes; an outbox is the fix and is not
  built.

Shipped in #229.

### 2026-08-22 — A queue is the only way an open socket loses access

**What changed:** A dedicated Cloudflare Queue now carries every retraction. The
Worker that writes the fact publishes a message; a consumer walks
`WorkspaceDO → WorkstreamDO → {SubstreamAgent, BlockDashboardAgent}`, closing
that person's sockets at each object and publishing the children each one names.
`DELETE /workspaces/:workspaceId/membership/member/:userId` and
`reapExpiredSessions` are new, and `logout` now publishes for the sessions it
revoked. Four older mechanisms are gone: `WorkspaceDO`'s periodic
revalidate-before-publish sweep and its `workspace-socket-authorization` helper,
`SubstreamAgent`'s reader eviction on a revalidation interval,
`BlockDashboardAgent`'s time-based re-authorization of subscribed sockets, and
`WorkstreamDO`'s per-broadcast `workspace_members` reads.

**Why:** The old mechanisms were each an object trying to discover, on its own,
something only D1 knew — and they discovered it late, on a timer, at the cost of
a D1 read on every broadcast. They also produced a real bug: the revalidation
sweep put an `await` between waterline allocation and send, which let a
concurrent publication overtake it, and the desktop's `waterline <= lastWaterline`
guard then dropped the invalidation silently. Fixing that inside the sweep meant
serializing publication behind a queue in the object, which is a lot of machinery
to make a mechanism work that was answering the wrong question in the first
place. The fact is known exactly once, in the request that writes it; publishing
it there is both immediate and cheaper than any number of objects polling for it.

**Considered and rejected:**

- *Keeping revalidation and fixing the ordering.* Hoisting the `await` above the
  waterline allocation — the obvious fix — crashed workerd outright
  (`kj/async.c++:2191: failed: Promise callback destroyed itself`), reproducibly,
  isolated to that single move. The serialize-publication fix that replaced it
  worked, but it was a queue inside a Durable Object to compensate for a design
  that re-asks a question nobody had answered yet.
- *Having each object publish its own children.* Rejected after a fork in the
  discussion: it couples every object to the queue binding and to the message
  schema, for no gain over returning a list. In a distributed system, couple
  lightly or not at all — the objects answer with what they know, and one place
  decides what carries it.
- *One RPC call chain instead of a queue.* A single invocation would hold the
  whole hierarchy open, and one unreachable object would restart the walk from
  the top. Per-message retry is the entire point.
- *Moving work-stream participation into D1* so a single query could enumerate
  the fan-out. That is a second authority for a fact the object already owns, and
  it would have to be kept correct forever to serve one code path.

**Consequences:**

- **Anything that ends access must publish.** There is no sweep to catch what a
  producer forgot; a missing message is a socket that stays open until reconnect.
- **Two retractions no longer reach an open socket at all**: losing participation
  or visibility on a single work stream, and a block's visibility narrowing.
  Those facts live in object storage, so the D1-fed queue cannot see them. They
  take effect on the next reconnect. Picking this up means giving `WorkstreamDO`
  a producer of its own, which is a real design question — an object publishing
  to a queue it currently knows nothing about — and it was out of scope here.
- **`removeMember` has no last-owner check**, because it cannot be reached: only
  an owner may remove an owner, an owner may not remove themselves, and a role is
  only carried by an active membership. A future change that relaxes any of those
  three has to add the count back.
- **The dead-letter queues are the monitoring.** There is no other signal that a
  revocation did not land.

Shipped in #229.
