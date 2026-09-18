# Apple push notifications

Rally sends mentions and additions to signed-in Macs and iPhones through APNs, using the
existing workspace notification intent. Push is enabled for everyone from launch through
`push-notifications-enabled`; Slack also sends when available, and email is the
fallback when neither Slack nor push accepted the notification.

## Where the code lives

- `apps/api/src/services/push-device-service.ts`: regional D1 device/session registry.
- `apps/api/src/services/push/`: provider authentication and payload rendering.
- `apps/api/src/queues/push-delivery-consumer.ts`: intent read, existing access check, send, receipt.
- `apps/desktop/src/main/push-notifications.ts` and `apps/desktop/native/push-notifications/`: Mac registration and native response/permission callbacks.
- `apps/ios/Rally/App/RallyPush.swift`, `RallyAppDelegate.swift`, and `AppModel` reconcile: iPhone registration, permission, and tap routing.

## How it works

Every stored workspace credential registers the installation with its own region.
The Mac loops every credential it holds; the iPhone holds one workspace session
and registers that one. Delivery requires a live session bound to that device; another installation's
session cannot keep it alive. The device switch and a separate push installation
ID persist in the existing application settings file on the Mac, and in the
Keychain on iPhone.

The producer enqueues only region, workspace, recipient and intent identifiers.
Settlement retains the payload only when push was enqueued, until the existing
intent retention expires. The consumer reads content through `WorkspaceDO.readNotificationIntentForDelivery`
and reuses the processor's `notificationDeliveryContext`. A projection behind
its required version retries; revoked access stops delivery. No presence check is
added. Successful enqueue with a live device counts as push acceptance for email
fallback, not proof of an Apple alert.

Success receipts key on workspace, intent and device. A partial retry skips only
those devices already reached for that intent. Sending precedes recording, so an
uncertain send can alert twice. Collapse identifiers are hashes of workspace and
intent, because existing intent IDs are not UUIDs. No exactly-once claim is made.

Receipts currently live until their device is deleted. After the existing intent
retention expires they are inert: no later intent reuses the key. This accepts
one small row per successful intent/device at the current product size, rather
than adding a cross-store retention job for launch. Future pruning should join
existing intent retention, not introduce another scheduler.

Payload bodies reduce Markdown formatting and Rally's internal citation and
person-mention references to readable plain text before carrying the first
1,000 Unicode code points with an ellipsis when shortened, fitted further to
Apple's 4,096-byte ceiling. Every alert also sets APNs `badge` to
the recipient's count of unarchived, non-system work streams in that workspace that
are unread for them, or `needs_input` while they are a participant — the same
directory `attention` read already returns as `unreadAndNeedsInputCount`. Each
stream counts once even when both apply. A send from one workspace does not sum
other workspaces: iOS holds one session, and a global inbox is out of scope.
Omitting `badge` would leave the previous icon count in place; `0` clears it.
APNs retains undelivered alerts for
24 hours. Provider JWTs are shared through regional KV and refreshed at 50 minutes;
no coordination object is introduced. Enqueue and send share the same
production/staging availability check. Queue retries and dead-letter queues own
transient delivery failures. Provider-auth failures notify operations without
disabling devices; one provider fault stops the remaining batch sends and
produces one operator notice per batch. Token-update throttling keeps the cached
provider token.

The main process uses Electron for APNs registration and a small native delegate
for permission state and explicit notification clicks. The delegate forwards
unrelated notification callbacks to Electron. Receipt never implies a click.
Registration waits for an affirmative permission result, and returning to Rally refreshes permission state so denial removes
server registrations. Session, setting, and feature-flag changes serialize fresh
registration passes; unchanged flag polls do not register again. Every pass asks
Electron for the current token, so the registration timestamp corresponds to an
APNs registration rather than a heartbeat. Sign-out cancels pending work and
unregisters natively immediately; captured credentials permit best-effort server
cleanup without delaying local credential removal. Optional push settings I/O
cannot abort application startup.
APNs groups notifications by the main workstream ID, including notifications
from its substreams. Clicks still target the originating substream.
Clicks pass the HTTPS link through the existing work-stream parser and scheme
navigation, including pending navigation before sign-in or window readiness.
iOS parses the same `rally` object and opens `url` as a universal link. Debug
iPhone builds sign the development APNs entitlement, so their tokens are
`apnsEnvironment: sandbox` and the consumer posts to
`api.sandbox.push.apple.com`; Release and TestFlight stay on production, like
the Mac.
Main-window creation waits for renderer protocol and IPC installation, including
when a native notification response arrives during asynchronous app startup.

## Operations and release

Set `APNS_AUTH_KEY` and `APNS_KEY_ID` separately on both regional API Workers.
Without them, health reports push as not configured and existing email delivery
continues. Local/test transports do not contact Apple. APNs requires the device address in
the request path, so existing Cloudflare automatic outbound traces include it;
application log fields omit tokens and content. The existing queue provisioner
creates each region's push queue and dead-letter queue from Wrangler configuration.

Enable Push Notifications and Associated Domains on `ai.rallywith.desktop` for
team `7ZLT6A8W25`. Store the base64 Developer ID provisioning profile in the
`desktop-release` secret `RALLY_MAC_PROVISIONING_PROFILE`; local packaging uses
`RALLY_MAC_PROVISIONING_PROFILE_PATH`. Packaging requires the profile and checks
its identity, capabilities and expiry. No extra pre-expiry margin is imposed.
The packager passes the resolved profile path as an electron-builder CLI option;
the `mac.provisioningProfile` YAML field does not expand environment macros.
The verifier extracts scalar profile fields as raw values because `plutil` JSON
output supports dictionaries and arrays, not standalone booleans.
Apple profiles may authorize Associated Domains with the scalar `*`; the signed
app must still declare exactly the two Rally domains.

Publish the site association files before desktop release. The desktop release
preflight checks both live hosts, so independently triggered deployments cannot
publish the desktop first. Verify signed-Mac acceptance before release: permission, background and quit delivery/clicks, private children,
sign-out, both regions and HTTPS links. Native compilation and automated tests
are not this acceptance. Turn the flag off to stop push delivery.

Deployment readiness checked on 2026-09-14: both regional Workers have the APNs
secret names and healthy public probes; GitHub's `desktop-release` environment
has the provisioning-profile secret. The live Flagship definition is enabled,
default `on`, with no targeting rules. Push queues/tables are not deployed yet,
and both association URLs still return 404. The standard deployment owns those
resources; secret presence does not establish APNs credential validity or
signed-Mac delivery.

## Invariants

- Existing sessions, regional routing and access checks remain authoritative.
- Queue messages and application logs contain no notification content or device tokens.
- Only explicit notification responses navigate; remote alerts are not reposted locally.
- A device-wide delivery timestamp must never suppress a different intent.

## Testing

`push-device-service.test.ts` uses real migrated SQLite. `push-payload.test.ts` and
`apns-transport.test.ts` cover encoding/signing, Apple responses, and the
sandbox versus production host. The real
workerd `push-delivery.test.ts` covers read RPC, receipts, revocation, retry,
and that `aps.badge` is the workspace attention count of unread and needs-input
streams. `workspace-attention.test.ts` covers that count against the same
directory projection. Desktop push/link tests cover registration and routing; existing settings and
release suites cover the integration. iOS XCTest covers payload parse and the
PUT body. The provider itself and macOS/iOS alert
presentation require a signed installed build.

Local acceptance on 2026-09-14: lint/typecheck, scoped API and desktop tests,
27 workerd delivery/notification tests, 38 site tests, 461 repository script tests
and 141 release tests passed. The native bridge compiled on arm64 macOS and the
Notifications pane was inspected in a real Electron window. Negative controls
caught broken session binding, reassignment/deletion, receipt skipping, access
checks, APNs disable handling and premature payload clearing. No deployment or
signed-Mac APNs/universal-link acceptance is claimed.

## Changelog

### 2026-09-15 — Alert bodies are plain text, not Markdown

**What changed:** Mention and participant-added alert bodies pass through the
same plain-text reducer as email and Slack. Formatting marks are removed, and a
stored
`[@Name](person://<uuid>)` mention reaches APNs as `@Name`; Rally citations also
degrade to their visible labels without appending a source list to the alert.

**Why:** The push consumer handed canonical stored message text directly to
APNs, so macOS displayed Rally's durable mention syntax and UUID instead of the
chip label a person sees inside the app. Fixing presentation in each Apple
client would duplicate a server-owned message protocol and leave notification
extensions dependent on Rally's Markdown grammar.

**Consequences:** Payload truncation still runs after reduction, so the 1,000
code-point preview and 4,096-byte APNs ceiling apply to what the recipient
actually reads. Both Apple platforms receive the same plain reference text.

### 2026-09-15 — Set APNs badge from unread and needs-input work streams

**What changed:** Alert payloads now include `aps.badge`, set from
WorkspaceDO's attention read: the number of unarchived, non-system work streams
in that workspace that are unread for the recipient, or `needs_input` while they
are a participant. Ordinary unread that is not a mention, seating, or elicitation
counts; a needs-input stream that has already been read still counts; a stream
that is both counts once. `GET /workspace/attention` exposes the same number as
`unreadAndNeedsInputCount`.

**Why:** The iOS (and Mac) app icon had no count. The push design reserved
`badge` for the attention read once that existed; using `waitingForYou` would
have omitted unread streams that are not addressed and would have treated
unseen-only rows as the icon count. A second producer or a silent badge-only
push would have been another queue hop for a number the delivery consumer can
already read from the directory it is fenced on.

**Considered and rejected:** Summing every workspace the person belongs to.
Attention is workspace-scoped, regions do not share directory rows, and
multiple workspaces have no global inbox. iOS registers one session. Also
rejected: setting badge only on iOS devices. APNs `badge` is how Apple paints
the icon on both platforms; a later local Dock count fed by the socket is a
different surface.

**Consequences:** The icon reflects this workspace at send time. Reading a
stream does not clear the badge until the next alert (or a client that sets it
locally). A Mac with several workspace credentials shows whichever workspace
last notified. Future silent badge refreshes belong with that local surface,
not here.

### 2026-09-15 — Wait for application startup before opening a notification target

Signed-Mac acceptance found that clicking a notification with Rally quit opened
a blank window: Electron was ready before Rally's async initialization installed
its renderer protocol and IPC. Main-window creation now waits for that setup,
preserving the existing pending-link queue. This also covers early URL callbacks
without a separate notification window or retry timer. Concurrent open requests
share the in-flight renderer load and respect `ready-to-show` before revealing
the window, including the interval between load completion and first paint.

### 2026-09-14 — iOS registers the same Apple push registry

**What changed:** `APNS_TOPICS.ios` is `ai.rallywith.ios`. The register schema
accepts `platform: "ios"` with sandbox or production, while the Mac stays
production-only. Live devices carry `apns_environment` so the consumer posts
sandbox tokens to `api.sandbox.push.apple.com`. The native iOS client PUTs and
DELETEs `/push-devices/:installationId` like desktop, gated on the same
feature flag, and opens `rally.url` from a notification tap.

**Why:** The desktop ship left iOS holding a device token it could not send.
A second iOS-only route would have been two registries for one intent. Debug
iPhone builds are Apple sandbox; posting those tokens at production APNs
fails as `BadDeviceToken`, so the host has to follow the environment the
client registered.

**Considered and rejected:** Keeping the Mac schema macos-only and inventing
an iOS path later. Also rejected: sending every iOS token at production APNs.
The Debug entitlement is sandbox; that is Apple's split, not a defensive
guess.

**Consequences:** A signed TestFlight/Release iPhone uses production, like the
Mac. Simulator and unsigned Debug builds still have no token. Shipped in #725.

### 2026-09-14 — Add Apple push as a transport of existing notification intents

A closed desktop previously received no device-local notification. Reuse the
intent audience and access decision rather than invent a second producer. The
PRD's device-wide timestamp was replaced with per-intent/device receipts because
an unrelated later send would otherwise swallow a retry. The user chose code-first
implementation with signed-Mac acceptance before release, explicit native click
callbacks, and a 24-hour APNs expiration. The subsequent rollout decision enables
push for everyone from day one; the existing flag remains an operator off switch.
Keep the transport small and preserve
at-least-once delivery rather than adding coordination machinery. Registration is
serialized and cancelable because permission prompts and network requests can
outlive session changes; this optional transport must never delay sign-out or
prevent app startup. Provider credential failures stop the current queue batch
rather than repeating the same failure and operator alert for every device.
Notification grouping uses the main workstream so its substreams appear together,
while click destinations preserve the originating conversation.
