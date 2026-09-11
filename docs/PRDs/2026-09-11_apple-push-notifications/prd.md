# Apple push notifications

> Created 2026-09-11.
>
> Rally tells a person about a mention or a seating on the Apple devices they
> have signed in from, through the Apple Push Notification service (APNs),
> starting with the macOS desktop client and built so an iOS client registers
> into the same backend without a second delivery path. Companion:
> [`design.md`](design.md) (the primitives, schema, payload, transport, desktop
> mechanics, and the spike the build starts with). Sequenced after it:
> [https work-stream links](../2026-09-11_https-work-stream-links/prd.md),
> which shares the App ID and provisioning profile this PRD creates. Standing
> contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [`digests.md`](../../digests.md), which owns the notification
> intent pipeline this plugs into, and
> [`workstream-durable-object.md`](../../workstream-durable-object.md#sidebar-activity-and-notifications).

## Summary

When somebody mentions a person in a work stream, or adds them to one, that
person's Mac shows a system notification even when Rally is quit, asleep in the
Dock, or on another Space. Clicking it opens Rally at that work stream. Today the
same event reaches them as a Slack direct message if they linked Slack, and as an
email otherwise; the desktop client shows nothing of its own, and a person who
closed Rally hears about a mention when they next open it or read their digest.

The backend gains one generic capability: a registry of a person's push-capable
devices per region, and a queue-fed delivery service that re-checks the
recipient's access, renders the intent into a provider payload, and sends it.
The macOS client is its first registrant. An iOS client registers into the same
route with a different platform value, and the same delivery service, key, and
queue serve it.

## Motivation

- **A quit desktop app hears nothing.** The desktop has no notification surface at
  all: no Electron `Notification`, no Dock badge, no menu-bar count. Every
  interruption today is a Slack DM or an email, and both are addressed at an
  inbox rather than at the device in front of the person. A mention in a busy
  automation work stream can sit for hours.
- **iOS is coming soon, and push is its only channel.** A phone client without
  push is a client nobody opens. Building the registry and delivery once, for the
  desktop, means the iOS work is a client-side registration and a payload branch
  rather than a second backend.
- **The pipeline that decides who is told already exists.** `workstream_notification_intents`
  in WorkspaceDO already produces one causally fenced intent per (message,
  recipient, kind), leases it, revalidates access at delivery, and records the
  terminal outcome. Push is a third transport on that state machine, not a new
  producer, so the cost of adding it is bounded.

## Goals

1. A person who enabled notifications on a Mac is told about a mention or a
   seating there within seconds, whether or not Rally is running, and clicking
   the notification opens that work stream (or private child) in Rally.
2. Nobody is told about their own doing, about a work stream they can no longer
   see, or on a device they signed out of. The access fence the intent pipeline
   performs is run again at the moment of sending, not only when the intent was
   decided, and a registration lives only as long as a session that was made
   from that installation.
3. One device registers once per region it holds a credential for; a person with
   workspaces in both Global and EU is notified about each by the Worker that
   owns it, with that region's secrets, and no notification content crosses the
   regional boundary or enters a Queue.
4. The backend is platform-agnostic: the registry keys on `platform` and
   `topic` (bundle identifier), the payload renderer branches per platform, and
   adding iOS touches an allowlist constant and a renderer branch and nothing
   else server-side.
5. A stopped delivery is visible without tooling Rally does not have: a non-empty
   push dead-letter queue, a `/health` line saying the key is absent, a log
   reason that distinguishes *turned off* from *no session* from *never
   registered*, and one operator notice when APNs rejects the provider token.
6. The feature ships dark behind `push-notifications-enabled`, defaults off for
   everyone, and is turned on per cohort from Ace.

## Non-goals

1. **Notification presentation while Rally is frontmost with that conversation
   open.** macOS presents a remote alert itself; suppressing it needs a
   `UNUserNotificationCenter` delegate Electron does not expose, and the
   server-side presence check that would also serve iOS was deferred by the
   product owner to keep v1 simple (key design decision 13). Deferred.
2. **Dock badge or menu-bar unread count.** A local surface fed by the socket,
   not by push; deferred to its own PRD. The payload reserves `badge` for iOS.
3. **Push for anything other than mentions and seatings.** Digest summaries,
   automation completions, and access requests each have a producer that can
   feed the same queue later; none are wired here. Deferred.
4. **Per-workspace or per-work-stream notification preferences.** One device-level
   switch in v1. Mute windows and per-stream settings are their own PRD.
   Deferred.
5. **Content fetched on the device.** iOS can carry `mutable-content` and a
   Notification Service Extension that fetches the message so the payload is
   content-free; the desktop has no such extension. The payload reserves the
   flag; the extension is iOS work. Deferred.
6. **Firebase Cloud Messaging, Windows, Linux, or Web Push.** The registry's
   `transport` column admits a second provider later; nothing else is shaped for
   one now. Deferred.
7. **The APNs sandbox environment.** Developer ID builds are always
   `production`; the same key serves both environments, and a debug iOS build can
   register with `apns_environment = sandbox` when that client exists. Nothing
   sends to the sandbox host in this PRD. Deferred.
8. **A Mac App Store build.** Rejected; the app is Developer ID, and push works
   there with a Developer ID provisioning profile.

## Product behavior

**Enabling.** Settings gains a **Notifications** section, shown only when
`push-notifications-enabled` is on for the person. It holds one switch,
*Notify me on this Mac about mentions and additions*, on by default the first
time the section appears on a build that can register (key design decision 10).
Turning it on registers with APNs, posts one local confirmation notification
(*Rally will notify you here about mentions and additions*), which is what makes
macOS ask for permission, and registers the device with every region the client
holds a credential for. Turning it off deletes the registration in every region
and unregisters from APNs; the switch's position is persisted on the device,
and no launch or credential change re-registers a device whose switch is off.
The section states macOS's own permission when it is denied, with a button to
System Settings, because a registered device the system will not show alerts for
looks like a broken feature.

**Unsigned and development builds.** `electron-vite dev` and any build without
the entitlement cannot register; the section explains that notifications need
an installed release build, and nothing else changes. A packaged local build
carrying the profile works like a release.

**Receiving.** A mention produces a notification titled with the author and the
work stream (*Priya mentioned you in Launch checklist*), whose body is the
first 1,000 characters of the message text; a seating reads *Priya added you to Launch
checklist* with the objective as the body. A private child carries the child's
title. Notifications from one conversation share a thread so they group. A
redelivery of the same intent shows as one entry in Notification Center, though
a device that is sent the same intent twice is alerted twice; the consumer
therefore does not re-send to a device it has already reached.

**Clicking.** Rally comes to the front, or launches, at that work stream, through
the same deep-link path a `rallywithai://` link takes, attributed as the
`notification` entrypoint and recorded as a `push_notification` open. A
signed-out client shows the sign-in screen and keeps the link for after.

**Signing out.** A registration is bound to the sessions that made it from that
installation, and delivery requires one of them to be live. Sign-out revokes
the session, so delivery to that Mac stops whether or not the client's own
delete reached the server. Access revocation and session expiry revoke or expire
the same sessions, so a revoked person stops receiving at the next event rather
than at a reaper. A Mac whose owner has not launched Rally in thirty days
stops receiving too, because its sessions have expired and the link in the
notification could not be opened without signing in again; this is a decision,
logged as `no_live_session`, not an accident.

**Several accounts on one Mac.** A registration is per (person, installation);
signing into a different account on the same Mac disables the earlier person's
row for that token when the new one registers, so a shared machine never shows
the previous person's mentions.

**Two regions.** A person with a Global and an EU workspace sees notifications
from both; each is sent by its own region. The EU payload leaves Rally for Apple
the same way an EU mention email leaves for Resend today; see
[Regional impact](#regional-impact).

**Failure.** A device APNs reports unregistered (410) is disabled and never
retried. A payload APNs refuses (400, 413) is logged with Apple's reason and
dropped; a transport failure is retried by the Queue and dead-lettered after the
declared attempts, and a retry never re-alerts a device the earlier attempt
reached. A rejected provider token disables nothing and posts an operator
notice, because every device would fail the same way.

## Impact on the product contract

None — this refines behavior within the existing contract. A notification is a
pointer to a work stream the person already participates in, addressed at them
because they were mentioned or seated; it creates no inbox, no channel, and no
cross-workspace surface, and background workspaces still expose nothing beyond
the aggregate attention they expose today.

## Decision log

None yet.

## Key design decisions

1. **A device registers per region, and each region sends its own.** Rejected: a
   Global registry that EU calls through a bridge. Every ordinary workspace
   request already stays in its region, `users` is regional (the timezone column
   set the precedent), the desktop already walks one credential per region for
   attention reads, and a bridge would carry either EU content to Global or a
   content-free payload that defeats the feature. The cost is one row per
   region per device and one registration call per region on launch; both are
   cheap.
2. **Push rides the existing notification intent, not a new producer.** The intent
   pipeline already decides audience, fences on the recipient's directory
   projection, refuses self-notification and unlistable rooms, and settles once.
   Rejected: reading `workspace_activity_events` and deciding again, which
   would duplicate the judgement and could disagree with Slack and email.
3. **Delivery is a Queue hop that carries identifiers only, and the consumer
   re-runs the access fence.** The intent processor enqueues the region, the
   workspace, the intent id, and the recipient; the consumer reads the intent
   row back from WorkspaceDO, re-checks membership, listability, and private-child
   access exactly as the processor did, and only then renders and sends.
   [`regionalization.md`](../../regionalization.md#deployments) requires Queue
   bodies to carry opaque ids and never content, and a Queue with retries
   extends delivery well past the moment the intent was decided. Rejected:
   sending inline beside Slack, which would hold the activity consumer for N
   devices × a 5 s deadline; and a message carrying the rendered title and
   body, which would put EU content in a Queue whose jurisdiction is not
   established.
4. **Provider token auth (a team `.p8` key), not certificates.** One key serves
   every app in the team, never expires, and needs no per-app renewal, which is
   exactly what makes iOS a client-only addition. Rejected: per-app APNs
   certificates, which expire yearly and are per bundle.
5. **Electron's built-in `pushNotifications` module, no native addon.**
   Electron 43 ships `registerForAPNSNotifications()` and the
   `received-apns-notification` event. Rejected for v1: an Objective-C++ addon
   that installs a `UNUserNotificationCenter` delegate; it is the fallback if
   the spike in `design.md` finds a click on a system-presented alert does not
   reach the app.
6. **The restricted entitlement goes on the main bundle only.** Helpers keep
   their exact three entitlements; [`security.md`](../../security.md#macos-distribution-and-updates)
   already forbids `com.apple.developer.*` there, and the verifier enforces it.
7. **The payload carries the preview.** The mention email and Slack DM already
   carry the message text to a third party; a content-free push (*You were
   mentioned*) would be the one channel that says less. Rejected for v1: a
   content-free mode; it stays one renderer branch away if a region or a
   customer needs it.
8. **A separate installation id for push.** Minted once per install beside the
   session file, deliberately not the telemetry `installationId`, so a device
   row in D1 cannot be joined to the analytics subject exported to PostHog.
9. **Send-then-record per device, and a redelivery skips devices already
   reached.** A crash between a send and its record may send once more; that is
   the rare case, and the collapse id keeps Notification Center to one entry.
   A Queue retry for one device's transient failure is not rare, so the
   consumer skips any device whose `last_delivery_at` is at or after the
   message's enqueue time. Rejected: a receipt written before the send, which
   loses the notification on a crash after the write, the worse failure.
10. **On by default when the section first appears.** The digest is on by
    default for the same reason: nobody should have to find a settings screen to
    be told what they missed, and macOS gates delivery behind its own permission
    prompt anyway, so the default cannot surprise anyone who declined there.
    Rejected: off by default, which would make the feature invisible to the
    people the rollout is measured on. The product owner can overturn this in
    the decision log.
11. **A registration is bound to sessions, not to the person.** Every
    workspace credential on an installation that registers adds its session id
    to the registration, and sending requires one of those sessions to be live.
    Rejected: any live session of the person as the witness, which would keep an
    abandoned or shared Mac eligible for as long as the person's phone is signed
    in, and would make the client's sign-out delete the only thing ending
    delivery, at the moment it is least reliable.
12. **Push and Slack are both sent when available; email only when neither
    reached anyone.** Product owner's decision, 2026-09-11. Push is device-local
    and Slack is a channel the person chose by linking, so the two do not
    compete; email is the channel of last resort it already is. "Reached" for
    push means the intent was enqueued with at least one live device, since
    APNs delivery is best effort. Rejected: email regardless, which would tell a
    person three times.
13. **No presence suppression in v1.** Product owner's decision, 2026-09-11:
    keep it simple. A person with the conversation open on their Mac sees the
    system alert for it. The server-side check against WorkspaceDO viewer
    presence stays the likely later answer because it would serve iOS too, and
    it is one condition in the consumer when wanted.
14. **The preview is 1,000 characters.** Product owner's decision, 2026-09-11.
    `PUSH_BODY_PREVIEW_CHARACTERS = 1000` in `@rally/contracts`, a product
    limit cited to this PRD; the renderer's fit to Apple's 4,096-byte payload
    ceiling remains beneath it as the protocol floor for titles, links, and
    multi-byte text that would otherwise overflow.

## Data model

Regional D1, both regions, one migration:

| Table | Purpose |
| --- | --- |
| `user_push_devices` | One row per (person, installation, transport) in this region: `platform` (`macos`, `ios`), `transport` (`apns`), `topic` (bundle id, checked against the allowlist in `@rally/contracts`), `apns_environment`, `token`, `app_version`, `last_seen_at`, `last_delivery_at`, `last_failure_code`/`_at`, `disabled_at`/`disabled_reason`. |
| `user_push_device_sessions` | The sessions that registered this device, one row per (device, session); liveness at send time is a join through it to `sessions`. |

No WorkspaceDO table changes. The intent row already records the terminal
outcome and keeps the effect payload for thirty days, which is what the
consumer reads content from; the device row records the last delivery and
failure per device; structured logs carry the per-send evidence. `design.md`
has the DDL.

## Regional impact

Registrations, sends, and secrets are regional. The `.p8` key is set in each
region separately, as `DAYTONA_API_KEY` is. The Queue message carries the
region and opaque ids only; content is read from the regional WorkspaceDO by
the regional consumer and leaves the region only for Apple, which is the same
class of boundary crossing as the mention email through Resend and the Slack
DM. Nothing about a device crosses the regional identity bridge. Read
[`regionalization.md`](../../regionalization.md) before changing that.

## Security and trust model

- The APNs key is a Worker secret in each region, sent as a bearer token in a
  header to a fixed Apple host, never in a URL (automatic tracing exports
  `url.full`). The logger's redaction covers it. The minted provider token is
  shared between isolates through the regional KV namespace so the team's mint
  cadence stays inside Apple's window; it is a bearer credential with a
  one-hour life and is stored nowhere else.
- A device token is a capability to make one device show text; it is stored
  regionally, never logged, and never returned to any client.
- Registration needs a live workspace session in that region; the row is keyed
  by the session's person and bound to the session. A client can register only
  topics on the allowlist and only for itself.
- The consumer re-runs the access fence and the session-liveness join at send
  time; a revoked person, a left room, or a signed-out device stops receiving
  without waiting for a reaper or trusting a client-side delete.
- The payload contains the same text the email would, plus a canonical link the
  client already validates before following. No token, ticket, or credential
  rides in it.
- The provisioning profile embeds in `Rally.app`; the release verifier asserts
  its bundle id, team, entitlement, and expiry, because an expired Developer ID
  profile can stop installed copies launching.

## Provider configuration

Work outside the repository, in this order. Nothing on the desktop can be
released before items 1 to 4 exist, and nothing on the backend can send before
5 and 6 do.

**Apple Developer account (team `7ZLT6A8W25`).**

1. **App ID.** Certificates, Identifiers & Profiles → Identifiers →
   `ai.rallywith.desktop` (register it as an explicit App ID if notarization
   never needed one; a wildcard cannot carry push) → enable **Push
   Notifications** *and* **Associated Domains**. The second is for
   [https work-stream links](../2026-09-11_https-work-stream-links/prd.md),
   which ship after push; enabling it now means that PRD needs no second
   profile, secret, or release to unlock its entitlement. When the iOS app
   exists: the same two on its App ID. Nothing else Apple-side is per app.
2. **APNs authentication key.** Keys → create one with **Apple Push
   Notifications service (APNs)** enabled. Download the `.p8` once (Apple does
   not offer it again) and record the **Key ID**. Store both in the team's
   secret store. The key is team-wide, does not expire, and serves the Mac app
   and every future iOS app.
3. **Developer ID provisioning profile.** Profiles → create → **Developer ID**
   (under *Distribution*, not *Mac App Store*) → App ID `ai.rallywith.desktop`
   → the Developer ID Application certificate already used for signing →
   download the `.provisionprofile`. It carries both capabilities from step 1;
   the app declares only `aps-environment` until the links PRD adds
   `associated-domains`, and a profile may carry a capability the app does not
   yet claim. Record its **expiry date** in the runbook beside the signing
   certificate's: Apple states an installed Developer ID app using a profile for
   advanced capabilities must keep a valid profile to run, so renewal is a
   release, not a chore.
4. **Notification authorization.** No portal work: macOS asks the person the
   first time Rally posts a notification.

**GitHub (`release-desktop-macos.yml`, environment `desktop-release`).**

5. Repository secret `RALLY_MAC_PROVISIONING_PROFILE` = base64 of the
   `.provisionprofile`. The workflow decodes it to `$RUNNER_TEMP` beside the
   notarization key and exports its path for `mac.provisioningProfile`; the
   packager refuses a release build without it, the way it refuses one
   without `CSC_NAME`.

**Cloudflare (both regions, per [`runbook.md`](../../runbook.md)).**

6. **Secrets**, set separately per region as `DAYTONA_API_KEY` is:
   `APNS_AUTH_KEY` (the PEM text of the `.p8`) and `APNS_KEY_ID`, with
   `wrangler secret put` against `wrangler.global.jsonc` and again against
   `wrangler.eu.jsonc`. The team id is a constant in the code. Neither is
   required by the env contract; a region without them reports
   `pushDelivery: not configured` and skips.
7. **Queues.** `avalon-global-push-deliveries`, `avalon-eu-push-deliveries`, and
   their `-dead-letter` queues are declared in the Wrangler files;
   `deploy-api.yml` creates the missing ones before migrations. Verify with
   `scripts/ensure-cloudflare-queues.mjs`.
8. **D1 migration.** Applied by `deploy-api.yml` to both regional databases in
   the ordinary chain; nothing manual.
9. **KV.** The provider-token cache uses the regional KV namespace each API
   Worker already binds; no new namespace.
10. **Flag.** `push-notifications-enabled` is created in Flagship by Ace's
    deploy once the flag lands in code; targeting rules are written in Ace,
    staff first.

**Local development.** `pnpm env:sync` copies `APNS_AUTH_KEY` and
`APNS_KEY_ID` from `.env.local` into `.dev.vars.*` for anyone who has them; a
local Worker still answers `skipped` (the `APP_ENV` guard), which is deliberate.
End-to-end verification is against the deployed staff cohort, with a locally
packaged build that carries the profile.

## Rollout

Ships behind **`push-notifications-enabled`**, a client-visible product flag that
defaults off for everyone and is registered in Ace in the change that introduces
it. The same flag gates delivery server-side, the way `digests-enabled` does,
so an operator turning it off stops sends as well as hiding the section. The
Apple-side configuration and the profile-carrying desktop release land before
any flag is turned on, staff first, then per workspace.

The build starts with the spike `design.md` § The spike describes, because two
of its questions decide the click strategy and the provider-token cadence, and
both are cheaper to learn on a Mac with a `.p8` than in a deployed region.
The backend lands dark first, then the producer, then the desktop and its
packaging; a `plan.md` with the phase gates follows approval, per
[`prds.md`](../../prds.md).

Turning it off: the flag. Backing out fully: revert the transport branch in the
intent processor; the migration and queues stay, empty and harmless.

## Acceptance

1. On a release build with the section enabled, a mention from another account
   shows a macOS notification within a few seconds with Rally quit; clicking it
   launches Rally at that work stream.
2. The same with Rally running in the background; the notification is shown
   once.
3. A seating shows the seating notification; a mention in a private child
   opens the child.
4. Turning the switch off, then a mention: nothing is shown; the row is gone in
   both regions; a relaunch registers nothing.
5. Sign out, then a mention: nothing is shown, including when the client's
   delete is made to fail; sign back in: notifications resume.
6. Leave a work stream after a mention in it is enqueued and before the
   consumer runs: nothing is shown; the log says `access_revoked`.
7. A person with a Global and an EU workspace is notified from both.
8. `/health` reports `pushDelivery` as configured in both regions; the
   dead-letter queues are empty after the run.

## Open questions

1. **How far ahead of profile expiry the verifier refuses to release.** A
   defensive number; the verifier is written with the value open and hands it
   back.
