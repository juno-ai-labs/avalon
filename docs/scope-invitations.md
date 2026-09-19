# Scoped invitations

Scoped invitations offer Main, individual children or a workstream to verified
email recipients. The invitation and resulting grants live in the same
WorkstreamDO. Client integration lands in the browser-lite layer of the PR stack
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
| `packages/db/src/link-payloads.ts` | `defineLinkPayload`/`issueLinkPayload`/`openLinkPayload`: opaque tokens for any link a person receives, typed by their prefix. |
| `packages/db/migrations/0114_link_payloads.sql` | The shared `link_payloads` table: token digest, type, JSON and optional expiry. |
| `apps/api/src/routes/browser.ts` | Unauthenticated `POST /browser/invitation`, releasing the invited mailbox to a link holder. |
| `apps/api/src/durable-objects/scope-invitation-service.ts` | Current sharing authority, verified mailbox, relationship admission, grant activation and email delivery. |
| `apps/api/src/durable-objects/scope-invitation-storage.ts` | Operation receipts, invitation state, encrypted delivery and acceptance binding. |
| `apps/api/src/durable-objects/workstream-do.ts` | Addressed RPCs, migration 14 and delivery alarm execution. |

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
else: a type prefix and 256 bits. Workspace, work stream, invitation and
acceptance secret are a row in the issuing region's `link_payloads`, which
stores the token's SHA-256 digest rather than the token, so a copy of that table
lists what exists instead of handing over working links. Only the secret was
ever a credential; the three identifiers beside it were the server's own
routing, published to whoever the mail was forwarded to and describing the shape
of a team they hold no access to. They are now readable only by the deployment
holding the row, and the recipient learns where the invitation points from the
acceptance they authorized, not from the link.

`link_payloads` is shared rather than invitation-specific, because a link whose
URL should not describe its subject is a recurring shape rather than one
feature. `defineLinkPayload` pairs a prefix with the schema that prefix
promises; nothing is written or read without satisfying it, so a token minted
for one kind can never be presented as another even though every kind shares the
table. A row carries the expiry of the thing it addresses, which for an
invitation is `expiresAt` or null, and each issue deletes rows already past
their own deadline, so the table is swept by the writes that grow it rather than
by a schedule nobody owns.

The token is minted before the sharing checks and the transaction, with every
other external await. A creation that is then denied, or that replays an earlier
operation, therefore leaves a row addressing an invitation that never existed.
Such a row is inert: opening it reaches an owner with no such invitation, which
refuses it exactly as it refuses a revoked one. The alternative, writing the row
after the invitation commits, risks the opposite and worse failure, an
invitation whose emailed link resolves to nothing.

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
cannot read as the end of the quote.

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

Gmail clips a message past 102 KiB and shows a "view entire message" link, which
would cut off the footer; five turns of a hundred words is a few kilobytes, and
the test holds the whole body under that ceiling.

Everything in the heading and the preview is cosmetic, and none of it can fail
an invitation. The names are read from D1 and the turns from another object; a
failure of either sends the invitation without that part, and the heading has a
sentence for every name it did not get, down to the line this email carried
before. Names, titles and authors are collapsed to one line before rendering,
because a plain-text email has no other structure to forge, and member-written
turns are quoted with `>` below the real link so a message ending in its own
sign-in sentence cannot sit where ours does.

`POST /browser/invitation` is the one unauthenticated read here, and it exists
because a sealed link cannot tell the sign-in form under it which mailbox to
fill in. It checks the secret exactly as acceptance does, on the same
invitation state, and returns that mailbox alone — never the workspace, the work
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
`/sharing/grants/list`. WorkstreamDO admits the authenticated actor against that
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
  deployment's own drift, not a forged link, and is raised as
  `link_payload_drifted:<prefix>:<field>:<issue>` rather than reported as one
  more unavailable invitation — otherwise a deploy that stopped honouring every
  outstanding link of that kind looks exactly like recipients mistyping.
- The token is the whole of what guards the row, so it carries the same 256 bits
  as the acceptance secret inside it. A shorter handle would make the row easier
  to reach than the secret it holds.
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
explicitly leaves expiry open; policy values remain a team decision. Existing
platform request/storage limits still apply. Invalid origin/key configuration
refuses creation. `BROWSER_APP_ORIGIN` and the existing encryption/signing keys
are required; the existing transactional Resend configuration delivers mail.
Development/test delivery uses the shared sender's no-send behavior.

A send accepted by the provider followed by a lost acknowledgement is retried
with the same key. Revocation during an in-flight send may still deliver a link;
its owner refuses subsequent acceptance. A corrupted receipt or unavailable
identity authority remains an error, never a grant.

## Testing

`pnpm --filter @rally/api test:workers test-workers/scope-invitations.test.ts`
runs real D1, WorkstreamDO SQLite, RPCs, alarms and HTTP routing. The fixture
declares the D1 columns it uses. It covers verified-recipient admission, child-only
access, atomic multi-target activation, replay after removal/revocation,
sharer replacement, stable operation/email receipts and identity-only HTTP
acceptance. It also reads the link out of the delivered encrypted body to prove
it is one typed token with no identifier, region or secret in it, that the row
holds a digest rather than that token, previews and accepts by the token alone,
and refuses an edited token, a wrong secret and a revoked invitation.
`apps/api/test/scope-invitation-link.test.ts` covers the store against the real
migrations: the round trip, another kind's token, an edited one, an expired row,
the sweep, and a payload that no longer matches its prefix.
`apps/api/test/scope-invitation-email.test.ts` covers the body: the heading and
each of its fallbacks, a name carrying a newline, the quoted turns, the singular
and plural earlier-message line, word truncation, and `readConversationPreview`
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

### 2026-09-19 — Put the emailed link behind one token, and say what the invitation is for

The invitation email published the server's routing to its recipient:
`#region=…&workspace=…&workstream=…&invitation=…&token=…` told anyone the mail
reached which deployment, workspace and work stream they were being offered,
before they had accepted anything and whether or not the invitation was theirs
to accept. Only the secret was ever a credential.

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
