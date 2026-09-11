# Apple push notifications — plan of action

> Companion to [`prd.md`](prd.md) and [`design.md`](design.md). Phases in
> build order, each with an acceptance gate; then the deployment checklist,
> which is the part that cannot be done from this repository. One pull request
> per phase is the intended grain; phases 1–3 can be built in parallel once
> phase 0 answers its questions.

## Phase 0 — Spike the two things only a real Mac can answer

Time-boxed, on a developer Mac with a locally packaged signed build carrying a
Developer ID profile (see the checklist for how to get one).

1. `pushNotifications.registerForAPNSNotifications()` resolves with a token on
   a build with the entitlement and profile, and rejects on `electron-vite dev`.
2. With the app quit, a hand-sent alert push (any APNs CLI or a 20-line
   script with the `.p8`) shows a macOS notification; clicking it launches
   Rally. Record what reaches the main process: does
   `received-apns-notification` fire after `ready` with the payload? Does
   anything else?
3. With the app running in the background, the same push: the system shows the
   alert once; `received-apns-notification` fires on receipt; does it fire
   again on click, with the same `userInfo`?
4. Does posting one local Electron `Notification` trigger macOS's permission
   prompt, and does a remote alert display once permission is granted?

**Gate:** a one-page note in this folder (`research.md`) recording the four
answers with the Electron and macOS versions, and the click strategy chosen
from `design.md` (a), (b), or (c). If (c), the addon becomes phase 3's first
task, built like `unified-log.node`.

## Phase 1 — Backend primitives: registry, transport, renderer, consumer

Everything server-side, dark; no producer feeds it yet.

1. Contracts in `@rally/contracts`: schemas, `APNS_TOPICS`,
   `PUSH_BODY_PREVIEW_CHARACTERS` (open), `pushNotificationsEnabled` on the
   feature-flag response.
2. D1 migration `user_push_devices` in `packages/db/migrations/`, and its row in
   [`data-model.md`](../../data-model.md).
3. `push-device-service.ts` and `/push-devices` routes on `protectedApi`.
4. `apns-transport.ts`: JWT minter, cache, request, outcome table, skips,
   `pushDeliveryConfigured` for `/health`.
5. `push-payload.ts`: renderer per platform.
6. `push-delivery-consumer.ts`, queue declarations in both Wrangler files,
   dispatch in `worker-events.ts`, `PUSH_DELIVERY_QUEUE` and the two secrets
   typed in `env.ts`, `.env.example` and `sync-dev-env.mjs` updated.
7. Flag `push-notifications-enabled` in `client-feature-flags.ts`, plus a
   shared `push-flags.ts` the consumer and producer both call, registered in
   Ace in all three places ([`feature-flags.md`](../../feature-flags.md#adding-a-flag)).
8. Docs: a new `docs/push-notifications.md` to the module-document shape,
   registered in `docs/README.md`, with its first changelog entry; a row in
   `runbook.md` for the secrets and health line; `security.md` secrets
   paragraph.
9. Tests per `design.md` § Testing, with the two prove-it-can-fail runs.

**Gate:** deployed to both regions with the queues created and secrets set;
`/health` shows `pushDelivery: configured` in both; a hand-inserted device row
and a hand-enqueued message (from the engineering MCP, or a temporary operator
route) produce a notification on the spike Mac; the dead-letter queues are
empty.

## Phase 2 — Producer: the notification intent feeds the queue

1. In `processWorkstreamNotificationIntent` (`conversation-effect-service.ts`),
   after the self-notification check: build the `PushNotificationIntent` from
   the effect (title, body preview, `rally.url` from `workstream-links.ts`,
   `threadKey` = parent id or child id, `collapseKey` = intent id), count live
   devices, and `PUSH_DELIVERY_QUEUE.send`. Log
   `workstream_notification_transport_terminal channel=push outcome=enqueued|no_devices`.
2. Apply the answer to open question 1 (email fallback) — one condition on
   the existing sequencing, recorded in the decision log.
3. Apply the answer to open question 2 (presence suppression) if it is in
   scope, or record the deferral.
4. Update the producers table in [`digests.md`](../../digests.md) and the
   transport paragraph in
   [`workstream-durable-object.md`](../../workstream-durable-object.md), each
   with a changelog entry.
5. `test-workers/participant-notification.test.ts` and the mention suite gain
   the enqueue assertions; break the enqueue and watch them fail.

**Gate:** with the flag on for a staff cohort and the spike Mac's row present,
a real mention and a real seating each produce one notification; a self-mention
produces none; a mention in a work stream the recipient left produces none.

## Phase 3 — Desktop: registration, settings, click routing, packaging

1. `push-notifications.ts` in the main process: availability, installation id,
   the per-region registration loop, delete on switch-off and sign-out,
   `received-apns-notification` handling, and the click strategy from phase 0.
   IPC and preload surface for the settings state, added to the renderer's
   typed bridge.
2. Settings → Notifications section, its three states, search registration,
   and the flag gate. A component test for each state, and a screenshot of each
   under Xvfb per [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it)
   — the section is a visible change.
3. Entitlement, `provisioningProfile` in both builder configs, the workflow
   secret and env, `verify-macos-app.mjs` assertions with
   `PROVISIONING_PROFILE_MINIMUM_REMAINING_DAYS` open, and `test:release`
   fixtures. `security.md` § macOS distribution and `runbook.md`'s release
   section gain the profile, its expiry, and how to renew it.
4. `applicationOpenObserver.opened('push_notification')` on click, closing the
   TODO in `index.ts`.
5. Docs: the desktop half in `docs/push-notifications.md`; `menu-bar.md`'s
   request-helper note if the helper moves; `settings-search.md` if a new
   provider is added.

**Gate:** a release build from `main` passes the verifier, notarizes, and
installs; the acceptance list in `prd.md` passes end to end on two Macs with
two accounts, one of them holding a Global and an EU workspace.

## Phase 4 — Turn it on, and hand back the numbers

1. Flag on for staff; a week of use; dead-letter queues and
   `push_delivery_terminal` outcomes reviewed once.
2. The handover report: `PUSH_BODY_PREVIEW_CHARACTERS`, `apns-expiration`,
   `PROVISIONING_PROFILE_MINIMUM_REMAINING_DAYS`, the consumer batch settings,
   and the `notifyOps` cadence for provider-token failures, each with the
   arithmetic, per
   [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md#the-handover-report).
3. Flag on per workspace. `state.md` to completed; the PRD freezes and the
   module document's changelog takes over.

## Deployment checklist

Work outside the repository, in order. Nothing in phase 3 can be released
before items 1–4 exist, and nothing in phase 1 can send before 5–7 exist.

### Apple Developer account (team `7ZLT6A8W25`)

1. **App ID.** Certificates, Identifiers & Profiles → Identifiers →
   `ai.rallywith.desktop` (register it as an explicit App ID if notarization
   never needed one; a wildcard cannot carry push) → enable **Push
   Notifications** *and* **Associated Domains**. The second is for
   [https work-stream links](../2026-09-11_https-work-stream-links/prd.md),
   which ship after push; enabling it now means that PRD needs no second
   profile, secret, or release to unlock its entitlement. (When the iOS app
   exists: the same two on its App ID. Nothing else Apple-side is per app.)
2. **APNs authentication key.** Keys → create one with **Apple Push
   Notifications service (APNs)** enabled. Download the `.p8` once — Apple does
   not offer it again — and record the **Key ID**. Store the file in the team's
   secret store. This key is team-wide and does not expire; it serves the Mac
   app and every future iOS app.
3. **Developer ID provisioning profile.** Profiles → create → **Developer ID**
   (under *Distribution*, not *Mac App Store*) → App ID `ai.rallywith.desktop`
   → the Developer ID Application certificate already used for signing →
   download the `.provisionprofile`. It carries both capabilities from step 1;
   the app declares only `aps-environment` until the links PRD adds
   `associated-domains`, and a profile may carry a capability the app does not
   yet claim. Record its **expiry date** in the runbook
   beside the signing certificate's: Apple states an installed Developer ID app
   using a profile for advanced capabilities must keep a valid profile to run,
   so renewal is a release, not a chore. Renewing means a new profile file, a
   new repository secret, and a release.
4. **Notification authorization.** No portal work: macOS asks the person the
   first time Rally posts a notification.

### GitHub (`.github/workflows/release-desktop-macos.yml`, environment `desktop-release`)

5. Repository secret `RALLY_MAC_PROVISIONING_PROFILE` = base64 of the
   `.provisionprofile`. The workflow decodes it to `$RUNNER_TEMP` beside the
   notarization key and exports its path for `mac.provisioningProfile`; the
   packager refuses a release build without it, the way it refuses one
   without `CSC_NAME`.

### Cloudflare (both regions, per [`runbook.md`](../../runbook.md))

6. **Secrets**, set separately per region as `DAYTONA_API_KEY` is:
   ```bash
   pnpm exec dotenv -e .env.local -- pnpm --filter @rally/api exec wrangler secret put APNS_AUTH_KEY --config wrangler.global.jsonc
   pnpm exec dotenv -e .env.local -- pnpm --filter @rally/api exec wrangler secret put APNS_KEY_ID  --config wrangler.global.jsonc
   # and again with --config wrangler.eu.jsonc
   ```
   `APNS_AUTH_KEY` is the PEM text of the `.p8`. The team id is a constant in
   the code. Neither is required by the env contract; a region without them
   reports `pushDelivery: not configured` and skips.
7. **Queues.** `avalon-global-push-deliveries`, `avalon-eu-push-deliveries`, and
   their `-dead-letter` queues are declared in the Wrangler files;
   `deploy-api.yml` creates the missing ones before migrations. Verify with
   `scripts/ensure-cloudflare-queues.mjs` and the migration-tracker preflight
   ([`durable-object-migration-tracking.md`](../../durable-object-migration-tracking.md)).
8. **D1 migration.** Applied by `deploy-api.yml` to both regional databases in
   the ordinary chain; nothing manual.
9. **Flag.** `push-notifications-enabled` is created in Flagship by Ace's
   deploy (`apps/ace/scripts/deploy.mjs`) once phase 1 merges; targeting rules
   are written in Ace, staff first.

### Local development

10. `pnpm env:sync` copies `APNS_AUTH_KEY` and `APNS_KEY_ID` from `.env.local`
    into `.dev.vars.*` for anyone who has them; a local Worker still answers
    `skipped` (the `APP_ENV` guard), which is deliberate. End-to-end
    verification is against the deployed staff cohort, with a locally packaged
    build that carries the profile
    (`electron-builder.local.yml` → `provisioningProfile`).

## What this plan does not decide

The five open questions in `prd.md`. Questions 1, 2, and 4 are the product
owner's and should be answered before phase 2; 3 and 5 are numbers handed back
in phase 4.
