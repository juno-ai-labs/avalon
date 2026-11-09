# Rally Demo MCP: creating demo Organizations from a custom scenario

> Created 2026-10-03.
>
> A new internal MCP server lets an authorized person write, check, save and
> run a demo scenario, and create a demo Organization from it, from Claude or
> any other MCP client. Companions: [state.md](state.md) and
> [design.md](design.md), which holds the full tool catalog, wire shapes and
> errors. Builds on [the demo workspace PRD](../2026-09-04_demo-workspace/prd.md)
> and the shipped machinery in `demo-workspaces.md`.
> Ships in two phases; [design.md](design.md#phases) says which tool is in which.
> Modeled on [the engineering MCP](../../engineering-mcp.md). Standing
> contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A person preparing a Rally demo opens Claude, connects the **Rally Demo MCP**,
and says what the demo should hold: "a demo for Northwind, a logistics company;
keep the vendor selection story but make it about a warehouse system, rename
Acme to Northwind, drop the Sales review Space, and Priya is played by Sam."
The model reads the built-in scenario through the
MCP, edits it, asks the server to check it, shows the operator the readable
preview the check returns, and starts the demo. The person watches the same phases the Ace **Demos** page
shows, and gets the Organization name to switch to once it is Ready.

Today every demo is prepared from one scenario that is compiled into the API
and changes only through a pull request. After this change a scenario is data:
any pack the existing schema accepts can be checked, previewed and used to
create a demo Organization, pinned to an immutable stored copy. Everything a
demo is made of becomes a choice at creation time: the content, the Spaces,
Channels, Breakouts, documents and Sidekicks, the cast and who plays each part,
and the company name. The preparation operation, seeder, readiness barrier and
retirement walk are reused unchanged, as are the shipped status shape, cast
entries and error codes. A second phase adds a named, shared scenario library
and a choice of which template connections a demo receives.

## Motivation

Every demo shows the same company. The one pack in service,
`multiplayer-2026-09` in `apps/api/src/services/demo-pack.ts`, is a TypeScript
literal. Its customer is Acme, its vendors are ClearDesk, HelpHarbor and
SupportLane, and its numbers are fixed. A presenter showing Rally to a
logistics prospect and another showing it to a law firm on the same afternoon
get the same rooms. The only thing an operator chooses today is the company
name on the Organization and who plays each part
(`DemoOperationStartRequestSchema`: `operationId`, `companyName`,
`presenterUserId`, `cast`).

Changing a scenario costs a pull request and a deploy. The pack's content
changed in four separate changes in its first month, the last of which
replaced every earlier story (the 2026-09-09, 2026-09-10, 2026-09-15 and
2026-09-23 entries in
`demo-workspaces.md`). The people who
want scenarios do not write TypeScript, which is why the
`/demo-scenario` skill exists:
it turns a plain description into pack steps and opens the PR for them. That
skill had already fallen behind the code it edits by the time this PRD was
written: its cast labels and its "renewal room" no longer matched the shipped
pack, and it did not cover Spaces or prepared history. The change that adds
this PRD brings it up to date, but a guide to editing code drifts whenever the
code moves.

A deploy also breaks demos in flight. Every phase compares the operation's
recorded `pack_version` with the pack in service and fails with
`demo_pack_changed` when they differ, so a pack edit merged while a demo is
preparing forces Abandon and a new operation.

Finally, the only door is Ace, and Ace's Access policy is all of Ace: managed
flags, model routes, workspace retirement and the telemetry pages. A person
who should be able to prepare a demo has to be trusted with all of it, and the
[engineering MCP](../../engineering-mcp.md#security-and-trust-model) copies the
same policy and adds a production SQL console. There is no narrower door for
the job of preparing a demo.

What it costs to leave: each prospect sees a demo about somebody else's
company, each change to a story waits on an engineer and a deploy, and the
circle of people who can prepare a demo stays the circle trusted with
production flags and SQL.

## Goals

1. An authorized person creates a demo Organization from an MCP client, with
   the same phases, receipts, readiness barrier and Ready state as the Ace
   **New demo** control, and follows its progress to Ready or a named failure.
2. Any scenario the pack schema accepts can be used to create a demo, without
   a code change or a deploy: content, Spaces, Channels, Breakouts, documents,
   Sidekicks, roles and their labels, and which rooms the presenter is in.
3. A scenario is checked before anything is written, and every problem is
   reported with the path of the field it rejected and a sentence saying what
   to change, so a model can fix its own pack in one or two rounds.
4. A person can read a scenario as the presenter will read it, with the cast's
   real names bound, before starting a demo from it.
5. **(Phase 2.)** A scenario can be saved under a name, revised, and reused by
   anyone on the team. In both phases every pack a demo is made from is stored
   immutably, so a demo always records exactly what it was made from.
6. The per-demo choices are explicit inputs: company name, presenter, and who
   plays each part (a colleague or a typed name). **(Phase 2.)** Which of the
   template's copyable connections the demo receives.
7. A change to the built-in scenario never fails a demo that is already
   preparing.
8. The people who may prepare demos can be admitted without being given Ace,
   managed flags, retirement of arbitrary workspaces, or the SQL console.

## Non-goals

1. **Backdating, fabricated tool history, and a demo mode: rejected, as
   before.** Non-goals 1 and 4 of
   [the demo workspace PRD](../2026-09-04_demo-workspace/prd.md#non-goals) and
   its 2026-09-05 "No demo mode" decision stand. A custom scenario is written
   with the real clock, its assistant turns carry no tool calls except a real
   elicitation, and the demo's connectors behave like anyone's.
2. **Server-side generation of scenarios: rejected.** The MCP server never
   calls a model to write or rewrite a pack. The client's model does the
   writing; the server checks, stores and runs it. A pack is therefore
   reviewable text before it runs, two runs of one revision prepare the same
   demo, and the server holds no prompt, model route or provider cost of its
   own.
3. **A template language inside packs (`{{customer}}` variables, expressions,
   conditionals): rejected.** See key design decision 2. Renaming Acme is an
   edit to the pack, made by the client's model, and checked like any other.
4. **More than one connection template, and connections the template does not
   hold: deferred.** The demo still copies from the one hand-built
   `demo-template`, and still only providers in `SHAREABLE_CONNECTOR_TYPES`.
   Phase 2 adds a choice of which of those copies a demo receives, including
   none.
   Several templates (for instance one per industry, with its own demo
   accounts) is a later PRD once a second set of demo accounts exists.
5. **Attachments other than Markdown and plain text: deferred.** The `upload`
   step accepts `text/markdown` and `text/plain` only. PDFs, slides and
   images need a binary transport through MCP and through the pack store, and
   nobody has asked for them yet.
6. **Changing a demo after it is Ready: rejected.** No in-place reseed, edit or
   reset of a live demo Organization, for the reasons in non-goal 2 of the
   earlier PRD. A changed scenario is a new demo.
7. **Retiring arbitrary workspaces from this server: rejected.** The Demo MCP
   retires only Organizations that demo preparation made. Retiring any other
   workspace stays in Ace's workspaces tab.
8. **Customer access: rejected.** This is an internal operator surface. No
   Rally member gains it by membership, and the product gains no "create a
   demo" feature.
9. **Replacing the Ace Demos page: not this change.** Ace keeps working and
   keeps preparing from the built-in scenario. A scenario picker in Ace is a
   later change once saved scenarios exist.
10. **Regions other than Global: deferred.** Demos are Global only today
    (`demo_region_unsupported`), and so is this server.

## Product behavior

### Who uses it, and how they connect

A person admitted by the Demo MCP's own Cloudflare Access policy adds
`https://demo-mcp.internal.rallywith.ai/mcp` to Claude, Claude Code, ChatGPT or
Cursor and completes Access's Managed OAuth sign-in, exactly as
[`internal-admin-mcp-server.md`](../../internal-admin-mcp-server.md) describes
for the engineering MCP. The server has its own Access application and
audience, so neither an Ace token nor an engineering MCP token is accepted, and
its policy is set separately (see **Provider configuration**).

The person is called the **operator** here, as in the earlier PRD. They are
often also the presenter, but need not be.

### What a scenario is

A **scenario** is a named, versioned pack. A pack is exactly what
`DemoPackSchema` accepts today: roles and their labels, optional Spaces, an
ordered list of steps (`create_workstream`, `create_substream`, `message`,
`upload`, `sidekick`), and the `expect` block the readiness barrier verifies.
This PRD adds no step kind and loosens no playability rule.

There are three sources of scenarios, and every tool treats them the same way:

- **Built-in** scenarios are compiled into the API, as the shipped pack is
  today. Their ID is fixed (`builtin:multiplayer`) and their revision is the
  pack's `version`. They change only by pull request, and the
  `/demo-scenario` skill keeps working for them.
- **Inline** packs are passed whole to `create_demo_organization` and stored
  as an unnamed revision, unique by content hash, so the operation points at
  bytes that cannot change.
- **Saved** scenarios (phase 2) are stored in Global D1, written through this
  server. Each save makes a new immutable revision. Anyone admitted to the server can
  read, use, revise or archive any saved scenario: the library is the team's,
  not the author's. Each revision records who saved it.

### The customization surface

Everything below is chosen per demo or per scenario, by the operator through
their model. The table is the whole list; what is not in it is fixed.

| Dimension | Where it is chosen | How |
| --- | --- | --- |
| Rooms (Channels), their titles, scope and Space | Scenario | `create_workstream` steps |
| Spaces: name, icon, colour, creator | Scenario | `spaces` map |
| Breakouts, their members and starting context | Scenario | `create_substream` steps |
| Who says what, in which order | Scenario | `message` steps; step order sets sidebar order |
| What Rally says, and where it asks a question | Scenario | `assistant: say` or `ask` on a step |
| Prepared history without a run | Scenario | `execution: "history"` on a room |
| Documents and their versions | Scenario | `upload` steps (Markdown or text) |
| Sidekicks: definition, schedule, time zone, a first briefing | Scenario | `sidekick` steps |
| How many parts there are and what each is called | Scenario | `roles`, `roleLabels` |
| Which rooms the presenter is in, and what their home screen shows | Scenario | seats and mentions; `expect` is derived (below) |
| Company name, which names the Organization `<companyName>-demo` | Per demo | `companyName`, as today |
| Presenter | Per demo | a member of `demo-template`, as today |
| Who plays each part | Per demo | a colleague's user ID or a typed name (a persona), as today |
| Which template connections are copied (phase 2) | Per demo | all copyable (default and today's behavior), none, or a chosen subset |

A model customizes a built-in story by reading it with `get_demo_scenario`,
editing the JSON (renaming the customer, changing figures, dropping a room,
adding a Breakout), and passing the result to `check_demo_scenario`. Keeping
figures consistent across a room's messages, documents and Rally's own turns
is the author's job, as it is in a checked-in pack; Rally's seeded turns may
only use facts the room's own messages state, and the check reports a turn
that mentions somebody outside the cast but cannot check arithmetic.

### The readiness block is derived, not written

The `expect` block is the hardest part of a pack to write by hand: a wrong flag
parses, plans and seeds, then leaves the demo in **Waiting for workspace**
until the wait runs out. The skill today has the author run tests and copy the
failing diff.

The check does that work. When the presenter never acts in a room's main
conversation, which is true of every pack this repository has shipped, the
check replaces the presenter's entry with what `demoIdleViewerExpectation`
derives (already the answer the checked-in pack is held to by test) and says
it did. Their flags have one right answer, so there is nothing to refuse. A
pack in which the presenter does act is still accepted, but their flags then
depend on what they did, so the pack must state them, as it does for any cast
member it verifies; a pack that leaves them out is refused with a code naming
`expect`. An entry for a cast member is kept as written.

### The flow and its states

A model reads a scenario, edits it, checks it until it passes, shows the
operator the preview, creates the demo, and follows the operation to Ready. The
operation's states are the shipped ones (checking template, creating workspace,
copying connections, seeding conversations, waiting for workspace, Ready,
failed, abandoned), returned in the shipped status shape, with no percentage
and no time estimate. Failed carries the tool that recovers it. The calls,
their shapes and the common sequences are in
[design.md](design.md#discovery-and-sequencing).

**Ready can still be invisible to the presenter.** The account menu lists
Organizations only while `multiple-workspaces-enabled` is on for that person
(`demo-workspaces.md`).
When it is off, Ready carries a notice saying so and where to turn it on. The
Demo MCP does not change flags itself; that stays with Ace and the engineering
MCP.

**Offline and client loss.** Closing the client does not cancel anything: the
operation is a Workflow that runs to Ready or failure on its own. A later
`get_demo_operation` or `list_demo_operations` picks it up.

### Replays and duplicate demos

A model may call a write tool twice: after a timeout, after a context
compaction, or by mistake. `create_demo_organization` takes a `requestKey`, a
short string the client chooses ("northwind-2026-10-03"). The operation ID is
derived from the caller's Access subject and that key, so a repeat returns the
same operation and its progress rather than a second Organization. A different
key is a different demo, as a different operation ID is today. This is the
shipped "one operation id, one demo" rule, given an input a model can repeat
reliably; a model cannot be trusted to reuse a random UUID across a context
loss.

The repeat is answered first, before the pack is resolved, checked or stored
and before the cast is checked, as `startDemoOperation` does today and for its
reason: re-checking a repeat against a directory that has moved since would
refuse a retry of a preparation that is running fine. So a repeat writes
nothing, and a repeat with different inputs still returns the first demo.

### Retiring and abandoning

`abandon_demo_operation` is the shipped abandon: it closes an unfinished
candidate and needs the operation ID typed again as confirmation.

`retire_demo_organization` retires a published demo through the shipped
retirement walk. It needs the Organization's name typed as confirmation, and it
refuses any workspace that has no row in `demo_operations`. That refusal is a
limit on this door, not a change to retirement: the
[2026-09-05 decision](../2026-09-04_demo-workspace/prd.md#2026-09-05--retirement-is-not-gated-on-the-register)
that the register authorizes nothing still holds for Ace's workspaces tab,
which can retire anything. This server is meant for a wider circle of people,
so it may only close what demo preparation opened.

### Errors

Every refusal names the field it rejected, by path, and says what to do next
in a fixed sentence per code that never echoes pack text back, per
[naming a schema failure](../../naming-a-schema-failure.md). Shipped refusals
keep their shipped codes, so Ace and the MCP report the same failure the same
way. The full list is in [design.md](design.md#failures).

## Impact on the product contract

None for Rally members: no product surface, permission, or object behavior
changes, and a demo Organization is an ordinary Organization.

This PRD does move two rules of the demo feature, which is internal:

1. `demo-workspaces.md`
   says "Seed prose is pack data behind a schema, never a member's or a
   model's input." After this change, seed prose may come from an operator,
   who may have had a model write it. It still never comes from a Rally member
   or from Rally's own agent, and it reaches the seeder only through the
   Access-gated operator door, as a stored, checked, immutable revision. The
   **Security and trust model** section says what that costs.
2. The pack a demo is made from is no longer "the pack in service". Every new
   operation, from Ace or the MCP and built-in or inline, stores the pack it
   starts with and runs from that copy, so `demo_pack_changed` applies only to
   operations started before the change.

The earlier demo workspace PRD is still `in progress`. This PRD refines it and
does not supersede it.

## Key design decisions

1. **A separate MCP server, not more tools on the engineering MCP.** The
   engineering MCP's Access policy is copied from Ace and it grants a
   production SQL console across both regions. Putting demo tools there would
   keep demo preparation inside the most trusted circle, which is the problem
   motivation names. A separate Worker with its own Access application lets
   the policy be as narrow or wide as demo work needs. It costs one more
   Worker and one more Access application, both made by the same deploy
   script pattern. **Rejected:** a role check inside the engineering MCP,
   which would make the app, not Access, the authority on who may do what,
   which that server deliberately avoids.
2. **The whole pack is the unit of customization; no variables.** The pack
   schema is already the complete, checked description of a demo. Every
   other design (template variables, story toggles, per-field overrides) is a
   second, smaller language that covers part of the first and needs its own
   rules for figures that have to agree with each other. The client is a
   model that edits JSON well; giving it the whole pack and a strict checker
   gives unlimited customization with one primitive. **Rejected:** `{{var}}`
   substitution with typed defaults, which cannot express "drop this room" or
   "add a Breakout" and would need expressions to keep totals consistent.
3. **The server checks, stores and runs; it never writes.** No model call on
   the server. Keeps preparation deterministic, keeps cost and prompt
   ownership with the client, and keeps the existing invariant that what runs
   is reviewable data. **Rejected:** a `generate_demo_scenario(prompt)` tool,
   which would put a model's output straight into a production write path with
   nothing to review.
4. **Every operation points at a stored, immutable revision.** Whatever the
   scenario's source, built-in or inline, the pack is saved as an unnamed
   revision, unique by content hash, once its checks pass and before the
   operation row is written. A built-in scenario is snapshotted too, or a
   deploy that edits it would still fail a demo in flight. Retries,
   readiness and audit read the same bytes, a deploy cannot change them, and
   "what was this demo made from" has one answer. **Rejected:** storing the pack
   JSON on the operation row, which would duplicate it per demo and leave saved
   scenarios as a second store.
5. **`expect` for an idle presenter is derived by the server.** It is the
   step most likely to be wrong and the one whose failure costs a demo rather
   than a test, and while the presenter never acts it has one right answer, so
   the check overwrites it. A presenter who acts is stated by the pack, like
   any verified cast member.
   **Rejected:** keeping it author-written, which hands a model the one task
   the skill already moved to the test suite; and refusing a wrong entry,
   which makes the model do work the server already did.
6. **Idempotency by `requestKey`, scoped to the caller.** See **Replays and
   duplicate demos**. **Rejected:** client-supplied UUIDs (a model loses them)
   and server-minted IDs with no key (a retried call makes a second demo).
7. **The bridge is a named `WorkerEntrypoint`, not the HTTP operator route.**
   The engineering MCP reaches the API through `EngineeringInspectionBridge`
   with no HTTP route and no shared secret. The Demo MCP does the same with a
   `DemoAdministration` entrypoint that calls the same service functions the
   `/internal/demos` routes call. **Rejected:** calling `/internal/demos` with a
   `demos` token from `DEMO_OPERATORS_JSON`, which would add a bearer secret to
   rotate. Either way the API receives the operator's identity as a value it
   cannot verify itself; it trusts the caller, the binding here or the token
   there. The entrypoint is chosen for having no secret, not for verifying
   more.
8. **Retirement from this server is limited to demo Organizations.** See
   **Retiring and abandoning**.
9. **The operator is recorded.** Each operation and each scenario revision
   stores the Access subject and email of who made it, so a demo whose
   seeded words are attributed to a colleague can be traced to the person who
   wrote and started it. The record is only as trustworthy as the Demo MCP
   Worker, which is the one caller that can reach the entrypoint and the one
   place the Access assertion is verified.
10. **Shipped shapes and codes, unchanged.** The MCP returns every field of the
    shipped `DemoOperationStatusSchema`, with its own additions defined in the
    MCP's contract rather than on the shipped schema, which Ace parses
    strictly and which therefore does not change. It takes the shipped
    cast entry (a user ID or `{ name }`) and the shipped company name, and
    keeps every shipped error code. **Rejected:** an MCP-specific status shape,
    an `{ email }` cast form and a separate Organization name, each a second
    version of something Ace already sends or reads, for no new capability.
11. **Two phases.** Phase 1 is the primitive: run any checked pack, pinned to
    immutable bytes, which meets every goal but the library and connection
    choice. Those two are cheap to add later and costly to remove once people
    depend on them, so they wait until somebody asks. Preview is part of the
    check, not its own tool, so each round of editing is one call.

## Data model

Sketch level; the migration is authoritative. All in Global D1, beside
`demo_operations`.

Phase 1:

- **`demo_scenario_revisions`**: `id`, `scenario_id` (null for an unnamed
  revision, which every new operation makes), `revision` (null when unnamed), `pack_json`
  (the normalized pack, with derived `expect`), `content_hash` (SHA-256 of
  `pack_json`), `saved_by_subject`, `saved_by_email`, `created_at`, and in
  phase 2 a `request_key`, unique with `saved_by_subject`, so a repeated save
  returns the revision it wrote. Unnamed
  revisions are unique by `content_hash`, so storing one twice writes nothing.
  Immutable: no update path.
- **`demo_operations`** gains `scenario_revision_id` (set on every new row),
  `request_key` (MCP rows), and `requested_by_subject` and
  `requested_by_email`. `pack_version` keeps the built-in version for a
  built-in scenario and is `stored:<content_hash>` for an inline one, so the
  shipped column keeps saying what the demo was made from. Rows written before
  the migration have no revision and keep today's `pack_version` comparison.

Phase 2:

- **`demo_scenarios`**: `id`, `name` (unique among live scenarios),
  `description`, `archived_at`, `created_at`. A built-in scenario has no row.
  Saved revisions point at it and number 1, 2, 3.
- **`demo_operations`** gains `connection_selection` (JSON: `all`, `none`, or a
  list of template connection IDs); null means all, today's behavior.

A pack is stored as one D1 value. D1's published per-row size limit (2,000,000
bytes when this was written; check the current
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before
relying on it) is the ceiling. The shipped pack is a small fraction of it. A
pack over the limit fails the save with `demo_scenario_too_large`, naming the
platform limit; this change adds no size cap of its own.

## Regional impact

Global only. The Demo MCP has one service binding, to `avalon-api-global`'s
`DemoAdministration` entrypoint, and no regional fan-out: demos, the template,
saved scenarios and operation rows all live in Global. Pack text, which may
name a prospect, stays in Global D1 and in the demo Organization's own objects.
Nothing crosses to another configured deployment. If demos ever move beyond
Global, scenarios move with the template, which is non-goal 10's later PRD.

## Security and trust model

**Who.** Cloudflare Access is the only authority on who may connect, as for the
engineering MCP: the Worker verifies the `Cf-Access-Jwt-Assertion` with the
shared verifier, its own audience, and refuses everything else. The app has no
allowlist of its own.

**What they can reach.** Through this server an operator can create demo
Organizations owned by a member of `demo-template`, seat colleagues on the
company's email domain or personas in them, copy the template's shareable
Google connections into them, and retire Organizations that demo preparation
made. They cannot read or write SQL, change flags, retire other workspaces, or
see credential material. That is narrower than Ace's Demos page, whose users
can also do everything else in Ace.

**What changes about seed text.** Until now every pack was code-reviewed in a
pull request before it ran. A saved or inline scenario is reviewed only by the
operator who runs it, and its text may have been written by a model working
from material the operator pasted in, such as a prospect's website. That text
becomes transcript history in a workspace whose live turns can call the copied
Google connections. Three things bound the result:

1. The copied connections reach only the demo Google accounts. The template is
   built by hand to hold nothing else ([earlier PRD, Security and trust
   model](../2026-09-04_demo-workspace/prd.md#security-and-trust-model)), so a
   seeded instruction that persuades a later live turn to read or send
   something can reach only demo data.
2. Seeded text is history, not instructions to the harness. It runs through
   the same admission and Bind path as a person's message and gains no
   authority by being seeded.
3. The revision records who saved it and the operation records who started it,
   as reported by the Demo MCP Worker. The entrypoint cannot check that
   identity itself; it trusts the one Worker bound to it, which verified the
   Access assertion.

**Words in a colleague's name.** A scenario puts words in the mouth of whoever
is cast in a part, under their real name. A checked-in pack had a reviewer; a
custom one has only its operator. The server keeps today's rule (a colleague on
the company's domain, or a typed name that becomes a persona) and records the
operator on the operation. Whether a colleague must be told, or must agree,
before custom words are attributed to them is an open question below.

**Credentials.** Unchanged: copying uses `decryptVersionedCredentialValue`, never
writes the template, and keeps plaintext out of responses, logs and receipts.
In phase 2, `list_template_connections` returns type, display name, scope and
copyability, never account tokens.

**Logs.** As in the engineering MCP: Access subject and email, tool name,
target IDs and a fixed outcome code. Pack text, cast names and preview text
never enter Worker logs.

## Provider configuration

Before the first deploy, in the Cloudflare account that hosts the engineering
MCP:

1. A DNS name and custom domain `demo-mcp.internal.rallywith.ai` for the new
   Worker.
2. A new Access application for that hostname, with Managed OAuth and Dynamic
   Client Registration enabled and the same hosted client origins as the
   engineering MCP (`hosted-clients.json`). Its audience is its own.
3. **Its policy is set on purpose, not copied from Ace.** Who it admits is the
   team's choice (see **Open questions**). The deploy script refuses to deploy
   when the application has no policy, rather than falling back to Ace's.
4. The `DemoAdministration` entrypoint ships in `avalon-api-global` before the
   Demo MCP deploys, as the engineering MCP deploys only after both API
   entrypoints are healthy.

Nothing changes in Google, Slack or any other provider. The template's
accounts and grants are as the earlier PRD left them.

## Agent behavior

The Demo MCP's tools are used by an operator's MCP client, not by Rally's agent.
No Rally plugin, harness tool, or system prompt changes, so the plugin contract
in [`agent-tools.md`](../../agent-tools.md) does not apply. The tools are still
used by a model, so [design.md](design.md) gives the complete catalog anyway:
each tool's description, read or write, idempotency, exact input and output
shapes, where every ID comes from, and each failure with its code and the
sentence the model reads.

Inside a demo Organization nothing changes. Seeded runs answer from the seed
seam and make no tool calls; a presenter's later turns are ordinary runs with
the demo's connector tools.

## Rollout

**No feature flag.** The surface is internal and behind its own Access policy,
which is the control a flag would duplicate, and Rally's managed flags hide
client surfaces without changing API availability, as the earlier PRD found.
The default applies: it ships to its audience on merge.

Order:

1. Phase 1: the migration and the `DemoAdministration` entrypoint, with stored
   revisions and the operation changes. Ace keeps working unchanged against
   the built-in scenario.
2. Phase 1: the Demo MCP Worker and its Access application, deployed after the
   API.
3. Phase 1: documentation. A new `docs/demo-mcp.md` module document registered
   in [`docs/README.md`](../../README.md), a connection guide beside
   `internal-admin-mcp-server.md`, and updates to `demo-workspaces.md` for
   stored revisions, derived `expect` and the new `demo_operations` columns.
   The `/demo-scenario` skill gains a note that a scenario that does not need
   to ship to everyone can be run through the MCP instead of opening a PR.
4. Phase 2, when asked for: the scenario library and connection selection, each
   with its own migration and documentation update.

To turn it off: remove the Access policy's members, or delete the Worker. Demos
already prepared are unaffected, and Ace still prepares and retires them.

## Acceptance

1. **Create from the built-in scenario.** Connect Claude to the server, create a
   demo from `builtin:multiplayer` with a colleague and a typed name in the
   parts, follow it to Ready, and open the Organization in a real window as
   the presenter. It matches a demo made from Ace with the same inputs.
2. **Customize and run.** Ask the model to rename Acme, change a vendor's
   figures, drop a Space and add a Breakout. The check passes, the preview
   shows the new names in sidebar order, and the Ready demo shows exactly that,
   inspected in a real window.
3. **Self-correction.** Give the model a pack with a speaker who is not in the
   room, a second question in one conversation, a mention of a role outside the
   cast and a wrong presenter `expect`. Each issue names its path and says what
   to change, the presenter's `expect` is replaced and reported in `derived`
   rather than refused, and the model fixes the pack without human help. Run this on the
   medium fallback model, not only a frontier one.
4. **Derived readiness.** A pack with no `expect` is checked, filled in, and
   reaches Ready. Breaking `demoIdleViewerExpectation`'s mention rule makes the
   integration test fail by the gap it names.
5. **Immutability and deploys.** Start one demo from an inline pack and one
   from the built-in scenario (through Ace), and deploy a changed built-in pack
   while both prepare. Both finish from the bytes they started with, and
   `demo_pack_changed` is not raised.
6. **Replay.** Call `create_demo_organization` twice with one `requestKey`,
   including after the first call's response is lost, and once with a changed
   pack. One Organization, one operation, one stored revision; the changed
   repeat returns the first demo and stores nothing.
7. **Phase 2, connection selection.** `none` copies nothing; a subset copies
   only those; a non-copyable ID is refused before a row is written with its
   reason.
8. **Limits of the door.** `retire_demo_organization` refuses `demo-template`
   and a customer workspace; the server has no SQL or flag tool; an Ace token
   and an engineering MCP token are both refused by the origin.
9. **No leakage.** Worker logs from a full session contain no pack text, cast
   name, preview text or credential.

Integration tests follow [`testing.md`](../../testing.md): the bridge and
storage on real workerd and the real migrations, the MCP handler as the
engineering MCP tests it, and each integration behavior proved to fail with
one production edit.

## Open questions

- **Who is admitted.** Which people or Access groups the new policy admits:
  for instance everyone on the company's domain, or a named demo group. Blocks
  the deploy, not the build.
- **Telling a colleague.** Should a colleague cast in a custom scenario be told,
  or have to agree, before words are attributed to them in a live demo? Today
  nobody is told, but every pack was code-reviewed. The options are: keep
  today's rule (no notice); notify the colleague when an operation that casts
  them starts; or allow colleagues only in built-in scenarios and personas only
  in custom ones. The last is the safest and the least useful. Does not block
  the build; changes one check in `create_demo_organization`.
- **Hostname.** `demo-mcp.internal.rallywith.ai` is a proposal.
- **Phase 2 triggers.** What request would start the scenario library or
  connection selection. Until one arrives, neither is built.
- **Scenario library hygiene (phase 2).** Whether archived scenarios are ever
  removed. Revisions referenced by an operation must stay, so this PRD
  proposes none.

## Decision log

None yet.
