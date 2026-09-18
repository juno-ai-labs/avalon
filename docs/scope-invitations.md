# Scoped invitations

Scoped invitations offer Main, individual children or a workstream to verified
email recipients. The invitation and resulting grants live in the same
WorkstreamDO. The [lite browser entry](browser-client.md) accepts invitations through this
protocol. The shared email panel creates and revokes pending invitations from
the browser conversation header or native participant dialog. The same panel manages direct accepted grants. Participant mutations use the
parent grant ledger after first-share handoff; transcript execution stays in the
conversation owner.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/scope-grants.ts` | Batch, acceptance, revision and result contracts. |
| `apps/desktop/src/renderer/components/scope-sharing-panel.tsx` | Shared email invitation form, stable retry operation and pending revocation. |
| `apps/api/src/routes/sharing.ts` | Authenticated HTTP boundary; server-selected actor and recipient identities. |
| `apps/api/src/durable-objects/scope-invitation-service.ts` | Current sharing authority, verified mailbox, relationship admission, grant activation and email delivery. |
| `apps/api/src/durable-objects/scope-invitation-storage.ts` | Operation receipts, invitation state, encrypted delivery and acceptance binding. |
| `apps/api/src/durable-objects/workstream-do.ts` | Addressed RPCs, migration 14 and delivery alarm execution. |

## How it works

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
preparation check is never the final sharing authorization. A conflicting
handoff reports `migration_pending` instead of writing grants ahead of import.
Workspace-public reading alone is insufficient even to start preparation.

One operation records an invitation per distinct email, with stable grant
operation IDs and an encrypted email payload. Its transaction schedules the
existing alarm mechanism. The email's link carries its acceptance secret in a
fragment. No GET consumes an invitation. Retrying the same operation returns its
recorded invitations; changing its input conflicts. Delivery retries use the same
provider idempotency key and encrypted body.

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
acceptance. The deliberate SQL failure is caught inside the real object because
the test RPC bridge otherwise reports its expected rejection twice.
`message-to-output-pipeline.test.ts` additionally exercises invitation-triggered
handoff against real Main and child agents, including refusal to transfer for a
nonparticipant and reconciliation of a stale child roster.

## Changelog

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
