# Email sign-in

Email sign-in proves control of an address and creates an ordinary identity-only
session. The [browser cookie transport](browser-sessions.md) now adapts that
session for the browser sign-in page. The routes
require explicit policy and browser-origin configuration before they are usable.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/email-login-service.ts` | Challenge issuance, proof consumption, encrypted delivery intent and retry. |
| `apps/api/src/services/login-identity-service.ts` | Verified email to immutable user identity. |
| `apps/api/src/services/auth-service.ts` | Resumption of the one session recorded by a consumed challenge. |
| `apps/api/src/routes/auth.ts` | POST start/redeem endpoints and scanner-safe GET rejection. |
| `apps/api/src/worker-events.ts` | Scheduled delivery recovery and expired-proof cleanup. |
| `packages/db/migrations/0111_email_login_challenges.sql` | Challenge, delivery and redemption receipt storage. |

## How it works

POST `/auth/email/start` takes a caller-generated challenge ID and email. Retrying
that ID preserves the original challenge and encrypted email body; reusing it for
another address fails. One challenge has both an OTP and a random magic-link
secret. The link carries its secret in a fragment. Loading a link does not consume
it; POST `/auth/email/redeem` takes the proof and a caller-generated redemption ID.

A start may carry `returnPath`, the `/app/` path the browser was on. The link
then opens that path instead of `/login/email`, with the same fragment, so a
person who signs in from a shared Canvas or Sidekick link
lands back on it after signing in. `browserReturnUrl` keeps the path on the
browser origin and drops any query or fragment; any other path falls back to
`/login/email`. The browser client reads the proof on either path and takes the
challenge's region from the fragment, not from the resource the path names.
Code sign-in and Google sign-in already returned to the page they started on.

The winning conditional SQL update records the verified user, one session ID and
an encrypted refresh credential. The session is inserted idempotently afterwards.
A crash between those operations resumes the recorded session. Repeating the same
proof and redemption ID can recover the response, while another redemption ID
cannot consume the challenge again. Expiry of the resumed session is anchored to
the original redemption. Rotation or revocation makes the old receipt unusable.

Email delivery uses the frozen encrypted body and a stable provider idempotency
key. Provider acceptance marks delivery complete; a lost response leaves it
pending for retry. Scheduled recovery continues past individual delivery failures.
Development delivery is skipped by the existing shared email sender.

Authenticated GET `/auth/workspaces` lists active relationships in the current
deployment. POST `/auth/workspace/select` validates the selected relationship and
issues a workspace session. These routes use immutable user identity without a
Google subject. A Google-verified primary mailbox links to an existing verified email identity, preserving
its user ID, platform ID, sessions and grants. An unverified profile email is never
linking evidence. Guest sessions carry `accessClass: "guest"` and a null role;
legacy member sessions can omit `accessClass`. Promotion keeps the user and
session incarnation, and refresh returns the current member role. General
member-only discovery and setup routes remain unavailable to guests; shared
conversation mutations use the existing exact-scope authority.
Registering the browser session claims any [scoped invitation](scope-invitations.md#claiming)
waiting for the verified address; the share and its grant receipts live in the
Canvas's parent in WorkspaceDO, independently of email sign-in challenge consumption.

Local setup copies `EMAIL_LOGIN_POLICY_JSON` and `BROWSER_APP_ORIGIN` from
`.env.local` to the configured deployment's Worker variables through
`scripts/sync-dev-env.mjs`, including deployment-specific overrides. Both are
listed in `.env.example` without defaults: an absent policy or origin leaves
email sign-in disabled. Production values must be chosen explicitly.

## Signup measurement

Signup uses the opaque first-account flow and stage contract in [complete signup measurement](telemetry.md#complete-signup-measurement).

## Invariants

- Magic links and OTPs consume the same row atomically; separate consumption
  would allow two sessions from one sign-in request.
- A retry resumes the recorded credentials; generating fresh credentials would
  turn response loss into extra sessions or extend the session lifetime.
- Verification grants identity only. Creating membership here would turn proof
  of an address into unauthorized workspace admission.
- Challenge hashes use a server-keyed digest, preventing a database-only attacker
  from enumerating a short OTP. Recoverable delivery and session secrets remain
  encrypted and are never logged.
- Sender and message content are frozen at issuance so provider retries do not
  change their body under the same idempotency key.

## Boundary

This subsystem owns email proof and its resumable session receipt. Existing
[security](security.md) rules own bearer sessions, refresh and workspace admission;
[authorization](authorization.md) owns product access. Claiming scoped shares,
workspace guest grants and client UI belong to their own modules. The original
API returns the ordinary session contract; [browser sessions](browser-sessions.md)
adapt the same proof to an HttpOnly cookie and return metadata without tokens.

## Failure modes and limits

`EMAIL_LOGIN_POLICY_JSON` specifies `otpDigits`, `ttlSeconds` and nullable
`maxFailedAttempts`. There are no production defaults. `BROWSER_APP_ORIGIN`, a
transactional sender and signing/encryption keys are also required. Invalid
configuration returns 503. Origin must be an exact HTTPS origin, except in
development. Issuance freezes expiry and attempts policy on the challenge.
Invalid, expired, exhausted or already consumed proofs return a generic 401.
GET redemption returns 405. The routes reuse the existing auth body-size limit.

Delivery errors leave the durable intent pending until expiry or redemption. A
successful provider response can still be lost; the shared provider's idempotency
semantics determine deduplication. Scheduled cleanup deletes expired unredeemed
proofs and receipts whose sessions have expired or been revoked. A consumed receipt
without a session is retained through the existing initial session lifetime so
crash recovery remains possible. Live receipts remain encrypted for response-loss
retries; clearing them immediately after minting would break that contract.
Production explicitly uses six-digit codes, ten-minute expiry and five failed
redemption attempts. On 2026-09-18 the team chose to launch without issuance
limits: callers can request unlimited fresh challenges and emails. The redemption
attempt limit does not bound email volume or aggregate guesses across challenges.
This is an accepted launch trade-off, not a pending enablement prerequisite.

## Testing

`pnpm --filter @rally/api exec vitest run test/email-login-service.test.ts`
uses real migrated SQLite through the D1 adapter and a mocked email provider.
It covers issuance replay, competing proof types, crash recovery, expiry and
attempts, rotation/revocation, scanner GETs, POST routing and delivery retries.
Removing the SQL consumption fence makes the competing-proof test accept both
requests; restoring it returns to one winner. D1 deployment validation and real
browser sign-in acceptance remain outstanding.

## Regional impact

Challenges and sessions use the endpoint's existing D1 binding and deployment
identifier. Global is the currently configured identity deployment; email sign-in
does not introduce cross-deployment membership or route grants.

## Changelog

### 2026-10-07 — The emailed sign-in link returns to the shared link

**What changed:** `POST /auth/email/start` takes an optional `returnPath`, and
the magic link opens that `/app/` path with its proof in the fragment instead
of `/login/email`.

**Why:** Copied links now open in the web app. A signed-out reader who chose
the email link from a shared Channel landed on the plain sign-in page and then
the Organization root, losing the Channel; the code and Google paths kept it.

**Considered and rejected:** Storing the destination in the browser that
started sign-in: the link is often opened on another device or in a mail
client's browser, where that storage is absent. A `next` field in the fragment
beside the proof: the path itself already carries the destination, and every
link reader parses it.

**Consequences:** `EmailLoginStartSchema` is strict,
so an API older than this change rejects a start that carries `returnPath`.
Deploy the API before the browser client.

Shipped in juno-ai-labs/avalon#1144.

### 2026-09-18 — Production email sign-in policy

**What changed:** Configure six-digit codes, ten-minute expiry and five failed
attempts; launch without issuance limits, explicitly selected by the team.
**Why:** Enable guests to redeem shared conversations through the browser.
**Considered and rejected:** Per-address and per-IP issuance limits were offered
during launch review; the team chose to launch without them.
**Consequences:** Outbound email volume and aggregate attempts across fresh
challenges remain unbounded by Rally. Do not describe issuance limiting as a
fulfilled or pending launch gate. PR: [#843](https://github.com/juno-ai-labs/avalon/pull/843).


### 2026-09-16 — Persist proof consumption and resumable session identity

**What changed:** Email links and OTPs share one challenge and one session receipt,
with encrypted delivery retries and POST-only redemption. Scheduled cleanup uses
existing proof/session expiry, preserving live response-loss receipts rather than
deleting the only recoverable credential as soon as a session is minted.

**Why:** Guests need quick entry without duplicate user identities. A response lost
between verification and session creation must not consume access irrecoverably or
create multiple sessions.

**Considered and rejected:** Independent link/code challenges and fresh sessions
on each retry permit multiple successful redemptions of one sign-in request.

**Consequences:** Clients must retain their challenge and redemption IDs across
retries. Configuration and remaining browser/invitation work must be completed
before this foundation is enabled for users.
