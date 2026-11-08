# Private access

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/access-copy.ts`, `landing.css`, `index.html` | Replaceable static landing copy, layout, and direct canonical installer link. |
| `apps/site/src/pilot-offer.ts` | The landing's pilot offer card: when it slides in, each visitor's six-day deadline, and remembering that a visitor closed it. |
| `apps/site/src/section-nav.ts`, `src/fonts/`, `src/assets/` | The landing's current-section marker, its self-hosted Barlow faces, and its hero and team images. |
| `apps/api/src/services/access-request-content.ts` | Replaceable acknowledgement subject and body, delivered as plain text. |
| `apps/api/src/services/access-request-service.ts` | Persist-before-send acknowledgement, deduplication and explicit retry. |
| `apps/api/src/routes/private-access.ts` | Global public intake and explicit POST download redemption. |
| `packages/contracts/src/private-access.ts` | Runtime-validated public and Ace contracts. |
| `packages/db/src/private-access.ts` | Shared grant issuer, hash, URL builder, redemption and request listing. |
| `packages/db/migrations/0101_private_access.sql` | Access requests, download grants, optional expiry and frozen acknowledgement sender. |
| `apps/ace/src/private-access.ts`, `client/private-access.tsx` | Access-protected request list and ad hoc grant generator. |
| `apps/site/download/index.html`, `src/download.ts` | Fragment-based grant handoff and deliberate Download button. |
| `apps/api/src/services/workspace-service.ts` | Issues a `workspace_invitation` grant alongside each Global workspace invitation. |
| `apps/api/src/services/invitation-email-service.ts` | Renders the optional download link into the invitation email. |

## How it works

The public landing page links directly to the canonical macOS installer. It does not collect access requests or load Turnstile. The existing intake API, Ace review tools, and token-based invitation downloads remain available for their separate workflows. Downloading the installer does not grant workspace membership.

Global `POST /access/requests` remains the intake boundary for a future authorized client. Validation trims and lowercases the email. D1 has a unique normalized email: repeated submissions preserve
the original row, request time, and frozen acknowledgement sender/subject/body. A new or
failed request sends through the existing Resend service, reduced to plain text
by the shared renderer and sent with no HTML part. Success records provider acceptance; development records `skipped` and
never calls the provider. An acknowledged duplicate returns the same accepted
response without sending another message. The endpoint still requires and verifies
a Turnstile proof from any future authorized client; the current landing page does
not initialize that client or a browser widget.

Ace reads Global requests from its existing D1 binding, searches server-side, and keyset-pages 50 rows at a time. It shows acknowledgement state, first-attempt time and request ID for provider reconciliation. Grant history is separately paginated and contains recipient attribution and lifecycle timestamps, never raw tokens; `listDownloadGrants` resolves that email by joining `source_id` against whichever table the grant's `source` names — `access_requests` for `manual`/`access_invitation`, `workspace_invitations` for `workspace_invitation` — so a workspace-invitation grant is findable by the invitee's email rather than always rendering as an unattributed standalone link. Revocation is a same-origin Access-protected write. An operator can generate a standalone download or
associate one with a request. This creates a `manual` grant and returns its URL
once; it does not send mail or mark the person invited. The same exported
`issueDownloadGrant` accepts `access_invitation` and `workspace_invitation` sources
for email producers; the workspace invitation caller is described below, and
`access_invitation`'s bulk Ace sender remains planned. Source fields are
attribution, not authority.
There is one generator, independent of the UI or any particular email template.
Its optional `expiresAt` accepts a future ISO timestamp with an explicit offset,
normalizes it to UTC, and makes the grant repeatable until that instant. Omission
preserves single-use behavior with no time expiry. Ace defaults to timed mode and requires operators to choose an
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

The shared `revokeDownloadGrantsForInvitation(db, invitationId)` primitive
invalidates any still-live grant tied to one invitation, keyed on the
`download_grants_source` index over `(source, source_id)`. Every place a
workspace invitation can end calls it: `revokeInvitation`'s explicit admin
revoke, `declineInvitationForUser`'s invitee decline, the duplicate-invitation
path in `createInvitation` that supersedes an existing pending invitation to
the same email (via `RETURNING id` on that `UPDATE`, since the superseded row's
id is otherwise not known to the caller), and `leaveWorkspace("abandoned")`'s
bulk revoke of every pending invitation in a closing workspace (a fourth batch
statement matching `source_id` against that workspace's invitations). A grant
issued for an invitation later invalidated through any of these paths does not
outlive it.

## Invariants

- D1 persistence precedes provider I/O; otherwise a mail failure loses the lead.
- The acknowledgement sender, content and idempotency key stay fixed per request;
  otherwise retrying after a copy change conflicts at Resend.
- The acknowledgement carries no HTML part; otherwise an authored note arrives
  styled as a campaign.
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
- Installing does not grant workspace membership. The workspace-invitation
  caller keeps the existing authenticated invitation acceptance checks; a grant
  never bypasses them.

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

The request and grant lists each use a 50-row UI page with a `(created_at, id)` cursor. Search uses bound parameters and literal substring matching. There is no automatic retention schedule or background campaign dispatcher.

### Launch abuse controls

`private-access-edge.ts` runs before the Worker authority read. It uses Hono’s path decoder and rejects encoded acquisition paths, wrong
hosts, regions, methods and origins without D1; browser preflight also stays out
of D1. A Worker `ACCESS_EDGE_RATE_LIMITER` binding applies a coarse per-IP limit
before database work. This is a per-Cloudflare-location, eventually consistent
traffic filter, **not** an exact global allowance. Platform DDoS protection still
handles network floods; this change does not claim protection against every botnet.

The route counts actual body bytes (including chunked bodies and incorrect length
headers) before parsing. Production intake validates Turnstile server-side,
requiring success, the submitting origin's hostname, and `access_request` action.
Missing secrets, missing tokens, expired/replayed tokens, wrong actions/hosts,
and verifier errors all fail closed. Local development skips the external verifier
and never sends mail. The landing site has no intake client and therefore ships
no challenge script, widget, or public Turnstile key.

The authoritative hourly email budget is a conditional update of the singleton
`access_email_budget` row in Global D1. It counts attempts, including uncertain
provider failures and operator retries, across all IPs and Cloudflare locations.
Full capacity leaves the lead pending instead of dropping it. A retryable provider
409 (`concurrent_idempotent_requests`) remains failed/retryable; changed-payload
idempotency conflicts require operator review. Other non-retryable provider errors
also become `review_required`: Resend's 4xx codes include sender/authentication and
payload failures, so they cannot establish that the visitor's address is wrong.
Fixed windows can admit a burst across
the boundary; this is a cost budget, not a smooth traffic scheduler.

Known download grants atomically count starts per minute before R2 I/O. Random
invalid tokens never create rate rows. A throttled holder receives a branded 429
with an explicit retry form; neither expiry nor revocation interrupts an already
admitted stream. A failed storage lookup can spend a start allowance, but does
not consume the grant itself.

The team approved the launch values on 2026-09-09:
`MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR` is 10, `MAX_PRIVATE_ACCESS_REQUEST_BYTES`
is 8 KiB, `MAX_ACCESS_EMAILS_PER_HOUR` is 100, and
`MAX_DOWNLOAD_STARTS_PER_MINUTE` is 5. The Global Worker's
`ACCESS_EDGE_RATE_LIMITER` is 30 requests/IP/minute. These are accepted launch
tolerances, not measured capacity: ten signups allow a small shared office,
8 KiB leaves room above the documented 2,048-character challenge token and email
envelope, 100/hour permits up to 2,400 mail attempts/day, and five download starts
allow an initial transfer plus four restarts. Thirty edge admissions leave room
for several users restarting and signing up. A larger shared office can reach the
IP limits; a distributed attacker can exhaust the acknowledgement budget and
delay legitimate email. Already admitted downloads can outlive the minute window.

The production boundary refuses acquisition until **all four constants are
finite**, the limiter binding exists, and the Turnstile secret is installed.
No Infinity value is serialized into Wrangler. The guard machinery can be
reviewed/tested without silently exposing an unbounded production intake.

## Testing

Mutation checks prove the write, token admission, forced concurrent claim,
origin, expiry, rate/body guards and sender/idempotency paths fail when their
production behavior is broken. The focused tests pass again after restoration.

The test fixture installer is text bytes, never executable software. Browser
verification uses the actual Vite pages and explicitly synthetic Ace records; no
production requests, emails or grants are created.

## Launch copy and outreach

[Launch copy](PRDs/2026-09-09_private-access/launch-copy.md) holds the supplied
wording and launch checklist. The content modules in the path table are the
editable landing/email definitions. Personal outreach, profile research and
onboarding demos remain separate launch work.

Intake and downloads have their own origin, rate, and credential checks.
Successful intake responses do not distinguish duplicates, but explicit email
failures can reveal acknowledgement state during a provider outage. A future
durable acknowledgement dispatcher can remove that distinction without silently
losing retries.

The 2026-09-09 early-access security audit recorded unresolved launch controls;
it is a historical record now, listed in [architecture.md's
changelog](architecture.md#2026-11-08--retirement-records-spaces-space-access-sources-projects-the-implementation-plan-meeting-notes). Do not treat the open guards or default Cloudflare DDoS protection
as a hardened acquisition system.

## Operations

Apply migration 0101 before deploying the Global API and then Ace/site. The Global
Worker binds the existing `avalon-desktop-releases` bucket as `DESKTOP_RELEASES`;
no new bucket or Cloudflare admin credential is needed. Acknowledgements use the
existing production Resend key. New acknowledgements use the supplied
`Adam @ Rally <hi@rallywith.ai>` From address, frozen alongside the subject/body.
Non-retryable provider failures are recorded as `review_required`. Ace's Review email panel
relays recovery through the Global API's existing `DEMO_OPERATORS_JSON` operator
boundary (`demos` role), never through a browser-held provider key. Supported actions:

- Retry pending/failed mail with the existing key and frozen content.
- Mark provider acceptance confirmed after checking Resend.
- Start a new send after confirming the prior attempt was not accepted and no
  send is in flight. This deliberately refreshes sender/copy and increments the
  generation in the idempotency key; it is not an automatic retry.
- Suppress further acknowledgements for an address after a complaint or bad
  recipient. Duplicate public requests cannot remove suppression.

The panel requires an explicit provider-review confirmation and sends the row's
observed generation. Conditional writes refuse stale recovery actions. Every
provider completion is generation-fenced so an older attempt cannot overwrite
operator recovery. A `sending` row is never retried automatically. Explicit recovery requires the operator to reconcile the provider outcome and ensure no send is in flight; there is no arbitrary waiting period substituting for that check. The UI shows the request ID and first-attempt time for lookup.
Recovery and revocation emit operator/record/action audit events without email,
bearer URL, or provider response bodies. There is no automatic bounce webhook or
bulk sending in this slice; use provider delivery records and manual suppression.

The Global API retains `TURNSTILE_SECRET_KEY` so the dormant intake endpoint
continues to fail closed. The landing Worker has no public intake client and does
not require a Turnstile site key. Any future browser client must provision and
bind its public key as part of re-enabling that product surface. Deploy the
approved limiter binding and finite constants before public acquisition is
enabled.

The Cloudflare Single Redirect rule `Redirect retired public landing hosts to Rally`
in the `with-avalon.com` zone matches only `with-avalon.com` and
`www.with-avalon.com`. It returns 301 to `https://rallywith.ai` with the original
path and query string, before the old hosts can serve an unusable Turnstile form.
API and download subdomains are excluded from this redirect. The rule lives in
Cloudflare's `http_request_dynamic_redirect` phase, not `_redirects`: Workers
Static Assets does not support domain-level redirects there. Rule ID:
`4bc018c19c794f3fb6c092cf3faf7a1b`.

The team selected `Adam @ Rally <hi@rallywith.ai>` after the Resend dashboard
confirmed `rallywith.ai` is verified; `rally.ai` is not configured there. Receiving
replies is explicitly not required. No live acknowledgement was sent during
configuration verification. The code does not provision DNS or mailboxes. Other transactional
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
above. Manual suppression is retained while needed to prevent unwanted acknowledgement mail; verified erasure removes it with the request and a later submission can therefore send again. Future campaigns need their own consent/suppression lifecycle. An unused single-use grant has no hidden time expiry; revoke it explicitly
when its associated purpose ends. Delete expired/used/revoked grants after their
related delivery/support investigation is complete. No automatic age-based sweep
or numerical retention period is configured.

## Changelog

### 2026-10-11 — Pilot offer card with a per-visitor deadline

**What changed:** The landing shows a pilot offer card two seconds after load:
first two months on us, with a Sign up link into the web app. Each visitor's
deadline is six days after the day the card first appeared in their browser,
stored as that local date and kept on later visits; after it the card stops
showing. The Sign up link carries the first-visit date as `pilotOfferFirstSeen`.

**Why:** The product owner wanted urgency for pilot signups. A date that always
reads six days out was asked for and declined: it is a false deadline, the kind
the EU bans and the FTC pursues, and a returning visitor would see it move. A
per-visitor date that is honored gives the same urgency truthfully.

**Considered and rejected:** One fixed campaign end date, which an earlier
commit in this change used; the product owner preferred a rolling window.
Storing the first visit as an instant, which shifts the date by a day for a
visitor who later browses from another time zone. Recording it on page load,
which spent the window of a visitor who left before the card appeared.

**What a future change must respect:** The deadline is only true if signups are
held to it. Nothing reads `pilotOfferFirstSeen` yet; until the follow-up records
it, every pilot who signs up through the card qualifies. Without local storage
every visit is a first visit, so the date moves forward for that visitor.

### 2026-09-29 — Dark multi-section landing from the agency design

**What changed:** Rebuilt the landing on the agency's design: a dark theme set in
Barlow over a sunrise hero, then Teamwork, Sidekicks, Features, Team and Pricing
sections with a sticky numbered side navigation. The shared-thread demo, the
canonical installer links, the copy renderer and the trust footer carry over.
`section-nav.ts` marks the current section for any `nav[data-section-nav]`.

**Why:** The product owner asked for the agency's design and content. The
agency delivered a TanStack Start, React and Tailwind app; the landing stays
static HTML and hand-written CSS, so it ships no framework and keeps the
existing build, CSP and tests.

**Considered and rejected:** Importing the agency app as-is, which would add a
React runtime and a second build to a page with one interactive behavior.
Loading Barlow from Google Fonts and the team photos from `juno-labs.com`, which
the site CSP (`default-src 'self'`) blocks; both now ship from the site origin.
Keeping `help@rallywith.ai` as the only public address: the product owner wants
each founder's address linked from the team section, and spam is an accepted
cost.

**Consequences:** The landing is now dark while the other public pages stay
light; the ink mark is inverted with CSS rather than adding a new mark file. A
new font weight must be added to `src/fonts/` with its README row first. The
Sidekicks "When something happens" blurb was unfinished in the design and was
completed with one concrete example in the tone of the rest of the page.

### 2026-09-21 — Remove retired acquisition and release deployment coupling

**What changed:** Deleted the unused landing-page intake and Turnstile client,
removed the Turnstile-key requirement from site deployment, and made
`deploy-site.yml` the only workflow that publishes the landing Worker. Desktop
releases continue to advance the canonical installer and record their durable
release state without rebuilding the site.

**Why:** The direct-download homepage neither submits access requests nor renders
desktop release metadata. Retaining those build requirements blocked unrelated
copy and link-preview deployments during release transitions without protecting
anything visible or executable on the site.

**Considered and rejected:** Keeping the dormant client and release-driven site
deploy as future-ready scaffolding preserved two independent failure paths and
the historical risk of an older release checkout overwriting the live site.

**Consequences:** The Global intake endpoint and its server-side Turnstile guard
remain available but have no public landing-page caller. A future intake UI must
restore its own client, public key, and tests explicitly. The canonical installer
continues to advance entirely through desktop publication.

### 2026-09-21 — Collaboration landing with a direct macOS download

**What changed:** Replaced the email-only landing with the approved static hero and shared-thread demo. The macOS Beta action links to the configured canonical DMG, and the announcement card is noninteractive. Visible copy and metadata use the existing copy renderer.

**Why:** Outreach feedback prioritized a clear collaboration story, and the product owner explicitly requested that the beta action download the app rather than ask for an email. The full demo introduction must remain visible on normal laptop screens.

**Considered and rejected:** A dialog wrapping the existing intake form preserved private acquisition but contradicted the requested direct-download behavior. It has been removed; the homepage no longer initializes its verification widget.

**Consequences:** Installer distribution from the homepage is public; workspace membership and invitation-token download controls remain unchanged. Existing request records, intake endpoints, and Ace operations are retained. The homepage uses the fixed canonical installer alias that desktop publication advances independently of the release record. Trust/support links and regional telemetry stay intact.

Shipped in #892.

### 2026-09-12 — Wire the shared issuer into Global workspace invitations

**What changed:** `WorkspaceService.createInvitation` now issues a
`workspace_invitation` grant, timed to the invitation's own 7-day expiry, for a
Global workspace and passes its URL to `sendWorkspaceInvitationEmail`, which
renders it as a second link/button alongside "Accept invitation". Issuance runs
inside the same `try` that sends the email, so a grant-issuance failure or an
email-send failure both revoke the grant (if one was issued) and the invitation
row through the one existing rollback path. Per the PRD's own invariant that
revocation or supersession must invalidate a linked grant, the other three
places a workspace invitation can end — an administrator's explicit
`revokeInvitation`, a duplicate invitation to the same email superseding a
pending one, an invitee's `declineInvitationForUser`, and a workspace closing
via `leaveWorkspace("abandoned")` — now revoke any grant tied to that
invitation too, via a shared `revokeDownloadGrantsForInvitation` primitive
keyed on the existing `(source, source_id)` index. `listDownloadGrants` also
joins `workspace_invitations` on `source_id` so these grants are attributed and
searchable by the invitee's email in Ace, the same as request-sourced grants
already were — the fallback of an operator revoking one by hand doesn't work on
a row Ace can't find.

**Why:** The invitation email's only link opens `/invite/`, whose "Open Rally"
button is a `rallywithai://` deep link that does nothing when the app is not
already installed, and that page's copy ("install it first") pointed nowhere. An
invited teammate with no existing install had no way to get Rally from the
invitation email at all — reported as a real lockout, not a hypothetical gap.
The `workspace_invitation` source and the database-parameterized issuer already
existed for exactly this caller; nothing about the grant primitive needed to
change. The revocation cascade and the Ace attribution join were not part of
the first cut of this change; independent review found both — the cascade gap
against the PRD's own stated invariant, the attribution gap by four of six
reviewers in one pass — cheaply enough (an existing index makes each cascade
site a one-statement addition) that fixing them outright was worth it over
documenting four more places where a stale grant can outlive its invitation.

Shipped in [#728](https://github.com/juno-ai-labs/avalon/pull/728).

### 2026-09-10 — Send the acknowledgement as plain text

**What changed:** The acknowledgement sends no HTML part. The stored copy is
still reduced by `markdownToEmailText` rather than sent verbatim. Carrying that
required relaxing the shared Resend caller (digests (retired)), where `html`
was mandatory and is now optional and omitted rather than sent empty.

**Why:** A person's four-paragraph reply arrived in the app's dark palette,
which reads as a marketing send rather than mail from a founder. Every other
email through that sender is a model's Markdown, which needs elements to read as
anything; authored prose does not, and the requirement was the renderer's
assumption rather than the provider's. Styling this one lighter instead would
have answered the light-palette question `email-markdown.ts` has deliberately
left open, on behalf of a surface that wants no palette at all.

**Considered and rejected:** Rewriting the copy as literal plain text and
sending it verbatim. Content is frozen per request, so rows stored before this
change would retry as visible `**` and `<br/>`; reducing keeps old and new rows
identical.

**Consequences:** A request whose first provider attempt is under 24 hours old
retries with a different payload under the same idempotency key, which Resend
answers 409 and this records as `review_required` — reconcile those in Ace
rather than reading them as delivery failures. Copy edits are now written as the
reader will see them: emphasis is dropped and a link arrives as its label
followed by the bare URL. A caller that omits
`html` no longer fails to typecheck, so text-only has to be a deliberate choice;
`text` stays required, since Resend rejects a message with neither part.

Shipped in [#659](https://github.com/juno-ai-labs/avalon/pull/659).

### 2026-09-10 — Hide the landing-page challenge unless a visitor must interact

**What changed:** The landing page renders the managed Turnstile widget with the
`interaction-only` appearance instead of the default always-visible one. The
challenge still runs on page load and still gates the submit button, but no
widget is shown unless Cloudflare decides the visitor has to complete a check.
A `ResizeObserver` on the widget container reserves the spacing above the form
and fills a visually hidden live region only while the widget has a rendered
height, and releases both when Cloudflare hides it again.

**Why:** The product owner does not want visitors to see a verification widget
unless they have been flagged and must prove themselves. The server-side proof
is unchanged, so the abuse controls lose nothing; only the visible widget goes.
Review of the first cut, which set the spacing from `before-interactive-callback`
and cleared it only on reset, found that Cloudflare also hides the widget on a
token refresh and an interactive timeout, so a callback-driven marker could
outlive the widget and leave a phantom gap.

**Considered and rejected:** Switching the widget to Invisible mode would remove
the checkbox entirely, so a flagged visitor could never pass. Running the
challenge only on submit (`execution: 'execute'`) would also hide the widget but
adds a wait to every submission and a larger change to the form flow for no
visible gain. Hiding the container with `display: none` would keep the challenge
frame from laying out; Cloudflare's own appearance mode keeps it rendered but
out of flow. Tracking Turnstile's reveal and hide callbacks was rejected in
favour of the rendered height because it depends on lifecycle details the
documentation does not state.

**Consequences:** The widget must remain in Managed mode in the Cloudflare
dashboard. While the token is pending the button is disabled with no widget to
explain it, which on a normal connection lasts well under a second; a delayed
message is possible but its delay is the team's number to set. The live-region
copy lives in `access-copy.ts` with the rest of the landing copy. Browser
verification with Cloudflare's forced-interaction test key confirmed that a
passed widget stays in view, so the spacing stays with it and only the note
clears on proof.

PR #655.

### 2026-09-09 — Configure the approved launch limits and Turnstile deployment

**What changed:** Set the four application caps to 10 signups/IP/hour, 8 KiB,
100 mail attempts/hour and five download starts/link/minute, and added the Global
30 requests/IP/minute binding. Provisioned the Rally-only widget and its keys;
the desktop-release site step now receives the public key too. The acknowledgement
sender uses the team's corrected `hi@rallywith.ai` address on the verified domain.
Configured a Cloudflare redirect for the two retired landing hosts, preserving
paths and queries while keeping the widget restricted to the current domain.

**Why:** The team accepted these proposed numbers after the unconfigured site
deployment stopped. The assumptions and tradeoffs are recorded above. Passing
the key only to the standalone site workflow would still break the next desktop
release's site build. Incoming mail is not required by the product owner.
The old site routes still existed; redirecting at the edge prevents a dead
signup form without reauthorizing the retired domain or adding a site Worker.

**Consequences:** No acquisition caps remain unset. The provider confirms the
outbound domain, but successful deployment and browser verification remain launch
prerequisites. Existing requests retain their frozen sender until an operator
explicitly starts a reconciled generation; this does not silently change retry payloads.

### 2026-09-09 — Add the launch abuse controls and manual recovery

**What changed:** Added server-verified Turnstile, a pre-D1 traffic filter,
actual-byte parsing guards, a globally coordinated acknowledgement budget,
per-grant download admission, Ace pagination/search/revocation, and explicit
email recovery with generation fencing. Timed mode is the Ace default. Provider
configuration failures require review instead of blaming the recipient's address.

**Why:** Anonymous callers could spend shared email capacity or make the operator
list unusable; uncertain sends needed recovery without duplicate mail. Interrupted
downloads need retryable links. Production must refuse rather than silently open
when the numeric limits or verification configuration are missing.

**Considered and rejected:** A per-location rate binding cannot enforce a global
mail budget. A background campaign system and account approval add unnecessary
scope; manual provider reconciliation and bearer links preserve the chosen product.

**Consequences:** The four proposed finite limits and the coarse binding value
still require the team's decision. Turnstile provisioning and a verified monitored
sender are external launch prerequisites. This change neither enables bulk mail
nor retires the existing public installer origins. Recovery changes must preserve
the provider window on ordinary retries and generation checks on recovery.

PR #637.

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
