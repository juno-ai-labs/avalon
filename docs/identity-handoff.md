# Identity handoff: signing in to another service with Rally

Another service of ours can sign its users in with their Rally identity instead
of running a Google sign-in of its own. Relay, the Claude Code plugin, is the
first. The person sees Rally's Google consent screen, a Rally account is created
if they have none, and the service learns who they are. It never receives a
Rally session, so it cannot act in Rally as that person.

The handoff is the desktop app's sign-in with one more allowed destination. The
same Google client, `oauth_states` row, single-use `desktop_login_tickets` row
and PKCE proof carry it; only where the finished sign-in is sent and what the
ticket is swapped for differ.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/lib/desktop-handoff.ts` | `isIdentityHandoffReturnUri`: the one check of whether a web address may receive a finished sign-in. `desktopHandoffUrl` sends those addresses straight there rather than through the desktop handoff page. |
| `apps/api/src/services/auth-service.ts` | `allowedReturnUri` admits those addresses at `POST /auth/google/start`; `exchangeIdentityTicket` redeems the ticket; `claimLoginTicket` is the claim and proof check shared with the desktop exchange. |
| `apps/api/src/routes/auth.ts` | `POST /auth/identity/exchange` and its request and response shapes. |
| `apps/api/wrangler.global.jsonc` | `IDENTITY_HANDOFF_RETURN_URIS`, the allowed addresses. |

## How it works

1. The service makes an attempt ID and a PKCE verifier, and calls
   `POST /auth/google/start` on the Global API with `returnUri` set to its own
   callback (its own query string, such as its OAuth `state`, included), the
   attempt ID and the verifier's S256 challenge. It opens the Google URL it gets
   back.
2. Google returns to Rally's own `/auth/google/callback`. Rally creates or
   updates the person's identity exactly as for the desktop app and stores a
   two-minute ticket bound to the attempt and the challenge.
3. Rally redirects the browser to the service's callback, adding `ticket`,
   `attempt` and `region` to the query it was given.
4. The service calls `POST /auth/identity/exchange` with the ticket, region,
   attempt ID and verifier, and gets `userId`, `email`, `name` and
   `signupCreated` back. The ticket is spent.

A declined Google consent returns to the service's callback with `error`.

## Invariants

- **Only an address in `IDENTITY_HANDOFF_RETURN_URIS` receives a finished
  sign-in.** Origin and path must equal an entry and the scheme must be https;
  anything else is refused with `invalid_return_uri` before Google is opened. A
  looser match would send a person's ticket to whoever registered the address.
  Guard: `browser-google-sign-in.test.ts`, "will not send a sign-in to a web
  address that is not an allowed service".
- **A ticket is redeemed once, and only with the starter's proof.** A replay or
  a wrong verifier is `invalid_login_ticket`, and a wrong verifier burns the
  ticket, as RFC 7636 requires. Without this, anyone who saw the callback URL
  could become the person in that service. Guard: the two handoff tests in the
  same file.
- **The exchange returns identity, never a session.** The service gets no Rally
  access or refresh token, so a compromised service cannot read or write Rally
  as its users. Guard: the response schema in `routes/auth.ts`.

## Boundary

This owns admitting a service's callback and swapping its ticket for an
identity. It does not give the person an Organization: a new account has none
until they create or join one ([`new-user-onboarding.md`](new-user-onboarding.md)).
How the service then uses Rally, such as Relay creating or joining an
Organization and posting through the engineering bridge
([`engineering-mcp.md`](engineering-mcp.md)), is that service's concern. Identity is Global
([`regionalization.md`](regionalization.md)), so a service always starts and
exchanges on the Global API.

## Failure modes and limits

- Ticket lifetime is two minutes, shared with the desktop app. An exchange after
  that is `invalid_login_ticket`, and the person starts again from the service.
- With `IDENTITY_HANDOFF_RETURN_URIS` unset, every service callback is refused
  at start, and Rally's own clients are unaffected.
- Signup telemetry counts a handoff sign-in on the desktop platform, because it
  starts through the desktop start route.

## Testing

`pnpm --filter @rally/api exec vitest run test/browser-google-sign-in.test.ts`
runs the handoff against the real migrations, with Google's token endpoint and
signing keys stubbed because Google cannot run here.

## Changelog

### 2026-11-04 — Let Relay sign people in with their Rally identity

Relay had its own Google client limited to `rallywith.ai` accounts, so nobody
outside the company could use it, and opening it up would have meant a second
Google project to verify. The desktop sign-in already did everything needed
(create the account, hand a single-use, PKCE-bound ticket to another program),
so this adds one allow-listed web destination and an exchange that returns
identity only. A new OAuth provider inside Rally was rejected as far more
surface for one internal caller; a full Rally session for Relay was rejected
because Relay needs to know who someone is, not to act as them.
