# Private access, invitations, and downloads

> Created 2026-09-09.
>
> Request-only acquisition, operator invitations, and reusable download grants.
> Standing contract: [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> The companion implementation PR adds the durable `docs/private-access.md` reference.
> Read [Current review scope](#current-review-scope) for the consolidated design
> and [Launch copy](launch-copy.md) for supplied wording and launch checks.
> The original proposal below is preserved; the decision log records later changes.

## Summary

Replace the public download hero with a minimal email request form. Record each
request, acknowledge it by email, and let operators review requests in Ace and
invite people when a testing cohort opens. Landing and email copy remain in
explicit content definitions so final wording can change independently of logic.

A shared download-grant generator serves ad hoc Ace links, access invitation
emails, and workspace invitations. Each unpredictable bearer link permits one
download and has no time-based expiration. The recipient need not verify their
email: the product owner explicitly chose possession of the link as authority.

## Motivation

The product owner requested controlled intake while Rally is tested with a select
group. Today's public installer and explanatory hero do not support that process;
there is no durable acquisition list or operator invitation workflow.

## Goals

1. Visitors can only request access from the landing page's primary flow.
2. Each normalized address has one durable request and an acknowledgement email.
3. Ace shows requests, delivery state, and subsequently invitation/download state.
4. One reusable generator issues links for operators and automated email callers.
5. Exactly one redemption wins, including concurrent attempts; opening a page or
   an email scanner fetching it does not consume a grant.
6. Invited teammates can install Rally without joining the public request queue.

## Non-goals

1. A CMS: copy lives in versioned content definitions initially; a live copy editor
   is deferred until requested.
2. Preventing an authorized recipient from forwarding a bearer link or sharing an
   installed binary. Neither is promised by one-use download authorization.
3. Charging for access, cohort scoring, and marketing campaigns are deferred.

## Product behavior

The landing page has a brand mark, interchangeable headline and explanation,
email field, and Request access button. Privacy/terms/support links remain.
Submitting shows pending, validation/error, or received state without navigating
away. A repeated address does not create another request or send another already
acknowledged email. Provider failures retain the request and permit explicit retry.

Ace gains an Access page with a searchable request list and acknowledgement
status. Generate download link creates a fresh capability, optionally associated
with a request, and shows it once for copying. It does not itself email anybody.
The later Invite action creates a grant using the same generator and sends a
versioned invitation email, retaining delivery status for recovery.

A download link opens a page with an explicit Download for macOS button. Only its
POST consumes the grant. GET, HEAD, page previews and scanners consume nothing.
Redeeming streams the installer without exposing a reusable storage URL. Missing
installer/storage failure before redemption preserves the grant. A successful
redemption means the server starts the response, not proof the recipient saved
the file: browser disconnects require an operator to issue a replacement.

Workspace invitation emails will include a separate grant from the same issuer.
Installing consumes only the download grant; accepting membership still requires
the existing authenticated invited account and regional invitation checks. Resend
must recover delivery without inadvertently minting extra live grants; revoke or
supersede must invalidate unused grants linked to that invitation.

## Impact on the product contract

This changes acquisition and distribution, not workspace or work-stream
semantics. Download authorization is not account authorization. Strictly blocking
new account creation with an already-obtained binary is a separate product
choice, not a guarantee made by this download gate.

## Current review scope

This section consolidates recorded product decisions and the recommended
invitation-management design for review. Bulk sending and activation-based link
retirement are proposals from the discussion, not claims about implemented code.
The companion implementation PR documents its implemented scope separately.

### Acquisition and copy

- Replace the landing page on deployment, with no feature flag. Its primary flow
  is Work email → Get early access, using the supplied [launch copy](launch-copy.md).
- Save a normalized, deduplicated email request before sending Adam's automatic
  acknowledgement. Freeze the sender, subject and body for retry consistency.
- Keep the landing form email-only. “Work email” does not impose a personal-domain
  block. Names and LinkedIn profiles belong to the later outreach workflow.
- Do not add account approval or invitation-only sign-in. Forwarding a bearer
  link or installer is outside the requested level of control. Existing workspace
  membership checks remain in effect.

### Proposed Ace invitation workflow

1. Filter/search requests, with separate email-delivery, link and activation
   information. Initial filters cover waiting, invited, failed and activated.
2. Invite one person, select several, select all matching the current filter, or
   choose Invite everyone waiting. Clearly distinguish the visible page from all
   matching records. Everyone waiting excludes already invited, queued, suppressed
   and opted-out recipients; a repeat signup does not reset invitation history.
3. Review the exact recipient count, email preview and link lifetime before Send.
   Freeze the recipient set at confirmation; new requests are not silently added
   to a send already underway. Each recipient receives a separate email and a
   unique grant from the same issuer used by manual Ace generation.
4. Persist the send operation and each recipient's state before provider calls.
   Sending runs server-side and continues after Ace closes. Handle provider rate
   limits and quotas without losing recipients or re-sending completed work.
5. Prevent duplicate invitations from double clicks or concurrent operators.
   Retry definite failures with the same frozen message and grant. Reconcile
   uncertain delivery before retrying; provider idempotency alone is not a
   permanent exactly-once guarantee.
6. Show per-person history: request time, inviting operator, send attempts,
   provider results, link state and observed activation. Provider acceptance is
   not inbox delivery; only delivery events may label a message delivered.
   Download started is not proof of a file saved or an installation completed.
7. Offer explicit resend, replacement-link, revoke-link and exclude-from-future-
   sends actions. Resend retains a still-valid link. Replacement retires the old
   link and clearly states that earlier emails will stop working. Link revocation
   never revokes a person's account or workspace membership.

Bulk selection is an operator convenience; delivery still has per-recipient
records and recovery. This is intentionally a small invitation tool, without
cohort scoring or a general marketing-campaign engine.

### Proposed download and invitation lifecycle

- Prefer repeatable links for onboarding so interrupted transfers can restart.
  Keep time-based expiry available, with the operator choosing the deadline;
  no default duration has been selected. Do not send links already expired after
  a delayed send. GET/HEAD, email scanners and opening the landing page must not
  consume a grant. An admitted transfer can finish after expiry.
- Activation-based retirement is an additional option under consideration:
  retire anonymous access after the intended recipient activates with a matching
  verified email. For workspace invitations, use acceptance of that invitation,
  not the mere existence of an account. A different sign-in email must not
  silently retire the intended recipient's link.
- Before enabling activation-based retirement, provide a recovery download path
  for reinstalls and another device. The proposed same-page “Sign in to download”
  path would authorize that download only, without introducing invitation-only
  access to Rally itself. Do not retire anonymous access until that replacement
  path is actually available.
- Anonymous/manual links without a recipient identity use time expiry rather
  than an email-matching activation event. The explicit single-use mode already
  built remains a separate operator choice, not the recommended onboarding mode.
- Full retry and resuming a partial file are different capabilities. The current
  timed mode permits a fresh full download; resumable transfers require separate
  Range handling and consistent artifact identity and are not promised yet.
- Workspace invitation emails use the shared issuer in the invitation's region.
  Teammates bypass the public request queue. Existing authenticated membership
  acceptance, invitation revocation and regional boundaries continue to apply.
- Show platform compatibility before downloading. The current installer endpoint
  serves macOS on Apple silicon; a link must not imply other builds are available.

### Personal outreach and launch preparation

The supplied process calls for researching a requester's name/profile and a
personal invitation from Adam explaining why they are being brought in early.
Record the source, uncertain matches and proposed personal note in Ace; a name
must not be treated as known just because it was guessed from an email. The
personal message is separate from the automatic acknowledgement. Use Adam's
actual reviewed reason and supplied contact details, without inventing a phone
number or implying a personal review that did not occur.

The [launch checklist](launch-copy.md#needed-before-launch) requires testing the
shared-chat, team-skill and reusable-workflow paths with a new teammate, checking
their onboarding coverage, and an inspiration page with recorded demos. The
supplied `hi@rally.ai` sender requires domain verification and a working reply
mailbox. Existing public release paths must be coordinated with installer gating
and desktop updates before claiming private distribution. None of these requires
an approved-account list.

### Remaining product decisions

- Choose whether invitation emails initially use operator-selected time expiry
  alone or include activation-based retirement plus its recovery download page.
  Time expiry is implementable with the existing grant primitive; activation
  retirement depends on the additional identity/recovery work described above.
- Supply the final personal invitation template and any direct phone/text contact
  Adam wants included. The acknowledgement copy is already supplied.
- Decide whether profile research stays manual in Ace or gains assisted lookup;
  the source requests research but does not select a lookup provider or authorize
  treating uncertain matches as confirmed people.

### Additional acceptance for the proposed invitation workflow

- One-person, selected, all-filtered and everyone-waiting sends resolve the
  intended recipient set and create one distinct link per recipient.
- A repeated send action and overlapping operator actions do not create duplicate
  initial invitations; closing Ace does not stop persisted sending.
- Partial failure preserves successful results. Definite failures can recover
  without changing frozen messages; ambiguous outcomes remain visible until
  reconciled. Bounces and opt-outs are excluded from subsequent bulk sends.
- Resend preserves a valid link; explicit replacement retires the prior grant.
  Link revocation leaves account access and workspace membership unchanged.
- Interrupted onboarding downloads can retry. Existing accounts and mismatched
  sign-in emails do not prematurely retire a recipient's link. If activation
  retirement is selected, reinstall/recovery works before retirement ships.
- New requests arriving during a bulk send remain waiting for a later send.
- Operator UI accurately distinguishes accepted, delivered, failed, download
  started and activated; it never infers successful installation from a stream.

## Decision log

### 2026-09-09 — Use supplied landing and acknowledgement language

**Decided:** Use the product owner's pasted [launch copy](launch-copy.md) as the
source for the landing page and first email. The email is from Adam @ Rally at
`hi@rally.ai`, with subject “We got your Rally request.” Keep the email-only form
and put names/profile research in the later personal outreach workflow.

**Why:** The supplied positioning centers on sharing chats, skills, context and
routines. The first email gives teams three concrete things to prepare.

**Changes:** Placeholder copy is replaced in code, including the capability and
capacity lines. The sender is frozen per new request using migration 0103.
Personal research/invitations, the supplied ad/post drafts, checking all three
workflows in onboarding, and an inspiration page with recorded demos are retained
as launch work. Applying the copy does not complete those checks or send outreach.
The supplied sender domain must be verified separately before deployment.

### 2026-09-09 — Keep account admission outside private distribution

**Decided:** Do not add an approved-account list or require an access invitation
to create an account or sign in. The product owner explicitly rejected that
additional control as unnecessary.

**Why:** The desired exclusivity concerns the landing page and how Rally supplies
download links. Preventing someone with a forwarded installer from using Rally
is not a requirement.

**Changes:** Account admission is a deliberate non-goal, not a remaining rollout
gate. Existing workspace membership checks still apply. Any future retirement
of a download link after activation governs that link only; it must not introduce
a new requirement for permission to use Rally.

### 2026-09-09 — Support time expiry as an alternative to single use

**Decision:** Add an optional exact expiry to the shared issuer and Ace. Timed
links permit repeat downloads until that instant; omitted expiry retains the
original single-use/no-time-expiry behavior. All links remain bearer capabilities.

**Why:** The product owner asked whether a link could expire after a period of
time instead of one or two downloads. Operators choose a date/time; no default
window or arbitrary count is selected. Future email producers use the same input.

**Changes:** The original single-use lifetime in the proposal now becomes one
of two options. Timed acceptance includes repeat admission before expiry, rejection
at the exact deadline (including expiry during storage lookup), and revocation.
Expiry does not interrupt a download already admitted. Migration 0102 adds the
nullable deadline and must precede deployment of this enhancement.

### 2026-09-09 — Bearer grants and direct replacement

**Decided:** Anyone holding the random URL may redeem it once. The landing page
replaces the current page on deployment, without a flag. Both were explicitly
confirmed by the product owner.

**Why:** Ad hoc sharing must be simple, and the requested change is the public
acquisition policy rather than an experiment for signed-in users.

**Changes:** No recipient verification; attribution email is bookkeeping only.

### 2026-09-09 — Begin with intake and the reusable grant primitive

**Decided:** The first implementation covers intake, acknowledgement, Ace review
and ad hoc grant generation/redemption. Invitation email dispatch, workspace
integration, and closing legacy public artifact paths follow as separate steps.

**Why:** The public R2 release origin also serves Electron updates and release
verification. Its removal needs coordinated release-publisher and updater changes;
a cosmetic gate must not be represented as protected distribution.

**Changes:** All goals remain; the first change is explicitly incomplete until
the remaining acceptance gates below pass.

## Data model

Global regional D1 holds pre-workspace access requests, frozen acknowledgement
content, and standalone grants. The regional migration chain creates empty
schema in EU as well. Workspace grants must live in their invitation's region;
EU invite email addresses must not be copied into Global for convenience.
Grants store only the token digest, source, optional source identity, timestamps,
and operator attribution. Raw URLs are returned only to the issuing caller.

## Security and trust model

Ace retains Cloudflare Access and same-origin mutation admission. Random tokens
are cryptographic capabilities, stay in URL fragments, and never enter telemetry.
The server atomically changes unused to used and bypasses caches for downloads.
The initial backend streams R2 through a binding. Existing public DMG and ZIP
paths remain a rollout blocker for claiming exclusive distribution. The follow-up
must gate both current and historical artifacts and r2.dev origins, preserve
legitimate updates, and replace public release checks with authorized checks.

## Rollout

No feature flag, per the product owner. Apply migration, deploy API, then Ace and
site. No production deployment is authorized by this planning/build request.

1. Intake and acknowledgement, then Ace tracking and reusable grant issuance.
2. Operator Invite email with frozen content, durable delivery/retry state, and
   the same generator. Track provider acceptance separately from actual delivery.
3. Regional workspace invitation grants, resends/revocation and install handoff.
4. Close public distribution paths while preserving updates for installed clients;
   coordinate release publishing, retention and historical origins.
5. Production acceptance with test inboxes and the current signed installer.

## Acceptance

- Duplicate/case-normalized requests persist once; successful acknowledgements
  are not resent; provider failures never lose the request.
- Ace rejects unauthenticated and cross-origin issuance and exposes no raw tokens
  in its listing responses or logs.
- Independently created links differ; old unused links remain valid; two
  concurrent redemptions yield one download; used/revoked/unknown links fail.
- A GET/HEAD or unavailable installer does not consume a grant.
- Final invitation and teammate paths use the same issuer and retain correct
  membership authorization after installation.
- Old public DMG/ZIP URLs cannot bypass the finished gate, while updates work.
- Real browser inspection at desktop/mobile widths, lint, typecheck, scoped tests,
  and mutation checks pass before considering each implemented slice complete.
