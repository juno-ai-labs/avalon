# Password sign-in

Passwords are an optional credential on an existing Global identity. Operators
provision them through engineering MCP for accounts such as external reviewers;
desktop and web expose the same email/password form and use ordinary sessions.
There is no public password registration, password editor, or recovery flow.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/password-login.ts` | The shared email/password request. |
| `packages/db/migrations/0129_password_login.sql` | Credential generations, SHA-256 digests and attempt windows in D1. |
| `apps/api/src/services/password-login-service.ts` | Generation, hashing, verification, attempt admission and deletion. |
| `apps/api/src/services/auth-service.ts` | Ordinary identity sessions, with a credential-generation fence on password issuance. |
| `apps/api/src/routes/auth.ts`, `routes/browser.ts` | Desktop bearer and browser cookie transports. |
| `apps/api/src/engineering-inspection-bridge.ts`, `apps/engineering-mcp/src/server.ts` | Private operator provisioning and revocation with content-free audit. |
| `apps/desktop/src/renderer/components/password-sign-in-form.tsx` | Shared form, used by native onboarding and browser entry. |
| `apps/desktop/src/main/index.ts` | Trusted IPC, fixed Global endpoint, native session persistence and supersession. |

## How it works

The operator resolves an existing **Global** user using `search_users`, then calls
`provision_user_password({ userId })`. The service generates a 256-bit random
base64url password and returns it once with the user's ID and email. D1 keeps
only a SHA-256 digest and a random credential generation. The existing primary
email must already be verified before a password session can be issued.
Repeating the call rotates
the password; it is deliberately marked non-idempotent. If the response is lost,
provision again and use the new result. Concurrent provisions are last-write-wins.
There is no plaintext retrieval operation. Deliver the result privately to its
intended recipient; do not copy it into routine status updates or logs.

`revoke_user_password({ userId })` deletes the credential idempotently. Rotation
and revocation prevent subsequent password sign-ins, including a proof verified
before the mutation whose session has not yet been inserted. Existing sessions
remain ordinary sessions until logout, revocation or expiry. These tools change
credentials, not session lifetimes or Organization membership.

Both sign-in screens offer **Sign in with password**. The server normalizes the
email; the form preserves password bytes, clears the password after each attempt
and returns to other sign-in options on request. Desktop sends the proof through
trusted IPC to the main process, which chooses the configured Global endpoint.
IPC validation carries declared-field diagnostic codes, which the renderer maps
to readable email/password errors without exposing rejected values or raw Zod
JSON. Main stores the resulting credentials using the same encryption and generation
fences as Google sign-in. Browser sends `POST /browser/password`, receives an
HttpOnly cookie and credential-free metadata, and adopts the existing workspace
discovery/return-destination flow. Cookie writers use the same browser lock as
email redemption, renewal and logout. `POST /auth/password` serves desktop.

## Invariants

- Only the Access-authenticated engineering MCP has the provisioning binding.
  An Organization administrator is not an engineering operator. The bridge
  requires the trusted operator and commits an attempt audit before changing a
  credential.
- Provisioning neither creates a user nor verifies their mailbox nor creates
  membership. An operator-selected account cannot silently claim another
  identity.
- A verified password is fenced by its credential generation in the **session
  INSERT**, not a prior read. Rotation during verification cannot revive the old
  credential. The INSERT also requires a verified-address binding for the user’s
  current primary email; a password is not mailbox proof.
- Both transports reserve the same budget atomically before hashing, including
  unknown addresses.
- No password or hash enters operator audit events or routine MCP logs. The
  provisioning result is intentionally secret-bearing.

## Boundary

This module proves control of a provisioned credential. [Security](security.md),
[browser sessions](browser-sessions.md), [regionalization](regionalization.md)
and product authorization retain session, transport and membership authority.
Only Global provisions and verifies passwords. Other deployments reject these
operations; Global continues ordinary cross-region discovery and activation.

## Failure modes and limits

The team selected **10 attempts per account per minute on 2026-11-10**. Each
normalized address has one atomic D1 counter with a one-minute window beginning
at its first admitted attempt. Success also consumes an attempt. The eleventh
returns 429; expiry restores the budget. A scheduled sweep drops
expired counter rows. This bounds guessing one account, not traffic spread over
many addresses; it is not a global or per-IP rate limit. HTTP requests inherit
the existing 4 KiB auth-body limit. Someone who knows an account’s email can
continually exhaust its budget and deny legitimate sign-in. This is the trade-off
of the explicitly selected per-account limit, even with inexpensive hashing.

Unknown accounts, accounts without a password, incorrect passwords and accounts
without a verified primary address receive the same 401. Database errors fail
closed. Passwords are generated 256-bit secrets, hashed with the same SHA-256
primitive as refresh tokens and matched in the credential query. This depends on
operator provisioning generating every secret; allowing human-chosen passwords
would require a slow password KDF and a new credential format.

## Testing

- `apps/api/test/password-login.test.ts`: checked-in migrations, desktop and
  browser sessions, generic refusals, Origin enforcement, shared attempt windows,
  rotation/revocation and session-INSERT generation fencing.
- `apps/api/test-workers/password-login.test.ts`: generated credentials, real D1
  concurrency, operator bridge and independent audit storage.
- `apps/api/test-workers/scope-invitations.test.ts`: an unverified password account
  cannot sign in to claim a pending Canvas share.
- `apps/engineering-mcp/test/server.test.ts`: tool discovery, Global routing,
  trusted operator forwarding and credential-free logging.
- `apps/desktop/src/common/password-login.test.ts`: IPC input diagnostics and
  readable field-error messages.
- Desktop onboarding and browser-entry renderer tests: method switching,
  submission, discovery failures after form unmount, password clearing and browser
  session adoption. The onboarding test runs under its own setup. Real
  native and browser windows are required for visual acceptance.

## Operations

Apply D1 migration 0129 before deploying the API, then deploy engineering MCP
and the clients. No password policy secret or hashing dependency is required.
Audit events use `engineering.provision_user_password` and
`engineering.revoke_user_password`, with `attempt`/`result` suffixes. Since these
are account operations, their audit workspace scope is `identity:global`, and
their target is the selected user. If the result audit fails after mutation,
the attempt remains; provision again to obtain a known new credential.

For review, prepare a dedicated account with a previously verified primary email
and sample Organization, membership,
onboarding and connector test data separately. The credential does not replace
that preparation. Keep the supplied password valid during the review period.

## Changelog

### 2026-11-10 — Operator-provisioned passwords use ordinary identity sessions

**What changed:** Added password sign-in to desktop and web, operator-only
generation/rotation/revocation, and a shared ten-attempt one-minute budget.

**Why:** External reviewers need immediate access without mailbox codes, MFA
approvals or magic links. Reusing identity sessions retains normal Organization
permissions and native/browser credential handling.

**Considered and rejected:** A reviewer-only login bypass duplicates authority;
public password signup and recovery add an account-management surface beyond the
reviewer need. A slow KDF adds synchronous CPU cost without useful brute-force
protection for generated 256-bit secrets, so these use SHA-256 like refresh tokens.

**Consequences:** Operators select an existing Global account and deliver the
one-time result securely. Credential changes do not log out existing sessions.
A verified primary address remains a prerequisite for invitation discovery.
The attempt limit is team-selected; its rationale beyond the selected value was
not recorded. Future password methods must preserve the session-INSERT fence.
