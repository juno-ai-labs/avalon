# Push notifications

Rally pushes every row of the sidebar's Activity tab to signed-in Macs and
iPhones through APNs, and to signed-in browser tabs through Web Push. Mentions
and additions use the existing workspace notification intent; the rows Activity
reads from the directory (a thread or breakout somebody started, a run Rally
finished) are pushed from the Organization object as they appear
([Activity rows](#activity-rows)). Each device registers with one transport and
is sent only that transport's payload. Push is enabled for everyone from launch through
`push-notifications-enabled`. Each kind of row also goes by email or Slack when
the person chose that for it ([What each person chooses](#what-each-person-chooses));
nothing falls back from one channel to another.

## Where the code lives

- `apps/api/src/services/push-device-service.ts`: regional D1 device/session registry.
- `apps/api/src/services/push/`: provider authentication and payload rendering; `apns-transport.ts` for Apple, `web-push-transport.ts` for browsers.
- `apps/api/src/queues/push-delivery-consumer.ts`: intent or Activity row read, existing access check, send by transport, receipt.
- `apps/api/src/durable-objects/workspace-activity-push.ts`: which Activity rows a directory batch pushes, to whom, and the record that keeps each to one push.
- `packages/contracts/src/push-notifications.ts`: the registration contract and the Web Push service host allowlist (`isWebPushServiceUrl`).
- `apps/desktop/src/renderer/lib/web-push.ts` and `apps/browser/public/sw.js`: browser subscription and the service worker that shows the notification.
- `apps/desktop/src/main/push-notifications.ts` and `apps/desktop/native/push-notifications/`: Mac registration and native response/permission callbacks.
- `apps/ios/Rally/App/RallyPush.swift`, `RallyAppDelegate.swift`, and `AppModel` reconcile: iPhone registration, permission, and tap routing.

## How it works

Every stored workspace credential registers the installation with its own region.
The Mac loops every credential it holds, a guest's included, and the browser
registers a guest's tab as it does a member's. A registration belongs to the account in that deployment, not to one
workspace, so a guest workspace's notifications still reach a device that a
membership in the same deployment registered; the iPhone holds one workspace session
and registers that one. Delivery requires a live session bound to that device; another installation's
session cannot keep it alive. The device switch and a separate push installation
ID persist in the existing application settings file on the Mac, and in the
Keychain on iPhone.

The producer enqueues only region, workspace, recipient and intent identifiers.
Settlement retains the payload only when push was enqueued, until the existing
intent retention expires. The consumer reads content through `WorkspaceDO.readNotificationIntentForDelivery`
and reuses the processor's `notificationDeliveryContext`. A projection behind
its required version retries; revoked access stops delivery. No presence check is
added. Successful enqueue with a live device is not proof of an Apple alert.

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
Apple's 4,096-byte ceiling. Every alert also sets APNs `badge` to the number
the sidebar's **Threads** button counts, less pending access requests
([`attention-menu.md`](attention-menu.md)):
each Main the recipient may open and each Breakout they may list, in an
unarchived, non-system Channel, that is unread, unseen or mentions them. The
directory `attention` read returns it as `readerAttentionCount`
(`WorkspaceSpaceStorage.readerAttentionCount`). A run in `needs_input` is not
counted, as the Threads count does not include it. A send from one workspace does not sum
other workspaces: iOS holds one session, and a global inbox is out of scope.
Omitting `badge` would leave the previous icon count in place; `0` clears it.

While Rally runs, the Mac sets the dock badge itself. `useDockBadge` sends the
menu's count to main (`dock-badge:set`, `app.setBadgeCount`) on every change,
once the Channel directory and every Breakout list the count reads have
loaded, and clears it when the shell unmounts. Main re-applies the last count
when a Rally window gains focus, since a background alert from another
Organization sets that Organization's count. Foreground alerts leave `.badge`
out of their presentation options, so they never replace it.

macOS shows a badge only while notifications, with badges, are allowed for
Rally. Authorization requests `UNAuthorizationOptionBadge`, each permission read
(also on window focus) reports `badgeSetting` as `notificationBadgeStatus`, and
Settings → Notifications offers **Open System Settings**
(`com.apple.Notifications-Settings.extension?id=` the bundle id) when
notifications or badges are off.
APNs retains undelivered alerts for
24 hours. Provider JWTs are shared through regional KV and refreshed at 50 minutes;
no coordination object is introduced. Enqueue and send share the same
production/staging availability check. Queue retries and dead-letter queues own
transient delivery failures. Provider-auth failures notify operations without
disabling devices. A provider fault is scoped to its transport: the rest of the
batch skips that transport's devices and retries those messages, the other
transport keeps sending, and each faulted transport produces one operator
notice per batch. Token-update throttling keeps the cached
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

## Activity rows

Everything the Activity tab lists can be a push, an email or a Slack message.
`added` and `mentioned` go through their notification intents above, whose
processor sends each channel the person chose. `thread_started`,
`breakout_started`, `run_finished` and `merged` are read by the feed from the directory
rather than from an event ([`digests.md`](digests.md#the-activity-tab)), and
`workspace-activity-push.ts` queues one message per chosen channel.
`artifact_updated` goes the same way, to the person who pinned the artifact
alone: its trigger is a new version reaching the pinned-artifact ledger
(migration 111), drained after the write that filled it, and the person's
**Pinned artifact updates** setting (`artifactUpdates`) chooses its channels.
It reads "Rally updated launch-checklist.md" and opens the artifact, expanded
over its thread, through the link's artifact segment
([`workstream-links.md`](workstream-links.md#the-two-forms)).

**The trigger is the directory write.** `applyDirectoryBatch` reads each
conversation's row either side of its common effect and names what moved in
the follow-up (`activityPushSubjects`):

- a **start**: no row before, and a row that reads as started by somebody after;
- a **finish**: the state arriving at `completed`. Not `completed_at` moving: a
  parent stamps a completed thread's finish with its latest activity
  (`aggregateCommon`), so later traffic moves it with no new run;
- a **join**: a person becoming a participant of a thread or breakout. A viewer
  row travels in its own message and can land after the start was decided, so
  a join reconsiders that conversation's start for that person.

The push runs from the follow-up table after the commit, best effort, as the
Channel row sends are: a failure is logged as `activity_push_failed` with its
reason and not retried, because the row is in Activity either way and a push
must not re-run the batch's other work.

**The feed decides what each person is told.** A start asks everyone when its
conversation is Organization-wide, else the people its viewer rows name; a
finish asks only its participants, the only people the feed shows one to; a
join asks the person who joined. D1 narrows that to active members, and the
object keeps those with a live device or a channel other than push chosen for
these kinds. For each, the object reads their first Activity page and pushes the
rows about those subjects that are unread, of the subject's kinds, from after
migration 105 ran (`workspace_activity_push_origin`) and not handed to
delivery before (`workspace_activity_pushes`). So nobody is told about a
conversation they cannot list, the starter is not told of their own start, and
a backfill that re-projects old threads pushes nothing. Two rows are left out
on purpose:

- a start, when the person has an add for that conversation, since the add
  pushes itself; checked when deciding and again when sending, because the add
  lands after the viewer row it depends on; and
- anything about a thread the person has open in a foreground window
  (`contributesPresence`). Rally finishes a run on every reply, and a banner
  for the reply already on screen is noise. Mentions keep the old rule of no
  presence check.

**The queue carries a pointer.** The message names the row
(`activityItemId`), never its text, and a `channel` when it is an email or a
connector surface rather than a push. The consumer sends those through
`sendActivityEmail` and `sendWorkstreamActivitySlack`, keyed on the row so a
retry is one message. The consumer reads the row back through
the same feed (`readActivityItemForPush`), so a row the person has read, or
lost access to, since it was queued sends nothing. A finish is matched by its
conversation rather than its id, whose `completed_at` later traffic can move.
It is worded as the sidebar words it: "Maya started Q3 plan", "Maya started a
breakout on Q3 plan" with the breakout as the body, "Rally finished Q3 plan".
Receipts and the collapse id key on `activity:<row id>`. An app built before
these `rally.kind` values opens no conversation on a tap.

Known gaps: a thread made Organization-wide after it started shows its start to
people who could not see it before, but is not pushed to them. A finish that
lands before a participant's viewer row is not pushed to them. A row more than a
page deep when a push is read back sends nothing.

## What each person chooses

Settings → Notifications → **Notify me about** holds, for each of the six
kinds, the channels it goes by: `push`, `email`, and any connector surface the
person can be reached on (`userDelivery`, such as Slack). How they are stored
and how a save merges them is [`member-preferences.md`](member-preferences.md).
They apply to every device; the device switch above them is still the
device's own on/off. An empty list means Activity and the daily digest only.

`notificationAllows` in `member-preferences.ts` is the one rule. The push
consumer checks it before any push, and before any email or Slack message it
sends for an Activity row, so a choice changed after a message was queued
still holds. The mention and add processor reads the same choice and sends
only those channels. The Activity sweep records a row as decided for a person
with a device whatever they chose, so choosing a kind again never sends an old
row late.

The row of buttons in Settings is `ChannelPicker`: a button per channel while
they all fit beside the row's words, one menu of checkboxes when they do not.
Each row measures itself, because the number of channels grows with the
person's connectors.

## Web Push for browser members

A member's browser tab registers a `webpush` device: `token` is the
subscription endpoint and `web_push_p256dh` / `web_push_auth` hold its keys
(migration 0117). The device binds to the cookie session's own session row, so
signing out of that browser stops delivery like any other device. The
subscription itself outlives sign-out, so the member shell registers it again
for each new session, and Settings reports "on" only after that registration
succeeds. The browser
gets the VAPID public key from `GET /push-devices/web-push`, subscribes through
`/sw.js` at the browser host's root, and registers with `PUT /push-devices/:id`;
one installation id per browser profile lives in `localStorage`. Settings →
Notifications shows "In this browser" with a toggle instead of the Mac's
section. Safari on iPhone and iPad offers Web Push only to a Home Screen app, so
an iOS Safari tab reports `home-screen` and the section explains how to add
Rally ([`browser-client.md`](browser-client.md)).

The consumer renders both payloads and sends each device the one for its
transport. `web-push-transport.ts` encrypts one `aes128gcm` record to the
subscription (RFC 8291; the test reproduces the RFC's worked example byte for
byte) and signs a VAPID token for the push service's origin (RFC 8292), with
WebCrypto only. TTL matches APNs at one day; the collapse id's first 32
characters become the `Topic`, so a retry replaces rather than stacks. A `404`
or `410` disables the device at once: unlike APNs, a dropped browser
subscription carries no timestamp and never comes back. Enqueueing requires a
live device whose own transport is available, so either transport can run
without the other configured. A `403` means the subscription was made under
another VAPID key (RFC 8292 §4.2), so it retires that device only; one member's
stale subscription cannot pause anyone else's. A `401` refuses the token the
deployment signed for every browser: like an APNs provider-token failure, the
message retries and operators get one Web Push notice, while APNs devices keep
receiving. Keys that are not a P-256 point retire the device without a request;
registration already checks their shape. A device with any other transport is
rejected rather than sent to APNs.

A subscription endpoint is a URL the Worker POSTs to, so only known push
services are accepted, each at its subscription path: `fcm.googleapis.com`
(`/fcm/send/…`, `/wp/…`), `updates.push.services.mozilla.com` (`/wpush/v1|v2/…`),
`web.push.apple.com` (one segment) and any `*.notify.windows.com` (`/w/`), over
HTTPS, with no userinfo and the default port. The path matters because the same
hosts serve credential-gated APIs whose `401` would otherwise read as a refused
VAPID key. The contract refuses any other endpoint at
registration, and the transport checks again before each send and retires a
stored row that fails. The request does not follow redirects; a `3xx` is a
rejection. Only a subscription URL on an allowlisted push service can report a
credential failure, so a member's chosen endpoint cannot pause a batch or
notify operations. No request
timeout is set; that number is the team's to choose.

The service worker shows the title and body. Its `tag` is the intent's collapse
id: a Web Notification with the same tag replaces the earlier one rather than
grouping with it, so a retry replaces itself and two mentions in one channel
both stay on screen. There is no browser counterpart to APNs `thread-id`
grouping. A click opens the link's path and query on the worker's own origin,
never another host, in the first of:

1. A tab already on that page, focused.
2. A tab in the notification's Organization, sent the link. The page routes it
   by hash (`inPlaceHash`) while its shell is up, and loads it otherwise or
   when the link names another Organization.
3. Any `/app/` tab, navigated to the link; the load switches it to the link's
   Organization.
4. A new tab.

One VAPID key pair is shared by every region. The browser host is one origin
with one subscription per browser profile, and a subscription is bound to the
key it was made with, so per-region keys would make one region's sends fail.
When the configured key differs from the subscription's, the browser
unsubscribes and subscribes again before registering.

Known gaps: a browser registers only with the active workspace's region, so a
member with workspaces in both regions gets browser pushes only from that one.
Signing in over an existing cookie leaves the earlier session unrevoked, so a
device bound to it keeps receiving until that session ends; this predates Web
Push.

## Operations and release

Set `APNS_AUTH_KEY` and `APNS_KEY_ID` separately on both regional API Workers.
For browsers, set `WEB_PUSH_VAPID_PUBLIC_KEY` (base64url uncompressed P-256
point), the secret `WEB_PUSH_VAPID_PRIVATE_KEY` (base64url `d` of the same key)
and `WEB_PUSH_SUBJECT` (`mailto:` or `https:` contact) on each regional API
Worker, with the same key pair in every region. Without them, browsers are told
notifications are unavailable and APNs is unaffected; the health check does not
cover these variables. Without the APNs variables, health reports push as not
configured and existing email delivery continues. Local/test transports do not contact Apple. APNs requires the device address in
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
- A device is sent only its own transport's payload, and enqueue requires a live device whose own transport is available.
- A provider credential fault pauses only its own transport.
- A Web Push `404` or `410` disables the browser device at once.
- The Worker contacts only allowlisted Web Push service hosts and follows no redirect.
- `sw.js` opens links only on its own origin.
- An Activity row is pushed only if the feed lists it, unread, to that person when queued and again when sent.
- Each Activity row is handed to delivery for a person at most once (`workspace_activity_pushes`).

## Testing

`push-device-service.test.ts` uses real migrated SQLite. `push-payload.test.ts` and
`apns-transport.test.ts` cover encoding/signing, Apple responses, and the
sandbox versus production host. The real
workerd `push-delivery.test.ts` covers read RPC, receipts, revocation, retry,
and that `aps.badge` is the reader's attention count. `workspace-attention.test.ts`
covers that count, Breakouts included, against the same directory projection,
and `dock-badge.test.tsx` covers when the Mac sends its local count. Desktop push/link tests cover registration and routing; existing settings and
release suites cover the integration. iOS XCTest covers payload parse and the
PUT body. For Web Push, `web-push-transport.test.ts` reproduces RFC 8291's
worked example, checks the VAPID token and maps push service answers, redirects
and hosts outside the allowlist. The workerd suite covers routing each device to
its own transport, disabling a dropped browser subscription at once, and an
APNs credential fault that leaves Web Push sending. The contract test covers the
host allowlist and key shapes, and `web-push.test.ts` covers registration,
re-subscribing on a key change, and the permission prompt coming first.
`activity-push.test.ts` drives Activity rows through `receiveChildEffects` on
real workerd, and the consumer's read-back. The provider itself and macOS/iOS alert
presentation require a signed installed build.

Local acceptance on 2026-09-14: lint/typecheck, scoped API and desktop tests,
27 workerd delivery/notification tests, 38 site tests, 461 repository script tests
and 141 release tests passed. The native bridge compiled on arm64 macOS and the
Notifications pane was inspected in a real Electron window. Negative controls
caught broken session binding, reassignment/deletion, receipt skipping, access
checks, APNs disable handling and premature payload clearing. No deployment or
signed-Mac APNs/universal-link acceptance is claimed.

## Changelog

### 2026-10-19 — A Channel merge reaches the Channel, and opens it

**What changed:** A thread's merge into a Channel is pushed, emailed or sent to
Slack to everyone who reads the Channel (`ActivityPushSubject.channelId`):
every member for an Organization-wide Channel, its participants and the
thread's readers for a private one. Push, email and Slack link to the Channel
(`spaceCanonicalUrl`), not the thread. A reader who cannot open the thread is
told "Maya merged a private thread into GTM", and the macOS menu bar names the
Channel and opens it.

**Why:** The product owner's call: a private thread may now merge into its
Channel, and the Channel feed shows the merge to all its readers, so the
notification had to reach the same people. Their audience used to be the
thread's, which for a private thread left out everyone it was meant for. A
merge opens where it landed, as the Activity row already did; the push opened
the thread, which such a reader cannot.

**Considered and rejected:** Keeping the thread's audience and adding the
missing readers by hand: the Channel's scope and its participants already
answer who reads it.

**Consequences:** An Organization-wide thread's merge into a private Channel
now notifies the Channel's people rather than the whole Organization.

### 2026-10-16 — Merges push

**What changed:** A `merged` Activity row pushes, and goes by email or Slack,
under its own Settings row, **Merges** (`merges`, push by default). A breakout's
merge is pushed when its message's event reaches WorkspaceDO; a thread's merge
into a Channel when `mergeThreadIntoChannel` writes it. Both name the exact row
(`ActivityPushSubject.kind: "merge"`, `itemId`), and its audience is the
thread's, as a start's is. It reads "Maya merged Sequence B into Q3 plan" or
"Maya merged Q3 plan into GTM" and opens the thread.

**Why:** The product owner asked for merges to reach people as starts and
finishes do.

**Considered and rejected:** Matching a merge by its conversation, as a start
is: a breakout's merge row names the breakout though it is about the thread,
so it would never match. And folding merges into an existing preference: none
of the five describes them, and a new kind costs one row.

**Consequences:** `merges` has no legacy push switch, so an older client never
shows or saves it, and it reads from its default until set. A Channel merge's
row id carries its `posted_at`, so a replaced merge pushes again. iOS taps
route `merged`; an older iPhone build opens nothing for it.

### 2026-10-16 — A browser notification click routes in place in its own Organization

**What changed:** The service worker carries the notification's Organization
and, on a click, prefers a tab already in it, posting the link for the page to
route by hash. A tab in another Organization still loads the link, which
switches it.

**Why:** With a tab per Organization, a click took the first Rally tab and
loaded the link there, switching that tab away from its Organization even
though another tab was already in the right one, and every click reloaded the
whole app even when no switch was needed.

**What to respect:** The page decides, not the worker: it compares the link
with its own path and loads the link when they differ, so a wrong guess by the
worker costs a reload, never a Channel opened in the wrong Organization. The
listener is installed by the page's first script, not by the shell, so a tab
still restoring or signed out loads the link rather than dropping it.

### 2026-10-15 — Each kind goes by push, email or a connector, as the person chose

**What changed:** The push switches became a channel list per kind. Mentions
and adds send exactly the chosen channels; the email fallback is gone. New
threads, breakouts and finished runs can now go by email or Slack too, queued
on the push queue with a `channel` and read back through the feed like a push.
The two narrower switches (Channels not joined, threads not started) no longer
change what is sent.

**Why:** People wanted to choose how each kind reaches them, not only whether
it is pushed, and to choose email or Slack for kinds that never had them.

**Considered and rejected:** Keeping email as a fallback when nothing else
accepted: it sent email to people who had chosen not to get it, and the
choice in Settings could not say so. A separate queue for email and Slack:
the push queue already carries a pointer the consumer reads back through the
feed, which is what the other channels need too.

Because no other channel stands in any more, a Slack send that fails in a way a
retry can clear (a network fault, a 5xx, a rate limit) now throws back to its
queue instead of settling as skipped; the stable `client_msg_id` keeps a retry
from posting a chunk twice.

**Consequences:** A person with no device and no Slack now gets a mention only
in Activity and the digest unless they choose email. A new channel is a
connector declaring `userDelivery` plus a sender for Activity rows; the
picker shows it with no change.

### 2026-10-14 — People choose which kinds are pushed

**What changed:** The consumer checks the person's push switches
([`member-preferences.md`](member-preferences.md)) before sending any push.

**Why:** Pushing every Activity row is loud in a busy Organization: every
Organization-wide start, and a finish on every Rally reply.

**Considered and rejected:** Checking in the sweep as well: it saved a queue
message, but a row it filtered out was never recorded, so turning the switch
back on could push it late. Turning a skipped push into an email: the person
asked not to be told this way, not to be told another way.

**Consequences:** A new pushed kind needs a case in `pushPreferenceAllows`,
which is exhaustive over `rally.kind`, so the compiler asks for it.

### 2026-10-14 — Every Activity row is a push

**What changed:** A thread or breakout somebody else started and a run Rally
finished now push, as mentions and adds already did. The Organization object
decides them after the directory batch that made them commits, from the
Activity feed itself, and records each so it goes once. The push queue message
names either a notification intent or an Activity row, and the consumer reads
the row back through the feed when it sends. iOS and the Mac accept the new
`rally.kind` values.

**Why:** Activity is the list of what happened to a person, and only two of its
five kinds reached their devices, so a finished run or a new thread waited for
the person to open the app.

**Considered and rejected:** New notification-intent kinds: the intent table's
CHECK admits two kinds and needs a rebuild to widen, and its lease, directory
version gate and Slack/email fallback answer questions these rows do not have.
A per-person sweep of the whole first page on every directory change: it would
push an old unread backlog the first time someone got a device, and read every
member's feed on every message.

**Consequences:** A new Activity kind that the feed reads from the directory
needs adding to `PUSHED_KINDS`, to `rally.kind`, and to iOS's `pushKinds`, or it
will not push or not open on a tap. An Organization-wide start reads one feed
page per member with a device, in the object, after the commit; a finish reads
one per participant. A change to the feed's ids (`started:`, `finished:`)
changes what `workspace_activity_pushes` dedupes on and how a finish is matched
when sent.

### 2026-10-06 — Badge is the sidebar attention count, set by APNs and the Mac

**What changed:** `aps.badge` is now `readerAttentionCount`: Mains and Breakouts that
are unread, unseen or mention the reader, the attention menu's number. It
replaces `unreadAndNeedsInputCount`, which counted Channels only and included
read `needs_input` runs. The Mac app also sets the dock badge itself from the
menu's count while it runs. macOS authorization now asks for badges, the
permission read reports the badge switch, and Settings sends the user to
Rally's entry in System Settings when notifications or badges are off.

**Why:** The badge should match the count in the sidebar. The old number
counted different things (no Breakouts, plus needs-input runs), so the two
disagreed. APNs alone only moves the badge when an alert arrives, so reading a
conversation never lowered it; the app setting it locally fixes that, and APNs
still covers the time Rally is not running. Rally had never asked for badge
permission (only alerts and sound), so the badge could be off with no way for
the user to tell; existing installs keep that answer, since macOS does not ask
again, which is why the badge switch is read and surfaced rather than assumed.

**Considered and rejected:** A silent badge-only push on every read: a new
producer for each read, when the running app already holds the number. Summing
every Organization: the menu is per Organization, and iOS holds one session.

**Consequences:** The server count and `attentionItems` on the client must
change together; `waitingForReaderSql` is the server's copy of
`readerMarkerStatus`. The count takes the reader's access class, so a guest's
badge leaves out Organization-wide conversations their sidebar does not list.
The Mac waits for every Breakout list the count needs before writing, since a
missing list would lower the APNs badge.

Shipped in #1121.

### 2026-10-03 — Web Push for browser members

**What changed:** A browser tab can subscribe to Web Push. Devices gain a
`webpush` transport with the subscription's keys, the consumer sends each device
its own transport's payload, and the browser host serves a root service worker.
Endpoints are limited to known push service hosts, and a provider credential
fault now pauses only its own transport.

**Why:** Members who use Rally in a browser need the same mentions and additions
the Mac shows ([PRD](PRDs/2026-10-03_full-browser-client/prd.md) goal 8).

**Considered and rejected:** A Web Push library, which would bring Node crypto
into the Worker for two primitives WebCrypto already has. Suppressing pushes
to one client while another is in the foreground; the PRD leaves duplicates
across devices as an open question. Accepting any HTTPS endpoint, which let any
member make the Worker POST anywhere. Keeping one batch-wide stop on a provider
fault, which let an APNs key problem stall every browser. Reading a `403` as a
deployment fault, which let one stale subscription pause every browser and page
operators. Per-region VAPID keys,
which one browser origin with one subscription cannot hold.

**Consequences:** A member with the Mac app and a browser gets each push on
both. One VAPID key pair serves every region; rotating it retires each subscription at
its next push (`403`), and the browser re-subscribes under the new key on its
next visit. A new browser push
service, or a new subscription path on a known one, needs adding to the
allowlist before its users can subscribe; until then the browser reports
notifications as unsupported.

Shipped in #1081. Design: [Full browser client PRD](PRDs/2026-10-03_full-browser-client/prd.md).

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
