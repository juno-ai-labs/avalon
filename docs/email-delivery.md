# Email delivery

Rally sends production login codes, scoped invitations, "you were added"
emails, access acknowledgements and notification mail through Cloudflare Email Service. Personal connector mail
is owned by the connector. Sidekick runs deliver their own results with tools.

## Code and configuration

`apps/api/src/services/email.ts` owns the shared sender and delivery receipts.
`apps/api/wrangler.global.jsonc` binds `EMAIL` with `send_email`;
`EMAIL_FROM` supplies the transactional sender and `EMAIL_NOTIFICATION_FROM`
supplies the notification sender, falling back to the transactional address.
Sender domains must be verified in Cloudflare with the provider's bounce MX,
SPF and DKIM records. Cloudflare administration tokens belong in deployment
credentials, never Worker secrets. Sending is skipped outside production.

## Delivery and data

`EMAIL.send()` receives structured text, optional HTML, a named sender and an
optional Reply-To. `X-Rally-Category`, `X-Rally-Region` and
`X-Rally-Delivery-Key` provide correlation. Cloudflare does not deduplicate the
key. Regional D1 `email_delivery_receipts` (migration 0127) stores only opaque
references, attempt tokens, diagnostic codes and state; bodies stay with callers.

Login and invitation sends claim a reference before sending and fence settlement
with an attempt token. Confirmed quota refusals return to pending. Unknown
outcomes or accepted sends whose settlement failed require review. A crash leaves
`sending` for reconciliation rather than automatically sending again.
Notification sends retain completed receipts; unknown failures retry, so a crash
between provider acceptance and settlement or concurrent queue delivery may
produce duplicates. Permanent provider refusals do not retry. Access
acknowledgements keep their own generation-fenced reconciliation flow.

## Who gets email

Email that is about what happened in Rally goes only to people who have signed
in at least once: a login session was ever issued to them (`hasSignedIn`,
`apps/api/src/services/signed-in.ts`). A support session opened as them does
not count. The table is per deployment, so outside Global someone counts once
they have opened that deployment. Someone an administrator added by
address before they ever signed in gets none of it. Their notices are dropped,
not queued, and their Activity rows are kept, so they find what happened when
they first open Rally. Two senders read the rule: the notice sink
(`sendNoticeEmail`, which skips with `recipient_never_signed_in`) and the
usage-allowance email to administrators. It does not apply to the email that
tells someone they were added, which is the one way they learn to sign in,
nor to sign-in codes, nor to a Canvas shared with an address.

## Verification and operation

`apps/api/test/email.test.ts` covers provider failures and durable sends;
login, invitation and notice suites exercise their caller-specific policies.
The health endpoint reports sender readiness. Verify the binding and sending
domain before enabling production mail. Reconcile a parked attempt with provider
delivery evidence before marking it sent or returning it to pending; retrying
without evidence may duplicate a transactional message. Never log message bodies
or recipient details in transport diagnostics.

## Changelog

### 2026-11-17 — No notification email until someone has signed in

**What changed:** The notice sink and the usage-allowance email skip anyone
who has never been issued a session. Their notices are dropped and their
Activity rows kept.

**Why:** Adding a member by address makes them a member at once, with no
invitation to accept. Without this, an administrator adding a list of
addresses would have Rally email each of them every mention, request and
reply from then on, before they had ever chosen to use it. The owner asked
for nothing to reach their inbox until they sign in, with no queue to flush
when they do.

**Considered and rejected:** Holding the email and sending it at first sign-in:
a backlog of stale notices in the inbox at the moment the person arrives,
which Activity already shows them in the app.

**What a future change has to respect:** A new sender of email about activity
in Rally reads `hasSignedIn`. Sessions are never deleted, so it means "ever
signed in", not "signed in now", and a support session is not a sign-in.

### 2026-11-09 — Keep outbound delivery independent

**What changed:** The shared Cloudflare sender and durable receipt policy have a
standalone reference. Login, invitations, access acknowledgements and notices
retain their production delivery paths.

**Why:** Product scope now excludes receiving mail. Outbound authentication and
notifications still need their sending-domain verification and uncertainty policy.
Future changes must preserve the distinction between completed sends and unknown
provider outcomes; a delivery-key header alone does not provide idempotency.
