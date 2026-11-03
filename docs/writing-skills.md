# Writing a skill

This is the **authoring guide** — how to write a skill a model will load at the
right moment and follow correctly. For how the skill *system* works (frozen
scope, the three disclosure tiers, `load_skill` / `read_skill_resource`, the
load caps, activation hints), read the Skills section of
[`agent-harness.md`](agent-harness.md#skills) first. This document is the craft
on top of it, and the skill analogue of [`agent-tools.md`](agent-tools.md).

A skill is **prompt content**. Once loaded, its body is rendered verbatim into
the system prompt's `# Active Skill Instructions` section, and its catalog line
sits in the `# Skills` section that every skill in the run's frozen scope
contributes to. So a skill is reviewed with the same rigor as any other prompt
text in `@rally/agent-harness`: clarity, the right altitude, no internal
contradictions, byte-stable in the cacheable prefix.

The reference exemplar is `deep-research` in
[`packages/agent-harness/src/built-in-skills.ts`](../packages/agent-harness/src/built-in-skills.ts).
Read it before writing your own — most of what follows is distilled from it.

`building-live-sites`
([`building-live-sites-skill.ts`](../packages/agent-harness/src/building-live-sites-skill.ts))
is the exemplar for the other shape: a skill that exists **because** its
material would not fit anywhere cheaper. Its standing policy carries six lines
of trigger and manners; everything the model needs once it is actually writing
files — the entry-file rule, the handler shape, the storage class, the viewer
headers — is here, loaded at the moment it matters. Its `ownerPlugin` scopes it
to runs that hold the Terminal plugin, because the whole procedure ends in
publishing a directory from a sandbox.

Skills named for an **outcome** a person asks for ("a report", "an app"),
rather than a capability, are **task skills** and live one per file in
[`packages/agent-harness/src/task-skills/`](../packages/agent-harness/src/task-skills/index.ts).
A task skill reads the request, settles what must be decided before work
starts, and names the procedure skills that do the work; it does not repeat
them.

## The bar: a medium-sized model, at two moments

A skill is read by a model **twice**, and it has to work both times for a
**medium-sized model**, not just the strongest one in the routing stage. Rally
routes each agent through a Cloudflare Flagship flag and falls back through
configured model stages ([`feature-flags.md`](feature-flags.md)), so the model
that reads your skill is not always the one you tested on. Holding both moments
to the medium-model bar is what keeps a skill honest: if a smaller model can
route to it and execute it, a larger one certainly will.

The two moments map onto the two parts of a `HarnessSkill`:

1. **WHEN to load it — routing (the Tier-1 catalog line).** Early in a run the
   model sees only your `description` and `whenToUse`, one line among every
   other skill in the `# Skills` catalog. From *that line alone* — **without
   having seen the body** — a medium model must be able to decide "this applies
   to the request in front of me", and that a sibling skill does not. That is
   what [the catalog line](#write-the-catalog-line-for-discovery) section covers.
2. **The CONTENTS once loaded — execution (the Tier-2 body).** After
   `load_skill`, the body is rendered into the system prompt and the model works
   through it. A medium model must be able to **follow it to completion** —
   every step actionable, no leap of frontier-level inference, no ambiguity
   about the next move. That is what [the body](#write-the-body) covers.

A brilliant body is wasted if the catalog line never gets the skill loaded; a
perfectly routed skill is wasted if the body loses a medium model halfway
through. Hold each part to its own moment.

## What a skill is — and when to write one

A skill is a **knowledge or procedure module**, not a capability. It captures
*how this workspace does a thing* — how it triages an inbox, what a handover
note must carry, the house voice — and orchestrates capabilities the run already
has. It carries no code and grants no authority.

Write a skill when:

- There is a **repeatable procedure** worth capturing once, rather than
  re-explaining it in every work stream.
- The guidance is **knowledge**, not a new capability. If what is missing is a
  *capability* — a provider call, a store read, a write — that is a plugin tool
  ([`agent-tools.md`](agent-tools.md)), possibly *with* a skill that teaches the
  recipe for using it.
- The procedure is **non-obvious** enough that a model benefits from a pinned
  playbook rather than re-deriving it each run.

Do not write a skill for a one-off, for something a sentence in an existing
system message already covers, or for a capability that does not exist yet.

## Anatomy of a skill

A skill is a `HarnessSkill` value
([`packages/agent-harness/src/index.ts`](../packages/agent-harness/src/index.ts)):

```ts
export const TRIAGE_SKILL: HarnessSkill = {
  name: "triaging-an-inbound-queue",       // lower-kebab, unique within a run
  description: "How to work an inbound queue down to zero…",   // Tier 1
  whenToUse: "When asked to work through a backlog of…",       // Tier 1
  body: TRIAGE_BODY,                                           // Tier 2
  ownerPlugin: "rally:workstream",                            // optional
  resources: [{ path: "reference/severity.md", body: SEVERITY }], // Tier 3
};
```

Skills the package ships are authored in **TypeScript, not as `SKILL.md`
files**, because the harness runs in `workerd` and has no filesystem to read
them from at startup. A host that stores skills elsewhere can still author
markdown: `parseSkillMarkdown` from `@juno-ai/bind/skills` parses a `SKILL.md`
straight into this shape. Either way the same fields carry the same weight, and
everything below applies.

A run's skills are **frozen with its scope** — resolved against the execution
principal before admission and handed to the harness on
`RunHarnessInput.skills`. Nothing in the loop reaches a store, so authoring a
skill is never an authorization decision; putting it in a run's `skills` is.

## Name it

Use a short **gerund phrase** that reads as the action:
`triaging-an-inbound-queue`, `preparing-a-handover-note`,
`running-a-weekly-digest`. Lower-kebab, unique within a run.

The name is the identifier `load_skill` takes and the key a durable activation
hint restores against, so do not rename a shipped skill casually — a hint whose
name no longer resolves is dropped rather than restored, and the resumed attempt
silently loses the skill. The registry is keyed by name and last write wins, so
a collision loses a skill outright; that is one of the warnings surfaced through
`onSkillWarning`.

## Write the catalog line for discovery

This is the highest-leverage part — it governs **moment 1, WHEN the skill
loads**. `description` and `whenToUse` are the *only* things a model sees about
your skill until it loads it, and a medium model has to make the load decision
from that one line, without the body.

- **One tight line each.** The catalog has a token budget (2,500 by default in
  `renderPromptSkillCatalog`). Overflow is **demoted to names only**, not
  dropped — but a bloated description can cost your skill, or a sibling, its
  description entirely, leaving the model a bare name to route on. Leave
  headroom.
- **Say what it does *and* the kind of request it is for**, in concrete task
  terms. Good: *"How to research a question end to end: scope it into checkable
  claims, work authorized sources before the public web, corroborate and date
  every fact…"*. Bad: *"A helpful research skill."*
- **Make it mutually distinguishable from its siblings.** The model picks among
  every skill in the catalog; if two lines read alike, neither routes reliably.
  Earn the separation in the first clause.
- **`whenToUse` is the trigger.** Phrase it as the situation the model is
  actually in: *"When a request needs evidence gathered and reconciled across
  more than one source, rather than a single lookup."* It is rendered after an
  em dash on the same catalog line, so it must read as a continuation, not as a
  second description.
- **Write for routing, not for marketing** — concrete capability nouns and
  verbs, the words a person making the request would use.

## Write the body

The body governs **moment 2, the CONTENTS once loaded**. Everything below serves
one goal: a medium model, having just loaded the skill, can follow it to done.

### Pitch it at the right altitude

The central design problem. Too **low** — a brittle script hard-coding every
branch — is fragile and ages badly. Too **high** — vague vibes assuming context
the run does not have — gives no actionable signal. Aim between: **firm
heuristics and clear boundaries** the model can act on. State the rule and the
*why*, and let the model handle specifics.

### Make it self-contained

The body is the whole brief for the task. Name the inputs and where they live,
what to produce and where it goes, and the **stop conditions** — including when
to stay silent or hand back. An automation run starts with no memory of why it
exists, and a headless run has no one to ask; do not assume prior context.

### Nudge behaviors, not literal tool names

Describe *what to do* and let the model find the tool: "search the authorized
connectors", "read the attached resources", "ask for the missing identifier" —
not `web_search`, `run_subagent`, `request_elicitation`. A
literal wire name is brittle: nothing compiles prose, so a rename or a plugin
that is not in this run's frozen scope breaks it silently, and Bind composes the
model-facing wire name from the plugin's short name at render time anyway.

These, by contrast, are **not** brittle literals and are fine to name:

- **Data-shape fields the model must populate** — the fields of a draft, a
  column name, a required section of an output. Naming the field it fills is
  precision, not plumbing.
- **Enum and input-kind values** — `radio`, `multi_select`, a status value.
  These are values, not callable tools.
- **A plugin id, when the skill's procedure needs that plugin's capability** —
  plugin ids are stable authorization identities, and `load_skill` already
  names a skill's `ownerPlugin` back to the model. Say "load the Google
  plugin", not "call `gmail_search_messages`".
- **Another skill's name** — a composition reference is a stable anchor.
- **The owner plugin's own tools, in a skill that plugin owns** — a skill
  whose `ownerPlugin` is the plugin that defines the tool is only offered where
  that tool is, and its tool names are as fixed as the plugin's. So
  `building-live-sites`, owned by `rally:terminal`, names `run_command`,
  `view_image` and `publish_resource`. A tool from any other plugin is still a
  behavior to describe.

Error-code literals the model branches on are a softer smell: prefer describing
the condition ("if the tool reports the connection is no longer authorized")
over pinning the code string.

### Pair every "don't" with a "do instead"

A wall of prohibitions tells the model nothing about what to actually do. For
every "don't X", give the "do Y instead". And never contradict yourself across
the body — an "always X" in one section and a "never X" in another is the single
most common silent-failure pattern, and the model will pick whichever it read
last.

### One skill, one job — and compose with the others

Keep each skill scoped to a single job; prefer one well-scoped skill over a
sprawling one. Every loaded body spends the run's skill budget, and a skill that
covers four procedures charges the model for three it did not need. When a
related procedure exists, **point to the companion skill** rather than
duplicating it — duplicated guidance drifts.

### Use the house structure

Procedures read as **numbered steps**, optionally followed by an
**`## Anti-patterns`** section listing failure modes and the right move for
each. Bold the load-bearing terms. Second person, imperative. Match the voice of
`deep-research`.

### Keep it legible to a medium model

Moment 2, restated as a rule. If an instruction relies on frontier-level
inference to interpret, it is too subtle — make it explicit. Avoid
over-prompting: fifteen stacked rules dilute attention, so consolidate into a
few principled statements with one or two canonical examples. Do not stuff a
persona, and do not enumerate every edge case.

## Bundled resources are Tier 3, and they are bounded

`resources` are reference files a model reads with `read_skill_resource` **after
loading the skill** — a rubric, a schema, a long example set. Use them for
material that is needed occasionally and would otherwise blow up the body every
run.

Two constraints shape how you split:

- **The gate.** `read_skill_resource` refuses until its skill is loaded. That is
  deliberate: it stops a model pulling every catalog skill's references without
  taking on the instructions they belong to. So a resource must make sense only
  in the context of its body — never park the actual procedure in a resource.
- **The byte cap.** One response is capped (64 KiB by default,
  `maxSkillResourceBytes`) and over-long content is **truncated with a marker**,
  not rejected. A reference that only makes sense whole must fit; split it into
  several paths instead of relying on one long read.

Give each resource a path that says what it is (`reference/severity-rubric.md`),
and mention in the body when to read it. The body is the only place the model
learns a resource exists.

## Loading a skill grants no authority

Loading a skill adds instructions and nothing else. Where a skill declares an
`ownerPlugin`, two conservative things happen: the skill is offered only to a
run whose frozen scope already includes that plugin, and loading it **names**
the plugin for the model to load separately rather than activating it. An
auto-activation would let a document issue a capability grant.

Write bodies with that in mind. A skill may say the procedure needs a plugin's
capability; it must not read as though loading the skill has already provided
it. And set `ownerPlugin` whenever the procedure is meaningless without a
particular plugin — that containment is what keeps a Google-specific playbook
out of the catalog of a run with no Google connection.

Skill bodies are workspace-authored instructions, wrapped in a
`<skill_content name=…>` element so the model can tell them apart from platform
policy and from one another. They are not trusted prose about the world, and
they never carry provider content: a skill that quotes a remote document is
laundering untrusted data into the instruction layer.

## It is prompt content — keep it cache-friendly

Both prompt sections are a pure render of run state, rebuilt from the active set
on every turn in the harness's total order rather than spliced into the previous
prompt, so a resumed attempt produces the same bytes as a fresh one and the
provider's cached prefix survives. Two authoring rules follow:

- **Never interpolate a per-run value** — a timestamp, a counter, a work-stream
  id — into a `description`, `whenToUse`, or `body`. If a skill genuinely needs
  a dynamic value, that value belongs in the run's user-role context, not baked
  into the skill.
- **Keep the body stable across attempts.** A body computed differently on a
  retry breaks prefix caching and can trip Bind's drifted-pin warning.

## Testing and verifying

- **Skills have no golden render test of their own**; the coverage that matters
  is selection and rendering.
  [`skills.test.ts`](../packages/agent-harness/src/skills.test.ts) covers the
  runtime — offering, the owner-plugin filter, the load caps, the resource gate
  and its truncation — and
  [`prompts.test.ts`](../packages/agent-harness/src/prompts.test.ts) covers the
  catalog render, including the demote-never-drop overflow behavior. Add a case
  when a new skill exercises a path they do not already cover.
- **Cross-references resolve.** If your body names a companion skill or a
  plugin, make sure it exists and can actually be in scope with this skill.
- **Every field is present.** `name` lower-kebab, `description` and `whenToUse`
  both set — a skill with no `whenToUse` renders a catalog line with no trigger,
  which is the most common reason a good skill never loads.
- **Read it back as the model would, at both moments.** Does the catalog line
  *alone* tell a medium model when to load this and not a sibling? Does the body
  *alone* let it finish without re-deriving anything?

## Checklist

- [ ] Name is a short lower-kebab gerund phrase, and stable — renaming drops
      activation hints.
- [ ] **Moment 1 (WHEN):** from the catalog line alone, no body, a medium model
      can decide to load it and not a sibling.
- [ ] `description` is one tight line: what it does plus the request it is for,
      distinct from siblings, with headroom under the catalog budget.
- [ ] `whenToUse` is the literal trigger and reads as a continuation of the
      description.
- [ ] **Moment 2 (CONTENTS):** a medium model can execute the body to
      completion — no frontier-level inference, no over-prompting, no persona
      stuffing.
- [ ] Body is at the right altitude: firm heuristics, not a brittle script or
      vague vibes.
- [ ] Self-contained: inputs, outputs, destinations, and stop conditions named.
- [ ] Behavior nudges, not literal wire tool names (data-shape fields, enum
      values, plugin ids, and skill names are fine).
- [ ] Every "don't" has a "do instead"; no internal contradictions.
- [ ] One focused job; companions referenced, not duplicated.
- [ ] Numbered steps and, where useful, `## Anti-patterns`; second person,
      imperative.
- [ ] `ownerPlugin` set when the procedure depends on a specific plugin; the
      body never implies loading the skill granted that plugin's tools.
- [ ] Resources are genuinely occasional reference, each fits the read cap, and
      the body says when to read them.
- [ ] No per-run interpolation anywhere in the three rendered fields.

## See also

- [`agent-harness.md`](agent-harness.md#skills) — the skill **system**: frozen
  scope, disclosure tiers, the two controls, caps, activation hints, warnings.
- [`agent-tools.md`](agent-tools.md) — when the right answer is a *tool*, not a
  skill, and how to design one for a medium model.
- [`writing-prompts.md`](writing-prompts.md) — when it belongs in standing
  *policy* rather than a loaded skill, and how that text is written.
- [`built-in-skills.ts`](../packages/agent-harness/src/built-in-skills.ts) — the
  live exemplar.
- [`security.md`](security.md) — the trust boundaries a skill body must respect.
