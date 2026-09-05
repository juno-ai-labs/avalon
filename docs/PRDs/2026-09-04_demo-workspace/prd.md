# Rally demo workspace

> Created 2026-09-04.
>
> An internal operator prepares a fresh, populated workspace for each Rally
> demo and retires its predecessor. Companion: [state.md](state.md).
> Standing contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Evidence: [the spike report, beginning at §0](research.md#0-re-verified-against-main-rally-12710--read-this-first),
> kept in this folder so it cannot outlive its source. The code it describes is
> throwaway and unmerged; it stayed on `spike/demo-workspace-replay-main` at
> `87e73ef`.

## Summary

A presenter opens `CompanyName-demo` and finds the prepared conversations,
people, documents, and attention markers ready to show. Every demo uses a new
workspace. The operator retires the previous demo and creates another; nothing
clears or rewinds the old workspace. The one control says **New demo**, not
**Reset**, and the predecessor is retired only once its successor is ready.

A hand-built `demo-template` workspace holds three demo Google accounts and the
workspace-scoped connections each demo copies, credentials included, so a
presenter who continues the conversation can query Drive and the other connected
providers for real. A small, checked-in conversation pack supplies the seeded
content. Human messages and scripted assistant prose pass through Rally's
production writers. All timestamps use the real clock, and the seeded assistant
prose describes connector work rather than carrying fabricated tool calls.
Preparation ends only when each intended viewer's sidebar and attention state
reflect the pack.

## Motivation

The September 4 meeting settled the demo's scope. Rally needs a repeatable way
to present a populated workspace without carrying the previous presentation's
messages, activity, or background work into the next one. No demo frequency or
capacity requirement was supplied; this proposal needs neither a fleet manager
nor a new metrics system.

The spike establishes that production write paths can seed the object hierarchy
with small, marked production changes, and that retiring one workspace and
creating another prevents leakage. Its current Queue-based result supersedes
the original RPC findings: `reserveChild` creates a provisional directory row,
but content and viewer projections arrive later. Immediately after seeding, the
presenter saw two of three rooms and no waiting item; a read 150 seconds later
showed all three and the expected mention. That observation is evidence of an
incomplete readiness condition, not a proposed wait duration or service target.

Retirement cleared every observed alarm. One retired parent retained three
outbox effects that no longer had an alarm to deliver them. The workspace
drop-fence recorded no drops, so the current run did **not** prove rejection of
effects already handed to the Queue. These are separate requirements: keep the
old objects quiet and prove that an already-queued delivery cannot revive them.

## Goals

1. A presenter receives a new `CompanyName-demo` with the agreed pack fully
   visible, including viewer-specific participation, unread mentions, and
   attention state.
2. Seeded conversations remain ordinary, readable Rally history that a
   continued turn can use without replaying obsolete connector tool names.
3. Replacing a demo permanently closes the old workspace to product work,
   prevents background reactivation, and leaves the new workspace isolated.
4. Each demo owns separate, working connection records: a presenter who asks a
   question mid-demo gets a real answer from the demo accounts' Drive, mail, or
   other connected providers, without any per-demo OAuth.
5. An authorized internal operator can start, inspect, and recover preparation
   without database surgery or mistaking partial work for a ready demo.

## Non-goals

1. **Backdating — rejected for this feature.** Everything is written now and
   reads as recent activity. Supplying historical time risks changing scheduling
   and security behavior and would touch roughly 22 harness timestamp sites in
   `integrations.ts` alone, plus further lease and accounting sites.
   No replay clock, timestamp override, or frozen relative-time display ships.
2. **In-place clearing or reset — rejected for this feature.** A new workspace
   identity avoids undoing transcripts, receipts, loop state, and delayed effects
   beneath an identity that is still receiving work.
3. **Background connector activity during a demo — excluded.** A demo answers
   a question when the presenter asks one; it does not poll, run watches, accept
   webhook ingress, hydrate resources on a schedule, send outbound notifications,
   or start work of its own. The demo accounts' providers are a source the
   presenter can query, not an event stream that can interrupt a presentation
   with mail arriving or a document changing. Nothing here restricts a tool call
   the presenter's own turn makes, or the token refresh that call needs.
4. **Fake tool history — rejected.** No synthetic connector plugins, recorded
   tool results, manufactured plugin activity rows, or simulated durations are
   retained from the spike. Stale tool names in a *seeded* transcript become
   misleading context on continuation; a live turn's own tool calls carry the
   current names and are not affected by this.
5. **A template editor, arbitrary workspace copier, and automated reaper —
   deferred.** One manually maintained template and one versioned pack suffice.
   Retirement preserves old data; it is not deletion or a retention promise.

## Product behavior

### The operator and the presenter

An employee admitted by Ace's existing internal Access policy operates a
**Demos** page in Ace. The presenter may be that employee or another explicitly
selected Rally member. Customers and ordinary workspace owners do not receive
demo administration controls. The regional backend repeats operator
authorization; a workspace name ending in `-demo` grants no authority.

The page offers one control, **New demo**, which asks for the company name and
presenter. There is no second operation: whether a predecessor exists changes
only what the page warns about, not what runs. Where one does exist, the page
names it and its workspace ID and states that it becomes unavailable once the
replacement is ready. The new display name is always `CompanyName-demo`; a
successor may share that name but never its workspace or object IDs. The
operation binds to exact IDs, not a lookup by name. The template and ordinary
workspaces cannot be retirement targets through this surface.

The operator initiates one durable operation. Repeated submission of that
operation returns its existing progress and result. Competing replacement
requests for the same predecessor resolve to the existing replacement or a
visible conflict; they cannot independently retire and publish different
successors. This is operation identity, not a guessed concurrency limit.

| State | What the operator sees | What the presenter can open |
| --- | --- | --- |
| Empty | Company and presenter selection; **New demo** | No new demo yet |
| Checking template | Required accounts, pack, and connection configuration are being checked | The existing demo, if any |
| Creating workspace | New workspace identity has been allocated | The existing demo, if any |
| Copying connections / Seeding conversations | Current phase and completed items from actual receipts | The existing demo, if any |
| Waiting for workspace | Which expected rooms or viewer states have not arrived | The existing demo, if any |
| Retiring previous demo | The exact predecessor and completed retirement steps | The new demo; the predecessor becomes unavailable |
| Ready | `CompanyName-demo` and **Open in Rally** | The populated home screen and sidebar |
| Failed | Failed phase, actionable reason, operation ID, and recovery action | The existing demo, which is still usable |
| Offline | Last known phase labelled as stale; reconnect to retrieve progress | No locally inferred success |

There is no estimated completion time or fabricated percentage. Closing Ace
does not cancel the operation or erase progress. An operator reconnects to the
same operation. A known failure is visible immediately; ordinary projection
delay remains **Waiting for workspace**. The operator can abandon an unfinished
candidate, which retires that candidate and leaves any predecessor untouched.

**A predecessor is retired only after its successor reaches Ready.** Retirement
is irreversible, so performing it first would mean any failure in allocation,
connection copying, seeding, or projection left the operator with no demo at
all — possibly shortly before one is needed. Preparing first inverts that: a
failed preparation costs nothing and the predecessor stays usable. The cost is a
bounded window in which two demo workspaces exist, which the design already
tolerates, since names may repeat, IDs never do, and a candidate is withheld
from discovery until Ready.

Preparation is a real admission state. Candidate demos are withheld from normal
workspace discovery and switching until Ready, and an early direct activation
shows preparation rather than an incomplete sidebar. Internal seeding and
verification retain scoped access. The operator's Ace identity survives the old
workspace's session revocation. Existing desktop revocation behavior removes
only that workspace's credentials and drafts and permits selection of a surviving
workspace; it does not sign the presenter out of every workspace.

### Template and connection copying

`demo-template` is built by hand with **three real demo Google accounts** and
the agreed connector configuration. It exists, in Global, as
`01a06d5d-4624-751e-8269-e7950b51a835`, confirmed against the workspace itself;
that hardcoded UUID identifies it and filters it out of user-facing workspace
discovery, cached switcher entries, and activation offers. Renaming it does not
defeat the filter. This is a
specific exclusion, not a general hidden-workspace product feature; authorized
operators can still maintain the template. The filter is not its security gate.

Each candidate is created through ordinary workspace onboarding, retaining
regional placement, membership, and routing invariants. It receives memberships
for the three demo identities and the presenter as needed. Existing Google
identity subjects remain unchanged; cloning a membership does not duplicate a
Google account or copy a sign-in session. The spike's six synthetic, non-sign-in
personas are scaffolding and are not the account model for this feature.

**The template's connections are workspace-scoped, and the copies are too.**
This is a requirement, not a default. A presenter opens a demo as themselves,
with their ordinary Rally account, while the three demo identities are the cast
in the seeded conversation and never sign in during a demo. A personal
connection "can be used only by its owner principal", and "a work-stream
participant does not expose their personal connections by joining"
([connectors](../../connectors.md#authorization-model)) — so personal copies
would be invisible and unusable to the presenter, who owns none of them. A
workspace connection is an organization capability whose tools reach every work
stream in the workspace and execute as the workspace principal. Rally's
connection scope is independent of Google's sharing model: a workspace-scoped
Google connection still authenticates as the single account that completed
OAuth and reads that account's own Drive, so nothing has to be shared with
anyone. Creating one requires the workspace `owner` or `admin` role
(`connection-service.ts`, `assertScopeAllowed`), which the operator who built
the template already holds.

The backend copies the selected template connections into new destination
connection IDs: connector type, scope, display name, provider account
identifier, granted capabilities, connection configuration, and credential
material. Granted capabilities are preserved, never expanded. An explicit
source-to-destination mapping rewrites workspace and connection references.
Sessions, invitations, watches, schedules, delivery cursors, leases, provider
ingress registrations, error state, and historical effects are not cloned — a
copy starts with no history and no scheduled work of its own.

**Credential material is copied, and copying it requires re-encryption.** The
envelope is AES-GCM with the **connection ID as additional authenticated data**,
not the workspace ID, so ciphertext is not portable between rows. For each copy,
the regional backend:

1. Decrypts the source envelope using its stored key version and the source
   connection ID, through the **non-writing** helper
   (`decryptVersionedCredentialValue`), never `decryptVersionedConnectorCredentials`.
2. Encrypts that plaintext under the active regional key, a fresh IV, and the
   **new destination connection ID** as additional authenticated data.
3. Persists destination ciphertext, IV, and key version with the new row, and
   records the completed mapping without retaining plaintext.

**Step 1's choice of helper is the requirement, not a detail.**
`decryptVersionedConnectorCredentials` opportunistically re-encrypts under the
active key and writes the result back to the row it read whenever the stored key
version is stale. Called on a template connection, it would rewrite the
template's ciphertext, IV, key version, and `updated_at` — silently, as a side
effect of preparing a demo. The non-writing variant takes the same arguments and
returns the same plaintext.

Copying ciphertext unchanged is invalid. Missing keys or an undecryptable
envelope fail preparation with a connection identifier and a repair instruction,
never token contents; both the source and active regional keys must be available
when their versions differ. Template reads do not refresh or revoke provider
grants; template maintenance remains separate from copying. Retiring a demo
never revokes the shared upstream grant, which would also break the template and
every other demo — clones hold independent Rally records against one provider
grant, not independent grants. Google's refresh flow keeps an unrotated refresh
token, so concurrent copies of one grant refresh independently without
invalidating each other; a connector whose provider rotates refresh tokens on
use cannot be shared this way and is not included until that is settled.

### Writing the conversation pack

A backend seeder orchestrates a small schema-validated, versioned pack. It owns
the script and per-action receipts; it does not become another transcript
writer. The pack specifies account roles, ordered human messages, assistant
prose, local artifacts, real mentions, and expected visibility per viewer.

| Seeded fact | Writer |
| --- | --- |
| Work stream and opening message | `WorkstreamObjectCreationService.create` |
| Subsequent human message | `SubstreamAgent`'s `create_message`, via the ordinary product client, as its actual demo member |
| Assistant prose | The ordinary harness/Bind acceptance and settlement path, with an internal scripted provider-output seam |
| Document and attachment | `ResourceService.upload` and `attach_resource`, as an authorized participant |
| Participation, mention, unread state, attention | Consequences of production mutations and their normal projections |

The small marked production seams in the spike establish feasibility, not a
patch to merge wholesale. The retained seam supplies scripted assistant text
and explicit addressing outcomes for seed actions so seeding does not depend
on a live classifier. It carries pack/action identity, not `occurredAt`.
Fixture exhaustion is an explicit failure, never a repeat of the last output.
Every required run must reach its specified outcome; merely ceasing to run,
including a failed run, is not success.

The first pack retains the decision-memo and multiplayer renewal scenarios
demonstrated by the spike. Its onboarding-email room was invented to test a
third directory row and is not approved product copy. The final third scenario
and the mapping of roles to the three accounts are supplied before the pack is
released. Each assistant contribution uses prose such as “I reviewed the Q4
plan in Drive and the pricing discussion in Granola”; it contains the relevant
findings itself and has no fabricated connector call attached. Local documents
referenced in that prose actually exist in the destination workspace.

An actionable question uses a **real** Rally elicitation if the pack includes
one: the current core operation actually opens it, with validated arguments,
and the presenter answers through the ordinary product path. This is not a
replayed fake tool result or a drawn question card. **It is addressed to the
room, not to a person.** The spike added a targeted-user seam to direct a
question at one member; that is a change to the elicitation contract and a
product decision of its own, and this feature does not make it. The pack
composes around a room-addressed question. Connector tool history remains
absent.

Actions are applied in their intended order using real timestamps. They read
as “just now” when freshly written and age normally while the operator waits or
presents. No timestamp is changed to obtain a preferred recency order. Pack
ordering is checked against the production directory's actual ordering.

### Waiting for the viewer projection

The readiness barrier is a read through ordinary directory and attention
surfaces **as every intended viewer**, including the presenter and the three
demo accounts where their expected views differ. The expected result is a
manifest of destination IDs and visible state generated from the pack's
committed action receipts. It checks:

- The complete expected visible room set, settled titles, recency order, and
  participant previews, with no unintended room exposed to that viewer.
- The final work-stream/run state, projected content or latest activity, and
  viewer-specific mention, unread, and unseen flags required by the pack.
- The corresponding home-screen attention count and reason. A visible renewal
  row with a missing waiting item is not Ready.
- Canonical messages, artifacts, and any real open elicitation exist and the
  required runs settled successfully before the projection check can pass.

Directory reads follow pagination; a first-page count is not the barrier.
Verification must not open a work stream as a viewer whose unopened state the
pack preserves: detail reads can set `first_opened_at`. Inspect canonical
content as a designated participant for whom that read has no conflicting
expectation; use non-opening directory/attention reads for the presenter.

The spike's `awaitWorkspaceDirectory` implementation checks only whether an ID
is present, and some seed calls use the author rather than the presenter. It
does **not** implement this readiness contract. Nor do Queue acceptance, an
empty sender outbox, `reserveChild`, or a fixed sleep establish readiness.
Deleted RPC flush methods are not restored. The operation records missing
expectations while polling and publishes Ready only after they all match.

### Retirement and stranded effects

Replacement checks that the template and pack are usable, prepares the
successor to Ready, and only then closes the predecessor. Retirement is a
monotonic, receipt-backed operation; retries resume unfinished steps after
interruption or eviction. It is not the spike's straight-line best-effort walk.

1. Close regional admission using the existing abandonment semantics, without
   calling the final-member-only `leaveWorkspace` path. Revoke old workspace
   access and publish through the existing access-revocation mechanism, which
   addresses a workspace scope but carries one member per message and closes its
   `reason` enum around four values that do not include retirement — so this step
   needs a retirement reason and a per-member fan-out, neither of which exists
   today. Socket closure through that mechanism is best-effort by construction:
   a publish failure is logged and swallowed rather than retried
   ([access revocation](../../access-revocation.md)). That is acceptable here
   and is not the fence. Step 2 is: a socket that survives can no longer do
   anything, because every call it makes is refused. Do not affect the members'
   access to any other workspace.
2. Persist the WorkspaceDO retirement tombstone **before** walking descendants.
   Every inbound call consults one central lifecycle policy. Product reads and
   writes refuse with `workspace_retired`; valid late effects are terminally
   dropped and acknowledged. Only explicitly classified retirement, revocation,
   and read-only operator inspection operations remain permitted.
3. Walk the recorded object graph, including all children of each parent, not
   just substream `0`. Quiesce active work, stop automation schedules and other
   background producers, and retire children before finishing their parents.
   Use real lifecycle transitions with an attributed internal retirement actor;
   do not impersonate an automation's author as the spike did. Empty automation
   lists are not evidence that this part works.
4. Clear stored alarms and suppress every derived alarm candidate on retired
   objects, leaving the platform alarm deleted. Late calls, constructor recovery,
   inherited alarm handling, and continuations admitted before retirement must
   not re-arm an object or publish new product work.
5. Record completion only after the entire enumerated graph is retired and
   quiet. A failed child leaves retirement visibly incomplete and resumable.

**The central gate is new work, and it covers every object in the graph.**
WorkspaceDO has roughly 229 methods and no shared RPC dispatch boundary. Adding
a helper that each method is expected to call, checking only `fetch`, or gating
only the two effect receivers fails this requirement. Introduce a class-level
admission wrapper for the exported callable surface that delegates to the
existing implementation after the single policy check. Mechanically
derive/check coverage against the actual callable surface so a new RPC cannot
silently bypass retirement. Native RPC, HTTP/socket entry, hibernated socket
callbacks, inherited callbacks, and alarm recovery all need coverage. The
concrete wrapping technique must work on real workerd; a local JavaScript proxy
test is insufficient. This requirement does not mandate a new generic RPC
protocol or a rewrite of the domain methods.

**A WorkspaceDO-only gate does not meet this requirement.** The evidence sits in
the children: the spike's `409 workspace_retired` was raised in
`SubstreamAgent.acceptProductRequest`, and the retained outbox it reports was on
a WorkstreamDO. A product write that bypasses the edge — the case Acceptance 5
covers — arrives at a conversation object, which a WorkspaceDO wrapper never
sees. Apply the same wrapper and the same mechanical coverage check to the
conversation objects: the shared `ConversationParentDurableObject` base that
`WorkstreamDO` and `AutomationDO` extend, and `SubstreamAgent`. Retirement
already reaches each of them in step 3; this makes each of them consult what it
was told.

Entry admission alone does not settle an already-running call. The common
mutation/publication and alarm boundary must also prevent a continuation that
crosses retirement from committing new product effects or re-arming. Retirement
completion cannot race a pre-retirement child reservation into an unvisited
descendant. Prove these races rather than claiming that a method-entry check
serializes asynchronous work.

The fence belongs to the permanently retired object identity. Every otherwise
valid late effect addressed to it is dropped, even if its regional authority
generation has advanced. The envelope's existing `generation` is regional and
must not be treated as a workspace epoch. Fresh workspaces never reuse retired
IDs, so this feature needs no new epoch protocol. A dropped effect returns the
terminal acknowledgement shape the consumer expects; throwing a retryable
error would leave dead work circulating.

**Retain stranded outbox rows, inert, for this version.** Retirement records
their counts in its receipt but does not drain them, move them into the new
workspace, or wake the parent to clean them up. The tombstone prevents any
future drain, including after eviction. Operator inspection labels them as
retained effects in a retired object, not pending preparation. This deliberately
accepts storage residue and defers physical collection; it does not declare
delivery successful. Already-enqueued effects take the drop-and-acknowledge
path instead. Alarm clearing remains the guard the Queue spike proved; the
drop path requires separate evidence.

## Impact on the product contract

The work-stream, participation, and regional contracts remain unchanged.
Prepared conversations use the same durable multiplayer objects; viewing does
not add a participant, and connections retain their normal owner and scope.
The exception is an explicitly internal demo execution mode: seeded turns come
from a script rather than a provider, and background connector activity is
suppressed. Connector tools themselves behave normally for a live turn. It adds
no customer reset capability, global inbox, general replay clock, or permission
for a model to fabricate tool receipts.

## Decision log

None yet.

## Key design decisions

1. **September 4: real time and fresh identities.** No backdating and no resets.
   The security risk and harness clock surface outweigh historical appearance;
   fresh objects remove the need to undo a live object graph.
2. **September 4: one hand-built template.** Three demo Google accounts and
   their workspace-scoped connections live in `demo-template`, hidden by
   hardcoded UUID. A
   configurable template-management system adds no value to this first demo.
3. **September 4: prose describes connector work.** Synthetic tool history is
   rejected because its tool names become misleading context on continuation.
4. **Readiness follows each viewer.** The Queue spike supersedes §3's free
   propagation barrier. Row existence and fixed waits are rejected because they
   can open a half-populated sidebar.
5. **Central retirement policy, permanent object tombstones.** Per-method gates
   are too easy to miss; regional generations cannot identify a workspace
   lifecycle. A fresh workspace needs no reversible retirement or local epoch.
6. **Retained, inert outboxes.** Sending stale effects merely to empty storage
   creates work after retirement. Leaving them fenced is the smaller, reversible
   operational choice; a future reaper can remove them independently.
7. **Internal operation with durable progress.** Ace supplies an existing
   operator surface. Per-step receipts cover partial failure without adding a
   general workflow builder, priority queue, or separate administration site.
8. **Connections are copied with their credentials, and they work.** The
   September 4 meeting put the live case directly — a presenter continuing a
   demo conversation and asking something the seeded prose does not answer —
   and answered it with "copy all the users and all the connectors and all the
   tokens… you may have to decrypt them and re-encrypt them on the other side."
   An earlier draft of this PRD generalized the separate decision against fake
   tool calls in *seeded history* into a ban on live connector calls, and then
   dropped credential copying as pointless given that ban. Both were wrong: a
   demo that cannot answer a follow-up is a worse demo, and the two questions
   are unrelated. Seeded history still carries no tool calls, because stale tool
   names mislead a continued turn; a live turn's own calls use current names.
9. **Background connector activity stays suppressed.** Live answers are worth
   having; a demo that polls, accepts webhooks, or fires notifications can
   interrupt a presentation with mail arriving or a document changing, and can
   start work in a workspace nobody is watching. The line is drawn between work
   a demo starts by itself and work a presenter asks for.
10. **Connections are workspace-scoped.** The presenter opens a demo as
   themselves and owns none of the cast's connections; a personal connection is
   usable only by its owner, so personal copies would leave the presenter with
   no connectors at all. Rally's connection scope is unrelated to Google's
   sharing model, so this costs nothing.
11. **The successor is prepared before the predecessor is retired.** Retirement
   is irreversible, so retiring first turns any preparation failure into having
   no demo. The rejected alternative — retire first, so only one demo exists at
   a time — bought tidiness at the price of the failure that actually hurts.
12. **One elicitation contract.** A question is addressed to the room. Making
   elicitations targetable at one participant is a product change with its own
   audience and semantics, and this feature does not need it.
13. **No flag.** The Ace Access policy already limits this surface to internal
   operators; a flag would be a second lock on the same door. Rally's managed
   flags are also presentation-only by definition, so a flag that actually
   stopped creation would first require extending what that table means.

## Data model

Each structure below is new, and each has more than one plausible home. Naming
them here is the point; the choice belongs to the implementation.

- **Retirement tombstone.** Per object, permanent, consulted by the admission
  gate on every inbound call. It has to be readable during constructor recovery
  and after eviction, before any product work is admitted, which argues for the
  object's own SQLite rather than a D1 lookup — but D1 beside `workspaces`
  (where `abandoned_at` already lives) is the other candidate, and retirement
  step 5's resume-after-interruption semantics depend on which is chosen.
- **Operation record and per-step receipts.** One durable operation per
  requested demo, addressed by an identity the operator can resubmit against,
  holding phase, completed steps, failure reason, and the successor's identity.
- **The recorded object graph.** The enumeration retirement walks, captured
  before the walk so that a resumed retirement visits the same descendants.
- **Source-to-destination connection mapping.** Written as connections are
  copied, so a resumed copy neither duplicates a connection nor loses one.
- **Candidate admission state.** What withholds a not-yet-Ready workspace from
  discovery, switching, and activation.

## Regional impact

The initial demo operates in **Global**, the region exercised by the spike.
The template and every clone stay in that region; identities and memberships
use the existing onboarding/discovery control plane. Credentials, conversation
content, artifacts, operation receipts, and object state stay in the owning
region. Ace displays authorized operation metadata and progress, not tokens or
conversation bodies. Credential material is decrypted and re-encrypted only
within the owning region, and no template credentials or demo content cross the
Global/EU boundary.

EU demo creation is deferred until the region's template, keys, and the same
acceptance flows are exercised. General lifecycle code must preserve existing
EU behavior, but the Global spike is not claimed as EU demo verification. See
[regionalization](../../regionalization.md) and
[multiple workspaces](../../multiple-workspaces.md).

## Security and trust model

Demo designation, the template UUID, and seed authority are backend-owned. The
internal operator can copy only the named template into a newly allocated demo;
neither an ordinary product caller nor a model can submit arbitrary seed prose,
impersonated users, source workspace IDs, or credential bytes through a public
route. Pack schema and authorization checks are real controls, never open
placeholders. The dev-only spike routes do not become production endpoints.

Plaintext credentials exist only inside the backend copying operation. They
never enter Ace responses, the renderer, pack files, operation receipts, or
logs. Use the existing envelope and key-rotation rules in
[security](../../security.md#connector-credentials) and
[connectors](../../connectors.md#authorization-model). Preparation reads a
template envelope through the non-writing helper, so copying a demo never
modifies the template it read.

Demo mode suppresses **background** connector activity: polling, watches,
scheduled hydration, connection tests and repair, outbound notifications, and
scheduled work, and ingress cannot start demo work. It does not restrict a tool
call the presenter's own turn makes, or the token refresh that call needs — that
traffic is the point of copying credentials at all. The distinction is between
work a demo starts by itself and work a person asks for while presenting: the
first can interrupt a demo, the second is the demo. A prompt telling the model
which to do is not this boundary. Failure to establish this mode blocks Ready.

A demo therefore holds working credentials to the demo Google accounts and to
nothing else. That containment rests on the template holding only those
accounts' connections, which is why the template is built by hand and why an
operator's own account is never connected to it.

## Agent behavior

The seed adapter replaces the source of assistant output while keeping the
ordinary acceptance, persistence, and settlement path described in
[agent harness](../../agent-harness.md). No connector plugin or new model tool
is added. A real core elicitation, if included, uses its current production
contract rather than a saved wire-name fixture masquerading as execution.

After preparation, ordinary continued turns use the current harness, its
current authorized core surface, **and the demo workspace's connector tools**;
the seed adapter does not remain installed to repeat canned responses. A
presenter who asks a question the seeded prose does not answer gets a real tool
call against the demo accounts' providers, with the current tool names — which
is why the seeded transcript carries no tool calls of its own, and why that
restriction does not extend to a live turn. The connection settings show the
cloned accounts and their scopes, which are live.

The spike found human-only messages visible in the transcript but absent from
the resumed Bind history. Do not call that fixed by seeding. The pack's final
assistant prose or run-starting human message explicitly carries the facts a
continued demo turn needs, including the positions in the renewal discussion.
Acceptance inspects the actual provider-boundary context and exercises a
follow-up dependent on those facts. Repairing general human-only context
propagation is a separate product change if required beyond this pack.

## Provider configuration

Operators prepare the three Google identities and agreed connector grants in
the template before enabling creation. Each demo identity signs into Rally once
to accept its `demo-template` membership: a Rally member requires a Google
subject, and the spike's non-sign-in personas are not the account model here.
Google sign-in alone does not grant Drive, Gmail, or Calendar access. The
template's connections are created at **workspace** scope by an operator holding
its `owner` or `admin` role. No OAuth redirect, webhook registration, or
provider installation is repeated per demo. The source and active regional
credential keys must both be available when their versions differ, because
preparation decrypts each template envelope to re-encrypt it against its copy.
The template UUID is recorded above; the accounts and included connections
remain release prerequisites. Secrets are never checked into the PRD or pack.

The template's connections must authenticate as the demo Google accounts, never
as an operator's own account. A connection created while signed in as a real
company identity would read that identity's Drive, and every demo would carry a
copy of it — which is the exposure the separate demo accounts exist to prevent.

## Rollout

**Creation ships without a feature flag**, the answer
[PRD conventions](../../prds.md#optional-sections) require. The Demos page sits
behind Ace's existing internal Access policy, so the population a flag would
restrict is already restricted; a flag would be a second control over the same
door. Rally's managed flags are additionally presentation-only by their own
definition — they hide Electron surfaces "without changing API availability" —
so a flag that genuinely stopped creation would require extending what that
table means, and `deployment-contract.test.ts` pins it. Withdrawing the surface
is done by removing an operator's Ace access or not deploying the page.

Enable only after the template is provisioned and the acceptance flows below
pass. Deploy the lifecycle/admission and connector-execution boundaries before
admitting any demo preparation. Withdrawing the surface prevents new operations;
it never disables retirement, status/recovery access, or the connector block on
existing demos. A bad pack stops new creation until corrected. Published demos
are retired and replaced rather than patched in place.

The implementing changes update the owning documents for the harness, connector
credentials and copying, multi-workspace admission, access revocation, and
object lifecycle.
[`ace.md`](../../ace.md) is among them: its boundary section requires a new Ace
page's route, environment type, credential, and component reuse to be reviewed
as a new boundary, and the Demos page needs a credential to reach the regional
creation and retirement API. A durable demo module document is added when the
subsystem ships, written to [`module-documents.md`](../../module-documents.md)
and registered in [`docs/README.md`](../../README.md), which is the index that
has to stay complete. This PRD does not rewrite those documents to describe
unimplemented behavior.

## Acceptance

1. **Create and view.** Create a fresh demo from the template. As each intended
   viewer, the directory and attention state match the pack. Open Rally in a
   real window and inspect the home screen, sidebar, transcript, participant
   previews, connector settings, and local document. Timestamps age normally,
   and the seeded transcript carries no tool receipts or plugin activity rows.
2. **Delayed projection.** Withhold viewer effects while allowing provisional
   rows to exist. Preparation stays waiting and early activation cannot reveal
   a partial sidebar. Deliver the effects through the real Queue pipeline;
   Ready appears only after the missing per-viewer content and attention match.
   Verification preserves the presenter's unopened state.
3. **Continue the story, including live.** Answer any real elicitation and post
   a follow-up that depends on the seeded discussion; verify the actual model
   input contains the required facts and no synthetic connector calls or
   results. Then ask something the seeded prose does not answer and requires a
   provider — a document only in the demo account's Drive. The turn executes a
   real tool call, with current tool names, refreshing the copied credential if
   needed, and answers from what it found. Meanwhile no polling, watch,
   scheduled hydration, connection test, outbound notification, or webhook
   ingress runs in that workspace, before or after the turn.
4. **Copy connections.** Destination connections are distinct rows at workspace
   scope, with different IDs and IVs from their sources, carrying the template's
   connector type, account identifier, display name, and granted capabilities.
   Capabilities are preserved, never expanded. Decryption succeeds with the
   destination ID and stored key version and fails with the wrong associated ID.
   Exercise an old source key version and a missing-key failure. The presenter —
   a member who owns none of the cast's connections — sees and can use them.
   **Template rows are byte-identical before and after a copy** — ciphertext, IV,
   key version, and `updated_at` — including in the stale-key case, which is the
   case that catches a copy routed through the writing helper. Sessions, cursors,
   and provider registrations are likewise unchanged by a copy or a retirement.
5. **Replace and isolate.** Prepare W2 to Ready, retire W1, and verify their
   distinct object graphs. Old sessions fail; direct object product writes
   bypassing the edge are refused at the conversation objects, not only at
   WorkspaceDO. Sockets held open against W1 can complete no product operation.
   W2 contains only its own pack. Fail preparation partway and confirm W1 is
   still usable and not retired.
6. **Prove the Queue fence independently.** Hand a real effect to the Queue
   before retiring W1, hold delivery until after retirement, then release it.
   Observe terminal drop and acknowledgement, unchanged directory/attention,
   no retry loop, and no alarm. Repeat delivery and exercise an envelope with a
   later regional generation. An alarm-clearing test alone cannot pass this gate.
7. **Cover the central policy, on every object.** Mechanically check all
   callable entry points on WorkspaceDO **and on the conversation objects** —
   the shared `ConversationParentDurableObject` base and `SubstreamAgent` — and
   exercise native RPC, socket callbacks, inherited alarm recovery, and a
   formerly alarm-refreshing path under workerd. Retire during an admitted
   asynchronous mutation and child reservation. Evict/reload the objects: no
   effect commits, missing descendant, or re-armed alarm survives.
8. **Retained outbox and partial retirement.** Leave effects in a parent's
   outbox, retire it, and inspect the retained count with zero stored/platform
   alarms. Include an automation and non-main children. Interrupt retirement
   mid-walk, resume from receipts, and prove no delivery or activation resumes.
9. **Recover preparation.** Disconnect the operator during cloning and seeding;
   reconnect and retry the same operation. It creates no duplicate messages,
   connections, workspaces, or replacement operations. A failed required run or
   clone never becomes Ready. Abandoning a candidate retires it before a fresh
   attempt. Hidden-template and ordinary-workspace retirement attempts fail.

Runtime checks use real workerd, Durable Objects, and Queues; credential and
query checks use the real schema and encryption helpers. Follow
[testing](../../testing.md): prove each integration behavior can fail with a
production mutation, then revert it. Visual acceptance follows
[the real-window procedure](../../dev-environment.md#driving-and-screenshotting-it).
Test deadlines are not product readiness guarantees.

## Open questions

- **Pack inputs — block the first released demo.** Supply the three account
  identities, the included connection list, the final third scenario, and the
  role/presenter mapping. The spike's six personas and improvised middle room do
  not fill these gaps by default. The template UUID is settled and recorded under
  Template and connection copying.

  These block the *released* pack, not the build. The pack is versioned data
  behind a schema, so the seeder, the readiness barrier, retirement, connection
  copying, and the Ace surface are all built and proved against a placeholder
  pack carrying the two settled scenarios — the decision memo and the multiplayer
  renewal — and the real one is swapped in when its inputs arrive. The one risk
  in that order is a third scenario needing a shape the schema cannot express;
  the two settled scenarios are the schema's proving ground against it.
- **Granola's connection mode — blocks the connection list, not the design.**
  Granola's workspace mode takes an administrator-created Workspace API key
  rather than the personal OAuth flow, so including it in the template is a
  different setup task from Drive and Gmail. Whether the first pack includes it
  is open.
- **Wait policy — handed to the team, not guessed.** There is no promised
  preparation deadline. A proposed `DEMO_PROJECTION_WAIT_TIMEOUT_MS` is defined
  once at the readiness coordinator, defaults to the open value `+Infinity`
  with a finiteness guard (`LIMIT UNSET`), and, if configured, moves the operation
  to a visible wait-exceeded state with resumable verification. It must never
  report Ready or pass infinity to a timer. Queue delay can otherwise leave
  repeated reads running until an operator intervenes; choosing a deadline
  trades that cost against falsely failing a healthy but slow projection.
  The team supplies any finite deadline and polling cadence using
  `reads ≈ viewers × pages per check × elapsed time / polling interval` plus
  attention reads. The spike's 150-second observation is not the chosen number.
  No new retry ceiling, pack-size cap, demo quota, cleanup interval, or
  simulated-duration limit is inherited from the throwaway code.
