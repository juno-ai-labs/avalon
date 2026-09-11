# Apple push notifications — design

> Companion to [`prd.md`](prd.md). The primitives, the schema, the payload, the
> APNs transport, the desktop mechanics, the spike the build starts with, and
> what iOS reuses. Platform facts carry the date they were read; Apple and
> Cloudflare both move.

## The primitives

Four building blocks, each usable without the others:

| Primitive | Where | What it knows | What it does not know |
| --- | --- | --- | --- |
| **Device registry** | regional D1 `user_push_devices` + `user_push_device_sessions`; `apps/api/src/services/push-device-service.ts`; routes under `/push-devices` | who owns which token on which platform, which sessions vouch for it, and whether it is live | why anyone would send to it |
| **Push transport** | `apps/api/src/services/push/apns-transport.ts` | how to obtain a provider token and POST one payload to APNs, and what Apple's answer means | who the recipient is, or what the text says |
| **Payload renderer** | `apps/api/src/services/push/push-payload.ts`, contracts in `@rally/contracts` | how a `PushNotificationIntent` becomes bytes for a `platform` that fit Apple's ceiling | anything about intents' provenance |
| **Delivery consumer** | `apps/api/src/queues/push-delivery-consumer.ts`, queue `avalon-<region>-push-deliveries` | read the intent back, re-run the access fence, resolve devices, render, send, settle device state | how the intent was decided |

Producers compose them: the notification intent processor is the first, the
digest delivery registry (`CONNECTOR_DELIVERIES` in
`digest-delivery-service.ts`) is the obvious second, automation completions a
third. A producer only ever writes a `PushDeliveryMessage` of identifiers to
the queue.

```text
SubstreamAgent / WorkstreamObjectProduct mutation
  -> workstream_notification_intents (WorkspaceDO, existing)
  -> processWorkstreamNotificationIntent (conversation-effect-service.ts, existing)
       counts live devices for the recipient in this region's D1
       -> PUSH_DELIVERY_QUEUE.send({ region, workspaceId, intentId, recipientUserId, enqueuedAt })
       -> Slack as today; email only when neither push nor Slack reached anyone (prd.md decision 12)
  -> consumePushDeliveryQueue
       WorkspaceDO.readNotificationIntentForDelivery(intentId)  -> kind, effect payload, fence data
       re-run the fence: active member (D1), directory listable, child authorizeViewer
       for each live device of recipientUserId not yet reached for this message:
         render(intent, device.platform) -> apnsTransport.send(...) -> settle device row
```

## Contracts (`@rally/contracts`)

```ts
export const PushPlatformSchema = z.enum(["macos", "ios"]);
export const PushTransportSchema = z.enum(["apns"]);
export const ApnsEnvironmentSchema = z.enum(["production", "sandbox"]);

/** Bundle identifiers a client may register. iOS adds one line here. */
export const APNS_TOPICS = {
  macos: "ai.rallywith.desktop",
  // ios: "<bundle id, when the client exists>",
} as const;

export const RegisterPushDeviceRequestSchema = z.object({
  installationId: z.string().uuid(),
  platform: PushPlatformSchema,
  transport: PushTransportSchema,
  topic: z.string(),               // must equal APNS_TOPICS[platform]
  apnsEnvironment: ApnsEnvironmentSchema,
  token: z.string().regex(/^[0-9a-f]{64,}$/i),
  appVersion: z.string(),
});

/** What the consumer renders from; built in the consumer, never queued. */
export const PushNotificationIntentSchema = z.object({
  kind: z.enum(["mention", "participant_added"]),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),            // the canonical work-stream link the email carries
  threadKey: z.string(),            // conversation identity, for grouping
  collapseKey: z.string().max(64),  // the intent id, a UUID (36 bytes)
});

/** What every producer hands the queue: region and opaque ids only. */
export const PushDeliveryMessageSchema = z.object({
  region: RegionSchema,
  workspaceId: z.string(),
  recipientUserId: z.string(),
  intentId: z.string().uuid(),
  enqueuedAt: z.string().datetime(),
});
```

The message carries no title, body, or link.
[`regionalization.md`](../../regionalization.md#deployments) requires Queue
bodies to carry the region and opaque record ids and never a sensitive payload,
and notes that Queue jurisdiction is not something the region's configuration
pins. The consumer reads the effect payload — `authorNameSnapshot`,
`workstreamTitleSnapshot`, `messageText`, the objective for a seating — back
from the intent row WorkspaceDO already keeps for thirty days, through a new
typed RPC `readNotificationIntentForDelivery` in
`workspace-notification-intent-protocol.ts` that returns the kind, the payload,
the recipient, `sourceGeneration`, and `requiredDirectoryVersion`, and refuses an
unknown id.

### The preview cut

Two guards, two reasons, and they compose so that a long mention is shortened
rather than dropped:

- **The product number.** `PUSH_BODY_PREVIEW_CHARACTERS = 1000` in
  `@rally/contracts`, a product limit set by `prd.md` key design decision 14
  and cited to it in the code comment; it is the text on the person's screen,
  not a defensive placeholder. The producer-side body is cut there, with a
  visible mark.
- **The protocol floor.** Whatever that number is, the renderer always fits the
  body to Apple's 4,096-byte payload ceiling (a published limit, read
  2026-09-11 from the APNs *Sending notification requests* reference) by
  measuring the serialized payload and shortening the body further, with the
  same mark, until it fits — 1,000 characters of multi-byte text plus a long
  title and link can exceed it. The transport still refuses a payload over the
  ceiling with `payload_too_large` on the log row — that path is now reachable
  only by a title or link so long that no body fits, which is a bug to see, not
  a mention to lose.

## Schema

Regional D1, both regions, `packages/db/migrations/<next>_user_push_devices.sql`:

```sql
CREATE TABLE user_push_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'ios')),
  transport TEXT NOT NULL CHECK (transport IN ('apns')),
  topic TEXT NOT NULL,
  apns_environment TEXT NOT NULL CHECK (apns_environment IN ('production', 'sandbox')),
  token TEXT NOT NULL,
  app_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_delivery_at TEXT,
  last_failure_code TEXT,
  last_failure_at TEXT,
  disabled_at TEXT,
  disabled_reason TEXT,
  UNIQUE (user_id, installation_id, transport)
);
CREATE INDEX user_push_devices_live_by_user
  ON user_push_devices (user_id) WHERE disabled_at IS NULL;
CREATE INDEX user_push_devices_by_token ON user_push_devices (token);

-- The sessions that vouch for a device. A registration made with a workspace
-- credential records that credential's session; liveness joins through here.
CREATE TABLE user_push_device_sessions (
  device_id TEXT NOT NULL REFERENCES user_push_devices(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, session_id)
);
CREATE INDEX user_push_device_sessions_by_session
  ON user_push_device_sessions (session_id);
```

Rules the service enforces:

- **Upsert on `(user_id, installation_id, transport)`.** A re-registration
  replaces the token, clears `disabled_at` (a device that was `unregistered`
  and registers again is live again — Apple issues a new token), and adds the
  calling session to `user_push_device_sessions` if it is not there.
- **Every credential on the installation registers.** The desktop calls the
  route once per region with each workspace credential it holds there, so a
  device with two workspaces in one region has two session rows; a session
  row's `session_id` is stable across refresh (renewal rotates the refresh
  hash in place), so a registration does not have to be repeated on refresh.
- **One person per token.** On upsert, other users' live rows with the same
  `token` are disabled with reason `token_reassigned`. A shared Mac never shows
  the previous person's mentions.
- **`topic` must equal `APNS_TOPICS[platform]`.** Anything else is a 400.
- **Delete is by `installation_id`** for the session's person, so a sign-out
  needs no row id. The delete is best effort from the client; the session
  binding is what makes sign-out authoritative.
- **Liveness at send time** is `disabled_at IS NULL` *and* at least one row in
  `user_push_device_sessions` whose session has `revoked_at IS NULL AND
  expires_at > now`. Sign-out revokes the session; access revocation and the
  expiry reaper revoke or expire it; a Mac unopened for thirty days loses its
  last session to the sliding expiry
  (`SESSION_RENEWAL_WINDOW_SECONDS` in `auth-service.ts`). Each ends delivery to
  exactly that installation, whatever the person's other devices hold.
- **`disabled_reason`** is one of `unregistered` (APNs 410 whose `timestamp`
  is not older than `last_seen_at`), `bad_token` (APNs `BadDeviceToken`),
  `token_reassigned`, `user_disabled`.

A stale-row reaper (rows disabled or without a live session for a long time) is
deferred; the table is small and the send path never reads disabled rows.

## Routes

On `protectedApi` (a workspace session, which is what a regional credential is),
beside `/digest`:

| Route | Body | Effect |
| --- | --- | --- |
| `PUT /push-devices/:installationId` | `RegisterPushDeviceRequest` | upsert for the session's person, binding the calling session; 200 with `{ status: "registered" }` |
| `DELETE /push-devices/:installationId` | — | delete for the session's person; 204 whether or not it existed |

The row is per person, not per workspace; a second workspace credential in the
same region adds a session binding and changes nothing else. Both routes go
through the [header checklist](../../when-adding-a-new-http-header.md) only if
a header is added; none is planned.

## The APNs transport

`apps/api/src/services/push/apns-transport.ts`, in the shape of `notifyOps`
(`ops-slack-notifier.ts`): one exported function, a fixed host, a bounded
deadline, never throws, one log row per outcome.

**Provider token.** An ES256 JWT: header `{ alg: "ES256", kid: APNS_KEY_ID }`,
claims `{ iss: APNS_TEAM_ID, iat }`. Minted with WebCrypto —
`crypto.subtle.importKey("pkcs8", pemPrivateKeyToPkcs8(APNS_AUTH_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])`
and `sign({ name: "ECDSA", hash: "SHA-256" })`; the RSA template is
`createGitHubAppJwt` in `packages/connectors/src/github.ts`, and
`pemPrivateKeyToPkcs8` is reusable as is. WebCrypto returns the raw `r‖s`
signature JOSE wants; no DER conversion.

Apple counts token generation per key across every connection, and requires it
no more often than every 20 minutes and no less often than every 60 (read
2026-09-11 from *Establishing a token-based connection to APNs*). A per-isolate
cache would mint once per cold isolate, which under any real traffic is far
more often than the floor, so **the token is shared, not the mint**: the
transport reads the current token from the regional KV namespace under a key
derived from `kid`, mints only when the stored token is absent or older than 50
minutes, and writes the new one back with its `iat`. Two isolates racing on an
empty cache can still mint twice in one window; the spike below measures how
Apple treats that, and a single-flight guard through a Durable Object is the
escalation if it is not tolerated. The token is a bearer credential with a
one-hour life; KV is the one place it rests.

**Request.** `POST https://api.push.apple.com/3/device/<token>` with headers
`authorization: bearer <jwt>`, `apns-topic: <device.topic>`,
`apns-push-type: alert`, `apns-priority: 10`, `apns-id: <delivery uuid>`,
`apns-collapse-id: <intent.collapseKey>` (≤ 64 bytes, Apple; the intent id is a
UUID), and `apns-expiration` set to `APNS_EXPIRATION_SECONDS` from now — a
defensive window the team sets, written open as a far-future value so APNs
stores and retries for as long as it will. `0` is not the open value: it tells
APNs to try once and discard, the most restrictive setting there is, and
omitting the header is not the same request either. Workers `fetch` negotiates
HTTP/2 to Apple in production; the local `workerd` does not reliably
(cloudflare/workerd#4841, read 2026-09-11), which is one more reason sends are
skipped outside `production`/`staging`, exactly as `notifyOps` and Resend are.

**Answers**, as the transport's typed outcome:

| APNs | Outcome | Consumer action |
| --- | --- | --- |
| 200 | `sent` | `last_delivery_at` |
| 410 `Unregistered` | `unregistered` with `timestamp` | disable if `timestamp ≥ last_seen_at`, else keep (the device re-registered since) |
| 400 `BadDeviceToken` | `bad_token` | disable |
| 400 other, 413 | `rejected` with reason | log, `last_failure_code`, no retry |
| 403 `InvalidProviderToken`, `ExpiredProviderToken`, `MissingProviderToken` | `provider_auth_failed` | log at `error`, invalidate the shared token so the next send re-mints, `notifyOps` under `PUSH_PROVIDER_AUTH_NOTICE_COOLDOWN_MS` (a defensive cooldown, open at `0`, the team's number), and `retry()` the batch: a configuration fault must not lose the message while it is fixed |
| 429 `TooManyProviderTokenUpdates` | `provider_token_throttled` | do **not** re-mint and do not treat the batch as failed: keep the stored token (Apple honours it for its hour), log at `error`, `notifyOps` under the same cooldown, and `retry()` so the batch lands after the window. This is the one 429 where minting again is the wrong reflex, because the batch is not what failed |
| 429 `TooManyRequests`, 500, 503, timeout, thrown fetch | `transient` | `retry()`; the Queue's backoff and dead-letter queue own the rest |

**Skips.** Outside `production`/`staging`, or with either secret absent, the
transport answers `skipped` with the rendered payload's byte length on an `info`
row, so a developer can see what would have been sent. `/health` reports
`pushDelivery: configured | not configured` beside `opsNotifications`; neither
secret enters `productionOnlySecrets`, because a region without a key must stay
up.

## The delivery consumer

`consumePushDeliveryQueue(batch, env)`, dispatched from `worker-events.ts`
beside the access-revocation consumer, on `avalon-global-push-deliveries` /
`avalon-eu-push-deliveries`, each with `<queue>-dead-letter`, declared as
producer and consumer in both Wrangler files, created by `deploy-api.yml`'s
queue step. Consumer settings copy the access-revocation queue's and are the
team's to change.

Per message:

1. Parse `PushDeliveryMessageSchema`; a region mismatch is a thrown error (as the
   effect service does), never a silent skip.
2. If `push-notifications-enabled` is off for the recipient, ack and log
   `push_delivery_skipped reason=flag_off`. The producer also checks, so this is
   the rolling-deploy and turned-off-mid-flight case. There is deliberately no
   presence check here in v1 (`prd.md` decision 13); when one is wanted it is
   one more condition at this step.
3. Read the intent back: `WorkspaceDO.readNotificationIntentForDelivery`. An
   unknown or reaped id is acked with `reason=intent_missing`.
4. **Re-run the access fence, the same one `processWorkstreamNotificationIntent`
   ran when it decided the intent:** the recipient is still an active member
   (D1 `workspace_members`), `notificationDirectoryState` still reports the room
   listable at or beyond the intent's `sourceGeneration` and
   `requiredDirectoryVersion`, and for a private child `authorizeViewer` still
   admits them and the child is not archived. Any failure acks the message with
   a terminal `reason=access_revoked` or `reason=not_listable` and sends
   nothing. The Queue and its retries extend delivery past the moment the
   intent was decided, and the payload is content, so the decision has to be
   made again where the bytes leave.
5. Build the `PushNotificationIntent` from the effect payload (title, body
   fitted per the preview cut, the canonical link from `workstream-links.ts`,
   `threadKey` = parent id or child id, `collapseKey` = intent id).
6. Read live devices for `recipientUserId` (the liveness join above). Log
   `no_live_devices` with a `detail` of `none_registered`, `all_disabled`, or
   `no_live_session`, so goal 5's question — why did nothing arrive — has an
   answer in one row.
7. Skip any device whose `last_delivery_at` is at or after the message's
   `enqueuedAt`: it was reached by an earlier attempt of this same message, and
   a collapsed notification that arrives again still alerts.
8. For each remaining device: render for `device.platform`, send, settle the
   row, log `push_delivery_terminal` with `intent_id`, `device_id`, `platform`,
   `outcome`, `apns_id`, `status`, `reason`. Never the token, the title, or the
   body.
9. Any `transient`, `provider_auth_failed`, or `provider_token_throttled`
   outcome retries the message; step 7 keeps the retry from re-alerting the
   devices already reached.

Ordering across devices does not matter; ordering across messages is the
Queue's and is not relied on.

## Payload rendering

`renderPushPayload(intent, platform)`:

```jsonc
// macos and ios share the aps core
{
  "aps": {
    "alert": { "title": "<intent.title>", "body": "<intent.body>" },
    "thread-id": "<intent.threadKey>",
    "sound": "default",
    "category": "RALLY_<KIND>",
    "mutable-content": 1          // ios only; reserved for a service extension
    // "badge": n                  // ios only; deferred with the unread source
  },
  "rally": {
    "v": 1,
    "kind": "<mention|participant_added>",
    "url": "<intent.url>",
    "workspaceId": "<opaque>",
    "region": "<global|eu>"
  }
}
```

`rally.url` is the canonical work-stream link the mention email already carries
(`packages/contracts/src/workstream-links.ts`); the desktop routes it through
its existing deep-link parser, and a future iOS client can adopt it as a
universal link without a payload change. `rally.v` is the payload version a
client parses defensively: an unknown version opens the app and nothing else.

## The desktop

**Registration** (`apps/desktop/src/main/push-notifications.ts`, main process):

1. On `ready`, when packaged, on macOS, **and only when the persisted device
   switch is on and the served flag is on**, call
   `pushNotifications.registerForAPNSNotifications()`. A device whose switch
   was turned off is never re-registered by a launch or a credential change;
   only the switch turns it back on. The call rejects on a build without the
   entitlement (every `electron-vite dev` run): record `unavailable`, log once,
   expose the state to Settings.
2. Mint or read `pushInstallationId` from a file beside the session file
   (`session-file.ts` pattern; `safeStorage` is unnecessary, it is not a secret).
   The switch's position lives in `application-settings.ts` beside it.
3. For each workspace credential in the credential set (`stored-auth.ts`),
   `PUT /push-devices/:installationId` against that credential's region,
   through the per-credential request shape `getWorkspaceAttention` uses, with
   its 401 refresh-and-retry. Every credential registers, not one per region,
   because each one binds its own session to the device.
4. Re-run on every launch (the token can change), on `sessionChanged` when a
   credential is added, and on the switch being turned on — all subject to
   step 1's gate.
5. On the switch being turned off or on sign-out: `DELETE` in every region
   first, then `unregisterForAPNSNotifications()`, then clear credentials. The
   delete is best effort; sign-out's session revocation is what ends delivery
   if it fails.

**Receipt.** `pushNotifications.on("received-apns-notification", (_, userInfo))`
fires while Rally runs. macOS presents the alert itself; Rally does not post a
second one. The handler parses `userInfo.rally` and refreshes workspace
attention so the account menu's dot updates without a focus event.

**Click.** The spike below establishes what Electron delivers when the person
clicks a system-presented remote alert. Expected: `received-apns-notification`
fires again with the same `userInfo` (that is what AppKit's
`application:didReceiveRemoteNotification:` does for a click while running),
and a launch from a click delivers it after `ready`. Distinguishing receipt
from click by timing is not acceptable; the spike decides between (a) treating
every receipt whose `userInfo` matches an alert the app already saw as a click,
(b) reading `NSApplicationLaunchRemoteNotificationKey` at launch, or (c) the
addon fallback. On a click: `applicationOpenObserver.opened('push_notification')`
(the TODO at `index.ts` near the observer says exactly this), then
`sendDeepLink(rally.url, 'notification')`. A click that arrives before the
window exists queues through `pendingDeepLinks`, as an early `open-url` does.

**Settings.** A `notifications` section in `application-settings.ts` with the
switch and the three states (`enabled`, `unavailable`, `denied`), registered in
settings search per [`settings-search.md`](../../settings-search.md), gated by
the `pushNotificationsEnabled` field `GET /feature-flags` gains.

**Signing and packaging.**

- `resources/entitlements.mac.plist` gains
  `com.apple.developer.aps-environment` = `production`. The inherit plist is
  untouched; `mac-signature-policy.mjs` keeps asserting the helpers' exact three.
- `electron-builder.yml` `mac.provisioningProfile` points at a file the release
  workflow writes from a new repository secret (base64 of the
  `.provisionprofile`); electron-builder embeds it as
  `Contents/embedded.provisionprofile`. `electron-builder.local.yml` accepts an
  optional local path so a developer can test on their own Mac.
- `verify-macos-app.mjs` asserts, in both modes: the main executable's
  entitlements are exactly the previous three plus `aps-environment` with value
  `production`; `embedded.provisionprofile` exists, decodes (`security cms -D`),
  names `7ZLT6A8W25.ai.rallywith.desktop`, carries the entitlement, and expires
  no sooner than `PROVISIONING_PROFILE_MINIMUM_REMAINING_DAYS` from now — a
  defensive number written open (`0`) and handed back, because an expired
  Developer ID profile can stop installed copies launching (Apple Developer ID
  support page, read 2026-09-11).
- The release inputs classifier already admits `apps/desktop/**`; the profile
  path and secret name join the workflow's env block beside the notarization
  keys.

## The spike

Time-boxed, on a developer Mac with a locally packaged signed build carrying
the Developer ID profile from `prd.md` § Provider configuration, before any
implementing change. Its answers go in `research.md` in this folder with the
Electron and macOS versions.

1. `pushNotifications.registerForAPNSNotifications()` resolves with a token on
   a build with the entitlement and profile, and rejects on `electron-vite dev`.
2. With the app quit, a hand-sent alert push (any APNs CLI or a 20-line
   script with the `.p8`) shows a macOS notification; clicking it launches
   Rally. What reaches the main process: does `received-apns-notification`
   fire after `ready` with the payload? Does anything else?
3. With the app running in the background, the same push: the system shows the
   alert once; `received-apns-notification` fires on receipt; does it fire
   again on click, with the same `userInfo`? This picks the click strategy
   above; if (c), the addon is built like `unified-log.node`.
4. Does posting one local Electron `Notification` trigger macOS's permission
   prompt, and does a remote alert display once permission is granted?
5. With the same `.p8`, mint two provider tokens a few seconds apart and send
   with each: does Apple answer `TooManyProviderTokenUpdates`, and how long
   does the throttle last? This decides whether the KV-shared token needs a
   single-flight guard from the start.

## What iOS reuses

Everything server-side. The iOS client: registers with
`platform: "ios"`, its own topic (one line in `APNS_TOPICS`), `apnsEnvironment`
from its build, and each workspace credential it holds; parses `rally.url` as a
universal link; sets `badge` from the attention read once that exists; and can
add a Notification Service Extension that uses `mutable-content` to replace the
preview with fetched content, at which point the renderer's iOS branch can drop
the body. The same `.p8` key and the same queues serve it. Adding a second
transport (FCM) later is a new `transport` value, a second transport module,
and a renderer branch.

## Testing

- **Node suite (`apps/api`)**: the device service against the real migration —
  upsert, session binding, token reassignment, topic allowlist, delete, and the
  liveness join (device A's session revoked while device B's stays live selects
  only B; a device whose only session expired is not selected); the payload
  renderer per platform, including the fit-to-ceiling cut; the JWT minter
  (verify the signature with the public half) and the KV-shared cache; the
  transport's status-to-outcome table with a doubled `fetch` (Apple cannot run
  here, so a double is permitted).
- **Workers suite (`apps/api/test-workers`)**: the consumer end to end on real
  workerd with a doubled transport: no devices, one device sent, 410 disables,
  transient retries without re-alerting the device already reached, flag off
  skips, and **access revoked between enqueue and consumption sends nothing**
  (leave the work stream, archive the child, revoke membership).
- **Prove each can fail** per [`testing.md`](../../testing.md#prove-the-test-can-fail):
  drop the liveness join and watch the revoked-session test fail; skip the
  re-run of the fence and watch the revoked-access test fail; skip the disable
  on 410 and watch that one fail.
- **Desktop**: unit tests for the registration gate (switch off means no
  registration on launch), the loop over a credential set, the settings state
  machine, and the click handler's routing; the packaged verification is what
  proves the entitlement and profile.
- **Release scripts**: `test:release` gains cases for the new verifier
  assertions against fixtures.
