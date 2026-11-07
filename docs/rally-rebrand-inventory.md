# Rally rebrand: Avalon reference inventory

Avalon is becoming Rally. Part of that rename has already landed — the npm
package scope, the public hostnames, the product HTTP headers, the desktop
bundle identity and deep-link scheme are all Rally already, with the Avalon
forms kept deliberately as compatibility. The public site and canonical brand
asset pipeline are Rally; the remaining work is enumerated below.

This document is the **inventory**: what still says Avalon, where, and — the
part that decides the order of work — what each reference is coupled to. As
each category is worked, its section records what moved, what deliberately did
not, and what a consumer outside this repository still has to do.

Sections 3, 5, 6, 7, and 9 are **done**; sections 1, 4, and 8 are outstanding;
section 2 is closed as out of scope.

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

**Snapshot from the first inventory: 583 tracked files, ~4,560 occurrences.** By area:

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
| GitHub App and provider request identity | `Rally With AI`, Rally request metadata, and `Rally Agent` commits | existing and new work-stream head refs remain `avalon/<slug>`; the prefix is stored and visible on GitHub, so moving it requires an explicit compatibility plan that continues accepting in-flight refs |

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

- **Lakehouse / catalog names**: `avalon.analytics_events`,
  `avalon_agent_runs`, `avalon-global-inference-lakehouse`.

- **Analytics Engine datasets**: `avalon_agent_runs` and
  `avalon_terminal_operations`, bound as `RUN_ANALYTICS` and
  `TERMINAL_ANALYTICS`. These read as ordinary snake-case identifiers rather
  than `avalon-` resource names, which is exactly how one of them was swept
  into section 3 by mistake and had to be reverted. Changing `dataset` on a
  binding does not rename anything at Cloudflare — it starts writing to a new,
  empty dataset, and unlike a PostHog event name there is no destination-side
  alias for an Analytics Engine dataset.

### 3. Externally-observable identifiers — renamed to Rally

**Done.** Every identifier below now mints its Rally spelling. What each one
still needs on the *consumer* side is the part this section exists to record —
renaming the emitter does not move a dashboard.

| Identifier | Now | Consumer action still outstanding |
| --- | --- | --- |
| Analytics event names (55 distinct) | `rally_*` | PostHog dashboards, saved insights, and cohorts still query `avalon_*`. Alias the old names at the destination or the charts go flat. |
| PostHog person properties (10) | `rally_*`, `first_rally_release` | **Worse than an event rename, and not aliasable.** An event that stops being emitted makes a chart go flat, which is visible. A person property that stops being written stays on every existing profile at its last value forever, so a cohort or filter on `avalon_lockdown_mode_enabled` keeps returning a frozen answer that reads as live. Rebuild those cohorts on the `rally_*` names. |
| PostHog `$app_name`, `$lib` | `Rally`, `rally-regional-telemetry` | Both appear on every event. Moved with `$app_namespace` so the three are not half-renamed. |
| OpenTelemetry span attributes (68 distinct) | `rally.*` | Saved trace queries filtering `avalon.*` stop matching. Traces are short-lived, so this ages out on its own. |
| PostHog app namespace | `app.rally.desktop` | Partitions existing desktop events from new ones under `$app_namespace`. |
| Plugin ids (16 distinct) | `rally:*`, `rally_*`, `rally.skills` | `plugin_activation_hints.plugin_id` in the work-stream Durable Object stores canonical ids, so every existing work stream loses its preload hints once — a soft optimization that re-populates on the next activation. `run_plugin_activations` also stores them; a lookup miss re-authorizes rather than throwing. The `AVALON_*_PLUGIN_ID` env var *names* are section 4 and unchanged. |
| Socket ticket sentinel | `rally.ticket.v1` | None. `avalon.ticket.v1` is accepted inbound and echoed back; see below. |
| Public-site anonymous epoch key | `rally.site.anonymous-epoch.v1` | A returning visitor gets a fresh anonymous epoch once. |

The **socket ticket sentinel** was the one identifier here that could not be
renamed outright. A desktop build already installed offers the sentinel it
shipped with, and Chromium fails a handshake whose response selects a
subprotocol the client never offered — so accepting the superseded spelling is
not sufficient, the server has to echo back the one it was handed.
`SUPERSEDED_SOCKET_TICKET_SUBPROTOCOLS` in
`packages/contracts/src/socket-tickets.ts` holds it, and
`negotiatedSocketTicketSubprotocol` is what a 101 now echoes. Retiring it is one
edit to that list once those builds are gone.

Two identifiers listed here in the first inventory turned out to be **already
Rally**, with the Avalon form kept as deliberate compatibility rather than debt:
`ai.rallywith.telemetry.event` (superseded schemas in
`packages/contracts/src/telemetry.ts`, which now carries both `com.rally` and
`com.avalon` spellings) and the crash-dump sidecar
`<dump>.rally.json` (superseded suffix in `native-crash-uploader.ts`).

Not renamed, and deliberately so: `avalon_upload` / `avalon_note` /
`avalon_generated` and `avalon.web_search` / `avalon.web_fetch` are section 1
and need a migration; `avalon.analytics_events` and `avalon_agent_runs` are
lakehouse names and belong to section 2.

### 4. Runtime configuration — a rename is a coordinated deploy

Environment variables and Worker bindings: **~950 occurrences, 277 files**.

- **`AVALON_REGION` alone is 743 occurrences across 236 files** — the single
  largest identifier in the inventory, about a sixth of everything. It is a
  Worker `var` read as `env.AVALON_REGION` / `c.env.AVALON_REGION` /
  `this.env.AVALON_REGION` throughout `apps/api/src`, and stubbed in nearly
  every test that constructs an env. Heaviest: `connection-service.ts` (42),
  `durable-object-namespace.ts` (19), `auth-service.ts` (16),
  `workspace-do.ts` (15).

- Also in the untracked local `.env.local` (20), which `pnpm env:sync`
  regenerates — worth checking that whatever generates it moves too.

### 5. Filesystem paths and on-disk layout — renamed to Rally, except artifacts

**Done, with one permanent exception.**

- **Sandbox paths** — `/workspace/.rally/`, `.rally/resources/`, `.rally/tmp/`,
  `.rally/logs/`, `.rally/publications/`, `/workspace/.rally-output`. The
  snapshot bootstrap that creates them is idempotent and creates the new names
  on next run; a sandbox already running against an old snapshot keeps its
  `.avalon` directories until it is replaced, which is per work stream and
  short-lived. The `AVALON_RESOURCE_DIR` env var that carries the output path
  keeps its name — that is section 4.
- **Symbolication binary** — `/usr/local/bin/rally-symbolicate`. Self-contained:
  `apps/api/crash-symbolicator/Dockerfile` builds it and the callers and tests
  in this repository are its only consumers.
- **Daytona task names** — `avalon-path-*`, `avalon-publish-*`, `avalon-write-*`,
  `avalon-bootstrap-*`, `avalon-final-diff-*`, `avalon-import-*` and the rest,
  in `terminal/runtime.ts`, `repository.ts`, `lifecycle.ts`, and
  `resource-bridge.ts`. **Not renamed.** They are per-operation identifiers
  visible only in Daytona's own dashboard and logs, they match no shape the
  sweep keys on, and moving them buys nothing a reader of those logs needs.
  Listed so the next pass does not re-discover them as an oversight.
- **Publisher session names** — `rally-publisher-<key>`, and the
  `/tmp/rally-publisher-home` Git home beside it. Minted per operation, so
  nothing outlives the rename.

**Release artifacts keep their Avalon names, permanently.** `Avalon-<version>-mac-arm64.dmg`
/ `.zip` / `.blockmap` and the `Avalon.dmg` recovery pointer are compiled into
every build shipped before the rename and polled by those builds for updates;
renaming them strands every installed client that has not updated yet. This is
the same permanence that pins `downloads.with-avalon.com` in
[`domain-migration.md`](domain-migration.md). `apps/release-retention/src/retention.ts`
reads a bucket holding both namings and must keep doing so — electron-builder
already mints `Rally-${version}-...` for new releases, so the bucket is mixed by
design, not by oversight.

### 6. Brand assets — done

- The canonical mask and generated mark are `assets/brand/rally-mark-source.png`
  and `assets/brand/rally-mark.png`. The generator writes the same real mark to
  the shared UI package (`packages/ui/src/assets/rally-mark.png`), native icon,
  menu bar, site, desktop favicon, and social-card surfaces.
- The public site's pages render the redesigned vector mark
  (`/brand/rally-mark.svg`, with `/brand/rally-mark-small.svg` below 24 px and
  `/brand/rally-mark-ink.svg` — the same cut stroked ink — on light surfaces,
  where the lime stroke has no contrast).
  `/brand/rally-mark.png` is still served because provider manifests hotlink
  that URL; it, `assets/brand/rally-mark.png`, and every other generated
  raster asset come from `scripts/generate-brand-assets.py`, whose source mask
  `assets/brand/rally-mark-source.png` is rendered from the same vector. The
  obsolete public Avalon mark and oversized `og.png` were removed.
- `apps/api/test/avalon-tool-prose.test.ts` — filename.
- `docs/PRDs/2026-08-05_avalon-implementation-brief/` — folder name, and the
  standing product contract [`docs/README.md`](README.md) points at. PRDs
  freeze under [`prds.md`](prds.md), so this one is history, not debt.

### 7. User-facing copy — public site done

The marketing, handoff, support, legal, manifest, metadata, unfurl, and Trust
Center surfaces now identify Rally. The public legal documents were reviewed as
product-party copy and publish in one hierarchy below `/trust/`; their previous
top-level URLs remain only as permanent compatibility redirects. Internal
noindex concept studies remain in the tree but are not a production navigation
surface.

Mailboxes printed by the site use `@rallywith.ai`. Superseded invitation and
notification addresses elsewhere remain governed by the retirement conditions
in [`domain-migration.md`](domain-migration.md), not by this completed site pass.

The Slack installation landing page now documents `/rally` so it agrees with
the provider registration. Its public directory contact is the same confirmed
`help@rallywith.ai` catch-all used by the site; `support@with-avalon.com` and
other role aliases are not published as parallel external contact paths.

Workspace invitation emails and their accepted/declined follow-ups identify
Rally and use white backgrounds, neutral text, and black primary actions. Their
headers pair the name with `rally-mark-email.png`, a 96px raster export of
`rally-mark-ink.svg` displayed at 32px for email compatibility. Publish that site
asset with the API templates. The invitation-specific macOS download links and
delivery idempotency keys retain their existing behavior.

### 8. Internal prose — cheapest, and safe to move alone

- **`docs/`: 538 occurrences across 64 files.** Heaviest: `runbook.md` (67),
  `domain-migration.md` (54, mostly *about* the rename and correct as written),
  `performance-tracing.md` (42), `security.md` (24), `agent-harness.md` (20),
  `telemetry.md` (15). Most of the rest is prose using "Avalon" as the product
  name, which is now simply wrong rather than coupled to anything.
- **Code comments and test fixtures**: 221 of the 583 files are tests. Much of
  that is fixture strings — `avalon-task-1`, `avalon-ws-stream`,
  `avalon.example`, `avalon.test`, `https://linear.app/avalon/issue/ISS-42` —
  which are internal to the test that mints them and coupled to nothing.
- **`.github`** (14) and **`.agents`** (8).

### 9. The agent loop's prompt surface — renamed to Rally

**Done.** The first inventory counted these under section 8 as prose. That was
wrong, and the misfiling was the finding: **this prose is executed, not read.**
The work-stream system prompt opened `You are Avalon`, so the agent introduced
itself by the code name, in its own voice, to every user in every work stream.

Five prompts said it outright and now say Rally: the work-stream system prompt,
Control Tower and the end-of-meeting summarizer in `meeting-notes-service.ts`,
the automation architect in `prompts/automation-compiler.ts` (since deleted with
the first automation object), and the read-only sub-agent in `integrations.ts`. The prompt bodies moved with them — the
addressing classifier, work-opportunity admission and ranking, the Bind
summarization instructions, and the injected context headers (`SCHEDULED DIGEST
BRIEF FROM RALLY`, since deleted with the digest's model run, and
`USER-SELECTED RALLY SUGGESTED-WORK BRIEF`).

Three things here were not prose, and each moved as a pair or not at all:

| Item | Now | Why it needed care |
| --- | --- | --- |
| `writableByRally` | renamed | A tool-output field the model is told to branch on, named inside two tool descriptions. The field and the descriptions had to move in the same change or the model would be told to read a key that no longer exists. |
| `rallyTruncated` / `rallyTotalChars` | renamed | Same shape, in Notion tool output. |
| `avalon-core-write-v1` | **unchanged** | Not a label: the seed of a hash deriving durable provider idempotency keys. Renaming it silently re-issues writes that were already idempotent. It belongs to section 1. |

The surface was wider than the first audit found. Beyond the prompts, the model
also reads: the attachment manifest header, the memory-retrieval embedding
instruction, and — the largest group — the Terminal tool-result messages, which
are not status text but instructions the model acts on ("Retry this exact tool
call", "do not repeat the command"). Those moved too. Finding them took the
positive check rather than a list of likely files, which is the same lesson
recorded under the section 3 sweep.

One more of the same class surfaced on 2026-08-26, found from behavior rather
than a sweep: the work-stream object labelled the agent's own turns `"Avalon"`
in the recent-message context it hands the addressing classifier. An author
field, not a prompt file — but it is serialized into the same user-role JSON
the classifier reads, whose system prompt introduces the agent as Rally, so the
classifier could not tell that the agent itself had asked the question a member
was answering. It now says Rally.

**Tool descriptions the model reads when choosing a tool** — the six Google Docs
and Sheets descriptions in `packages/connectors/src/index.ts`, the X plugin, the
Linear native-agent plugin, and the core plugin's own utilities line all moved;
the four Slack connector labels moved earlier, in the Slack cut-over.

**Not section 9, and deliberately left here:** the API error strings surfaced
in the client UI. Those are user-facing copy the public-site pass did not reach,
and they are section 7's remainder rather than this section's. The digest email
(`digest-email-content.ts`), once listed here too, now says Rally.

The two **person-notification** emails — `participant-` and
`mention-email-service.ts` — have moved, along with configured deployments'
`RESEND_FROM_EMAIL` and `RESEND_NOTIFICATION_FROM_EMAIL` display names, which
front every template including the four above. They were taken out of order
because their Slack halves had already moved, so one event arrived as "Open in
Rally" in a DM and "Open in Avalon" in an inbox; and because a sender line
reading Avalon over a Rally body is worse than either name used consistently.
The consequence to know before finishing the sweep: those four templates now
arrive **From: Rally** with an Avalon wordmark, which is the same split in the
other direction and is the reason to finish rather than a reason to revert.

**Strings the agent emits to people** moved too: the Slack fallback and mention
copy in the Slack cut-over, and the Control Tower failure notices with this
change.

**Identity sent to third parties** moved: `appName` (the `X-Title` header on
every inference request, 4 call sites), the hosted-MCP `client_name` and
`clientInfo.name`, and the Linear GraphQL operation names that appear in that
provider's own request logs. The GitHub half — the App identity, the connector
and Terminal publisher user agents, the pinned-repository query, and the commit
author — moved in the GitHub provider cut-over rather than here; this section
claims only what it changed. The account finding from that
slice is worth keeping here because it is easy to re-litigate: neither
`rally-agent` nor `avalon-agent` resolves to a GitHub account, so the commit
trailer was unattributed before the rename and after it — the name on it moved,
not who it credits.

**One string here must not change.** `avalon-core-write-v1` in
`integrations.ts` is the seed of a hash that derives durable provider
idempotency keys. It is not prose and nothing reads it as a name; changing it
changes every derived id and re-issues writes that were already idempotent.
It belongs to section 1, not here.

**A regex literal is neither a comment nor a string, and the sweep saw only the
latter two.** `classifyAddressingHeuristically` matched `/\bavalon\b/i` to decide
whether a message names the product. It is a fast path that returns *without*
invoking the model, so after the prompts moved, "Rally, take a look at this"
classified as `human_only` and the agent stayed silent while being addressed by
name. It now matches both spellings — recognizing an extra word costs nothing,
and there is no stored value to keep consistent.

**Nested template literals broke the scanner, twice.** A tokenizer that pairs
backticks naively mis-pairs `` `…${shellQuote(`…`)}…` `` and then mis-reads the
rest of the file, which is how `Rally could not restore <ref>` — printed to
stderr *inside the sandbox*, where the model reads it as tool output — and two
Daytona resource descriptions survived a pass that renamed their neighbours.
Both are fixed. The lesson is the one already recorded for the blocklist: the
sweep is a convenience, and only enumerating what remains proves anything.

**`matchedAvalonUserId` is the second field whose name is prompt text.**
`renderWorkstreamSystemPrompt` serializes the Slack origin object into the
prompt, so this schema field reads to the model exactly as `addressesRally`
does. It is declared in `packages/contracts`, which makes it look like a wire
contract — but nothing persists it (no column, no Durable Object row), so it
renames cleanly. Any *future* field of this shape needs that check first: the
declaration cannot tell you whether it is stored.

**Found while sweeping, and left for later:**
`AVALON_BRANCH_PATTERN` in `terminal/repository-selection.ts` both mints
`avalon/<slug>` and recognizes `^avalon/`. Moving it is not a rename but a
compatibility problem — branches of that name already exist in members' GitHub
repositories and in open pull requests, so the minted prefix and the recognized
one have to diverge for as long as those branches live. That is section 5's
shape, not this section's, and it is recorded here so the next pass does not
rediscover it as an oversight.

**One split is deliberate and will look like a miss.** The Terminal plugin's
system message now says "Rally creates or restores `$AVALON_GIT_BRANCH`" — the
sentence is section 9 and moved; the variable it names is section 4 and stays,
because renaming it is a coordinated change with the sandbox image rather than
with this repository. The two halves of that line have different owners.

## Product names that changed over unchanged storage

Avalon to Rally is not the only rename the tree carries. The product's own
nouns have changed several times while the storage under them kept its names,
so a storage name is not a product name and must not be read back into copy.
[`AGENTS.md`](../AGENTS.md) ("Rebranding Guide") keeps the short form for
agents; this is the record of what each step left behind.

| Step | Product name | Storage name that stayed |
| --- | --- | --- |
| Sidekicks | An **Automation** became a **Sidekick**. | `automation` (parent kind, `automation_directory`, `/automations` routes). |
| Organizations | A **Workspace** became an **Organization**. | `workspace` (`WorkspaceDO`, `workspace_id`, `/workspace` routes). |
| Spaces | A **Project** became a **Space** and grew in scope. | None: `projects` was retired with its mechanism ([`projects.md`](projects.md)). |
| Channels | A **Work stream** became a **Channel**; a **Substream** became a **Breakout**. | `workstream`, `substream`. |
| Navigation redesign ([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)) | A **Space** became a **Channel**, and a **Channel** became a **Thread**. | `spaces` held Channels; `channels` and `workstream` held Threads. |
| Canvases and Sidekicks ([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)) | A **Thread**, a **Channel** and a **Breakout** became nothing: they were deleted, not renamed. The product is two sections, **Canvases** and **Sidekicks**. | A Canvas id is a `workstream` id (`WorkstreamId`, `artifact_registry.workstream_id`, `artifact_state.workstream_id`); a Canvas's Chat is substream `"0"`; a Sidekick is an `automation`; the conversation Durable Object, renamed from `SubstreamAgent` to `AgentLoopDO`, keeps its `SUBSTREAM_AGENTS` binding and `workstream:<parent>:substream:<id>:loop` object names, since those are identities. Client names such as `WorkstreamDetail`, `useWorkstreamSocket` and `WorkstreamComposer` stay. The `spaces`, `channels` and Thread tables stay in storage, unread, until the pivot's data migrations drop them. |

## What this inventory does not settle

- **Which Avalon references are permanent.** Three are now settled: the
  Cloudflare resource names by the decision above, `downloads.` by
  [`domain-migration.md`](domain-migration.md), and the release artifact names
  by section 5. Others may be.
- **Whether the PostHog aliases get written.** Section 3 renamed the emitters;
  nothing in this repository can alias the old event names at the destination.
- **Ordering and batching.** The categories above are ordered by coupling cost,
  which is not the same as the order the work should happen in.

## Changelog

### 2026-11-07 — The product-name renames are recorded beside the Avalon ones

**What changed:** A section records each product-name rename the tree carries
— Automation to Sidekick, Workspace to Organization, Project to Space, Work
stream to Channel and Substream to Breakout, the navigation redesign, and the
Canvases and Sidekicks pivot, which deleted Threads, Channels and Breakouts —
with the storage name each one left in place.

**Why:** The pivot made `workstream` the storage name of a Canvas, the third
product noun it has stood for, and no document said so outside the agents'
rule sheet. A reader meeting `workstream_id` on an artifact row, or
`SUBSTREAM_AGENTS` beside `AgentLoopDO`, needs one place that says the name is
storage and was kept on purpose.

**Consequences:** A later rename of a product noun adds a row here and to the
"Rebranding Guide" in `AGENTS.md`, in the same change. Renaming one of these
storage names is a migration, not a sweep, for the reasons section 1 gives.

### 2026-08-25 — The person-notification emails and both Resend senders

**What changed:** `participant-` and `mention-email-service.ts` say Rally, and
`RESEND_FROM_EMAIL` / `RESEND_NOTIFICATION_FROM_EMAIL` say `Rally <…>` in both
regions and in `.env.example`. Section 7's remainder is now the invitation,
automation, and digest templates.

**Why:** taken out of section 7's order because a bug fix already had the two
notification templates open, and leaving them was producing a visible split — the
Slack halves of the same two events had moved in the Slack cut-over, so one add
arrived as "Open in Rally" in a DM and "Open in Avalon" in an inbox, on a
`rallywith.ai` link. The senders moved with them because a From line is read
before a body and shows in the inbox list without opening anything: an Avalon
sender over a Rally body is a worse artifact than either name used consistently,
and `docs/runbook.md` already documented these two vars as `Rally <…>`, so the
config was the stale side.

**Considered and rejected:** moving the two bodies and leaving the senders, to
keep the From line agreeing with the four templates still on Avalon. That
optimises for the templates not being fixed. The senders are one value each and
the bodies are four files; the sender is also the half a person sees first.

**Consequences:** the invitation, automation, and digest emails now arrive
**From: Rally** with an Avalon wordmark. That is the same inconsistency in the
other direction and is deliberate pressure to finish the section, not a state to
settle in.

### 2026-08-25 — Section 9 renamed: the agent stops calling itself Avalon

Five system prompts opened `You are Avalon`, so the product introduced itself by
its code name, in its own voice, to every user. They now say Rally, along with
the prompt bodies, the injected context headers, and the connector tool
descriptions the model reads when choosing a tool.

The audit behind the original section 9 was too narrow, and the positive check
is what showed it. Three more model-facing surfaces turned up that no list of
"prompt files" would have contained: the attachment manifest header, the
memory-retrieval embedding instruction, and the Terminal tool-result messages —
the largest group, and the least prompt-shaped, because they read as error text
while actually being instructions the model obeys ("Retry this exact tool call",
"do not repeat the command").

`addressesAvalon` is the sharpest example of why "prompt surface" is the wrong
mental model. It is a TypeScript interface field, which is section 8 by every
appearance — but `renderAddressingMessages` serializes it into the JSON the
classifier reads, so its *name* is prompt text. A field is model-facing if
something stringifies it, and that is not visible from its declaration.

The golden-prompt test earned its place here. `prompts.test.ts` hashes each
rendered prompt, so the rename failed it loudly rather than drifting through.
Before regenerating the hashes, every changed line in the prompt modules was
diffed against a rename-only normalization to prove nothing else moved — a
regenerated golden is worthless if the thing that changed it was never checked.
Five hashes moved and five did not, and the five that moved are exactly the
prompts that contained the old name, which is the cross-check that made
regenerating them safe.

Not renamed, and still correct: `avalon-core-write-v1`, the idempotency-key hash
seed, which belongs to section 1.

### 2026-08-25 — The GitHub App and request identity moved as one slice

The existing production App was renamed to `Rally With AI`; its description,
homepage, canonical callbacks, setup and webhook hosts, logo provenance, and live
slug now write Rally while the four callback entries retain the two compatibility
hosts. The same change moved the connector, Terminal catalog and publisher user
agents, pinned-repository GraphQL operation, Git commit author, and GitHub App
configuration errors. Those are the App, request-metadata, and commit surfaces;
generic Terminal model-facing prose remains in section 9.

GitHub still displays the `avalon/<slug>` namespace on every work-stream branch.
That head ref is stored and reused across runs, and existing work streams may have
an in-flight local or remote branch. Renaming the generator without first accepting
both forms would strand that state, so this slice records the prefix as deliberate
compatibility rather than treating an App rename as authority to change it.

The App ID, client credentials, private keys, webhook secret, installation ID,
repository selection, permissions, and events deliberately stayed fixed. The
slug could not: GitHub removed the old public URL on rename, so both regional
`GITHUB_APP_SLUG` secrets moved to `rally-with-ai` before the source change. The
manifest records Contents write because Terminal `full_access` depends on that
installed ceiling; treating the old read-only documentation as the target would
have broken Git pushes rather than completed a rename.

### 2026-08-25 — Rally help became the sole published catch-all

The public site and Slack app directory now publish `help@rallywith.ai` as the
one role-based inbound contact. Earlier work deliberately held Slack on
`support@with-avalon.com` until a Rally alias was confirmed; the product owner
has now confirmed `help@rallywith.ai` as the operational catch-all, so keeping
the compatibility address public would create the split this inventory exists
to prevent. Named-person addresses and outbound transactional senders remain
separate identities rather than catch-alls.

### 2026-08-25 — Public site and brand pipeline completed

Sections 6 and 7 were closed when the Rally public site landed. Review found
that the checked-in pages had moved but their source-of-truth generator and this
inventory had not: running the generator would have restored Avalon artwork and
an obsolete 907 KB social asset. The generator now owns the Rally-named source,
real mark, native assets, and compact 1200×630 social card; public pages, legal
navigation, release markup, and provider manifests consume those outputs.
The shared stylesheet also dropped the retired four-theme landing rules after
the Rally layout moved to its own class namespace; keeping that layer would
have shipped unused theme images, selectors, and responsive overrides on every
public page even though the no-index concept studies have separate stylesheets.

Compatibility identifiers, Cloudflare resource names, release buckets, and
old hostnames were deliberately not swept. Their retirement conditions belong
to sections 1, 2, 4, and `domain-migration.md`; a brand regeneration must never
be used as a reason to rename them.

### 2026-08-25 — What the sweep's verification could not see

Review of #294 found six misses. All of them are one mechanism failing in two
directions, and the mechanism is worth stating plainly because every remaining
section will be worked the same way.

The sweep keyed on the *shape* of an identifier with a blocklist, and verified
itself by counting the blocklisted strings before and after. **That proves the
blocklist held. It cannot prove the blocklist was complete, and it cannot see a
string that should have moved and did not.** Both failure modes occurred:

*Should not have moved, and did.* `avalon_terminal_operations` is an
account-level Analytics Engine dataset — section 2, out of scope — sitting one
line below `avalon_agent_runs`, which was blocklisted. It matched the snake
shape and went through. Changing `dataset` on a binding does not rename
anything at Cloudflare; it starts writing to a new empty dataset, with no
destination-side alias available. Reverted, and section 2 now names both
datasets so the next pass does not have to notice the asymmetry itself.

*Should have moved, and did not.* `avalon.component` was blocked by the
blocklist entry `com`, which existed for `with-avalon.com` and was compared
with `startsWith`. It is on the base attributes of every span, so the rename
left `rally.flow` and `avalon.component` on the same span — the exact split the
change set out to close. A blocklist compared by prefix must be anchored, or it
silently swallows every identifier that begins with a shorter blocked one.

*Neither shape nor blocklist.* `.avalon` directory paths and
`avalon-development-...`-style literals match none of the three shapes, so they
were hand-edited — and `mkdir -p /workspace/.avalon` in `repository.ts`, the
`.avalon` tar excludes in `lifecycle.ts`, and the `install -d` operand were each
missed one at a time. Hand-editing has no verification step at all, which is
what made these the least visible of the six.

The rule for the sections still outstanding: an exclusion check proves the
blocklist held and nothing more. Pair it with a positive check — after the
sweep, every remaining occurrence of the old name is enumerated and each one
individually explained — because that is the only pass that sees a miss.

### 2026-08-25 — The telemetry envelope identifier is ai.rallywith, and a collapsed supersede list

`TELEMETRY_ENVELOPE_SCHEMA` is `ai.rallywith.telemetry.event`, matching the
desktop bundle id rather than a `com.` domain nobody owns; `com.rally` joins
`com.avalon` in the superseded list.

Recorded here because of how the second half was found. The same day's section 3
sweep had rewritten the *superseded* entry into a copy of the canonical one, so
the parser would have rejected every envelope from an installed build — a live
compatibility break, produced by a rename that read as pure prose. The gates did
not catch it: the test looped over the constant, so it asserted only that the
current identifier parses, which is true no matter how the constant is spelled.

Two rules for the sections still outstanding. A supersede list is the one place
a rename must never reach, and it is exactly the place a name-shaped regex is
drawn to — every remaining sweep checks those lists explicitly, by their
literal values, before it is trusted. And a test that loops over the constant
it is meant to guard proves nothing; assert the literal.

### 2026-08-25 — The agent loop's prompt surface is its own section

Added section 9 after auditing the system prompts, tool descriptions, plugin
prose, and tool and field names that the product's own agent loop sends to the
model. The first inventory had folded these into section 8 as prose, which is
the mistake this entry exists to correct: a system prompt is executed, and
`You are Avalon` in the work-stream prompt means the agent introduces itself
by the code name to every user — a user-facing leak counted as an internal
comment.

Kept as its own section rather than merged into 7 (user-facing copy), because
the failure mode differs: site copy is wrong where a reader sees it, while a
prompt is wrong in a way that propagates — the model paraphrases the name into
text nobody wrote and no grep will find. Ordering by coupling cost puts this
last; ordering by what a user notices puts it first, which is why the section
says so rather than relying on its number.

Two things the audit turned up that are not prose and do not move with it:
`writableByAvalon` is a tool-output field the model is told to branch on, so
its description and its name have to move together; and `avalon-core-write-v1`
is a hash seed for durable idempotency keys, where a rename silently re-issues
writes — it belongs to section 1.

### 2026-08-25 — Sections 3 and 5 refactored to Rally

Renamed the externally-observable identifiers and the on-disk paths, in one
change rather than per-category, because the two share a failure mode: a
regex broad enough to catch them also catches the section 1 and 2 values it
must not touch. The sweep therefore ran with explicit blocklists —
`avalon_upload` / `avalon_note` / `avalon_generated`, `avalon.web_search` /
`avalon.web_fetch`, `avalon.analytics_events`, `avalon_agent_runs`, every
`avalon-` Cloudflare name, `AVALON_*` env var names, `with-avalon.com`, the
`avalon://` scheme, and `avalon-mark` — and the verification that each of
those still appears at its original count is the evidence the sweep stayed in
its lane.

Three things the sweep got wrong on the first pass, all caught by the gates and
recorded here because they are what a future sweep will get wrong too:

- Renaming `avalon:` by prefix hit the **deep-link scheme**, including the
  accepted-schemes list in `desktop-deep-link.ts`. Deep links from shipped
  builds would have stopped resolving. The rule now requires a lowercase letter
  after the colon, which is what separates a plugin id from `avalon:` in prose.
- The same rule renamed a **TypeScript parameter** named `avalon`.
- Renaming `Avalon-<version>` hit the **release artifacts**, which are
  permanent: `retention.ts` and its tests encode a bucket holding both namings
  because pre-rename builds poll the Avalon names for updates. Reverted, and
  section 5 now says so.

The socket ticket sentinel could not be renamed outright. Accepting the
superseded spelling inbound is not enough — Chromium fails a handshake whose
response selects a subprotocol the client never offered, so the server now
echoes back whichever sentinel it was handed rather than always the canonical
one. That asymmetry is the thing to respect if another negotiated wire
identifier is ever renamed.

Frozen PRDs and applied D1 migrations were excluded from the sweep. Both are
historical records; an inventory that edits history to make a count go down is
worth less than the history.

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
