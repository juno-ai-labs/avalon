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

Set these as Worker secrets separately in each deployment:

- `OPENROUTER_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `SESSION_SIGNING_KEY`
- `OAUTH_STATE_ENCRYPTION_KEY`
- `CONNECTOR_CREDENTIALS_KEY`

Generate independent signing/encryption material per region. Cloudflare administration credentials belong only in the local deployment environment; they must never become Worker variables.

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

Every new Avalon release advances exactly one minor version and resets the patch to zero. The release following `0.1.5` is `0.2.0`, followed by `0.3.0`; do not create patch releases, prereleases, skip a minor, or jump the major version. Immediately after a verified publication, move the root and desktop package versions to the next minor development version. Leave `apps/site/release.config.json` on the currently published version until the immutable desktop artifacts and update feed for the next version have been uploaded and verified. The release tag and site-promotion tooling enforce this policy and allow the same published version only for an idempotent retry.

Current production status: the site and both regional APIs are deployed, migrations through `0026_bind_runtime_durability.sql` are live in both D1 databases, and both regional infrastructure health checks pass. Firecrawl, Resend invitation delivery, and work-stream and automation inbound email on `automation.with-avalon.com` are configured. Google identity OAuth is configured only on the Global Worker; connector OAuth callbacks remain regional. Base Google credentials and callbacks are configured, but expanded API enablement, consent-screen review, and human acceptance of both Google presets remain release gates. The public `Avalon Workstreams` GitHub App and public Linear app are registered with their regional secrets, callbacks, and ingress deployed. Notion provider-owned registration and secrets remain to be completed using `docs/PROVIDER_APPS.md`. Human test-account identity, cross-region invitation, connector, and inbound-email acceptance runs remain release gates.

Deploy the EU Worker first for ordinary releases because the Global Worker has named service bindings to EU entrypoints. The first release that introduces work-stream inbound email is a special, compatibility-staged rollout: Global must export `WorkstreamEmailRoutingBridge` before EU can bind to it, while Global must not require `InboundEmailRegionalBridge` until EU exports that entrypoint. Use a bootstrap Global deployment with the new router export and without the `EU_INBOUND_EMAIL_BRIDGE` binding, deploy the full EU Worker, then deploy the full Global Worker. Never deploy either caller before its target entrypoint exists. Apply migrations to both D1 databases before the staged Worker rollout.

For ordinary releases after both entrypoints exist:

1. Validate both Wrangler configurations with dry-run builds.
2. Create or confirm each region's named Cloudflare resources.
3. Confirm each configured D1 ID belongs to the intended region.
4. Set the regional Worker secrets.
5. Apply the D1 migration remotely to EU and Global.
6. Deploy the EU Worker, then the Global Worker. For the first inbound-email release only, use the three-stage bootstrap order above.
7. Call `GET /health` on both regional APIs.
8. Send a workspace invitation to a real test inbox, confirm Resend accepts it, and complete the one-time email-bound acceptance flow.
9. Complete one Google identity login in a provider test account.
10. Connect **Google Mail + Calendar** and verify a Gmail read, Gmail draft, Calendar read, and Calendar test-event create/update. Delete the provider-side test fixture afterward.
11. Connect **Google Drive + Docs + Sheets** and verify a Drive read, native Docs read/write, and native Sheets read/write against disposable fixtures.
12. Establish the Drive poll baseline, change the test Doc and Sheet, poll again, and confirm `docs.document_changed` and `sheets.spreadsheet_changed` arrive through Drive change-token polling.
13. Create an automation, run it manually, and verify that a single work stream and run record are reused across a retry.
14. After every successful deployment, run the configured Gitleaks gate, commit the complete verified release transaction, and push the authorized current branch. A deployment is not complete until its source and release metadata are present on the remote. Never stage `.env.local`, generated release bundles, dependency directories, or local Cloudflare state.

Use `pnpm deploy:global` and `pnpm deploy:eu` to publish the regional Workers after the infrastructure prerequisites are satisfied. Do not mark Google capabilities release-ready until the provider credentials and APIs are configured, provider verification is complete where required, and steps 9–12 pass. A failed regional health check blocks desktop distribution for that region.

## Provider configuration

Google identity and connector OAuth use different consent purposes but may share one Google Cloud OAuth **Web application** client. Enable the Gmail, Google Calendar, Google Drive, Google Docs, and Google Sheets APIs in that client's project, then configure these authorized redirect URIs exactly:

- Global identity: `https://api.with-avalon.com/auth/google/callback`
- Global connector: `https://api.with-avalon.com/connections/google/callback`
- EU connector: `https://eu.api.with-avalon.com/connections/google/callback`

`https://with-avalon.com/auth/desktop/` is Avalon's browser handoff and `avalon://auth/complete` is the allowlisted desktop return URI; neither belongs in Google's authorized redirect URI list. Identity login requests only `openid`, `email`, and `profile`.

Settings exposes two authorization presets over one `google` connector family:

- **Google Mail + Calendar** requests `gmail.read`, `gmail.draft`, `gmail.send`, `calendar.read`, and `calendar.write`.
- **Google Drive + Docs + Sheets** requests `drive.read`, `docs.read`, `docs.write`, `sheets.read`, and `sheets.write`.

The exact Google scope URLs are listed in `docs/PROVIDER_APPS.md`. Google may require sensitive/restricted-scope verification and, for some requested scopes, a security assessment before external production use. A consent screen in Testing or a successful test-user callback is not production approval. Complete the consent-screen configuration, verified-domain and policy requirements, provider verification, and both acceptance flows in `docs/E2E.md` before release.

Google connector ingestion currently polls Gmail history, Calendar sync/completion cursors, and Drive changes. Drive change-token polling is also the change source for Docs and Sheets. Do not configure or claim Gmail Pub/Sub watch delivery, Calendar notification channels, Drive push notifications, or any Google webhook; none is implemented.

The hosted Global identity callback must use `PUBLIC_WEB_BASE_URL=https://with-avalon.com` so it can redirect through `/auth/desktop/` before opening the custom protocol. The Global Worker must bind `EU_IDENTITY_BRIDGE` to the EU Worker's named `RegionalIdentityBridge` entrypoint and set `EU_PUBLIC_API_BASE_URL=https://eu.api.with-avalon.com`; do not expose an equivalent public route. Keep `ALLOWED_ORIGINS` exact: hosted Electron uses `app://avalon`; local Vite development uses its explicit `http://localhost:<port>` origin. Do not add wildcard, prefix, or suffix patterns.

## Realtime operations and cost controls

- Use one deterministic WorkstreamRoom per work stream, scoped by region and workspace. Do not allocate a room per socket or user.
- Keep REST/D1 canonical. The room's bounded replay buffer is an optimization and must not be persisted per token; `resync_required` deliberately falls back to REST after hibernation or a replay gap.
- Keep `acceptWebSocket` and serialized attachments. Replacing them with the standard WebSocket API prevents Durable Object hibernation.
- Keep exact text `ping`/`pong` in `setWebSocketAutoResponse`. The client heartbeat is jittered across 45–55 seconds, waits 15 seconds for `pong`, and reconnects with equal-jitter exponential backoff capped at 30 seconds. Auto-responses must not perform application work.
- Batch model `stream_delta` broadcasts. Avoid Durable Object timers, per-connection alarms, and periodic room health polling; each can wake an otherwise idle room and add duration or request cost.
- Resolve every EU room and scheduler namespace through `durableObjectNamespaceForRegion(..., "eu")`. A direct namespace lookup is a regionalization defect.
- Monitor reconnect rate, `resync_required` rate, rejected socket origins, active connections, and messages per room. A rise in reconnects or resyncs is an availability signal, not a reason to retain unbounded replay state.

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
