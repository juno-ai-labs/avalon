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

- `workstreams` is the central object. `origin_type` distinguishes ad hoc work from automation output without splitting the UI. `objective` is the work stream's description; `description_source` records whether a person wrote it (`authored`) or it was derived at creation or by the refresh loop (`derived`), which is what lets an automatic rewrite weigh a deliberate line differently from a copied opening message.
- `workstream_description_refreshes` holds one row per work stream: the last evaluation by the loop that rewrites a description once the work stream's purpose has moved. `evaluated_at` is both the throttle clock and the single-writer claim — it is stamped when an evaluation starts, so two runs finishing together cannot both spend a window and a failing model is not retried by every run behind it. `decision` records the outcome including `kept`, because knowing the loop looked is what separates a description that still fits from one nothing has examined. See [`workstream-descriptions.md`](workstream-descriptions.md).
- `workstream_participants` records explicit participation reasons. Viewer presence is intentionally absent from D1.
- `messages` has a per-work-stream `sequence_number`; `workstreams.next_sequence_number` allocates ordered events.
- `message_mentions` stores validated person and connector spans.
- `resources` holds metadata while `content_ref` points at the immutable, user-visible original in regional R2. Image attachments may also carry a `model_content_ref`, `model_mime_type`, SHA-256, and bounded model metadata for a signature-validated derivative used only for model input. Animated GIF metadata records dimensions, frame count, duration, approximate frame rate, loop behavior, and storyboard timestamps. `workstream_resources` owns attachment/watch behavior.
- `artifacts`, `elicitations`, and `activity_suggestions` are first-class transcript blocks.

## Automations and execution

- `automation_templates` and immutable `automation_template_versions` separate shared behavior from credentials.
- `automation_subscriptions` pins one version and owns scope, principal, connector bindings, activity-source bindings, overrides, and schedule state. `connector_bindings_json` maps model-facing plugin IDs to frozen connection IDs; `activity_trigger_bindings_json` independently maps reusable trigger source slots to those plugin IDs so an activity can match only the selected installation. `status` is the run state (`draft`, `active`, `paused`, `error`); `lifecycle_state` is the separate question of whether the subscription is still present (`visible`, `archived`, `deleted`), so a dismissed draft and a deleted automation share one enum instead of a flag each, and `updated_at` records when the transition happened. Archiving is restricted to drafts; deleting is allowed at any status and also disables the schedules and the email route. A deleted row is kept, never removed: automation runs, generated work streams, the memory scope, and the permanent email tombstone all reference it. Every path that starts a run — scheduler alarm, activity matching, inbound email — requires `status = 'active' AND lifecycle_state = 'visible'`, so a hidden automation cannot run.
- `memory_scopes` owns durable work-stream, automation, user, and workspace memory authority. `memory_items` stores compact prose facts; `memory_tables`, `memory_table_columns`, `memory_table_rows`, and `memory_table_cells` store typed collections with natural-key deduplication and targeted queries. Automation template versions declare table schemas, while every subscription owns an independent materialized automation scope and shares it across its generated work streams.
- `automation_runs.workstream_id` is unique, enforcing the one-run/one-work-stream contract.
- The partial unique index on `(automation_subscription_id, planned_for)` converges early-open and alarm-driven scheduled-run creation.
- `harness_runs` records each bounded model loop. `tool_invocations` is unique on `(harness_run_id, tool_call_id)` and stores input hashes plus side-effect state.
- `schedules` is canonical. One workspace Durable Object alarm reads due rows and advances them transactionally/idempotently.
- `workstream_wakeups` holds one-shot prompt wake-ups a run scheduled for itself. It is separate from `schedules` because a wake-up is one-shot, belongs to a work stream rather than a subscription or connection, and carries the prompt text that becomes the resulting run's trigger. The same workspace alarm unions it with `schedules` and `resource_watches`. `(workstream_id, idempotency_key)` is unique, so a replayed tool receipt resolves to the wake-up its first attempt created; `status` moves `pending → fired` under a version guard before the run is launched, making a wake-up at-most-once rather than at-least-once.

## Connectors and activities

- `connector_connections` owns scope, encrypted provider credentials, capabilities, cursors, and health.
- `slack_installation_routes` is the opaque Global team-to-region directory; `slack_user_links`, `slack_agent_sessions`, and durable `slack_ingress_jobs` remain regional.
- `automation_delivery_targets` freezes each destination a personal automation copies its results to, one row per `target_type`. A `slack_agent_dm` row carries the selected Slack installation and linked Slack user; an `email` row carries the owner's account address as it stood when the automation was saved and no connector connection. A per-type `CHECK` keeps the two shapes from mixing. Avalon itself is never a row — every run already owns a work stream.
- `slack_unfurled_links` records which Slack message carries which work-stream link, plus a hash of the attachment posted on it, so a posted unfurl card is rewritten exactly when it would render differently. Slack reports a shared link only once, so a row that is not written as the card is posted can never be recovered — see [`WORKSTREAM_LINKS.md`](WORKSTREAM_LINKS.md).
- `activities` stores normalized metadata and an optional R2 payload reference. `target_user_ids_json` preserves explicit owner/mention routing separately from visibility, while `external_people_json` retains bounded provider identities and exact mention evidence for workspace-scoped resolution. Provider identity and dedupe constraints make at-least-once delivery safe.
- `resource_watches` records explicit direct relationships.
- `webhook_receipts` prevents replay of signed generic-webhook deliveries.
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
