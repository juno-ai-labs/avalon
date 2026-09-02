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

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/access-revocation.ts` | The message schema, the publish helpers, the expired-session sweep, and `revocationClosesSocket` — the one place that decides whether a socket belongs to a revocation. Every producer goes through here. |
| `apps/api/src/queues/access-revocation-consumer.ts` | One hop per message: resolve the object, call it, publish the children it names. |
| `apps/api/src/routes/workspace-membership.ts` | The administrator removal route and `DELETE /workspaces/:workspaceId/membership`, where a member leaves for themself. |
| `apps/api/src/services/workspace-service.ts` | `removeMember` and `leaveWorkspace` — end the D1 membership and publish in the same request. Final-member leave suspends the row during atomic workspace abandonment instead of deleting it, but publishes the same membership-wide revocation. |
| `apps/api/src/services/auth-service.ts` | `logout` — publishes for each session row it revoked. |
| `apps/api/src/index.ts` | Queue dispatch by name — ahead of the work-stream maintenance gate, so a retraction is never held by it — and `reapExpiredSessions` on the five-minute cron. |
| `apps/api/src/durable-objects/{workspace-do-sockets,workstream-do,substream-agent,block-dashboard-agent,automation-agent}.ts` | `revokeSocketAccess` on each of the five socket-holding objects. |
| `apps/api/wrangler.{global,eu,test}.jsonc` | The `ACCESS_REVOCATION_QUEUE` producer binding and the consumer settings. |
| `packages/db/migrations/0091_seed_expired_session_revocations.sql` | Marks the expired-session backlog older than seven days revoked so the sweep starts clean, and indexes the query it runs every five minutes. The cutoff matters: marking a row suppresses its announcement forever, and migrations run before the Worker deploys, so anything recent is left for the sweep to announce properly. |

## How it works

### The producer writes the fact and publishes it

**Whoever writes the fact publishes the message, in the same request that wrote
it.** There is no watcher on D1 and no reconciliation pass; a retraction that is
not published does not reach an open socket.

Four producers exist today:

- **A membership ends.** `WorkspaceService.removeMember` deletes the
  `workspace_members` row and publishes with `sessionId: null` — the membership
  is gone, so none of that person's windows is admissible any longer. Their
  session rows are deliberately left alone: every authorization query joins
  membership, so a session stops resolving the moment the row is gone.
- **A member leaves.** `WorkspaceService.leaveWorkspace` deletes the caller's
  membership, or atomically suspends it while abandoning a workspace whose last
  active member is leaving, then publishes the same membership-wide message.
  The self-leave route cannot skip the producer by performing its own delete.
- **A session is revoked.** `AuthService.logout` returns the rows it revoked
  (`RETURNING id, user_id, workspace_id`) and publishes one message per row,
  carrying that session's id. Only the windows that presented that session are
  closed; the person's other windows are still theirs.
- **A session expires.** Nobody performs an expiry, so no request would ever
  publish one. `reapExpiredSessions` is that writer: on the five-minute cron it
  marks up to 200 expired rows revoked and publishes each one.

### The consumer walks the hierarchy, one hop per message

A message names exactly one object. The consumer resolves that object's stub,
calls `revokeSocketAccess`, and receives back the children that object knows
about; each child becomes its own message on the same queue.

```
workspace  ──▶ WorkspaceDO        ──▶ [workstreamIds] + [automationIds]
workstream ──▶ WorkstreamDO       ──▶ [substreamIds] + [blockIds]
substream  ──▶ SubstreamAgent     ──▶ (leaf)
block      ──▶ BlockDashboardAgent ──▶ (leaf)
automation ──▶ AutomationAgent    ──▶ (leaf)
```

The fan-out is queue-driven rather than one long call chain for three reasons: a
hop that fails is retried alone rather than restarting the walk; no single
invocation holds the whole hierarchy open while a hundred objects wake; and the
objects stay ignorant of the transport — they return lists, and the consumer
decides what carries them onward. An object that later needs a different carrier,
or a sixth object type, changes the consumer and nothing else.

An automation is a *sibling* of the work streams under a workspace rather than a
child of one: its room belongs to the workspace, so it hangs off the workspace
hop and is a leaf of its own. Its list comes from `automation_directory` — the
one place the workspace knows an automation exists — filtered to the person's own
authored automations when the message names a user, and unfiltered when a
membership ended and carries none. Only the author can hold an automation socket,
so authorship is the exact list rather than a generous one.

**Only the object knows its own children.** A work stream's participants and a
dashboard's blocks live in that object's SQL storage, not in D1, so no query the
producer could write would enumerate them. That is why the walk exists at all
rather than the producer publishing a flat list.

The lists are deliberately generous. `WorkspaceDO` returns the person's own
viewer rows plus every workspace-scoped work stream, because a workspace-scoped
work stream is readable by any member and can therefore hold a socket the object
never wrote a viewer row for. `WorkstreamDO` names `"0"` — the main substream,
which keeps its historical name and is never listed in `substream_directory` —
alongside the directory rows. A hop that finds nothing to close costs one call.

### What each object does

Four of the five `revokeSocketAccess` methods walk `state.getWebSockets()`, read
the hibernation attachment, and ask `revocationClosesSocket` — one shared
predicate rather than an inline copy each. Those four roles disagree about their own attachments:
`SubstreamAgent` alone makes `sessionId` optional, because a socket accepted
before the command gateway carries none. Written out per role, the natural
`attachment.sessionId !== request.sessionId` reads as *skip* for `undefined`,
which is how the transcript feed came to be exempt from every logout and expiry
in the first place. Shared, a schema change on one role cannot silently diverge
from the rule. Close code
`WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE` tells the desktop this was a retraction
rather than a network drop.

`AutomationAgent` is the fifth, and it does **not** use the shared predicate: it
compares the attachment inline. The two agree on every socket the room can
actually hold, because an automation attachment always carries a `sessionId`,
and they disagree on the one case that predicate exists for — an attachment with
no session, which the shared rule closes and the inline copy skips. Nothing
produces such an attachment here today. It should be reading
`revocationClosesSocket` like its four siblings; a schema change that made
`sessionId` optional would otherwise exempt automation rooms from every logout
and expiry, which is precisely the bug that made the shared predicate exist.

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
- **A message with a `sessionId` closes only that session's sockets.** Closing
  the rest would sign a person out of every window because one of them logged
  out.
- **A message without a `sessionId` closes all of that person's sockets.** It is
  published only when the membership itself is gone, where no window survives.
- **Every hop is idempotent.** A socket already closed is not found again, and a
  re-published list is a list of hops that each find nothing to do. Retries are
  therefore free of consequence, which is what lets the consumer retry at all.
- **An object returns lists; it does not publish.** Keeping the transport in the
  consumer is what keeps the five objects independent of the queue.
- **Every object that accepts a socket is on this walk.** A room admits on a
  ticket and never re-authorizes, so an object added to the tree without a
  `revokeSocketAccess` and a hop to reach it keeps serving somebody who has lost
  access, and nothing will report it.
- **Publishing never fails the request that wrote the fact.** The removal
  committed; failing the response would tell the operator it did not. A producer
  that *can* still retry — the expiry sweep, which owns its own schedule — reads
  the returned flag and leaves the row for the next run instead.

## Boundary

This module owns the path from *access ended* to *socket closed*. It does not
own:

- **Admission.** Whether a socket may open at all is
  [`realtime-sockets.md`](realtime-sockets.md) and the objects' own connect
  paths. This module never re-runs admission; it only closes.
- **Object-local visibility.** Whether one work stream still admits one reader
  is held in that object's SQL — `WorkstreamDO.canRead`, `product.canRead` — and
  the object enforces it itself when it publishes. No message here carries it,
  and none should: it is not a D1 fact, and routing it through a queue would put
  a round trip between a scope change and the reader it excludes.
- **Authorization queries.** Membership and session validity are D1 facts owned
  by `middleware/auth.ts` and the services that write them.
- **What flows over a socket while it is open.** That is
  [`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md).
- **The object hierarchy itself.** [`workstream-durable-object.md`](workstream-durable-object.md)
  owns the work-stream-down objects and
  [`automation-lifecycle.md`](automation-lifecycle.md) owns `AutomationAgent`;
  this module adds one method to each.
- **Choosing a queue over RPC for a new hop.** [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md)
  owns that decision and records this one.

Callers: any Worker code that ends access calls `publishAccessRevocation`. The
`revokeSocketAccess` methods are called by the consumer and by nothing else.

## Failure modes and limits

- **The queue is unavailable when a producer publishes.** Logged as
  `access_revocation_publish_failed` and swallowed. The socket outlives the
  retraction until the client reconnects and fails admission — which every
  desktop does on its own reconnect cycle. The alternative, failing the request,
  reports a removal that did happen as a removal that did not. **This is the
  module's weakest point**: a membership removal has already committed, so a
  dropped message is not retried by anything and that socket keeps receiving
  until it reconnects. Making it durable needs an outbox row written in the same
  D1 write as the retraction, and a sweep that enqueues until delivery; that is
  a real design change and is not built.
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
- **A hop throws.** Logged as `access_revocation_hop_failed` and retried, up to
  `max_retries: 5`, then dead-lettered to
  `avalon-{global,eu}-access-revocations-dead-letter`. A non-empty dead-letter
  queue is the monitoring for this module.
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
  paths (`WorkstreamDO.broadcastMetadata`, `broadcastBlockDashboardEvent`, and
  `SubstreamAgent` on an event that narrows visibility). That is not a second
  answer to this module's question. This module answers "does this person still
  have access to the workspace", which only D1 knows; those checks answer "does
  this work stream still admit this reader", which only that object knows. The
  distinction to hold on to: what was removed from those paths is the **D1**
  read, not the object-local one.
- **Genuinely not covered:** a block's visibility narrowing within a dashboard
  the reader still has access to. That closes on their next reconnect.
- **A revocation is not versioned.** A message names `(workspaceId, userId)` and
  nothing more, so one delayed or dead-letter-replayed message can close sockets
  belonging to a membership that was since restored. Admission decides what
  reopens, so this costs a reconnect rather than access, but a replay procedure
  should confirm the membership is still absent before replaying.

## Testing

| Suite | What it proves |
| --- | --- |
| `pnpm --filter @rally/api exec vitest run test/access-revocation.test.ts` | The producers write and publish, the guards refuse, the route refuses a foreign workspace, the consumer's fan-out publishes the right children — one message per automation the workspace names, and the automation hop stopping as a leaf — and a failed hop retries while an unreadable one is acknowledged. Runs against the checked-in migrations through `sqlite-d1`. |
| `pnpm --filter @rally/api test:workers` | `revokeSocketAccess` on real workerd: sockets actually close, a session-scoped revocation closes only the windows that presented it, and each object names its children. `test-workers/queue-dispatch.test.ts` covers the Worker's own queue entry point, which cannot be imported in the Node suite because it pulls in `cloudflare:workers`. |

Traps:

- The Node suite's `WorkspaceService` path calls `publishWorkspaceSync`, which
  resolves a `WorkspaceDO` stub. A test env therefore needs `AVALON_REGION` and a
  `WORKSPACE_DOS` double even when the test is about the queue.
- The object side needs real hibernation attachments, which is why it lives in
  the workers suite; a Node double of `getWebSockets()` would prove nothing about
  what the runtime hands back after a hibernation round trip.

## Regional impact

The queue is per region — `avalon-global-access-revocations` and
`avalon-eu-access-revocations` — and so is its dead-letter queue. A revocation
never crosses the boundary, because the objects it addresses never do: a session
is bound to one region's workspace, and the consumer resolves stubs through the
same `workspacePlacementAffinity` every other caller uses. Membership discovery
lives in Global, but the sockets do not, so nothing here reads across.

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
