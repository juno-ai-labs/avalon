# Forced Durable Object migrations

Operators can wake dormant Durable Objects to apply the schema in the deployed
build. This module owns the constructor migration wrapper, forced-migration RPC,
regional command consumer, and operator CLI. It does not maintain a fleet registry.

## Where the code lives

- `apps/api/src/durable-objects/migratable-durable-object.ts` owns constructor gating and `forceMigration`.
- `apps/api/src/durable-objects/migration-runtime.ts` traces synchronous schema application and reads version receipts.
- `apps/api/src/queues/migration-command-consumer.ts` routes commands to supported regional namespaces.
- `packages/contracts/src/durable-object-migrations.ts` defines the command contract.
- `scripts/force-substream-agent-migrations.mjs` inventories objects and queues commands for `AgentLoopDO` or `WorkspaceDO`.

## How it works

Each class declares its migration plan and exposes `migrationsReady()`. A normal
wake applies migrations during construction. `forceMigration` checks class and
object IDs, awaits that same constructor gate, then returns the version from
`_sql_schema_migrations`. No second migration runner or report transport exists.

The CLI enumerates Cloudflare namespaces and stored object IDs, classifies their
jurisdiction using the local remote-binding probe, then sends one message per
eligible object through the Cloudflare Queue API. The API consumer compares the
receipt with its deployed head, logs a shortfall, and acknowledges success.

## Invariants

Commands are routed only through the namespace for their explicit class and
region. IDs are opaque; legacy IDs from another jurisdiction are excluded.
Repeated delivery wakes the same object and is naturally idempotent.
Queue provisioning explicitly records the CLI as producer of migration-command
queues; ordinary queues still require both producer and consumer declarations.

## Boundary

The CLI needs account-level Cloudflare credentials for namespace inventory and
queue writes. It never reads product payloads. Only the regional API holds the
namespace bindings that can apply the command. These are operator capabilities,
not public HTTP routes.

## Failure modes and limits

Malformed, deleted-class, or misrouted commands are acknowledged with diagnostics.
Migration failures retry and eventually reach the regional dead-letter queue.
The CLI checks for increased dead letters while waiting for command backlog to
drain. A drained queue alone does not prove every object reached the latest
schema: inspect `migration_command_applied` logs for version shortfalls and
`migration_command_failed` diagnostics. There is no inventory dashboard.

## Testing

`apps/api/test-workers/forced-migration.test.ts` exercises actual Durable Object
construction, receipts, routing, and queue retries. The CLI's Node suite covers
inventory, class selection, jurisdiction filtering, and sent command bodies.

## Operations

Deploy the API before running an eager pass. Set `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` in the operator environment. The token needs namespace
inventory and Queue read/write access. Do not put it in Worker runtime vars.

Start the local probe, whose bindings point to the deployed namespaces:

```sh
pnpm migrate:substream-agents:probe
```

Preview a fleet pass, then apply using that probe:

```sh
pnpm migrate:substream-agents -- --class=WorkspaceDO --region=global
pnpm migrate:substream-agents -- --class=WorkspaceDO --region=global --jurisdiction-probe-url=http://localhost:8790 --apply
```

Use `--class=AgentLoopDO` for agent objects; it remains the default for existing
invocations. `--region=all` targets configured regions. Add the corresponding
unrestricted external namespace bindings to the probe config when enabling a
new region. The probe only parses IDs and never opens objects.

## Changelog

### 2026-11-10 — Retain forced migrations without a tracker

The tracker app was retired at the product owner's request. Removed constructor
reports and their queue contract rather than leaving a report ledger and traffic
path with no receiver. Kept regional forced migration because dormant workspaces
still need eager backfills, and extended the existing CLI to both active classes
instead of building another operator site. Failures remain visible in Worker logs
and dead-letter queues.
