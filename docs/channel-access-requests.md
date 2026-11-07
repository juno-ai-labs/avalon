# Channel access requests

What an Organization member sees when they open a link to a thread (a stored
Channel) or Breakout they are not in, and how they get in. They reach it from a
link; a Channel's feed does not list threads they cannot open. They see its name, color and icon, the line
"You're not in this thread, ask for access below" ("breakout" for a Breakout),
and a primary
**Request access** button. The button records a request addressed to the
conversation's creator and emails them. While a request is pending, including
after reopening or reloading, the screen shows **Access requested — awaiting
approval** and **Try again** instead of asking them to request access again.
If the email has not been sent, **Retry sending request** remains available.
The creator can answer it in any of
these places, and every one settles the same stored request:

- **Approve access** in the email: one click, no sign-in.
- The **check** and **cancel** icon buttons on the request's row at the top
  of the sidebar's **Activity** tab (Tabler `check` and `cancel`, tooltips
  **Approve** and **Decline**).
- Choosing the row itself, which opens a dialog with **Decline** and
  **Approve**.
- The same two buttons under **Asked to join**, above **Suggested**, on the
  People level of that Channel's or Breakout's title menu.
- A row in the macOS menu bar's **Needs attention**, which opens the same
  dialog in the main window.

The person who asked gets an email when the request is approved or declined.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/access-requests.ts` | The preview, the request item an approver is sent, the `workspace_access_requests` socket frame, and the decision result. |
| `apps/api/src/durable-objects/conversation-access-request-storage.ts` | Migration 95's `conversation_access_requests` table and its reads and writes: record (or reuse the pending one), get, settle, and one approver's pending list joined to the Channel and Breakout directories. |
| `apps/api/src/durable-objects/workspace-do.ts` | `accessRequestSubject` (a conversation's name, mark and creator, with no viewer check), the request RPCs, `publishAccessRequests` (the approver's list to their sockets only), and the list on the subscribe answer. |
| `apps/api/src/services/conversation-access-request-service.ts` | The preview, the request (approver, row, email), `decide` (approve or decline from the app), `approveConversationAccess` (the email's link), `grant` (the ordinary add, as the approver) and `tellRequester` (the decision email). |
| `apps/api/src/routes/conversations.ts` | `GET …/substreams/:substreamId/access-preview`, `POST …/substreams/:substreamId/access-requests`, and `POST /conversations/access-requests/:requestId/{approve,decline}`. |
| `apps/api/src/routes/conversation-access.ts` | The public `GET` and `POST /conversation-access/approve` pages behind the email's button. |
| `apps/desktop/src/renderer/components/conversation-access-request.tsx` | The requester's screen, shown in place of "Channel could not be opened". |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Refreshes waiting access previews on `workspace_reach_changed` and on Organization socket subscribe, so newly available access immediately retries the conversation. |
| `apps/desktop/src/renderer/lib/access-requests.ts` | The approver's list in the query cache (written only by the workspace socket) and the approve/decline mutation, which drops the row at once and restores it if refused. |
| `apps/desktop/src/renderer/components/navigation-sidebar.tsx` | Request rows at the top of the Activity tab, with the two icon buttons; the row opens the dialog. The Threads badge counts them. |
| `packages/ui/src/components/conversation-menus.tsx` | The People level's **Asked to join** section (`TitleMenuPeople.requests`); a requester is left out of **Suggested**. `conversation-surface.tsx` passes the requests for the conversation on screen. |
| `packages/ui/src/styles/app.css` | `.decision-button`, the approve and decline buttons both surfaces share: green (`sys.color.success.tint`) and red (`sys.color.danger.tint`) on hover. |
| `apps/desktop/src/renderer/components/access-request-dialog.tsx` | The dialog, opened from a row or from the menu bar's deep link. |
| `apps/desktop/src/main/channel-directory-watch.ts`, `menu-bar-content.ts`, `menu-bar-menu.ts` | The main process's copy of the list and its menu bar rows. |
| `packages/contracts/src/desktop-deep-link-intent.ts` | `access-requests/<id>`, the link a menu bar row emits to reach the main window. |

## How it works

1. **The refusal comes first.** Opening a conversation asks for a socket
   ticket. For someone not in it, the ticket answers 404
   `conversation_not_found` and the socket keeps retrying with backoff. Only
   then does `ConversationAccessRequest` ask for the preview, so opening a
   conversation you are in costs nothing extra.
2. **The preview.** A guest is refused (404). For a member, the Organization
   object names the conversation, and the Worker runs the same
   `authorizeViewer` the ticket runs: an initially `open` preview keeps the old
   error screen,
   `requestable` shows the request screen. A Breakout with no look of its own
   wears its Channel's, and `markId` is then the Channel's id. The same object
   read checks whether the signed-in requester has a pending request for this
   exact conversation and whether its email was sent (`requestPending` and
   `requestEmailed`). These fields are sent only to clients at contract 12 or
   later; older browser builds receive the original preview shape because
   their decoders are strict. Reopening refreshes the stored state, while a
   successful send cancels older preview reads before updating the submitted
   conversation's waiting state, even if the requester has navigated elsewhere.
   A failed send refreshes the preview too: the request may already be stored
   even though its email failed, so the screen offers the resend action at once.
   Preview keys and submission variables include the requester identity, so
   switching accounts cannot let an old send overwrite the new person's state.
   If a send response interrupts a check for a newer access-recovery version,
   that check is refreshed so a fast approval push still reopens the thread.
3. **The request.** The approver is the conversation's creator, who must be an
   active member and not the requester. The Organization object records the
   request, or returns the one already pending for this person and
   conversation. Only a new row pushes the approver's list. The email goes
   until one has gone out (`emailed_at`): pressing again after a failed send
   retries it under the same idempotency key, and after a sent one does
   nothing. The requester's name is copied
   into the row, since names live in D1 and the list is built in the object.
4. **The approver's list.** The subscribe answer carries `accessRequests` on
   every connect, and each change sends `workspace_access_requests` with the
   whole list to that approver's sockets alone. Neither is on the waterline.
   The renderer and the main process each keep it, so the Threads badge, the
   Activity tab, the dock badge and the menu bar count it with no request of their own. The list
   names each conversation as it is now: a rename or an archive sends the list
   again to every approver with a request pending there, and a request for a
   conversation since archived drops out.
5. **Answering in the app.** `POST /conversations/access-requests/:id/approve`
   or `decline`, as the signed-in approver. Anyone else is told it does not
   exist. The row is settled first, so only the decision that wins it acts:
   an approve and a decline sent together from two places cannot leave
   somebody added under a request that reads declined. Approving then runs
   `WorkstreamService.addParticipant` (a Channel) or
   `SubstreamCreationService.changeParticipant` (a Breakout) as that person.
   If that add is refused, the row goes back to pending (`reopen`) and is
   listed again. A request already settled answers `settled`.
6. **Answering in the email.** The link names the stored request and its
   approver, sealed with AES-GCM under `OAUTH_STATE_ENCRYPTION_KEY` and the
   purpose `rally-conversation-access-approval-v1`. The `GET` grants nothing:
   it serves a page whose one script, allowed by a per-response CSP nonce,
   posts the token back, so a mail scanner that fetches the link changes
   nothing. The `POST` claims the row as approved first, the same way, then
   acts as the approver under `principal: "connector"`. A request already approved shows "Access approved"
   without granting again. A declined one stays declined.
7. **Telling the requester.** Whichever call settled the request sends
   "You can now open …" (with an **Open in Rally** link) or "Your request to
   join … was declined". A mail failure is logged as
   `conversation_access_decision_email_failed` with its code and does not undo
   the decision. Approving also runs the ordinary add, which sends its own
   "added you" notification by Slack, push or email.
8. **The requester gets in.** The ordinary add's `workspace_reach_changed`
   push, or Organization socket resubscribe, replaces pending access previews
   and reads access again. A stored nudge permits one freshly admitted retry
   per conversation, including after revocation or before its preview exists.
   The 30-second backoff and **Try again** remain
   recovery paths.

Outside production no mail is sent (`sendResendEmail`). In development the
approve link is logged as `conversation_access_request_dev_link` and each
decision email as `conversation_access_decision_dev_email`.

## Invariants

- **The waiting state comes from the requester's own pending row.** Another
  person's request, another conversation, or an answered request must not hide
  **Request access**. Guard: the workerd file's pending-preview tests and
  `conversation-access-request.test.tsx`'s fresh-visit and reopening tests.
- **Only the approver's own add can let someone in.** Every path runs the add
  the app runs, as the approver, so an approval never grants more than they
  could by hand. Guard: the add paths' own tests.
- **A settled request is never granted again.** The email link checks the
  row, so an old email cannot re-add someone removed since. Guard:
  `test-workers/conversation-access-requests.test.ts` "lists a request to its
  approver on connect and pushes the empty list once it is settled".
- **An approver's list reaches only the approver.** Guard: the same file,
  "pushes a new request to its approver alone".
- **Fetching the link grants nothing.** Guard:
  `test/conversation-access-approval.test.ts`.
- **The preview names, it never reads.** Title and mark only. Guard: the
  workerd file's `accessRequestSubject` cases assert the whole subject.
- **A guest is told nothing** and has no list. Guard:
  `test/conversation-access-approval.test.ts` "a guest".

## Boundary

Owns: the preview, the stored request, the emails, the approve page, and the
request rows and dialog. Does not own who may add a participant (the add paths
in [`workstream-durable-object.md`](workstream-durable-object.md) and
[`substream-creation.md`](substream-creation.md)), what the Activity tab lists
otherwise ([`digests.md`](digests.md#the-activity-tab)), the menu bar
([`menu-bar.md`](menu-bar.md)), or link parsing
([`links.md`](links.md)).

## Security and trust model

A link is routing context, not a capability
([`links.md`](links.md#why-the-id-is-in-the-path)). The
preview widens that one step on purpose: any active member who holds a Channel
or Breakout id learns its title and mark. That is what a Slack unfurl already
shows anyone in the Slack channel, and less than a Channel reached through a
Breakout shows.

The sealed approval is a bearer credential for one pending request, held in
the approver's inbox, and it acts only as the approver.

## Failure modes and limits

- **No approver.** A creator who left the Organization or the conversation
  itself, a missing creator, or a requester who created it gets 409
  `access_request_no_approver`, and the screen says to ask someone in it. The
  creator is asked the socket ticket's question as themselves before the
  request is recorded.
- **The approver lost the right to add.** The add's own refusal is shown: on
  the approve page as "Access was not changed", in the app as the dialog's or
  menu's error line, and the request stays pending.
- **No expiry and no request cap.** A pending request and its email link stay
  valid until answered. Whether either should expire, and whether asking needs
  a cooldown after a decline, is the team's call
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).
- **An Organization held below migration 95** (the meeting-notes retirement
  can hold one at 57) has no request table, or no Breakout projection, or one
  without its look. The list is read on every connect, so it answers empty or
  leaves the Breakout half out rather than aborting the connect: an unguarded
  read there stops the sidebar opening. Guard: `space-authority.test.ts`
  "given an Organization held at schema 57".
- **The APNs badge leaves requests out.** It is counted by
  `readerAttentionCount` on the server, which counts conversations only. The
  macOS dock badge and the menu bar include requests.
- **Approving can send two emails.** The decision email, and the ordinary
  "added you" email when the requester has no Slack link or push device.

## Testing

```bash
pnpm --filter @rally/api exec vitest run test/conversation-access-approval.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/conversation-access-requests.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/workspace-reach-changed.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/components/conversation-access-request.test.tsx \
  src/renderer/lib/workspace-socket.test.tsx \
  src/renderer/components/navigation-sidebar.test.tsx src/renderer/components/access-request-dialog.test.tsx \
  src/main/menu-bar-menu.test.ts src/main/channel-directory-watch.test.ts
pnpm --filter @rally/contracts exec vitest run src/desktop-deep-link-intent.test.ts
```

## Open questions

- Should a request go to more than the creator, for example every member who
  can share, when the creator has left?
- Should requests and their links expire?

## Changelog

### 2026-10-22 — Preserve the requester's waiting state on reopen

**What changed:** The access preview includes the signed-in person's pending
request and email-delivery state for clients at contract 12 or later. Desktop
and web show **Access requested — awaiting approval** for a pending request,
retain **Retry sending request** if email delivery failed, and discard older
preview reads when a send succeeds. Completion updates are bound to the submitted
conversation so navigating during a request cannot mark another one as pending.
Failed sends reconcile the stored state immediately rather than waiting for reopen.
Cache and mutation state are scoped to the requester as well as the conversation.
The access-push recovery version from PR #1416 is preserved when request completion
cancels an admission check, so the two recovery paths cannot lose a fast approval.

**Why:** The screen remembered only the current component's successful click.
Reopening showed **Request access** even though the Organization still held a
pending request, leaving the requester unsure whether they had asked.

**Considered and rejected:** Persisting a local sent flag: it would miss requests
from another device and outlive an approval or decline. The existing preview
RPC can read the authoritative pending row without another network hop.

**Consequences:** Pending state stays scoped to person and conversation. Older
desktops keep their original response shape, and a stored but undelivered email
remains retryable under the request's existing idempotency key.

### 2026-10-22 — Recover waiting conversations on an access push

**What changed:** The requester stores `workspace_reach_changed` or Organization
socket subscribe as a recovery version, replaces pending access checks, and
claims one admitted retry per conversation for that version.

**Why:** Approval previously waited for a backoff retry, and a socket stopped
after revocation required a manual retry despite the screen promising it would
open after approval.

**Considered and rejected:** A second approval-only event. The ordinary add
already publishes a targeted reach event for both threads and Breakouts, and
using it also covers a direct participant add.

**Consequences:** The event remains a nudge, not an authorization result. Only
an admitted preview retries the conversation, whose new ticket checks access
again. Reusing a pending preview can return a pre-grant refusal after the only
push has passed; cancellation must discard that result. The nudge is stored
independently of preview existence and retained by the Organization socket's
cache lease, because the two sockets' events can arrive in either order. Each
preview records the version when its
read started; recovery requires a successful idle result for the current
version. Consuming that version for the conversation survives a failed retry's
remount, preventing a loop. An Organization subscribe can therefore permit one
extra authorized retry of another connection failure; healthy conversations
mount no preview and make no additional request. An offline-paused check is not
a completed check and cannot consume the nudge.

PR: [#1416](https://github.com/juno-ai-labs/avalon/pull/1416).

### 2026-10-07 — A member with a link can ask to join

**What changed:** A member who opens a link to a Channel or Breakout they are
not in sees its name, color and icon and a **Request access** button. The
request is stored in the Organization object and addressed to the creator. The
creator can approve from the email in one click, or approve or decline from
the attention menu, its dialog, the conversation's People level, or the
macOS menu bar. The requester is emailed either way.

**Why:** The link showed "Channel could not be opened" and nothing else, so the
person had to find out who to ask somewhere other than Rally. Product asked for
a request button, a one-click email approval, the requests in the app's
activity area with inline approve and decline, a dialog from the menu bar, and
an email back to the requester.

**Considered and rejected:** An email-only request with no stored row. That
was the first version: it could not be listed in the app, and an old approval
link would re-add somebody removed since. Storing the request fixed both. A
link that grants on `GET`: mail scanners fetch links, so it would approve
requests nobody read. Buttons inside the macOS menu: a native menu row cannot
hold them, so the row opens a dialog in the main window instead.

**Consequences:** Requests and links do not expire, and asking again after a
decline is not limited (see above). A later change that lets someone other
than the creator approve should keep the add-as-approver path, so an approval
can never grant more than the approver could.
