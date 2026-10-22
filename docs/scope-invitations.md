# Scoped invitations

Scoped invitations share Main, individual children or a workstream with email
addresses. A share belongs to the address: whoever signs in with that verified
address holds it, and there is no acceptance step, link secret or confirmation
screen. The share and the grants it becomes live in the same Channel parent,
hosted in `WorkspaceDO`
([hosted conversation parents](hosted-conversation-parents.md)). Someone who
already signs in with the address is claimed as the share is made; anyone else
is claimed the first time they sign in. Until then they appear as a **Guest** in
the sharing panel. The shared email panel creates shares, lists those still
waiting for a sign-in, and revokes them, from the browser conversation header or
the native participant dialog.
The panel reports a created invitation to its container rather than confirming it
in place: the standalone share dialog dismisses itself, and the participant
dialog, which embeds the panel beside its own controls, stays open on an emptied
form. Participant mutations use the
parent grant ledger for every ready conversation; transcript execution stays in the
conversation owner.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/scope-grants.ts` | Batch, claim, revision and result contracts. |
| `apps/desktop/src/renderer/components/scope-sharing-panel.tsx` | Shared email form, stable retry operation, and the Guests still waiting to sign in, each revocable. |
| `apps/api/src/routes/sharing.ts` | Authenticated HTTP boundary; server-selected actor and recipient identities. |
| `apps/api/src/services/scope-invitation-claims.ts` | Claiming at sign-in: which Channels hold a share for the user's verified addresses, and asking each to claim; plus the old `inv_` token read for shares made before claiming. |
| `packages/db/migrations/0119_scope_share_recipients.sql` | `scope_share_recipients`: address to Channel lookup for shares still waiting for a sign-in. |
| `apps/api/src/services/scope-invitation-email.ts` | What the invitation says: the heading, the quoted preview, and the line about Rally. |
| `apps/api/src/services/conversation-preview.ts` | The last turns of one conversation, named and truncated for somewhere outside the product. |
| `apps/api/src/services/browser-session-service.ts`, `platform-onboarding-service.ts` | The two sign-in points that claim: browser session registration, and regional discovery. |
| `apps/api/src/durable-objects/scope-invitation-service.ts` | Current sharing authority, relationship admission, grant activation on claim, and email delivery. |
| `apps/api/src/durable-objects/scope-invitation-storage.ts` | Operation receipts, share state, encrypted delivery and claim binding. |
| `apps/api/src/durable-objects/hosted-parent.ts` | Addressed RPCs and delivery alarm execution. |
| `apps/api/src/services/workspace-service.ts` (`listInvitees`), `GET /workspace/invitees` | Pending Organization invitations as every member may see them: address and date, for the people pickers. |
| `apps/desktop/src/renderer/lib/workspace-invitees.ts` | The invitee query, the member-shaped invitee (`status: 'invited'`), and the directory the `@address` chip resolves against. |

## How it works

Creation validates the configured browser origin and signing/encryption keys before
starting any forward-only participant handoff. Configuration failure leaves the
existing conversation authority unchanged.

`POST /sharing` takes a caller-generated operation ID, one parent, explicit
targets, recipient emails and an explicit nullable expiry. The authenticated
workspace and actor override no caller-provided identity fields: such fields are
rejected by the public schema. Every target must be in that workstream, and
current direct/inherited collaborator grants must authorize sharing it. Its
participant-authority handoff must complete before an invitation is recorded.
Grants are the only serving authority for Channels and Breakouts. New Main
conversations finish the bootstrap handoff before creation returns; private
children finish it when their opening content becomes durable and they become
ready. Existing conversations import their historical rosters once, in the
foreground when addressed or through the upgrade's durable migration alarms.
Main imports preserve existing Channel grants; child imports use only the
parent's historical child membership, never a stale child-local seat. If grants
already exist, the handoff freezes and reconciles the source without importing
its roster over those decisions. Frozen snapshots, incarnation bindings, receipts
and alarms retain the existing recovery protocol.

Sharing choices, transport, resource authorization and Breakout listings read
grants. No serving path falls back to a directory or historical roster. Pending
handoffs refuse admission until completion. Current relationships and grants are
rechecked after external awaits; implicit Organization-wide reading does not
confer sharing authority. An unpublished Breakout's local seats are bootstrap data
only; it is not publicly readable until its parent publishes its grants. Hidden
import agents remain creator-only reservations at the parent, with a signed
bootstrap membership version; they are not ready Breakouts.

One operation records an invitation per distinct email, with stable grant
operation IDs and an encrypted email payload. Its transaction schedules the
existing alarm mechanism. Retrying the same operation returns its recorded
invitations; changing its input conflicts. Delivery retries use the same
provider idempotency key and encrypted body.

Participant grant commands issued by message admission carry
`participationReason: "message"` through their durable receipt and projection.
That projection starts unread after existing history and suppresses the added
notice because the canonical message sends the more specific mention notice.
Ordinary shares and participant additions retain their existing behavior; the
conversation admission rules are in
[`workstream-durable-object.md`](workstream-durable-object.md).

Manual adds, confirmed mentions and connector audiences all issue parent grant
commands, for members and guests alike. Connector events retain immutable
receipts, so replay cannot restore a participant revoked later. Correcting creator
attribution does not itself seat anyone. Existing-conversation additions address
only that conversation; inherited Channel shares must be managed at their owning
scope. Creation-time participants retain the new Channel's initial access.

The conversation's `participants` table remains a versioned projection for names,
unread state, participant epochs and socket admission. Its identity/status writes
are frozen by SQLite triggers; only parent projections may update them. Opening
and read-position metadata stay local. Ordinary messages whose participants are
already seated need no grant RPC. Message admission sends all missing participants
in one parent command, retaining one operation receipt per person. Pending
projections for a conversation travel in one callback, including connector
admission and handoff recovery. The source hydrates active recipients and actors
in one D1 batch and reuses those request-local profiles for notification names
and realtime frames; profiles never authorize access. Removals need no profile
hydration, and manual adds perform actor authorization once. Visibility changes synchronously deliver their
durable common effect to the parent so a newly public reader can join immediately.

Completing a handoff delivers the pending participant projections for the whole
addressed conversation before returning. This includes the original sharer:
their next socket ticket names the new projection revision too. Durable delivery
intents and alarms recover interrupted transfers and projection calls.

### Claiming

**A share is claimed by signing in, and by nothing else.** The address the
sharer typed is the whole of what the share names, and a verified sign-in with
that address is the whole of the proof. There is no token in the link and no
acceptance request: the explicit step that used to sit between sign-in and the
conversation only existed so a mail scanner fetching a link could not consume
it, and with nothing in the link to consume, an email one-time code or Google
sign-in is already a human proving they hold the mailbox.

Creation writes one `scope_share_recipients` row per address in D1, naming the
Channel that holds the share, once the Organization object has recorded it, so
a refused caller writes no rows. The share stays in the object, beside the
grants it becomes; the row only says where to ask. If that write fails the
request fails, and the sharer's retry replays the same operation to it. A claim
or revocation that deletes rows re-checks afterwards and restores any whose
address gained a pending share meanwhile, so a delete racing a new share to the
same address cannot leave it without a row. A share whose sharer's membership
was replaced can never be claimed, so a claim that meets one retires it, and its
row clears instead of costing every later sign-in. Every refusal is logged as
`scope_invitation_claim_refused` with its reason.

`claimScopeInvitations` (`scope-invitation-claims.ts`) looks up rows for the
user's verified addresses in `user_verified_emails`, plus any address the caller
has verified itself, in one D1 query, and asks each Channel to claim, in
parallel. It runs at two
points:

- **Browser session registration**, which every browser sign-in passes through:
  email one-time code, magic link, Google, and activation in another deployment.
  It runs before the session is described, so the Organization it just joined
  is in the list the browser receives.
- **Regional discovery**, which desktop sign-in and cross-deployment activation
  both use. It passes the Global identity's address, since a person known to a
  deployment only through the platform link may have no verified row there.

**Creation also claims at once** for every address that already belongs to a
user in this deployment. That person holds the share before the response
returns and shows up as a participant, not a pending Guest; they still get the
email, which is how they hear of it.

A claim, per pending share for one of the addresses, checks that it is usable
(not revoked, not past `expiresAt`), that its targets have finished their
participant migration, and that the sharer still holds the share in the
membership incarnation they shared it from. It establishes an ordinary guest
relationship if absent, preserving full members and refusing suspended
relationships, then re-reads the share and sharing state and commits all target
grants with the claim receipt in one local transaction. A share that cannot be
claimed yet stays pending and keeps its lookup row, so the next sign-in tries
again; once nothing is pending for an address in that Channel, its row is
deleted. A Channel that cannot be reached is logged as
`scope_invitation_claim_failed`; a failed lookup is logged as
`scope_invitation_claim_lookup_failed`. Neither fails the sign-in.

A claim is a cross-authority operation only at the relationship step. If the
process stops after creating the D1 relationship, that relationship confers no
conversation access, and the next claim resumes grant activation. Within the
grant owner, a failed target write rolls back all targets and the receipt.
Whoever's claim created a guest relationship publishes it right away, rather
than waiting for the cron sweep: the sharing route for a claim made as the share
was created, and the claim service for one made at sign-in.

The email's link is the conversation's own address,
`<browser origin>/app/workspaces/<region>/<workspace>/workstreams/<channel>` with
`/substreams/<id>` for a child share. It carries nothing a holder could present,
so a forwarded copy opens a sign-in page and nothing more. Signing in with the
right address lands in the conversation; any other address finds no access.
Only one deployment exists today; if a second one serves Organizations, an
email-only identity cannot cross deployments, and the link's sign-in will have
to happen in the deployment it names.

### What the invitation says

The email leads with the person and the workspace — "Morgan Ellis invited you to
Juno Labs on Rally." — then the address to sign in with and the link, then the
end of the conversation being offered, then one line on what Rally is. Its old
body named none of that: a recipient could not tell who was asking, what for, or
whether the mail was meant for them, and an unfamiliar product asking for a
sign-in with nothing else on the page is indistinguishable from a phishing
attempt.

The preview is the last five turns of the offered conversation, each cut to a
hundred words, above a count of everything earlier ("14 earlier messages"). Both
numbers are the product owner's, set on 2026-09-19: enough to recognize the
work, not so much that a long thread arrives in a mailbox. Only turns of type
`text` are read, so tool output and system notices never leave this way, and
each turn's whitespace is collapsed so a paragraph break inside a quoted message
cannot read as the end of the quote. Before the quote is composed, its stored
Markdown passes through the same plain-text reduction used by push and mention
notifications: a link keeps its visible label, while emphasis, code delimiters,
Rally targets and other renderer syntax do not leak into the mailbox. Reduction
happens before the word and byte limits, so a cut cannot strand half a Markdown
link and the limit measures the words the recipient can actually read. A real
turn made only of formatting becomes “Formatting-only message.” rather than an
empty author row; it stays in place so the preview remains a contiguous suffix
and “earlier messages” still means every omitted turn came before it.

**Which conversation is the one the invitation opens onto**: the first target,
which is Main for a work-stream offer and that conversation for a conversation
offer. Never a second conversation, and never the parent of a child-only share.
The preview is bounded by the offered scope exactly as the grants are; a preview
that widened would put work outside the share into a mailbox nobody has
authenticated, which is the thing scoped invitations exist to prevent.

**This does put conversation content in front of an unauthenticated address.**
The sharer chose that address and can read everything they are sharing, which is
the authority it rests on, and the same sharer could paste the same text into
the same mail themselves. What changes is that a mistyped address now receives
work rather than only an invitation, and that revoking an invitation cannot
unsend what was quoted in it. That is the accepted cost of an invitation a
recipient can recognize; a future change that widens what is quoted is changing
that bargain, not extending it.

The message goes out as both parts, composed once and stored together so a
delivery retry sends what was composed rather than something rendered again
later. The styled part is the same template Rally's workspace invitation uses:
one 560-pixel table, inline styles, the brand mark, the black "Open in Rally" button, the
quoted turns behind a left rule.

**What that template may use is decided by where it is read.** Gmail drops a
`<style>` block in several of its surfaces, so nothing load-bearing lives in
one, and there is no `@media` query to lose: `width:100%` under a `max-width` is
the whole of the responsive behaviour. No flexbox, no grid, no positioning, no
`@font-face`, no background images, since each fails somewhere popular and none
is needed to lay out one column. The brand mark is the only remote asset and the
layout does not depend on it loading. Every value interpolated into it is
escaped, so a member's message is text in both parts and markup in neither. A
test asserts each of those, because the rule is invisible in a template that
happens to render correctly in a browser.

Gmail clips a message past 102,400 bytes and shows a "view entire message" link,
which would cut off the footer and the link with it
(https://support.google.com/mail/answer/81126, read 2026-09-19). Five turns of a
hundred words is a few kilobytes of ordinary prose, but a word limit is not a
size limit — a message with no spaces in it is one word however long it is — so
each turn also carries a ceiling in UTF-8 bytes. That ceiling is not a number
anyone here chose: it is Gmail's, less 8 KiB for everything that is not a quoted
turn, divided across the five of them and again by six, the longest entity
`escapeHtml` produces (`&quot;`), so a turn made entirely of quote characters
still fits. Cutting is by code point, so a multi-byte character is never split
in half. A test holds the whole body under the ceiling on the worst input the
preview can carry.

Everything in the heading and the preview is cosmetic, and none of it can fail
an invitation. The names are read from D1 and the turns from another object; a
failure of either sends the invitation without that part, and the heading has a
sentence for every name it did not get, down to the line this email carried
before. That is also why the failure is logged with the `ObjectPortError` code
rather than its name: every port failure is one class, and a preview that has
silently stopped rendering for everyone otherwise looks exactly like a run of
invitations to empty conversations. Names, titles and authors are collapsed to
one line before rendering, because a plain-text email has no other structure to
forge, and member-written
turns are quoted with `>` below the real link so a message ending in its own
sign-in sentence cannot sit where ours does.

`DELETE /sharing/:parentId/:invitationId` requires current sharing authority and
the observed revision. It revokes only a pending share, and deletes the address's
lookup row once nothing else waits for it there. If a claim won first, the caller
must remove the scope grants explicitly; an invitation operation must not erase
another independently granted scope.

### Sharing interface and scoped listing

`POST /sharing/list` accepts an exact target and derives the actor from the
session. The owner first checks sharing authority on that target, then releases
only invitation summaries whose every target is still shareable by that actor.
An invitation spanning Main and a child is hidden from someone who can share only
the child, even if they could previously manage Main. Listing never returns
credentials, email bodies or grant-operation receipts.

The shared panel deduplicates normalized email addresses. A failed response keeps
the same operation ID for the unchanged recipient/scope selection; success clears
the draft and refreshes invitation summaries. Below the form it lists the shares
for its conversation still waiting for a sign-in, each as a **Guest** row with
the address and a remove control that revokes it at the displayed revision.
Claimed shares are not listed there: their recipient is a participant, labelled
Guest in the participant list when their relationship is a guest one, and is
managed through grant/participant management.
The panel reads `/sharing/:parentId/options` for shareable scope choices. Choices use canonical grants after any required historical import.
Choices are advisory; creating the invitation repeats current authority checks.

Several independent scopes can be selected. The complete-workstream choice is
available only when the actor can share every existing ready restricted child
and the parent. Its targets contain the parent grant and explicit restricted
children, without redundant Main or inheriting-child grants. `completeWorkstream`
asks the owner to verify current coverage immediately before committing creation;
a newly added restricted child returns `scope_changed`, rather than accepting a
stale incomplete selection. A committed operation still replays its original
receipt after later children appear. Future restricted children are excluded by
their new boundary, as stated in the UI.

Preparing a parent grant also prepares all existing ready inheriting children.
Those children need the same participant-authority handoff before guest serving,
even though their access comes from the parent grant rather than an explicit
child grant. Creation and acceptance require those handoffs to be complete.

### Accepted-share management

The panel lists direct grants in the selected scopes through
`/sharing/grants/list`. The Channel's parent admits the authenticated actor against that
exact scope, reads profiles only for its grantees, then rechecks the actor's
relationship and local grants after those external profile reads. A suspension
or loss of sharing authority during lookup returns denial rather than stale
labels. This is not a workspace member-directory query.

`/sharing/grants/revoke` supplies the server-selected actor and `active: false`
to the existing grant mutation authority. The UI submits the displayed grant
revision and retains an operation ID for that grant/revision across retries.
A conflict refreshes the list for a new explicit action. A retried old removal
cannot overwrite a later re-share. Lists refresh after success; they do not
infer current access from an old operation receipt. Removing a direct child
grant leaves Main, parent and sibling grants intact. Inherited access can remain,
and the panel states that distinction. Existing last-participant rules apply.

### Invitees in the people pickers

Somebody invited to the Organization has no user until they sign in, so they
cannot be a participant or a person mention. They can be shared a conversation
by address, which is this module, and that is how the pickers bring them in.
`GET /workspace/invitees` lists the addresses with a pending Organization
invitation to any member (a guest is refused, as for the roster), leaving out
an address that already has a membership. The desktop reads it under
`['workspace-members', 'invitees']`, so the roster's `member_directory`
publication, which an invitation, acceptance and revocation each send, refreshes it.

Every surface that lists people to pick offers invitees after the members,
labelled **Invited** with the address in muted italics; the `@` list also
labels everyone else **Member** or **Guest** in place of the old **Person**, and
Rally **AI**:

- **The composer's `@` list.** An invitee's mention is the typed `@address`;
  no identity rides with it. On send the composer hands the host the invitees
  the text names, read whole and Markdown-aware
  (`@rally/contracts/email-mentions`) so code, links and a longer address
  never match, and the host shares the conversation with them before the
  message goes, after the send holds its attachments. An address already
  shared here is neither asked about nor shared again, since each share is its
  own email. A personal Channel asks first, in the dialog that already asks
  about members from outside.
- **The People level of the title menu.** Suggested lists invitees with an
  Add that shares by address, as typing the address and pressing Enter does.
- **The new-Channel Participants row.** An invitee is held as a member-shaped
  entry (`status: 'invited'`, id `invitee:<address>`), kept out of
  `participantIds`, and shared the Channel once the create answers. That share
  is not awaited, so the Channel opens on the create alone; a failure is logged
  and shows as the address missing from the Channel's People. An address typed
  into the search that no member holds is held the same way, which is how
  someone outside the Organization is invited as the Channel is started.
- **The breakout launch composer.** As the Channel composer, except the
  breakout does not exist when the message is sent: the host shares it with the
  named invitees once the create answers, unawaited, as the new Channel does.
- **The Add a participant dialog.** Invitees not yet shared the target are
  listed after the members, and adding one shares it by address, the same
  write as the share panel the dialog embeds.
- **A Space's participants.** Not a share: a Space grants no access, so its
  invitees are listed by address and seated as participants when they accept
  ([Spaces](spaces.md#participants)).
- **iOS, the Channel details sheet.** Lists invitees under People and shares
  the open conversation with the one tapped.

When the invitee signs in, the claim makes them a guest of the Channel, and
accepting the Organization invitation makes them a member, which keeps the
grant.

## Invariants

- A share is held by the verified address it names and nothing else. A forwarded
  link opens a sign-in page; profile email alone is never proof.
- Only a pending share is ever claimed. A claimed share is never claimed again,
  so a later claim never reapplies a revoked grant, recreates a removed
  relationship, or binds the share to a replacement relationship.
- The actor's recorded membership incarnation must still be current. Rejoining
  does not restore their old shares' authority.
- The grant transaction and the claim receipt cannot be separated. A grant
  commit without its receipt would let an interrupted claim restore a later
  revocation.
- A lookup row is a hint, never authority. The Organization object decides; a
  row with nothing pending behind it is removed by the next claim that reaches it.
- A lookup row stays while anything is pending for its address in that Channel,
  so a share that could not be claimed yet (migration, sharer state, a failure
  mid-transaction) is retried on the next sign-in.
- Claiming never fails a sign-in.
- An invitee's stand-in id (`invitee:<address>`) never reaches the server. It
  carries `status: 'invited'`, and every surface that sends ids already keeps a
  membership that is not active out of what it sends.
- The preview reads the offered conversation and no other. Main is previewed
  only where Main is what is offered.
- Nothing rendered into the email can fail the invitation. A name, a title or a
  transcript that cannot be read is left out; only the link is load-bearing.
- Email bodies are not returned by public routes. The only stored readable copy
  is encrypted with the existing server key.
- Browser setup, onboarding and connector configuration are outside the lite
  client; existing scoped collaboration remains the intended product scope.

## Boundary

The workstream owns invitation/grant ordering. D1 owns verified identities and
workspace relationships. Email providers own delivery, not admission. Browser
routes and UI own presenting per-workstream progress when sharing several
workstreams; there is no atomic transaction spanning their independent owners.
New grants still require the existing participant-authority handoff and projection
before serving conversation traffic. This module does not bypass that gate.

## Failure modes and limits

No invitation-expiry number or recipient cap is invented. `expiresAt: null`
explicitly leaves expiry open; policy values remain a team decision. The one
number bounding this module's output, the per-turn byte ceiling above, is
arithmetic on a published platform limit rather than a policy guess: change
Gmail's documented figure and the ceiling moves with it. Existing platform
request/storage limits still apply. Invalid origin/key configuration
refuses creation. `BROWSER_APP_ORIGIN` and the existing encryption key are
required; the existing transactional Resend configuration delivers mail.
Development/test delivery uses the shared sender's no-send behavior.

A send accepted by the provider followed by a lost acknowledgement is retried
with the same key. Revocation during an in-flight send may still deliver a link;
it opens nothing, since the revoked share is never claimed.

`token_hash` on `parent_invitations` is retired but still `NOT NULL UNIQUE`; new
rows store the invitation's own id there rather than paying for a table rebuild.
Shares made before this change had no lookup row. WorkspaceDO migration 93
schedules a `parent_invitation_index` alarm for each parent holding a pending
share, and the alarm writes that parent's rows, once, with the alarm system's
retries. The server does all of it: an old `/invite#inv_…` link is just a
sign-in page, and signing in claims the share like any other. A corrupted
receipt or unavailable identity authority remains an error, never a grant.

## Testing

`participant-notification.test.ts` drives confirmed guest mentions in personal
and Organization-wide Channels, manual guest add/remove/re-add, creation-time
participant and mention replay, and member/guest Breakout mentions through real
workerd. It obtains tickets through `ConversationService`, upgrades them through
`SocketService`, and receives a conversation snapshot for recipient and sharer.
It also checks that a Breakout share does not admit Main and that revocation
refuses a fresh ticket. Guest fixtures have a null role, matching production.

`pnpm --filter @rally/api test:workers test-workers/scope-invitations.test.ts`
runs real D1, `WorkspaceDO` SQLite, RPCs, alarms and HTTP routing. The fixture
declares the D1 columns it uses. It covers a share claimed as it is made for an
existing account, one held for an address with no account and claimed by a
real browser one-time-code sign-in with no further step, that someone else's
claim reaching the same Channel takes nothing, a Global-verified address this
deployment has not recorded, child-only access, atomic multi-target claiming
with the share left pending after a rollback, re-claiming after removal and
revocation, revoked and expired shares, a lookup outage that leaves the sign-in
intact, a delete racing a new share's row, the old `inv_` token claiming only
for the right address, sharer replacement, stable
operation/email receipts, relationship publication, and the link's exact form.
It also proves the bound the whole feature rests on, against real conversation
objects with distinct transcripts in Main and in a child: an offer of the child
quotes the child and never Main, an offer of Main quotes Main and never the
child, and a system notice in either is not conversation and never leaves. That
case needs the runtime — the Node fixture resolves every substream id to one
database, so the same assertions there would pass with the boundary broken.
It also checks that an `expiresAt` past the `Date` range is refused with the
field named in the diagnostic, and that a preview failure is logged with the
port code that says which authority refused.
`apps/api/test/scope-invitation-email.test.ts` covers the body: the heading and
each of its fallbacks, a name carrying a newline, the quoted turns, the singular
and plural earlier-message line, word truncation, the byte ceiling that bounds a
single wordless message, and `readConversationPreview`
against a real seeded transcript — reading order, the count of what is not
shown, an author named from D1, the agent, and a conversation nobody has spoken
in. It also covers the styled part: that it carries everything the
text part says, that it uses none of the CSS its clients drop, that a script
tag, an image tag and quote characters written into a message or a name arrive
as text, and that the whole body stays under Gmail's clipping ceiling. The
runtime suite proves the delivered payload carries both parts with the sender
and the workspace in them, and that an invitation whose conversation cannot be
previewed is still sent. The deliberate SQL failure is caught inside the real object because
the test RPC bridge otherwise reports its expected rejection twice.
`message-to-output-pipeline.test.ts` additionally exercises invitation-triggered
handoff against real Main and child agents, including refusal to transfer for a
nonparticipant and reconciliation of a stale child roster.

## Changelog

### 2026-10-21 — Grants own every ready conversation's participation

**What changed:** Creation and publication complete the participant handoff;
existing conversations receive durable upgrade backfill. Manual adds, mentions,
connector admission, viewer/resource authorization, owned-Sidekick participation
checks and Breakout discovery use
parent grants. Source rosters become fenced projections. A parent with grants
already in service reconciles its source without importing stale seats. Visibility
commands deliver their durable common effect before returning. Admission and
handoff projection delivery are batched by conversation, sharing one profile
read for effects and realtime output and avoiding duplicate manual authorization.

**Why:** A confirmed mention put a guest on a private Channel's local roster and
published a sidebar entry, while transport required a grant and returned 404.
Manual adds, creation, connectors and Breakout mentions exposed the same split.
Keeping two writable admission systems would repeat it for the next caller.
Per-person RPC callbacks and repeated profile reads also made admission latency
grow with the roster; batching preserves the same authority and receipts without
paying those network round trips for each recipient.

**Considered and rejected:** Letting guests read the old roster would bypass grant
incarnation and revocation fences. Patching only the mention writer would retain
competing authorities. Dropping historical rows immediately would strand existing
conversations; retaining them as serving fallbacks would preserve the defect.

**Consequences:** Historical rows are one-time import/bootstrap input, never a
fallback. Parent decisions converge through revisioned projections; replays cannot
restore revoked access. Handoff success delivers every affected projection,
including the sharer's. Unpublished child content installs before publication;
normal posting retains its local fast path. An implicit public reader cannot
manufacture sharing authority by narrowing visibility.

### 2026-10-08 — Offer pending Organization invitees wherever people are picked

**What changed.** `GET /workspace/invitees` lists pending Organization
invitations to members. Every people picker (the `@` list in a Channel and in a
breakout being started, the People level, the new-Channel Participants row, the
Add a participant dialog, a Space's participants, and iOS's details sheet)
offers those addresses as **Invited**. Picking or mentioning one shares the
conversation with the address; a Space lists it until they accept. The `@` list
labels people **Member**, **Guest** or **Invited** instead of **Person**, and
Rally **AI** instead of **Bot**.

**Why.** A teammate invited during onboarding could not be tagged in a Channel
until they accepted, so the inviter added them a second time at the Channel by
address. That second step is exactly a share by address, so the pickers now do
it for them.

**Considered and rejected.** Creating a placeholder user and an `invited`
membership at invitation time, so an invitee had a real id to mention and add.
`users.email` is unique and every sign-in path creates its user by inserting,
so a placeholder would collide with the invitee's own sign-in and need identity
linking by address across three creation paths. Reusing the share keeps
identity untouched, at the cost of a mention that carries no identity and an
extra email from the share.

### 2026-10-06 — Claim shares at sign-in; drop the acceptance step and the link token

**What changed.** Sharing by email no longer needs the recipient to accept.
Signing in with the shared-with address claims every share waiting for it:
browser session registration and regional discovery both call
`claimScopeInvitations`, and creation claims at once for an address that
already belongs to a user. A new D1 table, `scope_share_recipients`, maps an
address to the Channels holding its pending shares. `POST /sharing/accept`,
`POST /browser/invitation`, the `inv` link token and its HMAC are gone; the
email links to the conversation's own address and says "Open in Rally". The
sharing panel lists shares still waiting for a sign-in as Guest rows the sharer
can remove.

**Why.** The product owner judged the one-time code a sufficient safeguard on
its own. The acceptance click was there so a mail scanner fetching the link
could not consume it, but a human proving they hold the mailbox already happens
at sign-in, so the click after it added a screen and no protection. The token
existed only to carry that acceptance secret and to route the link, and both
jobs went with it.

**Considered and rejected.** Keeping the token and auto-accepting in the browser
after sign-in was smaller, but kept a client-side protocol, an unauthenticated
preview route and a link secret for a step nobody sees. Moving pending shares
into D1 entirely would split a share from the grants it becomes, losing the
single transaction that stops an interrupted claim restoring a later
revocation; the lookup row is only a hint for that reason. Having the browser keep an
old link's token and present it after sign-in, so shares made before this
change still reach their recipient, was replaced by a one-time server-side
index (WorkspaceDO migration 93): the browser should carry no protocol.

**Consequences.** A share is held by an address, so anyone who later holds a
verified sign-in for it takes what is still pending; revoke a share sent to a
wrong address. Email-only identities do not cross deployments, so a second
deployment serving Organizations needs the link's sign-in to happen there.
`parent_invitations.token_hash` is retired but still constrained, and stores
the invitation id. Shares made before this change are indexed by a one-time
WorkspaceDO alarm (migration 93), so old links need no special handling. The
`link_payloads` table is no longer used and can be dropped after deploy.

PR: [#1120](https://github.com/juno-ai-labs/avalon/pull/1120). PRD: [guest sharing](PRDs/2026-09-16_guest-sharing-browser/prd.md).

### 2026-09-21 — Make outside-product conversation previews plain text before sizing

**What changed.** Conversation previews now reduce each complete stored turn to
plain text before applying their word and byte budgets. Links keep their visible
labels and renderer-only syntax stays out of both invitation email parts. A
turn whose Markdown has no plain-text content keeps its place as
“Formatting-only message.”

**Why.** The invitation email quoted canonical Markdown into a client that has
no Rally renderer, exposing destinations and delimiters such as
`[PR #838](https://github.com/…)`. Reducing after truncation was insufficient:
a word cut could split a link first and leave syntax that the reducer could no
longer recognize.

**Considered and rejected.** Dropping empty reductions and fetching older prose
would show more words, but it would stop the preview being a contiguous suffix;
the “earlier messages” count could then describe a newer omitted turn as
earlier than the rows below it. Keeping the real turn with explicit copy
preserves ordering and exact count semantics without leaking its Markdown.

**Consequences.** Any future consumer of `ConversationPreview` receives plain
text already bounded for display and must preserve reduction-before-sizing.
Formatting-only turns remain visible placeholders rather than disappearing, so
new renderers must treat the preview as complete presentation text rather than
canonical transcript Markdown.

PR: [#890](https://github.com/juno-ai-labs/avalon/pull/890).

### 2026-09-19 — Put the emailed link behind one token, and say what the invitation is for

The invitation email published the server's routing to its recipient:
`#region=…&workspace=…&workstream=…&invitation=…&token=…` told anyone the mail
reached which deployment, workspace and work stream they were being offered,
before they had accepted anything and whether or not the invitation was theirs
to accept. Only the secret was ever a credential.

That secret is now the token itself rather than a field the row carries beside
the routing. The first revision stored both, which quietly made `link_payloads`
a second place a working invitation could be read out of: a dump of it replays
through the addressed request body that is still accepted, and no amount of
guarding the row changes that a row holding a presentable secret is a copy of
one. Collapsing the two removes the copy. The owner keeps the token's HMAC and
the row keeps its SHA-256, so the link in the recipient's mailbox is the only
place the value exists, and a future change that wants a handle separate from
the secret is reintroducing that second copy, not adding a layer.

The link is now a typed token over a shared `link_payloads` row rather than the
four fields encrypted into the URL, which was the first thing built here. Both
hide the same information; the row wins on two counts the sealed form could not
match. It is 47 characters instead of 321, because a pointer does not grow with
what it points at. And outstanding links stop depending on
`OAUTH_STATE_ENCRYPTION_KEY`, which under sealing would have made a key rotation
silently invalidate every unaccepted invitation. What it costs is a table, a
write on the sending path and a read on every open, and those are the things to
weigh if this is ever revisited. The row is also why the link still names no
region: only the deployment holding it can resolve it, so naming one would be
routing the client already has.

Review also caught the preview drifting from acceptance. `describe` checked the
secret and `usable()` and stopped there, while acceptance also requires the
targets' migration to be complete and the sharer to still hold the share they
offered, in the incarnation they offered it from. A preview that outlives those
is a mailbox oracle — it keeps naming who an invitation was for after nobody can
accept it, which is not something its holder could have learned by trying. Both
now ask one predicate, which returns the reason so acceptance can keep answering
`migration_pending` and `sharing_required` separately while the preview collapses
every reason into its one sentence. The same round narrowed
`POST /browser/invitation` to the opaque token: on the addressed branch nothing
is looked up, so an unauthenticated caller's own identifiers reached a Durable
Object stub, and a missing work stream came back as a 500 where every other
answer there is one 403.

Two smaller things the first revision got wrong are worth keeping written down,
because both are properties of minting before committing rather than of this
feature. A row is reachable only by the token that reads it, and that token is
never stored — so a creation that mints and then does not record is the last
place those rows can ever be deleted from, and it now does. And `expiresAt`
reached `new Date(value)` for the first time here, which turned a value the
contract had always accepted into a `RangeError` naming nothing; the ceiling is
the `Date` range, set where the rejection can still say `expiresAt`, and it is
not the policy expiry the team has yet to choose.

The store is generic because the shape recurs: a URL that should not describe
its subject is not specific to invitations. The prefix is the type, and the type
owns the schema, so one table can hold every kind of link without any kind being
readable as another.

Taking the identifiers out took the invited address with them, and the form
still asks the recipient to sign in with the mailbox that received the
invitation. `POST /browser/invitation` gives it back, unauthenticated, because
the page needs it before a session can exist; it checks the same secret on the
same invitation state acceptance does and releases nothing else, so the link's
authority is unchanged. A future change must keep those two checks identical:
a preview that outlives acceptance's conditions turns a revoked invitation into
a mailbox oracle.

The addressed request body is still accepted so that links already sent keep
working. It is the only part of this that is temporary — drop it once no such
link is outstanding, and the union at both routes goes with it.

Hiding the identifiers also left the email saying nothing at all: a link, and a
sentence about signing in. So it now opens with the sender and the workspace and
quotes the last five turns of the conversation being offered, each cut to a
hundred words, over a count of what came before. That is a deliberate widening
of what an invitation discloses, and the reasoning is in **What the invitation
says** above: the sharer already chose the address and could paste the same text
themselves, the preview is bounded by the offered scope, and the cost is that a
mistyped address receives work and a revocation cannot unsend it. A future
change that quotes more than the offered scope, or quotes anything but said
text, is reopening that decision rather than following it.

The preview reads another object's transcript, so every part of it is written to
fail quietly: a transcript, a workspace name or a sender name that cannot be
read is left out and the invitation goes anyway. An invitation that failed
because a title could not be rendered would be the worst of both.

Both parts are composed together and stored together. The styled one reuses the
workspace invitation's template rather than introducing a second look for the
same product, and it is restricted to what its readers actually render: tables
and inline styles, no `<style>` block, no media query, no flexbox or grid. Those
are not stylistic preferences and they are asserted in a test, because a
template that renders correctly in a browser says nothing about the clients it
is read in. `html` is optional in the stored payload for exactly one reason: an
invitation recorded before this change still delivers, as the text it was
composed as.

PR: [#863](https://github.com/juno-ai-labs/avalon/pull/863).

### 2026-09-19 — Dismiss the share dialog, and drop the invited-address notice

The share dialog exists only to take email addresses, so leaving it open after a
successful share made the user close a form that had nothing left to do. The
panel now reports success to whoever rendered it rather than deciding for itself,
because the participant dialog embeds the same panel beside its member list and
must stay open.

The `Invited <addresses>.` line went with it, on every surface this panel
appears on rather than only in the dialog that no longer outlives it. Keeping it for the embedded panel alone would
have left the same action confirmed on one surface and silent on the other, and
the pending invitation is not a delivered one: the line restated addresses the
user had just typed while the send itself is still an alarm away. The emptied
form is the acknowledgement now. Failures keep their own notice, and keep the
typed batch, because a retry needs both. If sharing later needs a confirmation
that means delivery rather than acceptance of the form, it belongs in an
app-level notice this tree does not have yet, not back inside the panel.

The outcome is handled on the `mutate` call rather than on the mutation hook,
which is what makes the dismissal safe. A hook-level `onSuccess` runs even after
its component is gone, so a share the user dismissed mid-flight would close
whichever dialog had been opened in its place and take the addresses typed into
it. React Query skips the per-call callbacks once the observer has no listeners,
so a dismissal belongs to the panel that submitted the share.

### 2026-09-17 — Order invitations with the grants they activate

External sharing needs retries to resume without restoring revoked access. The
invitation now lives beside the workstream's grants, so acceptance and all target
mutations commit together. A regional invitation row followed by independent
grant writes would require an additional distributed revocation protocol. The
remaining cross-authority relationship step is safe to resume because an empty
guest relationship grants no conversation access. Keep operation receipts and
membership incarnations intact when adding the browser and sharing interfaces.
First-share preparation drives the existing handoff because requiring an
operator to migrate each conversation would leave the product flow unusable.
Canonical participant checks precede preparation; current grant checks still
precede invitation storage. Scoped invitation listing and the shared email panel
reuse this owner rather than a workspace-wide invitation inventory. Every target
must remain manageable before its combined summary is released, and retries
retain their operation identity to avoid sending duplicate invitations. Read-only
legacy sharing choices avoid requiring an initial Main invitation just to expose
parent sharing. Complete coverage is verified at commit rather than inferred from
an earlier UI list, and inherited child handoff prevents a full share from leaving
its children on a legacy authority that cannot admit the new guest. Accepted-share
management addresses grant revisions directly; removing an invitation after it
was consumed would otherwise ambiguously revoke unrelated subsequent shares.
Profile reads revalidate admission on return so management labels obey the same
authority boundary as their mutations.
Legacy Main can be implicit, without a registered child row. Read-only choices
include it after checking the source participant; invitation preparation registers
it before handoff so old workstreams do not fail every first-share attempt.
