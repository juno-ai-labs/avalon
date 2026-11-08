# Browser client

The browser client provides email and Google sign-in, then mounts the desktop
shell for everyone: Organization members and guests shared into some of its
conversations, as described in [The shell](#the-shell). A guest gets no setup or
onboarding. Sign-in, which also claims anything shared with the person's
address, and canonical conversation links activate the workspace and mount the shell. Local API and
Chrome journeys cover guest entry, feed, upload/reload, multiple conversations,
promotion and membership removal. Production mail delivery and deployed stateful
artifact serving remain release checks.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/browser/src/worker.tsx` | Static entry, asset delivery and regional service forwarding. |
| `apps/browser/src/entry.tsx` | Email/OTP and explicit magic-link redemption, Google sign-in, session restore and workspace list. |
| `apps/browser/src/site-open.tsx` | The site-opening page a protected site sends a signed-out visitor to: finds the site's organization, opens it, opens the site and returns to the visitor's path. |
| `apps/browser/src/transport.ts` | Same-origin entry requests and runtime response validation. |
| `apps/browser/src/shell.tsx` | The signed-in application's one lazy boundary: the desktop shell over the cookie session, for members and guests, and the browser's `AppSessionValue`. |
| `apps/browser/public/sw.js` | The root service worker that shows Web Push notifications, sets the installed app's icon badge, and opens their links on this origin. |
| `apps/desktop/artifact-picker-plugin.ts` | Emits `/annotation-frame.js`, the annotation script an HTML file's opaque preview frame loads from this origin, into the browser build as well as the desktop's. |
| `apps/browser/public/manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | The install manifest and icons that let the host be added to an iOS Home Screen or installed as an app window. |
| `apps/desktop/src/renderer/lib/home-screen.ts` | On iPhone and iPad, whether the host runs as a Home Screen app or in a Safari tab. |
| `apps/browser/src/session.ts`, `packages/contracts/src/client-session.ts` | Credential-free collaboration session metadata and its cookie adapter. |
| `apps/desktop/src/renderer/lib/api.ts` | Existing product API client, shared by native bearer and browser cookie sessions. |
| `apps/desktop/src/renderer/lib/collaboration-session.tsx` | Collaboration-only identity/API context, optional setup capabilities, and `useShellCapabilities`: which host is drawing and whether the reader is a guest. |
| `apps/desktop/src/renderer/lib/window-surface.ts` | The surfaces the Mac app opens in their own window (Settings), which a browser tab shows as full-tab routes, and how each closes. Sidekicks render in the main window on both hosts. |
| `apps/desktop/src/renderer/components/mac-download-link.tsx` | The Mac app download row, the sidebar's footer item when the host is a browser tab. |
| `packages/contracts/src/browser-session.ts` | Shared credential-free session and email exchange schemas. |
| `apps/browser/wrangler.jsonc` | Assets and the explicit Global API service binding. |
| `apps/browser/test/host.test.ts` | Real workerd host and service-binding transport tests. |

The browser shell lives in the browser package and declares its own UI dependencies.
Both hosts reuse application recovery and query defaults. Initial session restoration
shows a loading state before offering sign-in.

## How it works

Vite builds the client and content-addressed assets. The Worker reads the built
HTML through the assets binding unchanged; React mounts the collaboration SPA in
the browser. Initial HTML contains no user or scope data. Rendering a generic
sign-in form on every server request added a second rendering path without
providing authenticated content, so the client uses a static shell. The content policy allows same-origin
requests and local image/media blobs so authenticated attachment bytes can render;
this does not allow blob scripts or frames. Styles permit inline CSS because
shared dialogs inject scroll-lock rules and components use dynamic styles, as
in the desktop renderer. Scripts remain restricted to same-origin bundles.
The sign-in form becomes usable after the client has checked its cookie session.

`/regional/<region>/browser/*` forwards to that deployment's API service
binding, `<bindingPrefix>_API` from `config/regions.json` (`GLOBAL_API` today),
preserving request method, body, Origin and cookies and returning Set-Cookie.
The path chooses a configured deployment, never a caller-supplied upstream host;
a configured deployment without a binding answers 404.
`/regional/<region>/socket/*` forwards WebSocket upgrades through the same service
binding. It requires the browser's exact Origin, removes Cookie and Authorization,
and preserves the single-use ticket subprotocol. The API performs ticket
verification and source-object admission; the web Worker returns its upgrade
response directly and never accepts a socket or handles a frame.
The [regional browser adapter](browser-sessions.md) owns authentication and
Origin validation; the host has no signing key or identity database.

Scoped invitation emails link to the shared conversation's own address under
`BROWSER_APP_ORIGIN`; workspace invitations retain the existing site flow.

An email request carries a client operation ID. A failed issuance can retry that
ID; choosing another email or requesting another code starts a new operation.
OTP redemption uses a stable redemption ID. A magic-link fragment carries the
region, challenge and proof. The client removes it from browser history and keeps
the proof in document memory until the person clicks Continue. Merely opening a
link never redeems it. Reloading after removing the fragment requires reopening
the email link or requesting another one; no proof is written to local storage.

A shared Canvas has no entry of its own. Its emailed link is the Canvas's
canonical link, so it opens like any other: signed out, the
entry asks the person to sign in with the address the link was sent to; signed
in, it opens the Organization and the Canvas. Signing in is what claims
the share ([scoped invitations](scope-invitations.md#claiming)), on the server,
before the session is described, so there is no acceptance screen, button or
request after it. An old `/invite#…` link from before this is a plain sign-in
page: the client drops the fragment from history. The server indexed those
older shares itself, so signing in claims them like any other.

For an unaddressed entry, the client lists the user's regional workspaces and can sign
out through the ordinary browser-session logout. Once the list is on screen it
reads `GET /browser/workspaces/attention` and gives each row with new activity a
count badge ([multiple workspaces](multiple-workspaces.md#the-account-menus-directory)). Workspace roots mount the shell,
and canonical Canvas and Sidekick links activate the addressed workspace and
open in it. A retired Space, Channel, Breakout or Thread link opens nothing:
the entry says `RETIRED_LINK_MESSAGE` (`@rally/contracts/links`, the sentence
the desktop's deep-link error window shows too) above the
list, or in place of the sign-in line. A copied link reaches here from the site's handoff
page, whose **Continue in browser** keeps the path and swaps the host
([`links.md`](links.md#the-handoff-page)). A guest sees no setup or onboarding view.

Returning focus refreshes both the root session and the selected workspace
relationship, even when the user ID is unchanged. The feed stays mounted while
this check runs, preserving unsent drafts. A denied workspace selection unmounts
collaboration; a transient request failure leaves the current view and opens the shared OK error popup (see [shared UI](shared-ui.md#error-popups)).
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

A guest's sidebar is the desktop sidebar fed by the workspace socket, listed
by the same rules a member's is ([`canvases.md`](canvases.md)): the
Canvases shared with them and the Sidekicks they may open. A guest has no New
Canvas or New Sidekick, and the Canvases home's empty state says a shared
Canvas appears there. The server re-authorizes every conversation a guest
opens.

### Google sign-in

The signed-out entry leads with **Continue with Google** as the primary button,
with **Continue with email** under it. Choosing email swaps both buttons for the
email form, whose **Other sign-in options** link swaps them back. An invitation
page opens straight on the email form.
`POST /browser/google/start` stores a `browser_identity` OAuth state with a
return path on the browser host and sets an HttpOnly session cookie
`<cookie>-google-<state>` holding the same state. The callback checks that
cookie, claims the state, exchanges the code through the same path the desktop flow
uses, registers a browser session, sets the cookie and redirects to the return
path. A failure returns with `#google_error=<code>`, which the signed-out screen
shows until the person starts an email sign-in. Four choices shape it:

- **Offered on every signed-out page,** including a shared conversation's link:
  the share belongs to the address, so a Google sign-in with it claims the share
  like any other sign-in, and returns to the page it started on.
- **The callback is on the browser host.** Google returns to
  `/regional/<region>/browser/google/callback`, which the Worker forwards like
  any `/browser/*` request. Only a response on that host can set its host-only
  cookie, and an API-hosted callback would have to hand the page a Rally
  credential in a URL instead.
- **Cookie before state.** The callback compares the state cookie with the
  `state` query before it touches the stored row, so a link to someone else's
  callback cannot sign this browser in as them, and cannot burn their state.
  There is one cookie per state, so two tabs signing in at once keep their own.
- **Row kinds do not mix.** Browser rows have `purpose = 'browser_identity'`
  and desktop rows `purpose = 'identity'`. Each callback claims only its own
  purpose, so a state that reaches the wrong callback is refused without being
  consumed.

The redirect URI must be registered on Google's identity OAuth client; the
[runbook](runbook.md#provider-configuration) lists it.

### Development sign-in

Against a local API with `APP_ENV=development` and `RALLY_DEV_AUTH=true`, the
signed-out entry also offers **Use local development account**, the desktop's
button of the same name. The entry asks `GET /browser/dev/session` once, the
first time the signed-out screen shows; it answers 204 only there and 404
everywhere else, so production never draws the button. Choosing it sends
`POST /browser/dev/session`, which opens `createDevelopmentIdentitySession`'s
account (`adam@avalon.local`, the seed's Adam) as an ordinary browser cookie
session with no Organization, and the entry continues as after an email
sign-in, to the Organization list.

A Canvas or Sidekick link's sign-in line names what it opens ("Sign in to open
this Canvas."), and an Organization path's says "Sign in to open this
Organization."; a link need not have been emailed to anyone.

### Connectors

A member can start every connection except those whose catalog entry in
`connector-catalog.ts` is marked `desktopOnly`, which today is Canva alone: its
OAuth returns to a loopback listener in the Mac app's main process. A new
connector is offered in both clients unless it is marked. A marked connector, in
Settings and a conversation's connection card, is shown with its buttons
disabled and "Download the Mac app to connect this." linking to the Mac build.
An installed marked connection's Refresh is disabled too, with the same note as
its tooltip, since reconnecting takes the same path. On a phone or tablet (`MAC_APP_DOWNLOADABLE` false) it
reads "Connect this from the Mac app." with no link, since the build cannot run
there. The mark is presentation only; the connection routes do not read it.

A cookie session's `RallyApi` starts with `?handoff=browser`. The API stores
`<browser origin>/connections/complete` as the return, accepts exactly that
page in `connectorAttemptTarget`, and the callback redirects there directly
instead of through the site's desktop handoff page. `desktopHandoffUrl` passes
that one page through and sends every other target to the handoff page, so it
never redirects to an arbitrary web URL. The browser's `openExternal` opens a
blank tab, cuts its opener, then loads the provider; a blocked popup is an error
the caller shows ("Allow pop-ups…"), never a navigation away from the tab that
holds the pending attempt. The completion page says what happened and closes itself
when a script opened it; the tab that started the connection reconciles from the
attempt read, as on the desktop.

### The shell

Every signed-in workspace mounts `BrowserShell` (`shell.tsx`), members and
guests alike. The selected workspace's access class is part of the remount key,
so a promotion, or a member made a guest, remounts the shell and drops caches
that held what the old relationship could read.

The shell reuses the desktop renderer rather than forking it. It builds an
`AppSessionValue` over the cookie session and installs it with
`AppSessionValueProvider`, then mounts the desktop's `AccountOnboardingGate`
and `WorkspaceApp`: the workspace socket provider, the sidebar, the Canvases and Sidekicks
screens, the right panel and the Settings route. The value carries
`host: "browser"`. Account onboarding is identity-scoped, so it goes through the
`_` workspace of the cookie adapter. Anything only the Mac app can do (accepting
a workspace invitation from the desktop flow, desktop sign-in) rejects with
"Available in the Mac app." Creating an organization is the entry's, not the
shell's; see below. A browser tab cannot keep a window of its own, so the
surface the Mac app opens in one, Settings, is a route of the main window here
(`#/settings`). `lib/window-surface.ts` lists it; on that route the shell takes
the whole tab and hides the sidebar, which stays mounted so closing the surface
returns to the workspace without reloading it. Sidekicks (`#/sidekicks`, the
home, and `#/sidekicks/:id`, each Sidekick) are panes beside the sidebar on
both hosts, like any other screen. In Settings a browser drops the Desktop
app group, whose settings are all about the Mac app, and shows Appearance in
Account; Notifications offers "In this browser" while the
`pushNotificationsEnabled` flag is on, and only the email choices without it.
At phone width Settings' header has one close: the sections sheet's toggle is
hidden while the sheet is open. The tab is named for what it shows
("Canvases · Rally", "Settings · Rally"). The sidebar always shows **Download the Mac app** above the
account menu, as a footer item ([`desktop-shell.md`](desktop-shell.md#the-sidebar)).

What a guest may do is asked in one place, `useShellCapabilities()`, which reads
`host` and the session's `accessClass`. A guest's shell does not read imports,
connections or the connector catalog; it shows no Sidekicks library, no account
introduction and no Organization setup journey; and Settings holds only Account
(without the timezone, saved through a member-only route) and Application. Those
routes refuse a guest, so the shell neither asks nor offers. Search, Speak and
push registration are a guest's as they are a member's: each answers only for
what the person may already reach. The server still
authorizes every call. `GET /workspace` answers guests too, with
`accessClass: "guest"` and no role, because the shell reads it before anything
else; the rest of `/workspace` stays member-only.

The desktop shell routes by hash. Before its router mounts, the shell rewrites a
canonical Canvas or Sidekick link into the workspace path plus the hash the
desktop's own deep links navigate to (`shellLocation`): `#/canvases/:id`, with
`?artifact=:id` when the link opens one of its artifacts, or `#/sidekicks/:id`. Losing access or a 401 asks the entry to re-read the server
session, which unmounts the shell when the session is gone. The shell keeps
transcripts in the local cache, so the entry wipes it alongside drafts on
sign-out and account change.

The cookie adapter forwards the families the Canvases and Sidekicks shell
calls: `canvases`, `conversations` (a Canvas's Chat and a Sidekick's
conversation), `sidekicks`, `automations`, `sharing`, `resources`, `search`,
`connections`, `workspace`, `workspaces`, `push-devices`, `digest` (the
schedule in Settings), `onboarding/account` and
`onboarding/organization-suggestion`, with `feature-flags`, `telemetry`,
`message-issues`, `favicons`, `speech` and `realtime`. The Thread, Channel and
Space families (`workstreams`, `spaces`, `projects`, `navigation`,
`work-opportunities`) are not forwarded. The list is
`BROWSER_ROUTE_FAMILIES` in `apps/api/src/routes/browser.ts`: a new route family
the browser calls must be added there, or the browser's request for it is not
forwarded. Each route keeps its own role
checks; the adapter adds no permission of its own. The rest of `onboarding`
stays out: creating, activating or joining a workspace there answers with a
bearer session, and a browser holds only its HttpOnly cookie.

### Creating an organization

When the signed-in entry has nothing to list, it offers **Create an
organization**, which shows `CreateOrganizationCard`: the Mac app's organization
step, shared with `RegionOnboarding`, with the same name rules, UUIDv7 operation
id and `workspace_create_requested` intent. The entry posts the name and
operation id to `POST /browser/workspace/create` on Global. That route runs the
Mac app's `PlatformOnboardingService.createWorkspace`, revokes the bearer session
it returns without reading it into a response, and answers only
`{ region, workspaceId }`. The entry then opens it in the same document: it
replaces the address with `/app/workspaces/<region>/<id>` (replaced, not
pushed, since nothing in the entry answers Back), makes that the destination
a later restore reopens, and opens it through `/workspace/select` like any
other organization. The shell runs the creator's setup journey there: "This
is you in Rally", then inviting teammates.
Any account can create one, whatever it signed in with; see
[multiple workspaces](multiple-workspaces.md#authority-and-data-flow) for how a
deployment links the account.

A member can turn on Web Push for this browser, delivered as described in
[push-notifications.md](push-notifications.md#web-push-for-browser-members).

### Other deployments

Sign-in goes to Global, which holds the identity. On Global the workspace list covers every
deployment, and opening a workspace in another one activates it through Global,
which sets that deployment's own cookie. The browser host forwards only the
target deployment's cookies, and sign-out reaches every deployment. The PRD's
[`design.md`](PRDs/2026-10-03_full-browser-client/design.md) is the contract.

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

The shared conversation surface, the Canvas and Sidekick views and the favicon
adapter consume `CollaborationSessionProvider`, not the desktop
account/setup context. The desktop session provider installs this smaller
provider around its children, retaining the same API and identity objects.
Connector authorization cards require an explicit connector-setup capability,
which supplies pending OAuth state and external navigation. Omitting it hides
setup cards and avoids their catalog request; existing connector chips and tool
execution are separate from setup. Sidekick creation likewise requires an explicit
creation callback; without it the shell offers no New Sidekick. The browser
supplies both to a member and neither to a guest, whose routes for them refuse.

Addressed conversation links select their workspace directly without waiting for the workspace list.

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

A guest's shell offers no Sidekick authoring or setup, and does not fetch the
member-only Sidekick authoring directory.

A Canvas's Share dialog invites a guest by email through the shared invitation
panel (`ScopeSharingPanel`). It accepts multiple email addresses separated by
whitespace, commas, or semicolons, and sends through the existing scoped
invitation API with operation identity retained on retry. The Canvas's Chat
(`0`) is the only target. Below the form it lists who the Canvas was shared
with and has not signed in yet, as Guest rows the sharer can remove.
The server remains responsible for sharing authorization. No setup or onboarding
capability is required.

The conversation header also opens the selected conversation's participant controls and
lists its attached resources. Resource selection uses the shared preview/lightbox
and authenticated byte endpoint. The header's resource opener is bound to the
selected conversation.

### Shared site resources

The shared conversation surface uses the platform adapter for site actions in
Chrome as well as Electron. Guests and members alike preview a live artifact
inline in a sandboxed iframe, which the shell's
`frame-src https://*.<ARTIFACT_SERVING_DOMAIN>` allows, and can still open the
freshly authorized URL in a separate tab; see
[`live-web-artifacts.md`](live-web-artifacts.md). Comment mode works in that
frame: the serving Worker gives a framed page Rally's annotation script, and
the detail drives it over `postMessage`, accepting replies only from the frame's
window at the artifact origin. HTML files and saved site spots take comments
too, since the host serves `/annotation-frame.js` for their opaque frame; see
[`artifact-annotations.md`](artifact-annotations.md).
Artifact open, error, and data routes accept the guest workspace relationship
and use the existing canonical resource authorization in `ArtifactOpenService`.
Public artifact content retains its existing anonymous serving rules; the guest
grant controls Rally resource access and attributed viewer sessions.

A site can also send someone here. `/app/sites/<region>/<hostname stub>/<return
path>` is the site-opening page (`apps/browser/src/site-open.tsx`). Signed out,
it is the ordinary sign-in card, which carries the `/app/` path through email
and Google and lands back on it; the return path is one encoded segment because
only the path survives that trip. Signed in, it asks the site's deployment
`POST /browser/sites/resolve` for the site's organization and resource, opens
that organization with the same `openWorkspace` a workspace link uses, mints the
site's single-use access code, and replaces itself with the site's `openUrl`
plus `?return=`. A 404 means no such site, and a 403 means the site exists but
this account cannot read it, including a member of the Organization who is not
in the audience of the site's Canvas; the page says which, so the person knows whether to fix
the link or ask for access. A failure that trying again could fix (Rally
unreachable, a 503) offers Try again. Its decisions live in
`apps/browser/src/site-open-decisions.ts`, apart from React, and the page is
keyed by the signed-in user, so switching accounts starts the open over.

A deployment other than Global sets its cookie only when one of its
organizations is opened, and the lookup is what finds the organization, so a
site in such a deployment opens only once the browser has opened one of that
deployment's organizations. The page says so.


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
Its screens draw the desktop's sign-in card and the shared `RallyMark`,
`Button` and `ConnectorMark`; failures use the shared error popup. A sign-in or picker change belongs
in `@rally/ui`'s `app.css` so both hosts move together; the browser's
`styles.css` keeps only what a web page adds.
Every wait from page load to the shell draws `BrowserBoot`. A signed-in link
never falls through to the signed-in card while its organization opens, since
that card's organization list is empty for a link and reads as "no access"; nor,
when the link names another deployment, to the spent code's card.
Collaboration code loads after authentication through one explicit lazy boundary;
this is the browser-only exception to static imports. The browser declares its
desktop dependency because it consumes the existing collaboration implementation;
`@rally/ui` remains presentation-only. Cross-host renderer tests stay in the
existing desktop jsdom harness rather than creating another test runner.

The host serves the push service worker at `/sw.js` from the root, with
`Cache-Control: no-cache` so a changed worker is picked up, and the shell's CSP
allows `worker-src 'self'` so the shell can register it. The worker
caches nothing and answers no requests.

The host can also be added to an iOS Home Screen, or installed as an app window
in Chromium. The shell links `/manifest.webmanifest` (`display: standalone`,
start and scope `/`) and `/apple-touch-icon.png`; the Worker serves those and
the manifest's icons from the root, by name, beside `/assets/`. The icons are
the Mac app icon, which is full-bleed with its mark inside the maskable safe
zone, so one 512 px file serves as both the plain and the maskable icon. The
status bar above a Home Screen app is iOS's to paint: through iOS 18 from the
document's `theme-color` meta, which the entry carries as a light and dark pair
for the first paint and `applyTheme` keeps at the applied canvas, and on iOS 26
from the page itself, so the root paints the canvas too
([`theming.md`](theming.md)).

On iOS this is what makes notifications possible: Safari offers Web Push only to
a Home Screen app, so in a Safari tab Settings reports `home-screen` and tells
the member how to add Rally instead of saying the browser cannot. Safari also
keeps a Home Screen app's cookies apart from its tabs, so the app signs in on
its own, and a magic link from email opens in Safari and signs in Safari, not
the app. In the Home Screen app the code screen therefore asks only for the
code. `home-screen.ts` tells the cases apart with `navigator.standalone`, which
only iOS Safari defines, rather than the user agent. An installed Chromium app
shares its browser profile's cookies, so it keeps the email link.

Forwarded HTTP responses retain their streaming bodies but add document sandbox
CSP and `nosniff`: an uploaded HTML or SVG navigated on the cookie origin must
never execute as the application. Socket upgrades remain untouched. The shell
allows HTTPS remote images for existing avatars and Markdown images. Socket
routing still relies on the existing ticket and source-object admission; there
is no separate browser permission model or arbitrary forwarding destination.

At phone width the shared sidebar becomes a top bar with a menu button that
drops the navigation in as a sheet
([`desktop-shell.md`](desktop-shell.md#at-phone-width)). Guest promotion uses
the shared confirmation modal.

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
- A Google callback completes only when this browser's state cookie matches the
  `state` query.
- Browser and desktop Google states do not mix: each callback claims only rows
  of its own `purpose`.
- `/browser/sites/resolve` is a deliberate exception to "not an existence
  oracle": it tells a **signed-in** account whether a site exists (404 versus
  403), and returns the organization and resource ids only to someone who can
  read the site.

## Boundary

The Worker owns the web entry and transport, not product authority or sockets.
The collaboration host reuses the existing conversation surface and its direct
subscriptions. The host is separate from
the public marketing site. Its production origin is `https://app.rallywith.ai`,
configured as a Custom Domain on `rally-browser`. Cloudflare provisions its DNS
record and certificate. Global API `BROWSER_APP_ORIGIN` matches that exact origin, which is also included
in `ALLOWED_ORIGINS` for realtime WebSocket upgrades.

### Production deployment

`.github/workflows/deploy-browser.yml` builds, checks and deploys the browser on
main changes to the host or its shared desktop/package dependencies. It reuses
`site-production` Cloudflare credentials and verifies the public entry routes.
The deployment token needs Workers and zone permissions for the Custom Domain;
`rallywith.ai` must be an active zone in the same account and `app` must not have
an unrelated conflicting DNS record. No browser secrets are added: `GLOBAL_API`
already connects to `avalon-api-global` through a service binding. A new
deployment needs its own `<bindingPrefix>_API` binding here, and its identity
bridge on Global, before the browser can reach it.

The API deploy workflow independently applies its checked-in browser origin and
email policy. The team selected six-digit OTPs, ten-minute expiry and five failed
attempts for production on 2026-09-18. The existing API Resend and session/encryption
secrets must be present. Initial enablement is complete only after both deployments
succeed; the browser shell can be available before API sign-in is enabled.

Manual browser deployment from the repository root is
`pnpm exec dotenv -e .env.local -- pnpm --filter @rally/browser run deploy`. After the first deployment, verify in
Chrome that a real invitation arrives, email sign-in opens the conversation, and the
shared conversation can send messages and receive realtime updates. The workflow's
public route checks compare the served shell with the built HTML, including its
hashed assets; they do not prove mailbox delivery or authenticated collaboration.
The workflow reuses the site deployment budget and Ace's domain propagation retries.
If API deployment finishes first, invitation links can temporarily point to a
host that is not ready. Disable new sharing/sign-in by removing the API browser
origin; removing the browser route from config alone does not detach an existing
Custom Domain, which must be removed in Cloudflare when retiring the host.
The email policy and explicit decision to launch without issuance limits are
owned by [email-login.md](email-login.md).

For local work, start the API according to [dev-environment.md](dev-environment.md)
and run `pnpm dev:browser` on port 8794. Client assets rebuild on source edits. The Global service binding discovers the local
`avalon-api-global` Worker. The script passes `--local-upstream localhost:8794`
because `wrangler dev` otherwise rewrites the request URL and `Origin` to the
production Custom Domain, and the API's origin check then refuses every browser
mutation; [dev-environment.md](dev-environment.md#lite-browser-development) has
the detail. Configure the API's browser origin and explicit email
policy before testing real authentication. Development does not send emails.

## Failure modes and limits

Missing built HTML returns 503. Unknown regional/API paths return 404.
`POST /browser/sites/resolve` answers 404 `site_not_found`, 403
`site_access_denied`, or 503 `authorization_unavailable` when access cannot be
checked. API errors
remain visible in the form and retries preserve the active operation. This module
introduces no new authentication TTL or attempt count; those remain explicit
policy in [email-login.md](email-login.md). Google sign-in reuses the desktop
flow's ten-minute OAuth state expiry, and its state cookie is a session cookie.

`POST /browser/google/start` answers 422 `invalid_return_uri` for a return path
that leaves the browser host. Every other Google failure is a redirect to the
browser host with `#google_error=<code>`:

| Code | Meaning |
| --- | --- |
| `google_state_mismatch` | No state, or no matching state cookie in this browser. |
| `invalid_oauth_state` | The state is unknown, expired, already used, or a desktop one. |
| `google_oauth_denied` | The person declined at Google. |
| `google_oauth_failed` | Google returned any other error. |
| `google_token_exchange_failed`, `google_identity_missing` | Google's token endpoint refused the code or returned no ID token. |
| `google_id_token_invalid` | The ID token did not verify; the log names JOSE's reason. |
| `google_identity_invalid` | The token lacks a subject or email, or the email is not verified. |
| `google_oauth_not_configured`, `global_identity_required` | Google identity is not configured, or this is not the Global deployment. |
| `google_sign_in_failed` | Anything else that threw; the log names the cause. |

Current limitations: only Global is configured today, so the cross-deployment
path is proven against a simulated deployment in tests. A guest tab
owns one selected-conversation subscription, with no desktop background swarm; a
member tab runs the desktop's feed swarm over native sockets.
Production routing/configuration, external mailbox delivery and deployed stateful
artifact serving remain release checks. Signing in over an existing cookie does
not revoke the earlier session, so anything bound to it, such as a Web Push
device, stays live until that session ends. The Home Screen app supports iOS
18 and later, so a Safari tab on an iOS too old for Home Screen Web Push (before
16.4) is still shown the Home Screen hint. It works only
online: nothing is cached for it, and invitation and Canvas links from email
open in Safari, not in the app.

## Testing

`pnpm --filter @rally/browser test` builds assets and exercises the host in real
workerd. `test/site-open.test.ts` covers the site-opening page's decisions:
the code stays in the fragment, and which failure each answer shows. The page's
React wiring has no automated test. A separate real Worker reflects forwarded requests, proving transport
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
fixture-backed journeys verify client rendering and request shape. Shared-link
checks cover a conversation link opening straight into the shell after an email
sign-in with no acceptance request, and an old token link reading as a plain
sign-in page. That verifies presentation
and client request shape, not an end-to-end invitation or email delivery.

The shared renderer suite's `browser-entry.test.tsx` uses a real BroadcastChannel
and fixture HTTP responses to exercise same-user promotion, draft preservation,
workspace denial and sign-out/sign-in invalidation. Two real Electron Chromium
windows also verify sign-out and explicit magic-link redemption reaching the
other window without a focus event. These checks prove client behavior; the API
browser-session suites own the cookie and membership authority checks.
Fake-clock entry cases additionally cover renewal, unchanged-ceiling expiry,
late renewal after logout and deadlines beyond the browser timer range.

`browser-collaboration.test.tsx` mounts the entry and the shell for a guest
and fails on any request to a route family that refuses guests, so a surface
that starts reading member-only data for everyone shows up there.
`apps/api/test/auth-router.test.ts` proves `GET /workspace` and the member
directory answer a guest while the rest of `/workspace` stays refused.

The browser shell draws the desktop's Canvas and Sidekick screens, so a
Canvas's rename, Share dialog and title menu are the desktop's
([`canvases.md`](canvases.md#in-the-client)).

Equivalent session refreshes update the stable RallyApi with `setSession`; they
must not close a healthy socket or reject pending command receipts. Identity,
workspace, role or access-class changes replace the client and re-admit it.

## Changelog

### 2026-11-08 — Settings and the tab say what the browser shows

**What changed:** This document names the development account that actually
signs in and the Settings sections a browser actually draws; Settings' copy
says Organization and Sidekicks rather than "workspace" and "automations" and
no longer calls the browser "this desktop app"; a phone's Settings header has
one close.

**Why:** The design inspection found the copy and this page out of step with
the app (v4-F18, v4-F21, v4-F22, v4-F23, v3-G10). The PRD's names win over
the storage names the copy had leaked.

### 2026-11-08 — A local browser can use the development account

**What changed:** `GET` and `POST /browser/dev/session`, and the signed-out
entry's **Use local development account** where the first answers 204. A
Canvas or Sidekick link's sign-in line names what it opens.

**Why:** A person with only the browser could not sign in locally: Google
needs credentials, and development sends no email, so the browser tester read
the code out of D1. The desktop's button already existed against
`POST /auth/dev/session`, whose bearer tokens the browser does not use; the
browser route registers the same identity as a cookie session. The flag is
asked of the API rather than built into the client, because the browser bundle
is a production Vite build even locally (`import.meta.env.DEV` is false). The
link line said "Sign in with the email address the link was sent to.", which
was the invitation's copy and wrong for a link copied from the app.

**What a future change must respect:** both routes stay behind
`APP_ENV=development` and `RALLY_DEV_AUTH=true`; the button's presence is the
API's answer, never a client build flag.

### 2026-11-07 — The browser opens Canvases and Sidekicks, beside the sidebar, and forwards their routes

**What changed:** The shell mounts the two-section sidebar (Canvases,
Sidekicks) rather than Channels, Threads and Activity, and a guest's sidebar
lists what was shared with them there. `#/sidekicks` and each Sidekick render
beside the sidebar, as they do in the Mac app's main window; only Settings is
a window surface. `shellLocation` rewrites a Canvas link to `#/canvases/:id`
(with `?artifact=`) and a Sidekick link to `#/sidekicks/:id`; the Thread,
Channel and Space branches are gone, and a retired link gets a line on the
entry screen saying what it named no longer exists. `BROWSER_ROUTE_FAMILIES`
gains `canvases`, which it lacked, so a browser could not create or open a
Canvas, and loses `workstreams`, `spaces`, `projects`, `navigation` and
`work-opportunities`. The Thread header's rename, archive and restore, and the
Thread and Breakout right-click sharing menus, went with Threads.

**Why:** Plan steps A-13, B-1, B-3 and B-5 of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md):
the Thread and Channel screens are deleted, `App.tsx` redirects their old hash
routes to the Canvases home (so a link rewritten to `#/workstreams/:id` would
have lost its target), the Canvas is what a shared link names, and the PRD
moves Sidekicks into the main window ("Sidekicks home"), so a tab giving them
the whole window would draw a different product from the Mac app.

**Considered and rejected:** Keeping the retired families forwarded "in case".
Forwarding is the whole of the browser's reach; a family nothing calls is reach
nobody needs.

**Consequences:** A route family a later step adds to the shell must be added
to the list in the same change. The links themselves are
[`links.md`](links.md)'s.

### 2026-11-03 — A protected site's link signs you in and brings you back

**What changed:** `/app/sites/<region>/<stub>/<return path>` signs a person in,
opens the site's organization and opens the site at the path they asked for.
`POST /browser/sites/resolve` maps a hostname to its organization and resource
for someone who can read it.

**Why:** A protected site answered a visitor who arrived by its link, rather
than from inside Rally, with "Open this site from Rally", and nothing there
could get them in. Sites are shared by link, so that was the common case.

**Not found versus no access:** the lookup answers 404 and 403 separately, so
a person knows whether to fix the link or ask for access. It tells a
signed-in person that a site exists, nothing more.

**Considered and rejected:** Putting the organization id in the site's
redirect. The site Worker does read it, but it would hand the id to anyone
who visits a site URL; the lookup returns it only to a reader.

**Consequences:** A site in a deployment other than Global opens only after
the browser has opened one of that deployment's organizations, because the
regional cookie is set by opening an organization.

### 2026-10-10: Every connector but Canva connects from the browser

**What changed:** The browser offers every connector except those marked
`desktopOnly` in the connector catalog, where it offered only the ones a served
`browser-connectable-capabilities` list named (the two Google connections). The
flag, its resolver and the `browserConnectableCapabilities` client field are
gone. Canva carries the mark, and its reconnect, from the card or an installed
connection's Refresh, is now gated too.

**Why:** Every start route already returns to the browser's completion page, so
the allowlist kept working connectors in the Mac app for no reason, and each new
connector started hidden until someone edited a flag nobody had created. What
keeps a connector out of the browser is a fact about its code, Canva's loopback
listener, so it lives beside the connector rather than in a flag.

**Considered and rejected:** Inverting the flag into a served deny list. A flag
cannot make a loopback callback work in a tab, so it would only restate the code
in a second place that can drift from it.

**Consequences:** A connector whose authorization needs the Mac app must be
marked `desktopOnly` in the change that adds it. Removing Canva's mark waits on
Canva approving Rally's server callback.

Shipped in #1186.

### 2026-10-07: Add Rally to the iOS Home Screen

**What changed:** The host serves a web app manifest and icons. On iOS,
Settings tells a Safari tab how to add Rally, and the Home Screen app's code
screen drops the email link.

**Why:** Safari delivers Web Push only to Home Screen apps, and the host had no
manifest, so an iPhone member could not get notifications at all.

**Considered and rejected:** An offline cache in the service worker. The shell
HTML is private and `no-store`, and the app is not useful without its sockets.

**Consequences:** A root file a browser fetches by name has to be added to
`INSTALL_FILES` in the Worker, or it returns 404.

### 2026-10-07: Settings and Sidekicks take the whole tab

**What changed:** Settings and Sidekicks, which the Mac app opens in their own
windows, are routes of the main window in a browser tab, listed in
`lib/window-surface.ts`. On those routes the shell hides the sidebar and gives
the surface the whole tab. Sidekicks used to open in a second, named tab; it now
opens at `#/sidekicks` in the same one, and its library gains a close button.

**Why:** Settings drew in a pane beside the sidebar, which read as a channel
rather than as its own place. Sidekicks opened a tab of its own, which a person
then had to find and close.

**Considered and rejected:** Mounting these routes outside the shell. Leaving
would then remount the sidebar and reconnect the workspace socket; hiding it
keeps the return instant.

**Consequences:** A surface added to the list gets both behaviors. The sidebar
stays mounted, and its socket open, while a surface is on screen. A tab left
open on the former Sidekicks tab's `?surface=sidekicks` address drops that query
when the shell loads.

Shipped in [#1154](https://github.com/juno-ai-labs/avalon/pull/1154).

### 2026-10-07: A created organization opens in place

**What changed:** After `POST /browser/workspace/create` the entry no longer
calls `location.assign`. It replaces the address with the organization's
path, records it as the destination the restore path reopens (a ref, where
the restore used to read only the address the page loaded with), and sets
the destination, so the existing effect selects the organization and mounts
the shell.

**Why:** The navigation downloaded and booted the page again, restored the
session it already held, and only then made the one request the new
organization needed: `/workspace/select` on Global.

**Considered and rejected:** `history.pushState`, so Back would return to the
empty list. Nothing in the entry answers `popstate`, so Back would change the
address and leave the organization on screen.

**Consequences:** The created organization is reached without a history
entry, so Back leaves Rally rather than returning to the empty list. A focus
or a session change while it is open reselects it, as for a page loaded at
its address, rather than reading the organization list. The list read before
the creation is dropped, so a select that fails shows its error rather than an
empty list with Create on it again.

Shipped in #1142.

### 2026-10-06 — Create an organization from the browser

**What changed:** The signed-in entry's empty state offers **Create an
organization**. It shows the Mac app's organization step, extracted as
`CreateOrganizationCard`, and creates through the new cookie route
`POST /browser/workspace/create`. The route reuses the Mac app's create path on
Global, revokes the bearer session that path issues, and returns only where to
open the organization.

**Why:** A person who signs in on the web with nothing shared reached a dead
end: the only way to start an organization was the Mac app. Product asked for
setup to start in the browser, following the Mac app's process.

**Considered and rejected:** Forwarding `onboarding/workspace` through the
cookie adapter. It answers with a bearer session, which browser JavaScript must
never hold. A browser-only bridge method that registers a cookie in the target
deployment, as activation does, was more machinery than needed while
organizations are created on Global: the browser's existing Global cookie can
select the new organization.

The browser also records the account introduction as seen instead of showing
it, since the landing page that sent the person here already introduced Rally.

**Consequences:** Creation runs only on Global; another deployment answers 409
`global_identity_required`. The bearer the create path mints is revoked at once,
so it costs one session row. The button shows only on the empty state; someone
with organizations listed has no way to create another here yet.

PR: [#1129](https://github.com/juno-ai-labs/avalon/pull/1129).

### 2026-10-06 — A shared link opens the conversation after sign-in, with no Accept screen

**What changed:** The entry no longer has an invitation page. Its `/invite`
handling, the mailbox prefill from `/browser/invitation`, the Accept invitation
button and the accepted-destination list are gone, along with
`apps/browser/src/invitation.ts`. An invitation email links to the conversation's
addressed path, which signs in and opens like any canonical link; Continue with
Google is offered there too. An old `/invite#…` link is a plain sign-in page.

**Why:** The server now claims a share when its address signs in
([scoped invitations](scope-invitations.md)), so the screen between sign-in and
the conversation had nothing left to do.

**Considered and rejected:** Keeping the old token in page memory and posting it
after sign-in so shares made before claiming still reach their recipient. The
server indexes those shares itself instead, so the browser carries no protocol.

**Consequences:** The sign-in form no longer fills in the invited address; the
email names it, and the page says to use the address the link was sent to. The
organization list shows a loading line until it has loaded, so a fresh sign-in
never says nothing was shared before the server answers.

PR: [#1120](https://github.com/juno-ai-labs/avalon/pull/1120).

### 2026-10-06 — Lead sign-in with Google

**What changed:** The signed-out entry shows **Continue with Google** as the
primary button and **Continue with email** under it, instead of the email form
with Google below. Choosing email reveals the form in place; **Other sign-in
options** returns to the two buttons. Invitation pages still open on the email
form, since Google stays hidden there.

**Why:** Product asked for Google as the main path into the browser client,
with email kept as a second choice that does not crowd the first screen. The
Mac and iPhone apps already sign in with Google only, so leading with it puts
the browser on the same path. Any reasoning beyond that request was not
recorded.

**Considered and rejected:** Keeping the email form visible under a primary
Google button. It leaves the first screen as crowded as before and still reads
as two equal paths.

**Consequences:** The choice is page state only, and it resets once a session
exists, so every later signed-out screen in the tab starts from Google again. A
returned Google failure stays on screen through the switch to email and clears
when an email sign-in starts, as before. Invitation pages skip the choice and
open on the email form, because Google stays hidden there.

Shipped in #1125.

### 2026-10-06 — A signed-in link opens behind the boot screen

**What changed:** Until a linked organization opens, the entry shows
`BrowserBoot`. Before, it showed the signed-in card, with an empty organization
list, or for a link to another deployment the spent code's "Check your email"
card.

**Why:** Both read as a failure (no access, or a code to enter again) during an
ordinary wait. Whatever is added between sign-in and the shell has to keep
this: the organization's open is a wait, not a state of the card.

### 2026-10-03 — Guests get the desktop shell too

**What changed:** The browser's guest shell (`conversation.tsx`, about 600
lines with its own sidebar, router and header) is gone. Every browser user
mounts the desktop shell; what a guest may do is read from one hook,
`useShellCapabilities()`, which also took over the scattered `accessClass` and
cookie-session checks. `GET /workspace` now answers guests, with no role. A
guest's shell skips the member directory, imports, connections, search, the
Sidekicks library, the account introduction and the Organization journey, and
its Settings holds Account and Application. A guest's Space link opens the
first Channel shared with them there, and the root opens the first one shared
anywhere. The Mac app download moved into the
shared sidebar for every browser user.

**Why:** Two shells meant every conversation feature shipped twice or reached
guests late, and the desktop shell already carried most of what guests need:
the sidebar from the shared-navigation directory, scoped Breakouts, and no
background Channel sockets for guests.

**Considered and rejected:** Opening the member directory to guests so the
shell needs no guest checks; it would show a guest everyone in the
Organization. Porting the guest shell's own rules (hiding the sidebar for a
single Channel, a "make this window wider" notice under 920px, a Space
overview page) into the shared shell; members never had them, and the
Channel opens directly either way.

**Consequences:** A surface that reads Organization-wide data must check
`useShellCapabilities().guest` before it asks; the guest test in
`browser-collaboration.test.tsx` fails on any request to a member-only route
family. Turning the shared shell off for guests is now a revert, not a
switch. The Mac app still withholds guest workspaces in platform discovery
(see [`multiple-workspaces.md`](multiple-workspaces.md)); lifting that is a
separate change that has to audit Electron-only surfaces. A guest's transcript
cache sits in its own scope (`localCacheScope(…, 'guest')`), so one shared in
after being removed as a member never hydrates what they cached as a member.

Shipped in #1088.

### 2026-10-03 — The entry draws the desktop sign-in card

**What changed:** Sign-in, the organization picker, invitation acceptance and
the connection-complete page now use the desktop's sign-in classes and shared
primitives instead of the entry's own left-aligned wordmark layout.
Organizations are `.signin-choice` rows, which share the desktop invitation
row's rule, with the desktop's initial mark.

**Why:** The web entry looked like a different product from the Mac app and
the signed-in browser shell that follows it.

**Considered and rejected:** Restyling the entry's own classes to look similar.
That keeps a second copy of the design to drift; reusing the shared rules costs
the entry chunk about 2 KB.

**Consequences:** Changing the desktop sign-in rules changes the web entry too.

Shipped in #1085.

### 2026-10-03 — Browser members reach every deployment

**What changed:** The browser Worker forwards each region to its own service
binding. On Global, the workspace list covers every deployment, and
`/browser/workspace/activate` opens a workspace in another deployment: the
target registers its own browser session over the identity bridge
(`activateBrowser`) and Global sets that deployment's cookie. Sign-in always
goes to Global.

**Why:** Goal 9 of the [PRD](PRDs/2026-10-03_full-browser-client/prd.md): a
member in any configured deployment can use the browser. The product chose to
build this before a second deployment exists.

**Considered and rejected:** Global proxying regional API calls, a handoff code
the browser redeems, and one shared cookie. The PRD's
[`design.md`](PRDs/2026-10-03_full-browser-client/design.md) has why.

**Consequences:** A new deployment is reachable from the browser only once it
has a `<bindingPrefix>_API` binding on the browser Worker and an identity bridge
on Global. Email-only identities stay in Global; only a Google identity is
linked across deployments. Region-addressed invitations still need their own
routing in a second deployment.

Shipped in #1083. Design: [Full browser client PRD](PRDs/2026-10-03_full-browser-client/prd.md).

### 2026-10-03 — Connect Gmail and Drive from the browser

**What changed:** Connector authorization can return to a browser completion
page (`?handoff=browser`). The member shell supplies a connector-setup
capability. A served JSON list, `browser-connectable-capabilities`, decides which
connections the browser may start; every other connector is disabled there with
a pointer to the Mac app.

**Why:** Connecting is part of a member's daily setup, and the product chose a
small launch set with the rest in the Mac app
([PRD](PRDs/2026-10-03_full-browser-client/prd.md) goal 7).

**Considered and rejected:** Landing the popup on the site's desktop handoff
page and relying on polling, which tells a browser user to return to an app they
may not have. A registry field for the list, which needs a deploy to change.

**Consequences:** A connection tile is offered only when its whole capability
set is listed. Nothing provisions the flag; it is created and edited in
Flagship, not in Ace. Reconnecting an existing connection is not gated, in
Settings or in a conversation card. The cookie-session check is
`isCookieSession` in `@rally/contracts/client-session`, the one answer to "is
this the browser?".

Shipped in #1079. Design: [Full browser client PRD](PRDs/2026-10-03_full-browser-client/prd.md).

### 2026-10-03 — Sign in with Google in the browser

**What changed:** The entry has a Google button, backed by new
`/browser/google/start` and `/browser/google/callback` routes that share the
desktop flow's Google code exchange.

**Why:** Members sign in to the Mac app with Google; the browser offered only
email ([PRD](PRDs/2026-10-03_full-browser-client/prd.md), goal 2).

**Considered and rejected:** An API-hosted callback that redirects with a Rally
login ticket for the page to redeem, which puts a Rally credential in a URL. A
schema column for a browser binding, where a double-submitted state cookie does
the same job with no migration. Telling browser rows from desktop rows by a
missing desktop attempt: a separate `purpose` keeps the two apart in both
directions, again with no migration.

**Consequences:** Production needs
`https://app.rallywith.ai/regional/global/browser/google/callback` registered on
the identity OAuth client before the button works there. Google identity stays
Global; the route refuses other deployments. An ID token that fails to verify is
now `google_id_token_invalid` on the desktop callback too, where it used to be
an unhandled error.

Shipped in #1078. Design: [Full browser client PRD](PRDs/2026-10-03_full-browser-client/prd.md).

### 2026-10-03 — Members get the desktop shell

**What changed:** A member's workspace in the browser mounts the desktop shell
instead of the guest shell: the full sidebar from the workspace socket, Spaces,
Channels, Breakouts, Settings and account onboarding. The desktop's session
value became a shared `AppSessionValueProvider` with a `host` field and
account-onboarding methods, so the browser supplies its own value over the
cookie session. The cookie adapter forwards the member route families.

**Why:** Requiring the Mac app before a member can do any work is too much
friction ([PRD](PRDs/2026-10-03_full-browser-client/prd.md)).

**Considered and rejected:** Forking a browser-only member UI, which would be a
second product to keep in step; mounting the desktop `App` whole, which drives
its session from the Electron bridge and its stored credentials.

**Consequences:** The guest shell and the member shell share one lazy boundary
(`workspace.tsx`). A member tab opens the desktop's feed sockets one handshake
at a time, because Chromium serializes handshakes to one endpoint and there is
no Node broker here. Any surface that only works in the Mac app must check
`host`, not `desktopServicesAvailable()`, because renderer tests treat the
latter as false for the desktop. Of onboarding, only `onboarding/account`
crosses the adapter: workspace creation, activation and invitation acceptance
answer with a bearer session, which browser JavaScript must never hold.

Shipped in #1077. Design: [Full browser client PRD](PRDs/2026-10-03_full-browser-client/prd.md).

### 2026-09-30 — The account rail offers the Mac app

**What changed:** A "Download the Mac app" button, linking to the public macOS
build the marketing site uses, is pinned just above the account menu, in
whichever rail holds that menu: Spaces, Channels, the Breakout rail, or the
floating fallback. It is a Space-style row wearing Apple's mark from the
brand pack, so a compact rail collapses it to the same lone tile a Space
becomes. `WorkstreamSidebar`
gained an optional `footerAbove` slot for the Breakout rail case, which desktop
does not use.

**Why:** Browser visitors are mostly guests, and the browser client had no
path to the desktop app they would need for anything beyond shared
collaboration.

**Considered and rejected:** A full-width 60px footer under every screen. It
reached the sign-in screen too, but the shared rails pin to the window's top
and bottom, so the footer needed layout containment on the whole app to keep
them above it, and it took height from the conversation on every screen.

**Consequences:** The button follows the account menu, so any change to where
that menu lives must move the button with it. The sign-in screen offers no
download. The URL is hard-coded in `mac-download.tsx`, as it is in the site
and in `MANUAL_UPDATE_URL` in `apps/desktop/src/main/updater.ts`; a change to
the release path must update all three. Where the menu and the download live
is one decision, `browserAccountHome`, so they cannot be placed apart.

PR: [#1032](https://github.com/juno-ai-labs/avalon/pull/1032).

### 2026-09-25 — Rails with one row are hidden

**What changed:** The Spaces rail is hidden when the directory holds one Space,
and the Channels rail when it holds one Channel. The account menu moves to the
next rail inward, and with neither outer rail the lone Channel opens directly.

**Why:** Most browser visitors are guests shared into one Channel. For them the
two outer rails each held a single row and took width from the conversation for no choice.

**Considered and rejected:** Hiding the rails while the directory loads. It
avoids a shift for guests, but moves the loading and error text nowhere and
makes multi-Space members watch rails slide in; the existing width transition
already softens the shift the other way.

**Consequences:** With both outer rails hidden the account menu has two homes:
the Breakout rail footer, and a floating copy for when that rail is not mounted
(an archived, loading or failed Channel). The Breakout rail gained an optional
`footerLeading` slot for this, which desktop does not use.

### 2026-09-24 — The sidebar follows grants without focus

**What changed:** Each tab opens one workspace socket, through the same
`/regional/<region>/socket/` forwarding the conversation feed uses, and rereads
the shared navigation on `workspace_reach_changed` or any subscribe answer. It subscribes
and ignores the sidebar payload the subscribe answer carries.

**Why:** A person shared into a Channel or Breakout while their tab was open saw
nothing until they refocused the window. Guests are sent no Space snapshot, and
the open conversation's metadata only nudges when that one conversation moves.

**Considered and rejected:** Polling adds a timer number nobody set and still
lags. Mounting the desktop's workspace-socket provider would bring presence,
directory paging and the sidebar store the lite client deliberately does not
carry.

**Consequences:** A tab holds one socket more than it did, for as long as a
workspace is selected. The subscribe answer is built per socket and discarded here; a
lighter subscribe for listen-only hosts would remove that cost if it matters.
Nothing is replayed, so a missed event is covered by the reread on each
subscribe answer, including the first: the opening navigation read can finish
before the socket subscribes.

### 2026-09-22 — Read hierarchical shared-resource URLs

The browser now decodes Base58 Organization, Space, Channel, and Breakout path
segments and keeps the selected Space in its shared-navigation rail. Accepted
invitations resolve each destination's Space from the recipient's authorized
directory before constructing its link. Earlier browser URLs remain readable.

### 2026-09-21 — Shared descendants carry their ancestor presentation

**What changed:** `/sharing/navigation` now includes public/private scope and
appearance for authorized Channels and Breakouts, plus scope on their containing
Spaces. The Chrome UI renders those fields, and the Electron guest shell consumes
the same read-only hierarchy instead of falling back to a flat recency list.
Child-only grants create a navigable Channel ancestor and carry the first
authorized Breakout destination; open-conversation metadata refreshes this
directory without polling.

**Why:** A person who can open a descendant needs to identify where it lives.
Hiding the hierarchy made access look inconsistent between hosts and was the
premise behind refusing otherwise-valid Channel moves.

**Considered and rejected:** Loading the member Space directory for guests would
expose unrelated Spaces and management fields. Keeping a separate Electron-only
projection would duplicate the authority and drift from browser behavior.

**Consequences:** Shared navigation reveals exactly name, icon, colour and
public/private scope up the ancestor chain. A read-only Space selection filters
the Channel rail rather than opening the member Space dashboard. It does not
grant Main, unshared Breakouts, participants, defaults, content or Space
mutations. The accessible description keeps the same scope words visible beside
each row, and read-only Channel rows expose no placement drag, reorder, pin or
Space menu.

### 2026-09-21 — Put guest Channels in their Spaces

**What changed:** The browser's shared navigation now returns the minimal Space
mark and containment edges for canonically authorized Channels, and renders an
adjacent Space rail before the Channel rail. Child-only shares carry their
Channel name while Main and unshared Breakouts remain absent.

**Why:** A guest shared into Breakouts under Channels in two different Spaces
received both conversations but saw one flat Channel list. That lost the
Organization's navigation hierarchy and made it impossible to tell which
Channels belonged to the selected Space.

**Considered and rejected:** Extending the existing strict `/sharing/directory`
response in place would make already-deployed browser bundles reject the new
fields. Deriving Space placement in the browser would either require the member
directory or duplicate authority outside WorkspaceDO.

**Consequences:** `/sharing/navigation` is a separately versioned browser read;
the compatibility directory remains unchanged, including its nullable Channel
title for a child-only share. The WorkspaceDO accepts only current scope-grant
candidates, applies the ordinary per-viewer Space visibility predicate, and
returns no Space participants, defaults, scope or lifecycle fields. The final
service response is still fenced by the guest relationship revision, and the
browser uses a local fallback rather than dropping an admitted Channel when no
visible Space contains it.

### 2026-09-19 — Fill in the mailbox an opaque invitation was sent to

**What changed:** Invitation fragments are one opaque credential, and the entry
asks the unauthenticated `/invitation` route for the invited address before
anyone signs in, filling it into the email field.

**Why:** The page asks the recipient to sign in with the address that received
the invitation, and the link stopped saying which address that was. An empty box
under that sentence asks someone with several mailboxes to guess, and a wrong
guess only fails after a round trip through a sign-in email.

**Considered and rejected:** Leaving the address in the link would have kept the
workspace and work stream identifiers there with it, which is what
[scoped invitations](scope-invitations.md) removed. Filling the field after
sign-in would be too late to be of use.

**Consequences:** The field stays editable, so a recipient can still sign in as
someone else and receive the ordinary verified-mailbox refusal. A link this
deployment cannot open fills nothing and reports the invitation as unavailable;
a transport failure says so separately, because it is not evidence about the
link.

PR: [#863](https://github.com/juno-ai-labs/avalon/pull/863).

### 2026-09-18 — Enable the production browser origin

**What changed:** Host the lite browser at `app.rallywith.ai`, deploy it on main
changes, and configure Global invitation/sign-in URLs and the team-selected OTP policy.

**Why:** Desktop sharing refused invitations because production had no browser
origin where recipients could sign in and accept them.

**Considered and rejected:** Hosting under the marketing site's `/app` path would
couple its routing and cookie origin to the collaboration application.

**Consequences:** Browser and API deployments must both succeed for initial
sign-in enablement. Keep their origins identical and include shared desktop code
in browser deployment triggers. The public entry check is not an authenticated
end-to-end guest test.

PR: [#843](https://github.com/juno-ai-labs/avalon/pull/843).

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
