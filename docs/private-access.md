# Private access

Rally's initial private-access implementation captures requests, acknowledges
receipt, lists them in Ace, and issues single-use or timed bearer downloads. The
[product plan](PRDs/2026-09-09_private-access/prd.md) also covers operator invitation
emails, workspace invitation downloads and closing the old public release paths;
those follow-up stages are not implemented yet. The landing page replacement is
ready for a coordinated deployment, not deployed by this change.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/access-copy.ts` | Replaceable landing copy and escaped build rendering. |
| `apps/site/src/landing.ts`, `access.css`, `index.html` | Email form and its pending/success/error states. |
| `apps/api/src/services/access-request-content.ts` | Replaceable acknowledgement subject and Markdown. |
| `apps/api/src/services/access-request-service.ts` | Persist-before-send acknowledgement, deduplication and explicit retry. |
| `apps/api/src/routes/private-access.ts` | Global public intake and explicit POST download redemption. |
| `packages/contracts/src/private-access.ts` | Runtime-validated public and Ace contracts. |
| `packages/db/src/private-access.ts` | Shared grant issuer, hash, URL builder, redemption and request listing. |
| `packages/db/migrations/0101_private_access.sql` | Access requests, download grants, optional expiry and frozen acknowledgement sender. |
| `apps/ace/src/private-access.ts`, `client/private-access.tsx` | Access-protected request list and ad hoc grant generator. |
| `apps/site/download/index.html`, `src/download.ts` | Fragment-based grant handoff and deliberate Download button. |

## How it works

The static site posts an email to Global `POST /access/requests`. Validation trims
and lowercases it. D1 has a unique normalized email: repeated submissions preserve
the original row, request time, and frozen acknowledgement sender/subject/body. A new or
failed request sends through the existing Resend service and shared Markdown
renderer. Success records provider acceptance; development records `skipped` and
never calls the provider. An acknowledged duplicate returns the same accepted
response without sending another message.

Ace reads Global requests from its existing D1 binding and shows their
acknowledgement states. An operator can generate a standalone download or
associate one with a request. This creates a `manual` grant and returns its URL
once; it does not send mail or mark the person invited. The same exported
`issueDownloadGrant` accepts `access_invitation` and `workspace_invitation` sources
for the planned email producers. Source fields are attribution, not authority.
There is one generator, independent of the UI or any particular email template.
Its optional `expiresAt` accepts a future ISO timestamp with an explicit offset,
normalizes it to UTC, and makes the grant repeatable until that instant. Omission
preserves single-use behavior with no time expiry. Ace lets operators choose an
exact date/time in their displayed local timezone; no default duration is assumed.
Both standalone and request-linked generation use this choice. The returned
`expiresAt` is null for single-use links and is displayed with each newly issued
URL so changing the next link's settings cannot mislabel the previous one.

The issuer generates 256 random bits and persists a SHA-256 digest. The URL
carries the raw token in its fragment, which the browser strips from history once
read. The download page does not initialize site telemetry. Its form POSTs the
token to the Global API; browsing the page or performing a GET/HEAD has no effect.
The API obtains the canonical installer through its Global `DESKTOP_RELEASES` R2
binding, then atomically admits the unrevoked row using `UPDATE … RETURNING`.
Single-use grants admit only while unused; timed grants admit while server time
is strictly before `expires_at`, regardless of earlier use. Both preflight and
final admission check expiry, so time passing during R2 lookup cannot admit an
expired grant. `used_at` records first admission and stays fixed on repeat use.
There is no redirect to a storage URL, cache,
or installer-sized buffer. The canonical key is `stable/darwin/arm64/Rally.dmg`,
the same stable alias the release publisher promotes.

## Invariants

- D1 persistence precedes provider I/O; otherwise a mail failure loses the lead.
- The acknowledgement sender, content and idempotency key stay fixed per request;
  otherwise retrying after a copy change conflicts at Resend.
- Successful acknowledgement is never downgraded by a concurrent failure;
  otherwise subsequent submissions can resend an already accepted email.
- Token possession is the authority. No recipient identity guarantee exists, as
  explicitly chosen by the product owner.
- Only the atomic returned witness admits a stream; read-then-unconditional-write
  permits two downloads under contention.
- A null `expires_at` preserves single-use admission. A non-null deadline allows
  repeat admission strictly before expiry; equality rejects. Revocation blocks
  both policies, and first-use tracking must not turn timed links into single-use.
- Expiry governs starting a download. A stream admitted before expiry may finish
  afterwards; the server does not interrupt active transfers.
- Email scanners and page previews must not consume grants; therefore consumption
  stays behind an explicit POST, with no auto-submit in the browser.
- Installing does not grant workspace membership. The future workspace-email
  caller must keep the existing authenticated invitation acceptance checks.

## Boundary

Global D1 owns pre-workspace requests; Ace may read them and create attributed
manual grants through its Access boundary. The API owns public submission and
redemption. In production these routes accept only the canonical
`PUBLIC_API_BASE_URL` origin, so legacy aliases cannot bypass host-scoped controls. Resend owns delivery. A successful intake response means the request is accepted;
a concurrent acknowledgement may still be sending. Only `sent` records provider
acceptance, not inbox delivery. The state is labelled accordingly in Ace.

The initial implementation does **not** close the public R2 installer and update
origins. It therefore provides scoped links but cannot yet promise exclusive
installer distribution. Release verification, signed desktop updates, retention,
historical DMG/ZIP objects and alternate public origins must be coordinated before
making that promise.

Account approval and invitation-only sign-in are deliberately outside this
subsystem: the product owner rejected those controls. Someone who obtains a
forwarded installer follows the existing account creation and sign-in flow.
Existing workspace membership authorization still applies. Retiring a download
link after activation, if implemented, must govern that link only rather than
introduce a new permission to use Rally.

## Failure modes and limits

Malformed emails fail before persistence. A disallowed/missing Origin fails intake before any write. Download admission
uses the bearer token, including native no-referrer POSTs with `Origin: null`. EU intake returns 404; there is no acquisition-data fallback from EU.
A provider error leaves the request as failed, and the page says it was saved but
asks the visitor to retry confirmation. There is no background delivery queue or
operator resend action yet. A request remaining pending/failed is visible in Ace.
A process interruption between provider acceptance and status persistence has an
uncertain outcome. An explicit retry reuses Resend's idempotency key and frozen
body within the provider's 24-hour window, anchored to the first attempt. Outside
that window it becomes `review_required` without another send. One conditional
claim owns `sending`; concurrent duplicates do not call Resend. A process crash
can leave `sending` for operator reconciliation. Exactly-once delivery is not claimed.

Invalid, expired, used single-use or revoked links return a branded 410 page.
A missing installer returns a branded 503 page with an explicit retry form that
retains the validated token; failures do not strand the user without navigation. Missing installer
or missing binding
returns 503 before consumption. A storage or database exception also prevents a
successful download response. Once the claim commits, a response failure or
browser disconnect cannot establish whether the recipient saved bytes. A single-use
grant
stays used and requires a new link. A timed link can restart a full download until
its deadline. Range/resume requests are not implemented.

The request list is intentionally unpaginated for the seed-stage intake volume.
No arbitrary retention, TTL, cooldown or request cap has been selected. General
public-intake anti-abuse controls and age-based retention remain rollout decisions;
this first slice should not be represented as a fully hardened campaign system.

### Configurable intake guards

`MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR` and `MAX_PRIVATE_ACCESS_REQUEST_BYTES` in
`access-request-limits.ts` are `LIMIT UNSET` open upper bounds. The first bounds
new address/mail attempts per edge IP; choose it from the email budget divided
by active hours, allowing for a whole office sharing an IP. The second bounds
JSON/form bytes before parsing; choose it from legitimate email/token envelope
sizes against concurrent Worker memory. Both are +Infinity until the team picks
values: rate storage and body middleware are skipped in that state. Finite
values return 429/413 before request persistence or provider calls. This remains
unprotected against abuse/oversized bodies while open; allowed origins and email
deduplication are not replacements for those limits.

## Testing

`apps/api/test/private-access.test.ts` uses the checked-in regional migrations and
real SQLite, replacing only Resend's external HTTP response. It covers normalized
deduplication, persist-before-send failure/retry, regional/origin admission,
development suppression, distinct hashed grants, default non-expiry and shared
issuer expiry validation.
`apps/api/test-workers/private-downloads.test.ts` applies migration 0101 to real
D1 and streams real R2 objects through Hono on workerd. It covers concurrent
redemption, repeat timed downloads, exact expiry, expiry during R2 lookup,
missing installers, scanner GET/HEAD and revoked/invalid tokens.
`apps/api/test/ace-private-access.test.ts` covers Ace admission and issuance
through the actual Access middleware and shared issuer, including UTC normalization
and rejection of past, current or ambiguous expiries; site tests retain
legacy release-renderer coverage separately from the new form template.

Mutation checks prove the write, token admission, forced concurrent claim,
origin, expiry, rate/body guards and sender/idempotency paths fail when their
production behavior is broken. The focused tests pass again after restoration.

The test fixture installer is text bytes, never executable software. Browser
verification uses the actual Vite pages and explicitly synthetic Ace records; no
production requests, emails or grants are created.

## Regional impact

Requests are pre-workspace Global data, disclosed in the privacy policy. Migration
0101 creates empty schema in both regional databases because they share the
migration chain. The issuer is database-parameterized so future workspace grants
can use the invitation's existing region. The first browser redemption endpoint
is Global only; EU workspace grants must not be issued until regional redemption
and regional links are wired together.

## Launch copy and outreach

[Launch copy](PRDs/2026-09-09_private-access/launch-copy.md) holds the supplied
wording and launch checklist. The content modules in the path table are the
editable landing/email definitions. Personal outreach, profile research and
onboarding demos remain separate launch work.

The existing Worker-wide maintenance gate also covers intake and downloads.
During planned product maintenance or a failed authority read these routes return
the same maintenance response as other API traffic; no new bypass is introduced.
Successful intake responses do not distinguish duplicates, but explicit email
failures can reveal acknowledgement state during a provider outage. A future
durable acknowledgement dispatcher can remove that distinction without silently
losing retries.

The [security audit](private-access-security-audit-2026-09-09.md) records unresolved
launch controls. Do not treat the open guards or default Cloudflare DDoS protection
as a hardened acquisition system.

## Operations

Apply migration 0101 before deploying the Global API and then Ace/site. The Global
Worker binds the existing `avalon-desktop-releases` bucket as `DESKTOP_RELEASES`;
no new bucket or Cloudflare admin credential is needed. Acknowledgements use the
existing production Resend key. New acknowledgements use the supplied
`Adam @ Rally <hi@rally.ai>` From address, frozen alongside the subject/body.
Permanent provider rejection is recorded as `rejected` in Ace and suppresses
subsequent acknowledgement sends for that request. After resolving a provider
configuration problem, an operator may reset the affected row to `pending`
through Global D1; its frozen sender/content must still be valid before retry.
For `sending` or `review_required`, first reconcile the provider outcome and ensure
no attempt is in flight. Never reset the first-attempt timestamp automatically to
extend retry eligibility. Only an explicit, reconciled operator decision to send
again may clear it; a possibly delivered message is not safe to blindly retry.

Before launch, verify `rally.ai` in Resend and confirm Adam can receive replies
at `hi@rally.ai`; the code does not provision DNS or mailboxes. Other transactional
mail retains its existing sender. Landing copy is compiled
at build time; changing it requires a site deploy. New email copy affects new
requests, while retries retain their original sender and content.

The independent deployment workflows do not enforce this ordering. For the first
release, dispatch the verified API revision through the existing deployment
workflow, confirm migrations and regional health, then merge the site/Ace change. Invitation dispatch and
closing legacy distribution remain the next implementation phases in the PRD.

### Handling an acquisition erasure request

Use the existing privacy-contact and identity-verification process, not an
account-login requirement. This initial slice uses an operator procedure through
existing Global D1 administration; it has no deletion UI, background invitation
sender, research store or invitation-suppression implementation.

1. Normalize the verified email exactly as intake does (trim and lowercase).
   Look up `access_requests` by that email in Global D1 and note the request ID
   only in the authorized support record. Avoid exporting the frozen message or
   putting the address in command output, shell history or a pull request.
2. Coordinate with operators to stop generating request-linked grants while
   erasure runs. Reconcile any in-flight acknowledgement first; a provider call
   already submitted cannot be recalled by deleting its D1 row. Do not retry the
   acknowledgement as part of erasure.
3. Find `download_grants` with `source` equal to `manual` or `access_invitation`
   and `source_id` equal to the request ID. Set `revoked_at` before removing the
   request, so a failed/partial cleanup leaves related downloads denied.
4. Delete those request-linked grant records, then the `access_requests` row.
   This removes its email, frozen sender/subject/body and acknowledgement state.
   Re-query both the email and captured source ID to verify nothing remains;
   repeat cleanup if an already-running operator issuance completed during the
   procedure. The existing redemption predicate rejects deleted or revoked rows.
5. A standalone manual grant has no recipient email association. If one is part
   of the verified request, identify it by the grant ID retained by the operator;
   revoke/delete that grant separately. Do not claim an email lookup found every
   anonymously shared link, and never put a bearer URL in logs to find one.
6. Handle any provider-side message copy using Resend's supported privacy process.
   Local deletion cannot retract already delivered mail or guarantee deletion of
   provider backups; record any unresolved external handling separately.
7. Confirm the outcome without copying deleted content into a new record. These
   actions do not delete a Rally account or affect workspace membership. A later
   explicit signup creates a new request; it does not restore the deleted row or
   its frozen content.

Retain waiting requests while serving that acquisition purpose. Verified
withdrawal/erasure or closure of the early-access programme triggers the procedure
above. An unused single-use grant has no hidden time expiry; revoke it explicitly
when its associated purpose ends. Delete expired/used/revoked grants after their
related delivery/support investigation is complete. No automatic age-based sweep
or numerical retention period is configured.

Future invitation sending must implement the PRD's durable suppression,
cancellation and sender/erasure race handling before it is enabled. This manual
procedure is not a substitute for those controls. Future EU workspace-grant
privacy operations stay in the owning region; the current slice creates none.

## Changelog

### 2026-09-09 — Contain acknowledgement races and record the abuse audit

**What changed:** Added atomic acknowledgement ownership and the provider-window
fence, rejected older rate buckets and unsupported/ambiguous request formats, and
restricted acquisition to the canonical production API host. Recorded a dated
code and production-configuration audit with unresolved launch controls.

**Why:** Concurrent submissions could multiply provider calls, and an uncertain
retry could send again after provider deduplication expired. Host aliases would
bypass canonical-host rules; open limits do not contain abuse or protect D1.

**Considered and rejected:** Automatic recovery of an uncertain sender would risk
repeat mail. Origin validation alone does not stop bots. Arbitrary finite limits
were not installed without the team's decision.

**Consequences:** Reconcile interrupted sends in Ace/Global D1. Before launch,
activate bot proof, finite byte/admission limits, a provider budget and download
throttling as described in the audit; this code change is not DDoS certification.

### 2026-09-09 — Introduce early-access intake and reusable downloads

**What changed:** Added the authored request form and frozen acknowledgement,
Global intake, Ace tracking/issuance/audit events, shared hashed grants and R2
streaming. One founding migration defines the complete undeployed schema. Added
operator erasure, explicit timed mode, retryable error pages, terminal provider
rejection handling and open intake guards.

**Why:** Rally needs gradual team intake and reusable download issuance. Timed
links allow interrupted downloads to restart. Review found that no-referrer native
POSTs carry opaque origins, requiring bearer-only redemption rather than the
intake origin gate; concurrency coverage now forces both claims past preflight.

**Considered and rejected:** Public storage redirects bypass grant admission;
single-use streaming cannot prove a file was saved. Changing the global sender
would rename unrelated mail, and invented TTL/rate/size values would set product
policy without an owner. Additional account approval was explicitly rejected.

**Consequences:** Apply migration 0101 before the API and publish the form afterward.
Verify the supplied sender separately. Invitation dispatch, suppression, workspace
integration and closing legacy public artifact paths remain future work. The two
open guards do not constrain abuse or memory until the team sets values.
