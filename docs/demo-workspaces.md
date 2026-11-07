# Demo workspaces

Rally is presented from a workspace that was prepared for the presentation:
Canvases already in it with their Chats and artifacts, Sidekicks already
published with a run behind them, and the people already in them. Every demo is a *new* workspace; any number can be live at once, and one
is retired when an operator closes it rather than cleared. This document covers
the machinery that prepares one: the filter that decides what a member is
offered, copying the template's connections into a new workspace, seeding its
conversations from a pack, deciding when it is Ready, and the operation that
drives those in order. Closing a workspace permanently is
[`workspace-retirement.md`](workspace-retirement.md); this feature calls it.

Read it before changing seeding, readiness, the demo register, or how a demo's
connections are made.
The product decisions behind it are in
[the demo workspace PRD](PRDs/2026-09-04_demo-workspace/prd.md), and the
evidence behind those is the spike report in the same folder.

**What is built today is the whole lifecycle on the API side**: the filter
that decides what a member is offered, the seeder — the pack, the provider seam
a seeded run answers itself from, and the receipts each action leaves — the
readiness barrier that decides when a seeded demo is Ready, the durable
preparation operation that drives them, and the operator API the Ace Demos
page calls. **Open questions** below says what remains.


## Where the code lives

| Path | Role |
| --- | --- |
| `apps/api/src/services/workspace-retirement-service.ts` | Owned by [`workspace-retirement.md`](workspace-retirement.md); the walk writes the operation row's `retired_at` once the graph reports closed. |
| `apps/api/src/services/demo-workspace-register.ts` | The walk's one write into the register: `markDemoWorkspaceRetired` stamps `retired_at` on the operation row. Not an authorization input, and nothing reads through it. |
| `apps/api/src/services/demo-connection-copy.ts` | Copying template connections into a demo, with credential re-encryption; `SHAREABLE_CONNECTOR_TYPES` is the list of providers whose grant may be shared. |
| `apps/api/src/services/demo-workspace-visibility.ts` | The template and unpublished-candidate filter, applied in regional discovery and activation. `DEMO_TEMPLATE_WORKSPACE_ID`, the template's UUID, is declared here and nowhere else. |
| `apps/api/src/services/demo-pack.ts` | The pack schema and its playability rules, the planner that binds a pack to a cast, the label each part is cast under, and the placeholder pack — the mockup's three Canvases and two Sidekicks. |
| `.agents/skills/demo-scenario/SKILL.md` | Adding a scenario to the shipped pack from a plain-language description, for an author who does not read the code: what to ask, how Rally has to sound, the files a scenario touches, and the loop that proves a scenario seeds and is Ready. Invoke it as `/demo-scenario`. |
| `apps/api/src/services/demo-cast.ts` | Who a demo can be cast from: the company's email domain, the directory query the New demo form suggests from, persona minting for a typed name, and the check that every cast id is a colleague or a persona. |
| `apps/api/src/services/demo-seeder.ts` | Plays one action at a time through the production write paths, waits for its run to settle as specified, and records the receipt. `sidekickDraft` is the definition a Sidekick step publishes. |
| `apps/api/src/services/demo-seed-provider.ts` | The `fetch` a seeded run's harness config carries: answers the run's one inference request from the seed and refuses the next. |
| `apps/api/src/services/demo-readiness.ts` | The manifest of what every verified viewer should find, derived from the pack and the receipts, and the one comparison against their real Canvas list, Sidekick list and each Canvas's and Sidekick's canonical reads. |
| `apps/api/src/services/demo-preparation.ts` | The operation: its rows, start/retry/abandon, and the five idempotent phase functions the Workflow's steps call. |
| `apps/api/src/workflows/demo-preparation.ts` | `DemoPreparationWorkflow`: one step per phase, then a check-and-sleep loop until the workspace matches the pack. |
| `apps/api/src/routes/demo-operations.ts` | `/internal/demos`, behind the operator credential in the `demos` role; `/internal/workspaces/:id/retire` is retirement's own router. |
| `packages/contracts/src/demo-operations.ts` | The operation on the wire: the start request, the status Ace renders, the template's presenter and cast candidates, and the Workflow's pointer payload. |
| `packages/contracts/src/demo-seed.ts` | `DemoSeedSchema`: what a seed action carries, and the one field a run's execution context gains. |
| `packages/db/migrations/0100_demo_workspaces.sql` | The operation's row — which is also the register of published workspaces — its per-phase receipts, and the seeder's receipts. |
| `packages/db/migrations/0102_demo_seed_sidekicks.sql` | Widens those receipts for an action that is in no room. |
| `packages/db/migrations/0103_demo_seed_substreams.sql` | A fifth kind of confirmed action, and the conversation each action wrote to. |
| `packages/db/migrations/0125_demo_seed_canvases.sql` | The receipts rebuilt for the Canvas and Sidekick kinds, addressed by the pack's name for a Canvas or a Sidekick and the id it got. |
| `apps/api/src/services/canvas-service.ts`, `apps/api/src/services/terminal/resource-bridge.ts`, `apps/api/src/services/terminal/authority.ts` | Owned by [`canvases.md`](canvases.md): the seeder makes and shares a Canvas through `CanvasService`, publishes an artifact's version through the Terminal's resource bridge, and lets `resolveTerminalPublicationHome` make a Sidekick run's Canvas. `CanvasService.list` (`WorkspaceDO.canvasListFor`) is the Canvas list the readiness barrier reads. |

### Retiring a workspace

Retirement is [`workspace-retirement.md`](workspace-retirement.md): the
tombstone, the gate, the recorded graph and the walk, and the operator door
Ace's workspaces tab calls. What this feature adds is one write after the walk
reports closed: `retired_at` on the operation row that made the workspace, so
the Demos page can answer "is there a demo" without waking a retired object to
ask it. A workspace this feature never made has no row, and the write is a
no-op for it. Abandoning an unfinished preparation retires its candidate
through the same walk and takes a confirmation naming the operation.

### Withholding a workspace from its own member

Two workspaces a member belongs to are not offered to them, for different
reasons. The **template** is withheld permanently, by UUID rather than by name,
so renaming it does not defeat the filter and naming another workspace
`demo-template` does not acquire it; it is a specific exclusion rather than a
hidden-workspace feature, and deliberately not the template's security gate —
membership and role checks are, and an operator maintaining it still opens it. A
**candidate** is withheld while `ready_at` is null, whatever its status, because
preparation is a real admission state: a demo exists and is being filled for
minutes before anyone should see it. Activating one answers
`demo_workspace_preparing` rather than opening a half-seeded sidebar. An
*abandoned* candidate stays withheld for good — its workspace was retired with
nobody ever in it, and offering it afterwards would put a half-seeded,
tombstoned workspace in the presenter's account menu. A *published* demo is
never withheld, retired or not: retirement closes it the way any closed
workspace is closed, and hiding it as well would leave its presenter looking at
a switcher a workspace silently vanished from while its rooms still answered.
Discovery asks with the member's own workspace ids, in runs that fit D1's
bound-parameter ceiling, so the read is bounded by what they are in rather than
by every operation ever prepared — and it is made whenever they are in any
workspace but the template, because the read is what answers the question.

### Copying the template's connections

`connector_connections` lives in each WorkspaceDO's own SQLite, so a copy is a
cross-authority operation with one `workspaceRuntimeDatabase` handle per side.
Each connection is decrypted under its source's id and re-encrypted under the
destination's, because the envelope's additional authenticated data is the
connection ID rather than the workspace ID.

A copy shares the template's upstream grant rather than holding one of its own,
and that is safe for exactly one provider today. Google neither rotates the
refresh token on use nor revokes the grant remotely when one holder disconnects
— disabling a Google connection is local (`mayRevokeRemotely` in
`connection-service.ts`) — so the template and any number of demos can hold one
grant at once. For every other provider the presenter, who owns the demo, would
hold a Disconnect button that revokes the grant the template and every other
live demo share. So only a connection whose type is in
`SHAREABLE_CONNECTOR_TYPES` is copied; the rest are skipped and reported as
`shared_grant`, beside the personal connections reported as `personal_scope`,
so the operator hears "the demo has no Linear" before the meeting rather than
the template losing Linear during one.

### Casting a demo

**The presenter is a colleague with a real account; every other part is a
typed name.** The presenter signs
in, owns the demo, and it is their view of it that the readiness barrier
verifies, so they are chosen from the template's own members. Every other role
is a typed name; the **company's directory** — everyone with an account on the
company's own email domain who has signed in to this region — is what the New
demo form suggests, and the only accounts a request may name. `demo-cast.ts` holds that domain — the one
place it is written down — and the query that reads it. The pack names each
part it is casting for (`roleLabels`: Finance lead for `theo` and Engineering
lead for `priya` in the pack in service; the presenter is chosen from the
template's members and is not labelled), because a role token reads as this pack's own character and a
colleague put in the wrong part has its scripted words attributed to them under
their real name.

Each part is a text field that suggests colleagues. A name that exactly one
colleague carries (case-insensitive) is sent as their account and seats them;
any other name is sent as `{ name }` and played by a **persona**
(`mintDemoPersona`): a `users` row with that name, no platform identity and an
address `<operationId>.<role>@persona.invalid`, minted when the start request
passes its checks. A persona is seated and acts like anyone else but can never
sign in, so it widens nothing. The derived address makes minting idempotent,
and personas are never cleaned up — a demo's history references them.

The two lists are different questions, which is why the template answers both
rather than filtering one. A presenter is handed the template's connections,
so they have to be somebody the template already trusts with them. A cast
member is only seated in the new workspace, so the domain is the whole of what
bounds them.

**The domain filter is a boundary, not a convenience for the form.** Being cast
seats the account in a demo workspace that receives copies of the template's
connections, so it is checked when the start request arrives — before a row is
written — and again by `checking_template` before the first write, against
whatever the page sent. `demo_cast_not_a_colleague` is the refusal: 422 from
the start request, 409 from the phase, where it means somebody the row already
names has stopped being one.

Two collisions are refused. **One person cannot play two parts**
(`demo_cast_duplicate`), presenter included: the seeded conversation would have
them answering themselves, and the readiness barrier would read one directory
row for two roles. **Two people in the demo cannot share a display name**
(`demo_cast_name_duplicate`): a mention resolves to a user id, and nobody
watching can tell which of them was named. Both are checked in Ace so the form
says which, and again by the regional API, which does not trust the page — and
the name check runs again before the first write, because a name is rewritten
from the platform identity every time somebody signs in, so two people can
collide after the row was written.

A demo's people are the accounts that were already there: preparation creates
nobody. Abandoning a preparation retires the workspace and leaves everyone who
was seated in it with one less workspace, exactly as retiring a published demo
does.

After seating, preparation writes the complete ordered pair set of
workspace-scoped **can impersonate** relationships, including every self-pair,
through the generic WorkspaceDO writer. The operation id is their authority
basis, so retirement revokes only the edges this demo produced. The runtime
authorization path is owned by [impersonation](impersonation.md) and never reads
the demo register.

### Seeding a demo from a pack

A pack is versioned data behind a schema: a cast of *roles*, the viewers to
verify, and ordered steps in the product's two modes
([Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)).
Roles are bound to real workspace members only when a demo is prepared, so the
pack never names a user id and one pack serves every demo.

| Step | What it writes, and through what |
| --- | --- |
| `create_canvas` | A Canvas with a title, made by `CanvasService.create` as its creator under an id derived from the operation and the step, shared with `sharedWith` (`"organization"`, or the people besides the creator) by `CanvasService.setAudience`, and with an optional first `prompt` sent to its Chat through the conversation route's admission. `assistant` is what Rally answers the prompt with. |
| `canvas_message` | A cast member's message in a Canvas's Chat, through the same admission; with `assistant`, the run it starts and what Rally says. |
| `canvas_artifact` | A version of one of the Canvas's artifacts, published by the Terminal's resource bridge — the path `publish_resource` takes — under the identity `(Canvas, path)`: the first publish of a path is version 1, a later one of the same path the next version. It is attributed to the Canvas's latest seeded run and noted on the Canvas as Rally's (`canvasArtifactNoter`). A document only; see **Open questions** for sites. |
| `upload` | A document a cast member attaches to a message in a Canvas's Chat: `ResourceService.upload`, then the message admission that commits the draft with its turn. |
| `sidekick` | A Sidekick, made by `createAutomation`, published by `saveDefinition`, and shared with `sharedWith` (`"organization"` is scope `workspace`; a list is the `people` audience, set by `setAudience` after the definition, because a draft's suggested scope that moves the audience clears a list). With `firstRun`, one run through `runSeeded`, whose row lands in the shared conversation like every run's ([`automation-lifecycle.md`](automation-lifecycle.md#runs-in-the-shared-conversation)). With `canvas`, that run also wrote a Canvas: once the run has completed, its document is published through the resource bridge as the run, and `resolveTerminalPublicationHome` makes the run's Canvas with its principal as creator and the Sidekick as writer, exactly as a live run's first publish does. |
| `sidekick_message` | A cast member's message in a Sidekick's shared conversation, to the people there. It starts no run: a Sidekick's answer is a run, and a demo's one run is the Sidekick step's. |

There is no Thread, Channel, Breakout, Space or room step, and no substream:
those surfaces are retired, and the earlier steps went with them.

#### The placeholder pack

`PLACEHOLDER_DEMO_PACK` is the
[mockup's](PRDs/2026-11-06_canvases-and-sidekicks/design.html) Organization,
with the presenter as Maya, Theo (finance) and Priya (engineering):

- **Q4 revenue review** — Maya's Canvas, shared with Theo. Rally drafts the
  board review and publishes it, Theo asks for October churn and Rally
  publishes version 2, and Theo keeps the accounts board-only. It shows shared
  work with Rally and an artifact that versions.
- **Launch plan** — Theo's Canvas, open to the Organization, with Priya's
  attached checklist and Rally's answer to her. It shows planning across a
  team, and a Canvas that is unread to the presenter.
- **Weekly changelog** — an Organization Sidekick on a Friday schedule whose
  one run wrote **Weekly changelog · Nov 6**. It shows a Sidekick that has
  already done its job, and the Canvas it writes.
- **Incident triage** — Priya's Sidekick shared with Maya and Theo, whose run
  reported a rollback and whose conversation holds Priya taking the fix. It
  shows a Sidekick shared with people, and talking in its conversation.

What Rally says is part of the step that starts its run — `assistant`, a single
turn that is either prose (`say`) or a question (`ask`). `@{role}` in any prose
is written as the bound person's display name. It records no mention: a Canvas
and a Sidekick admit their readers by their audience, so a mention seats nobody
in either. The schema refuses, before the first write, a Canvas or Sidekick
used before it exists, two of them under one pack name, a line from somebody
the Canvas or Sidekick does not admit, a role nobody plays named in any prose,
a creator listed in their own audience, an answer with no prompt, a publish in
a Canvas where Rally has not run, a Sidekick's Canvas with no run to write it,
a Canvas that carries on after its question, and two Sidekicks under one name.

**A `canvas_artifact` is Rally's, in the run that said it.** A seeded run makes
no tool calls — a stale tool name in seeded history is a wrong claim about what
Rally did — so the version is not published from inside the run. It is
published right after, through the bridge, with the run's id as its author and
the run's requester as its execution principal, and the pack places it after
the message whose answer announces it. The schema's rule that Rally must have
run in the Canvas first is what makes the attribution true. The same holds for
a Sidekick's Canvas, published once its run has completed.

**Existing demos do not change when this pack deploys.** Use Ace **New demo**
with a new operation id; wait for Ready, switch to that Organization, then
separately retire the old demo if desired. There is no in-place reseed. A stale
unfinished operation fails `demo_pack_changed` at any phase; and its receipts
of the retired kinds were not carried by migration 0125, so it cannot resume
under the new pack either. Abandon it and start a new operation.

A Sidekick's recurrence always names its zone. A calendar trigger may leave
that null in general, and it then resolves against the account the Sidekick
runs for — whichever colleague was cast as its author. A demo is presented in a
zone somebody chose, so the pack states it. The seeded run's recorded trigger
is `manual`, naming the author, because that is what happened.

**Every seeded fact is written by the production path that writes it for a
person, as the cast member who did it**, under the `demo_seed` auth principal:
no session, because the cast never signs in, and the object verifies their
current membership instead — the same verification a connector ingress gets.
Nothing in this module writes a transcript row, and none of those paths know
they were seeding.

Two things are replaced, and both are decisions rather than writers:

- **Addressing.** A message in a Canvas with more than one person in it is
  normally classified by a model to decide whether it is for Rally. A seed
  action carries the answer instead: `assistant` present means this line
  starts a run, `null` means it starts none. In a Sidekick's shared
  conversation a seed's input is not routed to the Sidekick, which is what
  keeps a `sidekick_message` a line to the people.
- **The source of model output.** The seed rides the message's authorization
  into the run's execution context, and the harness reads it there:
  `OpenRouterConfig.fetch` is set to a function that answers the run's one
  streamed request from the seed's turn and everything else emptily, and
  refuses a second request with a 400. A question is a call to the real
  `request_elicitation` tool; the run parks on `needs_input`, and whoever
  answers starts an ordinary, unseeded run.

**Order and outcome are the seeder's.** Actions are applied one at a time and
each is confirmed before the next: a run has to settle the way its turn said it
would — `completed` for prose, `needs_input` *with* an open elicitation for a
question. A failed run fails the action. Applying and settling are separate
calls because they are separate waits, and the preparation operation calls both
inside one step. How long it may wait is the caller's deadline; this module
sets no ceiling.

**A receipt is written only once an action is confirmed**, with every
destination id it produced: the Canvas (by the pack's name and its id) or the
Sidekick (likewise), the turn, the run and how it settled, the resource, the
elicitation, and for a Sidekick that wrote one, its Canvas. Replaying an action
is safe by construction: the id of every seeded Canvas, document and Sidekick,
the client message id of every turn, and the receipt of every publish are
derived from the operation and the action, so a replay after a crash meets the
production path's own receipt and comes back as what it already wrote — a
republished version with the same bytes is the version it was, not another.

### Waiting for the workspace

Seeding writes through the conversation objects; what the presenter sees of a
Sidekick's run — its state in the run history, and its row in the shared
conversation — and a Canvas's recency are projections that arrive afterwards,
through the effect Queue and the Organization object's alarms. Ready is
therefore not "the seeder finished". It is "every verified viewer's lists and
every seeded Canvas and Sidekick match the pack", and the barrier is one
comparison the preparation operation repeats until it holds.

**What should match comes from the pack and the receipts, never from what the
workspace happens to contain.** `demoReadinessManifest` is pure: the steps say
which Canvases and Sidekicks exist, who each is shared with (a Sidekick's
Canvas is admitted by the Sidekick's audience, read live, as `canvasAdmits`
does), how each Chat ends, and how many versions each artifact reaches; the
receipts say which ids they got. A pack whose seeding never confirmed a step is
refused rather than described. The pack's `verify` list names the viewers to
check, and the steps say everything else: there is no per-viewer block to
author. `unread` is stated only for a Canvas the viewer neither made nor wrote
in, which they have never opened and which is therefore unread; what a viewer
who acted has read since depends on what came after, and is not compared.

**The comparison reads as each viewer, through the ordinary reads.** Their
Canvas list, as the workspace socket carries it (`CanvasService.list`), must
hold exactly the Canvases the pack makes visible to them, each with its title,
its writer Sidekick and its newest artifact's kind; their Sidekick list must
hold exactly theirs, each active, shared as the pack said, with a next run —
which proves the schedule was armed — and its seeded run `completed` in its
history. Then, once each and as whoever made it: a Canvas's artifacts at the
versions the pack publishes, its Chat's state and open question, and its
uploads attached; a Sidekick's run's row in its shared conversation. The list's
order is not compared: a Canvas's recency is the moment its Chat's effects land
in the Organization object, which no pack can state. Every mismatch is reported
as a named gap (the gap's `room` field carries the pack's name for the Canvas
or Sidekick, under its released name) rather than the first one, because the
operator's **Waiting for workspace** state lists what has not arrived.

The proof is the moment between the two: with the effect Queue held, seeding
completes and every Canvas and Sidekick is listed, but the run's report has not
crossed the Queue, and the barrier names `sidekick_run_state`. Delivering the
effects through the real consumer is what makes it Ready.

### Preparing a demo

The operator asks once, by an operation id, and everything hangs off that
identity. `demo_operations` is the row: company, presenter, pack version, the
cast binding, the workspace once one is allocated, the status, the attempt, the
failed phase and reason when there is one, and the instants the workspace was
published and closed — the row is also the register discovery and the Demos
page read. Repeated submission of the same id returns that row's progress and
starts nothing; two different ids are two demos. This is operation identity,
not a concurrency limit. Before a row is written the request is checked: every
pack role but the presenter's cast, each to a different colleague and none to
the presenter, no two of them under one display name, and the presenter an
active member of the template — the new workspace is owned by the presenter and
receives the template's credentials, so a presenter outside the template would
be handed them. What the row stores is the user ids every phase after it works
in.

**The phases are the PRD's, and each is safe to run again.** Every phase verifies the pack in service is the one the operation recorded.
`checking_template` verifies the template
workspace exists in this region, the presenter is a signed-in regional user and
still an active member of the template, and every other role is played by an
account that is still a colleague on the company's domain, or by the persona
minted for this operation and that role — never another operation's.
`creating_workspace` allocates the workspace id onto the operation's row
*before* creating the workspace, so a crash between the two retries the same
id — which is why that column carries no foreign key to `workspaces`; creates
it through the onboarding service as the presenter's own — the same rows,
journal, placement check and object initialization as a person creating one,
minus the session, because a login minted on somebody's behalf by an operator
is not something preparation may do; and seats the cast as active members, and
nothing more: since the Canvases and Sidekicks pivot there is no General or
Personal Channel to seat them in, and the pack's Canvases and Sidekicks admit
them by their audiences. `copying_connections`
is the copier, which matches what it already copied. `seeding_conversations`
opens the seed session and applies and settles each action in order, recording
confirmed-of-total on its phase row after every one, so the operator watches
the count climb; the receipts make a retry resume. `waiting_for_workspace` is
one readiness comparison: `waiting` with the open gaps on its phase row, each
naming the viewer it was read as, or Ready — and publishing is one statement
inside that same phase, `status = 'ready'` and `ready_at` together, fenced on
the attempt and on the row still being `running`, so there is no moment where
the check has passed and discovery has not heard, and no driver can publish a
row that abandon has claimed. The status Ace reads lists the phases in phase
order, each phase's latest attempt.

**One driver at a time.** Every attempt has a number, the row carries the
current one, and a phase called by a driver whose attempt is no longer the
row's writes nothing and stops. Every status write is guarded by the attempt it
belongs to. That is what lets the operator retry an operation whose driver died
without a second driver racing the first.

**The Workflow is the driver, and knows nothing the rows do not.** Its payload
is a pointer — operation id and attempt — re-read on arrival. It runs one step
per phase and a loop of check-then-sleep steps for the wait, memoizing only
each step's outcome; the detail the operator reads is in the phase row already.
A step does not retry: a phase that fails is final for the attempt, and the
operator's Retry is the retry, because a step retrying on its own would race an
operator's retry and put two drivers on one operation. Whatever stops the
driver outside a phase body — a step the platform ended, an error between steps
— is recorded on the row as a failure before it propagates, so an operation
never sits `running` with nothing running it. The wait is bounded by the
platform's own ceiling: Cloudflare publishes a maximum number of steps per
Workflow instance, each round costs two, and the driver stops at the round
count that fits under the smaller published figure and records
`demo_projection_wait_exhausted` with the last round's gaps still on the phase
row. That is arithmetic from a published limit, not a number chosen here; the
PRD's wait policy remains the team's, and a ceiling shorter than the
platform's is theirs to set.

**A failure is a state, not a log line.** The phase that threw is recorded with
its error code and message, and the operation is marked failed with the same,
which is what the Demos page shows beside the operation id; an internal fault
is shown as one, with its text in the log rather than on the page. Recovery is
a retry: the next attempt of the same operation, whose every phase resumes
from what the last attempt left. A `running` operation may be retried too — for
the driver that died without a word — and the attempt number is what makes
that safe. A launch that fails marks the operation failed with the same way
back. The one failure a retry cannot reach is a seeded run's own: the turn
that started it is written once, by a derived id, so the retry meets the same
run and fails the same way; **Failure modes** says what to do instead. Retry
checks for a driver before it touches the row, so a deployment without the
binding refuses and leaves the operation as it was.

**Abandon claims before it closes.** Abandoning an unfinished candidate is
first one statement that moves a `running` or `failed`, unpublished operation
to `abandoned`; a driver publishing Ready in the same instant either wins, and
abandon answers `demo_operation_ready`, or loses, and its remaining status
writes meet a row that is no longer `running`. Only then does abandon write the
same D1 fence the operator door writes, `workspaces.abandoned_at`, and retire
whatever the candidate made through the same walk the workspaces tab uses. It
takes a confirmation naming the operation, records the operator who asked, and
closes an operation whose workspace was allocated but never created without
retiring anything; an abandon whose walk could not finish is asked again and
returns to the objects that remain. A published demo is retired from the
workspaces tab like any other workspace.

## Invariants

Retirement's own invariants — unclassified refuses, a permit covers a call,
any workspace, the Worker's own region, every router names its roles — are in
[`workspace-retirement.md`](workspace-retirement.md#invariants). These are the
demo's.

- **The register authorizes nothing.** `demo_operations` records what this
  feature made and what is published; retirement never consults it, and the
  `retired_at` it carries is a shadow written after the walk, not a gate before
  it.
- **Copying never writes to the template.** Only
  `decryptVersionedCredentialValue` may be used; the version-aware sibling
  re-encrypts under the active key and writes back to the row it read.
- **Copies are workspace-scoped, and a personal connection is not copied at
  all.** A presenter opens a demo as themselves and owns none of the cast's
  connections, so a personal copy would be invisible to them — and rewriting one
  as workspace-scoped to fix that hands one person's refresh token to everybody
  in the demo. Skipped connections are returned rather than dropped, because "the
  demo has no Slack" is something the operator needs before the meeting.
- **Only a grant that can be shared is copied.** A provider whose disconnect
  revokes the grant remotely, or whose refresh rotates the token, is not in
  `SHAREABLE_CONNECTOR_TYPES` and is skipped as `shared_grant`. Adding one is a
  decision about that provider's revocation and refresh behavior, not a list
  edit.
- **Withheld means unpublished.** A candidate is hidden from its members while
  `ready_at` is null, whatever its status; a published demo is never hidden.
- **Abandon claims the row before it closes anything**, and the driver's
  publish is fenced on the row still being `running`, so the two cannot both
  win.
- **A seed decides addressing; nothing else in a seeded message does.** The
  classifier is not consulted, and neither is the Canvas's size.
- **A seeded run says one thing.** One turn, one provider request; the second
  request is a refusal, never a repeat.
- **Seeded history carries no tool call except a real elicitation.** Prose
  states its findings itself; the artifact it names is published by a step of
  its own, attributed to that run, so the prose points at something that exists.
- **A receipt follows confirmation, never admission.** The run settled as
  specified, the resource is attached, or there is no row.
- **Every seeded write is idempotent through the production path**, by a
  derived client message id or resource id, not by a check the seeder makes.
- **A seeded fact is stamped with the real clock.** The seed carries pack and
  action identity and no instant; nothing is backdated.
- **Ready is a projection match, checked as each viewer.** Never the seeder
  finishing, an empty outbox, or a first page. The manifest is derived from the
  pack and the receipts, and the presenter is read only through non-opening
  surfaces.
- **One operation id, one demo.** Repeated submission returns the progress it
  has; a retry is the next attempt of the same operation; the workspace id is on
  the row before the workspace exists.
- **One driver at a time.** A phase refuses a driver whose attempt the row has
  moved past, and every status write names the attempt it belongs to.
- **A cast account is a colleague or a persona.** A start request carries an
  account or a typed name per role; every account must be a signed-in account
  on the company's email domain. A persona is reached only by typing a name, and
  the template check accepts only this operation's own — checked before the row is written and again by the
  template check before the first write, so the page's list is never what
  bounds who a demo can seat.
- **Nobody is in a demo twice, and no two of them share a name.** One person
  per part, the presenter included, and a display name that is unique among
  them; a mention resolves to a user id, and both collisions make one
  unattributable.
- **A viewer the workspace does not seat is refused, never invented.** The
  barrier reads as the member membership says the viewer is; there is no
  fabricated role.
- **Rally's seeded prose cites only what the Canvas holds.** A seeded run makes
  no tool call, so it cannot have read a connector; the people bring the facts,
  and a document is attached by the person who wrote it.
- **Preparation never retires anything.** A failed or repeated preparation
  touches no other demo; only an explicit abandon or an operator's retirement
  closes a workspace.
- **A demo workspace is created for the presenter, never as them.** Owner
  membership, journal, placement and object through the onboarding service;
  no session.

## Boundary

This module owns preparing a demo workspace and nothing else. It does not own
how a workspace is created (ordinary onboarding), what a connection means
([`connectors.md`](connectors.md)), how a workspace is closed
([`workspace-retirement.md`](workspace-retirement.md)), how an object schedules
itself ([`durable-object-alarms.md`](durable-object-alarms.md)), or how sockets
are closed when access ends ([`access-revocation.md`](access-revocation.md)).

## Failure modes and limits

- **Retirement's own limits** — the construction window, the lazy runtime
  recovery, a walk nothing re-invokes, stranded outbox rows — are in
  [`workspace-retirement.md`](workspace-retirement.md#failure-modes-and-limits).
  Abandon invokes the walk once and reports incomplete when objects remain;
  nothing re-invokes it on a schedule.
- **A seeded run that fails fails the action, and ends the operation.** The
  seeder reports `demo_seed_run_failed` with the run's error code, and
  `demo_seed_run_outcome_mismatch` when a run settled but not the way its turn
  said. Neither is skipped past, and neither is retried into success: the turn
  that started the run is written by a derived client message id, so a retry
  replays the action, meets the same turn, finds the same failed run and fails
  the same way. The way back is Abandon and a new operation — and whatever
  failed the run, a pack the harness could not play or a room that refused the
  line, is what to fix before starting it.
- **A second inference request in a seeded run is refused**, with
  `demo_seed_exhausted`, so a loop the script did not anticipate dies visibly
  rather than replaying the turn forever. The first version of the spike's
  adapter repeated it, and wedged the runtime.
- **The seeder has no ceiling of its own.** `settleDemoSeedAction` takes the
  caller's deadline and otherwise waits. In production none is passed: the poll
  is bounded by the driver's step, whose ending the driver records as a
  failure the operator can retry, and by the run itself, which the harness
  fails or stops on its own ceilings.
- **The barrier is one comparison, not a wait.** `checkDemoReadiness` reads
  once and reports; the driver decides how often to ask and for how many
  rounds.
- **The barrier compares only what the steps decide.** A viewer's read state in
  a Canvas they acted in, and the list's order, depend on what came after and
  when effects landed, so neither is compared; the placeholder pack verifies
  the presenter alone.
- **The wait ends before the platform's step limit, with a record.** Each
  readiness round is two Workflow steps; the driver stops at the round count
  that fits under the published limit and fails the phase as
  `demo_projection_wait_exhausted`, leaving the last round's gaps on the row.
  The arithmetic, in the driver beside the limit's URL and the date it was
  read: 1,024 steps per instance is the smaller published figure; four leading
  phase steps and one step of headroom come off it; at two steps a round that
  is 509 rounds, and the last round checks without sleeping. At the ten-second
  poll that is about 85 minutes of waiting before the phase fails. None of
  those is a number chosen here; a shorter ceiling is the team's, and would be
  a constant beside these.
- **A driver that dies outside a phase is recorded.** The Workflow's `run`
  catches whatever escapes a step and marks the operation failed for the
  attempt that owns it; a launch that fails does the same
  (`demo_preparation_launch_failed`, with the platform's error in the
  `demo_operation_launch_failed` log line). Retry is the way
  back from both — a seeded run's own failure, above, is the one it cannot
  reach.
- **Lists are chunked to D1's bound-parameter ceiling.** Discovery's withheld
  read over a member's workspace ids and the Demos page's phase read over every
  operation both run in chunks, so neither breaks once there are more than a
  statement's worth of ids.
- **A Ready demo is reachable only with the presenter's flag on.** The account
  menu lists workspaces only while `multiple-workspaces-enabled` is on for
  that person; the Demos page's Ready copy says so, and Ace's Feature flags
  tab is where it is set.
- **Abandon can report incomplete.** It runs the retirement walk once and
  refuses to close the operation while objects remain; asking again returns to
  exactly those objects.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test-workers/workspace-retirement-graph.test.ts` | Retirement's own suite, extended here: the walk writes `retired_at` on the operation row once the graph is closed, and the first pass's instant survives a replay. |
| `apps/api/test-workers/demo-connection-copy.test.ts` | A copy opens under its own identity, and the template is byte-identical afterwards **when its key version is stale** — the only state in which the wrong decrypt helper is visible. A personal connection and a non-Google one are skipped and reported, as `personal_scope` and `shared_grant`, and only the Google copy exists afterwards. |
| `apps/api/test/demo-workspace-register.test.ts` | The walk's `retired_at` write against the real migration: written once, the first instant kept on a replay, and a workspace this feature never made untouched. |
| `apps/api/test/demo-workspace-visibility.test.ts` | The template, an unpublished candidate and an abandoned one are withheld; a published one, a retired one, and a customer workspace named like a demo are not; and a member in more workspaces than one statement can name is answered in chunks. |
| `apps/api/test-workers/demo-seeder.test.ts` | A seven-step pack — a Canvas shared with one cast member, a scripted prompt, two versions of one artifact, a document, an unscripted line, a question, and an Organization Canvas — seeds through the real Canvas creation, Chat object, alarm-driven loop, resource bridge and upload, with the provider double recording no call: the Canvas shared as stated, the artifact at version 2 attributed to Rally, the question open, two runs. Proved to fail with the audience write dropped (the cast member's line is refused: the Canvas does not admit them). A confirmed or half-confirmed action, a publish among them, replays without a second write. A Sidekick shared with the presenter publishes with its schedule armed in the pack's zone, its run answered from the pack, the Canvas the run wrote (its creator, its writer, the version attributed to the run, open to the presenter), and a line in its shared conversation that starts no run. |
| `apps/api/test/demo-pack.test.ts` | The playability rules, what a pack makes visible (a Sidekick's Canvas to the Sidekick's audience), that the planner resolves audiences to ids and names to display names and attributes a publish to the run's requester, and that the placeholder pack parses with no Thread, Channel or Breakout step and offers the presenter the mockup's Canvases and Sidekicks. |
| `apps/api/test/demo-seed-provider.test.ts` | The streamed wire form for `say` and for `ask` — the latter with arguments the real elicitation schema accepts — and the refusal of a second request; and the seeded route: an unbound model kept with its fallbacks dropped, an Azure-bound primary stepped past to the first unbound fallback, and a fixed unbound id when every routed model is bound. |
| `apps/api/test/demo-seed-receipts.test.ts` | Against the real migration: the first confirmation wins, a receipt needs a claimed operation, and an outcome the seeder cannot confirm is refused. |
| `apps/api/test-workers/demo-readiness.test.ts` | The presenter's Canvas list holds exactly the Organization Canvas; a private Canvas made Organization-wide is named `canvas_unexpected` and an artifact short of a version `artifact_version`. With the effect Queue held, a seeded Sidekick is listed but not Ready — its run is named `sidekick_run_state` — and delivering the effects through the real consumer makes it Ready. Proved to fail with the run-state comparison removed (Ready before the run landed). |
| `apps/api/test/demo-readiness.test.ts` | The manifest derived from the placeholder pack — the presenter's Canvases with `unread` stated only where it is derivable, each artifact at its version, the Sidekick's Canvas with its writer, the Sidekicks with their audiences — and its refusal of a pack whose publish or Sidekick Canvas was never confirmed. |
| `apps/api/test-workers/demo-preparation.test.ts` | The launch id handed to the real Workflow binding, so the platform's own instance-id validator judges it. Every phase in order on real objects: the presenter's workspace through onboarding with the cast seated, the template's Google connection copied and left in place, every action of the placeholder pack confirmed and a completed phase re-run confirming nothing twice, the wait naming its gaps, and Ready published to the register only after the effects land; and a failed template check recorded on the operation with its reason. |
| `apps/api/test/demo-operations.test.ts` | Against the real migrations: one operation id starts one Workflow and answers a repeat with the same progress; a cast that misses or invents a role, seats one person twice, seats two people under one name, or names the presenter's role at all, is refused before a row is written, as is a presenter outside the template and anybody who is not a signed-in account on the company's domain; the row stores the accounts it was given and answers their directory names, a repeat meets the cast it was started with, and a cast member who stops being a colleague fails the template check; the template route answers the presenter's members, the cast's candidates and each part's label, offers nobody off the domain, a near-miss domain or unseen, and is refused outside Global; the allocation statement is accepted before the workspace exists; a retry is the next attempt of a failed or a stalled `running` operation; a superseded attempt's phase call writes nothing; the template check runs against the real rows and records a presenter the template lost; a driver that stopped outside a phase is recorded for its own attempt only, with internal text kept off the page; a failed launch marks the operation failed; a retry without a driver leaves the row untouched; the status lists phases in phase order at their latest attempt, and a list past one statement's parameters is answered whole; abandon needs its confirmation, refuses a published demo and closes an operation with no workspace; and the routes — start, list, template, retry, abandon — admit only the `demos` role and reject a malformed start and an unconfirmed abandon. |
| `apps/ace/test/demos.test.ts`, `apps/ace/test/demos-client.test.tsx` | Ace's side, owned by [`ace.md`](ace.md#testing): the relay forwards the typed confirmation and answers a regional refusal by its own code, and the page reads a retried operation by its current attempt, keeps polling while offline, and names the presenter beside each gap. |
| `apps/api/test/socket-ticket-transport.test.ts` | Every socket-ticket issuer refuses a `connector` and a `demo_seed` principal alike. |

Two of these were written wrong first and are worth knowing about. The copier's
stale-key test is the only one that fails when the writing decrypt helper is
swapped back in, because a template whose key version is current is
byte-identical either way. And the workerd preparation fixture originally
seeded a generic webhook as the template's connection, because the run child's
harness loads every connection in the workspace through the connector registry
and a type the test Worker is not configured for fails the run; the test Worker
now registers Google with placeholder credentials in `wrangler.test.jsonc` —
construction is pure, and no test reaches Google — so the fixture holds the
connection a real template holds, and a fixture that seeds any other provider
has to register it the same way or watch the seeding phase fail.

## Data model

| Where | Table | Holds |
| --- | --- | --- |
| Regional D1 | `demo_operations` | One row per preparation: company, presenter, pack version, cast, the allocated workspace, status, attempt, the failed phase and reason, and the instants the workspace was published and closed. The register of published workspaces is this table. |
| Regional D1 | `demo_seed_receipts` | One row per confirmed seed action: its kind; the Canvas it wrote to, by the pack's name and the id it got, or the Sidekick, likewise; and the turn, run and outcome, elicitation and resource it produced — for a Sidekick, its seeded run and the Canvas that run wrote. A CHECK keeps each kind's identity complete rather than letting a row be half of both (migration 0125). |
| Regional D1 | `demo_operation_phases` | One row per phase per operation: status, attempt, a small detail object the page renders, and the error when there is one. |
| A seeded run's `runs.execution_context_json` | `seed` | The pack version, action id, and the one assistant turn the harness answers the run from. |
| `WorkspaceDO` | `sidekick_runs.seed_json` | The same object, on a seeded Sidekick run, from admission until `provisionSidekickRun` puts it in the execution context above. Null on every run production makes. |

The operation rows live in D1 because they answer a regional question — which
workspaces are ours, and which are published — asked by callers that have no
object to ask. There is no separate register table: a workspace enters the
register when the creating phase allocates its id onto the operation's row, and
`ready_at` and `retired_at` on that row are what discovery and the Demos page
read. `workspace_id` carries no foreign key to `workspaces` because it is
written before the workspace row exists. The tombstone and the graph a
retirement records live in the objects
([`workspace-retirement.md`](workspace-retirement.md#data-model)).

## Regional impact

Demos are prepared in Global, and the mechanism says so: the write routes
answer `demo_region_unsupported` in any other region, and the Workflow binding
is required in production Global only — absent, the routes answer
`demo_preparation_unavailable` and nothing else in the Worker changes. The
template is a Global workspace, and the template check refuses an operation in
a region whose D1 does not hold it.

## Security and trust model

Abandon retires a candidate through the walk in
[`workspace-retirement.md`](workspace-retirement.md#security-and-trust-model)
and, like retirement, takes a confirmation naming what it closes — the
operation id, typed. `demo-template` is not special to retirement; an operator
who retires it has retired it.

The routes sit behind the operator credential's `demos` role, the one Ace
already holds one token per region for; the demo routers refuse the telemetry
roles as the telemetry router refuses `demos`.

The presenter must be an active member of the template, and every cast member
an account on the company's email domain or this operation's own persona — both checked before the row is
written and again by the first phase. The new workspace is owned by the
presenter and receives copies of the template's connections, so a presenter
outside the template would be handed its credentials; a cast member is seated
in that workspace and so reaches the same copies, which is what the domain
bounds; a persona cannot sign in, so it reaches nothing. Digest delivery skips
`.invalid` addresses, so a seated persona is never mailed. Plaintext credentials exist only inside the copying operation and
never enter a response, a log, or a receipt. The template's row is not written
during a copy, which is asserted rather than assumed. A copy shares the
template's upstream grant, and the presenter owns the demo's Disconnect: only a
provider whose disconnect is local and whose refresh does not rotate — Google —
is copied, so no demo can revoke what the template and every other demo hold.
The presenter, as owner, can invite anyone into the demo and so hand them the
copied Google connections; that is the same trust the template extends to its
cast, and the template membership check is what bounds who can be a presenter.
Start and abandon record the operator who asked in the log.

A seed reaches a room only over the object's internal RPC. The message route's
request schema has no `seed` field, so nothing a client sends can carry one, and
`demo_seed` — like `connector` — is a principal only server code constructs;
the auth middleware never sets it, and every socket-ticket issuer refuses it.
The readiness barrier reads as the member membership says the viewer is and
refuses a viewer the workspace does not seat; it never fabricates a role. Seed
prose is pack data behind a schema, never a member's or a model's input, and
no run recalls memory at admission, so
the seed's `fetch` is the only provider it reaches — and the run is routed to
the client that `fetch` belongs to: an OpenRouter-only model with no fallbacks
and no Azure transport, because production's default model is Azure-first
([`agent-harness.md`](agent-harness.md#seeded-runs)).

## Open questions

These are specified in the PRD and not implemented, or resolved differently:

- **Open in Rally.** The PRD's Ready state carries an **Open in Rally** button.
  The desktop's deep-link contract addresses a workspace only together with a
  destination inside it — a Canvas, a Sidekick, settings —
  and has no home-screen destination, so the Demos page names the workspace to
  switch to rather than fabricating a link the desktop would reject. Adding a
  home destination is a desktop deep-link contract change
  ([`multiple-workspaces.md`](multiple-workspaces.md#workspace-addressed-handoffs)).
- **Access revocation on retirement**, which needs a retirement `reason` value
  and a per-member fan-out that the existing mechanism does not have.

One question the spike raised is settled rather than open: a scripted
conversation between cast members reaches the model. A human turn that starts
no run is now appended to the loop's projection at the next admission
([`agent-harness.md`](agent-harness.md)), so a presenter's question about what
the cast discussed is answerable. That was a product defect in every
multi-person room, not a demo concern, and it is fixed where it lived.

## Changelog

### 2026-11-07 — The pack seeds Canvases and Sidekicks

The pack's steps are now the product's two modes: `create_canvas`,
`canvas_message`, `canvas_artifact`, `upload`, `sidekick` (shared with people or
the Organization, with a run whose row sits in its shared conversation, and a
Canvas that run wrote) and `sidekick_message`. The room, substream, Space and
prepared-history steps are gone, and the placeholder pack is the mockup's
Organization: Maya (the presenter), Theo and Priya with "Q4 revenue review",
"Launch plan", the "Weekly changelog" Sidekick and its Canvas, and "Incident
triage". Why: the Thread, Channel and Breakout surfaces are retired by the
[Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md),
so a pack of rooms seeds a workspace nobody can open, and the services it
called are being deleted.

Decisions a later change has to respect. An artifact's version is published
through the Terminal's resource bridge, not written directly, so a seeded
version has the identity, versioning and Canvas note a live publish has; it is
attributed to the Canvas's latest seeded run, and the schema requires one,
because a seeded run makes no tool calls and the version must still be honestly
Rally's. A Sidekick's Canvas is made by `resolveTerminalPublicationHome` from
the run, never by `createCanvas` with a hand-set writer. `@{role}` writes a
name and records no mention, since a mention seats nobody in a Canvas or a
Sidekick. The readiness barrier reads the Canvas list (`CanvasService.list`,
new) and the Sidekick list instead of the Thread directory and the home
screen's attention, and no longer checks General and Personal Channels; the
per-viewer `expect` block is replaced by a `verify` list, because every flag
the barrier now compares derives from the steps. It does not compare the
list's order: a Canvas's recency is when its Chat's effects land, which raced
the expected order in the first workerd run. Migration 0125 rebuilds the
receipts for the new kinds and does not copy the retired ones — an operation
still preparing under the old pack fails and is started again. Deferred: a
site artifact (no seed has proved a served version and a hostname end to end),
and a demo whose Chat parks on a question in a Sidekick's shared conversation.

### 2026-10-13 — A demo's people are seated in General and given Personal Channels before seeding

**What changed:** `creating_workspace` calls `seatOrganizationMember` for every
seated person, and the readiness barrier holds Ready until each verified
viewer is a General participant with an active Personal Channel. The test
fixture opens its workspace the way creation does, with General and the
presenter's Personal Channel, instead of letting the first seeded room make
General.

**Why:** Every member now gets both (`docs/spaces.md#the-personal-channel`).
Preparation inserts the cast's membership rows directly, so without the call
their seating waited on the five-minute relationship dispatch cron and a demo
could be published with its cast missing from General.

**Considered and rejected:** Calling the relationship dispatch from the phase.
It would also deliver unrelated pending changes, and seating directly is the
same idempotent call that dispatch makes.

**Consequences:** A demo whose General is missing is never Ready; readiness
names it instead of making one.

### 2026-09-23 — Demonstrate human intervention in shared outcomes

**What changed:** The shipped pack now has Acme proposal and demo-follow-up work,
a support-vendor decision, and a brief Sales review pointer, grouped in named
Spaces. Setup uses repeatable Space identities and checks their placement before
Ready. Every preparation phase refuses a changed pack version. Product RPC
schema failures now preserve the declared field code after local verification
exposed malformed participant timestamps hidden by a generic error.

**Why:** Discovery needs one recognizable breakdown followed by a human changing
the work and an observable improvement. The unrelated memo, renewal and filing
examples buried that transition. General-only seeding could not represent the
agreed account/outcome structure, and a version check only in the first phase
could let a resumed Workflow mix content from two deployments.

**Considered and rejected:** A feature tour, fabricated connector deliveries, and
in-place rewrites of live demos. Brief independent stories, labelled sample
outputs, and the existing fresh-Organization lifecycle preserve truthful demos
without changing product capabilities or customer data.

**Consequences:** Replace older demos with New demo and separate retirement, not
Retry. Keep source facts and arithmetic consistent across snapshots; joining is
never implicit private-data sharing. Casting uses the existing colleague/persona
flow; real import/distribution requires its ordinary provider configuration.

Shipped in [#956](https://github.com/juno-ai-labs/avalon/pull/956).

### 2026-09-23 — A part can be played by any typed name

**What changed:** The New demo form's parts are text fields, not colleague
dropdowns. A start request's cast entry is an account id or `{ name }`; a name
is played by a persona minted for the operation (`demo-cast.ts`), and
`readDemoCast` accepts personas beside colleagues. The page no longer refuses
to open the form when the company has fewer people than parts.

**Why:** With three people in the company, whoever presents leaves two
colleagues for three parts, so no demo could be cast without a duplicate. The
2026-09-10 entry rejected per-part personas as "a question with no good
default"; typing resolves that — the field asks one question, and a
colleague's name still seats the colleague.

**Consequences:** A persona is never renamed by a mint: two concurrent first
submissions both mint before either claims the operation, so only the winner
names its personas, after its claim. Persona rows accumulate, one per typed part per operation,
and are never deleted. A name that two colleagues share is played by a
persona, not either of them. Changing the persona address derivation orphans
personas already minted for an operation that may still be retried.

### 2026-09-21 — Demo preparation produces platform impersonation relationships

**What changed:** The seating phase idempotently creates every ordered
**can impersonate** pair, including self-pairs, and retirement revokes the edges
whose authority basis names that demo operation.

**Why:** Sideline needs live operator-timed participant turns after preparation,
but demo status cannot become a second authorization system. The generic
relationship lets preparation supply authority without owning its runtime use.

**Considered and rejected:** Authorizing from `demo_operations` at send time or
reusing `demo_seed`. The first makes a register into live permission state; the
second bypasses ordinary addressing and uses scripted inference.

**Consequences:** Seating and relationship creation remain one idempotent phase,
and demo retirement must revoke only its own authority basis while preserving
prior messages and audit evidence. Runtime impersonation must not read this
module's register.

Design: `docs/PRDs/2026-09-19_impersonation-platform/prd.md`.

### 2026-09-17 — Admit seeded uploads as attachment messages

Uploads now use ordinary message admission with a stable client message ID and
an empty, non-inferencing seeded turn. The upload receipt records that turn.
Directly attaching a pending draft bypassed its reservation and could leave a
conversation referencing a file still eligible for draft deletion or cleanup.
Retry must reuse the original upload and message identities, including when the
orchestration receipt was lost after admission committed.


### 2026-09-15 — Separate prepared prose from scripted execution

The pack's creation action now explicitly chooses history or execution. History
uses the common conversation materializer and verifies the stored turns; readiness
can expect idle without a run receipt. The decision memo exercises this mode.
Wrapping each prose string in a model-message helper did not share creation behavior,
and pretending the assistant ran would make demo readiness depend on fabricated
execution. Real scripted tool/elicitation runs remain unchanged.

### 2026-09-10 — A demo is cast from the company's directory, not invented

**What changed:** A start request carries an account per pack role instead of a
name, and the New demo form casts each part from a dropdown of the company's
own people — everyone with a `@rallywith.ai` account who has signed in to the
region (`demo-cast.ts`). Personas are gone: `demo-personas.ts` is deleted,
nothing is minted, and the pack no longer carries a default name per role. The
form opens with every part uncast rather than pre-filled, and refuses one
person in two parts or two people under one name; `checking_template` proves
every cast id is still such an account.

**Why:** The team asked for it, in those words: the invented cast was not being
used, and demos are shown with the people who actually work here.
**2026-09-09 — The cast is named, not cast from the company directory** below
argued the opposite — that casting colleagues put real names and
work addresses in front of a customer — and that argument is not wrong so much
as outweighed: the demos being given are internal and to design partners, where
a cast of people who do not exist is the thing that reads as fake, and an
operator who wants an invented name has one fewer thing to type than they had
to before. The alternative considered was keeping personas and giving them
plausible company addresses, which makes a fake account look like a real
colleague's — worse than either honest option.

**Considered and rejected:** Keeping personas beside the directory, so an
operator could choose either per part. That is a question with no good default
asked on every demo, for a cast that never signs in either way.

**Consequences:** The domain is the security boundary now. Being cast seats the
account in a workspace holding copies of the template's connections, so
`demo-cast.ts` is where who-may-be-in-a-demo is decided, it is enforced on the
request and again before the first write, and changing that constant changes
who can be seated. The list is the whole directory rather than the template's
membership, which is what the team asked for and is wider than the presenter's
list on purpose. A demo now seats people who can sign in, so a cast member sees
the demo workspace in their own account menu once it is published — that is the
point, not a leak, but it is a real change from a cast who could not sign in at
all. A preparation started before this change stores persona ids in
`cast_json`; retrying one now fails `checking_template` with
`demo_cast_not_a_colleague`, because a persona is not an account on the domain.
Start a new preparation instead — the old rows still read, and the demos they
made are unaffected.
### 2026-09-10 — A scenario is authored against a derived readiness block, and by a skill

**What changed:** `demoIdleViewerExpectation` derives a viewer's whole `expect`
block from the steps for a viewer who acts in no room, refusing one who does,
and `demo-pack.test.ts` holds the shipped pack's own block to it. A new skill,
`.agents/skills/demo-scenario/SKILL.md`, is the workflow that turns a scenario
described in ordinary words into steps, tests, this document and a pull request.

**Why:** The scenarios are the demo, and the people who know what a scenario
should say are not the people who read the pack. Authoring one meant knowing
fifteen playability rules, that Rally may cite only what the room already holds
because a seeded run makes no tool call, which three assertion lists hard-code
the pack's contents — and `expect`, which is the one input where being wrong
is silent. A mis-stated flag parses, plans and seeds; the barrier then compares
against a projection the platform will never produce and the operator watches
**Waiting for workspace** until they give up, minutes before a customer call.
Deriving it is what makes the rest of the workflow safe to hand over.

**Considered and rejected:** Deriving the flags in `demoReadinessManifest` and
dropping `expect` from the schema — the derivation holds only for a viewer who
never acts, and a barrier that quietly assumed that would verify the wrong thing
for a pack that verifies a cast member. Leaving the derivation in the test file
— it is a statement about what a pack means, and the next authoring tool wants
it. A script that writes the block into the source — the failing test already
prints it, and a generator that edits a literal is a second way for the pack to
be wrong.

**Consequences:** A pack whose presenter speaks in a room's main conversation is
refused by the derivation rather than silently unverifiable, so keep the
presenter to mentions; that is now the skill's rule as well. The flags for an
idle viewer are no longer an author's to reason out — change the derivation and
the shipped pack's block, or neither.

Shipped in #664. Design:
[the demo workspace PRD](PRDs/2026-09-04_demo-workspace/prd.md).

### 2026-09-09 — A pack can open a substream, and the demo has three rooms

**What changed:** Three things, one on top of the next.

A pack step now addresses a *conversation* rather than a room: `create_substream`
opens a private child of a room the pack already made, and a message or upload
may name that child instead of the room's main conversation. Every playability
rule is applied per conversation. Two rules are new and belong only to a child —
the pack states its roster, because a substream opens creator-only and nothing
can be inferred from the parent's seats; and a mention in a child must name
somebody already in it, because a message cannot add to a roster the parent
object owns.

The seeder plays that step through `SubstreamCreationService` — prepare,
confirm, then one participant add each, all keyed by ids derived from the demo
operation and the action so an interrupted attempt finishes the child it started
rather than opening a second one. It passes a summary gateway that returns the
pack's own text, so creation's one structured inference is answered from the
pack. `demo_seed_receipts` gains the conversation each action wrote to, by the
pack's name for it and by the id creation minted, and `create_substream` as a
fifth kind — which meant rebuilding the table in `0103`, because SQLite cannot
widen a CHECK in place.

The placeholder pack gains a third room: three people drafting the announcement
of a filing through three versions of the document, with a substream where they
argue about which publication gets it first. The presenter is in that child
without being in its parent.

**Why:** The pack could show one document and one room's worth of disagreement.
It could not show a document that goes through versions, and it could not show
the product's private-conversation feature at all — which meant a demo could not
open the one place a real team's side argument actually goes.

**What was rejected, and what a future change has to respect.** Counting a
substream's steps in `packRoomFacts` was the first attempt and it is wrong in a
way that does not fail loudly: a private child takes no directory row and the
parent aggregates only its main conversation, so a room whose seats, state,
recency or attachments came partly from its child would make the readiness
barrier wait for a projection the platform never produces — a demo stuck in
**Waiting for workspace** forever, with gaps naming things that were correct.
The rule is that substreams are invisible to `packRoomFacts`, to the manifest,
and to `expect`, and a test asserts it directly rather than by implication.

The other rejected option was letting creation's summary come from the live
model. It is the smaller diff, and it costs the pack its two most important
properties: what the presenter reads is approved copy, and preparing the same
pack twice produces the same demo.
`substream-creation.md` (retired)
holds why the seam is a gateway rather than a new context strategy.

### 2026-09-09 — A demo opens on a Sidekick that has already run

**What changed:** A pack can publish a Sidekick. `sidekick` is a fourth step
kind, and the only one that is in no room: it carries the definition's prose, a
recurrence with its zone, and optionally one `say` turn — a briefing the Sidekick
has already written. The seeder plays it through `createAutomation` and
`saveDefinition`, then starts that briefing as an ordinary Sidekick run whose
model bytes come from the seed. Migration `0101` widens the seed receipts for a
row with no room, adding the Sidekick and its run and a CHECK that keeps each
kind's identity complete. The readiness barrier now also reads each viewer's
Sidekicks list, and is not Ready until the row is listed, active, at its scope,
with a next run, and showing the seeded briefing.

The placeholder pack gains one: a workspace-scoped **Morning briefing**, authored
by the product lead, running weekdays at 9am `America/Los_Angeles`, with one
briefing behind it that cites only what the pack's two rooms hold.

**Why:** A demo that shows only conversations shows half the product. What was
asked for is a standing Sidekick on a daily schedule, and a Sidekick that is
merely configured demonstrates nothing — the presenter cannot see what it
produces until its schedule fires, which in a demo prepared at 2pm is tomorrow.

**Two alternatives were rejected.** Running the briefing against the real model
during preparation would make every demo's opening screen depend on inference
nobody can replay, and would fail in a sandbox with no provider key. Writing the
run's rows directly would put a briefing in the history that no run produced,
which is the fabricated history this feature refuses everywhere else. Reusing the
run path with a scripted provider is the only version where the briefing is a
real run.

**What a future change has to respect.** The seed reaches a Sidekick run through
`runSeeded`, which is a separate method from `runNow` on purpose — `runNow` is
what `POST /sidekicks/:id/run` reaches, and a seed on that request shape would
let a member script their own Sidekick's output and keep it as history. Keep the
two request shapes apart. The recurrence's zone stays required in the pack: a
null one resolves against the persona the Sidekick runs as, which has no zone.
And a seeded run was the gate on admission-time memory recall while that
existed — the recall used to be skipped by looking at the run's reason, which
for a Sidekick run is its trigger's, so the seed itself decided. A run carrying a seed must reach no
provider but the seam; the seeder's test proves that by refusing at the
OpenRouter double.

### 2026-09-09 — The cast is named, not cast from the company directory

**What changed:** A start request carries a name per pack role instead of a
user id, and preparation mints a **persona** for each — a regional user with
that name, no platform identity, and an address under `.invalid`
(`demo-personas.ts`). Only the presenter is still chosen from the template's
members. The pack carries a default name per role, which is what the New demo
form opens on. `checking_template` proves every cast id is this operation's
own persona; `demo_cast_not_in_template` is gone.

**Why:** The form could only cast the people in the Google workspace, so a
demo for a customer was staffed by Rally's own employees, under their real
names and work addresses, in front of that customer — and a demo could not be
prepared at all unless the template happened to seat as many people as the
pack has roles. Naming the cast is what the operator actually wants to do, and
the alternative considered — keeping the member pickers and adding personas
beside them — was rejected: a seeded cast member never signs in, so a real
account in the cast buys nothing over a name and costs the operator a choice
they have to make every time.

**Consequences:** The ids in `cast_json` are minted by the region, so nothing
a request says can seat an account in a demo workspace; that is an invariant
now, checked twice. A persona's identity is derived from the operation and the
role rather than stored, which is what makes minting idempotent under a repeat
or a retry — changing either half of that derivation orphans the people an
operation already made. Personas are not cleaned up when a demo is abandoned
or retired: a `users` row is referenced by everything it wrote, and a demo's
history is what makes it replayable. Whoever adds a second pack has to give
every role but the presenter's a default name; the schema refuses a pack
without one.

### 2026-09-09 — A seeded run is routed past Azure

**What changed:** `demoSeedModelRoute` picks the model a seeded run is routed
under — the resolved primary when it is not Azure-bound, otherwise the first
unbound fallback, otherwise a fixed unbound id — with no fallbacks, and
`runWorkstreamHarness` leaves the Azure transport out of a seeded run's config.

**Why:** Found by tracing the production path before the instance-id fix
below deployed. The seam replaces the OpenRouter client's `fetch` only, and
production routes `x-ai/grok-4.3` to Azure first: a seeded `say` would have
been a live model's words and a seeded `ask` would have failed
`demo_seed_run_outcome_mismatch`. Local and test environments never showed it
because they route to OpenRouter. [`agent-harness.md`](agent-harness.md)
records why the route was pinned rather than the seam widened.

**Consequences:** A seeded run records the unbound model as its own, which in
production is `google/gemini-3.6-flash`. A change to the production model
variables cannot break seeding, only change that record.

### 2026-09-09 — The Workflow instance id is one the platform accepts

**What changed:** `demoPreparationInstanceId` builds the launch id as
`demo-preparation-<operation>-<attempt>`; it was `demo-preparation:<operation>:<attempt>`.
The test Worker binds the real `DemoPreparationWorkflow`, and a workerd test
hands both forms to it.

**Why:** The first production launch failed with
`demo_preparation_launch_failed`. Cloudflare accepts an instance id only if
it matches `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` (the validator in
`workflows-shared`, which Miniflare bundles), and colons are outside it. No
test caught it because the Node suite's driver is a fake that accepts any id
and the workerd suite drove the phases by hand; the new test is the missing
one, and reproduces the refusal locally. Every other Workflow id in this
Worker already used hyphens.

**Consequences:** An operation that failed at launch before this change
retries cleanly — Retry launches attempt 2 under the new id. A Workflow id
built anywhere in this Worker should be handed to the real binding in a test
at least once.

### 2026-09-08 — The demo routes read `DEMO_OPERATORS_JSON`

**What changed:** `demo-operations.ts` verifies Ace's token with
`requireDemoOperator`, against the per-region `DEMO_OPERATORS_JSON` secret,
not the telemetry map; the route test refuses a telemetry token as invalid
and a `support` principal filed in the demo map by role.

**Why:** Decided in [#593](https://github.com/juno-ai-labs/avalon/pull/593)
and recorded in [`workspace-retirement.md`](workspace-retirement.md#changelog):
a Worker secret cannot be read back, and adding the `demos` role to a
telemetry secret somebody else had set meant overwriting tokens nobody could
name. These routes follow the retirement route to the same secret.

**Consequences:** Operators set `DEMO_OPERATORS_JSON` in Global before the
first demo; `TELEMETRY_OPERATORS_JSON` is never touched for this feature.

### 2026-09-08 — Review: what a demo may share, what a retry can reach, and where the driver is bound

**Why:** A review swarm on the split PR. The copier shared a grant the
presenter could revoke remotely for the template and every live demo. The
filter tested `retired_at` as well as `ready_at`, so abandoning a candidate
retired a workspace and then offered it. Two lists ran unchunked on paths a
member's or an operator's history grows. Abandon checked, walked, then wrote,
and a driver publishing Ready in between would have been retired as a
candidate. `DEMO_PREPARATION_WORKFLOW` in the production boot contract would
have taken Global offline on a deploy without the binding — a demo tool's
binding must never do that. The seeded-run entry, now part of the entry
below, claimed Retry recovered a failed seeded run; the derived client message
id, the very thing that makes replay safe, is what makes that impossible. The
withholding entry, now part of the entry below, said discovery pays "none at
all for a member in no demo", which was never true: the read is what answers
the question, and it is made for every member in any workspace but the
template.

**Consequences:** Adding a provider to `SHAREABLE_CONNECTOR_TYPES` is a
decision about its revocation and refresh behavior. A seeded run that fails is
the operation's end; fix the pack and start another. Every status write on the
operation row is fenced on the status it expects, not only on the attempt. A
new list over ids uses `boundParameterChunks`.

### 2026-09-08 — The demo module lands after retirement: a durable operation, the seeder, the readiness barrier, withheld candidates, and its review round

**What changed:** This module is the third PR of a split: the loop's
transcript mark landed first, retirement second with its own document, and
this is what remains — the register, connection copying, the pack, the seeder,
the barrier, the operation, the routes and the Demos page. The retirement
route and its Ace relay live in retirement's files; this feature adds the
walk's `retired_at` write on the operation row, the `demos` role's other
routes, and the Demos page beside the Workspaces tab. The parts, in the order
they were decided:

- *Withholding.* Regional discovery drops the template and an unpublished
  candidate from a member's workspace list, and activating an unpublished
  candidate answers `demo_workspace_preparing`.

- *Retirement, and no demo mode.* `retireWorkspaceGraph` no longer consults
  the register; `isRetirableDemoWorkspace` and its refusal are gone (the walk
  itself is now [`workspace-retirement.md`](workspace-retirement.md)).
  `currentDemoWorkspace` became `liveDemoWorkspaces`, a list. Demo mode — the
  suppression of background connector activity in a demo — is dropped from the
  PRD before it was built.

- *The seeder.* `DemoSeedSchema` in contracts, and an optional `seed` on the
  message the object admits, on `initialize`, and on the run's execution
  context. The object skips the addressing classifier for a seed action and
  starts a run exactly when the seed carries a turn. The harness sets
  `OpenRouterConfig.fetch` to `demoSeedProviderFetch` for a seeded run.
  `demo-pack.ts` holds the schema, the planner, and the placeholder pack;
  `demo-seeder.ts` plays one action at a time and records
  `demo_seed_receipts`. A `demo_seed` auth principal lets the cast act without
  a session.

- *Readiness.* `demo-readiness.ts`: `demoReadinessManifest` derives what each
  verified viewer should find from the pack's steps, its new `expect` section
  and the seeder's receipts, and `checkDemoReadiness` compares that with the
  viewer's whole directory, their attention summary, and each room's canonical
  detail read as its creator, reporting every gap by name. The pack schema
  gains `expect` and checks a viewer's listed rooms against the rooms the pack
  makes visible to them; `packRoomFacts` is the one statement of who ends up
  in a room.

- *The operation.* `demo_operations` and `demo_operation_phases`;
  `demo-preparation.ts` with start, retry, abandon, status, the template's
  cast candidates, and the five phase functions; `DemoPreparationWorkflow`
  bound as `DEMO_PREPARATION_WORKFLOW` in configured deployments; `/internal/demos` and
  `/internal/workspaces/:id/retire` behind a new `demos` operator role;
  `RegionalOnboardingService.createWorkspaceForMember`, a session-less create
  that shares the rows, journal, checks and object initialization with
  `create`. The wait was first bounded by `DEMO_PROJECTION_WAIT_TIMEOUT_MS`,
  unset by default; the review below removed it.

**Why:** The combined branch was eleven thousand lines with three different
blast radii — a model-context change in every multi-person room, a gate on
every object method, and an additive feature nothing runs until an operator
starts it — and reviewing and observing them together would have hidden the
first two under the third.

- *Withholding.* Preparation takes minutes, and a presenter who opens a
  candidate in the middle of it sees a half-seeded sidebar and can open a room
  the pack has not finished writing. The template is separate and permanent:
  it holds the demo cast's real connections and is never a workspace a member
  should find.
- *Retirement, and no demo mode.* Three decisions from review. The
  register-as-authorization was bookkeeping for a surface that one Access
  policy already admits, and an operator tool that can retire *any* workspace
  is what was actually wanted. Demos run concurrently — two presenters, two
  prospects, the same afternoon — so "the current demo" and "retire the
  predecessor once the successor is Ready" were the wrong shape: New demo
  creates one, retirement is a separate action, and neither knows about the
  other. And demo mode was judged not worth the branching it adds: scheduled
  work is something a demo might want to show, and a demo that behaves like
  any other workspace is simpler to reason about than one with a second set of
  rules.
- *The seeder.* The PRD's seeding rule — every seeded fact through the
  production writer, as the member who did it — leaves two decisions nobody in
  that path can make: whether a line starts a run, and what the run says. The
  spike carried both on a replay context that also carried a historical
  instant, and the instant was the part the PRD rejected. So the seed carries
  identity and the one turn, and nothing else, and it decides addressing
  itself rather than through `forcedHarnessOrigin`: one field that says "run,
  and say this" or "no run" cannot disagree with a second flag that says the
  same thing. One turn rather than a script of turns because a seeded run
  makes no tool calls — a stale tool name in seeded history is a wrong claim
  about what Rally did — and without tool calls Bind asks once; a second
  request is refused rather than repeated, which is the failure the spike's
  first adapter had. Applying and settling are separate calls so the operation
  can hold both in one step and a test can force the alarm between them.
  `demo_seed` is its own principal value rather than a reuse of `connector` so
  the run's authorization record says who acted; the object verifies both the
  same way.
- *Readiness.* The PRD's readiness contract is a read through the ordinary
  directory and attention surfaces as every intended viewer, against
  expectations generated from the receipts, following pagination, opening
  nothing as the presenter. The spike's `awaitWorkspaceDirectory` checked only
  that an id was present, and read as the author. Derived where derivation is
  honest — room set, seats, state, order, ids — and stated in the pack where it
  is not: the per-viewer flags depend on who opened what, and the seeder's own
  reads open rooms for the cast, so a derivation would encode the seeder's
  reading habits as product truth. The barrier is one comparison rather than a
  wait because the wait policy is the team's open decision, and the operation
  that holds the deadline is the place for it.
- *The operation.* The PRD's operation is durable, resumable, identified by an
  id the operator chooses, and readable as phases with real receipts. A
  Workflow gives the durability and the retry; the rows give the identity and
  the receipts, and keeping every phase idempotent is what makes the two
  agree — the Workflow's retry and the operator's retry both resume rather
  than repeat. The workspace id is allocated onto the row before creation so
  no retry can make two workspaces. Creation goes through onboarding because
  the PRD requires ordinary regional placement, membership and routing, and
  through a session-less variant because a session minted for the presenter
  by an operator would be a credential nobody signed in for. The wait is a
  loop of steps rather than one long step so an eviction resumes at the next
  check, at the cost of the platform's step limit bounding an open wait —
  recorded rather than capped, because the ceiling is the team's to set. The
  routes reuse the operator credential with a role of their own: one secret
  to rotate, and a token that can only do this.
- *The review round.* A review swarm on the finished feature. The foreign key
  was a shipping defect: D1 enforces it on the write, and the creating phase
  writes the id before the row it would reference, so preparation died at its
  second phase in production and in no test — the workerd fixture declared the
  table without the constraint. The register was a second table holding the
  operation's identity with two extra columns and one dead reader, and two
  children of the same operation id pointed at different parents. The state
  machine had no fence: a phase failure marked the operation failed while the
  step's own retries were still pending, Retry was offered on that, and a
  second driver would have raced the first — up to a stale driver flipping a
  published demo back to `failed` and Abandon retiring it. The wait ceiling
  could never fire, because the phase row's `started_at` was reset every
  round, and its value arrived through a Wrangler variable, which the limits
  document names as smuggling. The `demos` role reached three telemetry routes
  because only the demo routers narrowed by role. A presenter was checked to
  exist and not to belong to the template, which would have handed a customer
  account a workspace holding the template's credentials. The barrier
  fabricated a `member` role for a viewer membership did not know. A seeded
  run embedded its recall query through the real endpoint. A shared token was
  destructive authority in both jurisdictions from one leak.

**Considered and rejected:**

- *Withholding.* Withholding a *retired* demo too — it is closed by its
  tombstone, and hiding it as well would make a workspace vanish from its
  presenter's switcher while its rooms still answered. Filtering the template
  by name — renaming it would defeat the filter, and naming another workspace
  `demo-template` would acquire it. Refusing to activate the template — the
  filter is a discovery filter, not its security gate, and an operator
  maintains it by opening it.
- *Retirement, and no demo mode.* Keeping the register check as a soft
  warning — either it blocks or it is noise. Keeping demo mode as a flag — the
  whole objection was the flag.
- *The seeder.* Carrying the turn on `forcedHarnessOrigin`, a second flag that
  could disagree with the seed; a replay context with a historical instant,
  which the PRD rejected; a script of turns, which would put tool names in
  seeded history that no tool call backs.
- *Readiness.* The spike's `awaitWorkspaceDirectory`, which checked only that
  an id was present and read as the author; deriving the per-viewer flags from
  the seeder's own reads, which would have encoded its reading habits as
  product truth.
- *The operation.* One long Workflow step for the whole wait — its result is
  what the platform memoizes, so an eviction would restart the wait from the
  beginning. A second operator secret with the same shape — one secret to
  rotate, and a role that names what it can do, was the smaller change.
- *The review round.* Keeping the ceiling as an env var and fixing the reset —
  the number would still arrive sideways, and the platform's own limit already
  bounds the same wait; the round count is arithmetic from that limit, not a
  number chosen here. Step retries kept and the operation marked failed only
  after them — the operator's Retry is the retry, and one mechanism is easier
  to reason about than two racing. Region-binding the operator principal
  instead of two tokens — a second secret is the smaller change and matches
  the per-region rule `security.md` already states.

**Consequences:** Nothing in this PR runs until an operator starts a demo.
Retirement's invariants are stated once, in its own document; this one says
only what the demo adds to them.

- *Withholding.* Discovery pays one D1 read bounded by the workspaces the
  member is actually in, and none at all for a member in no demo. A caller
  that shows a workspace list must expect `demo_workspace_preparing` from
  activation.
- *Retirement, and no demo mode.* The confirmation in Ace is the only thing
  between an operator and an irreversible close of a customer workspace; build
  it to make the operator type or paste the id. Nothing assumes one live demo:
  every reader of the register takes a list. A demo's connectors poll, watch
  and notify like anyone's, so a presenter can be interrupted by mail
  arriving — that is now a pack and account-hygiene concern, not a code one.
- *The seeder.* A seed must never gain an instant. The receipt is written
  after confirmation, and a replayed action must keep meeting the production
  path's own receipt — the derived client message id and resource id are what
  make that true, so an action whose write cannot be keyed that way cannot be
  a seed action. The elicitation is addressed to the room; the
  targeted-question seam the spike tried is a contract change the PRD
  declined.
- *Readiness.* The presenter is read only through non-opening surfaces; a
  canonical read as the presenter would destroy the state the check exists to
  verify. Every gap is reported, not the first, because the operator's waiting
  state lists them. Notification effects are not part of readiness and must
  not become a precondition of it — the projection they ride beside is.
- *The operation.* Every phase must stay safe to run twice. Publishing Ready
  stays inside the waiting phase. Abandon retires and closes; it never deletes
  rows. The operator credential's `demos` role must not gain telemetry reach,
  nor the telemetry roles this reach.
- *The review round.* `demo_operations` is the register; nothing else records
  which workspaces this feature made. Every status write must carry the
  attempt. Adding an operator router means naming its roles. The migration is
  one file, unshipped, and stays editable until it ships.

Design: `docs/PRDs/2026-09-04_demo-workspace/prd.md`.

Earlier entries — the gate, the permit-as-a-call, and the first version of the
walk — are in [`workspace-retirement.md`](workspace-retirement.md#changelog).
