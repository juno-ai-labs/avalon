# Connector installation lifecycle

Workspace event connections use a durable installation record alongside the
connection's encrypted credentials. The record coordinates provider registrations
without assigning that authority to personal MCP authorization. Ashby and Granola
use the same execution path; ordinary tool activation remains in
[connectors](connectors.md) and [hosted MCP](hosted-mcp-connectors.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/connector-installation.ts` | Public installation and registration state, without credential values. |
| `packages/connectors/src/installation.ts` | Provider-management facet and explicit automatic/manual support. |
| `packages/connectors/src/{ashby,granola}.ts` | Documented provider calls and manual recovery instructions. |
| `apps/api/src/durable-objects/connector-installation-{protocol,storage}.ts` | Typed commands, atomic reservation, dispatch receipts, generation fences, and cleanup snapshots. |
| `apps/api/src/durable-objects/workspace-do.ts` | Schema migrations and workspace/retirement authority. |
| `apps/api/src/services/connector-installation-service.ts` | Shared Queue-driven provider execution. |
| `apps/api/src/services/connector-installation-plan.ts` | Reviewed configuration diff, grant intersection and replacement-before-removal dependencies. |
| `apps/api/src/services/connector-maintenance-service.ts` | Frozen regional operations and concurrency-safe per-target progress. |
| `apps/api/src/services/connector-connection-access.ts` | Normal credential authorization and the separate exact-removal cleanup door. |
| `apps/desktop/src/renderer/components/connector-installation.tsx` | Administrator setup, registration status and recovery controls. |

## How it works

An administrator provides a provider API key in Settings. New Ashby setup
automatically reserves all 27 documented business event types from
`packages/contracts/src/ashby-events.ts`; there are no subscription checkboxes.
`ping` is a transport check, not a subscription. Older clients that explicitly
supply an event subset retain that grant; maintenance does not widen it. Before provider I/O, one WorkspaceDO transaction binds the setup
attempt to the administrator and a keyed digest of normalized inputs, reserves a
stable connection ID, and saves encrypted credentials plus registration intents.
Repeated setup with the same identity resumes the reservation; changed inputs or
a competing active workspace installation are refused. Ashby also has partial
unique indexes for its active personal-owner and workspace cardinality.
The existing setup telemetry records a newly committed local authorization once;
idempotent retries do not count as new setups. Verified provider delivery remains
the installation status, not the setup telemetry result.

If setup reserves an installation but its response is lost, Settings reloads the
workspace connections and opens the saved installation. It does not change the
attempt identity and submit corrected inputs against that reservation. A failed
recovery lookup blocks further setup until Find existing installation succeeds.
Reconciliation offers only unresolved eligible registrations and clears the
submitted provider identity after success.

The existing activity Queue carries only region, workspace and connection IDs.
The runner claims each step before provider I/O. It records returned provider IDs
before inspection; successful creation alone does not establish current delivery.
Inspection compares the recorded identity, destination, approved events and enabled
state. An explicit repair can enable a disabled registration, followed by another
inspection. Health checks and tool inventory never run this repair path.

A lost create response remains unknown. Queue redelivery cannot create another
registration. The administrator inspects the exact destination in the provider
and supplies an existing ID for verification. An interrupted dispatched step is
made explicitly unknown by repair before recovery proceeds. Neither provider
advertises automatic signing-secret cutover. The desktop shows local manual
guidance without changing installation state or verification material.

Disconnect disables the ordinary connection and clears its credential access in
the same transaction that captures a separate encrypted cleanup snapshot. Only a
claimed removal step for an exact recorded provider ID can obtain that snapshot.
It cannot refresh tokens, discover tools, create, update, or reactivate a connection.
Generation and dispatched-intent checks precede provider I/O and settlement.
Repeated disconnect preserves the existing encrypted cleanup snapshot and pending
removals. A late create result is recovered from its dispatched intent: after
disconnect it is recorded for removal, and it cannot overwrite newer state.
Successful removal clears the snapshot;
Forget local cleanup credential clears it explicitly and invalidates pending work.
Retry cleanup refuses to start again once that credential has been forgotten.
Both disconnect entry points run the same local teardown, including disabling
associated schedules and updating ingress routes. Adoption or cleanup-queue
failure cannot skip that teardown. A host-side cleanup authorization/decryption
failure is failed work; only dispatch to the provider makes its outcome uncertain.
Expected installation action refusals return stable 404/409 API errors.

An administrator can replace the API key in Manage events. Read-only provider
validation precedes an atomic replacement fenced by installation generation.
Credential settlement advances that generation, and replacement reads the
generation before reloading the envelope it will preserve. Existing signing material and registration IDs
survive; an unknown dispatched operation
stays unknown. Neither a stale replacement nor a disabled connection can regain
ordinary credentials. Explicit Test still runs repair before healthCheck; this
credential replacement does not make automatic health or inventory a repair path.

For providers without verified signing cutover, the UI describes the supported
manual replacement: disconnect, finish removal of exact registrations, then
connect again. It explicitly names the intervening delivery gap. Automatic
rotation is reserved for facets with authenticated cutover evidence. The guidance
control performs no request; it cannot turn a current installation into action
required merely because somebody reads the instructions.

Existing Granola workspace connections are adopted on explicit Test or disconnect.
Adoption retains the connection ID, plugin ID, encrypted envelope and secret, and
records the existing provider webhook ID. It creates no subscription. An absent
or mismatched registration requires attention. The four existing note event
subscriptions remain unchanged. All Granola provider repair and removal now use
the lifecycle path; the adapter has no duplicate legacy mutation implementation.
The original Granola setup request remains accepted when an older desktop omits
an idempotency key; current clients supply a stable setup attempt.

## Invariants

- The workspace reservation precedes remote create; reversing the order leaks
  duplicate registrations under concurrent administrator setup.
- Personal MCP grants cannot reach workspace management; an OAuth failure cannot
  disable an independently authorized workspace event connection.
- A dispatched create is never blindly retried. A lost response is not evidence
  that the provider did nothing.
- Generation and exact step identity fence settlement; an old callback cannot
  overwrite newer credentials or restore a disabled installation.
- Cleanup credentials authorize removal of recorded IDs only. Passing them through
  normal refresh or activation would reopen a disabled connection.
- Desired events come from the reviewed provider declaration intersected with
  the saved installation grant, never arbitrary operator payloads.
- Granola adoption preserves existing subscriptions and verification material;
  replacing its webhook would introduce an unverified delivery gap.

## Boundary

WorkspaceDO owns installation state. Regional D1 holds opaque ingress routing
and frozen administrative maintenance operations; R2 stores signed payloads in the owning region. No second activity pipeline is
introduced. Ashby workspace connections expose zero REST recruiting tools.
All declared Ashby event types normalize to operational notifications with host
first-observation time. Application payloads contribute application, candidate and
job IDs; the email beta contributes candidate identity. Other event families keep
their raw regional payload reference without inventing entity fields. Names and
provider content are not promoted to summaries.

The [email beta](https://developers.ashbyhq.com/reference/candidaterecentemailmessagesupdatedwebhook)
is a change signal, not email content. Its action ID survives retries while its
watermark can change. Canonical Queue admission therefore compares the normalized
candidate signal, excluding only its raw hash and payload reference from the
logical hash. Every raw delivery retains its actual hash and separate R2 object;
a changed candidate under the same action ID still conflicts. No email REST
refresh or recruiting tool is introduced.
The approved confidential-payload authorization review remains a release gate:
normalized Ashby events currently have restricted visibility and do not run
workspace automations. This is not launch completion.

Fleet maintenance uses the existing Ace `demos` operator credential identified
by the user. The new route is repository implementation, not a deployed permission
grant or authorization to run a fleet operation. Read-only inspection credentials
remain insufficient. The generic signing-key preparation/promotion protocol and
frozen maintenance service do not make manual provider cutovers verified.

## Failure modes and limits

Provider validation failures before a mutation are failed steps. Uncertain
mutations require inspection, not blind replay. Missing credentials, redacted
provider destinations, unsupported operations and version mismatches must stay
visible. Queue infrastructure failures use existing retries and DLQ handling.
A locally disabled connection refuses ingress even while provider deletion is
pending. If the cleanup credential was revoked or forgotten, the administrator
must remove the recorded webhook in the provider dashboard.

A rejected Ashby subscription remains visibly unresolved, including the email
beta that Ashby says may not be available to every organization. Other
registrations continue setup and delivery. No undocumented rejection code is
classified as harmless, and an uncertain create is never blindly retried.

A Granola create response with a provider ID but no signing secret is not a
verified installation. The ID remains available for inspection or exact removal;
repair cannot mark delivery current without usable verification material. Ashby
ingress uses the existing `PROVIDER_WEBHOOK_MAX_BYTES` setting, defaulting to
1,000,000 bytes when unset; the dedicated and both regional Wrangler configs
explicitly set 2,000,000 bytes. The shared bounded reader enforces this before
buffering or RPC forwarding. Oversized bodies
are rejected with 413; this reuses the regional provider ingress limit.

Granola's current public update schema omits `note.regenerated`, although Rally's
existing subscription includes it. The implementation preserves the existing
four-event selection and only patches `enabled`; live compatibility remains
required before changing that selection or advertising broader repair.

## Testing

`apps/api/test-workers/connector-installation.test.ts` uses real workerd, real
WorkspaceDO migrations, actual Queue sends and Queue consumption. It covers
concurrent reservation, input-bound replay, single dispatch, stale settlement,
late-create cleanup, credential erasure, Ashby and Granola provider execution,
uncertain create recovery, signed webhook admission and identity collisions,
a populated v52 upgrade, manual provider capabilities, and synthetic verified and
unverified rotation. It also exercises frozen maintenance, concurrent delivery,
destination updates, dependency-gated replacement cleanup, retirement and API-key
replacement. `connector-installation-recovery.test.ts` covers late Granola
identity recovery, missing signing material, repeated disconnect and credential
envelope races. `connector-installation-routes.test.ts` covers authenticated HTTP
roles, validation, secret-preserving replacement, audit replay and event-signing
scope before persistence, automatic 27-event setup under concurrent administrators,
signed admission for every event type, renewed email-watermark retries and partial
provider subscription failures. `connector-maintenance-progress.test.ts` exercises
atomic settlement of two frozen targets, cancellation and stale completions.
`connector-installation-audit.test.ts` exercises Test repair's administrator
audit and distinct authenticated operators across preview, apply, resume and cancel.
Remote providers alone use protocol fixtures.
`connector-installation-teardown.test.ts` verifies both disconnect entry points,
adoption and queue failures, cleanup dispatch classification, domain refusals and
single-count setup telemetry through real workspace and regional storage.
`packages/connectors/src/ashby.test.ts` covers scope separation, dynamic tool
inventory, conservative writes, signatures, pings, and the normalized allowlist.

Live acceptance is outstanding: there is no authorized Ashby test account.
Protocol fixtures establish implementation behavior, not provider compatibility.
The exact remaining checks are tracked in the
[approved PRD plan](PRDs/2026-09-12_connector-installation-lifecycle/plan.md).

## Regional impact

Ashby has a separate deployment at `ashby.rallywith.ai`, using
`apps/api/src/ashby-ingress-worker.ts` and `wrangler.ashby.global.jsonc`. Its public
entry point imports neither the API application nor the connector registry or
agent runtime. Its `/health` verifies its three named dependencies, regional identities and
the Global route table, without provider repair. It looks up an opaque connection's region and forwards unchanged
signed bytes through a named regional binding. The API HTTP receiver is regional
only; the dedicated Worker is the sole shared-host forwarding path. First
deployment requires Global router bootstrap before EU, then dedicated ingress;
see the [deployment guide](api-worker-deployment.md#dedicated-ashby-ingress).
Credentials, verification, Queue
admission, and canonical event processing remain under regional authority.
This first boundary isolates public ingress startup; it does not remove shared
hosted-MCP or lifecycle code from the API bundle. Provider protocol extraction
and emitted-bundle verification must be evaluated separately before claiming an
API startup reduction. The user requested dedicated Workers after API bundle
size/startup had already consumed an engineering day. Aliasing another domain
to the same API Worker was rejected for that reason.

Granola keeps its existing callback/subscription URLs and credentials. A read-only
Cloudflare inspection on 2026-09-12 found no Granola DNS record/custom domain in
`rallywith.ai` or `with-avalon.com`; the existing source registers regional API
webhook URLs. No DNS or deployment was changed by this implementation task.

## Operations

### Operator maintenance

`connector-maintenance-service.ts` freezes a region/provider/version/workspace
selection in regional D1. Preview reads saved installation state and lists each
registration's planned operation without contacting providers. Apply queues only
the operation ID; the existing activity Queue runs the shared installation runner.
New connections are never added to a frozen operation. Per-connection generation
and operation identity fence preparation, repeated invocation, and cancellation.
Completed targets are skipped. Each target update uses an atomic JSON-path write,
so concurrent Queue deliveries cannot overwrite sibling progress. Cancellation
wins against late progress writes. The preview includes exact destinations and
registration intents derived from the deployed declaration; operators supply no
URLs. Destination updates preserve provider IDs. Changed grouping establishes
and verifies replacements before claims can remove older registrations. Event
selection is the intersection of the existing customer grant and the declaration;
a new declared event cannot expand a connection's grant. Granola version 1 retains
its observed destination because its reviewed update supports enabled state only.
A completed operation can contain failed or
customer-action outcomes; inspect its target results rather than equating
completion with every installation being current.

`scripts/connector-maintenance.mjs` accepts `preview`, `apply`, `status`, `resume`,
and `cancel`. Supply the regional API origin and a file containing the existing
Ace operator credential. Preview takes a JSON file with `provider`, `region`,
`version`, and optional `workspaceIds`; omitting `workspaceIds` selects all eligible
connections in that region. Subsequent commands take the returned operation ID.
Administrative installation mutations, including the repair requested by Test,
record the acting administrator in workspace-scoped regional audit records. Operator apply,
resume and cancel requests record the current authenticated operator, action and
operation ID through the same regional structured logger used by Ace demo and
retirement operations. These are request audit records, not proof that every
target succeeded; frozen operation outcomes remain authoritative. Neither audit
path includes credentials or provider content.

`/internal/connector-maintenance` uses `requireDemoOperator` and the `demos`
role. Read-only engineering MCP tools gain no maintenance authority. Deployment
and actual operator execution remain outside this implementation task.

Only the reviewed version present in the deployed provider declaration is accepted.
Unknown provider outcomes and not-yet-adopted Granola connections report customer
action. An administrator's explicit Test adopts an existing Granola connection.

## Changelog

### 2026-09-12 — Reserve and record workspace installations before provider I/O

**What changed:** WorkspaceDO owns installation attempts, exact provider dispatch receipts and separate cleanup authority. Ashby and Granola share one runner; maintenance freezes reviewed registration diffs and updates target outcomes independently. Early Resume leaves unprepared targets to the queued frozen configuration, and setup response recovery opens the existing reservation. New Ashby connections automatically register the documented event catalog, without customer subscription selection.

**Why:** Subscription checkboxes exposed provider plumbing when users should choose automation triggers instead; the user requested automatic coverage on 2026-09-13. The direct Granola create/repair/delete path could neither retain uncertain creates nor clean up after local disablement. A generation that does not advance with credential settlement cannot protect the newer envelope from an in-flight replacement. Repeated disablement must preserve the only credential that can remove the remote endpoint. Adoption or Queue failures must not strand local authority or enabled schedules, and a host-side credential failure must not pretend a provider delete was dispatched.

**Considered and rejected:** Blind create retries, a second legacy Granola mutation path and speculative secret-overlap intervals. None preserves the provider identity and verification evidence needed to reconcile uncertainty. Whole-operation JSON rewrites also lose concurrent target progress. Stamping an operation identity before applying its frozen configuration would make an early Resume silently report the old configuration as current.

**Consequences:** Every late response must settle against its dispatched intent; unknown or unsigned installations require action, never assumed success. Replacement removal waits for verified successors. Cleanup cannot restore ordinary access; credential settlement advances the generation that replacement reads before its envelope, and manual rotation guidance does not mutate state. Test repair records its acting administrator, and operator requests record their current caller rather than attributing later actions to the preview author. Live provider and confidential-event acceptance remain outstanding.

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).
