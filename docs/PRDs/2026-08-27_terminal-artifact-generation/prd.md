# Terminal-driven artifact generation

> Created 2026-08-27.
>
> When a participant asks Rally for a document — a PRD, a press release, a
> plan, a brief — the model writes it as a file in the work stream's
> Terminal sandbox and publishes it back into the work stream as an ordinary
> generated resource. No new message type, no new tools, no new plugin: this
> change is standing-prompt guidance over machinery that already exists.
> Companion: [state](state.md). Supersedes part of the combined
> work-stream artifacts PRD, which was not merged; its folder — including
> the `design.md` protocol comparison that picked this path's machinery —
> remains readable on
> [PR #334](https://github.com/juno-ai-labs/avalon/pull/334). Siblings:
> [resource versioning](../2026-08-27_resource-versioning/prd.md) (history
> beneath the resources this produces),
> [inline resource citations](../2026-08-27_inline-resource-citations/prd.md)
> (how the chat references them). Subsystem references:
> [Terminal work spaces](../../terminal-workspaces.md),
> [agent attachments](../../agent-attachments.md),
> [writing prompts](../../writing-prompts.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A document-shaped request stops streaming a wall of text into the
transcript. Steered by new standing-prompt guidance, the model loads the
Terminal plugin, writes the document as a Markdown file in the work
stream's sandbox with its ordinary file tools, and publishes it with
`terminal_publish_resource`. The published file is a generated resource:
it appears in the right rail's resource list under existing visibility
rules, opens in the existing preview surfaces, is readable back by the
model through the existing attachment tools, and survives compaction
through the existing resource inventory. The chat shows what it always
shows — tool-activity rows while the agent works, then a short
conversational message naming what was produced.

A revision request works the same way: the model edits the file in the
sandbox (re-importing it from the published resource first if the sandbox
was recycled) and publishes again. Publishing the same sandbox path from
the same work stream updates the same resource rather than minting a
sibling, which is the one behavioral change to the publish path this PRD
makes. Until [resource versioning](../2026-08-27_resource-versioning/prd.md)
lands, an update is latest-only — the superseded content is not retained —
and that limitation is accepted and named rather than solved here.

Everything about this change ships server-side. The trigger heuristic, the
narration discipline, and the file-then-publish procedure are prompt
policy; retuning or reverting any of it is an API deploy, with no desktop
release and no schema change anywhere.

## Motivation

The problem is unchanged from the superseded PRD: a request like "draft
the launch press release" produces one assistant message spanning many
viewport heights, which buries the conversation, reads as finished output
rather than a draft under discussion, and multiplies with every revision.
The transcript stops being the "readable shared transcript" the product
contract promises, and the output has no durable identity a group can
open, revise, or later export.

What changed is the cost side of the equation. The superseded design
reached the document surface through a new message type, two dedicated
tools, an artifact-specific version ledger, and a new right-rail pane —
weeks of build across four layers. But Rally already owns every mechanism
the core experience needs: a per-work-stream sandbox where the model is
heavily trained to write and edit files; a publish operation that lands a
sandbox file as a durable, receipt-deduplicated generated resource; a
resource rail every participant can open; read tools and a
compaction-surviving inventory that let the model rediscover its own
output. The 2026-08-12 artifact retirement's standing instruction —
"anything durable that a person should be able to open belongs in
`resources`" — is satisfied by the publish path that has existed since the
Terminal plugin shipped. What is missing is only the instruction to use
it: nothing tells the model that a document request should become a file
and a publish rather than a wall of chat text.

This PRD adds that instruction and deliberately nothing else. The two
capabilities the combined design bundled in — version history beneath
updated resources, and an in-chat affordance that references the document
— are real, and they are their own PRDs, listed as siblings above. This
one is intentionally narrow so it can ship first and alone.

## Goals

1. A request whose natural output is a document produces a published
   generated resource in the work stream and a short conversational
   message — never the full document streamed inline into the transcript.
2. A revision request updates the same resource: stable identity across
   publishes of the same document, so the rail shows one entry per
   document, not one per draft.
3. The trigger heuristic and the procedure are standing-prompt policy:
   tunable and reversible by API deploy alone, with nothing for the
   desktop to ship or know.
4. The model can revise after any interruption — sandbox recycled, context
   compacted — using only existing recovery rails: list the resource, read
   or re-import it, edit, republish.
5. Every surface that exists today keeps working unchanged: the resource
   rail, previews, the attachment read tools, the compaction inventory,
   digests that link the work stream.

## Non-goals

1. **A new message type, transcript card, or document pane.** Rejected
   here. The chat references the document in ordinary prose; making that
   reference a rendered chip that opens the rail is
   [the citations PRD](../2026-08-27_inline-resource-citations/prd.md)'s
   scope, and a dedicated pane is not currently planned at all — the rail's
   existing preview surfaces are the V1 reading experience.
2. **New agent tools or a new plugin.** Rejected. The Terminal plugin's
   existing file and publish tools are the entire mechanism; adding a
   parallel artifact tool family is precisely what the superseded PRD did
   and this split undoes.
3. **Version history.** Deferred to
   [resource versioning](../2026-08-27_resource-versioning/prd.md). Until
   it lands, a republish is a destructive latest-only update, and this PRD
   ships anyway with that named.
4. **A feature flag.** Rejected for this change. The whole behavior is
   prompt policy; the deploy is the rollout and the revert is the
   rollback. If staged per-workspace rollout is later wanted, gating the
   policy's rendering at run admission is the established pattern to
   reach for.
5. **Changing when the Terminal plugin itself is available.** Rejected.
   Its existing availability, region, and origin rules stand; where
   Terminal is unavailable, the guidance does not render and behavior is
   today's inline answer.
6. **Guidance for automation, inbound-email, or delegated child runs.**
   Deferred. The policy renders for ordinary participant-triggered work
   stream runs only; other origins keep their current delivery-path
   behavior until those paths are taught what a published document means
   to them.
7. **Non-Markdown documents.** Deferred. The guidance steers to GFM
   Markdown files; the publish path itself is format-agnostic already, so
   widening later is policy wording, not machinery.
8. **New defensive numbers.** Rejected — none are added. File and publish
   sizes ride the Terminal plugin's existing bounds.

## Product behavior

A participant asks for something document-shaped — "draft a PRD for mute
windows". The run, steered by the policy below:

1. Loads the Terminal plugin if it is not already active (its normal
   deferred activation; the first file operation acquires the work
   stream's sandbox, with that acquisition's usual cold-start cost).
2. Writes the document to a stable, human-named file —
   `mute-windows-prd.md` — using the ordinary file tools.
3. Publishes it with `terminal_publish_resource`, titling it for people
   ("Mute windows PRD").
4. Says, in the chat, a short framing and an invitation to iterate — "I've
   drafted the PRD as a document in this work stream — tell me what you'd
   like changed." — and nothing of the document's content.

Participants see the standard tool-activity rows while this happens
(writing the file, publishing), then the message. The published document
appears in the right rail's resource list under the work stream's existing
visibility rules and opens in the existing preview surface; selection and
copy behave as they do for any Markdown resource today.

**Revision.** "Tighten the goals section" leads the model to edit the
file — a targeted in-place edit with its trained file tools, not a
regeneration — and publish the same path again. The publish updates the
existing resource in place (goal 2): same rail entry, fresh content. If
the sandbox was recycled since the draft, the model first re-imports the
published resource into the sandbox with `terminal_import_resource`, then
edits and republishes. If context was compacted, the resource inventory
and `workstream_list_resources` rediscover the document exactly as they
rediscover any attachment.

**The trigger heuristic** carries over from the superseded PRD, restated
as this policy's intent: explicit document-type requests (PRD, press
release, plan, spec, brief, report, proposal, memo, FAQ, or comparable)
trigger it independently; a substantial structured composition — longer
than roughly three paragraphs *and* organized with headings, sections, or
a standalone table — triggers it; a large result that would bury the
conversation triggers it; conversational answers of any length, content
whose home is another tool, and participant overrides never do.

## Impact on the product contract

None — this refines behavior within the existing contract. The agent uses
typed, authorized tools that already exist; a published document is a
resource, one of the contract's named persistent kinds; participants see
tool activity and a resource, never a terminal, shell, or PTY; viewing
the document is viewing and creates no participation. No clause moves.

### 2026-08-27 — Acceptance criterion 1 is blocked: nothing in the client reads a published document

**Decided:** The guidance and the publish-path refinement ship; this PRD stays
`in progress` rather than reaching `completed`.

**Why:** Product behavior and non-goal 1 both rest on "the rail's existing
preview surfaces are the V1 reading experience". Checked in a real window, that
premise is false. A generated resource appears in the rail under **Artifacts**
and opening it shows a metadata panel — title, provider, type, direction,
version, last updated, `Remove` — with no content. `InspectorDetail` renders no
body, and `AttachmentLightbox`, the one surface that fetches
`/resources/:id/preview`, is wired only to attachments on a message.

**Changes:** Acceptance criterion 1 cannot be demonstrated, and goal 1 ships
without a reader. To pick it up: a body renderer in the rail's resource detail,
or `AttachmentLightbox` wired to rail resources — a desktop change this PRD
excludes outright ("no desktop release"), so it wants its own PRD. The durable
limitation is recorded in [`agent-harness.md`](../../agent-harness.md) under
Failure modes and limits.

### 2026-08-27 — Latest-only republish does not ship; the versioning layer landed first

**Decided:** A republish is an ordinary semantic write, and the superseded
object is deliberately **not** enqueued for cleanup.

**Why:** Key design decision 3 and non-goal 3 accepted a destructive
latest-only update because resource versioning had not landed. It landed the
same day, before this. WorkspaceDO's `resources_create_semantic_version`
captures the superseded original and derivative, and the reaper treats a ref a
version row still names as active — so the "existing superseded-content
cleanup" this PRD expected to fire would be a deletion the reaper immediately
cancels.

**Changes:** Key design decision 3 is superseded and the fourth rollout risk
does not apply. A future change must not reinstate an explicit enqueue of the
old pointer.

### 2026-08-27 — Slack-origin runs are excluded from the guidance

**Decided:** The policy does not render for a run carrying a `slackOrigin`.

**Why:** Non-goal 6 defers automation, inbound-email and delegated child runs
because their delivery paths cannot carry a document reference. Slack delivery
cannot either, and it was not named. A Slack participant would be told a
document exists and given no way to open it — worse than today's inline answer.

**Changes:** Non-goal 6's list widens by one. Turning it on later is one
condition removed from `runPublishesDocuments`.

### 2026-08-27 — The work-stream prompt version is not bumped

**Decided:** `WORKSTREAM_PROMPT_VERSION` is unchanged, settling the first
rollout risk this PRD left to implementation.

**Why:** It is hashed into the immutable run scope, so bumping it fails every
in-flight run resuming across the deploy with `immutable_run_scope_mismatch`.
This section grants no capability and moves no authority — eligible
capabilities and the tool surface hash are unchanged — and its flag derives
from environment and run input already frozen for the run.

**Changes:** A later prompt change that does move authority still needs the
bump; this decision is not a precedent for prompt edits in general.

### 2026-08-27 — The guidance ships as standing policy, not a skill

**Decided:** Open question 1 resolved in favour of standing policy.

**Why:** Measured rather than argued — the rendered standing prompt is 6,172
bytes against its 8,000 ceiling, so it fits, and a skill would pay a load round
trip for a rule whose trigger is evaluated on any request.

**Changes:** Open question 1 is answered and removed below.

## Key design decisions

1. **Prompt guidance over new machinery.** The generation protocol rides
   the Terminal plugin's existing, heavily-trained file workflow; the only
   deliverable is policy plus one publish-path refinement. The rejected
   alternative — the superseded PRD's dedicated typed artifact tools and
   message type — bought observability and a bespoke surface at the cost
   of four layers of new build, and its own protocol framework (the
   unmerged combined PRD's `design.md`, on
   [PR #334](https://github.com/juno-ai-labs/avalon/pull/334)) rated the
   Terminal path strongest exactly where documents hurt most: targeted
   edits to long files. The cold-start and two-copies costs that framework
   charged against Terminal are accepted here as the price of shipping
   with machinery that exists.
2. **Same path, same resource.** Publishing the same sandbox path from the
   same work stream updates the existing generated resource instead of
   creating a sibling. Mechanically this is a change to how the publish
   path derives the resource's provider identity — path-scoped rather than
   per-call — so the existing provider-identity dedupe does the work;
   replay of a single call remains receipt-deduplicated as today. The
   rejected alternative, a new resource per publish, makes three revisions
   read as four documents in the rail and gives the versioning PRD no
   stable object to hang history on.
3. **Latest-only updates are accepted until the versioning layer lands.**
   A republish today supersedes the prior content, which the resource
   lifecycle then reaps. Shipping without history is acceptable for
   drafting (the transcript still records what was asked and said); the
   sibling PRD adds history beneath exactly these pointer updates, and
   nothing in this PRD has to change when it does.
4. **No flag.** The behavior is a prompt module: deploy to turn on, revert
   to turn off, both region-wide. The rejected alternative — an
   admission-consulted flag in the digests pattern — buys staged rollout
   at the cost of the second-ever server-consulted product flag for what
   is, structurally, a prompt change. If dogfooding demands staging, that
   is the escalation, recorded here so it is reached deliberately.
5. **The chat references the document in prose for now.** With no new
   message type permitted, the announcement is the model's own words plus
   the rail entry. The citations sibling turns those words into a
   clickable chip; this PRD does not wait for it.

## Agent behavior

No tool or plugin is added or changed; this section records the guidance
contract and the one publish-path refinement.

**Guidance placement and availability.** A new standing-policy module in
the agent harness's prompt family (beside the response-formatting policy),
rendered into the work-stream system prompt only when the run is an
ordinary participant-triggered work-stream run *and* the Terminal plugin
is available to it under its existing rules. Written to the
prompt-authoring rules: byte-stable, golden-hash-pinned, within the
standing-policy byte budget — and if it does not fit that budget, it ships
as an always-available skill instead (see Open questions).

**Guidance content, normatively.** Half the teaching already exists: the
Terminal plugin's own activation message instructs the mechanics — write
the final stable file beneath the sandbox's resource-output directory,
then publish it with a path relative to that directory — and the standing
work-stream policy already nudges the model toward Terminal when writing
code helps. What the new policy adds is only the missing trigger and the
manners: recognize the document-shaped triggers above and load Terminal
for them; write the document as a Markdown file at a stable, descriptive
path; publish with a human title; keep all chat narration short and free
of the document's content; on revision, edit the existing file
(re-importing from the published resource if the sandbox no longer has
it) and publish the same path; obey explicit participant overrides in
both directions. The policy names no wire tool names — house prompt
practice, and unnecessary here anyway: it steers generically ("use the
terminal workspace to write the document as a file and publish it as a
work-stream resource"), the way the standing prompt already says "use
the terminal tool" for code-shaped work, and the Terminal plugin's own
activation message — which the model has whenever these tools are in
scope — already carries the exact tool-by-name procedure for writing
beneath the resource directory and publishing. Standing policy owns the
trigger and the manners; the plugin message owns the mechanics.

**The publish-path refinement** (key design decision 2), exactly. Today
the publish service derives the resource's provider identity from the
call's own effect intent — `terminal:<effect-intent-id>` — and looks it
up workspace-scoped by `(provider, provider_resource_id)`. Because that
identity is unique per call, the lookup can only ever deduplicate a
replay of the *same* call; a second publish of the same file
legitimately mints a sibling resource. The change is one derivation and
one branch:

- Derive the provider identity from the document's stable coordinates
  instead: the work stream and the normalized published path (shape:
  `terminal:<workstream-id>:<normalized-path>`). The existing lookup
  then finds the document's row across calls, and two work streams
  publishing the same filename stay distinct.
- On a lookup hit with an equal content hash, return the existing
  resource unchanged — this one branch covers both a crash-replay of a
  settled call and a no-change republish.
- On a hit with a different hash, update in place: write the new content
  object, compare-and-swap the row's content pointer and hash, reset the
  derivative to pending, apply a new title if one was given, and keep
  the resource id and its work-stream link. This is the same swap shape
  the connector re-fetch path already performs — and, until the
  versioning sibling lands, it fires the existing superseded-content
  cleanup, which is the latest-only behavior decision 3 accepts.

The tool's model-facing contract — name, inputs, outputs, receipt
behavior — does not change; resources published before the change keep
their per-call identities, and only new publishes adopt path-scoped
identity.

**Verification.** Formal prompt evaluations are deliberately deferred:
Rally has no evaluation suite yet, and this PRD does not build one.
Until one exists, verification is the Acceptance section's manual
flows, walked in dogfooding on the models the route plan actually
serves — brief narration, no inline document, same-path revision,
recycle recovery, and override obedience are exactly those flows, so
nothing is lost except automation. Golden-hash updates to the prompt
module itself are still made deliberately, as for any prompt change.

## Rollout

1. Ship the policy module and the publish-path refinement in one API
   deploy. No desktop release, no migration, no flag.

2. Rollback is reverting the policy module (the publish-path refinement is
   inert without the guidance driving republish traffic and can stay).

**Migration and compatibility risks, stated plainly:**

- The policy changes behavior for every qualifying run at deploy, region
  wide (non-goal 4 accepts this). Whether the addition warrants a
  work-stream prompt-version bump is settled at implementation against
  the in-flight-run cost that bump carries.

- Changing publish identity derivation must not disturb replay of
  already-settled publishes. Today the publish path derives the
  resource's provider identity from the per-call effect intent, which is
  what makes each republish a sibling; the change derives it from the
  work stream and published path, while single-call replay keeps its
  receipt-based dedupe. Existing dogfood resources keep their
  identities; only new publishes adopt path-scoped identity.

- Until the versioning sibling lands, republish is destructive
  (latest-only); teams relying on drafts-history during that window have
  the transcript, not the document, as their record.

- Sandbox cold-start adds seconds to the first document request in a work
  stream; accepted, since generation time dominates.

## Acceptance

1. In a work stream where Terminal is available, "draft a PRD for
   <topic>" yields file-write and publish activity rows, a generated
   resource in the rail that opens to the formatted document, and a short
   chat message — with the document never rendered inline in the feed.
2. "Tighten the goals section" yields an edit and a republish; the rail
   still shows exactly one entry for the document, now with the updated
   content.
3. After a forced sandbox recycle, a revision request succeeds via
   import → edit → republish.
4. A short factual question produces an inline answer and no file
   activity; "just answer in chat" and "make that a document" both
   override the heuristic.
5. Where Terminal is unavailable, behavior is byte-identical to today.
6. `pnpm lint` (zero warnings), `pnpm typecheck`, and `pnpm test` pass;
   prompt golden hashes updated deliberately; every new test shown to
   fail when the behavior it protects is broken; the rail and preview
   surfaces captured from a real window.

## Open questions

1. **Should automation runs get the guidance once their delivery paths
   can carry a document reference?** Deferred with non-goal 6; the answer
   arrives with the digest/delivery work, not here.
2. **Cold-start presentation.** Whether the sandbox-acquisition wait needs
   its own activity copy ("Setting up the work stream's workspace…") or
   the existing tool rows suffice — settle against real screenshots
   during implementation.
3. **A token-friendly resource identifier.** ~~The model handles
   resource ids here only occasionally — publish outputs return one, and
   the recycle-recovery path passes one to import — but the suggestion
   of a short slug alias for resources (raised against the citations
   sibling, where ids are emitted routinely) would make those ids
   cheaper and safer to copy here too.~~ **Resolved elsewhere: the slug
   alias was adopted.** It rides the
   [versioning sibling](../2026-08-27_resource-versioning/prd.md)'s
   schema work (its key design decision 8), which puts slugs in
   model-facing outputs and listings — so publish results get cheaper
   ids when that lands. The recycle-recovery import's contract is
   unchanged: `terminal_import_resource` takes the UUID, and accepting
   slugs there would be its own input-contract change, not implied by
   the alias. Nothing here depends on identifier shape.
