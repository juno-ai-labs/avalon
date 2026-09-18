# Lite browser client

The browser client provides email entry for shared collaboration without setup
or onboarding. Email entry, invitation acceptance and canonical conversation links
activate the workspace and mount the shared conversation screen. Local API and
Chrome journeys cover guest entry, feed, upload/reload, multiple workstreams,
promotion and membership removal. Production mail delivery and deployed stateful
artifact serving remain release checks; see the guest-sharing completion audit.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/browser/src/worker.tsx` | Static entry, asset delivery and regional service forwarding. |
| `apps/browser/src/entry.tsx` | Email/OTP and explicit magic-link redemption, invitation acceptance, session restore and workspace list. |
| `apps/browser/src/invitation.ts` | Validated invitation fragments and exact canonical scope destinations. |
| `apps/browser/src/transport.ts` | Same-origin entry requests and runtime response validation. |
| `apps/browser/src/conversation.tsx` | Browser router and providers for the shared feed; no desktop background socket pool. |
| `apps/browser/src/session.ts`, `packages/contracts/src/client-session.ts` | Credential-free collaboration session metadata and its cookie adapter. |
| `apps/desktop/src/renderer/lib/api.ts` | Existing product API client, shared by native bearer and browser cookie sessions. |
| `apps/desktop/src/renderer/lib/collaboration-session.tsx` | Collaboration-only identity/API context and optional setup capabilities. |
| `packages/contracts/src/browser-session.ts` | Shared credential-free session and email exchange schemas. |
| `apps/browser/wrangler.jsonc` | Assets and the explicit Global API service binding. |
| `apps/browser/test/host.test.ts` | Real workerd host and service-binding transport tests. |

The browser shell lives in the browser package and declares its own UI dependencies.
Both hosts reuse application recovery and query defaults. Initial session restoration
shows a loading state before offering sign-in.

## How it works

Conversation archive state is part of the existing shared-directory response.
The selected feed opens immediately while navigation loads; it has no separate
lifecycle preflight. Archive and restore refresh that same directory query.

Vite builds the client and content-addressed assets. The Worker reads the built
HTML through the assets binding unchanged; React mounts the collaboration SPA in
the browser. Initial HTML contains no user or scope data. Rendering a generic
sign-in form on every server request added a second rendering path without
providing authenticated content, so the lite client uses a static shell. The content policy allows same-origin
requests and local image/media blobs so authenticated attachment bytes can render;
this does not allow blob scripts or frames. Styles permit inline CSS because
shared dialogs inject scroll-lock rules and components use dynamic styles, as
in the desktop renderer. Scripts remain restricted to same-origin bundles.
The sign-in form becomes usable after the client has checked its cookie session.

`/regional/global/browser/*` forwards to the configured Global API service,
preserving request method, body, Origin and cookies and returning Set-Cookie.
The path chooses a configured deployment, never a caller-supplied upstream host.
`/regional/global/socket/*` forwards WebSocket upgrades through the same service
binding. It requires the browser's exact Origin, removes Cookie and Authorization,
and preserves the single-use ticket subprotocol. The API performs ticket
verification and source-object admission; the web Worker returns its upgrade
response directly and never accepts a socket or handles a frame.
The [regional browser adapter](browser-sessions.md) owns authentication and
Origin validation; the host has no signing key or identity database.

The site’s workspace-invitation `/invite` link and this host’s scoped `/invite` link
are separate entry points with different proof formats. Scoped invitation email
links use `BROWSER_APP_ORIGIN`; workspace invitations retain the existing site flow.

An email request carries a client operation ID. A failed issuance can retry that
ID; choosing another email or requesting another code starts a new operation.
OTP redemption uses a stable redemption ID. A magic-link fragment carries the
region, challenge and proof. The client removes it from browser history and keeps
the proof in document memory until the person clicks Continue. Merely opening a
link never redeems it. Reloading after removing the fragment requires reopening
the email link or requesting another one; no proof is written to local storage.

An invitation fragment is validated and removed from history, with the secret
kept only in document memory. The entry tells the recipient to use the invited
mailbox. If a magic link signs in a different tab, focusing the invitation tab
restores the new cookie session without losing its invitation. Explicit acceptance
posts to the identity-only sharing endpoint; server authority still checks the
verified recipient, invitation and current sharer. Failure retains the invitation
for retry or switching accounts. Success activates the addressed workspace and
opens the exact canonical destination immediately for a single accepted scope;
invitations with several scopes show their destination links. A child-only destination
points directly to that child, not through Main. No GET or focus event accepts.

For an unaddressed entry, the client lists the user's regional workspaces and can sign
out through the ordinary browser-session logout. Workspace roots mount the
shared-conversation directory and canonical workstream and child links
activate the addressed workspace and mount the shared feed. No setup or onboarding
view is part of this client.

Returning focus refreshes both the root session and the selected workspace
relationship, even when the user ID is unchanged. The feed stays mounted while
this check runs, preserving unsent drafts. A denied workspace selection unmounts
collaboration; a transient request failure leaves the current view with an error.
This is focus-time revalidation, not immediate cross-tab logout delivery or a
replacement for server-side authorization on every operation.

Successful email redemption and sign-out publish a regional `session-changed`
invalidation over a same-origin BroadcastChannel. Other open tabs restore their
session and selected workspace from the server even when they remain in the
background. The channel carries no identity, credentials, or invitation data;
it cannot grant access. Browsers without BroadcastChannel still revalidate on
focus. External revocation continues to rely on server authorization and socket
revocation, not a channel message from another browser.

Visible tabs renew halfway through the remaining server-issued session lifetime.
Focus, becoming visible, and reconnecting reconcile the session and renew only when the scheduled renewal is due. Overlapping restores share one in-flight operation. The server retains
the ordinary inactivity window and absolute ceiling; the client adds no lifetime
policy. An unchanged expiry does not rearm the renewal timer, avoiding a loop at
the absolute ceiling. At the reported expiry the client re-reads the session,
allowing the server to account for another tab's renewal and device clock skew.
Failed network requests remain visible and can recover on focus or reconnect;
401 responses clear the session. Late responses are fenced by the same read
generation used for sign-out and cross-tab restoration. Long session deadlines
are split into timer-range-safe waits by `session-timer.ts`.

The shared navigation uses the same navigation frame, workstream rows, contextual
sidebar, header, resource rows, Sidekick controls and account trigger as desktop,
from `@rally/ui`. Only authorized directory entries are supplied. Child-only shares
omit Main and its title. Workspace identity uses the existing account/badge treatment;
no workspace icon/color settings are introduced. The browser does not install desktop
background subscriptions. See [shared UI](shared-ui.md).

### Shared collaboration transport

`ClientSession` holds identity/workspace presentation without credentials.
Desktop sessions extend it with their native bearer token; cookie sessions mark
`authentication: "cookie"`. The browser metadata adapter constructs the exact
workspace-addressed API prefix. The existing `RallyApi` accepts either mode,
retaining wire validation, request IDs, uploads and mutation behavior. Cookie
requests use same-origin credentials and never native bearer renewal. Browser
socket ticket results retain their handshake protocols while their destination
is mapped to the same-origin regional upgrade path; ticket secrets stay out of
URLs. A completed sign-out or session replacement fences a pending native renewal
so it cannot restore an old bearer.

The shared conversation surface, workstream/automation views, Sidekick picker
and favicon adapter consume `CollaborationSessionProvider`, not the desktop
account/setup context. The desktop session provider installs this smaller
provider around its children, retaining the same API and identity objects.
Connector authorization cards require an explicit connector-setup capability,
which supplies pending OAuth state and external navigation. Omitting it hides
setup cards and avoids their catalog request; existing connector chips and tool
execution are separate from setup. Sidekick creation likewise requires an explicit
creation callback; without it the picker retains attachment of existing Sidekicks
and omits the native creation action. The lite browser omits both setup capabilities.

Addressed conversation links select their workspace directly without waiting for the workspace list.
The browser mounts the shared surface with query, collaboration, tooltip and
speech providers. A router basename preserves workspace-addressed links. The
standalone feed hook opens only the selected conversation; workspace presence is
optional and no workspace-wide subscription is fabricated. Persistent local
transcript caching remains disabled without a cache-scope provider.

The client and Worker have separate TypeScript configurations: browser components
use DOM types and the existing shared-renderer optional-property convention; the
Worker keeps strict optional properties and Cloudflare runtime types. This avoids
Worker globals changing the meaning of DOM methods in shared components.

Guest screens derive their people and connection lists from the authorized
conversation detail. They do not fetch or reuse cached workspace-wide inventories.
Selected participant mentions resolve without workspace-directory discovery;
server-side scope checks still authorize the resulting command.

A browser fixture has exercised feed snapshot admission, composer submission and
its private socket receipt, responsive layout and sign-out through the production
client. API and socket authority in that visual check are fixtures; the API
runtime suites cover guest mutation and lifecycle authority. The collaboration
context deliberately does not expose workspace
creation, account onboarding or desktop credential controls.

The shared contextual sidebar lists Sidekicks available in the selected conversation,
including workstream recommendations and locally loaded instructions. Its removal
local action removes only the local attachment and leaves the workstream
recommendation available. A separately labeled parent action removes the shared
recommendation; an eligible loaded workspace Sidekick can also be recommended.
These actions use the canonical conversation-addressed recommendation options,
not Main's participant list. Owned Sidekicks are excluded from explicit
recommendation management. Recommendations use the exact substream endpoint and query key, so
navigating between children does not reuse another child's source visibility.
Sidekick authoring and setup are outside this lite surface. Guests use the scoped
recommendation summaries for eligible owned Sidekicks as well; they do not fetch
the member-only owned Sidekick authoring directory.

The conversation header opens the shared email invitation panel. It sends through
the scoped invitation API, retains operation identity on retry and supports
revoking pending invitations. Direct accepted shares are listed by selected scope
and removed using their current grant revisions; other overlapping grants remain
intact. Profile labels come from the scope-authorized management endpoint. Independent scope checkboxes and a complete-workstream option use owner-provided
sharing choices. Complete sharing includes explicit restricted children and asks
the server to verify that coverage at creation. Future restricted children remain
excluded as described in the interface. No setup or onboarding capability is
required.

The lite header also opens the selected conversation's participant controls and
lists its attached resources. Resource selection uses the shared preview/lightbox
and authenticated byte endpoint. The header's resource opener is bound to the
selected conversation; the desktop parent sidebar retains a separately bound
parent-resource opener. A child-only browser view therefore does not require
Main's participant list or resource inventory to expose these controls.

### Shared site resources

The shared conversation surface uses the platform adapter for site actions in
Chrome as well as Electron. Chrome opens the freshly authorized artifact URL in
a separate tab; it does not need an Electron preview or an embedded iframe.
Artifact open, error, and data routes accept the guest workspace relationship
and use the existing canonical resource authorization in `ArtifactOpenService`.
Public artifact content retains its existing anonymous serving rules; the guest
grant controls Rally resource access and attributed viewer sessions.


### Browser host lifecycle and content boundaries

Chrome cookie-changing requests (renewal, email redemption and logout) use one
regional Web Lock across same-origin tabs. This orders actual `Set-Cookie`
responses; React generation checks alone cannot order browser cookie writes.
Ordinary product requests and sockets never enter that lock. A renewal requested
while restoration is in flight is replayed afterward. Workspace lists and
invitation completions retain the session generation fence.

Login replacement, logout and observed account changes reuse the existing draft
cache wipe, including attachment bytes and its pending-write epoch fence. Focus
refreshes for the same account preserve drafts and the live feed. Pending magic
proofs stay visible until explicitly redeemed, even if focus discovers an older
cookie session. Legacy unaddressed links restore the root workspace picker.

The entry scrolls independently of the shared application's fixed viewport.
Collaboration code loads after authentication through one explicit lazy boundary;
this is the browser-only exception to static imports. The browser declares its
desktop dependency because it consumes the existing collaboration implementation;
`@rally/ui` remains presentation-only. Cross-host renderer tests stay in the
existing desktop jsdom harness rather than creating another test runner.

Forwarded HTTP responses retain their streaming bodies but add document sandbox
CSP and `nosniff`: an uploaded HTML or SVG navigated on the cookie origin must
never execute as the application. Socket upgrades remain untouched. The shell
allows HTTPS remote images for existing avatars and Markdown images. Socket
routing still relies on the existing ticket and source-object admission; there
is no separate browser permission model or arbitrary forwarding destination.

The mobile navigation uses the existing Radix dialog primitive for focus trapping,
Escape and outside dismissal, including landing and archived states. Archive and
guest promotion use the shared confirmation modal. Sharing selections are derived
from current canonical options; losing complete coverage re-enables individual
choices. Denied invitation and grant lists show a visible refreshable error.

## Invariants

- HTML is private and no-store; shared cached HTML must never acquire user data.
- Email proofs are never in server query strings, bootstrap JSON or persistent
  JavaScript storage. Server GET requests do not consume them.
- The browser receives metadata only. Cookies remain HttpOnly; API bearer and
  refresh tokens are not exposed through the client transport.
- Regional HTTP forwarding is restricted to the browser adapter; socket
  forwarding only accepts same-origin upgrades to the existing ticketed routes. It cannot reach
  arbitrary URLs, internal API routes or ordinary authentication endpoints.
- Workspace membership is still checked by the regional API; a workspace list
  item or URL does not grant access to any conversation.

## Boundary

The Worker owns the web entry and transport, not product authority or sockets.
The collaboration host reuses the existing conversation surface and its direct
subscriptions. The host is separate from
the public marketing site. Its production hostname is not configured or deployed
by this change; API `BROWSER_APP_ORIGIN` must match its eventual exact origin.

For local work, start the API according to [dev-environment.md](dev-environment.md)
and run `pnpm dev:browser` on port 8794. Client assets rebuild on source edits. The Global service binding discovers the local
`avalon-api-global` Worker. Configure the API's browser origin and explicit email
policy before testing real authentication. Development does not send emails.

## Failure modes and limits

Missing built HTML returns 503. Unknown regional/API paths return 404. API errors
remain visible in the form and retries preserve the active operation. This module
introduces no new authentication TTL or attempt count; those remain explicit
policy in [email-login.md](email-login.md).

Current limitations: the entry restores the configured deployment's identity,
not a cross-deployment session set. Only Global is configured today. The browser
owns one selected-conversation subscription, with no desktop background swarm.
Production routing/configuration, external mailbox delivery and deployed stateful
artifact serving remain release checks.

## Testing

`pnpm --filter @rally/browser test` builds assets and exercises the host in real
workerd. A separate real Worker reflects forwarded requests, proving transport
without pretending to test product authorization. Its real WebSocketPair proves
upgrade, subprotocol and frame continuity through the service binding, along with
same-origin enforcement and stripping unrelated credentials. Shared API adapter
tests cover cookie reads/mutations/uploads, ticket URL adaptation, native renewal
compatibility and sign-out races. Actual email/session authority
is covered by `apps/api/test/browser-sessions.test.ts` against real migrations.

Earlier entry verification used an Electron Chromium window with mocked API
responses to inspect desktop/mobile layouts, submit OTP, and confirm magic links
do not redeem before a click. That predated removal of SSR. The static SPA and
shared-site action were subsequently inspected in headed Google Chrome; the
fixture-backed journeys verify client rendering and request shape. Invitation checks cover
restoration after another tab signs in, explicit acceptance, refusal/retry,
workspace activation and exact child destination links. That verifies presentation
and client request shape, not an end-to-end invitation or email delivery.

The shared renderer suite's `browser-entry.test.tsx` uses a real BroadcastChannel
and fixture HTTP responses to exercise same-user promotion, draft preservation,
workspace denial and sign-out/sign-in invalidation. Two real Electron Chromium
windows also verify sign-out and explicit magic-link redemption reaching the
other window without a focus event. These checks prove client behavior; the API
browser-session suites own the cookie and membership authority checks.
Fake-clock entry cases additionally cover renewal, unchanged-ceiling expiry,
late renewal after logout and deadlines beyond the browser timer range.

The lite conversation header exposes rename through the shared conversation
mutation. A failed rename keeps its draft and shows the API error; success closes
the dialog and refreshes shared navigation. Guest Main renames use the same
exact-conversation route as child renames, without requiring full membership.

The shared-directory response carries both parent and conversation archive state.
There is no separate lifecycle preflight. An independently archived child under an
active parent offers Restore substream outside the feed. An archived parent shows
Archived work stream and explains that its work stream must be restored first;
it never sends a child restore for Main or for a parent-archived child.
Archive/restore uses the existing child mutation and refreshes the directory.

Equivalent session refreshes update the stable RallyApi with `setSession`; they
must not close a healthy socket or reject pending command receipts. Identity,
workspace, role or access-class changes replace the client and re-admit it.
Responsive navigation uses shell state, closes on navigation and supplies the
shared dismissal scrim. Sharing reads distinguish loading, empty and error states.

## Changelog

### 2026-09-17 — Add a browser entry over ordinary regional sessions

The browser-only loading boundary and session cookie ordering keep email entry
small without introducing a second collaboration or authentication implementation.
Forwarded resource documents are sandboxed because this host makes their URLs
navigable with same-origin cookies, unlike native bearer-only reads.

The collaboration header includes scoped rename with retryable draft state and
shared-directory refresh, because API-only mutations left browser guests unable
to manage conversation names. Guest Main renames use exact scope admission.
Site actions use the existing platform adapter instead of requiring the native
Electron bridge, so a shared site can open in a Chrome tab. Single-scope
invitation acceptance opens the conversation directly, avoiding a redundant
destination click.

**What changed:** Added the lite browser package, static entry shell, email
and OTP submission, session restoration, invitation acceptance and same-origin
regional HTTP/upgrade forwarding, plus cookie mode in the shared API client.
Session revalidation retains a stable API client and healthy conversation socket;
parent archive state and shell-owned navigation keep lifecycle and responsive
controls consistent with the selected scope.

**Why:** Guests need to enter shared work without installing the desktop app or
creating a workspace. Reusing the regional session boundary keeps identity and
scope checks consistent while leaving browser secrets out of JavaScript.

**Considered and rejected:** A marketing-site login adapter would mix separate
product surfaces. An arbitrary-host reverse proxy would make links choose the
credential destination. A separate guest session model would duplicate authority.

**Consequences:** Keep the configured service routing and cookie boundary when
extending the collaboration UI. This host is not a WebSocket multiplexer
and does not establish desktop feature parity. Workspace landing and scoped
navigation reuse this collaboration host, keeping discovery separate from the
member directory so an independent child share cannot reveal Main metadata.
Shared dialog CSS requires the desktop-compatible inline-style policy; retaining
the stricter script policy avoids coupling that rendering requirement to script
execution permissions.
