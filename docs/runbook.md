# Operations runbook

## Local development

[The development environment guide](dev-environment.md) covers this in full,
including the sandbox-specific differences; the summary follows.

From the repository root:

```text
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The default Global API is `http://127.0.0.1:8787`; the optional EU development API uses port `8788`. `GET /health` checks D1, R2, Durable Objects, Queue and Workflow bindings, the one-Global-registry route, and regional inbound-email configuration, and reports other provider configuration separately.

After the API is running, use `pnpm smoke:local` for the repeatable authentication, work-stream, sidebar-data, idempotency, URL-safety, and realtime acceptance check. The complete desktop acceptance flow is documented in `docs/e2e.md`.

Local authentication is available only when all of these are true:

- `APP_ENV=development`
- `RALLY_DEV_AUTH=true`
- Electron is unpackaged

If the local account cannot sign in, run `pnpm env:sync`, confirm `.env.local` remains owner-readable, and restart both processes. Never add a development-auth value to a hosted Worker.

## Required hosted resources

Create independent resource sets for `global` and `eu`:

- A D1 database
- An R2 payload bucket
- A dedicated telemetry R2 bucket (`avalon-global-telemetry` or the
  EU-jurisdiction `avalon-eu-telemetry`), separate from workspace payloads
- Queues need no manual step: the deployment preflight creates every queue the
  Wrangler files declare, and Cloudflare creates each dead-letter queue on first
  deploy (see [the migration tracker section](#the-durable-object-migration-tracker)).
  The inference lakehouse is also automatic: the API deployment creates the
  Global analytical R2 bucket, enables Data Catalog, creates the Global stream,
  sink, and Pipeline, and materializes its generated ID into the Global Worker
  deploy config. EU inference analytics are intentionally deferred, so the EU
  config has no inference Queue or Pipeline binding. The general payload and
  telemetry R2 buckets remain one-time resources created by hand.
- The Worker, Durable Object namespaces, Workflows, and `CRASH_SYMBOLICATOR`
  Container declared in the regional Wrangler file

One account-wide Flagship app, `avalon-api`, holds the agent model-routing and
client product flags and is bound by both regional Workers; it is not a
per-region resource because a flag holds configuration rather than workspace
data. Both regions do send it an evaluation context carrying workspace,
work-stream, and user *attributes* — slugs, counts, ages, roles, origins, email
domains — bounded by the rules in
[`feature-flags.md`](feature-flags.md#what-may-become-an-attribute).

The checked-in regional Wrangler files reference the provisioned Rally resources. If a database is intentionally recreated, update only that region's `database_id` and keep the EU R2 jurisdiction and every region-specific name intact.

Wrangler validates an R2 binding without proving its named bucket exists. Run
`pnpm cloudflare:resources:check` after provisioning or changing either regional
Wrangler file. It is read-only: the R2 half proves each bucket exists, and the
queue half reports any queue a deployment would create without creating it
(`pnpm cloudflare:queues:ensure` creates them from a laptop, for break-glass
only), and the lakehouse half verifies both complete immutable Global resource
chains. The API deployment runs the same general R2 check before any
remote migration or Worker deploy, creates the missing queues, then creates or
verifies both Global lakehouses and resolves their generated Pipeline stream
IDs. EU has no lakehouse analytical chain by design. A missing general
bucket is an infrastructure failure even if
the Wrangler dry build and Worker binding are otherwise deployable.

`avalon-api` and its per-agent flags are provisioned, and both regional Wrangler
files carry the `app_id`; [the feature-flag
document](feature-flags.md#provisioning) has the commands for rebuilding them in
a fresh account. Each model flag is seeded with the ids already in the
`OPENROUTER_*` variables. Ace automatically ensures the
`hypersight-enabled`, `meeting-recording-enabled`, `suggested-work-enabled`, and
`automation-workspace-templates-enabled` flags exist with an off default on
every merge that deploys it. Changing their targeting happens in Ace rather
than the Flagship dashboard so connected clients receive the Queue push.

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
- `CONNECTOR_CREDENTIALS_KEYS_JSON` during credential-key rotation; a JSON object mapping old numeric versions to their regional keys
- `TELEMETRY_OPERATORS_JSON`; a JSON map from opaque bearer token to the fixed
  principal accepted by that region's restricted telemetry operator surface
- `OPS_SLACK_BOT_TOKEN` and `OPS_SLACK_CHANNEL_ID`; optional, as a pair — the
  internal Slack app operator notifications are posted with, and the channel
  they go to ([`ops-alerting.md`](ops-alerting.md)). Either absent, the Worker
  posts nothing and `/health` reports `opsNotifications` as not or half configured

Set `POSTHOG_PROJECT_TOKEN` only on the Global Worker when PostHog delivery is
enabled. The checked-in Global configuration fixes `POSTHOG_HOST` to the approved
US ingest origin; EU must have neither value. Until the token is provisioned,
regional collection remains healthy and Global accepted rows stay inside Rally
until their normal deadline. `TELEMETRY_CAPABILITY_SIGNING_KEY` is an optional
Global-only hardening boundary: when absent, onboarding capabilities use the
existing Global `SESSION_SIGNING_KEY`; EU always sends the capability to the
narrow `GLOBAL_TELEMETRY_CONTROL` RPC for verification and receives only a
route/epoch control projection. An absent `TELEMETRY_OPERATORS_JSON` disables
only that region's internal operator surface with a 503 and does not disable
collection. Enabling the dedicated signer is an immediate key cutover: schedule
it for low traffic or accept that capabilities issued under the session key in
the preceding hour will fail verification and clients must bootstrap again.
Rotating whichever key is active has the same one-hour boundary. The desktop
release workflow also requires repository variables
`RALLY_GLOBAL_TELEMETRY_R2_BUCKET` and `RALLY_EU_TELEMETRY_R2_BUCKET` so it can
publish source maps and native symbols to both private regional buckets before
distribution.

Generate independent signing/encryption material per region. Cloudflare administration credentials belong only in the local deployment environment; they must never become Worker variables.

To rotate connector credentials in one region, keep the old key, set `CONNECTOR_CREDENTIALS_KEY` to a newly generated key, increment `CONNECTOR_CREDENTIALS_KEY_VERSION`, and set `CONNECTOR_CREDENTIALS_KEYS_JSON` to a JSON object such as `{"1":"<old key>"}`. Deploy, exercise connector reads/health checks until every row reports the new version, then remove the old mapping. Never increment the version without retaining every key version still referenced by a row; those rows fail closed until that historical key is restored.

Configure the Azure values in every region where dictation is enabled. `AZURE_OPENAI_ENDPOINT` is the HTTPS resource endpoint, and `AZURE_OPENAI_REALTIME_DEPLOYMENT` is the name of an Azure deployment backed by `gpt-live-transcribe`. Azure's GA transcription contract connects to `/openai/v1/realtime?intent=transcription` and identifies that deployment in `session.audio.input.transcription.model`. Do not place any Azure value behind a `VITE_` prefix. Local development may use one unsuffixed set or `_GLOBAL` and `_EU` overrides in `.env.local`.

### Terminal provider activation and recovery

Terminal is fail-closed per region. Global and EU are both enabled against the
same Daytona environment: `DAYTONA_TARGET=us` and `daytona-small`. Rally does
not run a separate EU Daytona fleet. Presence of provider values never implies
availability: a region whose `TERMINAL_REGION_CAPABILITY` is `unsupported`, or
whose Daytona values are incomplete, omits the plugin. Leave any unverified
region unsupported until private-sandbox isolation, managed snapshot
bootstrap, native domain policy, secret-host restriction, stop/archive/restore,
and deletion behavior have passed for that exact target and provider version.
There is no Rally cross-region fallback; Daytona itself is the shared
subprocessor.

An activated region requires:

- `TERMINAL_REGION_CAPABILITY=supported` and
  `TERMINAL_EMERGENCY_DISABLED=false`;
- `DAYTONA_API_URL`, `DAYTONA_TARGET`, and
  `DAYTONA_TERMINAL_SNAPSHOT=daytona-small`; and
- `DAYTONA_API_KEY` as a regional Worker secret. EU reuses the same Daytona
  project key already on Global: put that exact value on the EU Worker. Cloudflare
  cannot copy a secret between Workers, so this is a second `secret put`, not a
  shared binding. Never put the Daytona project credential in a `VITE_`
  variable, D1, a sandbox environment value, or a checked-in Wrangler file.

If any required Daytona value is absent, Rally treats that region as
`unsupported` and continues starting without the Terminal plugin. This is the
normal local-development state. Once every value is present, malformed values
still fail the environment contract so an intended provider rollout cannot
silently run against the wrong endpoint.

The managed-snapshot compatibility contract is
`apps/api/src/services/terminal/snapshot-manifest.ts`: Bash, Python,
JavaScript/Node.js, TypeScript, SQLite, apt/dpkg, pip/uv, npm/pnpm, Git, `gh`,
and passwordless sudo. First creation idempotently adds any missing launch tools
through the Trusted-only apt/npm hosts and then executes every probe. A runtime
or manager is not supported merely because it happens to exist in one image;
add its functional probe and update the Terminal prompt in the same change.

Before enabling a region, place the candidate configuration only in the local
operator environment. The current configuration can be checked immediately:

```text
pnpm dotenv -e .env.local -- pnpm --filter @rally/api terminal:verify-provider-interface
```

The interface probe needs only the six normal Terminal/Daytona variables and is
appropriate for local credential, snapshot, filesystem, command-session,
lifecycle, policy-update, and cleanup verification. It is destructive only to
the private disposable sandbox it creates. It does not replace the full network
acceptance gate or controlled DNS-rebinding evidence.

For the full activation gate, also provide two controlled HTTPS endpoints:
`TERMINAL_PROBE_REDIRECT_URL` must be an allowed public host that redirects to a
blocked host, and `TERMINAL_PROBE_PRIVATE_DNS_URL` must be an allowed public name
that resolves to a private/special-use address. Then run:

```text
pnpm dotenv -e .env.local -- pnpm --filter @rally/api terminal:verify-provider
```

The automated acceptance probe creates one private Trusted-only sandbox,
verifies the exact effective allowlist, a binary upload/download round-trip,
every promised runtime/manager, allowed and denied domains, direct-IP, redirect,
private-DNS, and metadata denial. It then checks stop/restart, archive/restore,
deletion, and observed absence; cleanup failure is a failed probe and success is
printed only afterward. It also prints create,
policy-read-back, compatibility-install, manifest-verification, and start phase
timings from that disposable sandbox. These are acceptance evidence, not the
production distribution used for the image decision. The automated result is
not sufficient by itself: the activation record must also contain controlled
evidence for TTL-changing public-to-private DNS rebinding and host-scoped secret
substitution against an alternate host. Preserve those results with the provider
version, target, snapshot ID, region, and vendor residency evidence; never
preserve configuration values, canary secret values, or endpoint credentials.
Only after the complete record exists should the Wrangler region be changed to
`supported`, the three non-secret values be configured, the API key be set, and
that region deployed.

Once enabled, query the durable aggregate measurements with:

```text
pnpm terminal:analytics -- --days 7
pnpm terminal:analytics -- --days 30 --region eu --snapshot daytona-small
```

The command uses `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` restricted
to **Account Analytics: Read**. Its start/end line is the actual first and last
Analytics Engine observation in the requested window, not merely the requested
date boundary.

Use the structured events `terminal_plugin_activation_finished`,
`terminal_provider_request_finished`, `terminal_tool_finished`,
`terminal_sandbox_lifecycle_transition`, and
`terminal_sandbox_lifecycle_failed`. Commands and output are deliberately absent.
Activation records acquisition/cache state, provider duration and request/poll
counts, residual Rally time, a one-based `activation_attempt`, and whether
repository preparation completed or was deferred to the visible repair tools.
Provider-request events use a fixed
content-free operation/detail vocabulary and correlate activation under the
`terminal_plugin_activation` tool identity.
For regional durable diagnosis, query counts/ages and exact IDs from
the owning object's `terminal_workspace`, `terminal_tasks`, and
`repository_publications`; inspect workspace-wide policy mutation history in
the owning WorkspaceDO's `workspace_sandbox_network_policy_mutations` table.
That table is not present in D1 after migration 0090, so use the authorized
object diagnostic/repair surface for the workspace's regional route rather
than issuing a regional D1 query.
Inspect generated logs/diffs only through Rally's authorized resource surface.
The oldest running `last_activity_at`, nonterminal task beyond
`command_deadline_at`, expired lifecycle claim, failed policy verification, or
`ambiguous` publication points to the owning reconciler rather than permission to
repeat the provider write.

For a provider-wide egress, isolation, or secret incident, set
`TERMINAL_EMERGENCY_DISABLED=true` and deploy the affected region first. The
plugin remains visible so its normal tool contract can explain the outage, but
new sandbox leases and publication starts fail closed with
`sandbox_unavailable`; regional receipts and generated resources remain intact.
Revoke/rotate the Daytona project key and GitHub App
credentials as the incident requires, reconcile retained provider sandboxes
against each owning object's `terminal_workspace`, and run the full real-provider probe before
clearing the emergency switch. Do not bulk-delete provider sandboxes by label
without matching the exact regional route and object-local
workspace/work-stream/generation rows;
final diffs and ambiguous publication state may still require preservation.

Apply migration `0040_realtime_transcription_admission.sql` before enabling dictation. It stores no audio or transcripts: it records consumed one-minute ticket IDs and five-minute active-session leases. After the Durable Object cutover these rows live in the owning `WorkspaceDO` (`realtime_transcription_ticket_receipts` and `realtime_transcription_sessions`); the D1 tables are fenced. The Worker permits at most two concurrent sessions per user and twenty per workspace, rejects more than thirty client frames per second, and caps PCM audio at five minutes per connection. Expired leases are removed during the next admission attempt.

Alert on `realtime_transcription_session_release_failed`. The Worker retries the idempotent lease deletion in the owning WorkspaceDO before emitting this event; repeated occurrences can leave a user at the concurrency limit until the five-minute lease expires.

Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` only on the Global Worker. They belong exclusively to the platform login client and are never used by Google service connectors.

Set `RESEND_WEBHOOK_SIGNING_SECRET` and `WORKSTREAM_EMAIL_ADDRESS_KEY` only on the
Global Worker. `RESEND_API_KEY` is required in both regions with Resend's
**Full access** permission because each owning region retrieves its own full
message after the Global ingress has routed only signed metadata. An optional
`RESEND_RECEIVING_API_KEY` can override it later if Rally returns to separate
sending and receiving credentials. All non-Global work-stream and automation
email-name reservations use
the Global `WorkstreamEmailRoutingBridge`; there is no regional allocator key or
regional fallback registry.

`RESEND_API_KEY` is shared by the two regional Workers and is used for both invitations and inbound-message retrieval. There are two checked-in senders, both `vars` in each region's Wrangler config: `RESEND_FROM_EMAIL` (`Rally <invites@rallywith.ai>`) for transactional mail, and `RESEND_NOTIFICATION_FROM_EMAIL` (`Rally <notifications@rallywith.ai>`) for mail Rally generates — digests, automation results, mention notifications. Resend verifies the domain rather than the address, so the second rides the same verification; keep both `rallywith.ai` and `with-avalon.com` verified with their own DKIM/SPF records — Resend verifies the sending domain, so the Rally senders do not inherit the Rally verification and mail from them is rejected until the Rally records are live. An unset notification sender does not fail: `sendResendEmail` falls back to the transactional one silently, which is why `GET /health` reports `resendNotificationSender` separately — check it after a deploy that touches either var. Resend acceptance confirms that the transactional request was queued, not final inbox delivery. A provider failure revokes the newly created invitation before the API reports failure.

Inbound work-stream and automation mail uses the dedicated catch-all subdomain `automation.rallywith.ai`. Create it with Resend Receiving enabled, install the exact MX record returned by Resend in Cloudflare DNS, and create one `email.received` webhook pointing to `https://api.rallywith.ai/ingest/resend`. **Keep `automation.with-avalon.com` receiving, with its own MX record and webhook, for as long as any address on it exists.** Addresses are stored per work stream rather than derived, so every address issued before the rename still carries that domain, is printed in the sender's mail client, and is what mail rules forward to; the Worker accepts either domain and resolves the full recipient address in the Global registry. See [`domain-migration.md`](domain-migration.md). Store its `whsec_...` value as the Global `RESEND_WEBHOOK_SIGNING_SECRET`. Ensure the reused `RESEND_API_KEY` has Full access in both regions because the regional Worker retrieves the full received message after routing. Store one stable 32+ byte `WORKSTREAM_EMAIL_ADDRESS_KEY` in the Global Worker. Do not log any of these values. Existing deployments using `RESEND_WEBHOOK_SECRET` remain compatible during migration.

For non-interactive Wrangler commands, prefer `CLOUDFLARE_API_TOKEN`. The older global-key method requires both `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL` in `.env.local`; an API key by itself cannot authenticate a deployment.

Use a custom token restricted to the Rally Cloudflare account and the `rallywith.ai` and `with-avalon.com` zones — both are served while the rename is in flight, and a token holding only one of them fails route provisioning for the other. The deployment and migration workflow needs these permissions:

- Account: Account Settings Read
- Account: Workers Scripts Write (shown as Edit in older dashboards)
- Account: D1 Write/Edit
- Account: Workers R2 Storage Write/Edit
- Account: R2 Admin Read & Write — used by the inference-lakehouse preflight to
  create the Global analytical bucket and Data Catalog and as the
  non-interactive credential source for the Global Catalog sink
- Account: Pipelines Write/Edit — to create and inspect the Global stream, sink,
  and pipeline; Worker ingestion itself uses the generated binding
- Account: Queues Write/Edit — to attach a consumer on deploy and for the
  preflight to create a declared queue. A token that can only list queues fails
  the create with `Authentication error [code: 10000]`.
- Account: Flagship Write/Edit — the permission is still in open beta and is
  absent from the published permissions reference; find it by searching
  `Flagship` in the dashboard's API-token editor. Read access alone lists apps
  but fails `wrangler flagship apps create` with `Authentication error [code:
  10000]`, and automatic provisioning on deploy fails the same way.
- Account: Access Apps and Policies Write/Edit — Ace's deployment creates or
  updates its Access application and copies the migration site's current policy
  and identity-provider settings on every merge.
- Zone `rallywith.ai`: Zone Read
- Zone `rallywith.ai`: Workers Routes Write/Edit
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

### Order the EU API certificate before deploying the Rally routes

**`eu.api.rallywith.ai` is two labels deep and the zone's Universal SSL does not
cover it.** A Universal pack covers `rallywith.ai` and `*.rallywith.ai`, and a
wildcard matches exactly one label — so this hostname is not in it, and without a
further certificate it serves a TLS error rather than the EU API. Wrangler
creates the route and the DNS record regardless, so the symptom is an EU region
that looks deployed and is unreachable, which reads as an outage rather than as a
missing certificate. This is the same trap the migration tracker hit; see
[the tracker's hostname note](#the-durable-object-migration-tracker).

Add `*.api.rallywith.ai` to the **existing Advanced Certificate Manager pack** on
the `rallywith.ai` zone — the one already covering `*.internal.rallywith.ai`. It
is a per-zone add-on that is already paid for and holds up to 50 hostnames, so
this costs nothing beyond the order. Issue from **Google Trust Services**, to
match the zone's other packs. TXT validation completes on its own because
Cloudflare is authoritative for the zone, and the pack takes roughly fifteen
minutes to go active. Confirm it is active, then deploy.

The other nine Rally hostnames are single-label and covered by the Universal
pack, so they need no certificate work. [`domain-migration.md`](domain-migration.md)
lists all ten and what each serves.

### The Rally rename cannot reach installed builds through the update feed

**An installed `app.rally.desktop` build will not auto-update to
`ai.rallywith.desktop`.** Squirrel.Mac treats the bundle identifier as the
application's identity and refuses to replace a bundle with one that does not
match — see the macOS distribution section of
[`security.md`](security.md#macos-distribution-and-updates). The release that
carries the rename therefore reaches existing installs only as a manual
reinstall, and the failure mode if that is not planned is silent: those installs
keep polling `downloads.with-avalon.com`, keep being offered a build they will
not accept, and simply stop updating. Nothing is logged on either side.

Decide the migration **before** the rename ships. The options, in the order they
are usually worth considering:

1. **Announce and ship a manual reinstall.** Mail every account a
   `downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg` link before promoting
   the release, and keep the Avalon feed serving its last Avalon-named build so
   an un-migrated install is not left broken.
2. **Ship one last Avalon-identified release first** whose only job is to tell
   people, in the app, that the next version must be installed by hand. This is
   the version that reaches everyone, so it is the only reliable channel.
3. **Keep `app.rally.desktop`** and rename everything else. This is the only
   option with no migration at all; it trades a permanent `avalon` string in the
   shipped bundle for a clean update path.

Whichever is chosen, `downloads.with-avalon.com` and the last Avalon-named
artifacts must stay served indefinitely — an install that never migrates polls
them forever, and there is no way to tell from this side how many did.

### Rename the release repository variables before the next desktop release

The desktop release workflow reads three GitHub **repository variables** whose
names moved with the rebrand. Rename them under **Settings → Secrets and
variables → Actions → Variables**, keeping each value:

| Current name | New name | Value |
| --- | --- | --- |
| `AVALON_RELEASE_R2_BUCKET` | `RALLY_RELEASE_R2_BUCKET` | `avalon-desktop-releases` |
| `AVALON_GLOBAL_TELEMETRY_R2_BUCKET` | `RALLY_GLOBAL_TELEMETRY_R2_BUCKET` | `avalon-global-telemetry` |
| `AVALON_EU_TELEMETRY_R2_BUCKET` | `RALLY_EU_TELEMETRY_R2_BUCKET` | `avalon-eu-telemetry` |

**The values stay Avalon-named on purpose** — an R2 bucket cannot be renamed, and
moving one means creating a bucket, copying every object, and repointing the
`downloads.rallywith.ai` custom domain. That is a separate, reversible-only-by-
copying operation; see the Boundary section of
[`domain-migration.md`](domain-migration.md).

Until the rename is done the workflow falls back to the superseded variable names
(`vars.RALLY_… || vars.AVALON_…`), so a release does not fail in the window
between this merging and someone opening that page. The fallback exists because
the failure it prevents is quiet: an unset variable is an empty bucket name, and
a publish to an empty bucket name uploads nowhere rather than erroring. Delete
the fallback once the variables are renamed.

No Apple credential changes with the rename. The Developer ID Application
certificate is issued to the team (`7ZLT6A8W25`), not to a bundle identifier, and
notarization authenticates the same team — so `ai.rallywith.desktop` signs and
notarizes with the existing `CSC_LINK`, `CSC_KEY_PASSWORD`, and `APPLE_API_*`
secrets untouched.

### Release version policy

Every new Rally release advances exactly one minor version and resets the patch to zero. The one stable-promotion exception permits a `0.x` release to advance to `1.0.0`; after that, releases continue by minor version (`1.0.0` → `1.1.0`). Do not create patch releases, prereleases, skip a minor, or make any other major-version jump. Do **not** move the package versions to the next minor immediately after publication, as earlier revisions of this policy directed: an unreleased version in `package.json` is now the instruction to release it, so the next merge to `main` would ship it. Bump in the change that is meant to go out. See "Releasing the desktop app by bumping the version" below. Leave `apps/site/release.config.json` on the currently published version until the immutable desktop artifacts and update feed for the next version have been uploaded and verified. The release tag and site-promotion tooling enforce this policy and allow the same published version only for an idempotent retry.

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
pnpm dotenv -e .env.local -- pnpm --filter @rally/api exec wrangler r2 bucket create avalon-desktop-releases-archive --location wnam --storage-class InfrequentAccess
pnpm dotenv -e .env.local -- pnpm --filter @rally/api exec wrangler r2 bucket info avalon-desktop-releases-archive
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

`stable/darwin/arm64/Rally.dmg` and
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
   require exactly five complete releases plus `Rally.dmg` and
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
pnpm --filter @rally/release-retention test
pnpm --filter @rally/release-retention typecheck
pnpm --filter @rally/release-retention build
```

Exercise the real scheduled handler against the remote buckets without writes
by starting Wrangler with the dedicated `wrangler.dry-run.jsonc` configuration.
That configuration pins `RETENTION_DRY_RUN=true` and is the only checked-in
configuration whose development bindings access the remote buckets:

```text
pnpm dotenv -e .env.local -- pnpm --filter @rally/release-retention dev:dry-run
curl "http://localhost:8799/cdn-cgi/handler/scheduled?cron=0+9+*+*+*&time=1786093200000&format=json"
```

The timestamp above simulates 02:00 PDT on 2026-08-07. Require an `ok` outcome
and a structured completion log with `dryRun: true`. After deployment, preserve
the Wrangler output showing both Cron Triggers and inspect Workers & Pages →
`avalon-release-retention` → Cron Events after the next window. Alert on failed
events, unexpected `dry-run` production reports, a non-five retained set, or any
copy/delete count that does not match the plan.

### Ace internal administration

`deploy-ace.yml` is the complete Ace release. A matching merge to `main`
validates the workspace, creates every declared Queue, clones the migration
site's current Cloudflare Access policy into an Ace-specific application,
ensures the two Enabled-named product flags exist off by default, deploys the
Hono Worker and Vite assets at `ace.internal.rallywith.ai`, installs the
Flagship-only credential as an encrypted secret, and verifies that an
unauthenticated request enters Access. No dashboard or laptop step follows the
merge.

The API and desktop sides deploy from their existing workflows on the same
merge: `packages/contracts/**` triggers both, `apps/api/**` triggers both
regional Workers, and `apps/desktop/**` triggers the signed macOS release. The
three workflows intentionally do not wait on one another. Queues retain an Ace
change until a regional consumer is deployed, and both product flags remain off
until every layer receives an explicit true.

An Ace deployment that fails before Worker upload leaves the previous Ace
version in place. If it created one of the flags first, that flag is still off
and has no rules. If upload succeeds but the final Access probe fails, inspect
the Ace Access application and `avalon-ace` Worker before retrying the workflow;
the deploy script is idempotent. [`ace.md`](ace.md) owns the runtime recovery
sequence and the rule that managed product flags are not edited directly in the
Flagship dashboard.

### The Durable Object migration tracker

`avalon-migration-tracker` in `apps/migration-tracker` serves the operator site
at `migrations.internal.rallywith.ai`, receives a migration report from every
Durable Object in both API Workers, and can send a forced-migration command back
to any of them.
[`durable-object-migration-tracking.md`](durable-object-migration-tracking.md)
owns the design; this is the provisioning and deployment procedure.

Reports travel on a Queue rather than a service binding, so **there is no
deploy-order dependency between the tracker and either API Worker** — a queue is
a resource both sides bind to. What both sides do require is that the queues
exist first, which each deployment now ensures for itself (below). The producer
binding is optional at runtime, so an API Worker deployed before the tracker
existed keeps working and simply reports nothing.

The queue's *configuration* — name, batch size, batch timeout, retries, and its
dead-letter queue — lives in the Wrangler files and is applied on every deploy,
so it is not something to set by hand anywhere. What Wrangler does not do is
create the queue a producer binding names; that fails the deploy. So every
deployment provisions its own queues as a preflight:

```text
pnpm cloudflare:resources:check
```

Locally that is read-only: it reads all three Wrangler files and reports any
queue they declare that the account does not hold. Both the API and the tracker
deployment run the same script without `--check` —
`scripts/ensure-cloudflare-queues.mjs`, making the same `POST …/queues` call
`wrangler queues create` makes — before anything is deployed, so a release that
adds a binding ships its queue with it and no queue is created by hand.
`pnpm cloudflare:queues:ensure` is the break-glass form of the same create from
a laptop. The script refuses a queue that only a producer or only a consumer
names anywhere across the three files, because that is a misspelling and the
deploy that attached it would go green with nothing draining the queue. It
never deletes: retiring a queue is a deliberate operator action. A dead-letter
queue needs no action either way, because Cloudflare creates one named in a
consumer's `dead_letter_queue` on first deploy. The create needs **Queues
Edit** on the token, as the permission list above records; a token that can
only list queues gets `Authentication error [code: 10000]` on the create, and
the script names the permission.

There is one report queue for both regions, not one per region as with the
activity queues: every report converges on the single registry object regardless
of where it came from, so splitting the transport would isolate nothing. The
region travels in the message body.

The commands going the other way are split — `avalon-global-migration-commands`
and `avalon-eu-migration-commands` — because a queue has exactly one consumer
and only the region's own Worker can address its objects. So the tracker holds
both producer bindings and each regional API file holds one consumer. Neither
queue needs creating by hand: they are declared in those Wrangler files like
every other, and the preflight above creates whichever the account does not
hold. Their dead-letter queues are left to the platform in the usual way, and
both are worth watching — a message in one is an object a forced migration
could not move, which is the count of how many are stuck at no instrumentation
cost.

Deploy order still does not matter. The tracker's producer bindings are optional
at runtime, so a tracker deployed before the API Workers have their consumers
reports the region as unreachable on its page rather than dispatching into
nothing.

Deploy in any order:

```text
pnpm deploy:migration-tracker
pnpm deploy:global
pnpm deploy:eu
```

Ordinarily none of that is run by hand. `.github/workflows/deploy-migration-tracker.yml`
deploys the tracker on a merge to `main` that touches `apps/migration-tracker/`
or the shared report contract, and `deploy-api.yml` deploys the two API Workers
on a merge that touches theirs. They are separate workflows with separate path
filters for the same reason the transport is a queue: neither side's release
should wait on the other's. The commands above are the manual path, for a first
deployment or a rollback.

The tracker workflow runs against the same **`api-production`** environment as
the API deploy, and uses the same `CLOUDFLARE_API_TOKEN` secret and
`CLOUDFLARE_ACCOUNT_ID` variable. It needs no permission the API deploy does not
already have: Workers Scripts to upload, and Queues to attach a consumer and to
create a declared queue, which the API deploy uses for its own queues. A separate environment would be
a second copy of the same credential to rotate and would isolate nothing, since
a token that can deploy `avalon-api-global` can already deploy anything in the
account. Note this is the *deployment* token, and a different one from the
read-only runtime token in step 3 below, which the Worker uses for the sweep.

After deploying, the workflow proves the deployment rather than trusting the
upload:

```text
node scripts/check-migration-tracker-health.mjs
```

That asserts the Worker actually became a consumer of `avalon-migration-reports`
with the batch settings `wrangler.jsonc` declares, and that the site refuses a
request carrying no Access assertion. The first is the failure worth catching: a
tracker that deploys without attaching looks healthy everywhere while reports
pile up unread until they age out of the queue. The second turns the fail-closed
design into a checked invariant — from a runner with no Access cookie, a `2xx`
would mean the fleet's schema state is being served to anyone who asks.

The tracker needs no D1 database and no R2 bucket: its entire store is the
`MIGRATION_REGISTRY` Durable Object namespace, which the deploy creates. Three
further one-time steps are required outside the repository.

**Attach `downloads.rallywith.ai` to the releases bucket before the next
desktop release.** `electron-builder.yml`, `updater.ts`, `mac-signature-policy.mjs`,
and the release workflow all publish and poll there now, but the R2 bucket
(`avalon-desktop-releases`) is unchanged — the hostname is a new R2 custom domain
on the Rally zone and nothing creates it automatically. Already-shipped DMGs keep
polling `downloads.with-avalon.com`, correctly and permanently, so this blocks
the next release rather than the Worker deploy.

**1. The hostname.** `migrations.internal.rallywith.ai` is declared as a custom domain in
`wrangler.jsonc`, and the deploy provisions the route on the `rallywith.ai` zone.

It is two labels deep, which the zone's Universal SSL **does not cover**. A
Universal pack covers `rallywith.ai` and `*.rallywith.ai`, and a wildcard matches
exactly one label — so `migrations.internal.rallywith.ai` is not in it, and
without a further certificate the hostname serves a certificate error rather
than the site.

The certificate is therefore an **Advanced Certificate Manager** pack on the
`rallywith.ai` zone, a paid per-zone add-on, covering `*.internal.rallywith.ai`.
The wildcard rather than the exact hostname so the next internal tool needs no
new certificate order; a pack takes up to 50 hostnames. Issue it from
**Google Trust Services** — DigiCert is being deprecated as a CA, and the zone's
Universal pack is already Google-issued, so one CA covers the zone. TXT
validation completes on its own because Cloudflare is authoritative for the
zone, and the pack takes roughly fifteen minutes to go active.

**Order the certificate before the first deploy.** Wrangler will create the
route and the DNS record regardless, and the hostname will fail TLS until the
pack is active — which reads as an outage rather than as a missing certificate.
`scripts/check-migration-tracker-health.mjs` catches exactly this: an
unreachable hostname fails the deployment verification.

The `internal.` label buys naming, not security — the site is protected by
Cloudflare Access, not by being hard to guess. It is the one Rally hostname
that is not single-level, and it is the reason this zone carries ACM at all.

**2. Cloudflare Access.** Zero Trust is enabled on the account with the team
name **`juno-labs`**, so the team domain is `juno-labs.cloudflareaccess.com` and
that is what `ACCESS_TEAM_DOMAIN` carries. It is an account setting, not derived
from the web domain, and it does not follow a rebrand of the site — the site
moved from `with-avalon.com` to `rallywith.ai` and the team domain would not
have moved with it.

Renaming the team later is not free: the name is the JWKS URL the Worker fetches
keys from, the `iss` claim on every assertion, and the URL people log in at, so a
rename invalidates outstanding sessions and needs the identity providers updated
as well as a redeploy.

Then add **Google** as a login method and create a self-hosted application for
the hostname, with an Allow policy whose include rule is `Emails ending in
@juno-labs.com` — the domain people sign in with, which is **not** the domain
the site is served from. Copy the application's **Application Audience (AUD)
tag** into `ACCESS_APPLICATION_AUD`.

**That policy is the only place who-may-read is written.** The Worker verifies
the assertion — signature against the team's JWKS, issuer, audience — but it
does not re-check the address, so widening or narrowing access is a policy
change in Zero Trust and nothing else: no variable to update, no deploy. The
Worker held a second domain allowlist once and it was deleted for the usual
reason a duplicated rule gets deleted — the two copies disagreed, and the
disagreement was invisible until somebody could not log in.

The Worker still fails closed. Until both `ACCESS_TEAM_DOMAIN` and
`ACCESS_APPLICATION_AUD` are set it refuses every request, so an unconfigured
deployment is unreachable rather than open.

**3. A read-only Cloudflare API token.** The hourly sweep enumerates Durable
Object namespaces and object IDs. `CLOUDFLARE_ACCOUNT_ID` is set in
`wrangler.jsonc` — an identifier, not a credential — and the token is a secret:

```text
pnpm --filter @rally/migration-tracker exec wrangler secret put CLOUDFLARE_API_TOKEN --config wrangler.jsonc
```

Grant it **Account · Workers Scripts · Read** and nothing else. Note that the
resulting token can still *list* zones and queues: those endpoints answer any
account-scoped token, which is Cloudflare's behaviour rather than a wider grant.
It cannot write anything.

Run that command signed in as yourself. It resolves the account through
`User · Memberships · Read`, which the deployment token deliberately does not
carry, so authenticating it with `CLOUDFLARE_API_TOKEN` from `.env.local` fails
with "Unable to get membership roles" — which reads like a problem with the
secret rather than with the credential being used to set it.

**Both halves are required.** With either missing the sweep logs
`migration_inventory_sweep_skipped` and returns, so the tracker only ever learns
about an object that has woken and reported — and the site cannot distinguish a
class with no objects from one whose objects are all dormant. That is the exact
blind spot the sweep exists to close, so a tracker without it is showing far less
than it appears to.

Before deploying a change, run:

```text
pnpm --filter @rally/migration-tracker test
pnpm --filter @rally/migration-tracker typecheck
pnpm --filter @rally/migration-tracker build
```

Locally, `pnpm dev:migrations` serves the site on port 8790 from
`wrangler.dev.jsonc`, the one configuration that sets `APP_ENV=development` and
`MIGRATION_TRACKER_DEV_AUTH=true`. Cloudflare Access does not stand in front of
a local Wrangler, and the bypass is honoured in no other environment.

After deployment, watch `migration_inventory_sweep_completed` for a `partial`
status — it names the namespaces whose listing was truncated or failed — and
`migration_reports_recorded` at `error` level, whose `failed_objects` field names
each Durable Object whose migration threw and which the site lists under **Open
failures**.

Check `avalon-migration-reports-dead-letter` when reports stop arriving. A
message reaches it only after five failed attempts to write it to the registry, so a non-empty
dead-letter queue means the registry object itself was failing, not that a
migration did. `migration_report_rejected` is the other direction: a message the
consumer refused because it did not match the contract, which means a producer
was changed without the shared contract in `packages/contracts` being changed
with it.

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
change the update channel. Change `latest-mac.yml` or `Rally.dmg` only as a
separate, explicitly approved release rollback using the normal publisher's
ordering and cache-purge safeguards.

### Desktop icon release gate

If desktop icon artwork, generated icon assets, or the icon-family configuration changed, follow [Desktop application icons](desktop-icons.md). Regenerate the assets, build the guarded local desktop package, and verify the running Dock icon in both light and dark macOS appearances before creating a release build. Also inspect Finder to confirm the static bundle icon remains correct.

Current production status: the site, both regional APIs, and the private nightly `avalon-release-retention` Worker are deployed. The retention Worker keeps the five newest complete desktop releases active and archives older releases to private Infrequent Access storage at 02:00 Pacific. Migrations through `0065_automation_draft_conversation.sql` are live in both D1 databases — confirmed against both remote databases with `pnpm db:migrate:remote:list` and its EU counterpart — and both regional infrastructure health checks pass. Firecrawl, Resend invitation delivery, and work-stream and automation inbound email on `automation.with-avalon.com` are configured. Google identity OAuth is configured only on the Global Worker; the separate Google connector OAuth client is configured in both regions, and credentials issued by the former shared client were invalidated during the cutover. Expanded API enablement, consent-screen review, and human acceptance of both Google presets remain release gates. The public `Rally With AI` GitHub App and public Linear app are registered with their regional secrets, callbacks, and ingress deployed. The public Notion connection and regional OAuth secrets exist; its webhook subscription remains to be created after migration `0071_notion_webhook_setup_nonces.sql` and the matching Worker release land, using the two clipboard commands in `docs/provider-apps.md`. Human test-account identity, cross-region invitation, connector, and inbound-email acceptance runs remain release gates.

Deploy the EU Worker first for ordinary releases because the Global Worker has named service bindings to EU entrypoints. The first release that introduces work-stream inbound email is a special, compatibility-staged rollout: Global must export `WorkstreamEmailRoutingBridge` before EU can bind to it, while Global must not require `InboundEmailRegionalBridge` until EU exports that entrypoint. Use a bootstrap Global deployment with the new router export and without the `EU_INBOUND_EMAIL_BRIDGE` binding, deploy the full EU Worker, then deploy the full Global Worker. Never deploy either caller before its target entrypoint exists. Apply migrations to both D1 databases before the staged Worker rollout.

The release that first ships the shared Notion ingress is the second such rollout, and it is staged for the same reason: Global adds `EU_NOTION_BRIDGE` bound to `NotionRegionalBridge`, which the deployed EU Worker does not export yet, while EU adds `GLOBAL_NOTION_ROUTER` bound to `NotionRoutingBridge`, which the deployed Global Worker does not export yet. Neither region can be deployed with its full configuration first. Deploy a bootstrap Global Worker carrying the new `NotionRoutingBridge` export and the `notion.with-avalon.com` custom domain but **without** the `EU_NOTION_BRIDGE` binding, then the full EU Worker, then the full Global Worker. Apply `0066_shared_notion_connection_routing.sql` and `0071_notion_webhook_setup_nonces.sql` to both databases first. Until the third stage lands, an EU authorization returns `notion_region_unavailable` rather than completing — the shared callback is live but has nowhere to hand an EU attempt — so set the Notion Worker secrets only after the rollout finishes, which keeps the connector out of the catalog and the connect button disabled in the meantime.

After the migration and Worker release are live, finish the Notion subscription
without putting either setup material or its signing secret into logs:

1. Run `pnpm notion:webhook:prepare`; it copies a URL carrying a 30-minute,
   single-use nonce. Paste that URL into Notion's Webhooks tab and create the
   subscription immediately.
2. Run `pnpm notion:webhook:copy-token` after Notion posts the challenge. Paste
   the copied value into **Verify subscription**. The command prints only the
   capture timestamp, not the token, and refuses until the stored ciphertext is
   proven to belong to the current consumed setup generation.
3. If the nonce expires or setup must be restarted, run the prepare command
   again. The new command invalidates any earlier unconsumed URL; never recover a
   nonce or verification token from Workers Logs or Logpush.

For ordinary releases after both entrypoints exist:

1. Validate both Wrangler configurations with dry-run builds.
2. Create or confirm each region's named Cloudflare resources. The deployment
   automatically creates and verifies the Global inference Queue, analytical R2
   bucket, Data Catalog, sink, stream, Pipeline, and generated binding. EU has no
   inference analytics resources in its Worker config. Scoped
   memory still requires `avalon-global-memory` and `avalon-eu-memory` Vectorize
   indexes with 1,024 dimensions and cosine distance. Memory embeddings use
   OpenRouter `qwen/qwen3-embedding-8b` with an explicit 1,024-dimension
   request; the Workers AI binding remains for Cloudflare-backed PDF OCR.
3. Confirm each configured D1 ID belongs to the intended region.
4. Set the regional Worker secrets.
5. Apply the D1 migration remotely to EU and Global with `pnpm db:migrate:remote:eu` and `pnpm db:migrate:remote`. Inspect the pending set first with `pnpm db:migrate:remote:list:eu` and `pnpm db:migrate:remote:list`. The unsuffixed `pnpm db:migrate` targets local Wrangler state only and never touches a hosted database.
6. Deploy the EU Worker, then the Global Worker. For the first inbound-email release and the first shared-Notion-ingress release, use the three-stage bootstrap order above instead.
7. Call `GET /health` on both regional APIs with `pnpm health:regions`, which fails unless both regions report `ok`. That now includes the Worker's own environment contract: a region missing a required secret answers `503` here and names the keys, rather than reporting healthy while every other route returns `service_misconfigured`.
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

- `.github/workflows/ci.yml` runs on every pull request and deliberately does not rerun after a push to `main`: lint, typecheck, the full test suite, both Wrangler dry-run builds, the desktop release invariants, and the Gitleaks gate over the full history. Verification fans out across independent Ubuntu runners; the desktop Vitest suite uses two shards, the API Vitest suite uses three, and the workers suite uses two shards, while a terminal `verify` job collapses every lane back into the one stable branch-protection check. Keep `fail-fast: false` so all failures remain visible, and keep `if: always()` on the terminal job so a failed or cancelled lane reports `verify` as failed rather than skipped. Require the `verify` and `secrets` checks through a branch ruleset on `main` to stop a red pull request being merged in the first place. Push-triggered deployment and release workflows continue to verify the workspace themselves before touching production; they do not depend on a second CI run after merge.
- `.github/workflows/deploy-api.yml` performs steps 1 and 5–7: dry-run validation, remote D1 migrations, the EU-then-Global Worker deployment, and the regional health check. Its verify matrix shards the workers suite the same way CI does (`api-tests-workers-1-of-n` / `2-of-n`) rather than appending an unsharded `test:workers` onto a Node lane — that split is load, not coverage, and an unsharded full-suite Miniflare is more `reset()` interleave than PR CI ever sees. It runs automatically on every merge to `main` that touches `apps/api`, `packages` (including `packages/db/migrations`), either lakehouse manifest/provisioner, the lockfile, the workspace file, or the workflow itself; documentation, desktop, and site-only merges do not redeploy. A `workflow_dispatch` run can additionally restrict the regions, skip the migration step, and deploy an arbitrary ref; the verify job resolves that ref once, and the deploy job checks out the resulting immutable SHA so a moving branch cannot change between validation and deployment. It creates any declared Queue that is missing and fully provisions/verifies both Global lakehouses before migrations; the EU deploy config intentionally contains no lakehouse binding. It does not create unrelated resources, confirm regional D1 IDs, or set Worker secrets — those steps stay manual and one-time — and it must not be used for the three-stage inbound-email bootstrap or any other release that introduces a new cross-region entrypoint. Those are deployed by hand in the documented order, which means holding such a change out of `main` until the staged rollout is complete.
  Migration 0090 is the one destructive exception to normal migration-first ordering: when it is the sole pending migration, compatible Workers deploy before it. The workflow fails closed if 0090 appears beside any other pending migration, because Wrangler applies the complete pending ledger and must never move an ordinary later migration behind the Worker that may require it.
- **The durable automation lifecycle cutover ran on 2026-08-28** and its three
  one-shot deploy steps — the single-region refusal, the preflight, and the
  apply — have been removed from `deploy-api.yml`. They were deliberately
  temporary: left in place, the refusal permanently bans an EU-only or
  Global-only deploy in the name of a cutover that has already happened. Both
  regions ran it in one release. Completion was confirmed per workspace
  afterwards rather than inferred from the drained queue: Workers Logs carry one
  `automation_cutover_completed` event for each of the three Global workspaces
  (EU held none), and zero `workspace_do_schema_hash_mismatch` events. Those
  events are themselves proof the objects applied through WorkspaceDO v22, since
  `finalizeAutomationCutover` exists only in the new build and runs after the
  constructor's migration pass.
  `scripts/cutover-automation-agents.mjs` is kept as an operator tool rather
  than deleted, because it is the remedy if a workspace is ever found still
  holding legacy automation state; `--apply` is idempotent per workspace, so
  rerunning it against a completed fleet is a no-op.
  Running it by hand needs the Cloudflare credentials the deploy job used to
  assert, and two things are worth knowing before you do. **The drain wait is
  unbounded**: `AUTOMATION_CUTOVER_DRAIN_TIMEOUT_MS` ships as `+Infinity`
  behind a `LIMIT UNSET` marker
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)),
  so the poll has no exit but success. A deterministically failing message is
  not what hangs it — the command queues carry five retries and a dead-letter
  queue, and the loop already fails on any rise in the dead-letter count. What
  hangs it is a drain that is merely slow, or this: **`avalon-<region>-migration-commands`
  is shared with the migration tracker's "Force a migration" page.** Anyone
  fanning a Durable Object class into that queue while the script runs keeps
  the backlog above zero for reasons that have nothing to do with automations,
  and the script waits on a number that is no longer about its own work. Check
  the tracker before running it, and read the regional command-queue backlog
  directly before concluding anything is stuck; the run is idempotent and a
  rerun resumes where it stopped.
- `.github/workflows/release-desktop-macos.yml` guards the tag, builds, signs, notarizes, staples, and verifies the macOS package, checks both regional APIs, publishes the immutable payloads, promotes the release manifest, records the release config on `main`, and deploys the landing site from `main`'s then-current tip. The health gate can be bypassed only through the `skip_health_gate` dispatch input. It runs automatically on a merge to `main` matching its `paths:` filter — the files the installed app is built from — bumping the version itself, and on a manual dispatch naming an existing tag. Nothing triggers on a tag.

### Cutting a workspace over by hand, and reading the DLQ

The fleet-wide cutover ran on 2026-08-28 and **there is no cutover workflow left
to retry** — rerunning `deploy-api.yml` only redeploys the Workers. If a
workspace is ever found still holding legacy automation state, the remedy is to
run the retained script directly:

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
  node scripts/cutover-automation-agents.mjs --apply --workspace=<workspace-id>
```

**Name the workspace.** Without `--workspace=` the smallest unit is a whole
region: one command per workspace fanned into
`avalon-<region>-migration-commands`, waking every WorkspaceDO in it to tell all
but one that it is already done. That is a herd for a single repair, it shares a
queue with the migration tracker, and its drain wait is the unbounded one. A
targeted run sends one message and drains in seconds.

It needs the Cloudflare credentials the deploy job used to assert, and
`pnpm migrate:automation-agents` runs it in dry-run mode first, which inventories
both regions and sends nothing. If you do run it region-wide, **check the
migration tracker before you start**: that queue is shared with its "Force a
migration" fan-out, and a class-wide force running concurrently holds the backlog
above zero so the drain loop waits on work that is not yours.

The cutover is roll-forward only. A failed workspace command stays retryable from
its WorkspaceDO campaign ledger; do not deploy an older Worker or recreate
removed tables. Record the region, the script's `runId`, and the workspace ID
from the structured failure before rerunning — the command and every
import/finalization step are idempotent, so a redelivery is safe and a completed
campaign is a no-op.

**Reading the dead-letter queues.** `avalon-global-migration-commands-dead-letter`
and its EU counterpart have no consumer, so nothing drains them and their depth
is cumulative rather than current — as of 2026-08-29 they hold 787 and 1 messages
respectively, all from forced-migration runs between 23 and 27 August, none from
the cutover. That is why the script compares each DLQ against a **baseline taken
at dispatch** and fails on an increase, rather than on a non-zero count. Read
them the same way: the delta across a run is the signal, the absolute number is
history nobody has cleared. Never copy an EU payload into a Global fixture or
diagnostic.

**A `503 automation_cutover_in_progress` is now a repair, not a wait.** While the
cutover was running it meant "your turn is coming"; there is no cutover deploy
any more, so today it means this workspace was carried over and never completed —
exactly the stranded case the script above is retained for. WorkspaceDO refuses
to mint an automation id until its campaign row reads `completed`, so a member
reports "I can't make a new automation" while their existing accepted automations
keep running from their imported objects. Confirm the campaign state, then run
the targeted `--apply` for that workspace; do not wait it out. A workspace
created after the cutover cannot produce this — `WorkspaceDO` seeds its campaign
row as `completed` when it writes its identity — so this only ever names an
object that predates 2026-08-28.

Every other automation failure a person can hit has its own status and sentence
in `apps/api/src/services/automation-agent-errors.ts`; a `500 internal_error`
from an automation route means the object threw a code that table does not name,
which is a defect rather than a state to wait out.

The symbolicator image is the one expensive thing either workflow builds, in the single `crash-symbolicator-container` lane each of them runs it from. Its builder stage compiles `minidump-stackwalk` from source — about three and a half minutes, depending on nothing in this repository — so both workflows run a **Warm the symbolicator image cache** step against a `docker-container` builder before anything builds the image for real. That step is the only one that reads or writes the shared `crash-symbolicator` cache scope; the builds that follow it — the integration lane's own `docker build`, and Wrangler's during a regional deploy — resolve every layer from the warmed builder without naming a cache at all. It warms that builder by **materializing the image** (`load: true`), not by importing cache records alone. A remote cache import is lazy — it resolves the keys without fetching the layers behind them, and BuildKit keeps that only for the solve that imported it — so a cache-only warm-up hands a later, separate `docker build` nothing. That arrangement shipped first and was measured: the warm-up reported every vertex `CACHED` in 2.4s and the lane recompiled the crate from scratch immediately afterwards. Do not revert it to `type=cacheonly` on the reasoning that the image is unused; the image is the point, and its tag is the side effect. `install: true` on `docker/setup-buildx-action` is what points their plain `docker build` at that builder, and it must stay. Buildx now warns that the `docker buildx install` alias it sets is deprecated and names `BUILDX_BUILDER` as the successor; when that alias is finally removed, replace `install: true` with `BUILDX_BUILDER` set to the builder name the setup step outputs, in the same job env the later builds read. Do not simply drop it — a build that silently resolves to the default builder still succeeds, just cold, which is the failure this arrangement exists to make impossible. The warm-up must also stay a JavaScript action rather than a `docker buildx build` line: `type=gha` authenticates with `ACTIONS_RUNTIME_TOKEN`, which the runner injects into actions and never into a `run:` step, so a shell-driven cache silently transfers nothing.

#### Releasing the desktop app

**Nobody bumps a version by hand.** Merge a change that affects the desktop app and it ships: the pipeline picks the next minor, stamps it onto `package.json` and `apps/desktop/package.json`, commits that bump, and builds it. There is nothing to remember and nothing to prepare.

Two things decide a release, in order. The workflow's **`paths:` filter** decides whether a push is release-worthy at all: `apps/desktop/**`, `packages/**`, the root manifests and lockfile, `tsconfig.base.json`, and the release workflow itself. A docs, Worker, or landing-site merge matches nothing there, starts no run, and does not spend a 90-minute signed, notarized build. **Change that list in `.github/workflows/release-desktop-macos.yml` when you add something the installed app is built from** — `release-workflow.test.mjs` pins it, so an entry cannot drift unnoticed, but only the entries the tests name.

`apps/desktop/scripts/plan-release.mjs` then picks the version on a cheap runner before any macOS runner is claimed. `apps/site/release.config.json` records both the last published version and `commit`, the commit that release was built from — the **watermark**. The planner diffs `commit..origin/main` and releases if anything at all has landed since. It reads both the record and that diff at **main's tip, not at the commit that triggered the run**: the job waits for the release queue, and the release ahead of it pushes its `Record Rally <version> release config` commit while it waits, so a plan made from the trigger reads a record that predates a release which has already shipped and cuts that version a second time. The tip is also what the release job goes on to build, so the two agree. It applies no path list of its own: two lists would drift, and the stricter one would silently win. What the watermark adds over `paths:` is the durable half of the question — `paths:` sees only the newest push, so it cannot tell whether the last release actually published, while the watermark makes a release carry everything still unreleased after a run is discarded, cancelled, or fails.

Every published payload is immutable under `v<version>`, so a version can only be released once. The watermark moves with each release, so the same version never comes around twice, and `assertNextReleaseVersion` still requires each release to be exactly one minor above the record. The one-time `0.x` → `1.0.0` stable promotion is deliberately *not* something automation picks: `nextReleaseVersion` always increments the minor, and a major promotion is made by hand.

**A tag is an artifact of a release, never an input to one.** Nothing triggers on `v*`, and the planner never reads tags, so pushing a tag by hand starts nothing and records nothing — the release record is the authority. That also keeps the decision on durable committed state: the concurrency group keeps only the newest pending run, so a rule derived from a single push's diff could have its run discarded and then skip forever, retiring a version silently. The record survives run collapse, which makes the planner idempotent — replaying a merge cannot double-publish.

This replaces two earlier conventions in turn: first recording a release and pre-bumping to the next version afterward, then bumping in the change you intend to ship. The second was correct but silent in the case that actually bit — a merge that changed the desktop app and forgot the bump did not release, and, because the workflow was then unfiltered by path, looked exactly like a merge with nothing to ship. Desktop work piled up on `main` until some later change happened to carry a bump.

##### The pipeline's own commits

A release writes two commits back to `main`, and neither can start another one. The **version bump** lands before the build — that is what keeps the released commit an ancestor of `main` and therefore usable as a watermark — and becomes the new watermark itself, so it is the diff base rather than part of the diff. That matters because the bump edits `package.json` and so *does* match the `paths:` filter. The **recorded release config** lands after publication and touches `apps/site/release.config.json`, which the filter excludes. Both are pushed with `GITHUB_TOKEN`, which does not start workflow runs. Two independent guards on purpose — a release publishes immutable payloads, and a loop cannot be undone by hand.

**The record is excluded from the watermark diff by name**, in `RELEASE_RECORD_PATH`, and that exclusion is load-bearing rather than tidy. The watermark is the commit the release *built*, but the record naming it is pushed as a **later** commit, so it is always present in `commit..HEAD` — `c3a547b "Record Rally 1.33.0 release config"` has its own recorded watermark `f4e66c6` as the direct parent. Without the exclusion the diff is never empty, the "nothing has landed" skip is unreachable, and re-planning a finished release cuts a minor with no work in it.

Two states fail *open* — an unrecorded `commit` (the first plan after this landed, or a publish run outside the pipeline) and a watermark git cannot reach (a force-push or a pruned object). Both cut a release. Skipping one that had work in it retires desktop changes silently, which is the failure this planner exists to prevent; cutting one that had nothing new in it only wastes a build.

A release that fails *after* the bump is pushed leaves `main` bumped and unpublished. That is resumable, not broken: the record still names the old version, so the next plan picks the same next minor, `apply-release-version.mjs` finds the manifests already stamped and commits nothing, and the same version is rebuilt.

The API and the desktop app are ordered by their own durations rather than by coordination between runners. A merge that changes both starts the two workflows together; the Workers deploy in minutes while the signed, notarized app takes tens of minutes, so the API is live long before anything reaches the update channel. The guarantee that matters is not the start order but the regional health gate, which runs after the verified build and before the payloads are published, and blocks distribution when a region is unhealthy. Each workflow serializes itself through its own concurrency group, all of them non-cancelling with `queue: single`: a run already in flight is never killed, and a newer arrival supersedes the older *pending* one. For releases that is the intended policy — intermediate versions do not need to ship, and the newest pending run carries the newest work.

The release and the site deployment deliberately keep separate groups. Sharing one would order them, but `single` cancels the pending member when another queues, so a site deployment could discard a pending release. The residual overlap runs in both directions. A standalone site deployment of an older commit landing immediately after a release could restore the superseded version; the guard is `check-site-release-config.mjs`, which runs against the live channel in the step immediately before the publish, leaving only a seconds-wide window. In the other direction the release itself redeploys the site as its final step, and until 2026-08-27 it built that site from its own checkout — the release commit, by then up to a build's length behind — so a site fix that merged and deployed during the 1.182.0 build was reverted in production for twenty-five minutes. The release now builds the site from the tip of `main`, fetched inside that final step. Every push-triggered `deploy-site.yml` run deploys a commit on `main`, so the fetched tip is never older than one of those; a manual dispatch of that workflow against another branch sits outside the guarantee, and the next release will overwrite whatever it deployed. The race that remains is bounded by work rather than by any timing measurement: for the release to regress the site, an entire `deploy-site.yml` run — runner acquisition, checkout, install, full lint and typecheck, the site tests, and its deploy — would have to finish inside the span of the release's site step, which performs a strict subset of that work. That group is declared at **workflow** level, so the planning job runs inside the queue rather than ahead of it. When the plan is made matters: a plan made while another release is in flight reads a release record that run has not finished writing, so it picks a version that release is about to take, and the bump step can no longer tell a genuine resume of a failed release from a version that has just shipped — that merge's run then dies at the tag or at publish, and its desktop work ships in no release until an unrelated later push happens to match `paths:`. Planning inside the queue settles the record before it is read. The cost is that a plan now waits behind a running release before it can even skip, which the `paths:` filter makes affordable: the runs that queue here are release candidates, not ordinary merges.

The tag is created locally so the existing guards can verify it against HEAD, and is pushed immediately after the payloads are published and the channel is promoted — before the release config is recorded and before the site is deployed. A release that fails before publication leaves no tag, so the same version can be retried by re-running the workflow or by merging a fix. After publication the release is live to updaters and cannot be retried, because a rebuild is not byte-identical and the immutable-object guard rejects it; the tag therefore has to exist by then, so that the remaining steps can be re-run or dispatched on their own. Pushing the tag with `GITHUB_TOKEN` deliberately does not start another run.

`latest-mac.yml` is also the boundary for orphan recovery. A failed attempt can upload one or more versioned objects before it reaches that final commit point, and a freshly notarized retry will not reproduce their bytes. While the live manifest is absent or still names the preceding version, the publisher replaces a mismatched object under the pending version only when the live manifest does not reference that object, verifies the replacement in R2, purges the exact public URL, and streams the ordinary query-free response through SHA-512 before promotion. Once the live manifest names that version, both a mismatch and a missing object are hard failures: published release bytes are never rewritten or regenerated from a fresh build. A missing manifest also fails closed when the checked-in site record says that version already shipped.

Every live publisher first atomically creates `${prefix}/release-publish.lock` in the release bucket with R2's conditional `If-None-Match: *` write. This remote mutex covers GitHub Actions and the documented local command, so a second publisher exits before it reads or changes release state. R2 does not provide conditional deletion, so the key persists: the owner conditionally changes its acquired ETag from `active` to `released`, and the next publisher conditionally changes that released ETag back to `active`. Every ownership transition is atomic, and a paused old process has no unconditional cleanup that could change a newer publisher's lock after manual recovery. If publication succeeds but marking the lock released fails, it reports that the release shipped and continues so the workflow can push the tag and release record; the surviving active lock fails the next publisher until it is repaired. If the process or runner is terminated without cleanup, confirm no publisher is active, inspect that exact lock, and delete only that object before retrying; the lock deliberately has no guessed lease that could expire underneath a slow notarized release.

##### When a release does not happen

Check in this order, because the two causes look different.

**No run appeared at all.** The push matched nothing in the workflow's `paths:` filter. This is the normal outcome for a docs, Worker, or landing-site merge, and it is the cost of filtering at the trigger: there is no run and no log to read, so the filter itself is the only explanation available. Compare the merge's file list against `paths:` in `.github/workflows/release-desktop-macos.yml`. If it should have matched, fix the list — a missing entry silently retires every future change under it.

**A run appeared and planned a skip.** Read its reason. `nothing but the release record has landed since the released commit <commit>` means `main` is already released — the state a completed release leaves behind, and what a re-run of a finished release produces.

To ship a desktop build for a change outside the path set, dispatch the workflow against the tag you want, or land any change inside the set — the watermark means that release carries everything unreleased, not just the change that triggered it.

- `.github/workflows/deploy-site.yml` deploys the landing site on a merge to `main` matching its `paths:` filter — `apps/site`, the shared packages, the lockfile, the root TypeScript config and workspace file, and the workflow itself — and on manual dispatch. The site also deploys as the last step of every desktop release, from the then-current tip of `main`; this workflow covers copy and layout changes that have no release to ride along with.

#### How the site learns the desktop version

`apps/site/release.config.json` is the site's source of truth for the version it advertises and the digests it records, and — through its `commit` field — the release pipeline's record of what has already shipped. The desktop release publisher rewrites that file on its own runner after the payloads are published and the channel is promoted. The release commits the rewritten file back to `main` first, retrying if `main` moved, and refuses to move the record backwards when an older tag is replayed; that retry addresses the temporary sync worktree with `git -C`, and the shell must remain in `GITHUB_WORKSPACE`, because the next attempt removes and recreates the sync worktree after a rejected push. Only then does the release deploy the site, from a second worktree at the freshly fetched tip of `main` — which now carries the committed config — with its own frozen install, filtered to the site's dependency closure: a two-project scope instead of the whole workspace, which keeps Electron and the desktop toolchain out of a step that runs after the release is already live, though `wrangler` and `vite` are site dependencies, so `workerd` and `esbuild` still install there and run their allowed build scripts. The worktree runs the site's own typecheck and tests before deploying, for the one change no other workflow verifies: the record commit is pushed with the Actions `GITHUB_TOKEN`, whose pushes start no workflow runs, so the site tests in this step are the only check that asserts on the freshly committed release config before it ships. The checks are deliberately site-scoped: a lint warning in an unrelated package must not fail a live release's final step. The step ends with the same `check-site-release-config.mjs` guard both site deployments run. Deploying from the tip rather than the release's own checkout is what keeps a release from shipping a site older than one `main` has already deployed; the release checkout is up to a build's length stale by that step, and deploying it is what reverted a live site fix on 2026-08-27. Handing the deploy to another workflow instead — a `workflow_run` trigger on the release, or a dispatch, which the job's `GITHUB_TOKEN` could issue if it were granted `actions: write` — was rejected because either ends the release transaction early: the release run would go green while the site deploy failed in a run nobody is watching, leaving the site advertising the previous version.

If that final step fails, the release itself is complete — the payloads, tag, and record are already live — and must not be rebuilt: re-running the release job dies at the immutable-bytes guard. Dispatch `deploy-site.yml` on `main` instead; its guard passes precisely because the record commit has already landed.

That commit is load-bearing rather than tidy bookkeeping. `plan-release.mjs` treats its `commit` as the watermark for unreleased desktop work, `publish-r2-release.mjs` reads the committed copy through `assertNextReleaseVersion`, so a stale record rejects the *next* release outright, and `check-site-release-config.mjs` compares the same copy against the live channel, so a stale record fails every later site deployment.

If publication and the tag push succeeded but recording the config failed, do not rebuild that version: its immutable objects are already live and a fresh signed build will not reproduce their bytes. Recover the record from the live `latest-mac.yml`, the versioned `SHA256SUMS`, R2 object metadata, and the published tag's commit; commit that recovered record together with the retry fix. The next ordinary release then advances one minor from the recovered version and carries everything after its recorded commit.

The site build only queries the live channel when the config is unpublished: `pnpm deploy` sets `RALLY_RELEASE_DISCOVERY=1`, and `discoverDesktopRelease` returns the configured version immediately when `published` is `true`, falling back to reading `latest-mac.yml` and verifying the canonical installer when it is not. That makes the committed config authoritative for a published channel, and it is why a standalone site deploy between a release and its recorded config would advertise the superseded version. The download link is the canonical `Avalon.dmg` regardless, so the failure is a wrong version string rather than a broken download. `scripts/check-site-release-config.mjs` runs in both site deployments and fails on that mismatch, naming the fix; an unreachable manifest is reported and passed over rather than blocking an unrelated copy change.

Required repository configuration: secret `CLOUDFLARE_API_TOKEN` and variable
`CLOUDFLARE_ACCOUNT_ID` in the `api-production` environment for the API and Ace
deployments and in `site-production` for the site deployment, plus the existing
`desktop-release` environment for the macOS release. `api-production` also holds
`ACE_FLAGSHIP_API_TOKEN`, restricted to Flagship Write on the Avalon account;
the Ace workflow installs it as an encrypted Worker secret. Regional API Worker
secrets are never held by Actions; they are set per region with Wrangler.

Deployments cannot overlap. Each workflow declares a concurrency group, so a second run waits for the first to finish, and a burst of merges collapses to the newest commit: GitHub keeps only one run pending per group and drops the superseded ones. Runs already in progress are never cancelled, so a migration cannot be interrupted halfway. Each run deploys the commit that triggered it, not the tip of `main` at the time it starts.

The one interaction the platform does not sequence is an API deployment overlapping a macOS release, because they are separate workflows. The visible symptom is the desktop release failing its regional health gate while a Worker deployment is mid-flight; re-dispatch the tag once the API run is green. Avoid tagging a desktop release in the same minutes as an API-touching merge.

Because API deployment is continuous, a merge to `main` is a production release. Do not add required reviewers to `api-production`; that environment scopes the Cloudflare token to the deployment job and is not an approval gate. Migrations apply automatically, so a migration is live the moment its pull request merges: an irreversible or destructive migration must be split into backward-compatible steps, and a rollback is a forward migration, never a redeployment of the previous Worker. A failed deployment leaves the migrations applied; recover by fixing forward on `main`.

### The window between a migration and the Worker that needs it

The deploy job applies both regions' migrations before it deploys either Worker, so for the length of one deployment — around twenty seconds when it goes well — **the previous Worker is writing into the new schema**. That is the correct order, because new code must never meet an old table; the consequence is that a new column's `DEFAULT` is not a fallback during that window, it is the value.

Migrations `0090_drop_legacy_product_tables.sql`,
`0094_retire_agent_inference_payload_ledger.sql`, and
`0097_email_routes_use_full_address.sql` are deliberate reverse-order
exceptions. Each deletes tables or columns the previous Worker still names, so
applying either first would break live requests until deployment finished — or
indefinitely if deployment failed. The deployment workflow reads each remote
pending-migration ledger; when one configured Worker-first migration is the sole
pending entry in a region, it deploys the replacement Workers first and applies
that migration afterward. If it has any companion migration, deployment fails
closed instead of silently moving an ordinary migration across the Worker.

For 0090, the replacement Worker probes the regional `workstreams` shape when
reserving an identity anchor and can write both the through-0089 required-column
shape and the final three-column shape. For 0094, the replacement Worker no
longer reads `workspaces.log_agent_inference` or
`agent_inference_payload_logs`, while it remains compatible with a database that
still has them. For 0097, the replacement Worker probes
`workstream_email_routes`: before the migration it reserves and resolves by the
legacy `local_part`; afterward it writes and resolves the full `email_address`.
Its owner-reconciliation path preserves the regional full address in both shapes.
Therefore a failed Worker deploy leaves the old schema untouched,
while a failed migration leaves the compatible Worker serving the old schema.
Detection comes from the remote ledger, not the triggering Git diff, so a
superseded workflow or later regional retry retains the barrier. Once no
Worker-first migration is pending, the workflow automatically returns to the
ordinary migration-first order.

Twenty seconds is the happy path, and it is the figure that makes this rule feel safe to skip. A failed deployment leaves the migrations applied, as the paragraph above says, so a deploy that breaks after the migration step leaves the previous Worker writing through the new default until a fix-forward lands — minutes or hours, not seconds, and every row written in that time takes the default.

So when a migration adds a `NOT NULL` column to a table the Worker writes to on a hot path, **choose the default that is safe for the old code to produce**, not the one that is convenient for the rows already there. Those are different questions and they are answered in different places: existing rows are the migration's own `UPDATE`, which can say anything; rows written during the window get the column default and nothing else. Expect the safe default to cost an extra `UPDATE` rather than nothing — a default picked for the window is usually the wrong answer for some class of existing rows, and that class then needs its own backfill.

**The more general form is to add the column nullable with no default at all**, treat `NULL` as the fail-closed value on read, and tighten it to `NOT NULL` in a later migration once the deployment window has closed. That costs a second migration and buys two things a default cannot: rows written during the window are withheld *and* structurally identifiable afterwards, so they can be found and corrected by a query rather than by a timestamp nobody wrote down. Reach for it when the column governs something a wrong value would be expensive to leave — and note that a read already written as `column = 1` excludes `NULL` for free.

This is not hypothetical. `0063_activity_events_digestible.sql` added `digestible` with `DEFAULT 1` — permissive, so that pre-existing rows kept their prior behavior — and then backfilled the existing connector rows to `0`. Six rows landed in Global between the migration at `18:56:00` and the Global Worker going live at `18:56:23`, took the default, and were marked digestible when every one of them should have been withheld. The blast radius was six lines of noise in one digest, which is why they were left alone; a column governing something less forgiving would not be.

Changing such a default afterwards is far more expensive than choosing it correctly, because SQLite cannot alter one: it takes a full table rebuild, and for a table with children — `activity_events` has `activity_event_targets` cascading off it — that means staging every child row, dropping and recreating the parent, restoring the children, and restoring `sqlite_sequence` by hand where the parent's key is `AUTOINCREMENT`. `0039_slack_connector.sql` is the worked example of the child-staging half, and only that half: it never touches `sqlite_sequence`, because `connector_connections` is keyed by a text id. `activity_events.log_sequence` is the only `AUTOINCREMENT` key in the repository and no migration has ever restored a sequence, so the hardest part of that rebuild has no precedent to copy. The five minutes spent picking the default at introduction is the cheapest it will ever be.

## Provider configuration

Google identity and connector OAuth use two distinct Google Cloud OAuth **Web application** clients in one project. The **Rally Login** client requests only platform identity scopes and has this one redirect URI:

**Register the Rally callback URLs on both Google clients before deploying.**
`callbackUrl()` derives `redirect_uri` from `PUBLIC_API_BASE_URL`, so the moment
that var moves, every Google sign-in and every Google connector authorization
fails with `redirect_uri_mismatch` on its first request. Keep the Rally URLs
registered alongside: they cost nothing and they are what a rollback lands on.

- Global identity: `https://api.rallywith.ai/auth/google/callback`

The **Rally Google Connectors** client owns the Gmail, Calendar, Drive, Docs, and Sheets scopes and has these redirect URIs:

- Global connector: `https://api.rallywith.ai/connections/google/callback`
- EU connector: `https://eu.api.rallywith.ai/connections/google/callback`

`https://rallywith.ai/auth/desktop/` is Rally's browser handoff for login and connector outcomes, and `rallywithai://auth/complete` is the allowlisted desktop return URI. Provider codes always terminate at a regional API callback first; neither handoff URI belongs in Google's authorized redirect URI list. Identity login requests only `openid`, `email`, and `profile`.

Store the Login client as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` on the Global Worker. Store the connector client as `GOOGLE_CONNECTOR_OAUTH_CLIENT_ID` / `GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET` on both regional Workers. The connector runtime deliberately has no fallback to the login credentials.

Settings exposes two authorization presets over one `google` connector family:

- **Google Mail + Calendar** requests `gmail.read`, `gmail.draft`, `gmail.send`, `calendar.read`, and `calendar.write`.
- **Google Drive + Docs + Sheets** requests `drive.read`, `docs.read`, `docs.write`, `sheets.read`, and `sheets.write`.

The exact Google scope URLs are listed in `docs/provider-apps.md`. Google may require sensitive/restricted-scope verification and, for some requested scopes, a security assessment before external production use. A consent screen in Testing or a successful test-user callback is not production approval. Complete the consent-screen configuration, verified-domain and policy requirements, provider verification, and both acceptance flows in `docs/e2e.md` before release.

The production-approved connector scopes use `gmail.modify` for the Gmail capabilities, `calendar.readonly` plus `calendar.events` for Calendar, `drive.readonly` for Drive and native Docs/Sheets reads, and `drive.file` for Docs/Sheets creation and per-file writes. Existing Docs and Sheets discovered through Drive are read-only unless the user separately opens or shares them with Rally; Rally does not currently provide a Google Picker flow for that grant.

Google connector ingestion currently polls Gmail history, Calendar sync/completion cursors, and Drive changes. Drive change-token polling is also the change source for Docs and Sheets. Do not configure or claim Gmail Pub/Sub watch delivery, Calendar notification channels, Drive push notifications, or any Google webhook; none is implemented.

Both regional Workers must use `PUBLIC_WEB_BASE_URL=https://rallywith.ai` so identity and connector callbacks redirect through `/auth/desktop/` before opening the custom protocol. The Global Worker must bind `EU_IDENTITY_BRIDGE` to the EU Worker's named `RegionalIdentityBridge` entrypoint and set `EU_PUBLIC_API_BASE_URL=https://eu.api.with-avalon.com`; do not expose an equivalent public route. Keep `ALLOWED_ORIGINS` exact: hosted Electron uses `app://avalon`; public-site telemetry uses `https://with-avalon.com` and `https://www.with-avalon.com`; local Vite development uses its explicit `http://localhost:<port>` origin. Do not add wildcard, prefix, or suffix patterns.

## Realtime operations and cost controls

- Use deterministic region/workspace IDs for `WorkspaceDO`, region/workspace/work-stream IDs for model-free `WorkstreamDO`, append the external substream ID for each independently provisioned `SubstreamAgent`, and append `block-dashboard:<stable-block-id>` for each configured `BlockDashboardAgent`. Never allocate an object per socket, user, turn, tool call, or retry.
- Respect the authority boundary. REST reads the selected `SubstreamAgent`, its
  parent holds aggregate metadata/outbox, and D1 contains only authority
  routing plus unrelated relational workspace data;
  work-stream directory state is in WorkspaceDO. The child's bounded replay
  buffer remains an in-memory
  optimization. The active checkpoint lives in `active_output_turns` and
  60-KiB `active_output_chunks`, is updated per batched delta, and is removed at
  terminal state. Do not collapse it into one unbounded value.
- Every object constructor applies only bounded, append-only SQL migrations under `blockConcurrencyWhile()`. Diagnose failures through `_sql_schema_migrations`; a hash mismatch means history was edited, `schema_ahead` means the Worker is older than the object, and a foreign-key violation requires quarantine. Product data never moves through a hidden KV importer.
- Keep `acceptWebSocket` and serialized attachments. Replacing them with the standard WebSocket API prevents Durable Object hibernation.
- Keep exact text `ping`/`pong` in `setWebSocketAutoResponse`. The
  SubstreamAgent feed jitters its heartbeat across 45–55 seconds; WorkspaceDO,
  WorkstreamDO control, and BlockDashboardAgent sockets use a fixed 50-second
  heartbeat. Every role waits 15 seconds for `pong` and reconnects with
  equal-jitter exponential backoff capped at 30 seconds. Auto-responses must not
  perform application work.
- Expect one native Chromium WorkspaceDO socket per signed-in Electron
  renderer/workspace, plus one main-process Node WorkstreamDO metadata socket
  and one substream `0` feed for the active work stream, every pin, the five most
  recent unpinned rows, every visible live-state row, and recently viewed pairs
  still inside retention. Navigation must not reopen the WorkspaceDO socket. An
  idle row outside those roles should retain neither child socket. Proactive
  feeds send `publishPresence: false`; verify “Viewing now” against WorkspaceDO
  foreground presence rather than socket counts. Brokered frames are limited to
  1 MB, and a failed managed-network attempt must follow Electron's remaining
  PAC directives in order rather than inventing a direct fallback.
  While the HyperSight panel is visible, Electron also opens one direct
  hibernating socket per configured `BlockDashboardAgent`; closing the panel
  closes those block sockets, and reopening replaces from durable checkpoints.
  WorkstreamDO remains the configuration/preference/terminal-result control
  plane and never relays block token frames. An open idle block socket uses
  hibernation and auto-response rather than billed application timers.
- Verify foreground message ingress on the workspace socket: drop
  the connection after `create_message` but before its private receipt, confirm
  reconnect resends the same `clientMessageId`, and confirm exactly one
  sequenced `transcript_turn_upserted` event and canonical turn exist. A socket attachment from before
  the session-claim deployment should receive `socket_reconnect_required` and a
  1012 close on its first attempted write.
- Verify workspace convergence by mutating timezone, Terminal policy,
  membership/invitations, and connector health from another client. The
  WorkspaceDO socket must advance its topic waterline and refetch only the mapped
  query roots. A reconnect after several changes must receive one newest-waterline
  event with the union of missed topics. Force a replay-window miss and confirm
  the desktop invalidates every workspace surface once rather than polling.
- Verify aggregate convergence by changing title/description/state/read and
  mention metadata, evicting WorkstreamDO, then subscribing again. Confirm each
  transition created `workstream_state_changes` and `durable_outbox` rows with
  a UUIDv7 and increasing common or viewer waterline. The direct work-stream
  socket and Queue-delayed workspace socket must carry the same identity for
  each matching common or viewer row;
  the shared Electron cache must clear nullable fields, ignore duplicate/lower
  waterlines independently, reject an older directory page's pin position, and
  remove the row on authorization revocation. Reconnect the WorkspaceDO socket
  after missing a state push and confirm its resident directory reload repairs
  the gap without a timer.
- Batch model `stream_delta` broadcasts. The direct child loop may use its reference-counted 30-second keep-alive alarm only while active work exists; avoid per-connection alarms and periodic room health polling.
- Resolve every workspace-scoped object through
  `durableObjectStubForWorkspace`: Global must derive IDs from
  `jurisdiction("us")`, EU from `jurisdiction("eu")`, and every child must use
  the affinity stored in `workspaces`, the Global binding, and WorkspaceDO.
  Expect `wnam`/`enam` for Global or `weur`/`eeur` for EU; selecting the western
  value solely from jurisdiction is reserved for migration, background creation,
  or missing request metadata.
  Direct namespace and low-level resolver calls are linted regionalization
  defects. A hint remains best effort and never proves residency; inspect
  `ctx.id.jurisdiction`/constructor failures for the hard lock.
- Monitor reconnect rate, `resync_required` rate, rejected socket origins, active connections, and messages per room. A rise in reconnects or resyncs is an availability signal, not a reason to retain unbounded replay state.
- Dictation uses a separate, non-durable WebSocket bridge because each session has one desktop client and one Azure upstream; it does not need room coordination or persistence. Keep the 60-second Rally ticket, exact Origin check, 256,000-character client-frame bound, and audio-buffer event allowlist. The Worker must set the Azure `api-key` handshake header and must never forward client `session.update` events.
- The renderer captures mono PCM16 in a 24 kHz `AudioWorklet`, sends bounded chunks, and explicitly commits when the user stops. Permission denial, device removal, provider errors, and component unmounts must stop every media track and close both sides of the session.

Cloudflare can terminate long-lived connections during network deployments, so recovery—not socket immortality—is the contract. Verify that a forced disconnect reconnects with a cursor, replays only newer events when available, and refreshes REST state when the room replies `resync_required` without dropping the active checkpoint that frame carries.

### WorkstreamDO authority steady-state operations

Both regions completed the one-time maintenance cutover and are permanently at
`durable_object_open` in `workstream_authority_control`. The campaign machinery
(the cron importer, the per-object import RPCs, and the deploy workflow's
cutover steps) has been retired; the control row, the route directory, and the
minimal three-column work-stream identity anchor deliberately remain. Migration
0090 removes the product tables, their fences, and the completed route-population
triggers. The control row is read on every
request and fails closed — do not delete it, and never edit
`serving_contract_version` manually. `workstream_authority_routes` is now the
live work-stream-to-object directory: creation writes it, and regional effect
delivery fences on its `state`/`generation`.

For a missing or stale product fact, inspect the parent
`WorkstreamDO.durable_outbox` and source child outbox/receipt first. For a
missing sidebar badge/resource route/suggestion feedback row, inspect
`WorkspaceDO.workspace_workstream_effect_receipts` and the corresponding
`workspace_workstream_*` row's authority generation, waterline, and UUIDv7
`source_event_id`. For a missing digest event, Slack mention, or email
notification, inspect that same
`WorkspaceDO.workspace_workstream_effect_receipts` table — activity and mention
effects commit their receipt in the object transaction that commits the event
or intent — and `WorkspaceDO.workstream_notification_intents`. A receiver
receipt with no local outbox row means the owning WorkspaceDO transaction
committed and acknowledged the effect; an outbox row with no receiver receipt
means Queue/consumer-RPC delivery is still retrying. Both rows with the same
hash mean only the acknowledgement RPC is retrying. Never delete an object
outbox row to clear an alert. Repair the receiver/consumer and let the alarm
resend it. A generation/waterline/hash conflict is a producer bug or
restore-generation error and requires quarantine, not last-writer-wins repair.
Effect receipts and terminal notification shells disappear after 30 days; a
redelivery older than that converges on the idempotent product identities
(directory waterline, activity dedupe key, intent ID) instead of a receipt.

Migration 0090 removes the legacy D1 product tables and their writer fences. A
post-cutover `no such table` or `no such column` from a product statement means
the runtime router was bypassed; quarantine and fix that path, and never recreate
the table or fall back to D1. Identity, membership, routing, migration/control,
audit, and telemetry remain valid D1 writers.

## Timezones

- Store only supported IANA names. Existing users and Global workspaces are migrated to `America/Los_Angeles`; existing EU workspaces are migrated to `Europe/London`.
- Electron supplies the Mac timezone during ticket exchange. It seeds an account whose
  `timezone_source` is still `client` and never writes over one somebody chose in settings;
  a client that sends no zone leaves the account alone, because there is no server-side default.
- New Global workspaces default to `America/Los_Angeles`; new EU workspaces default to `Europe/London`.
- Owners and admins may change the workspace timezone. Every user may change their personal
  timezone, which records `timezone_source = 'user'` and stops sign-in reseeding it.
- Calendar automation precedence is explicit trigger timezone, then the automation **author's**
  timezone for personal scope, then the workspace timezone — resolved at acceptance, inside the
  automation's own object, rather than when the draft was compiled, so the scope chosen on the
  create screen and the account adopting a shared template are the ones that answer it. A zone
  the runtime cannot format refuses acceptance with `automation_timezone_invalid` rather than
  falling back silently. The resolved zone is then frozen with the schedule: changing the
  author's account timezone afterwards does not move an accepted automation's calendar runs.

## Observability views and retention

### Log shape

`no-console` is an error across `apps/api/src`, `apps/release-retention/src`,
`apps/site/src`, and `apps/desktop/src`. Every diagnostic goes through a logger
instead:

| Code | Logger | Call |
| --- | --- | --- |
| API Worker, inside a request | `apps/api/src/observability/logger.ts` | `logEvent(c, level, event, fields)` — adds `request_id` and `workspace_id` |
| API Worker, everywhere else | same | `logInfo`/`logWarn`/`logError(env, event, fields)` |
| Retention Worker | `apps/release-retention/src/logger.ts` | `logEvent(level, event, fields)` |
| Desktop client | `apps/desktop/src/common/logger.ts` | `logWarn`/`logError(scope, message, …detail)`, and `logDebug` for the trace level |

`apps/site` is the fourth Worker and appears in no row: it serves static assets
and logs nothing, so it has no logger. It keeps Workers Logs enabled without a
head sampling rate and without traces; give it a logger of its own before adding
the first diagnostic there, rather than reaching for `console`.

The two Workers emit one object per `console` call, which is what Workers Logs
wants: it indexes the object's properties as queryable fields and renders its
`message` property as the row summary in the log list, so an entry needs both.

- **Never `JSON.stringify` an entry.** A serialized entry arrives as one opaque
  string, and no saved view below can filter it.
- **Never log a bare object either.** Without `message`, the row lists as a
  blank line and has to be expanded before it identifies itself. The API logger
  derives one from `event` plus whichever of `method`, `path`, `status`, `code`,
  `flow`, `phase`, `component`, and `duration_ms` the entry carries —
  `http_request GET /notes 200 96ms`, `perf_flow workstream_create api 812ms` —
  and a caller may pass its own `message` instead.
- Keep the summary a restatement of indexed fields. Filter on the fields, not on
  message text; anything only the message says is unqueryable. `message` is
  therefore reserved: a field that holds an opaque provider string is `detail`.
- Name the event, not the sentence. `event` is snake_case and stable, because
  the saved views below filter on it; the prose belongs in the field values.
- The logger already records `region`, `app_version`, and `build_sha`. A field
  named `region` would overwrite the Worker's own, so a different region — an
  EU workspace resolved from Global — is `workspace_region`.

The desktop client logs to a terminal or DevTools rather than to Workers Logs,
so its logger keeps human-readable lines and only owns the scope tag and level.
`logDebug` is the trace level: `console.debug`, which DevTools and a terminal
filter out until a reader opens the Verbose level, which is what lets the
client's performance traces stay on in every build.

Both regional Workers also enable **Workers Traces**
(`observability.traces`, head sampling 1), which instruments handler
invocations, `fetch`, and binding calls automatically and exports OTLP traces
and logs. Because `console` output is attributed to the active span, the
structured rows above are exported as log records carrying that span's trace id,
and a destination correlates them to the trace with no configuration. The custom
spans layered on top are [`performance-tracing.md`](performance-tracing.md)'s;
what the platform itself provides, what its span API does and does not support,
and the beta caveats on its names and prices are in
[`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md). No
OpenTelemetry package is installed, and adding one is the mistake both documents
exist to prevent.

Workers Logs remain at full invocation and head sampling. `pnpm cloudflare:observability` idempotently creates these account-level saved views in Workers & Pages → Observability → Query Builder; each view is scoped to both regional API service names. The read-only `pnpm cloudflare:observability:check` evaluates every definition before failing and prints the complete missing, stale, and duplicate set in one report. The mutating command creates every missing definition in one pass but still fails closed on stale or duplicate names, which require operator review:

| View | Filters |
| --- | --- |
| Failures | `level = error` |
| Invalid model output | `event = request_failed` and `code = model_output_invalid` |
| Slow inference | `event = automation_compiler`, `stage = model_response`, and `latency_ms > 10000` |
| Degraded connector workflows | `event = connector_poll_timeout` or `event = connector_poll_failed` |
| Rejected model calls | `event = agent_inference_attempt_failed` or `event = structured_inference`, and `provider_error_code` exists |
| Broken response contracts | `event = request_failed` and `error_name = ZodError` |
| Harness run outcomes | `event = harness_run_finished` |
| Slow root runs | `event = harness_run_finished` and `duration_ms > 60000` |
| Slow Terminal bootstrap | `event = terminal_daytona_operation_finished`, `operation = sandbox_bootstrap`, and `install_duration_ms > 10000` |

**Operator notifications** are the one push surface. `notifyOps`
([`ops-alerting.md`](ops-alerting.md)) posts to the `OPS_SLACK_CHANNEL_ID`
channel when a Durable Object alarm entry reaches its third consecutive attempt
without progress — `*_scheduled_alarm_failed` or `*_scheduled_alarm_stalled`
for the workspace, work-stream, and agent objects, each also at `level = error`
from that attempt on, so the Failures view carries them — and when a Slack
ingress job is given up on (`slack_ingress_job_exhausted`). Its own outcomes
are `ops_notification_sent` (info) and `ops_notification_failed` (warn, with
`code` and `status`); a region whose notices are all failing is a region whose
operator Slack app needs attention, not a quiet one — `invalid_auth` is the
token, `channel_not_found` or `not_in_channel` is the channel or the missing
invite. Outside `production` and `staging` the notifier posts nothing.

**Work-stream flow latency** has no saved view yet, deliberately: the thresholds
would be guesses until there are production rows to pick them from. Starting,
opening, and sending a message to a work stream each emit one `perf_flow` row per
participant, carrying `flow`, `component`, `duration_ms`, `slowest_step`, and a
`steps` object, alongside the custom spans the same flows open on Workers Traces.
Filter `event = perf_flow` with a `flow` and a `duration_ms` threshold, group by
`slowest_step`, and follow one interaction by `request_id`.
[`performance-tracing.md`](performance-tracing.md) holds the span names, the
attribute registry, and the investigation procedure.

Correlate by `request_id`, `workspace_id`, `region`, `workflow_step`, and
`connection_id`. Pure identifiers are not PII in Rally's logging policy and
should be retained whenever they disambiguate a path: this includes Rally
entity IDs and provider identifiers such as Slack team, user, channel,
client-message, and message timestamp IDs or Linear issue IDs. Do not replace
them with mutable names or email addresses. Compiler events additionally carry
stage, schema, provider/model, fallback attempt, latency, response size, app
version, and sanitized validation paths. Logs must never include prompts, email
bodies, connector content, credentials, file contents, email addresses, or
model context.

Connector adapters add two deliberately redundant structured layers:

| Event | Level and meaning | Useful fields |
| --- | --- | --- |
| `connector_operation_started` | `debug`; an adapter lifecycle branch was entered | `connector_type`, `operation`, IDs relevant to the branch |
| `connector_operation_finished` | `info` for success, `warn` for expected refusal/degraded health, `error` for unexpected failure | preceding fields plus `outcome`, `code`, `duration_ms`, and bounded counts or provider operation ID |
| `connector_provider_request_started` | `debug`; the shared provider transport was entered | `connector_type`, `provider_origin`, `method` |
| `connector_provider_request_finished` | `info` for HTTP success, `warn` for non-5xx provider refusal, `error` for 5xx or transport failure | preceding fields plus `outcome`, `status` or `code`, and `duration_ms` |
| `connector_credential_reauthorization_started` / `connector_credential_reauthorization_finished` | `warn` when a fresh credential is refused; `info` when refresh and retry recover it; `warn` or `error` when they do not | connector and connection IDs, `outcome`, `code`, `rotation_source` |
| `connector_credential_refresh_started` / `connector_credential_refresh_finished` | `debug` at refresh entry, then `info`, `warn`, or `error` at its terminal result | preceding fields plus `reason` and `rotation_source` |
| `connector_provider_retry_started` | `debug`; a rejected call is about to be repeated once with refreshed credentials | preceding fields plus `reason = credential_refreshed` |

Production's normal `LOG_LEVEL=info` retains terminal outcomes while omitting
the high-volume start rows. Temporarily setting a region to `debug` adds both
starts, letting an operator distinguish “never entered” from “entered and did
not reach a terminal log.” Query one operation first by `connection_id`, then
`connector_type` and `operation`; ID-shaped tool arguments appear with a
`provider_` prefix (for example `provider_channel_id` or `provider_issue_id`).
Use provider request rows to determine whether
the adapter called out and what HTTP class returned. Provider URLs are reduced
to their origin. Tool arguments, results, webhook payloads, provider error
messages, OAuth state, health text, headers, credentials, and response bodies
are never fields in these events.

### Root-run analytics

Both API Workers bind `RUN_ANALYTICS` to the account-level Workers Analytics
Engine dataset `avalon_agent_runs`. A root ordinary work-stream or HyperSight
execution writes exactly one datapoint after the harness has produced its final
result, the Workflow has rechecked durable cancellation, and D1 has committed
the effective terminal status. It also emits the correlated
`harness_run_finished` Workers Log carrying workspace, work-stream, and run IDs.

The Analytics Engine point is deliberately a **terminal summary**, not one row
per model turn or loop event. Bind has already computed duration, routed
attempts, tool calls, tokens, and cost; normal result paths also carry exact
turn and model/tool timing totals. Reconstructing those
totals from churn would be both more expensive and incorrect for this store:
Analytics Engine samples at write and query time, does not guarantee retrieval
of an individual point, cannot reconstruct exact event sequences, and supports
neither joins nor unions. D1 is the run ledger. Workers Logs and Workers Traces
are the exact correlated diagnostic path. If a future investigation needs
latency by tool name, give completed tool executions a separate fixed-schema
dataset; do not mix a second event grain into `avalon_agent_runs`.

`writeDataPoint` accepts ordered arrays, so position is the schema. Never reorder
or repurpose a populated slot. Add a new version and unused trailing slots when
the schema grows:

| Column | Meaning |
| --- | --- |
| `index1` | `<source>:<region>` sampling cohort, for example `block_dashboard:eu`; never a unique run ID |
| `blob1` | schema version (`harness_run_v1`) |
| `blob2` | source (`workstream` or `block_dashboard`) |
| `blob3` | terminal status |
| `blob4` | final model ID |
| `blob5` | terminal failure code or `none` |
| `blob6` | region |
| `blob7` | app version |
| `blob8` | build SHA |
| `double1` | end-to-end harness duration in milliseconds |
| `double2` | successfully completed model turns, or zero when `double11 = 0` |
| `double3` | tool calls requested by completed turns, including cached calls |
| `double4` | cumulative model routing/retry/generation time in milliseconds, or zero when `double11 = 0` |
| `double5` | sum of individual tool durations in milliseconds, or zero when `double11 = 0`; this may exceed wall time when tools overlap |
| `double6` | input tokens |
| `double7` | output tokens |
| `double8` | cost in cents |
| `double9` | routed model attempts (the count governed by the 1,000-iteration policy) |
| `double10` | output tokens per second, or zero when unavailable |
| `double11` | detailed timing availability: 1 means `double2`, `double4`, `double5`, and `double10` are measured; 0 means their zeros are placeholders |

No Analytics Engine point contains workspace, work-stream, run, user, prompt,
transcript, tool-argument, tool-result, connector-content, or credential data.
The sampling index follows the primary operator query—caller source by
region—and stays far below the 96-byte index limit. One point uses eight of the
20 blob slots and eleven of the 20 double slots, stays below the 16 KiB aggregate
blob limit, and is one of at most 250 writes allowed per Worker invocation.
Writes are non-blocking and must never be awaited or allowed to change a run's
durable outcome.

Queries must weight every aggregate by `_sample_interval`. This seven-day view
is the starting point for deciding whether a run ceiling is warranted:

```sql
SELECT
  blob2 AS source,
  blob3 AS status,
  count() AS sampled_rows,
  SUM(_sample_interval) AS estimated_runs,
  SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_duration_ms,
  quantileExactWeighted(0.50)(double1, _sample_interval) AS p50_duration_ms,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_duration_ms,
  quantileExactWeighted(0.95)(double3, _sample_interval) AS p95_tool_calls,
  quantileExactWeighted(0.95)(double8, _sample_interval) AS p95_cost_cents,
  max(double9) AS max_routed_attempts
FROM avalon_agent_runs
WHERE blob1 = 'harness_run_v1'
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY source, status
ORDER BY source, status
```

For a dashboard, group the same weighted measures with
`toStartOfInterval(timestamp, INTERVAL '1' HOUR)`. Use `count()` as a sample-size
quality signal, not as the run count; `SUM(_sample_interval)` estimates events,
and `quantileExactWeighted(..., _sample_interval)` is the supported percentile
form. Filter on `index1 = 'block_dashboard:eu'` or
`index1 = 'block_dashboard:global'` for the highest-resolution regional HyperSight
view. Do not use this dataset for exact billing, deduplication, run lookup, or
crash recovery. End-to-end `double1`, calls, tokens, cost, and routed attempts
remain usable on failed rows. Bind currently cannot return its detailed
runToolLoop timing object after a thrown failed/stopped path, so filter
`double11 = 1` before aggregating turns, model/tool time, or output rate; never
interpret the placeholder zeros as measured time.

Query the SQL API with a token restricted to **Account Analytics: Read**, or
connect Grafana through the documented ClickHouse datasource. Analytics Engine
retains data for three months. Its published limits currently include 10
million writes and one million SQL reads per month on Workers Paid before
usage-based charges; Cloudflare's April 2026 pricing page says billing has not
started yet, so re-check the product page before treating that as a budget.
Every `writeDataPoint` is one billable write regardless of how many fields it
contains, which is another reason to record one terminal summary rather than
every churn.

### Terminal platform analytics

Both API Workers bind `TERMINAL_ANALYTICS` to the account-level
`avalon_terminal_operations` dataset. This dataset has one point per Daytona
platform operation and is intentionally separate from `avalon_agent_runs`: a
provider create/bootstrap/start is a different grain from a completed model
run. Writes are non-blocking and advisory. A failed analytics write cannot
change sandbox state.

The fixed `terminal_platform_v1` positions are:

| Column | Meaning |
| --- | --- |
| `index1` | `terminal:<region>` sampling cohort; snapshot remains a grouped blob |
| `blob1` | schema version |
| `blob2` | `sandbox_create`, `sandbox_bootstrap`, or `sandbox_start` |
| `blob3` | `completed`, `failed`, or `policy_mismatch` |
| `blob4` | Rally region |
| `blob5` | configured Daytona snapshot |
| `blob6` | source lifecycle state (`absent`, `stopped`, `archived`, and so on) |
| `blob7` | failed phase, or `none` |
| `blob8` | sorted compatibility capabilities installed, or `none` |
| `blob9` | Rally app version |
| `blob10` | build SHA |
| `double1` | total operation milliseconds |
| `double2` | provider create milliseconds |
| `double3` | provider policy read-back milliseconds |
| `double4` | workspace/package compatibility-install milliseconds |
| `double5` | full capability-manifest verification milliseconds |
| `double6` | number of compatibility capabilities installed |

No point contains a workspace, work stream, run, user, sandbox, repository,
resource, command, path, output, or credential identifier. The dataset therefore
answers fleet/image questions, not exact-work-stream diagnosis. Exact state
continues to come from regional D1 and structured Workers Logs.

`pnpm terminal:analytics` sends sampling-aware SQL to Cloudflare's documented
[Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).
It reports the actual observed start/end, estimated operation counts, and
average/p50/p95/max total latency. Create is decomposed into allocation and
policy read-back; bootstrap into read-back, compatibility installation, and
verification; start is labeled as stopped-sandbox warming or archived restore.
It also expands the fixed installed-capability set into human-readable counts.
Use `--days 1..90`, `--region global|eu|all`, and an optional safe snapshot name.
Analytics Engine retains these points for three months.

The report intentionally refuses to recommend an owned image before 100
successful bootstraps in the selected cohort. At or beyond that sample, a
compatibility-install p95 above ten seconds triggers a prebuilt-snapshot
benchmark—not an automatic switch. Run paired disposable creates in the same
Daytona target and retain manifest verification in both variants. Adopt an owned
snapshot only when its first-ready improvement is material after including
provider create/read-back, warming, archived restore, failure rate, image build
and activation work, and the cost of following managed Daytona updates. A custom
image cannot claim savings from verification, because Rally keeps that phase
for either image.

Automatic tracing is enabled on both API Workers and on the retention Worker at
a `traces` head sampling rate of 1. It is a separate switch from logs: the
`enabled`/`head_sampling_rate` pair at the top of an `observability` block
governs Workers Logs only, and traces stay off until the block also carries
`"traces": { "enabled": true }`. Traces are free during Cloudflare's open beta;
if that changes, lower the traces sampling rate rather than the logs one, which
the saved views above depend on.

**Cloudflare's own capture is wider than ours, and the difference is
credentials.** The application logs `pathname` only and redacts by key, but the
platform records the whole request independently of that: the invocation log
carries `$workers.event.request.url`, the Logpush `Event` field carries the same
request object into R2 for 90 days, and a trace span adds `url.full` and
`url.query`. So a connector OAuth callback's `?code=`/`?state=` and a WebSocket
`?ticket=` reach all three, and no redaction in this repository can reach them —
they arrive on the request rather than through `logEvent`. Both are short-lived
and single-use, but treat the observability stores and the two R2 observability
buckets as credential-adjacent: bucket-scoped write-only delivery credentials,
no wider dashboard access than a responder needs. Moving those two secrets off
the query string is the only fix that removes them from the capture.

Every OpenRouter call that the provider refuses records `provider_error_code` and `provider_error_provider` — the provider's own classification of the rejection, which is what separates a bad model id from a provider outage. The provider's free-text message is deliberately **not** recorded in Workers Logs or the Global lakehouse: some upstreams quote the request back inside it, and the key-based redactor has no way to recognise member content arriving inside provider prose. The Global lakehouse keeps the exact request and the bounded classification; EU inference has no analytical archive. A `request_failed` at `error_name = ZodError` is a response that failed *its own* contract before it left the Worker — the log carries the route and the offending field paths, so fix the row or the schema rather than the caller.

Account-level `workers_trace_events` Logpush jobs route `avalon-api-global` to the `avalon-global-observability` R2 bucket and `avalon-api-eu` to the EU-jurisdiction `avalon-eu-observability` bucket. Both buckets use an automatic 90-day object-expiration rule. Keep the destination credentials bucket-scoped and write-only. The configuration command also reconciles bucket retention and verifies each existing job's filter, fields, destination bucket, and redacted delivery state. The read-only release check must report all saved-query drift at once so a partial repair cannot make the next release discover one definition at a time.

Connector polls have a 20-second adapter cancellation deadline inside a 25-second Workflow step. The step uses three exponentially backed-off retries. A terminal timeout or provider failure moves the connection into a deterministic degraded/error state and emits only structured, redacted metadata; it must never leave the workflow waiting indefinitely.

That deadline must be a **cancellable** one — `createDeadline`/`withDeadline` from `apps/api/src/lib/deadline.ts`, disposed in a `finally`. `AbortSignal.timeout()` cannot be cancelled, so a poll that finished in a second still held its Workflow invocation open for the remaining nineteen. The runtime eventually cancelled each one as a hang and counted it as an uncaught exception, which is what put a steady ~560 errors a day on `avalon-api-global` while every workflow instance reported `complete`. The same rule applies to any deadline created inside a Workflow step, queue consumer, or Durable Object alarm: those invocations end when the handler returns, so an armed timer outlives the work it guarded. Inside a request handler the timer dies with the response and either form is safe.

The deadlines long enough to matter have been converted: the connector poll (20s), the Slack public-channel sync in the activity queue consumer (3 minutes), and the two inside the bind loop's Workflow step — per-tool-call (`TOOL_DEFAULT_TIMEOUT_MS`, 30s) and plugin reauthorization (30s). Not yet converted are the fixed 5–10 second `slackApi` calls in `slack-agent-service.ts`, which hold a queue invocation open for at most ten seconds each; they are the same class and are tracked as follow-up work rather than fixed here. Any new deadline in one of these contexts uses the cancellable form.

Inline read-only subagents use independent ceilings configured with `HARNESS_CHILD_MAX_*`. The production defaults are four model iterations, eight tool calls, 90 seconds, 12,000 tokens, 100 cents, four active credential plugins, 64 KiB of tool schemas, four total runs per chain (the root plus at most three inline children), eight active children per workspace, and depth one. A child inherits and narrows the parent's persisted authority; raising these limits must never enable writes, recursion, or mid-run scope expansion.

### Inspecting a run's raw inference

Structured logs are redacted by design, so they say what a run did and never what
the model was actually asked. When the question is *why did the agent do that* —
a fabricated value, a tool the model never called, a question it should not have
needed to ask — the answer is the recorded request body, and this section turns a
work-stream URL into it. Nothing here mutates production; every step is a read.

The Global inference lakehouse is the only raw-inference surface. For Global
workspaces it captures request and terminal-attempt events automatically,
retains the exact record under `inference-lakehouse/records/` in Global R2, and
exposes typed dimensions plus request/response/error JSON through the
`rally.llm_inference` Iceberg table. EU inference analytics are intentionally
deferred: EU model calls are served normally but are not archived, queued, sent
to Pipeline, or exported to Global. The former workspace preference, D1 payload
index, and `agent-inference/` request-only writer no longer exist.

#### Before querying

1. Copy the work-stream UUID from the canonical
   `https://rallywith.ai/app/workstreams/<uuid>` URL. The current main
   substream ID is `0`. When Rally exposes additional product substreams, copy
   the canonical substream ID from the API response or route that opened that
   substream; do not infer it from an inline child run. These opaque IDs are safe
   to place in the query examples below; do not paste a title, prompt fragment,
   email, or other user content into SQL.
2. Resolve the workspace's immutable **Data region** from the regional API base
   URL serving its authenticated session: `api.rallywith.ai` is Global and
   `eu.api.rallywith.ai` is EU. Use the authenticated API response, not the
   web interface. If it is EU, stop: no lakehouse evidence exists by design. Do
   not search D1, Workers Logs, the unused EU preflight resources, or Global as a
   substitute.
3. For Global, use these resources:

   | Data region | Typed analytical surface | Exact-record `PAYLOADS` bucket |
   | --- | --- | --- |
   | Global | R2 SQL over Data Catalog bucket `avalon-global-inference-lakehouse` | `avalon-global-payloads` |

Use Cloudflare's HTTP APIs, not the dashboard. Global uses R2 SQL. Its endpoint
takes the **Data Catalog bucket name**, not a warehouse ID:

```text
POST https://api.sql.cloudflarestorage.com/api/v1/accounts/<account-id>/r2-sql/query/<data-catalog-bucket>
Authorization: Bearer <inference-lakehouse-api-token>
Content-Type: application/json

{"query":"SELECT ..."}
```

Store a dedicated Global responder token in the ignored `.env.local` as
`INFERENCE_LAKEHOUSE_API_TOKEN`; the existing `CLOUDFLARE_ACCOUNT_ID` supplies
the account path. Never reuse `CLOUDFLARE_API_TOKEN`, which is the deployment
credential. A query needs **R2 SQL Read**, **R2 Data Catalog Read**, and
**R2 Admin Read & Write**. An exact-record download needs R2 storage read access
through the Object REST API. Cloudflare's current
REST permission is account-level rather than cryptographically bucket-read-only:
restrict the token to the Rally account, keep it out of product clients, and use
it only with the GET/POST requests documented here.

R2 SQL is a Cloudflare beta surface. If the HTTP contract has changed, use
Cloudflare's current [R2 SQL query
guide](https://developers.cloudflare.com/r2-sql/query-data/) rather than
guessing. The table and bucket names in this runbook remain repository-owned.
Start with the narrow typed columns and time window below; selecting every JSON
column across an unbounded table is both an unnecessary exposure of customer
content and an unnecessary scan.

#### Find the inference pair

Pipeline rolls files every 300 seconds, so a just-finished call may not be
queryable for roughly one roll interval. Query a bounded time range around the
incident and inspect identifiers before selecting raw JSON:

Use this R2 SQL statement:

```sql
SELECT
  captured_at,
  event_id,
  event_type,
  source,
  invocation_type,
  substream_id,
  request_id,
  parent_request_id,
  inference_request_id,
  turn_id,
  provider,
  model,
  provider_model,
  success,
  disposition,
  failure_kind,
  latency_ms,
  ttft_ms,
  input_tokens,
  output_tokens,
  reasoning_tokens,
  cached_input_tokens,
  cost_microusd,
  response_bytes,
  payload_object_key
FROM rally.llm_inference
WHERE workstream_id = '<workstream-uuid>'
  AND substream_id = '0'
  AND captured_at >= '2026-08-24T19:00:00Z'
  AND captured_at <  '2026-08-24T20:00:00Z'
ORDER BY captured_at ASC
LIMIT 200;
```

Create a scratch directory, save that SQL as `find.sql`, then build the JSON
request body without hand-escaping it and call the Global R2 SQL API:

```text
lakehouse_scratch="$(mktemp -d)"
lakehouse_catalog_bucket='avalon-global-inference-lakehouse'
lakehouse_request="$lakehouse_scratch/find-request.json"
lakehouse_response="$lakehouse_scratch/find-response.json"
node -e 'const fs=require("node:fs"); process.stdout.write(JSON.stringify({query:fs.readFileSync(process.argv[1],"utf8")}))' \
  "$lakehouse_scratch/find.sql" > "$lakehouse_request"
pnpm exec dotenv -e .env.local -- sh -c '
  curl --fail-with-body --silent --show-error \
    --request POST \
    "https://api.sql.cloudflarestorage.com/api/v1/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2-sql/query/$1" \
    --header "Authorization: Bearer ${INFERENCE_LAKEHOUSE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data-binary "@$2" \
    --output "$3"
' _ "$lakehouse_catalog_bucket" "$lakehouse_request" "$lakehouse_response"
```

Keep the response in the scratch directory rather than printing it into a
terminal transcript. Inspect only the identifier and typed columns needed to
choose the `inference_request_id` for the next query.

Use `substream_id` to isolate the product conversation and `request_id` to
isolate one API/harness run. `"0"` is the current main substream. An inline
child remains in the same product substream as its root; identify it by its own
`request_id` and the root's `parent_request_id`, never by inventing another
substream. Each provider call normally has one `request` and one terminal
`attempt` row sharing `inference_request_id`. After copying that opaque ID from
the first query, retrieve only that pair:

```sql
SELECT
  captured_at,
  event_id,
  event_type,
  source,
  provider,
  model,
  provider_model,
  success,
  disposition,
  failure_kind,
  latency_ms,
  ttft_ms,
  request,
  response,
  error,
  metadata,
  payload_object_key,
  payload_sha256,
  payload_bytes
FROM rally.llm_inference
WHERE inference_request_id = '<inference-request-id>'
ORDER BY captured_at ASC
LIMIT 10;
```

Save this statement as `$lakehouse_scratch/pair.sql` and invoke the same R2 SQL
API recipe with `pair-request.json` and `pair-response.json`. That response
contains raw customer content; do not print it, pipe it through a logging tool,
or attach it to an incident.

Interpret the pair rather than one row in isolation:

- `request` is what Rally sent to the provider, including messages, tool
  schemas, routing options, and structured-output schema when applicable.
- `response` is the normalized terminal provider result; `error` and
  `failure_kind` explain a failed attempt. `metadata` carries retry, repair,
  cursor, validation, and source-specific context.
- `model` is Rally's requested route; `provider_model` is the concrete model
  reported by the provider. Do not substitute one for the other in an incident
  report.
- Queue and Pipeline delivery are at-least-once. Duplicate physical rows with
  the same `event_id` are one logical event. A quick duplicate check is:

  ```sql
  SELECT event_id, COUNT(*) AS copies
  FROM rally.llm_inference
  WHERE inference_request_id = '<inference-request-id>'
  GROUP BY event_id
  HAVING COUNT(*) > 1;
  ```

#### Retrieve the exact archived record

Every row also has an exact JSON archive in the Global `PAYLOADS` bucket. Use
the archive when the analytical row is pointer-backed, when the query response
is awkward to inspect, or when byte-for-byte evidence matters.

- If `payload_object_key` is present, use it exactly. The row also supplies the
  expected SHA-256 and byte count.
- Otherwise derive the key as
  `inference-lakehouse/records/<UTC YYYY-MM-DD>/<event_id>.json`, using the UTC
  date in `captured_at`. Ordinary rows omit the pointer columns because their
  complete JSON already fits in the analytical row, but their archive still exists.
- Download it with Cloudflare's R2 Object REST API and the same dedicated token.
  Never use the analytical bucket for this request; it contains the Global
  Iceberg table, not the per-event JSON archive.
- If the pointer supplied `payload_sha256` and `payload_bytes`, verify both
  before treating the file as evidence.

The object GET is also API-only:

```text
lakehouse_payload_bucket='avalon-global-payloads'
lakehouse_jurisdiction='default'
lakehouse_object_key='<generated-object-key>'
lakehouse_expected_bytes='<payload_bytes>'
lakehouse_expected_sha256='<payload_sha256-base64url>'
pnpm exec dotenv -e .env.local -- sh -c '
  curl --fail-with-body --silent --show-error \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/$1/objects/$2" \
    --header "Authorization: Bearer ${INFERENCE_LAKEHOUSE_API_TOKEN}" \
    --header "cf-r2-jurisdiction: $3" \
    --output "$4"
' _ "$lakehouse_payload_bucket" "$lakehouse_object_key" "$lakehouse_jurisdiction" \
  "$lakehouse_scratch/record.json"
node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const bytes = fs.readFileSync(process.argv[1]);
  const digest = crypto.createHash("sha256").update(bytes).digest("base64url");
  if (bytes.length !== Number(process.argv[2]) || digest !== process.argv[3]) {
    throw new Error("inference archive failed byte-count or SHA-256 verification");
  }
  process.stdout.write(`verified ${bytes.length} bytes\n`);
' "$lakehouse_scratch/record.json" "$lakehouse_expected_bytes" \
  "$lakehouse_expected_sha256"
```

Use `avalon-global-payloads` and `default`. The object key is generated by Rally
and contains only the fixed prefix, UTC date, inference ID, event suffix, and
`.json`; do not substitute an arbitrary user-controlled path. The responder
token is for these query and object-GET requests, not for provisioning,
deploying, replaying, deleting, acknowledging a DLQ, or changing table
maintenance.

#### When a row is missing

For a Global workspace, no row is not proof that no model call occurred. Wait
through the five-minute roll interval, confirm the workspace region and time
window, then correlate the content-free Workers events by
`request_id`/`inference_request_id`. For an EU workspace, no row is the designed
outcome and these delivery diagnostics do not exist:

- `inference_lakehouse_stage_failed` means archive or Queue acceptance failed.
- `inference_lakehouse_delivery_failed` means a delivery is retrying.
- A non-empty `avalon-global-inference-lakehouse-dead-letter` queue is the
  definitive terminal delivery alarm.
- `inference_lakehouse_delivered` confirms Pipeline acceptance, not that product
  state committed and not that the row is already visible to R2 SQL.

Keep this distinction during incident reconstruction: the owning
`SubstreamAgent`/`BlockDashboardAgent` `inference_attempts` ledger is operational
authority for attempt recovery, while the lakehouse is best-effort analytical
evidence. Never repair product state from an analytical row.

[`inference-lakehouse.md`](inference-lakehouse.md) owns the complete schema,
Global resource names, deduplication rule, and failure operations.

A retrieved payload contains the prompt, the connector data pulled into it, and
whatever the person wrote. Treat it as production user content: read it from a
scratch directory, do not reproduce it in a user-facing agent response or
persistent task note, keep it out of logs, tickets, and commits, record only the
minimum content-free identifiers and conclusion needed for the incident, and
delete the scratch copy when the investigation is done. Cleanup is explicit and
bounded to the directory created by `mktemp`:

```text
/usr/bin/find "$lakehouse_scratch" -type f -delete
/usr/bin/find "$lakehouse_scratch" -depth -type d -exec /bin/rmdir {} \;
```

What the feature stores and why is
[`inference-lakehouse.md`](inference-lakehouse.md); this section is only how to
read it back.

### Querying analytics events in production

Use the analytics-events lakehouse to debug whether a governed backend or client
event was accepted and what typed metadata it carried. This is a Global-only
analytical surface: if the authenticated session is served by
`eu.api.rallywith.ai`, stop and use the restricted regional telemetry API below.
Do not query Global as a fallback.

Use Cloudflare's HTTP APIs, not the dashboard. Store a dedicated read token in
ignored `.env.local` as `ANALYTICS_LAKEHOUSE_API_TOKEN`; it needs R2 SQL Read,
R2 Data Catalog Read, and R2 Admin Read & Write on the Avalon account. Do not
reuse the deployment token or put this token in a Worker/client variable.

First query promoted, content-free dimensions in a bounded time window. Choose
the source deliberately: `api` is backend; `desktop-main`,
`desktop-renderer`, and `desktop-preload` are native clients; `site` is the
public web client.

```sql
SELECT
  normalized_timestamp,
  event_id,
  event_name,
  source,
  category,
  identity_scope,
  analytics_subject_id,
  workspace_analytics_id,
  release,
  build_id,
  platform,
  architecture,
  channel,
  operation_id,
  request_id,
  trace_id,
  span_id
FROM avalon.analytics_events
WHERE normalized_timestamp >= '2026-08-24T19:00:00Z'
  AND normalized_timestamp <  '2026-08-24T20:00:00Z'
  AND source IN ('api', 'desktop-renderer')
  AND event_name = '<registered-event-name>'
ORDER BY normalized_timestamp ASC
LIMIT 200;
```

Save it as `find-analytics.sql`, then invoke R2 SQL without printing the
response into a terminal transcript:

```text
analytics_scratch="$(mktemp -d)"
analytics_catalog_bucket='avalon-global-analytics-events-lakehouse'
analytics_request="$analytics_scratch/find-request.json"
analytics_response="$analytics_scratch/find-response.json"
node -e 'const fs=require("node:fs"); process.stdout.write(JSON.stringify({query:fs.readFileSync(process.argv[1],"utf8")}))' \
  "$analytics_scratch/find-analytics.sql" > "$analytics_request"
pnpm exec dotenv -e .env.local -- sh -c '
  curl --fail-with-body --silent --show-error \
    --request POST \
    "https://api.sql.cloudflarestorage.com/api/v1/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2-sql/query/$1" \
    --header "Authorization: Bearer ${ANALYTICS_LAKEHOUSE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data-binary "@$2" \
    --output "$3"
' _ "$analytics_catalog_bucket" "$analytics_request" "$analytics_response"
```

Pipeline files roll every 300 seconds, so wait roughly one roll interval before
concluding a just-accepted event is missing. Queue/Pipeline delivery is
at-least-once; treat rows sharing `event_id` as one logical event. Pipeline
handoff is also the current point of no return: a later opt-out, user deletion,
or D1 `acceptance_delete_at` deadline does not retract an Iceberg row, and the
retention columns are metadata rather than proof of catalog deletion. After choosing
one opaque event ID, retrieve its full admitted metadata only when necessary:

```sql
SELECT
  normalized_timestamp,
  event_id,
  event_name,
  source,
  context,
  properties
FROM avalon.analytics_events
WHERE event_id = '<event-uuid>'
LIMIT 10;
```

Write that response to the scratch directory too. Although the telemetry schema
is content-free, identifiers and diagnostic properties are still production
data: do not paste them into logs, tickets, commits, or an agent response. Delete
the scratch directory when the investigation ends.

To distinguish capture from export failure without the web interface, query the
Global D1 outbox and Queue metadata through the APIs/CLI:

```text
pnpm --filter @rally/api exec wrangler d1 execute avalon-global --remote \
  --command "SELECT event_id, analytics_lakehouse_state, accepted_at, analytics_lakehouse_delivered_at FROM telemetry_accepted_events WHERE event_id = '<event-uuid>'"
pnpm exec dotenv -e .env.local -- wrangler queues info avalon-global-analytics-events-lakehouse
pnpm exec dotenv -e .env.local -- wrangler queues info avalon-global-analytics-events-lakehouse-dead-letter
```

`pending` means the first Queue send has not completed; `queued` means at least
one Queue send completed and scheduled recovery will continue redriving it;
`delivered` means the Worker handed the row to Pipeline, not that the current
Parquet roll is already queryable. `suppressed` records a preference recheck;
`rejected` records a permanent integrity or live-schema failure. A non-empty DLQ
is the escalation signal for a dependency failure even though durable recovery
continues from D1.

## Regional telemetry

The five-minute scheduled Worker pass is the normal telemetry operator. In each
region it reaps expired rows and raw objects, suppresses opted-out attributable
work, repairs stale crash-processing claims, processes crash and event/profile
outboxes, and emits one content-free `telemetry_operations_snapshot`. The fixed
fields are pending and terminal counts for accepted events, crashes, and profiles;
rejection and open-circuit counts; and the age of each oldest pending queue. No
event properties, person details, dump bytes, object keys, or stack report may be
added to this log.

Alert when any destination circuit is open, a terminal count is nonzero, a
backlog remains older than 15 minutes, processing failures persist, matching
symbols are unavailable for a current release, or a deletion pass leaves expired
rows or objects. Always inspect Global and EU independently. EU has no PostHog or
Analytics Engine telemetry destination, so a Global delivery graph says nothing
about EU health.

The public site makes `GET /telemetry/route`, then the ordinary anonymous
bootstrap/ingest calls. The route response must be `Cache-Control: no-store` and
must not create a `telemetry_onboarding_journeys` row. A Global route may reuse a
first-party browser epoch; an EU route must remain page-scoped. Verify both paths
after changing CORS, the site deployment, the Global custom domain, or
`EU_TELEMETRY_BRIDGE`; see [`public-site-telemetry.md`](public-site-telemetry.md).

### Operator access

Each regional Worker receives its own `TELEMETRY_OPERATORS_JSON` secret. It is a
JSON object with at most 25 entries; each key is a distinct 32–256 character
bearer token and each value is a fixed principal:

```json
{
  "<opaque-token>": {
    "operatorId": "<operator-uuid>",
    "role": "support"
  }
}
```

The other role is `security`. Use independent tokens in Global and EU, add a new
token before removing its predecessor during rotation, and never put a token in a
URL, log, ticket, or shell history. Requests use `Authorization: Bearer <token>`
against the owning regional API under `/internal/telemetry`:

- `GET /status` returns the fixed regional operational snapshot to either role.
- `POST /replay` accepts `{ "eventId", "reason" }` only from a `security`
  principal. Replay is Global-only; `reason` is `destination_recovery` or
  `incident_response`.
- `GET /crashes/<crash-id>/raw?reason=customer_support` is for `support`;
  `reason=incident_response` is for `security`. It streams one regional dump and
  records the principal, reason, and fixed result code in
  `telemetry_crash_access_audit`.
- EU additionally exposes `GET /eu/crash-issues?limit=<1-100>` and
  `POST /eu/crash-free-launches` with canonical `{ "from", "to" }` timestamps.
  The same paths return `404` from Global.

Start with `/status` in both regions. Use replay only for a known terminal Global
event, and request raw bytes only when the reason genuinely requires them; neither
operation is an exploratory listing surface.

### Destination outage or open circuit

1. Confirm product requests are healthy; telemetry failure must not fail or retry
   the observed product action.
2. Inspect the fixed destination state and oldest Global backlog age. Do not log or
   export accepted envelopes while diagnosing transport.
3. Verify the configured PostHog origin and secret presence without printing the
   token. Ordinary event/profile batches preserve HTTP status: a 408, 429, 5xx, or
   network error retries within the original deadline, while another 4xx is
   terminal. SDK-backed JavaScript/native exception delivery exposes only flush
   success/failure to Rally, so any flush failure retries within the original
   deadline. Investigate a persistent exception retry as a provider or contract
   incident rather than replaying it blindly.
4. Let the five-minute circuit cool down after restoring the destination. Confirm
   pending age falls and the next snapshot reports no open circuit.
5. If a bounded replay is required, call Global
   `POST /internal/telemetry/replay` with the `security` operator credential and a
   `destination_recovery` or `incident_response` reason.
   It preserves event ID, payload hash, route, and deletion deadline. Never replay
   an expired, suppressed, wrong-region, or opt-out row.

### Backlog, rejection, or abuse

Compare accepted, crash, and profile backlogs before changing a limit. A growing
accepted/profile queue points at destination delivery; a growing crash queue may
instead be symbolication or artifact access. Rejection buckets contain only fixed
violation codes, registered event names or `unregistered`, and counts. A crash
upload subject is one-way hashed and limited to ten newly accepted reports per
hour; duplicates do not consume the limit. Do not raise the 50-event/256-KiB batch,
20-MiB dump, or per-subject limit during an incident without a reviewed contract
and cost change.

### Missing source maps or native symbols

Confirm the private artifact exists under the affected region, release, build,
platform, and architecture in `TELEMETRY_PAYLOADS`. The release workflow publishes
to both regional buckets using the two `AVALON_*_TELEMETRY_R2_BUCKET` variables;
the application bundle must not contain source maps or native symbol archives.
Republish the exact immutable artifact for that build rather than substituting a
new build under the old key. An unavailable artifact yields an unsymbolicated
report and remains bounded by the original 90-day occurrence deadline.

### Prohibited data or raw-crash access

Disable the affected registered producer first; do not broaden logger redaction as
a substitute for stopping collection. Preserve the route and original deadline
while identifying affected event IDs through fixed metadata. Delete prohibited
internal rows and objects in their owning region, confirm the next lifecycle pass
finds no survivors, and follow the separate incident/legal process for any data
already delivered to PostHog.

Raw dumps are accessed only through regional
`GET /internal/telemetry/crashes/<crash-id>/raw` by opaque crash ID,
authenticated operator, and `customer_support` or `incident_response` reason.
Every attempt writes `telemetry_crash_access_audit`; logs and audit rows never
contain the R2 key or dump contents. Do not download a dump merely to inspect
whether it exists.

### Cross-region route failure

Check the route stored on the event or crash generation and the routing basis. A
workspace binding is authoritative; an onboarding route is the immediate coarse
classification made when the epoch began. Never rewrite the route, copy the row,
or fall EU telemetry back to Global. Restore the named `EU_TELEMETRY_BRIDGE`,
regional D1/R2, or processor and allow the existing regional retry to continue
within its original deadline. If an affirmative-EU pre-workspace dump was saved,
treat that as prohibited-data handling, not as a delivery problem.

### Preference inconsistency

A disabled account must have nonessential local reporting and upload stopped,
the current Crashpad generation invalidated, attributable undelivered regional
event/profile/crash work suppressed or deleted, and no later profile delivery.
The desktop enables only after the canonical compare-and-set succeeds and reads
the preference fail-closed on each authenticated startup. Reconcile the canonical
Global preference and opaque EU projection by version; never enable from a stale
local `true`. Essential content-free reliability remains eligible.

### Retention or deletion failure

Deadlines are absolute: local material is eligible for at most 14 days; regional
accepted/outbox/receipt/profile/audit/full-crash state and raw dumps for at most 90
days; EU semantic and minimized crash contributions for at most 13 months. Retry
the regional lifecycle job in bounded batches and verify both D1 and the dedicated
telemetry bucket. Do not extend `delete_at`, renew a contribution from issue
recurrence, or keep an object after its index is deleted. A dormant desktop
physically purges expired Crashpad generations on its next launch before upload or
starting the next generation.

[`telemetry.md`](telemetry.md) owns the mechanisms and limits behind these
procedures.

## Incident response

### OpenRouter unavailable

The harness tries configured fallback models within its per-request and stream
watchdogs plus the caller's run policy. Root ordinary work-stream and HyperSight
runs allow 1,000 routed model attempts; durable child dispatch and attempt
leases recover long runs across eviction. Inline children and bounded one-shot
callers retain their smaller wall-time and iteration ceilings. If all models fail, the run becomes `failed`
and the work stream retains its persisted context. Check redacted structured
logs by request, workspace, work-stream, and harness-run IDs; never add prompt
bodies or credentials to logs.

When every candidate answers with a transport fault the provider owns, the
harness re-executes the **whole route plan** up to `HARNESS_TRANSPORT_RETRIES`
times (declared as `1` in both regional Wrangler configs) after a backoff that
honours `Retry-After` up to 30 seconds. So during an outage elevated latency may
be Rally waiting rather than a run hanging. **Set `HARNESS_TRANSPORT_RETRIES` to
`0` and redeploy to stop it everywhere — work streams, inline children, the final
meeting-notes pass, and the automation compiler all read it** — worth doing when a provider is failing broadly,
because each re-execution charges another failure to the per-workspace circuit
breaker whose threshold is 3.

Two failure codes an operator will see, both distinct from
`harness_execution_failed`, which means Rally's own defect:

| Code | Meaning | Triage |
| --- | --- | --- |
| `provider_unavailable` | Rally called and got nothing — no response, a 408, a 429, or a 5xx — and its retries are spent. | The provider. Runs are safe to retry once it recovers. |
| `provider_circuit_open` | Rally did not call: the breaker had already opened, so the run was refused before a request went out. | Read the *earlier* failures that opened it. The breaker also opens on 401/402/403, which are Rally's credential or credit, so this code does not by itself accuse the provider. |

A run failing with either while the provider is healthy points at credentials or
at the breaker's cooldown (60–120 seconds), not at a model outage. The reasoning
behind the split and the retry is
[`agent-harness.md`](agent-harness.md#failure-modes-and-limits).

### Ambiguous external write

Do not retry automatically. A tool invocation left in `ambiguous` means the provider may have accepted the write before Rally recorded confirmation. Inspect the provider using the stored operation metadata, then either reconcile the invocation or ask the user before another write.

### Staged resource publication

A `resource_object_deletion_outbox` row with `cleanup_eligible = 0` is owned by
a publisher, not by R2 cleanup. It is intentionally absent from the maintenance
due queue: a missing pointer alone cannot distinguish an in-flight writer from
a Worker that stopped after uploading its bytes.

Use the authorized object diagnostic/repair surface in the workspace's owning
region. Inspect the exact row by workspace and resource ID, then check both
`resources` and `resource_versions` for its object ref. If either names it, run
the ordinary resource-object maintenance pass; that pass removes only the
staging row. If neither names it, first prove from the owning run/receipt and
publication state that no in-flight operation can still commit that generation.
Only then release that exact row with the equivalent of:

```sql
UPDATE resource_object_deletion_outbox
   SET cleanup_eligible = 1, updated_at = :now
 WHERE workspace_id = :workspace_id
   AND object_ref = :object_ref
   AND cleanup_eligible = 0
   AND NOT EXISTS (
     SELECT 1 FROM resources
      WHERE workspace_id = :workspace_id
        AND (content_ref = :object_ref OR model_content_ref = :object_ref)
   )
   AND NOT EXISTS (
     SELECT 1 FROM resource_versions
      WHERE workspace_id = :workspace_id
        AND (content_ref = :object_ref OR model_content_ref = :object_ref)
   );
```

The next maintenance pass deletes the unreferenced regional R2 object and row.
Do not use age alone, and do not copy the object ref into logs, tickets, or
cross-region tooling.

### Queue backlog or dead letters

Pause connector polling if ingestion exceeds safe capacity. Inspect receipts and activity dedupe keys, fix the deterministic consumer failure, and replay only opaque activity IDs. Unique constraints and processing leases remain the authoritative duplicate barrier.

### Google token revoked

Mark the connection `needs_reconnect` and preserve affected automation state. The mark is a diagnosis, not a gate — dependent tool execution continues and fails on the provider's answer, per [Stored status is a belief, not a gate](connectors.md#stored-status-is-a-belief-not-a-gate). It also does not clear itself: only reauthorization or an explicit connection test returns the row to `healthy`. Reauthorization must request only its previously selected capabilities; do not silently broaden scopes.

### Region mismatch

Do not copy records between deployments. Confirm the desktop-selected region, session claim, workspace region, and target API agree. V1 has no workspace-region migration path.

### Stuck cross-region onboarding reservation

An unknown EU RPC/runtime failure intentionally leaves the Global `platform_workspace_bindings` row in `pending`, even after `pending_expires_at`. Do not delete or reuse it based on time alone: the original regional action may still commit. First inspect the EU user's `workspace_members` and `regional_onboarding_operations` records for the pending operation ID. If membership committed, the user's next `GET /onboarding` discovery activates the existing binding. Only when there is no membership, no operation journal row, and no in-flight RPC may an operator delete that exact pending Global row and let the user retry. Record the reconciliation in the incident log.

### Credential-key rotation

Retain the previous regional key during rotation. Decrypt with the stored key version, re-encrypt with the new active version and connection-bound authenticated data, verify provider access, then retire the old key after all rows have migrated.

## Recovery and data handling

- Before the authority phase opens, D1 is canonical for work streams, messages,
  runs, schedules, connector metadata, and audit events. After it opens, each
  `SubstreamAgent` is canonical for its substream product tables,
  `WorkstreamDO` is canonical for aggregate metadata/outbox, `WorkspaceDO` is
  canonical for cross-work-stream directory/viewer/pin/resource/feedback
  indexes and every workspace-scoped product module, and D1 stays canonical for
  identity/membership, routing, migration/control, and operational
  audit/telemetry only.
- R2 stores large payloads, uploads, and snapshots referenced by their owning
  regional database.
- Use D1 PITR before the work-stream authority open. After open, use object
  PITR/repair for product and directory state and D1 recovery for its remaining
  control/relational modules.
- Production never loads `packages/db/seed.sql`.
- Restore D1 and its corresponding R2 objects as a region-consistent set before resuming Queue consumers or scheduler alarms.

### Finishing the artifact retirement

Retiring artifacts is staged across two releases, for the reason [the migration window](#the-window-between-a-migration-and-the-worker-that-needs-it) gives: the Worker that is live while a migration applies still reads `artifacts` on every `GET /workstreams/:id/context`, so the table cannot go in the same release as the code that stopped reading it. `0069_retire_artifact_messages.sql` therefore only retires the `'artifact'` message type. **A later release still owes a `DROP TABLE artifacts` migration**, and it is safe to write once no deployed Worker reads the table — after the release carrying that code removal is live in both regions.

The R2 objects are the third step and are not reachable from a migration at all. The retired `create_artifact` tool wrote them under `<region>/<workspace>/artifacts/<artifact-id>.txt` in both regions, and `artifacts.content_ref` holds their only pointers — so sweep them **before** the drop lands, or enumerate them from the table first, or they become unreferenced with nothing left to enumerate. Delete by prefix once per region — `wrangler r2 object delete` per key, or a bucket lifecycle rule on the prefix — and confirm the prefix lists empty afterwards. Do it deliberately rather than as part of a deploy: the objects are the last copy of anything an agent wrote there, so anything worth keeping has to be pulled out first.
