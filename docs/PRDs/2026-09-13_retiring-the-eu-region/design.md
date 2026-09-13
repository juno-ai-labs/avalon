# Retiring the EU region — inventory and removal order

> Companion to [`prd.md`](prd.md). What exists today, what happens to each
> piece, and what can only be removed from the Cloudflare dashboard.

This is a survey, not a promise that every file listed changes in exactly the
way described. It exists so that the work is scoped from a read of the tree
rather than from memory, and so a reviewer can check the claim that nothing was
missed. Counts were taken on 2026-09-13 at `544954a`.

## Scale

| Area | Files touching region wiring |
| --- | --- |
| `apps/api/src` | 62 |
| `apps/api/test` | 66 |
| `apps/api/test-workers` | 8 |
| `apps/desktop/src` | 48 |
| `packages/` | 48 |
| `scripts/` | 35 |
| `apps/ace` | 14 |
| `apps/migration-tracker` | 9 |
| `config/` | 6 |
| `.github/` | 5 |
| `apps/engineering-mcp` | 4 |
| `apps/site/src` | 2 |
| `docs/` (plus `AGENTS.md`, `README.md`) | 63 |

Plus `package.json`, `.env.example`, and `.gitleaks.toml` at the root.

## Production state, verified

Read from the Cloudflare account on 2026-09-13:

| Resource | State |
| --- | --- |
| `avalon-eu` D1 (`099eb3bf-…`, jurisdiction `eu`) | **0 workspaces, 0 members, 0 work streams.** 892 KB — a bare migrated schema |
| `avalon-global` D1 (`3802fdab-…`) | 16 workspaces, 40 members, 5,063 work streams. 454 MB |
| Live EU Workers | `avalon-api-eu`, `avalon-api-documents-eu`, `avalon-api-terminal-eu`, `avalon-artifacts-eu` |

**There is no EU data to migrate, leave in place, or abandon.** The emptiness
check is re-run as a release gate rather than trusted from this date — see
**Rollout** in the PRD.

## Delete outright

Nothing here has a single-region form; the whole file is the second region.

**Wrangler configs**

- `apps/api/wrangler.eu.jsonc`
- `apps/api/wrangler.documents.eu.jsonc`
- `apps/api/wrangler.terminal.eu.jsonc`
- `apps/api/wrangler.artifacts.eu.jsonc`

**Cross-region RPC bridges** (`apps/api/src/`)

- `regional-identity-bridge.ts`
- `github-regional-bridge.ts`, `github-routing-bridge.ts`
- `notion-regional-bridge.ts`, `notion-routing-bridge.ts`
- `slack-regional-bridge.ts`, `slack-routing-bridge.ts`
- `linear-regional-bridge.ts`, `linear-routing-bridge.ts`
- `workstream-email-routing-bridge.ts`
- `inbound-email-regional-bridge.ts`
- `telemetry-regional-bridge.ts`, `telemetry-control-bridge.ts`
- `telemetry/regional-bridge.ts`, `telemetry/control.ts`

Their entrypoint exports leave `apps/api/src/index.ts` and
`worker-exports.d.ts`, and their argument schemas leave
`apps/api/src/lib/rpc-contracts.ts`.

**Scripts**

- `scripts/dev-regional-api.mjs` and `dev-regional-api.test.mjs` — the two-region
  launcher. `pnpm dev:api` and `pnpm dev:api:local` become the `@rally/api`
  `dev` / `dev:local` scripts directly.
- `scripts/substream-agent-jurisdiction-probe/` — a probe for a jurisdiction
  question that only exists across two.
- `scripts/check-regional-health.mjs` survives but collapses to one URL; its
  `parseRegions` and `baseUrlForRegion` go.

**Documentation**

- `docs/regionalization.md` — deleted, its surviving content redistributed per
  key design decision 6, and its row removed from `docs/README.md`.

## Collapse, do not delete

**`apps/api/src/lib/durable-object-namespace.ts`** — the one product-object
resolver, and the highest-risk file in the change.

| Today | After |
| --- | --- |
| `JURISDICTION_BY_REGION = { global: "us", eu: "eu" }` | the constant `"us"`, commented with why it can never be removed |
| `FALLBACK_LOCATION_HINT_BY_REGION` | the constant `"wnam"` |
| `AFFINITIES_BY_REGION`, `WORKSPACE_PLACEMENT_AFFINITIES` | `["wnam", "enam"]` |
| `WEST_EAST_LONGITUDE_SPLIT = { global: -100, eu: 15 }` | the constant `-100` |
| `region` parameters on every resolver | removed; `env.AVALON_REGION` goes with them |
| `assertDurableObjectJurisdiction(id, region, env)` | `assertDurableObjectJurisdiction(id, env)`, still fail-closed on `us` |

**`scripts/eslint-rules/durable-object-region-routing.mjs`** stays. It is named
for the region but enforces the single-resolver rule, which matters just as much
with one region; only its EU cases leave the rule's tests.

**Provider routing services** (`apps/api/src/services/`) —
`github-routing-service.ts`, `linear-routing-service.ts`,
`notion-routing-service.ts`, `slack-routing-service.ts`,
`workstream-email-routing-service.ts`. Each keeps its signature verification and
its directory lookup; each loses the region column, the forwarding branch, and
the "connected in another region" refusal. The `<region>.` prefix on Notion
OAuth state goes.

**`apps/api/src/env.ts`** — `assertEnvContract` stops being region-scoped. The
rules that currently read "required in Global, forbidden in EU" (Google identity
OAuth, PostHog, the inference lakehouse bindings) become plain requirements.

**`apps/ace`** — `regional-api.ts`, `directory.ts`, `env.ts`, `protocol.ts`,
`private-access.ts`, `demos.ts`, `index.ts`, and the two client screens. One
`RALLY_API_BASE_URL`, one `RALLY_OPERATOR_TOKEN`, one `DB`; `EU_DB`,
`RALLY_EU_API_BASE_URL`, `RALLY_EU_OPERATOR_TOKEN`, `unavailableRegions`, and
the `'global' | 'eu'` unions go.

**`apps/engineering-mcp`** — the `EU_INSPECTION` binding and every
`Promise.all([global, eu])` fan-out in `server.ts` collapse to one inspection
entrypoint. The cross-region identity routing that made this MCP notable is
simply gone.

**`apps/migration-tracker`** — `schema.ts` carries `region` in the
`(component, region)` primary key of the deployed-version table and in the
object registry, because the two Workers deploy independently. With one Worker
the column and the key narrow.

**`packages/contracts`** — `RegionSchema` and `type Region` leave `index.ts`;
`WorkspaceTargetRegion` leaves `workspace-target.ts`; `workstream-links.ts`
stops emitting the region segment and keeps parsing it (key design decision 2);
`telemetry.ts` loses `onboarding_region_selected` and `selectedRegion`.

**`apps/desktop`** — 48 files. The user-visible ones are
`screens/onboarding.tsx` (the picker and its copy), `screens/workspace-settings.tsx`
(the *Workspace region* row), `components/sidebar.tsx` (the *EU workspace* /
*US workspace* label), and `styles/app.css` (`.region-option`, `.region-icon`,
`.region-check`, `.region-note`, `.region-question`). The rest is plumbing:
`main/stored-auth.ts` and `stored-session.ts` (the `(region, workspaceId)`
credential key — read-tolerant, per key design decision 3), `lib/types.ts`,
`lib/api.ts`, `lib/local-cache.ts`, `lib/draft-keys.ts`,
`lib/device-preferences.ts`, `main/native-crash-uploader.ts`,
`main/telemetry-reporter.ts`, `main/telemetry-intent.ts`,
`main/credential-refresh.ts`, `main/realtime-socket-broker.ts`.

**`apps/site`** — `src/telemetry.ts` (the `global | eu` route and the
page-scoped EU identity) and `src/invite.ts` (the region guard). The `trust/`
pages are copy, not code, and wait on open question 1.

## Configuration, CI, and scripts

| File | Change |
| --- | --- |
| `package.json` | Delete `deploy:eu`, `db:migrate:remote:eu`, `db:migrate:remote:list:eu`; `db:seed` seeds once; `dev:api` / `dev:api:local` call `@rally/api` directly; `dev:desktop:prod` drops `VITE_API_EU_URL` |
| `apps/api/package.json` | Delete `dev:eu`, `dev:local:eu`, `build:eu`, `build:documents:eu`, `build:terminal:eu`, `build:artifacts:eu`, `build:deployed:eu`, `db:migrate:remote:eu`, `db:migrate:remote:list:eu`, `db:seed:eu`; `db:platform:migrate` applies to one state directory |
| `.env.example` | Delete `VITE_API_EU_URL`, `PUBLIC_API_BASE_URL_EU`, `GITHUB_APP_PRIVATE_KEY_EU`, the three `NOTION_*_EU`, `SESSION_SIGNING_KEY_EU`, `OAUTH_STATE_ENCRYPTION_KEY_EU`, `CONNECTOR_CREDENTIALS_KEY_EU`, `CONNECTOR_CREDENTIALS_KEYS_JSON_EU`, `TELEMETRY_OPERATORS_JSON_EU`, `RALLY_EU_TELEMETRY_R2_BUCKET`, and the `_GLOBAL`/`_EU` override convention |
| `.github/workflows/deploy-api.yml` | Delete the `regions` dispatch input, `DEPLOY_EU`, every `*:eu` build and profile step, the EU-before-Global ordering, and the EU health barrier |
| `.github/workflows/ci.yml`, `deploy-ace.yml`, `rebuild-terminal-snapshot.yml`, `release-desktop-macos.yml` | Drop EU build matrix entries, EU health gating, and the EU telemetry artifact bucket |
| `scripts/migrate-d1.mjs` | `--region` goes; one database |
| `scripts/seed-local-region.mjs` | Loses its region argument |
| `scripts/sync-dev-env.mjs` | Stops generating per-region keys and stops writing `EU_PUBLIC_API_BASE_URL` |
| `scripts/ensure-cloudflare-queues.mjs`, `check-cloudflare-r2-buckets.mjs`, `ensure-cloudflare-inference-lakehouse.mjs`, `configure-cloudflare-observability.mjs`, `select-api-deploy-mode.mjs`, `d1-baseline.mjs`, `open-local-authority*.mjs`, `smoke-local.mjs`, `report-terminal-analytics.mjs`, `force-substream-agent-migrations.mjs` | One region each |
| `scripts/session-start.sh` | Message says one API |
| `config/inference-lakehouse.json`, `config/analytics-events-lakehouse.json` | Drop the Global-only caveat; there is no other region for them to be *only* in |
| `config/provider-apps/*.json` | Drop the per-region callback pairs; keep the shared ingress hostnames |

## Tests

Region cases are deleted, not parameterized down to one. The suites with the
most to remove are `apps/api/test/platform-onboarding.test.ts` (cross-region
discovery, activation, and route reconciliation), `runtime-components.test.ts`
(US/EU namespace restriction), `env-contract.test.ts` (what Global requires and
EU must not), `workstream-email-routing.test.ts` (the Global registry serving a
non-Global caller), the four `*-routing.test.ts` provider suites, the telemetry
suites, and `apps/desktop/src/renderer/lib/app-session.test.tsx` and
`main/stored-auth.test.ts` on the client.

What must survive, on real workerd in `apps/api/test-workers/`, is the Global
behavior those suites also covered: Durable Object admission and jurisdiction
assertion, forced migration, search indexing and authorization, and substream
creation. `test-workers/durable-object-runtime.test.ts` currently proves
admission is refused after *regional* abandonment; the abandonment case stays
and the regional framing goes.

Two new tests earn their place, and each is proved to fail before it is kept:

1. **A stored profile written by the previous build still loads**, with its
   `region` field discarded rather than rejected. Break it by making the schema
   strict; the test fails with the user signed out.
2. **A link carrying a region segment still resolves to its work stream.** Break
   it by removing the legacy parse branch; the test fails with a null target.

No dual-region fixture survives. `apps/api/test/helpers/` loses its EU
environment shapes.

## Documentation

Updated in the same change as the code:

- **`AGENTS.md`** — the "both regional Workers" line and the two EU caveats
  under **Environment** (inference not archived; EU on the restricted telemetry
  API without a Global fallback).
- **`docs/dev-environment.md`** — one Worker, one port, one seed, one migrate;
  the `pnpm health:regions` and `curl :8788` rows go, and so does the
  two-region container-flag workaround.
- **`docs/runbook.md`** — one deploy path, one resource set, one secret set,
  plus **the new teardown checklist below**.
- **`docs/sandbox.md`**, **`docs/e2e.md`**, **`docs/testing.md`** — one API.
- **Module documents** that own a mechanism with an EU case:
  `architecture.md`, `data-model.md`, `api-worker-deployment.md`,
  `telemetry.md`, `public-site-telemetry.md`, `inference-lakehouse.md`,
  `analytics-lakehouse.md`, `agent-harness.md`, `notion-ingress.md`,
  `provider-apps.md`, `linear-integration.md`, `slack-integration.md`,
  `connectors.md`, `workstream-email-addresses.md`, `text-search.md`,
  `terminal-workspaces.md`, `multiple-workspaces.md`, `ace.md`,
  `engineering-mcp.md`, `durable-object-migration-tracking.md`,
  `workstream-durable-object.md`, `security.md`, `authorization.md`,
  `access-revocation.md`, `choosing-queues-or-rpc.md`, `feature-flags.md`,
  `new-user-onboarding.md`, `demo-workspaces.md`, `workspace-retirement.md`,
  `private-access.md`, `domain-migration.md`, `ops-alerting.md`,
  `cloudflare-logging-and-tracing.md`, `performance-tracing.md`,
  `production-error-investigation.md`, `d1-baseline-migrations.md`,
  `when-adding-a-new-http-header.md`, `adding-new-instrumented-event.md`.

**Not updated:** the dated point-in-time records —
`harness-production-qa-2026-08-22.md`,
`terminal-production-qa-2026-08-21.md`,
`private-access-security-audit-2026-09-09.md`,
`durable-object-self-rpc-audit-2026-08-22.md` — and completed PRDs. They record
what was true when they were written, the same way a frozen PRD does, and
editing them to match the present destroys the only thing they are for.

**Changelog entries** go in the documents that own a *mechanism this change
moves* — one per pull request per document, per
[`module-documents.md`](../../module-documents.md#what-earns-an-entry). A
document whose only change is deleting the phrase "and EU" gets no entry: that
is a documentation catch-up, not a decision.

## Cloudflare teardown (dashboard only)

Wrangler removes neither a Worker nor a stateful resource by omitting it from
config, so deleting these files leaves every one of them running and billable.
This list becomes a section in [`runbook.md`](../../runbook.md), to be worked
**after** the phase-2 deploy is live and healthy.

1. **Re-run the emptiness check first.**
   `SELECT COUNT(*) FROM workspaces` against `avalon-eu` must return 0. If it
   does not, stop.
2. **Workers** — delete `avalon-api-eu`, `avalon-api-documents-eu`,
   `avalon-api-terminal-eu`, `avalon-artifacts-eu`. Deleting the API Worker
   releases its Durable Object namespaces and their storage; that is
   irreversible, and it is why step 1 comes first.
3. **Custom domains** — remove the `eu.api.rallywith.ai` and
   `eu.api.with-avalon.com` routes. Whether the DNS records and the ACM pack
   that covers a two-label hostname are also removed is open question 2.
4. **D1** — delete the `avalon-eu` database (jurisdiction `eu`).
5. **R2** — delete `avalon-eu-payloads` and `avalon-eu-telemetry`. Both are
   EU-jurisdiction buckets and do not appear in a default bucket listing; list
   with the EU jurisdiction to confirm they are empty first.
6. **Vectorize** — delete `avalon-eu-memory` after confirming a zero vector
   count (open question 3).
7. **Queues** — delete `avalon-eu-activities`, `avalon-eu-access-revocations`,
   `avalon-eu-product-feature-flags`, `avalon-eu-migration-commands`, and each
   one's dead-letter queue.
8. **Containers** — delete the `avalon-eu-crash-symbolicator` image and its
   EU-constrained instances.
9. **Secrets** — every EU value listed under **Security and trust model** in the
   PRD is revoked at its source, not merely unbound: the EU Notion OAuth client
   is deleted from Notion, the EU-suffixed keys are rotated out, and the EU
   telemetry operator tokens are invalidated.
10. **Analytics Engine and Logpush** — the `avalon_agent_runs` and
    `avalon_terminal_operations` datasets are shared and stay. Remove the
    EU-specific Logpush job and its destination path.

Nothing in steps 2–10 can be done from this repository, and nothing in this
repository will notice if it is skipped. The checklist is the only thing
standing between the merge and four Workers that keep running with live
credentials on them.
