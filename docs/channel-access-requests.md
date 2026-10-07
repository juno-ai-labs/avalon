# Channel access requests

What an Organization member sees when they open a link to a Channel or Breakout
they are not in, and how "Request access" gets them in. They see its name, color
and icon and a **Request access** button. The button emails the conversation's
creator, and the **Approve access** button in that email grants access in one
click, with no sign-in.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/access-requests.ts` | `ConversationAccessPreviewSchema` (kind, title, appearance, `markId`, `open` or `requestable`) and the request's result. |
| `apps/api/src/durable-objects/workspace-do.ts` | `accessRequestSubject`: one unarchived Channel's or Breakout's title, appearance and creator, read from the `channels` and `breakouts` directories with no viewer check. |
| `apps/api/src/services/conversation-access-request-service.ts` | The preview, the request (finds the approver, seals the approval, sends the email) and `approveConversationAccess`, which opens the seal and runs the ordinary add as the approver. |
| `apps/api/src/routes/conversations.ts` | `GET /conversations/:parentId/substreams/:substreamId/access-preview` and `POST …/access-requests`, both signed in. |
| `apps/api/src/routes/conversation-access.ts` | The public `GET` and `POST /conversation-access/approve` pages behind the email's button. |
| `apps/desktop/src/renderer/components/conversation-access-request.tsx` | The screen with the mark, the name and the button. `conversation-surface.tsx` shows it in place of "Channel could not be opened". |

## How it works

1. **The refusal comes first.** Opening a Channel or Breakout asks for a socket
   ticket. For someone who is not in it, the ticket answers 404
   `conversation_not_found` and the socket hook keeps retrying with backoff, so
   the surface shows its error state. Only then does
   `ConversationAccessRequest` ask for the preview. Opening a conversation you
   are in makes no extra request.
2. **The preview.** The Worker refuses a guest (404) and asks the Organization
   object for the subject. It then runs the same `authorizeViewer` the ticket
   runs: `open` means the failure was something else and the client keeps the
   old error screen. `requestable` shows the request screen. A Breakout with no
   look of its own wears its Channel's, and `markId` is then the Channel's id,
   so its mark matches the sidebar and search.
3. **The request.** The approver is the conversation's `created_by_user_id`,
   who must be an active member and not the requester. The approval (workspace,
   parent, substream, requester, approver and a fresh operation id) is sealed
   with AES-GCM under `OAUTH_STATE_ENCRYPTION_KEY`. Its additional data is
   `rally-conversation-access-approval-v1`, so no other value sealed under that
   key opens as an approval. The email links to the region's own API:
   `PUBLIC_API_BASE_URL/conversation-access/approve?token=…`. Outside production
   no mail is sent (`sendResendEmail`), and in development the link is logged
   as `conversation_access_request_dev_link` so the flow can be tried locally.
4. **The approval.** The `GET` grants nothing. It serves a page whose one
   script, allowed by a per-response CSP nonce, posts the token straight back.
   The approver's click approves, while a mail scanner or link preview that
   only fetches the URL changes nothing. The `POST` opens the seal and re-reads
   the approver as an active member. It then acts as them under
   `principal: "connector"`, the authority the Space default delivery already
   uses with nobody signed in. A Channel runs `WorkstreamService.addParticipant`;
   a Breakout runs `SubstreamCreationService.changeParticipant`. Each enforces
   every rule an add from the app enforces, at the moment of the click.
5. **The requester gets in.** The ordinary add sends its usual "added you"
   notification. Their open screen needs nothing: the socket's next retry
   (backoff ceiling 30 seconds) is admitted and the conversation opens.

## Invariants

- **Only the creator's own add can let someone in.** The approval runs the
  same add the app runs, as the approver, so it can never grant more than the
  approver could grant by hand. Guard: the add paths' own tests. No test drives
  an approval end to end.
- **Fetching the link grants nothing.** Only the `POST` writes. Guard:
  `test/conversation-access-approval.test.ts` "answers the link with a page
  that posts the token back".
- **No other sealed value is an approval.** Guard: the same file, "refuses a
  value sealed under the same key for another purpose".
- **The preview names, it never reads.** It carries the title and the mark,
  never the description, roster, content or activity. Guard:
  `test-workers/conversation-access-requests.test.ts` asserts the whole
  subject, so a new field fails it.
- **A guest is told nothing.** The preview and the request answer a guest 404,
  per [`listing-rules.md`](listing-rules.md#invariants). Guard: none automated.

## Boundary

Owns: the preview, the request email and the approval link. Does not own who
may add a participant (the add paths in
[`workstream-durable-object.md`](workstream-durable-object.md) and
[`substream-creation.md`](substream-creation.md)), which conversations a person
is listed ([`listing-rules.md`](listing-rules.md)), or link parsing
([`workstream-links.md`](workstream-links.md)).

## Security and trust model

A link is routing context, not a capability
([`workstream-links.md`](workstream-links.md#why-the-id-is-in-the-path)). The
preview widens that one step on purpose: any active member who holds a Channel
or Breakout id learns its title and mark. That is the same thing a Slack unfurl
already shows anyone in the Slack channel, and less than a Channel reached
through a Breakout shows.

The sealed approval is a bearer credential for one add, held in the approver's
inbox. It names its approver, and the approval acts only as them.

## Failure modes and limits

- **No approver.** A creator who left, a missing creator, or a requester who
  created it gets 409 `access_request_no_approver`, and the screen says to ask
  someone in it.
- **The approver lost the right to add.** The click shows "Access was not
  changed" with the add's own message, for example a Breakout creator who
  left the Breakout.
- **No expiry and no replay guard.** An approval opens for as long as the key
  is unchanged. If the requester is removed later, the old email adds them
  again. Whether approvals expire, and after how long, is the team's call
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).
- **No request cap.** Every press sends a new email; the screen hides the
  button once one is sent. A cap or cooldown is likewise the team's call.

## Testing

```bash
pnpm --filter @rally/api exec vitest run test/conversation-access-approval.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/conversation-access-requests.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/components/conversation-access-request.test.tsx
```

## Open questions

- Should a request go to more than the creator, for example every member who
  can share, when the creator has left?
- Should approvals expire, or be single-use?

## Changelog

### 2026-10-07 — A member with a link can ask to join

**What changed:** A member who opens a link to a Channel or Breakout they are
not in sees its name, color and icon and a **Request access** button. The
button emails the creator a one-click approval.

**Why:** The link showed "Channel could not be opened" and nothing else, so
the person had to find out who to ask somewhere other than Rally. Product asked
for a request button, an email to approve, and approval without further steps.

**Considered and rejected:** A stored request row with an inbox in the app. It
needs a new table, a new notification kind and a screen to approve from, for
the same outcome as an email the approver can act on from a phone. The sealed
approval carries everything the add needs. A link that grants on `GET`. Mail
scanners fetch links, so it would approve requests nobody read. Opening the
approval in the desktop app. That adds a sign-in and an install between the
approver and "approve", which is the fuss the request asked to avoid.

**Consequences:** Approvals have no expiry or replay guard yet (see above). A
later change that stores requests should keep the add-as-approver path, so an
approval can never grant more than the approver could.
