# iOS client

Rally's native iOS app is a SwiftUI conversation client. It signs in with the
same Google + PKCE identity flow the desktop uses, holds sessions in the
Keychain, and talks to the regional Workers over HTTPS and a ticketed
WebSocket. It is a fourth deployment surface, not a wrapper around the Electron
renderer: there is no Expo, React Native, or Flutter in this tree.

Read this before changing the Xcode project, the iOS auth or socket path, the
Grok-inspired transcript chrome, or the TestFlight archive.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/ios/Rally.xcodeproj` | File-system-synchronized Xcode 26 project. Targets Rally, RallyTests, RallyUITests. |
| `apps/ios/Config/Shared.xcconfig` | Bundle ID `ai.rallywith.ios`, team `7ZLT6A8W25`, marketing version, deployment target iOS 26, usage strings. |
| `apps/ios/Rally/RallyApp.swift` | `@main`. Appearance, deep links, push reconcile on foreground. |
| `apps/ios/Rally/App/AppModel.swift` | Session lifecycle, workspace pick, directory, send, socket consume, pin/archive/search, substream switch and create, account appearance, Apple push registration. |
| `apps/ios/Rally/App/RallyAppDelegate.swift` | APNs token and notification-tap callbacks. Forwards; does not register. |
| `apps/ios/Rally/App/RallyPush.swift` | iOS topic, sandbox/production environment, `rally` payload parse. |
| `apps/ios/Rally/App/MainShell.swift` | Tab shell: Work streams, Sidekicks. System `Tab` + minimize-on-scroll so the bar is Liquid Glass. |
| `apps/ios/Rally/Auth/PKCE.swift` | S256 attempt/verifier/challenge, same lengths as the desktop store. |
| `apps/ios/Rally/Auth/KeychainStore.swift` | Identity and workspace sessions. Refresh tokens never go in UserDefaults. |
| `apps/ios/Rally/Network/RallyClient.swift` | Regional HTTPS. `ConversationBoot` also understands a nested socket snapshot. Prepare/confirm/cancel/rename/archive for substreams. |
| `apps/ios/Rally/Network/RallyTicketedSocket.swift` | The one iOS ticketed WebSocket: subprotocol ticket, subscribe on open, `isBusy` during handshake. Workspace, control, and feed sockets are codecs on top of it. |
| `apps/ios/Rally/Network/ConversationSocket.swift` | Feed frames on `RallyTicketedSocket`: subscribe, send, stop, retry, elicitation, older ranges, `mark_opened`. |
| `apps/ios/Rally/Network/WorkspaceSocket.swift` | Directory subscribe, `list_workstreams` later pages, recency upserts. Sidebar projects and notes are ignored. |
| `apps/ios/Rally/Network/WorkstreamControlSocket.swift` | Parent `workstream_metadata` frames. The child directory lives here, not on the workspace sidebar. |
| `apps/ios/Rally/Network/RallySocketPolicy.swift` | Navigation-shaped retain set plus presence-free feeds for directory rows that stayed on screen for one second. |
| `apps/ios/Rally/Network/RallySocketPool.swift` | Opens and closes sockets to match the retain set. Reuses a live ticketed connection. Caches snapshots for the workspace session. |
| `apps/ios/Rally/Network/RallyPagedDirectory.swift` | Subscribe overlay, cursor append, recency upsert. Page sizes transcribed from the contracts. |
| `apps/ios/Rally/Design/RallyInfiniteScroll.swift` | Terminal-row `onAppear` trigger for the next cursor page or older transcript range. |
| `apps/ios/Rally/Features/Chat` | Work-stream list → substream list → feed. `FeedProjection`, composer in `safeAreaBar`, substream launch. Same row kinds as desktop `messageType`. |
| `apps/ios/Rally/Features/History` | Work-stream list: pin, unread, archive, rename, Electron recency/pin order. |
| `apps/ios/Rally/Features/Sidekicks` | Sidekick library; opening one is the same conversation surface with the automation id as parent. |
| `apps/ios/Rally/Features/Settings` | Account, digest, members, appearance, Apple push (when the flag is on), leave/sign-out. Desktop-only settings are named, not faked. |
| `apps/ios/Rally/Assets.xcassets/AppIcon.appiconset/AppIcon.png` | 1024 RGB App Store icon, flattened from the Electron **Dark** selectable icon (`apps/desktop/resources/app-icons/dark.png`). |
| `apps/ios/Rally/Assets.xcassets/RallyMark.imageset` | Shared loop PNG from `assets/brand/rally-mark.png`. Template-rendered in brand ink. |
| `apps/ios/Rally/Design` | True-black/light palette, Liquid Glass helpers, Dynamic Type, the shared Rally loop mark, work-stream/Sidekick glyphs from the appearance catalog, the circular account avatar. |
| `apps/ios/fastlane` and `apps/ios/scripts/archive-testflight.sh` | App Store export. Must run on a Mac. |

There is no `apps/ios/package.json`. `pnpm-workspace.yaml` globs `apps/*`; a
Node package here would be picked up as a workspace package and is forbidden.

`FeedProjection` hides the leading personal-instruction XML envelope from human
and external message display, matching desktop. Literal XML in the message body
stays visible; the server retains the envelope as ordinary history. See
[`personal-system-prompt.md`](personal-system-prompt.md).

## How it works

### Sign-in

`POST /auth/google/start` with `returnUri = rallywithai://auth/complete`, a
43-character `desktopAttemptId`, and an S256 `desktopCodeChallenge`.
`ASWebAuthenticationSession` presents Google. The return URL carries `ticket`;
`POST /auth/desktop/exchange` on the Global API swaps it for an identity
session. JWT audience stays `avalon-desktop` — iOS reuses the desktop client
rather than minting a second audience.

A Debug build also offers **Use local development account**, the same
`POST /auth/dev/session` plus `POST /auth/dev/identity` split the desktop uses.
It is compiled out of Release (`RALLY_DEBUG`). Real Google callbacks cannot be
verified against wrangler, so local validation has to take this door.
`NSAllowsLocalNetworking` in `Info.plist` is what lets the simulator speak
HTTP to `127.0.0.1` without turning ATS off. The shared scheme still points at
production; override `RALLY_API_GLOBAL_URL` or Settings → Developer
(`rally.api.global`) for a local Worker.

`GET /onboarding` then lists workspaces and invitations. One workspace activates
immediately; otherwise the picker runs. Activation and create hit
`/onboarding/workspace/activate` and `/onboarding/workspace` and store a
*workspace* session whose `apiBaseUrl` is the regional Worker.

### Conversation

Ready state is the tab shell. **Work streams** opens on the work-stream list (Grok
Bot's directory: the circular account avatar opens Settings). The chip paints
stored initials and personal color from `GET /onboarding/account` on Global
identity; a missing presentation falls back to two letters of the name and
`blue`. The list uses recency groups (**Last hour**, **Today**,
**Yesterday**, **This week**, **This month**, **Before this month**) by this
viewer's last access. It has no pin actions or pinned section because the
current iOS history has no selected Space; placement-scoped pins cannot be
projected without one. Selecting a work stream pushes the
substream list on that tap, without a navigation animation: Main and **New substream** paint at once; children
fill when the parent control socket has the directory. Selecting a substream
pushes the feed on that tap, before the ticket and without waiting for a zoom:
a cached snapshot paints if
the pool has one, otherwise bubble skeletons on the first frame until the feed snapshot arrives.
The composer stays up. Sending on an open stream is `create_message` on the
conversation feed.

The feed snapshot is the transcript. There is no REST conversation boot —
Main and child both wait on the addressed SubstreamAgent subscribe, per
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md). Snapshot frames
nest `workstream` + `transcript` and decode through `ConversationBoot`.
`FeedProjection` maps turns onto the same row kinds the Electron renderer
shows (`docs/conversation-surfaces.md`).

iOS does not copy the desktop pin/recent/running swarm. `RallySocketPolicy`
keeps one workspace socket for the session, one control socket for the parent
still on the navigation stack, the visible feed, Main (`"0"`) of that
parent while the substream list or a child is showing, and presence-free
feeds for directory rows that stayed on screen for one second (the same delay
desktop uses for hover). Child rows on the substream list warm as soon as they
appear: that list is already a committed parent, and a tap should not wait out
the hover delay. A Sidekick is on-demand until its row warms: then
one feed, no control, no extra Main. Retained Main is presence-free;
navigating onto it sends `mark_opened`. Send, stop, and retry reuse the live
feed socket — they do not mint a new ticket. Snapshots stay for the workspace
session so switching back paints before the next handshake. Foregrounding
remints only sockets in the retain set that have dropped. Tickets remain
single-use; reconnect always asks for a new one. Older history is
`load_transcript_range` with the opening snapshot fence (`snapshotId`,
half-open sequence range, event waterline) once the feed has settled on the
newest row and the reader pulls to the oldest visible content. A LazyVStack
sentinel at index 0 is not that signal — it appears while the view is still
pinned to the bottom. There is no Load-earlier button.

The desktop's Breakout list is parent-scoped (it lives in the Channel's title
menu), so on iPhone it is not a fifth tab.
After a work stream is selected, its substream list is the next push: Main, each
private child, and **New substream**. Row menus rename, copy the canonical link,
archive, and (on Main) make the work stream public. A settled main-feed message
also offers **New substream** with that turn as the cutoff. Either entry opens
the launch surface: faded provenance when branching from a message, an empty
body when branching from the list, and a composer whose first submit is
`POST …/substreams/prepare` then `POST …/substreams/confirm`. Nothing is
reserved until that submit. The parent control socket
(`GET /workstreams/:id/control-socket`) is the child directory. Sidekick chats
skip the substream list: they are automations, and their conversation is
substream `0` only.

### Directory

The workspace ticket (`GET /workspace/socket`) opens `RallyTicketedSocket`.
Subscribe carries the first sidebar page; later work-stream pages are
`list_workstreams` on that socket. There is no REST directory or Sidekick
list — those rows arrive on subscribe. A subscribe page with a cursor overlays
page one and keeps later pages a reader already scrolled to; a payload with no
cursor replaces the list. Recency events upsert one row. The last visible
work-stream row requests the next page. Sidekicks have no cursor — the
subscribe slice is bounded at 250 — and update from the same sidebar.
Members, digest, and suggested-work chips still refetch over HTTP when
`workspace_sync` invalidates — the Worker does not yet push those payloads
([`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md)). Search follows
`POST /search` `nextCursor`.
Projects and notes still arrive on that sidebar; this client does not keep
them. A work-stream row draws the filled circle from
[`workstream-appearance.md`](workstream-appearance.md) — stored icon and colour
when the directory carries them, otherwise the same id-derived mark desktop
uses. A Sidekick row draws that same mark in the rounded hexagon, with a play
on `active`. Opening a Sidekick uses the same conversation parent contract as
desktop: `/conversations/:automationId`.

### Appearance and HIG

Dark canvas is OLED `#000000`. Light inverts the same steps. System / Light /
Dark is a Keychain preference. Type uses Dynamic Type styles, not locked point
sizes. Liquid Glass is the **navigation layer** only: system tab bars, navigation
bars, and toolbars get it automatically; the composer and a few floating controls
use `glassEffect` / `.glassProminent`. Content (lists, transcript bubbles) stays
opaque. Glass is never stacked on an opaque fill of the same control. The tab bar
minimizes on scroll. Reduce Motion drops press scales and the
streaming cursor blink. VoiceOver labels cover send/stop and message roles.
The Sidekicks tab uses the hexagon, not sparkles — sparkles is a catalog
icon, not a Sidekick's, and not Rally's loop. The Work streams toolbar avatar is always
a circle on the stored personal color; it does not copy desktop's diamond,
flower, or arch.

### TestFlight

Version `1.0.0` build `1`, Automatic signing, production APNs entitlements on
Release, associated domains `applinks:rallywith.ai` and
`applinks:www.rallywith.ai`, privacy manifest, `ITSAppUsesNonExemptEncryption =
false`, 1024px App Icon taken from the Electron Dark Dock icon, flattened to
RGB because App Store icons cannot carry alpha. Archive on a Mac with Xcode 26;
the sandbox image has no iOS SDK.

### Apple push

Once a workspace session is ready, iOS reads `GET /feature-flags` on Global
identity. When `pushNotificationsEnabled` is on and the person has not turned
the Notifications switch off, it asks for permission, registers for APNs, and
`PUT`s `/push-devices/:installationId` on the workspace Worker with
`platform: "ios"`, topic `ai.rallywith.ios`, and `apnsEnvironment` from the
build (Debug sandbox, Release/TestFlight production). The installation UUID
lives in the Keychain and survives sign-out. Sign-out and leave `DELETE` that
row while the session is still live. A tap parses the same `rally` object
desktop does and opens `rally.url` as a universal link. The Worker already
renders that payload; iOS does not invent a second one.
[`push-notifications.md`](push-notifications.md) owns delivery.

### Electron inventory and coverage

Electron's main window is a HashRouter. Extra windows are `?surface=settings`,
`sidekicks`, `meeting`, and `deep-link-error`. The table is every path a person
can take on desktop, and where it lives on iOS. Desktop-only rows are Mac
application chrome, Daytona/Terminal policy, connector OAuth sheets, or
pipelines that have no iOS capture device story yet — they are named rather
than stubbed as working.

| Electron path / flow | iOS |
| --- | --- |
| Boot / sign-in / Google PKCE | `SignInView` |
| Desktop “Use local development account” | Debug-only button on `SignInView`; Release stays Google-only |
| Region + create workspace / invitations / activate | `WorkspacePickerView` |
| Guided connectors / profile / people journey | Skipped after workspace pick. Profile is Settings → Account; people are Settings → Members; connectors stay on the Mac |
| `#/` landing | Work-stream list on the Work streams tab |
| `#/workstreams/:id` | Work stream → substream list → feed |
| Open, rename, pin, unread, archive, public/private | Work-stream list swipe + context menu + inspector |
| Participants / resources inspector | Details inspector (people; add participant) |
| Suggested prompts | Empty-state chips from `/work-opportunities` |
| Stop / retry / copy / speak | Composer stop, failed-turn Retry, message actions |
| Save image / PDF / Mermaid export | Not on iPhone. Copy and Share are |
| Start breakout / Channel menu Breakouts (children, launch, rename, archive, copy link) | Substream list after picking a work stream, plus message action on the feed. Same prepare/confirm contract as desktop. Not a tab. |
| Composer: send, stop, attach, dictation | Composer + PhotosPicker + file importer + `VoiceBar` |
| Mentions, slash commands, debug model override, pending-input reorder | Not on iPhone |
| `#/spaces/:spaceId` and `#/spaces/:spaceId/workstreams/new` | Not on iPhone. Space grouping stays on the Mac |
| `#/notes/:id` | Not on iPhone. Notes stay on the Mac |
| Meeting window / Control Tower live capture | Not on iPhone. AudioWorklet capture stays on the Mac |
| `#/sidekicks`, `#/sidekicks/:id`, `#/automations/:id` | Sidekicks tab; open is `/conversations/:id`. Creating a Sidekick stays on the Mac |
| `#/settings` and settings window | Settings sheet: Account, Digest, Notifications (when the flag is on), Workspace members, Appearance, leave, sign-out |
| Settings: connections, GitHub, custom MCP, Terminal network | Named in Settings as Mac-only |
| Application: menu bar, Dock icon, login item, lockdown | Named in Settings as Mac-only |
| Application: Apple push | Same registry as the Mac. iOS uses topic `ai.rallywith.ios` and the sandbox host from a Debug build |
| Search (⌘K) | Search sheet; pages follow `nextCursor` |
| Account / workspace switcher | Workspace picker after leave; sign-out |
| Deep-link error window | Alert: "This Rally view does not exist or is no longer available." |
| macOS menu bar extra window | Desktop-only |

Feed row kinds (desktop `messageType` / omitted placeholder / stripped suggestion):

| Kind | iOS `RallyChatMessage.Kind` |
| --- | --- |
| `text` | `.text` |
| `thought` | `.thought` (folded into `.workAccordion` once settled above an answer) |
| `tool_event` | `.toolEvent` |
| `plugin_activity` | `.pluginActivity` (tool blocks with `pluginId`, or `messageType`) |
| `work_accordion` | `.workAccordion` |
| `elicitation` | `.elicitation` (text / radio / multi, skip + submit) |
| `system` + `assistant_turn_failed` / `stopped` | `.system` + Retry |
| `automation_activation` | `.automationActivation` |
| omitted-blocks placeholder | `.omitted` |
| `suggestion` | stripped, not shown |
| unread divider, load-older, jump-to-latest, streaming caret, attachments, speak/copy | Work streams feed |

## Invariants

- **Native SwiftUI only.** A React Native, Expo, Flutter, or Capacitor
  dependency in `apps/ios` means this is no longer the iOS client this document
  describes, and TestFlight review would be given a different product than the
  one signed as `ai.rallywith.ios`.
- **Refresh tokens live in the Keychain**, accessibility
  `AfterFirstUnlockThisDeviceOnly`. Putting them in UserDefaults, iCloud, or a
  file would copy desktop's main-process secret into an unencrypted container
  on a phone.
- **Socket tickets travel as `Sec-WebSocket-Protocol`**, never as a query
  parameter. A leaked URL in a proxy log would otherwise be a feed credential.
- **The handshake Origin is `app://rallywithai`**, the same allowlisted
  value desktop sends. `URLSession` does not set `Origin` on a WebSocket
  upgrade; the Worker rejects a missing one before it reads the ticket.
- **The iOS pool is the navigation stack, not the desktop swarm.** A second
  live feed is only Main of the parent still on the stack. Hover warming,
  pinned/recent/running rows, and a five-minute graveyard are desktop-only.
- **Identity stays on Global; workspace traffic stays on `apiBaseUrl`.** Mixing
  them would send EU workspace content to the Global Worker.
- **An opening message is text or attachments**, never `" "` so the refine on
  `CreateWorkstreamRequestSchema` can pass for photo-only starts.
- **Leave uses `DELETE /workspaces/:id/membership?expectedOutcome=left`.** A
  different outcome string is a different membership mutation.

## Boundary

This module owns the iOS binary, its signing, and the way that binary talks to
already-shipped HTTP and socket contracts. It does **not** own those contracts
([`architecture.md`](architecture.md), [`packages/contracts`](../packages/contracts)),
desktop isolation ([`security.md`](security.md)), or APNs delivery itself
([`push-notifications.md`](push-notifications.md)). Account erasure for other members is operator work, not an iOS
route.

Callers: a person on an iPhone or iPad, TestFlight, and App Store Connect.
Nothing in the Worker imports this tree.

## Failure modes and limits

- Sign-in cancel (`ASWebAuthenticationSessionError.canceledLogin`) is silent.
- HTTP 401 on workspace calls refreshes once, then signs out.
- Socket close after a snapshot has painted: the transcript stays in the
  snapshot cache; send or foreground remints a ticket. There is no background
  reconnect loop. A retained Main feed is not presence.
- Offline is `RallyAPIError.offline` and an alert. Nothing is queued on device.
- Composer cap is `APIConfiguration.messageMaxCharacters` (100,000), the same
  number as the HTTP contract.
- APNs registration is the same PUT/DELETE as desktop. A missing token (simulator,
  unsigned Debug) is not an error; the device is simply not in the registry.
  Denied permission deletes the row so email fallback can still fire.
- Voice capture fails closed: denied speech or microphone shows a status string
  and does not send.

No new numeric limit is invented here. Caps that already exist on the API are
reused; member-facing erasure is left open because the Worker does not implement
it.

## Testing

| Suite | Command | What it can prove |
| --- | --- | --- |
| XCTest | Xcode → RallyTests | PKCE lengths, deep-link parsing (including child path and `?substream=`), Apple push payload parse and PUT body, transcript mapping, feed kinds, branch provenance, member/search decode, REST vs nested snapshot decode, substream prepare/confirm/control metadata, work-stream appearance hash and catalog fallback, account initials/color decode and personal-color aliases, work-stream recency directory order, navigation-shaped socket retain set, feed chrome while a substream opens. Needs iOS 26 SDK. |
| UI tests | Xcode → RallyUITests | Intro chrome and Continue with Google. `testLocalDevelopmentAccountReachesChats` is skipped unless `RALLY_LOCAL_UI=1` and a local Worker is up — CI never sets that. Needs a simulator. |

This sandbox cannot run `xcodebuild`, and nothing on Linux tests the iOS tree:
a source scan of the Swift and Xcode files was removed because it asserted on
file text rather than behavior. A Swift behavior change needs RallyTests on a
Mac before it is believed.

## Regional impact

Identity start and ticket exchange are Global-only, same as desktop. After
activation, every work-stream call uses the workspace session's `apiBaseUrl`
(`https://api.rallywith.ai` or `https://eu.api.rallywith.ai`). EU inference is
not archived; debugging a run in an EU workspace stops at that region, per
[`runbook.md`](runbook.md).

## Security and trust model

iOS has no renderer to isolate. The trust split is: UIKit/SwiftUI process vs
Keychain vs the regional Worker. `ASWebAuthenticationSession` is the browser
for Google; the app never sees the password. Associated domains are the
universal-link admission list. See [`security.md`](security.md) for how this
sits next to Electron's renderer isolation.

## Operations

Archive and upload are manual on a Mac; there is no CI lane yet. Health of the
API is unchanged. A TestFlight build that cannot sign in is almost always a
missing `rallywithai` URL type, a wrong return URI, or Automatic signing
pointed at the wrong team.

## Open questions

- Member-facing erasure: Settings currently leaves + signs out + privacy URL.
  An in-app delete that actually drops identity needs an API.
- Meeting capture, Projects, Notes, connector OAuth, GitHub repo access, Terminal
  network policy, and composer queue reorder remain Mac-only until those APIs
  have a phone-sized UI and, for capture, an iOS audio path.

## Changelog

### 2026-09-22 — Copy hierarchical resource links

The iPhone now reads Base58 hierarchical universal links and copies Channel and
Breakout URLs in the same public shape as desktop. Because its current history
model has no selected Space, Copy link asks the existing Channel access endpoint
for current placements and chooses an Organization-wide Space before a personal
one, with ID as the tie-break; it does not add a
second Space directory to the iPhone solely for link construction.
Space-only URLs remain on the web with a desktop-only explanation: the iPhone
does not yet have a Space dashboard. Until a release with the new parser is
available, its association claims only legacy Channel paths. New canonical
Channel and Breakout links enter through the site, which hands old builds an
addressed legacy deep link; the new universal-link claim can be enabled later.

### 2026-09-21 — Remove global pin controls from Space-less history

The iOS history list no longer displays, pins, or unpins Channels. Pin state is
now scoped to a Channel's placement in a selected Space, and this surface has no
Space selection. Treating “pinned anywhere” as one list was rejected because it
would merge independent Space arrangements back into a global pin. A future iOS
Space surface can restore the controls with an explicit `spaceId`.

### 2026-09-11 — Native SwiftUI client, Grok IA, desktop PKCE

**What changed:** Rally ships an iOS app under `apps/ios` as SwiftUI on iOS 26.
The ready surface is Work streams plus Sidekicks. The Work streams tab is a three-step stack: the
work-stream list, then that stream's substreams, then the feed. The list has
no search field and no trailing plus; Sidekicks has no plus. New work streams
and Sidekicks start on the Mac. Liquid Glass is
the system navigation layer (tab bar, toolbars) plus a composer `safeAreaBar`;
lists and transcript bubbles stay opaque content. The Work streams leading control is
the account avatar from Global identity (`GET /onboarding/account`): stored
initials and personal color, always a circle. The work-stream list is Pinned then
access recency, same headings as the Mac sidebar. Projects and Notes are not on
the phone: they stay on the Mac with Control Tower capture. Debug builds can
also mint the local development session (`/auth/dev/session` plus
`/auth/dev/identity`) so the simulator can sign in against wrangler; ATS allows
local HTTP without disabling it globally. The feed projects every desktop
`messageType` (text, thought, tool, plugin, accordion, elicitation, system,
automation, omitted; suggestions stripped). Live feed frames use
`transcript_turn_upserted` plus `stream_started` / `stream_delta` /
`stream_completed`; `turn_upserted` is the range-protocol name and is ignored
on this socket. Multi-select elicitation answers go on the wire as a JSON
array. Authenticated HTTP refreshes the access token once on 401 and retries.
Work-stream directory menus send `workspace` / `personal`. Digest saves keep
the decoded `deliveryTargets`. Sign-out revokes both stored sessions. Archive
export writes an IPA (`destination = export`). Test bundles do not inherit the
app Info.plist or APNs entitlements. The association file claims the iPhone
bundle next to the Mac. Work-stream substreams use the same
parent + child ids as desktop: **New substream** on the substream list and on a
settled main-feed message opens the launch composer, and prepare/confirm run on
submit. Opening a substream or the substream list replaces the stack on the tap
with no push animation, so the skeleton (or Main and New substream) is the first
frame. The feed shows skeletons until a snapshot paints; the
substream list shows Main and New substream immediately and fills children
when the parent directory arrives. The row does not wait for the ticket. Every
live connection is a `RallyTicketedSocket` (ticket as subprotocol, Origin
`app://rallywithai`, subscribe on open). Directory and transcript state come down those sockets, not REST. Directory rows use the shared appearance catalog: a circle for a work
stream, a hexagon for a Sidekick, the same colours and the same id-derived
fallback as desktop. In-app Rally chrome uses the shared loop mark
(`assets/brand/rally-mark.png`), not the retired four-pointed spark. Socket
ownership is a navigation-shaped pool: the workspace session, the parent on
the stack, the visible feed, Main of that parent while a child or the
substream list is showing, and presence-free feeds for directory rows that
stayed on screen for one second. Directories and the feed page: subscribe is
page one, `list_workstreams` and fenced `load_transcript_range` follow the last or
first visible row, and a later subscribe does not drop pages already
scrolled. Feed history waits until the bottom-anchored list has settled before
treating the top edge as a page request. Child rows on the substream list warm on appear. A ticket already
minted for a still-retained feed is kept when a tap upgrades presence. The App Store icon is the Electron Dark selectable mark, flattened to
RGB. TestFlight identity is bundle `ai.rallywith.ios`, team `7ZLT6A8W25`,
version 1.0.0. Apple push uses the Worker registry the Mac already has:
`platform: "ios"`, topic `ai.rallywith.ios`, Debug sandbox / Release
production, a Keychain installation id, and a tap that opens `rally.url`.

**Why:** The product needed a phone client that could go to TestFlight without
standing up a second UI stack, and then a phone that could actually walk the
same objects a person already uses on the Mac. Wrapping the Electron renderer
in a WebView, or adopting Expo/React Native/Flutter, would have imported a
second bridge and a second release pipeline into a seed-stage repo that already
pays for one desktop renderer. Native SwiftUI is the smallest new surface that
can use Liquid Glass, Dynamic Type, and the system sign-in sheet, and it can
reuse HTTP and socket contracts the Worker already enforces. Inventing a
parallel feed model would have drifted from
[`conversation-surfaces.md`](conversation-surfaces.md) on day one; projecting
the same kinds keeps one transcript. The Dark desktop icon is the mark people
already have in the Dock — a second glyph would have been a second brand. The
phone shell is conversation plus Sidekicks: project grouping has no phone-sized
space yet, and Notes without Control Tower capture would be a read-only stub of
the Mac. Storing an APNs token in UserDefaults until a second Worker topic
existed left mentions on a closed iPhone undelivered after the Mac registry
had already shipped; iOS registers into that registry instead of inventing
another queue. Opening onto a composer hid the directory a phone user needs to pick
work; the Grok Bot list, then the substream list, then the feed is the same
parent → child → transcript split
[`substream-creation.md`](substream-creation.md) already documents, as a
push stack rather than a fifth tab. A local title filter in that list is not
workspace search, and a trailing plus next to Settings is a second create
surface on a screen whose job is opening work that already exists. Liquid
Glass belongs on that navigation layer. Recreating a custom top bar and hiding
the system toolbar would have
skipped the material Apple applies automatically and stacked glass on opaque
fills. The Work streams chip has to read the stored initials and color; a first letter
of the Google name with no fill would have been a second identity next to the
account people already set on the Mac. A letter in a hashed circle would have been a second identity for the
same objects the Mac already paints from the appearance catalog. Local Google
OAuth cannot complete against wrangler, so Debug reuses
desktop's dev session rather than pointing the shared scheme at localhost (which
would ship a production TestFlight build at the wrong host). Switching chats on
a phone is the stack, not a sidebar of pins; reminting a ticket on every send
would spend a one-use credential to re-handshake a socket that was already
open. Keeping Main of the open parent is the back-target the Grok list
promises, without holding every pinned or running stream. Visible directory
rows warm after one second so opening them paints from a snapshot instead of
a cold ticket. Painting the work-stream
list in API arrival order would have been a second directory next to the pin
and last-access order [`workstream-pinning.md`](workstream-pinning.md) already
owns. Waiting for a feed ticket before pushing a substream froze the list on a
destination the tap already knew; the feed skeleton is that wait, not a spinner on
the row. A zoom from the row hid that skeleton until the morph finished, and
`GeometryReader` reported a zero width for the pills during the transition, so
the wait looked empty. Directory-row appear/disappear must not each start a new pool pass:
overlapping applies cancelled the control socket before `workstream_metadata`.
A control subscribe sent before the WebSocket was open was dropped, then
treated as connected, so later retain passes never retried and the child
roster never arrived. Painting the directory or Main transcript from REST
while the same fields arrive on subscribe was two paths to one field —
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) forbids a REST
read for the first value a socket will push. A workspace upgrade without
`Origin: app://rallywithai` is refused before the ticket is read —
`URLSession` does not send `Origin` unless the handshake request sets it, and
the refusal surfaces as NSURLError -1011 with an empty work-stream list.
A `load_transcript_range` that named only `beforeSequence` was not a
`WorkstreamTranscriptRangeRequest` — the room refused it as `invalid_event`,
and a fire-once `onAppear` at the top of a bottom-anchored feed never retried,
so older history never arrived. Treating the first layout (offset 0 before
`defaultScrollAnchor(.bottom)` applies) as “the reader pulled to the oldest
row” then paged the whole transcript against a tail-follow, flashing empty
LazyVStack gaps. Waiting one second to warm a child the
substream list was already showing made the first tap a cold handshake.
Replacing a scrolled directory with subscribe's first page would have
thrown away rows the reader had already paged; a Load-earlier button on the
feed would have been a second paging control next to the terminal row.

**Considered and rejected:** An Expo or React Native shell around the existing
renderer. That would have shipped faster pixels and a permanently different
client, with no Keychain story and no path to 2026 HIG materials. Also
rejected: minting an `avalon-ios` JWT audience. The desktop exchange already
issues tokens the Worker accepts; a second audience is a Worker change this
client does not need in order to sign in. Also rejected: stubbing Mac-only
settings (menu bar, lockdown, Terminal policy, connector OAuth) as working
toggles. A disabled row that pretends to save would be a lie on a phone that
cannot hold those secrets. Also rejected: keeping Projects and Notes as tabs
that list Mac objects they cannot create or capture. Also rejected: listing
substreams as their own tab, or gluing Liquid Glass onto every row and bubble.
A tab would have mixed parent inventory with child conversations. Glass on
content would have broken Apple's rule that the material is the topmost
navigation layer and must not be overused. Also rejected: wiring the list
search field to `POST /search`, or keeping toolbar pluses that compose a
work stream or Sidekick. Those would have presented a fake directory search
and a Mac create-flow on the phone chrome. Also rejected: letter-in-a-circle
glyphs hashed from a private palette. Those would have been a second identity
next to the catalog [`workstream-appearance.md`](workstream-appearance.md)
already owns, and sparkles on the Sidekicks tab is a catalog icon, not the
Rally loop. Also rejected: keeping the Grok four-pointed spark as the in-app
mark. Desktop already retired that starburst for the shared loop. Also
rejected: copying Electron's pin/recent/running swarm or a five-minute retain
TTL onto iOS. `URLSessionWebSocketTask` dies in the background, and the phone
has no persistent sidebar those sockets would serve. Work-stream directory
rows use the same one-second delay desktop uses for hover; that is the row on
screen, not a guessed extra-socket ceiling. Substream-list children warm as
soon as they appear — copying the hover delay onto a list the reader already
opened made the first tap a cold handshake. Also rejected: a `beforeSequence`
range request, or a Load-earlier button. The room already has a fenced
`load_transcript_range`; a second paging control next to the terminal row
would have been a second way to ask. Also rejected: a LazyVStack sentinel as
the first child of a bottom-anchored feed, or retrying `load_transcript_range`
on connect while the scroll offset is still 0. Also rejected: a second iOS origin on
`ALLOWED_ORIGINS`, or REST-listing work streams when the handshake 403s.
The Worker already admits `app://rallywithai`; the bug was that iOS did not
send it. Also rejected: painting desktop's diamond, flower, or arch on the 32pt toolbar
chip, or hashing a color from the display name. The phone control is always a
circle filled with the stored personal color. Also rejected: sorting work streams by
last shared activity, or flattening pins into the recency groups. Pins are a
hand-arranged section; unpinned rows group by this viewer's last access. Also
rejected: holding the substream list until the conversation socket connected,
showing the empty-greeting chips while a known feed is still opening, or covering
Main and New substream with a full-list skeleton while the child roster is still
in flight. Also rejected: a zoom from the directory row into the pushed screen.
The morph hid the skeleton until it finished. Also rejected: a guessed sleep before `subscribe`. The protocol
signal is the socket open event, the same one desktop already waits for. Also
rejected: a REST first paint of the work-stream list or Main transcript.
Those fields already arrive on subscribe. Also rejected: a second iOS-only
push route, or leaving the APNs token in UserDefaults until a later Worker
change. The Mac registry already existed; iOS is a second topic on it.

**Consequences:** iOS is a peer of desktop, not a mode of it. Session files,
preload, and CSP in `apps/desktop` do not apply. A future iOS feature that
needs a new Worker route has to land in the API first. Member-facing erasure
is still out of this change. Apple push registration is in: Debug tokens go
to Apple sandbox because that is the entitlement the Debug build signs, and
the consumer must use the host that environment names. Meeting Control Tower, Projects, Notes, connector authorization, new
work streams, and new Sidekicks stay Mac-only. A new substream
still starts from the list row or a settled feed message. Child membership stays creator-only because that is the platform
policy, not an iOS omission. Prepare still happens on the submit keystroke, not
when the launch surface opens, so backing out of an unsent composer does not
reserve a child. Foregrounding remints dropped sockets in the retain set; it
does not hold extra connections while the app is suspended. A scrolled
work-stream list keeps later pages across a subscribe overlay; `nextCursor`
is adopted only while the client is still on page one.

Shipped in #725.
