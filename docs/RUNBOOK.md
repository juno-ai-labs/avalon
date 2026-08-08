# Operations runbook

## Local development

From the repository root:

```text
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The default Global API is `http://127.0.0.1:8787`; the optional EU development API uses port `8788`. `GET /health` checks D1, R2, Durable Objects, Queue and Workflow bindings, the one-Global-registry route, and regional inbound-email configuration, and reports other provider configuration separately.

After the API is running, use `pnpm smoke:local` for the repeatable authentication, work-stream, sidebar-data, idempotency, URL-safety, and realtime acceptance check. The complete desktop acceptance flow is documented in `docs/E2E.md`.

Local authentication is available only when all of these are true:

- `APP_ENV=development`
- `AVALON_DEV_AUTH=true`
- Electron is unpackaged

If the local account cannot sign in, run `pnpm env:sync`, confirm `.env.local` remains owner-readable, and restart both processes. Never add a development-auth value to a hosted Worker.

## Required hosted resources

Create independent resource sets for `global` and `eu`:

- A D1 database
- An R2 payload bucket
- An activity Queue and dead-letter Queue
- The Worker, Durable Object namespaces, and Workflows declared in the regional Wrangler file

The checked-in regional Wrangler files reference the provisioned Avalon resources. If a database is intentionally recreated, update only that region's `database_id` and keep the EU R2 jurisdiction and every region-specific name intact.

Set these shared Worker secrets separately in each regional deployment:

- `OPENROUTER_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_REALTIME_DEPLOYMENT`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`
- `GOOGLE_CONNECTOR_OAUTH_CLIENT_ID`
- `GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET`
- `TWITTER_API_IO_API_KEY`
- `SESSION_SIGNING_KEY`
- `OAUTH_STATE_ENCRYPTION_KEY`
- `CONNECTOR_CREDENTIALS_KEY`

Generate independent signing/encryption material per region. Cloudflare administration credentials belong only in the local deployment environment; they must never become Worker variables.

Configure the Azure values in every region where dictation is enabled. `AZURE_OPENAI_ENDPOINT` is the HTTPS resource endpoint, and `AZURE_OPENAI_REALTIME_DEPLOYMENT` is the name of an Azure deployment backed by `gpt-live-transcribe`. Azure's GA transcription contract connects to `/openai/v1/realtime?intent=transcription` and identifies that deployment in `session.audio.input.transcription.model`. Do not place any Azure value behind a `VITE_` prefix. Local development may use one unsuffixed set or `_GLOBAL` and `_EU` overrides in `.env.local`.

Apply migration `0040_realtime_transcription_admission.sql` before enabling dictation. It stores no audio or transcripts: it records consumed one-minute ticket IDs and five-minute active-session leases. The Worker permits at most two concurrent sessions per user and twenty per workspace, rejects more than thirty client frames per second, and caps PCM audio at five minutes per connection. Expired leases are removed during the next admission attempt.

Alert on `realtime_transcription_session_release_failed`. The Worker retries the idempotent D1 lease deletion before emitting this event; repeated occurrences can leave a user at the concurrency limit until the five-minute lease expires.

Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` only on the Global Worker. They belong exclusively to the platform login client and are never used by Google service connectors.

Set `RESEND_WEBHOOK_SIGNING_SECRET` and `WORKSTREAM_EMAIL_ADDRESS_KEY` only on the
Global Worker. `RESEND_API_KEY` is required in both regions with Resend's
**Full access** permission because each owning region retrieves its own full
message after the Global ingress has routed only signed metadata. An optional
`RESEND_RECEIVING_API_KEY` can override it later if Avalon returns to separate
sending and receiving credentials. All non-Global work-stream and automation
email-name reservations use
the Global `WorkstreamEmailRoutingBridge`; there is no regional allocator key or
regional fallback registry.

`RESEND_API_KEY` is shared by the two regional Workers and is used for both invitations and inbound-message retrieval. The checked-in sender is `Avalon <invites@with-avalon.com>`; keep that domain verified with its Resend DKIM/SPF records. Resend acceptance confirms that the transactional request was queued, not final inbox delivery. A provider failure revokes the newly created invitation before the API reports failure.

Inbound work-stream and automation mail uses the dedicated catch-all subdomain `automation.with-avalon.com`. Create it with Resend Receiving enabled, install the exact MX record returned by Resend in Cloudflare DNS, and create one `email.received` webhook pointing to `https://api.with-avalon.com/ingest/resend`. Store its `whsec_...` value as the Global `RESEND_WEBHOOK_SIGNING_SECRET`. Ensure the reused `RESEND_API_KEY` has Full access in both regions because the regional Worker retrieves the full received message after routing. Store one stable 32+ byte `WORKSTREAM_EMAIL_ADDRESS_KEY` in the Global Worker. Do not log any of these values. Existing deployments using `RESEND_WEBHOOK_SECRET` remain compatible during migration.

For non-interactive Wrangler commands, prefer `CLOUDFLARE_API_TOKEN`. The older global-key method requires both `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL` in `.env.local`; an API key by itself cannot authenticate a deployment.

Use a custom token restricted to the Avalon Cloudflare account and the `with-avalon.com` zone. The deployment and migration workflow needs these permissions:

- Account: Account Settings Read
- Account: Workers Scripts Write (shown as Edit in older dashboards)
- Account: D1 Write/Edit
- Account: Workers R2 Storage Write/Edit
- Account: Queues Write/Edit
- Zone `with-avalon.com`: Zone Read
- Zone `with-avalon.com`: Workers Routes Write/Edit

Do not grant DNS, billing, user-management, API-token-management, or account-wide zone access. Rotate any broader bootstrap token after provisioning.

Keep Cloudflare's zone-level **Always Use HTTPS** setting enabled. Keep HTTP Strict
Transport Security enabled with a one-year `max-age`, `includeSubDomains`, and
`nosniff`; do not enable HSTS preload until the domain has completed the separate
preload-readiness review. Release verification must confirm that the site, both API
origins, and the downloads origin redirect cleartext HTTP to HTTPS and return the
expected `Strict-Transport-Security` header over HTTPS.

## Deployment order

### Release version policy

Every new Avalon release advances exactly one minor version and resets the patch to zero. The one stable-promotion exception permits a `0.x` release to advance to `1.0.0`; after that, releases continue by minor version (`1.0.0` → `1.1.0`). Do not create patch releases, prereleases, skip a minor, or make any other major-version jump. Immediately after a verified publication, move the root and desktop package versions to the next minor development version. Leave `apps/site/release.config.json` on the currently published version until the immutable desktop artifacts and update feed for the next version have been uploaded and verified. The release tag and site-promotion tooling enforce this policy and allow the same published version only for an idempotent retry.

### Desktop release retention

Keep the five highest semantic versions in the public `avalon-desktop-releases`
R2 bucket. Move every older complete release to the private
`avalon-desktop-releases-archive` bucket in the same WNAM location. The archive
bucket's default storage class is `InfrequentAccess`; keep its `r2.dev` URL
disabled and do not attach a custom domain. Infrequent Access has retrieval
charges and a 30-day minimum storage duration, so it is appropriate only for
release artifacts that are rarely restored. See Cloudflare's
[storage-class](https://developers.cloudflare.com/r2/buckets/storage-classes/)
and [pricing](https://developers.cloudflare.com/r2/pricing/) documentation.

Create the archive bucket only if it does not already exist:

```text
pnpm dotenv -e .env.local -- pnpm --filter @avalon/api exec wrangler r2 bucket create avalon-desktop-releases-archive --location wnam --storage-class InfrequentAccess
pnpm dotenv -e .env.local -- pnpm --filter @avalon/api exec wrangler r2 bucket info avalon-desktop-releases-archive
```

Use the live R2 inventory as the retention authority. Do not derive the keep set
from Git tags, `apps/site/release.config.json`, upload timestamps, or local
release directories; any of those can lag a completed publication. Under
`stable/darwin/arm64/`, one complete release currently has five immutable
objects:

- A versioned DMG
- A versioned ZIP
- The DMG and ZIP blockmaps
- `<version>/SHA256SUMS`

`stable/darwin/arm64/Avalon.dmg` and
`stable/darwin/arm64/latest-mac.yml` are mutable channel pointers, not releases.
They must always remain in the public bucket.

Production retention is automated by the private `avalon-release-retention`
Worker in `apps/release-retention`. It has no route, `workers.dev` URL, preview
URL, or application secret. Its only capabilities are bindings to the active and
archive release buckets. Deploy it from the repository root with:

```text
pnpm deploy:release-retention
```

Cloudflare Cron Triggers execute in UTC. The checked-in configuration therefore
fires at both `0 9 * * *` and `0 10 * * *`, while the handler admits only the
invocation whose scheduled time is 02:00 in `America/Los_Angeles`. This produces
one run at 02:00 Pacific under both PST and PDT. On the spring-forward night,
when 02:00 does not exist, the 10:00 UTC invocation runs once at 03:00 Pacific.
The other daily invocation logs `desktop_release_retention_skipped` and exits.
Do not replace the two expressions with one fixed UTC hour. Cron changes can
take up to 15 minutes to propagate. See Cloudflare's
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
documentation.

Each admitted invocation performs this fail-closed transaction:

1. Page through every active object under `stable/darwin/arm64/`. Parse and sort
   semantic versions, require all five immutable objects for every release, and
   require the two mutable pointers. An unexpected, duplicate, or incomplete
   key aborts the run before any copy or deletion.
2. Select all versions older than the highest five. For each exact candidate
   key, stream the source object into the archive with its HTTP and custom
   metadata and `InfrequentAccess`. A matching existing archive object is reused
   without another write, which keeps retries idempotent and avoids resetting
   the archive storage-duration clock.
3. Before deleting anything, require the archive copy to have the same key,
   size, ETag, HTTP metadata values, and custom metadata values as the source,
   and require its storage class to be `InfrequentAccess`.
4. Re-list the active bucket immediately before deletion. Abort without deleting
   if any key, metadata, ETag, release grouping, or retained-version decision
   changed while copies were in progress. This protects a release that races the
   nightly job.
5. Delete only the computed, verified candidate-key array. Re-list both sides,
   require exactly five complete releases plus `Avalon.dmg` and
   `latest-mac.yml` in active storage, prove every candidate is absent from the
   active bucket, and prove its verified archive copy remains present.

The Worker calls `noRetry()` so Cloudflare cannot start a concurrent automatic
retry after a partial failure; the next nightly invocation safely reuses any
verified archive copies. A successful admitted run logs
`desktop_release_retention_completed` with its plan and copy/delete counts. An
exception is a failed Cron event and must be investigated before manually
deleting any object.

Before deploying a change, run:

```text
pnpm --filter @avalon/release-retention test
pnpm --filter @avalon/release-retention typecheck
pnpm --filter @avalon/release-retention build
```

Exercise the real scheduled handler against the remote buckets without writes
by starting Wrangler with the dedicated `wrangler.dry-run.jsonc` configuration.
That configuration pins `RETENTION_DRY_RUN=true` and is the only checked-in
configuration whose development bindings access the remote buckets:

```text
pnpm dotenv -e .env.local -- pnpm --filter @avalon/release-retention dev:dry-run
curl "http://localhost:8799/cdn-cgi/handler/scheduled?cron=0+9+*+*+*&time=1786093200000&format=json"
```

The timestamp above simulates 02:00 PDT on 2026-08-07. Require an `ok` outcome
and a structured completion log with `dryRun: true`. After deployment, preserve
the Wrangler output showing both Cron Triggers and inspect Workers & Pages →
`avalon-release-retention` → Cron Events after the next window. Alert on failed
events, unexpected `dry-run` production reports, a non-five retained set, or any
copy/delete count that does not match the plan.

For a one-off repair, set `RETENTION_DRY_RUN` to `true` in the checked-in Worker
configuration, deploy, and inspect one scheduled plan before authorizing live
mode. Do not run ad hoc deletion commands while the scheduled Worker is enabled.
If manual copying is unavoidable, preserve metadata and explicitly set
`InfrequentAccess`, verify the exact objects as described above, and disable the
Cron Triggers for the whole maintenance window.

R2 aggregate object-count and bucket-size counters can lag object operations.
Use successful object-list, HEAD, and GET checks as the completion authority;
do not repeat a migration merely because `wrangler r2 bucket info` has stale
totals.

To restore an archived release, copy its five objects back to the public bucket
as `Standard` storage while preserving metadata, then repeat the key, size,
ETag/hash, and public HEAD verification. Restoring immutable objects does not
change the update channel. Change `latest-mac.yml` or `Avalon.dmg` only as a
separate, explicitly approved release rollback using the normal publisher's
ordering and cache-purge safeguards.

### Desktop icon release gate

If desktop icon artwork, generated icon assets, or the icon-family configuration changed, follow [Desktop application icons](DESKTOP_ICONS.md). Regenerate the assets, build the guarded local desktop package, and verify the running Dock icon in both light and dark macOS appearances before creating a release build. Also inspect Finder to confirm the static bundle icon remains correct.

Current production status: the site, both regional APIs, and the private nightly `avalon-release-retention` Worker are deployed. The retention Worker keeps the five newest complete desktop releases active and archives older releases to private Infrequent Access storage at 02:00 Pacific. Migrations through `0026_bind_runtime_durability.sql` are live in both D1 databases, and both regional infrastructure health checks pass. Firecrawl, Resend invitation delivery, and work-stream and automation inbound email on `automation.with-avalon.com` are configured. Google identity OAuth is configured only on the Global Worker; the separate Google connector OAuth client is configured in both regions, and credentials issued by the former shared client were invalidated during the cutover. Expanded API enablement, consent-screen review, and human acceptance of both Google presets remain release gates. The public `Avalon Workstreams` GitHub App and public Linear app are registered with their regional secrets, callbacks, and ingress deployed. Notion provider-owned registration and secrets remain to be completed using `docs/PROVIDER_APPS.md`. Human test-account identity, cross-region invitation, connector, and inbound-email acceptance runs remain release gates.

Deploy the EU Worker first for ordinary releases because the Global Worker has named service bindings to EU entrypoints. The first release that introduces work-stream inbound email is a special, compatibility-staged rollout: Global must export `WorkstreamEmailRoutingBridge` before EU can bind to it, while Global must not require `InboundEmailRegionalBridge` until EU exports that entrypoint. Use a bootstrap Global deployment with the new router export and without the `EU_INBOUND_EMAIL_BRIDGE` binding, deploy the full EU Worker, then deploy the full Global Worker. Never deploy either caller before its target entrypoint exists. Apply migrations to both D1 databases before the staged Worker rollout.

For ordinary releases after both entrypoints exist:

1. Validate both Wrangler configurations with dry-run builds.
2. Create or confirm each region's named Cloudflare resources. Scoped memory requires `avalon-global-memory` and `avalon-eu-memory` Vectorize indexes with 1,024 dimensions and cosine distance, plus the Workers AI binding declared by each API Worker.
3. Confirm each configured D1 ID belongs to the intended region.
4. Set the regional Worker secrets.
5. Apply the D1 migration remotely to EU and Global with `pnpm db:migrate:remote:eu` and `pnpm db:migrate:remote`. Inspect the pending set first with `pnpm db:migrate:remote:list:eu` and `pnpm db:migrate:remote:list`. The unsuffixed `pnpm db:migrate` targets local Wrangler state only and never touches a hosted database.
6. Deploy the EU Worker, then the Global Worker. For the first inbound-email release only, use the three-stage bootstrap order above.
7. Call `GET /health` on both regional APIs with `pnpm health:regions`, which fails unless both regions report `ok`.
8. Send a workspace invitation to a real test inbox, confirm Resend accepts it, and complete the one-time email-bound acceptance flow.
9. Complete one Google identity login in a provider test account.
10. Connect **Google Mail + Calendar** and verify a Gmail read, Gmail draft, Calendar read, and Calendar test-event create/update. Delete the provider-side test fixture afterward.
11. Connect **Google Drive + Docs + Sheets** and verify a Drive read, native Docs read/write, and native Sheets read/write against disposable fixtures.
12. Establish the Drive poll baseline, change the test Doc and Sheet, poll again, and confirm `docs.document_changed` and `sheets.spreadsheet_changed` arrive through Drive change-token polling.
13. Create an automation, run it manually, and verify that a single work stream and run record are reused across a retry.
14. After every successful deployment, run the configured Gitleaks gate, commit the complete verified release transaction, and push the authorized current branch. A deployment is not complete until its source and release metadata are present on the remote. Never stage `.env.local`, generated release bundles, dependency directories, or local Cloudflare state.

Use `pnpm deploy:global` and `pnpm deploy:eu` to publish the regional Workers after the infrastructure prerequisites are satisfied. Do not mark Google capabilities release-ready until the provider credentials and APIs are configured, provider verification is complete where required, and steps 9–12 pass. A failed regional health check blocks desktop distribution for that region.

### Automated workflows

Three GitHub Actions workflows carry the mechanical part of this procedure. They are the same commands documented above, so a local operator run and a workflow run remain interchangeable.

- `.github/workflows/ci.yml` runs on every pull request and on `main`: lint, typecheck, the full test suite, both Wrangler dry-run builds, the desktop release invariants, and the Gitleaks gate over the full history.
- `.github/workflows/deploy-api.yml` performs steps 1 and 5–7: dry-run validation, remote D1 migrations, the EU-then-Global Worker deployment, and the regional health check. It runs automatically on every merge to `main` that touches `apps/api`, `packages` (including `packages/db/migrations`), the lockfile, the workspace file, or the workflow itself; documentation, desktop, and site-only merges do not redeploy. A `workflow_dispatch` run can additionally restrict the regions, skip the migration step, and deploy an arbitrary ref. It does not create resources, confirm regional D1 IDs, or set Worker secrets — steps 2–4 stay manual and one-time — and it must not be used for the three-stage inbound-email bootstrap or any other release that introduces a new cross-region entrypoint. Those are deployed by hand in the documented order, which means holding such a change out of `main` until the staged rollout is complete.
- `.github/workflows/release-desktop-macos.yml` runs on a `v*` tag: it guards the tag, builds, signs, notarizes, staples, and verifies the macOS package, checks both regional APIs, publishes the immutable payloads, promotes the release manifest, and deploys the landing site. The health gate can be bypassed only through the `skip_health_gate` dispatch input.

Required repository configuration: secret `CLOUDFLARE_API_TOKEN` and variable `CLOUDFLARE_ACCOUNT_ID` in the `api-production` environment for the API deployment, and the existing `desktop-release` environment for the macOS release. Worker secrets are never held by Actions; they are set per region with Wrangler.

Deployments cannot overlap. Each workflow declares a concurrency group, so a second run waits for the first to finish, and a burst of merges collapses to the newest commit: GitHub keeps only one run pending per group and drops the superseded ones. Runs already in progress are never cancelled, so a migration cannot be interrupted halfway. Each run deploys the commit that triggered it, not the tip of `main` at the time it starts.

The one interaction the platform does not sequence is an API deployment overlapping a macOS release, because they are separate workflows. The visible symptom is the desktop release failing its regional health gate while a Worker deployment is mid-flight; re-dispatch the tag once the API run is green. Avoid tagging a desktop release in the same minutes as an API-touching merge.

Because API deployment is continuous, a merge to `main` is a production release. Do not add required reviewers to `api-production`; that environment scopes the Cloudflare token to the deployment job and is not an approval gate. Migrations apply automatically, so a migration is live the moment its pull request merges: an irreversible or destructive migration must be split into backward-compatible steps, and a rollback is a forward migration, never a redeployment of the previous Worker. A failed deployment leaves the migrations applied; recover by fixing forward on `main`.

## Provider configuration

Google identity and connector OAuth use two distinct Google Cloud OAuth **Web application** clients in one project. The **Avalon Login** client requests only platform identity scopes and has this one redirect URI:

- Global identity: `https://api.with-avalon.com/auth/google/callback`

The **Avalon Google Connectors** client owns the Gmail, Calendar, Drive, Docs, and Sheets scopes and has these redirect URIs:

- Global connector: `https://api.with-avalon.com/connections/google/callback`
- EU connector: `https://eu.api.with-avalon.com/connections/google/callback`

`https://with-avalon.com/auth/desktop/` is Avalon's browser handoff for login and connector outcomes, and `avalon://auth/complete` is the allowlisted desktop return URI. Provider codes always terminate at a regional API callback first; neither handoff URI belongs in Google's authorized redirect URI list. Identity login requests only `openid`, `email`, and `profile`.

Store the Login client as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` on the Global Worker. Store the connector client as `GOOGLE_CONNECTOR_OAUTH_CLIENT_ID` / `GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET` on both regional Workers. The connector runtime deliberately has no fallback to the login credentials.

Settings exposes two authorization presets over one `google` connector family:

- **Google Mail + Calendar** requests `gmail.read`, `gmail.draft`, `gmail.send`, `calendar.read`, and `calendar.write`.
- **Google Drive + Docs + Sheets** requests `drive.read`, `docs.read`, `docs.write`, `sheets.read`, and `sheets.write`.

The exact Google scope URLs are listed in `docs/PROVIDER_APPS.md`. Google may require sensitive/restricted-scope verification and, for some requested scopes, a security assessment before external production use. A consent screen in Testing or a successful test-user callback is not production approval. Complete the consent-screen configuration, verified-domain and policy requirements, provider verification, and both acceptance flows in `docs/E2E.md` before release.

Google connector ingestion currently polls Gmail history, Calendar sync/completion cursors, and Drive changes. Drive change-token polling is also the change source for Docs and Sheets. Do not configure or claim Gmail Pub/Sub watch delivery, Calendar notification channels, Drive push notifications, or any Google webhook; none is implemented.

Both regional Workers must use `PUBLIC_WEB_BASE_URL=https://with-avalon.com` so identity and connector callbacks redirect through `/auth/desktop/` before opening the custom protocol. The Global Worker must bind `EU_IDENTITY_BRIDGE` to the EU Worker's named `RegionalIdentityBridge` entrypoint and set `EU_PUBLIC_API_BASE_URL=https://eu.api.with-avalon.com`; do not expose an equivalent public route. Keep `ALLOWED_ORIGINS` exact: hosted Electron uses `app://avalon`; local Vite development uses its explicit `http://localhost:<port>` origin. Do not add wildcard, prefix, or suffix patterns.

## Realtime operations and cost controls

- Use one deterministic WorkstreamRoom per work stream, scoped by region and workspace. Do not allocate a room per socket or user.
- Keep REST/D1 canonical. The room's bounded replay buffer is an optimization and must not be persisted per token; `resync_required` deliberately falls back to REST after hibernation or a replay gap.
- Keep `acceptWebSocket` and serialized attachments. Replacing them with the standard WebSocket API prevents Durable Object hibernation.
- Keep exact text `ping`/`pong` in `setWebSocketAutoResponse`. The client heartbeat is jittered across 45–55 seconds, waits 15 seconds for `pong`, and reconnects with equal-jitter exponential backoff capped at 30 seconds. Auto-responses must not perform application work.
- Batch model `stream_delta` broadcasts. Avoid Durable Object timers, per-connection alarms, and periodic room health polling; each can wake an otherwise idle room and add duration or request cost.
- Resolve every EU room and scheduler namespace through `durableObjectNamespaceForRegion(..., "eu")`. A direct namespace lookup is a regionalization defect.
- Monitor reconnect rate, `resync_required` rate, rejected socket origins, active connections, and messages per room. A rise in reconnects or resyncs is an availability signal, not a reason to retain unbounded replay state.
- Dictation uses a separate, non-durable WebSocket bridge because each session has one desktop client and one Azure upstream; it does not need room coordination or persistence. Keep the 60-second Avalon ticket, exact Origin check, 256,000-character client-frame bound, and audio-buffer event allowlist. The Worker must set the Azure `api-key` handshake header and must never forward client `session.update` events.
- The renderer captures mono PCM16 in a 24 kHz `AudioWorklet`, sends bounded chunks, and explicitly commits when the user stops. Permission denial, device removal, provider errors, and component unmounts must stop every media track and close both sides of the session.

Cloudflare can terminate long-lived connections during network deployments, so recovery—not socket immortality—is the contract. Verify that a forced disconnect reconnects with a cursor, replays only newer events when available, and refreshes REST state when the room replies `resync_required`.

## Timezones

- Store only supported IANA names. Existing users and Global workspaces are migrated to `America/Los_Angeles`; existing EU workspaces are migrated to `Europe/London`.
- Electron supplies the Mac timezone during ticket exchange. Browser and undetected clients use `America/Los_Angeles`.
- New Global workspaces default to `America/Los_Angeles`; new EU workspaces default to `Europe/London`.
- Owners and admins may change the workspace timezone. Every user may change their personal timezone.
- Calendar automation precedence is explicit trigger timezone, then the initiating user's timezone for personal scope, then the workspace timezone for workspace scope.

## Observability views and retention

Workers Logs remain at full invocation and head sampling. `pnpm cloudflare:observability` idempotently creates these account-level saved views in Workers & Pages → Observability → Query Builder; each view is scoped to both regional API service names:

| View | Filters |
| --- | --- |
| Failures | `level = error` |
| Invalid model output | `event = request_failed` and `code = model_output_invalid` |
| Slow inference | `event = automation_compiler`, `stage = model_response`, and `latency_ms > 10000` |
| Degraded connector workflows | `event = connector_poll_timeout` or `event = connector_poll_failed` |

Correlate by `request_id`, `workspace_id`, `region`, `workflow_step`, and `connection_id`. Compiler events additionally carry stage, schema, provider/model, fallback attempt, latency, response size, app version, and sanitized validation paths. Logs must never include prompts, email bodies, connector content, credentials, file contents, or model context.

Account-level `workers_trace_events` Logpush jobs route `avalon-api-global` to the `avalon-global-observability` R2 bucket and `avalon-api-eu` to the EU-jurisdiction `avalon-eu-observability` bucket. Both buckets use an automatic 90-day object-expiration rule. Keep the destination credentials bucket-scoped and write-only. The configuration command also reconciles bucket retention and verifies each existing job's filter, fields, destination bucket, and redacted delivery state. Use `pnpm cloudflare:observability:check` for a read-only release check.

Connector polls have a 20-second adapter cancellation deadline inside a 25-second Workflow step. The step uses three exponentially backed-off retries. A terminal timeout or provider failure moves the connection into a deterministic degraded/error state and emits only structured, redacted metadata; it must never leave the workflow waiting indefinitely.

Inline read-only subagents use independent ceilings configured with `HARNESS_CHILD_MAX_*`. The production defaults are four model iterations, eight tool calls, 90 seconds, 12,000 tokens, 100 cents, four active credential plugins, 64 KiB of tool schemas, four children per chain, eight active children per workspace, and depth one. A child inherits and narrows the parent's persisted authority; raising these limits must never enable writes, recursion, or mid-run scope expansion.

## Incident response

### OpenRouter unavailable

The harness tries configured fallback models within its wall-clock and iteration limits. If all fail, the run becomes `failed` and the work stream retains its persisted context. Check redacted structured logs by request, workspace, work-stream, and harness-run IDs; never add prompt bodies or credentials to logs.

### Ambiguous external write

Do not retry automatically. A tool invocation left in `ambiguous` means the provider may have accepted the write before Avalon recorded confirmation. Inspect the provider using the stored operation metadata, then either reconcile the invocation or ask the user before another write.

### Queue backlog or dead letters

Pause connector polling if ingestion exceeds safe capacity. Inspect receipts and activity dedupe keys, fix the deterministic consumer failure, and replay only opaque activity IDs. Unique constraints and processing leases remain the authoritative duplicate barrier.

### Google token revoked

Mark the connection `needs_reconnect`, stop dependent tool execution, and preserve affected automation state. Reauthorization must request only its previously selected capabilities; do not silently broaden scopes.

### Region mismatch

Do not copy records between deployments. Confirm the desktop-selected region, session claim, workspace region, and target API agree. V1 has no workspace-region migration path.

### Stuck cross-region onboarding reservation

An unknown EU RPC/runtime failure intentionally leaves the Global `platform_workspace_bindings` row in `pending`, even after `pending_expires_at`. Do not delete or reuse it based on time alone: the original regional action may still commit. First inspect the EU user's `workspace_members` and `regional_onboarding_operations` records for the pending operation ID. If membership committed, the user's next `GET /onboarding` discovery activates the existing binding. Only when there is no membership, no operation journal row, and no in-flight RPC may an operator delete that exact pending Global row and let the user retry. Record the reconciliation in the incident log.

### Credential-key rotation

Retain the previous regional key during rotation. Decrypt with the stored key version, re-encrypt with the new active version and connection-bound authenticated data, verify provider access, then retire the old key after all rows have migrated.

## Recovery and data handling

- D1 is canonical for work streams, messages, runs, schedules, connector metadata, and audit events.
- R2 stores large payloads, uploads, snapshots, and artifacts referenced by D1.
- Durable Object storage coordinates presence, ordering, sockets, and alarms; it is not the backup source.
- Production never loads `packages/db/seed.sql`.
- Restore D1 and its corresponding R2 objects as a region-consistent set before resuming Queue consumers or scheduler alarms.
