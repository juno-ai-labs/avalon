# Retiring the EU region

> Created 2026-09-13.
>
> Rally becomes a single-region product. The second Worker deployment, its
> databases, buckets, queues, indexes, key sets, cross-region bridges, and the
> workspace region choice itself are removed rather than disabled.
> Companion: [`design.md`](design.md) — the file-by-file inventory, the removal
> order, and the resources that can only be torn down in the Cloudflare
> dashboard.
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Subsystem references: [`regionalization.md`](../../regionalization.md),
> [`api-worker-deployment.md`](../../api-worker-deployment.md),
> [`data-model.md`](../../data-model.md), [`telemetry.md`](../../telemetry.md),
> [`runbook.md`](../../runbook.md).

## Summary

Creating a Rally workspace stops asking where to keep your data. The **Global**
and **European Union** choice disappears from workspace setup, from the
invitation card, from workspace settings, and from the workspace switcher,
because there is one place data goes and no decision left to make.

Underneath, Rally stops being two products. Today the same Worker source is
deployed twice — `avalon-api-global` and `avalon-api-eu` — with independent D1,
R2, Vectorize, queues, workflows, containers, secrets, and Durable Object
jurisdictions, joined by thirteen named RPC bridges and four provider routing
directories. After this change there is one deployment. The `Region` type, the
`eu` enum value, the bridges, the routing directories, the `_EU` environment
variables, the second Wrangler graph, the second set of `pnpm` scripts, and the
EU branches of the region-splitting D1 schema are deleted — not defaulted, not
flagged off, not left as a stub. `pnpm dev:api:local` starts one API. Deploying
means deploying Global.

Nobody signs in again, no work stream moves, and no link stops working.

## Motivation

**The EU region has no users and never has.** The EU control-plane database
(`avalon-eu`, `jurisdiction: eu`) holds **0 workspaces, 0 members, and 0 work
streams**, at 892 KB — the size of a bare migrated schema with nothing in it.
The Global database holds **16 workspaces, 40 members, and 5,063 work streams**
at 454 MB. Every byte of Rally's product data is already in one region. The
second region is a code path with no customers on it.

**It is the slow path, and it cannot be fixed cheaply.** The 2026-09-11 standup
put an EU request at roughly **2s P50 against ~200ms on Global**. The
repository explains why, and none of it is incidental:

- **EU has no KV binding**, so the search-admission decision that Global reads
  from KV costs EU a warm Durable Object round trip on every query
  ([`text-search.md`](../../text-search.md)).
- **EU reaches Global over RPC for the things it cannot own**: identity
  bootstrap and membership discovery, every work-stream email-name reservation,
  and every telemetry capability and preference command. Each is a hop Global
  does not pay.
- **Five provider ingresses terminate in Global first** — GitHub, Notion,
  Slack, Linear, and inbound email — because those providers publish one
  callback URL. An EU delivery is verified in Global, then forwarded.
- **The compute an EU workspace actually uses is not in the EU.** Terminal runs
  on the Daytona `us` fleet for both regions, and inference egresses to
  OpenRouter from the region's own Worker to US-attributed providers. Only
  Turbopuffer is genuinely regional (`gcp-europe-west1`).

Closing that gap means an EU-domiciled stack — an EU KV equivalent, an EU
identity plane, per-region provider registrations, an EU Daytona fleet, EU
inference — which is a company-sized programme, not a sprint.

**The EU stack is incomplete in ways that are already documented as
deliberate.** EU inference is never archived, so a production model run in an EU
workspace cannot be inspected at all. The `avalon.analytics_events` lakehouse is
Global-only, so EU product analytics have no analytical destination. EU sits on
a restricted regional telemetry API with no PostHog project. And
[`regionalization.md`](../../regionalization.md) already states plainly that the
isolation "is not marketed as a guarantee that every byte is processed
exclusively in the EU". We are carrying the full cost of a second region while
being unable to make the claim that would justify it.

**The cost is paid on every change, by everyone.** Around **363 files** carry
region wiring. Every new table gets a `region` column and a CHECK constraint.
Every new Durable Object gets a jurisdiction. Every provider integration needs a
routing directory and a bridge. Every environment variable may need an `_EU`
twin. Every deploy is two deploys in a fixed order with a health barrier between
them. Every local session starts two Workers, seeds two databases, and migrates
two schemas. On a team this size that is the largest recurring tax in the
repository, and it is being paid to serve zero workspaces on the slow path.

## Goals

1. **Rally runs as one deployment.** There is no second Worker, database,
   bucket, queue, workflow, Vectorize index, container, key set, or route.
2. **Nobody is asked where their data lives.** Workspace setup has no region
   step, and no surface — invitation, settings, switcher, link — states a
   region.
3. **No code path can produce, accept, or store `eu`.** The `Region` type,
   `RegionSchema`, the thirteen RPC bridges, the four provider routing
   directories, the `_EU` variables, and the region columns in D1 are gone. A
   future `eu` is a compile error, not a runtime branch.
4. **One command starts the API and one command deploys it.**
   `pnpm dev:api:local` brings up a single Worker; `pnpm deploy:global` is the
   whole deployment.
5. **Nothing existing breaks.** Every Global workspace keeps its Durable
   Objects, sessions, stored credentials, connector installations, work-stream
   email addresses, and previously shared links. No one is signed out and no
   link 404s.
6. **The documentation describes one region.** No document retains an EU special
   case, and no document is left describing a boundary that no longer exists.

## Non-goals

1. **Data residency, GDPR-specific handling, or an EU roadmap.** *Rejected
   outright.* The product offers one region. This PRD does not add a residency
   control, a jurisdiction setting, or a note that EU returns later.
2. **An abstraction that makes a second region cheap to add back.** *Rejected
   outright.* A region parameter kept "just in case" is the code path this PRD
   exists to delete, with the users removed and the maintenance retained.
3. **Removing `jurisdiction("us")` from Global Durable Objects.** *Rejected
   outright, permanently.* Jurisdiction participates in ID derivation:
   `idFromName` on an unrestricted namespace resolves to a **different object**
   than on `jurisdiction("us")`. Dropping it orphans every WorkstreamDO,
   WorkspaceDO, SubstreamAgent, SidekickDO, and ArtifactHostDO in production —
   5,063 work streams of SQLite that would still exist and never be addressed
   again. The jurisdiction stays, and
   `assertDurableObjectJurisdiction` keeps failing closed on it. See key design
   decision 1.
4. **Collapsing the five shared provider ingress hostnames into the API.**
   *Deferred.* `github.`, `notion.`, `slack.`, `linear.rallywith.ai` and the
   Resend receiving host exist because those providers publish one callback URL;
   with one region they could be the API itself, but changing them means
   re-registering four public provider apps against live installations for no
   product benefit. The hostnames stay; their *routing* — the directories, the
   forwarding, the region-prefixed OAuth state — goes.
5. **Renaming Avalon → Rally.** *Deferred* to
   [`rally-rebrand-inventory.md`](../../rally-rebrand-inventory.md), except
   where a string this change already has to touch carries the name.
6. **Retiring the Terminal capability switch or the emergency disable.**
   *Rejected.* `TERMINAL_REGION_CAPABILITY` and `TERMINAL_EMERGENCY_DISABLED`
   read as region wiring and are not: they are an availability gate and a
   break-glass switch. They stay, with the regional framing removed from their
   names and prose.
7. **Deleting the live EU account resources.** *Out of reach from git.* Wrangler
   deletes neither a Worker nor a bucket by omission. The four live EU Workers,
   the EU D1 database, the EU-jurisdiction buckets, the EU Vectorize index, the
   EU queues, and the EU custom domains are torn down in the Cloudflare
   dashboard after deploy, from the checklist this change adds to
   [`runbook.md`](../../runbook.md). See [`design.md`](design.md).
8. **Migrating EU workspace data.** *N/A — there is none.* Verified against the
   EU database on 2026-09-13: zero workspaces, zero members, zero work streams.
   The check is re-run as a deploy gate rather than trusted from this date; see
   **Rollout**.
9. **Ashby, guest sharing, PostHog project configuration, and the Slack app
   store listing.** Untouched.

## Product behavior

### Creating a workspace

A new user who has no workspace and no invitations reaches workspace setup. They
name their workspace and continue. The **"Where should Rally keep your data?"**
question, the Global and European Union options, and the note beneath them are
gone. The screen has one field and one button.

The `onboarding_region_selected` telemetry event stops existing, along with its
`selectedRegion` property, and is retired through the process in
[`adding-new-instrumented-event.md`](../../adding-new-instrumented-event.md)
rather than left registered and never emitted.

### Accepting an invitation

The invitation card shows the workspace, who invited you, and your role. The
**"European Union data region"** / **"United States data region"** line is gone.
Accepting works exactly as it does now.

### Living in a workspace

- **Workspace settings** no longer shows a *Workspace region* row.
- **The workspace switcher** no longer labels entries *EU workspace* or *US
  workspace*; each entry is just the workspace.
- **Connections, Terminal, and search** behave identically. Where a surface
  currently says a provider "is not configured in this Rally region", it says it
  is not configured.
- **Links keep working.** A work-stream link already shared in Slack or email
  carries a region segment (`/app/workspaces/global/<workspace>/workstreams/…`)
  or a `?region=` parameter. Those keep resolving. Newly copied links omit the
  segment. See key design decision 2.

### Signing in on a desktop that already has a session

Nothing happens. The client holds credentials keyed by `(region, workspaceId)`
and a stored profile that records a region; on first launch after the update it
reads those, ignores the region, and carries on. Nobody is signed out, and a
client that has not updated yet keeps working against the same API. See key
design decision 3.

### Errors and empty states

No new error exists. The failure modes that disappear — an EU bridge that is
unreachable, a provider delivery for an installation with no route, a session
whose claim disagrees with its workspace row, a work-stream name reservation
that cannot reach the Global registry — disappear with the code that produced
them, along with their tests.

## Impact on the product contract

**This changes the contract.** [The Rally implementation
brief](../2026-08-05_avalon-implementation-brief/prd.md) lists "Global/EU signup
routing" among the capabilities the product provides. That clause is struck.
Choosing where a workspace's data lives is no longer something Rally does, and
the brief is edited in the same change to say so — it is the one PRD that stays
current, so this is an edit to it rather than a note about drift.

Nothing else in the brief moves. What a work stream is, whether viewing implies
participation, what the agent may do, the absence of channels, the absence of a
global inbox — none of it is touched. A workspace is still the tenancy boundary;
it simply has one possible home.

**The public trust pages contradict the product after this ships**, and that is
a contract question rather than a code one. `apps/site/trust/terms`,
`/trust/dpa`, and `/trust/subprocessors` each describe a customer-selected
"Global or EU workspace architecture", and the DPA's international-transfers
clause is written around it. Those pages are customer commitments; rewriting
them is not a change an engineer makes unilaterally. See **Open questions**.

## Key design decisions

1. **Global Durable Objects keep `jurisdiction("us")` forever.** The
   `JURISDICTION_BY_REGION` map collapses to the constant `"us"`; it does not
   collapse to nothing. *Rejected: removing the jurisdiction call as part of
   "removing jurisdiction flags".* Jurisdiction is an input to ID derivation, so
   removing it silently re-points every name at a new, empty object while the
   old one keeps existing and paying. This is the single most destructive edit
   available in this change, it produces no error when it happens, and the
   symptom is every work stream in production appearing blank. The constant is
   commented with this reason at the call site so the next person to see a
   one-entry map does not "simplify" it.

2. **Links stop emitting a region segment but keep parsing one.** The canonical
   form becomes `/app/workspaces/<workspace>/workstreams/<id>`. The parser
   continues to accept the current `/app/workspaces/<region>/<workspace>/…` path
   and the `?region=` query parameter, discarding the value — and refuses `eu`
   as an unknown workspace rather than a routing decision. *Rejected: keeping
   the segment with a literal `global`.* That preserves a routing dimension in
   every URL we mint forever to save one parser branch. *Rejected: dropping
   parse support.* Links are already in customers' Slack and email;
   [`2026-09-11_https-work-stream-links`](../2026-09-11_https-work-stream-links/prd.md)
   just made them shareable, and breaking them would be a self-inflicted
   regression in the same month.

3. **The desktop tolerates and discards the stored `region` field rather than
   failing to parse it.** Stored auth, the workspace directory, device
   preferences, and the draft cache all persist a region today. Their schemas
   drop the field, and their readers strip an unknown `region` instead of
   rejecting the record. *Rejected: a strict schema.* A strict parse on a
   record written by the previous build signs the user out on upgrade, which is
   the worst possible outcome of a change whose entire premise is that nothing
   user-visible should break. The repository already has the shape for this in
   the legacy stored-auth path.

4. **The provider ingress hostnames stay; the routing dies.** `github.`,
   `notion.`, `slack.`, and `linear.rallywith.ai` keep answering, verifying
   signatures, and processing locally. The installation-to-region directories,
   the `<region>.` OAuth state prefix, the forwarding bridges, and the
   "no route" refusal path are deleted. *Rejected: pointing the providers at
   `api.rallywith.ai` and deleting the hosts.* Four live provider registrations
   would need re-registering against existing installations to save four DNS
   records.

5. **The D1 region columns are removed in a separate, classified destructive
   migration applied after the Worker that cannot write `eu` is live.** Twelve
   tables carry `region TEXT NOT NULL CHECK (region IN ('global','eu'))`; four
   carry it inside a PRIMARY KEY or UNIQUE constraint; two triggers branch on it
   to validate placement affinity. SQLite cannot alter a CHECK in place, so this
   is a table rebuild on a 454 MB production database. *Rejected: doing it in
   the same deploy as the Worker.* The repository's release workflow already
   encodes the correct order — a destructive product-schema retirement is
   applied *after* the compatible replacement Worker — and there is no reason to
   be the first change to violate it. *Rejected: leaving the columns as an inert
   constant.* A schema that still admits `'eu'` is exactly the stub this PRD was
   asked not to leave behind.

6. **[`regionalization.md`](../../regionalization.md) is deleted, not
   rewritten.** Its entire subject is the boundary being removed. The parts that
   outlive it move to the documents that own them: Durable Object placement
   affinity and the permanent `us` jurisdiction to
   [`data-model.md`](../../data-model.md) and
   [`workstream-durable-object.md`](../../workstream-durable-object.md); the
   shared provider ingress hostnames to
   [`provider-apps.md`](../../provider-apps.md); the deployment graph to
   [`api-worker-deployment.md`](../../api-worker-deployment.md); and the standing
   caution that Cloudflare's account-level services are not jurisdiction-pinned
   to [`security.md`](../../security.md). Its row leaves
   [`docs/README.md`](../../README.md). *Rejected: keeping a one-paragraph
   "Rally runs in one region" document.* A registered document whose subject no
   longer exists is a trap for the next reader who finds it in the index.

## Data model

The region columns come out in the order below. Nothing is backfilled: every
existing row already holds `'global'`.

| Table | Region's role | After |
| --- | --- | --- |
| `workspaces`, `platform_workspace_bindings` | `region` column, CHECK, and a placement-affinity trigger that branches on it | Column dropped; the trigger validates `wnam`/`enam` only |
| `workspace_invitations`, sessions, and the other seven product tables carrying `region` | Column and CHECK only | Column dropped |
| `github_installation_routes`, `linear_organization_routes`, `notion_workspace_routes` | `region` inside the PRIMARY KEY; the table exists to map an installation to a region | Region dropped from the key; the tables survive as installation→workspace directories |
| `workstream_email_routes` | `region` inside two UNIQUE constraints; the Global reservation registry serves every region | Region dropped from both constraints; the registry is simply the registry |

`placement_affinity` narrows from `('wnam','enam','weur','eeur')` to
`('wnam','enam')`. The east/west split at 100°W stays: it is a latency
optimisation within one jurisdiction, not a region boundary, and every existing
row already holds one of the two surviving values.

A new checked-in D1 baseline is generated after the migration lands, per
[`d1-baseline-migrations.md`](../../d1-baseline-migrations.md).

## Regional impact

There is no region boundary after this change, which is the point. What that
removes:

- **One identity plane, one data plane.** The Global bootstrap session, the
  cross-region membership and invitation discovery, and the second session mint
  on activation collapse into ordinary sign-in.
- **No RPC bridges.** All thirteen named service entrypoints and the schemas
  in `rpc-contracts.ts` that exist to parse their arguments are deleted, along
  with the ESLint rule ban they motivated — `durable-object-region-routing`
  stays, because it also protects the single-resolver rule, with its EU cases
  removed.
- **One telemetry path.** The EU internal sink, the country-signal
  classification during onboarding, the EU crash-suppression decision, the
  Global↔EU preference and capability control RPC, and the page-scoped EU
  identity on the public site all go. Every accepted event takes the Global
  path into PostHog and `avalon.analytics_events`.
- **One inference archive.** Every model run is archived, because the workspace
  that produced it is always in the region that has a lakehouse. The "EU
  inference is intentionally not archived" caveat is removed from
  [`AGENTS.md`](../../../AGENTS.md), the runbook, and the harness document.
- **One Ace.** The operator directory reads one database, the flag fan-out
  targets one queue, and the second operator credential and API base URL go.

What does *not* change: Rally still does not claim that every byte is processed
in one jurisdiction. Cloudflare's Workers Logs, Traces, and Analytics Engine
remain account-level services with no jurisdiction pinning, and
[`security.md`](../../security.md) keeps saying so.

## Security and trust model

- **One key set.** `SESSION_SIGNING_KEY_EU`, `OAUTH_STATE_ENCRYPTION_KEY_EU`,
  `CONNECTOR_CREDENTIALS_KEY_EU`, `CONNECTOR_CREDENTIALS_KEYS_JSON_EU`,
  `GITHUB_APP_PRIVATE_KEY_EU`, the EU Notion OAuth client, the EU telemetry
  operator map, and the EU operator token are removed from `.env.example`, the
  runbook, and CI. **The live secret values are revoked at the Cloudflare
  dashboard as part of teardown**, not merely unreferenced — an unreferenced
  secret on a live Worker is still a live credential.
- **Signature verification is unchanged.** Every ingress still verifies the
  provider's signature before parsing. What is removed is the second
  verification an EU Worker performed on forwarded bytes, which existed only
  because the bytes had crossed a boundary.
- **Sessions get simpler in the direction of safety.** The class of bug where a
  session's region claim disagrees with its workspace row — a valid signature on
  a cross-region read — cannot occur when there is one region. The
  session-to-workspace check itself stays.
- **No secret is committed.** The EU values are removed from example and
  documentation files only; the real ones live in Cloudflare and `.env.local`,
  which stays ignored.

## Rollout

**No feature flag.** This was asked and answered in the 2026-09-11 standup: the
region is removed rather than disabled, and there is to be no toggle, no
"disabled EU" environment, and no stub region. A flag here would be a second
code path guarding the deletion of a second code path. The change is reversible
by revert until the destructive migration in phase 3, which is the point of no
return and is deliberately last.

Ordered phases. Each is a separate pull request; each is deployable on its own.

1. **Stop creating EU workspaces.** Workspace setup loses the region step and
   the API refuses `eu` on create. Landing this first means the zero-EU-workspace
   fact cannot change underneath the rest of the work. Gate: a new workspace is
   created from the desktop client with no region question.
2. **Delete the code path.** The bridges, routing directories, region
   parameters, `Region` type, EU Wrangler graph, EU `pnpm` scripts, EU CI steps,
   EU environment variables, and the EU branches of every client surface come
   out. The D1 columns stay, holding `'global'`. Gate: `pnpm lint`,
   `pnpm typecheck`, scoped tests for every touched package, one API from
   `pnpm dev:api:local`, and the desktop client driven against it.
3. **Retire the schema.** The classified destructive migration drops the region
   columns, narrows `placement_affinity`, and rewrites the two triggers; a new
   D1 baseline is generated. Gate: `db:baseline:verify` against the hosted
   database, and the migration classification recognises it as destructive and
   sequences it after the phase-2 Worker.
4. **Tear down the account resources.** Follow the new runbook checklist: delete
   the four EU Workers, the EU D1 database, the EU-jurisdiction buckets, the EU
   Vectorize index, the EU queues and their dead-letter queues, the
   `eu.api.rallywith.ai` and `eu.api.with-avalon.com` custom domains, and revoke
   every EU secret. Gate: the EU Workers no longer appear in the account and
   `eu.api.rallywith.ai` does not resolve to a Worker.

**Deploy gate, every phase.** Re-run the emptiness check against the EU database
before any irreversible step:
`SELECT COUNT(*) FROM workspaces` must return 0. A non-zero result stops the
release and reopens this PRD's decision log — it means someone created an EU
workspace after 2026-09-13, and what happens to it is a product decision, not a
migration script.

**Rolling back** phases 1–2 is a revert. After phase 3 it is a restore from a
D1 point-in-time backup; after phase 4 it is a rebuild from scratch. That
ordering is deliberate: everything cheap to reverse happens before anything that
is not.

## Acceptance

1. `rg -i 'avalon-api-eu|wrangler\.eu|EU_[A-Z_]+_BRIDGE|weur|eeur|jurisdiction\("eu"\)|European Union'`
   over the tree returns only changelog entries and this PRD folder.
2. `rg -w eu` over `apps/`, `packages/`, `scripts/`, `config/`, and `.github/`
   returns nothing that is a region.
3. `pnpm lint`, `pnpm typecheck`, and `pnpm test:scripts` pass, and the tests
   for every package the change touches pass with no new flakes.
4. `pnpm dev:api:local` starts **one** Worker. `curl http://127.0.0.1:8787/health`
   reports `ok`, and there is nothing on 8788.
5. `pnpm db:migrate && pnpm db:seed` sets up one local database.
6. The desktop client, run under Xvfb against that single API per
   [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it),
   creates a workspace with no region question; workspace setup, the invitation
   card, workspace settings, and the switcher are screenshotted and read.
7. An existing desktop install with a stored session launches against the new
   client without signing in again.
8. A work-stream link copied before the change still opens the right work
   stream; a link copied after it carries no region segment.
9. `pnpm health:regions` checks one region, and `deploy-api.yml` has one deploy
   path with no ordering barrier.

## Open questions

1. **Who rewrites the trust pages, and when?** `apps/site/trust/terms`,
   `/trust/dpa`, and `/trust/subprocessors` promise a customer-selected EU
   architecture, and the DPA's international-transfers clause is built on it.
   These are customer commitments; an engineer should not edit them. **This
   blocks the public launch of the change, not the code.** The answer decides
   whether phase 1 ships before or after the copy is corrected.
2. **Does `eu.api.rallywith.ai` keep resolving to anything?** The Worker route
   goes either way. Whether the DNS record and its ACM pack are deleted or left
   pointed at nothing is a call for whoever does the dashboard teardown; the
   only thing this PRD requires is that no Worker answers there.
3. **Is `avalon-eu-memory` (Vectorize) safe to delete outright?** It is declared
   only by the EU Worker and no EU workspace exists, so it should hold nothing —
   but Vectorize is not covered by the D1 emptiness check above, and the
   teardown step should confirm a zero vector count before deleting rather than
   assume it.

## Decision log

None yet.
