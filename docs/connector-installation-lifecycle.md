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

An administrator chooses the approved event set and provides a provider API key
in Settings. Before provider I/O, one WorkspaceDO transaction binds the setup
attempt to the administrator and a keyed digest of normalized inputs, reserves a
stable connection ID, and saves encrypted credentials plus registration intents.
Repeated setup with the same identity resumes the reservation; changed inputs or
a competing active workspace installation are refused. Ashby also has partial
unique indexes for its active personal-owner and workspace cardinality.

The existing activity Queue carries only region, workspace and connection IDs.
The runner claims each step before provider I/O. It records returned provider IDs
before inspection; successful creation alone does not establish current delivery.
Inspection compares the recorded identity, destination, approved events and enabled
state. An explicit repair can enable a disabled registration, followed by another
inspection. Health checks and tool inventory never run this repair path.

A lost create response remains unknown. Queue redelivery cannot create another
registration. The administrator inspects the exact destination in the provider
and supplies an existing ID for verification. An interrupted dispatched step is
made explicitly unknown by repair before recovery proceeds. Unsupported rotation
currently produces action required and preserves active verification material;
neither provider advertises automatic signing-secret cutover.

Disconnect disables the ordinary connection and clears its credential access in
the same transaction that captures a separate encrypted cleanup snapshot. Only a
claimed removal step for an exact recorded provider ID can obtain that snapshot.
It cannot refresh tokens, discover tools, create, update, or reactivate a connection.
Generation checks precede provider I/O and settlement. A create response arriving
after disconnect is recorded for removal. Successful removal clears the snapshot;
Forget local cleanup credential clears it explicitly and invalidates pending work.
Retry cleanup refuses to start again once that credential has been forgotten.

An administrator can replace the API key in Manage events. Read-only provider
validation precedes an atomic generation-fenced envelope replacement. Existing
signing material and registration IDs survive; an unknown dispatched operation
stays unknown. Neither a stale replacement nor a disabled connection can regain
ordinary credentials. Explicit Test still runs repair before healthCheck; this
credential replacement does not make automatic health or inventory a repair path.

For providers without verified signing cutover, the UI describes the supported
manual replacement: disconnect, finish removal of exact registrations, then
connect again. It explicitly names the intervening delivery gap. Automatic
rotation is reserved for facets with authenticated cutover evidence.

Existing Granola workspace connections are adopted on explicit Test or disconnect.
Adoption retains the connection ID, plugin ID, encrypted envelope and secret, and
records the existing provider webhook ID. It creates no subscription. An absent
or mismatched registration requires attention. The four existing note event
subscriptions remain unchanged. Its adapter's legacy repair/revoke methods defer
to lifecycle ownership when the connection carries `installationLifecycle: 1`.

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
  customer selection, never arbitrary operator payloads.
- Granola adoption preserves existing subscriptions and verification material;
  replacing its webhook would introduce an unverified delivery gap.

## Boundary

WorkspaceDO owns installation state. Regional D1 holds opaque ingress routing;
R2 stores signed payloads in the owning region. No second activity pipeline is
introduced. Ashby workspace connections expose zero REST recruiting tools.
Ashby currently normalizes only application, candidate and job IDs with host
first-observation time; raw provider content is not promoted to names or summaries.
The approved confidential-payload authorization review remains a release gate:
normalized Ashby events currently have restricted visibility and do not run
workspace automations. This is not launch completion.

Fleet maintenance uses the existing Ace `demos` operator credential identified
by the user. The new route is repository implementation, not a deployed permission
grant or authorization to run a fleet operation. Read-only inspection credentials
remain insufficient. The generic signing-key preparation/promotion protocol and
frozen maintenance service do not make manual provider cutovers verified.

## Operator maintenance

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
`/internal/connector-maintenance` uses `requireDemoOperator` and the `demos`
role. Read-only engineering MCP tools gain no maintenance authority. Deployment
and actual operator execution remain outside this implementation task.

Only the reviewed version present in the deployed provider declaration is accepted.
Unknown provider outcomes and not-yet-adopted Granola connections report customer
action. An administrator's explicit Test adopts an existing Granola connection.

## Failure modes and limits

Provider validation failures before a mutation are failed steps. Uncertain
mutations require inspection, not blind replay. Missing credentials, redacted
provider destinations, unsupported operations and version mismatches must stay
visible. Queue infrastructure failures use existing retries and DLQ handling.
A locally disabled connection refuses ingress even while provider deletion is
pending. If the cleanup credential was revoked or forgotten, the administrator
must remove the recorded webhook in the provider dashboard.

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
replacement. Remote providers alone use protocol fixtures.
`packages/connectors/src/ashby.test.ts` covers scope separation, dynamic tool
inventory, conservative writes, signatures, pings, and the normalized allowlist.

Live acceptance is outstanding: there is no authorized Ashby test account.
Protocol fixtures establish implementation behavior, not provider compatibility.
The exact remaining checks are tracked in the
[approved PRD plan](PRDs/2026-09-12_connector-installation-lifecycle/plan.md).

## Dedicated connector ingress

Ashby has a separate deployment at `ashby.rallywith.ai`, using
`apps/api/src/ashby-ingress-worker.ts` and `wrangler.ashby.global.jsonc`. Its public
entry point imports neither the API application nor the connector registry or
agent runtime. It looks up an opaque connection's region and forwards unchanged
signed bytes through a named regional binding. Credentials, verification, Queue
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

## Changelog

### 2026-09-12 — Reserve and record workspace installations before provider I/O

Maintenance now previews reviewed registration diffs and writes target progress
atomically because replaying a saved version without a concrete diff could miss
a destination migration, while whole-document progress writes could erase a
concurrent target result. Replacement removal depends on verified successor
registrations. API-key replacement preserves subscription/signing identity and
fences stale completions, avoiding a disconnect solely to recover credentials.
Explicit repair retains pending removals and their verified-replacement dependencies;
otherwise Test could keep an obsolete webhook alive. Already removed registrations
and unresolved signing-key cutovers are not revived by repair.
Unsupported configuration versions and forgotten cleanup credentials produce
explicit action rather than silent pending work.

Ashby's independent personal and workspace modes require explicit provider
registration ownership. The former direct Granola create/repair/delete path
could not retain uncertain creates or authorize cleanup after local disablement.
The shared runner therefore uses WorkspaceDO transactions and generation-fenced
receipts, while keeping credential authorization and Queue event admission in
their existing subsystems. Provider create retries and speculative secret-overlap
intervals were rejected because neither is established by the verified protocols.
