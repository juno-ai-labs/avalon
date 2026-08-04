# Data model

The checked-in D1 migration is authoritative. Application contracts expose camel-cased TypeScript values; storage uses explicit snake-cased columns and JSON only where provider- or model-shaped data is not relationally queried.

## Identity and tenancy

- `users` stores Google identity subjects and display information.
- `workspaces` pins an immutable `global` or `eu` region.
- `workspace_members` authorizes users as owner, admin, or member.
- `sessions`, `oauth_states`, and `desktop_login_tickets` support revocable sessions, PKCE, and single-use Electron deep-link completion.
- `workspace_invitations` supports explicit membership growth without introducing a workspace switcher in V1.

Every tenant-owned table carries `workspace_id`, and every repository lookup includes it. Knowing an object ID is never sufficient authorization.

## Work streams

- `workstreams` is the central object. `origin_type` distinguishes ad hoc work from automation output without splitting the UI.
- `workstream_participants` records explicit participation reasons. Viewer presence is intentionally absent from D1.
- `messages` has a per-work-stream `sequence_number`; `workstreams.next_sequence_number` allocates ordered events.
- `message_mentions` stores validated person and connector spans.
- `resources` holds metadata while `content_ref` points at the immutable, user-visible original in regional R2. Image attachments may also carry a `model_content_ref`, `model_mime_type`, and SHA-256 for a bounded, signature-validated derivative used only for model input. `workstream_resources` owns attachment/watch behavior.
- `artifacts`, `elicitations`, and `activity_suggestions` are first-class transcript blocks.

## Automations and execution

- `automation_templates` and immutable `automation_template_versions` separate shared behavior from credentials.
- `automation_subscriptions` pins one version and owns scope, principal, connector bindings, overrides, and schedule state.
- `automation_runs.workstream_id` is unique, enforcing the one-run/one-work-stream contract.
- The partial unique index on `(automation_subscription_id, planned_for)` converges early-open and alarm-driven scheduled-run creation.
- `harness_runs` records each bounded model loop. `tool_invocations` is unique on `(harness_run_id, tool_call_id)` and stores input hashes plus side-effect state.
- `schedules` is canonical. One workspace Durable Object alarm reads due rows and advances them transactionally/idempotently.

## Connectors and activities

- `connector_connections` owns scope, encrypted provider credentials, capabilities, cursors, and health.
- `activities` stores normalized metadata and an optional R2 payload reference. Provider identity and dedupe constraints make at-least-once delivery safe.
- `resource_watches` records explicit direct relationships.
- `webhook_receipts` prevents replay; `web_monitor_snapshots` deduplicates deterministic page content.
- `audit_events` records security- and side-effect-relevant actions without copying sensitive bodies.

## Invariants

1. A personal connection must have an owner; a workspace connection must not.
2. Passive viewing never creates `workstream_participants` rows.
3. A human authoring a message or elicitation answer is upserted as a participant in the same operation.
4. A personal activity is never promoted to workspace scope implicitly.
5. Repeated provider events, Queue deliveries, alarms, workflow steps, client messages, and tool calls converge on unique keys.
6. Canonical timestamps are UTC ISO-8601 strings. Every user and workspace retains a validated IANA timezone. Calendar intent separately retains its explicit IANA timezone; omitted automation timezones resolve in the order explicit trigger, personal user, then workspace.
7. R2 objects are addressed through opaque references; raw provider payloads do not enter Queue or Workflow inputs.

## Migration policy

Migration files are immutable after deployment. New schema changes receive a monotonically numbered SQL file. Local and hosted databases are migrated with Wrangler before code that depends on the new schema is deployed. Runtime request handlers never attempt broad schema migration.
