# Apple push notifications — design

> Companion to [`prd.md`](prd.md). The primitives, the schema, the payload, the
> APNs transport, the desktop mechanics, and what iOS reuses. Platform facts
> carry the date they were read; Apple and Cloudflare both move.

## The primitives

Four building blocks, each usable without the others:

| Primitive | Where | What it knows | What it does not know |
| --- | --- | --- | --- |
| **Device registry** | regional D1 `user_push_devices`; `apps/api/src/services/push-device-service.ts`; routes under `/push-devices` | who owns which token on which platform, and whether it is live | why anyone would send to it |
| **Push transport** | `apps/api/src/services/push/apns-transport.ts` | how to mint a provider token and POST one payload to APNs, and what Apple's answer means | who the recipient is, or what the text says |
| **Payload renderer** | `apps/api/src/services/push/push-payload.ts`, contracts in `@rally/contracts` | how a `PushNotificationIntent` becomes bytes for a `platform` | anything about intents' provenance |
| **Delivery consumer** | `apps/api/src/queues/push-delivery-consumer.ts`, queue `avalon-<region>-push-deliveries` | resolve recipient → devices, render, send, settle device state | how the intent was decided |

Producers compose them: the notification intent processor is the first, the
digest delivery registry (`CONNECTOR_DELIVERIES` in
`digest-delivery-service.ts`) is the obvious second, automation completions a
third. A producer only ever writes a `PushDeliveryMessage` to the queue.

```text
SubstreamAgent / WorkstreamObjectProduct mutation
  -> workstream_notification_intents (WorkspaceDO, existing)
  -> processWorkstreamNotificationIntent (conversation-effect-service.ts, existing)
       counts live devices for the recipient in this region's D1
       -> PUSH_DELIVERY_QUEUE.send({ intentId, recipientUserId, workspaceId, intent })
       -> Slack as today; email only per open question 1
  -> consumePushDeliveryQueue
       for each live device of recipientUserId:
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

/** What every producer hands the queue; platform-neutral. */
export const PushNotificationIntentSchema = z.object({
  kind: z.enum(["mention", "participant_added"]),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),            // the canonical work-stream link the email carries
  threadKey: z.string(),            // conversation identity, for grouping
  collapseKey: z.string(),          // intent id; ≤ 64 bytes at the transport
});

export const PushDeliveryMessageSchema = z.object({
  region: RegionSchema,
  workspaceId: z.string(),
  recipientUserId: z.string(),
  intentId: z.string(),
  intent: PushNotificationIntentSchema,
});
```

`title` and `body` are rendered by the producer, in the region, from the effect
it already holds (`authorNameSnapshot`, `workstreamTitleSnapshot`,
`messageText`, the objective for a seating). The queue message therefore carries
content, which is permitted: it is a regional queue and the payload stays in the
region, the same as the activity queue's mention effect today
([`workstream-durable-object.md`](../../workstream-durable-object.md) notes the
mention text already rides that queue).

### The preview cut

`body` is cut by the producer with `PUSH_BODY_PREVIEW_CHARACTERS`, defined once
in `@rally/contracts`, written open (`Number.POSITIVE_INFINITY`) until the team
sets it. The transport separately refuses a rendered payload over Apple's
4,096-byte ceiling (a published limit, read 2026-09-11 from the APNs
*Sending notification requests* reference) with `payload_too_large` on the log
row rather than sending a request Apple will 413. Two guards, two reasons: one is
product, one is protocol.

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
```

Rules the service enforces:

- **Upsert on `(user_id, installation_id, transport)`.** A re-registration
  replaces the token and clears `disabled_at` (a device that was `unregistered`
  and registers again is live again — Apple issues a new token).
- **One person per token.** On upsert, other users' live rows with the same
  `token` are disabled with reason `token_reassigned`. A shared Mac never shows
  the previous person's mentions.
- **`topic` must equal `APNS_TOPICS[platform]`.** Anything else is a 400.
- **Delete is by `installation_id`** for the session's person, so a sign-out
  needs no row id.
- **Liveness at send time** is `disabled_at IS NULL` *and* the person holds a
  session in this region with `revoked_at IS NULL AND expires_at > now`. That
  read is one indexed query on `sessions` and is what makes revocation and
  expiry take effect at the next event without touching this table.
- **`disabled_reason`** is one of `unregistered` (APNs 410 whose `timestamp`
  is not older than `last_seen_at`), `bad_token` (APNs `BadDeviceToken`),
  `token_reassigned`, `user_disabled`.

A stale-row reaper (rows disabled or unseen for a long time) is deferred; the
table is small and the send path never reads disabled rows.

## Routes

On `protectedApi` (a workspace session, which is what a regional credential is),
beside `/digest`:

| Route | Body | Effect |
| --- | --- | --- |
| `PUT /push-devices/:installationId` | `RegisterPushDeviceRequest` | upsert for the session's person; 200 with `{ status: "registered" }` |
| `DELETE /push-devices/:installationId` | — | delete for the session's person; 204 whether or not it existed |

A person registers once per region with any one workspace credential in that
region; the row is per person, not per workspace, so activating a second
workspace in the same region registers nothing new. Both routes go through the
[header checklist](../../when-adding-a-new-http-header.md) only if a header is
added; none is planned.

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
signature JOSE wants; no DER conversion. Apple requires the token to be
refreshed no more often than every 20 minutes and no less often than every 60
(read 2026-09-11 from *Establishing a token-based connection to APNs*); the
transport caches one per isolate and re-mints after 50 minutes. Those two
numbers are Apple's, transcribed with the source beside them.

**Request.** `POST https://api.push.apple.com/3/device/<token>` with headers
`authorization: bearer <jwt>`, `apns-topic: <device.topic>`,
`apns-push-type: alert`, `apns-priority: 10`, `apns-id: <delivery uuid>`,
`apns-collapse-id: <intent.collapseKey>` (≤ 64 bytes, Apple), and
`apns-expiration` left for the team (open; `0` means deliver once now or never).
Workers `fetch` negotiates HTTP/2 to Apple in production; the local `workerd`
does not reliably (cloudflare/workerd#4841, read 2026-09-11), which is one more
reason sends are skipped outside `production`/`staging`, exactly as `notifyOps`
and Resend are.

**Answers**, as the transport's typed outcome:

| APNs | Outcome | Consumer action |
| --- | --- | --- |
| 200 | `sent` | `last_delivery_at` |
| 410 `Unregistered` | `unregistered` with `timestamp` | disable if `timestamp ≥ last_seen_at`, else keep (the device re-registered since) |
| 400 `BadDeviceToken` | `bad_token` | disable |
| 400 other, 413 | `rejected` with reason | log, `last_failure_code`, no retry |
| 403 `InvalidProviderToken`, `ExpiredProviderToken`, `MissingProviderToken` | `provider_auth_failed` | log at `error`, one `notifyOps` per isolate per hour, and `retry()` the batch: this is a configuration fault, and the message must not be lost while it is fixed |
| 429 `TooManyProviderTokenUpdates` | `provider_auth_failed` | as above; means the mint cadence is wrong |
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
   the rolling-deploy and turned-off-mid-flight case.
3. Read live devices for `recipientUserId` (the liveness rule above). None: ack,
   log `no_live_devices`.
4. For each device: render for `device.platform`, send, settle the row, log
   `push_delivery_terminal` with `intent_id`, `device_id`, `platform`, `outcome`,
   `apns_id`, `status`, `reason`. Never the token, the title, or the body.
5. Any `transient` or `provider_auth_failed` outcome retries the message; the
   already-sent devices are protected by the collapse id on redelivery.

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

1. On `ready`, when packaged and on macOS, call
   `pushNotifications.registerForAPNSNotifications()`. It rejects on a build
   without the entitlement (every `electron-vite dev` run): record
   `unavailable`, log once, expose the state to Settings.
2. Mint or read `pushInstallationId` from a file beside the session file
   (`session-file.ts` pattern; `safeStorage` is unnecessary, it is not a secret).
3. For each region with a stored credential in the credential set
   (`stored-auth.ts`), `PUT /push-devices/:installationId` through the
   per-credential request shape `getWorkspaceAttention` uses, with its 401
   refresh-and-retry. Skip regions without a credential.
4. Re-run on every launch (the token can change), on `sessionChanged` when a
   region gains its first credential, and on the switch being turned on.
5. On the switch being turned off or on sign-out: `DELETE` in every region
   first, then `unregisterForAPNSNotifications()`, then clear credentials.

**Receipt.** `pushNotifications.on("received-apns-notification", (_, userInfo))`
fires while Rally runs. macOS presents the alert itself; Rally does not post a
second one. The handler parses `userInfo.rally` and refreshes workspace
attention so the account menu's dot updates without a focus event.

**Click.** The spike in `plan.md` establishes what Electron delivers when the
person clicks a system-presented remote alert. Expected: `received-apns-notification`
fires again with the same `userInfo` (that is what AppKit's
`application:didReceiveRemoteNotification:` does for a click while running),
and a launch from a click delivers it after `ready`. The handler distinguishes
the two by timing is not acceptable; the spike decides between (a) treating
every receipt whose `userInfo` matches an alert the app already saw as a click,
(b) reading `NSApplicationLaunchRemoteNotificationKey` at launch, or (c) the
addon fallback. On a click: `applicationOpenObserver.opened('push_notification')`
(the TODO at `index.ts` near the observer says exactly this), then
`sendDeepLink(rally.url, 'notification')`.

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

## What iOS reuses

Everything server-side. The iOS client: registers with
`platform: "ios"`, its own topic (one line in `APNS_TOPICS`), `apnsEnvironment`
from its build; parses `rally.url` as a universal link; sets `badge` from the
attention read once that exists; and can add a Notification Service Extension
that uses `mutable-content` to replace the preview with fetched content, at
which point the renderer's iOS branch can drop the body. The same `.p8` key and
the same queues serve it. Adding a second transport (FCM) later is a new
`transport` value, a second transport module, and a renderer branch.

## Testing

- **Node suite (`apps/api`)**: the device service against the real migration —
  upsert, token reassignment, topic allowlist, delete, the liveness join with
  `sessions`; the payload renderer per platform; the JWT minter (verify the
  signature with the public half); the transport's status-to-outcome table with
  a doubled `fetch` (Apple cannot run here, so a double is permitted).
- **Workers suite (`apps/api/test-workers`)**: the consumer end to end on real
  workerd with a doubled transport: no devices, one device sent, 410 disables,
  transient retries, flag off skips. The intent processor enqueues one message
  and still settles.
- **Prove each can fail** per [`testing.md`](../../testing.md#prove-the-test-can-fail):
  drop the liveness join and watch the revoked-session test fail; skip the
  disable on 410 and watch that one fail.
- **Desktop**: unit tests for the registration loop over a credential set, the
  settings state machine, and the click handler's routing; the packaged
  verification in `plan.md` is what proves the entitlement and profile.
- **Release scripts**: `test:release` gains cases for the new verifier
  assertions against fixtures.
