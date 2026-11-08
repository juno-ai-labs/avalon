# Canvas access requests

A member of an Organization who opens a Canvas they cannot see is told it
exists — never its title — and may ask to be let in, with an optional
one-line message. Whoever decides on that Canvas's people is told, in
Activity and by push, and approves or denies from the Activity row or the
Share panel. An approval seats the requester and tells them; a denial tells
nobody. A request also settles on its own when the person is let in some other
way. Read this before changing who may ask, who decides, or what a decision
does; who can open a Canvas at all is [`canvases.md`](canvases.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/canvases.ts` | `CanvasAccessSchema` (`GET /canvases/:id/access`), `CanvasAccessRequestSchema` and `CanvasAccessRequestResultSchema` (asking), `CanvasAccessDecisionRequestSchema` and `CanvasAccessDecisionSchema` (deciding), and `CanvasDetail.pendingAccessRequests`. |
| `packages/contracts/src/activity.ts` | The `access_request` and `access_granted` kinds and the item's `accessRequest` (`state`, `decidedByName`). |
| `apps/api/src/durable-objects/canvas-access-requests.ts` | WorkspaceDO migration 151, `requestCanvasAccess`, `settleCanvasAccessRequest` (one settlement for a decision and for every other way in), `settleAdmittedAccessRequests`, the deciders, and the named refusals. |
| `apps/api/src/durable-objects/hosted-canvas.ts` | `HostedCanvas.access`, `requestAccess`, `decideAccess`; `detail`'s pending list for a decider; `setAudience` settling what the new audience admits. |
| `apps/api/src/routes/canvases.ts` | The three routes; `CanvasService` carries them to `WorkspaceDO.canvasAccess`, `canvasRequestAccess` and `canvasDecideAccess`. |
| `apps/api/src/durable-objects/workspace-activity.ts` | A request's row reads as seen once settled, and names its state and decider. |

## How it works

### Asking

`GET /canvases/:id/access` answers a member who cannot open the Canvas with
`{ access: "requestable", title: null, request }`, where `request` is their
latest request (`pending` or `denied`, with when they asked) or null. A
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
an empty message is none.

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
decider, linking to the Canvas. A denial tells the requester nothing (the
Thread-era rule); a new request after a denial is a new row.

### Let in another way

`HostedCanvas.setAudience`, after its write, settles every waiting request
whose person the new audience admits — a person named, or every member when
the Canvas is now Organization-wide — as approved by whoever changed the
audience, through the same settlement, so the requester is told as an
approval tells them.

### In the client

[Client half: the requestable pane, the Request access dialog, the Activity
row's Approve and Deny, and the Share panel's Requests section, folded in at
merge.]

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
  new request tells every decider. The Thread-era access-request limits
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
a denial tells the requester nothing and allows a new request; Share adding
the person, and the Canvas becoming Organization-wide, settle a waiting
request and tell the requester; a guest is
`canvas_access_request_not_member`, an id that is no Canvas
`canvas_not_found`, and a participant who does not manage it
`canvas_access_decision_not_manager`. Each case uses fresh Organization and
Canvas ids. `apps/api/test/workspace-canvas-access-requests-migration.test.ts`
proves migration 151 over populated participants.

## Data model

| Table | Key | Columns |
| --- | --- | --- |
| `canvas_access_requests` | `request_id` | `canvas_id`, `user_id`, `requester_name`, `message`, `state` (`pending`, `approved`, `denied`), `decided_by_user_id`, `decided_by_name`, `created_at`, `decided_at` (null exactly while pending). Unique `(canvas_id, user_id)` where pending; indexed by `(canvas_id, user_id, created_at DESC)`. |
| `canvas_participants` | `(canvas_id, user_id)` | `source` admits `request` (migration 151 copied the table, and remade its index and the memory-digest triggers). |
| `workspace_activity_items` | `item_id` | An `access_request` or `access_granted` row's `subject_id` is the request's id. |

## Changelog

### 2026-11-08 — Document created: a member asks to open a Canvas, and its deciders answer

**What changed:** Access requests return for Canvases: the access read, the
request and the decision routes; `canvas_access_requests` and the `request`
participant source (WorkspaceDO migration 151); an `access_request` intent and
Activity row per decider (the creator, the Organization's administrators and
a writer Sidekick's managers), settled for all of them by one decision; an
`access_granted` intent and row for the requester; and a request settling when
Share adds the person or the Canvas opens to the Organization. [Client half:
folded in at merge.]

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
it quiet, and a later request is allowed. A cap on requests per person: a
number the team has not set.

**What a future change must respect:** every way a requester gets in settles
through `settleCanvasAccessRequest`, and only someone `canvasManages` admits
decides.
