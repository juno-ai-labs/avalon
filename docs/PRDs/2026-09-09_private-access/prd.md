# Private access, invitations, and downloads

> Created 2026-09-09.
>
> Request-only acquisition, operator invitations, and reusable download grants.
> Standing contract: [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> The companion implementation PR adds the durable `docs/private-access.md` reference.
> Read [Current review scope](#current-review-scope) for the consolidated design
> and [Launch copy](launch-copy.md) for supplied wording and launch checks.

## Summary

Replace the public download hero with a minimal email request form. Record each
request, acknowledge it by email, and let operators review requests in Ace and
invite people when a testing cohort opens. Landing and email copy remain in
explicit content definitions so final wording can change independently of logic.

A shared download-grant generator serves ad hoc Ace links, access invitation
emails, and workspace invitations. It supports two explicit modes: single-use
with no time expiry, and repeatable until an exact expiry. Anyone holding a valid
link can download without email verification. Manual Ace generation offers both
modes; onboarding invitations prefer repeatable downloads, with their final
lifetime policy subject to the decisions below.

## Motivation

The product owner requested controlled intake while Rally is tested with a select
group. Today's public installer and explanatory hero do not support that process;
there is no durable acquisition list or operator invitation workflow.

## Goals

1. Visitors can only request access from the landing page's primary flow.
2. Each normalized address has one durable request and an acknowledgement email.
3. Ace shows requests, delivery state, and subsequently invitation/download state.
4. One reusable generator issues links for operators and automated email callers.
5. Single-use grants admit exactly one request, including concurrent attempts;
   timed grants admit repeated and concurrent requests strictly before expiry.
   Opening a page or an email scanner fetching it does not consume a grant.
6. Invited teammates can install Rally without joining the public request queue.

## Non-goals

1. A CMS: copy lives in versioned content definitions initially; a live copy editor
   is deferred until requested.
2. Preventing an authorized recipient from forwarding a bearer link or sharing an
   installed binary. Neither is promised by bearer download authorization.
3. Charging for access, cohort scoring, and marketing campaigns are deferred.
4. Approved-account lists and invitation-only account creation or sign-in are
   rejected as unnecessary. Existing workspace membership checks still apply.

## Product behavior

The landing page has a brand mark, interchangeable headline and explanation,
Work email field, and Get early access button. Privacy/terms/support links remain.
Submitting shows pending, validation/error, or received state without navigating
away. A repeated address does not create another request or send another already
acknowledged email. Provider failures retain the request and permit explicit retry.

Ace gains an Access page with a searchable request list and acknowledgement
status. Generate download link creates a fresh capability, optionally associated
with a request, and shows it once for copying. It does not itself email anybody.
Before generation, the operator chooses single-use/no-time-expiry or repeatable
with an exact future date/time, displayed in their local timezone. Both standalone
and request-associated links use that choice. There is no inferred default TTL.
The later Invite action creates a grant using the same generator and sends a
versioned invitation email, retaining delivery status for recovery.

A download link opens a page with an explicit Download for macOS (Apple silicon)
button. Only an explicit POST admits a transfer; GET, HEAD and ordinary email
previews do not. Single-use grants become unavailable after their first admitted
transfer. Timed grants admit repeated and concurrent transfers strictly before
the deadline, even after an earlier download. At the deadline or after revocation,
neither mode admits new transfers; a transfer already admitted can finish.

Redeeming streams the installer without exposing a reusable storage URL. Missing
installer/storage failure before admission preserves the grant. Admission means
the server starts the response, not proof the recipient saved the file. After a
browser disconnect, a single-use link needs an operator-issued replacement; a
timed link can restart a full download before expiry. Resuming a partial download
requires separate Range handling and is not promised by this first slice.

Workspace invitation emails include a separate grant from the same issuer.
Installing affects only the download grant; accepting membership still requires
the existing authenticated invited account and regional invitation checks.
Revocation or supersession must invalidate any still-active grants linked to that
invitation, including timed grants previously used. Resend recovers delivery
without inadvertently minting extra live grants. Both access and workspace
invitation flows prefer repeatable onboarding links. Their time-only versus
activation-retirement policy remains a decision before implementing dispatch;
activation-based retirement requires the recovery path described below.

## Impact on the product contract

This changes acquisition and distribution, not workspace or work-stream
semantics. Download authorization is not account authorization. There is no approved-account list or invitation-only account creation/sign-in.
An already-obtained installer does not require an additional access approval.

## Decision log

None yet.

## Current review scope

This section consolidates recorded product decisions and the recommended
invitation-management design for review. Bulk sending and activation-based link
retirement are proposals from the discussion, not claims about implemented code.
The companion implementation PR documents its implemented scope separately.

### Acquisition and copy

- Replace the landing page on deployment, with no feature flag. Its primary flow
  is Work email → Get early access, using the supplied [launch copy](launch-copy.md).
- Save a normalized, deduplicated email request before sending the Rally team's automatic
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
  than an email-matching activation event. The explicit single-use mode
  remains a separate operator choice, not the recommended onboarding mode.
- Full retry and resuming a partial file are different capabilities. The proposed
  timed mode permits a fresh full download; resumable transfers require separate
  Range handling and consistent artifact identity and are not promised yet.
- Workspace invitation emails use the shared issuer in the invitation's region.
  Teammates bypass the public request queue. Existing authenticated membership
  acceptance, invitation revocation and regional boundaries continue to apply.
- Show platform compatibility before downloading. The first installer endpoint
  serves macOS on Apple silicon; a link must not imply other builds are available.

### Personal outreach and launch preparation

The supplied process calls for researching a requester's name/profile and a
personal invitation from the Rally team explaining why they are being brought in early.
Record the source, uncertain matches and proposed personal note in Ace; a name
must not be treated as known just because it was guessed from an email. The
personal message is separate from the automatic acknowledgement. Use the Rally team's
actual reviewed reason and supplied contact details, without inventing a phone
number or implying a personal review that did not occur.

The [launch checklist](launch-copy.md#needed-before-launch) requires testing the
shared-chat, team-skill and reusable-workflow paths with a new teammate, checking
their onboarding coverage, and an inspiration page with recorded demos. The
supplied `hello@example.com` sender requires domain verification and a working reply
mailbox. Existing public release paths must be coordinated with installer gating
and desktop updates before claiming private distribution. None of these requires
an approved-account list.

### Remaining product decisions

- Choose whether invitation emails initially use operator-selected time expiry
  alone or include activation-based retirement plus its recovery download page.
  Time expiry uses the proposed grant primitive; activation
  retirement depends on the additional identity/recovery work described above.
- Supply the final personal invitation template and any direct phone/text contact
  the launch team wants included. The acknowledgement copy is already supplied.
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

## Key design decisions

1. **Use the supplied landing and acknowledgement copy.** The pasted
   [launch copy](launch-copy.md) is the source, including the Rally team,
   `hello@example.com`, and “We got your Rally request.” Freeze the sender, subject and
   body with each request so changing copy does not change a retry's payload.
   Keep profile research and personal outreach separate from the automatic
   acknowledgement. Verify the sender and reply mailbox before launch.
2. **Keep links as bearer capabilities.** The product owner chose possession of
   the random URL as authority. Recipient attribution is bookkeeping, not email
   verification or account admission. The requested exclusivity does not include
   approved-account lists or preventing installer sharing.
3. **Offer explicit single-use and timed modes.** The later request for timed
   expiry expands the original single-use proposal. Timed grants allow full
   download retries until the operator-selected deadline. No guessed duration or
   arbitrary download-count cap is introduced. Future email producers use this
   same issuer; activation-based retirement remains a separate decision.
4. **Replace the landing page directly.** The product owner explicitly chose
   replacement on deployment rather than a feature flag.
5. **Deliver intake and the shared issuer first.** The first implementation
   covers requests, acknowledgement, Ace review and ad hoc downloads. Invitation
   dispatch, regional workspace integration and closing public artifact paths
   follow separately. The public release origin also serves Electron updates and
   release verification, so hiding the public CTA alone cannot be described as
   exclusive distribution. The implementation PR assigns migration filenames
   and records any scope changes when they land.

## Data model

Global regional D1 holds pre-workspace access requests, frozen acknowledgement
content, and standalone grants. The regional migration chain creates empty
schema in EU as well. Workspace grants must live in their invitation's region;
EU invite email addresses must not be copied into Global for convenience.
Grants store only the token digest, source, optional source identity, timestamps,
and operator attribution. Raw URLs are returned only to the issuing caller.

### Data lifecycle and privacy requests

Acquisition records do not inherit workspace deletion: they are collected before
a workspace exists. Use explicit purpose-ending events for cleanup; do not
invent numerical retention periods. Any maximum elapsed-time retention policy
is a separate operator decision, left unset until the team selects it.

| Data class | Retention boundary and cleanup |
| --- | --- |
| Uninvited request and acknowledgement snapshot | Keep while the request is waiting or its acknowledgement needs reconciliation. A verified erasure/withdrawal request or closure of the early-access programme ends that purpose: delete the request, frozen content and linked acquisition grants. Invitation/activation alone does not justify retaining these indefinitely; remove acquisition-only content once its delivery/support work is complete. |
| Researched profile, source and personal notes | Collect only for the personal-outreach phase. Erase when the outreach purpose ends, on verified erasure, or when a proposed match is rejected. Do not retain rejected guesses or copy these into suppression records. |
| Download grant | Time expiry or revocation ends admission. Retain only until any related delivery/replacement investigation is resolved, then delete the digest and attribution. An unused single-use grant remains live until use, explicit revocation or associated request erasure; cleanup must not invent a hidden expiry. |
| Invitation send/delivery records | Retain while a send needs reconciliation, retry or support. After completion, erase message content and unnecessary provider identifiers; retain only non-identifying aggregate results if useful. Verified erasure removes recipient-linked history and triggers deletion of provider copies where supported. |
| Invitation suppression | On opt-out, retain only the normalized destination needed to prevent another invitation, its suppression reason/time and necessary consent evidence. Delete research and message content independently. An ordinary repeated access request does not clear invitation suppression; only an explicit renewed invitation consent does. |

Use the existing privacy contact and identity-verification process. Locate
pre-account records by normalized email in Global; do not require a Rally account
or workspace ID to make a request. Follow any grant source IDs to their request
or invitation, revoke access before deleting attribution, and reconcile/cancel
pending sends before erasure so a delayed worker cannot recreate the data.
Global acquisition erasure does not delete a Rally account or workspace.

For a regional workspace invitation, fulfill lookup and erasure in its owning
region using existing invitation/identity routing. EU addresses, research and
message content stay in EU; a support operation must not copy them into Global
as a lookup shortcut. Provider-side deletion follows the provider's supported
privacy process; record unresolved provider retention separately rather than
claiming a local deletion erased external copies.

The first intake slice needs an operator runbook for locating and erasing its
request and manual-grant records through existing administration access. It has
no background invitation sender or research records. Before the invitation phase
ships, implement durable invitation suppression and deletion of pending/send
records, including protection against a sender racing with erasure. Automatic
age-based cleanup and a self-service privacy UI are deferred; the documented
operator procedure handles requests in the meantime.

## Security and trust model

Ace retains Cloudflare Access and same-origin mutation admission. Random tokens
are cryptographic capabilities, stay in URL fragments, and never enter telemetry.
The server atomically admits single-use grants only while unused and timed
grants only while unexpired, respecting revocation in both modes. Downloads
bypass caches.
The initial backend streams R2 through a binding. Existing public DMG and ZIP
paths remain a rollout blocker for claiming exclusive distribution. The follow-up
must gate both current and historical artifacts and r2.dev origins, preserve
legitimate updates, and replace public release checks with authorized checks.

## Rollout

No feature flag, per the product owner. Apply migration, deploy API, then Ace and
site. PRD approval alone does not deploy the implementation.

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
- Independently created links differ. Unused single-use links have no time expiry;
  two concurrent single-use redemptions yield exactly one admitted download.
  Subsequent attempts fail even after a disconnected transfer.
- Timed links permit repeated and concurrent downloads before expiry. Both the
  preliminary check and final admission reject the exact deadline, including
  expiry during storage lookup; already-admitted transfers may finish afterward.
- Revocation and unknown tokens fail in both modes, including revocation of a
  previously used timed grant. Expired timed links fail.
- Ace's standalone and request-associated issuers preserve the selected mode and
  exact expiry. A generated link's displayed lifetime does not change when the
  operator changes settings for the next link.
- A GET/HEAD or unavailable installer does not consume a grant.
- Final invitation and teammate paths use the same issuer and retain correct
  membership authorization after installation.
- Old public DMG/ZIP URLs cannot bypass the finished gate, while updates work.
- Real browser inspection at desktop/mobile widths, lint, typecheck, scoped tests,
  and mutation checks pass before considering each implemented slice complete.

- An operator can locate and erase pre-account request/snapshot/manual-grant
  records without requiring a workspace, and erased links cannot be redeemed.
  A later explicit signup creates fresh data and does not restore erased content.
- Before invitation sending ships, erasure cancels pending sends and cannot race
  with a sender to recreate data. Opt-out suppresses future invitations across
  duplicate signup and bulk selection without retaining research/message content.
  Regional invitation erasure and provider-copy handling follow the lifecycle above.
