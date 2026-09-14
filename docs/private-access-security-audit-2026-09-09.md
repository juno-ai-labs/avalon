# Early-access security audit — 2026-09-09

**Verdict: hold the public launch.** The capability design is sound, but the
current defaults do not contain signup abuse or application-level denial of
service. Green functional CI did not establish that. Several concrete defects
were fixed during this audit; active admission limits and bot protection remain
launch work. [Private access](private-access.md) owns the living implementation.

## Scope and method

Reviewed PR #637 at `40b12b922a6b8918e1ca5d0fce40f109ce7e3d1e`, then the audit
fixes in this change: public intake, acknowledgements, shared grants, redemption,
Ace authorization/listing, browser handling, deployment aliases, and logging.
Inspected production Cloudflare configuration through read-only APIs. Used local
real-migration SQLite and workerd/R2 regression tests, with external email replaced
by provider doubles in the final suite. No production load test, live email,
installer flooding, or production configuration change was performed.

This is a scoped code/configuration assessment, not an independent penetration
test or a capacity certification. Existing workspace-invitation implementation,
account authentication, the complete desktop client, and all dependencies were
not exhaustively re-audited. Future bulk dispatch and workspace-specific download
grants have no implementation here to certify.

## Production configuration observed

| Surface | Read-only observation | Meaning |
| --- | --- | --- |
| `rallywith.ai` | Active, unpaused Pro zone | Cloudflare fronts the canonical site/API. |
| `with-avalon.com` | Active, unpaused Free zone | Legacy API aliases must be considered separately. |
| Both zones | No `http_ratelimit` or custom-firewall entrypoint; API returned explicit missing-entrypoint errors | No configured zone-specific admission rule was found. |
| Managed WAF | Catalog entries exist, but no managed-firewall entrypoint was found in these zones; account list contained only a managed catalog entry | A listed managed ruleset is not evidence of a deployed application-specific rule. |
| Global Worker | No rate-limit bindings; workers.dev and preview URLs disabled | No Worker limiter protects D1; the alternate workers.dev bypass is closed. |
| Turnstile | No widget registered for Rally domains | The form has no verified bot challenge. |
| Observability | Invocation logs and traces enabled at sampling 1; query redaction false; PostHog destinations | Admitted junk can also multiply logs/traces. Never move tokens into queries. |

The legacy rate-limit API returned 410, not an empty successful response; this
report does not infer additional legacy coverage from that endpoint.
Cloudflare's default DDoS protection is enabled for onboarded zones, including
HTTP attacks. That is valuable network/traffic-pattern protection, but it is not
an application email budget or proof that low-rate valid-looking abuse is blocked.
[Cloudflare DDoS defaults](https://developers.cloudflare.com/ddos-protection/get-started/).

### High — arbitrary-address email abuse and waitlist poisoning

`apps/api/src/routes/private-access.ts` accepts an unauthenticated address and
calls the shared Resend sender. An HTTP client can supply the allowed Origin;
CORS and Origin checks constrain browsers, not bots. Distinct addresses bypass
email deduplication. `MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR` is `Infinity`, and there
is no bot proof or aggregate acknowledgement budget. An attacker can fill the
waitlist and spend provider requests or cause unwanted Rally mail to third parties.
The shared sender/key makes delivery reputation and provider throttling a concern
for other transactional mail too. No specific provider suspension is asserted.

**Required:** server-validated Turnstile on signup, finite per-IP admission, and a
separate atomic global acknowledgement-attempt budget before the provider call.
Check the challenge's expected hostname and action, reject missing/invalid/replayed
proofs, and fail closed if verification/configuration is unavailable. Turnstile
proofs are single-use and require server validation; a widget alone is insufficient.
[Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
A challenge does not prove mailbox ownership, so it complements the budget.

### High — request bodies remain unbounded at application scale

`MAX_PRIVATE_ACCESS_REQUEST_BYTES` is `Infinity`. JSON and URL-encoded parsing
retain caller-sized input in memory. The audit removed unnecessary multipart
parsing and refuses unsupported content types, but this does not bound valid-type
bodies. Schema validation runs after parsing. Cloudflare's platform request limit
is not a suitably small envelope for an email address or bearer token; Workers
have a 128 MB memory limit shared by an isolate's work.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

**Required:** activate the byte guard before parsing, reject oversized declared
and streamed bodies, and test the streaming path without Content-Length. Do not
rely solely on a post-parse schema length check. A limit must preserve the normal
email plus challenge-token envelope, not permit arbitrary attachments.

### High — a database-backed limiter cannot protect the database from DDoS

Even when made finite, `admitAccessRequest` runs after body parsing and performs
an expiry DELETE and counter write in shared Global D1 for each checked request.
Before that, `worker-events.ts` already reads work-stream authority from D1 for
every non-health request. Invalid download tokens with valid syntax also cause a
D1 lookup. The rate guard can protect mail volume per IP, but rejected traffic
still reaches shared state. Rotating IPs defeats a per-IP-only budget.

**Required:** reject abusive traffic at Cloudflare's edge or through an early
Worker limiter before the authority query/body work; retain an atomic budget for
provider spending. D1 processes a database's queries serially, so extra reads and
writes compete with product operations. This inherited entrypoint issue also
exists beyond `/access`; it must not be claimed solved by a route-only guard.
[D1 throughput](https://developers.cloudflare.com/d1/platform/limits/).
Workers rate-limit bindings are fast, per-location and eventually consistent;
they are suitable for shedding traffic, not exact global accounting.
[Worker limiter semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

### High — a valid timed link permits unlimited concurrent installer starts

A holder of a timed bearer grant can repeatedly open full R2 streams until expiry.
Single-use grants have atomic admission; timed reuse is deliberately allowed.
The time deadline bounds duration, not request count, concurrency or bytes served.
Every accepted start involves storage/Worker operations, and no rate or global
kill switch is enforced for this surface. Random token guessing is impractical,
but a leaked or legitimately acquired timed link does not require guessing.

**Required:** a per-grant start throttle, coarse attempt limiting before token
lookup, and an operator emergency stop/revoke path. Throttled responses must keep
the token usable and offer a retry; do not consume a single-use grant on throttling.
Revocation currently requires the documented Global D1 procedure. It stops new
admissions, not streams already admitted. R2 does not charge egress bandwidth;
the concern is repeated operations, served traffic, and shared-service pressure,
not an invented R2 bandwidth bill. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

### Medium — poisoned intake can make Ace expensive to open

`packages/db/src/private-access.ts:listAccessRequests` fetches and sorts the entire
list; Ace searches in the browser. Public junk rows therefore turn one authorized
page load into an increasingly large query, response, and DOM. Authentication does
not bound attacker-influenced result size.

**Recommended:** indexed keyset pagination and server-side search before opening
acquisition broadly. Preserve export/select-all semantics for future campaigns
without materializing every row in the browser. Choose the page size explicitly;
no arbitrary cap was installed during this audit.

### Medium — acknowledgement-state inference and logging amplification

During a provider failure, an address already marked sent returns 202 while an
unacknowledged address can return 502/503. This is an acknowledgement-state oracle,
not access to the full list. Request logs and unsampled traces add per-request
cost/noise even for failed traffic; no exact bill was measured.

**Recommended:** a uniform persisted-request response with durable, internally
managed acknowledgement retries. Keep operational failures visible in Ace. A
fire-and-forget promise or `waitUntil` alone is not a durable dispatcher. Edge
rejections should precede application logging. Preserve useful aggregate abuse
signals instead of indiscriminately turning production diagnostics off.

## Defects fixed in this audit

| Defect | Evidence before the fix | Current behavior |
| --- | --- | --- |
| Concurrent acknowledgement calls | Two real reads of pending state could reach two provider calls for one request | Conditional `UPDATE ... RETURNING` grants one sending owner; concurrent duplicates return accepted without another send. A barrier test forces both real reads before either claim. |
| Retry after provider deduplication expiry | An uncertain attempt followed by a retry at 24 hours called the provider again | Persist the first-attempt time; at or beyond the provider window, pending/failed attempts become `review_required` and do not automatically send. |
| Counter rewind | An older in-flight admission replaced a newer exhausted hourly bucket and reopened admission | The counter's conditional update rejects an older bucket. |
| Extra request formats | JSON in text/plain reached sending; multipart/repeated-token forms could reach download parsing/admission | Signup requires JSON. Download requires one URL-encoded token field; unsupported formats, duplicate tokens and extra fields are rejected before R2 access. |
| Alternate-host bypass of future canonical rules | The new route had no canonical-host restriction; legacy API/ingress aliases share the Worker | Production acquisition is restricted to `PUBLIC_API_BASE_URL`. Other product/webhook routes retain their existing compatibility behavior. |

Resend retains idempotency keys for 24 hours; the new constant transcribes that
provider contract rather than inventing a retry timeout.
[Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
A Worker interruption can leave `sending` unresolved. This intentionally requires
operator reconciliation instead of silently resending a possibly delivered email.
It is not an exactly-once delivery guarantee or automatic outbox implementation.

The host restriction is inside the app route: it prevents acquisition writes and
email/R2 use through aliases, but the earlier authority read still occurs. It is
not a substitute for the pre-D1 control above. Canonical webhook hosts already
have their own path fences; do not broadly rewrite those during acquisition work.

- Tokens use 256 bits of cryptographic randomness; storage retains SHA-256 only.

- Download authority is the bearer token, as requested; email verification and
  approved-account sign-in gates were not introduced.

- Grant queries are parameterized, token lookups are indexed, and deadlines use
  normalized UTC strings. Expiry/revocation/use is rechecked at atomic admission.

- GET/HEAD and email-link previews do not consume a grant. Missing R2 objects do
  not consume it. Concurrent single-use redemption admits only one stream.

- The generated token is a URL fragment, removed by the browser and excluded from
  site telemetry. Redeeming streams bytes instead of returning a reusable object
  redirect. No caller-supplied bucket key or download destination is accepted.

- Existing public installer/updater URLs remain accessible by design. Restricted
  landing links do not make distribution exclusive or prevent resharing a DMG.

## Proposed launch values — awaiting a team decision

These are assumptions offered for review, **not installed settings**. The existing
source limits remain open. Repository policy requires the team to choose defensive
numbers; this report must not be read as approval to ship an uncapped endpoint.

| Control | Proposal and explicit assumption | Tradeoff |
| --- | --- | --- |
| Signup IP/hour | 10 attempts, assuming one signup per person and room for a small team sharing one address | A shared office/proxy with more signups may be blocked; IP rotation bypasses it. |
| Global acknowledgement attempts/hour | 100, assuming the launch can admit at most that much outbound acquisition mail | 100 × 24 = 2,400 attempts/day; verify against the actual Resend plan and reserve other mail's quota. A bot can exhaust this budget and pause new acknowledgements. |
| Request bytes | 8 KiB, assuming an ordinary email field and a challenge token of at most 2,048 characters plus JSON overhead | Small normal envelopes fit; unusually encoded or extended payloads can be refused. This is not a measured concurrency capacity. |
| Starts per grant/minute | 5, assuming room for platform selection/retry without continuous restarts | Still permits 300 full starts/hour/link. At an illustrative 250 MiB per artifact that is about 73 GiB/hour/link; it is a start throttle, not a global traffic ceiling. |

Pre-D1 request throttling and Ace pagination additionally need values chosen for
their actual enforcement mechanism. Do not treat the per-IP email cap as either.
The user was asked about the four proposals above during the audit.

## Validation and release gate

The audit regression suite uses checked-in migrations. Initial runs reproduced
concurrent provider calls, the expired retry window, a rewound rate bucket and
unsupported signup formats. After fixes, those tests pass. Production mutations
independently broke the atomic send predicate, retry deadline, bucket ordering,
content-type check, token-field check and canonical-host fence; each corresponding
test failed. Workerd
checks real D1/R2 and confirms rejected forms neither read the object nor consume
the grant. The site suite checks the new review-required message.

Validation passed: full `pnpm test`, `pnpm lint`, `pnpm typecheck`, documentation
checks, site/Ace builds, and both regional API dry-run/startup builds. The new
review-required notice was inspected in a real browser using a local fixture.

Before public release, complete and test the four High controls above, verify the
sender/reply domain, and confirm deployed rules actually cover the canonical host
without alias bypass. No high-volume production experiment is required to turn on
basic protection. Recheck CI and review against the final head, deploy API/schema
first, then publish site/Ace. Automatic merge/deployment is paused during this audit.

## Follow-up — launch essentials implementation (2026-09-09)

PR #637 now includes Turnstile server validation, a pre-database Worker-rate
boundary, actual-byte request limits, a singleton D1 email budget, per-grant
minute admission, paginated Ace lists, revocation and manual acknowledgement
recovery. Recovery generations fence stale completions; the documented retryable
Resend concurrency 409 is no longer treated as permanent rejection. Other
non-retryable provider failures go to operator review without blaming the visitor's
address; their HTTP status cannot distinguish sender/auth failures from a bad recipient.

The original findings above describe the audited revision. These mechanisms are
not yet activated in production: numerical values await the team, the connected
Cloudflare credential rejected Turnstile creation, and the supplied sender remains
unverified/unreachable. Production acquisition fails closed when these abuse
controls are missing. The launch hold remains. See the current owner document
[private access](private-access.md) for exact behavior and the retained limits.

## Follow-up — approved configuration (2026-09-09)

The team accepted the four proposed application values and the 30 requests/IP/minute
Worker binding. The `Rally early access` widget now allows only `rallywith.ai`;
its site key is configured in both site-publishing GitHub environments and its
secret is installed on the Global API. The team explicitly does not require the
acknowledgement sender to receive replies: null MX is not itself a launch blocker.
The team subsequently selected `hi@rallywith.ai`; the Resend dashboard confirms
`rallywith.ai` is verified. The current owner document supersedes the earlier
configuration snapshot above. No real acknowledgement was sent by the audit.
