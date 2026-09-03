# Automation drafts

> Historical design record. The subscription-row authority described below was
> retired by the durable automation lifecycle cutover. Current implementation
> guidance is [`automation-lifecycle.md`](automation-lifecycle.md): a draft is a
> state of AutomationAgent, begins only on first send, and is deleted rather
> than archived.

An automation that someone has begun setting up but has not created is a
**draft**: a real `automation_subscriptions` row, listed in the sidebar under
Automations, that never runs. It carries no schedule, holds no email address, and
is scoped to the person writing it. It stops being a draft in exactly two ways —
its author creates it, which promotes the same row to `active`, or its author
archives it, which hides it for good.

The promise this makes is that setting an automation up is visible work.
Describing one to Rally takes several turns and can be interrupted; a
conversation that lived only in the window it was typed in was work that
disappeared the moment the window went somewhere else. Read this before changing
the automation compiler, `POST /automations`, the sidebar's automation section,
or the New automation screen.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/automation-service.ts` | `saveDraft` writes each compiled turn; `draftState` reads one back; `create` promotes one; `archiveDraft` hides one. `loadOwnDraft` is the single check of whether a client-supplied draft id may be written through to. |
| `apps/api/src/services/automation-draft-attachment-tools.ts` | Gives the compiler bounded access to the exact attachment IDs frozen into its current request while rechecking present ownership and draft state. |
| `apps/api/src/routes/automations.ts` | `POST /automations/draft/stream` and `POST /automations/draft` compile and persist; `GET /automations/:id/draft` returns the conversation; `POST /automations/:id/archive` hides it. |
| `packages/contracts/src/index.ts` | `AutomationDraftStateSchema` is the resumable conversation; `AutomationDraftStreamEventSchema`'s `completed` event carries the draft's id; `CreateAutomationRequestSchema.draftId` is what makes creation a promotion. |
| `apps/desktop/src/renderer/lib/api.ts` | `compileAutomation` adopts the id the API assigns; `resumeAutomationDraft` reopens one; `createAutomation` names the draft being promoted. |
| `apps/desktop/src/renderer/screens/new-automation.tsx` | The builder: resumes `?draft=<id>`, and names the draft it wrote in the URL. |
| `apps/desktop/src/renderer/components/sidebar.tsx` | Sinks drafts below the automations that run and points their rows back at the builder. |
| `packages/db/migrations/0065_automation_draft_conversation.sql` | `draft_conversation_json`, the saved transcript. |

After the maintenance cutover, templates, versions, subscriptions, schedules,
memory definitions, delivery targets, and automation-resource relationships are
all WorkspaceDO rows. The services retain their repository shape through the
typed workspace SQL adapter; D1 has no draft or automation serving projection.

## How it works

### A turn writes a draft

Every compile turn ends in `AutomationService.saveDraft`. The first turn inserts
a private template, its version 1, and a subscription with `status = 'draft'`;
each later turn updates those same three rows in place. The id of that
subscription is returned to the client on the stream's `completed` event, and the
client sends it back on the next turn — so the automation has one identity from
the first sentence someone types about it.

The client does not mint that id. It opens a conversation with no `draftId` at
all and adopts whatever the API answers, because an id invented in the renderer
names nothing that another surface — the sidebar, a second window, tomorrow's
session — could look up.

What the row deliberately lacks is as much of the design as what it holds:

- **No schedules.** `schedules` rows are what the workspace scheduler reads. A
  draft that carried one would be a half-written automation that fires.
- **No email address.** An address is a way to reach an automation, and there is
  nothing here to reach. Listing and reading a draft therefore never call the
  Global registry; the address is reserved when the draft is promoted, which is
  also the first moment its route could legitimately be activated.
- **No workspace scope.** The compiler's `suggestedScope` is a proposal recorded
  inside the draft, not a decision. The row stays `personal` and owned by its
  author, so an unfinished idea is never in a coworker's sidebar.

### The saved conversation

`draft_conversation_json` holds the compiler's transcript, the attachment
resources it was given, and the draft it last produced — precisely the body the
next `POST /automations/draft/stream` sends. The assistant's reply to the current
turn is appended by the service, so a resumed draft ends on the same question the
person walked away from rather than on their own last message.

`GET /automations/:id/draft` returns it. The builder renders every turn as text
except the compiler's last, which it re-renders from the draft so a choice that
was open is open again rather than being a sentence describing one.

Attachments in the current compile request are also a frozen hydration scope.
The compiler sees durable manifest entries and five `automation_*` read tools;
the scope never expands beyond those IDs, and each call requires the resource to
still be this user's draft upload in this workspace. Deleting an upload, changing
its owner, or committing it elsewhere revokes it during the same compiler run.
The saved conversation may remember an ID for continuity, but that identity is
not authority on a later request.

### Promotion

`POST /automations` with a `draftId` naming a promotable draft updates that row
rather than inserting beside it: the template and version take the final draft's
content, the subscription takes the chosen scope, principal, connector bindings,
and model override, `status` becomes `active`, and `draft_conversation_json` is
cleared. Schedules, memory tables, delivery targets, and resource relationships
are inserted in the same WorkspaceDO transaction, and the address is claimed in
the Global ledger after it.

The id therefore survives, which is the point: the sidebar row someone watched
appear while they described the automation is the row that becomes the
automation. A request without a `draftId`, or with one naming anything the caller
may not write through to, inserts a new automation exactly as it always did.

Promotion is also where a calendar trigger's timezone is settled. A draft carries
the zone the person named for it and null when they named none, and the
`schedules` row is derived in the account's — the owner's `users.timezone` for a
personal automation, `workspaces.timezone` for a workspace one. It is read here
rather than when the draft was compiled because the scope is chosen on this
screen, not by the compiler: a draft the compiler suggested sharing and its
author kept to themselves runs in their day, not the workspace's.

The null is what makes that possible, which is why nothing fills it in earlier.
The client posts the draft it holds beside the scope it chose, so a default
substituted at compile time arrives here as a concrete zone indistinguishable
from one the person asked for, and this screen has no way to tell the two apart.
The same distinction is what a shared template needs: an adopter takes the
author's zone when the author named one, and their own when nobody did.

## Invariants

- **A readiness rule the model cannot read is a trap.** `AutomationDraftSchema`'s
  refinements decide whether a draft is ready, and none of them can be expressed
  in the JSON Schema the compiler shows the model — they are cross-field, and the
  prefilter's lives inside an opaque JSON string. Each one is therefore stated
  somewhere the model reads, and reaches it as a named field when it breaks,
  because `automation_submit_draft` declares the same parse as its
  `validateInput`. A refinement added with neither leaves the model able to fail
  it and unable to learn why, which is how a compile reaches a state it cannot
  leave. The refinements live in `@rally/contracts`, a package away from both
  this document and the compiler, so a new one passes every test in its own
  package while doing this. One is still unstated in everything the model reads:
  memory-table names must be unique within an automation. It arrives as a named
  field when it fails, which is the floor rather than the goal.

- **A draft never runs.** Every path that starts a run — the scheduler alarm,
  activity matching, inbound email, a manual run — requires
  `status = 'active' AND lifecycle_state = 'visible'`. Adding a start path that
  checks only one of those, or that treats any non-`paused` status as runnable,
  makes a half-written automation fire against a definition its author never
  agreed to.
- **A client-supplied draft id is a claim, not an instruction.** `loadOwnDraft`
  admits only a visible draft in the caller's workspace that the caller owns.
  Both writers — `saveDraft` and `create` — go through it. A second reader that
  matches on id alone would let one request rewrite another person's automation.
- **A draft is personal until its author creates it.** `scope` is `personal` and
  `owner_user_id` is the author for the whole of a draft's life. Deriving the
  row's scope from `suggestedScope` would put unfinished drafts in every
  workspace member's sidebar.
- **Creation promotes rather than duplicates.** If `create` ever inserts a new
  subscription for a request that carried a promotable draft, the finished
  automation appears alongside the draft it came from and the draft has to be
  archived by hand.
- **A draft holds no email address.** Nothing on a read path reserves one, and
  deleting a draft does not either — reserving an address purely to record its
  end would tombstone one forever for an automation nobody created. Reserving on
  read would also make opening the sidebar depend on the Global registry. Mail to
  a draft's address could not start a run in any case — the resolver requires
  `status = 'active'` — so the address would buy nothing and cost a name.
- **The only way out of `draft` is `create` or `archiveDraft`.** `setPaused` and
  `shareSubscription` each refuse a draft for that reason. Resuming would reach
  `active` without any of the scope, connector, and binding validation creation
  does; sharing would publish a half-written template *and* leave a subscriber
  pinned to the version row every later turn rewrites in place, so their
  automation's definition would change under them with no version bump. Any
  further writer of `status` — or of `sharing_state` — needs the same refusal.
- **A draft's rows are written only while it is still a draft.** A compile turn
  takes seconds, and the row can be created or archived from another window in
  that time, so every statement in `saveDraft` carries the condition rather than
  trusting the check that preceded it. Without it a turn begun before a
  promotion rewrites the finished automation's name and instructions and hangs a
  draft conversation back off it.
- **Creation claims the draft before it writes anything else.** The claim is the
  status transition itself, so two creations of one draft cannot both proceed.
  A second one that got as far as the child inserts would give the automation
  two of every schedule — nothing constrains a subscription to one — and it
  would fire twice for every trigger.
- **A surface that lists automations by recency excludes drafts.** A draft's
  `updated_at` moves on every compile turn, so any query ordered by it — Slack's
  App Home is the one today — is otherwise led by whatever is being typed right
  now, and led away from the automations that run.
- **The result is Markdown, not an email.** The compiler asks for headings,
  bullets, numbered lists, bold, italic, inline code, and links — never for a
  wrapper, an HTML document, or a subject line. Rally renders the email around
  the result; a model asked for an email-shaped artifact produces one nested
  inside another, and asked for a table produces the one structure the renderer
  keeps verbatim rather than laying out.
- **A draft names no destination.** Where a result should go is written into
  the instructions like any other step, and the run sends it there itself with
  its connector tools; Rally posts the result nowhere but the room that owns the
  automation. The former `requestedDelivery` field is gone, and a stored draft
  that still carries it parses with the key stripped.
- **A send is a step.** "Email me the briefing" belongs in `instructions`, with
  its recipient, because the run is what performs it; an instruction that only
  says to prepare the result produces a run that prepares it and sends nothing.
  The one send the compiler must not write is a post to the owning room, which
  Rally makes itself; the run-time half of that rule is the `# Result delivery`
  section described in [`agent-harness.md`](agent-harness.md).
- **The saved transcript ends with the reply on screen.** The service appends the
  assistant message it streamed. Persisting only the request's messages would
  resume every draft one turn behind what its author last read.

## Boundary

This module owns the draft's lifecycle: its row, its saved conversation, its
promotion, and its archival. It owns nothing about what the compiler decides —
the automation architect, its prompts, its tools, and the shape of an
`AutomationDraft` belong to [`agent-harness.md`](agent-harness.md).

It does not own an automation that runs. Once promoted, the row belongs to the
automation surfaces described in [`data-model.md`](data-model.md) — schedules,
runs, delivery, and the overview screen — and there is no path back to draft.

It does not own the composer's own draft text or attachment bytes, which are
cached on the device by [`composer-drafts.md`](composer-drafts.md). The two
answer different questions: that cache keeps the sentence someone was typing,
this module keeps the automation they were describing.

### Product measurement

The renderer records when a new or resumed builder becomes actionable. The API
records each compiler turn after its durable draft write, including input mode,
bounded attachment/connector counts, duration, result, turn bucket, and whether
the revision is create-ready. The first create-ready revision emits once with
trigger, connector, plugin, visibility, and delivery-target classes. Elicitations
receive a stable server UUID and presentation time; resolution records only
response type, answered/skipped, custom-response use, and latency. Neither the
conversation, prompt, follow-up question, answer, compiler output, nor attachment
content enters telemetry. Promotion emits the authoritative automation creation
from the API, not a second renderer completion.

## Failure modes and limits

- **The compile fails.** Nothing is written. `saveDraft` runs only after the
  compiler returns a draft, so a provider error, a timeout, or invalid model
  output leaves the previous turn as the saved state and the conversation on
  screen unchanged.
- **A submission the draft schema rejects** is answered with the field that has
  to change. `AutomationDraftSchema`'s refinements — a ready activity trigger's
  binding key, its inspected plugin, one declared `deterministicPrefilter`
  event type — are what decide readiness, and none of them can be stated in the
  JSON Schema the model is shown, so the compiler hands the same parse to the
  harness as the submit tool's code-authored refinement. Without it a rejection
  reads as an external fault, the model is told to resubmit unchanged, and the
  turn ends `automation_draft_not_submitted` — a `502` the person can only
  answer by retrying into the same wall. [`agent-harness.md`](agent-harness.md)
  owns the classification.
- **A draft that cannot bind its activity source** is still saved, as a draft
  that is not ready with the reason as its follow-up question. That is the case
  someone most needs to come back to.
- **The database write fails.** The turn fails with it and the person retries;
  there is no path that streams a reply for a turn that was not saved, because a
  draft resumed one turn behind is worse than a turn that visibly did not land.
- **Archiving or deleting a draft that is open** navigates the builder away,
  since the API will not serve its conversation again. `showsAutomation` in
  `app-shell.tsx` is the one place that answers "is this automation on screen",
  and it has to know about the builder as well as the overview — a draft is
  reached through a query, not a path of its own.
- **Attachments do not come back on resumed turns.** The resource ids are
  preserved and sent on the next compile, so the compiler still sees them, but
  the transcript renders those turns without their attachment tiles — only the
  ids are persisted, not the per-message metadata.
- **A conversation this deploy cannot read** answers `409
  automation_draft_unavailable` rather than failing. `AutomationDraft` is a
  model-output contract that has changed before, and a draft written by an
  earlier deploy can stop parsing; the draft stays listed and archivable rather
  than becoming a row that answers 500 forever with no way to clear it.
- **A resume that is loading or has failed** shows that, and refuses to send.
  A turn sent in that window would carry no draft id and open a *second* draft
  while the sidebar still highlights the first.
- **Two windows writing one draft** is last-turn-wins on the saved conversation.
  Each turn carries the whole transcript, so the loser's next turn restores its
  own and the draft stays coherent; what is lost is one turn's text. A revision
  token was rejected for this — it would reject a turn *after* the model had
  already run, which costs more than it saves for a conflict that needs the same
  draft open in two windows.
- **No expiry.** A draft stays until its author creates or archives it. The
  transcript is bounded only by the conversation's own length, and the compile
  request carries the same messages, so a draft too large to save is a draft too
  large to compile.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/automation-draft-persistence.test.ts` | The lifecycle end to end against a migrated SQLite database: a draft appearing in the list, later turns updating it in place, the conversation coming back, promotion keeping the id, and a draft id the caller may not write through to. |
| `apps/api/test/automation-lifecycle.test.ts` | Archival, and the refusal to archive an automation that runs. |
| `apps/api/test/automation-compile-source-validation.test.ts` | An unbindable activity source still saving as a draft, and a hand-built `ConnectorError`'s mapping to a typed `ApiError` — reconnect-required only for the exact code-plus-detail shape `isReconnectRequiredConnectorError` checks, non-retryable otherwise. |
| `apps/api/test/automation-compile-connector-registry.test.ts` | The mapping above against the real, unmocked `loadAutomationCreatorPluginCatalog`: a stored connection naming a `connector_type` this environment does not register reaches `AutomationService.compile`'s catch block and comes back as `automation_connector_failed`. |
| `packages/agent-harness/src/index.test.ts` | The compiler's submission loop: the field a refused draft is answered with, and that a corrected resubmission compiles. |
| `packages/contracts/src/index.test.ts` | Every readiness refinement's path and message — what the model is actually told when a draft is refused. |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` | Draft ordering, the row's link, and the archive menu item. |
| `packages/agent-harness/src/automation-compiler-wire-roundtrip.test.ts` | A regression pin, not a two-version-skew detector: the normalizer's trigger handling for an unnamed multi-time-daily calendar schedule surviving `AutomationDraftStreamEventSchema` and a JSON transport round trip. |

Run them with `pnpm --filter @rally/api exec vitest run test/automation-draft-persistence.test.ts`
and `pnpm --filter @rally/desktop exec vitest run src/renderer/screens/new-automation.test.tsx`.

Three traps in the renderer suite. `api.resumeAutomationDraft` is stubbed to
**reject** in `beforeEach`: a resolved fixture left over from another test
silently replaces the transcript under the test that follows it, which is how a
green suite hid a real defect once already. `renderScreen` mounts a location
probe, because the screen's own URL write is otherwise invisible to a test. And
it renders two plain links to `/automations/new`, with and without a draft in
the query — anything about switching between drafts has to be driven through a
navigation that does *not* remount the screen, because that is the only case
where the screen has to clean up after itself.

## Data model

One column beyond what an automation subscription already had:

| Column | Meaning |
| --- | --- |
| `automation_subscriptions.draft_conversation_json` | The compiler transcript, attachment ids, and last draft. Written on every compile turn, `NULL` for every automation that runs. |

`status = 'draft'` and `lifecycle_state = 'visible'` together identify a live
draft; `lifecycle_state = 'archived'` is a dismissed one.
[`data-model.md`](data-model.md) stays authoritative for both enums.

## Security and trust model

The draft id travels through the client, which makes it attacker-controlled
input on both write paths. It is never trusted as a target: `loadOwnDraft`
resolves it against workspace, owner, status, and lifecycle, and a claim that
fails to resolve starts a new draft instead of failing loudly — a request cannot
use the difference between "not yours" and "does not exist" to enumerate other
people's automations.

The draft's contents are user-authored context and stay user-role in every
prompt, as [`agent-harness.md`](agent-harness.md) requires. Nothing in a saved
conversation grants authority: connector bindings are validated and frozen at
creation, not at draft time.

## Changelog

### 2026-09-03 — A draft names no destination

**What changed:** The body no longer describes `requestedDelivery`; the field
left `AutomationDraftSchema` and the submit-draft tool schema, and the create
screen that pre-selected from it was deleted on 2026-09-01. The Testing row for
`new-automation.test.tsx` is removed with it.

**Why:** An automation has no destinations of its own; the decision and its
alternatives are in [`automation-lifecycle.md`](automation-lifecycle.md). This
entry records that the drafts document caught up with it.

### 2026-09-01 — The standalone draft screen is retired

**What changed:** `new-automation.tsx` and its tests are deleted.
`/automations/:id` serves durable automations only; `/automations/new` and the
`rallywithai://automations/new` deep link redirect to a new work stream, and the
sidebar's "New automation" does the same. An agent drafting in a work stream
proposes the automation as a card in that feed, and accepting it calls the same
`acceptDraft` the screen used to call.

**Why:** A draft *is* a conversation in progress. The screen was a second place
for that conversation to happen, with its own feed, its own draft state, and its
own accept — and the work stream feed it duplicated had grown every feature the
draft surface lacked. One conversation surface, in the place the conversation
actually happened.

**Considered and rejected:** Keeping the screen for drafts already in flight.
That makes the retirement wait on other people's half-finished work for a
surface being removed because it should not exist, and a read-only view with an
Accept button is a surface built solely to bury the dead. Those drafts are
deleted instead, with the count taken first —
`scripts/retire-standalone-automation-drafts.mjs` — because losing work you
started is worth a sentence even when the work was minutes old. Also rejected:
removing the sidebar affordance. People look for it there; what it opens is now
the conversation rather than a builder.

**Consequences:** A draft authored inside a work stream is not stranded and is
never deleted by that script — its room is still open and its proposal card is
still in the feed. `automation_builder` stays in the telemetry union because
rows recorded before this still carry it, but nothing reports it any more: a
draft opens the same overview an accepted automation does.

### 2026-08-28 — Draft authority moves into AutomationAgent

**What changed:** New automation navigation creates no server state. First-turn
admission creates one AutomationAgent whose draft conversation, compiler state,
and later accepted lifecycle share one ID. Legacy draft rows are discarded by
the one-shot cutover; draft deletion tombstones the object and removes its
projection.

**Why:** A resumable draft needs durable ownership, but a separate subscription
row and conversation authority made acceptance a cross-authority promotion.

**Consequences:** The remainder of this document is retained as historical
reasoning only. Use `automation-lifecycle.md` before changing the current path.

### 2026-08-25 — A rejected submission tells the compiler which field to fix

**What changed:** `automation_submit_draft` hands the harness the same parse its
executor runs as a code-authored refinement, so a submission the draft contract
rejects comes back naming the field. The submission schema and the compiler
policy both state the requirement that had been invisible: a ready
`semantic_activity` trigger names one declared event type in its
`deterministicPrefilter`. A prefilter string that is not a JSON object now
reaches the schema instead of being coerced to `{}` — which had produced the
same un-actionable rejection for a model that sent unquoted keys or a
double-encoded string, and which silently dropped a filter the model wrote from
a saved automation.

**Why:** the compiler could reach a state it could not leave. The submit tool's
advertised JSON Schema accepts a draft the same tool's executor then refuses,
and with no refinement declared the harness read that refusal as a fault in
somebody else's system — telling the model to retry without changing its
arguments. On request `8592b3f1` the model complied four times over one missing
`deterministicPrefilter.eventType`, the compile ended with no draft, and the
person got "Avalon could not refine the automation draft. Try again" for a turn
where trying again could not have helped. Nothing was written, so the loss was
the turn rather than the draft — but a builder that answers a fixable mistake
with an unfixable error is worse than one that saves a draft that is not ready.

**How it is proved:** `packages/agent-harness/src/index.test.ts` asserts the
correction the model receives names
`triggers[0].deterministicPrefilter.eventType` and that the corrected
resubmission compiles. `apps/api/test/automation-compile-source-validation.test.ts`
still covers the neighbouring case, where a draft that cannot bind its source is
saved as not ready rather than failing.

**What a future change has to respect:** recorded above as an invariant, since
the refinements live in another package and a changelog is not where a future
change is checked.

**Considered and rejected:** *Saving the rejected draft as not-ready* so the turn
survives: the draft that arrived is the model's, not the person's, and storing a
draft whose triggers were refused would put an unusable automation in the
sidebar. The compiler's own not-ready path already exists for what the person
still has to decide.

### 2026-08-25 — Review found the connector-error mapping below doesn't reach its motivating case

**What changed:** The entry below's `ConnectorError` mapping now reuses `isReconnectRequiredConnectorError` (`connector-connection-access.ts`) to decide the reconnect message, rather than checking `error.code === "unauthorized" || error.code === "invalid_configuration"` directly, and marks every case `retryable: false`. The two new messages say "Rally", not "Avalon". A third test pins the code-plus-`reconnectRequired`-detail requirement directly, and a new file, `automation-compile-connector-registry.test.ts`, drives the real (unmocked) `loadAutomationCreatorPluginCatalog` path — a stored connection naming a `connector_type` this environment does not register — to prove the branch is reachable at all, rather than only proving the mapping is correct for a hand-built error.

**Why:** Review — a human pass and five independent model reviewers — found the mapping backwards for the two `ConnectorError` codes that can actually reach `AutomationService.compile`'s catch block, and, more fundamentally, found that neither example in the entry below's "Why" ever reaches it. `loadAutomationCreatorPluginCatalog` wraps its entire dynamic-tool-discovery step — connecting, authorizing, and calling `dynamicAgentTools.discover` — in its own catch (`integrations.ts`'s `dynamic_connector_tools_unavailable` log site), which drops the failing connector from the catalog and lets the compile continue rather than raising anything. That is where an expired Slack token or a plugin exposing too many dynamic tools actually lands, and it was never true that either "fell through to the same generic 500". What escapes uncaught, because it happens before that step's own `try` even starts, is `connectorRegistryForEnv`'s own construction failing and `registry.get(connector_type)` throwing for a stored connection whose type this environment does not register — both environment defects, neither fixable by reconnecting an account. The original `needsReconnect` check called the first of those two "reconnect it" and the second "retryable", getting both backwards. `isReconnectRequiredConnectorError` requires the code *and* a `reconnectRequired` detail neither of the two reachable codes carries, so today this branch has no live path that produces its reconnect message at all — which is the honest state of things until the swallowing catch above is itself revisited, not a reason to remove the branch, since the check stays correct if that ever changes.

**Considered and rejected:** Also changing `loadAutomationCreatorPluginCatalog` so a connector's own discovery failure aborts the compile instead of being dropped from the catalog. That is a real, separate question — silently compiling a draft without a connector the person asked for is its own gap — but it is a catalog-policy decision (abort entirely, or propagate the omission into the draft so the compiler and the person both know a source was unavailable) that deserves its own change and its own review, not a side effect of correcting an error mapping that never reached it.

**Consequences:** The report that prompted this — a Slack correspondence-check automation failing mid-compile with a nondescriptive error — is not fixed by the `ConnectorError` branch at all, and was never going to be; the stale-build client message below remains the actual fix for what that report showed. `details.retryable` is not yet read anywhere: the builder's Retry button (`new-automation.tsx`) renders for any compile error and replays the identical request regardless of this flag, so a `retryable: false` connector failure is not yet a different experience from a retryable one — the field is there for whichever caller reads it next, not a claim that one already does.

### 2026-08-25 — A connector failure during compiling gets its own error, and a schema mismatch names its likely cause

**What changed:** `AutomationService.compile`'s catch block maps `ConnectorError` — raised by `loadAutomationCreatorPluginCatalog` while inspecting a connector's live tool surface, e.g. Slack — to a typed `ApiError`, distinguishing a revoked or misconfigured connector (not retryable; reconnect it) from everything else (retryable). Separately, `RallyApi`'s two response-schema-mismatch messages in the desktop client — the generic `request` helper and the automation draft stream's per-event check — now say that restarting Rally usually fixes an unrecognized response, instead of only naming the symptom.

**Why:** A report of automation creation failing with a nondescriptive error while the compiler was inspecting Slack's tools led nowhere in the compile pipeline itself — a reproduction built from the same request (a Slack correspondence check, three times a day, no zone named) round-trips cleanly through the normalizer, `AutomationDraftSchema`, and the exact SSE shape both the route and the desktop client parse (pinned in `packages/agent-harness/src/automation-compiler-wire-roundtrip.test.ts`). Two real gaps turned up along the way instead. `ConnectorError` was the one error type among the compiler's failure modes with no `instanceof` branch, so any live connector-inspection failure — an expired Slack token, a plugin exposing too many dynamic tools — fell through to the same generic 500 as an actual defect, naming neither the connector nor the reason. And the client's own schema-mismatch message, read carefully, only describes what a same-version client and server cannot actually produce: the two sides validate the same bytes against the same shared schema, so a genuine mismatch is best explained by this process running stale across a deploy — Rally checks for an update every few hours and still waits on a confirmed restart, so a shape change can outlive a given desktop process for a long margin. The old message gave no hint that "restart the app" was the one thing worth trying before an unrecoverable-looking "Retry".

**Considered and rejected:** Resolving a calendar trigger's unnamed timezone before it reaches the draft-stream wire, mirroring what the automation detail response already does for the same field. Rejected because the two responses are not analogous: nothing posts a detail response's triggers back, but the create screen posts the draft response's triggers back verbatim on `POST /automations`, which is exactly the wire boundary the 2026-08-24 entry below relies on staying null through. Resolving it here would freeze a scope-guessed default into the definition again, reopening the bug that entry closed.

**Consequences:** A connector failure surfaced while compiling now carries `automation_connector_failed` and a `retryable` flag a caller can act on, rather than `internal_error`. The stale-build message change is client-only and general — every `RallyApi` caller gets it, not only the automation builder — because the same reasoning holds for any response that fails local schema validation. The remaining skew this document's entry below names — the draft response is the one place a null calendar timezone still reaches a client — is unresolved and, per the rejected option above, does not have a fix that does not cost more than it saves; a client that has picked up a shape change parses it same as the server that sent it.

### 2026-08-24 — A promoted draft is scheduled in the account's timezone

**What changed:** A calendar trigger's `timezone` is nullable, and
`AutomationService` resolves an absent one against the automation's owner where
it derives the `schedules` row — on this path, on template subscription, and on
version adoption. The compiler is separately given the account's zones so the
draft a person reviews names the right one.

**Why:** A briefing created by somebody whose account said America/New_York ran
on Pacific time. The compiler had never been told the account's zone, and the
zone it invented was frozen into the definition at compile time — before the
scope was even chosen — so nothing downstream could correct it.

**Consequences:** A draft now carries `timezone: null` for a recurrence nobody
named a zone for. A first draft of this change filled the default in at compile
time to keep the wire non-null, and review found that this left the server's
resolution unreachable for everything the pipeline produced, including the
scope-switch case above.

A second round of review found the correction had over-reached: the null was
reaching the *automation detail* response too, where `create` stores the draft's
triggers verbatim and `get` returns them, so a desktop build older than this
release could not parse any automation created after it — including a workspace
automation a colleague created, and including an old automation once a newer
template version existed. So a response now resolves the zone before returning
it, from the `schedules` row the automation actually fires on, while storage
keeps the null. Nothing posts those triggers back, so this cannot re-freeze the
distinction the null exists to carry. The remaining skew is the builder alone:
the draft response is the one place a null still reaches a client.

### 2026-08-23 — The compiler names the destination it was asked for

**What changed:** `AutomationDraftSchema` gained `requestedDelivery`, the
submit-draft tool schema requires it, and the compiler policy says to record what
was asked for and nothing else — never a destination inferred from the subject
matter. The create screen reads that field instead of matching phrases in
`expectedOutputs`.

**Why:** The screen was inferring intent from prose the compiler had already
parsed, and getting it wrong in the direction that costs most: the compiler's own
worked example is a briefing *about* somebody's inbox, whose expected output says
"emails", which pre-ticked a destination nobody asked for.

**Considered and rejected:** Having the API derive the field server-side from the
same prose. It moves the guess rather than removing it, and leaves two readings of
one sentence — the model's and the regex's — free to disagree.

**Consequences:** The field is defaulted, so drafts saved before it existed still
parse and simply pre-select nothing. A new destination kind has to be added to the
enum in contracts *and* to the tool schema the model answers against, or the
compiler cannot name it.

### 2026-08-22 — The compiler stops writing the delivery it is given

**What changed:** The compiler prompt's Slack-only rule — describe the delivery,
do not model the Rally bot as a tool — now covers every destination Rally
delivers to, email included, and says outright not to instruct a provider send
for one. It also asks for a result in ordinary Markdown, with no wrapper,
envelope, HTML document, or subject line around it.

**Why:** Only Slack was named, so a briefing automation whose owner asked to be
emailed got `gmail.send` written into its instructions *and* an email delivery
target frozen on it: the same briefing arrived twice, from the owner's own
address and from Rally's. The Markdown line is for the other half of that
report — the result is rendered into an email, so a model asked for an
email-shaped artifact produces one wrapped in another.

**Considered and rejected:** Leaving this to the run-time policy alone. That
policy stops the second send, but the instructions still describe work the
automation is not doing, which is what its author reads on the overview screen.

**Consequences:** Automations compiled before this still carry a provider send in
their instructions. The run-time policy suppresses it, so they deliver once — but
their overview screen still describes a step that no longer happens, and nothing
rewrites them. It also makes the create screen's delivery choice load-bearing:
with no provider send in the instructions, an automation whose owner asked to be
emailed and whose Email destination is left unticked delivers nowhere, which is
why the draft's own `expectedOutputs` now pre-tick it.

### 2026-08-18 — Draft and promotion state move into WorkspaceDO

**What changed:** Automation templates/versions/subscriptions, draft
conversation, schedules, memory definitions, resource relationships and frozen
delivery targets now share the owning WorkspaceDO transaction. D1 is no longer
an automation serving or fallback database.

**Why:** Draft promotion intentionally changes several related workspace rows
atomically. Keeping them in D1 split workspace product authority from the
object that schedules, lists and invalidates them.

**Considered and rejected:** A D1 projection and a separate AutomationDO per
draft. Neither improves ownership, and the latter turns promotion into a
distributed transaction.

**Consequences:** The global inbound-email route remains a routing side effect
after local commit, while the complete product lifecycle and retry evidence are
WorkspaceDO-owned.

### 2026-08-13 — Automation authoring becomes a durable content-free funnel

**What changed:** Builder entry, compiler turns, first create-ready state,
elicitation presentation/resolution, promotion, reopen, and lifecycle actions now
have typed product events at their authoritative desktop or API boundaries.

**Why:** Created-automation totals did not explain where authors abandoned,
whether questions blocked them, how many revisions creation required, or which
configuration shapes reached a durable subscription.

**Considered and rejected:** Capturing the draft conversation, inferred intent,
question/answer text, renderer-reported promotion, and parallel legacy creation
events. Those alternatives expose content or count a creation before the server
commits it.

**Consequences:** Stable elicitation and draft IDs join the funnel without
becoming authority. The server event owns successful creation and action state;
current clients do not also emit the legacy completion contracts.
### 2026-08-12 — Draft manifests replace redundant resource pagination

**What changed:** The automation architect exposes read, search, view, and
summarize operations for the frozen attachment IDs, but no list operation. The
complete set is capped at ten, loaded in one query, and already present in the
current-turn manifest.

**Why:** Paginating an already-visible ten-item immutable set added cursor state,
fingerprints, and an unreachable multi-query loop without improving discovery.

**Considered and rejected:** Retaining the list operation for naming symmetry
with work-stream tools. Symmetry is not worth a model-visible operation that has
no distinct task.

**Consequences:** Automation content access remains freshly authorized and uses
the same derivative implementations; only work streams expose pageable resource
discovery.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Compiler attachments become frozen, revocable resources

**What changed:** The automation architect now receives list, read, search,
view, and summarize operations for the attachment IDs admitted to the current
compile request. Every operation rechecks workspace, owner, provider, and draft
state, and its cursor namespace is separate from work streams.

**Why:** Preserving large attachment bytes in the compiler prompt silently
truncates documents and spends context repeatedly. Replacing bytes with resource
references first required an equally capable read path that cannot outlive a
deletion or ownership change.

**Considered and rejected:** Making all of a user's draft uploads discoverable,
or trusting the initially validated set for the rest of the run. The first leaks
unrelated composer work into this draft; the second defeats revocation.

**Consequences:** Each compiler request explicitly carries the IDs it needs.
Future resume behavior must re-admit attachments rather than treating IDs saved
in conversation JSON as durable authority.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — A navigation the address bar cannot show, and the sentence it stranded

**What changed:** The builder's route effect resets on a new history entry with
no draft named, not only on the draft id *changing* to null. It reads
`useLocation().key` alongside `resumeDraftId` for exactly that.

**Why:** The entry below says three things key off the address bar changing
rather than what it says, and that anything added here must do the same. That
holds — but it has a blind spot this change found: the id can be observed
*unchanged* across a navigation that really happened. This screen names its own
draft in the bar with a `replace`, and when that write and the reader's next
navigation land in one commit, the effect sees null before and null after. The
transition it keys off never appears, so nothing resets, and the composer stays
keyed to a draft the reader has already left — showing, on the blank builder,
the sentence they typed for the other one. A new history entry is the signal
that survives the batching, and unlike the id it does not appear during the
renders where the bar is merely behind.

Both defects surfaced as the same intermittent failure of
`new-automation.test.tsx > carries an answer typed during a turn onto the draft
that turn named`. The other one — the copy left behind under the old key — was
found independently and fixed first, in #109; this is what remained after it,
and the two are unrelated beyond the test that caught them. The assertion could
be satisfied by the moment between the composer emptying on a key change and
refilling when the read lands, which is why either defect alone let it mostly
pass.

**Considered and rejected:** *Reading the current bar instead of its
transitions*, again — that is the change the entry below rejected twice, and it
wipes a conversation during the same lag window this one is careful to ignore.
*Making the screen's URL write synchronous with its state*, which is not
something a caller of `setSearchParams` gets to decide.

**Consequences:** There are now two signals here, and they answer different
questions: the draft id says *which* conversation the bar names, and the location
key says *whether the reader moved*. A reset needs the second; a load needs the
first. Anything added to this effect has to pick deliberately, and using the id
alone will silently miss the batched case rather than fail loudly.

### 2026-08-11 — Bound every writer that a live draft row newly exposed

**What changed:** `shareSubscription` refuses a draft. `saveDraft`'s statements
are each conditional on the row still being a visible draft, and
`draftVersionUpdate` now requires a caller-supplied condition rather than
writing any version row it is handed. Creation claims the draft — the status
transition itself — before writing anything else, and a second creation of one
draft is refused instead of inserting duplicates. `draftState` validates the
stored conversation and answers 409 when it cannot read it. In the builder, a
turn is discarded if the reader moved to another draft while it compiled, the
old conversation clears the moment another draft is chosen rather than when its
replacement arrives, a resume that is loading or has failed says so and refuses
to send, and the composer's cache moves onto the draft a turn names — carrying
whatever was typed while that turn was compiling.

**Why:** Review of the entry below, by a person and two bots. The pattern in
every finding is the same and worth stating plainly: **a row that could not
exist before is now reachable by every writer that never had to exclude it.**
`shareSubscription` was the exact "third writer" that entry predicted and it was
already in the tree — its ownership check passes by construction for a draft,
because the draft's template is owned by whoever started the conversation. The
composer-cache leak was the common path, not the rare one: the existing test
entered through a resume, where the key is per-draft from the start, while every
automation created through the product enters through the launcher, where it
was not.

**Considered and rejected:** A revision token on the saved conversation, to
reject a stale write from a second window. It would reject a turn after the
model had already run — paying for a conflict that needs the same draft open in
two windows with a failure in the common case. Last-turn-wins is recorded under
Failure modes instead, and it self-heals, because each turn carries the whole
transcript. Also rejected: keying the composer on the draft in the URL, again —
the URL commit lags the state beside it, so that key changes mid-turn.

**Consequences:** Three separate things now key off the address bar *changing*
rather than what it says, because this screen writes its own URL and the router
commits it a render or two later; anything added here must do the same or it
will wipe a conversation that has not finished naming itself. Creation is no
longer atomic end to end: a claim that succeeds and a batch that then fails
leaves an automation active with no schedules, which does not run — chosen over
the alternative, which was running twice. And `draftVersionUpdate` is the only
in-place writer of a table `data-model.md` calls immutable; its guard parameter
is what keeps that exception to a draft's own private version.

Shipped in #99.

### 2026-08-11 — Close the paths a draft could take out of being one

**What changed:** `setPaused` refuses a draft, deleting a draft no longer mints
the address it never had, Slack's App Home excludes drafts from its
recency-ordered list, and in the builder: the composer cache is keyed per draft,
the saved conversation is dropped from the query cache when a turn moves it on,
and the "this screen wrote the URL" mark moved from history state to the
component.

**Why:** Review of the change above, once `status = 'draft'` rows actually
existed. Every one of these was code that had been correct for years while no
draft could reach it. `POST /automations/:id/resume` was the sharpest: it is the
only other writer of `status`, so it took a draft straight to `active` — live
email route, runnable by mail and by hand — with none of `create`'s scope,
connector, or binding validation. In the builder, the mark in history state was
the same class of mistake in the other direction: a history entry outlives the
component that stamped it, so a back gesture would land on a marked entry with
the resume switched off and show an empty builder for a draft that has a
conversation.

**Considered and rejected:** Keying the composer cache on the draft named in the
URL, which is the obvious reading of "one composer per draft". React Router
commits this screen's own URL write several renders after the state beside it,
so that key changes *during* a turn and `useDraftText` re-hydrates over the
sentence being typed — a caught regression, not a hypothetical. The key follows
a draft the screen was opened on or switched to, and deliberately not one it
named itself. For the same reason the mark is only invalidated by the address
bar naming a *different* draft, never by it naming nothing.

**Consequences:** The lag between this screen's URL write and the router
commit is now load-bearing in two places; anything reading `?draft=` as
authoritative within a turn has to account for it. `status` has exactly two
legitimate exits from `draft` — `create` and `archiveDraft` — and a third writer
needs the same explicit refusal `setPaused` now carries. Any new surface listing
automations by `updated_at` must exclude drafts or be swamped by them.

Shipped in #99.

### 2026-08-11 — Automations being set up are drafts, and drafts are in the sidebar

**What changed:** The automation compiler now writes a `status = 'draft'`
subscription on its first turn and updates it on every turn after, so an
automation being set up appears in the sidebar while it is being written and
survives a restart. Creating it promotes that same row. A draft row can be
reopened in the builder from its sidebar entry.

**Why:** None of this worked before, in a way that was invisible from any single
file. `status = 'draft'` had been in the schema since `0001_initial.sql`; the
sidebar had rendered drafts, sunk them below the automations that run, and
offered **Archive draft** since drafts were given their own treatment; the
end-to-end script asked a tester to confirm all of it. But no code anywhere ever
wrote a row with that status — both `INSERT INTO automation_subscriptions`
statements hardcoded `'active'` — and the compiler's conversation lived in a
`Map` in the renderer, keyed by a `crypto.randomUUID()` the renderer minted. A
draft existed only inside the window it was typed in and was gone on reload. The
whole feature was reachable only by inserting a row by hand, which is exactly
what its tests did, so every suite passed.

**Considered and rejected:** A separate `automation_drafts` table, unioned into
the list. It duplicates the template, version, trigger, and scope columns a draft
already needs, and it forces creation to copy a draft into a subscription — which
means the finished automation gets a new id, so the sidebar row someone watched
appear is not the one they end up with, and every id already handed out for the
draft dangles. Also rejected: keeping the client's `draftId` as the subscription
primary key, which is one id collision away from a request writing into another
workspace's row.

**Consequences:** Every automation being set up now costs three rows from the
first compiled turn, including ones abandoned after a sentence — the price of a
draft being visible at all, and archiving is what clears them. Any new path that
starts a run must check `status = 'active'`, not merely that the automation is
not paused. Any new writer of a client-supplied draft id must go through
`loadOwnDraft` rather than matching on the id. And `create` now has two shapes,
promotion and insertion; a change to what a new subscription holds has to be made
in both or a promoted automation will quietly lack it.

Shipped in #99.
