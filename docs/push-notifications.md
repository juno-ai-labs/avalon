# Apple push notifications

Rally sends mentions and additions to signed-in Macs through APNs, using the
existing workspace notification intent. Push is enabled for everyone from launch through
`push-notifications-enabled`; Slack also sends when available, and email is the
fallback when neither Slack nor push accepted the notification.

## Where the code lives

- `apps/api/src/services/push-device-service.ts`: regional D1 device/session registry.
- `apps/api/src/services/push/`: provider authentication and payload rendering.
- `apps/api/src/queues/push-delivery-consumer.ts`: intent read, existing access check, send, receipt.
- `apps/desktop/src/main/push-notifications.ts` and `apps/desktop/native/push-notifications/`: registration and native response/permission callbacks.

## How it works

Every stored workspace credential registers the installation with its own region.
Delivery requires a live session bound to that device; another installation's
session cannot keep it alive. The device switch and a separate push installation
ID persist in the existing application settings file.

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

Payloads carry the first 1,000 Unicode code points with an ellipsis when shortened,
fitted further to Apple's 4,096-byte ceiling. APNs retains undelivered alerts for
24 hours. Provider JWTs are shared through regional KV and refreshed at 50 minutes;
no coordination object is introduced. Queue retries and dead-letter queues own
transient delivery failures. Provider-auth failures notify operations without
disabling devices; token-update throttling keeps the cached provider token.

The main process uses Electron for APNs registration and a small native delegate
for permission state and explicit notification clicks. The delegate forwards
unrelated notification callbacks to Electron. Receipt never implies a click.
Clicks pass the HTTPS link through the existing work-stream parser and scheme
navigation, including pending navigation before sign-in or window readiness.

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
`apns-transport.test.ts` cover encoding/signing and Apple responses. The real
workerd `push-delivery.test.ts` covers read RPC, receipts, revocation and retry.
Desktop push/link tests cover registration and routing; existing settings and
release suites cover the integration. The provider itself and macOS alert
presentation require a signed installed build.

Local acceptance on 2026-09-14: lint/typecheck, scoped API and desktop tests,
27 workerd delivery/notification tests, 38 site tests, 461 repository script tests
and 141 release tests passed. The native bridge compiled on arm64 macOS and the
Notifications pane was inspected in a real Electron window. Negative controls
caught broken session binding, reassignment/deletion, receipt skipping, access
checks, APNs disable handling and premature payload clearing. No deployment or
signed-Mac APNs/universal-link acceptance is claimed.

## Changelog

### 2026-09-14 — Add Apple push as a transport of existing notification intents

A closed desktop previously received no device-local notification. Reuse the
intent audience and access decision rather than invent a second producer. The
PRD's device-wide timestamp was replaced with per-intent/device receipts because
an unrelated later send would otherwise swallow a retry. The user chose code-first
implementation with signed-Mac acceptance before release, explicit native click
callbacks, and a 24-hour APNs expiration. The subsequent rollout decision enables
push for everyone from day one; the existing flag remains an operator off switch. Keep the transport small and preserve
at-least-once delivery rather than adding coordination machinery.
