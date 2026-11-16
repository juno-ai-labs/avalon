# Canvas share federation

A Canvas explicitly shared with a **guest** of its Organization also appears in
the Canvas list of every other Organization that person opens, on the Mac, in
the browser and in the Expo app, with the Canvas's Organization's initial on
its top right. The server sends these rows; clients only draw them.

Only guests: a member of the Canvas's Organization never has its Canvases
federated, even ones explicitly shared with them, and a Canvas a person reaches
only because it is open to the whole Organization or to a writer Sidekick's
audience is never federated. A guest reaches a Canvas only from its participant
list, so for a guest "explicitly shared" and "on the list" are the same thing.

The shape is **invalidate, don't replicate**, as Google Drive's "Shared with
me" and Slack Connect hold a reference rather than a copy: the Canvas's own
Organization answers, every time a list is built, which of its Canvases are
shared with that guest. A change there only tells the guest's other
Organizations to rebuild. Nothing about a Canvas (its title, look, activity) is
stored outside its Organization, and an Organization's object neither reads
another Organization nor builds a list: the Worker builds it and the object
relays it.

The guest can turn it off under Settings › Account › Preferences (**Show
shared Canvases in every Organization**, on by default). The switch is stored
for the person in the regional D1, so it covers every Organization and device.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/canvas-share-federation.ts` | The refresh message, the origin's answer, the shared row, the `workspace_shared_canvases` socket event and the setting. |
| `apps/api/src/durable-objects/canvas-share-federation.ts` | The origin half: WorkspaceDO migration 151 (triggers only) and the query behind `guestSharedCanvases`. |
| `apps/api/src/durable-objects/workspace-do.ts` | Hooks only: the alarm that queues a refresh, the subscribe that queues one, `guestSharedCanvases`, and `relayToPerson`, a generic relay of a frame to one person's sockets. |
| `apps/api/src/services/shared-canvases.ts` | The Worker builder: which Organizations the person is in and a guest of, asking each origin, building each target's list and relaying it; the switch. |
| `apps/api/src/services/interactive-queue.ts`, `queues/interactive-consumer.ts` | The `shared_canvases_refresh` kind and its handler ([`interactive-queue.md`](interactive-queue.md)). |
| `packages/db/migrations/0135_shared_canvases_settings.sql` | The switch. |
| `apps/api/src/routes/shared-canvases.ts` | `GET` and `PUT /workspace/me/shared-canvases`. |
| `apps/desktop/src/renderer/lib/shared-canvases.ts`, `lib/workspace-socket.tsx` | The socket-owned list and the switch's read and save. |
| `apps/desktop/src/renderer/components/other-organization-canvas.tsx` | The badged sidebar row, the card badge, and opening a Canvas in its Organization. |
| `apps/browser/src/mobile.tsx`, `apps/mobile/src/Dashboard.tsx` | The Expo snapshot's `sharedElsewhere` and the native card ([`mobile-canvas-client.md`](mobile-canvas-client.md)). |

## How it works

1. **The origin's outbox.** Triggers queue one `_internal_durable_alarms` entry
   keyed by the person's user id whenever what they could see may have
   changed: they were added to or taken off a Canvas's list; a Canvas they are
   on was renamed, re-iconed, archived or deleted; or their relationship to
   this Organization changed (a guest promoted, removed or suspended). People
   this object knows to be members queue nothing. A Canvas's date alone queues
   nothing, so a Chat message never fans out. There is no backfill: lists are
   built from the Canvases themselves on every subscribe.
2. **Invalidation.** The alarm sends `shared_canvases_refresh` (scope `others`)
   on the interactive queue: rebuild this person's list in every other
   Organization they are in.
3. **On subscribe.** After a socket's subscribe answer (never ahead of it) the
   Organization queues `shared_canvases_refresh` (scope `this`) for that
   person. A support session's socket queues none.
4. **The build, in the Worker.** It reads the person's active Organizations in
   this region from D1, and asks each one they are a **guest** of, once,
   `guestSharedCanvases`. That Organization checks the person's relationship
   itself (`readRelationship`) and answers only for an active guest: the
   Canvases they are on the list of, did not make and that are not archived.
   For each target Organization it builds the list from every other origin,
   newest first, at most the sidebar list's own bound (`SIDEBAR_LIST_LIMIT`),
   with each Organization's name from D1, or an empty list while the switch is
   off.
5. **The relay.** The target Organization's `relayToPerson` sends the frame to
   the person's subscribed sockets, leaving out support sessions. Before
   reading anything, the build takes a ticket from each target
   (`relayTicket`), strictly increasing per (person, channel); the relay drops
   a frame whose ticket is not newer than the last one sent, so a slow build
   cannot land after a newer one, even one started in the same millisecond.
6. **The switch.** `PUT` saves it and, after answering, rebuilds every
   Organization the person is in.
7. **The clients** apply the event to one query and merge it into the home
   grid and the sidebar by date (or name). A shared row has no menu, drag or
   pin and never shows unread. Choosing one opens it in its Organization: on
   the Mac through the deep-link queue, in the browser and Expo through its
   canonical page.

## Invariants

- **Nothing about a Canvas leaves its Organization at rest.** The only stored
  state is the person's switch.
- **The origin decides every time,** for one person, and only for an active
  guest of its own on the Canvas's list.
- **An Organization's object only relays.** It neither reads another
  Organization nor builds a list; `relayToPerson` knows nothing of Canvases.
- **A support session never receives this list.** Its grant covers one
  Organization; the list spans others.
- **A newer build always wins** in what a socket last received.

## Boundary

Who a Canvas is shared with is [`canvases.md`](canvases.md)'s. The socket and
its subscribe answer are [`realtime-sockets.md`](realtime-sockets.md)'s. A
guest relationship and switching Organization are
[`multiple-workspaces.md`](multiple-workspaces.md)'s.

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| An origin Organization cannot answer during a build | `shared_canvases_origin_unread` with its id and a code; its Canvases are left out of that frame, the rest still show. A retired one is skipped silently. |
| A target Organization cannot be relayed to | `shared_canvases_relay_failed` with its id and a code; its sockets get the list on their next subscribe. |
| A refresh cannot be queued after a subscribe | `shared_canvases_refresh_unsent`; the next change or subscribe rebuilds. |
| A refresh message fails as a whole (D1 unreadable) | The interactive queue retries it, then dead-letters it. |
| A rename, re-icon or archive | Rebuilds the guest's other lists. Activity alone rebuilds nothing; a list built for another reason reads the current dates. |
| The first time an Organization answers for a guest | Caching their relationship queues one extra, idempotent rebuild of their other Organizations. |
| A person in another data region | Not federated: each region builds from its own Organizations and user ids. |

## Testing

- `apps/api/test-workers/canvas-share-federation.test.ts` — on real
  WorkspaceDOs and sockets: a guest's Canvas shows in their own Organization
  and follows its rename and unshare; a member explicitly added is not
  federated; a guest promoted to member loses it; a support session receives
  nothing; an older frame is dropped. Each was proven by removing what it
  covers: the origin's guest check, the support-session skip, the ordering
  check and the relationship trigger.
- `apps/api/test/shared-canvases.test.ts` — the D1 reads against the
  checked-in migrations: active Organizations and guest status, the switch.
  Proven by dropping the active-membership filter.
- `apps/desktop/src/renderer/lib/workspace-socket.test.tsx`, the Canvas home and
  sidebar tests, and `apps/mobile/src/protocol.test.ts` cover the clients.

## Performance and cost

A build costs two D1 reads, one call to each Organization the person is a
guest of, and one relay per target. A subscribe builds one target; a change
builds every other Organization the person is in. A person in no Organization
as a guest costs a subscribe one queue message and one D1 read.

## Regional impact

Each region builds only from its own Organizations. A guest in a Canvas's
Organization in another region does not see it here.

## Changelog

### 2026-11-16 — Document created: federate a guest's shared Canvases by invalidation

**What changed:** A Canvas explicitly shared with a guest of its Organization
shows in the guest's other Organizations. Its Organization's triggers queue an
invalidation; the Worker builds each list by asking the Canvas's own
Organization and relays it through the target Organization to the guest's
sockets. The only stored state is the guest's switch.

**Why:** A guest of a partner's Organization had to switch Organization to find
what was shared with them. Only guests: Canvases inside one Organization stay
in it for its members, which is what the Organization boundary is for.

**Considered and rejected:** Each client fetching every other Organization's
list, built first on this branch: three clients doing the same work and lists
only as fresh as the last window focus. A per-person inbox copying each
Canvas's title, look and date: it put a Canvas's contents outside its
Organization and showed an unshared Canvas until its delivery landed. A
pointer-only inbox with revisions: a design review found it a cache the reads
already refused to trust, with a lost-push window after a partial failure and
pointers that could outlive their Canvas. Building lists inside the target
Organization's object, which put cross-Organization reads and D1 into every
subscribe there.

**Consequences:** A Canvas reached only through Organization-wide visibility
or a writer Sidekick's audience is never federated. Anything that adds a way to
share a Canvas with a guest must write `canvas_participants`, or a trigger of
its own. `relayToPerson` is generic: a later per-person push can use it with
its own channel.
