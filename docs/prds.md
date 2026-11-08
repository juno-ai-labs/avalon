# Product requirement documents

This document defines **where a product requirement document lives, how its
folder is named, and how its state is recorded**. Read it before writing a PRD,
before advancing one, and before citing one as current guidance.

A PRD here is a *point-in-time* document: it argues for a change, defines its
scope, and records the decisions taken while it was being built. It is not the
durable reference for the subsystem it created — that is the matching document
in [the documentation index](README.md), which is updated alongside the code
long after the PRD is finished.

One PRD is the exception and stays current: [the Rally implementation
brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md), the standing product
contract for what Rally *is*. Everything else under `docs/PRDs/` covers one
proposed change and stops being edited once it is complete. The brief predates
this specification and keeps its own shape — it is the contract every later PRD
is written *against*, not an instance of the form below.

## Where a PRD lives

Every PRD is a **folder** under `docs/PRDs/`, named:

```
<yyyy>-<mm>-<dd>_<kebab-case-short-description>
```

For example:

```
docs/PRDs/2026-08-10_workstream-mute-windows/prd.md
```

The date is the date the PRD was **created**, and it never changes — not when
work starts, not when it ships, not when something supersedes it. Nothing else
in the folder name changes either: the path is fixed for the life of the PRD, so
a link to it never rots, and a directory listing sorts into a chronological
record of what the product has proposed.

One folder is one PRD. A change large enough to split into focused parts becomes
several folders that link to each other, not several PRDs in one folder.

## `state.md`

**Where a PRD has got to is recorded in `state.md`, not in the folder name.**
Every PRD folder has one. It opens with this checklist — these three lines, in
this order, worded this way — and the only thing that may follow is a short note
beneath it. There are three kinds: the supersession or abandonment note and
the partial note, both described under
[Abandoned and superseded PRDs](#abandoned-and-superseded-prds), and the
standing-contract note that says the freeze rule does not apply, which only [the
implementation brief](PRDs/2026-08-05_avalon-implementation-brief/state.md)
carries.

```
- [ ] planned
- [ ] in progress
- [ ] completed
```

The boxes are **cumulative** — a PRD that is being built has both `planned` and
`in progress` ticked, because it was planned and it still is. So a PRD under
construction reads:

```
- [x] planned
- [x] in progress
- [ ] completed
```

and a shipped one reads:

```
- [x] planned
- [x] in progress
- [x] completed
```

Approval is a review gate, not a fourth state. A PRD is approved when the pull
request that introduces it has been reviewed and merged. It remains `planned`
from creation through approval and until implementation starts. Write any
`plan.md` in a later change, never in the pull request that writes the PRD.

Advancing a PRD is therefore ticking a box, and nothing else moves. Do it in the
commit that makes it true: `in progress` when the first implementing change
lands, `completed` when the last one does.

`state.md` is the **only** authority on state. Don't restate it in the PRD body,
in the documentation index, or in the folder name — a second copy is a copy that
goes stale.

### Abandoned and superseded PRDs

A PRD replaced by a newer one, or dropped without being built, never reaches
`completed`. Leave its boxes as they stand and add a line beneath the checklist
saying what happened, with a link:

```
- [x] planned
- [ ] in progress
- [ ] completed

Superseded by [`2026-09-02_workstream-notification-rules`](PRDs/2026-09-02_workstream-notification-rules/prd.md).
Design only — no code shipped. Do not build against this PRD.
```

That line is what stands between a future reader and a design that was
deliberately abandoned, so make it unambiguous. The successor's own PRD should
point back at what it replaced.

A PRD only part of which was replaced or deleted, whether it is completed or
still `in progress`, gets the same kind of note. The note names the goals that
still hold, says what went and which PRD took it, and links the document that
owns what survives, so a reader knows which half to trust.

## Completed PRDs are frozen

**Once `completed` is ticked, the PRD is not edited again.** It records what was
decided at the time, and its value is that a later reader can trust it to say
what was actually believed and agreed then, rather than a version quietly
reconciled with what shipped afterwards. The same applies to an abandoned PRD
from the moment its `state.md` says so.

If the shipped system drifts from a completed PRD, the drift is recorded in the
subsystem document that owns the area — not by editing the PRD. If the direction
itself changes, write a new PRD.

Two edits are still allowed on a frozen PRD, because they are about *finding* it
rather than about its content: adding or correcting the note in `state.md`
(including links to whatever replaced it), and fixing a link that broke when
another document moved.

[The implementation brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md) is
the exception to all of this. Its boxes are ticked because the product it
describes was built, not because the document is finished: it is the standing
contract, and it is edited whenever the contract itself changes.

## Files inside the folder

| File | Purpose |
| --- | --- |
| `prd.md` | **Required.** The PRD itself: the problem, the goals and non-goals, the proposed product behavior, and the decisions. This is the file other documents link to. |
| `state.md` | **Required.** The three-line state checklist above, plus a supersession or standing-contract note where one applies. Nothing else. |
| `plan.md` | The phased build checklist for the PRD, with an acceptance gate per phase. Write it only after the PRD is approved, and only when the work is large enough that sequencing matters. A flagged feature registers its flag in Ace in the phase that introduces it, per **Rollout** below. |
| `design.md` | Architecture and rationale too detailed for the PRD body — schemas, protocols, migration strategy. |
| `research.md` | Prior art, competitor behavior, or investigation that informed the PRD but is not itself a proposal. |
| `README.md` | Only for a folder that has grown into a bundle: a short map saying which file is actionable and which are supporting provenance. |

Anything else follows the same shape — lower-kebab, `.md`, descriptive of its
role. Split a file out when it is long enough that the PRD body suffers for
carrying it; keep everything in `prd.md` otherwise.

## The PRD header

Every `prd.md` opens with an H1 title and then a blockquote, before any other
prose:

```markdown
# Work-stream mute windows

> Created 2026-08-10.
>
> A participant can silence a busy work stream for a fixed period without
> leaving it. Standing contract:
> [the Rally implementation brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md).
```

It carries the creation date, a one-line scope, and links to the companion files
and to the documents a reader needs alongside it. Keep it to what orients a
reader who arrived from a search result. If an approved PRD later gains a
`plan.md`, add its companion link here in the same change.

**No state and no owner in the header.** State lives in `state.md` and nowhere
else; an owner line in a document that outlives the assignment is stale the day
someone changes teams, and the commit history says who wrote it.

## The sections of a PRD

A PRD body is Markdown `##` headings in the order below. The first seven are
**required**; the rest are included when they apply and omitted entirely — no
empty headings — when they do not. A required section with genuinely nothing to
say keeps its heading and gets `N/A — <reason>`, because a reader needs to know
the question was asked and answered rather than skipped.

Sections 1–6 are written before the build and describe the change as it was
agreed. Section 7, the **Decision log**, is the one part that grows while the
PRD is `in progress`.

### Required sections

1. **Summary** — One or two paragraphs stating what changes, for whom, and what
   becomes possible that was not before. Written so that someone who reads only
   this section knows whether the rest concerns them. Lead with the outcome a
   user would notice, not with the mechanism.

2. **Motivation** — The case for making this change *now*: the problem someone
   actually hit, how often, and what it costs to leave it alone. Cite the
   evidence — a support thread, a recurring request, an incident, a measurement.
   A reviewer who was not in the room should finish this section agreeing there
   is a problem, before reading a word about the solution. "It would be nice" is
   not motivation; "every participant in a busy automation stream leaves it, and
   leaving loses their place in the transcript" is.

3. **Goals** — What the change must achieve, as a numbered list of outcomes, not
   tasks. Each one should be specific enough that you could later say plainly
   whether it happened. "Participants can silence a conversation for a fixed
   period without leaving it" is a goal; "add a mute table" is a task.

4. **Non-goals** — What this change explicitly does *not* cover, numbered the
   same way, each with the reason it is out of scope and a note on whether it is
   deferred or rejected outright. This is the highest-value section in the
   document: an unstated non-goal is the thing that gets built anyway, and the
   thing a reviewer argues about for a week. Say what is deliberately left for
   later, and say what the product will never do.

5. **Product behavior** — The proposed experience in enough detail to build
   against: what the user does, what the surface shows, and how it behaves in
   each state — empty, loading, populated, error, and offline. Name the real
   surfaces (the sidebar, the transcript, the composer, the contextual right
   rail) and the real vocabulary (conversation, participant, automation,
   subscription, activity, elicitation), so the PRD and the product use the same
   words. Where behavior is conditional, give the condition. Where a mock or a
   screenshot settles it faster than prose, link the image.

6. **Impact on the product contract** — How the change sits against [the Rally
   implementation brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md).
   Most PRDs write "none — this refines behavior within the existing contract",
   and that one line is the point: it forces the author to check. If the change
   *does* alter the contract — what a conversation is, whether viewing implies
   participation, what the agent is allowed to do, the absence of channels, a
   global inbox, or global search — say exactly which clause moves and why. That
   is a bigger conversation than the feature, and it belongs at the top of it.

7. **Decision log** — What was decided *after* the PRD was agreed, appended as
   the build proceeds. See below; while the PRD is still `planned` the heading
   sits there reading `None yet.`

### The decision log

Implementation always disagrees with the plan somewhere. A goal turns out to
cost ten times what it looked like, a behavior collides with something the PRD's
author did not know about, a reviewer proposes something better. Those decisions
are the ones a future reader most wants and least often finds — the PRD says
what was intended, the diff says what was built, and nothing says *why they
differ*.

The decision log closes that gap. **Update it in the same change that acts on
the decision**, not at the end of the build when the reasoning has evaporated.

Each entry is a `###` heading with the date and a one-line claim, then three
fixed fields:

```markdown
## Decision log

### 2026-08-19 — Mute windows expire lazily, not on a schedule

**Decided:** A mute row whose `muted_until` has passed is ignored at read time.
No scheduled job sweeps expired rows.

**Why:** The sweep was a Workflow and a cron trigger to save a comparison in a
query that already loads the row. Goal 3 (delivery resumes on its own) holds
either way, and the read-time check cannot drift from the data.

**Changes:** Nothing in the agreed scope. Design decision 2 described a sweep;
this supersedes it. Shipped in #412.
```

- **Append only.** Never rewrite or delete an entry, and never quietly edit
  sections 1–6 to match a later decision. Those sections are the proposal as it
  was agreed; the log is the record of everything that moved afterwards, and a
  reader needs both to understand what happened.
- **A reversal is a new entry**, dated the day it was reversed, naming the entry
  it overturns and why the first answer did not survive.
- **Say what it changes** in the PRD's own terms — a goal narrowed, a non-goal
  promoted into scope, a design decision superseded, or nothing at all. Link the
  pull request that carried it.
- **Cutting scope is a decision.** A goal that quietly does not ship is the
  single most common thing this section exists to catch. Record it, with what
  would have to be true to pick it back up.

What belongs elsewhere:

| Decision | Where it goes |
| --- | --- |
| A product or scope consequence — the PRD's goals, behavior, or contract move | The decision log. |
| A low-level ambiguity resolved without changing the product contract | [`assumptions.md`](assumptions.md), which exists for exactly this. |
| How the shipped system now behaves, durably | The subsystem document that owns the area. The log says *why it changed*; that document says *what it is*. |
| A purely internal implementation choice with no product consequence | The pull request description, under **Key design decisions**. |

The log freezes with the rest of the PRD when `completed` is ticked. Before
ticking it, read back through the log and make sure every durable consequence
has landed in the document that owns the area — after the freeze, the log is
provenance rather than guidance.

### Optional sections

- **Key design decisions** — Decisions taken *while writing the PRD* that a
  reader might otherwise second-guess, numbered, each with its rationale *and*
  the alternative that was rejected. Recording the road not taken is what stops
  the same debate reopening in six months. Decisions taken *after* the PRD was
  agreed go in the decision log instead, which is where a superseded entry here
  gets overturned.
- **Data model** — The tables, columns, and relationships the change implies,
  and whether existing rows need backfilling. Sketch level is fine; the
  authoritative record is the migration and [`data-model.md`](data-model.md).
- **Regional impact** — What differs between configured deployments, what
  crosses the boundary, and where the data comes to rest. **Required in spirit**
  for anything touching identity, the Global registry, cross-region bridges,
  provider ingress routing, or data residency; read
  [`regionalization.md`](regionalization.md) first.
- **Security and trust model** — The trust surface the change opens or closes:
  renderer isolation, connector credential scope, session and ticket handling,
  webhook signature verification, untrusted model or provider payloads, secrets
  placement. **Required in spirit** whenever the change touches any of those;
  [`security.md`](security.md) defines the boundaries.
- **Agent behavior** — What the agent may now do, which typed tools it gains,
  what it is still forbidden, and what a user sees while it works. Required
  whenever the change touches the harness or adds or changes a tool or plugin;
  see [`agent-harness.md`](agent-harness.md) and the requirements below.
- **Provider configuration** — Any Slack, GitHub, Linear, Notion, Google,
  Resend, or Cloudflare setting that must change outside the repository, in
  which region, and what breaks if it is not applied before the change ships.
- **Rollout** — Phases, migration or backfill order, and how the change is
  turned off if it goes wrong. **Required in spirit for any feature a user can
  see.** The default is that a feature ships to everybody on merge: no flag, no
  staged audience, no staff-only period. Write this section to that default and
  say so.

  A feature only ships behind a flag when an engineer explicitly asks for one.
  When that happens, three things follow and all three belong in this section:

  1. **Name the flag**, with a key ending `-enabled`, per
     [`feature-flags.md`](feature-flags.md). The suffix is what marks it as a
     flag an operator manages rather than one driven by hand.
  2. **State its default**, and why that is the right one for this feature —
     a kill switch that defaults enabled and a staged rollout that defaults
     disabled are both legitimate, and which one this is has to be written down
     rather than inferred from the key.
  3. **It is registered in Ace**, which is the thing that creates it in
     Flagship and the only surface an operator can turn it on from. Serving the
     key from a Worker does neither;
     [`feature-flags.md`](feature-flags.md#adding-a-flag) lists the edits. A PRD
     that names a flag and stops at the Worker has specified a feature nobody
     can enable, and it will read as finished while being permanently off.

  Where the PRD has a `plan.md`, the phase that introduces the flag carries its
  Ace registration — not a later phase and not an unwritten follow-up. A phase
  whose acceptance gate is "the client reads the flag" passes with the flag
  uncreatable.
- **Acceptance** — How anyone can tell the PRD is done: the flows to walk and
  what each must show. Where these become durable checks, they land in
  [`e2e.md`](e2e.md).
- **Open questions** — What is genuinely undecided, and what each answer would
  change. An open question that blocks the build says so. Delete each one as it
  is resolved — resolved questions belong in **Key design decisions**.

### Required documentation for agent tools and plugins

A PRD that adds or changes an agent tool or plugin must include an **Agent
behavior** section and follow [`agent-tools.md`](agent-tools.md). “Add a tool
that edits files” or a table of tool names is not a buildable contract. Put
concise behavior in `prd.md` and split detailed schemas, sequencing, and prior
art into `design.md` or `research.md` when needed, but preserve all of the
following somewhere in the PRD folder:

1. **Plugin contract.** Give the canonical plugin ID, model-visible wire prefix,
   availability, selection, and authority conditions, preload/lazy-load
   behavior, tool order, and the exact high-salience system-prompt guidance.
   State what loading the plugin does and does not start, authorize, or persist.
2. **Complete tool catalog.** For every tool, give its canonical and
   model-visible names, model-facing description, capability, `read`/`write`
   mode, idempotency class, timeout, and whether execution must be serial. A
   model should be able to choose the right tool from this material without
   hidden implementation knowledge.
3. **Exact wire shapes.** Document every input property, whether it is required,
   optional, nullable, mutually exclusive, or forbidden, plus the complete
   successful output. Use the repository's real casing and Bind envelope. Name
   hard limits, defaults, cursor rules, strict unknown-field rejection, and the
   runtime validation that enforces the advertised JSON Schema.
4. **Discovery and sequencing.** Show where every ID, enum, cursor, revision,
   path, or other prerequisite comes from and include short common call
   sequences. If a consumer accepts `expectedRevision`, name the producing
   tool/output, define create-only semantics such as `null`, return the next
   revision after success, and require rereading after a conflict rather than
   returning a replacement token. Identify shell or other paths that bypass the
   guard and how they serialize with typed mutations.
5. **Failure and self-healing contract.** List common failures for every tool,
   with a stable code, an exact model-visible error sentence that includes the
   shortest safe next action, only the structured detail keys Bind actually
   forwards, and any contextual remediation in model-visible `data.details`. For
   example, a revision-conflict error says “The file changed after it was read.
   Read it again and rebuild the edit”; it does not merely say “stale revision”
   or hide the reread instruction in `summary`. Say whether the model should
   correct and retry, inspect state first, retry once after `retryAfterMs`, or
   stop for participant/policy/external-state change. Distinguish normal domain
   outcomes—such as a command exiting nonzero—from transport failures and
   ambiguous writes. Never put the only recovery instruction in the human-only
   `summary` or require the model to translate an internal error code into a
   procedure.
6. **Authority, safety, and lifecycle.** State what is model choice versus
   host-derived, how paths and identifiers are authorized, where credentials
   live, what the OS/provider boundary enforces, how network access works, and
   how cancellation, timeout, output truncation, replay, reconciliation, and
   cleanup behave. Permission prompts and command parsing are not described as
   a sandbox.
7. **Next-step outputs.** Return the IDs, revisions, URLs, hashes, statuses, and
   continuation values a likely following call needs. Document how a replay
   returns persisted values and how truncation exposes a bounded recovery path.
8. **Model-usability acceptance.** Add schema snapshot and contract tests for
   required, optional, forbidden, success, and failed shapes. Add prompt/tool
   evaluations on the configured medium fallback model that cover discovery,
   at least one successful multi-tool sequence, predictable wrong first calls,
   conflict recovery, stop conditions, and the absence of loops or blind
   side-effect retries. A frontier model succeeding is not sufficient evidence.

When implementation ships, the same durable material moves into the owning
subsystem documents and tests; the completed PRD remains provenance. If the
feature creates a large plugin or tool subsystem with no owner, add a module
document per [`module-documents.md`](module-documents.md) and register it in
[`README.md`](README.md).

### Conventions

- Markdown `##` per section; `###` beneath only when a section genuinely has
  parts. Numbered lists for goals, non-goals, and decisions, so a reviewer can
  cite "non-goal 3" and be understood.
- Present tense for proposed behavior ("a participant mutes a conversation…"),
  not future or conditional. A PRD describes the product it is asking for as
  though it exists.
- Refer to surfaces, tables, tools, and flags by their real names so a reader
  can go find them.
- Length follows the change. A one-surface refinement is a page; a subsystem is
  not. Move anything longer than the argument it supports into `design.md`.

### Skeleton

```markdown
# <Title>

> Created <yyyy-mm-dd>.
>
> <one-line scope, companion links>

## Summary
## Motivation
## Goals
## Non-goals
## Product behavior
## Impact on the product contract
## Decision log              <!-- `None yet.` until the build starts -->

## Key design decisions      <!-- optional -->
## Data model                <!-- optional -->
## Regional impact           <!-- optional -->
## Security and trust model  <!-- optional -->
## Agent behavior            <!-- required when adding/changing an agent tool or plugin -->
## Provider configuration    <!-- optional -->
## Rollout                   <!-- required for a user-visible feature -->
## Acceptance                <!-- optional -->
## Open questions            <!-- optional -->
```

## Relationship to the rest of `docs/`

- **PRDs are not registered individually in [the documentation
  index](README.md).** That index registers the durable documents that own an
  area, and it would churn beyond usefulness with one row per proposal. This
  document is the `docs/PRDs/` tree's only entry in it, the implementation brief
  included; the folder listing is the tree's own index.
- **A PRD does not replace the subsystem document.** When a PRD ships, the
  behavior it introduced is described in the document that owns the area —
  [`architecture.md`](architecture.md), [`data-model.md`](data-model.md),
  [`connectors.md`](connectors.md), and so on — updated in the same change as
  the code, per [the agent rule sheet](../AGENTS.md). If a PRD introduced a
  subsystem that no existing document covers, add `docs/<lower-kebab-name>.md`
  to the shape in [`module-documents.md`](module-documents.md) and register it in
  the index.
  Once the PRD freezes, that document's changelog — not the decision log — is
  where the module's reasoning continues to be recorded.
- **A subsystem document may cite a PRD** for the reasoning behind a decision.
  Link to the folder's `prd.md` by its full path; the path is stable for the life
  of the PRD, so such a link does not need revisiting when the PRD advances.
- **A pull request implementing a PRD** links to it from the **Motivation**
  section of its description, per [`pull-requests.md`](pull-requests.md).

## Creating one

1. Pick today's date and a short kebab-case description. Create
   `docs/PRDs/<yyyy>-<mm>-<dd>_<description>/prd.md`.
2. Add `state.md` next to it with the three-line checklist, `planned` ticked.
3. Write the title, then the header blockquote: creation date, a one-line scope,
   companion links.
4. Write the body against [the sections above](#the-sections-of-a-prd) — the
   seven required ones in order, then whichever optional ones apply. Start with
   **Non-goals** if the scope is contested; the rest gets easier once the edges
   are fixed. **Decision log** starts as `None yet.` If the PRD proposes a
   feature a user can see, **Rollout** applies: it ships to everybody on merge
   unless an engineer has explicitly asked for a flag.
5. If the PRD adds or changes an agent tool or plugin, complete the
   [tool-and-plugin documentation](#required-documentation-for-agent-tools-and-plugins)
   and verify each tool against [`agent-tools.md`](agent-tools.md).
6. Split out `design.md` or `research.md` if the body is carrying
   material that belongs in one of them.
7. Tick `in progress` in the commit where implementation starts. From here the
   **Decision log** is the live part of the document: append an entry in the same
   change as each decision that moves the scope, the behavior, or the contract.
8. When it ships, tick `completed`, read back through the decision log and make
   sure the subsystem documents describe the shipped behavior, and stop editing
   the PRD.
