# Push notifications

Rally pushes to signed-in Macs through APNs, and to signed-in browser tabs
through Web Push, whatever lands on the workspace notification intent: a
mention or an add, a Sidekick run that needs input or finished
([below](#a-sidekick-run-that-needs-input-or-finished)), and a person's reply
([below](#a-persons-reply)). A mention or add in a
Canvas's Chat or a Sidekick's conversation is recorded by its parent
([A mention or an add](hosted-conversation-parents.md#a-mention-or-an-add)),
and a run notice by the Sidekick. Each device registers with one transport and
is sent only that transport's payload. Push is enabled for everyone from launch through
`push-notifications-enabled`. Every kind also goes by email when the person
chose that for it ([Sinks](#sinks),
[What each person chooses](#what-each-person-chooses)); nothing falls back
from one channel to another.

## Where the code lives

- `apps/api/src/services/push-device-service.ts`: regional D1 device/session registry.
- `apps/api/src/services/push/`: provider authentication and payload rendering; `apns-transport.ts` for Apple, `web-push-transport.ts` for browsers.
- `apps/api/src/services/notification-notice.ts`: `renderNotice`, the one rendering of every kind into a channel-neutral `Notice`, with the access check.
- `apps/api/src/queues/push-delivery-consumer.ts`: the queue consumer: render the notice, check the choice for its channel, hand it to the push sink (send by transport, receipt) or the email sink; a retired Activity row message is acknowledged.
- `apps/api/src/services/notice-email.ts`: the email sink, one template for every kind, sent through `sendEmail`.
- `apps/api/src/services/push-delivery-service.ts`: `enqueueNotice`, which queues one message per sink a producer's recipient chose.
- `packages/contracts/src/push-notifications.ts`: the registration contract and the Web Push service host allowlist (`isWebPushServiceUrl`).
- `apps/desktop/src/renderer/lib/web-push.ts` and `apps/browser/public/sw.js`: browser subscription and the service worker that shows the notification.
- `apps/desktop/src/main/push-notifications.ts` and `apps/desktop/native/push-notifications/`: Mac registration and native response/permission callbacks.

## How it works

Every stored workspace credential registers the installation with its own region.
The Mac loops every credential it holds, a guest's included, and the browser
registers a guest's tab as it does a member's. A registration belongs to the account in that deployment, not to one
workspace, so a guest workspace's notifications still reach a device that a
membership in the same deployment registered. Delivery requires a live session bound to that device; another installation's
session cannot keep it alive. The device switch and a separate push installation
ID persist in the existing application settings file on the Mac.

A mention or an add in a Canvas's Chat or a Sidekick's conversation becomes
an intent where the conversation's effect lands: the hosted parent records it
beside the effect's receipt and the activity consumer processes it at once
([A mention or an add](hosted-conversation-parents.md#a-mention-or-an-add)).
Processing reads whether the recipient is still an active member (D1), may
still open the parent and is not the author, then sends each channel the
person chose.

The producer enqueues only region, workspace, recipient and intent identifiers.
Settlement retains the payload only when push was enqueued, until the existing
intent retention expires. The consumer reads content through `WorkspaceDO.readNotificationIntentForDelivery`
and reuses the processor's `notificationDeliveryContext`, which asks
`WorkspaceDO.notificationDirectoryState` whether the recipient may still open
the conversation: the Canvas's row and who it admits, or the Sidekick's row and
who it is shared with. An intent written from a newer parent generation than
the object holds retries; one for any other parent (a retired Thread) is
skipped as `notification_parent_missing`; revoked access stops delivery. No presence check is
added. Successful enqueue with a live device is not proof of an Apple alert.

Success receipts key on workspace, intent and device. A partial retry skips only
those devices already reached for that intent. Sending precedes recording, so an
uncertain send can alert twice. Reply collapse identifiers are hashes of workspace and conversation (thread plus
breakout). Other kinds retain per-intent collapse ids, so an ordinary reply never
replaces an explicit mention or addition. APNs groups them through thread-id.
Delivery receipts remain keyed by intent. No exactly-once claim is made.

Receipts currently live until their device is deleted. After the existing intent
retention expires they are inert: no later intent reuses the key. This accepts
one small row per successful intent/device at the current product size, rather
than adding a cross-store retention job for launch. Future pruning should join
existing intent retention, not introduce another scheduler.

Payload bodies remove the generated personal-system-prompt envelope, then
reduce Markdown formatting and Rally's internal citation and person-mention
references to readable plain text before carrying the first
1,000 Unicode code points with an ellipsis when shortened, fitted further to
Apple's 4,096-byte ceiling. Every alert also sets APNs `badge` (and the Web
Push payload's `badge`, and `rally.badge` in the data) to the `attention`
read's `readerAttentionCount`: the person's unseen Activity in that
Organization, read when the message is sent, so the notice's own row, recorded
before it was queued, is in it ([`activity.md`](activity.md)). An alert that
arrives while Rally is closed therefore sets the icon to what the Activity rail
will show, rather than clearing it. A send from one workspace does not sum
other workspaces: a global inbox is out of scope.
Omitting `badge` would leave the previous icon count in place; `0` clears it.

While Rally runs, the Mac sets the dock badge itself. `useDockBadge` sends the
live unseen Activity count (`dockBadgeCount`, the Activity rail badge's
`unseenCount`, the same count a push's badge carries) to main
(`dock-badge:set`, `app.setBadgeCount`) on every change, once the Activity
list has arrived, and clears it when the shell unmounts. So the badge follows
the push payload's count while Rally is closed and the live count while it
is open, and opening Rally keeps the number an alert left. Main re-applies the last count
when a Rally window gains focus, since a background alert from another
Organization sets that Organization's count. Foreground alerts leave `.badge`
out of their presentation options, so they never replace it.

An installed browser app (a Chrome or Edge app window, or a Home Screen app on
iPhone and iPad) shows the same number through the Badging API. The Web Push
payload carries it as `badge`, and `sw.js` sets it with `navigator.setAppBadge`
(`clearAppBadge` at `0`) when the push arrives, unless a Rally tab is visible:
the visible tab owns the icon with its live count, the push may be for another
Organization, and a Mac foreground alert leaves the dock badge alone too. A
hidden tab (a backgrounded Home Screen app) takes the push's count until it is
shown again. While a tab runs, the browser bridge's
`setDockBadgeCount` takes the count from `useDockBadge` the same way. The icon
is one for every tab, so only the tab focused last writes it: focusing a tab
(or bringing it back to visible) records it under `rally.app-badge-owner` in
`localStorage` and puts its count back, as main does on the Mac. A tab still focused last keeps the icon current
from the background. A plain tab has no icon, and browsers ignore the call
there; Safari also requires notification permission.

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
Clicks pass the HTTPS link through the Canvas and Sidekick link reader
(`httpsLinkDeepLink`) and scheme navigation, including pending navigation before sign-in or window readiness.
Main-window creation waits for renderer protocol and IPC installation, including
when a native notification response arrives during asynchronous app startup.

## What is pushed

Each of the intents below also writes its recipient's Activity row in the same
transaction ([`activity.md`](activity.md)), so the feed lists what was pushed.

Push delivery reads notification intents only. A Queue message for a retired
Activity row is logged `activity_item_retired` and acknowledged (its id logged
as `activity_item_id`). The events are a mention or add (the intent above,
recorded by the Canvas or Sidekick whose conversation carried it), a
Sidekick run's two notices, and the notices a hosted parent records about
itself, below.

### A Sidekick run that needs input or finished

A run reaching `needs_input`, or finishing (`completed`, `failed` or
`stopped`), is a notice on the same intent row a mention uses, with
`notification_kind` `needs_input` or `run_finished` (WorkspaceDO migration 138
widened the CHECK; `NOTIFICATION_INTENTS_RUN_KINDS_MIGRATION`). Who hears it is
decided, per the [Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md):

- **Needs input** goes to the run's requester when a person's request started
  the run (a `manual` trigger's `requestedByUserId`: a message in the
  Sidekick's conversation or Run now), plus whoever manages the Sidekick (its
  author, the person it runs as, and for an Organization-wide Sidekick the
  Organization's owners and administrators).
- **A finished run** goes only to its requester. A scheduled, event or email
  run has none; its row in the shared conversation and its unread are the
  signal.

`HostedSidekick.onChildCommonProjection` sees the transition in the
projection's own transaction (the state it moves from is read there) and arms
one `sidekick_run_notice` alarm entry carrying the notice
(`SidekickRunNotificationSchema` in `packages/contracts/src/push-notifications.ts`:
the Sidekick's name, the run, its state and reply then). A run admitted
straight into `needs_input` for want of a delegate arms the same entry. The
entry resolves recipients, drops anyone no longer active, records one intent
per recipient with `recordSidekickRunNotices` (already `delivered`: push is
the only channel, so there is no lease), and enqueues each with
`enqueuePushDelivery`. A retried entry records nothing twice (the source and
kind are unique per recipient) and re-enqueues, which the per-device receipts
make harmless.

The push consumer reads the notice back, checks the recipient is an active
member the Sidekick still admits (`notificationDirectoryState`), consults
`notificationAllows` for the kind, and links to the Sidekick
(`conversationLink`). The title is "<Sidekick> needs your input" or
"<Sidekick> finished / failed / stopped"; the body is the run's reply as plain
text. For Needs input that reply is the question the run is waiting on: a
run's conversation sends a pending elicitation's prompt as its reply
([automation-lifecycle.md](automation-lifecycle.md#runs-in-the-shared-conversation)),
so the push body and the Activity row's preview, which is the body's text,
carry the question. One notice feeds both, so they cannot disagree, and the
question is what the recipient needs to decide whether to answer now; before
this the body was the run's last text turn, usually empty, because the asking
is not a text turn. A run admitted with no delegate carries the delegation
notice instead. Both kinds read the person's **Sidekick runs** choice (`runFinished`),
so one row in Settings covers both.

**Where a push links.** Every notice, whichever sink takes it, links through
`conversationLink` once, in `renderNotice`: a mention or a reply in a
Canvas's Chat opens the Canvas at that message — the canonical link with
`?turn=<turn>&sequence=<n>` ([`links.md`](links.md)), and the push data's
`turnId` and `sequence` beside it — from the mention effect's
`transcriptSequence` and the reply notice's `messageSequence`. A notice
recorded before it carried the sequence, or a turn id that is not a UUID,
opens the Canvas without a position. Needs input and a Sidekick's
conversation or finished run open the Sidekick (its link has no message
form), and a pinned Canvas's new version opens the Canvas onto that artifact.
A conversation with neither — a retired Thread or Breakout — has no link, and
the notice is skipped as `conversation_not_linkable:<parent kind>` rather
than sent to open nothing. An older Mac refuses a link with a message query
and opens the app without navigating.

### A person's reply

A person's message in a Canvas's Chat or a Sidekick's shared conversation
(`"0"`) tells every active participant of that conversation who neither wrote
it nor is mentioned in it (a mention already tells them) nor was seated by it
(being added already tells them): `new_message`, the **New messages** choice
(`newMessages`). Rally's own replies tell nobody; the conversation's unread is
the signal, as it was for the Thread-era reply batch. A run's own
conversation tells nobody either.

The conversation object names the recipients, because only it knows who is
seated: where it emits a message's mention effects it emits one
`new_message_notification` per message, carrying the message, its attention
ordinal and transcript sequence, and the recipients' ids. One effect per
message rather than one per recipient keeps the Queue payload to the
message's text once plus a list of ids; per-recipient effects would carry the
text, up to 8,000 characters, once per person. The effect is bound by the
Queue's per-message limit (`EFFECT_QUEUE_MESSAGE_MAX_BYTES`, 120,000 bytes):
a conversation with more than roughly 2,700 people to tell (fewer with a long
message) makes an effect over it, which the outbox logs
`conversation_effect_oversized` (`outcome: dropped`) and drops, so that
reply tells nobody.

The hosted parent adds the effect, in the transaction that receipts it, to its
conversation's open `reply_batch` alarm entry
(`conversation-reply-batch.ts`), or opens one due `REPLY_BATCH_SECONDS` (15)
out. The entry holds, per recipient, the newest reply they are owed (by
transcript sequence, since the Queue does not order effects); a reply drops
its own author from what the batch owes them. The key carries its due time,
so a reply after a batch has come due opens a new one rather than joining a
batch being sent. When the entry runs, each recipient gets one `new_message`
intent and one Activity row for their reply (`recordParentNotice`), recorded
`delivered` and enqueued, unless the person was told about this conversation
within `CONVERSATION_ALERT_COOLDOWN_MS` (two minutes) — read from their last
`new_message` intent's `delivered_at` — in which case the intent is recorded
`skipped` (`conversation_alert_cooldown`) and only the Activity row moves.
Both numbers are the team's from the Thread-era batch
(`workspace-activity-push.ts`, which
`git log --diff-filter=D -1 -- apps/api/src/durable-objects/workspace-activity-push.ts`
finds,
and the 2026-10-20 entry below), carried rather than set again.

The push reads the notice back (`ParentNoticeSchema`), checks the recipient
as a run notice's is (an active member the parent still admits), consults
`notificationAllows`, and says "<author> in <Canvas or Sidekick>" with the
message as plain text. Its collapse id is the conversation's, so a newer
reply replaces the alert before it.

### A pinned Canvas's new version

A new version of one of a Canvas's artifacts tells everyone who pinned the
Canvas (`workspace_pins`, kind `canvas`) except whoever made it or had it made
(the version's `author_user_id` and `on_behalf_of_user_id`): `artifact_updated`,
the **Pinned Canvas updates** choice (`artifactUpdates`). Which versions are
news is the rule the Canvas row's own artifact unread takes
(`artifactNewsSql`): version 2 on, a republish or a replacement, so a new
artifact's first version tells nobody. The publish's note to its Canvas
(`HostedCanvas.noteArtifact`) reads the resource's newest version and records
one intent and Activity row per pinner (`tellCanvasPinners`,
`canvas-artifact-notices.ts`), then enqueues each push; a publish noted twice
records nothing twice. The push says "<author> updated <artifact> in
<Canvas>" — the author a member's name, a connection's display name, or
whoever the publish says edited the Canvas (Rally for its Chat, the Sidekick
for a run) — and opens the Canvas onto the artifact (`/cv/<id>/a/<id>/`). Its
collapse id is the Canvas's, so a newer version replaces the alert before it.

### A request to open a Canvas, and its grant

A member who asks to open a Canvas they cannot gives each of its deciders an
`access_request` intent, the **Access requests** choice (`accessRequests`):
"<requester> asked to open <Canvas>", the request's message as the body,
linking to the Canvas, where the Share panel lists it. An approval gives the
requester an `access_granted` intent, read through **Being added** (`added`),
since being let in is being added: "<decider> let you into <Canvas>". A
denial gives the requester an `access_denied` intent under their **Access
requests** choice: "<decider> declined your request to open a Canvas", with
no title (they were refused it), linking to the Canvas, and sent although
they cannot list it. All three are recorded with their Activity rows by
[`canvas-access-requests.md`](canvas-access-requests.md)'s settlement.

### A request for a Sidekick source, and its answer

A manager who asks a person to let events from one of their connections start
a Sidekick ([`sidekick-sources.md`](sidekick-sources.md)) gives that person a
`source_request` intent: "<requester> asked to use your <connector> for
<Sidekick>". When the person approves or declines, whoever asked gets a
`source_approved` or `source_declined` intent: "<person> approved <Sidekick>'s
use of their <connector>", or "declined". The body of all three is what was
asked: "Events: Email received. Only when: it is about a pre-seed round", the
events by their manifest labels and the condition when there is one
(`sourceNoticeText`). The connector is named as the person calls the product
(`sourceConnectorName`: Gmail for Google's mail events). A request cancelled
by a newer ask sends nothing, and neither does a person answering their own
ask.

`HostedSidekick.requestSources` and `decideSourceRequest` prepare each notice
before their transaction (a notice is hashed, which yields), record the intent
and its Activity row inside it (`recordSourceRequestAsked`,
`recordSourceRequestSettled`, through `recordParentNotice`), and enqueue after
the commit (`enqueueSourceNotices`). All three are sent although the
recipient may not be able to list the Sidekick (`recipientRefused`'s
`unlisted`): the person asked usually cannot open it, and the request names it
to them on purpose. All three read the **Access requests** choice
(`accessRequests`): a request the person decides, and the answer to a request
they made. That choice defaults to push alone, so the email below is sent only
to a person who chose email for Access requests.

A `source_request` notice also carries **actions** (`Notice.actions`): an
Approve and a Decline link, each signed for that request, that person and that
decision (`sourceDecisionActions`,
[`sidekick-sources.md`](sidekick-sources.md)). The email sink draws them as
its two buttons; push ignores them and opens the Sidekick's link, the only
link form a Sidekick's notice has. The person asked usually cannot open that
Sidekick, so tapping their push lands on a Sidekick that could not be opened,
and the Activity row is where they answer; a link form that opens Activity
does not exist yet ([`links.md`](links.md)). When
`BROWSER_APP_ORIGIN` is not configured there is nowhere for the links to open,
so the notice goes without them and `source_decision_link_unavailable` is
logged with the reason.

## Sinks

Every notification is rendered once into a **notice** (`Notice`, by
`renderNotice`): its kind, title, plain-text body, who acted, the canonical
link it opens, the Organization, and for a mention or an add the
conversation's reply-to address. The rendering is where each kind's words
live and where the recipient is checked (still a member, still able to open
what it is about, the link still exists); nothing downstream knows kinds.

A **sink** takes a notice and adds only its transport's form. There are two:

- **Push** (`sendPushNotice`): the APNs and Web Push payloads, the badge, the
  collapse id, one send per live device with a receipt.
- **Email** (`sendNoticeEmail`): one template for all kinds. Its subject is
  the notice's title, so each kind has its own subject line ("Avery mentioned
  you in Launch plan", "Deploy watcher needs your input", "Ada declined your
  request to open a Canvas"); its body greets the person, quotes the notice's
  text (cut at 320 characters, the mention email's number), has one Open in
  Rally button to the link, and names the Settings row that sent it. A notice
  with `actions` (a Sidekick source request) has a button for each action in
  that button's place, the first filled and the rest outlined, and a line
  saying that opening one records the answer. It goes
  through `sendEmail` and the native Cloudflare `EMAIL` binding (production
  only). `rally-notice/<organization>/<intent>` is its correlation reference;
  Cloudflare does not deduplicate it. D1 `email_delivery_receipts` records a
  completed send so a later queue delivery skips the provider. Internal and
  unknown failures retry; explicit permanent refusals are acknowledged. Retries
  across the provider-acceptance and local-settlement gap, or concurrent queue
  deliveries before settlement, can still send a duplicate.

A producer that records an intent calls `enqueueNotice` with the channels its
recipient chose for the kind (`chosenChannels`, read from the object's own
`member_preferences` row): one queue message per sink, `channel` absent for
push and `email` for email, each pointing at the intent. The mention and add
processor does the same after its claim, keeping the intent's payload for
the sinks to read. The consumer renders the message's intent and checks
`notificationAllows` for its kind and channel again before handing it on, so
a choice changed after queueing still holds. A new sink is a channel in
`NotificationChannelSchema`, a function that takes a `Notice`, and one branch
in the consumer.

Slack is not a sink. The Slack DM sender for mentions and adds was deleted;
a stored `slack_agent_dm` choice reads as no choice.

## What each person chooses

Settings → Notifications → **Notify me about** holds, for each kind it offers
— exactly the kinds a producer records: Mentions, New messages, Being added,
Sidekick runs, Pinned Canvas updates, Access requests, Source requests (a
Sidekick source request and its answer, the one kind that defaults to email
as well as push)
(`OFFERED_NOTIFICATION_KINDS`) — the channels it goes by: `push` and `email`,
each a [sink](#sinks). A Thread-era kind a person stored (`newThreads`,
`newBreakouts`, `merges`) is dropped as the record is read. How
they are stored and how a save merges them is
[`member-preferences.md`](member-preferences.md). They apply to every device;
the device switch above them is still the device's own on/off. An empty list
means that kind is not sent at all.

`notificationAllows` in `member-preferences.ts` is the one rule. The push
consumer checks it before any push, so a choice changed after a message was
queued still holds, and for email the same way. Producers read the same choice
to queue only the sinks chosen.

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
Rally ([`browser-client.md`](browser-client.md)). Why the toggle is off
(unsupported, Home Screen, not available yet, blocked for the site) is a row
inside its card, as the Mac's reason is, not a line below it.

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
never another host. Nothing in the click path reads the push's `kind`: the
link alone decides where it lands, so every kind routes the same way, the
macOS click (`httpsLinkDeepLink`) included. A Canvas link (`/cv/<id>/`) opens
the Canvas, which is where a reply, an access request (its Share panel lists
the request) and a grant land; a pinned Canvas's new version links with
`/a/<id>/` and opens the Canvas onto that artifact (`?artifact=` in the
hash route, on either host). A mention's or a reply's push links with the
message's position, `/cv/<id>/?turn=<turn>&sequence=<n>`, and opens the Chat
scrolled to that message: the browser's `shellLocation` and `inPlaceHash`
read the query with `parseLinkTarget` and route `#/canvases/<id>?turn=&sequence=`
(a query that is not a message still opens the Canvas), and on the Mac
`httpsLinkDeepLink` carries it onto the deep link, whose intent the app
session routes through `canvasLinkRoute` to `canvasTurnRoute`, the route a
search result for a message opens.
The tab is the first of:

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

An email sink without its Cloudflare `EMAIL` binding or sender answers
`notification_email_unavailable` (retryable), so its queue messages retry
until the dead-letter queue takes them: a non-empty dead-letter queue is the
signal, as for every queue here. Outside production the sink sends nothing
and logs `notification_email_skipped` with `transport_disabled_for_environment`.

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
- A notice is sent only to a recipient the parent still admits when it is sent (`notificationDirectoryState`): a Canvas narrowed, a Sidekick unshared or a member removed since the intent was recorded sends nothing. A declined Canvas request and the three Sidekick source kinds are the exceptions: each is about something its recipient need not be able to open, and each still requires an active member and a parent that exists.
- A link that acts when opened (`Notice.actions`) is signed for one recipient and one decision and rides only in the email sink: a push payload never carries one.
- A Sidekick run notice is recorded once per recipient and kind; a retried alarm entry re-enqueues, which the per-device receipts make harmless.

## Testing

`push-device-service.test.ts` uses real migrated SQLite. `push-payload.test.ts` and
`apns-transport.test.ts` cover encoding/signing, Apple responses, and the
sandbox versus production host. The real
workerd `push-delivery.test.ts` covers read RPC, receipts, revocation (a Canvas
made private, a Canvas deleted, a removed member), a newer parent generation, retry,
and that `aps.badge` and the Web Push `badge` are the reader's attention count.
`dock-badge.test.tsx` covers when the Mac sends its local count, and
`platform.test.ts` covers the browser bridge setting and restoring the app
icon badge, and leaving it to the tab focused last. Desktop push/link tests cover registration and routing; existing settings and
release suites cover the integration. For Web Push, `web-push-transport.test.ts` reproduces RFC 8291's
worked example, checks the VAPID token and maps push service answers, redirects
and hosts outside the allowlist. The workerd suite covers routing each device to
its own transport, disabling a dropped browser subscription at once, and an
APNs credential fault that leaves Web Push sending. The contract test covers the
host allowlist and key shapes, and `web-push.test.ts` covers registration,
re-subscribing on a key change, and the permission prompt coming first.
The workerd `push-delivery.test.ts` also covers that an owner or administrator mentioned in a Canvas only its
creator otherwise opens is told, and pushes both Sidekick run notices with
their titles and the Sidekick's link, sending neither once **Sidekick runs** is
off; `hosted-sidekick.test.ts` covers who each notice is recorded for
(requester and managers for Needs input, the requester alone for a finish,
managers alone for a scheduled run's Needs input and nobody for its finish),
and `test/workspace-notification-intent-kinds-migration.test.ts` migration
138 over populated rows. `hosted-mention-notifications.test.ts` starts from the message: a mention
posted in a Canvas's Chat and in an Organization-wide Sidekick's conversation
reaches the parent, records one `mention` intent for the recipient, enqueues
one push and sends its literal alert, and a redelivery of every effect sends
nothing again. `hosted-reply-notifications.test.ts` starts from a reply: two replies in one
batch make one `new_message` intent and one Activity row carrying the newest,
whose push says "Avery in Launch plan"; a person the replies mention and their
author get nothing; a reply within the cooldown is recorded `skipped` and moves
the row, and one after it pushes again; a reply after the row was read is a
new row; and Rally's reply makes no batch at all.
`canvas-artifact-notices.test.ts` covers a pinned Canvas's new version: its
author's own pin gets nothing, the other pinner one intent and a row naming
the artifact, the push "Avery updated Launch report in Launch" opening onto
the artifact, Rally's next version moving that row, a read of the Chat
clearing it, and the version after that a new row.
`canvas-access-requests.test.ts` covers a request's push to its decider, an
approval's push to the requester and a denial's.
`sidekick-source-notices.test.ts` covers a source request's push to the person
asked ("Avery asked to use your Gmail for Deals") though they cannot open the
Sidekick, the answer's push to whoever asked, nothing sent for a replaced
request or a person's own ask, the email queued after the commit for a person
who chose email, its two signed links and its literal text, and the Approve
link recording the answer once.
`notice-email-sink.test.ts` covers the sinks on real workerd: with email chosen
for every offered kind, the email sink is handed one notice per kind (mention,
add, reply, pinned version, request, grant, denial, run finished, needs input)
with its title, body, actor and link; a kind left on push sends no email and a
stored `slack_agent_dm` reads as no choice; and the real sink sends one Cloudflare
request whose subject is the title and whose idempotency key is the intent,
with the template's literal text.
`test/workspace-notification-intent-kinds-migration.test.ts` covers migration
138 over populated rows. `test/conversation-effect-service.test.ts` covers the
mention processor queueing one message per chosen sink, the email one named,
and keeping the payload for them. The provider itself and macOS alert
presentation require a signed installed build.

Local acceptance on 2026-09-14: lint/typecheck, scoped API and desktop tests,
27 workerd delivery/notification tests, 38 site tests, 461 repository script tests
and 141 release tests passed. The native bridge compiled on arm64 macOS and the
Notifications pane was inspected in a real Electron window. Negative controls
caught broken session binding, reassignment/deletion, receipt skipping, access
checks, APNs disable handling and premature payload clearing. No deployment or
signed-Mac APNs/universal-link acceptance is claimed.

## Changelog

### 2026-11-10 — A Sidekick source request and its answer are notices, and a notice can carry links that answer it

**What changed:** Three kinds join the intents: `source_request` to the person
asked, and `source_approved` or `source_declined` to whoever asked (WorkspaceDO
migration 145 rebuilds the intents table to admit them). They are sent although
the recipient may not be able to list the Sidekick, and read a notification
choice of their own, Source requests (`sourceRequests`), which defaults to
push and email. `Notice` gains `actions`, and the email sink draws a
`source_request`'s Approve and Decline as buttons in place of Open in Rally.
A `source_request` opens the Canvas it was asked in, where its card is, since
the Sidekick is closed to the person until they approve.

**Why:** The owner decided that the person asked answers from the email with
one click. A request names a Sidekick to someone who usually cannot open it,
so the rule that a notice goes only to a recipient the parent admits would
have skipped every one. [`sidekick-sources.md`](sidekick-sources.md) holds the
reasoning for the request and the link.

**Considered and rejected:** A second email template for the request: the
sinks stay one template per transport, and the buttons are data on the notice.
Reading the Access requests choice: it defaults to push alone, so the email
the owner asked for would have reached only people who had chosen it, and
changing that default would start emailing every Canvas decider.

**Consequences:** A kind's words still live in `renderNotice` only. An action
link acts when opened, so it must stay signed per recipient and decision, and
must never be put in a push payload, a log or a queue message. A fourth notice
about something its recipient cannot open needs its own entry in
`recipientRefused`'s `unlisted` cases and in Activity's listing filter
([`activity.md`](activity.md)), together.

### 2026-11-09 — The generic email sink uses Cloudflare

**What changed:** `sendNoticeEmail` uses the shared native Cloudflare sender;
its recipient checks, notice text and notification intent reference stay the same.
D1 delivery receipts suppress already-completed sends on queue redelivery;
internal/unknown provider failures stay retryable and retain diagnostic codes.

**Why:** The requested provider migration must cover the current generic sink,
which replaced the retired per-kind email services. A single transport preserves
one template and one notification policy across every kind.

**Consequences:** Production needs the `EMAIL` binding and
`EMAIL_NOTIFICATION_FROM` (or its transactional fallback), with migration 0127
applied before the Worker. Correlation headers
do not provide provider deduplication; the acceptance/settlement gap remains an
explicit at-least-once delivery limitation.

### 2026-11-09 — Every kind renders once into a notice for the push and email sinks, checked against its Canvas or Sidekick, with an Activity row beside each intent

**What changed:** `notificationDirectoryState` checks a recipient against the
Canvas's row and `canvasReaderAllows`, or the Sidekick's row and
`sidekickReaderAllows`, with the person's role, so an administrator hears a
creator-only Canvas's mention, and reads the relationship through
`readRelationship`; the Thread directory reads and the projection-version wait
are gone. The kinds are a Canvas mention and add; a Sidekick run's `needs_input`
and `run_finished`, recorded by a `sidekick_run_notice` alarm entry the run's
projection arms; a reply (`new_message`), batched per conversation in a
`reply_batch` entry with the Thread-era 15-second batch and two-minute cooldown;
a pinned Canvas's new version (`artifact_updated`); and an access request, grant
and denial. WorkspaceDO migration 138 widens the intents' kind CHECK. Every
intent writes its recipient's Activity row in the same transaction.
`renderNotice` renders each kind once into a channel-neutral `Notice` that a
push sink and an email sink take, one queue message per chosen sink; the Slack
DM sender and the per-kind email services are deleted. A push's link comes from
the conversation's parent (a mention or reply opens at its message,
`?turn=&sequence=`), a delivery about a Thread is skipped as
`conversation_not_linkable`, and every push's badge is the person's unseen
Activity count.

**Why:** The PRD keeps push for Canvas mentions, Needs input and finished runs,
and none was sent: nothing writes the Thread directory any more, so every Canvas
mention waited on a projection that never came. The owner asked on 2026-11-08
for replies, pinned updates and access requests to notify again, and for Slack
to go while "email should support all notifications (this should be generic
pathway, it's easy to hook notification sinks into)". Writing the Activity row
with the intent is what keeps the feed and the push from disagreeing, and the
badge from clearing when an alert arrives while Rally is closed.

**Considered and rejected:** Sending a Thread push with no link: a tap that
opens nothing reads as broken. One queue message fanning out to every sink,
where a push retry would resend the email. Rendering per sink, each carrying its
own copy of every kind's words. A reply notification per recipient, which sends
the text across the Queue once per person, or an intent per message, which makes
ten replies ten pushes. Reading the feed from the intents table, whose rows are
30-day delivery records.

**Consequences:** A kind's words live in `renderNotice` only; a sink branches on
kind only for its own transport's needs (push's collapse id), and the consumer
checks `notificationAllows` for the message's own channel. A new person-facing
kind is recorded through one of the three recorders or writes its Activity row
in its own intent's transaction, and the intents' reaper must keep leaving
Activity alone. An inactive recipient's mention is now recorded and skipped at
delivery. A desktop older than this release drops a push whose kind it does not
know. The `platform: "ios"` registration shape and its APNs topic stay in code
with no client sending them.

Shipped in juno-ai-labs/avalon#1490. Design:
`docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.

### 2026-10-21 — The installed browser app shows the badge

**What changed:** Installed browser apps show the badge, from Web Push and from
the tab focused last.

**Why:** The Mac dock showed the attention count and an installed browser app
showed nothing, though both are signed in to the same Organization. Reusing
`useDockBadge` and its `complete` gate keeps one rule for when the client may
write a count.

**Considered and rejected:** Every tab writing its own count: the icon is shared, so a background
tab in another Organization replaced the focused tab's count, and focus could
not restore it because the focused tab never lost focus. Writing only from the
focused tab: an installed app window in the background would then stop
updating.

**Consequences:** A change to the badge count changes the Mac, iPhone and
browser icons together. A push from another Organization sets its own count, as
on the Mac, until a Rally tab regains focus or becomes visible; a Home Screen
app on iPhone and iPad returns from the background without a `focus` event.

### 2026-10-20 — Reply batches and conversation notification collapse

**What changed:** Unmentioned human replies notify current participants through
`newMessages`. A 15-second Queue delay coalesces a burst onto its latest reply;
reply and completion alerts share a two-minute cooldown after actual provider
acceptance, per channel. Reply collapse ids group a conversation, while mentions
and additions retain per-intent alerts and receipts retain the original delivery.
Provider sends are claimed atomically; failed handoffs remain durable and failed
providers release their claim without consuming the cooldown. Native reply
payloads preserve routing compatibility with already-shipped clients.

**Why:** Human replies were missed unless they mentioned the reader, while
routine conversation activity crowded the sidebar. Repeated ordinary reply
alerts should coalesce without erasing explicit calls for attention.

**Considered and rejected:** Treating a foreground thread as proof every message
was read would suppress replies while the reader was scrolled elsewhere. A new
scheduler is unnecessary because the existing delivery Queue supports delays.

**Consequences:** Cooldowns never clear unread state. Mentions remain immediate
and independently controlled. Queue retries check the read/access state again.

### 2026-10-19 — A Channel merge reaches the Channel's readers

**What changed:** A thread's merge into a Channel is pushed, emailed or sent to
Slack to everyone who reads the Channel (`ActivityPushSubject.channelId`):
every member for an Organization-wide Channel, its participants and the
thread's readers for a private one. A reader who cannot open the thread is
told "Maya merged a private thread into GTM", and the link opens the Channel
(`spaceCanonicalUrl`); everyone else's still opens the thread. The macOS menu
bar opens the Channel for every Channel merge, as the Activity tab does.

**Why:** The product owner's call: a private thread may now merge into its
Channel, and the Channel feed shows the merge to all its readers, so the
notification had to reach the same people. Their audience used to be the
thread's, which for a private thread left out everyone it was meant for.

**Considered and rejected:** Linking every Channel merge to the Channel: the
iOS build parses no Channel link, so its taps would land on "This Rally view
does not exist". A reader who can open the thread keeps the thread link every
client follows.

**Consequences:** An Organization-wide thread's merge into a private Channel
now notifies the Channel's people rather than the whole Organization. An iOS
tap on a private thread's merge still opens nothing until the app reads
Channel links.

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
