# Engineering MCP

The engineering MCP is Rally's authenticated operator path to the authoritative
SQLite database inside a workspace, a Canvas's or Sidekick's conversation, or
a live web artifact Durable Object, and to each region's D1 databases.
It recreates the useful part of Cloudflare's dashboard database console through
standard MCP tools at `https://mcp.internal.rallywith.ai/mcp`, including deliberate
repair writes. It also reads and changes the feature flags and agent model
routes that Ace manages, through Ace, and runs read-only queries against the
Global analytical lakehouses and the account's Workers Logs and Traces. Product tools create and retire Organizations, send messages
to a Canvas's Chat or a Sidekick's shared conversation, and read their
participant-visible text as a selected user, through the same services as the app. It is not a product API and it is never
available to Rally users by virtue of product membership.

## Where the code lives

- `apps/engineering-mcp/` is the public MCP Worker, Cloudflare Access verifier,
  tool registry, deployment provisioner, and its tests.
- `apps/api/src/engineering-inspection-bridge.ts` is the private named
  `WorkerEntrypoint` exported by each regional API Worker.
- `apps/api/src/services/engineering-creation.ts` adapts operator Organization
  creation to regional onboarding, and resolves the selected user's
  authority (`engineeringUserAuth`).
- `apps/api/src/services/engineering-messages.ts` adapts the ordinary composer
  and transcript range reader; `conversation-text.ts` formats participant
  prose with shared display and plaintext helpers.
- `apps/api/src/services/engineering-audit.ts` records content-free attempt and
  result events in the existing independent audit database before/after writes.
- `apps/api/src/durable-objects/internally-inspectable-durable-object.ts` owns
  the shared raw-SQL Durable Object RPC.
- `apps/api/src/durable-objects/scheduled-alarms.ts` makes every scheduled
  authority inherit that RPC. WorkspaceDO and AgentLoopDO have the
  capability that way.
- `apps/api/src/durable-objects/artifact-host-do.ts` inherits the same base
  directly. It is not a scheduled authority, so it names the inspectable base in
  its own declaration rather than picking it up from the scheduler. This MCP
  routes all four.
- `packages/contracts/src/engineering-inspection.ts` is the runtime-validated
  RPC vocabulary shared by both Workers.
- `apps/ace/src/flag-administration.ts` is the private named `WorkerEntrypoint`
  Ace exports for the flag tools. Its interface and input schemas live in
  `apps/ace/src/protocol.ts`, which this Worker compiles.
- `apps/engineering-mcp/src/lakehouse.ts` is the Basin SQL client behind
  `query_data_lake`. It takes bucket and table names from the checked-in
  `config/*-lakehouse.json` manifests.
- `apps/engineering-mcp/src/observability.ts` is the Workers Observability
  client behind `query_worker_observability`.
- `apps/engineering-mcp/src/cloudflare-api.ts` reads both clients' Cloudflare
  response envelope and names a refusal by Cloudflare's own code.
- `.github/workflows/deploy-api.yml` deploys this Worker only after both
  regional API entrypoints are live and healthy.

## How it works

The initialization response advertises the server's purpose through
`serverInfo.description` and includes usage instructions for resolving product
and storage names, selecting exact users and conversations, paging participant
reads, inspecting schemas, respecting requested mutation scope, retrying with
stable operation IDs, and keeping diagnostic credentials out of output. Clients
can use this metadata for discovery and active-plugin instructions without
inventing a capability summary from individual tools.

Cloudflare Access terminates MCP OAuth and Dynamic Client Registration at the
custom hostname. Dynamic registration accepts installed-client loopback
callbacks and hosted callbacks under the supported Claude, ChatGPT, and Cursor
origins. The MCP transport admits those same hosted request origins after
authentication. The origin independently verifies the signed
`Cf-Access-Jwt-Assertion`, including issuer and this application's dedicated
audience. A verified request reaches the stateless MCP handler; every other
request fails closed.

The regional bridge uses D1 only for identity and routing:

| Tool | Route lookup | Authoritative read or write |
| --- | --- | --- |
| `create_org` | Caller names the region | Regional onboarding commits the owner and initial members together, then performs ordinary member seating |
| `send_message` | Resolve the Organization in exactly one region | ConversationService.writableClient and ordinary create_message admission |
| `pause_sidekick`, `resume_sidekick` | Resolve the Organization in exactly one region | AutomationService.pause or resume, which call HostedSidekick in WorkspaceDO |
| `retire_org` | Resolve the Organization in exactly one region | `retireWorkspaceForOperator`, Ace's retirement door: the D1 fence, then the graph walk over every object |
| `dump_thread_transcripts` | Resolve the Organization in exactly one region | `thread-retirement-service.ts`: WorkspaceDO's Thread inventory, each conversation's AgentLoopDO, and R2 `PAYLOADS` |
| `retire_threads` | Resolve the Organization in exactly one region | `thread-retirement-service.ts`: the dump receipts in R2, `retireObject` on each conversation's AgentLoopDO, and WorkspaceDO's row deletion |
| `convert_threads_to_canvases` | Resolve the Organization in exactly one region | `thread-conversion-service.ts`: WorkspaceDO's conversion inventory and Canvas rows, the dump receipts in R2, `convertParentKind` on each Thread's Main and `retireObject` on its Breakouts, and WorkspaceDO's row deletion |
| `read_canvas_chat`, `read_sidekick_conversation` | Resolve the Organization in exactly one region | ConversationService.authorizeViewer, a refusal when the parent is the other kind, and the conversation's authorized transcript range reader |
| `list_workspaces` | Regional `workspaces` identity plus the open authority generation | D1 identity inventory from configured deployments |
| `list_orgs`, `search_orgs` | None | D1 `workspaces` and `workspace_members` in every region, filtered there and ordered here |
| `list_users`, `search_users` | None | D1 `users`, `workspace_members` and `workspaces` in every region, filtered there and ordered here |
| `list_canvases` | Regional workspace identity at the open authority generation | `canvas_directory` in WorkspaceDO |
| `list_sidekicks` | Regional workspace identity at the open authority generation | `automation_directory` in WorkspaceDO, every lifecycle |
| `list_artifacts` | Regional workspace identity at the open authority generation | `artifact_registry` in WorkspaceDO |
| `run_workspace_sql` | Resolve, select one region, then revalidate the open workspace authority generation | WorkspaceDO SQLite |
| `run_canvas_sql` | Resolve the parent's active route and, for a child, its registration (the Organization's parent tables, or a Sidekick's own registry), select one region, then revalidate | AgentLoopDO SQLite |
| `run_artifact_sql` | Resolve the regional workspace identity and `artifact_registry` membership, select one region, then revalidate | ArtifactHostDO SQLite, the supervisor's own |
| `run_d1_sql` | None: the caller names the region and the binding | The named D1 database in that region |

`list_orgs` and `search_orgs` share one bridge method, `searchOrganizations`.
Each region applies the filters in D1 (a name, slug or ID substring, plan,
abandoned state, and a creation window) and returns its matches unordered,
with the active member count, guests excluded, and the latest `last_seen_at`
of any member. The MCP merges the regions, sorts by creation time (newest
first by default), name, member count or last seen, and returns one page, so
ordering and paging run once over the whole set. `list_orgs` includes abandoned Organizations;
`search_orgs` leaves them out unless asked. They read D1 only and open no
Durable Object, so an Organization whose authority is closed still appears.

A result is `{ items, page, pageCount, total, nextPage }`, 200 rows per page
by default; the caller repeats its arguments with `page` set to `nextPage`. A
row can repeat or be skipped if an Organization is created or removed between
calls.

`list_users` and `search_users` work the same way through `searchUsers`. Each
region matches name, email or ID and a creation window, and returns each user
with every membership in that region's Organizations, whatever its status, and
the latest `last_seen_at` of the active ones. Users are regional rows, so a
person with an account in two regions appears once per region. Both tool pairs
share `src/paging.ts`, which orders the merged set and pages it.

`run_canvas_sql` takes the workspace ID and a Canvas or Sidekick ID
(`conversationId`): the conversation object is named by that id, which is a
`workstream` id in storage, and its main conversation, substream `0`. An
optional `substreamId` reaches a registered child instead: a Sidekick run's
conversation through the Sidekick's `sidekick_children`, or a background
agent's through the parent tables, both in the Organization object. An
unregistered child is not found rather than materialized. `list_canvases` and
`list_sidekicks` return the workspace and parent IDs together.

A Sidekick's ID is an `AutomationId`: the product renamed the concept, not the
identifier. A Sidekick and a work stream share one parent-ID namespace in
`workstream_authority_routes`, since a Sidekick's conversation is registered
there under the Sidekick's ID, so an active route cannot tell the two apart.

`run_artifact_sql` takes a workspace ID because ArtifactHostDO's name — `<region>:artifact:<uuid>` — carries no
workspace segment at all, so nothing in the name says which workspace may reach
it and every UUID in the account is a valid object name. `artifact_registry`,
which lives in WorkspaceDO beside the resource authority rather than in D1, is
the only thing that says which artifacts a workspace has.

**`run_artifact_sql` opens the supervisor, not the artifact's own data.** A
stateful artifact keeps its tables in a Durable Object *facet* with a separate
SQLite database, and `runInspectionSql` runs against the supervisor's storage:
the current version, viewer sessions, and the bounded error log — which is what
an operator diagnosing a broken artifact wants. The facet's tables are reachable
only through the product's own read-only admitted query path
(`queryData`/`pageData`, behind work-stream authorization), and giving the
console arbitrary SQL there would mean changing the facet host module every
stateful artifact runs. See [`live-web-artifacts.md`](live-web-artifacts.md).

### Product creation

The tools use today's product names: `orgId` is a stored workspace ID, a
Canvas ID or Sidekick ID names its conversation (a stored workstream ID), and
`creatorUserId` (creation) or `userId` (send/read) selects an existing regional
Rally user. The Access identity remains the audited operator. No tool issues a
login credential, promotes a guest, or bypasses the selected user's ordinary
product permissions. Guests can be selected; actions the app refuses for them
are refused here too.

Creation takes a fresh UUID `operationId`, reused with the original arguments
after an uncertain outcome. The Organization's ID is that operation ID, and
its creation uses the onboarding journal. A transient failure can leave member
seating unfinished; replay the original call to resume it. Reusing an ID with
changed arguments is not a new creation.

`create_org` takes `region`, `name`, and `userIds`. The creator becomes its owner;
the existing regional users become initial members, without invitations.
`RegionalOnboardingService.createWorkspaceForMember` accepts the initial member
list, validates it before creation, and commits those memberships alongside the
owner in the shared onboarding batch. A new Organization holds no Canvas.
The MCP adapter writes no membership rows of its own.

The private `engineering` principal lets the regional bridge enter existing
product services without a user login session. Authorities recheck the person's
current relationship and permissions. It carries no extra product capability;
operator calls retain the existing non-session exclusion from human-use metrics.

Each write also carries the verified Access subject, audience and informational
email as a separate, required RPC argument supplied by the MCP Worker. It is
never part of a tool's caller-controlled arguments. The regional bridge writes
an `engineering.<action>.attempt` event to `AUDIT_DB.audit_events` before product
effects, then an `engineering.<action>.result` with the represented user,
destination, operation ID and receipt identifiers. Transcript authors stay the
selected product user, as on the existing impersonation path. No prompts,
message bodies or transcript content enter these audit rows.

An unavailable attempt audit prevents the write. A failed cross-authority call
records `failed_or_uncertain` with its diagnostic code; it does not claim no
effect committed. An admitted result means admission, not completed agent
execution. If a result audit cannot be written, the durable attempt still
correlates recovery using the original operation ID.

### Messages and text reads

`send_message` takes `orgId`, `userId`, `conversationId` (a Canvas ID for its
Chat, or a Sidekick ID for its shared conversation), `text`, and a UUID
`operationId`. The other
composer fields reuse CreateMessageRequestSchema: mentions, confirmed participant
additions, attachments, annotations and queue/steer mode. After resolving the
Organization, the adapter uses ConversationService.writableClient and
WorkstreamObjectClient.createMessage, the same boundary as the app's send route;
the parent resolves which kind the id names. There are no transcript inserts,
forced run starts, or scripted replies. Normal
addressing decides whether Rally responds, unless the caller passes
`recordOnly: true`: the message is then admitted the same way but starts no run,
so the conversation holds it as a record for its readers. Reuse the message
operation ID and original arguments after an uncertain result; the ordinary
receipt reports `pending` or `canonical`, not completion of the agent run.

`read_canvas_chat` (by `canvasId`) and `read_sidekick_conversation` (by
`sidekickId`) return plain MCP text, without a JSON envelope, headed
`Canvas:` or `Sidekick:` and the title. Each names the kind it expects, and
the region refuses an id whose parent is the other kind
(`conversation_kind_mismatch`), so an operator never reads a Sidekick's
conversation believing it is a Canvas's.

Conversation reads authorize the selected user through
ConversationService.authorizeViewer, as the app's open does. A generic `read_transcript` product operation exposes
the existing transcript range reader used by socket hydration. It does not boot
the feed or acknowledge read state. The owning Durable Object formats committed participant
prose with frozen author bylines and attachment names, including elicitation
questions, selected option labels and annotation comments, while omitting tool payloads, thinking, internal mailbox messages,
private personal-instruction prefixes and suggested prompts. Live pending-input
and activity overlays are outside this committed-history read. Only that text
and paging metadata cross the RPC boundary, not raw tool blocks or activities.

Omit `limit` for a 20-turn page, set by the team on 2026-10-21 to match the
desktop hydration size. A caller may choose another `limit`. The footer
supplies `afterSequence` and `throughSequence` to continue under the same append
fence. A later call without the fence includes
newer turns.

### Pausing a Sidekick

`pause_sidekick` and `resume_sidekick` call the same AutomationService `pause`
and `resume` as the app's buttons, as the selected user, so HostedSidekick
decides who may manage the Sidekick and refuses with its own codes. Both are
idempotent, so they take no `operationId`; the bridge mints one per call only
to pair the attempt and result audit rows.

### Retiring an Organization

`retire_org` calls `retireWorkspaceForOperator`, the same function behind Ace's
Retire button, through a bridge method, `retireOrg`. So the region check,
`workspaces.abandoned_at`, the tombstones, the resumable walk and the demo
register's `retired_at` are all
[`workspace-retirement.md`](workspace-retirement.md)'s, unchanged. The Access
subject goes into the pass as its operator id, so the region's
`workspace_retirement_pass` log names who closed it, and the audit pair targets
the Organization rather than a represented user, since no user acts.

It takes no typed confirmation. In Ace that is a page ceremony for a person;
here the caller is a client that would fill both fields from the same value,
and the tool's destructive annotation is what asks the client to check first.
A receipt with `complete: false` means parts are still open; calling again
resumes the walk.
### Retiring Threads

`dump_thread_transcripts` and `retire_threads` are the two operator operations
that retire an Organization's Threads, Breakouts and Channels after the cutover
to Canvases and Sidekicks, run in that order. The dump writes each of their
conversations to R2 as text and reports `conversations`, `dumped`, `skipped`
(already in R2) and `failed`, a stable code per conversation. The retirement
is refused (`engineering_operation_failed:thread_retirement_dump_incomplete`)
until every conversation has its dump, then retires the conversation objects
and deletes their rows, and reports `parents`, `conversations`,
`retiredParents`, `retiredConversations`, `retainedOutbox` and `failed`; a
rerun over a finished Organization reports zeros. It is annotated destructive.
Both take `orgId` and `confirm`, which must equal `orgId`: the MCP refuses `thread_retirement_unconfirmed` before asking any
region, and the regional bridge checks it again, then refuses
`workspace_not_found` for an Organization the region does not hold. Being
Organization-wide, they represent no user: its audit rows target the
Organization (`target_type = 'workspace'`). The walk, its receipts and its
failure codes are
[`workspace-retirement.md`](workspace-retirement.md#retiring-threads-breakouts-and-channels)'s.

`convert_threads_to_canvases` runs between the two: every Thread that made or
linked an artifact becomes a Canvas with the same id, its Main the Canvas's
Chat, and its Breakouts are retired. It takes `orgId`, `dryRun` (default
`true`: list the candidates, each with its artifact, linked-artifact,
participant, conversation and undumped counts, and change nothing) and
`confirm`, which must equal `orgId` when `dryRun` is `false`. An apply is
refused with `thread_retirement_dump_incomplete` as the retirement is, and
reports `converted`, `alreadyConverted` (finished from an interrupted pass),
`failed` with a code per Thread, and `artifactsWithoutThread`. It is annotated
destructive and writes its audit rows on the same path; a dry run writes none.
[`workspace-retirement.md`](workspace-retirement.md#converting-threads-that-have-artifacts)
owns the mechanism. The order for an Organization is dump, convert, retire.

**Who may call them.** These three tools sit behind the `confirm === orgId` gate
and nothing else, with the same standing as `run_workspace_sql`: this server
has no roles, and every principal its Access application admits is an
operator who could already delete the same rows by hand. The confirmation is a
consistency check on the request, not an authorization. So an agent-driven
caller — a scheduled agent, a bot, or any MCP client acting without an operator
reading each call — must not be given this server with these tools enabled; the
decision was the reviewing engineer's on 2026-11-07, and a role split is the
change to make if that ever has to differ.

### D1

`run_d1_sql` runs SQL against five of the six D1 databases the regional API
Worker binds: `DB`, `TELEMETRY_DB`, `USAGE_DB`, `PLATFORM_DB` and
`MESSAGE_ISSUES_DB` (Oopsie message issue reports). `AUDIT_DB`
is left out: it records privileged actions such as impersonation and support
access, D1 offers no read-only binding, and this Worker's log does not record
the SQL it ran, so a write there would erase the record without leaving one.
The caller names the region and the binding, and the bridge's `runD1Sql` runs
the statement through that binding. `PLATFORM_DB` is one database every region
binds, so any region reaches the same rows.

`MESSAGE_ISSUES_DB` holds Oopsie reports in the submitting Organization's region
(only `global` today); the report columns and provenance are documented in
[message issues](message-issues.md#data-model).

The result has the Durable Object tools' shape, with two differences D1
forces. D1 returns rows as objects, so `columns` comes from the first row and is
empty when no row returns; `raw({ columnNames: true })` would name them but
drops `rows_read` and `rows_written`. For the same reason a later column
overwrites an earlier one of the same name, so a JOIN aliases its duplicates. Given several statements, D1 runs them all
only when the last alone has parameters, and answers with the last one's rows
and counters, so `rowsWritten` misses an earlier statement's writes. D1 returns
a BLOB as an array of bytes, which the bridge turns into `{ type: "blob",
base64 }`, and refuses `BEGIN` and `SAVEPOINT`.

### Feature and model flags

The four flag tools call Ace's `FlagAdministration` entrypoint over the
`FLAG_ADMINISTRATION` Service Binding. They hold no Flagship credential and
write nothing themselves:

| Tool | Ace method | Effect |
| --- | --- | --- |
| `list_feature_flags` | `listProductFlags` | Each managed product flag's catalog entry and live Flagship definition, `null` if not provisioned |
| `update_feature_flag` | `updateProductFlag` | Replaces the flag's whole definition, then queues the key-only client notification |
| `list_model_flags` | `listModelFlags` | Each agent role's catalog entry, checked-in default route, and live Flagship definition |
| `update_model_flag` | `updateModelRouting` | Checks every model id against OpenRouter, then replaces the default variation's route plan, keeping rules and other variations |

These are the same catalogs, schemas and write functions the Ace pages use, so
an MCP write is validated, fanned out to connected clients, and limited to the
managed keys exactly as an Ace save is. See [`ace.md`](ace.md) for what each
write does in Flagship and [`feature-flags.md`](feature-flags.md) for what
each flag controls.

`update_feature_flag` is a whole replacement because Flagship's API is: rules
left out of the call are deleted. The tool description tells the client to read
the flag first and send it back with its change.

### Lakehouses

`query_data_lake` sends one statement to Cloudflare's Basin SQL HTTP API
(formerly R2 SQL) for one of the three Global lakehouses: the
[inference](inference-lakehouse.md), [analytics events](analytics-lakehouse.md)
and [usage](usage-metering.md) tables. Their bucket, namespace and table names
come from `config/*-lakehouse.json`.

Each bucket is its own catalog, so the tool takes the table and picks the
bucket; a query cannot join across lakehouses. Basin SQL is read-only on
Cloudflare's side, so the tool passes the statement through and is annotated
read-only. It returns Cloudflare's `result` unchanged: `schema`, `rows`, and
`metrics` with bytes and files scanned. A refusal is returned to the engineer
with Cloudflare's codes and messages and logged as
`lakehouse_query_failed:<code>`, where the code is Basin SQL's own (for
example `40004`) or `http_<status>` when the response carried none.

The tool does not reach the exact per-event archive in `avalon-global-payloads`.
An `llm_inference` row too large for Pipeline carries only
`payload_object_key`; the [runbook](runbook.md#retrieve-the-exact-archived-record)
still owns reading that object.

The shared Durable Object base waits for the object's checked-in migrations,
runs the supplied statement through `ctx.storage.sql.exec`, and returns column
names, JSON-safe rows, and the platform's physical `rowsRead` and `rowsWritten`
counters. SQLite BLOB results are represented as `{ type: "blob", base64 }`.

### Worker logs and traces

`query_worker_observability` sends one query to Cloudflare's Workers
Observability API (`/workers/observability/telemetry/query`), the store behind
the dashboard's Query Builder. It reaches every Worker on the account, so a
query narrows to one with a `$metadata.service` filter. The `view` picks the
shape: `events` (one row per log line or span), `traces` (one row per trace),
`invocations` (events grouped by request) or `calculations` (aggregates with
group-bys). One trace's spans and logs are the `events` view filtered on
`$metadata.traceId`.

The tool takes Cloudflare's own filter, calculation and group-by vocabulary
with one level of filter grouping, which is what every saved view in
[`runbook.md`](runbook.md#log-shape) uses. It sends
`dry: true` so runs stay out of the account's query history, and returns
Cloudflare's `result` unchanged. A refusal is returned with Cloudflare's codes
and messages and logged as `observability_query_failed:<code>`. The audit row
names the view only; filter values and the needle can quote product data.

## Invariants and contracts

- D1 locates authority; it never substitutes for Durable Object product state.
- The bridge accepts workspace identity only in the current
  `durable_object_open` generation with a compatible serving contract.
  The regional `workspaces` row is the deterministic WorkspaceDO route;
  migration 0115 removed the completed per-workspace cutover ledger so it
  cannot be mistaken for live authority. Work-stream targets still require
  their active current-generation route. A closed or incompatible regional
  authority and pending, importing, verified, quarantined, or stale work-stream
  routes cannot obtain a Durable Object stub.
- SQL resolves configured deployments without mutation, refuses a duplicate target, and
  executes against exactly one selected binding. The selected bridge rechecks
  the generation so a cutover between resolution and execution fails closed.
- Main substream `0` needs no directory row: route activation happens only after
  creation or import initializes that object. Child substreams still require a
  directory membership row before their stub is obtained, and so does every
  artifact.
- **An inspection tool never materializes an object that does not exist, with one stated
  exception.** An artifact's registry row is written *before*
  `pointArtifactAtVersion` initializes its supervisor, so between those two
  calls — and permanently if the second never returns — `run_artifact_sql`
  against that artifact creates an empty supervisor. Closing it needs a
  readiness fact written after the supervisor exists, which is a WorkspaceDO
  migration and a product write; until then the empty supervisor an operator
  finds, with schema and no `artifact_state` row, is itself the diagnosis of the
  half-finished publish.
- The origin verifies Access JWT provenance. A header's presence alone is not
  authentication.
- The Access application is separate from Ace and has its own audience, while
  its policy and allowed identity providers are copied from Ace at deployment.
- SQL tools are annotated non-read-only, destructive, and non-idempotent. The
  list tools are read-only.
- The SQL text, bindings, returned rows, and error message never enter Worker
  logs. Audit events contain Access subject/email, tool name, target IDs, and a
  fixed outcome code only.
- The private regional entrypoint has no HTTP route. Only a Worker with the
  named Service Binding can call it.
- **A per-object-kind id on the SQL result is optional and omitted, never a
  required nullable field.** The MCP parses every regional response through a
  strict schema and deploys *after* the regional Workers, so a key the previous
  build did not know is an unknown key mid-rollout and strict parsing rejects
  it. Adding the next object kind's id as a required field breaks every existing
  SQL tool for the length of the deployment window.

- Flag tools reach Flagship only through Ace. A direct Flagship write from this
  Worker would skip the client notification and the managed-key allowlist, and
  would put a second Flagship token on a second Worker.
- Ace records `actor_subject` and `via: "engineering_mcp"` on every flag write
  it makes for this Worker, beside this Worker's own audit event.
- The lakehouse token reaches only Basin SQL, from inside this Worker. It never
  crosses to a client, and its permissions are scoped to the three lakehouse
  buckets, not the account.
- The Workers Observability token is likewise used only from inside this Worker
  and holds only Workers Observability permission.

## Boundaries and non-goals

This is an unrestricted engineering console, not a domain RPC. It intentionally
permits schema reads, arbitrary queries, and mutations because production
inspection and repair are the product requirement. Product code must continue
to use typed domain RPCs and must never depend on this surface.

A Sidekick has two inspectable halves and they are reached by different tools.
Its definition revisions, schedules and run history are the Organization's
`sidekick_*` tables, read with `run_workspace_sql` filtered by `sidekick_id`.
Its *conversations* are AgentLoopDO objects, reached with `run_canvas_sql`
under the Sidekick's ID: its shared conversation with no `substreamId`
(substream `0`), or a run's conversation with that run's registered
`substreamId`.

A Canvas's parent state lives in WorkspaceDO, in `canvas_directory` and the
`parent_*` tables keyed by `parent_id`
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)), so
`run_workspace_sql` is the tool for it; its Chat is reached with
`run_canvas_sql` under the Canvas's ID.

`list_canvases` lists every Canvas in the Organization, private ones
included: listing is operator inspection, like `run_workspace_sql`. Reading a
Chat is still the selected user's, through ordinary admission.

`run_canvas_sql` checks the parent's route, not its kind: until
`retire_threads` has run for an Organization, a Thread's id still resolves
there, and nothing else in this MCP names one.

A stateful artifact's facet database is outside this MCP for the reason above:
its contents are reachable only through the product's admitted read path.

`MigrationProbeDO` holds no product state by design.

The Worker does not retain query history, cache results, copy databases, or
provide a D1 fallback. Creation explicitly names the Rally identity to act as;
Access identity is never silently mapped to a product user.

## Failure modes and limits

- A missing or invalid Access assertion returns a refusal from the origin; an
  unauthenticated MCP client receives Cloudflare Access's OAuth challenge before
  reaching it.
- A missing D1 workspace identity or child route returns not found without
  creating an object.
- A SQLite error is returned to the authenticated caller and logged only as the
  fixed `tool_failed` code.
- A regional Service Binding failure fails the tool. There is no one-region
  fallback because the absent response could hide an ambiguous identity.
- There is no repository-defined query, row, statement, or execution limit.
  Cloudflare's current Worker RPC and response limits are the effective ceiling;
  adding a defensive limit requires a separately chosen product value. The same
  holds for `query_worker_observability`: Cloudflare caps a page at 2,000 rows
  and keeps seven days, and this Worker adds no window or row limit of its own.
- `query_worker_observability` fails as `observability_token_unconfigured`
  until its secret is installed.

## Testing

`apps/api/test-workers/engineering-creation.test.ts` drives the regional bridge
against real D1 and Durable Objects: Organization creation with its initial
membership and seating and stable-ID retries, unknown users and a mismatched
region refused, and the rejected field kept across the RPC boundary; then, in a
Canvas's Chat, member and guest sends with normal execution, retry dedupe and
author snapshots, a send and a read refused to somebody the Canvas does not
admit, a record-only message that starts no run, and default and fenced history
paging, and a Canvas read as a Sidekick's conversation refused by name.
`engineering-sidekick-inspection.test.ts` posts a record-only message to a
Sidekick's shared conversation and reads it back, refuses it read as a Canvas,
and reaches a run conversation through `run_canvas_sql`'s registry check.
Audit coverage reads operator and receipt attribution from the real audit
database and refuses product writes when the attempt cannot be persisted.
Only the external model provider is doubled. The text formatter's unit tests
cover bylines, display text, attachments, elicitation, annotations and hidden
internal content; the desktop transcript suite covers the extracted display helper.
The MCP transport suite checks annotations, regional routing, ambiguous-target
refusal, plain-text results, trusted operator forwarding and content-free logging.

`apps/api/test-workers/engineering-inspection.test.ts` calls the inherited RPC
on real WorkspaceDO and AgentLoopDO instances under workerd.
It proves bound writes, reads, SQLite metadata, and BLOB serialization.

`apps/api/test-workers/engineering-d1-inspection.test.ts` proves binding-selected
D1 writes and reads, including `MESSAGE_ISSUES_DB`, and that `AUDIT_DB` is refused
before execution.

`apps/api/test-workers/engineering-workspace-inspection.test.ts` proves that a
workspace is inventoried as active, resolves at the open generation, and
and executes against its initialized WorkspaceDO from regional identity alone.

`apps/api/test-workers/engineering-org-retirement.test.ts` retires an
Organization through the bridge and reads back the D1 fence, the tombstone, the
demo register stamp and the audit pair; an id the region does not hold is
refused as `workspace_not_found` and audited as failed.

`apps/api/test-workers/engineering-sidekick-inspection.test.ts` lists a
Sidekick created through the real path and reaches its run conversation only
through the Sidekick's own registry.

The same file pauses and resumes a published hourly Sidekick through the
bridge as its author, reading its lifecycle and schedule alarm from the real
WorkspaceDO and its audit rows from `AUDIT_DB`, and proves a member who cannot
manage it is refused with `sidekick_forbidden` and leaves it running.

`apps/api/test-workers/engineering-artifact-inspection.test.ts` does the same
for an artifact published through `registerArtifact` and `recordPublish`, and
additionally proves the facet boundary: after a real request through the facet
writes the model's own table, the supervisor's inspection SQL still sees only
the supervisor's. Both files seed their D1 route from
`test-workers/helpers/engineering-inspection-fixture.ts`.

`apps/engineering-mcp/test/server.test.ts` exercises the production Agents SDK
MCP handler, tool discovery, cross-region aggregation, destructive annotations,
single-region SQL execution, and proof that a duplicate-region resolution makes
no SQL call. `apps/api/test/engineering-inspection-routes.test.ts` exercises the
checked-in regional D1 schema and proves that lifecycle, serving-contract, and
generation fences admit only the current active authority. Existing Access tests own JWT
signature, issuer, audience, cookie, and header verification because this
Worker imports that one verifier rather than forking it.

`apps/api/test-workers/engineering-d1-inspection.test.ts` writes and reads a
D1 database through `runD1Sql`, BLOBs included, and proves the call reached
the named binding and not another.

`apps/ace/test/flag-administration.test.ts` drives the entrypoint against
Flagship and OpenRouter doubles, the two APIs that cannot run here.

The deployment workflow dry-runs the MCP bundle during verification and, after
deployment, requires a non-browser `401` carrying an OAuth protected-resource
challenge.

## Regional impact

Both regional API Workers execute SQL locally against their own D1 routes and
Durable Objects. The shared Worker never receives a database handle or a copy of
the SQLite file, only the requested result.

## Security and trust model

Cloudflare Access is the identity and policy authority. Managed OAuth supplies
standards-based authorization and Dynamic Client Registration for remote MCP
clients; the deployment enables loopback redirect registration for installed
clients. Access reuses the same configured identity provider and admission
policy as Ace, but the distinct application/audience prevents an Ace token from
being replayed at the MCP origin.

The SQL capability is production-destructive by design. Access membership is
therefore equivalent to database-console access across both Rally regions.
It also grants read access to every lakehouse row, including the raw prompts,
connector data and model output in `llm_inference`, which the
[runbook's handling rules](runbook.md#inspecting-a-runs-raw-inference) cover.
Access membership also grants every Worker's logs and traces, and retiring
any Organization for good. Cloudflare
records the full request URL on invocation logs and spans, which carries a
connector OAuth callback's one-time `code` and a WebSocket `ticket`, and the
platform's Durable Object SQL spans carry their bindings, which for Avalon
means message text ([`runbook.md`](runbook.md#log-shape)).

Policy changes, identity-provider changes, and client approval belong in the
Cloudflare Access application, not in application code.

`BASIN_SQL_API_TOKEN` is a runtime credential, like Ace's Flagship token, not
the deployment token. Basin SQL requires R2 storage read/write on the buckets it
reads, so create it as an R2 API token restricted to the three lakehouse
buckets with Basin SQL Read, Basin Catalog Read, and R2 Storage Write. Never
widen it to the account or reuse `CLOUDFLARE_API_TOKEN`.

`WORKERS_OBSERVABILITY_API_TOKEN` is a runtime credential too: an account API
token with only Workers Observability Write, which Cloudflare requires to run a
query even though the tool only reads. Never reuse `CLOUDFLARE_API_TOKEN` for
it.

## Operations

Operator connection instructions for Codex, Claude Code, and Cursor Desktop,
including the first safe schema query and OAuth troubleshooting, live in
[`internal-admin-mcp-server.md`](internal-admin-mcp-server.md).

The provisioner requires `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`. It requires the existing Ace Access application as the
policy, identity-provider, and session-duration source; missing source state is
a deployment failure, not permission to create a broader policy. Generated
configuration contains the Access audience, is owner-readable, and is removed
after Wrangler exits. Redeployment preserves an existing Managed OAuth grant
configuration and administrator-added HTTPS redirect allowlist entries. It also
ensures the supported Claude, ChatGPT, and Cursor hosted origins remain present.
Changing that managed provider list remains an explicit Access administration
decision.

The provisioner also injects the account ID as a Worker variable and, when the
`ENGINEERING_MCP_BASIN_SQL_API_TOKEN` and
`ENGINEERING_MCP_WORKERS_OBSERVABILITY_API_TOKEN` GitHub secrets are set in the
`api-production` environment, installs them as `BASIN_SQL_API_TOKEN` and
`WORKERS_OBSERVABILITY_API_TOKEN`. Without a secret the deploy keeps whatever
token the Worker already has, and its tool fails as
`lakehouse_token_unconfigured` or `observability_token_unconfigured` if it has
none: the MCP deploys inside the API release, and a missing read credential
should not turn that release red.

Model routes support optional `routing.reasoningEffort` (`low`, `medium`, or
`high`) through `list_model_flags` and `update_model_flag`. Omission restores
each selected model's configured default; an explicit value applies to the
primary and fallbacks. Ace owns validation and the atomic write.

## Changelog

### 2026-11-09 — Retire an Organization

**What changed:** `retire_org` retires an Organization through a new bridge
method, `retireOrg`, which calls Ace's operator door,
`retireWorkspaceForOperator`. The audit helper's represented user is now
optional; a write without one targets the Organization.

**Why:** An engineer had to retire the live demos and the demo template, and
only Ace's workspaces tab could. The console offered SQL, and retiring by hand
is not a row update: the walk closes every object child-first, tombstones each,
and stamps the demo register, so a hand-written `abandoned_at` would leave every
room, Sidekick and socket still running.

**Considered and rejected:** Calling Ace over a Service Binding, as the flag
tools do. Those go through Ace because Ace holds the Flagship token and fans
out the client notice; retirement has no such step in Ace, and the door already
runs in the regional Worker the bridge lives in. Asking for the id twice, as
Ace does, for the reason in [Retiring an Organization](#retiring-an-organization).

**Consequences:** Access membership now also grants permanent closure of any
Organization. A change to the retirement door changes this tool with it.

### 2026-11-08 — `convert_threads_to_canvases`

**What changed:** A third operator operation beside the Thread dump and
retirement, with the same principal, `confirm` gate and audit path, plus a
dry run by default.

**Why:** The user decided on 2026-11-08 that Threads with artifacts become
Canvases in place rather than being deleted. A dry run is the default because
the operator needs the candidate list, and each one's dump state, before
committing an Organization.

**What a future change must respect:** run it after the dump and before
`retire_threads`; the retirement deletes every Thread it finds.

### 2026-11-07 — Canvas and Sidekick conversation tools replace the Thread ones

**What changed:** `list_spaces`, `read_thread`, `read_breakout`,
`list_workstreams`, `list_substreams` and `run_substream_sql` are removed with
their bridge methods (`listSpaces`, `listWorkstreams`, `listSubstreams`,
`resolveSubstream`, `runSubstreamSql`) and contract shapes. `list_canvases`
reads `canvas_directory`; `read_canvas_chat` and `read_sidekick_conversation`
read a conversation as a user and refuse the other kind by name;
`run_canvas_sql` runs inspection SQL on the conversation object named by a
Canvas or Sidekick ID, or a registered child of it. `send_message` takes a
`conversationId` instead of `threadId` and `breakoutId`. The server
instructions' naming map says Organization = workspace, Canvas = its
conversation (a `workstream` id in storage), Sidekick = automation.

**Why:** the Canvases and Sidekicks pivot
(`docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`) retired Spaces, Threads
and Breakouts; the tools that named them could only fail or mislead. The read
names its kind rather than taking any conversation id because the two parents
answer different questions, and an operator's diagnosis rests on which one
they read. `run_canvas_sql` keeps the child reach `run_substream_sql` had
(2026-09-28), since a Sidekick run's conversation is where its failures are.
A future tool must not take a Thread or Space id: the product refuses those
parents by name (`conversation_parent_kind_retired:<kind>`).

### 2026-11-07 — The Channel and Thread creation, list and feed tools go

**What changed:** `create_channel`, `create_thread`, `read_channel`,
`list_channels`, `list_threads` and `list_breakouts` are removed with their
regional bridge methods (`createChannel`, `createThread`, `readChannel`,
`listUserChannels`, `listUserConversations`) and contract shapes.
`send_message`, `read_thread` and `read_breakout` stay until the Canvas and
Sidekick conversation tools replace them.

**Why:** Channels and Threads are retired by the Canvases and Sidekicks pivot
(`docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`); the services these
tools called (`SpaceService`, `WorkstreamObjectCreationService`) are deleted in
plan step C-2, so the tools could only fail.

### 2026-11-07 — Dump an Organization's Thread transcripts, then retire its Threads

**What changed:** `dump_thread_transcripts` and `retire_threads`, and the
bridge's `dumpThreadTranscripts` and `retireThreads`, behind a typed `confirm`
that must equal `orgId`.
`auditedEngineeringWrite` takes an action with no represented user and then
targets the Organization.

**Why:** Plan steps B-7a and B-7: the PRD deletes every Thread, Breakout and
Channel at cutover and dumps their transcripts to R2 first. It is an operator operation
per Organization, and this MCP is the Access-gated operator surface that already
reaches every region's objects; Ace's retirement route is the `demos` role's.

**Consequences:** The first Organization-wide write here. Its confirmation is a
consistency check on the request, not a second approval, as Ace's is.

### 2026-11-06 — Pause and resume a Sidekick

**What changed:** `pause_sidekick` and `resume_sidekick` call the app's own
AutomationService pause and resume as a selected user, through a new bridge
method, `setSidekickPaused`. The bridge's error mapping now uses `asApiError`,
so an ApiError thrown inside a Durable Object keeps its code across the RPC hop.

**Why:** An engineer had to pause Sidekicks that were spending heavily, for
people who were not at hand, and the console offered only SQL. A pause is more
than `lifecycle = 'paused'`: it stops runs, cancels alarms, bumps the stop
generation and clears registrations in other objects, so a hand-written update
would show a paused Sidekick whose work kept going. Adding the tool also
showed that `productOperation` tested `instanceof ApiError`, which is false
for any error raised in an object, so a Sidekick's `sidekick_forbidden`
reached the operator as bare message text and the log as `tool_failed`; the
other write tools had the same gap for their objects' refusals.

**Considered and rejected:** Copying `pauseByPerson` into SQL, for the reason
above; a tool that acts as the operator rather than a selected user, which
would need an operator-only manager exception in HostedSidekick.

**Consequences:** Resume exists so a pause made here can be undone here.
Errors from any product write, and their audit rows, now carry the object's
code: `diagnosticErrorCode` also rebuilds an ApiError that crossed an RPC.

### 2026-11-04 — Post a message that starts no run

**What changed:** `send_message` and the bridge's `sendMessage` accept an
optional `recordOnly: true`. The Thread's storage object treats it as it treats
a Breakout merge: the message is admitted, written and delivered to readers, and
no run starts.

**Why:** Relay, an internal experiment outside this repository, records
decisions from a person's Claude Code sessions as messages in a Rally Thread and
asks Rally's agent to reconcile them only when more than one session is
involved. Every such Thread has one participant, and in a one-person Thread
admission starts a run on every message without asking the addressing
classifier, so each recorded decision would have cost a run and a reply.

**Considered and rejected:** Reusing the `merge` tag, which also renders a
merged-result card and needs a Breakout source; adding a second participant so
the addressing classifier would usually decline, which depends on a model's
guess per message.

**Consequences:** The flag reaches the object only through the bridge's RPC;
the app's message route schema has no such field.

### 2026-10-23 — Inspect Oopsie reports through the D1 console

Added `MESSAGE_ISSUES_DB` to the shared D1 allowlist and tool description because
Oopsie reports have their own regional store but the console still admitted
only the earlier databases. Reuse the existing binding-selected SQL path rather
than adding a separate report tool or copying feedback into another database.
Deploy the regional API bridge before the MCP Worker so both accept the new
binding; the audit database remains excluded.

### 2026-10-22 — Advertise purpose and operator guidance in initialization

The Engineering MCP supplied individual tool descriptions but no server-level
purpose or instructions. Clients could therefore connect successfully and still
lack the context for selecting it or mapping Channels, Threads and Breakouts to
storage IDs. Initialization now describes its investigation and administration
capabilities and supplies concise operator guidance. Preserve normal app access
checks and idempotent operation IDs; metadata describes usage and grants no
additional authority.

### 2026-10-21 — Exercise product workflows as a named user

**What changed:** Operator tools create Organizations, Channels and Threads,
send messages, read Channel/Thread/Breakout text, and list the selected user's
visible Channels, Threads and Breakouts. They adapt shared onboarding,
SpaceService, WorkstreamObjectCreationService, ConversationService and ordinary
message admission. Onboarding accepts initial members in its existing atomic
creation batch; a generic product read exposes the existing transcript range
reader. User-visible lists reuse the socket directory and the existing paged
conversation query, with server-selected kind and attention filters applied
before pagination. The selected member or guest keeps their normal permissions.
Writes persist the Access operator and represented user in the independent
audit database, and text reads format at their authority with a team-selected
20-turn default page. Elicitation answers reuse the desktop label formatter.

**Why:** Engineers need realistic product behavior through MCP, including
identity, visibility, retries, placement, notifications and agent execution.
Copied state writes or operator-only permission exceptions would produce objects
and messages that behave differently from the app.

**Considered and rejected:** Direct product-table writes, synthetic transcript
insertion, extra guest permissions, and minting user login credentials. Reuse the
existing entryways and extend their inputs where a second caller needs them.

**Consequences:** Writes can execute connected tools as the selected user. Retry
with the same operation ID and original arguments. Reads return committed prose;
Channel pagination and explicit conversation sequence fences remain visible.
Product-use metrics continue excluding non-session operator actions.
Audit attempts precede product effects; their operation IDs correlate uncertain
outcomes. Text-only RPC responses avoid shipping hidden payloads across hops.

### 2026-10-19 — Read and write D1

**What changed:** `run_d1_sql` runs SQL against a named region's `DB`,
`TELEMETRY_DB`, `USAGE_DB` or `PLATFORM_DB` through a new bridge method,
`runD1Sql`, and returns the Durable Object tools' result shape.

**Why:** The console reached every Durable Object database but not D1, so
reading or repairing a user, membership or route row meant `wrangler d1
execute` with a deployment token, or the Cloudflare dashboard.

**Considered and rejected:** Cloudflare's D1 HTTP API from this Worker, which
needs an account token able to write every D1 database in the account; the
regional Worker already holds these bindings. Reaching `AUDIT_DB` too, which
would let any Access member erase the impersonation and support-access record
untraced; a read-only check on D1's `rows_written` runs only after the write.
One tool per
database, which repeats one call for what is one argument. Resolving the
region from an ID, as the object tools do: a D1 row has no single owning ID,
so the caller names the region.

**Consequences:** Access membership now includes writing every regional D1
database but the audit trail, the usage ledger and the shared platform routing
table included. A new D1 binding on the API Worker is reachable once it is
added to `ENGINEERING_D1_DATABASES`; reading `AUDIT_DB` here needs a read-only
path D1 does not provide today.

### 2026-10-19 — Query Workers Logs and Traces

**What changed:** `query_worker_observability` runs Workers Observability
queries (logs, traces, invocations, calculations) for every Worker on the
account, with a token that holds only Workers Observability permission. The
Cloudflare response handling `query_data_lake` had is now shared by both tools.

**Why:** Reading logs or a trace meant a Cloudflare dashboard login with account
access, or a hand-built API call with a personal token. Engineers already reach
production state and the lakehouses through this MCP.

**Considered and rejected:** Cloudflare's hosted observability MCP server, which
needs each engineer to hold a dashboard login with account access. Reading the
Global Worker's OTLP copy in PostHog, which covers only that one Worker. Separate
log and trace tools, which would repeat one API call for what is one `view`
choice. A recursive filter schema matching Cloudflare's four levels of nesting,
which some MCP clients receive as an unresolved `$ref`; one level is what every
saved view needs.

**Consequences:** Access membership now includes request URLs carrying one-time
OAuth codes and socket tickets, and span bindings carrying message text. The
token needs Workers Observability Write because Cloudflare requires it to run a
query. There is no repository-defined window or row limit.

### 2026-10-18 — List and search users with their Organizations

**What changed:** `list_users` and `search_users` call a new bridge method,
`searchUsers`, that returns each user with their memberships in one
JSON-aggregating D1 query per region. Ordering and page-number paging moved
out of the Organization tools into a shared `src/paging.ts`, which both pairs
use.

**Why:** Finding a person and the Organizations they belong to meant a
`run_workspace_sql` per Organization or a direct D1 query.

**Considered and rejected:** A second copy of the Organization ordering and
paging code for users. Separate calls per user for memberships, which would
cost one query per row.

**Consequences:** A new listing tool supplies only its sort keys to
`orderAndPage`. Users carry email addresses, which every Access member could
already read through the SQL tools.

### 2026-10-18 — List and search Organizations

**What changed:** `list_orgs` and `search_orgs` call a new bridge method,
`searchOrganizations`, that filters `workspaces` in each region's D1 and adds
member count and last-seen time. The MCP orders the merged set and pages it
by number.

**Why:** `list_workspaces` returns every Organization sorted by name with no
filter, plan, age or activity, so finding one meant reading the whole list.

**Considered and rejected:** Adding fields and filters to `listWorkspaces`.
The MCP parses each regional answer strictly and deploys after the regional
Workers, so a new key breaks the live MCP's `list_workspaces` for the length of
the rollout. A new method is one the old MCP never calls. An opaque paging cursor was
rejected because models garble long random tokens when they copy them back,
and the product's four-word page IDs need storage this stateless Worker does
not have. The 200-row default page, about 12-16k tokens, is sized for a large
context window so most searches fit on one page.

**Consequences:** `list_workspaces` remains for existing clients and could be
retired. A new filter goes into the D1 query and the input schema together; a
new sort key goes into the MCP only. Page numbers trade stability across a
concurrent insert for a token a model copies reliably.

### 2026-10-18 — Query the Global lakehouses

**What changed:** `query_data_lake` runs read-only Basin SQL against
`llm_inference`, `analytics_events`, or `usage_events`, using a bucket-scoped
token installed as a Worker secret.

**Why:** Reading a lakehouse meant minting a personal token, keeping it in
`.env.local`, and hand-building curl requests from the runbook. Engineers
already reach production through this MCP, behind the same Access policy.

**Considered and rejected:** One tool per lakehouse, which would repeat the
same code three times for what is one table choice. Proxying through a regional
API Worker, which adds a hop and puts the token on a product Worker. Fetching
the `PAYLOADS` archive too: it needs an R2 binding to a bucket that holds far
more than inference records, and nobody has asked yet.

**Consequences:** Access membership now includes reading raw inference
content. The token needs R2 Storage Write because Basin SQL requires it, so it
must stay restricted to the lakehouse buckets. The tool uses the `basin-sql`
path; Cloudflare says the `r2-sql` path the runbook names still works but will
be deprecated.

### 2026-10-06 — The Sidekick tools go with `SidekickDO`

**What changed:** `run_sidekick_sql` and `retry_sidekick_import` are removed,
with the bridge's `runSidekickSql`, `retrySidekickImport` and `resolveSidekick`
and their contract types. A Sidekick's run conversations are found only in the
Organization's `sidekick_children`.

**Why:** `SidekickDO` is deleted and every Sidekick's rows are in its
Organization object, so `run_workspace_sql` reaches all of them. The tools
existed only for the legacy object and its import.

**Consequences:** No tool opens a Sidekick by its own ID any more. A future
per-Sidekick tool reads the Organization object filtered by `sidekick_id`.

### 2026-10-05 — Retry a stuck Sidekick import

**What changed:** `retry_sidekick_import` calls a new bridge method and
`WorkspaceDO.retrySidekickImport`, fenced like `run_sidekick_sql`, and returns
the Sidekick's `sidekick_imports` state and last code. A Sidekick's run
conversations are found in the Organization's `sidekick_children` first.

**Why:** Sidekicks move from `SidekickDO` into `WorkspaceDO` the way Channels
did, and the legacy object freezes before the import commits, so a refused
export needs a repair and a re-run that SQL cannot express. The
2026-09-25 entry's reasoning for `retry_parent_import` applies unchanged.

**Consequences:** `run_sidekick_sql` now reads a frozen copy for an imported
Sidekick; `run_workspace_sql` is the live source. Both Sidekick tools are
deleted with the legacy class.

### 2026-10-02 — Read and change managed flags through Ace

**What changed:** `list_feature_flags`, `update_feature_flag`,
`list_model_flags` and `update_model_flag` call a new `FlagAdministration`
entrypoint on Ace over a Service Binding.

**Why:** Engineers working through an MCP client had no way to see or change a
flag without leaving for the Ace pages.

**Considered and rejected:** Giving this Worker its own Flagship token and
calling the API directly. That is a second write path that would skip the
client notification queue unless it rebuilt it, and a second Worker holding a
token that can change every flag. Calling Ace's HTTP routes was also rejected:
they sit behind a different Access audience and a same-origin check written for
a browser.

**Consequences:** Ace stays the one place that writes a
managed flag. A new flag kind is added to Ace's catalog and entrypoint first;
this Worker only forwards. The MCP deploys from the API workflow and Ace from
its own, so for the length of a rollout the flag tools can fail with a missing
entrypoint until Ace is live. A Flagship refusal crosses the RPC as its status
only; Flagship's own error text stays in Ace.

Shipped in #1070.

### 2026-09-28 — Reach a Sidekick's run conversations

**What changed:** `run_substream_sql` accepts a child substream of a Sidekick
when the Sidekick's own `conversation_children` registers it. Before, a child
was accepted only when the Organization's hosted-parent tables listed it, and a
Sidekick's children are never there.

**Why:** Phase 3 of the search-audience work needed every conversation woken so
its migration could re-project search rows. A Sidekick's run conversations
could not be woken through the tools, so their rows stayed invisible to search.

**Considered and rejected:** Reading every SidekickDO for every lookup. The
Organization's tables are still asked first, and a SidekickDO is opened only for
an ID the workspace directory already lists as a Sidekick, so no lookup can name
an object that does not exist.

**What a future change has to respect:** Keep the directory check before naming
a SidekickDO, for the reason the 2026-09-18 entry gives.

### 2026-09-26 — Remove the legacy parent tools

**What changed:** `retry_parent_import`, `run_workstream_sql` and
`run_space_sql` are gone, with the bridge's `retryParentImport`,
`runWorkstreamSql`, `runSpaceSql`, `resolveWorkstream` and `resolveSpace`, and
`list_substreams` no longer falls back to a legacy object's
`substream_directory`.

**Why:** `WorkstreamDO` and `SpaceDO` are deleted
([`hosted-conversation-parents.md`](hosted-conversation-parents.md#changelog)).
The three tools opened those objects or re-ran their import, and nothing is
left for either to reach. Channel and Space parent state is read with
`run_workspace_sql`.

**Consequences:** The MCP and the regional Workers deploy separately, so for
the length of a rollout an MCP of either build may call a bridge of the other.
An old MCP calling a removed bridge method fails that one tool call; no other
tool changes shape.

### 2026-09-25 — Retry a stuck Channel or Space import

**What changed:** `retry_parent_import` calls a new bridge method and
`WorkspaceDO.retryParentImport`, fenced like `run_workspace_sql`, and returns
the parent's `parent_imports` row.

**Why:** Moving Channel and Space parents into `WorkspaceDO` freezes the legacy
object before the import commits, so an import that fails deterministically (a
row SQLite refuses, a stored row the replay cannot parse) left the Channel
unavailable with no way to re-run it after a repair short of waiting for the
alarm's backoff or a user opening it.

**Considered and rejected:** An SQL convention (clear `not_before` and wait for
the alarm) was rejected: it waits up to the alarm's backoff and gives the
operator no answer. A general "call any RPC" tool was rejected as a product API
in disguise; this is one named repair.

**Consequences:** This console now holds one typed domain call beside the SQL
tools. The next such call needs the same justification: a repair SQL cannot
express.

### 2026-09-20 — Remove the completed workspace cutover ledger

**What changed:** Regional migration 0115 drops
`workspace_product_authority_routes`. Workspace inventory and resolution now
have one model: regional workspace identity plus the region-wide open generation
and serving-contract fence. The deployment classifies this as Worker-first, so
the compatible bridge is live before D1 removes the table it replaced.

**Why:** The table had no writer after the one-time WorkspaceDO cutover, yet its
route-shaped name and retained rows repeatedly led operators and agents to treat
it as current authority. That produced false reports that newer Organizations
had no WorkspaceDO authority.

**Considered and rejected:** Keeping the inert table with stronger comments was
rejected because the prior inspection bug showed that documentation did not
neutralize the misleading schema. Backfilling new rows was rejected because it
would revive a second routing system beside deterministic WorkspaceDO identity.

**Consequences:** Current schema inspection cannot discover or depend on the old
ledger. Immutable historical migrations and the migration-0090 baseline still
name it as evidence of the cutover they performed; all live code, local
bootstrap tooling, fixtures, and authority guards do not.

### 2026-09-20 — Resolve post-cutover workspaces from their regional identity

**Superseded later the same day:** the completed cutover ledger described below
was removed entirely by migration 0115; the entry above is the current model.

**What changed at that intermediate point:** Workspace inventory and resolution
began using the regional `workspaces` identity under the open compatible
authority generation. A retained `workspace_product_authority_routes` row was
temporarily treated as an additional active/current-generation fence; its
absence no longer made a workspace uninspectable. Migration 0115 later removed
that table and temporary fence entirely.

**Why:** That table was populated for the one-time WorkspaceDO cutover, and its
population trigger was removed when legacy product tables were retired. Every
workspace created afterward correctly went straight to its deterministic
WorkspaceDO, but the engineering MCP mislabeled it as having unknown authority
and refused every workspace-owned inspection tool.

**Considered and rejected:** Restoring writes to the cutover ledger was rejected
because it would turn historical migration evidence into a second live routing
system. Ignoring retained rows entirely was also rejected because a quarantined
or stale cutover row is still useful evidence that a historical workspace must
not be opened through the console.

**Consequences at that intermediate point:** Post-cutover Organizations became
visible and inspectable without backfilling synthetic migration rows. The
regional open-generation and serving-contract fences remained mandatory, while
historical workspace rows temporarily retained their stricter activation fence.

### 2026-09-19 — Route SpaceDO, fenced on the object's own identity row, and reach a Space's Main through the directory row

**What changed:** `list_spaces` and `run_space_sql` reach a Space's own object.
`run_space_sql` resolves the D1 workspace-authority anchor every other target
starts from, then requires the object's `workstream_metadata` row to name this
workspace and this Space id.

`list_spaces` reads `workspace_space_directory` and
`run_space_sql` fences on it, replacing the identity read the entry below
describes. Nothing else about the tools moved.

**Why:** A `SpaceDO` is unreachable from every existing tool — it is not a
WorkspaceDO, not a WorkstreamDO in `WORKSTREAM_DOS`, and not a conversation — so
an operator holding a Space id had nothing to open it with.

That entry named this as the change that would close its window, and
WorkspaceDO migration 61 is what made the row exist. Reading it from an object
that is already open means an unknown Space id is refused without naming
anything in `SPACE_DOS`, so a typo stops creating an object and a tracker row.

**Considered and rejected:** The Sidekick fence, which is the right one and is
not yet available: it reads the workspace-held directory row that proves the
object exists, and the Space directory projection does not exist. Also rejected:
waiting for that projection before adding the tools, which would have left the
release that creates Spaces also adding the only way to inspect one.

**Consequences:** The fence costs exactly what the Sidekick fence exists to
avoid — a miss has already named, and thereby created, an empty object. It
creates it in `SPACE_DOS`, where an empty object reaches no product path and is
confusable with nothing, unlike a work-stream id resolved in `AUTOMATION_DOS`;
the visible cost is a row in the migration tracker's `SpaceDO` count. A future
change replaces the identity read with the directory row and closes the window.
`list_spaces` answers an empty list, which is true rather than a placeholder
while no product path creates a Space.

A Space's hidden main conversation is now reachable through
the substream tools as well, under the Space id as the parent — not a change to
this MCP but a consequence of `SpaceService.create` writing the
`workstream_authority_routes` row those tools resolve through. It is the only
way to inspect a Space's participants and resources.

### 2026-09-18 — Route ArtifactHostDO, and stop at the facet

**What changed:** `list_artifacts` and `run_artifact_sql` open a live web
artifact's supervisor. `ArtifactHostDO` now extends
`InternallyInspectableDurableObject` directly — it is the first inspectable
object that is not a scheduled authority — and `EngineeringSqlLookup` carries an
optional `artifactId`.

**Why:** The supervisor holds the bounded log of what a model's server module
threw, which is what turns "the artifact page is broken" into a diagnosis, plus
the current version and the viewer sessions. None of it was reachable: the class
skipped the inspectable base, so the object had no inspection RPC at all.

**Considered and rejected:** Routing the facet as well, so the tools reached a
stateful artifact's own tables. The facet is a separate SQLite database behind
Rally's facet host module, whose only SQL surface is the read-only admitted
`rallyQuery` the product's Data view uses; arbitrary operator SQL there means
editing the module every stateful artifact runs and loading the artifact's own
code just to inspect it, which can fail for reasons that have nothing to do with
the inspection. The boundary is documented instead, and the tool description says
so, because an operator's natural assumption is the opposite.

**Consequences:** The two new ids on the SQL result are optional and omitted
rather than nullable, so the three pre-existing results stay byte-identical for
the window in which an upgraded regional Worker answers an MCP that has not
deployed yet. `viewer_sessions` is now operator-readable and writable. It
stores only digests, so nothing there reconstructs a live cookie, but an
admitted operator can mint artifact access by writing a row — inside this
console's stated destructive authority rather than beyond it, and worth knowing
it is there. A publish that has not yet written its `artifact_registry` row is
refused, matching the Sidekick fence.

### 2026-09-18 — Route SidekickDO, fenced on workspace directory membership

**What changed:** `list_sidekicks` and `run_sidekick_sql` open a Sidekick's own
object. Every inspectable class is now routed. A Sidekick resolves through its
workspace's active route plus an `automation_directory` row, and
`EngineeringSqlLookup` carries an optional `sidekickId` beside the work-stream
and substream IDs.

**Why:** SidekickDO inherited the inspection RPC when the shared base was added
but was left unrouted, so a Sidekick's definition revisions, schedules, and run
history were the one authoritative SQLite database an operator could not open —
the substream tools reach only its conversations.

**Considered and rejected:** Resolving a Sidekick from its own row in
`workstream_authority_routes`, the way `run_workstream_sql` resolves a work
stream, was rejected outright. That table is keyed by parent ID whatever the
parent's kind, and a Sidekick's conversation occupies it under the Sidekick's
own ID, so an active route proves a parent exists and not which kind it is.
Passing a work-stream ID would then have named — and thereby created — an empty
SidekickDO, breaking the invariant that a tool never materializes an absent
object. D1 carries no parent-kind column to fix that, and adding one to make an
operator console's lookup cheaper was not worth a product migration.

**Consequences:** The directory is a projection, so a Sidekick created since the
last projection landed is refused until its row arrives. That is deliberate:
refusing an object that exists is recoverable in a way that materializing one
that does not is not. Each Sidekick SQL call also costs one WorkspaceDO
inspection read before execution, the same shape a child substream's parent
check already pays. `SlackReactionTicker` remains unroutable because it does not
inherit the RPC; reaching it is a change to its class, and nobody has asked.

### 2026-08-30 — Admit hosted origins to the MCP transport

**What changed:** The stateless MCP handler now admits request `Origin` headers
from the supported Claude, ChatGPT, and Cursor hosted providers. Redirect URI
patterns and transport-origin hostnames now share one checked-in provider
registry.

**Why:** Managed OAuth successfully authorized Claude Code on the web, but the
Agents SDK rejected Claude's subsequent MCP handshake because its default
origin policy for a custom domain admits only localhost-class origins. Claude
reported the resulting `403` as an authorized account with no MCP server.

**Considered and rejected:** Disabling origin validation with `"*"` was rejected
because the Access redirect policy already defines the hosted providers Rally
intends to trust. Maintaining a second provider list inside the Worker was
rejected because it would drift from the deployment allowlist.

**Consequences:** Hosted handshakes from the registered providers reach the MCP
server after Access authentication. Other browser origins remain rejected, and
adding a provider requires one registry change that updates both OAuth
registration and transport admission.

### 2026-08-30 — Admit hosted MCP clients through Managed OAuth

**What changed:** The Access provisioner now permits Dynamic Client Registration
callbacks on every path under the hosted Claude, ChatGPT, and Cursor origins,
while retaining installed-client localhost and loopback callbacks and preserving
administrator-added HTTPS entries.

**Why:** Claude Code on the web registered through an Anthropic-hosted callback,
but the initial Access application admitted only callbacks on the user's own
machine. Client registration therefore failed before company sign-in.

**Considered and rejected:** A single exact Claude callback was rejected because
hosted clients can move callback paths and the operator requirement is to admit
all supported hosted surfaces. An undocumented global HTTPS wildcard was
rejected because Cloudflare documents path wildcards only after a concrete
HTTPS origin.

**Consequences:** Any OAuth client hosted on an admitted provider origin can
dynamically register, but it still receives no database access unless the user
passes the Ace-derived Cloudflare Access policy. Adding another hosted provider
requires a provisioner change and deployment.

### 2026-08-30 — Fence SQL execution behind read-only regional resolution

**What changed:** SQL tools now resolve both regional authorities before they
execute, select exactly one Service Binding, and pass its authority generation
back for a final regional check. All object-routing lookups now require an
active route in the current open, serving-compatible generation. The Access
provisioner now paginates both application and policy inventory, and BLOB
serialization uses bounded chunks instead of per-byte string growth.

**Why:** The first implementation issued SQL to configured deployments concurrently and
only rejected ambiguity after both calls returned. A duplicate route could
therefore apply one destructive statement twice, and maintenance or stale
routes could address an object that was not the current serving authority.

**Considered and rejected:** Running read-only SQL in configured deployments and parsing
the statement was rejected because SQLite text is not a reliable capability
boundary and the tools deliberately permit arbitrary statements. Choosing the
first successful region was rejected because a second route is an authority
defect that must remain visible.

**Consequences:** Every SQL call adds one read-only regional resolution round
trip before execution. If authority changes between those phases, the tool
fails without issuing SQL and the operator must retry against the new route.

### 2026-08-30 — Add the Access-protected cross-region SQLite console

**What changed:** Rally gained a stateless remote MCP Worker with six initial
inventory and SQL tools, a private named bridge in both regional API Workers,
and a shared inspectable Durable Object superclass beneath the scheduler.

**Why:** Cloudflare's dashboard can inspect one Durable Object SQLite database,
but engineering agents need the same capability through an authenticated,
discoverable protocol and must be able to find the correct object across both
regions without guessing its name or jurisdiction.

**Considered and rejected:** Cloudflare account APIs were not used as the data
path because they do not expose the dashboard's live arbitrary Durable Object
SQL console as a supported application API. Copying product tables back to D1
would create a second authority. HTTP routes on each object, a shared secret,
and product OAuth were rejected because they widen the raw-SQL boundary or mix
operator identity with Rally membership.

**Consequences:** Access admission now grants deliberate destructive database
console authority across configured deployments. The MCP must deploy after both named
regional entrypoints, raw query material must never be logged or persisted, and
future product callers must not reuse the inspection RPC in place of a typed
domain contract.
