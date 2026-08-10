# Creating agent tools

How to design the tools an Avalon agent calls, so they are usable, safe, and
hard to misuse. The mechanics of registering a plugin, narrowing it to a
connection's frozen grants, and recording receipts live in
[`AGENT_HARNESS.md`](AGENT_HARNESS.md); the connector manifests those tools hang
off live in [`CONNECTORS.md`](CONNECTORS.md). This document is about *design* —
the decisions that make a tool work well for the model calling it. Its skill
analogue is [`writing-skills.md`](writing-skills.md).

## The design target: works down to a small model

**Design every tool — its name, parameters, response, and behavior — so a small
open model can use it correctly on the first try, not just the strongest model
in the routing stage.** Frontier models paper over bad tool design with sheer
reasoning; smaller ones do not. They follow the schema and the names literally,
rarely re-read a long system message, seldom recover from a vague error, and do
not infer hidden conventions. Avalon makes this concrete rather than
hypothetical: model routing is a flag with configured fallback stages
([`FEATURE_FLAGS.md`](FEATURE_FLAGS.md)), classifier and structured-output work
already runs on a small model, and a failure that only shows up after a fallback
is a failure in production.

Hold each tool to four tests:

- Could the model use this **from the schema alone**, without the plugin's
  system message?
- If the model does the **obvious wrong thing**, does it fail **loudly** and
  **recoverably**, or silently do the wrong thing?
- Does every name match what the model already learned in pretraining?
- Can the model **discover** what it needs — ids, types, valid values — with a
  tool, instead of having to already know it?

The rest of this document is the principles that fall out of those tests.

## The shape of a tool

Every tool is a `ToolDefinition`
([`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts)) paired
with an executor:

```ts
{
  name: "list_issues",                 // ^[a-z][a-z0-9_.-]*$, local to its plugin
  description: "…",                    // model-visible; carries the semantics
  inputSchema: { /* JSON Schema */ },
  capability: "github.issues.read",    // what authorization checks
  mode: "read",                        // read | write
  idempotency: "safe",                 // safe | provider_key | record_before_execute
  timeoutMs: 30_000,                   // optional per-tool ceiling
}
```

Four of those fields are policy, not documentation. `capability` is what the
frozen run scope is checked against and what a revoked grant removes; `mode`
decides whether Bind may overlap the call with other reads or must run it
sequentially; `idempotency` decides what is durably recorded before execution
and what a replay is allowed to do; `timeoutMs` bounds it inside the run's
overall limits. Getting any of them wrong is a correctness bug, not a style
issue — see [durable receipts](AGENT_HARNESS.md#durable-receipts-and-terminal-state).

Canonical names are **local to their owning plugin** and must not repeat the
plugin prefix: Bind prepends the plugin's short wire name when it renders the
model-facing name, so a tool called `github_list_issues` inside the GitHub
plugin reaches the model as `github_github_list_issues`.

## Principles

### 1. Fail loud, never silently ignore an input

Argument validation strips what it does not declare. A parameter the model
*thinks* exists but the tool does not declare is dropped silently — and if that
parameter encoded the model's intent, the tool does the opposite of what was
asked, with no error.

The canonical trap is a dry-run or override flag that exists on some tools in a
family and not others. A model that learns "`preview: true` is a dry run" will
eventually send it to the sibling that lacks it, where the key is stripped and
the write happens for real. The fix is not to special-case that tool; it is to
**not have the parameter anywhere in the family**. A capability that is silently
ignored is worse than one that does not exist.

Do instead: declare `additionalProperties: false` on the input schema so an
undeclared key is a visible rejection rather than a silent drop (the
`avalon_skills` tools in
[`skills.ts`](../packages/agent-harness/src/skills.ts) are the pattern), and
keep the parameter surface small and uniform across a family. When you must
reject input, reject it with an error, never by dropping it.

### 2. Use industry-standard names so pretraining does the work

A name the model has seen ten thousand times carries its semantics for free; a
bespoke name has to be taught in a system message, which small models under-read.
Prefer `query`, `cursor`, `limit`, `since`, `idempotencyKey` over internal
coinages. Pay the small translation cost at the boundary — map the standard name
onto whatever the internal layer calls it — to buy recognizability at the
surface the model sees.

### 3. Accept names, not just opaque ids — and resolve them server-side

Tools that demand opaque ids force the model into a lookup dance it often gets
wrong: it confidently passes the human name and then loops on errors. Let it
pass what it naturally has — a repository full name, a channel name, a column
label — and resolve it to an id inside the tool, before the typed query layer
runs, so the storage and provider layers still only ever see ids.

Two non-negotiables when you resolve names:

- **Ambiguity is an error, not a guess.** A name matching more than one entity
  is rejected with a message naming the candidates. Silently picking the first
  match writes to the wrong place, and the model has no way to notice.
- **Do not relax the strict layer to accept names.** Resolve in the tool, then
  re-validate the resolved, id-only arguments against the strict schema before
  anything executes.

### 4. Give the model a way to discover what it needs

If a tool needs ids, types, or valid values, ship something that returns them.
The run already has plugin-level discovery — `list_plugins`, `search_plugins`,
and `load_plugin` on the always-active `avalon_discovery` plugin — and the same
logic applies one level down: a `describe_*`-style read that returns a
resource's fields, types, and valid enum values in one call is a far better
instruction than "you must already know the column ids". Reserve it for shapes
the model cannot otherwise see; a discovery tool that just re-lists what the
catalog already says is spent context.

### 5. Errors are opaque only across a trust boundary, actionable everywhere else

Two different jobs:

- **Do not leak across a trust boundary.** When a lookup fails in a way that
  would disclose whether a foreign resource exists, or that another workspace's
  record is there, return one flat "not found" and log the real reason
  server-side. Never reveal the zero-versus-many distinction when the
  distinction itself is the disclosure. [`SECURITY.md`](SECURITY.md) owns which
  boundaries these are.
- **Be recoverable everywhere else.** Every other failure carries a
  fixed-vocabulary error code in `output.error` plus a `summary` that says what
  to do next — "narrow the range", "the connection is no longer authorized,
  load it again", "pass the repository as `owner/name`". The harness's own
  vocabulary is the model:
  [`skills.ts`](../packages/agent-harness/src/skills.ts) returns
  `skill_not_available`, `skill_limit_reached`, `skill_not_loaded`, and
  `resource_not_found`, each with a summary naming the fix. A small model can
  branch on a stable code and a hint; it cannot infer a recovery path from a
  500 or a vague string.

Opacity is a deliberate, scoped cost. Pay it only where disclosure is the risk.

**Classify failures honestly, because the classification drives retries.** The
host decides from a tool's result and its declared `idempotency` whether a
failure may be replayed. Return a structured failure for anything a retry cannot
fix; throw only for genuinely unexpected conditions, which are treated as
transient and may be retried. A deterministic bad-input failure that throws gets
retried pointlessly; a transient provider failure returned as a clean structured
result gets dropped when a retry would have worked.

### 6. Hard, predictable limits beat hidden privilege gates

A limit that depends on *who* the agent is means identical calls succeed or fail
with no signal the model can act on. Prefer a hard cap with a stable error and a
stated remedy. The skill loader is the in-repo example: a count cap, a body-token
budget, and a resource-read byte cap, all configurable by the host but never by
the model, each returning `skill_limit_reached` with the reason and the list of
what is already loaded. A limit the model can always predict and always recover
from is better than a capability it can sometimes use and cannot reason about.

Where truncation is kinder than refusal — a long reference read — truncate
**with a visible marker** so the boundary is legible to the model instead of
arriving later as a provider context error.

### 7. Idempotency: mirror identical retries, reject reused keys

The three `idempotency` values are a contract with the receipt layer, not
labels:

- **`safe`** — a read. A completed receipt replays without another provider
  call, and an incomplete one may simply resume.
- **`provider_key`** — the provider itself dedupes on a key the tool supplies.
  Use it when the provider offers a real idempotency key, and derive the key
  deterministically from the run and the receipt, never from a fresh random
  value.
- **`record_before_execute`** — a write with no provider-side dedupe. The
  canonical input and plan hashes are durably stored *before* execution, so a
  reused or mismatched plan, an incomplete prior write, or a timed-out record
  becomes `ambiguous_external_write` and is never blindly repeated.

That last mechanism only works if the request is **byte-stable**. Per-call
randomness in the arguments — a client-side generated id, a timestamp, a nonce —
makes every retry a *different* request, so a genuine retry cannot be recognized
as one and the write is either duplicated or refused. Generate ids on the server
side of the call, or derive them from the receipt identity. The general rule:
**per-call randomness in a request defeats idempotency; make requests
deterministic.**

### 8. Return what the model will need next

A create that returns only "ok" forces a re-read before the model can do
anything with what it just made. Return the ids, revisions, and addresses the
next step needs — and on an idempotent replay, return the **persisted** values,
not the ones the throwaway attempt computed.

When a tool creates something a person will want to open, return the canonical
absolute address alongside the id, built by the shared helper rather than
hand-assembled in the handler, so every producer stays in sync. Building it is
best-effort: if the address cannot be resolved, omit the field rather than
failing the create.

### 9. Do not leak internal jargon into anything the model sees

Tool names, descriptions, error strings, and system messages are all
model-visible. Keep implementation detail out of them: no internal table names,
no storage engine, no phase numbers, no PRD references, no ticket ids. Related:
do not expose internal structure the model should not reason about. A tool that
takes the id a person would recognize and resolves the internal layers itself is
both safer and shorter than one that makes the model navigate them.

### 10. Consistency across a tool family

A model that learns one tool in a family generalizes to the rest, so make the
family uniform: the same parameter names, the same return-shape conventions, the
same error vocabulary. One tool that calls it something else is a tax the model
pays on every call in the family. Worked examples in the `description` help too
— spelling out one concrete call for a tool with modes saves the model a round
of trial and error.

For connector tools this is enforced as well as advised: a connector's
agent-plugin descriptor must match its manifest in provider type and tool order,
and
[`agent-plugin.test.ts`](../packages/connectors/src/agent-plugin.test.ts)
fails the build when they drift. A tool that exists in one and not the other is
either an unauthorized capability or an advertised one that cannot run.

### 11. Validate the id family at the boundary, and hint the right one

Where an argument must be a specific kind of identifier, validate that at the
schema boundary rather than letting a wrong-family value produce a confusing
"not found" three layers down. Small models very commonly send the right-looking
value from the wrong family — a channel id where a user id goes, a workspace id
where a work-stream id goes.

And when you reject, **name what you expected**: "expected a work-stream id,
got a workspace id" turns a dead end into a one-step correction, where "invalid
id" leaves the model guessing. This composes with principle 3: a reference the
model can reasonably know by name should accept the name, but anywhere the value
must be a particular identifier, validate the family and hint on mismatch.

## Mechanics — where the rules are enforced

- **Authorize through the frozen run scope, never a one-off check.** A tool's
  `capability` is checked against the scope frozen at admission, and Avalon
  revalidates the principal, connection identity, grants, and health before
  every tool call and between model turns. Loading never widens the scope, and
  revocation drops the plugin mid-run. Resolve the target server-side so a
  forged id cannot reach another workspace's data.
- **Validate at the boundary.** Author the schema with zod and convert it to
  JSON Schema for `inputSchema`, as the connectors do; the harness parses
  arguments against it before the executor runs. Never cast across the boundary.
- **Choose `serial` deliberately.** Bind runs writes sequentially and may
  overlap independent reads, returning results in the model's original call
  order. Mark a read `serial` only when a later tool in the same batch depends
  on its effect — `load_skill` is serial for exactly that reason, so a
  `read_skill_resource` behind it in the same batch can see the load.
- **System messages are static, code-authored prose** on the plugin descriptor,
  and they sit in the cacheable system prefix. Keep per-call values out of them,
  and update the plugin's system message in the same change as the tool it
  describes. Never let provider content, a remote label, or a resource title
  become part of that trusted prose.
- **Update the docs in the same change.** A new or changed connector tool
  belongs in [`CONNECTORS.md`](CONNECTORS.md); a change to activation, receipts,
  or limits belongs in [`AGENT_HARNESS.md`](AGENT_HARNESS.md).

## Checklist for a new tool

1. Name and parameters use industry-standard terms and match the rest of the
   family; the canonical name does not repeat its plugin prefix.
2. No silently ignored params; `additionalProperties: false`; the surface is
   uniform across the family.
3. References accept names where a person would use a name; ambiguity is an
   error, never a guess.
4. There is a discovery path for any id, type, or enum the tool requires.
5. Errors are opaque only across a trust boundary; everywhere else a stable code
   plus an actionable `summary`.
6. Limits are hard and predictable, with no role-dependent silent behavior;
   truncation is marked.
7. `mode` and `idempotency` are correct for what the tool actually does, and the
   request is deterministic — no per-call randomness.
8. The response returns the ids and values the model's next step needs, and the
   persisted ones on replay.
9. No internal jargon in any model-visible string.
10. Strict-id params validate the family and hint the expected one on mismatch.
11. `capability` is covered by the connector manifest, the descriptor matches it
    in provider type and tool order, the plugin system message is updated, and
    `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green.

## See also

- [`AGENT_HARNESS.md`](AGENT_HARNESS.md) — plugin registration, frozen scope,
  activation, receipts, limits, and the loop the tool runs inside.
- [`CONNECTORS.md`](CONNECTORS.md) — the manifest model, capabilities, and the
  per-provider tool surfaces.
- [`writing-skills.md`](writing-skills.md) — when the right answer is a
  *procedure*, not a capability.
- [`SECURITY.md`](SECURITY.md) — trust boundaries and what is treated as
  untrusted.
