# Scoped invitations

Scoped invitations offer Main, individual children or a workstream to verified
email recipients. The invitation and resulting grants live in the same Channel
parent, hosted in `WorkspaceDO`
([hosted conversation parents](hosted-conversation-parents.md)). Client integration lands in the browser-lite layer of the PR stack
(#825); this platform layer (#822) owns the protocol. The [lite browser entry](browser-client.md) accepts invitations through this
protocol. The shared email panel creates and revokes pending invitations from
the browser conversation header or native participant dialog. The same panel manages direct accepted grants.
The panel reports a created invitation to its container rather than confirming it
in place: the standalone share dialog dismisses itself, and the participant
dialog, which embeds the panel beside its own controls, stays open on an emptied
form. Participant mutations use the
parent grant ledger after first-share handoff; transcript execution stays in the
conversation owner.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/scope-grants.ts` | Batch, acceptance, revision and result contracts. |
| `apps/desktop/src/renderer/components/scope-sharing-panel.tsx` | Shared email invitation form, stable retry operation and pending revocation. |
| `apps/api/src/routes/sharing.ts` | Authenticated HTTP boundary; server-selected actor and recipient identities. |
| `apps/api/src/services/scope-invitation-link.ts` | The emailed link's token kind, what opens it, and the workstream address it names. |
| `apps/api/src/services/scope-invitation-email.ts` | What the invitation says: the heading, the quoted preview, and the line about Rally. |
| `apps/api/src/services/conversation-preview.ts` | The last turns of one conversation, named and truncated for somewhere outside the product. |
| `packages/db/src/link-payloads.ts` | The shared opaque-token store, documented in [`link-payloads.md`](link-payloads.md). |
| `packages/db/migrations/0114_link_payloads.sql` | The shared `link_payloads` table: token digest, type, JSON and optional expiry. |
| `apps/api/src/routes/browser.ts` | Unauthenticated `POST /browser/invitation`, releasing the invited mailbox to a link holder. |
| `apps/api/src/durable-objects/scope-invitation-service.ts` | Current sharing authority, verified mailbox, relationship admission, grant activation and email delivery. |
| `apps/api/src/durable-objects/scope-invitation-storage.ts` | Operation receipts, invitation state, encrypted delivery and acceptance binding. |
| `apps/api/src/durable-objects/hosted-parent.ts` | Addressed RPCs and delivery alarm execution. |

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
For legacy targets, creation consults Main's canonical participant roster or the
parent's canonical private-child membership, then starts/resumes the durable
handoff in the foreground. The existing alarm recovers interrupted transfers.
Only addressed scopes move; sharing a child does not require migrating Main.
Older parents may list Main implicitly, without a `conversation_children` row.
Sharing options include that real Main after canonical source authorization;
discovery remains read-only. First-share preparation records its registration
only after verifying source existence, participant authority and archive state,
then transfers the roster normally. It never fabricates Main from a directory
row or workspace-public visibility.
Creation rechecks current relationships and grants after preparation, so the
preparation check is never the final sharing authorization. Inactive relationships and non-shareable or archived targets report access denial. A conflicting
handoff reports `migration_pending` instead of writing grants ahead of import.
Workspace-public reading alone is insufficient even to start preparation.

One operation records an invitation per distinct email, with stable grant
operation IDs and an encrypted email payload. Its transaction schedules the
existing alarm mechanism. No GET consumes an invitation. Retrying the same
operation returns its recorded invitations; changing its input conflicts.
Delivery retries use the same provider idempotency key and encrypted body.

The email's link is `<browser origin>/invite#inv_<43 characters>` and nothing
else: a type prefix and 256 bits. Workspace, work stream and invitation are a
row in the issuing region's `link_payloads`, keyed by the token's SHA-256
digest. Those three identifiers were the server's own routing, published to
whoever the mail was forwarded to and describing the shape of a team they hold
no access to. They are now readable only by the deployment holding the row, and
the recipient learns where the invitation points from the acceptance they
authorized, not from the link.

**The acceptance secret is not in that row — the token that reads the row is
that secret.** The owner holds its HMAC and the row holds its SHA-256, so
neither store carries anything a holder could present. An earlier revision put a
second secret in the payload beside the three identifiers, which made a dump of
`link_payloads` a set of working invitations through the addressed request body
that is still accepted; one token doing both jobs removes that copy rather than
protecting it. Reading the row therefore proves only *which* invitation is being
asked about, and the owner still checks the presented token against the HMAC it
recorded.

**The store itself is [`link-payloads.md`](link-payloads.md)**, which owns the
prefix typing, a row's lifecycle and the rule that a payload may never carry a
presentable secret. It is shared rather than invitation-specific because a link
whose URL should not describe its subject is a recurring shape, and this is only
its first kind. What belongs here is what an invitation puts in it: `inv` carries
`expiresAt` or null as the row's deadline, so a row dies with the invitation it
addresses, and a row for an invitation with no expiry is retained — see that
document's **Invariants** for why nothing can reclaim it and what the open
retention question is.

`expiresAt` itself is bounded at the largest instant a `Date` can represent.
That is not a policy ceiling — policy expiry is still `null` until the team sets
one — but the point past which `new Date(value).toISOString()` throws
`RangeError: Invalid time value` while minting the row, from a value the
contract had accepted. Anything above it is refused at the schema, where the
rejection can still name `expiresAt`; anything larger again was already refused
for not being a safe integer, which is why the ceiling is the `Date` range and
not that one.

The token is minted before the sharing checks and the transaction, with every
other external await. A creation that is then denied, or that replays an earlier
operation, therefore mints rows addressing an invitation that was never
recorded. The alternative, writing the row after the invitation commits, risks
the opposite and worse failure, an invitation whose emailed link resolves to
nothing. Such a row is inert — opening it reaches an owner with no such
invitation, which refuses it exactly as it refuses a revoked one — but inert is
not reclaimed, so every path that does not record what it minted discards those
tokens itself. That is the only moment it can: afterwards nobody holds them.
Discarding is housekeeping and cannot fail the request, which was already
decided; a failure to discard is logged and leaves a row that is still inert.

`POST /sharing/accept` and `POST /browser/invitation` both take that token and
resolve it server-side; a token this deployment cannot read is refused in the
same sentence as a revoked invitation, because distinguishing them would tell a
holder something about an invitation they do not hold. The addressed request
body those routes took before — workspace, work stream, invitation and token —
is still accepted, so links already in inboxes when this shipped continue to
work; nothing mints that form any more, and it can be dropped once no such link
is outstanding.

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
one 560-pixel table, inline styles, the brand mark, the black accept button, the
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

`POST /browser/invitation` is the one unauthenticated read here, and it exists
because an opaque link cannot tell the sign-in form under it which mailbox to
fill in. It takes the token and nothing else: on the addressed body, which
acceptance still accepts, nothing is looked up, so the caller's own identifiers
would reach a Durable Object stub with no session behind the request — one
instantiated per workspace and parent id anyone cares to name, and a missing
work stream answered with a 500 where every other answer here is one 403. A link
minted in that format never carried a mailbox to fill in, so refusing it here
regresses nothing.

It checks the secret exactly as acceptance does, on the same invitation state
and through the same predicate for everything acceptance would refuse it for,
and returns that mailbox alone — never the workspace, the work
stream, the sharer or the scopes. A holder who can read it can also accept with
it once they hold the mailbox, so it releases no authority that the link did not
already carry.

`POST /sharing/accept` accepts an identity-only session. The owner checks the
secret, a current `user_verified_emails` binding, invitation state/expiry and the
sharer's current membership incarnation and scope authority. It establishes an
ordinary guest relationship if absent, preserving full members and refusing
suspended relationships. It then re-reads local invitation and sharing state and
commits all target grants with the acceptance receipt in one local transaction.
Participant projection delivery remains the grant ledger's responsibility;
`accepted` means the grants committed, not that every downstream holder applied
its projection.

Acceptance is a cross-authority operation only at the relationship step. If the
process stops after creating the D1 relationship, that relationship confers no
conversation access. A retry resumes grant activation. Within the grant owner,
a failed target write rolls back all targets and the acceptance receipt.

`DELETE /sharing/:parentId/:invitationId` requires current sharing authority and
the observed revision. It revokes only a pending invitation. If acceptance won
first, the caller must remove the accepted scope grants explicitly; an invitation
operation must not erase another independently granted scope.

### Sharing interface and scoped listing

`POST /sharing/list` accepts an exact target and derives the actor from the
session. The owner first checks sharing authority on that target, then releases
only invitation summaries whose every target is still shareable by that actor.
An invitation spanning Main and a child is hidden from someone who can share only
the child, even if they could previously manage Main. Listing never returns
credentials, email bodies or grant-operation receipts.

The shared panel deduplicates normalized email addresses. A failed response keeps
the same operation ID for the unchanged recipient/scope selection; success clears
the draft and refreshes invitation summaries. Pending invites can be revoked at
the displayed revision. Accepted shares use grant/participant management instead.
The panel reads `/sharing/:parentId/options` for shareable scope choices. This is
read-only: legacy Main uses its canonical participant facts, legacy children use
the parent-owned private roster, and transferred scopes use canonical grants.
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

## Invariants

- A forwarded link is insufficient: the authenticated user must hold its verified
  recipient mailbox. Profile email alone is never proof.
- The actor's recorded membership incarnation must still be current. Rejoining
  does not restore their old invitations' authority.
- The accepted user and membership incarnation are permanent receipt fields.
  Replaying acceptance never reapplies grants, recreates a removed relationship,
  or binds the invitation to a replacement relationship.
- The grant transaction and invitation acceptance cannot be separated. A grant
  commit without its receipt would allow an interrupted acceptance to restore a
  later revocation.
- The emailed link names no deployment, and only the region holding its row can
  resolve it, so the lite client opens it against the one serving the page. A
  second browser deployment must give the link its own routing again rather than
  offering a token to every deployment in turn.
- A row whose payload no longer matches the shape its prefix promises is this
  deployment's own drift rather than a forged link, and says so;
  [`link-payloads.md`](link-payloads.md) owns that rule and the code it raises.
- The token in the link is the acceptance secret, not a handle to one. It
  carries 256 bits for that reason, and neither store it is recorded in — the
  owner's HMAC, the row's digest — holds a value that can be presented.
- Describing an invitation checks its expiry itself rather than inheriting the
  acceptance path's state check. An accepted invitation is still usable, so
  without that check a lapsed link would keep naming its mailbox forever.
- The preview and acceptance ask one predicate for everything else that can
  withdraw an invitation — the targets' migration, and whether the sharer still
  holds the share in the incarnation they offered it from. A preview that
  outlives acceptance's conditions is a mailbox oracle, and two copies of the
  conditions is how it gets there.
- The unauthenticated preview takes the opaque token only. The addressed body
  reaches a Durable Object without a lookup, which is not something an
  unauthenticated caller may choose.
- A creation that does not record what it minted discards those links itself.
  Nothing else can: the row is keyed by a digest of a token nothing stores, so
  the minting call is the last place it is reachable.
- The preview reads the offered conversation and no other. Main is previewed
  only where Main is what is offered.
- Nothing rendered into the email can fail the invitation. A name, a title or a
  transcript that cannot be read is left out; only the link and the secret are
  load-bearing.
- Email bodies and credentials are not returned by public routes. The only stored
  readable credential representation is encrypted with the existing server key.
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
refuses creation. `BROWSER_APP_ORIGIN` and the existing encryption/signing keys
are required; the existing transactional Resend configuration delivers mail.
Development/test delivery uses the shared sender's no-send behavior.

A send accepted by the provider followed by a lost acknowledgement is retried
with the same key. Revocation during an in-flight send may still deliver a link;
its owner refuses subsequent acceptance. A corrupted receipt or unavailable
identity authority remains an error, never a grant.

## Testing

`pnpm --filter @rally/api test:workers test-workers/scope-invitations.test.ts`
runs real D1, `WorkspaceDO` SQLite, RPCs, alarms and HTTP routing. The fixture
declares the D1 columns it uses. It covers verified-recipient admission, child-only
access, atomic multi-target activation, replay after removal/revocation,
sharer replacement, stable operation/email receipts and identity-only HTTP
acceptance. It also reads the link out of the delivered encrypted body to prove
it is one typed token with no identifier or region in it, that the row holds a
digest rather than that token and no secret beside the address it stores, that a
dump of it replayed through the addressed body is refused, previews and accepts
by the token alone, and refuses an edited token, a wrong secret, a revoked
invitation and one past its deadline whether or not it was accepted first.
It also proves the bound the whole feature rests on, against real conversation
objects with distinct transcripts in Main and in a child: an offer of the child
quotes the child and never Main, an offer of Main quotes Main and never the
child, and a system notice in either is not conversation and never leaves. That
case needs the runtime — the Node fixture resolves every substream id to one
database, so the same assertions there would pass with the boundary broken.
It covers the housekeeping around those rows too: that a replayed and a denied
creation each leave the table where they found it, that an `expiresAt` past the
`Date` range is refused with the field named in the diagnostic rather than
raising a `RangeError` while minting, and that a preview failure is logged with
the port code that says which authority refused.
`apps/api/test/scope-invitation-link.test.ts` covers the store against the real
migrations: the round trip, another kind's token, an edited one, an expired row,
the sweep, and a payload that no longer matches its prefix.
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
