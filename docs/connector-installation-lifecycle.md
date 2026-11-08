# Connector installation lifecycle

Workspace event connections use a durable installation record alongside the
connection's encrypted credentials. The record coordinates provider registrations
without assigning that authority to personal MCP authorization. Ashby, Fireflies
and Granola use the same execution path; ordinary tool activation remains in
[connectors](connectors.md) and [hosted MCP](hosted-mcp-connectors.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/connector-installation.ts` | Public installation and registration state, without credential values. |
| `packages/connectors/src/installation.ts` | Provider-management facet and explicit automatic/manual support. |
| `packages/connectors/src/{ashby,fireflies,granola}.ts` | Documented provider calls and manual recovery instructions. |
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
workspace connections and settles on the reservation it finds: for Ashby it
opens that installation's window, and for Granola, which has none, it closes
setup and leaves the refreshed row. Either way it does not change the attempt
identity and submit corrected inputs against that reservation. A failed
recovery lookup blocks further setup until Find existing installation succeeds.
The main management window shows plain connection status, the last event, and
explicit Test; trouble states offer Get help. Technical diagnostics, provider IDs,
URLs, key replacement, signing guidance and reconciliation live under Advanced.
Subscription details are collapsed separately so a 27-event installation does
not bury the recovery controls. Opening Advanced performs no mutation.
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
the same transaction that captures a separate encrypted cleanup snapshot. A
registration with no provider identity that was never dispatched — `pending`,
or `failed` because the provider refused it or nothing was sent — settles as
removed in that transaction; one whose create outcome is unknown waits for the
administrator. The connections list then shows the disconnected connection
only while its installation is unsettled: not yet `disconnected`, and its
cleanup credential not forgotten. Manage events, where it is offered, is
reachable only from the row, so the row stays for a removal still queued, a
webhook only the administrator can find, or a disconnect that never reached the
object, and leaves once the removal settles or the administrator forgets the
cleanup credential. Only a
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

An administrator can replace the API key in Manage events → Advanced, for the
providers that window is offered over. Read-only provider
validation precedes an atomic replacement fenced by installation generation.
Credential settlement advances that generation, and replacement reads the
generation before reloading the envelope it will preserve. Existing signing material and registration IDs
survive; an unknown dispatched operation
stays unknown. Neither a stale replacement nor a disabled connection can regain
ordinary credentials. Explicit Test still runs repair before healthCheck; this
credential replacement does not make automatic health or inventory a repair path.

For providers without verified signing cutover, replacement is manual:
disconnect, finish removal of exact registrations, then connect again, with a
delivery gap in between. That sequence is no longer written on screen — an
administrator reading a product's settings is not being asked to run a webhook
console — so it lives here instead. Automatic rotation is reserved for facets
with authenticated cutover evidence.

### Who gets a window

**`ConnectorEventConsoleProviders` in `@rally/contracts` is the list, and Ashby
is the only entry.** It is a different question from
`ConnectorInstallationProviders`, which says the provider has an installation at
all: every installation behind either list keeps its subscriptions, its ingress
and its activity, and the runner, the object and the maintenance paths described
above do not read the console list at all. Only the settings row does.

Ashby is on it because its administrator is the person who issued the key and
goes to the Ashby dashboard when a subscription needs inspecting, so a window
naming the exact destination and registration ID is the thing they came for.
Granola and Fireflies are not: their installations settle without anybody
looking, so the window offered a status line and a Test over machinery no
administrator had asked to see.

What a provider loses with the window is the manual recovery beside it —
replacing the organization API key, reconciling an unconfirmed create, retrying
cleanup, Test itself. For Granola, a key that must change is now a connection
made afresh: disconnect and connect again, which is the same sequence the
providers without verified signing cutover already walk.

### The all-manual provider

**Fireflies accepts no new workspace connection.** One administrator's key is
every member's read of every meeting it can see, so the scope is closed in
`connectableScopes`; [`connectors.md`](connectors.md#fireflies) has why. The
installations behind that door keep running, which is why this section is
written in the present tense — but nothing creates another, and the desktop
offers no **Manage events** window over one, as it now offers none over
Granola's.

Fireflies is the worked example of a provider that can automate none of this.
It exposes no webhook create, inspect, update or delete operation anywhere in
its API — only a dashboard page — so its facet declares create, update, remove
and rotate **manual**, and inspect and reconcile **unsupported**. Three
consequences follow without any Fireflies-specific code in the runner. Its
verifying delivery is usually the dashboard's test event rather than a meeting;
[`connectors.md`](connectors.md#fireflies) has how the ingress treats it.

A manual create never reaches `management.create`: the runner settles the step
as action required carrying the facet's `manualInstructions`. Because that path
also never reaches `management.validate`, setup validates the pasted credential
itself before reserving anything, so a rejected key leaves no connection behind
rather than sending an administrator off to a provider dashboard on behalf of a
key that will not work. Setup returns the endpoint URL and the host-generated
signing secret exactly once, in the response that created them; a replayed
setup returns the existing installation and no secret, and a lost secret is
replaced by reconnecting rather than re-revealed.

Nothing but a delivery can then establish that the registration exists.
Inspection is what makes every other provider's registration current, so an
installation waiting for one would sit in action required forever while events
arrived perfectly well. The ingress hook that records a verified delivery
therefore also marks such a registration — and the installation with it —
current, with the delivery time as `verifiedAt`. It is keyed on the facet's
support declaration, never on a provider name: what makes a delivery sufficient
is that nothing else is available, and the facet is where that is stated. A
disabled connection is excluded, so a late delivery cannot restore an
installation an administrator removed.

A fleet maintenance preview that changes such a provider's destination or event
set lists every one of its installations as customer action and applies nothing.
Disconnect leaves cleanup pending with no provider identity to remove, so the
management window says the administrator has to delete the registration in the
provider's dashboard instead of offering a retry that could do nothing; a
delivery to the retired route is rejected, so a webhook left behind is harmless.

Existing Granola workspace connections are adopted on explicit Test or disconnect.
Adoption retains the connection ID, plugin ID, encrypted envelope and secret, and
records the existing provider webhook ID. It creates no subscription. An absent
or mismatched registration requires attention. The existing note event
subscription is inspected against the three events Granola defines. All Granola provider repair and removal now use
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
- A delivery verifies a registration only where the facet says create is manual
  and inspect unsupported. Letting one stand in generally would replace real
  inspection — which compares destination, events and enabled state — with the
  weaker claim that something signed correctly once.

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
The connecting administrator authorizes organization event notifications for the
Rally workspace. Normalized Ashby events use the existing workspace audience and
can trigger matching automations through the ordinary Queue and occurrence-dedupe
path. There is no provider-acceptance toggle or special Ashby automation gate.
Personal MCP remains independently authorized. Raw provider fields are not added
to normalized summaries or trigger messages. Actual provider compatibility still
requires an authorized Ashby organization; unavailable access does not disable
this implemented automation path.

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

Granola's public API defines three note events — `note.access_granted`,
`note.edited`, `note.generated`; a regenerated summary is delivered as
`note.edited`. Version 1 registers exactly those, inspection compares against
them, and repair only patches `enabled`. A create the provider refuses with a
4xx settles as a failed step that Test re-dispatches; only an outcome the
provider did not answer — a timeout, a 5xx, an unreadable response — is unknown.

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
`connector-installation-fireflies.test.ts` drives the all-manual path end to end
on real workerd, over an installation it seeds the way setup left one before the
scope closed: the installation moving from action required to current on its
first verified delivery, unsigned/mis-signed/stale/unsubscribed posts writing
nothing and verifying nothing, a replayed delivery admitting once, the region
gate, and the refusal of a new workspace connection by route and by service.
`packages/connectors/src/fireflies.test.ts` covers the tool wire shapes and
bounds, the provider's in-body error codes, and signature verification.

Live acceptance is outstanding: there is no authorized Ashby test account.
Protocol fixtures establish implementation behavior, not provider compatibility.
The exact remaining checks are tracked in the
[approved PRD plan](PRDs/2026-09-12_connector-installation-lifecycle/plan.md).

## Regional impact

Granola keeps its existing callback/subscription URLs and credentials. A read-only
Cloudflare inspection on 2026-09-12 found no Granola DNS record/custom domain in
`rallywith.ai` or `with-avalon.com`; the existing source registers regional API
webhook URLs. No DNS or deployment was changed by this implementation task.

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

### 2026-09-21 — The events console is Ashby's alone

**What changed:** `ConnectorEventConsoleProviders` in `@rally/contracts`
declares which providers settings shows an events window over, and Ashby is its
only entry. A Granola organization connection's row no longer offers **Manage
events**, and Granola setup that loses its response now closes on the
installation it recovered instead of opening that window onto it. Nothing about
the installation itself changed: the runner, the ingress, the maintenance paths
and the object's authorization read the installation-provider enum, never this
list.

**Why:** Granola registers, inspects, updates and removes its webhooks through
its own API, so the window over it settled on its own and showed a status line,
a last-event timestamp and a Test over machinery nobody had asked to see — a
webhook console rather than a product, which is the same judgement that removed
subscription checkboxes from setup and the signing-key guidance from the window.
The desktop already had to answer "does this provider still get the window" for
Fireflies, and answered it by reading the catalog's scopes: true only by
coincidence, since Fireflies' window went away with its workspace scope while
Granola keeps its scope and loses the window.

**Considered and rejected:** Keeping the window and hiding the controls that do
not apply, which leaves an administrator opening a dialog to read one sentence.
Closing Granola's workspace scope the way Fireflies' was closed — that is a
decision about who may read whose meetings, not about a console, and nobody has
made it.

**Consequences:** A Granola organization connection has no in-product way to
replace its API key, reconcile an unconfirmed create, retry cleanup, or run
Test; its row keeps **Delete** and **Disconnect**. A workspace whose Granola key
must change disconnects and connects again. The API paths are unchanged and
still serve those actions, so restoring the window is adding one string back to
the list. A future provider with an installation gets no window unless it is
named there, which is the decision being asked for rather than a default.

### 2026-09-16 — A removed connection leaves the list once its installation is settled

**What changed:** `GET /connections` no longer returns a disabled connection
whose installation is settled — `disconnected`, or its cleanup credential
forgotten — or that has no installation at all. A disabled row whose
installation is still unsettled stays, so Manage events stays reachable. The
object answers the list's question in one `connectorInstallations` hop for
every disabled candidate, and a read that fails keeps every candidate rather
than failing the list. Disconnect now settles a registration that has no
provider identity and was never dispatched — `pending`, or `failed` — as
removed instead of leaving it waiting for an inspection nobody can perform.
Manage events offers Retry cleanup only for a verified provider identity, the
one kind the cleanup runner will act on.

**Why:** A removed connection sat in the table for good, badge reading
"disabled". The first cut of this rule kept a row only while Rally itself could
remove the webhook, and dropped the rows where the administrator has to act —
a create whose outcome was never learned may be live at the provider under an
identity Rally does not hold, and the notice written for exactly that case was
reachable only from the row. Keying on the installation being unsettled keeps
those, and also keeps a row whose disconnect never reached the object, which
`disable` marks disabled regardless; hiding that one would leave live
registrations behind an invisible connection.

**Considered and rejected:** Keeping a forgotten-cleanup row so its provider
ids stay readable. Forgetting is the one explicit way to say "I have dealt with
this", and a row that can never leave is the complaint this change answers; the
control's caption now says to copy the ids first. Also rejected: a read per
disabled row, which grows with every reconnect a workspace has ever made.

**Consequences:** A row that lingers after removal means the installation is
not settled: a removal still queued or refused, a webhook only the
administrator can remove, or a disconnect that did not complete. Reading the
installation list is the only new object method; it returns what exists and
omits what does not.

Shipped in the pull request for this change.

### 2026-09-15 — A create the provider refused is a failed step, not an unknown one

**What changed:** When `management.create` throws a `ConnectorError` whose
`details.status` is 400, 401, 403, 404 or 422, the runner settles the step
`failed`, with the provider's status and bounded message on the registration,
and Test re-dispatches it. Every other thrown create — a timeout, a 5xx, a
response that could not be parsed — stays `unknown`, as before. The validation
read before the create is not the create: a key refused there stays a failed
inspection. Test runs a managed repair before the credential door and loads the
envelope it checks after the repair, so a retried create is verified against the
endpoint it just registered. Granola's version 1 registers the three events its
API defines.

**Why:** The runner marked any thrown create unknown, and unknown creates are
deliberately never retried. That is right for a lost response, where an
endpoint may exist that a retry would duplicate. It is wrong for a 4xx, which
the provider sent instead of acting: nothing was registered, there is nothing
to inspect, and the administrator was left with "the provider operation may
have completed", a Test that changed nothing, and no way to learn that the
request had named an event Granola does not define.

**Considered and rejected:** Retrying every failed create on Test, which is the
blind retry this lifecycle exists to prevent. Also rejected: proving an unknown
create did nothing by listing the provider's endpoints and matching the
destination, since a listing may redact the URL of an endpoint the caller did
not create.

**Consequences:** A registration refused for a cause that has since been fixed
— a corrected request, a key given the permission, a plan that now includes
webhooks — recovers with one press of Test. A create recorded as unknown before
this change stays unknown; that connection is disconnected and connected again.

PR [#779](https://github.com/juno-ai-labs/avalon/pull/779).

### 2026-09-13 — A verified delivery is the evidence a manual registration cannot otherwise produce

**What changed:** `receiveConnectorInstallationEvent` takes the provider facet's
create/inspect support declaration alongside the delivery, and where create is
manual and inspect unsupported it now marks the registration and its
installation current with the delivery time as `verifiedAt`, instead of only
advancing the last-received time. Setup additionally validates a pasted
credential before reserving anything when create is manual, and returns the
endpoint and host-generated signing secret once for the administrator to carry
to the provider.

**Why:** Fireflies is the first real provider with no webhook API at all. Every
other registration becomes current by being inspected; there is nothing to
inspect here, so its installation would have read **Action required** forever
while meetings arrived correctly — Settings saying delivery was broken while the
activity log filled up. A delivery is also stronger evidence than an inspection:
it is signed with the secret Rally generated, so it proves the registration
exists, points at Rally, and carries the right key, which reading a row back
does not.

**Considered and rejected:** A per-provider branch in the ingress hook, which
would need editing again for the next such provider. A checkbox in Rally's setup
form standing in for verification, which would report meetings flowing when none
can. Driving the provider's dashboard by browser automation. Validating the key
inside the runner as automatic providers do, which a manual create never
reaches.

**Consequences:** A facet that declares create manual and inspect unsupported is
declaring that its first verified delivery is its verification; nothing else
about the lifecycle changes for it. A delivery verifies only the registration
whose signing secret actually checked the bytes — the ingress names it — so a
grouped provider is unaffected and a `single_event` one cannot have a delivery
for one event vouch for a subscription nobody ticked. A disabled connection is
excluded, so a late delivery cannot revive a removed installation, and a claimed
step keeps its registration until it settles.

Three things follow for a provider that automates nothing. Its registrations
carry no provider identity, so disconnect leaves cleanup pending with nothing
Rally can remove, and the management window says so rather than offering a retry
that cannot act. `repair` schedules no step for it, so the installation's state
is recomputed from its registrations instead of being told work is queued —
otherwise Test moved a working installation to **Updating** and nothing ever
settled it back. And reconciling a provider id is refused where the facet
declares `reconcileCreate: "unsupported"`: storing one would make the
registration read as a webhook Rally created, and the cleanup advice would start
offering to delete it through an API the provider does not have.

**What a future change must respect:** `registrationSupport` and
`registrationKey` on the delivery are deliberately optional. A deploy is not
atomic, so during the rollout window an older Worker calls the newer object
without them; requiring either would reject a delivery that used to be accepted.
Absent means "this establishes nothing", which is exactly what that older Worker
expects. The gate they feed is on every provider's delivery path, including
Ashby's, and `apps/api/test-workers/connector-installation-fireflies.test.ts`
holds a test that fails if it is removed.

PR #738. Design:
[Fireflies connector](PRDs/2026-08-14_fireflies-connector/prd.md).

### 2026-09-12 — Reserve and record workspace installations before provider I/O

**What changed:** WorkspaceDO owns installation attempts, exact provider dispatch receipts and separate cleanup authority. Ashby and Granola share one runner; maintenance freezes reviewed registration diffs and updates target outcomes independently. Early Resume leaves unprepared targets to the queued frozen configuration, and setup response recovery opens the existing reservation. New Ashby connections automatically register the documented event catalog, without customer subscription selection. The management window puts status and explicit Test first; provider diagnostics and recovery controls are advanced.

**Why:** A registration-level console overwhelmed ordinary connection management, so technical controls now require opening Advanced. Subscription checkboxes exposed provider plumbing when users should choose automation triggers instead; the user requested automatic coverage on 2026-09-13. The direct Granola create/repair/delete path could neither retain uncertain creates nor clean up after local disablement. A generation that does not advance with credential settlement cannot protect the newer envelope from an in-flight replacement. Repeated disablement must preserve the only credential that can remove the remote endpoint. Adoption or Queue failures must not strand local authority or enabled schedules, and a host-side credential failure must not pretend a provider delete was dispatched.

**Considered and rejected:** Blind create retries, a second legacy Granola mutation path and speculative secret-overlap intervals. None preserves the provider identity and verification evidence needed to reconcile uncertainty. Whole-operation JSON rewrites also lose concurrent target progress. Stamping an operation identity before applying its frozen configuration would make an early Resume silently report the old configuration as current.

**Consequences:** Every late response must settle against its dispatched intent; unknown or unsigned installations require action, never assumed success. Replacement removal waits for verified successors. Cleanup cannot restore ordinary access; credential settlement advances the generation that replacement reads before its envelope, and manual rotation guidance does not mutate state. Test repair records its acting administrator, and operator requests record their current caller rather than attributing later actions to the preview author. The user explicitly authorized workspace automation for organization events; live provider compatibility remains unverified without an Ashby organization.

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).
