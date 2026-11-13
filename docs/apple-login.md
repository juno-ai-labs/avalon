# Apple sign-in

**Continue with Apple** sits under **Continue with Google** on the desktop and
browser sign-in screens. It is the same web OAuth flow as Google's, run through
the same `AuthService` code with a `provider` of `apple`: a Global-only
`oauth_states` row, a provider callback, then the desktop's ticket handoff or the
browser's cookie. This document covers what differs for Apple. The browser host's
side is in [browser-client.md](browser-client.md#apple-sign-in), and registration
is in [provider-apps.md](provider-apps.md#sign-in-with-apple) and the
[runbook](runbook.md#provider-configuration).

## Where the code lives

| Path | Role |
| --- | --- |
| `apps/api/src/services/apple-identity.ts` | Apple's authorization URL, the ES256 client secret, the token exchange and ID-token checks, and the name from Apple's `user` field. |
| `apps/api/src/services/auth-service.ts` | `LoginProvider`, and the provider-generic start, claim, exchange and ticket code both providers share. |
| `apps/api/src/services/login-identity-service.ts` | `persistVerifiedProviderIdentity`: find, link or create the person for a provider with no `users` column. |
| `apps/api/src/routes/auth.ts` | Desktop `POST /auth/apple/start` and `POST /auth/apple/callback`. |
| `apps/api/src/routes/browser.ts` | Browser `POST /browser/apple/start` and `POST /browser/apple/callback`, the `SameSite=None` state cookie, and the same-origin exemption for the callback. |
| `apps/browser/src/worker.tsx` | Forwards the `-apple-` state cookie with the deployment's own. |
| `apps/desktop/src/renderer/screens/onboarding.tsx`, `apps/browser/src/entry.tsx` | The two buttons and the browser's `#apple_error` notice. |
| `apps/desktop/src/renderer/lib/sign-in-provider.ts` | One wording for provider sign-in failures on both hosts, and the provider the desktop last signed in with. |
| `packages/db/migrations/0133_desktop_ticket_login_provider.sql` | `desktop_login_tickets.login_provider`. |

## How it works

1. **Start.** The desktop (`/auth/apple/start`, with its attempt ID and PKCE
   challenge) or the browser (`/browser/apple/start`) asks Global for a URL.
   `startIdentity` stores an `oauth_states` row with `provider = 'apple'` and a
   sealed random secret, and returns Apple's authorize URL with
   `response_mode=form_post`, `scope=name email`, the state, and
   `nonce = sha256(secret)`.
2. **Apple returns with a POST.** Asking for `name` or `email` obliges
   `form_post`, so Apple posts `code`, `state` and, on the first authorization
   only, `user` to the callback as a cross-site form. The desktop's callback is
   on the API host; the browser's is on the browser host, which the Worker
   forwards like any `/browser/*` request.
3. **Exchange.** The callback claims the state for its own provider and purpose,
   mints a five-minute ES256 client secret from the deployment's `.p8` key, and
   exchanges the code at Apple's token endpoint. The ID token from that response
   must verify against Apple's keys with Apple as issuer, the Services ID as
   audience, `nonce` equal to the stored secret's hash, and a verified email.
   The copy of the ID token Apple also posts to the callback is ignored.
4. **Persist.** `persistVerifiedProviderIdentity` finds the person by
   `('apple', sub)` in `user_login_identities`. Failing that, it links to whoever
   holds the email verified in `user_verified_emails`; failing that, it creates
   a user with that email, named from Apple's `user` field when present.
5. **Finish.** The rest is Google's path: the desktop gets a two-minute ticket
   through the handoff page (the ticket now records its `login_provider`), and
   the browser gets its session cookie. Both callbacks answer 303, so the
   browser follows with a GET.

Signup telemetry carries `method: "apple"` at every stage, including the
desktop's ticket exchange, which reads the provider from the ticket.

## Invariants

- **The nonce stands in for PKCE.** Apple documents no PKCE for web clients. The
  sealed secret's hash goes out as `nonce` and must come back in the verified ID
  token; without that check, a code obtained for another sign-in could be
  redeemed against this state.
- **States do not cross providers or purposes.** `claimOAuthState` matches
  `provider` and `purpose`, so a Google state at Apple's callback, or a desktop
  state at the browser's, is refused without being consumed and the sign-in it
  belongs to can still finish.
- **The browser binds the state to itself.** The callback compares the
  `-apple-<state>` cookie with the posted state before touching the row, as
  Google's does. That cookie is `SameSite=None` because a `Lax` cookie does not
  ride a cross-site POST; it carries only the state, so being sent cross-site
  gives it nothing to do but match.
- **Only the Apple callback crosses the same-origin guard.** Every other non-GET
  browser route still requires the browser origin. `PROVIDER_POST_CALLBACKS`
  names the exemption; adding to it is adding a cross-site entry point.
- **Apple's `user` field names a new account and finds none.** Nothing signs it,
  so it is used for the name of a user being created and nothing else.
- **A returning Apple sign-in does not rewrite the account's email.** Google's
  does, because Google's address is the account's primary. An account may hold
  both, and two providers rewriting one primary address would fight; Apple's
  relay address is stable for the life of the link. If a person changes their
  Apple address, the account keeps the one it had.
- **An address held unverified links to nothing.** A user row with the email
  but no `user_verified_emails` entry refuses Apple sign-in with
  `apple_email_in_use`, as Google's sign-in refuses with `google_email_in_use`,
  rather than being taken over.
- **The desktop reconnects through the provider it signed in with.** When the
  account identity has to be restored (an account switch, an organization
  creation, a link into another organization), the desktop opens the provider
  it last started a sign-in with, kept in local storage. Nothing on the server
  records it: the ticket exchange does not name the provider, so an abandoned
  Apple start still counts, and a device with no record opens Google.

## Boundary

This module owns Apple's half of provider sign-in: its URLs, credentials,
token checks and the persistence rule for providers without a `users` column.
It does not own sessions, tickets, the handoff page, regional onboarding or the
Organization picker; those are the same for every provider. Global's regional
bridge already links people by any provider in `user_login_identities`
([multiple-workspaces.md](multiple-workspaces.md)), so Apple accounts reach other
deployments with no change there.

## Failure modes and limits

- **Unconfigured.** Until `APPLE_OAUTH_CLIENT_ID`, `APPLE_OAUTH_TEAM_ID`,
  `APPLE_OAUTH_KEY_ID` and `APPLE_OAUTH_PRIVATE_KEY` are all set on Global, both
  starts answer 503 `apple_oauth_not_configured` and `/health` reports
  `appleLoginOAuth: not configured`. They are deliberately not in the required
  environment contract: a missing Apple key must not take Google, email and
  password sign-in down with it. The button shows regardless.
- **Bad key.** A private key that will not import answers 503
  `apple_oauth_key_invalid` at the exchange.
- **Apple refuses the exchange.** `apple_token_exchange_failed`; the log's cause
  is Apple's own OAuth error, such as `invalid_grant` or `invalid_client`.
- **ID token.** `apple_id_token_invalid` (signature, issuer, audience, expiry,
  with JOSE's code as cause), `apple_nonce_mismatch`, `apple_identity_invalid`
  (no subject, no email, or an unverified email).
- **Declined.** Apple posts `error=user_cancelled_authorize`, and both hosts
  show "Apple sign-in was cancelled."
- **Local development.** Apple accepts only HTTPS return URLs on verified
  domains, so the flow cannot be completed against a local stack. Tests stand in
  for Apple's token endpoint and keys.
- **Mail to relay addresses** bounces unless the sending domains are registered
  with Apple; see the [runbook](runbook.md#provider-configuration).

## Testing

`apps/api/test/apple-sign-in.test.ts` runs both callbacks against the real
migrations with Apple's token endpoint and keys replaced by a local issuer: the
desktop flow through ticket exchange and its telemetry method, the client
secret's claims, nonce refusal, the browser's cross-site POST and cookie,
forged state, provider separation, cancellation, linking to an existing
verified address, and the unconfigured answer.
`apps/api/test/login-identity-service.test.ts` covers the unverified holder, the
returning sign-in with a changed address, Apple-first then Google linking, and
Apple staying connected after the Google address changes. The screens are covered in
`onboarding.test.tsx` and `browser-entry.test.tsx`.

```bash
pnpm --filter @rally/api exec vitest run test/apple-sign-in.test.ts test/login-identity-service.test.ts
```

## Open questions

- **Account deletion and token revocation.** App Store review requires an app
  that offers Sign in with Apple to let people delete their account and to
  revoke Apple's tokens when they do. Rally keeps no Apple refresh token today,
  so there is nothing to revoke yet; this matters if the desktop app ships
  through the Mac App Store.
- **Native sign-in.** The desktop opens Apple's web page in the system browser,
  as it does for Google. A native `AuthenticationServices` sheet would be
  smoother on macOS but needs its own entitlement and a second token audience.

## Changelog

### 2026-11-12 — Sign in with Apple, next to Google

**What changed:** Desktop and browser sign-in offer **Continue with Apple**. The
Google-only identity code in `AuthService` now takes a provider, and Apple's
specifics live in `apple-identity.ts`. Apple identities persist through a new
`persistVerifiedProviderIdentity` in `user_login_identities` rather than a
`users` column. Migration 0133 records the provider on desktop tickets.

**Why:** Product asked for Apple next to Google; migration 0120 had already
made the identity table take any provider for this.

**Considered and rejected:** A separate Apple code path beside Google's. The two
differ only in URLs, credentials and token checks, and a copy would have let
the state binding, ticket and cookie rules drift apart. Requiring the Apple keys
in the production environment contract: it would 503 every Global route until
they were set. Showing the button only when configured: it would cost a
round trip before the sign-in screen could draw.

Review moved the desktop's account reconnect off a hard-coded Google, which
would have sent an Apple-only person, often with a relay address no Google
account has, into another account or a dead end.

**Consequences:** A third provider is a new `LoginProvider` member, its
credentials, its URL and token checks, a route pair, and a case in
`sign-in-provider.ts`. The browser's
same-origin guard now has a named exemption. Telemetry's signup `method` gains
`apple`.
