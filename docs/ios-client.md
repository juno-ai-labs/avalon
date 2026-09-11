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
| `apps/ios/Rally/RallyApp.swift` | `@main`. Appearance, deep links, push authorization. |
| `apps/ios/Rally/App/AppModel.swift` | Session lifecycle, workspace pick, directory, send, socket consume, pin/archive/search. |
| `apps/ios/Rally/App/MainShell.swift` | Tab shell: Chats, Projects, Notes, Sidekicks. |
| `apps/ios/Rally/Auth/PKCE.swift` | S256 attempt/verifier/challenge, same lengths as the desktop store. |
| `apps/ios/Rally/Auth/KeychainStore.swift` | Identity and workspace sessions. Refresh tokens never go in UserDefaults. |
| `apps/ios/Rally/Network/RallyClient.swift` | Regional HTTPS. `ConversationBoot` also understands a nested socket snapshot. |
| `apps/ios/Rally/Network/ConversationSocket.swift` | `rally.ticket.v1` + ticket as `Sec-WebSocket-Protocol`. Subscribe, send, stop, retry, elicitation, older ranges. |
| `apps/ios/Rally/Network/WorkspaceSocket.swift` | Directory subscribe. Projects exist only on this sidebar; there is no `GET /projects`. |
| `apps/ios/Rally/Features/Chat` | Transcript, `FeedProjection`, composer. Same row kinds as desktop `messageType`. |
| `apps/ios/Rally/Features/Projects` | Project list and project space. |
| `apps/ios/Rally/Features/Notes` | Note list and detail (Control Tower recording stays on the Mac). |
| `apps/ios/Rally/Features/Sidekicks` | Sidekick library; opening one is the same conversation surface with the automation id as parent. |
| `apps/ios/Rally/Features/History` | History sheet: pin, unread, archive, rename, public/private. |
| `apps/ios/Rally/Features/Settings` | Account, digest, members, appearance, leave/sign-out. Desktop-only settings are named, not faked. |
| `apps/ios/Rally/Assets.xcassets/AppIcon.appiconset/AppIcon.png` | 1024 RGB App Store icon, flattened from the Electron **Dark** selectable icon (`apps/desktop/resources/app-icons/dark.png`). |
| `apps/ios/Rally/Design` | True-black/light palette, Liquid Glass wrapper, Dynamic Type, Rally mark. |
| `apps/ios/fastlane` and `apps/ios/scripts/archive-testflight.sh` | App Store export. Must run on a Mac. |
| `scripts/ios-project.test.mjs` | Linux-runnable packaging invariants. |

There is no `apps/ios/package.json`. `pnpm-workspace.yaml` globs `apps/*`; a
Node package here would be picked up as a workspace package and is forbidden.

## How it works

### Sign-in

`POST /auth/google/start` with `returnUri = rallywithai://auth/complete`, a
43-character `desktopAttemptId`, and an S256 `desktopCodeChallenge`.
`ASWebAuthenticationSession` presents Google. The return URL carries `ticket`;
`POST /auth/desktop/exchange` on the Global API swaps it for an identity
session. JWT audience stays `avalon-desktop` — iOS reuses the desktop client
rather than minting a second audience.

`GET /onboarding` then lists workspaces and invitations. One workspace activates
immediately; otherwise the picker runs. Activation and create hit
`/onboarding/workspace/activate` and `/onboarding/workspace` and store a
*workspace* session whose `apiBaseUrl` is the regional Worker.

### Conversation

Ready state is the tab shell. **Chats** is Grok Bot's chrome: history, search,
a centered workspace pill that opens Settings, details (inspector), and new
chat. The composer is pinned to the bottom. Sending with no open stream
calls `POST /workstreams` with `openingMessage` (text or attachments, never a
placeholder space) and, when a project is selected, that project's id. An open
stream sends `create_message` on the conversation feed.

`GET /conversations/:id` paints the REST boot. `GET
/conversations/:id/substreams/0/socket` returns a URL and ticket; the client
connects with subprotocols `rally.ticket.v1` and the ticket, then
`subscribe`. Snapshot frames nest `workstream` + `transcript`; REST boots are
flat. Both decode through `ConversationBoot`. `FeedProjection` maps turns onto
the same row kinds the Electron renderer shows (`docs/conversation-surfaces.md`).

### Directory

`GET /workstreams`, `/notes`, `/sidekicks`, and `/workspace/members` paint the
first lists. `GET /workspace/socket` then subscribes; the sidebar on
`workspace_sync` is the authority for **projects** (the Worker has no project
index route). Opening a Sidekick uses the same conversation parent contract as
desktop: `/conversations/:automationId`.

### Appearance and HIG

Dark canvas is OLED `#000000`. Light inverts the same steps. System / Light /
Dark is a Keychain preference. Type uses Dynamic Type styles, not locked point
sizes. Navigation chips use Liquid Glass (`glassEffect`) on iOS 26 and
ultra-thin material below. Reduce Motion stops the streaming cursor blink.
VoiceOver labels cover history, new chat, send/stop, and message roles.

### TestFlight

Version `1.0.0` build `1`, Automatic signing, production APNs entitlements on
Release, associated domains `applinks:rallywith.ai` and
`applinks:www.rallywith.ai`, privacy manifest, `ITSAppUsesNonExemptEncryption =
false`, 1024px App Icon taken from the Electron Dark Dock icon, flattened to
RGB because App Store icons cannot carry alpha. Archive on a Mac with Xcode 26;
the sandbox image has no iOS SDK.

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
| Region + create workspace / invitations / activate | `WorkspacePickerView` |
| Guided connectors / profile / people journey | Skipped after workspace pick. Profile is Settings → Account; people are Settings → Members; connectors stay on the Mac |
| `#/` landing | Empty Chats composer (same hand-off as new work stream) |
| `#/workstreams/new` | New chat on the Chats tab |
| `#/workstreams/:id` | Chats conversation |
| Open, rename, pin, unread, archive, public/private | History swipe + context menu + inspector |
| Participants / resources inspector | Details sheet (people; add participant) |
| Suggested prompts | Empty-state chips from `/work-opportunities` |
| Stop / retry / copy / speak | Composer stop, failed-turn Retry, message actions |
| Save image / PDF / Mermaid export | Not on iPhone. Copy and Share are |
| Start substream | Not on iPhone. Same conversation parent; no child-create UI |
| Composer: send, stop, attach, dictation | Composer + PhotosPicker + file importer + `VoiceBar` |
| Mentions, slash commands, debug model override, pending-input reorder | Not on iPhone |
| `#/projects/:id` and `#/projects/:id/workstreams/new` | Projects tab + project space + new chat with `projectId` |
| `#/notes/:id` | Notes tab + detail |
| Meeting window / Control Tower live capture | Note list/detail only. AudioWorklet capture stays on the Mac |
| `#/sidekicks`, `#/sidekicks/:id`, `#/automations/:id` | Sidekicks tab; open is `/conversations/:id` |
| `#/settings` and settings window | Settings sheet: Account, Digest, Workspace members, Appearance, leave, sign-out |
| Settings: connections, GitHub, custom MCP, Terminal network | Named in Settings as Mac-only |
| Application: menu bar, Dock icon, login item, lockdown | Named in Settings as Mac-only |
| Search (⌘K) | Search sheet |
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
| unread divider, load-older, jump-to-latest, streaming caret, attachments, speak/copy | Chats feed |

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
desktop isolation ([`security.md`](security.md)), or APNs Worker delivery (still
the push PRD). Account erasure for other members is operator work, not an iOS
route.

Callers: a person on an iPhone or iPad, TestFlight, and App Store Connect.
Nothing in the Worker imports this tree.

## Failure modes and limits

- Sign-in cancel (`ASWebAuthenticationSessionError.canceledLogin`) is silent.
- HTTP 401 on workspace calls refreshes once, then signs out.
- Socket close after the REST boot has painted: the transcript stays; the next
  send reconnects. There is no background reconnect loop.
- Offline is `RallyAPIError.offline` and an alert. Nothing is queued on device.
- Composer cap is `APIConfiguration.messageMaxCharacters` (100,000), the same
  number as the HTTP contract.
- APNs registration stores the hex token in UserDefaults. Nothing sends it
  until the Worker grows an iOS topic. A missing token is not an error.
- Voice capture fails closed: denied speech or microphone shows a status string
  and does not send.

No new numeric limit is invented here. Caps that already exist on the API are
reused; APNs and erasure are left open because the Worker does not implement
them.

## Testing

| Suite | Command | What it can prove |
| --- | --- | --- |
| Packaging | `pnpm test:scripts` (file `scripts/ios-project.test.mjs`) | Native-only tree, bundle ID, team, entitlements, privacy manifest, 1024 RGB icon, required Swift files, Electron route coverage, feed-kind cases. Runs on Linux. |
| XCTest | Xcode → RallyTests | PKCE lengths, deep-link parsing, transcript mapping, feed kinds, member/search decode, REST vs nested snapshot decode. Needs iOS 26 SDK. |
| UI tests | Xcode → RallyUITests | Intro chrome and Continue with Google. Needs a simulator. |

This sandbox cannot run `xcodebuild`. The packaging test is the gate that CI
on Linux can actually fail. A Swift behavior change that the packaging test
does not see needs RallyTests on a Mac before it is believed.

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

- When the Worker grows `APNS_TOPICS.ios`, this client should POST the stored
  device token. Do not invent that route in the iOS tree.
- Member-facing erasure: Settings currently leaves + signs out + privacy URL.
  An in-app delete that actually drops identity needs an API.
- Meeting capture, connector OAuth, GitHub repo access, Terminal network
  policy, substream creation, and composer queue reorder remain Mac-only until
  those APIs have a phone-sized UI and, for capture, an iOS audio path.

## Changelog

### 2026-09-11 — Native SwiftUI client, Grok IA, desktop PKCE

**What changed:** Rally ships an iOS app under `apps/ios` as SwiftUI on iOS 26.
The ready surface is a Grok Bot transcript plus the Electron directory
(Chats / Projects / Notes / Sidekicks), talking to the existing Global/EU
Workers with the desktop Google PKCE exchange and Keychain sessions. The feed
projects every desktop `messageType` (text, thought, tool, plugin, accordion,
elicitation, system, automation, omitted; suggestions stripped). The App Store
icon is the Electron Dark selectable mark, flattened to RGB. TestFlight
identity is bundle `ai.rallywith.ios`, team `7ZLT6A8W25`, version 1.0.0.

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
already have in the Dock — a second glyph would have been a second brand.

**Considered and rejected:** An Expo or React Native shell around the existing
renderer. That would have shipped faster pixels and a permanently different
client, with no Keychain story and no path to 2026 HIG materials. Also
rejected: minting an `avalon-ios` JWT audience. The desktop exchange already
issues tokens the Worker accepts; a second audience is a Worker change this
client does not need in order to sign in. Also rejected: stubbing Mac-only
settings (menu bar, lockdown, Terminal policy, connector OAuth) as working
toggles. A disabled row that pretends to save would be a lie on a phone that
cannot hold those secrets.

**Consequences:** iOS is a peer of desktop, not a mode of it. Session files,
preload, and CSP in `apps/desktop` do not apply. A future iOS feature that
needs a new Worker route has to land in the API first. APNs delivery and
member-facing erasure are explicitly out of this change — the client stores a
device token and explains deletion, and nothing behind the API was invented to
match. Meeting Control Tower, connector authorization, and substream creation
are listed in the inventory as Mac-only rather than half-implemented.

Shipped in #725.
