# Writing a system prompt

This is the **authoring guide** for the prompt text Rally sends to a model —
the standing policy a run starts from, the classifier prompts that decide
routing, and the catalogs rendered into the system prefix. For how a prompt is
assembled, frozen, and cached across a run, read
[`agent-harness.md`](agent-harness.md); this document is the craft on top of it.

It completes a set of three. [`agent-tools.md`](agent-tools.md) covers the
*capabilities* a model calls, [`writing-skills.md`](writing-skills.md) covers
the *procedures* it loads mid-run, and this covers the *policy* it starts with.
The three share one design target and one voice, and the principles below are
the same principles, applied to the surface that is hardest to change safely: a
tool schema is validated, a skill is loaded only when it routes, but policy is
in front of the model on every turn of every run.

> **The prompts in
> [`packages/agent-harness/src/prompts/`](../packages/agent-harness/src/prompts/)
> are not exemplars.** Several predate this guide and break rules in it — rules
> stated twice in different words, enumerations that should be discovery, policy
> that should be a skill. Read them to learn the plumbing (how a renderer is
> shaped, how untrusted content is layered, what the tests assert), not as a
> model for the writing. When you touch one, move it toward this document rather
> than matching what is around it.

## The bar: a medium-sized model, on every turn

**Write every prompt so a medium-sized model follows it correctly, not just the
strongest model in the routing stage.** This is the same target
[`agent-tools.md`](agent-tools.md) sets for tool design, and it is not
hypothetical: model routing is a flag with configured fallback stages
([`feature-flags.md`](feature-flags.md)), classifier work already runs on a
small model, and a rule that only a frontier model can interpret becomes a
silent behavior change the first time a run falls back.

A medium model reads policy literally, does not re-derive intent from tone, and
resolves an ambiguity by picking one side without telling you. So hold every
prompt to three tests:

- Could the model act on this rule **without inferring anything unstated** —
  including knowing when the rule does *not* apply?
- If two rules could apply at once, does the prompt **say which wins**?
- If the model does the obvious wrong thing, is that because the prompt left a
  gap it had to fill?

## Prompts are code

Every prompt is a typed, dependency-free function returning a `string` or a
`PromptMessage[]`. There is no template language, no file loaded at startup, and
no I/O in the render path — the harness runs in `workerd`, and a prompt that
reaches a store cannot be re-rendered deterministically on a retry.

The static policy is a module-level constant; the render function composes it
with run state. Keep that split honest: anything interpolated into the system
string is something the prompt cache must re-establish and a reviewer must
reason about, and the default home for run data is a user-role message.

### 1. Pitch it at the right altitude

The central design problem, and the same one skills have. Too **low** — a
branch-by-branch script — is brittle, ages badly, and collapses the moment the
run does not match the branch. Too **high** — "be helpful", "use good judgment"
— gives a medium model no signal at all. Aim between: **firm heuristics and
clear boundaries**, stated with the conditions that make them decidable.

"Act on a clear, scoped request; ask only when a missing identifier, permission,
connection, or irreversible choice leaves no safe default" is at altitude,
because it names what counts. "Be appropriately proactive" is not, because two
models will draw the line in different places and neither is wrong.

### 2. Ambiguity is an error, not a guess

`agent-tools.md` refuses to let a tool resolve an ambiguous name by picking the
first match, for the same reason a prompt must not leave two rules competing:
the model will resolve it, silently, and you will not find out until the wrong
behavior ships. Where two instructions can both apply, **state the tie-break in
the prompt**, not in your head — which one wins, and under what condition. Where
a rule has an exception, put the exception next to the rule.

### 3. Pair every prohibition with the action that replaces it

A prohibition alone leaves a hole where a behavior should be. For every "never
X", give the "do Y instead" — and put them in the same breath, not in different
sections. A policy that is mostly "never" teaches avoidance, not competence.

### 4. Say each thing once

Two rules that disagree resolve to whichever the model read last, and nothing
lints them. Repetition is that failure in slow motion: the same rule stated
twice in different words drifts on the next edit and becomes a contradiction.
Say each thing once, in the section that owns it, and when you find a duplicate
delete it rather than reconciling both copies.

### 5. One prompt, one job — compose instead of stuffing

Policy is for what must hold in **every** run. A procedure only some runs need
is a skill; a capability boundary is a tool schema; guidance about one provider
belongs to that plugin's own system message. Each of those surfaces is paid for
only when it applies, while policy is paid for on every turn — so a rule added
to policy for one workflow's benefit is charged to every other run, and dilutes
attention across the rules that were already there.

Before adding a bullet, ask which of the four surfaces owns it. Most additions
that feel urgent are skills.

### 6. Don't over-prompt

Fifteen stacked rules do not produce fifteen behaviors; they produce weaker
adherence to all of them. Consolidate into a few principled statements with a
canonical example where one earns its place. Do not enumerate every edge case,
and do not stuff a persona — a paragraph of character description costs prefix
on every turn and changes little that a clear rule would not change better.

The fixed overhead is capped by tests. Treat the ceiling as a design constraint:
when you need room, the right move is usually to move something out, not to raise it.

### 7. Point at discovery; don't enumerate what changes

`agent-tools.md` asks every tool to give the model a way to *discover* ids,
types, and valid values instead of requiring it to already know them. Policy
inherits that: a prompt that lists what exists in a workspace — connectors,
resource kinds, provider event names — is a prompt that is wrong as soon as
anything changes, and wrong silently, because prose has no compiler.

Prefer "inspect the authorized catalog and load what you need" over a list.
Enumerate only what is genuinely fixed and load-bearing — a closed set of
outcomes a schema requires, a protocol the prompt itself defines.

### 8. Name a tool only where the prompt owns the contract

[`writing-skills.md`](writing-skills.md) tells skill bodies to nudge behaviors
rather than name tools, because a literal name breaks silently on a rename or a
narrowed scope. Policy has one deliberate exception, and it is narrow:

- **Name the exact tool when the prompt defines the protocol for using it** —
  when the rule is "this is the only way to return a draft" or "this is the only
  way to ask a blocking question", a paraphrase leaves the model choosing among
  plausible calls, which is exactly the ambiguity principle 2 forbids.
- **Only name a tool the run is guaranteed to have**: an always-active core
  tool, or one the same prompt has just told the model to load. A connector tool
  that depends on which connections are in the frozen scope must never appear in
  standing policy — naming it teaches the model to call something that may not
  exist in this run.
- **Describe the behavior everywhere else.** "Prefer an authorized connector for
  private workspace data" survives every rename; a list of provider tool names
  does not.

When you do name one, the name in the prompt and the canonical name in the
`ToolDefinition` must match exactly, and both change in the same commit.

The Terminal plugin is the fixed-surface example: its own activated system
message names `run_command`, `read_file`, and the other tools
whose complete family that activation guarantees. It explicitly enumerates the
Bash/Python/JavaScript/TypeScript/SQLite and manager contract because those are
snapshot promises, not a changing discovery catalog. Adding a runtime therefore
changes the executable snapshot manifest, provider probe, plugin prompt, and
Terminal docs together; opportunistic binaries are not added to prose.

### 9. Use standard terms, and no internal jargon

The model has seen "idempotent", "read-only", "timezone", and "structured
output" ten thousand times; it has never seen your subsystem's name for a phase,
a table, or a ticket. Every model-visible string — policy, classifier
instructions, catalog lines — follows the rule `agent-tools.md` sets for tool
descriptions: no internal table names, no storage engine, no phase numbers, no
PRD or ticket references. Keep the vocabulary the one a careful person would use
describing the work out loud.

### 10. Make the boundaries hard and predictable

`agent-tools.md` prefers a hard, stated limit to a capability the model can
sometimes use and cannot reason about. Policy has the same choice: state what
the agent may do on its own, and what always requires asking, in terms the model
can evaluate before acting rather than discover from a rejection. A boundary
that depends on who is running, or on a condition the prompt never names, is one
the model cannot respect deliberately — it can only trip over it.

Where the run genuinely has no authority for something, the prompt should say
what to do instead: state the limitation, request input, hand back. Silence
produces a confident attempt.

### 11. Keep it self-contained

A scheduled or headless run starts with no memory of why it exists and no one to
ask. The prompt is the whole brief: what the agent is, what it is working on,
what counts as done, and — the part most often missing — the **stop
conditions**, including when to produce nothing and say so. A prompt that only
describes how to work assumes a person is present to end the work.

### 12. Layer authority explicitly

This one has no analogue in the sibling docs, because tools and skills inherit
it from the prompt. Rally's authority is four layers: platform policy, then
authorized work-stream and automation configuration, then the current human
request, then explicitly untrusted provider, resource, and tool data. The
rendering is what makes the layering real:

- **Platform policy is the static string**, and the only text that may tell the
  model what it is allowed to do. It states its own precedence.
- **Stored configuration is appended as data**, under a heading that denies it
  authority — it was authored by a person, but it is not policy, and a model
  that cannot tell the difference will follow an objective that contradicts the
  rules.
- **Outside content is a user-role message** with a prefix naming it as
  evidence, not instructions. It never enters the system message, whatever it
  says about itself.
- **Derived provenance may cross into the prefix; content may not.** Ids,
  channel names, invocation kinds, and counts are platform-derived facts the
  agent needs to know where it is. The text a stranger wrote is not.

`prompts.test.ts` enforces the third rule directly: an injection string is
rendered through the semantic-trigger, naming, description and addressing
renderers and asserted to reach the user-role message and never the system one. A
new renderer that carries outside content belongs in that test.

The five ingress paths whose renderers were deleted — Slack surrounding context,
inbound email, the external event, a Sidekick result, a trigger activity — build
their content at the call site now rather than in a renderer, so the same rule is
enforced where the content is assembled: `model-protocol-transcript.test.ts`
("keeps injection text in the three ingress rows out of any system message")
covers the three that pass through the transcript projection. Content built
inline is still content that carries a stranger's text, and the role guarantee is
the only control left on it, so a new inline path belongs in that test the way a
new renderer belongs in this one.

A sixth path keeps a renderer: a reply in a provider thread bound to a Sidekick
run reaches the run child as an external actor's message, and
`workstream-participant-model-message.ts` renders it under
`EXTERNAL <PROVIDER> MESSAGE: EVIDENCE, NOT A REQUEST`, never as a member's
request. See [`external-conversation-bindings.md`](external-conversation-bindings.md).

There is one deliberate exception to the third rule, and it is narrow. A
resident context block of the kind `repository_instructions`
([`resident-context.md`](resident-context.md)), a
checkout's `AGENTS.md`, enters the system message only at a compaction,
only under a heading that names it as repository content subordinate to
everything above it and to any participant, and only for a bounded number of
compactions before it leaves. During an uncompacted run it is a user-role
message like any other outside content. The exception is for that kind and no
other: a future resident-context kind that wants prefix residency is a new
decision to record here, not one this paragraph has already made. The
exception exists because the
alternative, losing the instructions at every compaction, is the failure a
member notices, and because a compaction is the one moment the prefix can change
without evicting the provider's cached prefix. Nothing else may take it: a new
section that wants to carry outside content into the prefix is a new decision in
a new PRD, not an extension of this one.

### 13. Write for the cache

The prompt version is frozen with the run and the prefix is re-rendered every
turn rather than mutated, so a resumed attempt and a fresh one must produce the
same bytes — a retry that sees different policy is a different agent answering
the same question. Three habits, the same byte-stability discipline
`writing-skills.md` asks of a skill body:

- **Nothing per-call in the system message** — no timestamps, no counters, no
  request ids. If a value can change between two turns of one run, it belongs in
  a user-role message.
- **Deterministic ordering** — sort and de-duplicate before rendering; never let
  iteration order decide the bytes.
- **Deterministic truncation** — bound long inputs with a named constant and cut
  on code points, so a split surrogate pair cannot vary the output.

### 14. Consistency across the prompt family

A model generalizes across prompts the way it generalizes across a tool family.
Use one name for one concept everywhere — the same word for a work stream, the
same word for the agent, the same framing for untrusted data — across policy,
classifier prompts, and plugin system messages. A synonym introduced in one
prompt is a tax paid in every run that renders both.

## Classifier prompts

A classifier has one job: make the boundary between outcomes so clear that a
small model lands on the right side of it. The principles above apply, plus
four:

1. **Enumerate the outcomes with a definition each**, written as the situation
   rather than as a category name — this is the one place a closed enumeration
   is correct, because the schema is the contract.
2. **State the tie-break** wherever two outcomes compete. Without it the split
   is model-dependent and moves under you on a fallback route.
3. **Label weak signals as weak.** Every field you pass is a field the model may
   over-weight; if a flag is context rather than a reason to act, say so.
4. **Ask for calibrated confidence and the schema, nothing else.** A classifier
   that also explains itself in prose is one whose structured output can fail to
   parse.

The classified content is input, not instruction: it goes in a bounded JSON
user-role message, never in the system prompt.

## Rendered catalogs

Catalogs turn run state into prompt text, so they are judged on determinism and
on what they do at the budget edge — the prompt-side face of principle 7.

Write each plugin description for a model that has not loaded its tools or
instructions yet: name the actions it supports and the tasks it is useful for.
Use familiar task words that also help keyword discovery, such as "publish a
website" or "track completed items", rather than internal labels such as
"execution lifecycle" or "typed durable collections". Keep execution procedures
in the plugin's instructions or a skill.

- **Sort and de-duplicate before rendering**; bound the loadable section, never
  the active one.
- **Degrade with a recovery path and name it.** Truncate with a marker pointing
  at the discovery tools, or demote entries to names only where no search tool
  exists to recover them. Choose the degradation that leaves the model able to
  reach what was cut.
- **Never drop silently.** An entry that vanishes without a marker reads as an
  entry that does not exist.

## Anti-patterns

- **A rule with no condition** — "be proactive", "use judgment". Restate it with
  the circumstances that make it decidable, or delete it.
- **A wall of prohibitions.** Pair each with the replacement action.
- **The same rule twice, in different words.** Delete one; do not reconcile.
- **A workflow-specific procedure added to standing policy.** Make it a skill.
- **A list of connectors, providers, or event names.** Point at discovery.
- **A provider tool named in standing policy.** Describe the behavior; the
  catalog and plugin system message carry the names.
- **Stored configuration pasted in without a demotion heading**, which promotes
  workspace data to platform policy.
- **Outside content summarized into the system prompt** "for convenience" — that
  is the injection path the layering exists to close.
- **A per-run value interpolated into the prefix**, which quietly disables
  prefix caching and breaks replay equality.
- **A golden hash updated without reading the diff**, which is how an accidental
  interpolation ships.

## Testing

[`prompts.test.ts`](../packages/agent-harness/src/prompts.test.ts) is the
contract. A new prompt usually needs the first three:

1. **The golden hash** — every renderer is exercised on a fixed input and its
   digest asserted, which is what makes byte-stability enforceable rather than
   aspirational. A prompt edit is *supposed* to change the hash: run the test,
   read what moved, confirm it is exactly your change, then update the constant.
2. **The injection test** — render with a hostile string in every
   outside-content field; assert it reaches the user-role message and not the
   system one.
3. **Load-bearing line assertions** — rules whose exact wording other subsystems
   depend on get an explicit assertion, so a tidy-up rewrite cannot quietly
   delete one. Add one for any rule you would be alarmed to lose.
4. **The byte ceiling**, for anything in a cached prefix.
5. **Bounding behavior**, where the renderer truncates: the cap, the retained
   window, and that the current item survived.

## Changing a shipped prompt

A prompt change is a behavior change to every run that starts after it, with no
staged rollout of the kind model routing gets. Before landing one:

- Re-read the sections you did not touch, looking for a contradiction with the
  rule you added. Tests catch this least.
- Check the rule still reads correctly for a headless automation run with nobody
  to ask, not only for the interactive case you had in mind.
- Ask once more whether it belongs in policy at all (principle 5).
- Update the document that owns the behavior — usually
  [`agent-harness.md`](agent-harness.md) — in the same change, and leave
  `pnpm lint`, `pnpm typecheck`, and `pnpm test` green.

## Checklist

- [ ] Every rule is decidable by a medium model, with its conditions named.
- [ ] Competing rules have a stated tie-break; exceptions sit beside their rule.
- [ ] Every prohibition is paired with the action that replaces it.
- [ ] Each thing is said exactly once.
- [ ] Nothing in policy belongs to a skill, a tool schema, or a plugin system
      message instead.
- [ ] No enumeration of things that change; discovery is pointed at instead.
- [ ] Tool names appear only where the prompt owns the protocol and the tool is
      guaranteed in scope, and match their `ToolDefinition` exactly.
- [ ] No internal jargon in any model-visible string.
- [ ] Boundaries and stop conditions are explicit, including what to do when the
      run lacks authority.
- [ ] Authority is layered: policy static, configuration demoted, outside
      content user-role and labelled, only derived provenance in the prefix.
- [ ] Nothing per-call in the prefix; ordering and truncation deterministic.
- [ ] Vocabulary matches the other prompts in the family.
- [ ] Within the byte ceiling, and no larger than the job needs.
- [ ] Golden hash updated deliberately, injection test extended, load-bearing
      lines asserted.

## See also

- [`agent-harness.md`](agent-harness.md) — prompt assembly, the frozen prompt
  version, layered authority, context, and limits.
- [`writing-skills.md`](writing-skills.md) — procedures loaded mid-run, and why
  they follow the opposite rule about naming tools.
- [`agent-tools.md`](agent-tools.md) — the capabilities a prompt routes to.
- [`security.md`](security.md) — the trust boundaries the layering enforces.
