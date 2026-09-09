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
| `packages/db/migrations/0101_private_access.sql`–`0103_access_acknowledgement_sender.sql` | Access requests, download grants, optional expiry and frozen acknowledgement sender. |
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
redemption. Resend owns delivery; a successful API response means provider
acceptance, not inbox delivery. The `sent` state is labelled accordingly in Ace.

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

Malformed emails fail before persistence. A disallowed/missing Origin fails before
any write. EU intake returns 404; there is no acquisition-data fallback from EU.
A provider error leaves the request as failed, and the page says it was saved but
asks the visitor to retry confirmation. There is no background delivery queue or
operator resend action yet. A request remaining pending/failed is visible in Ace.
A process interruption between provider acceptance and status persistence has an
uncertain outcome. An explicit retry reuses Resend's idempotency key and frozen
body; beyond the provider's deduplication window an acknowledgement can repeat.
Exactly-once external email delivery is not claimed.

Invalid, expired, used single-use or revoked links return 410. Missing installer
or missing binding
returns 503 before consumption. A storage or database exception also prevents a
successful download response. Once the claim commits, a response failure or
browser disconnect cannot establish whether the recipient saved bytes. A single-use
grant
stays used and requires a new link. A timed link can restart a full download until
its deadline. Range/resume requests are not implemented.

The request list is intentionally unpaginated for the seed-stage intake volume.
No arbitrary retention, TTL, cooldown or request cap has been selected. General
public-intake anti-abuse controls and retention policy remain rollout decisions;
this first slice should not be represented as a fully hardened campaign system.

## Testing

`apps/api/test/private-access.test.ts` uses the checked-in regional migrations and
real SQLite, replacing only Resend's external HTTP response. It covers normalized
deduplication, persist-before-send failure/retry, regional/origin admission,
development suppression, distinct hashed grants, default non-expiry and shared
issuer expiry validation.
`apps/api/test-workers/private-downloads.test.ts` applies migrations 0101–0102 to real
D1 and streams real R2 objects through Hono on workerd. It covers concurrent
redemption, repeat timed downloads, exact expiry, expiry during R2 lookup,
missing installers, scanner GET/HEAD and revoked/invalid tokens.
`apps/api/test/ace-private-access.test.ts` covers Ace admission and issuance
through the actual Access middleware and shared issuer, including UTC normalization
and rejection of past, current or ambiguous expiries; site tests retain
legacy release-renderer coverage separately from the new form template.

Mutation checks replaced the request address write, removed the unused-grant
condition, and removed Ace’s same-origin guard. The corresponding tests failed
with 500 instead of 202, two successful concurrent downloads, and 201 instead of
403 respectively. Expiry checks additionally skipped the final deadline predicate,
dropped Ace's deadline forwarding, and removed shared future-date validation.
The tests failed with an admitted expired download (200 instead of 410), a null
deadline, and an accepted past expiry respectively. Each mutation was reverted
and the focused suites re-run. Sender checks additionally removed the authored
From override and replaced the stored sender with current copy; they failed on
the incorrect sender and changed retry payload, then passed after restoration.

The test fixture installer is text bytes, never executable software. Browser
verification uses the actual Vite pages and explicitly synthetic Ace records; no
production requests, emails or grants are created.

## Regional impact

Requests are pre-workspace Global data, disclosed in the privacy policy. Migrations
0101–0103 create empty schema in both regional databases because they share the
migration chain. The issuer is database-parameterized so future workspace grants
can use the invitation's existing region. The first browser redemption endpoint
is Global only; EU workspace grants must not be issued until regional redemption
and regional links are wired together.

## Launch copy and outreach

The product owner's supplied copy is retained in the PRD's
[launch copy](PRDs/2026-09-09_private-access/launch-copy.md). The landing page now
leads with “Stop copy/pasting great AI work into Slack,” followed by the shared
chats/skills/context/workflows description, capability line, Work email field,
Get early access CTA and capacity note. Work email is a label, not a new email
domain restriction. Content remains in `access-copy.ts`.

The acknowledgement uses the supplied three-things-to-share prompt and Adam's
signature from `access-request-content.ts`. The longer headline uses a wider
responsive content column; the form remains the only acquisition action.

Personal outreach is a later operator workflow: the form supplies email only,
so a name/profile must be researched and confirmed rather than inferred as fact.
The planned personal invitation is distinct from the automatic acknowledgement.
The source also records the X/personal-post drafts, three onboarding workflow
checks and an inspiration page with recorded demos. Those are launch work, not
features implemented by this copy update.

## Operations

Apply migrations 0101–0103 before deploying the Global API and then Ace/site. The Global
Worker binds the existing `avalon-desktop-releases` bucket as `DESKTOP_RELEASES`;
no new bucket or Cloudflare admin credential is needed. Acknowledgements use the
existing production Resend key. New acknowledgements use the supplied
`Adam @ Rally <hi@rally.ai>` From address, frozen alongside the subject/body.
Legacy rows with a null sender retain the configured transactional sender.
Before launch, verify `rally.ai` in Resend and confirm Adam can receive replies
at `hi@rally.ai`; the code does not provision DNS or mailboxes. Other transactional
mail retains its existing sender. Landing copy is compiled
at build time; changing it requires a site deploy. New email copy affects new
requests, while retries retain their original sender and content.

The independent deployment workflows do not yet enforce this ordering; coordinate
the rollout before merging/deploying the first release. Invitation dispatch and
closing legacy distribution remain the next implementation phases in the PRD.

## Changelog

### 2026-09-09 — Apply supplied early-access copy and Adam's sender

**What changed:** Replaced placeholder landing and acknowledgement copy with the
product owner's source. Added editable capability, field-label and capacity
copy; widened the headline layout. New requests freeze their authored From
address in migration 0103, and the shared email sender accepts that trusted
per-message override. Recorded outreach and demo/onboarding launch checks.

**Why:** Final launch language now exists and positions Rally around sharing AI
work with a team. The first email should come from Adam rather than inheriting
the generic transactional sender, and retries must preserve that same message.

**Considered and rejected:** Changing the global sender would also rename
unrelated workspace/digest mail. Recomputing the sender on retry could change
an already submitted idempotent message. Adding a name field would change the
requested email-only landing flow; profile research belongs to later outreach.

**Consequences:** Apply 0103 before deployment; verify the supplied `rally.ai`
sender domain and mailbox before sending. Existing acknowledgements preserve
their old content and sender resolution. Ad copy is retained as planning material;
no outreach, advertising, sender provisioning or production deployment occurred.

### 2026-09-09 — Exclude additional account admission controls

**What changed:** Recorded that private distribution must not introduce an
approved-account list or invitation requirement for account creation or sign-in.

**Why:** The product owner considers that level of control unnecessary; the
request concerns acquisition and download distribution.

**Considered and rejected:** Blocking people with forwarded installers at sign-in
would add a product restriction beyond the desired private landing page.

**Consequences:** Account admission is not a rollout prerequisite. Existing
workspace permissions remain authoritative, and any later link retirement must
not be interpreted as an account access policy. No authentication code changed.

### 2026-09-09 — Offer timed download links through the shared issuer

**What changed:** Added an optional normalized UTC deadline to grants and a
local date/time choice in Ace. Timed links allow repeat downloads until expiry;
existing and default grants remain single-use. Admission rechecks the deadline
after fetching R2, and `used_at` retains the first-use timestamp.

**Why:** The product owner asked for time expiry instead of a download count.
This also permits full retries after an interrupted transfer during the chosen
window. Both manual generation and future email producers need the same policy.

**Considered and rejected:** A guessed fixed TTL would make a product decision
without a chosen duration. Separate timed storage URLs would split authorization
and lose revocation through the shared grant. No arbitrary download-count option
or range-resume protocol was added.

**Consequences:** Expiry denies new downloads, not an already admitted stream.
Apply migration 0102 before this code; null deadlines deliberately preserve
previous single-use links. Anyone holding a timed link may reuse or share it
until expiry, consistent with the existing bearer-link decision.

### 2026-09-09 — Persist intake and share one download issuer

**What changed:** Added a request-only landing page, stored acknowledgements,
Ace request review, and one hashed bearer-grant issuer used by the ad hoc UI and
available to future email producers. Redemption streams R2 after an atomic claim.

**Why:** Rally is admitting a select testing group and needs to retain interest
without publicly offering its installer. The product owner also explicitly
required ad hoc and automated links to come from the same mechanism.

**Considered and rejected:** Separate email tokens and operator links would split
expiry and redemption behavior. A signed R2 URL alone is reusable until expiry,
which does not implement the requested lifetime. Recipient verification was
explicitly declined. Removing public release access in this slice would break
update and publication paths without their coordinated replacement; that remains
a named rollout gate rather than a security guarantee made prematurely.
