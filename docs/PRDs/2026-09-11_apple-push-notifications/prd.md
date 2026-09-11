# Apple push notifications

> Created 2026-09-11.
>
> Rally tells a person about a mention or a seating on the Apple devices they
> have signed in from, through the Apple Push Notification service (APNs),
> starting with the macOS desktop client and built so an iOS client registers
> into the same backend without a second delivery path. Companions:
> [`design.md`](design.md) (the primitives, schema, payload, transport, and
> desktop mechanics), [`plan.md`](plan.md) (phases, deployment checklist, and
> acceptance gates). Standing contract:
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
devices per region, and a queue-fed delivery service that renders an intent into
a provider payload and sends it. The macOS client is its first registrant. An
iOS client registers into the same route with a different platform value, and
the same delivery service, key, and queue serve it.

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
   see, or about a device they signed out of. The revalidation the intent
   pipeline already performs applies to push unchanged, and a sign-out ends
   delivery to that device in every region.
3. One device registers once per region it holds a credential for; a person with
   workspaces in both Global and EU is notified about each by the Worker that
   owns it, with that region's secrets, and no notification content crosses the
   regional boundary.
4. The backend is platform-agnostic: the registry keys on `platform` and
   `topic` (bundle identifier), the payload renderer branches per platform, and
   adding iOS touches an allowlist constant and a renderer branch and nothing
   else server-side.
5. A stopped delivery is visible without tooling Rally does not have: a non-empty
   push dead-letter queue, a `/health` line saying the key is absent, and one
   operator notice when APNs rejects the provider token.
6. The feature ships dark behind `push-notifications-enabled`, defaults off for
   everyone, and is turned on per cohort from Ace.

## Non-goals

1. **Notification presentation while Rally is frontmost with that conversation
   open.** macOS presents a remote alert itself; suppressing it needs a
   `UNUserNotificationCenter` delegate Electron does not expose. Deferred; the
   server-side presence check in [Open questions](#open-questions) is the likely
   answer and works for iOS too.
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
time the section appears on a build that can register. Turning it on registers
with APNs, posts one local confirmation notification (*Rally will notify you
here about mentions and additions*), which is what makes macOS ask for
permission, and registers the device with every region the client holds a
credential for. Turning it off deletes the registration in every region and
unregisters from APNs. The section states macOS's own permission when it is
denied, with a button to System Settings, because a registered device the
system will not show alerts for looks like a broken feature.

**Unsigned and development builds.** `electron-vite dev` and any build without
the entitlement cannot register; the section explains that notifications need
an installed release build, and nothing else changes. A packaged local build
carrying the profile works like a release.

**Receiving.** A mention produces a notification titled with the author and the
work stream (*Priya mentioned you in Launch checklist*), whose body is the
message text cut to a preview; a seating reads *Priya added you to Launch
checklist* with the objective as the body. A private child carries the child's
title. Notifications from one conversation share a thread so they group. If
several arrive for the same intent (a Queue redelivery), APNs collapses them
under one identifier and the person sees one.

**Clicking.** Rally comes to the front, or launches, at that work stream, through
the same deep-link path a `rallywithai://` link takes, attributed as the
`notification` entrypoint and recorded as a `push_notification` open. A
signed-out client shows the sign-in screen and keeps the link for after.

**Signing out.** Sign-out removes the registration in every region before the
credentials are cleared. Access revocation, workspace departure, and session
expiry do not delete the row; the send path refuses a device whose person holds
no live session in that region, so a revoked person stops receiving at the next
event rather than at a reaper.

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
declared attempts. A rejected provider token disables nothing and posts one
operator notice, because every device would fail the same way.

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
3. **Delivery is a Queue hop.** The intent processor enqueues one message per
   (intent, recipient) and continues; a consumer resolves devices and sends.
   Per [`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md) this is
   the listed fire-and-forget case; APNs latency and retries stay out of the
   activity consumer, and the dead-letter queue is the monitoring. Rejected:
   sending inline beside Slack, which would hold the activity consumer for N
   devices × a 5 s deadline and couple every mention to Apple's availability.
4. **Provider token auth (a team `.p8` key), not certificates.** One key serves
   every app in the team, never expires, and needs no per-app renewal, which is
   exactly what makes iOS a client-only addition. Rejected: per-app APNs
   certificates, which expire yearly and are per bundle.
5. **Electron's built-in `pushNotifications` module, no native addon.**
   Electron 43 ships `registerForAPNSNotifications()` and the
   `received-apns-notification` event. Rejected for v1: an Objective-C++ addon
   that installs a `UNUserNotificationCenter` delegate; it is the fallback if
   the spike in `plan.md` finds a click on a system-presented alert does not
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
9. **Send-then-record, with APNs collapsing duplicates.** A Queue redelivery
   after a crash between send and record may send twice; the collapse id makes
   the device show one. Rejected: a receipt written before the send, which
   loses the notification on a crash after the write, the worse failure.

## Data model

Regional D1, both regions, one migration:

| Table | Purpose |
| --- | --- |
| `user_push_devices` | One row per (person, installation, transport) in this region: `platform` (`macos`, `ios`), `transport` (`apns`), `topic` (bundle id, checked against the allowlist in `@rally/contracts`), `apns_environment`, `token`, `app_version`, `last_seen_at`, `last_delivery_at`, `last_failure_code`/`_at`, `disabled_at`/`disabled_reason`. |

No WorkspaceDO table changes. The intent row already records the terminal
outcome; the device row records the last delivery and failure per device;
structured logs carry the per-send evidence. `design.md` has the DDL.

## Regional impact

Registrations, sends, and secrets are regional. The `.p8` key is set in each
region separately, as `DAYTONA_API_KEY` is. A notification's content leaves the
region for Apple, which is the same class of boundary crossing as the mention
email through Resend and the Slack DM, and is not a Global hop: EU content is
sent by the EU Worker directly to APNs. Nothing about a device crosses the
regional identity bridge. Read [`regionalization.md`](../../regionalization.md)
before changing that.

## Security and trust model

- The APNs key is a Worker secret in each region, sent as a bearer token in a
  header to a fixed Apple host, never in a URL (automatic tracing exports
  `url.full`). The logger's redaction covers it.
- A device token is a capability to make one device show text; it is stored
  regionally, never logged, and never returned to any client.
- Registration needs a live workspace session in that region; the row is keyed
  by the session's person. A client can register only topics on the allowlist
  and only for itself.
- The send path re-checks that the person still holds a live session in the
  region; a revoked person stops receiving without waiting for a reaper.
- The payload contains the same text the email would, plus a canonical link the
  client already validates before following. No token, ticket, or credential
  rides in it.
- The provisioning profile embeds in `Rally.app`; the release verifier asserts
  its bundle id, team, entitlement, and expiry, because an expired Developer ID
  profile can stop installed copies launching.

## Provider configuration

Apple Developer account (team `7ZLT6A8W25`): Push Notifications capability on
App ID `ai.rallywith.desktop`; one APNs authentication key; one Developer ID
provisioning profile with push for that App ID. GitHub: the profile as a
repository secret for the release workflow. Cloudflare: two secrets per region,
two queues per region with dead-letter queues (created by `deploy-api.yml`),
one D1 migration per region, and the flag registered in Ace. The exact steps
and order are in [`plan.md`](plan.md#deployment-checklist).

## Rollout

Ships behind **`push-notifications-enabled`**, a client-visible product flag that
defaults off for everyone and is registered in Ace in the phase that introduces
it. The same flag gates delivery server-side, the way `digests-enabled` does,
so an operator turning it off stops sends as well as hiding the section. The
Apple-side configuration and the profile-carrying desktop release land before
any flag is turned on, staff first, then per workspace.

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
   both regions.
5. Sign out, then a mention: nothing is shown; sign back in: notifications
   resume.
6. A person with a Global and an EU workspace is notified from both.
7. `/health` reports `pushDelivery` as configured in both regions; the
   dead-letter queues are empty after the run.

## Open questions

1. **Does push replace email as the fallback, or join it?** Recommendation: push
   and Slack are both sent when available, and email is sent only when neither
   reached anyone. The product owner decides; the alternative (email always) is
   one condition.
2. **Suppress the push when the recipient has that conversation open right
   now?** WorkspaceDO holds current-client viewer presence. Recommendation: yes,
   as a server-side check in the intent processor once the cost of the read is
   known, because it is the only answer that also serves iOS. Blocks nothing.
3. **The preview length.** The payload has a 4,096-byte ceiling (Apple); the
   preview cut is the team's number, per
   [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
   `design.md` writes the guard open.
4. **On by default when the section first appears, or off?** Recommendation:
   on, matching the digest, since macOS gates it behind its own permission
   prompt anyway.
5. **How far ahead of profile expiry the verifier refuses to release.** A
   defensive number; the plan writes the check with the value open and hands it
   back.
