# Ace internal administration

Ace is Avalon's internal administration Worker at
`https://ace.internal.rallywith.ai`. Its feature-flag surface manages
Boolean product flags in Cloudflare Flagship: presentation controls for
Electron and operational controls for scheduled digest and Apple push delivery. Its Queues
surface lists every actively configured Cloudflare dead-letter queue, its live
backlog, and a non-consuming peek at its messages. Its Models surface manages
the primary model and ordered fallback array for every model-using agent role.
New internal tools extend the same Hono application and Ace-owned component
library instead of creating another operator site or visual language.

The **Access** page lists Global pre-workspace email requests and their
acknowledgement state. It also generates ad hoc single-use or timed downloads, optionally
associated with a request, through the shared database issuer. Ace now writes
`download_grants` in Global D1; it still does not modify workspace identity or
membership. It sends no invitation email yet. [Private access](private-access.md)
owns that lifecycle and the remaining distribution work.

Timed links use an operator-chosen local date/time and permit repeat downloads
until that deadline. Both generation actions share the current lifetime choice, defaulting to timed mode. Requests and grant history are searched server-side and paged in groups of 50. Access-protected same-origin actions revoke grants and relay acknowledgement recovery to the Global operator API. The existing `demos` role also authorizes these acquisition recovery actions; it does not authorize telemetry administration. The same regional credential also authorizes the reviewed connector-maintenance command described in [connector installation lifecycle](connector-installation-lifecycle.md#operator-maintenance); telemetry and read-only engineering credentials cannot use it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/ace/src/index.ts` | Hono routes, Access admission, same-origin writes, and static assets. |
| `apps/ace/src/access.ts` | Reuses the migration tracker's signed Cloudflare Access assertion verifier. |
| `apps/ace/src/protocol.ts` | The managed flags, safe targeting attributes, all Flagship operators, and Flagship's request limits. |
| `apps/ace/src/client/models.tsx` | The model-role catalog UI, free-text model inputs, and ordered fallback editor. |
| `apps/ace/src/openrouter.ts` | Exact model-id and live-route validation against OpenRouter's public endpoints API. |
| `apps/ace/src/directory.ts` | Read-only user and workspace search across both regional D1 databases. |
| `apps/ace/src/regional-api.ts` | The client for the regional API's operator routes, over the operator credential; every answer parsed with the shared contract. |
| `apps/ace/src/demos.ts` | The demo preparation routes on that client: list, template, start, read, retry, abandon. |
| `apps/ace/src/client/demos.tsx` | The Demos page: every preparation and its phases from real receipts, **New demo**, retry and abandon. |
| `apps/ace/src/client/workspaces.tsx` | The workspaces tab: find any workspace, set its plan, and retire it behind a typed-id confirmation. |
| `apps/ace/src/flagship.ts` | Flagship reads and writes plus the post-write change notification. |
| `apps/ace/src/flag-administration.ts` | The `FlagAdministration` RPC entrypoint the engineering MCP's flag tools call; the same catalogs and write functions as the pages. See [`engineering-mcp.md`](engineering-mcp.md#feature-and-model-flags). |
| `apps/ace/src/cloudflare-queue-admin.ts` | Active dead-letter discovery, realtime backlog metrics, and non-consuming message peeks through Cloudflare's REST API. |
| `apps/ace/src/queues.ts` | Account-wide workspace enumeration and regional fan-out. |
| `apps/ace/src/client/components/ui.tsx` | Ace's shared controls and panels; future pages extend these components. |
| `apps/ace/src/client/main.tsx`, `styles.css` | Feature-flag application and responsive visual system. |
| `apps/ace/scripts/deploy.mjs` | Idempotent Access, flag, Worker, asset, and secret provisioning. |
| `.github/workflows/deploy-ace.yml` | The complete merge-to-main release transaction. |

## How it works

Cloudflare Access runs before Ace. The Worker independently verifies the signed
`Cf-Access-Jwt-Assertion`, including issuer and Ace's application audience, then
trusts the verified identity. The deploy script creates or updates an
Ace-specific Access application by copying the migration site's policies and
identity-provider settings. Ace therefore follows the same employee rule while
keeping a distinct audience.

`GET /api/flags` reads `meeting-recording-enabled`, `suggested-work-enabled`,
and `multiple-workspaces-enabled`. The editor exposes enabled/paused state, default Boolean
value, ordered first-match rules, all eleven operators, nested AND/OR groups,
and sticky percentage rollouts. A rule is reordered by dragging its handle
onto another or, from that same handle, ArrowUp/ArrowDown. A person search
accepts name or full
email but writes the stable `userPlatformId`; a workspace search accepts name or
slug but writes its opaque `workspaceId`. Exact email targeting therefore works
without storing an address in Flagship. Domains, workspace role, region, age,
member count, slug, and application environment use the same attributes the API
already evaluates.

After Flagship accepts a PUT, Ace places only the flag key on
`avalon-product-feature-flag-changes` after Flagship's documented
[up-to-30-second propagation window](https://developers.cloudflare.com/flagship/concepts/).
Its
consumer keyset-pages every workspace from configured deployments D1, then sends one
key-and-workspace message to the owning regional queue. The regional API
consumer RPCs to that workspace's `WorkspaceDO`. The object evaluates the
complete client flag contract per connected user and privately sends the values
to that user's sockets. A subscribe response performs the same evaluation, so
reconnect is the reconciliation path.

**Demos.** `GET /api/demos` and `GET /api/demos/template` relay the Global
regional API's `/internal/demos` routes over the operator credential, and
`POST /api/demos`, `/api/demos/:id/retry` and `/api/demos/:id/abandon` relay
the writes, same-origin. Ace holds no demo state and reads no demo table: the
page shows each operation's phase from the receipts the regional API returns —
Checking template, Creating workspace, Copying connections, Seeding
conversations with confirmed-of-total, Waiting for workspace with the readiness
gaps by name — and a failed operation with its phase, reason and operation id
beside **Retry** and **Abandon**. There is no estimated time and no percentage;
a running phase shows when it started, and a wait that failed keeps the gaps
its last round named. **Retry** is offered for a failed preparation and for a
running one that has stopped moving — the regional API starts the next
attempt either way — and a retried operation is read by its current attempt:
an earlier attempt's phase rows are shown as that attempt's receipts, never
as the new driver's state. **Abandon** retires the candidate workspace, so it
asks for the operation id to be typed, sends what was typed, and the regional
API refuses without it; an abandoned operation says whether its candidate was
closed, was never created, or was never allocated. Every gap the readiness
check reports names the viewer it was read as. While anything is running, and
for as long as the page is offline, it re-reads every five seconds; when a
read fails, the last known state stays on screen dated by its last successful
read until the next read succeeds, and **Refresh** asks now. There is no
per-operation read: the list is the read, and selecting a row selects from
it. The template is read before the page judges it: "reading" first, then
either the form, the regional API's own reason it could not be read, or — when
the template seats nobody to present, or the company has fewer people than the
pack has parts — a sentence saying so rather than a form that cannot be
submitted. **New demo** takes a company name, the presenter (chosen from the
template's members, because they are handed its connections), and a colleague
for every other pack role: one dropdown per part, labelled with what that part
is — **Product**, **Sales**, **Legal** for the pack in service — listing
everyone with a `@rallywith.ai` account who has signed in, by name and address
([`demo-workspaces.md`](demo-workspaces.md#casting-a-demo)). They open uncast: a
default here would seat a real person because nobody looked, and the form says
how many parts are still empty rather than leaving **Start preparation** dead
with nothing to read. It refuses to start while a part is uncast, one person is
in two parts, or two of them share a display name, and mints one operation id
per form so a second click resolves to the same preparation.
**Retry** is offered while a preparation is failed and disabled while it is
running; a running one that has stopped moving is abandoned rather than raced. A Ready demo names the workspace and where
the presenter finds it — the account menu at the foot of Rally's sidebar,
which lists workspaces only while their `multiple-workspaces-enabled` flag is
on, set from the Feature flags tab; the desktop's deep-link contract has no
home-screen destination, so there is no link to fabricate
([`demo-workspaces.md`](demo-workspaces.md#open-questions)). A regional refusal
reaches the page as the API's own code and message, and a response the shared
contract cannot parse is named as a contract mismatch rather than an outage.

**Workspaces.** The tab searches configured deployments' directories and retires the
selected workspace in the region that owns it, through
`POST /api/workspaces/:id/retire`, which relays to the regional API's
`/internal/workspaces/:id/retire` over that region's operator credential,
same-origin. The confirmation is the operator typing or pasting the workspace
id — the button stays disabled until it matches — and the id travels with the
request, where Ace and the regional API each refuse a confirmation that names
another workspace. The receipt says what closed, what stayed in an outbox, and
what remains when the walk could not finish, which a second retirement returns
to; an incomplete pass keeps the typed id and the button armed, under the
counts and the failed nodes, so the next click returns to what remains. A
failed directory search is shown as a failure, never as "no matches"; a region
whose directory did not answer is named beside the rows the other returned;
the search matches an id as well as a name or slug; and a workspace the tab has
retired stays marked for the rest of the session — the mark is held in the app,
so it survives a switch to another tab — because the directory it searches does
not know. A regional refusal reaches the page as the API's own code and
message, and an answer the shared contract refuses is named
`regional_api_contract_mismatch` rather than read as an outage, with the
field the contract refused in the message — which says whether Ace or the
regional API is the one behind.

The same tab sets the selected workspace's plan, Starter or Growth, through
`POST /api/workspaces/:id/plan`, which relays to the regional API's
`/internal/workspaces/:id/plan` over the same credential. The new weekly quota
applies to the current week at once, and the regional API refuses a workspace
another region owns. The directory search returns each workspace's current
plan, and reads a region whose `workspaces` table has no `plan` column yet as
Starter: Ace deploys apart from the API, so it can reach a region before
migration 0118 has run there. [`usage-metering.md`](usage-metering.md) owns what a plan means.

`GET /api/queues/dead-letters` lists account Queues through Cloudflare's REST
API. A Queue is classified as a dead-letter queue only when a live consumer's
`dead_letter_queue` field points to it; Ace does not infer operational meaning
from an `-dead-letter` name. It then calls the per-Queue metrics endpoint for
the realtime `backlog_count`, `backlog_bytes`, and oldest message timestamp.
Selecting one calls `POST .../messages/peek` for one provider-defined batch.
Cloudflare publishes no maximum for peek's optional `batch_size`, so Ace does
not invent one. Peek does not lease, acknowledge, retry, or remove a message.
Ace deliberately discards Cloudflare's returned purge reference, so this first
Queues surface has no delete capability.

`GET /api/models` reads the managed `agent-model-*` JSON flags, including the
Sidekick wizard's independent `agent-model-sidekick-authoring` Sol route. Ace hard-codes
the role catalog because Flagship knows only opaque keys: each entry explains
the code path the model serves and carries the same checked-in route the API
Worker uses when Flagship is unavailable. The suggested model list combines
the reviewed work-stream pin choices with the classifier model used only by
fleet routing; either a primary or fallback input may also carry an arbitrary
OpenRouter model id entered as free text. GPT-5.6 Sol is the exception: Ace suggests
and accepts it only for `inline_child`, whose complete execution path receives
Bind's Azure configuration and pricing port. A role such as `workstream` is not safe merely because its main
turn is routed: its attachment-summary pass still uses the structured
OpenRouter gateway.

Suggested IDs describe canonical model identity, not an Azure deployment name.
Ace's public OpenRouter lookup validates that a canonical ID exists; it does not
select that provider. The role policy is checked in the client and repeated by
the PUT schema before either the public lookup or Flagship I/O. Bind remains the
owner of the Azure-only runtime provider fence.

The sidebar is an explicit stack rank, not alphabetical order. It weights a
role's product criticality first and its execution frequency second: main runs,
message admission, and delegated work lead; per-run descriptions and creation
helpers follow; narrower meeting, activity, suggested-work, and dashboard paths
come after them. Each row shows its numeric rank and the usage reason behind it.
The rank lives beside the hard-coded role explanation so adding a role requires
making its operational importance explicit rather than letting insertion order
decide where operators see it.

The route editor includes optional reasoning effort (`low`, `medium`, or
`high`); Model default omits the field. Read, edit, and save preserve it as
part of the atomic route alongside the primary model and fallback array.

The client debounces edits to the atomic route and asks
`POST /api/models/validate` to check every distinct id against OpenRouter's
live per-model endpoints API. Invalid fields are marked and saving remains
disabled while the route is incomplete, being checked, unavailable, or invalid.
The PUT repeats the same validation before it contacts Flagship, so bypassing
the browser check cannot persist an unknown id. An exact id match with at least
one current endpoint is required; OpenRouter validation uses the public API and
receives no Rally or Cloudflare credential. Each provider lookup has a
five-second deadline chosen by the product owner; a stalled request returns the
same `502` validation-unavailable response as another provider outage and no
Flagship read or write begins.

`PUT /api/models/:role` changes the route plan in that flag's current default
variation. The route plan remains atomic — one primary `model` and one ordered
`fallbackModels` array. Cloudflare's update endpoint replaces a complete flag,
so Ace reads the live definition immediately before saving and copies its flag
status, rules, rollout percentages, and every non-default variation back
unchanged. New runs resolve the change on admission; no client notification
fan-out is needed.

The Flagship API does not expose an ETag, version precondition, or other
conditional-update token. Ace therefore has the same read-then-replace race as
Wrangler: two operators editing one model flag concurrently are last-writer-wins.
The editor disables an unchanged save to avoid needless rewrites, but operators
must not edit one flag in Ace and Wrangler at the same time. Flagship appends a
changelog entry for every update, which is the recovery and audit path if edits
overlap.

## Invariants

- Product Boolean names end in **Enabled**, and their keys end in `-enabled`, so
  `true` has one unambiguous meaning in Flagship, Ace, logs, and client code.
- The product features default to false in the shared client schema. No network
  response, stale cache, missing field, Flagship error, or older API enables one.
- The account-wide and regional Queue messages never carry a flag value. Values
  are user-specific and are evaluated in the owning WorkspaceDO after Flagship
  propagation; carrying one value would leak one audience's answer to another.
- A pushed value is private to sockets belonging to the evaluated user. It
  never rides a workspace-wide broadcast or durable waterline.
- Full email addresses and names may be used to search D1 but never become
  Flagship attributes. Breaking this sends personal data to the global
  targeting plane on every evaluation.
- Ace is the write authority for its managed product flags and the ordinary
  default-route editor for agent models, from its pages and from the
  engineering MCP, which writes only through Ace's `FlagAdministration`
  entrypoint. Direct product-flag dashboard or
  Wrangler edits do not emit Avalon's Queue notification and leave connected
  clients stale until reconnect. Model changes need no notification because
  agents re-evaluate their flag on each run.
- Access policy lives in Cloudflare Access. Ace verifies provenance and does not
  duplicate an employee-domain allowlist in application code.
- Queue identity comes from Cloudflare's returned resource ID and active
  consumer relationship. A caller cannot supply another account Queue ID to the
  peek route and turn this page into an arbitrary message browser.
- The message `ref` returned by Cloudflare never reaches the client. It is the
  capability needed to purge a peeked message, and deletion is not in this
  surface's contract.

## Boundary

Ace owns internal administration UI, the write workflow for its explicit
managed-flag and model-role allowlists, and the read-only operator view over
active Queue dead letters. Flagship owns flag configuration, evaluation, and
its changelog.
Cloudflare Queues owns queue configuration, backlog metrics, message retention,
and peek semantics. Regional D1 owns identity, membership, and workspace lookup
data; Ace reads that identity/membership data without writing it. The Access
page separately issues `download_grants` in Global D1, through its existing
operator authentication and same-origin write boundary. Regional API Workers own
their Durable Object namespaces and the socket protocol.

## Failure modes and limits

- Missing or invalid Access configuration returns 403. The development bypass
  works only with `APP_ENV=development` and `ACE_DEV_AUTH=true`.
- A cross-origin mutation returns 403 before parsing or contacting Flagship.
- An invalid or currently unroutable OpenRouter id returns 400 before Ace reads
  or writes Flagship. If OpenRouter validation itself is unavailable, Ace fails
  closed with 502 and keeps the existing route unchanged.
- A Flagship write failure returns an error and sends no notification. A Queue
  send failure fails the request after Flagship has changed; retrying the same
  save is safe and repairs notification.
- Fan-out and regional delivery are at-least-once. Re-evaluation and socket
  replacement are idempotent, so duplicates cost work but do not change the
  answer.
- Malformed Queue messages are acknowledged as poison; transient D1, Queue, RPC,
  and Flagship failures retry and eventually reach the configured dead-letter
  queue.
- Queue backlog metrics are best effort because Cloudflare's distributed
  counter may be approximate. A failure for one metrics request leaves that
  Queue visible with “Metrics unavailable” rather than hiding the DLQ.
- Cloudflare exposes no cursor on peek. The backlog count states when more exist;
  this first surface does not pretend it can paginate what the provider cannot
  paginate or guess a defensive batch ceiling the team has not chosen.
- Condition strings are at most 256 characters, descriptions 512 characters,
  nesting is at most five groups, and rollout percentages are 0 through 100.
  The string, description, and nesting limits come from
  [Flagship's platform limits](https://developers.cloudflare.com/flagship/reference/limits/),
  not Ace-chosen defensive bounds.

## Testing

`pnpm --filter @rally/ace test` covers Access failure, same-origin mutation,
active DLQ discovery, metrics, non-consuming peek, the exact
Flagship-and-Queue write contract, the safe attribute vocabulary, operators,
nested targeting, regional fan-out, the ranked model-role catalog, live exact-match
OpenRouter validation, invalid free-text rejection, ordered fallbacks, and
preservation of staged model variations and rules. The operator pages have a
Worker suite and a page suite each: `demos.test.ts` and `workspaces.test.ts`
prove the relay — the operator credential presented, a regional refusal
relayed by its own code, an outage answered as unavailable rather than as an
empty page, the typed confirmation forwarded — and `demos-client.test.tsx` and
`workspaces-client.test.tsx` prove the pages against a fetch double: phases
from receipts, a retried operation read by its current attempt, the offline
banner and the polling that keeps it honest, a template too small to cast,
the typed-id ceremony, an incomplete retirement kept armed. `directory.test.ts`
proves the two-region search against real SQLite, one region down included.
`pnpm --filter @rally/ace typecheck`
checks both browser and Worker programs; `pnpm --filter @rally/ace build`
builds the Vite client and performs a Wrangler dry run. API workerd tests cover
the real Queue dispatch and Durable Object WebSocket behavior. Desktop tests
cover the fail-closed product gates and live socket cache replacement.

The Flagship binding is not locally emulated. Tests use a double only for the
external Flagship management and evaluation APIs; D1, Queue dispatch, Durable
Object storage, RPC, and WebSockets use the workerd suite where their runtime
behavior matters.

Ace deliberately has no live local-backend command: a partial Worker without
its two D1 bindings, Queues, Access audience, and Flagship credentials is a
misleading approximation that can accidentally write the shared control plane.
Use the tests and dry-run build for backend changes; use explicit browser
fixtures when visually exercising the component library.

## Regional impact

Demos are prepared in Global, and the Demos page talks to the Global API only.
The workspaces tab retires in the region that owns the workspace, through that
region's API, so no retirement crosses a region; the directory search that
finds the workspace is the existing cross-regional lookup described above.

## Security and trust model

Ace treats request headers, URL parameters, JSON, directory queries, Flagship
responses, and Queue bodies as untrusted. Cloudflare Access is identity-aware
admission, but the Worker still verifies the signed assertion and its audience.
Mutations require same origin and a fixed managed-key schema. OpenRouter
validation is an outbound public read: the request carries only the typed model
id and an `Accept` header, never the Flagship token or operator identity.

The deployment credential stays in GitHub Actions. Ace receives a separate
encrypted `CLOUDFLARE_FLAGSHIP_API_TOKEN` secret with only Flagship Write and
Queues Edit on the Rally Cloudflare account. The binding keeps its historical
name so the existing secret remains in place while its token is rotated.
Cloudflare requires Queues Edit for the
non-consuming `messages/peek` endpoint; Queues Read alone can list Queues and
metrics but cannot view message bodies. The token can change flags and could use
other Queue mutation endpoints, so Ace keeps its API routes on an explicit
read/peek allowlist and never exposes Cloudflare's purge reference. It cannot
deploy Workers, change Access policy, read D1, or administer other account
products. No token is compiled into the Vite bundle or stored as a plain Worker
variable.

## Operations

A merge to `main` starts `deploy-ace.yml` when it changes Ace runtime or
configuration, the reused Access verifier, shared runtime contracts or DB code, dependency
resolution, the shared TypeScript configuration, or one of the deployment-time
scripts. Test-only changes under Ace, shared contracts/DB, or the Queue provisioner
remain CI-only and do not redeploy production. The workflow validates the
repository, creates all declared Queues, clones the migration Access policy,
ensures all Enabled-named flags and managed JSON model flags exist from their
checked-in defaults without overwriting existing definitions, injects Ace's
returned Access audience, uses the runtime token to list a dynamically selected Queue
and perform a non-consuming peek, deploys the Hono Worker and assets, installs
the token as an encrypted secret, and verifies an unauthenticated request is
redirected by Access. A missing Queues Edit permission therefore fails the
deployment before a broken Queues page reaches production. The API deploy and
signed desktop release start from their existing `packages/**` and
`apps/desktop/**` triggers in the same merge.
There is no per-release manual command or dashboard step.

When a save succeeds but clients do not change, inspect in order:

1. Flagship's changelog for the enabled-named key.
2. `avalon-product-feature-flag-changes-dead-letter`.
3. The matching regional product-feature-flag dead-letter queue.
4. `product_feature_flag_fanout_failed` and `client_flag_unresolved` logs.
5. A reconnect, which must receive current values on the private subscribe
   response even if a live notification was lost.

Shared DB runtime sources and package exports are deployment inputs alongside
contracts. Grant-only fixes therefore rebuild Ace; DB migration/test-only changes
do not publish a new Ace bundle.

### 2026-11-07 — Two Thread-era model roles leave the catalog

**What changed:** The managed model catalog loses the work-stream
description and suggestion-draft rows, and the deploy retires
`agent-model-workstream-description` and `agent-model-suggestion-draft`.
The `workstream_naming` row is relabelled "Pasted-text naming": it now titles
pasted text (`pasted-text-service.ts`) and keeps its key.

**Why:** Plan step C-2 of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)
deleted both roles' callers. The 2026-10-16 entry's rule applies: a row
removed from the catalog moves to a `retireFlag` call in the same change.
Renaming the naming role's key was rejected as a flag migration with no change
in behaviour.

### 2026-10-16 — Ace stops managing `digests-enabled`

**What changed:** `digests-enabled` left `MANAGED_FLAGS`, and the deploy
retires it instead of ensuring it. Every managed product flag now defaults the
way its catalog row says, with no digest exception.

**Why:** It was the kill switch for the agent-run digest the 2026-10-15
rewrite replaced, and its live default had drifted to `off`, hiding the Daily
digest settings and stopping delivery for everyone. See
`digests.md` (retired) for the full entry.

**Consequences:** A flag removed from the catalog must also move to a
`retireFlag` call in the same change, or the key stays in Flagship where a
stale value can still be served.

### 2026-10-02 — Edit reasoning with the model route

The Models editor reads and saves optional reasoning effort alongside model
and fallbacks. Model comparisons needed independent effort changes without a
deploy or a separate flag whose rollout could disagree with the model. The
shared route schema also owns MCP validation; Model default removes the field
and preserves existing behavior.

### 2026-10-02 — Deploy stops re-creating retired model flags

**What changed:** The deploy no longer ensures `agent-model-automation-compiler`
or `agent-model-automation-result-disposition`, and it now retires
`agent-model-activity-structured`, `agent-model-addressing-classifier` and
`agent-model-hypersight`.

**Why:** A merge on 2026-09-30 brought back the two automation `ensureModelFlag`
calls after the step that retires them, so every deploy deleted both flags and
created them again. The other three lost their roles earlier, but nothing
deleted their flags, so they stayed in Flagship as dead keys a rollout could
target.

**Consequences:** A key in the retire list must not also appear in an ensure
call; the second step wins and the flag survives every deploy.

PR #1062.

### 2026-09-12 — Use the existing operator identity for connector maintenance

**What changed:** Regional maintenance routes admit the existing Ace demos operator identity for preview, apply, status, resume and cancel; no Ace UI is added.

**Why:** The product owner selected the existing operator identity for reviewed connector maintenance, while read-only engineering access must remain insufficient for provider writes.

**Considered and rejected:** A new permanent administrative secret or arbitrary provider-request/SQL capability.

**Consequences:** Maintenance freezes a reviewed regional selection and records operator attribution. Deployment and a real fleet operation require their own authorization; follow [lifecycle operations](connector-installation-lifecycle.md#operations).

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).

### 2026-09-10 — New demo casts colleagues from a dropdown

**What changed:** The cast fields are dropdowns of the company's own people —
everyone with a `@rallywith.ai` account who has signed in — and the page sends
user ids rather than names. They open uncast rather than pre-filled, Start is
refused while a part is uncast, one person is in two parts, or two of them
share a display name, and the page says so when there are fewer colleagues than
the pack has parts, instead of a form that cannot be submitted.

**Why:** The team asked for the real addresses: the invented cast was not being
used. A default was dropped with it — yesterday's form opened on the pack's
suggested names because a name is a thing you type over, but a pre-selected
colleague is a real person seated in a demo workspace because nobody looked at
the field.

**Consequences:** The presenter's list and the cast's are now different lists
from the same response, and the page names the domain when it says the second
one is too short — so it reads the domain from the template rather than
carrying a copy of it. A template that reads fine but has nobody to cast is its
own state rather than the "could not be read" one, because Refresh is not the
remedy for it. What the page refuses, the regional API refuses again: the
dropdown is a convenience, not the boundary
([`demo-workspaces.md`](demo-workspaces.md#casting-a-demo)).

Shipped in #664.

### 2026-09-09 — Bound and recover early-access operations

**What changed:** The Access page now searches and pages requests and grant history, labels generated links with recipients, and supports revocation and explicit acknowledgement recovery. Recovery uses the existing Global operator credential and reports pending/failed/uncertain mail so an operator can reconcile it without raw SQL. Timed mode is the default; no default duration is invented.

**Why:** Public acquisition needs predictable failure and recoverable operator actions before launch, without imposing account approval or building a campaign system.

**Consequences:** [Private access](private-access.md) owns configuration, undecided numerical limits, and recovery procedures. PR #637.

### 2026-09-09 — Add access intake review and download issuance

**What changed:** Added Access request review and manual single-use/timed grant
issuance through the shared issuer, with operator audit events. The deployment
filter follows shared DB runtime changes so issuer fixes cannot leave Ace stale.

**Why:** Operators need to track early-access interest and supply downloads
without coupling the UI to a future invitation sender.

**Consequences:** Ace writes Global `download_grants` only; identity and membership
remain read-only. Generation sends no mail. [Private access](private-access.md)
owns the grant lifecycle and operator erasure/revocation procedure.

### 2026-09-09 — New demo names its cast

**What changed:** The cast pickers are text fields — **User 1** onwards,
defaulted from the pack — and the page sends names rather than user ids. The
summary shows the cast of a preparation the form is no longer on screen for,
and a gap names the person rather than the pack role. **Retry** is disabled
while an operation is running.

**Why:** Casting from the template's members put Rally's own staff, under
their work addresses, in the demo shown to a customer, and capped the cast at
the template's size; the regional API mints a persona per name now
([`demo-workspaces.md`](demo-workspaces.md#casting-a-demo)). Retry on a
running operation was offered for a driver that had died silently, which is
rare, reads as "start again" to whoever is watching a preparation work, and
costs a duplicated attempt when it is pressed; the API still allows it, so
nothing is lost that a deliberate change could not restore.

**Consequences:** The form needs one template member, not one per role. The
page shows names it does not compute — `castNames` comes from the regional
API, which reads the demo's own directory — so a renamed member is renamed on
the page.

### 2026-09-07 — Demos

**What changed:** A Demos page, which lists every preparation with its
phases from the regional API's receipts, starts one with **New demo**, and
retries or abandons a failed one behind a typed operation id. `demos.ts` puts
the `/internal/demos` routes on the relay the Workspaces tab already uses.

**Why:** The demo workspace PRD puts the operator surface in Ace, behind the
Access policy that already admits operators. Relaying rather than reading D1
keeps the operation's rules in one place — the regional service that owns the
Workflow. The states are the PRD's table; nothing is estimated. There is no
**Open in Rally** link because the desktop's deep-link contract has no
home-screen destination; the page says which workspace to switch to instead of
fabricating a link the desktop would reject. From review of the finished page:
the default cast was shifted by one and every default was wrong; the first
paint claimed the template was missing while it was still on its way; a slow
read could overwrite a newer one. So the page reads the template before
judging it, dates the offline banner by the first failure and the last
successful read, shows when a running phase started, keeps a failed wait's
gaps, offers Refresh, deals the default cast out in order, refuses a member in
two roles, labels roles as names, parses every response with the shared
contract, and sequences polls.

**Considered and rejected:** A native confirm dialog for Abandon — the one
irreversible action a tab over uses a typed id, and the regional API requires
one.

**Consequences:** Ace holds no demo state. The typed confirmation is the
pattern for anything irreversible on these pages.

### 2026-09-07 — Workspaces

**Why:** The demo workspace PRD puts the operator surface in Ace, behind the
Access policy that already admits operators, and needs a credential to reach
the regional retirement API. Relaying rather than reading D1 keeps the walk's
rules in one place — the regional service that owns the objects — and keeps
Ace's boundary as it was: no new Cloudflare capability, no product content.
The confirmation is typed rather than clicked because retirement takes any
workspace and nothing else guards it. One operator token per region rather
than one shared value, because a shared token contradicted the per-region rule
in `security.md` and made one leak destructive in both jurisdictions. The
receipt names the workspace and what closed, the form goes, and the row stays
marked, and a failed search is shown as a failure — a retirement that left the
page looking exactly as it had before it, with the button still armed, and a
failed search showing the previous query's rows under the new query, are the
two ways an operator retires the wrong workspace with full ceremony.

**Considered and rejected:** A native confirm dialog — the one irreversible
action on the page uses a typed id, and the regional API requires one.

**Consequences:** Ace holds two operator secrets and each reaches one region.
The typed confirmation is the pattern for anything irreversible on these pages.
The token's role reaches the retirement route only.

### 2026-09-03 — HyperSight has no managed rollout surface

**What changed:** Ace no longer carries the Block Dashboard model role,
feature-flag payload, queue protocol, deployment binding, or editor controls.
Its deploy removes the retired `hypersight-enabled` and
`agent-model-block-dashboard` keys if Flagship still holds them.

**Why:** HyperSight is removed rather than disabled, so leaving an operator
surface would advertise settings with no runtime consumer.

**Consequences:** Ace manages only live Rally capabilities. Flag retirement is
idempotent, so later deploys accept the keys already being absent. Historical
changelog entries still describe the feature while it existed.

Shipped in #541.

### 2026-09-02 — Sol appears only for completely Azure-routed roles

**What changed:** The Models editor suggests `openai/gpt-5.6-sol` above Terra
and Luna for `inline_child` and `block_dashboard`. It omits and rejects Sol for
every role with any direct OpenRouter path.

**Why:** Operators need Sol available for managed Azure-routed roles, while the
cost constraint forbids making it configurable on a path that can execute the
same canonical ID through OpenRouter.

**Considered and rejected:** Treating all eleven roles as equivalent because
they share one Flagship schema. Several roles construct direct structured
OpenRouter requests, and the work-stream role mixes a Bind main turn with one
of those attachment-summary passes.

**Consequences:** The suggestions are role-aware and Ace fails an unsafe save
before provider or Flagship I/O. Sol remains canonical in Flagship, is still
validated against the public model catalog for the two admitted roles, and
relies on Bind for runtime provider enforcement.

### 2026-09-01 — multiple-workspaces-enabled joins the catalog it was assumed to be in

**What changed:** `multiple-workspaces-enabled` was added to `MANAGED_FLAGS`,
to `ProductFeatureFlagKeySchema`, and to `deploy.mjs`, making it Ace's sixth
managed product flag and its fifth presentation control. Two new
`protocol.test.ts` cases fail when a product Boolean the API resolves is absent
from this catalog, and when a served key opts out of Ace by not being named
`-enabled` without being listed as a deliberate exception.

**Why:** The flag shipped in #464 resolved by the API and consumed by Electron,
but registered nowhere here. Nothing created it in Flagship, so it did not
exist in the app at all: the feature was off for every account with no operator
able to turn it on, and each desktop poll logged an unresolved flag. Every
existing check starts from this catalog and walks outward to `deploy.mjs`, so a
flag that never reached the catalog passed all of them.

**Considered and rejected:** Having Ace list whatever Flagship returns instead
of a hard-coded catalog. That would have surfaced this flag only once something
else created it, and it would surrender the labels, descriptions, and defaults
that make an operator page readable — `developer-settings` and
`control-tower-refresh-seconds` are deliberately not Ace's to manage, and a
live listing cannot express that. The catalog stays authoritative; the new test
makes its incompleteness fail on the pull request.

**Consequences:** Adding a product Boolean is now four edits, not one, and the
suite says so before merge. The `-enabled` suffix is load-bearing: it is what
separates a flag Ace must manage from one it must not, so a flag kept outside
Ace must keep a key that does not end in `-enabled`. Deploying this creates the
flag with no rules at its `off` default, which changes nothing for anyone until
a targeting rule is added.

### 2026-08-26 — Models makes every agent route editable without flattening rollouts

**What changed:** Ace gained a Models navigation section for all eleven roles
declared by `agent-model-flags.ts`. Each role carries a code-derived explanation,
its checked-in primary and fallback defaults, an explicit importance-and-usage
rank, a suggested model list, validated free-text OpenRouter ids, and an ordered
fallback editor. Every edit is checked
against OpenRouter's live endpoints API, and the Worker repeats that check
before any Flagship mutation. Saving replaces only the route
plan stored in the live flag's current default variation; the Worker reads the
complete flag immediately before PUT so its status, targeting rules, rollout
percentages, and staged variations survive. Deployment now creates any missing
model flags from the same hard-coded defaults before publishing Ace.

**Why:** Model routing was operationally configurable but required an operator
to translate eleven opaque Flagship keys back into their call sites and edit
JSON by hand. That made the easy change — move one concrete loop to a new
primary or fallback — depend on code spelunking every time and made an invalid
or reordered fallback array easy to write.

**Considered and rejected:** Replacing each model flag with one Ace-owned
variation. It would make the editor simpler but silently erase regional and
workspace rollouts that Flagship already supports. A second Ace-owned database
was also rejected: the API Worker evaluates Flagship on every admission, so a
parallel store would add synchronization and a second authority without making
the run path simpler.

**Consequences:** Ace intentionally edits only the current default variation;
advanced cohort rollouts still use Wrangler or Flagship. A custom model id is
allowed only after OpenRouter returns the exact id with a current serving
endpoint, unlike the desktop's closed reviewed work-stream pin list. A provider
validation outage therefore blocks model saves rather than risking an unusable
route. The role and route-value contracts are shared with the API; Ace's
code-derived explanations, defaults, and ranks remain hard-coded, with a parity
test that fails when the shared role catalog gains an entry. Model saves append
the ordinary Flagship changelog entry but send no product-flag Queue
notification: there is no client cache to wake, and a run resolves the route
when admitted. Cloudflare offers no conditional flag update, so concurrent
edits remain last-writer-wins; disabling unchanged saves reduces accidental
rewrites but does not manufacture a concurrency guarantee the provider lacks.
OpenRouter lookups abort after five seconds so a provider that accepts a
connection and stalls cannot hold the operator request indefinitely.

### 2026-08-25 — Queues exposes live dead-letter backlogs and non-consuming message inspection

**What changed:** Ace gained a Queues navigation section backed only by
Cloudflare's REST API. It derives the active DLQ set from Queue consumer
configuration, reads each realtime backlog count, byte size, and oldest
timestamp, and shows one provider-defined peek batch with attempts, time, body,
and metadata. The existing dedicated Ace token and Worker binding remain in
place and now require Flagship Write plus Queues Edit; their legacy
Flagship-specific names are retained to avoid a credential migration.
Deployment now proves the token can perform a non-consuming Queue peek before
installing it.

**Why:** Dead letters were already the intentionally simple production signal
for several Queue-driven subsystems, but investigating that signal meant leaving
the internal operator application and using Cloudflare directly. Operators need
the size and the actual failed envelope together to distinguish one poison
message from a growing delivery failure.

**Considered and rejected:** HTTP pull followed by no acknowledgement. It can
return bodies, but it leases every inspected message and temporarily changes
what another consumer can see. Cloudflare's newer `messages/peek` endpoint is a
closer contract because messages remain available for later peek or pull.
Classifying DLQs by the repository's naming convention was also rejected: a
name is compatibility text, while the consumer's live `dead_letter_queue`
relationship is the provider's authority. Finally, giving Ace the deployment
token was rejected because Queue inspection does not justify Worker, Access,
D1, route, or other account-administration permissions.

### 2026-08-25 — Targeting rules gain drag-to-reorder

**What changed:** Each rule card in the flag editor now has a drag handle;
dropping one rule onto another moves it to that position. The dragged rule's
own index travels on the native `dataTransfer` payload rather than only in
React state, so `onDrop` reads it back synchronously instead of depending on
a commit landing first. The same handle is a real `<button>` that also
answers ArrowUp/ArrowDown, moving the rule one position and announcing the
result (`aria-live="polite"`) for a keyboard or screen-reader operator who
cannot perform the drag gesture at all. Every rule now carries a client-only
`_clientId`, assigned once when it is loaded or created and stripped back out
before save, so React tracks a moved rule's own card — and the local state
inside it — rather than whichever rule now sits at its old position.
`priority` is still recomputed from array position on save, same as before —
reordering the rules array was always how a save would express a new order,
this just gives the editor two ways to produce that reorder without deleting
anything. `reorderRules` is the pure function behind both paths, unit-tested
directly rather than through a simulated pointer gesture.

**Why:** "Rules run from top to bottom, the first match wins" is Flagship's
real behavior, stated directly in the editor's own copy — but the only way to
change that order was removing a rule and re-adding it at the bottom, since
`+ Add rule` always appends. That was not a hypothetical gap: an operator
adding a personal override on top of an existing workspace-wide rule got the
opposite of what they configured, because the broader rule sat first and
Flagship never reached the narrower one. Nothing in the editor said so.

**Considered and rejected:** Separate move-up/move-down buttons instead of
arrow keys on the drag handle itself. Review caught that the first version of
this shipped drag as the *only* way to reorder — a `<span role="button">`
grip with no `tabIndex` and no keyboard handler, despite the doc above
claiming it was the only way to reorder, which made it doubly true for anyone
who could not drag. Dedicated buttons were the more conventional fix, but
putting the same ArrowUp/ArrowDown affordance on the existing handle needed no
second control, and `aria-keyshortcuts` on that one element documents both
interactions in the same place.

**Consequences:** `Panel` now spreads arbitrary HTML attributes instead of
accepting only `className`, so a rule card can carry `onDragOver`/`onDrop`
without a one-off prop grown just for this. Rule cards keyed by array
position — the first version of this — reordered the data on drop but left a
card's own local lookup state (the friendly label a person or workspace
search resolves to) behind at the old position; reviewed and confirmed in a
real browser before `_clientId` fixed it. A separate, position-indexed ref
array still exists purely to move keyboard focus after a move — unaffected by
the key fix, since a ref read immediately after the render that populated it
is never stale the way state surviving across renders at the same key can be.
A keyboard move reorders the data but leaves focus sitting on the position it
started at, so the editor explicitly refocuses the handle at the rule's new
position after every keyboard move, or a second arrow-key press would
silently move whichever rule had landed there instead. Putting the dragged
index on `dataTransfer` also made the drop handler synchronously correct on
Firefox, which never begins a drag whose `dragstart` handler left
`dataTransfer` untouched — and let `onDragOver`/`onDrop` gate on that same
payload's presence, so a card no longer swallows a drag that was never a rule
drag (dragged text, a link, a file). No Flagship-side change; the save
payload this produces was always a valid one, `_clientId` included and
stripped before it is sent.

### 2026-08-25 — Ace manages a fifth flag, its first that is not presentation-only

**What changed:** Ace's catalog gained `digests-enabled`, a kill switch for
scheduled digest delivery. Unlike every flag before it, Electron never reads
it — `apps/api/src/services/digest-flags.ts` reads it directly at the moment a
digest is about to fire — and `apps/ace/scripts/deploy.mjs` provisions it with
`default_variation: 'on'` rather than `ensureFlag`'s ordinary `'off'`, because
a digest already sends by default for every existing person.

**Why:** An operator needed a real stop for digest delivery, not a hidden
settings screen: digests run from a cron reconciler nobody visits a UI to
trigger, so a presentation-only flag in the existing pattern would have hidden
nothing that controls delivery. Reusing Ace's existing editor, write path, and
Queue fan-out — rather than building a second flag-editing surface — keeps one
place an operator looks for every Boolean flag they might need to change by
hand.

**Considered and rejected:** A bespoke write path that skips the Queue
notification for flags outside `ClientFeatureFlagsSchema`, to avoid triggering
a client re-evaluation nothing needs. Rejected because the fan-out is harmless
idempotent work — it always re-sends the complete client contract regardless
of which key changed, so a `digests-enabled` save just repeats a
re-evaluation that was already safe to repeat — and a conditional fan-out
would be a second code path for every future flag to reason about, bought for
a cost that shows up nowhere a person would notice it.

**Consequences:** `ensureFlag` now takes a default-variation argument, and each
`MANAGED_FLAGS` entry in `protocol.ts` carries its own `defaultVariation` —
`'off'` for every presentation flag, `'on'` only for `digests-enabled` — so the
client editor's skeleton state agrees with what `deploy.mjs` provisions before
either has read a real value from Flagship. The two still cannot read one
shared object: `deploy.mjs` runs under plain Node rather than through Vite, so
it cannot import `protocol.ts` and resolve the extensionless relative imports
elsewhere in the TypeScript graph. `deployment-contract.test.ts` closes that
gap in a test instead, checking every managed flag's provisioning call against
its catalog entry, so a silent regression back to `ensureFlag`'s ordinary
default fails CI rather than stopping every digest in production on the next
deploy.

### 2026-08-25 — Ace merge deployment follows its runtime boundary only

**What changed:** The merge-to-main path filter now follows the shared
TypeScript configuration and the Queue provisioner's transitive entry-point
helper. It excludes Ace tests and contract tests, and drops the Queue
provisioner's test file from the include list, while an exact
deployment-contract assertion pins the complete list.

**Why:** The old list could leave production on a bundle built under an older
compiler configuration or defer a deployment-helper change until an unrelated
merge. It also caused the production Ace deployment for the analytics lakehouse
merge even though the only matching file was a Queue provisioner test.

**Considered and rejected:** Treating every repository test or every API
Wrangler configuration as an Ace deployment input. CI owns test validation, and
the API and migration-tracker workflows already provision the Queue declarations
their own runtime changes introduce; redeploying an unchanged Ace Worker adds no
repair. Expanding this Ace correction into an audit of the API,
migration-tracker, and site path filters was also rejected as separate module
scope; this entry makes no claim that those workflows have the same complete
boundary.

**Consequences:** A runtime-relevant merge cannot miss Ace through these known
shared inputs, while a test-only merge no longer performs a credentialed
production deployment. Adding another external build or deployment module also
requires adding it to the pinned path contract.

### 2026-08-24 — Review hardens live delivery and records Ace's regional exception

**What changed:** Initial desktop reads now fetch immediately despite their
fail-closed render seed; every Electron surface defaults managed Booleans off;
meeting controls consume live socket-backed values; queue batches deduplicate
keys and prove cursor pagination; deployment follows changes to the shared
Access verifier. Misleading partial local-Ace commands were removed, and the
regional section now describes the directory fields Ace transiently reads.

**Considered and rejected:** Routing Ace directory search through a new regional
RPC. The product requirement deliberately makes this internal Access-gated
application the cross-region lookup plane; adding a bridge would change that
boundary rather than fix the inaccurate claim.

**Consequences:** A render seed is never treated as a completed server read,
managed Electron UI remains off until an exact server `true`, one Queue batch
enumerates each region once per distinct key, and regional documentation must
continue to name Ace's narrow operator-search exception.

### 2026-08-24 — Ace becomes the managed product-flag write path and manages Suggested Work and workspace template rollouts

**What changed:** Ace was introduced as an Access-protected Hono Worker with a
shared component library, D1-backed targeting editor, automated Flagship
provisioning, and a shared-to-regional Queue fan-out that updates connected
desktop clients through WorkspaceDO. Its fixed product-flag catalog includes
Suggested Work Enabled and Automation Workspace Templates Enabled alongside the
first two product flags, and its automatic deploy provisioner creates both as
Boolean flags with an off variation, an on variation, and an off default.

**Why:** Product managers need to stage user-facing features by human concepts
such as a person, workspace, role, or domain without copying opaque IDs or
deploying application code. Connected clients also need a change promptly, but
the effective answer differs per user and Flagship exposes no documented
outbound change notification. Suggested Work and workspace templates are
existing application surfaces that need staging through the same ergonomic
targeting editor and key-only notification path as the first two product flags,
without dashboard-only configuration that would bypass connected-client
notification.

**Considered and rejected:** Polling every desktop makes propagation depend on
every client timer and repeats work forever. Sending one value through the
fan-out is incorrect for targeted rules. Using the Flagship dashboard directly
cannot trigger Avalon's Queue path. Giving Ace the deployment token would make a
runtime compromise an account-administration compromise. For the two additional
flags, a second editor or a separate Flagship application would duplicate
targeting vocabulary and split one global rollout control plane without
introducing a distinct trust or residency boundary.

**Consequences:** Managed product flags must be edited through Ace, Queue
payloads remain key-only, reconnect remains the repair path, and future Ace
pages reuse its Access boundary and component library. The Flagship-only runtime
credential is a standing deployment prerequisite. Ace's managed set is four
flags. Adding another product Boolean requires an Enabled-named key, fail-closed
Electron visibility, automatic provisioning, and inclusion in the shared key
schema. These controls must not change API availability.
