# Rally demo workspace

> Created 2026-09-04.
>
> An internal operator prepares a fresh, populated workspace for each Rally
> demo and retires its predecessor. Companion: [state.md](state.md).
> Standing contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Evidence: [spike report, beginning at §0](https://github.com/juno-ai-labs/avalon/blob/87e73efbc8944a9bee990d2d8deb8dbe6038d28a/SPIKE-REPORT.md#0-re-verified-against-main-rally-12710--read-this-first)
> and [working spike code](https://github.com/juno-ai-labs/avalon/tree/87e73efbc8944a9bee990d2d8deb8dbe6038d28a/apps/api/src/spike),
> from `spike/demo-workspace-replay-main`.

## Summary

A presenter opens `CompanyName-demo` and finds the prepared conversations,
people, documents, and attention markers ready to show. Every demo uses a new
workspace. The operator retires the previous demo and creates another; nothing
clears or rewinds the old workspace. The control says **Create demo** or
**Replace demo**, not **Reset**.

A hand-built `demo-template` workspace holds three demo Google accounts and the
connector credentials each demo copies. A small, checked-in conversation pack
supplies the content. Human messages and scripted assistant prose pass through
Rally's production writers. All timestamps use the real clock, and assistant
prose describes connector work without fabricating tool calls. Preparation ends
only when each intended viewer's sidebar and attention state reflect the pack.

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
4. Each demo owns separate connection records with correctly re-encrypted
   credentials, preserving the template accounts' ownership and scopes.
5. An authorized internal operator can start, inspect, and recover preparation
   without database surgery or mistaking partial work for a ready demo.

## Non-goals

1. **Backdating — rejected for this feature.** Everything is written now and
   reads as recent activity. Supplying historical time risks changing scheduling
   and security behavior and would touch roughly 22 harness timestamp sites.
   No replay clock, timestamp override, or frozen relative-time display ships.
2. **In-place clearing or reset — rejected for this feature.** A new workspace
   identity avoids undoing transcripts, receipts, loop state, and delayed effects
   beneath an identity that is still receiving work.
3. **Live connector calls during a demo — excluded.** Seeded prose and local
   artifacts carry the story. Credential cloning does not authorize polling,
   refresh, tool execution, provider writes, or webhook-driven demo activity.
   A live-integration demo requires a separate decision.
4. **Fake tool history — rejected.** No synthetic connector plugins, recorded
   tool results, manufactured plugin activity rows, or simulated durations are
   retained from the spike. Stale tool names in history confuse continued turns.
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

With no prior demo, the page asks for the company name and presenter and offers
**Create demo**. With an existing demo, **Replace demo** identifies its name and
workspace ID and explains that the old workspace becomes unavailable. The new
display name is always `CompanyName-demo`; a replacement may share that name
but never its workspace or object IDs. The operation binds to exact IDs, not a
lookup by name. The template and ordinary workspaces cannot be retirement
targets through this surface.

The operator initiates one durable operation. Repeated submission of that
operation returns its existing progress and result. Competing replacement
requests for the same predecessor resolve to the existing replacement or a
visible conflict; they cannot independently retire and publish different
successors. This is operation identity, not a guessed concurrency limit.

| State | What the operator sees | What the presenter can open |
| --- | --- | --- |
| Empty | Company and presenter selection; **Create demo** | No new demo yet |
| Checking template | Required accounts, pack, and stored credential envelopes are being checked | The existing demo, if any |
| Retiring previous demo | The exact predecessor and completed retirement steps | The old demo becomes unavailable; the replacement is not offered |
| Creating workspace | New workspace identity has been allocated | No partially populated demo |
| Copying connections / Seeding conversations | Current phase and completed items from actual receipts | Preparation state only |
| Waiting for workspace | Which expected rooms or viewer states have not arrived | Preparation state only |
| Ready | `CompanyName-demo` and **Open in Rally** | The populated home screen and sidebar |
| Failed | Failed phase, actionable reason, operation ID, and recovery action | No Ready link for the failed candidate |
| Offline | Last known phase labelled as stale; reconnect to retrieve progress | No locally inferred success |

There is no estimated completion time or fabricated percentage. Closing Ace
does not cancel retirement or erase progress. An operator reconnects to the
same operation. A known failure is visible immediately; ordinary projection
delay remains **Waiting for workspace**. The operator can abandon an unfinished
candidate, which retires it before another fresh attempt. Retiring a predecessor
is irreversible: failure while preparing its successor does not reactivate it.

Preparation is a real admission state. Candidate demos are withheld from normal
workspace discovery and switching until Ready, and an early direct activation
shows preparation rather than an incomplete sidebar. Internal seeding and
verification retain scoped access. The operator's Ace identity survives the old
workspace's session revocation. Existing desktop revocation behavior removes
only that workspace's credentials and drafts and permits selection of a surviving
workspace; it does not sign the presenter out of every workspace.

### Template and credential cloning

`demo-template` is built by hand with **three real demo Google accounts** and
the agreed cloned connector credentials. One hardcoded UUID identifies it and
filters it out of user-facing workspace discovery, cached switcher entries,
and activation offers. Renaming it does not defeat the filter. This is a
specific exclusion, not a general hidden-workspace product feature; authorized
operators can still maintain the template. The filter is not its security gate.

Each candidate is created through ordinary workspace onboarding, retaining
regional placement, membership, and routing invariants. It receives memberships
for the three demo identities and the presenter as needed. Existing Google
identity subjects remain unchanged; cloning a membership does not duplicate a
Google account or copy a sign-in session. The spike's six synthetic, non-sign-in
personas are scaffolding and are not the account model for this feature.

The backend copies only the selected template connection configuration and
credential material into new destination connection IDs. Personal connections
remain owned by the corresponding demo account; workspace connections remain
workspace-scoped. Granted capabilities are preserved, never expanded. An
explicit source-to-destination mapping rewrites workspace, owner, and connection
references. Sessions, invitations, watches, schedules, delivery cursors, leases,
provider ingress registrations, and historical effects are not cloned.

Adam's re-encryption concern is mandatory behavior. The existing credential
envelope uses AES-GCM with the **connection ID as additional authenticated
data**, not the workspace ID. For each copy, the regional backend:

1. Decrypts the source envelope using its stored key version and source
   connection ID, using the existing version-aware credential helpers.
2. Encrypts that plaintext using the active regional key, a fresh IV, and the
   **new destination connection ID** as additional authenticated data.
3. Persists destination ciphertext, IV, and key version with the new scoped row,
   and records the completed mapping without retaining plaintext.

Copying ciphertext unchanged is invalid. Missing keys or an undecryptable
envelope fail preparation with a connection identifier and a repair instruction,
never token contents. Template reads do not refresh or revoke provider grants;
template maintenance remains separate from cloning. Retiring one demo never
revokes the shared upstream grant, which would also break the template and
other demos. Clones have independent Rally records, not independent provider
grants.

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
replayed fake tool result or a drawn question card. The spike's targeted-user
seam remains necessary if that question is addressed specifically to the
presenter; its target must be an actual destination member. Connector tool
history remains absent.

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

Replacement first checks that the template and pack are usable, then closes
the predecessor, then prepares its successor. Retirement is a monotonic,
receipt-backed operation; retries resume unfinished steps after interruption
or eviction. It is not the spike's straight-line best-effort walk.

1. Close regional admission using the existing abandonment semantics, without
   calling the final-member-only `leaveWorkspace` path. Revoke old workspace
   access and publish through the existing access-revocation mechanism so open
   sockets close as well as new requests failing. Do not affect the members'
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

**The central gate is new work.** WorkspaceDO has roughly 229 methods and no
shared RPC dispatch boundary. Adding a helper that each method is expected to
call, checking only `fetch`, or gating only the two effect receivers fails this
requirement. Introduce a class-level admission wrapper for the exported callable
surface that delegates to the existing implementation after the single policy
check. Mechanically derive/check coverage against the actual callable surface
so a new RPC cannot silently bypass retirement. Native RPC, HTTP/socket entry,
hibernated socket callbacks, inherited callbacks, and alarm recovery all need
coverage. The concrete wrapping technique must work on real workerd; a local
JavaScript proxy test is insufficient. This requirement does not mandate a new
generic RPC protocol or a rewrite of the domain methods.

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
The exception is an explicitly internal demo execution mode with scripted prose
and disabled live connector access. It adds no customer reset capability, global
inbox, general replay clock, or permission for a model to fabricate tool receipts.

## Decision log

None yet.

## Key design decisions

1. **September 4: real time and fresh identities.** No backdating and no resets.
   The security risk and harness clock surface outweigh historical appearance;
   fresh objects remove the need to undo a live object graph.
2. **September 4: one hand-built template.** Three demo Google accounts and
   cloned credentials live in `demo-template`, hidden by hardcoded UUID. A
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

## Regional impact

The initial demo operates in **Global**, the region exercised by the spike.
The template and every clone stay in that region; identities and memberships
use the existing onboarding/discovery control plane. Credentials, conversation
content, artifacts, operation receipts, and object state stay in the owning
region. Ace displays authorized operation metadata and progress, not tokens or
conversation bodies. No template credentials or demo content are copied across
the Global/EU boundary.

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

Plaintext credentials exist only inside the backend cloning operation. They
never enter Ace responses, the renderer, pack files, operation receipts, or
logs. Use the existing envelope and key-rotation rules in
[security](../../security.md#connector-credentials) and
[connectors](../../connectors.md#authorization-model).

Demo mode prevents connector egress before credential refresh as well as before
tool execution. It covers background polling, watches, hydration, connection
tests/repair, outbound notifications, and scheduled work; ingress cannot start
demo work either. A prompt telling the model not to use connectors is not this
boundary. Local seeding, projection delivery, and in-product interaction remain
available. Failure to establish this mode blocks credential cloning and Ready.

## Agent behavior

The seed adapter replaces the source of assistant output while keeping the
ordinary acceptance, persistence, and settlement path described in
[agent harness](../../agent-harness.md). No connector plugin or new model tool
is added. A real core elicitation, if included, uses its current production
contract rather than a saved wire-name fixture masquerading as execution.

After preparation, ordinary continued turns use the current harness and its
current authorized core surface; the seed adapter does not remain installed to
repeat canned responses. Connector tools remain unavailable in demo mode, and
Rally explains that live connector access is unavailable if the next request
needs it. The connection settings may show cloned accounts and scopes but do
not imply that a live test or refresh has run.

The spike found human-only messages visible in the transcript but absent from
the resumed Bind history. Do not call that fixed by seeding. The pack's final
assistant prose or run-starting human message explicitly carries the facts a
continued demo turn needs, including the positions in the renewal discussion.
Acceptance inspects the actual provider-boundary context and exercises a
follow-up dependent on those facts. Repairing general human-only context
propagation is a separate product change if required beyond this pack.

## Provider configuration

Operators prepare the three Google identities and agreed connector grants in
the template before enabling creation. Google sign-in alone does not grant
Drive, Gmail, or Calendar access. No OAuth redirect, webhook registration, or
provider installation is repeated per demo. The source and active regional
credential keys must both be available when their versions differ. The actual
template UUID, accounts, and included connections are release prerequisites;
secrets are never checked into the PRD or pack.

## Rollout

The product owner has been asked whether creation ships behind a flag, as
required by [PRD conventions](../../prds.md#optional-sections). That answer is
pending; it is not implied by the internal Access gate. If flagged, the key is
`demo-workspace-enabled`, defaults off for everyone, and is registered in Ace
with explicit internal-operator targeting before it is enabled. A decision to
ship without a flag and its reason must replace this pending note before rollout.

Enable only after the template is provisioned and the acceptance flows below
pass. Deploy the lifecycle/admission and connector-execution boundaries before
admitting any demo preparation. Turning off creation prevents new operations;
it never disables retirement, status/recovery access, or the connector block on
existing demos. A bad pack stops new creation until corrected. Published demos
are retired and replaced rather than patched in place.

The implementing changes update the owning documents for the harness,
credential cloning, multi-workspace admission, access revocation, and object
lifecycle, and add a durable demo module document when the subsystem ships.
This PRD does not rewrite those documents to describe unimplemented behavior.

## Acceptance

1. **Create and view.** Create a fresh demo from the template. As each intended
   viewer, the directory and attention state match the pack. Open Rally in a
   real window and inspect the home screen, sidebar, transcript, participant
   previews, connector settings, and local document. Timestamps age normally;
   no fake connector activity or tool receipts appear.
2. **Delayed projection.** Withhold viewer effects while allowing provisional
   rows to exist. Preparation stays waiting and early activation cannot reveal
   a partial sidebar. Deliver the effects through the real Queue pipeline;
   Ready appears only after the missing per-viewer content and attention match.
   Verification preserves the presenter's unopened state.
3. **Continue the story.** Answer any real elicitation and post a follow-up that
   depends on the seeded discussion. Verify the actual model input contains the
   required facts and no synthetic connector calls/results. No live connector
   request, including token refresh, occurs during this or background activity.
4. **Clone credentials.** Source and destination IDs and IVs differ. Decryption
   succeeds with the destination ID and stored key version, fails with the wrong
   associated ID, and preserves owner/capability scope. Exercise an old source
   key version and a missing-key failure. Template tokens, sessions, cursors,
   and provider registrations are not mutated by cloning or demo retirement.
5. **Replace and isolate.** Retire W1, prepare W2, and verify their distinct
   object graphs. Old sessions fail, open W1 sockets close, and direct object
   product writes bypassing the edge are refused. W2 contains only its own pack.
6. **Prove the Queue fence independently.** Hand a real effect to the Queue
   before retiring W1, hold delivery until after retirement, then release it.
   Observe terminal drop and acknowledgement, unchanged directory/attention,
   no retry loop, and no alarm. Repeat delivery and exercise an envelope with a
   later regional generation. An alarm-clearing test alone cannot pass this gate.
7. **Cover the central policy.** Mechanically check all callable WorkspaceDO
   entry points and exercise native RPC, socket callbacks, inherited alarm
   recovery, and a formerly alarm-refreshing path under workerd. Retire during
   an admitted asynchronous mutation and child reservation. Evict/reload the
   objects: no effect commits, missing descendant, or re-armed alarm survives.
8. **Retained outbox and partial retirement.** Leave effects in a parent's
   outbox, retire it, and inspect the retained count with zero stored/platform
   alarms. Include an automation and non-main children. Interrupt retirement
   mid-walk, resume from receipts, and prove no delivery or activation resumes.
9. **Recover preparation.** Disconnect the operator during cloning and seeding;
   reconnect and retry the same operation. It creates no duplicate messages,
   connections, workspaces, or replacement operations. A failed required run or
   clone never becomes Ready. Abandoning a candidate retires it before a fresh
   attempt. Hidden-template and ordinary-workspace retirement attempts fail.

Runtime checks use real workerd, Durable Objects, and Queues; credential/query
checks use the real schema and encryption helpers. Follow
[testing](../../testing.md): prove each integration behavior can fail with a
production mutation, then revert it. Visual acceptance follows
[the real-window procedure](../../dev-environment.md#driving-and-screenshotting-it).
Test deadlines are not product readiness guarantees.

## Open questions

- **Flag decision — blocks rollout.** The product owner's yes/no answer and
  reason remain pending. It does not block reviewing the lifecycle and pack
  requirements above.
- **Template and pack inputs — block the first released demo.** Supply the
  hardcoded template UUID, three account identities, included connection list,
  final third scenario, and role/presenter mapping. The spike's six personas and
  improvised middle room do not fill these gaps by default.
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
