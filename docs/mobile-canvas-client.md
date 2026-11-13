# Mobile canvas client

Rally's Expo app is a thin iOS and Android client for consuming canvases. Home opens the canvas dashboard; pinned canvases become tabs. Opening a canvas prefers its generated artifact. Chat remains available for editing, and opens directly when no artifact exists.

The native shell owns navigation and the Muse-inspired sidebar. The browser host supplies authenticated content and the existing composer, transcript, attachments, and artifact renderers.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/mobile/App.tsx` | Native tab navigator and headers, retained per-tab browser content, system conversation sheet, session scope and foreground refresh. |
| `apps/mobile/src/NativeTabIcon.tsx` | Rasterizes saved Lucide glyphs after native layout; Android uses content-addressed PNG files in Expo FileSystem’s cache. |
| `apps/mobile/src/pin-routes.ts` | Assigns Android’s four native pin destinations while preserving each canvas’s identity across reordering. |
| `apps/mobile/src/theme.ts` | Native adapter over the same source color tokens as Electron. |
| `apps/mobile/src/Sidebar.tsx` | Pin, unpin, drag ordering, accessible move actions, complete canvas directory. |
| `apps/mobile/App.web.tsx`, `src/PreviewTabBar.tsx`, `src/Glass.tsx` | Development-only browser preview; its custom controls do not model native geometry. |
| `apps/mobile/src/CanvasWebView.tsx` | Application WebView and isolated first-party live artifact WebViews. |
| `apps/mobile/src/CanvasWebView.web.tsx` | Development-only iframe preview of the native shell. |
| `apps/mobile/src/auth.ts`, `auth-callback.ts` | System authentication session and exact callback/attempt validation. |
| `apps/browser/src/mobile-sign-in.tsx` | Existing browser login followed by the return-to-app handoff. |
| `apps/mobile/src/protocol.ts` | Shared commands, validated snapshots, origin boundary, pin presentation capacity. |
| `apps/mobile/src/CanvasIcon.tsx` | Saved Lucide glyphs and themed canvas shading, with a sheet fallback. |
| `apps/browser/src/mobile-session.ts` | Account-bound organization preference and artifact routing decisions. |
| `apps/browser/src/mobile-bridge.ts` | Native handshake and explicit browser-preview handshake. |
| `apps/browser/src/mobile.tsx`, `mobile.css` | Mobile dashboard, artifact selection, shared chat and creation form. |

## How it works

The app opens the browser host with `?mobile=1`. The browser keeps its cookie authentication and organization selection. A native host opens the system authentication browser through `expo-web-browser`: ASWebAuthenticationSession on iOS and a browser Custom Tab on Android. Apple, Google, email and password sign-in use the existing browser entry. The app then exchanges a PKCE-bound, single-use ticket inside its WebView to establish an independent HttpOnly cookie session. On a returning launch, the browser restores the last organization only when its saved user matches the authenticated user and that organization is still in the authorized directory. The account row in the sidebar opens the organization picker; explicit sign-out clears the preference. After sign-in, `shell.tsx` selects the mobile presentation of the canonical Canvas routes instead of the desktop shell. The session providers and API client remain shared.

Home uses `#/canvases`; opening a canvas uses `#/canvases/:id`, just like desktop. The conversation sheet adds `?view=chat` to that same canvas URL; canonical `?artifact=` links select the named artifact, and validated `?turn=&sequence=` links reveal the named message through the embedded conversation’s explicit scroll request. Canonical path rewrites preserve the mobile and preview host parameters. Creation is local form state on the dashboard, then navigates to the created canvas. There are no separate mobile dashboard, artifact, conversation, or creation paths.

The dashboard consumes the current socket-owned Canvas directory. Opening a Canvas reads `GET /canvases/:id` and its published artifacts, preferring a site, then the newest file. Multiple resources expose an artifact picker. The matching Canvas row’s publication timestamp and the resource topic refresh detail reads in both artifact and chat views; shared resource-head state advances version-keyed metadata. Unrelated presence and pin updates do not refetch Canvas details. An empty canvas routes to chat and stays there while the user writes; View canvas explicitly returns to the artifact. Fetch failures show recovery rather than being mistaken for an empty canvas.

The native sidebar has Tabs and Canvases sections. Edit exposes plus/minus controls and drag handles. The Canvas directory supplies each pin’s name, appearance, and `pinnedPosition`. Native tabs are icon-only. Their full canvas names remain available to VoiceOver/TalkBack and in the sidebar. Sidebar directory failures offer retry. Pin writes use the canonical Canvas pin APIs, with one write in flight and server acknowledgments driving the UI. Home is fixed. The first four pins appear beside Home; existing desktop pins beyond those remain in the sidebar and can be reordered into view. This is a presentation capacity, not a new backend limit.

Visited artifact views stay mounted and attached to preserve local scroll and form state during tab changes. Inactive native views use zero opacity, disabled pointer events, and hidden accessibility descendants; `display: none` can detach WKWebView and replay its consumed access URL. The native containers disable view flattening so changing visibility or accessibility does not replace their children. Fragment navigation does not reset the shell, and full application-page loading retains artifact instances until the authenticated user or organization changes. File artifacts use the shared InspectorRail. Live sites use the existing `openArtifact` API to obtain an `openUrl` on their hosted artifact origin. Access queries belong to one mounted artifact/version instance and are discarded on unmount, so switching A → B → A obtains fresh access. That one-time URL establishes artifact access and redirects to the canonical hosted URL; loading the bare canonical URL would skip access for private sites. The browser preview frames the same hosted document directly. Native sites open in separate WebViews so their cookies are first-party on iOS, avoiding Safari's cross-site iframe restriction on interactive writes. Those views receive no native bridge. A native conversation sheet hosts the existing web transcript and composer. Native camera, photo-library, and microphone usage descriptions support its attachment and dictation controls; permission prompts occur when used. Creation uses the shared attachment lease and draft mechanisms. Creation first reserves the Canvas through `POST /canvases`, then sends its opening message and attachments through the existing HTTP conversation admission route. A create attempt retains its message receipt key, operation ID, and Canvas ID while the submitted content is unchanged, so either step can be retried safely. The form stays mounted through navigation while a request is pending; completion refreshes the directory without redirecting someone who already left the form. Edited retries keep the reserved Canvas ID and mint new message/operation receipts. The composer blocks submission while creation is pending and uses the same authorized member roster for mention confirmation and payload resolution.

Navigation uses Callstack's maintained [`react-native-bottom-tabs`](https://oss.callstack.com/react-native-bottom-tabs/docs/guides/usage-with-react-navigation)
and its React Navigation adapter. A shared native stack owns the header and
presents the conversation. The documented
`labeled={false}` and `tabBarIconRenderingMode="original"` options provide
icon-only tabs with full accessibility names and canvas colors. The Expo config
plugin owns Android's Material theme. The Android package carries an unchanged backport of merged
[Callstack PR #623](https://github.com/callstack/react-native-bottom-tabs/pull/623)
(commit `aa11d707a137ec33200519daa2be4718ac0cf7d1`) because npm 1.5.0 still
crashes when a tab is inserted before React Native sends its updated items.
`patches/react-native-bottom-tabs@1.5.0.patch` owns this temporary backport;
remove it when upgrading to a release containing that commit. No app-specific
native lifecycle logic or `react-native-screens` patch remains.
The tab navigator is a screen in the root native
stack, following React Navigation's documented nesting pattern. The focused
canvas updates that stack's header; conversation is another root-stack screen.
There is no stack per canvas: removing a dynamic SwiftUI tab with a nested native
stack exposed a controller-parent mismatch on iOS 26.5. Keeping the shared stack
above tabs avoids reparenting native navigation controllers when pins change.
Home is first. iOS pinned routes use canvas IDs and are scoped by the signed-in
user and organization. Android keeps four native pin destinations registered and
uses the supported `tabBarItemHidden` option for empty destinations. A canvas
keeps its destination while pinned; display order follows server pin order. On
unpin, its React content unmounts, but the empty native destination remains.
Removing native destinations exposed a blank selected page even with the
upstream insertion fix. This stable structure avoids deleting native tab
containers; it does not keep hidden WebViews or extra workspace sockets alive.
The assignments reset when account or organization changes. Removing the active
pin explicitly selects Home, including when an overflow pin immediately replaces
its Android destination. Unpinning closes that tab, so its unsaved
in-artifact state is not durable storage.

The previous React Navigation experimental native-tab integration required an
Android fragment patch and still lost the visible document when the selected
pin moved earlier. Use the supported navigator's lifecycle instead of maintaining
native fragment reconciliation in this app. Expo Router's documented dynamic
trigger hiding resets navigator state, so its native tabs are not used for live
pin changes. Native acceptance must cover insert, remove and reordering the
selected pin in both directions; a successful tab tap alone does not prove it.

Each tab lazily mounts a browser WebView on its first visit and retains it through tab switching. These pages reuse the existing browser session, Canvas REST APIs and workspace socket protocol. This means one existing workspace connection per visited browser page, rather than a new native data client or socket protocol. The focused page supplies directory snapshots and handles pin writes, so Android does not wait for an inactive WebView to resume rendering. Background snapshots cannot overwrite the visible page’s acknowledged state, and an initial loading snapshot cannot clear existing tabs before its first directory sync. Canvas screens receive their own artifact descriptors and keep their authorized hosted WebViews in stable native containers. Dashboard links and the pin manager select an existing native tab when possible. Unpinned canvases open within Home. The system conversation sheet uses the canonical chat URL and existing web composer.

The OS places the native tab bar and rail, including Duo’s outer screen, inner orientation changes and either side of Split View. No hinge angle or fixed width threshold chooses native navigation. Native safe-area handling reserves the system rail/bar; content extends behind the transparent header with a measured initial inset that scrolls away. The inset updates when geometry changes without accumulating padding. Header actions are native bar items on iOS, so the system can relocate or overflow them. Android uses its native navigation header with accessible actions. Main screens have sidebar/chat actions and no title or extra Home action. The Muse-inspired sidebar remains shared and custom, including pin/unpin, drag ordering and accessibility move actions. Its drag handle owns the gesture and disables parent scrolling during the drag.

Android native tab images use cached PNG file URLs because its native image loader does not render PNG data URIs. Native tab images use the same Lucide catalog and Electron ink/tint pairs as the sidebar, rasterized from SVG for platform tab items with original-color rendering. The SVG wrapper positions each complete glyph; Lucide receives `size` rather than `x`/`y` or explicit dimensions, which it would also forward to its child shapes and distort their geometry. Missing icons use PanelsTopLeft. The native theme reads Electron’s base and appearance tokens. iOS supplies Liquid Glass and its accessibility fallbacks; Android supplies native tab behavior and system Back. Predictive Back is disabled through Expo's
`android.predictiveBackGestureEnabled` setting, following [React Navigation's
Android setup](https://reactnavigation.org/docs/getting-started/#opting-out-of-predictive-back-on-android).
Enabling it on the tested Android emulator bypassed navigation and exited the
app from a selected pin. Native headers and ordinary system Back remain in use;
re-enable predictive Back only when the navigation stack supports it and device
acceptance passes. Keyboard avoidance only runs for nonzero keyboard height: Duo emits zero-height show events during display changes. System sign-in completion clears stale keyboard state. Window resizing leaves route keys, sources, selected canvas and conversation state intact. The Expo web preview retains custom controls solely for browser-content development and cannot validate native navigation geometry.

### System sign-in and production rollout

The native process creates a random attempt ID and S256 verifier, opens
`/app/mobile/sign-in/<attempt>/<challenge>` in the system authentication browser,
and keeps the verifier only in memory. The path survives Google and email
redirects without storing pending authentication in localStorage. The normal
browser entry handles login; the signed-in page identifies the account and offers
**Continue to Rally** or **Use another account**.

The authenticated page posts to `/browser/mobile/handoff`. The existing login
ledger issues a two-minute, single-use ticket bound to the attempt and challenge,
using the same storage and redemption primitive as desktop. The callback scheme,
host, path and attempt must match before native accepts the result. A
`sign-in-complete` command delivers the proof only to the first-party application
WebView, which posts `/browser/mobile/exchange`; its response sets the ordinary
HttpOnly cookie and returns credential-free identity metadata. Artifact WebViews
never receive this proof. The exchange joins the existing per-region Web Locks queue for cookie writers, so a late renewal cannot overwrite the new session. A transient session read failure offers retry without announcing sign-out or discarding native tabs. Sanitized response-schema errors retain rejected field names. The system browser's existing cookie is neither copied
nor revoked when the app signs out.

Deploy the API handoff routes and browser bundle together before distributing
the updated native shell. The native build needs `expo-web-browser`; an OTA or
Metro reload of the earlier development client cannot add that native module.
The default application origin remains `https://app.rallywith.ai`, with all
canvas operations using its existing REST and ticketed WebSocket transport.
Do not claim the deployed sign-in path is verified from a local integration test.

### Running locally

Use the repository setup in [dev-environment.md](dev-environment.md), then:

```sh
corepack pnpm install --frozen-lockfile
cp apps/mobile/.env.example apps/mobile/.env.local
corepack pnpm --filter @rally/mobile start
```

Set `EXPO_PUBLIC_RALLY_APP_URL` to a reachable browser host containing this change. The default is `https://app.rallywith.ai`; that deployment must include the mobile presentation and authentication handoff. A simulator can use the local browser Worker on port 8794. A physical device needs a reachable HTTPS development host, configured consistently with browser cookie and API origin settings. `localhost` on a device refers to that device. Use `corepack pnpm --filter @rally/mobile ios` on macOS or `android` with the Android SDK to build the native app. Generated native projects are ignored; Expo config is the source.

For a desktop preview, start the local API and set `BROWSER_APP_ORIGIN=http://localhost:5175` and the matching allowed origin in local development configuration, then run `pnpm env:sync`. Start the browser Vite server and Expo web preview:

```sh
RALLY_BROWSER_DEV_API=http://localhost:8787 corepack pnpm --filter @rally/browser exec vite --host 0.0.0.0 --port 5175
EXPO_PUBLIC_RALLY_APP_URL=http://localhost:5175 corepack pnpm --filter @rally/mobile web
```

The optional Vite proxy preserves the browser Origin and forwards the API and WebSocket path. This preview bypasses only the local browser Worker's framing restriction; production CSP is unchanged. Native builds load the browser host as the main document and need no framing exception. Set `EXPO_PUBLIC_RALLY_ARTIFACT_DOMAIN` only when using a different artifact deployment, such as `rallyusercontent.localhost` locally.

## Deployment and release readiness

There are two release surfaces:

- **Web content:** `.github/workflows/deploy-browser.yml` deploys the browser
  host on relevant `main` changes, including the shared mobile bridge and sign-in contracts. This
  ships the mobile dashboard and shared conversation code at `app.rallywith.ai`.
  The workflow must pass its existing repository-wide checks first; a local
  build or a branch change does not deploy it.
- **Native shell:** CI runs Expo export for iOS, Android, and web. This verifies
  JavaScript/assets only. `apps/mobile/eas.json` defines a `simulator` development
  profile (iOS Simulator and Android APK), with `expo-dev-client` for live
  reload. The `preview` profile produces a standalone internal-distribution iPhone
  IPA against `https://app.rallywith.ai`, without requiring Metro. The project is linked as `@juno-ai-labs/rally-mobile`, and EAS has produced
  both iOS Simulator and Android development builds. Store signing, a native release
  workflow, TestFlight/Play distribution, and EAS Update remain unconfigured. The
  iOS identifier is registered with Apple and EAS holds its distribution certificate
  and ad hoc provisioning profile. This does not create an App Store listing.

The physical iOS app uses `ai.rallywith.mobile`; Apple rejected the initial
`ai.rally.mobile` development identifier for the Juno AI Labs team. The
`rally-mobile` sign-in scheme remains unchanged.

For an installable iPhone build, register the phone under the Juno AI Labs Apple
team with `eas device:create`, then configure iOS signing through `eas credentials`
for the `preview` profile. Run `eas build --platform ios --profile preview` after
the compatible browser deployment succeeds. Ad hoc provisioning includes only
registered devices present when the profile was generated. For automated refresh,
current EAS CLI supports `--non-interactive --refresh-ad-hoc-provisioning-profile`
with an App Store Connect API key in Expo or the documented `EXPO_ASC_*` secret
environment variables. A new device can require a refreshed profile and re-sign;
a simulator archive cannot be installed on a phone. Store distribution remains
separate from this internal build profile.

To enable store distribution, choose the owning Expo/Apple/Google accounts,
confirm the bundle identifiers, link the EAS project, configure development,
preview and production build profiles, provide signing/store credentials through
secret storage, and add the chosen submission workflow. Use production browser
and artifact origins in release builds. Deploy compatible browser routes before
installing the native build; devices may retain an older bridge protocol after a
web deployment, so evolve that contract compatibly. OTA updates additionally need
an explicit runtime-version and channel policy; none is enabled today.

Run the device acceptance checks below before distributing a build. The browser
preview cannot prove native cookie behavior, keyboard handling, or Liquid Glass.

## Expo Simulators

Remote device testing uses the official [Expo Simulators skill](https://github.com/expo/skills/blob/main/plugins/expo/skills/eas-simulator/SKILL.md)
and [Expo setup guide](https://docs.expo.dev/eas/simulators/get-started/).
Use it to check native WebView cookies, Liquid Glass, safe areas, keyboard
handling, and Android Back, which the desktop preview cannot prove.

From `apps/mobile`, authenticate with `EXPO_TOKEN` supplied by the environment's
secret settings (or an interactive EAS login), confirm the owning Expo account,
and use the existing `@juno-ai-labs/rally-mobile` project. Its verified owner
and `extra.eas.projectId` are checked into `app.config.ts`; do not initialize
a second project. Check access before building or starting a device:

```sh
npx --yes eas-cli@latest whoami
npx --yes eas-cli@latest simulator:availability --json
```

Expo Simulators requires access on a paid Expo plan. An unavailable or
unauthenticated account must be resolved before starting a session. The
availability check does not start a device.

Build the current native development client with the checked-in profile:

```sh
npx --yes eas-cli@latest build --platform ios --profile simulator --non-interactive
npx --yes eas-cli@latest build --platform android --profile simulator --non-interactive
```

Both build platforms pin the `sdk-58` image; iOS uses Xcode 27.1 for Duo support. The iOS profile targets the simulator, not a signed physical-device app. Android
produces an installable APK. EAS may manage development Android signing; this is
not store-release configuration. These builds require Expo authentication and
project linkage even though iOS Simulator does not need Apple signing.

For live edits, set `EXPO_PUBLIC_RALLY_APP_URL` to a reachable HTTPS browser host
that includes this branch's mobile presentation and authentication handoff, then start Metro on an unused port:

```sh
EXPO_UNSTABLE_TUNNEL_V2=1 EXPO_NO_DEV_MENU=1 corepack pnpm exec expo start --dev-client --tunnel --port 8082
```

The Metro tunnel transports the development bundle and assets only. It does not
make the local API/browser host reachable. Expo also offers private local egress,
but it was not enabled for `juno-ai-labs` when this integration was configured. A remote device's `localhost` is the
remote device; use a deployed development browser host with its matching API,
cookie and origin configuration. Do not expose development-auth API routes as a
shortcut. The private Playwright snapshot replay is not a native test backend.

Check `npx --yes eas-cli@latest simulator:start --help` for current flags, then
start a named `agent-device` session with the matching development build ID and
its Metro development-client URL. SDK 58 accepts `rally-mobile://?__expo_url=<encoded-Metro-URL>&__expo_disable_onboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1` to avoid development-menu interference. Keep preview links private. Follow the skill
for connection, screenshots, interaction, and recordings of scrolling/gestures;
verify the session is `IN_PROGRESS` and displaying current code before claiming
native validation. Stop the created session with `simulator:stop` and stop its
Metro process when testing finishes.

EAS stores controller credentials in `.env.eas-simulator`, which is ignored by
Git. Keep session output and private test evidence outside the repository.

After changing native dependencies, rebuild the development client and restart
Metro with `--clear` before starting a paid session. A pnpm reinstall can move
package paths that an existing Metro process has cached. Fetch the target
platform's bundle first to catch resolution errors before device testing.

## Invariants

- Only the configured application origin and a per-WebView capability can update native navigation. `protocol.test.ts` exercises origin, document-path, nonce, and malformed-message rejection. Accepting generated artifact messages would give generated code account-level navigation capabilities.
- Live artifact open and canonical URLs share one origin under the configured artifact domain. The validator's tests reject nested, deceptive, credential-bearing, and cross-origin URLs. Artifact WebViews have no injected bridge; breaking that separation exposes shell actions to generated code.
- Home cannot be removed or reordered. Pin ordering preserves every server pin, including desktop overflow; `movePin` tests cover preservation and invalid moves. The fixed Home control is verified visually, with no automated guard.
- A failed resource request cannot imply no artifact. Error recovery precedes fallback routing; `mobile-session.test.ts` checks the routing decision, and browser acceptance exercises the stale-cache and recovery paths.
- Credentials remain in browser cookies. The bridge transmits display metadata, commands, short-lived artifact open URLs and the single-use sign-in redemption proof, never a password, access/refresh token or session cookie. Runtime schemas define this boundary.

## Boundary

This module owns mobile presentation, bridge state, and tab behavior. [browser-client.md](browser-client.md) owns authentication, regional transport, organization selection, and browser deployment. [pinning.md](pinning.md) owns canonical pin persistence and ordering. Existing artifact serving owns access tickets and generated-code isolation. There is no new mobile backend, native transcript implementation, or separate pin database.

The browser imports the framework-independent protocol from `apps/mobile/src/protocol.ts` and client sign-in locations from
`apps/mobile/src/auth-contract.ts`. Backend PKCE schemas are imported from
`@rally/contracts`. Changes to that contract must update both consumers. The Expo package is discovered by the existing workspace and recursive check commands.

## Failure modes and limits

Network and HTTP failures show retry views. Pin failure messages stay in the sidebar; failed writes do not manufacture a successful local order. New pins beyond the four visible mobile slots ask the user to unpin another; existing overflow remains accessible. Directory search filters the socket’s Canvas list. A removed or inaccessible canvas reports its read failure.

Renderer termination reloads the relevant WebView. An artifact retry requests a fresh access URL, rather than replaying an expired open ticket; an access or active metadata failure removes the stale native surface and exposes web recovery. The native handler also recognizes a failed `/redeem` bootstrap. Returning from inline chat republishes the active artifact descriptor. Sign-out and account/organization changes discard native artifact views; a full application-page reload can rebuild the tab directory. Foregrounding refreshes the directory and resource metadata. Unsaved in-artifact state survives tab switching, but a full page/app reload, closing that tab or process termination can discard it. Native navigation and Liquid Glass require device validation; a browser preview cannot validate WKWebView cookies, Android Back dispatch, keyboard resizing, native gestures, or system accessibility.

Sign-in uses the system browser and returns to `rally-mobile://auth/complete`. Cancelling leaves the app signed out, and retry creates a new attempt and verifier. External HTTP(S) links open in the system browser on both platforms; Android reports every navigation as `other`, so the handler uses the platform and destination origin instead of requiring iOS’s `click` signal. Push setup, offline canvas copies and app-store signing remain separate integration work.

## Testing

```sh
corepack pnpm --filter @rally/mobile test
corepack pnpm --filter @rally/mobile typecheck
corepack pnpm --filter @rally/browser typecheck
corepack pnpm --filter @rally/mobile exec expo install --check
corepack pnpm --filter @rally/mobile build
```

`apps/browser/test/mobile-session.test.ts` checks account-bound organization restoration and the stale-empty artifact race. `apps/desktop/src/renderer/lib/api.test.ts` checks that a retried opening message sends the caller’s original receipt key and attachments. The pure protocol tests execute command injection with adversarial IDs, validate the bridge and artifact origin boundaries, and exercise pin ordering. Expo export compiles iOS, Android, and web bundles; it does not install or launch native apps. Browser host tests still exercise the real Worker transport and CSP. Renderer `browser-entry`, `browser-cookie-writers`, and `browser-collaboration` tests cover transient recovery, schema diagnostics, cookie-writer ordering through a browser capability double, hosted-site remounts, socket publication/head updates, metadata recovery, inline-chat return, mention confirmation, pending submission and edited creation retry.

### Native verification (2026-11-13)

SDK 58 development builds were exercised against the production Juno Labs
organization through a temporary branch browser host. The reviewed backend
handoff is deployed; the mobile browser presentation remains part of this
unmerged change. Production pins were restored after each device run, and
artifact/conversation drafts were not submitted.

The final shared-stack implementation passed iPhone 17 (iOS 26.5) system sign-in,
artifact-first viewing, Home/tab draft retention, selected-pin movement,
removing/reinserting another pin, conversation dismissal, active-pin removal and
sign-out. This retest followed and fixed a controller-parent crash caused by
nesting a separate native stack inside each dynamic SwiftUI tab.

On iPhone Duo (iOS 27.1), selected canvas and drafts survived the actual outer-to-
inner display transition, partial folding, rotation, folding with the conversation
keyboard open, and Split View on either side. Screenshots confirmed native
controls and safe areas followed the window. The session recording contains a
roughly 0.6-second full-display blackout during panel handoff, including system
controls. A separate clean Duo session reproduced a longer full-display blackout
in Apple's Settings app with Rally absent. This establishes a system/simulator
handoff effect rather than a Rally-specific regression; it does not distinguish
recording behavior from the simulated OS display switch. These results establish
state and layout retention, not physical-device frame timing.

On Android Pixel 7, the final build passed production system sign-in with
cancel/retry, artifact-first viewing, Home/tab draft retention, selected-pin
reordering in both directions, removing/reinserting another pin, conversation
Back, system Back to Home, active-pin removal, and sign-out. Screenshots confirmed
icon-only Lucide tabs with canvas colors. This run includes the merged upstream
insertion fix, stable native destinations, cached icon files and the documented
predictive-Back opt-out. Both reorder directions were explicitly checked on
Android; the iPhone run checked movement earlier.

A targeted Pixel 7 review run additionally verified a same-window external
article link opening Chrome and Back returning to the retained artifact, plus
active-pin removal when an overflow pin immediately replaces its native slot.
The production organization had four canvases: this run added a temporary
fifth-pin bridge fixture and changed an existing article link's target only in
the device's document. Those fixtures were removed; no published artifact was
changed. System sign-in cancel/retry and sign-out also passed. A transient
session-failure retry screen was separately inspected in Chromium, and the
browser regression tests include eleven deliberate failing mutations.

All paid sessions were stopped after testing. These checks cover the exercised
flows, not every item in the broader manual acceptance list below.

### Private organization snapshot acceptance

`apps/mobile/e2e/canvas-snapshot.mjs` runs the Expo web shell against the real
local browser/API Workers with a caller-supplied private snapshot. Start the
three local servers described above, then run:

```sh
PLAYWRIGHT_MODULE=/path/to/installed/playwright node --import tsx apps/mobile/e2e/canvas-snapshot.mjs /path/outside/repository/scenario.json
```

`MOBILE_TEST_API`, `MOBILE_TEST_BROWSER`, and `MOBILE_TEST_EXPO` default to
localhost ports 8787, 5175, and 8081. The runner requires loopback hosts, uses
the development session route, and creates a separate local organization. Each
run writes screenshots and `report.json` beside the input. It does not belong
in CI: the private snapshot is deliberately absent from the repository.

The scenario includes `source` provenance; `canvases` with `sourceCanvasId`,
`title`, `appearance`, `createdAt`, `updatedAt`, optional `site` (`grocery` or
`unavailable`), and optional visible `messages` (`actor`, `author`, `text`,
`createdAt`); four `pinTitles`; `groceryTitle`; `emptyTitle`; `chatAssertion`;
`groceryHtml` (relative path); and `groceryData` (`items` and `sections`). This
lane exercises the captured grocery artifact's actual UI, so it expects its
`#new-item` input and Add button. Keep source transcripts, artifact HTML/data,
IDs and screenshots outside the repository. Obtain them through authorized
read-only access; do not include session credentials.

The Juno Labs scenario uses actual titles, appearances, visible conversation
messages, and the published grocery-list HTML/data. IDs are remapped locally,
with derived source hues preserved. Canvas reads, chat reads and pin writes
exercise the real local API. Artifact content and its small data API are
replayed in memory, with all other external browser requests blocked; edits
cannot reach the source organization. Protected artifacts whose content was
not captured exercise recovery instead. This proves shell navigation, pin
persistence/order, dimensions, artifact interaction and tab state retention,
but not production artifact authorization, backend item persistence, model
generation, or native WebView behavior. Device acceptance remains necessary.

Manual acceptance: sign in through the system browser with Apple, Google and email; cancel and retry sign-in; test an existing browser account and switching accounts; open Home; open an artifact and an empty canvas; create a canvas; edit through the conversation sheet; pin and unpin through sidebar Edit; drag to reorder; reload to check server persistence; check desktop overflow pins; disconnect and retry; sign out; test light/dark and Reduce Transparency. On devices, additionally verify artifact writes, keyboard behavior, Android Back, iOS sheet dismissal, VoiceOver/TalkBack reorder actions, and state retention across tab switching.

## Changelog

### 2026-11-13 — Add the Expo canvas consumer

The SDK 58 app uses platform-native tabs and stack headers with a shared
Muse-inspired pin manager. Callstack's supported native navigator replaces
app-owned tab geometry and experimental native lifecycle patches. Its label and
icon APIs keep icon-only visuals, Lucide canvas colors and spoken names together.
Canonical browser routes, REST calls and workspace sockets supply the dashboard,
conversation and creation flow. Hosted artifacts use their existing first-party
access flow in retained WebViews; no mobile data endpoints were introduced.

System authentication uses the existing browser login and the reviewed PKCE
handoff. The selected organization belongs to the authenticated account. Stable
canvas routes preserve visited documents while pins move, and only the focused
page publishes directory updates. Native safe areas and measured header insets
follow window changes; zero-height keyboard events do not hide navigation.

The native stack sits above the tabs so dynamic iOS pins do not reparent nested
navigation controllers. Android retains four native pin destinations and hides
empty ones through the navigator API, preserving the active document when other
pins change. Its dynamic insertion fix is an unchanged merged upstream backport
pending release. File-based native icons and React Navigation's documented
predictive-Back opt-out address failures found on device. iPhone, Duo and Android
acceptance is recorded separately from bundle/type checks above. Store
distribution and OTA updates remain unconfigured. A standalone internal iPhone
profile targets production so a registered tester can install an IPA without Metro.

Implemented in [#1589](https://github.com/juno-ai-labs/avalon/pull/1589).
