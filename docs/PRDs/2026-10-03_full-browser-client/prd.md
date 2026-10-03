# Full browser client for members

> Created 2026-10-03.
>
> Organization members can do their daily Rally work at `app.rallywith.ai`:
> the full sidebar, Spaces, Channels, Breakouts, Sidekick authoring, settings,
> Google connectors and push notifications. OS-level features and anything that
> needs the embedded browser stay in the Mac app. Builds on
> [guest sharing in the browser](../2026-09-16_guest-sharing-browser/prd.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Build plan: [`plan.md`](plan.md).
> Current host: [`browser-client.md`](../../browser-client.md),
> [`browser-sessions.md`](../../browser-sessions.md).

## Summary

Today the browser host is a guest client. It opens the conversations someone
was invited to and nothing else. A member who signs in sees only Channels
shared with them directly, cannot reach Spaces, cannot connect anything, and
cannot author a Sidekick.

After this change a member signs in with Google or email and gets the same
Organization they see in the Mac app: every Channel their Spaces give them,
live unread and running state, Breakouts, presence, Sidekick authoring,
settings, Gmail and Google Drive connections, and Web Push notifications. Other
connectors are listed but disabled with a prompt to download the Mac app.
Conversation import, the embedded browser, desktop actions, and OS-level
settings stay Mac-only.

## Motivation

Requiring a download to use Rally is too much friction. Today a new member's
path runs through installing the Mac app before they can do any work: the
browser host is guest-only by design (the guest-sharing PRD lists "full desktop
parity in the browser" as a non-goal), and what it offers a member beyond
shared links is a pinned **Download the Mac app** row. Every person invited to
an Organization has to find the download, install it, approve it on macOS and
sign in again before they see their first Channel. A person who will not
install an app, cannot install one on a managed machine, or is not on a Mac
never gets in.

This is a product judgement made on 2026-10-03, not a measured drop-off. Rally
has no funnel data on how many invited members never install the app, and this
PRD does not wait for it: a member who can start in the browser loses nothing,
and the Mac app remains for everything the browser cannot do.

The cost of building it is lower than the gap suggests. An investigation of the
tree on 2026-10-03 found:

- The desktop renderer already runs in a browser tab. `browserBridge` in
  `apps/desktop/src/renderer/lib/platform.ts` gives a web fallback for nearly
  every Electron call, and the guest host already reuses `ConversationSurface`,
  `RallyApi`, the composer, uploads, drafts, dictation and speech.
- Most member routes already accept a member's cookie session once the cookie
  adapter forwards them; the adapter's allowlist, not role checks, is what
  blocks them.
- Connector and Google OAuth callbacks are already HTTPS routes on the API. Only
  the final return target is tied to the desktop deep link.

## Goals

1. A member who signs in at `app.rallywith.ai` sees the same Spaces, Channels
   and Breakouts they see in the Mac app, including Channels reached through a
   Space rather than a direct share.
2. A member can sign in with Google or with an email code or magic link, and
   either lands on the same identity as the Mac app.
3. The sidebar shows live unread, mention, running and presence state, and
   browser members appear as present to others.
4. Switching between pinned, recent and running Channels is as fast as in the
   Mac app once the tab has warmed.
5. A member can author, edit and attach Sidekicks.
6. A member can use every settings section that is not about the operating
   system, and OS-level sections say they are Mac-only rather than being faked.
7. A member can connect Gmail and Google Drive in personal and workspace scope
   from the browser. Every other connector is listed and disabled with the text
   "Download the Mac app to connect this."
8. A member who allows notifications gets the same pushes as on the Mac, through
   Web Push.
9. A member in a workspace hosted in any configured region can use the browser
   client, not only Global.
10. Live artifacts preview inline in the right rail.

## Non-goals

1. **Conversation import from ChatGPT or Claude.** Deferred. It runs on the
   embedded browser and desktop actions, which a web page cannot provide.
   Revisit with export-zip upload or a browser extension.
2. **The embedded browser and desktop actions.** Rejected for the web host. A
   page cannot embed or script signed-in third-party sites. A browser extension
   answering the same `desktop_action_requested` frames is the only path and is
   not part of this PRD.
3. **Connecting any connector other than Gmail and Google Drive.** Deferred.
   Shown but disabled. The browser-connectable list is a flag so it can grow
   without a deploy.
4. **Canva in the browser.** Deferred. Its OAuth needs a loopback listener until
   Canva approves Rally's server callback. It falls under non-goal 3 either way.
5. **OS-level features.** Rejected for the web host: menu bar item, launch at
   login, Dock icon picker, auto-update and release channel, Lockdown mode,
   native crash reports, system audio capture, macOS Dictionary lookup.
6. **Message export as image or PDF.** Deferred. Needs a client-side renderer.
   Buttons stay hidden, as today.
7. **Background attention for other workspaces.** Deferred. The tab holds one
   active Organization session.
8. **Rate limits or bot protection on sign-in.** Rejected for now. Email
   issuance stays unlimited, per the launch decision in
   [`email-login.md`](../../email-login.md). Revisit on observed abuse.
9. **Replacing the Mac app.** Rejected. The Mac app remains the full client.

## Product behavior

### Sign-in

The entry offers **Continue with Google** above the existing email form. Google
returns to a callback on `app.rallywith.ai` itself, which sets the browser
cookie and restores the workspace list exactly as email sign-in does. A Google account and an email
sign-in with the same verified address reach the same identity. Guests keep
using email; nothing about invitation acceptance changes.

### Organization shell

A member's workspace mounts the desktop shell: the single sidebar with Space
pills, Channel rows, Breakouts, the account menu, and the details rail. The
sidebar comes from the full workspace socket provider, not
`/sharing/navigation`, so Space-derived Channels appear. A guest keeps the
current guest navigation.

Loading shows the sidebar skeleton while the workspace socket's first snapshot
arrives. A transient socket failure keeps the last sidebar and shows the
reconnecting state the Mac app shows. A revoked membership unmounts the shell,
as the guest host does today.

### Realtime

Each tab opens the same proactive feed set the Mac app does, as defined in
[`websocket-architecture.md`](../../websocket-architecture.md): the active
Channel, pins, recent and running Channels, the landing candidate and a hover
warmup, with the same retention. Breakouts open a feed only while viewed.
Every tab holds its own set; tabs do not coordinate.

The tab publishes presence from page visibility and focus, the way desktop
derives it from main's app-focus signal.

### Sidekicks and settings

Sidekick creation and the Sidekicks library open in a named tab (`window.open`)
as `browserBridge` already does. Settings opens as a route. OS-level sections
under Application are shown with "Available in the Mac app" and no controls.

### Connections

The connections screen lists every connector. Gmail and Google Drive are
enabled; starting one opens the provider in a popup synchronously on click (to
avoid popup blockers), and the card completes by polling the OAuth attempt,
which the existing cards already do. When the provider returns, the popup lands
on a browser page that says the connection finished and closes itself.

Every other connector is shown disabled with "Download the Mac app to connect
this." and a link to the Mac download. Existing connections made on the Mac
still work in the browser: chips, tool execution and reconnect banners are
unaffected; only starting a new authorization is gated.

### Notifications

After sign-in the account menu offers **Turn on notifications**. Allowing it
registers a Web Push subscription for this browser. Pushes arrive with the
same content and targets as on the Mac; clicking one focuses an open Rally tab
on that conversation or opens a new one. Denying it changes nothing else; the
email fallback still applies.

The service worker is served from the app root (`/sw.js`), so its default scope
covers `/app/`. The browser Worker adds that one path to what it serves today,
and the shell's CSP gains `worker-src 'self'`.

### Artifacts

The details rail previews a live artifact in a sandboxed iframe on the artifact
host. Pop-out still opens the artifact in a new tab. Where the browser refuses
the artifact's framed viewer cookie (see **Security and trust model**), the
preview shows the artifact's public representation and the pop-out link.

### Existing client flags

The browser shell reads the same client flags as the Mac app.
`multiple-workspaces-enabled` decides whether workspace switching is offered,
and `live-artifacts-enabled` decides whether the artifact rail and inline
preview exist. Shipping the browser to everybody does not turn on a surface the
Mac keeps dark.

### Regions

A member's workspace list covers every configured deployment, subject to
`multiple-workspaces-enabled` as above. Selecting a
workspace routes its requests and sockets to that deployment.

## Impact on the product contract

None to what a Space, Channel or Breakout is, or to what the agent may do. The
brief describes the client as "a secure Electron shell"; this adds a second
member client with a smaller feature set. Authorization stays on the server;
nothing in this PRD lets a browser session do something a member's bearer
session could not.

## Decision log

### 2026-10-03 — The browser connector list names whole Google connections

**Decided:** `browser-connectable-capabilities` defaults to every capability of
the two Google connections the UI offers: Gmail with Calendar
(`gmail.*`, `calendar.*`) and Drive with Docs and Sheets (`drive.read`,
`docs.*`, `sheets.*`). A connection is offered in the browser only when every
capability it asks for is listed.

**Why:** Each tile starts one authorization for its whole set, so a list of
Gmail and `drive.read` alone would have left both tiles disabled. This answers
the open question on what counts as "Google Drive".

**Changes:** Supersedes the Rollout default of four capabilities. The open
question is removed.

### 2026-10-03 — Browser notifications are turned on in Settings

**Decided:** The browser's notification switch is in Settings → Notifications,
"In this browser", in place of the Mac's section, rather than in the account
menu.

**Why:** The desktop already keeps this switch there, and the browser shell is
the desktop shell; one place for it on both clients.

**Changes:** Product behavior said the account menu offers **Turn on
notifications**; it does not.

### 2026-10-03 — The capability list is a JSON flag Ace provisions but does not edit

**Decided:** Ace's deploy creates `browser-connectable-capabilities` as a JSON
flag, the way it creates the agent model flags, and the API reads it with
`getObjectDetails`. Its value is edited in the Flagship console; Ace's own
editor manages Booleans and model routes only. It falls back to the launch set,
not to nothing.

**Why:** Ace has no list editor, and building one for a ten-item list nobody
has asked to change yet is more than the decision needs. The flag can still
change without a deploy, which is what the product asked for.

**Changes:** Narrows the Rollout statement that the flag is "registered in
Ace": it is provisioned by Ace, edited in Flagship. Adding an Ace editor is
deferred until the list needs changing often.

## Key design decisions

1. **Reuse the desktop renderer, do not fork it.** The browser mounts the same
   shell and providers through `browserBridge` and the cookie session.
   Rejected: a separate web UI, which would be a second product to keep in
   step.
2. **Widen the cookie adapter's allowlist rather than adding a second auth
   path.** Add `spaces`, `projects`, `onboarding`, `work-opportunities`,
   `digest`, `push-devices` and `workspaces` to the route families in
   `apps/api/src/routes/browser.ts`. Each route keeps its own role checks; the
   adapter stays the only place a cookie becomes a bearer, and the Origin gate
   is unchanged. `auth`, `internal`, `ingest` and `dev` stay out.
3. **Same socket swarm per tab as desktop.** Chosen for switching speed (goal
   4). The cost is that each tab handshakes its feeds one at a time, because
   Chromium serializes handshakes to the same endpoint and the browser has no
   Node broker to avoid it, and that tabs multiply sockets and ticket requests.
   Worst case per member is roughly 20 feeds × open tabs, each ticket a cookie
   resolve and token mint. Rejected: the iOS-style smaller set (slower
   switching), focus-only or leader-tab swarms (more client logic), a
   SharedWorker broker (uneven support, does not fix serialization), and a
   multiplexed socket (rejected repeatedly in
   [`websocket-architecture.md`](../../websocket-architecture.md) as a
   throughput bottleneck).
4. **Connector OAuth returns to the browser by an explicit browser return
   target.** The start request names the browser host; the API stores a return
   target under `BROWSER_APP_ORIGIN` and the callback redirects there.
   Rejected: letting the popup land on the desktop handoff page, which tells the
   person to return to an app they may not have.
5. **The browser-connectable list is a flag, and it is presentation only.** It
   decides which connector capabilities the browser offers to start. It does not gate the
   API: a member's cookie session could already start any connector, and the
   flag does not change who may connect what. Rejected: a registry field, which
   needs a deploy to change.
6. **Inline artifact preview uses a sandboxed iframe.** This reverses the
   recorded rule in [`live-web-artifacts.md`](../../live-web-artifacts.md) that
   the renderer never embeds artifact content. The Mac app keeps its
   `WebContentsView`, but the serving-policy change applies to every artifact
   response, whatever client loads it: artifacts become frameable by exactly
   one origin. See **Security and trust model**.
   Rejected: new tab only, which the guest host does today.
7. **Region support is built now**, before a second deployment exists. It
   cannot be proven against production until one does.

## Regional impact

The browser Worker drops its Global-only check and gains one service binding
per configured deployment from `config/regions.json`. The browser cookie is
already per region (`__Host-rally-browser-<region>`), so one host origin holds
one cookie per deployment. Each deployment adds `app.rallywith.ai` to its
`ALLOWED_ORIGINS` and sets `BROWSER_APP_ORIGIN`.

Google identity remains a Global identity. Discovery and activation stay on
Global, because `PlatformOnboardingService` is Global-only:

1. The browser lists workspaces through a new Global `/browser` route that
   resolves the Global browser cookie and runs the same cross-region discovery
   desktop runs through `/onboarding`.
2. Activating a workspace in another deployment posts to a Global `/browser`
   route. Global activates it over the existing cross-region bridge and asks
   the target deployment, server to server, to register a browser session for
   that identity. The target's `BrowserSessionService.register` needs a
   region-local unbound identity session, so the bridge call creates one there
   first, as desktop activation does for its regional credential.
3. Global's response carries `Set-Cookie` for `__Host-rally-browser-<region>`.
   It reaches the browser through the browser Worker on the app host, so the
   host-only cookie is valid. No bearer or regional credential passes through
   JavaScript or a URL.

From then on, requests for that workspace go to `/regional/<region>/browser/*`
and the target deployment resolves its own cookie. The exact bridge contract
belongs in a `design.md` before this goal is built.

Scoped invitation links name no region, so a second deployment needs its own
invitation routing, per [`regionalization.md`](../../regionalization.md).

## Security and trust model

- **Cookie routes grow.** More route families accept a cookie-derived bearer.
  The Origin and `Sec-Fetch-Site` gate on unsafe methods is unchanged, and every
  forwarded response keeps the sandbox CSP and `nosniff`.
- **Artifact iframe, app side.** The browser shell's CSP gains `frame-src` for
  the artifact serving host. The artifact host is a different registrable
  domain, so framed artifact script runs in the artifact's own origin and cannot
  read the app's cookies or DOM. The `sandbox` attribute must include
  `allow-same-origin`, `allow-scripts` and `allow-forms`: without
  `allow-same-origin` the artifact gets an opaque origin, its code-redemption
  POST sends `Origin: null` and the fetch-metadata check refuses it, and its own
  `connect-src 'self'` calls lose their identity. The sandbox withholds top
  navigation and popups. What is accepted:
  remote model-authored content renders inside the app's window and can
  `postMessage` the parent, so the app must ignore messages it does not expect.
- **Artifact iframe, serving side.** Every artifact response sends
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`
  (`apps/api/src/artifacts/serving-policy.ts`), so a `frame-src` alone loads
  nothing. The policy changes to `frame-ancestors` naming exactly
  `BROWSER_APP_ORIGIN`, and drops `X-Frame-Options`, which cannot express an
  allowlist and which CSP `frame-ancestors` supersedes. An artifact still cannot
  frame another artifact, because the artifact host is not in that list.
- **Artifact viewer cookie in a frame.** The viewer cookie is `SameSite=Lax`, so
  a browser does not send it inside a cross-site iframe and a framed artifact
  would load as anonymous. The framed path needs a `SameSite=None; Partitioned`
  viewer cookie, keyed to the app as top-level site. A browser that refuses it
  falls back to the public representation and the pop-out link, as **Product
  behavior** says. Top-level artifact navigation keeps the current `Lax` cookie.
- **`live-web-artifacts.md` is updated** in the implementing change to record
  the browser exception, the serving-policy change, and why.
- **Google sign-in.** The API-hosted Google callback cannot set the browser
  cookie: `__Host-rally-browser-<region>` is host-only to `app.rallywith.ai`.
  The browser therefore gets its own Google identity redirect URI on the app
  host, `https://app.rallywith.ai/regional/global/browser/google/callback`,
  which the browser Worker forwards to a new `/browser/google/*` route on the
  API, alongside the existing `/browser/email/*`. It is not under `/auth` and not
  behind the `/browser/api` adapter, and it has its own browser-specific start
  route that is not tied to a desktop PKCE attempt. The API completes Google's code exchange there and its
  `Set-Cookie` reaches the browser as a same-origin response. No Rally
  credential appears in a URL or in JavaScript; the only value in the URL is
  Google's one-use authorization code, as in any web OAuth flow. Rejected: an
  API callback that redirects with a Rally login ticket for the page to redeem,
  which puts a Rally credential in a URL. The desktop callback and its
  `allowedReturnUri` schemes are unchanged.
- **Connector return target.** The stored return target is accepted only when it
  is under `BROWSER_APP_ORIGIN` or a desktop scheme. Nothing caller-supplied
  chooses an arbitrary host.
- **No tokens in JavaScript.** The browser keeps HttpOnly cookies only, as
  [`browser-sessions.md`](../../browser-sessions.md) requires.
  `browserBridge`'s in-memory bearer path stays a development path.
- **Web Push keys.** The VAPID private key is a Worker secret per deployment.

## Provider configuration

- **Google:** add `https://app.rallywith.ai/regional/global/browser/google/callback`
  as an authorized redirect URI on the identity OAuth client, before the browser
  Google sign-in ships; without it Google refuses the browser flow with
  `redirect_uri_mismatch`. Connector callbacks stay on the API host and need no
  change.
- **Web Push:** generate a VAPID key pair per deployment; store the private key
  as a Worker secret and serve the public key to the client.
- **Cloudflare:** a service binding from `rally-browser` to each regional API
  Worker.

## Rollout

Ships to everybody on merge; no flag gates the member shell. One flag is
introduced because the product asked for a list it can change without a
deploy:

- **Key:** `browser-connectable-capabilities`. A string-list flag, not a
  Boolean, so it does not take the `-enabled` suffix that marks a managed
  Boolean. Value: connector capabilities the browser may start an authorization
  for. It lists capabilities rather than connectors because Gmail and Drive are
  capabilities of the one `google` connector, which also carries Calendar, Docs
  and Sheets. Default: `["gmail.read", "gmail.draft", "gmail.send",
  "drive.read"]`, matching goal 7.
- It is registered in Ace in the change that introduces it, per
  [`feature-flags.md`](../../feature-flags.md#adding-a-flag). It is the first
  non-Boolean client flag; that document gains the type in the same change.

To turn the member shell off, the browser entry falls back to the guest
navigation for every session; members keep using the Mac app.

## Acceptance

- A member signed in with Google sees every Channel the Mac app shows them,
  including one reached only through General.
- The same member signed in by email reaches the same identity and workspaces.
- Another member sees the browser member as present in a facepile.
- Unread and running badges update live for a Channel that is not open.
- Switching to a pinned Channel after warmup shows its feed without a loading
  state.
- Gmail and Drive connect from the browser in personal and workspace scope; the
  popup closes and the card completes. Every other connector is disabled with
  the Mac app text.
- A Web Push notification arrives with the tab closed and opens the
  conversation.
- A live artifact previews inline in the rail.
- Conversation import, embedded browser and OS-level settings are absent or
  marked Mac-only.

## Open questions

- **Popup or full-page redirect for OAuth?** A popup keeps the member's place;
  a redirect is simpler and immune to popup blockers. Does not block the build.
- **Duplicate pushes.** Each browser registers its own subscription, and a
  member with the Mac app and a browser gets each push on both. Should a push be
  sent to every registered client, or suppressed for the others while one client
  is in the foreground? Does not block the build.
