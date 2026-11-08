# Creating agent tools

How to design the tools a Rally agent calls, so they are usable, safe, and
hard to misuse. The mechanics of registering a plugin, narrowing it to a
connection's frozen grants, and recording receipts live in
[`agent-harness.md`](agent-harness.md); the connector manifests those tools hang
off live in [`connectors.md`](connectors.md). This document is about *design* —
the decisions that make a tool work well for the model calling it. Its skill
analogue is [`writing-skills.md`](writing-skills.md).

## The design target: works down to a small model

**Design every tool — its name, parameters, response, and behavior — so a small
open model can use it correctly on the first try, not just the strongest model
in the routing stage.** Frontier models paper over bad tool design with sheer
reasoning; smaller ones do not. They follow the schema and the names literally,
rarely re-read a long system message, seldom recover from a vague error, and do
not infer hidden conventions. Rally makes this concrete rather than
hypothetical: model routing is a flag with configured fallback stages
([`feature-flags.md`](feature-flags.md)), classifier and structured-output work
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
  longRunning: true,                  // optional advisory background-execution hint
}
```

Four of those fields are policy, not documentation. `capability` is what the
frozen run scope is checked against and what a revoked grant removes; `mode`
decides whether Bind may overlap the call with other reads or must run it
sequentially; `idempotency` decides what is durably recorded before execution
and what a replay is allowed to do; `timeoutMs` bounds it inside the run's
overall limits. Getting any of them wrong is a correctness bug, not a style
issue — see [durable receipts](agent-harness.md#durable-receipts-and-terminal-state).

Canonical names are **local to their owning plugin** and must not repeat the
plugin prefix: Bind prepends the plugin's short wire name when it renders the
model-facing name, so a tool called `github_list_issues` inside the GitHub
plugin reaches the model as `github_github_list_issues`.

Some plugins declare **no prefix at all**, and their canonical names reach the
model unchanged. A plugin earns that only when every one of its tool names is
**globally** unambiguous, because nothing namespaces them once the prefix is
gone. Two things make a name qualify, and either is enough:

- **The plugin is always active**, so a prefix on it distinguishes nothing — the
  model cannot load it, cannot unload it, and has no second source of the same
  capability to tell it apart from. `rally_discovery`, `rally_skills`,
  `rally_core`, `rally_workstream`, and `rally_agents` are these.
- **The canonical name is already the one the model knows.** `rally_terminal`
  and `rally_multimodal_generation` are loadable, but `read_file`, `edit_file`,
  `write_file`, `apply_patch`, `run_command`, `generate_image` and
  `generate_audio` are names a model has seen tens of thousands of times in
  pretraining, and `terminal_read_file` is not one of them. That is the third
  test at the top of this document, and the prefix was failing it.

`rally_memory` and `rally_tables` are always active and still keep
`memory_`/`table_`, because they fail the naming half: their canonical names are
local verbs (`recall`, `remember`, `forget`, `search`, `query`, `create`), and
bare verbs are the naming the rest of this document exists to prevent;
`rally_tables`' `search` also collides with `rally_web`'s. `rally_web` keeps `web_` for the opposite reason: `web_search` and
`web_fetch` *are* the pretrained names, and stripping the prefix would leave
bare `search` and `fetch`. `rally_conversations` keeps `conversation_` because
its canonical names are the local verbs `list`, `read`, `post` and `attach`;
[`conversation-tools.md`](conversation-tools.md) is its contract. `rally_sidekicks` keeps `sidekick_` because
unprefixed its `plugins_list` and `plugins_search` would sit beside
`rally_discovery`'s `list_plugins` and `search_plugins` — near-identical names
for different tools, which is worse than either prefix. Connector plugins can
never qualify: their prefix is per *connection* (`google_1`, `google_2`), and it
is the only thing telling two connections of one connector apart.

**`send_message` does not say who it acts on.** `rally_agents`' `send_message`
reaches another *agent*, not a person and not a connector, and nothing in the
bare name says so. It was unprefixed anyway, deliberately: the plugin's
instructions name the addressee in every sentence that reaches for one, and the
transcript rows say "Messaged a teammate" rather than "Sent a message". Its
sibling `reply_to_message` had the same problem as plain `reply` and was
renamed rather than re-prefixed — which is the fix available here, and the one
to reach for if `send_message` turns out to mislead a model in practice.

**Bind's duplicate-wire-name check covers less than "always active".** It
iterates Bind's own `corePlugins` — discovery, skills, and whatever the host
passes as `corePlugins`, which on the API side is `createWorkstreamCorePlugins`:
`rally_core`, `rally_tables`, `rally_memory`, and nothing else. Every other
plugin, including always-active ones like `rally_workstream` and `rally_agents`,
is assembled into `plugins` and sits outside the
guard. For those, two identical wire names resolve to whichever plugin sorts
first by canonical id, silently.

So an unprefixed plugin is a standing claim on its bare names, and for most of
them nothing at runtime defends it.
[`apps/api/test/plugin-wire-names.test.ts`](../apps/api/test/plugin-wire-names.test.ts)
is what holds that line: it builds every plugin a run can register and fails
when two unprefixed ones claim the same name. Before giving another plugin an
empty prefix, check its names there — and if you would rather have the runtime
guard, widening the check to all plugins is the change to make.

`longRunning` is optional tool-definition metadata, not an input argument.
True adds a short background-execution hint to the model-visible description
when tools are loaded and advertised; false or omission leaves it unchanged.
It does not alter routing, permissions, serialization, deadlines, or retries.
The model may call an already-asynchronous tool directly, and a background
agent may execute it without delegating again. Image generation and editing
are the initial annotated tools.

`get_connector_connection_state` and `show_connector_connection` are the
recovery pair for a run with a user principal: a Canvas's Chat, a Sidekick's
conversation, and a Sidekick run. Both accept only a trusted connector catalog
id and a `personal`/`workspace` scope. The read always checks every scope the
connector offers in one query; a `scope` it is sent is accepted and ignored, so
older calls still validate. It returns each scope's state, `connected`, `reconnect_required`, or `not_connected`,
from the caller-visible rows, plus the best of them as `state`; `connected` is
the last durable state Rally observed, not a provider health check. The presentation tool asks the main desktop feed for a
person-facing control rather than provider data. That feed resolves the card's
name, mark, copy, capability grant, displayed connection state, and OAuth
destination; none of those are model-authored. Check state before claiming a
connector is unavailable or presenting a card when the answer is not already
known. The presentation call does not establish a connection and must not be
described as one. Its validated id and scope are also the completed tool fact's
participant-safe result, so the card remains reconstructible from durable
history rather than depending on a transient started event. In a Sidekick
run the presentation tool is a question instead: it opens an elicitation
carrying the card's selection and pauses the run in `needs_input` until a person
connects it, chooses Continue, or declines
([`automation-lifecycle.md`](automation-lifecycle.md#a-run-a-missing-connection-or-grant-blocks)).

`check_resource_access` takes a connector and a resource link or id and asks
every connection of that connector in the run how far it reaches the resource,
in parallel: `edit`, `read` (with `editNeedsGrant` when Google's one-file grant
is missing), `none` with a reason code, or `unknown` with a code when the probe
itself failed. It names the first plugin that can edit and the first that can
read. It lists only connectors whose adapter implements `probeResourceAccess`;
the probe and the retry it pairs with are in
[`connectors.md`](connectors.md#2026-10-15-a-connection-that-cannot-reach-a-resource-hands-the-call-to-one-that-can).

The catalog id `google-drive` covers Google Drive, Docs and Sheets in either
scope. Saved connection cards using the retired `google-drive-workspace` id
normalize to `google-drive` when read; new tool requests use only `google-drive`.

The model-facing flow is deliberately literal:

1. Call `get_connector_connection_state` with `connectorId`.
2. If a connected scope can do the task, continue with it and do not show a
   card. A connected personal connection is enough.
3. If none can and `reconnect_required` or `not_connected` blocks the task,
   explain the blocker briefly.
4. Call `show_connector_connection` with the same `connectorId` and the scope
   the task needs. In a Canvas or a Sidekick's conversation, then stop the
   connector-dependent work for that run. In a Sidekick run the call pauses the
   run: on `continue`, check the state again and retry; on `declined`, end with
   one final message saying what is blocked. Do not claim the connection worked.
5. Never tell a person to complete a connection prompt unless the card was
   shown in that same reply, and never tell another agent a connection blocks
   it unless a tool refused for that reason. A state check is not a refusal.

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

Do instead: **make the executor parse its own arguments with a strict schema.**
`additionalProperties: false` on `inputSchema` declares a closed shape, but
Bind currently removes it from provider requests for xAI compatibility. It is
not an enforcement point — nothing in the harness validates arguments against it
(see [Mechanics](#mechanics--where-the-rules-are-enforced)). What actually
rejects an undeclared key is a `.strict()` zod parse at the top of the executor,
which is why the connector tools parse `rawArgs` per tool before doing anything
with them. Declare the JSON Schema and allowed keys in its descriptions, then
keep the strict zod parse so a violation is an error rather than a silent drop.
When testing schema/executor agreement, inspect the serialized model request:
`rawJsonSchema` still passes through Bind's sanitizer before Rally's root repair,
and testing only the authored schema misses its compatibility transformations.
The Gmail send/draft schemas additionally preserve their closed objects using
schema-valued `additionalProperties: { not: {} }` constraints; see [the Google contract](connectors.md#google). Their request tests
use Ajv to enforce schema-valued unknown-property constraints on the actual serialized requests. This is a
local compatibility representation, not permission to weaken runtime parsing or
to assume strict structured-output restrictions apply to non-strict tool calls.
The same split
governs a constraint *between* parameters: an exclusive choice belongs in the
`description` and the executor's parse, because the schema sanitizer erases the
`oneOf` idiom that looks like it would carry it (see
[Mechanics](#mechanics--where-the-rules-are-enforced)).

Then keep the parameter surface small and uniform across a family. When you must
reject input, reject it with an error, never by dropping it.

Two tolerances are shared by every tool at the harness boundary. **Neither is a
licence to drop input**, and both are stated as what the *schema already says*
rather than as a guess at intent.

The first: a field declared
exclusively as JSON Schema `number` or `integer` also accepts a string containing
one complete finite JSON number. The runtime normalizes that string before
authorization hooks, input hashing, receipt planning, or execution, so `0` and
`"0"` become the same request. Accepted spellings follow JSON number grammar —
for example `"0"`, `"-12"`, `"1.5"`, and `"6e3"`. Leading/trailing whitespace,
leading `+`, leading-zero integers such as `"01"`, hexadecimal, `NaN`,
`Infinity`, suffixes such as `"1px"`, unsafe integral values, and a fractional
value for an `integer` field remain errors. A schema that also accepts `string`
keeps the value as a string; otherwise numeric-looking ids, ZIP codes, phone
numbers, and spreadsheet cells would silently change meaning. Keep the
provider-facing schema numeric so the model still learns the preferred form,
and do not reimplement coercion inside individual tools. ESLint enforces this
boundary in production tool modules: `z.coerce.number()` and a raw
number-or-string compatibility type are rejected with instructions to keep the
field strict and rely on harness normalization. A broad multi-type domain value,
such as a spreadsheet cell that can also be boolean or null, remains valid; a
real string-or-number domain uses explicit `anyOf` branches, documents why the
types mean different things, and adds focused validation coverage.
The rule follows only expressions reachable from a tool's `inputSchema`, so a
module may still use coercion for an unrelated HTTP query or other non-tool
boundary without receiving a false positive.

The second, **on a read tool only**: an optional property given `""` is treated
as absent when that property's own schema says the empty string is not one of
its values —
`minLength` of at least 1, a `type` with no `string` in it, or an `enum`/`const`
excluding it, through `$ref`, `allOf`, and every branch of an `anyOf`/`oneOf`.
Nothing else counts: `pattern` and `format` are not consulted, an unreadable
schema keeps the value, and a **required** property keeps it too so validation
can name the field. Requiredness is resolved across the whole composed
schema — `$ref`, `allOf`, and every `anyOf`/`oneOf` branch — because a generated
schema routinely puts `required` on one node and `properties` on another, and a
key any branch requires is treated as required. If that walk cannot finish, no
blank is dropped at all. Small models blank an optional parameter rather than
omitting it, and the blank then either fails the tool's own parse or reaches the
provider — Linear answers an empty GraphQL cursor with a bare
`Argument Validation Error` naming no field, which a model cannot act on and
retries unchanged.

This is not the silent drop the principle above forbids, and two things keep it
from becoming one. The value dropped was **already declared invalid**, so there
was no intent in it the tool could have honored; a field where the empty string
*means* something — clearing a description, listing a repository's root — simply
does not declare it invalid, and is untouched. And it is confined to reads,
because a write is where a blank is genuinely ambiguous: `assigneeId: null`
clears an assignee and omitting `assigneeId` leaves it alone, so reading a blank
as either one picks an intent the model never stated and reports a partial
update as a complete one. On a read there is no such second meaning — absence is
the only alternative to a value.

So a write keeps the blank, its executor rejects it, and the model gets the
field's name, from which `null` is one correction away. That is strictly better
than the alternative *and* better than what the tool did before this rule
existed, which was to forward the blank to the provider.

What this asks of a tool is one word: **declare `minLength: 1` on every string
parameter whose empty value is not a value.** Opaque page cursors first, then
identifiers, handles, and dates. It is also the more accurate declaration on its
own terms, because a model reading `{ "type": "string", "maxLength": 500 }` has
no way to know that `""` is not among the strings that schema names. Leave it
off content — descriptions, bodies, Markdown, replacement text — where the empty
string is a real request. Deriving `inputSchema` from the zod schema with
`z.toJSONSchema` keeps the two in step for free; a hand-written JSON Schema is
where they drift, and where they drifted here.

**And `minLength: 1` is only half of it: a parameter whose value may be "none"
has to say so as a value.** A caller does not reliably answer "I have no
cursor" by leaving the key out — it answers it by putting something in the box,
and `minLength: 1` tells it the something must be at least one character. One
run spent eight `drive.search` calls on `"x"`, `" "`, `"undefined"`, `"null"`
as a string and `"/"` twice, with a description in front of it saying to omit
the key, and wrote down why: *"Schema says min but omit should maybe omit."*
Prose loses to the machine-readable half, so the schema has to admit the
answer.

The harness also supplies an unspecified value for independent, optional,
non-nullable **top-level scalar** arguments. It advertises `anyOf: [original,
{ type: "null" }]` and removes that synthetic null before validation, hashing,
receipts, or execution, for reads and writes alike. The original executor schema
remains authoritative. An existing nullable field keeps its null semantics;
required fields, nested fields, referenced properties,
and roots with composition, conditional, presence, or unknown constraints are
not adapted. The adapter does not enable strict mode or make optional keys
required. Unlike guessing what a blank means, this rule adds an explicit meaning
for a value the original scalar schema rejects. It is therefore usable on writes
without collapsing a declared clear operation into omission. Executor refinements
still enforce constraints not expressed by JSON Schema, such as requiring one of
two optional fields. Do not rely on it to repair arbitrary placeholders: commas, spaces,
and strings such as `"none"` remain literal values. Author explicit null semantics
when a tool needs both omission and clearing.

**Either spelling reaches the model as a union, and the guard covers every
parameter.** Since `@juno-ai/bind` 14 the sanitizer rewrites
`type: ["string", "null"]` to `anyOf: [{ type: "string", minLength: 1 }, { type: "null" }]`
rather than collapsing it to `type: "string"` with "Accepts string or null."
appended to the description, which is what Bind 13 did, and which left the
null branch alive only as prose, the same two-halves-disagreeing shape the rule
above exists to remove. `anyOf` stays the house spelling for a cursor because it
says what it means without depending on a dependency's transform, and
`droppedNullableBranches` still reports a declaration whose authored null does
not reach the wire. Bind 14 rewrites a nullable *single* type only, and five
shapes keep the collapse. This is the one list; the other documents and the
source comments point here rather than restating it:

- a multi-type union such as `["string", "number", "null"]`, collapsed to its
  first non-null member because no union of scalar branches has been measured
  on every provider;
- a nullable type at the parameters root, which every provider requires to be
  an object;
- a nullable type in a branch of a root `anyOf`/`oneOf`, where a branch
  carrying its own union is what xAI rejects;
- a nullable type in a composition branch whose `required` reaches the
  enclosing node's `properties`, because the rewrite would put that name two
  levels from the scope that declares it;
- a nullable type whose sibling `enum` or `const` excludes `null`, because
  those keywords are AND-ed with `type` and the node never admitted the value.

`apps/api/test/tool-schema-sanitization.test.ts` asserts that over every
declaration of every authored tool, nested ones included, not only the cursors,
so a tool added next year is enrolled by existing; what still has to be
remembered is a cursor named something outside `CURSOR_PARAMETERS`, which the
cursor-contract sweep will not find.

If using zod for parsing do not just return the zod error object. Provide natural
language errors and more importantly provide instructions on how to fix the error.
For example a file might have changed and so the model needs to re-read it. Or the
wrong type of id was provided and the model needs to provide a different type of id.

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
and `load_plugin` on the always-active `rally_discovery` plugin — and the same
logic applies one level down: a `describe_*`-style read that returns a
resource's fields, types, and valid enum values in one call is a far better
instruction than "you must already know the column ids". Reserve it for shapes
the model cannot otherwise see; a discovery tool that just re-lists what the
catalog already says is spent context.

`search_plugins` is ranked keyword discovery, not a literal phrase filter. It
normalizes case, punctuation, and whitespace, then ranks exact field matches
ahead of distinct-token overlap across the plugin id, display name, aliases,
and description. Any meaningful token may make a plugin eligible, results are
bounded to twenty, and `totalMatches` makes truncation visible so the model can
narrow the query; ties are deterministic. That OR boundary is deliberate:
a request such as `public web social timeline` spans the Web and X vocabularies
and must discover both rather than require one catalog field to contain the
entire sentence. A normalized-empty query returns no results, while a meaningful
one-character name such as `X` remains searchable.

### 5. Errors are opaque only across a trust boundary, actionable everywhere else

Two different jobs:

- **Do not leak across a trust boundary.** When a lookup fails in a way that
  would disclose whether a foreign resource exists, or that another workspace's
  record is there, return one flat "not found" and log the real reason
  server-side. Never reveal the zero-versus-many distinction when the
  distinction itself is the disclosure. [`security.md`](security.md) owns which
  boundaries these are.
- **Be recoverable everywhere else.** Every other failure carries a
  fixed-vocabulary error code and a model-visible `error` sentence containing
  the shortest safe next action — “narrow the range”, “reconnect before trying
  again”, “pass the repository as `owner/name`”. Put contextual remediation in
  the structured failure `data` as well. A small model can branch on a stable
  code and follow a direct instruction; it cannot infer a recovery path from a
  500, “stale revision”, or a vague noun phrase.
- **A refusal echoes the value it refused and names the accepted form.** The
  two retry loops this repository has recorded — a blank pagination cursor,
  and a Terminal path naming the workspace root — both came from refusals that
  named neither, so the model read the message as confirmation of what it had
  already done and sent the same value again. Bound the echo by the
  parameter's own schema limit and pass it through whatever sanitizer the
  tool's other output gets.

  **`summary` is not model-visible.** A successful tool message serializes
  `output`; a typed failure serializes its model-visible `error` sentence plus
  structured `data`. `summary` travels only on the host's `tool_completed` event
  and drives human-facing display. So a remediation that lives only in
  `summary` reaches the person watching and never the model that has to recover.
  Put successful recovery values in `output`, failure context in `data.details`,
  and the shortest safe action in the failed result's `error` sentence.

  The shared typed-failure allowlist is `reason`, `field`, `expected`,
  `available`, `resourceId`, `reconnectRequired`, `retryAfterMs`, `actualMimeType`,
  `attachmentKind`, `suggestedCall`, and a validated `resourceAuthorization`
  recovery hint. Use only the subset the tool needs;
  `reason` is the general bounded next-step field, while the last three exist for
  attachment recovery. An adapter-only `hint`, path, or provider-detail field is
  silently stripped unless contracts, runtime, and tests add it to that shared
  allowlist. The skill loader applies the same rule to
  `skill_not_available`, `skill_limit_reached`, `skill_not_loaded`, and missing
  bundled resources: each throws a typed failure whose message says what to
  call next and whose allowlisted details contain bounded recovery values.
  Returning `{output: {error: ...}}` from an executor is not an alternate
  failure path. Bind correctly records any returned `HarnessToolResult` as
  completed and projects it as `{success: true}`; using that shape for a refusal
  creates a dishonest durable receipt, model result, audit event, and activity
  row.

Opacity is a deliberate, scoped cost. Pay it only where disclosure is the risk.

**Classify failures honestly, because the classification drives retries.** The
host decides from the failure and declared `idempotency` whether replay is safe.
Use the harness's structured failure path for anything a retry cannot fix: in
the current Bind adapter that means a typed error with a stable `code` and only
allowlisted `details`, which Bind projects into `{success: false}`. Reserve a
bare, unclassified throw for genuinely unexpected conditions. A deterministic
bad-input failure thrown as a generic `Error` loses both classification and
remediation; a transient provider failure mislabeled as definitive gets dropped
when a retry would have worked.

When an executor throws a Zod error, the harness compares its normalized input
with the same JSON Schema advertised to the model. If that input is invalid, it
condenses the closest union branch, caps it, and returns `kind: "validation"`
with field paths and an instruction to retry. A code-authored refinement that
JSON Schema cannot represent must also be exposed through the `HarnessTool`
`validateInput` hook; connector adapters provide the equivalent
`validateToolInput` hook. That keeps messages such as “choose at least one field
to update” model-actionable. If both declared and refined input are valid, the
Zod failure came from downstream data. A read or provider-idempotent call may
invite one retry, but a `record_before_execute` write becomes
`ambiguous_external_write` and **stops the run**: the provider mutation may
already have succeeded, so retry guidance could duplicate it. That is this
path — a validation failure inside an active turn. Crash repair of an
interrupted batch is the one that continues instead, handing the model a failed
tool result that names the call and says to check before repeating; the two are
not the same path and only the second one keeps the run alive. Do not catch and stringify
either Zod error inside the tool, which would restore the raw issue tree and
defeat that distinction.

### 6. Hard, predictable limits beat hidden privilege gates

A limit that depends on *who* the agent is means identical calls succeed or fail
with no signal the model can act on. Prefer a hard cap with a stable error and a
stated remedy. The skill loader is the in-repo example: a count cap, a body-token
budget, and a resource-read byte cap, all configurable by the host but never by
the model, each returning `skill_limit_reached` with the reason. The active
skill catalog already names what remains usable; refusal metadata never calls
those loaded skills `available`. A limit the model can always predict and always
recover from is better than a capability it can sometimes use and cannot reason about.

Where truncation is kinder than refusal — a long reference read — truncate
**with a visible marker** so the boundary is legible to the model instead of
arriving later as a provider context error. `truncateTextWithMarker` in
`@rally/connectors` is that marker, and it spends itself from the budget rather
than adding to it: a bound that reports 12,000 characters and delivers 12,064 is
not a bound. A bare `truncateText(value, max).text` throws away the flag beside
it, which is how an adapter ships a cut nobody downstream can see.

### 7. Idempotency: mirror identical retries, reject reused keys

The three `idempotency` values are a contract with the receipt layer, not
labels:

- **`safe`** — a read. A completed receipt replays without another provider
  call, and an incomplete one may simply resume.
- **`provider_key`** — the provider itself dedupes on a key the tool supplies.
  Use it when the provider offers a real idempotency key, and derive the key
  deterministically from the run and the receipt, never from a fresh random
  value. An incomplete prior call whose plan, request hash and key all match may
  therefore *resume*, because the provider collapses the two; a call arriving
  with a different key does not, and is ambiguous.

  **That resume is load-bearing, not incidental.** `admit` grants it on the
  declared class alone, so a `provider_key` tool owes a key-scoped replay lookup
  as its first act — `memory_fact_receipts` behind `rememberMemoryFact` and
  `loadMutationReceipt` in `memory-table-service.ts` are the shape. Every
  `provider_key` write in this tree has one, and a new one without it would be
  re-executed rather than deduped.
- **`record_before_execute`** — a write with no provider-side dedupe. The
  canonical input and plan hashes are durably stored *before* execution, so a
  reused or mismatched plan, an incomplete prior write, or a timed-out record
  becomes `ambiguous_external_write` and is never blindly repeated.

Two further properties are separate from all three, and are about the *executor*
rather than the provider. Both are host-authored and deliberately absent from
`ToolDefinition`: that schema also parses tool declarations from remote MCP
servers, and a server able to assert either would be asserting that Rally may
repeat its writes.

**`HarnessTool.reenterable`** says the host may run this tool again over the
receipt an interrupted attempt already started, instead of reporting
`ambiguous_external_write`. Declare it only when the executor's first act is to
resolve what that `effectIntentId` already did — reattach to the provider task
it names, or find and return the record its stable identity already holds.

**`HarnessTool.reconcileEffect`** is what a tool declares when it cannot do
that. An executor that resolves its effect by *subject* — the document at this
path, the row with this name — answers "what is there now", which is a different
question from "did my attempt put it there", and re-entering it blind performs
the write again whenever the two differ. A reconciler answers the second
question without performing anything: `landed` returns the result and the
executor is never reached, `not_landed` is the only licence to run it, and
`unknown` leaves the attempt ambiguous. Prefer a durable record that names the
*writer* — an append-only version or audit row carrying the run that wrote it —
over comparing content, because content cannot distinguish your write from
somebody else's.

A tool that would simply perform the write a second time, and has no reconciler,
declares neither, whatever its idempotency class says.

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

**A list returns a declared row, never the provider's object.** Name the fields
one row carries, in a `FieldProjection` beside the tool, and apply it with
`projectFields` from `@rally/connectors` before anything else touches the value.
A provider's object is not a row: GitHub's pull request embeds `head.repo` and
`base.repo`, two complete repository records with about thirty URL templates
each, and its workflow run embeds `repository` and `head_repository` the same
way. Measured on a real substream, that was 24.5 KB per pull request and 21.3 KB
per workflow run against roughly 400 bytes of answer, and five list calls
accounted for 5.1 MB of 5.2 MB of model-facing payload.

Note what did *not* prevent it. Every count-based bound was inside its limit
throughout — `perPage` at 30 of 100, no string near its character clamp, no
array near a hundred entries, nothing eight levels deep. **A row is wide, not
long, and no cap on length fixes a width problem.** Lowering the page size is
the intuitive fix and it makes things worse: it does not change the bytes per
useful fact, it just buys the same waste in more round trips.

Four rules decide what a row holds:

- **Whatever another tool documents as copied from this one stays.** A
  projection that drops an id does not save bytes, it breaks the tool that was
  documented to take it.
- **A field with no other read path stays, however wide it is.** Width is a
  reason to bound a field, never on its own a reason to drop it. `output.text`
  on a check run is the widest field in the GitHub surface and is also the only
  place this plugin can read *why* a check failed — no check-run get, no
  annotations tool, no job-log tool — so dropping it would have taken a
  capability with it. Search for the read path before deciding a field is
  recoverable elsewhere.
- **A field the provider sent as `null` stays `null`, at any depth**, because
  `merged_at: null` is the answer to "was it merged". A field the provider never
  sent stays absent, because a synthesized `null` claims it answered a question
  nobody asked it — and so does an empty container standing where a field was
  asked for, so `projectFields` attaches a nested object only once something
  declared was found beneath it. A present but empty array is kept, because
  "there are none" is a complete answer.
- **Provider fields keep the provider's spelling.** A model that learned an API
  in pretraining reaches for `html_url` and `head.ref` (rule 2 above); only the
  envelope around the rows is ours to name.
- **The list says what its row holds, and names the tool that returns the
  rest.** A model cannot see an absent field, and will read one as empty. This
  is the sentence that keeps a summary from being mistaken for the whole record.

**A `get` is a declared record too, and a write echo is a `get`.** The
temptation is to leave single reads as pass-through on the grounds that one
deliberate object per call is affordable. It holds for exactly one call. A run
that lists thirty pull requests and then opens six of them pays most of the
saving back, because the `get` carries the same embedded records the list row
was just taught to drop. Declare the record as the list row *plus* what the read
was for — the body, and the state a caller opened it to see — so the two stay in
step and a field that earned its place on the list keeps it. A create or update
that returns the object it wrote is the same boundary and takes the same
declaration.

Do not add a `fields` parameter so the model can ask for more. It is one more
optional parameter beside the others, and [rule 13](#13-every-parameter-says-what-it-is-for-and-what-leaving-it-out-does)
records what a parameter a model does not understand costs. If a row is missing
something, add it to the row for everyone, or point the model at the `get`.

The projection is not a limit in the sense of
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md):
it is a design decision about what the tool is for, cheap to reverse, and its
failure is visible in the next call. The clamps behind it — the character,
array, and depth bounds an adapter already applies — stay where they are, doing
the job they are good at, which is bounding one declared field that is
legitimately enormous.

### 9. Make compare-and-swap tokens copyable and sequenceable

An `expectedRevision` guard is usable only when the model can tell where the
value comes from and what to do after either outcome. Treat the read and write
tools as one protocol:

- the producer returns `revision`, and the consumer accepts the same type as
  `expectedRevision`; the input property's description names the producing
  tool and tells the model to copy the value exactly;
- when create and replace share a tool, the create-only sentinel is explicit in
  the schema description and a worked example — never make the model guess
  whether omission, `null`, `0`, or an empty string means create;
- every successful mutation returns its resulting `revision`, so a second
  mutation can use that value without an unnecessary read when the model already
  knows the resulting state;
- a revision conflict returns a stable code and tells the model to read the
  current state and rebuild the mutation in the model-visible `error` itself,
  with path-specific context in allowlisted details. Do **not** return a fresh
  revision as a shortcut: a model will often retry with that token without
  observing the state it is about to overwrite, reducing compare-and-swap to a
  box-checking exercise; and
- a bulk mutation makes the path-to-revision relationship explicit and rejects
  the whole operation on one conflict. Its error identifies the conflicting
  paths without supplying replacement tokens.

For Rally-authored tools, use the first/next primitive in
[`tool-pagination.md`](tool-pagination.md), not a model-facing opaque cursor.
The first tool takes filters; its companion takes only a copied `pageId`, with
an exact plugin prefix and four lowercase words. Describe the producer field,
null/end signal, and fully qualified wire tool name in recovery text. Filters
remain server-owned. Provider tokens must be extracted at explicit authored
slots before content bounding; MCP/pass-through contracts are not rewritten.

The following cursor guidance applies to internal adapter contracts and
provider-defined pass-through schemas, not to the authored model-facing surface.
A pagination cursor is the same protocol with one tool on both ends, and it
fails the same way when the description is left off. A model that has not paged
yet holds no cursor, so an undescribed `pageToken`, `after`, `cursor`, or
`startCursor` reads as a field to fill in, gets filled with something invented,
and the provider rejects the whole call. Four things belong in that description
and none can be inferred from the parameter's name and bounds: which field of
this tool's own result produces the value, that it is opaque and must never be
constructed, guessed, shortened or incremented, that the rest of the call is
held unchanged when it is passed, and what the last page looks like. All four
are answerable for every cursor Rally serves. If a provider's pagination shape
looks unestablished, that is a reason to go and establish it rather than an
exception: the one parameter that seemed to qualify turned out to have its shape
pinned by its own adapter's tests, and shipping without it would have left that
caller the only one able to page forever. That third
one is not pedantry: a cursor is a position within the query it was issued for,
so pairing one with changed filters is not a defined continuation of either.
Google is the measured case, and it resumes the old search rather than running
the new one, which reaches the caller as a wrong answer instead of an error.

The description is half of it. Say what to send when there is no cursor, and say
it in the spelling Principle 1 prefers, `anyOf` with a `null` branch. Both
spellings reach the model as a union since Bind 14; `anyOf` is kept because it
says what it means without depending on the sanitizer's transform, and a
reader of the declaration sees the value the prose recommends. Two walks in
`tool-argument-empty-strings.test.ts` and `tool-schema-sanitization.test.ts`
hold the two halves across every registered connector.

Also identify mutation paths that do not participate in the protocol. If a
general shell can write the same files, say so and serialize it with typed
mutations; do not claim that `expectedRevision` protects writes that bypass the
guard. A short read → mutate → continue example belongs in the tool description
when the sequence is not obvious from standard API conventions.

### 10. Do not leak internal jargon into anything the model sees

Tool names, descriptions, error strings, and system messages are all
model-visible. Keep implementation detail out of them: no internal table names,
no storage engine, no phase numbers, no PRD references, no ticket ids. Related:
do not expose internal structure the model should not reason about. A tool that
takes the id a person would recognize and resolves the internal layers itself is
both safer and shorter than one that makes the model navigate them.

### 11. Consistency across a tool family

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

### 12. Validate the id family at the boundary, and hint the right one

Where an argument must be a specific kind of identifier, validate that at the
schema boundary rather than letting a wrong-family value produce a confusing
"not found" three layers down. Small models very commonly send the right-looking
value from the wrong family — a channel id where a user id goes, a workspace id
where a conversation (`WorkstreamId`) id goes.

And when you reject, **name what you expected**: "expected a conversation id,
got a workspace id" turns a dead end into a one-step correction, where "invalid
id" leaves the model guessing. This composes with principle 3: a reference the
model can reasonably know by name should accept the name, but anywhere the value
must be a particular identifier, validate the family and hint on mismatch.

### 13. Every parameter says what it is for, and what leaving it out does

A parameter reaches the model as its name, its type, its bounds, and nothing
else. That is not enough to use one, and the gap is invisible from inside the
repository, where the name is obvious because you know the API behind it.
GitHub's `pull_requests.list` takes a `head`, which is neither the head commit
nor a branch: it is the filter expression `owner:branch`, and GitHub answers
anything else with HTTP 200 and an empty list rather than an error. Undescribed
beside eight other parameters, it read as a field to fill in. A run asked for a
repository's open pull requests filled it in with a branch name, got `[]` twice
for a repository holding twenty-five of them, reported the repository as having
none, and went to the terminal for a credential to ask `git` directly.

So every parameter carries a `description`, and four things belong in an
optional one, none of which is inferable from a name and a `maxLength`:

- **what it selects**, in the provider's own spelling, with a worked value —
  ``written as `owner:branch`, such as `octocat:my-feature` ``;
- **what omitting it does**, said as the normal case when it is one: listing a
  repository's open pull requests means sending no filter at all;
- **what a wrong value does**, whenever wrong is silent — "a branch with no open
  pull request returns an empty list rather than an error" is the sentence that
  ends the failure above at the first call; and
- **which tool produces the value**, when another tool does. This is the cursor
  rule in principle 9, generalized: a cursor is the case where guessing is
  always wrong, not the only case where it is silent.

**Convert the schema in input mode.** `z.toJSONSchema(schema)` defaults to
`io: "output"`, which describes what a *parse returns* — so every `.default()`
field is listed as `required`, because the parsed value always has one. A tool
schema describes what a caller may *send*, which is `io: "input"`. The same
`pull_requests.list` was demanding `state`, `sort`, `direction`, `perPage`, and
`page`, five values the executor would have supplied itself; a schema insisting
on five parameters it does not need reads as an instruction to populate the
block, which is how the two undescribed filters beside them came to be
populated too. `z.strictObject` still emits `additionalProperties: false` in
either mode, so nothing is given up. `defaultedRequiredParameters` holds this at
zero across every authored tool.

**A silent narrowing is answered in the result, not only in the description.**
Where a filter can empty a list without erroring, the result says which filters
were applied, so an empty page can be told apart from an empty repository. See
principle 8 and the GitHub list envelope in
[`connectors.md`](connectors.md#github-app).

`apps/api/test/tool-schema-descriptions.test.ts` walks every authored tool for
both halves. Descriptions are asserted per surface, exactly, rather than at
zero: GitHub, Terminal, and X are complete and can never regress, and the eleven
surfaces still owed prose can only pay it down. Lower a number when you
describe a parameter; never raise one. A conditional surface — one whose plugin
is not built without credentials — is only in that walk if the walk supplies
them, so give it a sentinel in `EXPECTED_TOOLS` too.

## Sidekick delegation tools

The existing `rally:sidekicks` plugin offers `sidekick_my_delegations_list`,
`sidekick_delegates_list` and `sidekick_set_delegation` in direct and autonomous work.
Authoring's `sidekick` prefix and the room recommendation presentation's full
canonical names produce the same wire names. The two presentations retain their
existing discovery and recommendation tools. UUIDs, canonical Rally links and
exact visible names resolve through viewer authority, not editing authority.

Inputs and model-visible outputs are strict shared schemas in
`packages/contracts/src/sidekick-delegation.ts`. Mutation accepts the target
Organization userId; the execution actor and grant generation remain host-owned.
The actor needs Sidekick access to change another user, who must have active
Organization membership. Self-service UI has no manager removal action. Own lists stay within the current Organization and include safe stored labels
after access loss; withdrawal needs no viewer-only discovery. Completed mutation acknowledgements
are checked against the original consent receipt and current generation before
replay. A stale replay reports the recovery sentence without invoking the
mutation again; immutable historical completion remains intact. Lists return complete arrays
and no page cursor. The runtime currently has no tool-result byte cap; no new
numeric limit is added. [Sidekick lifecycle](automation-lifecycle.md#delegation-consent-authority)
owns consent ordering and recovery; [the design contract](PRDs/2026-10-22_sidekick-delegation/design.md#agent-tools)
records the tool behavior.

## Attachment contract registry

Attachment tools use the shared contracts in
`packages/contracts/src/attachment-contracts.ts`. The registry is the single
source for classification, JSON-schema enums, runtime validation, and the text a
model reads. It exposes eight natural-language kinds: `image`, `markdown`,
`pdf`, `document`, `spreadsheet`, `presentation`, `text`, and `other`. A list
tool must include the explanation for every value in its description; a model is
never expected to know or guess a MIME value.

The classifier trusts a verified MIME type before a filename. It consults a
sanitized extension only when MIME is absent or explicitly generic. This order
prevents a misleading filename from routing bytes to an unsafe converter while
still making historical generic uploads discoverable by a useful kind.

All attachment argument schemas are strict and share the same bounds. A first
list or read call carries human-meaningful arguments; a continuation carries
only a receipt-owned page ID. Its lookup binds the execution principal and owning
scope, but it remains a name rather than authority: an executor still performs
its normal authorization query. New private continuation state needs no HMAC or
artificial expiry; old signed cursors are decoded only for stored receipts.

An authorized wrong-tool call may carry a bounded `suggestedCall` for exactly
`read_resource`, `view_resource`, their two
`sidekick`-prefixed twins, or `import_resource`. The structured-failure
sanitizer accepts only those strict shapes, the nine registered kinds, bounded
MIME/reason values, and the existing fixed recovery fields. It does not forward
converter, provider, or attachment-authored objects.

`import_resource` is the one member that is not a content read, and it
is admitted in exactly one form: `{ resourceId }`. That is the create-only
shape, which refuses a non-empty destination with `destination_exists` rather
than replacing anything, so a model that follows the suggestion blind cannot
lose work — the strict object is what stops a producer suggesting `overwrite`.
It exists because a content read on a **site** has nothing single-bodied to
return: a site's stored content is its manifest, not a page. The remediation is
prefix-aware, and a `sidekick`-prefixed run gets the same sentence with **no**
`suggestedCall` — Sidekick runs hold no Terminal, so naming that tool would
trade one dead end for a worse one.

Three further `rally:workstream` tools read a **live artifact's stored data**, and are on
this plugin rather than Terminal's deliberately: reading a poll's tally must not
require a sandbox, and the run answering a data question is usually not the run
that built the page.

| Tool | Strict input | Successful `output` |
| --- | --- | --- |
| `describe_artifact_data` | `{ resource: string }` — a site resource's slug or id | `{ resource, slug, mode, tables: [{ name, columns: [{ name, type }], rowCount }] }`. Discovery first: the schema is a model-designed one this run may never have seen. |
| `query_artifact_data` | `{ resource: string, sql: string, params?: (string \| number \| null)[] }` | `{ resource, columns, rows, rowCount, truncated }`; at most 200 rows, with `truncated` rather than a silent cut. A stored blob is replaced by `<n bytes>`. |
| `read_artifact_table` | `{ resource: string, table: string, offset?: number }` | `{ resource, table, rows, nextOffset?, rowsShown? }`; one page of at most 200 rows, with `nextOffset` when a full page came back. `table_refused` names a table the site does not have. |

A member who did not publish the site reads only their own rows of a table
with a `private_to_viewer` column, and `describe_artifact_data` and
`read_artifact_table` say so in `rowsShown`. On a site with such a table, a
member's `query_artifact_data` fails with `private_rows`, pointing at
`read_artifact_table`, because free SQL cannot be limited to one person's
rows. The site's author and unattended Sidekick runs read and query every
row; `docs/live-web-artifacts.md` owns the rule.

All three are `mode: "read"`, `idempotency: "safe"`. **Read-only is enforced on the
statement, not by the transaction** — an always-rollback transaction is not an
authorization boundary, because caller SQL can commit mid-payload — so admission
is positive: exactly one statement, parsing as a `SELECT`, with a `WITH` clause's
*body* checked rather than its opening keyword. `sql_error` carries the repair in
its own sentence. `no_artifact_data` answers a static or stateless site, which is
a working outcome rather than a broken one, and points at the Terminal import for
reading its source. Results are the site's own data, written by its visitors, and
are handled as untrusted content wherever they surface.

The conversation runtime exposes five bounded content operations. The old
`workstream_read` hard-capped index is replaced by
`list_resources`, whose first call accepts an optional natural-
language kind and whose page-ID-only continuations can exhaust more than fifty
resources. `read_resource` returns 12,000 characters by default and
at most 24,000, with exact characters before and after plus previous/next page IDs.
`search_resource` derives bounded ranges from one versioned
derivative in memory and returns at most five passages and 20,000 characters.
`view_resource` returns a
JSON-only inclusion summary plus as many as eight ephemeral visual parts, and
`summarize_resource` runs one isolated reader over deterministic,
server-identified ranges with an optional untrusted prompt. Every continuation is
reauthorized and bound to the current inventory or derivative version.

All five operations use the same visibility loader as the right sidebar.
Nonexistent, foreign, detached, archived, revoked, and principal-invisible note
IDs therefore collapse to `resource_not_found`; a list continuation fails and
restarts when current visibility changes instead of combining inventories.
Calling a content tool on the wrong authorized natural-language kind returns an
exact read or view suggestion. Unsupported and invisible resources never carry
that remediation.

## Multimodal generation tool contract registry

The deferred `rally:multimodal-generation` plugin owns image generation,
editing, and text-to-speech. It is registered only when the main Azure
inference endpoint and key are both configured, and Bind exposes its tools as
`generate_image` and
`edit_image`, and
`generate_audio`. All three are serial
`record_before_execute` writes with a five-minute timeout.

| Tool | Strict input | Successful `output` |
| --- | --- | --- |
| `generate_image` | `{ prompt: string, title?: string, size?: "auto" \| "1024x1024" \| "1536x1024" \| "1024x1536" }` | One attached `generated_file` resource plus an ephemeral image part for the current model turn. |
| `edit_image` | `{ resourceId: UUID, prompt: string, title?: string, size?: same enum, maskResourceId?: UUID }` | A new version of that same attached image resource, preserving its resource ID and history, plus an ephemeral image part. The source must be an attached PNG, JPEG, or WebP image; a mask must be an attached PNG. |
| `generate_audio` | `{ text: string (1–4096 characters), voice?: "alloy" \| "ash" \| "ballad" \| "coral" \| "echo" \| "fable" \| "nova" \| "onyx" \| "sage" \| "shimmer" \| "verse" \| "marin" \| "cedar", instructions?: string, title?: string }` | One attached `generated_file` MP3 resource. The returned metadata identifies it as AI-generated audio; no audio bytes are copied into the model turn. |

Both calls use Azure's `gpt-image-2` deployment. The caller controls only the
prompt, title, and advertised size: moderation is fixed to `low`, quality to
`medium`, background to `auto`, output to PNG, and image count to one. The
provider response is MIME-verified and bounded by `MAX_ATTACHMENT_BYTES` before
R2 publication. Prompt text is never copied into resource metadata or logs.

Audio calls use the main Azure `gpt-4o-mini-tts` deployment, whose live
deployment version was `2025-12-15` when this contract was added. The response
format and image count have no tool arguments: the response is exactly one MP3,
and the voice defaults to `marin`. Text and optional speaking instructions are
sent to Azure but are not copied into the resource metadata, receipt, or logs.
The plugin system message requires the final response to disclose that the
recording uses an AI voice. Audio is a playable resource for people, not model
input: it is classified as `audio` with `contentMode: "unsupported"` and is not
returned through `contentParts`.

The resource's provider identity is derived from the durable effect-intent ID.
A generation replay therefore finds and reattaches the already-published image
instead of issuing a second provider request. An edit records its effect ID in
the new version's metadata and reuses that same resource on replay. Its update
is compare-and-swapped against the source content pointer and digest so it cannot
overwrite a version that changed while Azure was working. Current-turn image bytes travel through
`contentParts`, which durable receipts deliberately omit; later turns can view
the durable resource through the workstream tools.

Azure image usage is costed from the shared OpenRouter endpoint-average KV
record keyed by `openai/gpt-image-2`. Pricing is best-effort for this user-facing
tool: a missing/invalid price or missing usage does not deny the image request
and does not invent a charge. It records a null image cost and emits a structured
operator error instead.

The Azure speech response contains audio bytes and request metadata but no
token-usage object. Rally therefore makes the call available but records no
audio charge and logs that usage is unavailable. It probes the shared KV key
`openai/gpt-4o-mini-tts` for an advisory OpenRouter token-price fingerprint;
OpenRouter did not expose an endpoint record for that model when this tool was
added, so the normal state is an unavailable-price log rather than an invented
price or denied speech request.

## Model-authored input schemas

One family of tools has a schema a model wrote: a Sidekick's saved custom
tools, whose `inputSchema` the wizard authors and every run's model reads
([`code-mode.md`](code-mode.md#a-sidekicks-saved-tools)). The rules above still
hold, by construction rather than by review. `ToolInputObjectSchema` admits only
a plain object root with a description on every property and `required` drawn
from `properties` (items 2, 13); materialization closes it with
`additionalProperties: false` and the executor's first statement is the same
`validateToolArguments` the `validateInput` hook reports through (items 2, 12);
the wire name is `custom_<name>` with the name constrained to lower snake case
(item 1). What the schema cannot carry, a refinement or a cross-field rule, a
saved tool cannot express either, so item 12 has nothing to close.

## Terminal tool contract registry

The deferred `rally:terminal` plugin is the concrete file/command family that
follows these rules. All ten tools are exposed together after plugin load and
execute serially against one authority-fenced conversation workspace. Model-facing
names are prefixed by Bind as `terminal_<name>`. The runtime retains internal
hashes and an exclusive mutation lease, but none of these arguments or outputs
contains `expectedRevision`; exact file text or patch context supplies the
model-actionable drift check. See
[`terminal-workspaces.md`](terminal-workspaces.md) for the sandbox boundary.

| Tool | Strict input | Successful `output` |
| --- | --- | --- |
| `read_file` | `{ filePath: string, offset?: integer >= 1, limit?: integer 1..1000 }` | `{ filePath, content, startLine, endLine, totalLines, truncated, nextOffset? }`; at most 256 KiB. |
| `view_image` | `{ filePath: string }` | `{ filePath, sizeBytes, sentAs }`, plus the image as a content part the model sees for that turn (a GIF also gets its storyboard description); `sentAs` is the format the model received, which Images re-encodes. PNG, JPEG, GIF, WebP, TIFF or HEIF; at most 10 MiB read, scaled to the model's edge limit, and at most 8 MiB after conversion. A replay reads the file again. Refusals: `not_found`, `not_an_image`, `image_too_large`, `image_not_convertible`. |
| `edit_file` | `{ filePath: string, oldString: string, newString: string, replaceAll?: boolean }` | `{ filePath, replacements, additions, deletions }`. `oldString` must match exactly once unless `replaceAll` is intentional. |
| `write_file` | `{ filePath: string, content: string }` | `{ filePath, created, bytes, additions, deletions }`; this is deliberate complete replacement, not an edit fallback. |
| `apply_patch` | `{ patch: string }` | `{ files: [{ path, previousPath?, operation, additions, deletions }], additions, deletions }`; `operation` is `created`, `edited`, `renamed`, or `deleted`. |
| `run_command` | `{ command: string, cwd?: string, timeoutMs?: integer, description?: string }` | `{ state, terminationReason, exitCode, stdout, stderr, outputResourceId?, startedAt, completedAt, stdoutTruncated, stderrTruncated, durationMs }`. Nonzero exit is a completed command result, not an executor exception. Standard `git` and `gh` commands are available after repository checkout; `read_only` credentials reject remote mutation, while `full_access` may push and manage a PR. |
| `checkout_repository` | `{ repositoryFullName: string, requiredRemoteAccess?: "read_only" | "full_access" }` | `{ repository, repositoryId, connectionId, connectionName, baseRef, baseSha, headRef, remoteAccess, localEditsAllowed: true, remoteWritesAllowed, outcome, backup }`; `backup` is the attached recovery resource created before replacing prior workspace state, or `null` when there was nothing to preserve. |
| `import_resource` | `{ resourceId: UUID }` or `{ resourceId: UUID, destinationPath: string, overwrite?: boolean }` | `{ resourceId, filePath, outcome, mimeType, sizeBytes, sourceSha256 }`; `outcome` is `created`, `replaced`, or deterministic `reused`. For a **site** resource `destinationPath` names the directory root to materialize into and the output adds `fileCount`; `filePath` is reused for that root rather than a second key appearing beside it, so the round trip is `filePath` in, `filePath` out and a republish targets what the import returned. `overwrite` is whole-tree replacement, never a merge — merging would leave files a prior version deleted lying in the tree for the next publish to ship back. |
| `publish_resource` | `{ filePath: string, displayName?: string, description?: string }`; `filePath` may name a **directory** beneath `AVALON_RESOURCE_DIR` | A discriminated union on `publishKind` (`file` | `site` | `archive`), decided by the directory's root entry — see [Publishing a directory](#publishing-a-directory) below. A *file* returns `{ resourceId, title, resourceType: "generated_file", provider: "avalon_generated", mimeType, sizeBytes, sourceSha256, attachmentKind, contentMode, derivativeStatus, createdAt }`. Identity is `(work stream, normalized publish path)`: publishing the same path again updates that resource in place — new content, mime type, metadata, and `displayName` when one is given — and returns the same `resourceId`. Equal content returns it untouched, which is also how a replay of one call is absorbed. `createdAt` stays the first publish's timestamp across updates, so it is not a witness that this call's bytes landed. A different path, or the same path from another conversation, is a different document. |
| `publish_branch_and_pr` | `{ title: string, body: string }` | `{ repository, baseRef, headRef, commitSha, publishedSha, outcome, pullRequest: { number, url, title, state: "open" } }`; `outcome` is `created`, convergent `updated`, or recovered `unchanged`. |

### Publishing a directory

`filePath` may name a directory, and **the publish kind is resolved from what the
model wrote rather than from a parameter** — a parameter restating what the files
already say is a parameter that can disagree with them, and the disagreement
would be invisible until serve time.

| Root entry | Publishes as | Output adds |
| --- | --- | --- |
| `index.js` | An **active site** Rally executes per request | `resourceType: "generated_site"`, `attachmentKind: "site"`, `slug`, `url`, `mode: "active"`, `stateful`, `version`, `fileCount`, `totalBytes`, `manifestSha256`; `mimeType` is the site-manifest type |
| `index.html`, no `index.js` | A **static site** | The same, with `mode: "static"` |
| Neither | One downloadable **zip** | Today's file shape over the zip, plus `fileCount` and `totalBytes` |

A site's `slug` is its `resources.slug` alias. A republish keeps the one the
resource already has. It is `null` only while the alias is still owed: the
allocation beside a first publish failed and the `resource_slugs` maintenance
pass has not named it yet. A caller then falls back to `resourceId`.

`index.js` wins over `index.html`, because an active site almost always ships
both. The discriminant is `publishKind` rather than `resourceType` because a
document and an archive share the latter — a model told to switch on
`resourceType` would have to infer the archive branch from the presence of
`fileCount`, which is inference rather than a contract. A site output omits `contentMode` and `derivativeStatus` — a site has no
single content body to read and no derivative to wait on — and renames
`sizeBytes`/`sourceSha256` to `totalBytes`/`manifestSha256`, because a manifest
hash is not a file hash and a caller comparing them would be wrong.

Two failure codes are added. `single_file_directory` fires only on the archive
branch: a one-file zip is almost never deliberate and is near-exactly the shape
of a document publish that grabbed the folder by mistake, so it is refused with
the instruction to publish that file's own path. A one-file directory whose file
*is* an entry never trips it. `site_entry_removed` refuses a republish that would
turn a live site back into an archive — a URL participants hold is never killed
by an accident of file layout, while archive→site upgrades freely because that is
the archive fallback's own recovery. No publish-time code validation is promised:
`index.js` runs at serve time and nowhere else.

Every path uses `/` separators, is relative to `/workspace`, and rejects an
absolute path, backslash, NUL, or `..`; `.` names the root and is accepted for
`cwd` (which may also be omitted), while a `filePath` naming the root is
refused as `invalid_path`. `publish_resource.filePath` is instead relative to
the host-provided `AVALON_RESOURCE_DIR` (`/workspace/.rally-output`), and its
refusals say so rather than pointing at the workspace root. Discovery uses
`run_command` with `pwd`, `ls`, `find`, `rg --files`, or `rg`; a
duplicate `list_files` tool would spend context while teaching the model less
than the CLI it already knows.

Common failures are designed as loop repairs:

| Code/path | Model-visible recovery |
| --- | --- |
| `not_found`, `path_outside_root`, `invalid_path`, `not_text_file` | The refusal echoes the value it refused, names the root that parameter is relative to, and gives the accepted form; act on that rather than guessing another path. Omit `cwd` (or pass `.`) for the workspace root. For `not_found` on publication, write or copy the file beneath `AVALON_RESOURCE_DIR` first. Inspect with `pwd` and `ls -la`/`find`, or inspect binary metadata with `file`. |
| `not_an_image`, `image_too_large`, `image_not_convertible` | `view_image` only. Check the file's type with `file`; take a smaller screenshot or resize it with a command; or save it as a PNG at most 2048 pixels on its longest side, then view that file. |
| `match_not_found`, `match_not_unique` | Call `read_file` again, copy exact current text with enough surrounding context, then rebuild the edit; use `replaceAll` only when every match should change. This is the revision-drift recovery. |
| `patch_does_not_apply`, `patch_invalid` | Re-read every affected file and regenerate the whole context-bearing patch; no partial patch is reported as successful. |
| `destination_exists` | Choose a new import destination or set `overwrite: true` only after confirming replacement is intended. |
| `destination_not_regular` | Choose an absent destination or a regular file; Rally will not write through links, devices, or directories. |
| `limit_exceeded`, `resource_limit_exceeded` | Narrow/split the operation or reduce the input/output size before retrying. Archives and unfamiliar binary types still publish as download-only `other` resources. |
| `resource_empty`, `resource_not_ready` | Regenerate a non-empty file beneath `AVALON_RESOURCE_DIR`, wait for its producer to finish, then publish the stable final path with a new invocation. |
| `command_rejected` | Use one bounded foreground command or a dedicated file tool; do not retry a PTY, detached/background process, or remote shell. Git and GitHub CLI are ordinary bounded commands whose actual authority comes from the selected repository credential. |
| `sandbox_busy` | Wait the model-visible `retryAfterMs` before checking again. That value is retry cadence, not the lease deadline: an active harness execution owns the workspace through its valid operation lease, while an unsettled retained command blocks until Rally confirms provider quiescence. A `submitting` task renews exact durable authority before each provider mutation, then becomes `running` with the requested command-plus-observation horizon after provider acceptance. Recovery and lifecycle cleanup likewise renew their exact token before later provider mutations and cannot revive an expired token. An accepted `running` command requires whole-sandbox stop before linked handoff because named-session deletion does not prove the process stopped; a pre-acceptance or otherwise unprovable sandbox is retired and advanced to a fresh generation. Final expiry instead commits `expired` and preserves its final-diff reference. Never repeat a prior ambiguous command under a new invocation. |
| command `timed_out`, `cancelled`, `output_limit_exceeded` | Inspect the final bounded output or `outputResourceId`, reduce the job, and rerun as a new bounded command only when doing so is safe. |
| `repository_not_configured`, `repository_access_revoked` | Search the authorized GitHub repositories, call `checkout_repository` with an exact `owner/name`, then retry the repository operation. If policy changed, choose another authorized repository or ask a connector administrator to restore access. |
| `repository_not_authorized` | Use GitHub repository search and choose a result whose effective access satisfies `requiredRemoteAccess`; do not guess an inaccessible repository or retry unchanged. |
| `repository_remote_read_only` | Continue local edits and local commits, but do not push, publish a PR, or attempt another remote mutation until connector settings grant `full_access`. |
| `workspace_backup_failed`, `workspace_backup_changed` | Stop workspace writers and retry checkout; Rally leaves the existing repository and sandbox untouched until the durable recovery copy is verified. |
| `workspace_backup_too_large` | Remove regenerable dependency/output directories or publish large artifacts, then retry once the compressed recoverable state is at most 50 MiB. |
| `working_tree_dirty`, `publication_conflict`, `nothing_to_publish` | Use local `git status`, check out the host-selected branch, commit intended changes, or rebase onto the selected base, then retry publication only after local state is valid. |
| `publication_policy_denied`, publication size/path limits | Remove GitHub Actions workflow changes or split/reduce the committed change; a Terminal run cannot elevate this boundary. |
| `publication_not_authorized`, `publication_target_closed` | Continue from an active participant run with current full repository access, or use standard `git`/`gh`; use a fresh conversation when the typed publisher's convergent PR is closed/merged. |
| `command_outcome_unknown`, `tool_receipt_missing`, retryable provider failures | Retry the exact deterministic call so Rally can reconcile its durable receipt; do not invent a new command, id, or branch. |

Adding or changing a Terminal tool requires this input/output/recovery registry,
the exact descriptor and strict-schema tests, the plugin prompt update when
sequencing changes, and the snapshot/provider probe when the supported runtime
surface changes. The PRD checklist requires equivalent documentation for every
future agent tool or plugin, not just this family.

## Mechanics — where the rules are enforced

- **Authorize through the frozen run scope, never a one-off check.** A tool's
  `capability` is checked against the scope frozen at admission, and Rally
  revalidates the principal, connection identity, grants, and health before
  every tool call and between model turns. Loading never widens the scope, and
  revocation drops the plugin mid-run. Resolve the target server-side so a
  forged id cannot reach another workspace's data.
- **Validate in the executor — numeric normalization is not validation.** Bind
  is handed `z.unknown()` as the executable schema and carries `inputSchema` as
  `rawJsonSchema`, the provider-facing declaration. The runtime `JSON.parse`s
  the model's arguments and uses that schema to normalize exact numeric strings
  and classify a caught Zod error; it does not enforce the full contract before
  execution. Author the real schema with zod, convert it for `inputSchema`, and
  parse `rawArgs` as the first statement of the executor. Make it `.strict()` if
  an unexpected key should be an error. When it contains `.refine()` or
  `.superRefine()`, attach the same schema through `validateInput` (or a
  connector's `validateToolInput`) because `z.toJSONSchema` cannot carry the
  callback. Let a Zod rejection reach the harness so it can distinguish
  downstream validation from bad declared input. Never cast across the boundary.
- **Never express an exclusive choice as a root-level union of bare `required`
  branches.** Two independent things go wrong, and the rules below were measured
  against grok-4.3/4.5/4.6, gemini-3.5/3.6/3.7-flash, and
  gpt-5.6-terra/sol/luna through OpenRouter rather than reasoned about.

  **It fails the request on xAI.** Grok requires every branch of a *root* union
  to be recognizably an object and answers

  ```text
  invalid-argument: <tool>: tool parameter root must be an object type
  (root schema is an anyOf/oneOf union with a non-object branch)
  ```

  which OpenRouter surfaces as a provider 400 covering the **whole request,
  every tool**. This is not a sanitizer artifact — the authored schema fails
  identically to the sanitized one. A branch qualifies when it declares
  `type: "object"`, or declares no `type` and carries `properties`. Everything
  else is rejected, and three of those are easy to write by accident:

  - a bare `{ required: [...] }`, an empty `{}`, or an annotation-only
    `{ description: "…" }`;
  - `{ type: "string", properties: {…} }` — **a declared `type` decides by
    itself**, and `properties` does not rescue a branch typed as something else;
  - `{ type: "object", anyOf: [...] }` — **a branch carrying its own
    composition** is rejected despite the object type, so moving the union one
    level down inside a branch buys nothing.

  Two limits, both measured: only the **root** is constrained, so the same union
  nested under a property is fine everywhere; and only a **union** is, so a root
  `allOf` — an intersection — is accepted by all nine models including every
  Grok.

  **It loses the constraint everywhere else, silently.** The wire schema is not
  what you wrote. Bind sanitizes every `inputSchema` on the way out, and one
  transform prunes a `required` against *the same node's own* `properties` map,
  because Gemini's validator resolves neither composition nor parent scope. A
  branch that is nothing but a `required`, with the properties declared on the
  parent, prunes to nothing:

  ```jsonc
  oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }]
    ↦  oneOf: [{}, {}]
  ```

  Gemini and OpenAI accept that without complaint and let the model send both
  parameters or neither. An emptied branch is only the most visible form:
  `{ description: "…", required: [...] }` pruned to `{ description: "…" }` and
  `{ type: "object", required: [...] }` to `{ type: "object" }`, neither of them
  empty and both just as unconstrained.

  **Bind 12 and 13 repair that half.** A branch's `required` now resolves against
  its parent's `properties` and the referenced subschemas are copied down, so the
  constraint survives to the wire, and Bind 13 additionally drops the root
  branches it cannot repair rather than forwarding them. The guidance below is
  unchanged anyway: the schema is still not the enforcement point, a branch
  naming something nothing declares is still pruned away, and writing the
  constraint where it is actually enforced does not depend on which version of
  the sanitizer happens to be installed.

  So: state the constraint in the tool's `description`, where every provider
  reads it, and enforce it in the executor's zod parse — which is where it
  always held anyway, since `z.toJSONSchema` cannot carry a `.refine()` across
  the boundary either. `schedule_wakeup`'s "Give exactly one of delay or at" is
  the shape to copy. When a choice genuinely must be structural, give each
  branch a full object schema — `{ type: "object", properties: {…}, required:
  [...] }` — which is the only form that both passes xAI and survives
  sanitization with its `required` intact, because the branch then carries the
  `properties` the pruning resolves against.
  `list_resources` and `read_resource` are built that way
  and never broke. `apps/api/test/tool-schema-sanitization.test.ts` walks every
  authored schema through the real sanitizer and fails on either defect. A tool
  schema Rally does *not* author — a hosted MCP server's, which arrives at run
  time and no test can see — is repaired instead, at
  `validateDynamicConnectorTools`; see
  [`hosted-mcp-connectors.md`](hosted-mcp-connectors.md).
- **Choose `serial` deliberately.** This one is not a `ToolDefinition` field: it
  lives on the `HarnessTool` wrapper beside `definition` and `execute`, because
  it orders *execution* rather than describing policy. Bind already runs writes
  sequentially and may overlap independent reads, returning results in the
  model's original call order, so `mode: "write"` needs nothing extra. Set
  `serial` on a **read** whose effect a later tool in the same batch depends on
  — `load_skill` is serial for exactly that reason, so a `read_skill_resource`
  behind it in the same batch can see the load.
- **System messages are static, code-authored prose** on the plugin descriptor,
  and they sit in the cacheable system prefix. Keep per-call values out of them,
  and update the plugin's system message in the same change as the tool it
  describes. Never let provider content, a remote label, or a resource title
  become part of that trusted prose.
- **Update the docs in the same change.** A new or changed connector tool
  belongs in [`connectors.md`](connectors.md); a change to activation, receipts,
  or limits belongs in [`agent-harness.md`](agent-harness.md).

## Checklist for a new tool

1. Name and parameters use industry-standard terms and match the rest of the
   family; the canonical name does not repeat its plugin prefix.
2. No silently ignored params: `additionalProperties: false` declared *and* a
   strict zod parse in the executor enforcing it; the surface is uniform across
   the family. **A tool's `parameters` root is `{ type: "object", properties:
   {…} }` and nothing else** — no root-level `oneOf`/`anyOf`/`allOf`/`enum`/
   `const`/`not`, whatever the branches look like, and never a root without a
   `type`. That is Azure OpenAI's rule, it is the strictest of the two measured,
   and a root it rejects fails the whole request with every other tool in it.
   `z.union` emits exactly that shape, so an exclusive or conditional choice
   between parameters is a flat object with a `superRefine`, stated in the
   `description` and enforced by the executor's parse. The schema was never the
   enforcement point in any case: a branch naming an undeclared property is
   pruned away, `repairRootSchemaForProviders` flattens a root combinator on the
   way to the wire, and `z.toJSONSchema` cannot carry a `.refine()` across the
   boundary regardless. Item 12 below is then mandatory.
3. References accept names where a person would use a name; ambiguity is an
   error, never a guess.
4. There is a discovery path for any id, type, or enum the tool requires.
5. Errors are opaque only across a trust boundary; everywhere else a stable code
   plus the shortest safe action in the model-visible `error`, with contextual
   remediation inside structured `data`. `summary` never reaches the model.
6. Limits are hard and predictable, with no role-dependent silent behavior;
   truncation is marked.
7. `mode` and `idempotency` are correct for what the tool actually does, and the
   request is deterministic — no per-call randomness.
8. The response returns the ids and values the model's next step needs, and the
   persisted ones on replay.
9. Every `expectedRevision` names its producer and create semantics, successful
   mutations return the next revision, and conflicts require a fresh read rather
   than returning a replacement token.
10. No internal jargon in any model-visible string.
11. Strict-id params validate the family and hint the expected one on mismatch.
12. If the executor's parse is stricter than `inputSchema` in any way JSON
    Schema cannot carry — a `.refine()`, a `.superRefine()`, a cross-field or
    exclusivity rule, a bound stated only in zod — the same schema is attached
    through `validateInput` (or a connector's `validateToolInput`). Without it
    the runtime reads only what the model was shown, finds the arguments fine,
    files the tool's own rejection as somebody else's data problem, and tells
    the model to retry *without changing them*. Item 2 above is where that gap
    is created and this is where it is closed; the failure is invisible in every
    log, so nothing but this check catches it. **`validateInput` reports; the
    executor enforces.** The runtime consults the hook only after an executor has
    already thrown, so a refinement that lives *only* there never runs and the
    argument reaches durable storage unchecked — which is exactly what
    `automation_set_evaluator_rules` did. Run the check as the first statement of
    the executor and point `validateInput` at the same function.
13. Every parameter has a `description`, and each optional one says what
    omitting it does and what a wrong value does when wrong is silent. The
    schema is converted with `io: "input"`, so nothing the executor defaults is
    advertised as required.
14. `capability` is covered by the connector manifest, the descriptor matches it
    in provider type and tool order, the plugin system message is updated, and
    `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green.

## See also

- [`agent-harness.md`](agent-harness.md) — plugin registration, frozen scope,
  activation, receipts, limits, and the loop the tool runs inside.
- [`connectors.md`](connectors.md) — the manifest model, capabilities, and the
  per-provider tool surfaces.
- [`writing-skills.md`](writing-skills.md) — when the right answer is a
  *procedure*, not a capability.
- [`writing-prompts.md`](writing-prompts.md) — the standing policy and plugin
  system messages that tell the model when to reach for a tool.
- [`security.md`](security.md) — trust boundaries and what is treated as
  untrusted.

## Changelog

### 2026-11-03 — `read_artifact_table`, and a member reads only their own private rows

**What changed:** A third artifact data tool pages one table. A member who
did not publish a site sees only their own rows of its private tables, and
`query_artifact_data` refuses them free SQL on such a site with its own code,
`private_rows`.

**Why:** Sites now keep per-person rows (`private_to_viewer`), and free SQL
cannot be limited to one person's rows without a rewriter, which leaked each
time review found a new SQLite spelling.

**Considered and rejected:** Reusing `sql_error` for the refusal: the SQL is
fine, and a model branching on the code would rewrite the query instead of
switching tools.

**Consequences:** On a site with any private table, a member answers data
questions a page at a time.

### 2026-10-31 — A model may author a tool's input schema, within the shape

**What changed:** A Sidekick's saved custom tool carries an `inputSchema` the
wizard wrote. `ToolInputObjectSchema` bounds it to a described plain object,
and materialization closes it and validates through the same function in the
hook and the executor.

**Why:** A saved tool is the one place a model writes a schema other models
read. The checklist's items 2, 12 and 13 are what keep a tool usable by a small
model, and a reviewed schema is not available here, so the shape enforces them.

**Considered and rejected:** Free-form JSON Schema (an `anyOf` root or an
undescribed property would reach a run's model as exactly the parameter the
checklist forbids).

**Consequences:** A saved tool cannot express a refinement; what it needs
beyond the shape belongs in the program.

### 2026-10-15 — The connection check covers every scope

**What changed:** `get_connector_connection_state` reports every scope whatever
`scope` it is sent, and the prompts say a connected personal connection is
enough and a state check is not a refusal.

**Why:** on 2026-10-15 two agents setting up a Sidekick read the id
`google-drive-workspace` as a scope, asked only about `workspace` while the
member's personal Drive worked, kept the Sidekick a draft, and told the member
to complete a prompt that was never shown. Rejected: renaming the card id,
which saved cards in transcripts and the desktop catalog match on; and telling
the model to call twice, which leaves the miss to a prompt. A future change
must keep the check covering every scope regardless of input.

### 2026-09-20 — Give optional scalar arguments an explicit unspecified value

Documented the explicit unspecified-value contract for optional scalar arguments.
The implementation rationale and compatibility boundaries live in the
[harness changelog](agent-harness.md#2026-09-20--translate-unspecified-optional-scalars-at-the-model-boundary).

### 2026-09-19 — Re-enterability becomes a tool's own claim

**What changed:** `HarnessTool.reenterable` replaced the hard-coded list of
three Terminal tools the host was willing to run again over an interrupted
receipt, and `HarnessTool.reconcileEffect` joined it for a tool that resolves
its effect by subject rather than by receipt. `publish_resource` declares both.
The idempotency section above gained the two properties and the `provider_key`
resume rule.

**Why:** the list had no way for a fourth tool to join it, so
`publish_resource` was treated as unrecoverable and an interrupted publish
killed its run on 2026-09-19. Adding it exposed the second gap: looking up the
document at a path answers what is published there, not whether this attempt
published it, and that executor *swaps* the stored content when the two
disagree — so re-entry on its own was a second write, not a confirmation. One
property says the host may re-enter; the other says how the tool proves there is
nothing to duplicate. Both belong next to the executor that has to honour them.
`docs/agent-harness.md` has the mechanism and the full incident.

### 2026-09-19 — A `get` is a declared record too

**What changed:** The GitHub single reads and write echoes — `repository.get`,
`issues.get`, `pull_requests.get`, `actions.get_workflow_run`, and the create
and update tools that return what they wrote — now project onto declared
records, as the matching list row plus what the read was for. Rule 8 carries the
general form.

**Why:** The declared rows landed on the lists and deliberately left the reads
alone, reasoning that one object per call was affordable. That reasoning holds
for one call and not for a session: a run lists thirty pull requests and opens
six of them, and each `pull_requests.get` carried the same `head.repo` and
`base.repo` the list row had just dropped, so most of the saving came straight
back. The same held for `actions.get_workflow_run`, which embeds `repository`
and `head_repository`.

**Considered and rejected:** A separate declaration per read, which would let a
field earn its place on the list row and silently lose it on the read; the
records compose from the list rows instead. Leaving the write echoes as
pass-through, which would have made the shape of a created issue differ from the
shape of the same issue read back one call later.

**What a future change has to respect:** A read's record is the list row plus
the content and state the read was for, so adding a field to a list row adds it
to the read. What a read adds over its list row is what a caller opened the
record to see, not everything the provider happens to send.

### 2026-09-19 — A list returns a declared row, not the provider's object

**What changed:** Tool results are projected onto a declared set of field paths
before anything else sees them. `projectFields` and the `FieldProjection` type
are in `packages/connectors/src/provider-utils.ts`; every GitHub list tool now
declares its row, and `truncateTextWithMarker` makes a cut visible instead of
silent. Rule 8 above holds the contract.

**Why:** A substream measurement found five GitHub list calls holding 5.1 MB of
5.2 MB of model-facing payload — 24.5 KB per pull request, 21.3 KB per workflow
run, against roughly 400 bytes of answer. Nothing was unbounded: `perPage`, the
character clamps, and the array and depth clamps in `boundGitHubValue` were all
inside their limits, because they all bound a row's *length* and the problem was
its *width*. Six adapters in this package carry a near-identical clamp-only
walker, so the projection is a primitive rather than a fix to one adapter's
output, and GitHub is its first caller.

**Considered and rejected:** Lowering `perPage`, which leaves the bytes per
useful fact unchanged and buys the same waste in more round trips. A defensive
byte ceiling on a tool result, which truncates the useful tail of a page to keep
its useless head, and whose number is the team's rather than an implementer's
([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md));
that guard is still worth having, at the harness boundary where it covers hosted
and custom MCP too, and it belongs after a measurement of what rows now cost. A
model-supplied `fields` parameter, which is another optional parameter for a
small model to guess at.

**What a future change has to respect:** A row that drops an identifier another
tool documents as copied from it is a broken tool, not a smaller one. A declared
field the provider sent as `null` has to survive as `null`, and one the provider
omitted has to stay omitted. And a list whose description does not say what its
row holds teaches the model to read an absent field as an empty one.

### 2026-09-16 — Move authored pagination state out of model arguments

Authored tools now expose first/next calls and receipt-owned page IDs, with
wire-qualified recovery instructions and explicit end signals. Keeping opaque
provider cursors in the model schema required smaller models to copy fragile
tokens and preserve filters; the runtime can preserve both instead. Internal
adapter and pass-through schema guidance remains, but does not authorize
exposing raw continuations from authored tools. The owning mechanism and
tradeoffs are in [`tool-pagination.md`](tool-pagination.md).

### 2026-09-11 — A blocked connector can become an action, without making OAuth model-authored

**What changed:** Added the user-run-only
`core_get_connector_connection_state` and `core_show_connector_connection`
tools. Their calls carry only a closed connector catalog id and a
personal/workspace scope; the first reads caller-visible durable state and
regional availability, and an opted-in conversation feed turns the second
receipt into an interactive connection card.

**Why:** A connector refusal previously left the agent able to explain the
problem but unable to put the recovery action beside that explanation. For
Slack real-time search specifically, a workspace bot authorization can be
healthy while the missing personal authorization is still the thing required.

**Alternative rejected:** Letting the model supply display copy, capabilities,
or an authorization URL. Those are security and product decisions, not prose;
the desktop's trusted catalog and API own them. Also rejected: linking only to
Settings, which loses the scope the agent already established and makes the
person reconstruct the next step.

**Consequences:** New cards, their provider/capability discriminator, valid
scopes, and stable icon names are added once to shared non-UI catalog data; the
model-visible id enum and cross-field validation derive from it, and the
desktop consumes its icon names. Scheduled automation runs and workspace
principals receive neither recovery tool. A presentation call records that a card was shown, not
that authorization completed; only the OAuth callback may establish that. Its
terminal fact carries forward the validated catalog selection so that record
continues to render as a card from durable history. Both definitions state the complete
check-then-show flow and use short parameter descriptions so a medium model
does not have to infer ordering, state meanings, or whether the card completed
OAuth.

### 2026-09-11 — A nullable parameter survives in either spelling

**What changed:** Principle 1's second half no longer forbids the type-array
spelling. `@juno-ai/bind` 14 rewrites `type: ["string", "null"]` to the `anyOf`
union on the way to the wire, so a flat nullable declaration and an `anyOf` one
now reach the model alike. The `droppedNullableBranches` assertion in
`apps/api/test/tool-schema-sanitization.test.ts` widens from the connector
cursors to every declaration of every authored tool, nested ones included, and
`anyOf` remains the house spelling for a cursor.

**Why:** The 2026-09-03 rule below was written around the collapse and left 28
parameters on four connectors declared the way the sanitizer broke, each
waiting for its own conversion. One of them was `slack_send_message.thread_ts`,
and a scheduled Sidekick handed it as a bare string with "or send null" in the
prose put `"/"`, `". "` and `".000001"` into it for thousands of Slack-refused
calls, or the timestamp of its own previous post, which is how a joke Sidekick
came to reply to itself. Fixing the spelling per parameter would have left the
next connector free to ship the shape again; fixing the sanitizer fixes every
consumer at once, and the guard now proves it registry-wide.

**Considered and rejected:** rewriting the type array in Rally's own
`repairRootSchemaForProviders`, which runs before Bind's sanitizer and would
have worked for this repository alone. The collapse lives in Bind, every
consumer of Bind hits it, and the transform belongs beside the code it
replaces. Also rejected: dropping the `anyOf` preference for cursors now that
both spellings survive. A declaration that says what it means without
depending on a dependency's transform is the one a reader can trust.

**Consequences:** the guard is registry-wide and fails on a Bind release that
collapses again, naming the tool and the dotted path. A declaration in one of
the five shapes Bind 14 still collapses, listed once under Principle 1, is
reported the same way and needs a spelling of its own. And this changes what
the model is shown, not what the executor accepts: `SlackTimestampSchema`
still takes any non-empty string, so a model that ignores the schema can put
`"/"` in `thread_ts` past this change. The `pattern` on the string branch and
the matching executor check are phase 0 of
[the Sidekick delivery PRD](PRDs/2026-09-11_sidekick-delivery-reliability/prd.md)
and did not ship with this entry.

### 2026-09-10 — A parameter with no description is a parameter that gets guessed at

**What changed:** Principle 13, and checklist item 13. Every tool parameter
carries a `description`; an optional one says what omitting it does and what a
wrong value does where wrong is silent. Tool schemas are converted with
`z.toJSONSchema(schema, { io: "input" })`. GitHub's 112 parameters are written,
its list tools answer in one envelope carrying `count`, paging, and an
`appliedFilters` echo, and `apps/api/test/tool-schema-descriptions.test.ts`
walks every authored tool for both rules —
`defaultedRequiredParameters` at zero everywhere,
`undescribedParameters` at an exact per-surface count that can only fall.

**Why:** A recorded run (2026-09-10) asked for the open pull requests on
`juno-ai-labs/avalon` and answered that there were none. There were
twenty-five. Nothing errored: the call carried a `head` filter the model had
invented, GitHub's `head` wants `owner:branch` and answers anything else with
HTTP 200 and `[]`, and the connector returned that bare array with the summary
"Listed pull requests". The model could not attribute the emptiness to its own
argument, repeated the call, and finally abandoned the connector for a terminal
credential and `git`. Two defects put it there and neither was visible in any
log: all 112 GitHub parameters were undescribed, and `z.toJSONSchema`'s default
output mode advertised the five defaulted parameters beside `head` as required,
which is a schema asking for the whole block to be filled in.

This is the third instance of one class — the 2026-09-02 blank-cursor loop and
the 2026-09-03 cursor rule are the same failure on paginating parameters — so
it is a principle over every parameter rather than a fourth entry about one
kind. What the earlier two could not have caught is that the danger is not the
parameter's role but the provider's silence about a wrong value, which no walk
over names can see.

**Alternative rejected:** describing only the parameters that look risky, which
is what "cursors and ids" already was. `head` does not look risky; it looks like
a branch. The 239 parameters still undescribed across eleven other surfaces —
Google's 60 and Slack's 39 the largest — are recorded as an exact per-surface
count rather than fixed here, because each one needs a sentence somebody has to
know the provider to write, and a floor would have let a described surface
regress under it.

**Also caught by the map, and worth more than the count itself:** `multimodal`
reached it only because a review noticed the walk never built that plugin. Its
factory returns `null` without the Azure inference pair, so an environment
without one silently dropped three served tools and their twelve parameters out
of a walk that claimed to cover everything — passing both guards by not being
looked at. A conditional surface needs its credentials supplied in the walk
*and* a sentinel in `EXPECTED_TOOLS`, or the guard's own coverage is the thing
that regresses.

**Consequences:** A new tool fails `pnpm test` until its parameters are
described and its surface is named in that count. Lowering a number is the
edit that says you paid some of the debt down; raising one is not an
option. The GitHub list tools no longer return bare arrays, so anything reading
`output` as an array reads `output.pullRequests`, `output.issues`,
`output.commits`, `output.files`, or `output.reviews` instead.

### 2026-09-08 — A refusal echoes the value it refused

**What changed:** Principle 5 gains the rule that an error refusing a
caller-supplied value echoes that value and names the accepted form. The
Terminal path registry lists `invalid_path`, says `.` is accepted for `cwd`,
and says `publish_resource` refusals name the output directory rather than the
workspace root.

**Why:** A recorded run (2026-09-08) sent `cwd: "."` and was refused four
times as `path_outside_root` by a message that said to use `/` separators and
no `..` — which it had already done — so the model retried, then guessed
directory names. The 2026-09-02 blank-cursor loop was the same shape. Two
instances of one class earn a principle rather than a third changelog entry.

**Consequences:** An echoed value is model-authored and reaches the
transcript, so it is bounded and sanitized like the tool's other output; a
new refusal without an echo is a review finding.

### 2026-09-03 — The cursor rule is both halves, and it holds across every connector

**What changed:** Principle 9 now covers pagination cursors, and says the
description and the `null` branch are one rule rather than two. The
`droppedNullableBranches` assertion below widens from Google's four cursors to
every cursor on every registered connector, and
`tool-argument-empty-strings.test.ts` gains the matching sweep for a cursor
carrying no description.

**Why:** The entry below converted Google's four and recorded that 46 authored
null branches across five connectors were still collapsed, "which is a change
per connector rather than a line in this one". The 18 of those that are cursors
are now converted, so the assertion can be widened as that entry anticipated.
Its count of 19 cursors reads Slack's `search_messages.after` as one; that
parameter is a numeric timestamp filter sharing a cursor's name, which is why
both sweeps now match on the declared type as well.
Splitting the rule across two documents was the risk worth closing: an author
reading Principle 9 for a cursor's prose would not have reached Principle 1 for
its spelling, and prose alone was already measured not to work.

**Consequences:** 28 collapsed branches remain, on four connectors (Linear 13,
Granola 7, Slack 6, Notion 2), and they are ids and filters rather than cursors;
the widened assertion filters to the cursor property so it does not fail for
them. An author who needs `null` on one of those still gets the rule from
Principle 1; what is enforced automatically is the cursor case. Counted by
running `droppedNullableBranches` over the registry rather than by subtracting
from the entry below, so the figure describes the tree it ships with.

### 2026-09-03 — A parameter that may be "none" says so as a value, spelled `anyOf`

**What changed:** Principle 1 gains the other half of its rule. A parameter
whose value may legitimately be absent declares a `null` alternative, and
declares it as `anyOf: [{ type: "string", minLength: 1 }, { type: "null" }]`
rather than `type: ["string", "null"]`. `droppedNullableBranches` in
`packages/agent-harness/src/tool-schema-safety.ts` reports a declaration whose
null branch the sanitizer does not deliver, and the sanitization suite asserts
over Google's four cursors.

**Why:** `minLength: 1` closed the empty-string hole and opened a worse one. It
stops `""` reaching a provider, and it also tells a caller that whatever it
sends must be at least one character — so a caller that will not leave the key
out sends `"x"` instead. That is not hypothetical: in a work stream created
after the description-only repair shipped, with that description in front of it
four times, one run made eight `drive.search` attempts and put a value in
`pageToken` every time, then said so in leaked reasoning — *"here likely
pageToken required? Schema says min but omit should maybe omit."* Google
rejects the whole request over one bad parameter, so the first search failed
too, and the connector was abandoned for public web search.

The spelling matters because only one of the two survives. Bind's
`sanitizeToolSchema` collapses a type array to a scalar and moves the
nullability into the description, which hands a caller a schema forbidding the
value beside prose permitting it — precisely the conflict that produced the
eight attempts. `tool-schema-safety.ts` already noted the collapse in passing;
nothing connected it to the parameters that depend on it, and two automated
reviews of the change read the two spellings as equivalent. That is what a test
is for and a reviewer is not.

**Considered and rejected:** Documenting this only in
[`connectors.md`](connectors.md), where the Google change lives. The rule is
about authoring any tool, the guard is the one this document already promises
under Principle 1, and the next author to need it will not be writing a
connector.

**Consequences:** 46 authored null branches across five connectors — Linear 17,
Slack 11, Granola 9, Notion 5, X 4, of which 19 are cursors — are still
declared as type arrays and still collapsed, so their callers cannot spell
absence either. The assertion added here covers Google's four only; widening it
fails until those are converted, which is a change per connector rather than a
line in this one.

### 2026-09-02 — A tool parameters root is a plain object, on every provider

**What changed:** The rule for a tool's `parameters` root tightened from "a root
union whose branches all read as objects is fine" to "no root-level combinator
at all, and always `type: "object"`". `nonObjectRootSchema` states it,
`apps/api/test/tool-schema-sanitization.test.ts` gates every authored schema on
it, and `repairRootSchemaForProviders` corrects it for schemas no test can see.
`AttachmentListResourcesArgumentsSchema` and `AttachmentReadResourceArgumentsSchema`
stopped being `z.union`s and became flat objects whose cursor exclusivity is a
`superRefine`, with `validateInput` attached per item 12. Checklist item 2
carries the rule.

**Why:** `openai/gpt-5.6-sol` is fenced to Azure with no fallback candidate, and
the first production run to pick it from the model picker died on 2026-09-02
before its first turn. Azure answered `invalid_function_parameters` naming
`workstream_list_resources`: `schema must be a JSON Schema of 'type: "object"',
got 'type: "None"'`. Both offending tools were root `anyOf`s with fully readable
object branches, which is precisely the shape the previous rule was written to
*allow* — it was measured against xAI, Gemini, and GPT reached through
OpenRouter, and OpenRouter silently repairs root unions, so nine models' worth
of evidence agreed on a rule the first directly-called provider rejected. The
obvious patch of adding `type: "object"` beside the `anyOf` was tested against
the live deployment and also fails: `schema must have type 'object' and not have
'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level`.

The corrector had to change too, and that is the part to respect. It previously
*deleted* the offending root keywords, which is fine for a schema that also
declares root `properties` and catastrophic for one that does not: a `z.union`
root is only the `anyOf`, so deleting it leaves `{}` — a tool advertising no
parameters whose executor still demands them. It now merges the branches into
one object, intersecting `required` across a union and unioning it across an
`allOf`. What a merge cannot preserve is the exclusivity, and that loss is
deliberate: xAI could read it, Azure will not accept the request that carries
it, and a constraint only one provider honours is worth less than a request the
other does not reject outright.

**What a future change has to respect:** the corrector runs at
`toModelToolDefinitions`, the single point where any tool — this repository's, a
connector's, a hosted MCP server's, a skill's — becomes a provider payload.
Correcting at each source is a rule four sets of authors must remember; this is
one that cannot be forgotten, and moving it back toward the sources reopens the
class. `nonObjectRootSchema` deliberately judges the schema **as authored**
rather than as `sanitizeToolSchema` renders it, because this repository's
transports do not sanitize before serializing: the archived Azure request that
failed carried the bare root `anyOf` exactly as `z.toJSONSchema` emitted it.

### 2026-09-02 — A blanked optional argument reads as an omission

**What changed:** A second harness-wide tolerance, beside numeric-string
normalization: on a **read** tool, an optional property given `""` is dropped
before hashing, authorization, receipt planning, or execution when its schema
declares the empty string is not one of its values, and only for the top-level
arguments object, which is the one place requiredness can be resolved without a
schema evaluator. Principle 1 above carries the rule and the `minLength: 1`
obligation that turns it on. Every connector's cursors, ids, handles, and date
filters now declare it, and the six executor parses that did not enforce what
they declared do: Linear's `after`, Granola's `cursor` on `list_notes` and on
`list_folders`, Gmail's `threadId`, `gmail.search`'s `query`, and
`calendar.list_events`'s `query`.

**Why:** A production run was asked to file a Linear ticket, sent
`after: ""` on `list_teams` and `search_issues`, and got back
`Argument Validation Error` — Linear's verbatim message, with no field named,
because the connector forwarded the blank cursor as the GraphQL argument. The
model retried the identical arguments five times, varying only `first`, then
gave up without filing anything. The declared schema had permitted `""`, the
executor's parse had permitted it, and the model was given nothing to correct.
Blanking an optional parameter instead of omitting it is ordinary small-model
behavior, and it is the design target this document opens with.

**Considered and rejected:** Rejecting `""` loudly in each connector, which is
what Notion and Slack already did — it turns a provider error into a Rally
validation error, still costs the round trip, and still depends on the model
recovering from it. Also rejected: stripping every empty string from every
optional field, which would silently discard `description: ""` on
`linear_update_issue` and `path: ""` on GitHub's `contents.list`, both real
requests, and would be exactly the silent-drop failure principle 1 exists to
prevent. Tying the strip to what the schema declares is what makes it safe, and
it is why the obligation is on the schema rather than on the normalizer's
judgement, and applying it to writes, where `null` and absence are different
requests and a dropped blank turns a named error into a silent partial write.
Also rejected: treating what the walk cannot read as requiring nothing. A depth
or visit bound, an unresolvable `$ref`, a nested value whose requiredness an
ancestor's branches split between them, and the conditional keywords `if`,
`then`, `else`, `dependentRequired` and `dependentSchemas` are each unproven
rather than unrequiring, and each keeps every blank.
Also rejected: consulting `pattern` or `format`, which needs a regex
or format vocabulary evaluated to answer a question `minLength` answers plainly
and which the model reads more easily. Also rejected: reading `required` off the
node that carries `properties`, which two review passes caught — a schema
declaring `required` in an `allOf` branch or behind a `$ref` would have had its
required blank deleted, and a hosted MCP write tool, whose arguments Rally
forwards without a local parse, would then have run with the argument missing
rather than refusing it.

**Consequences:** The tolerance is for a read's top-level arguments; a write's
blanked argument, and any blank nested inside a value, still fails by name at
its executor. A tool that wants it must also declare it:
adding a read parameter whose empty value is meaningless without `minLength: 1`
leaves the blank to reach the provider, and for a cursor
`apps/api/test/tool-argument-empty-strings.test.ts` fails until it does.
Because normalization runs before the input hash, `{}` and `{ after: "" }` are
now one receipt identity. The X connector additionally maps its own provider's
`next_cursor: ""` to absence inside the executor, since that empty cursor
originates at the API rather than at the model.

### 2026-08-30 — Image generation, editing and speech are one dedicated multimodal plugin

**What changed:** Added the two strict `multimodal_generation` image tools,
their fixed Azure request policy, durable generated-resource publication and
same-resource edit versioning, effect-intent replay identity, ephemeral visual
results, and best-effort OpenRouter-average cost calculation. Beside them,
`multimodal_generation_generate_audio`, backed by the main Azure
`gpt-4o-mini-tts` deployment: the strict call accepts bounded text, one of the
provider's advertised voices, optional speaking instructions and an optional
title; output is fixed to one MP3 and defaults to `marin`. The verified bytes
become a replay-safe durable audio resource with native desktop playback.

**Why:** Image creation is a distinct capability that should be discoverable
without loading Terminal and should return a reusable workstream resource, not
an opaque provider payload. The provider controls that should not vary between
agent calls are locked in code so the small public schema remains honest.
Speech generation belongs beside image generation as hosted media work: it
needs the same Bind discovery, receipt, timeout, Azure credentials and
resource-publication boundary, without introducing a second plugin whose only
difference is media type.

**Considered and rejected:** Denying generation when cached pricing is absent.
That prevents an unpriced charge but turns a pricing-observability outage into a
product outage. Rally instead continues, records no image charge, and logs the
missing pricing for repair. Likewise for audio: denying the call or guessing a
token charge when Azure omits usage and OpenRouter has no endpoint price for
this model; Rally logs the missing billing evidence and records no charge. Also
rejected: storing prompt text in resource metadata; it is not needed to display
or replay the resource and would expand the durable sensitive-data surface. And
returning the MP3 through `contentParts`, which would pay to send an output
artifact back into the model and would misstate it as model-readable input.

**Consequences:** Changes to size choices, fixed moderation/quality/background,
output count, pricing semantics, or edit input formats must update this registry
and its exact request-contract tests in the same change. The attachment
registry includes `audio`; current and historical MP3 resources open in a
native player but remain unsupported by the agent content tools. Speech text
and instructions must remain absent from logs, receipts and resource metadata,
and user-facing summaries must identify the voice as AI-generated.
