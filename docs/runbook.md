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

After the API is running, use `pnpm smoke:local` for the repeatable authentication, work-stream, sidebar-data, idempotency, URL-safety, and realtime acceptance check. The complete desktop acceptance flow is documented in `docs/e2e.md`.

Local authentication is available only when all of these are true:

- `APP_ENV=development`
- `RALLY_DEV_AUTH=true`
- Electron is unpackaged

If the local account cannot sign in, run `pnpm env:sync`, confirm `.env.local` remains owner-readable, and restart both processes. Never add a development-auth value to a hosted Worker.

## Connector installation maintenance

For Ashby or Granola registration recovery and a frozen regional fleet operation,
use [connector installation operations](connector-installation-lifecycle.md#operations).
The repository command uses the existing regional Ace `demos` credential and
supports preview, apply, status, resume and cancel. Preview fixes the selected
connections before any provider mutations; inspect per-target outcomes after an
operation completes. The route's presence does not authorize an operator run.
Deployment order for the dedicated Ashby ingress is in
[API Worker deployment](api-worker-deployment.md#dedicated-ashby-ingress).

## Required hosted resources

- A D1 database

- An R2 payload bucket

- The Worker, Durable Object namespaces, Workflows, and `CRASH_SYMBOLICATOR`
  Container declared in the regional Wrangler file

One account-wide Flagship app, `avalon-api`, holds the agent model-routing and
client product flags and is bound by configured regional Workers; it is not a
per-region resource because a flag holds configuration rather than workspace
data. Configured deployments do send it an evaluation context carrying workspace,
work-stream, and user *attributes* — slugs, counts, ages, roles, origins, email
domains — bounded by the rules in
[`feature-flags.md`](feature-flags.md#what-may-become-an-attribute).

`avalon-api` and its per-agent flags are provisioned, and both regional Wrangler
files carry the `app_id`; [the feature-flag
document](feature-flags.md#provisioning) has the commands for rebuilding them in
a fresh account. Each model flag is seeded with the ids already in the
`OPENROUTER_*` variables. Ace automatically ensures the
`meeting-recording-enabled`, `suggested-work-enabled`, and
`multiple-workspaces-enabled` flags exist with an off default on
every merge that deploys it. Changing their targeting happens in Ace rather
than the Flagship dashboard so connected clients receive the Queue push.

Set these shared Worker secrets separately in each regional deployment:

- `TURBO_PUFFER_PROD_API_KEY` (search; development uses a separate DEV key)

- `OPENROUTER_API_KEY`

- `TYPESAFE_API_KEY`

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
  principal (`support` or `security`) accepted by that region's restricted
  telemetry operator surface

- `OPS_SLACK_BOT_TOKEN` and `OPS_SLACK_CHANNEL_ID`; optional, as a pair — the
  internal Slack app operator notifications are posted with, and the channel
  they go to ([`ops-alerting.md`](ops-alerting.md)). Either absent, the Worker
  posts nothing and `/health` reports `opsNotifications` as not or half configured

Generate independent signing/encryption material per region. Cloudflare administration credentials belong only in the local deployment environment; they must never become Worker variables.

To rotate connector credentials in one region, keep the old key, set `CONNECTOR_CREDENTIALS_KEY` to a newly generated key, increment `CONNECTOR_CREDENTIALS_KEY_VERSION`, and set `CONNECTOR_CREDENTIALS_KEYS_JSON` to a JSON object such as `{"1":"<old key>"}`. Deploy, exercise connector reads/health checks until every row reports the new version, then remove the old mapping. Never increment the version without retaining every key version still referenced by a row; those rows fail closed until that historical key is restored.

Azure agent inference is a separate opt-in pair:
`AZURE_INFERENCE_ENDPOINT` and `AZURE_INFERENCE_API_KEY`. Configure both only
on a Worker whose regional data boundary permits that resource. With neither,
Bind omits Azure and retains an existing OpenRouter route only when that
model's provider policy permits one; Azure-only Sol is unavailable. With only one, the
run fails configuration before provider I/O. The endpoint is the resource root
or its `/openai/v1` base, never HTTP, a deployment URL, or a URL carrying
credentials, query parameters, or a fragment; invalid values fail Worker
startup. The key remains a Worker secret. Rally's checked-in bindings currently map canonical `x-ai/grok-4.3`,
`x-ai/grok-4.6`, and `openai/gpt-5.6-sol` to their Monad production deployment
names. Grok tries Azure before OpenRouter for the same model; Sol is Azure-only
and never traverses to OpenRouter. Model Flagship values stay canonical and must
never contain an Azure deployment name.

The live Monad production endpoint is
`https://monad-prod-resource.services.ai.azure.com`. As verified on 2026-08-30,
the project had the following ten successful deployments. Nine have canonical
OpenRouter identities and participate in the pricing inventory; realtime
transcription does not.

| Azure deployment | OpenRouter pricing key |
| --- | --- |
| `FLUX.2-flex` | `black-forest-labs/flux.2-flex` |
| `grok-4.6` | `x-ai/grok-4.6` |
| `gpt-image-2` | `openai/gpt-image-2` |
| `text-embedding-3-large` | `openai/text-embedding-3-large` |
| `gpt-5.6-sol` | `openai/gpt-5.6-sol` |
| `gpt-5.6-terra` | `openai/gpt-5.6-terra` |
| `gpt-live-transcribe` | none |
| `DeepSeek-V4-Flash` | `deepseek/deepseek-v4-flash-0731` |
| `DeepSeek-V4-Pro` | `deepseek/deepseek-v4-pro` |
| `grok-4.3` | `x-ai/grok-4.3` |

Inference never refreshes this cache, and a route whose primary and fallback
models are all OpenRouter-only does not read it. Bind reads only the Azure-bound
models in the current route, rather than coupling every deployment to every
run. On a cron failure, each stale valid model record remains usable. A rejected
cache read or a missing, malformed, or legacy numeric-cost record makes Bind
omit Azure for that model instead of making an unpriced Azure request; another
model's valid record remains usable. Grok can then continue with its existing
OpenRouter candidate; Sol has no OpenRouter candidate and fails closed.
To inspect the three
currently Azure-routed records without exposing provider credentials, run:

```bash
pnpm --filter @rally/api exec wrangler kv key get x-ai/grok-4.3 --namespace-id <id>
pnpm --filter @rally/api exec wrangler kv key get x-ai/grok-4.6 --namespace-id <id>
pnpm --filter @rally/api exec wrangler kv key get openai/gpt-5.6-sol --namespace-id <id>
```

Use the namespace ID from any of the three pricing-bound Wrangler configs. To
exercise the cron locally, start `pnpm --filter @rally/api dev:pricing`, then
request `/cdn-cgi/handler/scheduled`. Deleting a record is not a refresh
mechanism: retain stale valid pricing during an upstream outage.

### Terminal provider activation and recovery

An activated region requires:

- `TERMINAL_REGION_CAPABILITY=supported` and
  `TERMINAL_EMERGENCY_DISABLED=false`;

- `DAYTONA_API_URL`, `DAYTONA_TARGET`, and
  `DAYTONA_TERMINAL_SNAPSHOT=rally-terminal-1`; and

The weekly snapshot rebuild (`.github/workflows/rebuild-terminal-snapshot.yml`)
reads the same provider values from the `api-production` GitHub environment
rather than from the Workers: `DAYTONA_API_KEY` as an environment secret, and
`DAYTONA_API_URL`, `DAYTONA_TARGET`, `TERMINAL_PROBE_REDIRECT_URL`, and
`TERMINAL_PROBE_PRIVATE_DNS_URL` as environment variables; the job fails
naming whichever Daytona value is absent. The base image and the sandbox size (2 vCPU / 4 GiB / 8 GiB,
`TERMINAL_SNAPSHOT_RESOURCES`) are both pinned in
`apps/api/src/services/terminal/snapshot-manifest.ts`, and both reach production
only through a rebuild and its push to main. The image has an escape
hatch for a one-off build, the `TERMINAL_SNAPSHOT_BASE_IMAGE` variable; the size
has none, so changing it is a commit. Add `TERMINAL_SNAPSHOT_PR_TOKEN`, a fine-grained token with contents
write on this repository, so the rebuild can push the adoption to main; without
it the job fails before the build, because a `GITHUB_TOKEN` push would not start
`deploy-api.yml`. The two probe endpoints are Rally's own on
`rallywith.ai` (`probe-redirect`, a proxied record with a redirect rule to
`https://example.org/`; `probe-private`, an unproxied A record to `10.0.0.1`).

If any required Daytona value is absent, Rally treats that region as
`unsupported` and continues starting without the Terminal plugin. This is the
normal local-development state. Once every value is present, malformed values
still fail the environment contract so an intended provider rollout cannot
silently run against the wrong endpoint.

#### Daytona state synchronization

Deploy the API receiver and Terminal provider Worker from the same change before
provisioning. From the repository root, with the normal Cloudflare operator
credentials and Daytona key in the local environment, run once per regional API:

```sh
pnpm dotenv -e .env.local -- pnpm --filter @rally/api terminal:ensure-webhook --config wrangler.global.jsonc
```

Set `DAYTONA_ORGANIZATION_ID` and `DAYTONA_WEBHOOK_URL` in that operator environment
(the latter is the regional API's HTTPS URL ending `/ingest/daytona`). Use the
matching configured deployment URL and Wrangler file for any future region.
Global is currently the only configured deployment. The Daytona API key must belong to
the named organization and allow webhook administration. No manual dashboard
registration or separate Svix account is required. `SVIX_API_URL` is optional
for a custom Svix server; otherwise the portal token determines its region.

The command initializes Daytona webhooks, obtains an organization-scoped Svix
portal token, and checks every endpoint page for the URL. It reuses an existing
registration or upserts a deterministic endpoint when none exists; ambiguous
duplicate registrations stop setup before any mutation. It installs
`DAYTONA_WEBHOOK_SECRET` and `DAYTONA_ORGANIZATION_ID` directly through Wrangler
stdin, probes the deployed signature verifier, then enables delivery and reads
back the subscription. It never prints or writes the signing secret to disk.
A failed installation/probe leaves the endpoint disabled; rerun the same command
to converge. Provisioning temporarily disables an existing endpoint while
checking its credentials. Periodic reconciliation continues during this window.

Finally, it walks all Daytona sandbox pages and submits signed refresh hints for
existing labelled sandboxes, including archives. Each hint records a fresh
observation at once instead of waiting for the next periodic check. Sandboxes
already deleted before rollout cannot be discovered from Daytona; those old
rows are reconciled on acquisition or their existing retention alarm. A newly
attached generation is due a check at once on its own conversation's alarm; the
observation deadline is never published to the directory. `providerObservation`
on the Terminal state API exposes the last successful observation and its
freshness/error; a successful setup probe proves receiver configuration, not
lifecycle delivery.
Use a disposable sandbox to verify actual provider-generated events after rollout.

The receiver accepts only the configured organization, and uses Daytona metadata
rather than the event's state. Missing metadata is detected by periodic owner
readback. See [Terminal lifecycle and synchronization](terminal-workspaces.md#network-policy-and-lifecycle)
for the ownership, ordering, and recovery rules, and
[Daytona webhooks](https://www.daytona.io/docs/en/webhooks/) and
[Svix portal authentication](https://docs.svix.com/app-portal#authentication)
for the provider setup contract.

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

The command uses `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` restricted
to **Account Analytics: Read**. Its start/end line is the actual first and last
Analytics Engine observation in the requested window, not merely the requested
date boundary.

Use the structured events `terminal_plugin_activation_started`,
`terminal_plugin_activation_finished`,
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

Dictation admission lives in the owning WorkspaceDO's
`realtime_transcription_ticket_receipts` and `realtime_transcription_sessions`;
the old migration `0040_realtime_transcription_admission.sql` D1 tables are
fenced. The one-minute ticket is single-use, and the Worker admits at most two
concurrent sessions per user and twenty per workspace. Each live socket renews
its two-minute lease every minute. The proxy validates frame size and audio-buffer
event shape for every audio-buffer message. Neither
audio nor transcripts are stored by admission.

Alert on `realtime_transcription_session_release_failed`. The Worker retries the
idempotent lease deletion before emitting this event; repeated failures can leave
a slot occupied until its two-minute lease expires and the next admission sweeps
it.

Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` only on the Global Worker. They belong exclusively to the platform login client and are never used by Google service connectors.

Set `RESEND_WEBHOOK_SIGNING_SECRET` and `WORKSTREAM_EMAIL_ADDRESS_KEY` only on the
Global Worker. `RESEND_API_KEY` is required in configured deployments with Resend's
**Full access** permission because each owning region retrieves its own full
message after the Global ingress has routed only signed metadata. An optional
`RESEND_RECEIVING_API_KEY` can override it later if Rally returns to separate
sending and receiving credentials. All non-Global work-stream and automation
email-name reservations use
the Global `WorkstreamEmailRoutingBridge`; there is no regional allocator key or
regional fallback registry.

Production email guest sign-in is configured through checked-in Global vars:
`BROWSER_APP_ORIGIN=https://app.rallywith.ai` and `EMAIL_LOGIN_POLICY_JSON`.
Do not duplicate these as Worker secrets. The policy is six digits, ten-minute
expiry and five failed redemption attempts. The team explicitly chose to launch
without issuance limits; see [email sign-in](email-login.md). Existing signing,
encryption and transactional email credentials remain required. Both API and
browser deployments must succeed before invitation recipients can sign in.
Sharing validates origin/keys before participant-authority handoff.

`RESEND_API_KEY` is shared by the two regional Workers and is used for both invitations and inbound-message retrieval. There are two checked-in senders, both `vars` in each region's Wrangler config: `RESEND_FROM_EMAIL` (`Rally <invites@rallywith.ai>`) for transactional mail, and `RESEND_NOTIFICATION_FROM_EMAIL` (`Rally <notifications@rallywith.ai>`) for mail Rally generates — digests, automation results, mention notifications. Resend verifies the domain rather than the address, so the second rides the same verification; keep both `rallywith.ai` and `with-avalon.com` verified with their own DKIM/SPF records — Resend verifies the sending domain, so the Rally senders do not inherit the Rally verification and mail from them is rejected until the Rally records are live. An unset notification sender does not fail: `sendResendEmail` falls back to the transactional one silently, which is why `GET /health` reports `resendNotificationSender` separately — check it after a deploy that touches either var. Resend acceptance confirms that the transactional request was queued, not final inbox delivery. A provider failure revokes the newly created invitation before the API reports failure.

Inbound work-stream and automation mail uses the dedicated catch-all subdomain `automation.rallywith.ai`. Create it with Resend Receiving enabled, install the exact MX record returned by Resend in Cloudflare DNS, and create one `email.received` webhook pointing to `https://api.rallywith.ai/ingest/resend`. **Keep `automation.with-avalon.com` receiving, with its own MX record and webhook, for as long as any address on it exists.** Addresses are stored per work stream rather than derived, so every address issued before the rename still carries that domain, is printed in the sender's mail client, and is what mail rules forward to; the Worker accepts either domain and resolves the full recipient address in the Global registry. See [`domain-migration.md`](domain-migration.md). Store its `whsec_...` value as the Global `RESEND_WEBHOOK_SIGNING_SECRET`. Ensure the reused `RESEND_API_KEY` has Full access in configured deployments because the regional Worker retrieves the full received message after routing. Store one stable 32+ byte `WORKSTREAM_EMAIL_ADDRESS_KEY` in the Global Worker. Do not log any of these values. Existing deployments using `RESEND_WEBHOOK_SECRET` remain compatible during migration.

For non-interactive Wrangler commands, prefer `CLOUDFLARE_API_TOKEN`. The older global-key method requires both `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL` in `.env.local`; an API key by itself cannot authenticate a deployment.

Use a custom token restricted to the Rally Cloudflare account and the `rallywith.ai` and `with-avalon.com` zones — both are served while the rename is in flight, and a token holding only one of them fails route provisioning for the other. The deployment and migration workflow needs these permissions:

- Account: Account Settings Read
- Account: Workers Scripts Write (shown as Edit in older dashboards)
- Account: D1 Write/Edit
- Account: Workers R2 Storage Write/Edit
- Account: R2 Admin Read & Write — used by explicit lakehouse reconciliation to
  create the Global analytical buckets and Data Catalogs and as the
  non-interactive credential source for their Global Catalog sinks
- Account: Pipelines Write/Edit — used by explicit lakehouse reconciliation to
  create and inspect Global streams, sinks, and pipelines; ordinary deployment
  and Worker ingestion use the pinned bindings instead
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

GitHub Actions keeps each workflow copy of the verified macOS release bundle
for seven days from its creation. That per-artifact expiry is the rolling
window; no scheduled cleanup workflow owns it. Changing the workflow retention
does not shorten artifacts that were uploaded under the previous 30-day policy,
so remove those older copies manually after the workflow change lands. R2
remains the durable release-retention authority described below.

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

`stable/darwin/arm64/Rally.dmg`, the three `*-mac.yml` manifests,
`stable-channel.json`, and `release-publication.json` are mutable state, not
releases. The persistent `release-publish.lock` is operational state. Retention
must preserve all of them in the public bucket. `latest-mac.yml` is the compatibility
feed for builds released before channel selection, `faster-mac.yml` advances on
every desktop release, and `stable-mac.yml` advances no more than once in a
rolling 24-hour window. The JSON receipt records when Stable last moved.

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
   require the mutable pointers. A bucket that predates channel selection may
   temporarily carry only the compatibility manifest; once any new channel
   pointer exists, both channel manifests and both receipts are required. The
   release lock is accepted when present but is not required before the first
   channel-aware publication. An unexpected,
   duplicate, or incomplete key aborts the run before any copy or deletion.
2. Select all versions older than the highest five, except the version still
   named by `stable-mac.yml`. For each exact candidate
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
   require the calculated complete release set plus every mutable pointer in
   active storage, prove every candidate is absent from the active bucket, and
   prove its verified archive copy remains present. Stable may make the active
   set temporarily larger than five when more than five Faster releases land
   inside its 24-hour window.

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

There is one report queue for configured deployments, not one per region as with the
activity queues: every report converges on the single registry object regardless
of where it came from, so splitting the transport would isolate nothing. The
region travels in the message body.

Deploy order still does not matter. The tracker's producer bindings are optional
at runtime, so a tracker deployed before the API Workers have their consumers
reports the region as unreachable on its page rather than dispatching into
nothing.

Deploy in any order:

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

### Running the Spaces cutover

One-time, per region, and it is driven from the migration tracker rather than
from a script. [`spaces.md`](spaces.md) owns the mechanism; this is the
sequence.

**What is being moved.** WorkspaceDO migration 63 seeds a `space_bootstrap` row
`pending` in every Organization, and migration 64 settles every undelivered
Project effect and then deletes the Project tables — there is no barrier in
front of the drops, for the reason step 4 gives. Waking a WorkspaceDO applies
both and arms its alarm, which
claims the first page of cutover work; from there the activity Queue carries
each page to a consumer that places one page of Channels in General. Nobody has
to be signed in.

1. **Deploy, then force `WorkspaceDO`.** On `/migrations`, pick `WorkspaceDO`,
   optionally one region at a time. That is the whole start: the constructor
   applies 61 and 62 and the alarm does the rest.

2. **Watch the cutover row, not the page count.** Through the engineering MCP:

   ```text
   run_workspace_sql: SELECT phase, general_space_id, cursor, attempts,
                             blocked_json, completed_at
                        FROM space_bootstrap WHERE id = 1
   ```

   The phases run `pending` → `general` → `preflight` → `memberships` →
   `finalize` → `complete`. An Organization sitting in `preflight` or
   `memberships` with a moving `cursor` is working: `preflight` walks the whole
   directory asking whether each Channel has somebody to act as and writes
   nothing, and `memberships` is only entered when it found nothing. One
   sitting in `finalize` is refusing to close, and `blocked_json` says why. A
   blocker recorded in `preflight` means **no** Channel in that Organization was
   placed.

3. **Remediate blockers.** Placing a Channel in General changes nobody's access
   ([a Space grants no reader](spaces.md#a-space-starts-organization-wide-and-grants-no-reader)), so
   the one blocker is `space_bootstrap_no_active_actor`: every participant of a
   private Channel has left the Organization. Re-activating one member, or
   deleting the Channel, are the two that move it; leaving it as it is keeps the
   Organization open. A `space_membership_content_fence` left on the row by an
   earlier Worker needs nothing: the next `preflight` pass finds that Channel
   clear and takes it off.

   A `finalize` that refuses sends the Organization back to `preflight` on the
   alarm's ordinary retry interval, so a remediated Organization re-walks and
   closes itself with no further command, and one nobody remediates re-walks
   about once a minute until somebody does.

   **An Organization can also leave `complete` on its own, and that is not a
   regression.** Three things reopen the walk: a `finalize` that refused, a
   connector or seed placement that was refused, and a directory row committing
   for a Channel the Organization was already holding that is in no Space. The
   last is the backstop for a creation path that forgot to place what it made —
   the Organization notices, takes `spacesReady` away while it re-walks, and
   closes again once the Channel has a home. It is deliberately the Channel's
   *second* row that trips it rather than its first: a Channel's first row is a
   creation still in flight, so reopening on one would blank every member's
   sidebar on ordinary creations. A Channel a forgetful path made is therefore
   caught on its next projection, not the instant it appears. An Organization
   that reopens
   *repeatedly* is the signal worth chasing: something is creating Channels
   without placing them, and the `workstream_id` will be in the membership rows
   the next walk writes.

4. **Project retirement needs no operator step.** Migration 62 settles every
   undelivered Project default in the same transaction that drops the tables —
   targets to `terminal` with `project_retired`, publications to `accepted` —
   and the activity consumer acknowledges a message published before the
   cutover with `reason: "projects_retired"`. Nothing is held back for it, and
   nothing is owed: the PRD deletes Projects rather than converting them, so a
   default that never reached a Channel is dropped on purpose. Do not wait for
   the Queue to drain before forcing the class.

5. **Confirm the finish.** `phase = 'complete'` with an empty `blocked_json` in
   every Organization, and an empty regional activity dead-letter queue — a
   dead-lettered `space_bootstrap` or `space_default` message is the terminal
   failure signal for this work, as it is for every other Space delivery.

**Old clients.** Once a region is serving the new payload, a desktop build from
before the cutover is answered `426 client_update_required` on
`GET /workstreams` and `GET /workspace/socket`. **That is a wire-level refusal,
not an update prompt**: no shipped build knows the code, so a pre-cutover
desktop renders it as whatever it shows for a transport failure. The prompt
belongs to builds that ship after this, which declare a contract and can read
the answer.

The gate keys on the **absence of `x-rally-client-contract`**, or on a declared
version below `MINIMUM_SERVED_CLIENT_CONTRACT`. `Origin` only separates a
browser context from a native one: a request with no contract header and no
`Origin` is admitted, because the desktop main process decodes with
schemas that ignore unknown keys and refusing them would break working clients
over a problem they do not have.

### Desktop icon release gate

If desktop icon artwork, generated icon assets, or the icon-family configuration changed, follow [Desktop application icons](desktop-icons.md). Regenerate the assets, build the guarded local desktop package, and verify the running Dock icon in both light and dark macOS appearances before creating a release build. Also inspect Finder to confirm the static bundle icon remains correct.

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

1. Build the API, document-processing, and Terminal-provider artifacts for both
   regions plus the Global pricing Worker, validate the exact Wrangler
   configurations with dry runs, and retain all seven startup profiles. See
   [`api-worker-deployment.md`](api-worker-deployment.md).

3. Confirm each configured regional D1 ID belongs to the intended region. Also
   confirm the platform-shared `rally-platform` D1 binding has database ID
   `39b6800c-7945-4c5b-80cb-e7cdd73af14a` in both API and artifact Workers,
   and that the proxied `AAAA *.rallyusercontent.com -> 100::` wildcard DNS
   record exists. The address is a Cloudflare originless placeholder; proxying
   routes the request to the Worker before that address is contacted.

4. Set the regional Worker secrets.

7. Call `GET /health` after each regional promotion and finally on both APIs
   with `pnpm health:regions`, which fails unless configured deployments report `ok`. That
   now includes the Worker's own environment contract: a region missing a
   required secret answers `503` here and names the keys, rather than reporting
   healthy while every other route returns `service_misconfigured`.

8. Send a workspace invitation to a real test inbox, confirm Resend accepts it, and complete the one-time email-bound acceptance flow.

9. Complete one Google identity login in a provider test account.

10. Connect **Google Mail + Calendar** and verify a Gmail read, Gmail draft, Calendar read, and Calendar test-event create/update. Delete the provider-side test fixture afterward.

11. Connect **Google Drive + Docs + Sheets** and verify a Drive read, native Docs read/write, and native Sheets read/write against disposable fixtures.

12. Establish the Drive poll baseline, change the test Doc and Sheet, poll again, and confirm `docs.document_changed` and `sheets.spreadsheet_changed` arrive through Drive change-token polling.

13. Create an automation from the sidebar, draft it in its conversation, apply it, run it manually, and verify that a repeated **Run now** with the same idempotency key reuses the one run and its child conversation.

14. After every successful deployment, run the configured Gitleaks gate, commit the complete verified release transaction, and push the authorized current branch. A deployment is not complete until its source and release metadata are present on the remote. Never stage `.env.local`, generated release bundles, dependency directories, or local Cloudflare state.

### Automated workflows

Three GitHub Actions workflows carry the mechanical part of this procedure. They are the same commands documented above, so a local operator run and a workflow run remain interchangeable.

- `.github/workflows/ci.yml` runs on every pull request and deliberately does not rerun after a push to `main`: lint, typecheck, the full test suite, both Wrangler dry-run builds, the desktop release invariants, and the Gitleaks gate over the commits the pull request adds to its base branch. Verification fans out across independent Ubuntu runners; the desktop Vitest suite uses two shards, the API Vitest suite uses three, and the workers suite uses two shards, while a terminal `verify` job collapses every lane back into the one stable branch-protection check. Keep `fail-fast: false` so all failures remain visible, and keep `if: always()` on the terminal job so a failed or cancelled lane reports `verify` as failed rather than skipped. Require the `verify` and `secrets` checks through a branch ruleset on `main` to stop a red pull request being merged in the first place. Push-triggered deployment and release workflows continue to verify the workspace themselves before touching production; they do not depend on a second CI run after merge.

- `.github/workflows/release-desktop-macos.yml` freezes the version-bumped release commit and runs lint, typecheck, the Electron desktop test suite (`pnpm --filter @rally/desktop test`), and the release invariants on Ubuntu before it claims macOS; the Apple runner then guards the tag, runs the packaged Crashpad fixture, builds, signs, notarizes, staples, and verifies the macOS package, checks configured regional APIs, publishes the immutable payloads, promotes the release manifest, and records the release config on `main`. The health gate can be bypassed only through the `skip_health_gate` dispatch input. It runs automatically on a merge to `main` matching its cheap admission filter; the Ubuntu planner rejects contract-only changes outside the desktop's derived import closure before bumping or claiming macOS. A manual dispatch names an existing tag. Nothing triggers on a tag.
- `.github/workflows/release-sideline-macos.yml` automatically releases after a
  `main` change to Sideline, its shared UI/contracts, workspace build inputs, or
  the shared macOS release helpers. Its singleton verification job fetches
  `main`, compares that tip with the latest `sideline-v<version>` tag, skips a
  stale run with no outstanding inputs, and stamps the next Sideline patch
  version itself; do not bump `apps/sideline/package.json` by hand. If another
  workflow advances `main` before the stamp is pushed, it fetches and replans,
  including the shared-contract API deployment gate. It never silently builds
  a newer tree using the old plan. The workflow
  freezes the stamped commit, repeats workspace lint/typecheck plus Sideline
  and release-tooling tests, and waits for the matching API deployment when
  contracts changed. It builds, signs, notarizes, and preserves one release
  artifact, then publishes that artifact in a separate job. Retrying a failed
  publication job reuses the same bytes; rerun only failed jobs while the run
  and its artifact are retained.
  Publication verifies the signed arm64 ZIP, DMG, blockmaps, update manifest,
  and canonical installer under `sideline/stable/darwin/arm64/` in the release
  R2 bucket before pushing the Sideline tag. Its R2 reads use the same
  idle-only download as Rally's publisher, never a total-time cap. A publish
  rerun reuses its run's original commit, so after a publisher fix, let the
  push-triggered run resume the pending version rather than rerunning the
  failed one. The `desktop-release` environment's
  `CLOUDFLARE_ZONE_ID` must identify the `rallywith.ai` zone that owns
  `downloads.rallywith.ai`; a successful purge against a different zone leaves
  old installer bytes in the CDN. This workflow does not change Rally's release
  record or landing site.

### Deploying the Sidekick class rename

3. Compare namespace IDs, stored object IDs, accepted revisions, definition and
   address fingerprints, and existing run history. Keep `:automation:` key bytes.

4. Only after verification, ship a separate cleanup removing the old Worker export.

After the rename, recover with a compatible forward deployment; do not point
bindings back at the old class or replay historical migration tags. Local builds
cannot establish production namespace preservation.

### Debugging an automation

An automation's rows are its Organization's: `automation_directory` and the
`sidekick_*` tables in `WorkspaceDO`, filtered by `sidekick_id`.
Its conversations are
`SubstreamAgent`s named `<region>:<workspace>:<automationId>` (the chat) and
`<region>:<workspace>:<automationId>:<runId>` (each run).
[`automation-lifecycle.md`](automation-lifecycle.md) owns the object; this is
where to look when one misbehaves.

- **"I can't find my automation."** The sidebar lists what
  `listAutomationDirectory` returns: `workspace` automations and the viewer's
  own `personal` ones, never a room's. A room's automation is in that room's
  rail. `GET /automations/:id` reads the object and answers 404 for a deleted
  one or a viewer the object refuses.
- **The sidebar row is stale.** The row is written in the Sidekick's own
  change, in `WorkspaceDO`, and the same call bumps the `automations` sidebar
  waterline and republishes the list. Read the row with `run_workspace_sql`;
  if it is right and the client still shows the old one, the client missed
  the push and a reconnect or reopen will fetch the list again.
- **Apply refuses.** The code is the answer: `sidekick_definition_not_ready`
  (the chat has not submitted a ready draft), `sidekick_plugin_unavailable`
  and its binding siblings (the workspace no longer has the connection the draft
  named), `sidekick_timezone_invalid`, `sidekick_recurrence_has_no_future`.
  A 500 from `POST /automations/:id/accept` is a fault, not a refusal.
- **The wizard never reviewed it.** `automation_directory.runs_since_review`
  is how many finishes under the accepted revision have counted since the
  last review or revision; `reviewed_at` is the last request. Below ten, or
  within three days of `reviewed_at`, nothing is owed. Otherwise look for the
  `<sidekickId>:review` entry in `_internal_durable_alarms` and the
  `sidekick_review_skipped` log line, whose `no_managing_delegate` means no
  eligible delegate may also manage the Sidekick. A `sidekick_reviews` row with
  `delivered_at` null is a notice the Queue still owes the wizard; the
  consumer's `sidekick_review_delivery_retry` line carries the refusal code.
  What reviews changed: `sidekick_revisions` rows whose `review_id` is not
  null, each the revision a review submitted, joined to `sidekick_reviews`
  for when; the `sidekick_review_revised` log line counts them.
  [`automation-lifecycle.md`](automation-lifecycle.md#scheduled-self-review)
  owns the review.
- **A scheduled run did not fire.** Inspect the object's `schedules`
  (`next_due_at` null means the rule has no future occurrence) and
  `_internal_durable_alarms` (an `automation_schedule` entry behind its retry
  gate). `sidekick_scheduled_alarm_failed` and
  `sidekick_scheduled_alarm_stalled` name the entry and the handler's code.
  A paused automation fires nothing and does not catch up on resume.
- **An event did not start a run.** `external_event_delivery_terminal` records
  the admission outcome per registration: `sidekick_paused`,
  `sidekick_event_before_activation_boundary` (the event's sequence is at or
  below `effective_after_event_sequence`, so it predates the apply that
  registered the rule), or `sidekick_occurrence_replayed` (a redelivery). No
  delivery at all means the matcher found no active registration, which
  `WorkspaceDO.workspace_external_event_registrations` will show.
- **Mail did not start a run.** `inbound_email_receipts` on the object holds
  one row per Resend email id with the refusal code
  (`sidekick_not_active`, `sidekick_email_route_mismatch`,
  `email_sender_not_authorized`) or the run it admitted.
- **A run stopped early.** `runs.state` on the object is what its child
  conversation last reported; `stopped` with the automation `paused` or
  `deleted` is a pause or delete after admission, and the run's provider writes
  were refused with "This automation run is no longer running". A run that
  never left `pending` has an `automation_run` alarm entry behind its gate.
- **A result never reached the room.** Only the run posts, with
  `conversation_post`; look for `conversation_archived`,
  `conversation_access_denied`, `conversation_not_in_scope` or
  `conversation_post_refused:<code>` in the run's tool results, and check the
  Sidekick's home (`automation_directory.owning_substream_id`). Nothing posts
  after the run.

Inspect the object through the engineering MCP's raw SQL per
[`engineering-mcp.md`](engineering-mcp.md); the automation's tables are listed
in [`workstream-durable-object.md`](workstream-durable-object.md#hosted-sidekicks).
Keep retrieved user content out of tickets and logs.

The symbolicator image is the one expensive thing either workflow builds, in the single `crash-symbolicator-container` lane each of them runs it from. Its builder stage compiles `minidump-stackwalk` from source — about three and a half minutes, depending on nothing in this repository — so both workflows run a **Warm the symbolicator image cache** step against a `docker-container` builder before anything builds the image for real. That step is the only one that reads or writes the shared `crash-symbolicator` cache scope; the builds that follow it — the integration lane's own `docker build`, and Wrangler's during a regional deploy — resolve every layer from the warmed builder without naming a cache at all. It warms that builder by **materializing the image** (`load: true`), not by importing cache records alone. A remote cache import is lazy — it resolves the keys without fetching the layers behind them, and BuildKit keeps that only for the solve that imported it — so a cache-only warm-up hands a later, separate `docker build` nothing. That arrangement shipped first and was measured: the warm-up reported every vertex `CACHED` in 2.4s and the lane recompiled the crate from scratch immediately afterwards. Do not revert it to `type=cacheonly` on the reasoning that the image is unused; the image is the point, and its tag is the side effect. `install: true` on `docker/setup-buildx-action` is what points their plain `docker build` at that builder, and it must stay. Buildx now warns that the `docker buildx install` alias it sets is deprecated and names `BUILDX_BUILDER` as the successor; when that alias is finally removed, replace `install: true` with `BUILDX_BUILDER` set to the builder name the setup step outputs, in the same job env the later builds read. Do not simply drop it — a build that silently resolves to the default builder still succeeds, just cold, which is the failure this arrangement exists to make impossible. The warm-up must also stay a JavaScript action rather than a `docker buildx build` line: `type=gha` authenticates with `ACTIONS_RUNTIME_TOKEN`, which the runner injects into actions and never into a `run:` step, so a shell-driven cache silently transfers nothing.

#### Releasing the desktop app

**Nobody bumps a version by hand.** Merge a change that affects the desktop app and it ships: the pipeline picks the next minor, stamps it onto `package.json` and `apps/desktop/package.json`, commits that bump, and builds it. There is nothing to remember and nothing to prepare.

Two things decide a release, in order. The workflow's **`paths:` filter** is a cheap admission filter: `apps/desktop/**`, all of `packages/contracts/**`, the root manifests and lockfile, `tsconfig.base.json`, and the release workflow itself. A docs, Worker, landing-site, agent-harness, connector, or database-only merge starts no run. Every contracts change does start the Ubuntu planner, because a broad trigger cannot miss a new file or rename.

`apps/desktop/scripts/plan-release.mjs` then picks the version on that cheap runner before any macOS runner is claimed. `apps/site/release.config.json` records both the last published version and `commit`, the commit that release was built from — the **watermark**. The planner diffs `commit..origin/main` with rename detection disabled so a file moved out of a release-input directory still reports its deleted source path. It derives the production contract-module closure from imports in production desktop source, shared UI source and release tooling, then follows relative and `@rally/contracts` package imports inside contracts. It releases only when that entire diff contains a desktop input. Shared UI source, styles, fonts and its package manifest are desktop inputs through both the workflow filter and planner. Classifying the watermark diff rather than the triggering push preserves work when concurrency discards an intermediate run. Contract tests and changes confined to API-only modules such as `durable-object-migrations.ts`, `engineering-inspection.ts`, or `text.ts` therefore produce a distinct, explained Ubuntu skip rather than a macOS build. If the runtime classifier cannot resolve its graph, the planner warns and fails open to a release: an extra macOS build is preferable to silently retiring desktop work.

The planner reads both the record and that diff at **main's tip, not at the commit that triggered the run**: the job waits for the release queue, and the release ahead of it pushes its `Record Rally <version> release config` commit while it waits, so a plan made from the trigger reads a record that predates a release which has already shipped and cuts that version a second time. The following Ubuntu job applies the version bump to the newest available tip, freezes that commit, and runs lint, typecheck, the full test suite, and release invariants against it. The macOS job checks out that emitted SHA rather than resetting to a later `main`, so it cannot sign code those gates did not see; commits arriving after the freeze wait for the next queued release.

Every published payload is immutable under `v<version>`, so a version can only be released once. The watermark moves with each release, so the same version never comes around twice, and `assertNextReleaseVersion` still requires each release to be exactly one minor above the record. The one-time `0.x` → `1.0.0` stable promotion is deliberately *not* something automation picks: `nextReleaseVersion` always increments the minor, and a major promotion is made by hand.

**A tag is an artifact of a release, never an input to one.** Nothing triggers on `v*`, and the planner never reads tags, so pushing a tag by hand starts nothing and records nothing — the release record is the authority. That also keeps the decision on durable committed state: the concurrency group keeps only the newest pending run, so a rule derived from a single push's diff could have its run discarded and then skip forever, retiring a version silently. The record survives run collapse, which makes the planner idempotent — replaying a merge cannot double-publish.

This replaces two earlier conventions in turn: first recording a release and pre-bumping to the next version afterward, then bumping in the change you intend to ship. The second was correct but silent in the case that actually bit — a merge that changed the desktop app and forgot the bump did not release, and, because the workflow was then unfiltered by path, looked exactly like a merge with nothing to ship. Desktop work piled up on `main` until some later change happened to carry a bump.

##### The pipeline's own commits

A release writes two commits back to `main`, and neither can start another one. The **version bump** lands before the build — that is what keeps the released commit an ancestor of `main` and therefore usable as a watermark — and becomes the new watermark itself, so it is the diff base rather than part of the diff. That matters because the bump edits `package.json` and so *does* match the `paths:` filter. The **recorded release config** lands after publication and touches `apps/site/release.config.json`, which the filter excludes. Both commits are pushed with `GITHUB_TOKEN`, which does not start workflow runs. The intervening tag push uses the `desktop-release` environment secret `DESKTOP_RELEASE_GITHUB_TOKEN`, a user or GitHub App token with repository contents and workflow write permission, because GitHub rejects `GITHUB_TOKEN` when the tagged tree changes a workflow relative to current `main`. Before the Apple build begins, the workflow proves that authority server-side by creating and immediately deleting a uniquely named non-release tag at the frozen release commit; a nonempty-secret check alone cannot catch an expired or under-scoped token, and a dry run does not exercise GitHub's ref-creation permission. The workflow's branch-only trigger means both the probe and release tag pushes cannot re-enter the release. Two independent guards on purpose — a release publishes immutable payloads, and a loop cannot be undone by hand.

**The record is excluded from the watermark diff by name**, in `RELEASE_RECORD_PATH`, and that exclusion is load-bearing rather than tidy. The watermark is the commit the release *built*, but the record naming it is pushed as a **later** commit, so it is always present in `commit..HEAD` — `c3a547b "Record Rally 1.33.0 release config"` has its own recorded watermark `f4e66c6` as the direct parent. Without the exclusion the diff is never empty, the "nothing has landed" skip is unreachable, and re-planning a finished release cuts a minor with no work in it.

Two states fail *open* — an unrecorded `commit` (the first plan after this landed, or a publish run outside the pipeline) and a watermark git cannot reach (a force-push or a pruned object). Both cut a release. Skipping one that had work in it retires desktop changes silently, which is the failure this planner exists to prevent; cutting one that had nothing new in it only wastes a build.

A release that fails *after* the bump is pushed leaves `main` bumped and unpublished. That is resumable, not broken: the record still names the old version, so the next plan picks the same next minor, `apply-release-version.mjs` finds the manifests already stamped and commits nothing, and the same version is rebuilt.

The API and the desktop app are ordered by their own durations rather than by coordination between runners. A merge that changes both starts the two workflows together; the Workers deploy in minutes while the signed, notarized app takes tens of minutes, so the API is live long before anything reaches the update channel. The guarantee that matters is not the start order but the regional health gate, which runs after the verified build and before the payloads are published, and blocks distribution when a region is unhealthy. Each workflow serializes itself through its own concurrency group, all of them non-cancelling with `queue: single`: a run already in flight is never killed, and a newer arrival supersedes the older *pending* one. For releases that is the intended policy — intermediate versions do not need to ship, and the newest pending run carries the newest work.

One verified artifact set serves two desktop release channels. The publisher
always advances `faster-mac.yml` and the legacy `latest-mac.yml`; the latter is
kept so an older installation can receive the build that introduces channel
selection. `stable-mac.yml` is the default for channel-aware builds. It advances
only when `stable-channel.json` proves that at least 24 hours have elapsed since
the previous public Stable promotion. Faster's manifest is also the durable
newest candidate for Stable: the hourly `promote-desktop-stable.yml` workflow
promotes it on the first scheduled run after the gate opens even when no newer
desktop release is published. GitHub schedules may run late, so the workflow
provides a minimum interval rather than an exact promotion time. The receipt is
written after the Stable manifest is publicly verified, so upload time cannot
shorten the interval. If the receipt is missing or behind the manifest after an
interrupted publish, either reconciler repairs it at the current time and skips
that promotion. This deliberately delays Stable rather than risking two
promotions inside one day. Before the first channel-aware release, the cron sees
both manifests absent and exits successfully, so deploying the workflow does
not disturb current installations.

The cron has its own `desktop-stable-promotion` concurrency group. Sharing the
release workflow's `queue: single` group would let an hourly tick cancel a
pending desktop release. Both paths instead serialize the authoritative R2
read, decision, and writes through the same `release-publish.lock`. A cron that
finds an active lock fails visibly and the next hourly run retries. This may be
ordinary contention with a live publisher, but it also ensures an abandoned
lock cannot freeze Stable behind indefinitely green scheduled runs. Likewise,
the promoter treats a failure to mark its lock released as a failed run.

The setting is a device preference, not an account or workspace preference.
Electron Updater selects `stable-mac.yml` or `faster-mac.yml` from the embedded,
signature-checked generic feed. Changing channels never enables downgrade: a
Mac moving from Faster to Stable stays on its installed version until Stable
advances past it. Changing the selection also invalidates any check, download,
or restart prompt from the previous feed. Rally disables install-on-quit for a
staged previous-channel build, waits for active updater work to settle, and then
checks the newly selected feed; only a download from that feed re-enables
install-on-quit. The site and `Rally.dmg` continue to advertise the newest
published desktop release; the channel choice governs automatic updates.

A downloaded update does not interrupt: the app offers the restart in the
window, and the native **Update ready** dialog appears only once the running
build is more than seven days old (`STALE_BUILD_PROMPT_AGE_MS` in
`updater.ts`). The build's age comes from `__RALLY_BUILD_TIME__`, which
`electron.vite.config.ts` stamps into the main bundle; an unstamped build never
prompts.

The first automatic check waits ten minutes after launch
(`STARTUP_CHECK_DELAY_MS` in `updater.ts`), so the feed request and any
download stay out of startup; after that Rally checks every three hours. **Check
for Updates…** and a channel change still check at once.

A staged build does not stop the three-hourly check. Those checks run with
`autoDownload` off so the staged version is not fetched and handed to Squirrel
again; when the feed names a different (and so newer) version, Rally downloads
it and the restart offer moves to it once it lands. Until then the offer for
the staged build stays up, and a failed check or exhausted download retries
leave it in place without the manual-installer prompt; the next check tries
again. A restart in the moment between the newer download finishing and
Squirrel staging it may install the older staged build, which the next check
then updates.

Desktop publication and landing-site deployment are independent. The release workflow advances the canonical `Rally.dmg`; `deploy-site.yml` is the only workflow that publishes the landing Worker, whose direct canonical link does not render or otherwise depend on a desktop version. This separation removes both directions of the old race: a site deploy cannot carry stale release metadata, and a long-running desktop release cannot overwrite a newer site. The latter happened during the 1.182.0 build on 2026-08-27, when the release redeployed its hour-old site checkout and reverted a live fix for twenty-five minutes. The intermediate mitigation rebuilt the site from the tip of `main`; once the homepage stopped rendering release state, removing the redundant release-time deployment eliminated the race instead.

The desktop release concurrency group is declared at **workflow** level, so the planning job runs inside the queue rather than ahead of it. When the plan is made matters: a plan made while another release is in flight reads a release record that run has not finished writing, so it picks a version that release is about to take, and the bump step can no longer tell a genuine resume of a failed release from a version that has just shipped — that merge's run then dies at the tag or at publish, and its desktop work ships in no release until an unrelated later push happens to match `paths:`. Planning inside the queue settles the record before it is read. The cost is that a plan now waits behind a running release before it can even skip. The admission filter still excludes unrelated packages; an admitted contract change outside the desktop closure consumes only this cheap planner job. Ubuntu release verification has a team-selected 60-minute ceiling after the full repository suite exceeded the previous 30-minute budget. It runs only the Electron desktop tests and release invariants; the broader test suites remain in repository CI. This keeps unrelated backend tests out of the desktop release queue while bounding how long a wedged verification can hold it.

The tag is created locally so the existing guards can verify it against HEAD, and is pushed immediately after the payloads are published and the channel is promoted — before the release config is recorded. A release that fails before publication leaves no release tag, so the same version can be retried by re-running the workflow or by merging a fix. The credential preflight's uniquely named tag is not a release artifact: it is created and removed before packaging, with an exit trap making a best-effort cleanup if the permission proof fails partway through. After publication the release is live to updaters and cannot be retried, because a rebuild is not byte-identical and the immutable-object guard rejects it; the release tag therefore has to exist by then, so that the remaining recording step can be recovered independently. Only the preflight and that release-tag push use `DESKTOP_RELEASE_GITHUB_TOKEN`; the later record push keeps `GITHUB_TOKEN`, preventing an automation loop while still allowing a tag whose historical tree contains a different workflow revision.

`release-publication.json` is the recovery boundary for a publication that has
begun changing mutable objects. After every immutable artifact is verified but
before `Rally.dmg` or any manifest moves, the publisher durably records the exact
manifest bytes and validated site-record inputs. A retry of that same version
uses this receipt rather than the newly rebuilt signing output, restores the
canonical DMG from the receipt-named immutable object, and idempotently finishes
Stable, its cadence receipt, Faster, the compatibility manifest, and the site
record. The publisher validates the legacy manifest, both channel manifests,
both receipts, and the future site record before its first write, so an orphan
or ahead Stable receipt cannot leave another manifest partially advanced.

Before this recovery boundary, a failed attempt can upload one or more
versioned objects and a freshly notarized retry will not reproduce their bytes.
While no prepared receipt or live manifest names that version, the publisher
may replace a mismatched orphan under the pending version, then repeats every
hash and public-domain verification. Every one of those downloads, from the R2
API or the public domain, aborts only after 30 seconds with no bytes arriving,
never on total transfer time: a healthy ~183 MiB zip can take longer than any
fixed wall-clock deadline, and a 5-minute one failed two notarized 1.479.0
attempts while hashing the existing orphan. Once the prepared receipt or a live
manifest names that version, recovery uses the recorded exact bytes; published
release bytes are never regenerated from a fresh build. If publication stops
after `release-publication.json` appears, rerun the same release workflow or tag
instead of rebuilding a different version or manually copying channel
manifests. A missing compatibility manifest still fails closed when the
checked-in site record says that version already shipped.

Every live publisher first atomically creates `${prefix}/release-publish.lock` in the release bucket with R2's conditional `If-None-Match: *` write. This remote mutex covers GitHub Actions and the documented local command, so a second publisher exits before it reads or changes release state. R2 does not provide conditional deletion, so the key persists: the owner conditionally changes its acquired ETag from `active` to `released`, and the next publisher conditionally changes that released ETag back to `active`. Every ownership transition is atomic, and a paused old process has no unconditional cleanup capable of changing a newer publisher's lock after manual recovery. If publication succeeds but marking the lock released fails, the release publisher reports that the release shipped and continues so the workflow can push the tag and release record; the scheduled Stable promoter instead fails because it has no post-publication record to finish. Either way the surviving active lock makes subsequent runs red until it is repaired. If a process or runner is terminated without cleanup, first confirm in GitHub Actions and the local release environment that no publisher or promoter is active. Inspect that exact R2 key's `state` and `owner` metadata, then delete only `${prefix}/release-publish.lock` and rerun the failed workflow. Never delete a lock merely because it is old: the lock deliberately has no guessed lease that could expire underneath a slow notarized release.

##### When a release does not happen

Check in this order, because the two causes look different.

**No run appeared at all.** The push matched nothing in the workflow's admission filter. This is the normal outcome for a docs, Worker, or landing-site merge. Every `packages/contracts/**` change is admitted, so a missing contracts run means the workflow itself did not start; it cannot be caused by the derived closure. For other desktop build inputs, compare the merge's file list against `paths:` in `.github/workflows/release-desktop-macos.yml`.

**The run stopped after planning.** Read the planner's reason. `N changed path(s) since <commit> are outside desktop release inputs` means the watermark diff was non-empty but classification found no module reachable from production desktop imports or release tooling; no version was bumped and no macOS runner was claimed. If that conclusion looks wrong, run `pnpm --filter @rally/desktop test:release`: the release invariant compares the planner's closure against an independent TypeScript-AST graph and names any disagreement. `desktop input classification failed open` has the opposite result: graph uncertainty deliberately proceeds toward a release rather than risking a silent miss.

**A run appeared and planned a skip.** Read its reason. `nothing but the release record has landed since the released commit <commit>` means `main` is already released — the state a completed release leaves behind, and what a re-run of a finished release produces.

To ship a desktop build for a change outside the path set, dispatch the workflow against the tag you want, or land any change inside the set — the watermark means that release carries everything unreleased, not just the change that triggered it.

- `.github/workflows/deploy-site.yml` is the sole landing-site publisher. It deploys on a merge to `main` matching its `paths:` filter — `apps/site`, the shared packages, the lockfile, the root TypeScript config and workspace file, and the workflow itself — and on manual dispatch.

#### How the desktop release is recorded

`apps/site/release.config.json` is the release pipeline's durable record of what has already shipped: its version and digests describe the published payloads, and its `commit` is the watermark for unreleased desktop work. The desktop release publisher rewrites that file on its own runner after the payloads are published and the channel is promoted. The release commits the rewritten file back to `main`, retrying if `main` moved, and refuses to move the record backwards when an older tag is replayed; that retry addresses the temporary sync worktree with `git -C`, and the shell must remain in `GITHUB_WORKSPACE`, because the next attempt removes and recreates the sync worktree after a rejected push.

That commit is load-bearing rather than tidy bookkeeping. `plan-release.mjs` treats its `commit` as the watermark for unreleased desktop work, and `publish-r2-release.mjs` reads the committed copy through `assertNextReleaseVersion`, so a stale record rejects the *next* release outright. It does not gate an otherwise independent landing-site deployment.

If publication succeeded but the tag push or config recording failed, do not rebuild that version: its immutable objects are already live and a fresh signed build will not reproduce their bytes. Recover the annotated tag at the exact release commit using a user token with workflow permission when it is missing. Recover the record from the live `latest-mac.yml`, the versioned `SHA256SUMS`, R2 object metadata, the publication receipt, and that tag's commit; commit that recovered record together with the retry fix. The next ordinary release then advances one minor from the recovered version and carries everything after its recorded commit.

The landing page links `https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg` directly and does not render the release version. The canonical object advances with the desktop channel, independently of a site build, so a site deployment neither reads nor validates `release.config.json`. This keeps copy, layout, and link-preview fixes deployable while a desktop release is between channel promotion and recording its durable release state.

Deployments cannot overlap. Each workflow declares a concurrency group, so a second run waits for the first to finish, and a burst of merges collapses to the newest commit: GitHub keeps only one run pending per group and drops the superseded ones. Runs already in progress are never cancelled, so a migration cannot be interrupted halfway. Each run deploys the commit that triggered it, not the tip of `main` at the time it starts.

The one interaction the platform does not sequence is an API deployment overlapping a macOS release, because they are separate workflows. The visible symptom is the desktop release failing its regional health gate while a Worker deployment is mid-flight; re-dispatch the tag once the API run is green. Avoid tagging a desktop release in the same minutes as an API-touching merge.

Because API deployment is continuous, a merge to `main` is a production release. Do not add required reviewers to `api-production`; that environment scopes the Cloudflare token to the deployment job and is not an approval gate. Migrations apply automatically, so a migration is live the moment its pull request merges: an irreversible or destructive migration must be split into backward-compatible steps, and a rollback is a forward migration, never a redeployment of the previous Worker. A failed deployment leaves the migrations applied; recover by fixing forward on `main`.

### The window between a migration and the Worker that needs it

The deploy job applies configured deployments' migrations before it deploys either Worker, so for the length of one deployment — around twenty seconds when it goes well — **the previous Worker is writing into the new schema**. That is the correct order, because new code must never meet an old table; the consequence is that a new column's `DEFAULT` is not a fallback during that window, it is the value.

Migrations `0090_drop_legacy_product_tables.sql`,
`0094_retire_agent_inference_payload_ledger.sql`,
`0097_email_routes_use_full_address.sql`, `0106_configurable_regions.sql`, and
`0113_drop_legacy_observability_tables.sql` are deliberate reverse-order
exceptions. These change schemas or deployment identifiers the previous Worker
still expects, so applying them first can break live requests until deployment finished — or
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
For 0106, deploy support for configured deployment identifiers before rebuilding
region-constrained tables. For 0113, stop querying legacy regional observability
tables before dropping them; the dedicated telemetry and audit stores already
serve all producers. The pre-retirement Global health check must pass before the
drop. Rolling back to the old reaper afterward stops telemetry delivery because
its first query names a removed table; roll forward with compatible code instead.
A manual deploy with migrations disabled postpones the drop and leaves inactive
legacy rows unreaped until a migration-enabled deploy completes the cleanup.
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

Google identity and connector OAuth use two distinct Google Cloud OAuth **Web application** clients in one project. The **Rally Login** client requests only platform identity scopes and has these two redirect URIs, one for the desktop and one for the browser client:

**Register the Rally callback URLs on both Google clients before deploying.**
`callbackUrl()` derives `redirect_uri` from `PUBLIC_API_BASE_URL`, so the moment
that var moves, every Google sign-in and every Google connector authorization
fails with `redirect_uri_mismatch` on its first request. Keep the Rally URLs
registered alongside: they cost nothing and they are what a rollback lands on.

- Global identity: `https://api.rallywith.ai/auth/google/callback`
- Global browser identity: `https://app.rallywith.ai/regional/global/browser/google/callback`

The browser one is derived from `BROWSER_APP_ORIGIN`, not `PUBLIC_API_BASE_URL`:
it sits on the browser host so the callback can set the browser's cookie. See
[browser-client.md](browser-client.md#google-sign-in).

The **Rally Google Connectors** client owns the Gmail, Calendar, Drive, Docs, and Sheets scopes and has these redirect URIs:

- Global connector: `https://api.rallywith.ai/connections/google/callback`

`https://rallywith.ai/auth/desktop/` is Rally's browser handoff for login and connector outcomes, and `rallywithai://auth/complete` is the allowlisted desktop return URI. Provider codes always terminate at a regional API callback first; neither handoff URI belongs in Google's authorized redirect URI list. Identity login requests only `openid`, `email`, and `profile`.

Store the Login client as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` on the Global Worker. Store the connector client as `GOOGLE_CONNECTOR_OAUTH_CLIENT_ID` / `GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET` on configured regional Workers. The connector runtime deliberately has no fallback to the login credentials.

Settings exposes two authorization presets over one `google` connector family:

- **Google Mail + Calendar** requests `gmail.read`, `gmail.draft`, `gmail.send`, `calendar.read`, and `calendar.write`.
- **Google Drive + Docs + Sheets** requests `drive.read`, `docs.read`, `docs.write`, `sheets.read`, and `sheets.write`.

The exact Google scope URLs are listed in `docs/provider-apps.md`. Google may require sensitive/restricted-scope verification and, for some requested scopes, a security assessment before external production use. A consent screen in Testing or a successful test-user callback is not production approval. Complete the consent-screen configuration, verified-domain and policy requirements, provider verification, and both acceptance flows in `docs/e2e.md` before release.

The production-approved connector scopes use `gmail.modify` for the Gmail capabilities, `calendar.readonly` plus `calendar.events` for Calendar, `drive.readonly` for Drive and native Docs/Sheets reads, and `drive.file` for Docs/Sheets creation and per-file writes. Existing Docs and Sheets discovered through Drive remain read-only to Rally until explicitly authorized. For an editable file that lacks the app grant, the desktop presents **Allow editing** and opens Google's one-file Picker in the system browser. A confirmed grant posts a normal user-authored authorization message and lets the model retry; it does not alter stored connector credentials.

Google connector ingestion currently polls Gmail history, Calendar sync/completion cursors, and Drive changes. Drive change-token polling is also the change source for Docs and Sheets. Do not configure or claim Gmail Pub/Sub watch delivery, Calendar notification channels, Drive push notifications, or any Google webhook; none is implemented.

## Realtime operations and cost controls

- Use deterministic region/workspace IDs for `WorkspaceDO`, which also hosts every Channel and Space parent, and region/workspace/work-stream plus the external substream ID for each independently provisioned `SubstreamAgent`. Never allocate an object per socket, user, turn, tool call, or retry.

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
  SubstreamAgent feed jitters its heartbeat across 45–55 seconds; the WorkspaceDO
  socket uses a fixed 50-second
  heartbeat. Every role waits 15 seconds for `pong` and reconnects with
  equal-jitter exponential backoff capped at 30 seconds. Auto-responses must not
  perform application work.

- Expect one native Chromium WorkspaceDO socket per signed-in Electron
  renderer/workspace, plus one main-process Node substream `0` feed for the
  active work stream, every pin, the five most recent unpinned rows, every
  visible live-state row, and recently viewed feeds still inside retention, and
  no Channel control socket (`/socket/workstreams/:id`). Navigation must not reopen the WorkspaceDO socket. An
  idle row outside those roles should retain neither child socket. Proactive
  feeds send `publishPresence: false`; verify “Viewing now” against WorkspaceDO
  foreground presence rather than socket counts. Brokered frames are limited to
  1 MB, and a failed managed-network attempt must follow Electron's remaining
  PAC directives in order rather than inventing a direct fallback.

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
  mention metadata, evicting `WorkspaceDO`, then subscribing again. Confirm each
  transition created a `parent_state_changes` row with a UUIDv7 and increasing
  common or viewer waterline. Every republish of a Channel row on the
  workspace socket must carry the same identity for each matching common or
  viewer row;
  the shared Electron cache must clear nullable fields, ignore duplicate/lower
  waterlines independently, reject an older directory page's pin position, and
  remove the row on authorization revocation. Reconnect the WorkspaceDO socket
  after missing a state push and confirm its resident directory reload repairs
  the gap without a timer.

- Batch model `stream_delta` broadcasts. The direct child loop may use its reference-counted 30-second keep-alive alarm only while active work exists; avoid per-connection alarms and periodic room health polling.

- Monitor reconnect rate, `resync_required` rate, rejected socket origins, active connections, and messages per room. A rise in reconnects or resyncs is an availability signal, not a reason to retain unbounded replay state.

- Dictation uses a separate, non-durable WebSocket bridge because each session has one desktop client and one Azure upstream; it does not need room coordination or persistence. Keep the 60-second Rally ticket, exact Origin check, 256,000-character client-frame bound, and audio-buffer event allowlist. The Worker must set the Azure `api-key` handshake header and must never forward client `session.update` events.

- The renderer starts its mono PCM16 24 kHz `AudioWorklet` before the transcription service connects, buffers in memory, and batches all captured audio within the shared `@rally/contracts/realtime-transcription` frame limits. Batches leave at 100 ms intervals, carrying up to about four seconds of unchanged audio each; Stop drains the final partial frame and queued audio before explicitly committing. The existing 10-second connection deadline now starts with capture and covers the ticket, handshake, and backlog drain; expiry cancels the request and releases capture. The existing 60-second finalization deadline covers the final audio drain and transcript completion together. See [dictation startup](conversation-surfaces.md#dictation-capture-and-connection-startup). Permission denial, device removal, provider errors, and component unmounts must stop every media track and close both sides of the session.

Cloudflare can terminate long-lived connections during network deployments, so recovery—not socket immortality—is the contract. Verify that a forced disconnect reconnects with a cursor, replays only newer events when available, and refreshes REST state when the room replies `resync_required` without dropping the active checkpoint that frame carries.

### Work-stream authority steady-state operations

Configured deployments completed the one-time maintenance cutover and are permanently at
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

For a missing or stale product fact, inspect the source child's `durable_outbox`
and the parent's outbox and receipts first: `parent_outbox` and
`parent_child_receipts` in `WorkspaceDO` for a Channel or Space (see
[`hosted-conversation-parents.md`](hosted-conversation-parents.md)), or
`sidekick_child_receipts` in `WorkspaceDO` for a Sidekick.
For a missing sidebar badge/resource route/suggestion feedback row, inspect
`WorkspaceDO.workspace_workstream_effect_receipts` and the corresponding
`channels` or `channel_viewers` row's authority generation, waterline, and
UUIDv7 `source_event_id`. For a missing digest event, Slack mention, or email
notification, inspect that same
`WorkspaceDO.workspace_workstream_effect_receipts` table — activity and mention
effects commit their receipt in the object transaction that commits the event
or intent — and `WorkspaceDO.workstream_notification_intents`. A receiver
receipt with no sender outbox row is the normal end state: the sender deleted
its row when the Queue accepted the message, and the receiver committed the
effect with its receipt. A sender outbox row that persists means the Queue is
refusing the send (`substream_outbox_batch_deferred`,
`parent_effect_enqueue_failed`, or `parent_effect_delivery_deferred` for a hosted
parent, whose `parent_outbox.last_error_code` holds the reason; a hosted row in
state `failed` did not parse and is never retried, see
`parent_outbox_row_unreadable`); no outbox row and no receipt means the Queue
holds the message or has dead-lettered it
(`conversation_effect_processing_failed` names the throw). There is no
acknowledgement RPC to retry. Never delete an object outbox row to clear an
alert; repair the Queue or the receiver and let the alarm resend it, or
redrive the dead-letter queue. A generation/waterline/hash conflict is a producer bug or
restore-generation error and requires quarantine, not last-writer-wins repair.
Effect receipts and terminal notification shells disappear after 30 days; a
redelivery older than that converges on the idempotent product identities
(directory waterline, activity dedupe key, intent ID) instead of a receipt.

Migration 0090 removes the legacy D1 product tables and their writer fences. A
post-cutover `no such table` or `no such column` from a product statement means
the runtime router was bypassed; quarantine and fix that path, and never recreate
the table or fall back to D1. Identity, membership, routing, migration/control,
audit, and telemetry remain valid D1 writers.

- Electron supplies the Mac timezone during ticket exchange. It seeds an account whose
  `timezone_source` is still `client` and never writes over one somebody chose in settings;
  a client that sends no zone leaves the account alone, because there is no server-side default.

- Desktop and browser clients report the device's zone while the account follows it; see
  `users` in [data-model.md](data-model.md#identity-and-tenancy).

- Owners and admins may change the workspace timezone. Every user may fix their personal
  timezone, which records `timezone_source = 'user'` and stops sign-in and device reports
  moving it; turning on Set timezone automatically sets `client` again.

- Calendar automation precedence is explicit trigger timezone, then the automation **author's**
  timezone for personal scope, then the workspace timezone — resolved at acceptance, inside the
  automation's own object, rather than when the draft was compiled, so the scope chosen on the
  create screen and the account adopting a shared template are the ones that answer it. A zone
  the runtime cannot format refuses acceptance with `sidekick_timezone_invalid` rather than
  falling back silently. The resolved zone is then frozen with the schedule: changing the
  author's account timezone afterwards does not move an accepted automation's calendar runs.

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
| Degraded connector workflows | `event = connector_poll_timeout` or `event = connector_poll_failed` |
| Rejected model calls | `event = agent_inference_attempt_failed` or `event = structured_inference`, and `provider_error_code` exists |
| Broken response contracts | `event = request_failed` and `error_name = ZodError` |
| Harness run outcomes | `event = harness_run_finished` |
| Slow root runs | `event = harness_run_finished` and `duration_ms > 60000` |
| Slow Terminal bootstrap | `event = terminal_daytona_operation_finished`, `operation = sandbox_bootstrap`, and `install_duration_ms > 10000` |

The **Rejected model calls** view keys on `provider_error_code`, so it shows
only the refusals a provider classified. A refusal that arrived as prose or as a
gateway's HTML carries `provider_error_detail` and no code, and is reachable by
filtering that field instead — worth a view of its own if those turn out to be
common, which nothing yet says they are.

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
model context. `provider_error_detail` is the one admitted piece of provider
free text: it is what a model service said about a request Rally sent, and
excluding it left rejections unreadable, so it is carried in a field named
`detail` rather than `message`, and read as evidence rather than instruction.
`redact` masks by key and cannot see inside it, and clips it at the 2,000
characters it clips every string to.

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
Engine dataset `avalon_agent_runs`. A root ordinary work-stream
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
| `blob1` | schema version (`harness_run_v1`) |
| `blob2` | source (`workstream`) |
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
is the starting point for deciding whether a run ceiling is warranted.

**`p95_cost_cents` is trustworthy only from 2026-09-19.** It reads the harness
run total, which summed a per-attempt cost that was `0` on every OpenRouter
call until the request began asking OpenRouter for usage accounting — so an
OpenRouter-heavy cohort reads near zero before that date and its real spend
after. Do not set a ceiling from a window that spans it. The same caveat and
its cause are in
[Inspecting a run's raw inference](#inspecting-a-runs-raw-inference).

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

Connector polls have a 20-second adapter cancellation deadline inside a 25-second Workflow step. The step uses three exponentially backed-off retries. A terminal timeout or provider failure moves the connection into a deterministic degraded/error state and emits only structured, redacted metadata; it must never leave the workflow waiting indefinitely.

That deadline must be a **cancellable** one — `createDeadline`/`withDeadline` from `apps/api/src/lib/deadline.ts`, disposed in a `finally`. `AbortSignal.timeout()` cannot be cancelled, so a poll that finished in a second still held its Workflow invocation open for the remaining nineteen. The runtime eventually cancelled each one as a hang and counted it as an uncaught exception, which is what put a steady ~560 errors a day on `avalon-api-global` while every workflow instance reported `complete`. The same rule applies to any deadline created inside a Workflow step, queue consumer, or Durable Object alarm: those invocations end when the handler returns, so an armed timer outlives the work it guarded. Inside a request handler the timer dies with the response and either form is safe.

The deadlines long enough to matter have been converted: the connector poll (20s) and the two inside the bind loop's Workflow step — per-tool-call (`TOOL_DEFAULT_TIMEOUT_MS`, 30s) and plugin reauthorization (30s). Not yet converted are the fixed 5–10 second `slackApi` calls in `slack-agent-service.ts`, which hold a queue invocation open for at most ten seconds each; they are the same class and are tracked as follow-up work rather than fixed here. Any new deadline in one of these contexts uses the cancellable form.

Background agents run independent work-stream Bind loops and inherit the source
conversation's model override and execution principal. They use normal tool
capabilities and execution protections. The retired inline-child
`HARNESS_CHILD_MAX_*` settings do not control this surface. See
[agent communication](agent-communication.md) for ownership, continuation,
message delivery, and archive behavior.

### Inspecting a run's raw inference

Structured logs are redacted by design, so they say what a run did and never what
the model was actually asked. When the question is *why did the agent do that* —
a fabricated value, a tool the model never called, a question it should not have
needed to ask — the answer is the recorded request body, and this section turns a
work-stream URL into it. Nothing here mutates production; every step is a read.

#### Before querying

1. Copy the work-stream and workspace UUIDs from the canonical
   `https://rallywith.ai/app/workspaces/<region>/<workspace-uuid>/workstreams/<workstream-uuid>`
   URL. The current main
   substream ID is `0`. When Rally exposes additional product substreams, copy
   the canonical substream ID from the API response or route that opened that
   substream; do not infer it from an inline child run. These opaque IDs are safe
   to place in the query examples below; do not paste a title, prompt fragment,
   email, or other user content into SQL.

3. For Global, use these resources:

   | Data region | Typed analytical surface | Exact-record `PAYLOADS` bucket |
   | --- | --- | --- |
   | Global | R2 SQL over Data Catalog bucket `avalon-global-inference-lakehouse` | `avalon-global-payloads` |

An MCP client connected to the engineering MCP can skip the token and curl
steps below: its `query_data_lake` tool runs the same statements
([`engineering-mcp.md`](engineering-mcp.md#lakehouses)). The handling rules for
what comes back still apply.

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
guessing. The table and bucket names in this runbook remain repository-owned:
`config/inference-lakehouse.json` declares the Data Catalog namespace and
table, and `pnpm docs:check` fails when a query here names anything else. It
does, because all three queries here once named the product instead of the
namespace, and the table they asked for did not exist.
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
FROM avalon.llm_inference
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

`cost_microusd` is the provider's own figure and is trustworthy only from
2026-09-19. Before that date it reads `0` on every OpenRouter row, because the
request did not ask OpenRouter for usage accounting, and is absent on every
structured row; Azure rows were always priced correctly. Read an older row's
spend from `input_tokens`/`output_tokens` and the model, not from this column.

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
FROM avalon.llm_inference
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
  FROM avalon.llm_inference
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

#### Reading a rejected call

When the attempt row says `success = false`, `error.providerError` is what the
provider said: `code` and `providerName` classify the refusal, and `detail` is
the body it sent. The code alone is regularly not an answer —
`invalid_function_parameters` says a tool schema was refused without saying
which one — so read `detail` first. On a gateway row the envelope's own
`message` is usually `Provider returned error` with the upstream's real sentence
inside `metadata.raw`; `detail` holds the whole body, so both are there.

`detail` is provider-controlled text that often quotes Rally's own request back,
and the logger's redaction is by key, so it does not reach inside the string.
Treat it as evidence rather than instruction, and keep retrieved user content out
of tickets, commits, and agent responses as everywhere else in this runbook.

#### When a row is missing

- `inference_lakehouse_stage_failed` means archive or Queue acceptance failed.
- `inference_lakehouse_delivery_failed` means a delivery is retrying.
- A non-empty `avalon-global-inference-lakehouse-dead-letter` queue is the
  definitive terminal delivery alarm.
- `inference_lakehouse_delivered` confirms Pipeline acceptance, not that product
  state committed and not that the row is already visible to R2 SQL.

Keep this distinction during incident reconstruction: the owning
`SubstreamAgent` `inference_attempts` ledger is operational
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

The engineering MCP's `query_data_lake` tool runs these queries too, with
`lakehouse: "analytics_events"`.

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
pnpm --filter @rally/api exec wrangler d1 execute avalon-global-telemetry --remote \
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

The other role is `security`. Use independent tokens in configured deployments, add a new
token before removing its predecessor during rotation, and never put a token in a
URL, log, ticket, or shell history.

- `GET /status` returns the fixed regional operational snapshot to either role.

- `POST /replay` accepts `{ "eventId", "reason" }` only from a `security`
  principal. Replay is Global-only; `reason` is `destination_recovery` or
  `incident_response`.

- `GET /crashes/<crash-id>/raw?reason=customer_support` is for `support`;
  `reason=incident_response` is for `security`. It streams one regional dump and
  records the principal, reason, and fixed result code in
  `telemetry_crash_access_audit`.

Start with `/status` in configured deployments. Use replay only for a known terminal Global
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

### Retention or deletion failure

[`telemetry.md`](telemetry.md) owns the mechanisms and limits behind these
procedures.

### OpenRouter unavailable

The harness tries configured fallback models within its per-request and stream
watchdogs plus the caller's run policy. Root ordinary work-stream runs allow
1,000 routed model attempts; durable child dispatch and attempt
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
`0` and redeploy to stop it everywhere: work streams, automation runs, inline
children, and the final meeting-notes pass all read it**, worth doing when a provider is failing broadly,
because each re-execution charges another failure to the per-workspace circuit
breaker whose threshold is 3.

Four failure codes an operator will see, all distinct from
`harness_execution_failed`, which means Rally's own defect:

| Code | Meaning | Triage |
| --- | --- | --- |
| `provider_unavailable` | Rally called and got nothing — no response, a 408, a 429, a 5xx, or an HTTP-200 stream declaring `unavailable`, `service_unavailable`, or a numeric 408/429/5xx — and its retries are spent. | The provider. Runs are safe to retry once it recovers. |
| `provider_circuit_open` | Rally did not call: the breaker had already opened, so the run was refused before a request went out. | Read the *earlier* failures that opened it. The breaker also opens on 401/402/403, which are Rally's credential or credit, so this code does not by itself accuse the provider. |
| `context_length_exceeded` | Rally called and the endpoint refused the prompt as longer than it accepts, declaring `context_length_exceeded` in its 400 — after every other candidate for the model refused it too. | Rally's sizing, not the provider's health. Compare the deployment's own input limit against the `context_length` the catalog reports for that model: a deployment that accepts less is a window compaction is sizing against wrongly, and every long run on that model will reach it. Not to be read as `context_limit_exceeded`, which is Rally declining to send a run it could not make fit and says nothing about a deployment. |
| `model_input_unsupported` | Rally called and OpenRouter found no endpoint for the model that accepts something the request carries: its 404 names an input step in `error.metadata.failed_routing_step` (`Filter by Image Support`, `File` or `Audio`). | The model, not the provider's health: that model cannot read that input on any endpoint. The member's remedy is the attachment or a different model; an operator's is the model a flag or override routes that work to. The attempt's `provider_error_detail` names the step. |

A run failing with either *provider* code while the provider is healthy points
at credentials or at the breaker's cooldown (60–120 seconds), not at a model
outage. A run failing with `context_length_exceeded` while the provider is
healthy points at neither: the call was answered, and the answer was that the
prompt did not fit. The reasoning behind the splits and the retry is
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

#### GitHub delivery dead letters

A `github_webhook_delivery_v1` message is not an opaque ID: it carries the
verified GitHub body inline (`body.kind: "inline"`) or a `payloadRef` into
Global `PAYLOADS` (`body.kind: "staged"`). Treat it as GitHub content — do not
copy it into a ticket or log. GitHub answered `202` long before it failed and
will not redeliver it, so the dead-letter queue holds the only copy.

- **Fix the cause first.** `github_delivery_retry` names it in `error_code` —
  a regional error code, `github_verified_delivery_invalid:<field>` for a
  bridge shape mismatch, or a GitHub rate limit already waited out.
- **Redrive the message unchanged.** A redrive is safe: a region answers a
  processed receipt as a duplicate and re-runs a pending one's effects keyed to
  the delivery, and an older lifecycle event than the one a connection already
  holds is skipped (`provider_webhook_lifecycle_superseded`). A staged message
  whose object is gone is acknowledged as `already_processed`.
- **Staged bodies can outlive their message.** A dead-lettered staged message
  keeps its object under `global/github-ingress/<delivery id>/`, and a failed
  cleanup logs `github_delivery_staged_body_cleanup_failed`. Delete the object
  once its message is redriven or abandoned; nothing expires that prefix yet.
- **A message that fails its own parse cannot be redriven.**
  `github_delivery_message_invalid` names the field. The ones logged between the
  Queue's first deploy and the `v8` fix on 2026-09-28 lost their body in
  transit: their `body.bytes` is `{}`. The only copy left is GitHub's. Read their
  `deliveryId`s from `avalon-global-activities-dead-letter` (those messages are
  `json`, so the dashboard shows them), or from the log's `delivery_id`.
  Redeliver each from the GitHub App's advanced settings, which keep deliveries
  for three days, then delete the message from the dead-letter queue.
- **`unrouted` is not an incident.** It is logged at `info` whenever no
  deployment has connected the installation — every new installation's
  `installation.created` beats the setup redirect. Look only if an installation
  that completed setup keeps logging it.

### Google token revoked

Mark the connection `needs_reconnect` and preserve affected automation state. The mark is a diagnosis, not a gate — dependent tool execution continues and fails on the provider's answer, per [Stored status is a belief, not a gate](connectors.md#stored-status-is-a-belief-not-a-gate). It also does not clear itself: only reauthorization or an explicit connection test returns the row to `healthy`. Reauthorization must request only its previously selected capabilities; do not silently broaden scopes.

### Region mismatch

Do not copy records between deployments. Confirm the desktop-selected region, session claim, workspace region, and target API agree. V1 has no workspace-region migration path.

### Credential-key rotation

Retain the previous regional key during rotation. Decrypt with the stored key version, re-encrypt with the new active version and connection-bound authenticated data, verify provider access, then retire the old key after all rows have migrated.

## Recovery and data handling

- Before the authority phase opens, D1 is canonical for work streams, messages,
  runs, schedules, connector metadata, and audit events. After it opens, each
  `SubstreamAgent` is canonical for its substream product tables,
  `WorkspaceDO` is canonical for each Channel and Space parent's aggregate
  metadata/outbox and for cross-work-stream directory/viewer/pin/resource/feedback
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

Retiring artifacts is staged across two releases, for the reason [the migration window](#the-window-between-a-migration-and-the-worker-that-needs-it) gives: the Worker that is live while a migration applies still reads `artifacts` on every `GET /workstreams/:id/context`, so the table cannot go in the same release as the code that stopped reading it. `0069_retire_artifact_messages.sql` therefore only retires the `'artifact'` message type. **A later release still owes a `DROP TABLE artifacts` migration**, and it is safe to write once no deployed Worker reads the table — after the release carrying that code removal is live in configured deployments.

The R2 objects are the third step and are not reachable from a migration at all. The retired `create_artifact` tool wrote them under `<region>/<workspace>/artifacts/<artifact-id>.txt` in configured deployments, and `artifacts.content_ref` holds their only pointers — so sweep them **before** the drop lands, or enumerate them from the table first, or they become unreferenced with nothing left to enumerate. Delete by prefix once per region — `wrangler r2 object delete` per key, or a bucket lifecycle rule on the prefix — and confirm the prefix lists empty afterwards. Do it deliberately rather than as part of a deploy: the objects are the last copy of anything an agent wrote there, so anything worth keeping has to be pulled out first.
