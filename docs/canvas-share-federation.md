# Canvas share federation

A Canvas explicitly shared with a **guest** of its Organization also appears in
the Canvas list of every other Organization that person opens, on the Mac, in
the browser and in the Expo app, with the Canvas's Organization's initial on
its top right. The server sends these rows; clients only draw them.

"Explicitly shared" means the guest is on the Canvas's own participant list
(`canvas_participants`). Only guests: a member of the Canvas's Organization
never has its Canvases federated, even ones explicitly shared with them. A
Canvas a guest reaches only through a writer Sidekick's audience, which can
name guests, is never federated, and Organization-wide visibility never admits
a guest at all.

The shape is **invalidate, don't replicate**: the Canvas's own Organization
answers, every time a list is built, which of its Canvases are shared with
that guest. A change there only tells the guest's other
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
| `apps/api/src/durable-objects/workspace-do.ts` | Hooks only: the alarm that queues a refresh, the subscribe that queues one, `guestSharedCanvases`, and `relayTicket` and `relayToPerson`, which send a built frame to one person's sockets in order. |
| `apps/api/src/services/shared-canvases.ts` | The Worker builder: which Organizations the person is in and a guest of, asking each origin, building each target's list and relaying it; the switch. |
| `apps/api/src/queues/activity-consumer.ts` | Runs `shared_canvases_refresh`, retrying one that fails. It is on the activity queue, not the interactive one, so connects and invalidations never wait in front of Slack replies. |
| `packages/db/migrations/0135_shared_canvases_settings.sql` | The switch. |
| `apps/api/src/routes/shared-canvases.ts` | `GET` and `PUT /workspace/me/shared-canvases`. |
| `apps/desktop/src/renderer/lib/shared-canvases.ts`, `lib/workspace-socket.tsx` | The socket-owned list and the switch's read and save. |
| `apps/desktop/src/renderer/components/other-organization-canvas.tsx` | The badged sidebar row, the card badge, and the in-place route a shared Canvas opens on. |
| `apps/desktop/src/renderer/lib/organization-scope.tsx` | `OrganizationScope`: re-roots one screen onto another Organization's client, query cache and local-cache scope, with no Organization socket; `useOrganizationSession` makes and keeps that client. |
| `apps/desktop/src/renderer/screens/other-organization-canvas.tsx` | `/organizations/:region/:workspaceId/canvases/:id`: the Canvas screen inside that scope. |
| `apps/desktop/src/main/index.ts` (`workspace:get-session`, `workspace:refresh-session`) | The Mac app's other-Organization credential: the stored one, or one minted through activation and stored without making it active. |
| `apps/browser/src/shell.tsx` (`openOrganizationSession`) | The browser's: `/workspace/select` maps the Organization to the cookie, and requests name it in their path. |
| `apps/browser/src/mobile.tsx`, `apps/mobile/src/Dashboard.tsx` | The Expo snapshot's `sharedElsewhere`, the native card, and the web view opening one in place ([`mobile-canvas-client.md`](mobile-canvas-client.md)). |

## How it works

1. **The origin's outbox.** Triggers queue one `_internal_durable_alarms` entry
   keyed by the person's user id whenever what they could see may have
   changed: they were added to or taken off a Canvas's list; a Canvas they are
   on was renamed, re-iconed, archived or deleted; or their relationship to
   this Organization changed (a guest promoted, removed or suspended). The
   participant triggers skip people this object knows to be members. The
   relationship triggers queue for anyone on any Canvas's list, members
   included, since a member's change may be a guest's promotion. A Canvas's
   date alone queues nothing, so a Chat message never fans out. There is no
   backfill: lists are built from the Canvases themselves on every subscribe.
2. **Invalidation.** The alarm sends `shared_canvases_refresh` (scope `others`)
   on the activity queue: rebuild this person's list in every other
   Organization they are in.
3. **On subscribe.** After a socket's subscribe answer (never ahead of it) the
   Organization queues `shared_canvases_refresh` (scope `this`) for that
   person. A support session's socket queues none.
4. **The build, in the Worker.** It reads the person's active Organizations in
   this region from D1. It takes a ticket from each target Organization
   (`relayTicket`) before reading anything else; a target where the person has
   no socket answers `null` and is skipped, and with no target left the build
   stops there. It then reads the switch and asks each Organization the person
   is a **guest** of, once, `guestSharedCanvases`. That Organization checks the
   person's relationship itself (`readRelationship`) and answers only for an
   active guest: the Canvases they are on the list of and did not make, each
   one the Canvas's own read rule still admits (`canvasReaderAllows`), newest
   first, at most the sidebar list's own bound (`SIDEBAR_LIST_LIMIT`). The
   Worker parses each answer, and builds each target's list from every other
   origin, newest first, at the same bound, with each Organization's name from
   D1, or an empty list while the switch is off. It parses the frame before
   relaying it.
5. **A failed origin.** An Organization that cannot answer is named in the
   frame's `unavailable`. The rest of the list still lands, so an unshare
   elsewhere is not held up, and the client keeps what it last showed from the
   Organizations named there. The build then throws, as it does when a relay
   fails, and the activity queue retries it with a growing delay (`min(300,
   5·2^(attempts−1))` seconds) until a complete list lands or it
   dead-letters. A retired Organization answers nothing and fails nothing.
6. **The relay.** The target Organization's `relayToPerson` sends the frame to
   the person's subscribed sockets, never a support session's. Tickets are
   strictly increasing per person, and floored at the clock. Each socket keeps,
   on its own attachment, the ticket of the last frame it was sent and skips
   one that is not newer, so a slow build cannot land after a newer one, even
   across the object's hibernation or two builds started in the same
   millisecond.
7. **The switch.** `PUT` saves it, then queues `shared_canvases_refresh`
   (scope `all`) before it answers, so the queue's retry covers the rebuild of
   every Organization the person is in.
8. **The clients** apply the event to one query and merge it into the home
   grid and the sidebar by date (or name). A shared row has no menu, drag or
   pin and never shows unread. Turning the switch off clears the list at
   once, before the server's empty list arrives.
9. **Opening one.** Choosing a shared row opens it in place, on
   `/organizations/:region/:workspaceId/canvases/:id`, and the Organization in
   front stays in front: its sidebar, socket and account tile do not move.
   The Canvas screen inside runs in an `OrganizationScope`: the Canvas's
   Organization's own client and session (so its guest rules apply), a query
   cache of its own, its own local-cache scope, and no Organization socket.
   The client comes from the host's `openOrganizationSession`: on the Mac,
   main hands out the credential it stores for that Organization, or mints one
   through `/onboarding/workspace/activate` and stores it without activating
   it, and renews it on its own; in the browser, `/workspace/select` maps the
   Organization to the cookie and the client calls
   `/browser/api/<that Organization>/…`. The client is made once per
   Organization and kept for the shell's life. The Expo web view does the
   same on its own route, remembering which Organization each Canvas id it
   opened came from, so the native shell's commands, which name a Canvas by
   id, keep it there.

## Invariants

- **Nothing about a Canvas leaves its Organization at rest.** The only stored
  state is the person's switch.
- **The origin decides every time,** for one person, only for an active guest
  of its own on the Canvas's list, and only for a Canvas its own read rule
  still admits them to.
- **An Organization's object only relays.** It neither reads another
  Organization nor builds a list.
- **A support session never receives this list.** Its grant covers one
  Organization; the list spans others.
- **A newer build always wins** in what a socket last received.
- **One failing Organization does not hold the others.** A build relays what
  it could read and names the rest as unavailable.
- **Opening a shared Canvas never switches Organization.** Only the screen
  that shows it reads its Organization, on that Organization's own
  credential; nothing it reads lands in the active Organization's caches.

## Boundary

Who a Canvas is shared with is [`canvases.md`](canvases.md)'s. The socket and
its subscribe answer are [`realtime-sockets.md`](realtime-sockets.md)'s. A
guest relationship and switching Organization are
[`multiple-workspaces.md`](multiple-workspaces.md)'s.

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| An origin Organization cannot answer during a build | `shared_canvases_origin_unread` with its id and a code. The frame names it in `unavailable` and relays the rest; the client keeps what it last showed from it, so a socket that had no list shows only the Organizations that answered. The build throws and the queue retries it with a growing delay, then dead-letters it. A retired one is skipped silently. |
| A target Organization cannot be relayed to | `shared_canvases_relay_failed` with its id and a code; the build throws and is retried the same way. |
| A refresh message fails | `shared_canvases_refresh_retry` with the scope, the attempt and a code, then the retry above. |
| A refresh cannot be queued after a subscribe | `shared_canvases_refresh_unsent`; the next change or subscribe rebuilds. |
| The switch's refresh cannot be queued | The `PUT` fails after the switch was saved; saving it again queues it. |
| The activity queue is backed up | Shared rows appear late on opening or switching Organization, since the subscribe's build waits behind search indexing and the rest. A known trade-off: the interactive queue is kept for work like Slack replies. |
| A rename, re-icon or archive | Rebuilds the guest's other lists. Activity alone rebuilds nothing; a list built for another reason reads the current dates. |
| An origin Organization is renamed, retired or abandoned | Queues nothing: its old name, or its Canvases, stay on open sockets until the next subscribe or change. |
| The first time an Organization answers for a guest | Caching their relationship queues one extra, idempotent rebuild of their other Organizations. |
| A person in another data region | Not federated: each region builds from its own Organizations and user ids. |
| The Canvas's Organization cannot be opened (access revoked, offline) | The Canvas pane says so with the reason and a Try again; the rest of the shell is unaffected. |
| The Mac app holds no credential for that Organization | The first open mints one through activation, which revalidates the relationship and records a `workspace_activation_completed` outcome as a switch would; later opens reuse it. |

## Testing

| Suite | What it covers |
| --- | --- |
| `apps/api/test-workers/canvas-share-federation.test.ts` (`pnpm --filter @rally/api test:workers`) | The flow on real Organization objects and sockets: the guest rule, rename, unshare and archive, a member never federated, promotion to member, a suspended guest, an unshare that still lands while another origin fails, the consumer's delayed retry and its other-region ack, no build where the person has no socket, the support-session exclusion and relay ordering. |
| `apps/api/test/shared-canvases.test.ts` (`pnpm --filter @rally/api test`) | The D1 reads against the checked-in migrations: which Organizations a person is in and a guest of, and the switch. |
| `apps/api/test/shared-canvases-route.test.ts` | The route: the caller's own switch, on by default, a change queuing an `all` rebuild, a malformed body refused, and no session refused. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx`, `screens/canvases-home.test.tsx`, `components/canvas-sidebar-section.test.tsx`, `screens/workspace-settings.test.tsx` | The pushed list and switch, an unavailable Organization's rows kept, the merged home grid and sidebar with their in-place routes, and the settings switch and its read failure. |
| `apps/desktop/src/renderer/screens/other-organization-canvas.test.tsx` | The real Canvas screen in an `OrganizationScope`: it reads on the other Organization's client and cache, never the active one's, and a failed open says why. |
| `apps/mobile/src/protocol.test.ts`, `directory.test.ts`, `saved-directory.test.ts` | The Expo snapshot's `sharedElsewhere`, the directory key, and that shared rows are never saved. |

Traps in the workers test:

- The workerd D1 starts with no schema. The test declares the tables it needs,
  adds `name` and `placement_affinity` to `workspaces` with `ALTER TABLE`, and
  applies `0135_shared_canvases_settings.sql` raw.
- It spies `env.ACTIVITY_QUEUE.send` before any write and runs each queued
  refresh itself. One test hands `consumeActivityQueue` a fake batch, which is
  the only place the consumer's branch runs.
- `drain()` must loop until nothing new is queued: the first
  `guestSharedCanvases` caches the guest's relationship, and that write queues
  one more refresh.

## Data model

| Store | What |
| --- | --- |
| D1 `shared_canvases_settings` (`0135`) | One row per person who changed the switch: `user_id`, `enabled` (0 or 1), `updated_at`. No row is on. |
| WorkspaceDO `_internal_durable_alarms`, kind `canvas_share_federation` | One entry per person whose view may have changed, keyed by user id, written by the migration 151 triggers. |
| WorkspaceDO socket attachment `sharedCanvasesTicket` | The ticket of the last shared-Canvas frame that socket was sent. |

## Regional impact

Each region builds only from its own Organizations. A guest in a Canvas's
Organization in another region does not see it here.

## Security and trust model

- The origin answers only for its own active guest, and only for Canvases its
  read rule admits them to. The Worker's D1 read narrows who is asked; it does
  not decide.
- A Canvas's title, look and date cross Organizations only in flight, built for
  one person. Neither the Organization objects nor the Expo app's saved
  directory store them.
- A support session gets none of it: no refresh on its subscribe, no frame on
  its sockets, and the route refuses it.
- Logs carry Organization and user ids and codes, never titles.

## Performance and cost

A subscribe costs one queue message, two D1 reads (the person's Organizations
and the switch) and a ticket call to that Organization; it asks the person's
guest Organizations and relays only when the person has a socket there. A
change does the same for every other Organization the person is in, skipping
those with no socket for them. A person in no Organization as a guest is asked
nothing.

## Changelog

### 2026-11-19 — Opening a shared Canvas stays in the current Organization

**What changed:** Choosing a Canvas shared from another Organization opens it
in place, on the Mac, in the browser and in the Expo app, instead of switching
the whole app to that Organization. A new primitive, `OrganizationScope`,
re-roots one screen onto another Organization's client, query cache and
local-cache scope, with no Organization socket; each host hands out that
client through `openOrganizationSession`. `openWorkspaceCanvas`, the switching
path, is gone.

**Why:** Switching tore down the shell the person was working in to read one
Canvas, and left them in the other Organization afterwards. The person asked
to stay where they were.

**Considered and rejected:** Overriding only the API client and keeping the
shell's query cache: list and detail keys are not keyed by Organization (the
members list, the sidebar lists), so the other Organization's rows would land
in the active one's. Asking the active Organization to proxy the Canvas: it
would put cross-Organization reads into an Organization's object, which this
design forbids. Reusing the stored credential without minting: a device that
never opened that Organization has none.

**Consequences:** Anything a Canvas screen reads must come from
`useCollaborationSession`, not `useAppSession`, or it reads the active
Organization inside the scope; the Expo Canvas and its detail hook moved for
this. Screens inside the scope have no Organization socket, so a live rename
or new artifact in the other Organization shows on the next read, not at once;
the Chat's own socket stays live. Deep links from outside still switch
Organization.

### 2026-11-16 — Document created: federate a guest's shared Canvases by invalidation

**What changed:** A Canvas explicitly shared with a guest of its Organization
shows in the guest's other Organizations. Its Organization's triggers queue an
invalidation; the Worker builds each list by asking the Canvas's own
Organization and relays it through the target Organization to the guest's
sockets. The only stored state is the guest's switch.

**Why:** A guest of a partner's Organization had to switch Organization to find
what was shared with them. Only guests: Canvases inside one Organization stay
in it for its members, which is what the Organization boundary is for. This is
not the merged sidebar or global inbox that the multiple-workspaces design
rejected: nothing from another Organization crosses except Canvases explicitly
shared with the person as a guest, each one decided by its own Organization
when the list is built, and the person can turn it off.

**Considered and rejected:** Each client fetching every other Organization's
list: every client doing the same work, with lists only as fresh as the last
window focus. A per-person inbox holding a copy of each Canvas: it puts a
Canvas's contents outside its Organization, and keeps showing an unshared one
until its delivery lands. An inbox of pointers only: a cache the reads would
not trust, which can lose a push after a partial failure and outlive its
Canvas. Building lists inside the target Organization's object, which would
put cross-Organization reads into every subscribe there. Ordering builds by
their start time instead of a ticket: two builds can start in the same
millisecond and read different state. Holding the whole list back when one
Organization fails to answer: that one Organization would stop an unshare
elsewhere from reaching the screen. Storing the switch as a member preference:
those are per Organization and live in its object, and this switch spans every
Organization the person is in.

**Consequences:** A Canvas reached only through Organization-wide visibility
or a writer Sidekick's audience is never federated. Anything that adds a way to
share a Canvas with a guest must write `canvas_participants`, or a trigger of
its own. SQLite drops a table's triggers with `DROP TABLE`, so a later rebuild
of `canvas_directory`, `canvas_participants` or `workspace_member_status` must
recreate them, and a rebuild that copies rows back fires them for everyone on a
list. Guests in another region are left out on purpose: a region builds only
from its own Organizations and user ids, and adding them would need a
cross-region read of who a person is, which nothing here has. Shared rows wait
behind the activity queue on opening an Organization.

Shipped in #1625.
