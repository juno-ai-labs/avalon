# Email delivery

Rally sends production login codes, scoped invitations, access acknowledgements
and notification mail through Cloudflare Email Service. Personal connector mail
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

## Verification and operation

`apps/api/test/email.test.ts` covers provider failures and durable sends;
login, invitation and notice suites exercise their caller-specific policies.
The health endpoint reports sender readiness. Verify the binding and sending
domain before enabling production mail. Reconcile a parked attempt with provider
delivery evidence before marking it sent or returning it to pending; retrying
without evidence may duplicate a transactional message. Never log message bodies
or recipient details in transport diagnostics.

## Changelog

### 2026-11-09 — Keep outbound delivery independent

**What changed:** The shared Cloudflare sender and durable receipt policy have a
standalone reference. Login, invitations, access acknowledgements and notices
retain their production delivery paths.

**Why:** Product scope now excludes receiving mail. Outbound authentication and
notifications still need their sending-domain verification and uncertainty policy.
Future changes must preserve the distinction between completed sends and unknown
provider outcomes; a delivery-key header alone does not provide idempotency.
