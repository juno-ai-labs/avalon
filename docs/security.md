# Security model

This document owns Rally's trust boundaries: what is treated as untrusted, what
each trusted component is trusted *for*, and the mechanisms that keep the two
apart — renderer isolation, OAuth and session handling, connector credential
encryption, webhook verification, the model boundary, audit logging, and secret
handling.

Read it before changing any of those, before adding a surface that receives
outside input, and before adding anything to `application-settings.json`, the
preload bridge, or the `VITE_` allowlist. Everything here is a boundary someone
outside this document can break without their own tests failing.

Ordinary member search and resource reads use the [authorization primitive](authorization.md):
five-minute freshness is a design goal, not a permission lease or request timeout.
Canonical permission checks share observations within a batch. Attachment and
artifact reads authorize once per operation. The session query's membership
proof supplies the current incarnation to migrated grant checks. No grant decision is retained across requests.
Queue-maintained attachment discovery can lag source changes, while a
positive result still requires its canonical grant. New requests pass session and
workspace-membership middleware. This does not relax mutation checks, socket
admission, or local socket visibility/revocation. Missing authority remains a
retryable failure for direct reads and explicit partial status for resource
lists; member search omits the candidate and reports nothing, because its
decisions are registered from the mutation side before the search needs them.
Member search candidate pagination exposes matching-index continuation even when
no candidate on a page is admitted. Repeated substring queries and correlation
with known source IDs can reveal content matches; this API does not promise
concealment of that inference. Projected search admission controls returned
content; excerpts, titles and archive state are served from the index within the
projection's staleness window rather than reloaded from their owners.
The operation-level and pagination contracts are detailed in [authorization](authorization.md).

[Attachment image caching](attachment-preview-cache.md) stores account- and
Organization-scoped bytes on the device. A new read validates the current
resource revision and canonical access before reusing them; HTTP 304 uses the
same once-per-request admission as a full preview. Sign-out and Organization removal use the existing
local-cache wipes, with a shared storage generation fencing image saves in
other browser tabs. A 403/404 response removes the saved image bytes. Persisted
bytes never serve as a permission lease.

## Sidekick authoring and loading

Sidekick delegation is separate from human reader/manager access. WorkspaceDO
stores per-user grants with membership incarnations, ordered mutation receipts
and withdrawal tombstones. [Sidekick lifecycle](automation-lifecycle.md#delegation-consent-authority)
owns mutation ordering and rollout. Creation immediately enrolls the creator,
including autonomous creation. Agent tools may target any current Organization
user; the execution actor remains host-owned and needs Sidekick access to change
another user. Target enrollment needs active membership. Delegation grants no
human reader or manager rights, and execution still requires ordinary eligibility
and provider access. No direct-human consent classifier or self-only agent
restriction is applied. Own withdrawal and safe stored-label recovery remain
available after access loss. Receipt replay never prepares a fresh grant and a
newer withdrawal invalidates older allow acknowledgements.

Conversational publication resolves the current workspace membership role and
owning-workstream participation through the same actor path as management routes.
A ready model submission publishes under that actor, while automation run contexts
do not receive the authoring plugin. Loading uses owner authorization for the
execution principal and the entire conversation audience. Catalog metadata is
escaped and treated as data; admitted instructions remain subordinate to platform
policy and the current request. Neither loading nor attachment grants access to
the source credentials, memory, authoring conversation, or run history.

Wizard-only run inspection follows the authority, resource reauthorization and
bounded-evidence contract in [Sidekick lifecycle](automation-lifecycle.md#sidekick-publication-and-loading).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/main/index.ts` | Window creation, sandbox and `contextIsolation` flags, navigation denial, IPC handler registration. |
| `apps/desktop/src/main/media-permission.ts` | Chromium media permission for the shared composer: audio-only capture from the main and Sidekicks windows. |
| `apps/desktop/src/main/embedded-browser.ts` | Isolated web contents for the local browser in the right rail and the import window; its lifecycle and command boundary are documented in [`embedded-browser.md`](embedded-browser.md). |
| `apps/sideline/src/main/index.ts`, `apps/sideline/src/preload/index.ts` | The internal represented-messaging host, encrypted operator session, dedicated OAuth target, sender-confined IPC, and narrow renderer bridge. Main also holds one ticketed workspace socket (fixed `app://sideline` Origin) and sends the renderer only a payload-free `sideline:catalog-stale` signal. The relationship and audit boundary is documented in [`impersonation.md`](impersonation.md). |
| `apps/desktop/src/preload/index.ts` | The whole renderer-facing API. Nothing else crosses. |
| `apps/desktop/src/common/realtime-socket-validation.ts`, `apps/desktop/src/main/realtime-socket-ipc.ts` | Shared broker channel/event validation and the conversation-window socket IPC boundary. |
| `apps/desktop/src/main/realtime-socket-broker.ts` | Route-confined Node socket transport, ordered system/PAC routing, OS trust roots, frame limits, and renderer-owner teardown. |
| `apps/desktop/src/renderer/index.html` | The Content Security Policy. |
| `apps/desktop/src/main/theme-assets.ts` | The private remote-font cache that keeps the renderer off remote font hosts. |
| `apps/desktop/src/renderer/components/markdown-mermaid.tsx` | The one generated-SVG boundary in Markdown: strict Mermaid configuration, disabled HTML labels and interactions, and source fallback. |
| `apps/desktop/src/main/session-encryption.ts`, `stored-auth.ts`, `stored-session.ts`, `session-file.ts` | The versioned credential envelope and the serialized session-mutation boundary. |
| `apps/desktop/src/main/lockdown-mode.ts` | The `safeStorage` mode and its migration. |
| `apps/desktop/src/main/application-settings.ts` | The shared write queue every preference goes through. |
| `apps/desktop/src/main/native-crash-generation.ts` | The route-final directory and deadline boundary around Crashpad's potentially content-bearing local database. |
| `apps/desktop/src/main/debug-settings.ts`, `developer-settings-flag.ts` | Debug enabled, and the flag that suppresses it. |
| `apps/api/src/middleware/auth.ts` | Session, workspace, role, and principal resolution on every request. |
| `apps/api/src/middleware/validation.ts` | Request parsing at the HTTP boundary. |
| `apps/api/src/middleware/request-context.ts` | Exact desktop-origin CORS policy, request IDs, regional assertion, and response security headers. |
| `apps/api/src/lib/crypto.ts` | AES-GCM credential envelopes and key-version handling. |
| `apps/api/src/services/terminal/` | The isolated Daytona execution boundary, network compiler, authority-fenced lifecycle, resource bridge, and trusted GitHub publisher. |
| `apps/desktop/scripts/mac-signature-policy.mjs`, `apple-notarization.mjs`, `finalize-macos-release.mjs` | Entitlement rules, notarization, and the release verifier. |
| `apps/ios/Rally/Auth/KeychainStore.swift`, `apps/ios/Rally/Rally.entitlements` | iOS session secrets and APNs/associated-domain entitlements. Owned with [`ios-client.md`](ios-client.md). |
| `.gitleaks.toml`, `scripts/gitleaks-allowlist.test.mjs` | The scan's bounded exceptions and the test that keeps them honest. |

The renderer socket-ticket lint rule follows immutable awaited ticket aliases,
including transcription tickets acquired before capture setup finishes. Aliases
from shadowed or reassigned bindings are rejected; the constructor remains
checked instead of carrying a local lint suppression.

### Trust boundaries

The renderer, inbound internet, connector providers, monitored URLs, model
output, and connector payloads are untrusted. The Electron main process and
regional Worker are trusted only within their narrow responsibilities. D1 and R2
are canonical storage services, not authorization layers.

iOS has no renderer. The comparable split is the SwiftUI process (untrusted for
secrets it does not need) versus the Keychain (identity and workspace refresh
tokens) versus the regional Worker. Google credentials stay in
`ASWebAuthenticationSession`. Refresh tokens are
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and are never written to
UserDefaults or iCloud. Socket tickets still travel as `Sec-WebSocket-Protocol`,
same as desktop.

### Electron

- `contextIsolation` is enabled, Node integration is disabled, and sandboxing is
  enabled.
- The packaged preload is emitted as CommonJS so Electron can load it inside the
  sandbox. Its bridge exposes a small named API and never exposes `ipcRenderer`,
  environment variables, filesystem paths, or arbitrary channel names.
- Every IPC argument is parsed before use.
- Chromium media permission is a second grant on top of macOS System Settings,
  and it is per WebContents. `allowsTrustedAudioCapture` admits the main window
  and the Sidekicks window only, and only for audio: both host the shared
  composer, and Sidekicks can outlive the main window. Settings, the import
  window, the deep-link failure window, detached artifacts, and the embedded
  browser are refused. Camera, display capture, and mixed audio+video stay
  denied. Computer-audio tap IPC remains main-window-only because the composer
  never requests it.
- Four window kinds are trusted IPC senders: main, Sidekicks, settings, and the
  deep-link failure window. Handlers that must not be reachable from every one of
  them narrow further — `assertDeepLinkErrorIpcSender` admits only the failure
  window, because its channels read and close that window. The failure window's
  message travels as a string, and one deep-link message interpolates the link's
  own `error` parameter, so text chosen outside Rally can be displayed
  always-on-top under Rally's name; `DEEP_LINK_ERROR_MESSAGE_LIMIT` bounds it and
  is currently open. See
  [`deep-link-failures.md`](deep-link-failures.md#failure-modes-and-limits).
  Admitting that window to the shared check widens what it *could* call to every
  handler behind `assertTrustedIpcSender` — `system:open-settings` and
  `system:open-external` among them — which it has no reason to. It is kept
  there because its renderer is the application's own error telemetry and theme
  code, which does invoke on that boundary, and because the window renders one
  string with no scripting, no session, and no network of its own. That balance
  holds only while the window stays this small: give it any further UI and its
  privileges should be narrowed to the channels it actually uses first.
- Detached artifact renderers remain outside the trusted-window sender set.
  `artifact:window-action` admits only a registered detached renderer and maps a
  strict operation union to the resource in main's window record. Rename,
  Archive, pinning and navigation-link coordinates derive their thread from
  that record's Main annotation scope and owning surface eligibility; the server
  still authorizes each route.
  Read/content/version/site-data and frozen-page preview operations cannot name another resource or an
  arbitrary API path. Credentials stay in main, which checks session ownership, including the opening region,
  again after asynchronous work and uses fresh site access for external opens.
- App-window navigation and popup creation are denied by default; Rally's own
  OAuth opens in the system browser. The embedded browser's isolated web
  contents handle website links and redirects within their own session, with
  non-web destinations rejected.
- The main window and the import window may drive their own browser tabs,
  including page script and DevTools commands; no other window may. Those
  commands act with the person's website sign-ins, so a script injected into
  either renderer would reach every site signed in there. A conversation import
  hands that capability to a model: its agent runs arbitrary page script in the
  person's signed-in tab, reads the page's outline and screenshots, gives it
  input, and lists and reads the network responses the tab received. Those
  results — network bodies included — reach the model unredacted, by product
  decision: the page already received them. The boundary is the tab: one tab,
  with no other tab and no DevTools passthrough. Where that tab goes is not
  restricted, by product decision: it may navigate to and load from any site
  with the person's session, and there is no egress filter on the page. The
  import window is the
  one non-conversation window allowed to open a realtime socket, to the hidden
  conversation its agent runs in, and it closes that socket when the window
  navigates, crashes or closes. See [`desktop-actions.md`](desktop-actions.md)
  and [`session-import.md`](session-import.md).
- Browser orchestration scripts execute in a separate sandboxed, ephemeral
  WebContents with no Node/preload and a network/frame-denying CSP. Only closed,
  typed requests reach the pinned browser tab; browser/tab closure or run
  termination disposes that realm. See [browser script runtime](browser-script-runtime.md).
- A strict Content Security Policy allows bundled content and the configured
  regional API only.
- Markdown treats model, member, email, and attachment text as untrusted.
  `react-markdown` evaluates no raw HTML. A fenced `mermaid` block is the one
  generated-markup path: Mermaid runs with `securityLevel: strict`, HTML labels
  and interaction disabled and those settings locked against diagram
  frontmatter before its sanitised SVG is inserted. The application never calls
  Mermaid's binding callback, so a diagram cannot install click handlers. A
  rejected parse leaves the original source visible.
  HTTP(S) link favicons are fetched only by the authenticated regional API,
  never by the renderer from the model-chosen destination. The service accepts
  public domain names only, uses the existing Firecrawl client to discover a
  public HTTPS favicon URL, rejects image redirects, bounds the body read at
  Cloudflare KV's value limit without a second retained chunk copy, applies a
  25-second deadline across branding discovery and the origin response,
  validates image bytes, and keeps only a 30-day platform-wide KV entry. The
  renderer requests each HTTP(S) anchor and each web citation's marker when its
  message renders, receives the cached bytes, and exposes them through a
  revocable local object URL. Both go through the regional Worker; neither
  position ever contacts the destination, and the marker's request is skipped
  entirely for a still export.
- Refresh material is encrypted in the main process. One versioned envelope
  holds the Global identity credential plus one credential/profile binding per
  activated workspace; renderers receive only the active short-lived session.
  Sign-out snapshots that set, deletes every local credential/profile and draft,
  and closes authenticated windows before attempting remote logout for the
  identity and each regional workspace. Remote cleanup failures are reported but
  cannot restore local authority.
  By default the desktop uses an application-wide embedded key so the saved set survives signing-identity
  and keystore changes. Application → **Lockdown mode** replaces that with
  Electron `safeStorage`, binding the saved authentication state to the
  operating-system keystore. An in-app toggle re-encrypts every durable session
  component before committing the new preference. The plaintext preference lives
  in owner-readable `application-settings.json` under Electron's `userData`
  directory. If that file is edited to turn Lockdown off while a Lockdown
  credential envelope remains, Rally removes only local credential-bearing files
  and requires sign-in instead of exporting the protected session. An unavailable
  keystore also turns Lockdown off and requires sign-in automatically. The
  renderer receives short-lived access only through the narrow session bridge.
- Product telemetry around Lockdown mode contains only availability plus the
  previous, requested, and applied booleans after the main-owned transition
  completes. It never contains credential state, keystore identity, encrypted
  bytes, error bodies, or session material. Failed and rolled-back transitions
  emit no completion event.
- The custom `avalon://` callback carries only an opaque, expiring, single-use
  login ticket or a non-secret connector result — never provider codes or tokens.
- Unsent composer drafts — their text and the bytes of their attachments — are
  cached in the renderer's IndexedDB so a restart does not discard them. They are
  workspace content stored unencrypted under Electron's `userData` directory,
  keyed by workspace, they expire after 12 hours, and signing out deletes every
  one of them. Leaving deletes only that workspace's scope. No credential is
  ever written there.
  [`composer-drafts.md`](composer-drafts.md) owns the mechanism.
- The local cache is the other thing the renderer writes under `userData`: the
  last first page of the workspace directory and, for every conversation the
  directory still lists that the reader opened or the socket pool warmed, its
  detail and opening transcript ranges, in a second unencrypted IndexedDB
  database keyed by account and workspace, so a second account on the device
  never reads the first's rows. It is bounded by membership as the device can
  observe it rather than by time: the live directory and child rosters retire
  rows the device missed, an access revocation or archive removes them at
  once, leaving a workspace or being refused by one removes that workspace's
  scope, and signing out or another account taking over removes all of them.
  A removal from a workspace the client never tries to open again stays on the
  disk until sign-out. No credential is ever written there.
  [`local-cache.md`](local-cache.md) owns the mechanism.
- The macOS menu bar status item is built entirely in the main process, from
  values the regional API returned, and the renderer's only reach into it is
  `application-settings:set-menu-bar-enabled` and
  `application-settings:set-launch-at-login`, each of which accepts a boolean and
  nothing else. The menu itself holds no control for state the operating system
  owns independently — whether Rally opens at login is a Settings toggle, read
  back from macOS on every read rather than from Rally's preference file. Its
  content requests reuse the stored access token and regional endpoint through the
  same coalescing refresh as the feature-flag poll, add no credential storage, and
  reach only `/workstreams` and `/work-opportunities`. The work-stream titles they
  return are workspace content held in main-process memory only, never written to
  disk, and dropped on sign-out. Because Rally registers itself to open at login
  and starts hidden there, this runs with no window and no renderer;
  [`menu-bar.md`](menu-bar.md) owns the mechanism. Its preference shares
  `application-settings.json` with Lockdown mode and therefore the same shared
  write queue described below.
- Saving one of Rally's messages as a picture or a PDF renders it in a hidden
  window that is deliberately *less* privileged than any other: no preload and
  therefore no bridge, no Node, no devtools, sandboxed, and served a document
  under `default-src 'none'; img-src data: https:; style-src 'unsafe-inline'`.
  That document is built from text a model wrote, so it is given a scheme of
  its own — `rallywithai-export://`, one in-memory document per single-use
  token — rather than the renderer's origin. Its IPC entry point parses all four
  fields of the request, and the file name it proposes to the save dialog is
  *rejected* unless it matches `^[a-z0-9][a-z0-9-]{0,79}$`, because that name is
  derived from the message's own text. The only thing written is the file the
  person chose in a native dialog. [`message-export.md`](message-export.md)
  owns the mechanism.
- The native Settings window uses the same sandbox, preload, CSP, navigation
  denial, and regional session bridge as the main window. **Command-,** opens a
  singleton window rather than a privileged remote page. It holds no workspace
  socket while the main window publishes one through main; that relay's sender
  checks and what may cross it are in
  [`websocket-architecture.md`](websocket-architecture.md#one-workspace-socket-per-desktop-the-organization-sync-relay).
- Application → Developer → **Debug enabled** shares the same
  `application-settings.json` file but crosses no trust boundary: it only reveals
  debugging affordances the renderer already holds, such as copying a work
  stream's or automation's identifier from its right-click menu or reading the
  wiring rows of the right rail's **Details** section. It is off by default and
  turning it on grants no additional data, capability, or IPC surface. The section
  it sits in is offered only where the service's `developer-settings` flag says
  so, and the main process reports the stored preference as `false` while that
  flag is off, so a hand-edited `debugEnabled: true` reveals nothing — see
  [`feature-flags.md`](feature-flags.md). Who the flag reaches is a Flagship
  targeting rule rather than a condition in the Worker, which is sound precisely
  because this is a product scope on a staff tool and not a confidentiality
  boundary — the same reason a poll that cannot reach the service keeps its last
  answer rather than closing the section. **Nothing that protects data may be
  scoped this way.**
- Because the two preferences have separate owners that serialize on different
  primitives, **every write to `application-settings.json` goes through one shared
  queue and re-reads before it merges**: a lost update here would leave an off
  Lockdown preference beside a Lockdown envelope, which the next launch treats as
  an out-of-app edit and answers by deleting the stored credentials.
- Telemetry is a main-process capability, not a renderer transport. The preload
  exposes only registered screen, product-intent, error-candidate, preference, and
  redacted-inspector operations; main validates sender and schema, resolves route
  and random analytics identity, and owns all files and requests. Renderer code
  never receives a PostHog token, route capability, dump path, spool path, raw
  breadcrumb ring, or generic event/property API.
- Crashpad has no submission URL and writes inside an owner-only, route-final
  generation. Main may atomically invalidate the sibling manifest while the
  handler runs, but it never opens or mutates the live database. A later launch
  rotates or purges the whole inactive generation before starting another handler.
  This is the only safe point to enforce opt-out, region, and the local deadline.
- Restricted telemetry operations use a separate per-region bearer credential,
  not a desktop session or request-supplied role. The Worker resolves the fixed
  operator UUID and role with timing-safe token comparison — `support` and
  `security` from `TELEMETRY_OPERATORS_JSON`, `demos` from the separate
  `DEMO_OPERATORS_JSON`; every operator router names the roles it admits and
  the secret it reads, so the `demos` role reaches only the demo preparation
  and workspace retirement routes Ace calls
  ([`demo-workspaces.md`](demo-workspaces.md#preparing-a-demo)), and neither
  telemetry role reaches those. Ace holds one `demos` token per region, each
  known to that region alone. Raw access and replay derive audit identity from
  that principal; neither endpoint accepts an operator ID or role in its body.

### macOS distribution and updates

Rally's production identity is pinned to bundle ID `ai.rallywith.desktop` and
Apple team `7ZLT6A8W25`. Release packaging never auto-selects a certificate.

**Squirrel.Mac cannot safely update across either boundary.** The team has not
moved, but the bundle ID has — it was `app.rally.desktop` before the rename to
Rally — so the release that carries the rename cannot reach an installed Avalon
build through the ordinary update path, and needs a deliberate manual-reinstall
migration instead. That is a release-sequencing decision rather than a packaging
one: nothing in this repository can make an installed build accept a bundle it
does not recognise as itself. The consequence of getting it wrong is silent —
those installs simply stop receiving updates, with no error on either side — so
the migration has to be planned before the rename ships, not discovered after.
[`runbook.md`](runbook.md) carries the procedure.

The main app and Electron helpers use separate entitlement files. In particular,
renderer/GPU/plugin helpers, Squirrel `ShipIt`, and `chrome_crashpad_handler` must
contain exactly `com.apple.security.cs.allow-jit` and
`com.apple.security.network.client`. Restricted `com.apple.developer.*`
entitlements are forbidden there: a provisioning profile for the main bundle ID
does not authorize helper bundle IDs, and macOS AMFI can otherwise kill those
helpers only after the app reaches another machine. The release verifier parses
the final signed entitlements, requires the pinned Developer ID team and an arm64
slice for every one of those executables, and then proves a renderer remains alive
under a clean user-data profile.

Both `Rally.app` and the DMG container are signed, submitted to Apple's notary
service, and stapled. The DMG is blockmapped only after signing and stapling
mutate its bytes; `latest-mac.yml` is generated from the final ZIP. Before R2
promotion, Gatekeeper, stapler, bundle ID/version, updater URL, final blockmaps,
nested signatures, and a LaunchServices smoke all have to pass. The update
transport is still treated as untrusted: electron-updater's macOS signature
validation remains the execution trust boundary, while R2 publication uses
immutable versioned objects and promotes only validated mutable channel feeds.
The trusted renderer's `checkForUpdates` preload method invokes the same manual
update check as the application menu. Its argument-free `update:check` handler
checks the IPC sender and accepts no feed URL, version, or connector-supplied
destination.

### Authentication and authorization

[Email sign-in](email-login.md) owns the configured passwordless challenge and
resumable identity-session protocol. It does not itself grant workspace access.

[Browser sessions](browser-sessions.md) place an opaque HttpOnly, host-only cookie
in front of the same session authority. Only `/browser` accepts that cookie;
mutations require the exact configured Origin. Workspace selection addresses a
separate incarnation-bound session per workspace, so tabs cannot switch each
other's authority. The HTTP adapter mints a request-local bearer internally and
never exposes desktop session tokens in browser JSON. The same-origin browser
host serves the lite client with shared collaboration components and ticketed sockets.

Google identity OAuth uses state and PKCE. The desktop starts it with POST, then
opens only the provider URL containing opaque state. Every desktop identity and
connector callback is completed by the owning regional server before the temporary
`/auth/desktop/` page receives an exact custom-protocol target in its URL
fragment. The browser client's Google callback is the exception: it lands on the
browser host, requires a state cookie matching `state`, and sets the browser
session cookie directly; see [browser-client.md](browser-client.md#google-sign-in). The page applies `no-store`/`no-referrer`, removes the fragment
immediately, and never renders or logs the target. Connector consent is a separate
incremental flow whose durable attempt result lets the desktop reconcile success,
denial, failure, or expiry even if the custom-protocol notification is lost. OAuth
states and desktop tickets are expiring and atomically consumed. Refresh tokens
are hashed for sessions or AES-GCM encrypted for providers.

Every resolvable connector callback and every newly emitted workspace-scoped
external link carries `(region, workspace_id)` as routing context. Those values
are public identifiers, not bearer authority. Scoped invitation links follow the
same rule: since shares are claimed by signing in with the shared-with address,
the email links to the conversation's own addressed path, so a forwarded copy
tells its reader the region, Organization and Channel ids while opening nothing
for them. Hiding those ids took an opaque token and a store behind it, and the
token's only other job, the acceptance secret, went with the acceptance step.

Claiming has two consequences worth knowing. A share to an address that already
has an account is claimed as it is made, so it adds that person to the
Organization as a guest without them confirming anything, and the sharer can
tell from the response and the Guest list whether the address has an account.
Both follow from the product decision, confirmed by the product owner on
2026-10-06 and recorded in the guest-sharing PRD, that proving the mailbox at
sign-in is the only consent a share needs. See
[`scope-invitations.md`](scope-invitations.md). The renderer must enter the target
through Electron main, verify the returned session names the exact pair, and
only then use the destination. Main answers a link that names the active
workspace with the session already in use, and every other target reaches the
platform membership path through activation; a stored credential for a
workspace that is not active is never enough to switch on, because an ended
membership leaves its session row alive and only the platform refuses that link
before the window moves. The regional middleware resolves active membership and
workspace scope on every request under either path. A failed activation cannot
fall back to the currently active workspace or search other stored credentials.

Identity and workspace middleware share one authenticated context within a single
HTTP request. Identity middleware admits a guest relationship with a null role
only when its current active membership and session incarnation match. Workspace
middleware still requires a workspace and member role for member-only routes.
Conversation feed snapshots, tickets, read-state and child title changes use the
workspace-relationship middleware plus exact parent admission. For guests, that
admission requires completed grant authority, never legacy workspace-public
visibility. Identity-only sessions cannot enter either class of workspace route. Resource
metadata/content/version/preview reads also use workspace-relationship admission,
then canonical resource authorization. A guest's non-owned resource must have an
attachment in a granted migrated conversation; workspace-public legacy visibility
does not substitute for that grant. Admitted reads may finish after a concurrent
revocation; the next request authenticates and authorizes afresh. Resource and
artifact registry metadata travel with the owner facts and are disclosed only
after admission. Upload and unsent-draft deletion use the same
workspace relationship and ordinary ownership checks. Attaching an existing file
requires both target mutation authority and canonical source read access; unsent
uploads must use message admission so their reservation and publication are
preserved. Each new request verifies
its token and reads current regional session/membership state again. This is not
a cross-request cache and does not change revocation or regional isolation.

Guest Sidekick rails use exact conversation admission and source-owned summaries
rather than authoring details. A recommended or locally loaded ID still has to
pass the source's personal-audience or owning-workstream rule. New guest agent
runs discover only recommendations, workstream-owned Sidekicks and local loads;
existing execution snapshots keep ordinary source revalidation. Removing a local
load rechecks participation and archival state in that SubstreamAgent, without
changing Main, siblings or workstream recommendations. Source history and parent
management remain separate authorization paths.

Workspace sessions carry `workspace_incarnation`, bound to the exact membership
that admitted them. Migration 0110 backfills existing sessions; insert and
workspace-selection triggers bind newly selected memberships. Reassigning the
same workspace ID does not rebind a session. Promotion preserves membership
incarnation, while removal/rejoin creates a different one. HTTP authentication,
refresh rotation, and the workspace, Channel control and SubstreamAgent socket
session checks require the stored and current incarnations to match. Refresh performs
that check in the token-rotation update, so rejected old credentials do not
rotate the session. Identity-only sessions remain valid for workspace selection.
This supplements durable revocation delivery; it does not replace closing
already-open sockets when access changes.

Addressed native links use the distinct `workspace` host rather than routing
query parameters. A pre-addressing desktop therefore rejects them instead of
ignoring the target. Connector OAuth records whether its initiating desktop
advertised this version and returns the stored legacy or addressed URI unchanged;
deployment timing cannot silently reinterpret a callback.

Every API resource query includes `workspace_id`. Mutations additionally resolve
membership role. A connector ingress may assert a member's own authority by
marking its auth `principal: "connector"` — set only after verifying the account
link on the delivered message, re-checked against current membership by the
work-stream object, and refused by every socket-ticket issuer (see
[`workstream-durable-object.md`](workstream-durable-object.md#invariants)). The
demo seeder asserts a cast member's authority the same way under
`principal: "demo_seed"`, verified and refused identically; only server code
constructs either value ([`demo-workspaces.md`](demo-workspaces.md#security-and-trust-model)).
The resource-grant callback similarly uses the server-only
`principal: "resource_authorization"` after verifying OAuth state, connection
authority, and current membership; ordinary participants cannot supply its
reserved continuation-message ID.
Every connector tool checks its execution principal, connection
scope, granted capability, and resource visibility. Workspace-scoped connector
capabilities roll down to every work stream in that workspace and execute as the
workspace principal; participants do not implicitly share their personal
connectors.

WebSocket upgrades require an exact match against `ALLOWED_ORIGINS`; missing
origins and suffix lookalikes are rejected before the short-lived socket ticket is
forwarded to a room. Tickets bind user, workspace, work stream, region, and
one-time ID, and the room atomically rejects reuse. A feed ticket also binds the
authenticated role and regional work-stream authority generation. SubstreamAgent
may reuse those values only when they exactly match request-scoped in-memory
preparation revalidated against D1 during ticket transit and its local
generation. Every upgrade still reads current regional maintenance authority;
session/membership or local-visibility revocation fences or deletes preparation,
and its absence restores the full regional admission check. The ticket travels in
`Sec-WebSocket-Protocol` — the one handshake header a browser will set, through
the `WebSocket` constructor's `protocols` argument — as the sentinel
`rally.ticket.v1` followed by the ticket. Current clients never place it in the
query string: Cloudflare records whole request URLs into the invocation log, the
Logpush export, and trace spans, and no redaction in this repository can reach
them. All issuers return query-free URLs; the renderer and main broker discard any
query data returned by older servers before opening. The
server echoes only the sentinel, never the ticket, because a selected subprotocol
is a response header. [`realtime-sockets.md`](realtime-sockets.md) owns the
admission path.

Native renderer WebSockets may be constructed only from a URL returned by an
authenticated ticket endpoint; ESLint enforces that provenance at each
production constructor. Electron's Channel control and SubstreamAgent connections
instead cross a typed preload bridge to the main-process broker. Main accepts
that capability only from the primary application window, validates the URL
against configured regional `ws`/`wss` origins and the declared control/feed
route shape, rejects credentials and fragments, discards query configuration,
requires the public
ticket sentinel, and supplies the exact `app://rallywithai` Origin itself. The
renderer chooses only the validated ticket subprotocol offer that becomes
`Sec-WebSocket-Protocol`; it cannot choose arbitrary headers or turn the broker
into an arbitrary network client. Main tries only the ordered proxy directives
Electron resolved, including `DIRECT` only when policy supplied it, and Node
accepts no work-stream control/feed frame over the shared 1 MB application
limit. Runtime URL schemas likewise name their
accepted scheme contract explicitly — HTTP(S), HTTPS-only, `avalon:`, or the
intentional HTTP(S)/Rally handoff union. Bare Zod URL validation is forbidden
because it accepts non-web schemes such as `javascript:` and `data:` while hiding
the product boundary being enforced.

Renderer HTTP requests use the pinned application origin and the regional API's
explicit CORS origin, method, and header allowlists. Every custom header emitted by
the desktop must be named there and exercised by a production-shaped `OPTIONS`
test. Otherwise Chromium rejects the request before authentication or route code
runs, which appears to the renderer as a transport failure and leaves no API
request log for the blocked mutation. The required implementation and test steps
live in [When adding a new HTTP header](when-adding-a-new-http-header.md).
The message speech path follows that same boundary: the renderer sends its Rally
session to the regional `/speech` route, while Azure credentials remain Worker
secrets. Raw PCM returns as an in-memory response stream and never creates a
provider URL, preload capability, or broader media origin.

The same exact origin policy admits `https://rallywith.ai`,
`https://www.rallywith.ai`, `https://with-avalon.com`, and
`https://www.with-avalon.com` — the public site is served on both zones while
the rename is in flight, and an origin the browser actually used but the Worker
does not list is rejected by Chromium before any route code runs — so the public
site can call only the capability-bound anonymous telemetry surface from a
browser. CORS is not authorization: the
site receives no session, provider token, PostHog token, signing key, or named-RPC
authority. Its route lookup returns only a coarse two-value decision; its
capability permits only the registered pre-authentication event names. Handoff
tokens and resource identifiers remain in the local page parser and never become
telemetry properties.

### Side effects and retries

Tool arguments are runtime-validated and canonically hashed. The system records a
write as started before provider execution and reuses completed results on
workflow retry. If a process stops after a provider write but before confirmation
is stored, the invocation becomes `ambiguous`, the work stream becomes
`needs_input`, and the write is not automatically repeated.

This is retry safety, not a broad approval gate.

### Connector credentials

Provider refresh tokens remain in the regional backend, encrypted with AES-GCM and
additional authenticated data tied to the connection ID. Key version is stored
beside ciphertext so rotation can decrypt with an old key and re-encrypt with the
active key. configured deployments deployments use independent keys. Rotation itself is in
[Operations](#operations).

Granola Workspace API keys and the signing secrets returned while registering
Granola webhook endpoints use the same versioned credential envelope and
connection-bound additional authenticated data. The admin setup form treats the
key as a password and submits it once to the selected regional backend. Plaintext
keys and signing secrets are excluded from connection configuration, API
responses, provider identifiers, audit metadata, and logs. Personal Granola OAuth
and refresh credentials remain user-scoped; workspace keys remain
workspace-scoped.

Google scopes are requested incrementally. Sign-in does not grant Gmail, Calendar,
or Drive access. Revoked and expired grants become an explicit reconnect state.

### Workspace installation and cleanup authority

Ashby and Granola workspace setup binds an administrator's attempt and input
digest to a reserved connection before provider mutations. A provider whose
`create` is manual inverts that order: Fireflies' pasted key is validated
read-only *before* anything is reserved, because the create that would otherwise
reject it never happens, so without this a bad key would reserve a connection
and only report itself when somebody pressed Test. API keys and signing
material use the connection-bound regional credential envelope. Replacement
validates provider access and checks both generation and the current envelope
before committing, so a racing settlement cannot overwrite a newer API key.

Disconnect removes ordinary access atomically while retaining separate encrypted
cleanup authority. Only a claimed removal of an exact recorded provider ID may
use it; it cannot refresh, discover tools, create or update registrations.
Repeated disconnect preserves pending cleanup. An uncertain create's late result
is handled against its recorded intent without reviving access; forgetting local
cleanup authority leaves provider removal to the administrator. The existing Ace
`demos` operator role authorizes reviewed fleet maintenance, never arbitrary
provider requests or new customer event grants. Administrative mutations retain
actor-attributed audit records without keys or candidate content. See
[installation lifecycle](connector-installation-lifecycle.md).

### Webhooks

Generic webhooks use an endpoint-specific secret, a timestamped HMAC-SHA256
signature, a bounded replay window, a stored receipt, schema validation, size
limits, and provider dedupe keys.

Fireflies signs the body and nothing else: no timestamp header, no delivery id.
Rally verifies HMAC-SHA256 over the exact raw bytes against a single
`X-Hub-Signature` header — after the size cap and before any decode — then
anchors the replay window on the timestamp **inside** the signed body, which is
the only value in a Fireflies delivery an attacker replaying a capture cannot
move. With no delivery id the ingress receipt is keyed on the hash of those
bytes, so a replay is byte-identical and a genuinely new delivery never is. A
body that verifies but is stale is reported as its own failure rather than as an
invalid signature, so an administrator is not sent to rotate a secret when the
cause is a clock. The signing secret is **host-generated and revealed exactly
once**, at setup, because the provider has no registration API and the
administrator has to carry it to a dashboard by hand: it is absent from every
read path afterwards and is replaced by reconnecting, not by asking again.

Ashby verifies the exact raw body with HMAC-SHA256 before decoding, parsing or
regional persistence. Both dedicated ingress and regional receipt enforce the
existing `PROVIDER_WEBHOOK_MAX_BYTES` limit (1,000,000 bytes when unset;
2,000,000 in all three checked-in Wrangler configs), before buffering/forwarding
on ingress. Host-derived content hashes bind replay identity
to the same bytes except Ashby's email-change signal, whose documented retry
renews its watermark. That event compares normalized candidate identity while
retaining each raw delivery and its actual hash regionally; changed candidate
identity still conflicts. New setup discloses automatic organization event
subscriptions rather than offering a subset picker. The administrator authorizes
normalized organization notifications for the Rally workspace, including matching
workspace automations. That audience does not inherit individual Ashby MCP
permissions. Names and recruiting content stay out of normalized event summaries
and automation trigger messages; raw payload storage remains regional.

Granola webhooks are verified using the Standard Webhooks `webhook-id`,
`webhook-timestamp`, and `webhook-signature` headers over the exact raw request
body. Verification and size checks happen before JSON parsing, R2 persistence,
receipt creation, or queueing.

Notion's initial subscription challenge is unsigned and its dashboard requires
an operator to paste the delivered `verification_token` back into the setup
form. Rally authorizes that one request with a 30-minute nonce stored only as a
SHA-256 hash and atomically bound to the first token it receives. Cloudflare
captures the full webhook URL independently of application redaction, so the
nonce is single-use and a later setup supersedes it; a reusable query secret
would remain a credential in the 90-day observability stores. The verification
token is AES-GCM encrypted in regional D1 and is never logged or returned by an
API. `pnpm notion:webhook:copy-token` decrypts it on the operator's machine and
pipes it directly to the clipboard, which is the only plaintext operator
handoff. Future connectors whose unsigned setup challenge becomes their later
webhook signing secret must follow the same boundary; connectors with a
developer-configured or authenticated secret exchange do not. The classification
and implementation checklist live in
[`connectors.md`](connectors.md#unsigned-webhook-subscription-handshakes).

### Model boundary

OpenRouter credentials and model context are server-only. The harness receives
only context authorized for the execution principal. Tool calls are proposals:
Rally validates the name, schema, principal, capability, limits, and idempotency
state before execution. Reasoning fields are ignored; private chain-of-thought is
neither persisted nor broadcast. Google plugin-view identity changes can replay
an earlier receipt only when its reconstructed surface hash and the same
connection, operation, capability, mode, retry policy and input hash match;
[the harness](agent-harness.md#durable-receipts-and-terminal-state) owns that
compatibility mechanism.

Attachment filenames, MIME declarations, extracted text, converter output, and
errors are untrusted model data. Server-verified MIME determines attachment kind;
a sanitized filename extension is consulted only for an absent or generic MIME
and cannot override a specific type. Attachment continuations are signed with a
purpose-separated key and bind operation, execution principal, and owning scope,
but they grant no access: every call repeats the current resource relationship
and visibility checks. Failed tools forward only bounded, schema-validated
recovery fields; arbitrary provider, converter, credential, and file-authored
objects are discarded before entering the transcript.

Compaction persists an LLM summary only in the row for the exact execution
principal and authorized resource-inventory revision that produced it. Its
resource inventory is regenerated through the sidebar's current-principal
visibility predicate each time the checkpoint is applied or replayed. It
contains fixed kind counts, not filenames, IDs, MIME values, content, or image
bytes. A revision mismatch rejects the summary; the final insert is conditional
on the revision still being current so revocation cannot win the last race.

Historical protocol reconstruction does not trust a completed tool invocation
merely because its JSON receipt still exists. Attachment read, search,
summarize, and view results are identified from their persisted execution plan,
then reauthorized against the current principal, current work-stream
relationship, and current derivative dependency before any result is placed in
the next model request. Missing authority omits that assistant/tool pair rather
than replaying stale content.

A Sidekick run continues on input from anyone who can reach it, including
everyone in a provider thread bound to the run who is a full member of the
connected workspace, whether or not they have a linked Rally account. For Slack,
the sender check refuses guests (restricted and single-channel accounts) and
members of another team, such as Slack Connect users, before the reply reaches
the run. The continued run acts with the Sidekick's run-as user's connectors
whoever sent the input. That is the product decision the external conversation
bindings PRD records, not a gap. The mitigation is framing, not admission:
outside text in a run child reaches the model as labelled evidence from its
sender and never as a member request, and the host's continuation note quotes
the sender's display name as data and says the new message is handled only as
the Sidekick's instructions direct
([continuing a run](automation-lifecycle.md#continuing-a-run)). Output from
`conversation_read` is untrusted model input in the same way: it is whatever
people and other runs wrote in the conversations a Sidekick is attached to.

### Terminal sandbox boundary

The model runs code in two places: the private Daytona sandbox described in
[`terminal-workspaces.md`](terminal-workspaces.md), which has a filesystem and a
network, and the Code Mode isolate described in the next section, which has
neither. Discovering the Terminal plugin
performs no provider operation; an explicit load starts the sandbox acquisition
in the background and returns, so the model is never held behind provider work
and a provider failure surfaces on the first Terminal tool rather than at load.
That acquisition freezes the execution principal, visible-resource authority,
selected immutable GitHub repository identity, and connection into a
sandbox-generation fingerprint; narrowing or revocation destroys that
generation before another tool can observe its filesystem, and a repository
that fails revalidation rejects the shared acquisition every waiting tool holds
rather than being cleaned up after one of them has already proceeded.
The GitHub connector policy is checked before selection, sandbox bootstrap, and
remote publication. An explicitly configured repository is bound to its
immutable provider ID, not just its reusable `owner/name`. Read-only policy is a
remote boundary and does not prevent the untrusted sandbox from changing its
own local checkout.

Commands, repository contents, package output, and imported files are untrusted.
A checkout's own `AGENTS.md` files are read without being asked and are
untrusted like the rest: delivered as user-role messages, and after a
compaction rendered into a system-prompt section under a heading that names them
as repository content subordinate to Rally's instructions and to any
participant, for a bounded number of compactions
([`resident-context.md`](resident-context.md)). That section is the one place
repository content reaches the prefix, and neither the heading nor output
sanitization is a role-isolation boundary; what a block can do is governed by
the standing sentence in the plugin's system message and by the tool loop, which
no block can widen. Each candidate file is checked for symlink and root
containment in its own right before it is read, so a planted
`AGENTS.md -> .git/config` cannot carry the checkout's Git credential header to
the model.
The model receives no PTY, inbound port, background daemon, provider lifecycle,
network-policy, credential, or raw-Daytona tool. Paths stay at or below `/workspace`,
output is stripped of terminal controls and recognizable token forms, and logs
never carry commands or output. Trusted-only egress is a host-compiled Daytona
`domainAllowList` with an immutable baseline and read-back verification; the
model cannot add a domain. The baseline includes every Rally site, which can
keep what a request sends it, so Trusted only limits where data can go rather
than stopping it leaving
([`terminal-workspaces.md`](terminal-workspaces.md#invariants)). Full internet
is an explicit workspace-admin choice.
Before a model-selected repository change destroys a retained generation,
Rally transfers a bounded recovery archive through the trusted Worker, verifies
its size and digest, and attaches it as a regional resource. Git metadata,
credentials, host state, and regenerable dependency trees are excluded; any
backup ambiguity leaves the old sandbox in place.

Daytona receives no R2 credential. Resource originals and generated files cross
through the regional Worker under current-principal visibility and normal cleanup
ownership. The work-stream sandbox receives a one-hour, single-repository GitHub
App credential through host-scoped Daytona secret placeholders. Connector
`read_only` maps to read permissions and technically rejects remote mutation;
`full_access` maps to contents-write and pull-request-write so the model can use
standard `git` and `gh`. Rally prepares and switches to a persisted word-based
work-stream branch before each model-facing operation. GitHub cannot scope an
installation token to one branch, so branch discipline is explicit model
guidance rather than a custom proxy or claimed technical boundary. Policy
changes invalidate the cached expiry and force credential rotation before the
next command.

### Code Mode boundary

A `code_execute` program, and a Sidekick's saved `custom_<name>` tool, is
model-authored JavaScript run in a Cloudflare Dynamic Worker the regional
Worker loads per program: no network (`globalOutbound: null`), no bindings, and
one capability, an `RpcTarget` with a single `call` method passed in as an
argument. Every call it makes is dispatched on the host side through the same
authorization hook, receipt and settlement a direct tool call takes, under the
run's execution principal, so a program has the authority of the model that
wrote it and no more, and its writes are in the ledger as the model's own are.
The program's return value is data: parsed by schema, its failure classified
from the host's own records rather than from the error it threw. A nested write
whose outcome is unknown halts the program and raises Bind's own ambiguous-write
halt, so a program cannot catch the error and write again and the run stops as
it stops after a direct write; a tool whose result is transient (Slack's
real-time search) is not callable from a program, whose result is durable.
Connector and saved-tool descriptions enter the prompt inside the
`# Code API` comments, framed as data. A saved tool is saved only after the
wizard tested its exact code, input schema and plugins, and runs with the run's
connections, never the wizard's. [`code-mode.md`](code-mode.md) owns the
mechanism and its trust model.

### Logging and audit

Structured logs include correlation IDs and domain IDs needed for operations.
Redaction removes authorization headers, tokens, OAuth codes, credential
ciphertext, email and file bodies, raw provider payloads, and model context.
User-visible failures are persisted in product state so recovery does not depend
on provider logs. HTTP request-validation failures keep the public
`invalid_request` envelope generic while the operator log records the method,
resolved path, route template, validation target, and at most 25 Zod issue paths
and codes. For parsed JSON failures it also records `request_body` with the
original object keys, array positions, and empty containers, after replacing
every numeric leaf with `-1` and every other leaf with `"***"`. Rejected values,
issue messages, regexes, and complete Zod objects are never logged. Malformed
JSON uses `(root)` / `invalid_json` and has no body shape because no parsed value
exists.

Workspace invitation tokens are random bearer secrets stored only as SHA-256
hashes in D1. The plaintext token exists transiently in the regional Worker, the
Resend transactional request, the recipient's email, and the fragment-protected
browser/deep-link handoff. It is never placed in a query string, log, audit event,
or Resend tag. Resend uses a send-only API key and a stable per-invitation
idempotency key; an outbound provider failure revokes the new invitation before
the API returns an error.

Work-stream inbound addresses are routing identifiers, never authenticators.
Resend webhooks are verified against their untouched raw body before parsing and
deduplicated by delivery ID. Received HTML, headers, attachments, sender
identities, and quoted content are untrusted. Incoming mail is attached as a
regional resource and system message; it never launches a write-capable agent run
merely because the From address resembles a workspace member. Friendly addresses
are immutable and permanently reserved so a stale sender can never reach a
different work stream.

Daytona lifecycle webhooks use the same shared Svix raw-body verifier, then
check `DAYTONA_ORGANIZATION_ID`. Signed payloads are refresh hints: current
metadata, regional routing, and the owner object's sandbox-ID/generation fence
must all agree before an observation is stored. These events cannot launch a
run or mutate retention intent. The endpoint signing secret is installed as a
Worker secret through the [Terminal setup command](runbook.md#daytona-state-synchronization).

Automation email may start a run, and the sender match against active
membership is the only control on it: since 2026-09-03 such a run holds the same
connector and web tools as every other automation run, for the reasons the
changelog entry of that date records, so a From address that passes the screen
steers a run that can write and send. There is no per-address rate limit; a
limit is a decision for when mail volume exists, and its number would be the
team's ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).

Audit events cover sign-in and session changes, membership, connector
authorization and revocation, external writes, automation changes, suggestion
decisions, and administrative actions.

### Secrets

Local server keys live only in ignored `.env.local`. Renderer-safe values are an
explicit `VITE_` allowlist containing API base URLs and the protocol name. Hosted
secrets, including `RESEND_API_KEY`, use separate Cloudflare secrets per region.
Cloudflare administrative credentials are local deployment inputs and never Worker
bindings.

`TELEMETRY_OPERATORS_JSON` is an independent secret in each region. Its bearer
tokens never cross regions or enter URLs; its stored principal is the only source
of operator identity and role for `/internal/telemetry`. `DEMO_OPERATORS_JSON`
is its sibling for the `demos` role Ace presents: the same shape, read only by
the surfaces Ace calls, and set and rotated independently, so neither secret's
holders can overwrite the other's tokens.

`OPS_SLACK_BOT_TOKEN` and `OPS_SLACK_CHANNEL_ID` are optional independent
secrets in each region: the bot token of a small internal Slack app with
`chat:write` alone, and the one channel it posts operator notifications to. The
token is sent in an `Authorization` header to a fixed Slack endpoint — never in
a URL, because the platform's automatic tracing records outbound URLs and
Global exports them — and the notifier sends only codes, counts, and opaque
ids, escaped for Slack markup: the channel is outside Rally's trust boundary
([`ops-alerting.md`](ops-alerting.md)).

The Gitleaks gate scans the commits a pull request adds to its base branch —
`HEAD_SHA --not <base tip>` — and not the repository's whole history. `detect`
with no range walks every ref the checkout fetched, which makes one branch's
finding everyone's failing job: the gate stops saying "this change introduces a
secret" and starts saying "somebody, somewhere, has an unmerged branch". What
that scope does not do is re-scan what is already on the base branch, so a
secret that reaches `main` is caught on the pull request that carries it or not
at all. That is the same one chance the gate has always had in practice — CI
runs on `pull_request` only, so nothing scans `main` after a merge either.

Exceptions to the Gitleaks scan live in `.gitleaks.toml` as narrowly bounded
patterns rather than as suppressed paths or fingerprints, because those two fail in
opposite directions. A path exemption is permanent and total: it suppresses
**every** secret the scanner would ever find in the files it matches, including a
real credential pasted there later. A fingerprint is the reverse — it is
`commit:path:rule:line`, so it lapses as soon as the line moves, silencing one
finding while saying nothing about the next placeholder written beside it. A
bounded pattern is the only one of the three that keeps covering the file, survives
the line moving, and still refuses real key material.

**Prefer writing the fixture so it is not credential-shaped at all.** An exception
is a standing hole that every future secret is measured against; a placeholder that
avoids the marker a scanner keys on — the `eyJ` of a JWT header, a real PEM body —
costs one comment and widens nothing. Where an exception is genuinely warranted,
bound it on the thing a placeholder cannot fake, and add the bound to
`scripts/gitleaks-allowlist.test.mjs`.

- **The renderer never receives a secret.** No provider credentials, native PKCE
  verifiers, OpenRouter keys, Cloudflare administration keys, raw `ipcRenderer`,
  Node integration, or arbitrary navigation. A capability added to the preload
  bridge is a capability added to every page the renderer could ever be tricked
  into loading.

- **Every IPC argument is parsed before use**, and every exposed handler is
  validated against a live Rally window and its pinned renderer origin.

- **A plaintext preference is never authority to unwrap a protected envelope.** An
  off Lockdown preference beside a Lockdown envelope deletes the local credentials
  and forces sign-in; it does not export the session.

- **Every write to `application-settings.json` goes through the one shared queue
  and re-reads before merging.** Two owners serializing on different primitives is
  how a lost update becomes a credential deletion on the next launch.

- **Model-authored web content is never same-origin with the application, the
  API, or another artifact.** A live artifact serves from a per-artifact
  subdomain of a registrable domain that is not `rallywith.ai`, so it is never
  cookie-adjacent to the product apex and one artifact cannot read another's
  storage, cookies, or DOM.

- **Separate artifact origins do not close cross-artifact CSRF, and the serving
  Worker does.** Every artifact is a subdomain of one registrable domain, so two
  artifacts are same-*site*: `SameSite` does not stop script in one sending a
  **credentialed** request to another, and a simple `POST` needs no preflight, so
  the victim's model-written handler would still run even though CORS hid the
  response. So the serving Worker never carries a viewer identity on a
  cross-origin request: fetch metadata (`same-origin`, or a genuine top-level
  `GET` navigation) decides whether a request may carry one, and every other
  request, any method, reaches the handler anonymously with its cookie ignored
  and its viewer headers stripped. The site's own code decides what an
  anonymous request may do. See `docs/live-web-artifacts.md`.

- **A new ticket audience never issues a ticket in a URL.** Cloudflare records
  whole URLs into the invocation log, Logpush, and traces, and no redaction here
  reaches them. An artifact's access code travels in a fragment, which a browser
  never sends to a server, and is redeemed through a request body at an endpoint
  that never serves artifact content — so no artifact document is ever loaded at
  a location that held it. Single-use redemption bounds replay; it does not keep
  a secret out of a log, and is not on its own compliance.

- **Nothing that protects data is scoped by a feature flag.** Flag targeting is a
  product scope; a flag that cannot be evaluated keeps its last answer, which is
  the wrong failure mode for a confidentiality boundary.

- **Every API resource query includes `workspace_id`; every mutation additionally
  resolves membership role.** Knowing an ID authorizes nothing.

- **Every connector tool checks execution principal, connection scope, granted
  capability, and resource visibility** — at execution, not only at admission.

- **A Terminal sandbox generation is reused only under its exact frozen authority
  fingerprint, and never receives a GitHub write or R2 credential.** Filesystem
  persistence cannot become a way around later revocation.

- **A current client never sends a socket ticket in a URL, and a new ticket
  audience never issues one there.** Cloudflare records whole request URLs into
  the invocation log, the Logpush export, and trace spans, and no redaction in
  this repository can reach them. Legacy issuer response fields exist only for
  old desktop compatibility and must be removed at the declared compatibility
  cutoff rather than copied to any later role.

- **A prepared feed admission is usable only by its exact signed ticket and
  object authority generation.** It is in memory, never a second durable
  credential; it is revalidated against D1 during ticket transit, natural
  session expiry is checked locally at upgrade, revocation fences it, eviction
  loses it, and every miss falls back to current regional session/membership
  authorization. The room retains only one preparation, and the durable ticket
  receipt remains the one-use decision.

- **A native WebSocket in the renderer is constructed only from a URL an
  authenticated ticket endpoint returned; Electron's work-stream broker is
  narrower still.** Its typed IPC accepts only configured regional
  Channel-control/SubstreamAgent paths from main or Sidekicks windows, and main supplies the
  application Origin.

- **A URL schema names its accepted scheme contract explicitly.** Bare Zod URL
  validation accepts `javascript:` and `data:`.

- **Every desktop HTTP header is covered by the regional CORS allowlist and an
  exact preflight test.** A header implemented only in the renderer cannot reach
  the Worker.

- **A request-validation log retains shape, never rejected content.** Route,
  target, field path, issue code, JSON keys, array positions, and empty
  containers are operational metadata; every logged body leaf is `"***"` or
  `-1`, and raw values, Zod messages, regexes, and unmasked request bodies do not
  enter the log.

- **A document built out of model output is never same-origin with the
  application.** The exported message card gets `rallywithai-export://`, no preload,
  and a policy that forbids script; putting it on `app://rallywithai` would buy one
  fewer scheme at the price of the boundary.

- **A webhook is verified against its exact raw body before anything parses,
  stores, or queues it.** A GitHub delivery is verified once, at the Global
  receiver; its Queue message and the account-internal `GitHubRegionalBridge`
  (`ingestVerifiedGitHub`) carry no signature and are trusted as verified, so
  anything able to send on Global's activity Queue or call that bridge binding
  is inside the GitHub webhook trust boundary
  ([`connectors.md`](connectors.md#invariants)).

- **A tool call is a proposal, never an instruction.** Name, schema, principal,
  capability, limits, and idempotency state are all checked before execution.

- **An inbound email address is a routing identifier, never an authenticator.** The
  From match against active workspace membership is the only control on a
  mail-started run: since 2026-09-03 such a run holds the same connector and web
  tools as every other automation run, so a spoofed From that passes the screen
  steers a run that can write and send. The changelog entry of that date records
  why the tool filter came out and what stands in its place.

- **An invitation token exists in D1 only as a SHA-256 hash**, and never in a query
  string, log, audit event, or Resend tag.

- **A Gitleaks exception is a bounded pattern**, never a path exemption or a
  fingerprint, and it ships with a case in
  `scripts/gitleaks-allowlist.test.mjs` proving it still rejects real material.

- **Crashpad's live database is opaque.** Invalidation changes only its sibling
  generation manifest; deletion, enumeration, and upload occur after rotation on a
  later launch.

- **Opt-out is enforced at creation, regional acceptance, and destination
  delivery.** Attributable undelivered product, diagnostic, identify, profile, and
  crash work is suppressed or deleted; already delivered destination data is
  outside Rally's internal lifecycle.

## Boundary

This document owns the trust boundaries and the mechanisms that enforce them. It
does not own the subsystems on either side of them:

| For | Read |
| --- | --- |
| The surfaces and how a request travels between them | [`architecture.md`](architecture.md) |
| Which region holds what, and what crosses | [`regionalization.md`](regionalization.md) |
| Tenancy columns and the visibility rule | [`data-model.md`](data-model.md) |
| Socket admission and the ticket format | [`realtime-sockets.md`](realtime-sockets.md) |
| Connector scopes, grants, and adapter invariants | [`connectors.md`](connectors.md) |
| The Slack scope inventory | [`slack-permissions.md`](slack-permissions.md) |
| Run admission, limits, and the inference ledger | [`agent-harness.md`](agent-harness.md) |
| The draft cache under `userData` | [`composer-drafts.md`](composer-drafts.md) |
| The local cache of directory and transcript state under `userData` | [`local-cache.md`](local-cache.md) |
| The windowless menu bar surface | [`menu-bar.md`](menu-bar.md) |
| Telemetry contracts, opt-out, identities, crash lifecycle, and destinations | [`telemetry.md`](telemetry.md) |
| Public-site anonymous identity, event surface, and handoff negative space | [`public-site-telemetry.md`](public-site-telemetry.md) |
| The artifact runtime's fences, the facet data plane, and what a published directory becomes | [`live-web-artifacts.md`](live-web-artifacts.md) |
| Rotating a key or responding to an incident | [`runbook.md`](runbook.md) |
| Access Managed OAuth and destructive operator SQLite inspection | [`engineering-mcp.md`](engineering-mcp.md) |

## Failure modes and limits

- **An ambiguous external write is never automatically repeated.** If a process
  stops after a provider write but before confirmation is stored, the invocation
  becomes `ambiguous`, the work stream becomes `needs_input`, and a person decides.
  This is retry safety, not a broad approval gate — a tool that has not been made
  idempotent has no protection here.
- **A lost custom-protocol notification is recoverable.** The durable connector
  attempt result lets the desktop reconcile success, denial, failure, or expiry
  regardless.
- **A rejected desktop CORS preflight is a client-side transport failure.** The
  shared renderer boundary reports its sanitized stack as `network_error`, but
  the rejected product mutation is not retried implicitly and cannot appear in
  Worker request logs because the browser never sent it.
- **An unavailable keystore turns Lockdown mode off and requires sign-in**, rather
  than leaving an unreadable envelope in place.
- **Renaming the application invalidates every Lockdown session on the machine.**
  macOS derives the `safeStorage` keychain entry from the application name, and
  Electron exposes no way to name it independently, so a build named Rally cannot
  read what `Avalon Safe Storage` holds. The rename from Avalon therefore costs
  every Lockdown user one sign-in. It costs the default global mode nothing: that
  mode encrypts with a compiled key, and the launch-time directory adoption in
  `user-data-path.ts` carries the envelope across. The failure is graceful by
  construction — an undecryptable envelope is logged and treated as no session,
  which is the sign-in screen rather than a crash.
- **Composer drafts are workspace content stored unencrypted** under `userData`,
  bounded by a 12-hour expiry and deleted on sign-out. No credential is ever
  written there.
- **The local cache of directory rows and opening transcript ranges is workspace
  content stored unencrypted** under `userData`, keyed by the account that
  wrote it, bounded by membership rather than time, deleted per workspace on
  leaving and entirely on sign-out. No credential is ever written there.
- **A packaged helper carrying a restricted `com.apple.developer.*` entitlement is
  killed by AMFI only after the app reaches another machine.** The release verifier
  exists because that failure is invisible on the build host.
- **A credential-shaped string fails the `secrets` CI job for the pull request
  that adds it, and deleting it later does not clear it.** The scan reads
  commits, not the working tree, so a fixture that was committed and then
  removed is still in the range; rewriting the branch's history is the fix to
  reach for. It used to be worse: the scan spanned every branch the checkout
  fetched, so one such string went red on every open pull request at once. The
  range is now the pull request's own commits, and the limit that remains is the
  other side of that — a secret already on the base branch is not re-reported,
  because it was this gate's to catch on the pull request that carried it.
- **A secret introduced only by a conflict resolution is invisible to the
  `secrets` gate.** `git log -p` emits no patch for a merge commit, so a value
  that appears in neither parent and only in the merged tree is in no patch the
  scan reads. This is not a consequence of scanning a range — the unscoped
  whole-history scan that preceded it had the identical gap, confirmed against
  the pinned binary both ways — and it is the same property that keeps a merge
  from double-reporting the commits under it. A conflict resolution that pastes
  a credential is therefore caught by review or not at all.
- **One documented dependency advisory is accepted.** As of August 2026 the package
  audit still reports
  [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) against
  React Router 7.18.2. The vulnerable path is React Server Components action
  handling; Rally is a bundled Electron client using `HashRouter` and has no RSC
  server, action decoder, or React server endpoint, so that path is not present.
  The release gate's rule is to upgrade patched transitive dependencies rather than
  suppress advisories — remove this exception as soon as React Router publishes a
  compatible patched stable release.

## Testing

Most of this is enforced by unit suites next to the code, plus two gates that have
no unit test standing in for them.

| Suite | Covers |
| --- | --- |
| `apps/desktop/src/main/*.test.ts` | Session encryption and the envelope versions, Lockdown migration, the settings write queue, the developer-settings flag suppression, launch-at-login, the menu bar's content fetch. |
| `apps/api/test/connector-credential-envelope.test.ts` | The AES-GCM envelope, its connection-bound additional authenticated data, and key-version rotation reads. |
| `apps/api/test/auth-session-lifecycle.test.ts` | Session minting, revocation, and single-use consumption. |
| `apps/api/test/auth-router.test.ts` | Root-mounted identity/workspace middleware reuse, standalone workspace-middleware authentication, and next-request revocation. |
| `apps/api/test/security-and-config.test.ts` | Exact desktop CORS origin/method/header preflights and environment guardrails. |
| `apps/api/test/validation-errors.test.ts` | Generic public 400 envelopes plus operator-only request target, field paths, issue codes, and recursively masked JSON body shape with rejected values absent. |
| `apps/api/test/rpc-contracts.test.ts` | That a cross-region rejection names field paths and never values. |
| `apps/desktop/src/main/telemetry-*.test.ts`, `native-crash-*.test.ts` | Sender/schema boundaries, redacted inspection, owner-only bounded spools, route-final generations, opt-out invalidation, and authenticated next-launch upload. |
| `apps/api/test/telemetry-*.test.ts`, `crash-*.test.ts`, `posthog-adapter.test.ts` | Regional acceptance, capabilities, preference/identity ordering, immutable deadlines, raw-object access, sanitization, and exact destination negative space. |
| `apps/site/test/site.test.ts` | Pure functions only: iOS detection, telemetry path classification, desktop handoff target parsing and Slack fragment parsing. Public entries, route-before-identity behavior and tracking disclosure have no automated test. |
| `pnpm --filter @rally/desktop test:release` | The entitlement rules, notarization, blockmap ordering, and the final verifier. CI runs this as a separate job — `pnpm test:scripts` does **not** cover `apps/desktop/scripts/`. |
| `scripts/gitleaks-allowlist.test.mjs` (`pnpm test:scripts`) | That each `.gitleaks.toml` pattern it has a case for still rejects real key material, because the scan itself only reports what it finds today and would not notice an exception that had been widened. A new exception needs its own case; nothing fails if it is added without one, so that is a review finding. |
| The `secrets` CI job | Gitleaks over the commits a pull request adds to its base branch — `HEAD_SHA --not <base tip>` — and not the base branch's own history. |

The trap in the desktop suites is that they assert on the *stored* shape of a
credential. A test that constructs an envelope by hand rather than through
`session-encryption.ts` will keep passing after the envelope version moves, which
is exactly the change that needs the coverage.

## Operations

**Rotating `CONNECTOR_CREDENTIALS_KEY`.** During rotation, that secret contains
the new active key, `CONNECTOR_CREDENTIALS_KEY_VERSION` is incremented, and the
regional secret `CONNECTOR_CREDENTIALS_KEYS_JSON` temporarily maps every
still-referenced old numeric version to its old key. Reads decrypt with the row
version and opportunistically rewrite the row with the active key. Operators
remove an old mapping only after confirming no regional
`connector_connections.credential_key_version` rows still reference it. Deployments rotate independently. [`runbook.md`](runbook.md) owns the procedure and the
incident response that may prompt it.

## Apple notifications

Apple device registrations reuse authenticated workspace sessions and the regional
D1 control plane. The existing notification access decision runs again when the
queue consumer sends. The native bridge handles permission state and explicit
notification responses; main validates the work-stream link through the shared
parser before navigation. Only the main app gains Push Notifications and
Associated Domains entitlements; helpers retain their existing entitlement set.
[Apple push](push-notifications.md) owns provisioning and release verification.

The lite browser host adds `Content-Security-Policy: sandbox; default-src 'none'`
and `X-Content-Type-Options: nosniff` to forwarded HTTP responses. Uploaded documents
therefore cannot execute with the application's cookie origin when opened directly;
XHR/blob readers retain their existing behavior. Chrome cookie writers use a
regional Web Lock so an older renewal cannot replace a later login cookie.
[Browser client](browser-client.md) owns these host-specific boundaries.

### Artifact annotation pickers

One annotation script runs in every HTML surface, and on a live artifact it
shares the page's origin on both hosts: the serving Worker prepends it to the
HTML a Rally viewer gets (a valid viewer session, or the browser client's
frame), the desktop calls its `rallyAnnotations` API through
`executeJavaScript`, and the browser client posts messages to the frame. The
page's own scripts can see and replace it. That is accepted because the page is
written by the workspace's own agent and nobody edits it by hand: a forged pin
quotes only what the page already shows, the person sees the chip before
typing, and the model treats quoted content as untrusted. The desktop's
isolated world (1001) was retired on 2026-10-29 for that reason; it was free,
not load-bearing. What stays: a host accepts a reply only from its own frame
or view at the expected origin, in a shape the shared schema admits, only
while Comment mode is on for a pin and only for a pin it holds for a card
action; a pin's `screenshot` is set by the desktop's own `capturePage` or not
at all, and the framed schema has no such field; a page without the script
keeps Comment mode disabled. Public, crawler and unfurl responses carry no
script.

An uploaded HTML file is not agent-authored, so it stays in an opaque
`allow-scripts` `srcdoc` frame with a fresh nonce admitting only the app-origin
script; `allow-same-origin` is never added, and the file's own scripts never
run. Pop-outs keep their narrow sender-checked preview/transfer bridge, require
an active originating composer scope and wait for its ACK. Canonical target
read/version checks precede message admission. The owner-window-only
`artifact:preview-comments` and `artifact:preview-ready` IPC validate schemas
and fence delayed answers against the current native view; artifact scripts
receive no application bridge. See
[artifact annotations](artifact-annotations.md) for the protocol.

## Changelog

### 2026-11-03 — Cross-origin requests reach a site anonymously, not refused

**What changed:** The artifact serving Worker no longer refuses a
cross-origin unsafe request. It lets it reach the site's handler with no
identity, the same as a cross-origin read.

**Why:** Sites need to take submissions from people outside Rally (an
anonymous poll, a contact form), and the product decided a site's own code,
not a per-site switch, decides what an anonymous request may do.

**Considered and rejected:** A per-site opt-in for anonymous writes, removed
as friction. Refusing cross-origin writes while admitting same-origin
anonymous ones, which still blocked public forms embedded or posted from
elsewhere.

**Consequences:** The boundary that remains is identity: a sibling artifact
can send a request but never with a viewer's identity. A site that never
checks for a viewer accepts anonymous writes from any origin.

### 2026-10-31 — Model-authored code runs in a second, smaller boundary

**What changed:** Code Mode adds a place the model runs code besides the
Terminal: a Dynamic Worker with no network, no bindings and one capability, the
gateway stub, whose calls are host-dispatched tool calls under the run's
principal. The Terminal paragraph no longer claims to be the only such place.

**Why:** The Sidekick runs that motivated Code Mode spent most of their calls
re-deriving a method; a program composes those calls in one step. The Terminal
was the wrong boundary for it: a sandbox with a filesystem and a network, and
no callback into Rally tools. The isolate has exactly the reach the model
already had.

**Considered and rejected:** Running programs in the Terminal sandbox with a
tool-calling shim (a network path into Rally from an untrusted machine); a
loopback `WorkerEntrypoint` (self-RPC into the Durable Object, which the
subrequest depth limit ends).

**Consequences:** Every refusal, receipt and audit row a direct call gets, a
nested call gets. What a program returns is untrusted data, parsed by schema.
Details in [`code-mode.md`](code-mode.md#security-and-trust-model).

### 2026-10-29 — Website picking shares the page's origin on every host

**What changed:** The annotation script is injected by the serving Worker into
a Rally viewer's artifact pages and runs in the page's own world on the desktop
and in the browser client; the desktop's isolated world is gone. The browser
client's framed preview listens for the script's messages, from that frame's
window at the artifact origin only.

**Why:** A live artifact is written by the workspace's own agent through Rally's
publish tool, so a picker isolated from the page's scripts defended against the
page's author. The requester chose one transport for both hosts over keeping
that isolation.

**Considered and rejected:** App-side input capture over the frame, and a
headless render to pick against; both recorded in
[the PRD](PRDs/2026-10-29_browser-website-comments/prd.md).

**Consequences:** The uploaded-file frame keeps its opaque origin and nonce
rule, and the artifact CSP, fetch-metadata and viewer-session fences are
unchanged. The injection rule in `annotation-script.ts` is the one place that
decides which responses carry Rally code.

### 2026-10-24 — Admit the Sidekicks window to composer microphone capture

**What changed:** Chromium media permission now grants audio capture to the
Sidekicks window as well as the main window. Camera, display capture, mixed
audio+video, and every other Rally window stay denied.

**Why:** Dictation lives on the shared composer, and the Sidekicks window hosts
that composer on its own WebContents. Electron asked only whether the requester
was the main window, so `getUserMedia` there returned `NotAllowedError` even
when macOS System Settings already allowed Rally and the main-window microphone
worked. The composer surfaces that as blocked microphone access, which sent
people to toggle an app-wide grant that was already on.

**Considered and rejected:** Granting media to every trusted Rally renderer.
Settings, import, the deep-link failure window, and detached artifacts do not
host the composer, and widening them would give a compromised renderer a
microphone it has no product reason to open. Identifying capture windows by
renderer URL instead of WebContents identity was also rejected: every Rally
window shares that origin.

**Consequences:** A new window that hosts the composer has to be named in
`allowsTrustedAudioCapture`; a trusted renderer URL is not enough. Computer-audio
tap IPC is a separate main-window-only channel and is not this grant.

PR #1444.

### 2026-10-19 — Confine detached artifact menu operations to their window

**What changed:** Detached windows can read and act on their own resource through
`artifact:window-action`; they remain outside the shared trusted sender set.
Main derives the resource and Main-thread context from its window record,
validates a strict action union, keeps credentials private, and checks the
session and opening region again after asynchronous work. Schema failures retain safe field codes.
Window restoration and refresh also stay within that region; legacy saved entries
without a region must be reopened from their owning conversation.

**Why:** Sharing the panel menu with a pop-out requires rename, archive, pins,
versions, and fresh website navigation. Granting the detached renderer the full
session bridge or arbitrary API transport would make those narrow actions a
capability to operate on unrelated resources.

**Consequences:** Keep the operation list explicit and retain route-level server
authorization. A new menu action needs a confined operation rather than adding
the window to `assertTrustedIpcSender`.


### 2026-10-19 — Isolate annotation picking from resource scripts

**What changed:** Opaque static frames and isolated live-site worlds run trusted picker code; main owns screenshots and popouts receive narrow sender-checked IPC.

**Why:** Pointing at model-authored HTML must not give its scripts app authority or let synthetic input impersonate user selection.

**Considered and rejected:** Published-response injection was removed after native-only website scope was accepted; bundled external code satisfies inherited CSP where an inline nonce does not.

**Consequences:** Preserve opaque frames, trusted-input checks, native screenshot ownership, narrow IPC and an active original composer scope for transfer. See [artifact annotations](artifact-annotations.md).

PR #1322; design: `docs/PRDs/2026-10-19_artifact-annotations/prd.md`.


### 2026-10-02 — Isolate persistent browser orchestration from the app

**What changed:** Browser model code runs in an ephemeral sandboxed WebContents,
with no preload/Node, denied network/frames and a typed pinned-tab RPC binding.

**Why:** Persistent browser handles need a JavaScript realm independent of both
provider-page navigation and Rally's authenticated renderer. Running orchestration
in the renderer would expose the app's trusted bridge; running it in the provider
page would lose bindings on navigation and grant unnecessary session authority.

**Consequences:** Native adapters remain trusted code, never arbitrary model
JavaScript. Realm reset and run termination dispose orchestration only; signed-in
page operations already sent to Chromium can finish after disposal.

### 2026-09-24 — Two Rally windows may drive a signed-in local browser

**What changed:** The desktop hosts account-partitioned web pages in the main
window's right rail and in an import window. Each of those two windows may send
its own browser typed commands — navigation, input, page script, and DevTools
commands — and no other window may. Visited pages get no preload, Node, or
permissions. Conversation readers run as page script inside the provider's page
and keep its credentials there, except a claude.ai Artifact's short-lived
asset token, which passes through the import window's renderer. Each file a
reader downloads is held to the attachment upload limit.

**Why:** Importing a conversation, with its files, needs the provider's own
data read with the person's own sign-in. Local app caches and server-side share
fetches were partial or challenged, and a remote sandboxed browser was
challenged too.

**Considered and rejected:** A narrower per-provider read command in main,
which would move provider formats into the main process and still need page
script and DevTools for Artifact files. Letting every Rally window drive the
browser, which widens the set of renderers whose compromise reaches signed-in
sites. Relaying the Artifact through main to keep its token out of the renderer;
the token is scoped to one Artifact and expires within the hour.

**Consequences:** Script injected into the main or import renderer would reach
every site signed in there, so both stay under the renderer isolation rules
above. `embeddedBrowserHost` in main is the one place that admits a window.

### 2026-09-21 — Sideline uses the desktop isolation boundary without participant credentials

**What changed:** The new Sideline Electron host has a dedicated OAuth callback,
encrypted main-process session storage, a sandboxed networkless renderer, and a
narrow typed preload for catalog, send, sign-out, and Rally handoff operations.

**Why:** Represented messaging needs the operator's ordinary Rally identity but
must never recover or package the represented participant's credential. Keeping
network and refresh tokens in the main process makes renderer compromise no more
authoritative than a modified API request.

**Considered and rejected:** A packaged internal API key, renderer-side fetch,
and sharing the main app's custom URL scheme. Those expose reusable authority or
leave the operating system unable to choose which installed app owns sign-in.

**Consequences:** New Sideline capabilities must be explicit bridge methods with
main-process argument validation. The renderer cannot gain arbitrary IPC,
network, filesystem, session, or environment access; `rallywithai:` remains
owned by the main Rally app.

Design: `docs/PRDs/2026-09-19_impersonation-platform/prd.md`.

### 2026-09-19 — The secret gate scans the pull request, not the repository

**What changed:** the `secrets` job passes
`--log-opts="$HEAD_SHA --not origin/$BASE_REF $BASE_SHA"` to `gitleaks detect`,
so it scans the commits the pull request adds to its base branch. Both sides of
that branch are excluded — its live tip and the SHA recorded when the event
fired — and the range is resolved with `git rev-list` before the scan runs.
`fetch-depth: 0` stays, because the range needs both sides.
`scripts/ci-workflow.test.mjs` fails if either exclusion, the range check, the
full history or the single invocation goes away.

**Why:** `detect` with no range walks every ref the checkout fetched, and
`fetch-depth: 0` fetches all of them. A credential-shaped test fixture pushed to
one unmerged branch therefore failed this job on every open pull request at
once — each with nothing in its own diff to fix, no way to re-run out of it, and
a red required check blocking auto-merge. The gate had stopped answering "does
this change introduce a secret" and started answering "does anyone have a branch
with a finding on it", which is not a question a pull request author can act on.

**Considered and rejected:** allowlisting the fingerprint that triggered this.
It is the fix this document already argues against, and it treats one instance
of a structural problem — the next branch would do it again. Also rejected:
scanning `git log` from the merge commit, which walks the base branch's whole
history again and reintroduces exactly what this removes.

**Two ways this range can be got wrong, both found in review and both fixed
here.** Excluding only one side of the base branch leaves a hole at each end: the
live tip alone misses a base branch force-pushed past the recorded SHA, and the
recorded SHA alone misses a finding that lands on the base branch afterwards and
is then merged in — either one puts base commits back in the range, which is the
original bug. And `gitleaks detect` **exits 0 when git rejects its range**: it
logs `stderr is not empty` and reports "no leaks found", so a stale variable or a
missing ref would have turned a required security check green. `git rev-list`
resolves the range first, and a gate that cannot work out its own scope now fails
loudly rather than passing silently. An earlier revision of this change had a
fallback to the recorded SHA when the remote-tracking ref was missing; excluding
both sides unconditionally leaves it nothing to do.

**Consequences:** a finding on the base branch is no longer re-reported on every
pull request, which is the point, and also the cost: a secret that is already on
`main` will not be found by this gate again. It was caught, or missed, on the
pull request that carried it. Anything relying on the old behaviour to
retroactively catch history — nothing does today — needs a scan of its own
rather than a widening of this one. A scheduled full-history scan is the obvious
shape for that, and is deliberately not added here: it is a standing job with a
standing noise budget, and whether the repository wants one is the team's call
rather than this change's to make.

### 2026-09-19 — Bind Canva loopback redemption to the initiating session

Canva's interim native callback runs in Electron main and forwards only an
OAuth code. The API checks the member and workspace before consuming the sealed
attempt; the public callback cannot redeem a desktop attempt. Provider credentials
remain server-side. Design share URLs are encrypted separately from navigation
metadata because the URL may itself grant access. See [Canva](canva-integration.md).

### 2026-09-16 — Bind sessions to membership instances

Guest promotion should retain a person's session, but removing and inviting the
same person again must not revive credentials from earlier access. Sessions now
store their admitting membership incarnation. Authentication, refresh rotation
and all three socket session authorities compare that incarnation with the
current relationship. Triggers cover both normal session creation and existing
workspace-selection writers; only a different workspace selection rebinds.
Relying solely on asynchronous revocation would leave a rejoin window, while
binding to every membership revision would unnecessarily sign people out during
promotion. Incarnation is the lifecycle boundary those two choices missed.


### 2026-09-16 — Receipt-owned pagination replaces model-held provider tokens

Authored tool continuations now live in the owning SubstreamAgent and expose
plugin-prefixed page IDs. Redemption checks run, principal, connection, operation,
producer completion, and receipt ownership before executing with current
authorization. New attachment state therefore needs neither a second HMAC nor
an artificial TTL; signed-token decoding remains for historical receipts only.
Generic JSON rewriting was rejected because content fields are not evidence of
cursor ownership. MCP/pass-through contracts remain unchanged. See
[`tool-pagination.md`](tool-pagination.md) for the lifecycle and recovery rules.

### 2026-09-15 — Link decoration does not widen renderer egress

**What changed:** Markdown HTTP(S) links may display a favicon, but the
sandboxed renderer obtains its bytes through the authenticated Rally API. The
server accepts public domains only, asks the existing Firecrawl client for
branding metadata, rejects image redirects, bounds and verifies image bytes,
applies a 25-second deadline to each complete candidate lookup, and caches the
result or confirmed miss for 30 days in dedicated KV. Transient
provider and image-origin failures are not negative-cached. A primary-domain
fallback that outlives an exact-host response is retained through the request
execution context rather than detached from the Worker lifecycle.

**Why:** Letting an `<img>` point at a model-authored site would notify that site
when a message merely painted and would move arbitrary network access into the
renderer. Repeating lookup on every client would also discard the platform-wide
reuse the mark is meant to provide. Cloudflare publishes no individual
subrequest deadline, so an origin can otherwise keep the authenticated request
and its coalesced desktop promise open indefinitely.

**Considered and rejected:** Direct renderer fetches and direct page scraping in
the API. The former discloses browsing context from each client; the latter
duplicates the server's existing public-web acquisition boundary.

**Consequences:** Favicon failure is silent and never changes navigation.
Redirects are treated as absent for that host, the separately resolved primary
domain may still supply its own mark, and detached still exports do not fetch
live decoration. Concurrent desktop requests for one normalized hostname share
one API operation, and browser responses revalidate so the KV entry remains the
one 30-day cache clock. Every HTTP(S) link loads with its message rather than
adding viewport or per-message limit bookkeeping. The team selected
25 seconds to match Firecrawl's branding scrape budget and remain within
Cloudflare's 30-second `waitUntil` window; one signal spans Firecrawl discovery,
image headers, and the body. A deadline failure is transient and therefore never
stored as a 30-day miss.

### 2026-09-12 — Authenticate once within each HTTP request

**What changed:** Protected routes reuse the identity middleware's request-local
decision in workspace middleware, removing their duplicate token verification
and session query.

**Why:** Both middleware stacks are root-mounted, so a protected route passes
through both in one request while requiring only one current identity decision.

**Considered and rejected:** Persistent caching was rejected because it would
introduce stale revocation decisions.

**Consequences:** Only the current request shares the decision; every later
request still reads current session, membership, workspace, and role state, and
workspace middleware still rejects identity-only sessions.

Shipped in #730.

### 2026-09-12 — Separate workspace installation cleanup from personal access

**What changed:** Workspace installation reserves encrypted authority before provider writes, isolates exact-ID removal credentials after disablement, and fences credential replacement against the current envelope. Administrative mutations retain actor attribution.

**Why:** A disabled connection must stop ordinary access without losing the only means of deleting its provider registration. A stale response must not restore credentials or silently replace a newer API key.

**Considered and rejected:** Reusing ordinary credential authorization for cleanup, blindly retrying uncertain creates, or widening event grants through operator maintenance.

**Consequences:** Cleanup remains removal-only; repeat disconnect preserves it and forgetting leaves manual provider work. Raw-byte signature/size checks precede persistence, and Ashby workspace notifications use the administrator-authorized workspace audience and retain the normalized field allowlist. The [lifecycle owner](connector-installation-lifecycle.md) records recovery details.

The full-history secret scan permits exactly the Granola test key encoding of
`provider-issued-secret`; it grants no provider authority. Its anchored literal
exception has a regression test rejecting other keys and longer values, rather
than allowing arbitrary webhook secrets or excluding the fixture file.

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).

### 2026-09-11 — iOS holds sessions in the Keychain, not a renderer

**What changed:** The iOS client stores identity and workspace sessions with
`KeychainStore` (`AfterFirstUnlockThisDeviceOnly`). It reuses the desktop Google
PKCE start/exchange and the same JWT audience. There is no preload, CSP, or
`safeStorage` path on iOS.

**Why:** Copying Electron's encrypted file envelope onto a phone would have
invented a second secret format without the main-process isolation that makes
the desktop envelope make sense. The Keychain is the platform primitive that
already matches "refresh tokens never sit in UserDefaults." Reusing
`avalon-desktop` as the audience avoids a Worker change just to put the same
member on a second device.

**Considered and rejected:** A `WKWebView` around the desktop renderer, which
would have put OAuth and session state in web storage on iOS. Also rejected:
shipping refresh tokens in `UserDefaults` behind a debug flag.

**Consequences:** A security change that tightens renderer isolation does not
automatically cover iOS. iOS review is Keychain accessibility, URL scheme
admission, associated domains, and the ticket-as-subprotocol rule. APNs tokens
register through `PUT /push-devices/:installationId` with topic `ai.rallywith.ios`;
they are not a session.

Shipped in #725.

### 2026-09-11 — The five prompt trust labels are gone

**What changed:** `renderUntrustedSlackOriginMessage`,
`renderUntrustedInboundEmailMessage`, `renderUntrustedExternalEventMessage`,
`renderUntrustedAutomationResultMessage` and `renderTriggerActivityMessage` are
deleted from `packages/agent-harness/src/prompts/workstream.ts`. Slack
surrounding context, an inbound trigger email, the event that started an
external-event run, a Sidekick's delivered result and a trigger activity now
reach the model as plain `role: "user"` messages with no `UNTRUSTED …` header.
The external-event message keeps the non-trust half of its old preamble, because
that sentence exists to stop a run answering that the event's fields were "not
provided". The Sidekick result keeps its name-and-timestamp attribution line.

**Why:** The team's judgement is that the labels were not earning their place: a
Sidekick is first-party code running under an authorized principal, and marking
its own summary `UNTRUSTED` read as Rally distrusting itself. Requested
directly, and reaffirmed after the exposure below was put in writing.

**What this leaves:** role placement, not labelling, is now the whole of the
control on these five paths — the content is still user-role and still cannot
outrank the system prompt. Ingress screening (a sender must resolve to an active
workspace member) is unchanged. The tool-narrowing guards were already removed on
2026-09-03, so for a run whose trigger content comes from outside the workspace —
a GitHub pull-request title read by a Sidekick, say — nothing now marks that text
before the owning room's agent reads it while holding write-mode connector tools.
That is an accepted trade, recorded here rather than argued again.

**What a future change has to respect:** the remaining markings are load-bearing
for something else. `COMPACTION_SUMMARY_PROMPT` in
`packages/agent-harness/src/bind-runtime.ts` still tells a summarizer that
content "marked untrusted keeps that marking"; after this change that rule only
matches `UNTRUSTED RECENT TRANSCRIPT`, `UNTRUSTED PROVIDER ACTIVITY` and the
attachment manifests. Removing those two renderers as well would leave the rule
matching nothing, and the rule should go in the same change if it ever does.

### 2026-09-09 — Repository instruction files reach the model, and after a compaction the prefix

**What changed:** The Terminal plugin reads a checkout's `AGENTS.md` files
automatically and the context-residency ledger moves them into a system-prompt
section at a compaction. The Terminal boundary above records both, and the
per-candidate symlink and containment refusal the probe applies.

**Why:** The product decision is the
[repository-instruction-files PRD](PRDs/2026-09-08_repository-instruction-files/prd.md).
This document owns the boundary it moves: repository content in the prefix,
bounded in time, under a demotion heading, with no claim of role isolation.
[`writing-prompts.md`](writing-prompts.md#12-layer-authority-explicitly) carries
the matching exception to its content rule.

### 2026-09-08 — The demo seeder acts as a cast member without a session

**What changed:** `ProductAuthSchema.principal` accepts `demo_seed` beside
`connector`. Only server code constructs it, the message route's request
schema has no `seed` field, the room verifies it against current membership
as it verifies a connector ingress, and every socket-ticket issuer refuses
it. The `demos` operator role now also reaches the demo preparation routes.
A demo receives copies of the template's Google connections only; a
connection of any other provider is skipped and reported, because a copy
shares the upstream grant and the presenter's Disconnect would revoke it
remotely for the template and every live demo.

**Why:** The cast never signs in, and a session minted for them would be a
credential nobody holds. A distinct principal value rather than a reuse of
`connector` so a seeded run's authorization record says who acted. Google's
disconnect is local (`connection-service.ts`, `mayRevokeRemotely`), which is
the one property that makes a shared grant safe to hold in several
workspaces. [`demo-workspaces.md`](demo-workspaces.md#security-and-trust-model)
owns both.

### 2026-09-08 — The `demos` role moves to its own secret

**What changed:** The `demos` operator role is read from `DEMO_OPERATORS_JSON`,
a per-region secret with the same shape as `TELEMETRY_OPERATORS_JSON`, which
goes back to the telemetry roles only. Each operator router names the secret
it verifies against as well as the roles it admits.

**Why:** Reversing the entry below on its rotation argument. A Worker secret
cannot be read back; the telemetry map was set by someone else, and adding
one token to it meant overwriting tokens nobody could name. Two credentials
set by different people for different surfaces should not share a value.

**Consequences:** A leaked demo token holds the surfaces Ace calls and no
telemetry route; a leaked telemetry token holds no operator surface Ace calls.
Owned by [`workspace-retirement.md`](workspace-retirement.md#changelog).

### 2026-09-08 — A `demos` operator role, isolated per router

**What changed:** `TELEMETRY_OPERATORS_JSON` carries a third role, `demos`,
which reaches only the workspace retirement route; every operator router names
the roles it admits with `requireOperatorRole`. Ace holds one `demos` token per
region. Retirement writes `workspaces.abandoned_at`, the fence every D1
authority read applies, before closing any object, so a session into a retired
workspace fails authentication on its next request.

**Why:** An operator tool that can close any workspace needed a credential that
can do that and nothing else. A second secret with the same shape would be a
second thing to rotate for no isolation gained: the role isolates, and only if
every surface names the roles it admits. The D1 fence is from review — the
objects' gate stopped everything that reached an object, and nothing else:
sign-in, the member list and invitations are D1 reads.

**Considered and rejected:** A separate secret for the role. Revoking sessions
on retirement — the fence answers `session_revoked` on the next request
without a per-member fan-out; the desktop's wording is the remaining gap
([`workspace-retirement.md`](workspace-retirement.md#open-questions)).

**Consequences:** Adding an operator router means naming its roles. The typed
confirmation on retirement is a client-side ceremony; the server-side
comparison of the confirmation with the path is a consistency check, not a
second factor.

### 2026-09-04 — Appearance files can no longer execute code

**What changed:** The animated theme-document iframe, its custom protocol,
Content Security Policy exception, generated document module, and schema field
were removed. Appearance files now produce only CSS values and a fixed remote
font manifest; `rally-font://` is the only appearance-adjacent scheme.

**Why:** Rally now has one GrokBot-derived design with light and dark
appearances. Keeping an unused executable decoration format preserved a larger
trust boundary and protocol surface without a product capability that needed
it.

**Consequences:** The renderer CSP no longer admits an appearance frame and the
main process registers no appearance-document handler. Remote fonts retain the
existing generated allowlist, size cap, and optional integrity verification.

### 2026-09-03 — An inbound-email run is no longer read-only

**What changed:** The three `inbound_email` tool guards in
`apps/api/src/services/integrations.ts` are gone: write-mode connector tools are
no longer withheld from a mail-started run, the Firecrawl search and fetch tools
are no longer omitted from one, and a child harness spawned by one keeps its web
tools. The invariant above that said a spoofed From "buys a read-only run" is
rewritten to say what is true now.

**Why:** The filter named one trigger out of several that carry untrusted
content. A `connector_activity` or `webhook` run reads equally untrusted
third-party text while holding every write tool it was bound, so a boundary
drawn around inbound email alone was not a boundary, and its presence in the
document let a reader believe the exfiltration channel was closed when it was
open for every other external trigger. The decision recorded in
[`automation-lifecycle.md`](automation-lifecycle.md) is that trigger-content
trust is decided once, for every external trigger, at the level that already
screens who may start a run, rather than in a tool rule that knew only this one.

**Considered and rejected:** *Keeping the guard until a general one exists*,
which keeps a control that misdescribes itself as the protection and defers the
general question indefinitely. *A per-run trust flag on the workflow input, gated
at both tool-assembly sites*, which is the shape a general control would take and
is the natural follow-up if one is wanted; it was not built here because no
number or policy for it has been decided, and per the rule on defensive limits
that decision is the team's, not a guess in a refactor.

**Consequences:** Ingress screening carries the whole weight for mail: a sender
must resolve to an active workspace member or the mail is refused before a run
exists. A mail-started run's prompt is steered by the mail body the same way a
connector-started run's is by the event payload, and the run may act on its
connectors accordingly. Anyone re-tightening this should do it for every external
trigger at once, and update this invariant and
[`workstream-email-addresses.md`](workstream-email-addresses.md) in the same
change.

Shipped in #541.

### 2026-09-02 — A link to the active workspace uses the session in use

**What changed:** An addressed link whose target is the active workspace no
longer re-activates it through the platform; Electron main answers with the
session already in use. Links into any other workspace still activate.

**Why:** For the active workspace the activation minted a credential that then
went through the same per-request membership check as the one in use, so the
round trip added no enforcement and cost a visible reload. It stays for other
targets because an ended membership leaves its session row alive and the
platform is what refuses that link before the window moves.

**Consequences:** The rule that external workspace targets cannot rely on local
authority still holds for every target that is not active. Shipped
in #484.
### 2026-09-02 — Conversation rail gets a bounded window-geometry capability

**What changed:** The sandboxed main renderer can tell main whether its attached
conversation details rail is open and how wide the rendered rail is. Main may
grow only the primary Rally window within its current display work area and
reverses only the growth it recorded.

**Why:** An attached details panel should add room when the desktop has it;
shrinking the transcript in an otherwise non-maximized window makes opening
context destroy the conversation layout.

**Considered and rejected:** Exposing `BrowserWindow`, coordinates, generic
resize IPC, or admitting Settings/meeting renderers would turn a presentation
detail into a broad window-control capability. Resizing from the renderer with
web APIs cannot control an Electron BrowserWindow reliably.

**Consequences:** Future geometry requests stay main-window-only and accept
semantic state rather than arbitrary bounds. Maximized and full-screen windows
remain untouched.

### 2026-09-02 — Prepared feed admission remains revocable and one-use

**What changed:** The feed JWT now signs role and work-stream authority
generation. SubstreamAgent reuses them only when an internal ticket-transit
preparation matches the complete verified identity, expiry, cursor, speculative
intent, and ticket ID, the session/membership decision was revalidated during
ticket transit, and the object's own generation still matches. Current regional
maintenance authority is read at every upgrade. A constant-size revocation
fence prevents older in-flight preparation from reappearing, and newer tickets
replace the room's single retained preparation. Ticket consumption remains a
durable atomic operation performed only at upgrade.

**Why:** Removing repeated room D1 reads is safe only if it spends the exact
decision made by authenticated ticket issue without creating a longer-lived or
less-revocable credential. A role header alone would be merely forwarded input;
the signed claim, local preparation, generation check, and durable receipt are
the complete boundary.

**Considered and rejected:** Persisting prepared admission or snapshots would
create another credential/content store. Letting the signed claim bypass D1
after preparation was lost would miss a revocation delivered while the object
was active. Consuming the ticket during preparation would make a failed warm-up
invalidate the real connection.

**Consequences:** The common prepared path skips the regional session/membership
join, but not current maintenance authority, without extending the ticket's
60-second lifetime or one-use scope. The security model explicitly trusts the
revocation fan-out to close prepared admissions and live sockets after a D1
session or membership change; the prepared fast path deliberately does not poll
D1 again at upgrade. A matching prepared ticket may therefore upgrade while
that fan-out is in transit. The ticket is valid for at most 60 seconds, natural
session expiry is checked locally, and delivered fan-out removes the preparation
or closes the socket. Revocation received before preparation, eviction,
mismatch, stale authority generation, and preparation failure all discard the
optimization and preserve the prior fail-closed path.

### 2026-09-01 — Model-authored web content gets its own origins, and its own fences

**What changed:** Three invariants for the artifact runtime — separate origins
for model-authored content, the fetch-metadata admission that closes
cross-artifact CSRF, and the rule that a new ticket audience never issues a
ticket in a URL.

**Why:** Serving model-authored HTML is a genuinely new trust surface, and two
of its hazards are ones origin separation alone does *not* close. Every artifact
is a subdomain of one registrable domain, so two artifacts are same-site:
`SameSite` does not stop a credentialed request between them, and a simple
`POST` needs no preflight, so the victim's handler runs even though CORS hides
the response. Closing that at the serving Worker is the only place it can be
closed once, for every artifact, without trusting model-written handlers to
defend themselves — which is why GETs are refused too, since nothing about such
a handler makes it safe by method.

The URL rule is the existing ticket rule applied to a new audience: Cloudflare
records whole URLs into the invocation log, Logpush, and traces, and no
redaction in this repository reaches them. A fragment is never sent to a server,
so the code redeems through a request body at an endpoint that never serves
artifact content.

**Considered and rejected:** capability URLs — "anyone with the link" — which
contradict the house rule that knowing an identifier grants nothing; and relying
on single-use redemption alone, which bounds replay but cannot keep a secret out
of a log.

### 2026-08-31 — Lockdown encrypts the complete account credential set

**What changed:** The main-owned session envelope now stores a retained Global
identity credential and independent region-bound workspace credentials with
matching cached profiles. Version-1 values migrate losslessly into the
version-2 set. Lockdown re-encrypts the whole set, and sign-out revokes every
locally stored credential/profile copy before attempting best-effort server
revocation for the captured sessions.

**Why:** Switching workspaces cannot require renderer-held refresh material or
a fresh Google sign-in, and encrypting only the active credential would leave
background workspace authority outside the Lockdown promise.

**Consequences:** Exact-credential refresh failure removes one workspace without
touching siblings. A failed online logout is reported, but local sign-out still
deletes the complete set and all drafts. The preload gains only scoped actions;
it never exposes refresh tokens or the encrypted set.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-30 — Spoken messages keep Azure authority in the regional Worker, and renderer media is limited to owned and in-memory URLs

**What changed:** The renderer can stream message PCM only through the
authenticated regional `/speech` route. The Worker owns the Azure inference
endpoint and key; the renderer validates Rally's fixed PCM format and plays the
in-memory stream without changing CSP.

The desktop renderer CSP now declares `media-src 'self' blob:` in both the
checked-in HTML policy and the runtime response-header policy. Generated audio
is fetched through Rally's authorized resource route, converted to an in-memory
object URL, and played by the native audio element; no remote or data-URL media
origin was added.

**Why:** Direct provider playback would put production inference authority in an
untrusted renderer. A provider URL or preload audio bridge would widen a second
trust boundary when the existing authenticated HTTP boundary already supports a
streaming body.

The renderer already allowed `blob:` images, but an audio element fell back to
`default-src 'self'` and Electron blocked its object URL after the resource had
loaded successfully. Visible controls therefore looked usable while playback
could never begin.

**Considered and rejected:** Exposing an Azure key, minting provider URLs, and
adding an Electron IPC/media bridge. Each grants more authority than reading one
already-authorized Rally response. Adding `https:` to `media-src` or pointing
the element at an authenticated API URL. The former lets document-authored
remote media bypass Rally's resource boundary; the latter cannot carry the main
process-owned session and complicates revocation. A short-lived object URL keeps
the existing authorized fetch and cleanup lifecycle.

**Consequences:** Speech stays region-scoped and content-free in logs. Future
audio playback must not treat `media-src`, preload, or direct provider access as
a shortcut around the regional API. Any future media player must use same-origin
or revocable `blob:` content. The HTML and runtime policies are an intentional
duplicate and their invariant test must keep them aligned.

### 2026-08-30 — Separate operator OAuth from product identity

**What changed:** `mcp.internal.rallywith.ai` is protected by its own Cloudflare
Access application with Managed OAuth and Dynamic Client Registration. It
copies Ace's configured identity providers and admission policy but receives a
distinct audience, which the Worker verifies before registering raw-SQL tools.

**Why:** Database-console authority must be granted as operator access, never as
a consequence of Rally membership or a client-supplied header.

**Considered and rejected:** Rally sessions, a shared bearer secret, and
trusting Access headers without signature/issuer/audience verification all mix
trust domains or fail open if the Access route is removed.

**Consequences:** An admitted Access identity can deliberately mutate product
SQLite in either region. Audit logs identify the actor/tool/target but must not
contain SQL, bindings, returned rows, or SQLite error text.

### 2026-08-30 — Mermaid SVG is a strict generated-markup boundary

**What changed:** The Markdown renderer may insert SVG generated from a
`mermaid` fence. Mermaid is initialized with strict security, HTML labels and
interaction disabled, and secure configuration keys that keep diagram
frontmatter from widening those choices or replacing Rally's token-derived
theme. The lock covers the security level, HTML labels, startup/error/resource
caps, theme, theme CSS/variables, typography, and visual look. Its
`bindFunctions` result is not used; invalid input falls back to the source
block. Both the global and flowchart-specific HTML-label settings are false,
because some Mermaid flowchart shapes read the nested value directly. Strict
mode still emits ordinary SVG links, so Rally unwraps anchors and
removes every non-fragment `href` before inserting the result. A generated style
block or presentation attribute containing a non-fragment CSS resource rejects
the entire diagram instead of allowing its display to make an external request.
Before preflight parsing, Rally applies Mermaid's initialized and secured text-size
ceiling. A source preflight rejects external CSS resource functions in Mermaid
style directives, and parsed flowchart image nodes and block styles are rejected
from Mermaid's database before render, because Mermaid can otherwise fetch them
while drawing or measuring, before output sanitisation can run. Parsed-style and
generated-SVG scans remain as additional boundaries before insertion, and the
generated SVG is rejected if it contains a `script` or `foreignObject` even if
Mermaid's strict sanitizer were to regress.

**Why:** Diagram rendering necessarily produces markup from untrusted model or
member text, unlike the rest of Rally's raw-HTML-free Markdown path. Naming and
locking the one exception keeps `dangerouslySetInnerHTML` from quietly becoming
a general rendering technique and prevents a model-authored diagram from
turning labels into HTML or destinations into UI behavior.

**What a future change has to respect:** keep the insertion point confined to
Mermaid's strict sanitised SVG. Do not enable loose/antiscript mode, HTML labels,
callbacks, or `bindFunctions`. Keep the post-render link removal even when
upgrading Mermaid, and keep rejecting pre-render image nodes, non-fragment CSS
resources, and scriptable output elements: `strict` does not mean non-interactive
or network-inert. A request for interactive diagrams is a new trust-boundary
decision, not a styling change.

### 2026-08-29 — The deep-link failure window joins the trusted-sender set

**What changed:** A fourth BrowserWindow, showing a refused deep link, is a
trusted IPC sender. Its own three channels are gated by a narrower check that
admits only that window, and the message it displays is validated in main against
an open length limit.

**Why:** The failure had no visible surface at all for the case that matters
most — a connector completion is delivered to the settings window, which renders
no application shell — so the message had to leave the renderer, and a window
that main owns is a new sender on the boundary this section defines. The narrower
check exists because `deep-link-error:dismiss` closes a window: reachable from
every renderer, any of them could discard a message the person had not read.

**Considered and rejected:** Reusing `assertTrustedIpcSender` alone for all three
channels. It is the check every other handler uses, but it admits four windows to
a channel that only one of them has any business calling.

**Consequences:** Anything that enumerates Rally windows must tolerate one that
can appear with no session behind it. The message is a string rather than a
closed set of codes, so untrusted text from a `rally://` link can reach an
always-on-top window; bounding it at the point it is built is the real fix, and
the limit is the backstop until then.

Shipped in #TBD.

### 2026-08-26 — Broker fallback and payload policy stay inside the capability

**What changed:** Brokered work-stream sockets preserve Electron's complete PAC
directive order and advance only after a pre-open failure. The main/preload
event boundary has one dependency-free strict validator, and Node plus both
server objects enforce one shared 1 MB frame ceiling.

**Why:** Keeping only the first PAC directive changes enterprise network policy
and can make the authenticated HTTP surface work while all realtime transport
fails. A 100 MB Node default also widens the privileged IPC transport far past
the application protocol accepted by the Durable Objects.

**Considered and rejected:** An unconditional direct fallback would bypass PAC
policy. Importing the renderer's full Zod graph into the sandboxed preload would
increase that bridge's dependency surface merely to share four event shapes.

**Consequences:** `DIRECT` is permitted only when Electron returns it, malformed
events stop at preload, and every future frame-limit change must use the shared
contract constant rather than transport defaults.

Shipped in #341.

### 2026-08-26 — The Node socket broker is a route-confined capability

**What changed:** The primary Electron renderer may ask main to open, send on,
or close WorkstreamDO control and SubstreamAgent feed sockets through typed IPC.
Main parses every input, confines the URL to a configured regional socket
origin and the route shape declared by the socket kind, requires the ticket
sentinel, supplies the application Origin, and terminates all sockets on
renderer navigation, destruction, or process exit. The Node transport resolves
proxies through Electron and includes operating-system CA roots. Settings and
Meeting renderers are denied.

**Why:** Moving these two handshake types out of Chromium removes its
same-endpoint connection queue, but a generic main-process WebSocket bridge
would give compromised renderer content a privileged arbitrary-network
primitive. The transport optimization must not widen the renderer's authority.

**Considered and rejected:** Letting the renderer provide headers or Origin,
accepting any configured-host path, and sharing the bridge with every Rally
window. None is needed for work-stream warming, and each makes the capability
broader than the authenticated ticket endpoints it replaces.

**Consequences:** New brokered socket purposes require an explicit kind and
path-validation branch. Tickets remain renderer-visible because the existing
ticket protocol needs them, but main never logs protocols or URLs and no ticket
is placed in a URL. Unsupported proxy directives fail the connection rather
than falling back to a direct route that could bypass network policy.

Shipped in #341.

### 2026-08-25 — The public Trust Center describes only implemented boundaries

**What changed:** The public security page became an ungated Trust Center with
implementation-backed control summaries, direct links to every applicable public
policy, the configured service-provider categories, operationally honest FAQs,
and coordinated reporting. The landing page links to it only from the footer.

**Why:** A conventional procurement surface is useful only when its green checks
mean something. The previous prose mixed a policy-shaped narrative with claims
that were broader than the current desktop defaults and socket compatibility
path. The replacement was regenerated from the current API, Electron,
deployment, logging, CI, and provider configuration, and explicitly names the
default application-wide desktop session key and legacy socket-query acceptance.

**Considered and rejected:** Copying a hosted trust-center template, displaying
certification badges without independent assurance, publishing names of internal
policies that are not actually public, and putting documents behind an email or
access-request gate. Those choices create the appearance of maturity while
making the underlying evidence harder to inspect.

**Consequences:** A public control must continue to be traceable to shipped code
or checked-in deployment configuration. Certifications and internal documents
remain absent until they exist and are current; changes to desktop session
storage, regional telemetry, socket transport, providers, or public policy links
must update the Trust Center in the same change.

### 2026-08-25 — The desktop's stored-data namespace follows the rename

**What changed:** The application name became `Rally`/`Rally Development`, its
userData directory moved to a matching name, the encrypted session files moved
from `avalon-data` to `rally-data`, and the session envelope headers are minted
as `rally-session/*`. Each superseded location is still read: the userData
directory is adopted by an atomic rename on the first launch that finds it, the
session directory by a one-shot rename, and the superseded envelope headers by
carrying the header a value was sealed with into the AES-GCM AAD. The bundle
identifier became `ai.rallywith.desktop`.

**Why:** These are values the previous build wrote and the next build reads,
which is the same shape as a hostname and is governed by
[`domain-migration.md`](domain-migration.md). Renaming them without reading the
old ones signs everyone out and abandons their local state — settings, drafts,
the Chromium profile — in a directory nothing looks at again. A directory rename
rather than a per-file migration because the file list is not knowable from this
repository: Chromium writes into that directory too.

**Considered and rejected:** Keeping the application name at `Avalon` to preserve
the `safeStorage` keychain entry. That is the one thing the rename genuinely
breaks and cannot repair, but it costs only Lockdown users one sign-in, and the
alternative is an application whose name in the keychain, the crash reporter, and
the Dock disagrees with the product forever.

**Consequences:** Lockdown users sign in once after updating; the failure mode is
the sign-in screen, not a crash, because an undecryptable envelope is already
caught and treated as no session. Signing is unaffected — a Developer ID
Application certificate is issued to the team, not to a bundle identifier, and
at the time of the rename none of the entitlements required a provisioning
profile. Apple push and associated domains now require the embedded Developer ID
profile described in [Apple push](push-notifications.md).

The bundle identifier is the expensive part, and it is not only a TCC and
login-item reset. **Squirrel.Mac cannot update across a bundle-ID change**, per
the macOS distribution section above, so an installed `app.rally.desktop` build
cannot receive this release through the update feed it already polls: the rename
has to reach those installs as a manual reinstall. Keeping the identifier would
have avoided that entirely, at the cost of an `avalon` string in the shipped
bundle forever. The rename was chosen deliberately; the migration it requires is
a release-sequencing decision recorded in [`runbook.md`](runbook.md), not
something this change can solve on its own.

### 2026-08-25 — The renderer origin is app://rallywithai, and both are admitted

**What changed:** The packaged renderer serves from `app://rallywithai`. Both regional
Workers list `app://rallywithai` and `app://avalon` in `ALLOWED_ORIGINS`. The saved
message card's scheme became `rallywithai-export://`.

**Why:** The rebrand to Rally reached the two internal schemes. The renderer
origin is not merely internal — it is the `Origin` header on every API request
and WebSocket upgrade the desktop makes, and a desktop build shipped before the
rename sends `app://avalon` with no way to change it. An origin that is actually
sent but not listed fails at the CORS preflight, before any route code runs, so
it produces a transport error in the renderer and no API request log at all: the
exact failure this policy exists to prevent, applied to ourselves.

The export scheme took no such window. It is registered, served, and loaded
inside one process against a single-use in-memory token, so no other party holds
an `avalon-export://` URL to honour.

**Considered and rejected:** Leaving the renderer origin alone, since nothing
outside the product reads the string. That is true of the name and false of the
header: the Workers read it on every request, which is what makes it a
compatibility surface rather than a label.

**Consequences:** `app://avalon` stays in the allowlist until shipped clients
carrying it are gone; removing it is a decision about installed builds.
Nothing automated asserts both origins are listed in configured deployments, so
dropping one does not fail on the edit. The origin policy is
otherwise unchanged — it still admits exact origins only, and CORS remains not
authorization. See [`domain-migration.md`](domain-migration.md).
### 2026-08-25 — The origin allowlist admits both site zones

**What changed:** `ALLOWED_ORIGINS` on the Global Worker admits
`https://rallywith.ai` and `https://www.rallywith.ai` alongside the two Rally
origins. The site's CSP `connect-src` permits both API origins.

**Why:** The rebrand to Rally put the public site on two zones at once. CORS is an
exact-origin match made by the browser before any route code runs, so an origin
that is actually served but not listed fails as a transport error with no API
request logged — the failure mode this policy already exists to prevent. Listing
all four served origins is the same rule applied to a site that now has four.

**Considered and rejected:** Matching the site origins by suffix or pattern
instead of listing them. Exact origins are the entire strength of this check; a
pattern that admits `rallywith.ai` also admits a look-alike that ends in it.

**Consequences:** The list grows and shrinks with what is actually served, and an
origin is removed from it only when its route is. This widens who may *call* the
capability-bound anonymous telemetry surface and nothing else — CORS remains not
authorization, and the site still receives no session, token, or signing key. See
[`domain-migration.md`](domain-migration.md).
### 2026-08-24 — Input validation keeps body shape without keeping content

**What changed:** Rally's Hono validator now throws a typed internal validation
error carrying the request target, bounded Zod issue paths/codes, and a parsed
JSON body whose terminal values have already been replaced with `"***"` or
`-1`. The error middleware adds those fields plus method and route to
`request_failed`; malformed JSON records a root `invalid_json` issue without a
body. Public 400 responses are unchanged.

**Why:** Production recorded that a request returned 400 but discarded the
field that failed, making a rejected message attempt impossible to diagnose
afterward. Paths identify the rejected field, while the recursively masked body
shows the complete client payload shape needed to diagnose version skew without
retaining member-supplied values.

**Considered and rejected:** Returning field details to the desktop broadens the
public contract and can expose validation internals; logging the raw Zod error,
issue message, or unmasked body captures rejected values and regexes. Logging
only issue paths omits sibling fields and nesting that distinguish an old client
contract from a malformed individual value.

**Consequences:** New request validators automatically receive this diagnostic.
Every parsed JSON leaf is masked before the error reaches the logger, including
under credential-shaped key names. Any custom 400 path that bypasses
`zValidator` must perform the same value-free transformation if operators need
its body shape.

### 2026-08-20 — A theme's backdrop runs its own script, in a box with no doors

**What changed:** a theme may ship a whole HTML document as the window's
backdrop. It is served from `avalon-backdrop://`, a scheme of its own, under
`default-src 'none'` with no `connect-src`, into a frame carrying
`sandbox="allow-scripts"` and *not* `allow-same-origin`. A second scheme,
`avalon-font://`, serves font files a theme named by URL: the main process
fetches each once, verifies a declared `sha256-` integrity, caps it at 8 MB, and
writes it under `userData`.

**Why:** The retired appearance's backdrop is a field of light that orbits, and no CSS value
orbits. The choices were a declarative motion vocabulary covering that one case,
or letting a theme bring a script. A script is the honest answer for a file
format modelled on VS Code themes, where the whole point is that people will
eventually write their own — and the moment they do, "a theme is data" stops
being true and the isolation has to be real rather than assumed.

Three mechanisms, covering three different things. The scheme withholds the
application's origin, and with it whatever that origin is ever granted. The
policy withholds the network, so a backdrop cannot report that it was rendered —
which for a document nobody audits is the difference between decoration and a
beacon. The sandbox withholds the parent document, storage, and the preload
bridge. Any two of the three leaves a hole the third was covering: the policy
without the sandbox is a document reading the application's DOM; the sandbox
without the policy is a document calling out. Verified in a running window, not
argued: `parent.location`, `fetch`, and `localStorage` all throw, and nothing
Rally-shaped is on `window`.

The remote-font scheme exists for the same class of reason. A theme could have
put `https://…` in a `@font-face` and the CSP would have permitted it, but then
every cold start announces the reader to whoever runs that host, for as long as
the theme is in use. Fetching in main and serving from a content-addressed cache
makes that a single request on first use.

**Consequences:** the window's `onHeadersReceived` policy must keep skipping
backdrop responses. It ends in `frame-ancestors 'none'`, so attaching it means
the backdrop never renders — the same early return the message exporter needs,
for a sharper reason. A backdrop frame must never gain `allow-same-origin`, and
the backdrop policy must never gain a `connect-src`; either alone turns the
document from decoration into a participant.

### 2026-08-13 — A saved message is rendered outside the application's origin

**What changed:** Exporting one of Rally's messages as a picture or a PDF renders
it in a hidden, preload-free window on a scheme of its own, `avalon-export://`,
serving one in-memory document per single-use token under a `default-src 'none'`
policy. The request's four fields are parsed in main, and its proposed file name
is rejected rather than sanitized.

**Why:** The card is a page built out of a model's words. The cheap version —
adding a route to the existing `app://avalon` handler — would have given that page
the renderer's origin, and with it whatever the application's own origin is ever
granted. A second scheme costs one registration and removes the question.
Rejecting the file name rather than stripping it follows the same reasoning as the
URL-scheme invariant above: text a model wrote reaches a filesystem API, and a
bounded pattern is checkable in a way that "we strip the dangerous parts" is not.

**Consequences:** The export window must stay preload-free. It has no legitimate
use for the bridge, and adding one would hand the desktop's privileged API to a
document assembled from model output.
[`message-export.md`](message-export.md) owns the rest of the design.

### 2026-08-13 — Repository choice is model-driven but policy- and recovery-fenced, and full access uses the native trained CLI path

**What changed:** The model may select an exact GitHub repository through a
typed Terminal tool. Connector settings bind repository IDs to read-only or full
remote access, every read/publish boundary rechecks that policy, and Rally must
store a verified recovery resource before destroying sandbox state for another
selection.

A connector's `full_access` setting gives the Daytona sandbox a short-lived
single-repository GitHub App credential for standard Git and GitHub CLI writes.
Rally creates/restores and checks out the persisted word-based work-stream
branch first; read-only continues to be enforced by token permissions.

**Why:** Removing the participant chooser avoids an unnecessary interruption,
but moving choice into an untrusted model cannot give it authority to broaden
the GitHub App grant or silently discard persistent workspace bytes. GitHub has
no branch-scoped installation token, and building a Git/API proxy plus a
prose-derived single-use publication gate would over-architect the feature and
prevent normal multi-commit PR workflows.

**Considered and rejected:** Authorizing by mutable `owner/name`, treating
read-only as a prohibition on local edits, and deleting after only a tracked Git
diff. Those respectively permit replacement-repository confusion, remove safe
local capability, and lose untracked files and generated artifacts. Claiming
the repository token was branch-scoped, blocking `git push` in favor of only a
typed publisher, and parsing participant messages for a separate publish
authorization. The explicit connector policy is the durable user choice.

**Consequences:** Repository listings must disclose effective remote access,
configured entries must be revalidated by provider ID, and remote-write tools
must fail closed after policy drift. Repository replacement has bounded R2 and
latency cost and refuses workspaces whose compressed recovery state exceeds the
limit. Full access is genuinely repository-wide at GitHub. The model is told to
push only `AVALON_GIT_BRANCH`, while repository rulesets may provide a
provider-side backstop. New code must preserve credential rotation on policy
changes and must not expose token plaintext in commands, output, or logs.

### 2026-08-13 — Public-site and Lockdown telemetry observe without gaining provider, handoff, or transition authority

The main process contributes Lockdown enabled/available state to the bounded
settings snapshot and reports previous, requested, and applied booleans only
after an in-app transition succeeds.

**Why:** Measuring acquisition through a provider browser SDK would put
destination credentials and a generic capture surface into pages that also
handle OAuth, invitation, Slack, and resource handoffs.

Product analysis needs current Lockdown adoption and change intent, while the
security boundary must continue treating migration and preference
persistence — not the renderer click — as the authoritative transition.

**Considered and rejected:** A PostHog token in the site bundle, wildcard CORS,
query/fragment capture, and sharing one persistent epoch across regions. Each
turns an anonymous measurement surface into destination, credential, or
cross-region authority. For Lockdown: renderer autocapture, credential/keystore
details, and failure payloads. None are needed to answer adoption, and each
would widen the least-privilege telemetry contract.

**Consequences:** CORS still grants no API authorization. New site events must
fit the pre-authentication allowlist and prove their negative space; handoff
pages continue to erase or locally validate secrets independently of telemetry.
Lockdown telemetry remains subject to Product analytics opt-out, uses a closed
setting enum, and cannot influence migration, rollback, or session recovery.

### 2026-08-13 — Desktop mutation headers are proven at the CORS boundary

**What changed:** The regional API admits `X-Rally-Operation-Id` in its explicit
CORS header allowlist, and app-origin preflight tests cover the desktop mutation
header in both configured deployments. Connector telemetry-version negotiation
deliberately uses a query marker rather than another header. Caught renderer
transport failures use the existing sanitized, main-owned exception route
rather than a new renderer destination.

**Why:** Chromium stops a request at preflight when any renderer header is absent
from the Worker allowlist. Operation correlation must therefore be admitted in
configured deployments. The connector version marker avoids expanding that preflight
contract and remains safe while the independently deployed desktop and API
briefly run different revisions.

**Considered and rejected:** A wildcard CORS header policy, removing operation
correlation, or adding a direct renderer PostHog client. Those respectively widen
the accepted browser boundary, lose idempotent intent/outcome correlation, or
place provider authority in the untrusted renderer.

### 2026-08-13 — Telemetry keeps provider, operator, and raw-crash authority in main and the regional Worker

**What changed:** Added a closed validated telemetry IPC surface, owner-only
bounded local spools, fail-closed account preference, route-bound upload
capabilities, dedicated regional crash storage, no-egress private
symbolication, sanitized Global exception delivery, and reason-coded
support/replay audits.

Main creates an owner-only route-final parent around the Crashpad database,
stores only sparse lifecycle metadata beside it, invalidates the whole
generation without touching the live database, and deletes malformed or expired
generations instead of inferring policy.

**Why:** Electron crash dumps can contain memory and customer content, while a
renderer can be compromised independently of main. Product analytics also needs
identifiable Global profiles without making every event a copy of account data
or giving renderer code a destination credential.

A minidump may contain memory fragments and customer content, while Crashpad
cannot be stopped after start. Treating its active database as opaque avoids
corruption races; treating missing route/deadline metadata as ineligible
prevents a filesystem failure from expanding collection.

An internal helper is not an authorization boundary, and request fields cannot
prove an operator's identity or role. Sharing the signing key across regions
also widened a one-direction capability into authority held by both data
planes.

**Future changes must preserve:** No credential enters a Crashpad URL or local
generation, no renderer learns a dump path, invalidation remains durable and
generation-wide, and private symbolication compute receives only scoped objects
for one opaque work item.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Code execution and GitHub publication use separate trust zones

**What changed:** Rally can execute model-authored code in an
authority-fenced private Daytona sandbox with host-controlled egress and
read-only GitHub access. Generated resources cross through regional Rally
services. Remote branch/PR writes use a participant-intent grant and a fresh
isolated publisher rather than the work-stream sandbox credential.

**Why:** A useful CLI workspace must process adversarial repository and resource
content, but a GitHub write token or R2 credential in that same environment
would let prompt injection turn code execution into durable external authority.
Persistent files also outlive one model turn, so admission-time authorization
alone is insufficient.

**Considered and rejected:** Supplying the sandbox a reusable GitHub App write
token, signed R2 URLs, model-managed network rules, and trusting Daytona labels
as Rally's authorization ledger. Those collapse storage, egress, and external
write boundaries into an untrusted process.

**Consequences:** Revocation changes the sandbox generation; publication is
convergent and separately receipted; provider logs and failures must not expose
commands or credentials; and a real provider isolation/egress probe gates each
region.

Shipped in the pull request for this change. Design:
[`docs/PRDs/2026-08-12_daytona-terminal-git-github/prd.md`](PRDs/2026-08-12_daytona-terminal-git-github/prd.md).

### 2026-08-12 — Compaction resource awareness is current-principal data

**What changed:** Authorized resource totals and natural-kind groups are appended
only to live and replayed checkpoints. The shared compaction row retains the raw
summary and a principal-neutral base message without the inventory.

**Why:** Persisting a user's current visible-resource projection would both go
stale after revocation and risk replaying private-note metadata to a different
execution principal. Asking the LLM for counts is also not an authorization
check.

**Considered and rejected:** Persisting the rendered appendix and listing exact
resource metadata. The former freezes authority at compaction time; the latter
adds unnecessary sensitive metadata and unbounded context growth.

**Consequences:** Replay now requires a fresh authorized visibility read.
Failures at that boundary fail the run rather than reusing stale inventory, and
the stored summary remains reusable across principals.

Superseded by the principal-scoped replay boundary above. Shipped in
[#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Attachment continuations name state without granting authority

**What changed:** Attachment cursors are authenticated, purpose-separated, and
bound to their execution principal and owning scope. The model-facing failure
sanitizer accepts only bounded attachment kinds, MIME metadata, and exact read or
view remediation shapes alongside the existing fixed recovery fields.

**Why:** Lazy attachment reads need resumable state, but a mutable or replayable
cursor can become a cross-workspace read primitive if a later handler mistakes it
for authorization. Wrong-tool self-healing creates a second injection surface:
converter or file-authored error JSON cannot be allowed to manufacture an
arbitrary follow-up call.

**Considered and rejected:** Plain base64 cursor payloads and forwarding a
converter's whole structured error. Both are convenient representations of
untrusted state, not validation; signing the first and strictly parsing the
second preserves recoverability without widening authority.

**Consequences:** Every attachment handler still reauthorizes database state
after cursor verification. New recovery calls must be added to the strict
discriminated union before they can reach a model, and cursor contents themselves
remain excluded from logs.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

Earlier entries do not exist. This document predates the changelog rule in
[`module-documents.md`](module-documents.md#starting-one), and the reasoning behind
the boundaries above — beyond the reasons already written inline — was not recorded
here and was not reconstructed. `git log` and the PRDs under `docs/PRDs/` are what
exist. The next substantial change to a trust boundary starts the record, and that
entry is that change, written in full.
