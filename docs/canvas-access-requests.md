# Canvas access requests

A member of an Organization who opens a Canvas they cannot see is told it
exists — never its title — and may ask to be let in, with an optional
one-line message. Whoever decides on that Canvas's people is told, in
Activity and by push, and approves or denies from the Activity row or the
Share panel. An approval seats the requester and tells them; a denial tells
them who declined, never the title. A request also settles on its own when the person is let in some other
way. Read this before changing who may ask, who decides, or what a decision
does; who can open a Canvas at all is [`canvases.md`](canvases.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/canvases.ts` | `CanvasAccessSchema` (`GET /canvases/:id/access`), `CanvasAccessRequestSchema` and `CanvasAccessRequestResultSchema` (asking), `CanvasAccessDecisionRequestSchema` and `CanvasAccessDecisionSchema` (deciding), and `CanvasDetail.pendingAccessRequests`. |
| `packages/contracts/src/activity.ts` | The `access_request`, `access_granted` and `access_denied` kinds and the item's `accessRequest` (`state`, `decidedByName`). |
| `apps/api/src/durable-objects/canvas-access-requests.ts` | WorkspaceDO migration 151 (migration 152, which admits `access_denied`, is `NOTIFICATION_INTENTS_ACCESS_DENIED_MIGRATION` and `WORKSPACE_ACTIVITY_ACCESS_DENIED_STATEMENTS` beside the tables it rebuilds), `requestCanvasAccess`, `settleCanvasAccessRequest` (one settlement for a decision and for every other way in), `settleAdmittedAccessRequests`, the deciders, and the named refusals. |
| `apps/api/src/durable-objects/hosted-canvas.ts` | `HostedCanvas.access`, `requestAccess`, `decideAccess`; `detail`'s pending list for a decider; `setAudience` settling what the new audience admits. |
| `apps/api/src/routes/canvases.ts` | The three routes; `CanvasService` carries them to `WorkspaceDO.canvasAccess`, `canvasRequestAccess` and `canvasDecideAccess`. |
| `apps/api/src/durable-objects/workspace-activity.ts` | A request's row reads as seen once settled, and names its state and decider; a declined request's row lists for a requester who cannot open the Canvas, untitled, and reads as seen once they ask again; `requestCanvasAccess` republishes the requester's list when they do. |

## How it works

### Asking

`GET /canvases/:id/access` answers a member who cannot open the Canvas with
`{ access: "requestable", title: null, request }`, where `request` is their
latest request (`pending` or `denied`, with when they asked and, once
declined, `decidedAt`) or null, so the pane can say "Request declined" and
offer Request access again. A
Canvas they can open answers `409 canvas_access_open`; an id that is no Canvas
of their Organization is `404 canvas_not_found`, as every Canvas route says.
A guest is refused `403 canvas_access_request_not_member` before the id is
looked at, so the answer says nothing about which ids exist.

`POST /canvases/:id/access-requests` with `{ message? }` asks. A guest is
refused `canvas_access_request_not_member`; a person the Canvas already admits
gets `{ status: "already_participant" }`; anyone else gets
`{ status: "pending" }`. A request already waiting is the answer to asking
again, so asking twice tells nobody twice. A new request is a row in
`canvas_access_requests` with the requester's name taken now, and one
`access_request` intent and Activity row for each **decider** who is told
(`recordParentNotice`), whose pushes are enqueued. The message is trimmed and
bounded by the contract at the push's preview length
(`PUSH_BODY_PREVIEW_CHARACTERS`), the one number the push and the preview
already use, so a longer one is refused as `canvas_access_request:message:…`;
an empty message is none. A new request also republishes the requester's own
Activity list (`noteActivityChanged`): a denied row of theirs on this Canvas
reads as seen once they ask again, and an open socket is told so at once.

### Who is told, and who decides

The people told are those the 2026-11-07 decision lets manage a Canvas's
participants: its creator, the Organization's active owners and
administrators, and, for a Canvas a Sidekick writes, that Sidekick's managers
(its author and the person it runs as), never the requester. Each one's
relationship is read into the object as they are chosen, because their
Activity lists a Canvas they open by role from the relationship the object
keeps. Anyone `canvasManages` admits may decide: the same people.
Anyone else who may open the Canvas is refused
`403 canvas_access_decision_not_manager`, and anyone who may not is told the
Canvas does not exist. A malformed person id in the decision route is refused
under its own label, `canvas_access_requester:userId:<issue>`.

### Deciding

`POST /canvases/:id/access-requests/:userId/decision` with
`{ decision: "approve" | "deny" }` settles the waiting request and answers
`{ state }`; a request that is not waiting is `409 canvas_access_request_settled`.
Settling writes, in one transaction: the request's state, who decided and
their name, and when; a note for every decider who has a row about it, so
each one's Activity is sent again and the row reads as settled and seen. An
approval also adds the requester to `canvas_participants` with source
`request`, moves a Canvas open to its creator alone to `participants`, and
writes the requester's `access_granted` intent and Activity row naming the
decider, linking to the Canvas. A denial writes the requester's
`access_denied` intent and Activity row instead ("<decider> declined your
request to open a Canvas"), linking to the Canvas, whose pane then reads the
denied request; a new request after a denial is a new row.

The denial's notice and row never carry the Canvas's title: the notice
(`ParentNotice` `access_denied`) has no title field, its row's `parentTitle`
is always null, and its push is sent though the requester cannot list the
Canvas (`recipientRefused`'s `unlisted`) — that is what it is about. It lists
while the Canvas exists, reads as seen on Mark all seen or once the requester
asks again, and goes under `accessRequests` in the person's choices
(`NOTIFICATION_KIND_FOR_PUSH`), the same kind a decider chooses for a
request.

### Let in another way

`HostedCanvas.setAudience`, after its write, settles every waiting request
whose person the new audience admits — a person named, or every member when
the Canvas is now Organization-wide — as approved by whoever changed the
audience, through the same settlement, so the requester is told as an
approval tells them.

### In the client

Client: a 404 on a well-formed Canvas id asks `GET /canvases/:id/access`; `requestable` draws "You don't have access to this Canvas" with Request access (one dialog opening on its optional message), "Request sent · <when>" alone, in the button's place, from the access read while pending, and 409 `canvas_access_open` read as "open it"; a restored route on a requestable Canvas stays, and the grant reopens the pane without a refresh (list row or `access_granted` row). A declined request reads "Ask again if you still need it." over Request access and "Request declined · <when>" (`decidedAt`, or when it was asked from a server older than that field) under it, so "declined" is said once, since a denial allows a new request. The requester's `access_denied` Activity row, "<decider> declined your request to open a Canvas" behind the lock glyph and never naming the Canvas, opens this pane; an open pane re-reads its access when that row arrives after its access read, so it says declined without a reload.

## Invariants

- **At most one waiting request per person per Canvas.** The partial unique
  index is the rule, so two asks racing each other leave one row, and deciders
  are told once. Guard: the first case's second ask; migration 151's proof.
- **Every way in that this module or the audience writes settles through
  `settleCanvasAccessRequest`**: an approval, Share naming the person, and the
  Canvas opening to the Organization. A second such path that seated a
  requester without it would leave deciders' rows waiting on a request
  already met. Admission through a writer Sidekick's audience (the person
  added to the Sidekick) does not settle a request: the request stays pending,
  and a decision on it seats them as `request` anyway. Guard: the Share and
  Organization-wide case.
- **A settled request's rows read as seen for every decider.** The rows are
  the actions; leaving one unsettled would offer an Approve that is refused.
  Guard: the first case, proved to fail with the settled clause of
  `ACTIVITY_SEEN_SQL` removed.
- **A denial never names the title.** Guard: the denial case asserts the
  row's null title and the push's words.
- **A guest learns nothing.** Asking and the access read refuse a guest
  before the id is read. Guard: the refusal case.
- **Only a manager decides.** Guard: the refusal case, proved to fail with the
  manager check replaced by the reader check.

## Boundary

This module owns `canvas_access_requests` and the `request` participant
source. It writes intents and Activity rows through `recordParentNotice` and
does not decide how they are pushed ([`push-notifications.md`](push-notifications.md))
or how seen is derived beyond its own clause ([`activity.md`](activity.md)).
Who can open a Canvas, and who manages it, are [`canvases.md`](canvases.md)'s
(`canvasAdmits`, `canvasManages`). It has no socket command: a decision from an
Activity row goes through the decision route, and the Activity push follows
from the same write.

## Failure modes and limits

- **No cap on requests.** A member may ask again after each denial, and each
  new request tells every decider. The earlier access-request limits
  (`git show 3df4150^:apps/api/src/services/access-request-limits.ts`) bounded
  anonymous email sign-ups by IP and mail budget, which this is not; a cap on
  requests per person would be a number for the team to set
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)),
  and none is written.
- **Names are snapshots.** The requester's and decider's names are taken when
  each acts, cut where a mention's author name is (300); a later rename does
  not change a row.
- **A decider removed from the Organization** keeps their row stored; it
  stops listing once they cannot open the Canvas.
- **A requester removed before a decision** can still be approved and seated;
  they open nothing until they are a member again.
- **Admission through a writer Sidekick's audience leaves a request
  pending**; a decider still sees it and may settle it.

## Testing

`apps/api/test-workers/canvas-access-requests.test.ts`, on real workerd
(`pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts
test-workers/canvas-access-requests.test.ts`): a member asks and the
creator's socket gets the row, the administrator gets one too, a second ask
answers the first, the access read names the pending request, the Share
detail lists it for a decider only, the push says "Robin asked to open Launch
plan"; approval seats the requester with source `request`, settles both
deciders' rows, and tells the requester ("Avery let you into Launch plan",
linking to the Canvas); a second decision is `canvas_access_request_settled`;
a denial tells the requester ("Ada declined your request to open a Canvas",
an untitled row on their socket, linking to the Canvas), the access read
names the denial with `decidedAt`, and a new request is allowed and reads
the denial as seen — proved to fail with the denial's notice dropped; Share adding
the person, and the Canvas becoming Organization-wide, settle a waiting
request and tell the requester; a guest is
`canvas_access_request_not_member`, an id that is no Canvas
`canvas_not_found`, and a participant who does not manage it
`canvas_access_decision_not_manager`. Each case uses fresh Organization and
Canvas ids. `apps/api/test/workspace-canvas-access-requests-migration.test.ts`
proves migration 151 over populated participants;
`apps/api/test-workers/access-denied-migration.test.ts` proves migration 152
over a populated v151 object (intents and Activity rows kept, `subject_id`
included, the identity trigger kept), proved to fail with `subject_id` left
out of the copy.

## Data model

| Table | Key | Columns |
| --- | --- | --- |
| `canvas_access_requests` | `request_id` | `canvas_id`, `user_id`, `requester_name`, `message`, `state` (`pending`, `approved`, `denied`), `decided_by_user_id`, `decided_by_name`, `created_at`, `decided_at` (null exactly while pending). Unique `(canvas_id, user_id)` where pending; indexed by `(canvas_id, user_id, created_at DESC)`. |
| `canvas_participants` | `(canvas_id, user_id)` | `source` admits `request` (migration 151 copied the table, and remade its index and the memory-digest triggers). |
| `workspace_activity_items` | `item_id` | An `access_request`, `access_granted` or `access_denied` row's `subject_id` is the request's id. `kind` admits `access_denied` from migration 152, as `workstream_notification_intents.notification_kind` does. |

## Changelog

### 2026-11-08 — A denial tells the requester

**What changed:** Denying a request now writes the requester an
`access_denied` intent and Activity row naming who declined, never the
Canvas's title, and pushes it under their `accessRequests` choice; the access
read gives the denied request's `decidedAt`, to every build: one older than
contract 13 was first served the request without it, a branch deleted once
13 became `MINIMUM_SERVED_CLIENT_CONTRACT` and such a build stopped
connecting. WorkspaceDO migration 152
rebuilds `workstream_notification_intents` and `workspace_activity_items` to
admit the kind, as 150 did.
Asking again republishes the requester's own Activity list
(`noteActivityChanged`), because their denied row now reads as seen through
the seen join: without it the row and the badge stayed unseen on an open
socket until a reload (the round-5 visual check, F1).

**Why:** The owner's answer of 2026-11-08: "inform the person [of] a
denial". The first version kept the Thread-era rule that a denial tells
nobody; a requester then waited on "Request sent" with no answer.

**Considered and rejected:** Reusing `access_request` with a denied state
for the requester's row: the row would read as a request to decide. Naming
the title in the notice: the requester was refused it.

**What a future change must respect:** the denial's notice and row carry no
title; a new kind on these two tables needs another rebuild, not an edit to
150 or 152.

Shipped in juno-ai-labs/avalon#1490.

### 2026-11-08 — Document created: a member asks to open a Canvas, and its deciders answer

**What changed:** Access requests return for Canvases: the access read, the
request and the decision routes; `canvas_access_requests` and the `request`
participant source (WorkspaceDO migration 151); an `access_request` intent and
Activity row per decider (the creator, the Organization's administrators and
a writer Sidekick's managers), settled for all of them by one decision; an
`access_granted` intent and row for the requester; and a request settling when
Share adds the person or the Canvas opens to the Organization. Client: the Share panel lists `pendingAccessRequests` for deciders with the same Approve and Deny the Activity row has (`AccessDecisionActions`, held once answered), which drop under the message at narrow widths; an approval made while the panel is open joins its choice of people, and the visibility the approval moved the Canvas to replaces the panel's, so Save keeps it (a creator-only Canvas left at "Only you" would have sent `creator` and removed the person just let in). On the Activity row the buttons are named for the Canvas too, and a settled row says "You approved" to the decider (`decidedByUserId`) in the buttons' place.

**Client:** The requestable pane reads a declined request as "Request
declined · <when>" with Request access offered again, and the requester's
`access_denied` row opens it; an open pane re-reads its access when that row
arrives after its access read. The owner's instruction of 2026-11-08: "inform
the person [of] a denial".

**Why:** The owner asked on 2026-11-08 for the whole flow back. The
Thread-era flow (`git show 3df4150^:apps/api/src/services/access-request-service.ts`
and its storage) was built on Thread tables and deleted with them; a member
who followed a link to a Canvas they were not in was told it did not exist,
with no way to ask. The request rides the one pipeline every notice does
(an intent and its Activity row in one transaction), with its actions on the
row, rather than a second table of alerts or its own socket event.

**Considered and rejected:** One row per (Canvas, person) reset on each ask,
as the brief sketched: an earlier, denied request's Activity rows would read
as waiting again, with live Approve and Deny, so each request is its own row
and only the waiting one is unique. A socket command for the row's actions:
the decision route already answers with a named code, and the Activity push
follows from the write. Telling the requester of a denial: the old rule kept
it quiet, and a later request is allowed (the owner reversed this the same
day; see "A denial tells the requester" above). A cap on requests per person: a
number the team has not set.

**What a future change must respect:** every way a requester gets in settles
through `settleCanvasAccessRequest`, and only someone `canvasManages` admits
decides.

Shipped in juno-ai-labs/avalon#1490.
