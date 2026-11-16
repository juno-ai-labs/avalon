# Canvas share federation

A Canvas shared with a person in one Organization also appears in the Canvas
list of every other Organization they open, on the Mac, in the browser and in
the Expo app, with that Organization's initial on its top right. The server
sends these rows; no client fetches another Organization.

The model is ActivityPub's outbox and inbox, with Google Drive's "Shared with
me" as the inbox: the Canvas's own Organization is the authority and only
publishes; each person has an inbox that holds a copy of what a list row needs;
every other Organization reads that inbox onto the person's socket. No
Organization ever reads another, and the Organization's object stores nothing
about other Organizations.

The person turns it off under Settings › Account › Preferences (**Show shared
Canvases in every Organization**, on by default). The switch is stored on their
inbox, so it covers every Organization in the deployment and every device.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/canvas-share-federation.ts` | The queue message, the origin's per-person state, the shared row, the `workspace_shared_canvases` socket event and the setting. |
| `apps/api/src/durable-objects/canvas-share-federation.ts` | The origin half: WorkspaceDO migration 150 (the `share_revision` column, the outbox triggers and the backfill), the outbox key and `canvasShareState`. |
| `apps/api/src/durable-objects/workspace-do.ts` | Thin hooks only: the alarm that sends the address, the `canvasShareState` and `publishSharedCanvases` RPCs, and the read after a socket subscribes. |
| `packages/db/migrations/0135_canvas_share_inbox.sql` | The inbox and its setting, in the regional D1. |
| `apps/api/src/services/canvas-share-inbox.ts` | Applying a delivery, reading one Organization's list, the setting, and asking the person's Organizations to push. |
| `apps/api/src/queues/canvas-share-consumer.ts`, `queues/activity-consumer.ts` | The `canvas_share_changed` handler on the activity queue. |
| `apps/api/src/routes/shared-canvases.ts` | `GET` and `PUT /workspace/me/shared-canvases`. |
| `apps/desktop/src/renderer/lib/shared-canvases.ts`, `lib/workspace-socket.tsx` | The socket-owned list and the setting's read and save. |
| `apps/desktop/src/renderer/components/other-organization-canvas.tsx` | The badged sidebar row, the card badge, and opening a Canvas in its Organization. |
| `apps/browser/src/mobile.tsx`, `apps/mobile/src/Dashboard.tsx` | The Expo snapshot's `sharedElsewhere` and the native card ([`mobile-canvas-client.md`](mobile-canvas-client.md)). |

## How it works

1. **The origin's outbox.** Triggers on `canvas_participants` (insert, delete)
   and on `canvas_directory` (title, appearance, archive, delete) queue one
   `_internal_durable_alarms` entry per (Canvas, person) whose view may have
   changed, keyed `<canvasId>:<userId>`, and bump the Canvas's
   `share_revision`. A Canvas's date alone publishes nothing: a new Chat
   message never fans out. Migration 150 also queues one entry for every share
   that existed before it, as each object upgrades.
2. **The address.** The alarm sends `canvas_share_changed` (region,
   Organization, Canvas, person) on the activity queue. It carries no content,
   as the artifact-access messages do not
   ([`canvas-artifact-access.md`](canvas-artifact-access.md)).
3. **The consumer** asks the origin for that person's current state of that
   Canvas (`canvasShareState`): `shared` with its title, appearance, date and
   revision; `unshared` with its revision; or `gone`. Reading the state at
   delivery means a removal needs no record of whom the origin told, and a late
   delivery reads the latest state.
4. **The inbox** (`canvas_share_inbox`) keeps one row per (person,
   Organization, Canvas) with the highest revision it has seen, through an
   unshare (`shared = 0`), so a delivery that arrives late can never undo a
   newer one in either direction. `gone` deletes the row whatever its revision.
5. **The push.** When the inbox changed, the consumer asks each other
   Organization the person is active in here to push to their open sockets
   (`publishSharedCanvases`). That Organization reads the inbox and sends
   `workspace_shared_canvases`; it keeps nothing. Every socket also gets one
   after its subscribe answer, read off the answer's path so it never delays
   it.
6. **The read** keeps only Organizations the person is still active in, never
   the Organization reading, newest first, at most the sidebar list's own bound
   (`SIDEBAR_LIST_LIMIT`). The Organization's name comes from D1 at read time,
   so a rename shows on the next push.
7. **The clients** apply the event to one query and merge it into the home
   grid and the sidebar by date (or name). A shared row has no menu, no drag
   and no pin, and never shows unread: the inbox carries no read state.
   Choosing one opens it in its Organization: on the Mac through the deep-link
   queue, in the browser and Expo through its canonical page.

## Invariants

- **The origin only publishes.** No Organization reads another; what crosses is
  an address on the queue and a state read back by the consumer.
- **The inbox is a copy, never an authority.** Opening a Canvas from it goes to
  its Organization, which decides access as for any link.
- **A newer revision always wins.** Deliveries are idempotent and may arrive
  late, twice or out of order.
- **The person's own Organization is never repeated** in its own list.

## Boundary

This module owns the inbox, the outbox triggers and the push. Who a Canvas is
shared with, and so `sharedWithMe`, is [`canvases.md`](canvases.md)'s. The
socket and its subscribe answer are [`realtime-sockets.md`](realtime-sockets.md)'s.
Switching Organization is [`multiple-workspaces.md`](multiple-workspaces.md)'s.

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| The origin cannot be reached | The message is retried, then dead-lettered; the inbox keeps its last copy. Logged as `canvas_share_changed_retry` with the Canvas and person. |
| One of the person's Organizations cannot be told | `shared_canvases_publish_failed` names it; its sockets read the inbox on their next subscribe. |
| The inbox read fails while building a push | `workspace_shared_canvases_unpublished` with a code; the socket keeps its last list. |
| A rename, re-icon or archive | Published to everyone the Canvas is shared with. Its date and order move only on these events, not on activity. |
| A person in another data region | Not federated: each region has its own inbox and user ids. |
| An Organization object that never wakes after the deploy | Its existing shares are queued when it next does. |

## Testing

- `apps/api/test-workers/canvas-share-federation.test.ts` — on real
  WorkspaceDOs: a share, a rename and an unshare reach the person's inbox and
  their other Organization's socket; the state answers for the creator and an
  unknown Canvas; the backfill queues existing shares. Proven by removing the
  participant-removal trigger, which leaves the unshared Canvas listed.
- `apps/api/test/canvas-share-inbox.test.ts` — the inbox queries against the
  checked-in migrations: order and names, the revision guard both ways,
  inactive memberships, the setting. Proven by dropping the revision guard and
  the membership filter.
- `apps/desktop/src/renderer/lib/workspace-socket.test.tsx`, the Canvas home and
  sidebar tests, and `apps/mobile/src/protocol.test.ts` cover the clients.

## Regional impact

One inbox per regional user, in that region's D1. Shares federate within a
region; a Canvas in another region does not reach this region's lists.

## Changelog

### 2026-11-16 — Document created: federate shared Canvases through a per-person inbox

**What changed:** Canvases shared with a person reach every other Organization
they open from the server: the origin publishes through an outbox, a queue
consumer writes the person's inbox, and their Organizations push it to their
sockets. The switch is stored on the inbox.

**Why:** The first version had each client fetch every other Organization's
list (a Mac IPC call per stored credential, a browser fan-out through Global),
so each client did its own work and the lists were only as fresh as the last
window focus. Sending them from the server makes Electron, the browser and Expo
show the same thing, and keeps the Organization's object from reading or
storing other Organizations.

**Considered and rejected:** A new per-person Durable Object as the inbox; a D1
table in the region is the same index with no new class or deploy migration.
Reusing the artifact-access outbox, which is merged per Canvas and tied to
artifact policy. Publishing every date change, which would fan out one message
per participant per Chat message. A Global inbox for every region, which needs
a new regional-to-Global path.

**Consequences:** A shared row's date moves only on share, unshare, rename,
re-icon and archive. A shared row carries no unread state. Anything that adds
a way to be shared with a Canvas must write `canvas_participants` (or add its
own trigger), or it will not federate.
