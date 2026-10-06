# API tokens

An API token is a long-lived credential an operator mints for one user. A client
trades it at `POST /auth/token/exchange` for the same identity-only session an
email or Google sign-in produces. It exists so automation can sign in to a hosted
deployment, for example a nightly end-to-end run against production, where
development sign-in is off and neither Google nor an emailed code can be
completed by a script. The desktop app accepts one at launch through
`RALLY_API_TOKEN`.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0119_api_tokens.sql` | The `api_tokens` table: user, SHA-256 of the token, label, optional expiry, revocation, last use. |
| `packages/contracts/src/index.ts` | `ApiTokenSchema` (the token's format) and `ApiTokenExchangeRequestSchema`. |
| `apps/api/src/services/auth-service.ts` | `exchangeApiToken`: checks the token and mints the session. |
| `apps/api/src/routes/auth.ts` | `POST /auth/token/exchange`. |
| `scripts/api-token.mjs` | The only way to mint, list or revoke a token: an operator command run through Wrangler. |
| `apps/desktop/src/main/launch-api-token.ts` | Takes `RALLY_API_TOKEN` out of the environment and checks its format. |
| `apps/desktop/src/main/index.ts` | `signInWithLaunchApiToken`: exchanges the token at startup and stores the session. |

## How it works

### Minting

```bash
node scripts/api-token.mjs mint --email bot@example.com --label nightly-e2e --remote
node scripts/api-token.mjs list --remote
node scripts/api-token.mjs revoke --id <token id> [--sign-out-everywhere] --remote
```

Without `--remote` the script acts on the local database under
`apps/api/.wrangler/state/`. `--region` picks a deployment and defaults to
Global, the identity deployment.

The user must already exist: they sign in once by any ordinary means first.
The script generates `rally_at_` followed by 32 random bytes in base64url,
prints it once to stdout, and stores only its SHA-256. `--expires-at` takes an
ISO 8601 time; without it the token does not expire. `list` shows each token's
label, owner, expiry, revocation and last use, never the token.

### Exchanging

`POST /auth/token/exchange` with `{ "token": "rally_at_…" }` runs one
conditional `UPDATE … RETURNING`. It matches the hash, requires the token to be
unrevoked and unexpired, and stamps `last_used_at`. A match mints an ordinary
identity-only session (`workspace: null`) for the token's user, with an access
token and a rotating refresh token. Anything else gets 401 `invalid_api_token`.
From here the session is like any other: the client discovers and activates a
workspace through the platform, refreshes through `/auth/refresh`, and the
30-day renewal window and 90-day ceiling apply.

### Desktop launch

Main reads `RALLY_API_TOKEN` at module load and deletes it from `process.env`
before anything can start a child process. After Lockdown mode settles the
session encryption, and before the stored credential is first read, main
exchanges the token against the configured Global API. It clears whatever
account the device held and stores the new session the way Google sign-in does
(`persistSessionUnlocked`). The first window then opens on organization
discovery and activation, exactly as after a browser sign-in. This works in
packaged builds too; that is the point, since production can only be tested
from one.

```bash
RALLY_API_TOKEN="$(cat token.txt)" XDG_CONFIG_HOME=/tmp/rally-e2e \
  xvfb-run -a pnpm exec dotenv -e .env.local -- \
  pnpm --filter @rally/desktop exec electron-vite dev --noSandbox --remoteDebuggingPort=9222
```

## Invariants

- **Only the hash is stored.** A database reader learns nothing that signs in.
  Guard: `scripts/api-token.test.mjs` pins the token-to-hash pair, and
  `apps/api/test/api-token-exchange.test.ts` exchanges the same literal pair.
  If the script's hash and the API's `sha256` ever disagree, both tests fail.
- **A token proves identity and nothing more.** The exchange never returns a
  workspace session, so membership stays the platform's decision. A token that
  minted workspace sessions would outlive the membership it was minted under.
  Guard: the exchange test asserts `workspace` is null.
- **Check and use are one statement.** A revoked or expired token never mints a
  session, even when racing a revocation. Guard: the revoked-token test fails
  if the `revoked_at` predicate is dropped (proved by removing it).
- **No HTTP route creates a token.** Minting needs the Cloudflare credentials
  that already live only in the operator's local environment. Adding a minting
  route is a new way into production and needs its own security review.
- **The desktop never passes the token on.** It is removed from the environment
  whether or not it parses, and the error for a malformed one never repeats
  it. Guard: `launch-api-token.test.ts`.

## Boundary

This module owns minting, revocation and the exchange. Sessions, refresh,
renewal and logout belong to the ordinary auth service
([`security.md`](security.md#authentication-and-authorization)), and workspace
admission to the platform onboarding routes. The browser app does not accept a
token; its sign-in stays email and Google
([`browser-client.md`](browser-client.md)). There is no settings screen or
self-serve token.

## Failure modes and limits

- **Unknown, revoked or expired token:** 401 `invalid_api_token`. The desktop
  logs `could not sign in with the launch API token` with that code and opens
  signed out.
- **Malformed `RALLY_API_TOKEN`:** the desktop logs
  `launch_api_token_malformed` and opens with whatever account it already had.
- **Revocation does not end sessions already minted.** By default `revoke` only
  stops new exchanges. `--sign-out-everywhere` also revokes every session the
  token's user holds, which cuts HTTP at the next request. A socket that is
  already open stays open until it closes, because only the API can publish a
  socket revocation ([`access-revocation.md`](access-revocation.md)). Bot
  accounts should be dedicated so that signing them out costs nothing.
- **Token lifetime is open.** No expiry is applied unless the operator passes
  `--expires-at`. Whether tokens should have a maximum lifetime, and what it
  is, is the team's number to set
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).
  `expires_at` is the mechanism.
- **No rate limit on the exchange.** A token holds 256 random bits, so guessing
  is not a concern.
- **A second desktop instance** launched with a token hands its window to the
  running one and exits; the token is not used. Give each run its own
  `XDG_CONFIG_HOME` or user-data directory.

## Testing

- `node --test scripts/api-token.test.mjs`: token format and hash, and the
  mint and revoke SQL run against every checked-in migration.
- `pnpm --filter @rally/api exec vitest run test/api-token-exchange.test.ts`:
  the route over real migrated SQLite, including revoked, expired and unknown
  tokens.
- `pnpm --filter @rally/desktop exec vitest run src/main/launch-api-token.test.ts`.
- The desktop exchange itself has no automated test. It was verified by
  minting a local token, launching Electron under Xvfb with `RALLY_API_TOKEN`
  and a fresh `XDG_CONFIG_HOME`, and confirming the window opened signed in as
  that user.

## Security and trust model

A token is a bearer credential with no second factor, and it is as strong as the
account it signs into. Mint tokens for dedicated automation users in a dedicated
Organization, keep them in a CI secret store, label each by purpose, and revoke
with `--sign-out-everywhere` on any suspicion of a leak. The `rally_at_` prefix
exists so secret scanners and log readers can recognise one.

## Changelog

### 2026-10-06 — Operator-minted API tokens for automated sign-in

**What changed:** Added the `api_tokens` table, `POST /auth/token/exchange`, the
`scripts/api-token.mjs` operator command, and `RALLY_API_TOKEN` in the desktop
app.

**Why:** Nightly end-to-end runs need to sign in to production through the
Electron app. Development sign-in is off there, Google blocks scripted logins,
and the desktop has no email sign-in. A stored refresh token was rejected
because each refresh rotates it and the 90-day ceiling forces a manual sign-in.

**Considered and rejected:** A self-serve token screen or an HTTP minting route
(a new way into production for every account, when only automation needs this
today). Tokens that mint workspace sessions directly (they would skip platform
admission, and a desktop holding only a workspace credential signs itself out
the first time it needs identity). Tracking which sessions a token minted so
revocation could end only those (it needs a column on `sessions` and every
workspace-selection path to carry it; signing a dedicated bot out everywhere
does the same job).

**Consequences:** Anyone with production Cloudflare credentials can mint a
token for any existing user. That is no more than those credentials already
allow, but it should stay true: do not add a minting route without a security
review. A maximum token lifetime is still open for the team to set.
