# Mobile canvas client

Rally's Expo app is a thin iOS and Android client for consuming canvases. Home opens the canvas dashboard; pinned canvases become tabs. Opening a canvas prefers its generated artifact. Chat remains available for editing, and opens directly when no artifact exists.

The native shell owns navigation and the Muse-inspired sidebar. The browser host supplies authenticated content and the existing composer, transcript, attachments, and artifact renderers.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/mobile/App.tsx` | Native tab navigator and headers, retained per-tab browser content, shared full-screen conversation navigation, session scope and foreground refresh. |
| `apps/mobile/src/NativeTabIcon.tsx` | Rasterizes saved Lucide glyphs after native layout; Android uses content-addressed PNG files in Expo FileSystem’s cache. |
| `apps/mobile/src/prepared-canvases.ts` | Keeps account-scoped pin descriptors and prepared session URLs; matches fresh access replies from Home. |
| `apps/mobile/src/pin-routes.ts` | Assigns Android’s four native pin destinations while preserving each canvas’s identity across reordering. |
| `apps/mobile/src/use-app-resume.ts`, `app-resume.ts` | Refresh after a real background return, without treating transient iOS inactivity as another launch. |
| `apps/mobile/src/theme.ts` | Native adapter over the same source color tokens as Electron. |
| `apps/mobile/src/Sidebar.tsx`, `SidebarDragRow.tsx`, `sidebar-drop.ts` | Long-press pin/unpin/reorder with edge scrolling, Edit controls and accessible move actions. |
| `apps/mobile/App.web.tsx`, `src/PreviewTabBar.tsx`, `src/Glass.tsx` | Development-only browser preview; its custom controls do not model native geometry. |
| `apps/mobile/src/CanvasWebView.tsx` | Application WebView and isolated first-party reactive artifact WebViews. |
| `apps/mobile/src/Dashboard.tsx` | Home's dashboard, drawn natively from the directory (the saved copy until Home answers) over Home's page. |
| `apps/mobile/src/dashboard-visibility.ts` | When the native dashboard covers Home's page. |
| `apps/mobile/src/directory.ts` | Compares Home snapshots on the fields the shell shows, so `updatedAt` ticks and Home's own navigation do not re-render every tab. |
| `apps/mobile/src/artifact-access.ts` | The one data request the native shell makes itself: fresh access to a pinned artifact on the shared session cookie, so renewal never waits for Home. |
| `apps/mobile/src/EdgePull.tsx`, `edge-swipe.ts` | iOS pull from the leading edge that drags the focused screen's sidebar open. |
| `apps/mobile/src/FloatingHeader.tsx` | The sidebar and chat buttons drawn over a native artifact in place of the native header, in the artifact's tone. |
| `apps/mobile/src/ArtifactPicker.tsx` | A pin's native artifact picker, for a canvas with several artifacts. |
| `apps/mobile/src/remembered-sites.ts`, `canonical-first.ts` | The site each canvas last showed, by canonical URL, so a dashboard tap reopens it on its cookie; and whether Home's later fresh access replaces that view. |
| `apps/mobile/src/saved-pins.ts` | The tab-bar pins' descriptors and canonical artifact URLs, saved per account so a pinned tab opens on its cookie at launch. |
| `apps/mobile/src/saved-directory.ts` | The last directory, saved on the device per account and removed on sign-out; launch opens Home at its organization. |
| `apps/mobile/src/recovery-order.ts` | Orders WebView recovery after a renderer crash: the visible screen first, hidden ones (Home included) once it has presented, shown or needed. |
| `apps/mobile/src/prepared-requests.ts` | Holds fresh-access requests while Home reloads and re-sends ones its old page never answered. |
| `apps/mobile/src/prepared-site-access.ts` | Reuses prepared cookies and clears consumed access while a retry requests its replacement. |
| `apps/mobile/src/artifact-presentation.ts` | Applies the artifact inset at document readiness and signals presentation without waiting for images. |
| `apps/mobile/src/CanvasWebView.web.tsx` | Development-only iframe preview of the native shell. |
| `apps/mobile/src/background.ts`, `runtime.ts` | Top-level background update task and registration; downloads never interrupt an open canvas. |
| `apps/mobile/src/notifications.ts`, `notification-target.ts` | Platform permission/token lifecycle and canonical notification routing. |
| `apps/mobile/src/diagnostics.ts`, `DiagnosticsScreen.tsx`, `RecoveryBoundary.tsx` | Local content-free diagnostics, user-requested sharing and recovery. |
| `apps/mobile/.eas/workflows/`, `.github/workflows/release-mobile.yml` | One-channel native-build/OTA releases and explicit store submission. |
| `apps/mobile/store.config.json`, `apps/mobile/metadata/` | English store listing, TestFlight description, test instructions and review notes. Review credentials stay in App Store Connect. |
| `apps/mobile/src/auth.ts`, `auth-callback.ts` | System authentication session and exact callback/attempt validation. |
| `apps/browser/src/mobile-sign-in.tsx` | Existing browser login followed by the return-to-app handoff. |
| `apps/mobile/src/protocol.ts` | Shared commands, validated snapshots, origin boundary, pin presentation capacity. |
| `apps/mobile/src/CanvasIcon.tsx` | Saved Lucide glyphs and themed canvas shading, with a sheet fallback. |
| `apps/browser/src/mobile-session.ts` | Account-bound organization preference and artifact routing decisions. |
| `apps/browser/src/mobile-bridge.ts` | Native handshake and explicit browser-preview handshake; marks `<html>` with the touch density. |
| `apps/browser/src/dynamic-type.ts` | Reads the person's iOS text size and writes it over the touch type roles. |
| `apps/browser/src/mobile.tsx`, `mobile.css` | Mobile dashboard, artifact selection and retained chat navigation. |
| `apps/browser/src/mobile-conversation.tsx` | Deferred shared transcript, composer and creation form. |
| `apps/browser/src/mobile-canvas-detail.ts` | One owner for publication/reconnect invalidation and shared event-driven detail queries. |

## How it works

The app opens the browser host with `?mobile=1`. The browser keeps its cookie authentication and organization selection. A native host opens the system authentication browser through `expo-web-browser`: ASWebAuthenticationSession on iOS and a browser Custom Tab on Android. Apple, Google, email and password sign-in use the existing browser entry. The app then exchanges a PKCE-bound, single-use ticket inside its WebView to establish an independent HttpOnly cookie session. On a returning launch, the browser restores the last organization only when its saved user matches the authenticated user and that organization is still in the authorized directory. It replaces the history URL and selects the organization inside the current document, retaining the restored session instead of downloading and booting the page again. An explicit organization choice uses the same in-place path; `chooseWorkspace` still forces the picker. The account row in the sidebar opens the organization picker; explicit sign-out clears the preference. After sign-in, `shell.tsx` selects the mobile presentation of the canonical Canvas routes instead of the desktop shell. The session providers and API client remain shared.

Home uses `#/canvases`; opening a canvas uses `#/canvases/:id`, just like desktop. The conversation view adds `?view=chat` to that same canvas URL; canonical `?artifact=` links select the named artifact, and validated `?turn=&sequence=` links reveal the named message through the embedded conversation’s explicit scroll request. Canonical path rewrites preserve the mobile and preview host parameters. Creation is local form state on the dashboard, then navigates to the created canvas. There are no separate mobile dashboard, artifact, conversation, or creation paths.

The dashboard consumes the current socket-owned Canvas directory. Each dashboard card wears its Canvas's appearance through the desktop's `canvasMark`, drawing its icon in that colour's ink on its tint, so a card matches its sidebar row and desktop card. The lead card deepens that tint toward the hue in a gradient. Opening a Canvas reads `GET /canvases/:id` and its published artifacts, preferring a site, then the newest file. Multiple resources expose an artifact picker. One mobile owner refreshes details when the matching directory row changes publication timestamp, artifact kind, title or visibility, or disappears. The first directory reconciles a detail read before it arrived; reconnects reconcile missed updates. Shared resource-head state advances existing artifact versions directly. Detail queries remain fresh between those events, and mounting a second observer does not repeat the read. Unrelated resource-topic, presence and pin updates do not refetch Canvas details. An empty canvas routes to chat and stays there while the user writes; View canvas explicitly returns to the artifact. Fetch failures show recovery rather than being mistaken for an empty canvas.

Canvases shared with the person as a guest in their other Organizations
([`canvas-share-federation.md`](canvas-share-federation.md)), which the server
pushes on Home's workspace socket, reach the shell
in the snapshot's own `sharedElsewhere` list, each with its Organization, never
in `canvases`: that list feeds tabs, pins and the sidebar, which are this
Organization's. The native dashboard places them among the Organization's own
by `updatedAt`, draws the Organization's initial in a square on the card's upper
right, and names it in the card's label ("Open Partner roadmap, Shared from
Acme"), since a touch screen has no hover. A tap sends Home `open-elsewhere`
(region, Organization, Canvas); Home loads that Canvas's canonical page with
`mobile=1` (and the preview's `mobilePreviewOrigin`), which opens it in its
Organization, as a notification's link from another Organization does. A shell
older than the field drops it and shows only its own Canvases. The saved
directory never holds them: they show once Home's live snapshot arrives. The browser
preview's dashboard draws the same list and badge from the same socket event.

During startup, the browser bridge announces `ready` with `waitForContent: true`.
The native shell keeps its existing loading surface until a non-loading directory
snapshot, a directory error, or `screen-ready` from an actionable entry screen.
The organization picker is not mounted while an automatic restore is pending.
Entry readiness is replayed if the native bridge attaches late. Older browser
hosts without the flag retain their existing reveal behavior. This change adds
no splash-screen dependency or artificial delay; Expo's native splash keeps its
normal lifecycle. The desktop navigation/settings renderer has its own lazy
boundary and is not fetched by the mobile shell. Chat/composition and InspectorRail are separate deferred imports: the dashboard downloads neither. Opening the first chat pays for its UI chunk; subsequent visits reuse it.

A warm return keeps the current native and browser views mounted. Native resume
refreshes require an observed `background` followed by `active`; an iOS sheet,
Control Center, or other `inactive` interruption alone does not invalidate Canvas
queries. Browser cookie revalidation and the existing socket heartbeat/reconnect
behavior continue to run without replacing the visible screen.

The native sidebar keeps Home fixed above Pinned and the remaining Canvases. Hold a canvas row and drag it into Pinned, between pins, or back into Canvases to pin, reorder, or unpin. A floating row and insertion marker show the destination; edge scrolling reaches off-screen rows. Dropping outside either section cancels. Edit still exposes plus/minus controls and drag handles, including accessible move actions. The Canvas directory supplies each pin’s name, appearance, and `pinnedPosition`. Native tabs are icon-only. Their full canvas names remain available to VoiceOver/TalkBack and in the sidebar. Sidebar directory failures offer retry. Pin writes use the canonical Canvas pin APIs, with one pin command in flight and server acknowledgments driving the UI. A new pin can carry an optional `beforeId` in the existing bridge command: the browser saves membership, then its position with the existing reorder endpoint. If positioning fails, the pin remains appended and the notice distinguishes a saved pin from its failed placement. Home is fixed. The first four pins appear beside Home; existing desktop pins beyond those remain in the sidebar and can be reordered into view. This is a presentation capacity, not a new backend limit.

Home prepares descriptors for the first four pinned canvases through its existing authenticated API and workspace socket. A pin with one hosted site opens that site's actual URL in a native WebView, without starting another browser shell. The shell prepares each visible hosted pin's session through Home's bridge and an attached, invisible native WebView. It loads only Rally's authentication bootstrap and cancels the redirect before the generated document. The tab-bar pins (the first four) are then loaded in full in hidden, attached WebViews, so their artifact code does run in the background: the team chose that on 2026-11-15, so a tap shows a page already drawn. No other artifact runs unseen. The platform stores the HttpOnly cookie; only the canonical URL is reused when opening a tab. A tab then loads that URL with shared cookies. If preparation is unavailable, opening requests fresh access; an expired or revoked cookie gets one fresh-access attempt before showing recovery. This includes the serving Worker’s redirect to the trusted site-opening route, not only HTTP 401/403; native cancels that handoff and clears the old access before requesting a new single-use URL. No single-use URL is saved for later replay. Native request IDs match replies, organization/account scope fences descriptors and pending requests, and reloading Home holds pending opens and re-sends them once Home can answer; a failed Home load or sign-out fails them so they can be retried. Resource-head and Canvas publication changes update descriptors. Removing a pin drops its prepared descriptor and unmounts any in-flight preparation. A resource version change reloads the visible hosted document, while tab switching preserves an already loaded view.

Files, pins opened before their descriptor is ready, and multi-artifact canvases on a browser host that does not declare the `artifact-picker` capability use the browser renderer. Where the host declares it, a multi-artifact pin opens its preferred site natively with a native picker, and hands a file to the browser renderer. A prepared descriptor arriving during bootstrap can replace the spinner with the direct hosted path. Once the browser has shown an artifact or conversation, the route keeps that renderer when a new artifact publishes, preserving in-progress work. This also keeps older browser deployments compatible with the new native client. Native tabs retain their existing lazy behavior: eager React mounting alone does not create an iOS WKWebView before SwiftUI attaches its tab to a window. Initial bridge readiness no longer sends a redundant refresh over bootstrap reads; reconnect and foreground refreshes remain. Focusing a retained browser tab does not itself invalidate Canvas queries. Direct hosted tabs keep Home’s live socket and avoid invalidating every prepared Canvas on each tab tap; reconnect and foregrounding refresh the shared host. Hosted sites use the Canvas descriptor and resource-head version directly, avoiding an extra resource-metadata request; file artifacts still need that metadata for InspectorRail.

Already loaded artifact views stay mounted and attached to preserve local scroll and form state during tab changes. Inactive native views use zero opacity, disabled pointer events, and hidden accessibility descendants; `display: none` can detach WKWebView and replay its consumed access URL. The native containers disable view flattening so changing visibility or accessibility does not replace their children. Fragment navigation does not reset the shell, and full application-page loading retains artifact instances until the authenticated user or organization changes. File artifacts use the shared InspectorRail. Reactive sites use the existing `openArtifact` API to obtain an `openUrl` on their hosted artifact origin. Access queries belong to one mounted artifact/version instance and are discarded on unmount, so switching A → B → A obtains fresh access. That one-time URL establishes artifact access and redirects to the canonical hosted URL; the canonical URL alone requires an existing artifact cookie, which the native pin preparation establishes ahead of a tap. The browser preview frames the same hosted document directly. Native sites open in separate WebViews so their cookies are first-party on iOS, avoiding Safari's cross-site iframe restriction on interactive writes. Those views receive no application commands or authentication bridge. A presentation-only `onMessage` handler accepts only the artifact-ready marker from the artifact origin, outside authentication bootstrap paths. The document-ready script applies the inset and signals after two animation frames, without waiting for images; `onLoadEnd` remains the fallback on engines that miss early injection. HTTP/network/process failures retain their existing recovery. This signal describes document presentation, not completion of a generated app’s own data fetches.

On hosts advertising `inlineChat`, the Chat button selects the existing Home browser and sends `open-chat`. The browser saves its prior route and displays the shared transcript/composer in place. Native tabs hide during this full-screen editor; Close and Android Back restore the previous tab and Home route through `close-chat`. The most recent chat stays mounted when hidden, so its draft, scroll and conversation socket survive reopening. Opening another chat replaces that retained editor, and account/organization changes destroy the scoped browser tree. Hidden chat uses the shared visibility context so it does not acknowledge unseen messages. Closing Chat sends no refresh fan-out; publication pushes keep artifacts current. Older hosts keep the native sheet fallback. This avoids reparenting WKWebView between native screens or retaining popped native-stack routes, neither of which is a supported reuse mechanism. Native camera, photo-library, and microphone usage descriptions support its attachment and dictation controls; permission prompts occur when used. Creation uses the shared attachment lease and draft mechanisms. Creation first reserves the Canvas through `POST /canvases`, then sends its opening message and attachments through the existing HTTP conversation admission route. A create attempt retains its message receipt key, operation ID, and Canvas ID while the submitted content is unchanged, so either step can be retried safely. The form stays mounted through navigation while a request is pending; completion refreshes the directory without redirecting someone who already left the form. Edited retries keep the reserved Canvas ID and mint new message/operation receipts. The composer blocks submission while creation is pending and uses the same authorized member roster for mention confirmation and payload resolution.

Navigation uses Callstack's maintained [`react-native-bottom-tabs`](https://oss.callstack.com/react-native-bottom-tabs/docs/guides/usage-with-react-navigation)
and its React Navigation adapter. A shared native stack owns the header and
presents diagnostics and the older-host conversation fallback. The documented
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

Each tab lazily mounts a browser WebView on its first visit and retains it through tab switching. These pages reuse the existing browser session, Canvas REST APIs and workspace socket protocol. This means one existing workspace connection per visited browser page, rather than a native data client or socket protocol; the native shell's own requests are only those the invariants below name. The focused browser page supplies directory snapshots and handles pin writes; when a direct hosted tab is focused, Home supplies them instead. A single native owner prevents delayed background snapshots from overwriting pin acknowledgments. This means Android does not wait for an inactive WebView to resume rendering. Background snapshots cannot overwrite the visible page’s acknowledged state, and an initial loading snapshot cannot clear existing tabs before its first directory sync. Canvas screens receive their own artifact descriptors and keep their authorized hosted WebViews in stable native containers. Dashboard links and the pin manager select an existing native tab when possible. Unpinned canvases open within Home. Chat reuses Home’s browser document and existing web composer; older hosts fall back to a system sheet at the canonical chat URL.

iPhone scenes extend behind the native bottom tab bar. The supported
`useBottomTabBarHeight()` measurement supplies bottom margin on the keyboard
container; its margin includes the home indicator, so the outer bottom safe area
is disabled in that case. `useVerticalBarEdgeIOS()` removes that margin when Duo
uses a vertical rail. WKWebView's documented `removeIosKeyboardObserver` option
lets the surrounding KeyboardAvoidingView own keyboard avoidance, preventing a
second keyboard inset from lifting the composer into the transcript. The same
WebView behavior applies to the shared conversation view, legacy conversation sheets and hosted artifacts.

The OS places the native tab bar and rail, including Duo’s outer screen, inner orientation changes and either side of Split View. No hinge angle or fixed width threshold chooses native navigation. Native safe-area handling reserves the system rail/bar; content extends behind the transparent header with a measured initial inset that scrolls away. The inset updates when geometry changes without accumulating padding. Header actions are native bar items on iOS, so the system can relocate or overflow them. Android uses its native navigation header with accessible actions. Home has sidebar and create-canvas (+) actions; artifact screens have sidebar/chat actions. Headers have no title or extra Home action. The Muse-inspired sidebar remains shared and custom, including pin/unpin, drag ordering and accessibility move actions. Ordinary swipes scroll; closing the drawer or a changed account, organization or pin list cancels a drag. The drawer slides in over a fading scrim and slides back out; Reduce Motion fades it instead. On iOS, pulling in from the leading edge drags the drawer out under the finger wherever its header button opens it, and taps or scrolls that start at the edge still reach the content. The pan wraps the whole tab shell rather than each screen, because pinned sites draw in the PinStage above every screen. Android leaves that edge to system Back.

Android native tab images use cached PNG file URLs because its native image loader does not render PNG data URIs. Native tab images use the same Lucide catalog and Electron bare-mark colors (themed ink for pastel colors, the hue itself for legacy colors), rasterized from SVG for platform tab items with original-color rendering. On iOS the tab image is rasterized at 27pt (22pt glyph), the size react-native-bottom-tabs redraws tab images to, and its source carries the screen `scale`, so neither the image loader nor the tab bar resamples it. Tab glyphs are bare, matching Home; canvas tint tiles remain in the sidebar. Selection uses the platform indicator, and the browser preview follows the same bare-icon treatment. The SVG wrapper positions each complete glyph; Lucide receives `size` rather than `x`/`y` or explicit dimensions, which it would also forward to its child shapes and distort their geometry. Missing icons use PanelsTopLeft. The native theme reads Electron’s base and appearance tokens. iOS supplies Liquid Glass and its accessibility fallbacks; Android supplies native tab behavior and system Back. Predictive Back is disabled through Expo's
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
- **Native shell:** CI exports iOS, Android and web bundles. The `simulator` profile
  is a development client; `preview` is an installable internal release (IPA/APK),
  and `production` is a store build. Both release profiles use the **one
  `production` update channel** and production EAS environment. The project is
  `@juno-ai-labs/rally-mobile`. EAS has the App Store signing profile and submission
  API key for `ai.rallywith.mobile` on Apple team `7ZLT6A8W25`. The App Store Connect
  app record, external TestFlight review and physical push delivery still require
  acceptance; a successful export proves none of them.

The physical iOS app uses `ai.rallywith.mobile`; Apple rejected the initial
`ai.rally.mobile` development identifier for the Juno AI Labs team. The
`rally-mobile` sign-in scheme remains unchanged.

For an installable iPhone build, register the phone under the Juno AI Labs Apple
team with `eas device:create`, then configure iOS signing through `eas credentials`
for the `preview` profile. Run `eas build --platform ios --profile preview` after
the compatible browser deployment succeeds. Ad hoc provisioning includes only
registered devices present when the profile was generated. For automated refresh,
first run `eas credentials:configure-build --platform ios --profile preview` when
entitlements change; it synchronizes Apple capabilities. Merely refreshing the
old profile does not enable Push Notifications. Current EAS CLI supports
`--non-interactive --refresh-ad-hoc-provisioning-profile`
with an App Store Connect API key in Expo or the documented `EXPO_ASC_*` secret
environment variables. A new device can require a refreshed profile and re-sign;
a simulator archive cannot be installed on a phone. Store distribution remains
separate from this internal build profile.

### One production channel

`expo-updates` checks on launch without blocking startup. Expo's fingerprint
runtime policy isolates updates by native compatibility. JavaScript and asset
changes can use OTA; native dependencies, entitlements and plugins require a new
binary. A previously installed binary without `expo-updates` needs one replacement
build before it can receive updates. The runtime policy, channel and update URL
are in app config and `eas.json`; do not add preview or staging update channels.

`.github/workflows/release-mobile.yml` runs lint, types and mobile/browser tests
on relevant main changes, then invokes `.eas/workflows/release.yml`. Expo's
supported fingerprint/get-build jobs find a compatible non-simulator build from the
`production` profile and channel for iOS: publish OTA when one exists, otherwise build the
new production binary. Android automated releases and Firebase setup are deferred. Internal preview builds cannot satisfy the store-build lookup.
Native builds do not automatically submit to stores. The explicit
`.eas/workflows/submit.yml` uses Expo's supported `testflight` job with a verified
iOS store build ID and release-specific What to Test notes. It uploads the build,
assigns it to the `Public Beta` external group and requests Beta App Review.
This does not release the app on the App Store. Android submission is deferred.

### Public TestFlight setup

The [App Store Connect record](https://appstoreconnect.apple.com/apps/6834593399/testflight/ios)
is **Rally AI - Live Artifacts**, Apple ID `6834593399`, bundle
`ai.rallywith.mobile`, English (US), SKU `rally-mobile-ios`.
`submit.production.ios.ascAppId` in `apps/mobile/eas.json` links EAS to that
record; the bundle, team and Expo project IDs are not substitutes. EAS holds the
signing credentials and submission API key. Accept any pending Apple agreements
and keep private keys out of the repository.

Complete TestFlight's beta description, feedback email, review contact and a
dedicated review login with sample canvases. The `Internal` and external
`Public Beta` groups are configured. Enable the public link with Open to Anyone
once a build is approved for external testing. Testers still need a Rally account
and organization access.

From `apps/mobile`, submit a verified production store build (not a preview IPA
or simulator archive) using [Expo's TestFlight job](https://docs.expo.dev/eas/workflows/pre-packaged-jobs/#testflight):

```sh
npx --yes eas-cli@latest workflow:run submit.yml \
  --input build_id=<EAS_STORE_BUILD_ID> \
  --input 'changelog=<What to Test for this build>' --non-interactive --wait
```

The job waits for processing and requests Beta App Review. Confirm Apple's
approval and an available build in `Public Beta` before sharing the public link;
upload success alone is not approval. Keep using the single `production` OTA
channel for compatible JavaScript updates.

`store.config.json` is synchronized from `apps/mobile` with
`EXPO_APPLE_TEAM_ID=7ZLT6A8W25 npx --yes eas-cli@latest metadata:push --profile production --non-interactive`.
The explicit team environment variable also handles stored API keys whose EAS
record lacks a team association. Keep `apple.version` in the store config aligned
with app config for each release.
[Release copy and screenshots](../apps/mobile/metadata/README.md) are manual paste
and upload sources, not inputs to EAS Metadata. Complete Apple's age-rating and
privacy questionnaires separately; metadata lint cannot validate those answers.

The GitHub `mobile-production` environment needs an `EXPO_TOKEN` secret. Set
`EXPO_PUBLIC_RALLY_APP_URL=https://app.rallywith.ai` in the EAS production
**environment**, so fingerprint, build and update jobs resolve the same config.
The pnpm package extension supplies `@expo/config-plugins` to
`react-native-bottom-tabs@1.5.0`: its published Expo plugin imports the package
without declaring it, which otherwise fails under EAS's direct config loading.
Remove this extension when upstream declares the dependency.

Deploy compatible API/browser changes before distributing a dependent native
build. The optional push commands remain compatible with older shells, but an
older browser cannot acknowledge new native registration. Existing installed
clients must keep working across browser deployments. The release integration adds no API
routes or socket protocols. Push registration reuses
`PUT /push-devices/:installationId` and `DELETE /push-devices/:installationId`;
crash reporting reuses `GET /telemetry/preference` and `POST /telemetry/crashes`.

For an urgent JavaScript regression, use EAS Update's republish or rollback to
embedded on `production`, targeting the affected runtime. Keep Expo's built-in
error recovery enabled. A runtime change needs another native build; publishing
an update cannot repair missing native modules. Never reload automatically while
a user is writing: the app downloads updates and applies them on a subsequent
cold launch, or after the user chooses Restart in diagnostics.

### Background work, notifications and recovery

`expo-background-task` registers one top-level TaskManager task to download
compatible updates. WorkManager/BGTaskScheduler choose execution using their
default cadence; delivery is opportunistic, and iOS Simulator cannot run this
task. Resume and reconnection refresh the existing browser/socket data. There is
no offline canvas content, queued editing system, or background content polling. The last canvas directory (titles, icons, pins) is saved on the device for one account and removed on sign-out; launch opens Home directly at that organization, and falls back to the plain start once if the page asks for sign-in before its first snapshot. Diagnostics records the latest launch-to-dashboard, first pin tap-to-artifact and visible crash-recovery times. Home reports its web build (its entry script) in `ready`; on resume native reads the deployed `index.html`, and a newer build reloads Home when its page is hidden: off screen or under the native dashboard, never under an open inline chat, create flow or canvas.

Home's dashboard is native (`Dashboard.tsx`). Its cards wear each Canvas's appearance as the browser host's do through `canvasMark`: the chosen glyph (else the unchosen one) in the pastel ink on the pastel tint, and the lead card's 145-degree gradient toward 20% of the hue, mixed in Oklab by `color-mix.ts` to match the stylesheet's `color-mix`. It draws from the live directory, or from the saved copy until Home's page answers, so launch shows the canvases on the first frame. Home's page stays mounted behind it for the socket, inline chat, creation and the canvases it opens. A tap on a pinned canvas switches tabs; any other tap, and Create, is sent to the page (held until the page is ready) and shows a spinner until the page reports that view. The saved copy is for display and for the tab bar: notification and crash-report registration wait for the live directory. The pins' descriptors and canonical URLs are saved too (`saved-pins.ts`, never a one-time open URL), so the tab bar and each hosted pin open at launch on the artifact's cookie without Home. A pin that needs fresh access asks the browser API directly (`artifact-access.ts`), and asks Home only if that fails.

Hosted tab-bar pins load from launch in `PinStage` (`App.tsx`), one frame after the first draw. iOS creates a WKWebView only once its view is in a window, and a native tab's content is not until that tab is first shown, so the artifact views live in a layer beside the tab navigator, not inside the tabs. Each pinned tab screen is an empty frame that reports its window rectangle and whether it is in front; the pin in front is placed over that frame, so the header, tab bar and sidebar stay outside it, and the others stay attached at zero opacity with touches and accessibility off. Artifact code of those four pins therefore runs while hidden, by the founder's decision; other canvases still load only when opened. A tap on a pin already drawn is recorded as one frame in `pin_tap_to_artifact`.

A pin with several artifacts is native too when one of them is a site: Home prepares its first site, the one the browser host opens, and lists every artifact. The pin shows a native picker under the header (`ArtifactPicker.tsx`); choosing another site opens it on its own access, and choosing a plain file, which needs the browser inspector, hands that tab to the browser renderer at the file. Home sends the list only to a shell that declares the `artifact-picker` capability in `window.__RALLY_MOBILE_CAPABILITIES__`, because an older shell would show the site alone and lose the files; such a shell keeps the browser renderer for these canvases. A canvas with no site still uses the browser renderer.

A screen with a native artifact in front (a pinned site, or a site Home opened) hides the native header and shows the same buttons floating over the artifact (`FloatingHeader.tsx`), at the header's last height so the inset does not move. iOS 26 fades content under a native navigation bar in the app's own appearance, a white band over a dark site; the navigation library's `scrollEdgeEffects` reaches only the first scroll view in its first descendant chain and its `ScrollViewMarker` cannot see inside a WebView, so removing the bar is the one fix that ships over the air. The presentation script also reports the page's background colour (`artifact-presentation.ts`): the first opaque background under the status bar, from the element at the top centre up to `html`, converted to sRGB; while that artifact is in front, the status bar text and the floating buttons take whichever of light or dark reads over it. The dashboard, chat and pages the browser renders keep the native header.

Opening a canvas from the dashboard is canonical-first. The shell remembers, per account, the site each canvas last presented and its canonical URL (`remembered-sites.ts`). A tap on a remembered canvas shows that site at once on its cookie while Home navigates behind it; Home's own view takes over when it reports one. Home's fresh access for the same site does not reload a view already on its cookie, unless it brings a newer version or answers a renewal the view asked for (`canonical-first.ts`). An expired cookie takes the existing renewal path. Nothing is started on touch-down: that would run a canvas's artifact before a tap was certain, and only the four tab-bar pins may run hidden.

Settings and diagnostics is available from the sidebar's settings button.
Notification permission is requested only through Enable notifications. The
native installation ID is in SecureStore; APNs device tokens pass through the
trusted browser bridge to the existing authenticated registry. Registration is
serialized and cancelled with the current account/organization view, including network-recovery retries. Token rotation,
permission changes and resume reconcile it. Sign-out revokes the bound session;
optional notification work never delays sign-out. Notification payloads must
match their canonical link's organization/region. Canvas taps wait for sign-in
and browser acknowledgement before clearing the response. Canonical URLs cross the bridge; the browser adds host parameters only after validation. Same-organization links route in place; Sidekick links open
in the system browser. See [push-notifications.md](push-notifications.md) for
provider credentials and deployment requirements.

The React recovery boundary offers reopen and share-diagnostics actions.
WebView failures retain explicit retry; artifact process termination reloads the
canonical URL on its existing cookie, and requests fresh access only if that
cookie is gone. Diagnostics store fixed failure codes and timestamps locally,
plus report native version/build, runtime/update ID, channel, emergency-launch
state and connection/background availability. Sharing is an explicit system
share-sheet action. It includes no conversation, title, URL, cookie or push token.
Remote iOS crash reporting is separate from that share sheet. A local Expo
module wraps PLCrashReporter, capturing fatal native crashes without a provider
SDK or an external ingestion URL. Hermes fatal errors and React boundary errors
use the same regional spool. The existing Product analytics preference gates
capture and delivery; account/organization changes invalidate the old context.
`GET /telemetry/preference` and `POST /telemetry/crashes` are reused through the
authenticated browser. See [telemetry.md](telemetry.md#ios-crash-reports) for the
immutable route, consent, retention, raw-data and symbolication boundaries.

The iOS release profile retains Fastlane's `ios/build/*.dSYM.zip` as private EAS
build artifacts. Native stacks currently retain binary UUIDs and offsets; Hermes
stacks retain numeric locations and update IDs. They are explicitly marked
unsymbolicated. Automatic mobile symbolication is not implemented; the existing
Electron minidump symbolicator cannot interpret iOS reports.

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

For OTA acceptance, `simulator-release` extends the production profile with an
iOS Simulator target and no version increment. It uses the same one production
channel and fingerprint policy, without a development client. Build it with
`eas build --platform ios --profile simulator-release`; development clients do
not prove automatic launch-update behavior.

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

- Only the configured application origin and a per-WebView capability can update native navigation. `protocol.test.ts` exercises origin, document-path, nonce, and malformed-message rejection. Routing generated artifact messages through that application handler would give generated code account-level navigation capabilities.
- Reactive artifact open and canonical URLs share one origin under the configured artifact domain. The validator's tests reject nested, deceptive, credential-bearing, and cross-origin URLs. Artifact WebViews accept only their presentation-ready marker, which can dismiss a loading cover and has no shell actions, account metadata or credentials. Never route it through the application bridge.
- Home cannot be removed or reordered. Pin ordering preserves every server pin, including desktop overflow; `movePin` tests cover preservation and invalid moves. The fixed Home control is verified visually, with no automated guard.
- A failed resource request cannot imply no artifact. Error recovery precedes fallback routing; `mobile-session.test.ts` checks the routing decision, and browser acceptance exercises the stale-cache and recovery paths.
- Native makes exactly one data request of its own (`artifact-access.ts`): fresh access to a pinned artifact, on the browser transport's endpoint and the same HttpOnly session cookie the WebViews hold, with the app's `Origin`. It reads no token and stores nothing but the canonical URL. Any failure records its reason code in diagnostics and falls back to asking Home. Its only other request, `web-build.ts`'s `GET /` of the public app shell to read the deployed build, reads no account data. Adding another native data request is a decision, not a convenience.
- Credentials remain in browser cookies. The bridge transmits display metadata, commands, short-lived artifact open URLs, APNs registration tokens, account-bound regional crash envelopes and the single-use sign-in redemption proof, never a password, access/refresh token or session cookie. Runtime schemas define this boundary.

## Boundary

This module owns mobile presentation, bridge state, and tab behavior. [browser-client.md](browser-client.md) owns authentication, regional transport, organization selection, and browser deployment. [pinning.md](pinning.md) owns canonical pin persistence and ordering. Existing artifact serving owns access tickets and generated-code isolation. There is no new mobile backend, native transcript implementation, or separate pin database.

The browser imports the framework-independent protocol from `apps/mobile/src/protocol.ts` and client sign-in locations from
`apps/mobile/src/auth-contract.ts`. Backend PKCE schemas are imported from
`@rally/contracts`. Changes to that contract must update both consumers. The Expo package is discovered by the existing workspace and recursive check commands.

## Failure modes and limits

Network and HTTP failures show retry views. Pin failure messages stay in the sidebar; failed writes do not manufacture a successful local order. New pins beyond the four visible mobile slots ask the user to unpin another; existing overflow remains accessible. Directory search filters the socket’s Canvas list. A removed or inaccessible canvas reports its read failure.

Renderer termination reloads the visible WebView at once; hidden WebViews, Home included, wait until it has presented, are shown, or are needed for fresh access. A terminated artifact renderer reopens its canonical URL in a new WebView on the cookie the platform still holds, never replaying the spent open ticket; a missing or expired cookie falls through to the fresh-access renewal. An access or active metadata failure removes the stale native surface and exposes web recovery. The native handler also recognizes a failed `/redeem` bootstrap. Returning from inline chat republishes the active artifact descriptor. Sign-out and account/organization changes discard native artifact views; a full application-page reload can rebuild the tab directory. Foregrounding refreshes the directory and resource metadata. Unsaved in-artifact state survives tab switching, but a full page/app reload, closing that tab or process termination can discard it. Native navigation, Liquid Glass and Dynamic Type require device validation; a browser preview cannot validate WKWebView cookies, Android Back dispatch, keyboard resizing, native gestures, or system accessibility.

Sign-in uses the system browser and returns to `rally-mobile://auth/complete`. Cancelling leaves the app signed out, and retry creates a new attempt and verifier. External HTTP(S) links open in the system browser on both platforms; Android reports every navigation as `other`, so the handler uses the platform and destination origin instead of requiring iOS’s `click` signal. Offline canvas copies are intentionally out of scope. Provider credentials and app-store signing remain release setup.

## Testing

`apps/mobile/src/sidebar-drop.test.ts` covers pin/unpin/reorder drop decisions.
`apps/browser/test/mobile-pins.test.ts` covers membership-before-order writes and
partial failures. `apps/browser/test/dynamic-type.test.ts` covers which hosts
read Dynamic Type and how measured sizes become role sizes. Native gesture and
capture evidence belongs in the PR validation.

`background.test.ts` exercises download deduplication, rollback directives,
retryable task failure, platform availability and the absence of automatic
reload. Its doubles stand in for the OS/Expo native APIs. `notification-target.test.ts`
checks canonical routing and organization/region mismatches. These are not
physical background scheduling, OTA receipt or notification delivery acceptance.
The APNs provider and real queue/registry tests are owned by
[push-notifications.md](push-notifications.md#testing).


```sh
corepack pnpm --filter @rally/mobile test
corepack pnpm --filter @rally/mobile typecheck
corepack pnpm --filter @rally/browser typecheck
corepack pnpm --filter @rally/mobile exec expo install --check
corepack pnpm --filter @rally/mobile build
```

`apps/browser/test/mobile-session.test.ts` checks account-bound organization restoration and the stale-empty artifact race. `apps/desktop/src/renderer/lib/api.test.ts` checks that a retried opening message sends the caller’s original receipt key and attachments. The pure protocol tests execute command injection with adversarial IDs, validate the bridge and artifact origin boundaries, and exercise pin ordering. Expo export compiles iOS, Android, and web bundles; it does not install or launch native apps. Browser host tests still exercise the real Worker transport and CSP. Renderer `browser-entry`, `browser-cookie-writers`, and `browser-collaboration` tests cover transient recovery, schema diagnostics, cookie-writer ordering through a browser capability double, hosted-site remounts, socket publication/head updates, metadata recovery, inline-chat return, mention confirmation, pending submission and edited creation retry.

### Native verification (2026-11-15)

An iPhone simulator (iOS 26.5, 402×874 points) on a fresh development build, signed in to
the production Juno Labs organization, checked the native dashboard and the pin
layer. Four canvases were pinned for the run and unpinned afterwards; the
session was signed out and stopped. Three single-site pins showed a fully drawn
page the instant their tab was first tapped, sized between the header and the
tab bar, and took touches; Home's dashboard took touches with the hidden pins
loaded above it. A multi-artifact pin used the browser renderer as designed. A
cold relaunch showed the dashboard and all pinned tabs before Home's page
answered, and a pin tapped seconds later was already drawn. Diagnostics read
`launch_to_dashboard` 222 ms (from JavaScript start, development build) and
`pin_tap_to_artifact` 4 to 9 ms. The run found and fixed the lead card's
gradient covering only part of the card on iOS, and `launch_to_dashboard`
still timing Home's page instead of the native dashboard. Release-build and
Android timings remain unmeasured.

### Native verification (2026-11-13)

SDK 58 development builds were exercised against the production Juno Labs
organization through a temporary branch browser host. Those earlier navigation
checks used the deployed backend handoff and the then-unmerged mobile browser
presentation. Production pins were restored after each device run, and
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

Manual acceptance: sign in through the system browser with Apple, Google and email; cancel and retry sign-in; test an existing browser account and switching accounts; open Home; open an artifact and an empty canvas; create a canvas; edit through the full-screen conversation view; pin and unpin through sidebar Edit; drag to reorder; reload to check server persistence; check desktop overflow pins; disconnect and retry; sign out; test light/dark and Reduce Transparency. On devices, additionally verify artifact writes, keyboard behavior, Android Back, Close and legacy iOS sheet dismissal, VoiceOver/TalkBack reorder actions, and state retention across tab switching.

### Latency verification

Target: 500 ms to visible content, with a 2-second ceiling. Prepared hosted-pin
first opens measured 1.02–1.91 s on iPhone 17; return switches measured 36–37 ms.
A separate controlled navigation fixture measured first Chat at 830 ms, repeat
Chat at 82 ms, zero detail reads on close/unrelated resource events, and 52% less
initial dashboard JavaScript. The slow-image browser test revealed the artifact
document before its image finished loading. These are development samples, not
production percentiles. Release-binary, Android/Duo timing and unsent hosted-form
retention remain unmeasured. The full method, before/after table and limitations
are in [PR #1601](https://github.com/juno-ai-labs/avalon/pull/1601).

## Changelog

### 2026-11-15 — The mobile host reads at iOS sizes and follows Dynamic Type

**What changed:** `installMobileBridge` sets `data-density="touch"` on
`<html>` before the first render, so the dashboard, Chat, creation form and
portaled dialogs take the touch density's role sizes: 17pt body, the iOS
default. Artifact content sits in a `display: contents` wrapper with
`data-density="default"` and keeps its document sizes. On iOS,
`dynamic-type.ts` measures the `-apple-system-*` font styles on a hidden probe
at launch and on each return to the foreground, and writes the changed roles
inline on `<html>`; the composer re-measures its height when they change.
`mobile.css` names roles instead of px.

**Why:** Phone text was 14pt, under the size iOS uses for body text, and a
fixed size ignores the person's text-size setting. The density belongs to the
design tokens (see `theming.md`); this host only decides which subtrees use it.

**What to respect:** document content goes inside a `data-density="default"`
wrapper; everything else inherits touch from `<html>`. The Dynamic Type path is unverified on a real
WKWebView: Chromium has no `-apple-system-*` keywords, and only the plumbing
was exercised, with `CSS.supports` stubbed.

### 2026-11-15 — Pull the iOS sidebar in from the left edge, and slide it in and out

**What changed:** On iOS, an edge pull drags the sidebar out under the finger
and settles it on release, and the drawer slides rather than fades. This adds
`react-native-gesture-handler`, a native module, so it needs a new native
build; the fingerprint runtime keeps OTA updates off older binaries.

**Why:** iOS convention is an edge pull that tracks the finger, and the
sidebar was reachable only from a button at the top of the screen. A first
version used a plain view over the edge, which took every touch that started
on it, taps included, and could only open the sidebar once a threshold was
crossed. Gesture handler's pan is a native recognizer: it leaves a touch to the
content until it activates, cancels the content's touch when it does, and
feeds `Animated.event` so the drawer follows on the native side. The pan wraps
the whole tab shell because pinned sites draw in the PinStage above every
screen; a recognizer inside a screen would never see touches over them.

**What to respect:** The pull relies on a touch continuing to reach the pan
after the sidebar's `Modal` presents over it, which UIKit does for a touch
already in progress. The `Modal` presents with no animation and stays up until
the slide out ends; a button open starts sliding on `onShow`, once the views
it animates exist. Android has no pull: gesture navigation owns that edge for
Back.

### 2026-11-15 — Recover renderers in place, visible screen first, and cut launch and update churn

**What changed:** When iOS or Android kills an artifact's web content process,
`ArtifactView` now remounts its WebView on the canonical URL instead of asking
Home for fresh access. Fresh-access requests (`prepared-requests.ts`) now wait
while Home reloads and are re-sent once Home can answer, rather than failing. `recovery-order.ts` makes the screen in front recover
first: hidden WebViews, Home included, reload only after it has presented, or
sooner when shown or when a queued access request needs Home. Home snapshots
that change nothing the shell shows are dropped, and the shared session value is
memoized. The directory is saved on the device and Home opens at its
organization. Native refreshes Home on every resume, and Diagnostics records
three timings. A web build newer than Home's reloads Home
once its page is hidden. Home's dashboard is drawn natively from the directory,
the saved copy until the page answers.

**Why:** A field report showed a pinned tab stuck on "Rally couldn't load" after
`artifact_process_terminated`, and Try again took far longer than the 500 ms
target. iOS usually kills Home's content process in the same pass, so the retry
waited on a full Home reload, socket sync and access round trip; worse, Home's
reload resolved the pending request with null and nothing retried once Home was
back. The redeemed artifact cookie is persistent and lives in the platform cookie
store, not the dead process, so the canonical URL alone is enough. Reloading
every killed WebView at once made Home's full application boot compete with the
one document the person was waiting for. Home posts a snapshot on every canvas
change, including `updatedAt` ticks while agents write, and each one rebuilt the
session value and re-rendered every tab and header. Opening Home at `/` cost a
session read and an organization-list read in series before the dashboard. The
founder accepted saving titles and pins on the device for speed, reversing the
earlier no-cache position. Without timings, "laggy" had no number to test. The
web host ships 20 to 30 times a day while Home stays open for days; reloading
Home while hidden picks up fixes without a spinner. Reloading a visible Home was
rejected: its tab would show the loading cover, so the native dashboard now
covers that reload instead. The web dashboard waited for the page's boot,
session and socket before drawing anything; the native one draws from the
saved directory on the first frame. Making the saved copy the live directory
was rejected: notification and crash-report registration act on the account
the moment it appears, and their commands would reach a page not yet loaded.

**Considered and rejected:** `reload()` on the same WebView: if the crash came
before redemption finished, the last URL is the spent open ticket. Waiting on a
timer for Home before retrying: it guesses a number and still pays for Home.
A fixed delay before hidden reloads: a guessed number, where the visible
screen's own presentation is the signal that matters. Recovery order yields one
JavaScript turn so a visible renderer reported after a hidden one in the same
pass still goes first.

**Consequences:** Recovery costs one artifact document load when the cookie is
valid. A lost cookie still takes the renewal path through Home, which now waits
for Home rather than failing. An artifact that crashes its renderer on every
load reloads each time, as the earlier retry did; no cap was added. In-artifact
unsaved state is still lost on termination. While Home waits, its socket is
down, so pins and notifications catch up once it reloads. Anything that needs
Home sooner must `wake` it, as fresh access does. A new snapshot field the shell
shows must be added to `directoryKey`, or its changes are dropped. Pinned tabs
open at launch from saved descriptors and canonical URLs on a viewer cookie that
now lasts a year from the last open (reactive-web-artifacts.md), and fresh
access is asked of the browser API directly. That direct request reverses the
earlier "no separate REST client" position for one call only, by the founder's
decision: renewal waiting on Home's boot was the slowest path left. Not yet
measured on a device.

### 2026-11-14 — Reduce mobile launch and pinned-canvas startup work

**What changed:** Home now shares its session with prepared hosted pins and a
retained full-screen Chat. Organization restoration stays in the document;
heavy renderers load on demand, detail updates follow Canvas publications, and
artifact presentation no longer waits for images.

**Why:** First taps were paying for another browser shell, session, socket, Canvas
discovery, access, and artifact load. The goal is 500 ms tap-to-visible with a
2-second ceiling; measured samples meet the ceiling after cookie preparation,
but first opens remain dependent on hosted page/network performance. Cold access and the browser-renderer fallback remain
network work, not an offline cache. Launch also reloaded the entire browser after
restoring the organization list, exposing multiple intermediate screens. Removing
that navigation preserves authentication work and one continuous loading state. Reopening Chat was repeating that session bootstrap in a new WebView; mounting, closing and broad resource events also refetched already-current Canvas details. Waiting for all artifact images unnecessarily covered usable content.

**Considered and rejected:** The navigator's supported eager mounting option was
tested on iPhone and did not preload WKWebView: iOS creates it only after the tab
attaches to a window. Caching access URLs would leave expired or consumed tickets. Instead, preparation
redeems immediately and lets the platform retain the ordinary HttpOnly cookie.
A separate REST client, socket, or native content database would duplicate the
browser session. The existing Home session can provide the descriptors and fresh
access instead. Retaining the full-screen editor in Home uses supported browser routing and native tab visibility. Moving a WKWebView between a sheet and its old parent risks replacing it; keeping a popped stack screen alive requires unsupported navigation behavior.

**Consequences:** Descriptor preparation is limited to the existing four visible
pins. A mounted browser conversation must not be replaced when an artifact
publishes. Transient detail failures preserve the last prepared descriptor; a
real change to multiple artifacts uses the browser picker. Files and multiple artifacts keep the browser renderer, while native
sites retain state between tab switches. There are no new backend endpoints or
sockets. The bridge adds prepared-descriptor and request/reply messages with
account/organization fencing. `open-chat`/`close-chat` use the existing authenticated bridge; artifact code receives only a presentation signal handler, with no application capability. First Chat/file opens still download their deferred UI. Their local error boundaries offer explicit Reload recovery if a deployment removes a deferred chunk; they do not automatically reload over unsent input. Onboarding and site-opening recovery announce readiness so the native cover cannot hide their retry controls. The native and browser changes must both ship for in-place Chat; older hosts retain the sheet.

### 2026-11-14 — Direct sidebar pinning and a Home create action

**What changed:** Holding and dragging moves canvases between Pinned and Canvases,
with Edit retained for discoverability and accessible actions. Home has a plus
button, and tab icons use bare canvas-colored outlines.

**Why:** Pinning and rearranging canvases required entering Edit, while creating
one lacked a direct Home header action. Filled tab tiles differed from Home.

**Considered and rejected:** A gesture dependency and a new pin-position API
would add machinery for behavior supported by React Native and the existing
membership/reorder APIs.

**Consequences:** New-pin placement is two sequential writes, so a failed reorder
leaves the pin appended and reports that partial result. Home remains fixed and
the existing presentation capacity applies. Drag coordinates and measured bounds
must use the same root coordinate system; reopening resets the scroll offset.

Shipped in #1598.

### 2026-11-13 — Make external TestFlight distribution explicit

**What changed:** The manual submission workflow uploads a selected iOS store
build, adds it to Public Beta and requests Beta App Review with supplied test
notes. EAS store signing and the existing Apple submission key are configured.
Store copy, screenshots and manual beta review instructions are versioned alongside
the app.

**Why:** An installable ad-hoc IPA requires registered devices; public beta
testers need Apple's external TestFlight distribution and review.

**Considered and rejected:** Automatically distributing every main-branch native
build would remove the existing explicit choice of which verified build testers
receive. A second OTA channel would complicate the one-channel release model.

**Consequences:** Keep store builds separate from preview/simulator artifacts,
complete Apple's app record and review information before the first submission,
and distinguish upload success from external beta approval.

Implemented in [#1596](https://github.com/juno-ai-labs/avalon/pull/1596).

### 2026-11-13 — Add one-channel releases and thin-client runtime recovery

**What changed:** Fingerprint-compatible EAS Update releases, platform background
update downloads, native notification registration, account-fenced browser writes,
regional iOS crash capture, measured composer insets,
and local recovery/diagnostics now share the existing client and push services.

**Why:** Installed builds needed JavaScript fixes without reinstallation and an
explicit recovery path when the native shell or WebView fails.

**Considered and rejected:** Separate update channels, an offline canvas database
and a second mobile API would create state and release branches this consumer
does not need. Direct Sentry ingestion would change the regional storage policy.

**Consequences:** Keep one production channel, fingerprint-compatible binaries,
user-controlled restarts, and native SDK recovery enabled. Native changes still
need replacement builds. Store submission, OTA receipt, background scheduling
and real push delivery require separate acceptance; bundle export proves none
of them. Crash approval replies must match the latest verification, and stored
approval deadlines cannot renew during an offline launch.

Shipped in #1591.


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
