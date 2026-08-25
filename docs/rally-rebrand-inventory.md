# Rally rebrand: Avalon reference inventory

Avalon is becoming Rally. Part of that rename has already landed — the npm
package scope, the public hostnames, the product HTTP headers, the desktop
bundle identity and deep-link scheme are all Rally already, with the Avalon
forms kept deliberately as compatibility. The rest has not been touched.

This document is the **inventory**: what still says Avalon, where, and — the
part that decides the order of work — what each reference is coupled to.
It is a survey, not a plan; it does not decide what gets renamed or when.

**The Cloudflare infrastructure does not get renamed.** Every `avalon-*` Worker,
queue, R2 bucket, and lakehouse name in [section 2](#2-cloudflare-infrastructure--out-of-scope-not-renamed)
keeps its current name — the account is out of scope for the rebrand. Those
names are internal to the deploy; nothing a user sees reads them. Treat that
section as a record of what exists under the old name, not as a work list. The
one thing it is still good for is recognizing an `avalon-` string as an
infrastructure name, so a broad rename does not sweep it up by accident.

This is the team's decision, not a conclusion of this survey; the reasoning
behind it was not recorded here.

[`domain-migration.md`](domain-migration.md) owns the hostnames, the deep-link
scheme, and the work-stream email domain, and is the authority on all three.
This document defers to it for those and covers everything else.

Counts are occurrences across tracked files (`git ls-files`), taken at the
changelog date below. They move with every commit; treat them as magnitudes.

## The shape of it

**583 tracked files, ~4,560 occurrences.** By area:

| Area | Occurrences | Files |
| --- | --- | --- |
| `apps/api` | 2,530 | 329 |
| `docs` | 538 | 64 |
| `apps/site` | 460 | 34 |
| `scripts` | 230 | 25 |
| `packages/agent-harness` | 229 | 19 |
| `packages/connectors` | 183 | 25 |
| `packages/contracts` | 103 | 17 |
| `apps/migration-tracker` | 60 | 12 |
| `apps/desktop` | 57 | 13 |
| `config` | 50 | 7 |
| `packages/db` | 35 | 18 |
| `apps/release-retention` | 23 | 4 |
| `.github` | 14 | 6 |
| `apps/ace` | 11 | 3 |

That distribution is misleading on its own, because a single identifier
accounts for a sixth of the total. The breakdown by *kind* is the one that
matters.

## What is already Rally

Renaming these again is not work; knowing they are done stops the inventory
below from being read as bigger than it is.

| Surface | Canonical form | Avalon form still present, and why |
| --- | --- | --- |
| npm packages | `@rally/api`, `@rally/contracts`, `@rally/db`, `@rally/desktop`, `@rally/agent-harness`, `@rally/connectors`, `@rally/site`, `@rally/ace`, `@rally/migration-tracker`, `@rally/release-retention` | none |
| Public hostnames | `rallywith.ai` and its nine subdomains | ten `with-avalon.com` hostnames still served — [`domain-migration.md`](domain-migration.md) owns the retirement conditions |
| Product HTTP headers | `x-rally-*`, read through `readRallyHeader` | `x-avalon-*` accepted as superseded prefixes (31 occurrences, 9 files) |
| Desktop bundle | `appId: ai.rallywith.desktop`, `productName: Rally` | none |
| Desktop deep link | `rallywithai://` minted everywhere | `avalon://` registered and accepted, never emitted (73 occurrences, 27 files) |
| Renderer origin | `app://rallywithai` | `app://avalon` still admitted by `ALLOWED_ORIGINS` (50 occurrences) |
| Telemetry envelope | Rally identifiers | superseded Avalon identifiers still parsed |
| Desktop userData / session dirs | `rally-data` and the canonical userData path | superseded directories adopted once at launch |

Everything in that table is a *deliberate* Avalon reference. It is compatibility
surface with a documented retirement condition, not rename debt.

## What still says Avalon

Grouped by what a rename would have to coordinate with. Roughly in order of how
expensive that coordination is.

### 1. Data-coupled — a rename needs a migration

Values written into D1 rows. Changing the literal in code without migrating the
stored rows silently breaks every existing record.

- **Resource provider values**: `avalon_upload` (23), `avalon_note` (9),
  `avalon_generated` (5). Written by `packages/db/src/index.ts`, read by
  queries and by triggers in `packages/db/migrations/0029`, `0045`, `0089`.
- **Web tool names**: `avalon.web_search`, `avalon.web_fetch`, constrained by a
  `CHECK` in `packages/db/migrations/0009` — the constraint has to move with
  the value.
- **Seed data**: `packages/db/seed.sql` — `Avalon Studio` workspace, slug
  `avalon-studio`, `@avalon.local` dev emails. Local only; no migration needed.
- **Applied migration prose**: ~25 comment references to Avalon across
  `packages/db/migrations/`. Applied migrations are immutable history — these
  are read-only and should be left alone.

### 2. Cloudflare infrastructure — out of scope, not renamed

Cloudflare resource names: **174 distinct names, 764 occurrences, 185 files**.
**These are not being renamed** — see the note at the top. The inventory below
records what exists so an `avalon-` string can be recognized as an
infrastructure name and left alone.

- **Workers**: `avalon-api-global`, `avalon-api-eu`, `avalon-site`,
  `avalon-ace`, `avalon-migration-tracker`, `avalon-release-retention`,
  and their `-dev` / `-test` / `-dry-run` variants.
- **Queues**: the `avalon-{global,eu}-*` families — `activities`,
  `access-revocations`, `migration-commands`, `product-feature-flags`,
  `connector-event`, `connector-poll`, `work-opportunity`, `memory`,
  `inference-lakehouse`, `analytics-events-lakehouse` — each with its
  `-dead-letter` pair.
- **R2 buckets**: `avalon-{global,eu}-{telemetry,payloads,observability}`,
  `avalon-desktop-releases`, `avalon-desktop-releases-archive`,
  `avalon-migration-reports`.
- **Lakehouse / catalog names**: `avalon.analytics_events`,
  `avalon_agent_runs`, `avalon-global-inference-lakehouse`.
- Declared in `apps/api/wrangler.{global,eu,test}.jsonc`,
  `apps/{site,ace,migration-tracker,release-retention}/wrangler*.jsonc`,
  `config/{analytics,inference}-lakehouse.json`, and asserted by the
  provisioning scripts and their tests under `scripts/`.

One typo is already in the tree: `avalon-eu-access-revocaitons` appears
alongside `avalon-eu-access-revocations`. That is a real defect rather than
rebrand debt, and is unaffected by the no-rename decision — but it is still a
provisioning change, so it belongs to whatever next touches those queues.

### 3. Externally-observable — a rename needs a consumer to move

- **Analytics event names**: **62 distinct `avalon_*` identifiers, 280
  occurrences, 69 files** — `avalon_connect`, `avalon_start_task_submit`,
  `avalon_feedback_submit`, `avalon_preferences_submit`,
  `avalon_lockdown_mode_enabled`, `avalon_menu_bar_enabled`,
  `avalon_application_icon`, and the rest. These are the names PostHog
  dashboards and saved insights query by. Renaming them breaks every existing
  chart unless the destination aliases them.
- **OpenTelemetry span attributes**: **77 distinct `avalon.*` names, 611
  occurrences, 156 files** — `avalon.workspace.id`, `avalon.workstream.id`,
  `avalon.request.id`, `avalon.socket.ticket_id`, `avalon.harness_run.id`,
  `avalon.llm_inference`, `avalon.component`, `avalon.flow`,
  `avalon.plugins.load`, `avalon.auth.duration_ms`. A partial `rally.*` prefix
  already exists (15 occurrences, including `rally.message.client_id` and
  `rally.request.id`), so the two prefixes are live at once — that split is
  itself worth resolving.
- **Telemetry event type**: `com.avalon.telemetry.event` (18).
- **Socket ticket type**: `avalon.ticket.v1` (5).
- **Plugin ids**: `avalon_core`, `avalon_web`, `avalon_terminal`,
  `avalon_skills`, `avalon_discovery`, `avalon_memory`, `avalon_tables`,
  `avalon_workstream`, `avalon_automation_architect` — surfaced to the agent
  harness and referenced by `AVALON_*_PLUGIN_ID` env vars.
- **Provider app registrations**: `config/provider-apps/*.json` (50
  occurrences, 7 files), including Slack manifests and the Linear agent icon
  at `https://rallywith.ai/brand/avalon-mark.png` — a Rally host serving an
  Avalon-named asset. These are applied by hand per provider.

### 4. Runtime configuration — a rename is a coordinated deploy

Environment variables and Worker bindings: **~950 occurrences, 277 files**.

- **`AVALON_REGION` alone is 743 occurrences across 236 files** — the single
  largest identifier in the inventory, about a sixth of everything. It is a
  Worker `var` read as `env.AVALON_REGION` / `c.env.AVALON_REGION` /
  `this.env.AVALON_REGION` throughout `apps/api/src`, and stubbed in nearly
  every test that constructs an env. Heaviest: `connection-service.ts` (42),
  `durable-object-namespace.ts` (19), `auth-service.ts` (16),
  `workspace-do.ts` (15).
- **49 other `AVALON_*` names, 207 occurrences.** Three groups:
  - *Sandbox/terminal contract* — `AVALON_RESOURCE_DIR`, `AVALON_WORKSPACE_ID`,
    `AVALON_CONNECTION_ID`, `AVALON_GIT_BRANCH`, `AVALON_GIT_BASE_BRANCH`,
    `AVALON_BRANCH_PATTERN`, `AVALON_DIFF_SUMMARY`, `AVALON_COMMAND_TIMED_OUT`,
    `AVALON_BOOTSTRAP_INSTALLED`, `AVALON_REMOTE_ACCESS`. These are injected
    into the Daytona sandbox and read by scripts running *inside* it, so they
    are a contract with the sandbox image, not purely internal.
  - *Agent harness* — `AVALON_TOOL_PROSE`, `AVALON_SKILL_TOOL_DEFINITIONS`,
    `AVALON_DISCOVERY_TOOL_DEFINITIONS`, `AVALON_SKILLS_SYSTEM_MESSAGE`,
    `AVALON_CURRENT_TIME_TOOL_DEFINITION`,
    `AVALON_REQUEST_ELICITATION_TOOL_DEFINITION`, and the `AVALON_*_PLUGIN_ID`
    set.
  - *Build, release, and CI* — `AVALON_RELEASE_R2_BUCKET`,
    `AVALON_RELEASE_DISCOVERY`, `AVALON_SITE_BUILD__*`, `AVALON_SITE_RELEASE__*`,
    `AVALON_SMOKE_*`, `AVALON_E2E_*`, `AVALON_HEALTH_*`,
    `AVALON_GLOBAL_API_URL`, `AVALON_EU_API_URL`,
    `AVALON_{GLOBAL,EU}_TELEMETRY_R2_BUCKET`, `AVALON_DEV_AUTH`.
- Also in the untracked local `.env.local` (20), which `pnpm env:sync`
  regenerates — worth checking that whatever generates it moves too.

### 5. Filesystem paths and on-disk layout

- **Sandbox paths**: `/workspace/.avalon/session.env`, `.avalon/resources/`,
  `/workspace/.avalon-output`. Written by the API and read inside the sandbox.
- **Symbolication binary**: `/usr/local/bin/avalon-symbolicate` (10), baked
  into the crash-symbolicator container.
- **Release artifacts**: `Avalon-<version>-mac-arm64.dmg` / `.zip` and their
  `.blockmap`s. Every already-shipped DMG polls the update feed for these
  names — the same permanence that pins `downloads.with-avalon.com` in
  [`domain-migration.md`](domain-migration.md).

### 6. Brand assets

- `assets/brand/avalon-mark.png`, `assets/brand/avalon-mark-source.png`,
  `apps/site/public/brand/avalon-mark.png` — 53 references across 25 files,
  including every site page header and footer, the desktop auth handoff page,
  and two provider-app registrations.
- `apps/api/test/avalon-tool-prose.test.ts` — filename.
- `docs/PRDs/2026-08-05_avalon-implementation-brief/` — folder name, and the
  standing product contract [`docs/README.md`](README.md) points at. PRDs
  freeze under [`prds.md`](prds.md), so this one is history, not debt.

### 7. User-facing copy

**`apps/site` is 460 occurrences across 34 files** and is the most visible
Avalon left in the product — the marketing site still calls it Avalon
throughout while serving from `rallywith.ai`.

- `index.html` (53): headline, meta description, OG and Twitter card titles,
  the brand mark's alt text and label.
- `concepts/index.html` (28), `concepts/horizon/index.html` (23).
- Legal pages: `terms/` (18), `privacy/` (18), `acceptable-use/` (15), and the
  footer line `© 2026 Juno AI Labs · Avalon` on every one of them. **Legal copy
  names the product as a party — these need whoever owns the legal text, not a
  find-and-replace.**
- Support and notification mailboxes: `support@`, `privacy@`, `invites@`,
  `notifications@with-avalon.com` — addresses printed to users, so they move
  with the mailboxes, not with the code.

### 8. Internal prose — cheapest, and safe to move alone

- **`docs/`: 538 occurrences across 64 files.** Heaviest: `runbook.md` (67),
  `domain-migration.md` (54, mostly *about* the rename and correct as written),
  `performance-tracing.md` (42), `security.md` (24), `agent-harness.md` (20),
  `telemetry.md` (15). Most of the rest is prose using "Avalon" as the product
  name, which is now simply wrong rather than coupled to anything.
- **Code comments and test fixtures**: 221 of the 583 files are tests. Much of
  that is fixture strings — `avalon-task-1`, `avalon-ws-stream`,
  `avalon.example`, `avalon.test`, `https://example.com/issue` —
  which are internal to the test that mints them and coupled to nothing.
- **`.github`** (14) and **`.agents`** (8).

## What this inventory does not settle

- **Whether `rally.*` or `avalon.*` wins for span attributes.** Both prefixes
  are in the tree now. The split is a fact this inventory found, not one it
  resolves.
- **Which Avalon references are permanent.** The Cloudflare resource names are,
  by the decision above. `downloads.` is already known permanent; shipped DMG
  artifact names look the same way. Others may be.
- **Ordering and batching.** The categories above are ordered by coupling cost,
  which is not the same as the order the work should happen in.

## Changelog

### 2026-08-25 — Cloudflare infrastructure placed out of scope

The team ruled the Cloudflare account out of the rebrand: every `avalon-*`
Worker, queue, bucket, and lakehouse keeps its name. Recorded at the top rather
than only in section 2, because that section is the second-largest group in the
inventory (174 distinct names, 764 occurrences) and reading it as a work list
was the likeliest way to misread the document.

Section 2 is kept rather than deleted, inverted from a work list into a
recognition list — the names still need to be identifiable *as* infrastructure
so a broad rename elsewhere does not sweep them up. The reasoning behind the
decision itself was not recorded here; a future change that wants to revisit it
should ask rather than infer it from this entry.

### 2026-08-25 — First inventory

Written because the rebrand had already landed unevenly: packages, hostnames,
headers, and desktop identity were Rally, while ~4,560 references across 583
files were still Avalon, and there was no single place saying which of those
were deliberate compatibility and which were simply untouched. Without that
distinction the remaining work reads as one undifferentiated find-and-replace,
which is the failure mode worth preventing — the `avalon_upload` provider value
and a doc sentence are the same string and nothing like the same change.

Grouped by coupling rather than by directory for that reason. A tree-shaped
inventory would put `packages/db` near the bottom on volume (35 occurrences) and
`apps/api` at the top (2,530), which inverts the actual risk: the D1 values need
a migration and most of the `apps/api` bulk is one env var and test fixtures.

Deferred to [`domain-migration.md`](domain-migration.md) for hostnames, the
deep-link scheme, and the work-stream email domain rather than restating them —
that document already owns the retirement conditions, and two copies of a
retirement condition is how one of them goes stale.

Counts are stated as of this date and will drift. A future change should
re-derive them rather than trusting these; the category boundaries are the part
meant to last.
