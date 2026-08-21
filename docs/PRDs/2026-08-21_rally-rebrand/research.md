# Rename-surface survey

> Created 2026-08-21. Supporting material for [`prd.md`](prd.md): where the
> Avalon name actually lives, measured from the repository as of
> `4be383317982a4f67212e6798df227d851326b67`. Counts are
> `grep -ri avalon --exclude-dir={node_modules,.git,.wrangler}` over the
> tree. This file is an inventory, not a proposal — the decisions about each
> row are in the PRD.

Roughly **7,800 occurrences across ~800 files**. They are not one kind of
thing: some are plain prose, some are durable identifiers users hold copies
of, and some are persisted inside production data. The PRD's phasing follows
these categories.

## 1. User-visible product name

| Surface | Today |
| --- | --- |
| Desktop `productName`, artifact names, `Avalon.app`, Dock/menu-bar item | `Avalon`, `Avalon-<version>-<os>-<arch>` (`apps/desktop/electron-builder.yml`) |
| Public site copy and metadata | `apps/site` |
| Agent identity in prompts | `packages/agent-harness/src/prompts/` — the standing policy names the product; [`writing-prompts.md`](../../writing-prompts.md) treats prompt bytes as deliberate |
| Message-export card, digest emails, invitation emails | "Avalon" in rendered output |
| Brand mark | `avalon-mark` / `AvalonMark` component (~60 uses); replacement artwork is being produced separately |
| macOS Dock tile plugin | `AvalonDockTilePlugin.docktileplugin`, signed via `sign-macos-dock-plugin.mjs` |

## 2. Durable user-held artifacts (cannot flag-day)

| Artifact | Contract |
| --- | --- |
| Work-stream links `https://with-avalon.com/app/workstreams/<uuid>` | Canonical per [`workstream-links.md`](../../workstream-links.md); already embedded in Slack threads, Linear issues, and sent email |
| Work-stream / automation email addresses `…@automation.with-avalon.com` | **Permanent** per [`workstream-email-addresses.md`](../../workstream-email-addresses.md); in people's address books and forwarding rules |
| Desktop auto-update feed `https://downloads.with-avalon.com/stable/darwin/arm64` | Every installed build polls this exact URL; it is the only channel through which the fleet can be moved |
| Installed app identity | `appId: app.avalon.desktop`; userData under `~/Library/Application Support/Avalon`; keychain items, login-item registration, notification permission all keyed to the installed identity |
| Deep-link scheme | `avalon://` (desktop authentication) registered on user machines. The `avalon-export://` scheme is *not* in this category: it exists only inside the app's hidden export window ([`security.md`](../../security.md)), never appears in a user-held link, and renames freely |

## 3. Wire protocol between shipped clients and the Workers

| Identifier | Where |
| --- | --- |
| HTTP headers `x-avalon-workspace-id`, `x-avalon-user-id`, `x-avalon-session-id`, `x-avalon-workstream-id`, `x-avalon-substream-id`, `x-avalon-operation-id`, `x-avalon-socket-ticket-id`, `x-avalon-socket-ticket-expires-at`, `x-avalon-region`, and the rest of the `x-avalon-*` family | Renderer ↔ regional APIs; governed by [`when-adding-a-new-http-header.md`](../../when-adding-a-new-http-header.md) |
| Renderer origin `app://avalon` | The origin every shipped renderer presents; enforced exactly against `ALLOWED_ORIGINS` by API CORS (`apps/api/src/middleware/request-context.ts`) and every socket admission path (`apps/api/src/services/socket-service.ts`) |
| WebSocket subprotocol sentinel `avalon.ticket.v1` | Offered in `Sec-WebSocket-Protocol` alongside the ticket by every shipped build (`SOCKET_TICKET_SUBPROTOCOL` in `packages/contracts/src/socket-tickets.ts`; [`realtime-sockets.md`](../../realtime-sockets.md)). The deprecated `ticket` query parameter carries no branding |
| Model-visible tool namespace `avalon_core.<tool>` | Bind runtime tool naming (`packages/agent-harness/src/bind-runtime.ts`); regenerated per run, but present in stored transcripts |

Old desktop builds keep sending the `avalon-*` forms until they auto-update;
the servers cannot drop them on the flip day.

## 4. Domains

`rallywith.ai` is already registered and serves
`migrations.internal.rallywith.ai` ([`durable-object-migration-tracking.md`](../../durable-object-migration-tracking.md));
`withrally.ai` was bought for the public rebrand (Alex, 2026-08-21) and does
not yet appear in the tree. The `with-avalon.com` estate, by occurrence
count:

| Host | Role |
| --- | --- |
| `with-avalon.com`, `www.with-avalon.com` | Public site + `/app/workstreams/<uuid>` rewrite |
| `api.with-avalon.com`, `eu.api.with-avalon.com` | Regional APIs (custom domains on the Workers) |
| `automation.with-avalon.com` | Permanent inbound/outbound email domain (Resend) |
| `downloads.with-avalon.com` | Desktop release feed |
| `notion.with-avalon.com` | Shared Notion OAuth callback + webhook host ([`notion-ingress.md`](../../notion-ingress.md)) |
| `github.with-avalon.com`, `slack.with-avalon.com`, `linear.with-avalon.com` | Provider ingress routes on the Global Worker |

External accounts also carry the name: `avalon.slack.com` (company Slack),
`avalon.openai.azure.com` / `avalon-eu.openai.azure.com` (Azure OpenAI
resources behind the automated reviewers).

## 5. Contributor-facing identifiers

| Kind | Instances |
| --- | --- |
| GitHub repository | `juno-ai-labs/avalon` |
| Workspace packages | root `avalon`; `@avalon/{api,desktop,site,migration-tracker,release-retention,agent-harness,connectors,contracts,db}` |
| Environment variables | `AVALON_REGION` (~640 uses), `AVALON_DEV_AUTH`, `AVALON_RESOURCE_DIR`, `AVALON_WORKSPACE_ID`, `AVALON_APPLE_TEAM_ID`, `AVALON_GIT_BRANCH`, `AVALON_SKILL_TOOL_DEFINITIONS` |
| Code symbols | `AvalonApi`, `AvalonTools`, `AvalonRegion`, `AvalonUserId`, `AvalonDesktopBridge`, `AvalonMark`, … |
| Docs | Every document in `docs/`, the index, `AGENTS.md`, the root `README.md`, and [the implementation brief](../2026-08-05_avalon-implementation-brief/prd.md) |

## 6. Cloudflare resource names

| Kind | Names | Renameable in place? |
| --- | --- | --- |
| Workers | `avalon-api-global`, `avalon-api-eu`, `avalon-site`, `avalon-migration-tracker`, `avalon-global-crash-symbolicator`, `avalon-eu-crash-symbolicator` | Only `avalon-site` safely: every other script owns Durable Object namespaces or containers whose identity and stored objects are bound to the script, and a Wrangler `name` change deploys a different script |
| D1 databases | `avalon-global`, `avalon-eu` | No — recreate + copy only |
| Queues | `avalon-global-activities`, `avalon-eu-activities`, `avalon-migration-reports` | No — recreate + drain only |
| R2 buckets | `avalon-desktop-releases`, `avalon-desktop-releases-archive` | No — recreate + copy only |
| Workflows | `avalon-{global,eu}-connector-poll`, `-connector-event`, `-work-opportunity` | Config-declared; rename orphans in-flight instances |
| Analytics Engine datasets | `avalon-global-telemetry`, `avalon-eu-telemetry` | No |

## 7. Persisted inside production data

- Provider literal `avalon_upload` in D1 attachment rows
  (`packages/db/migrations/0029_message_attachments.sql`).
- `avalon_core.<tool>` names and "Avalon" prose inside stored transcripts,
  compaction checkpoints, activity events, and work-stream descriptions.
- Any `avalon_*`-prefixed names inside Durable Object SQLite storage; a
  rename there is a migration in every object of every class, tracked by the
  migration tracker.
- Terminal sandbox stable names, `avalon-<hash>`, stored per work stream and
  matched against the live Daytona sandbox
  (`apps/api/src/services/terminal/coordinator.ts`); renaming one orphans
  the sandbox it names.

## 8. Frozen by policy

- Prior PRD folders (`docs/PRDs/2026-08-05_avalon-implementation-brief/` and
  the rest): folder paths never change and completed PRDs are not edited, per
  [`prds.md`](../../prds.md). The brief's *content* is the one living
  exception.
- Git history, merged PRs, closed issues, release tags
  (`Avalon 1.123.0` etc.).
