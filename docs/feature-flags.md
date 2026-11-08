# Feature flags

Rally evaluates feature flags with [Cloudflare Flagship](https://developers.cloudflare.com/flagship/)
through the `FLAGS` binding on configured regional Workers. The binding owns two
things: which OpenRouter model each agent runs on, and which client-visible
features the desktop is allowed to offer. Read this document before adding a
flag, changing an agent's models, or changing what happens when a flag cannot be
evaluated. One thing overrides a flag rather than being one — a conversation
pinned to a single model, which today means a Sidekick's pin copied onto each
of its runs — and it has [its own section](#a-conversations-own-model) below.

## Where the code lives

Two modules read the binding, one per kind, and **nothing else calls
`env.FLAGS` directly**:

| Module | Owns | Fails |
| --- | --- | --- |
| `apps/api/src/services/agent-model-flags.ts` | One flag per model-using agent, and the pin that overrides one | **Open** — to the Worker variables, because an agent still has to run |
| `apps/api/src/services/client-feature-flags.ts` | The features the desktop polls | **Closed** — to off, because a client feature has nothing it must do |

Failure direction is the reason these are separate modules rather than one
resolver with a parameter. A client feature that fell back the way a model flag
does would ship an unreleased feature on the first Flagship outage. Because the pin lives with the model flags, every answer to "which model
does this run use" still comes from one file.

`apps/api/src/services/flag-targeting-attributes.ts` is the companion all of them
evaluate through: it turns the ids a caller happens to hold into the attributes a
targeting rule matches on, and it is where the line between a fact and a person's
data is drawn.

The rest:

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/flag-targeting-attributes.ts` | Loads the facts, caches them, and holds the line on what may leave the Worker. |
| `apps/api/src/routes/feature-flags.ts` | `GET /feature-flags`, answered under identity auth. |
| `apps/ace` | Access-protected editor and write authority for the managed user-facing product flags, also reachable from the engineering MCP's flag tools. See [`ace.md`](ace.md) and [`engineering-mcp.md`](engineering-mcp.md#feature-and-model-flags). |
| `apps/api/src/queues/product-feature-flag-consumer.ts`, `WorkspaceDO.notifyProductFeatureFlagChanged` | Regional key-only fan-out and private per-user socket refresh. |
| `packages/contracts` — `AGENT_MODEL_OVERRIDES` | The closed set of pinnable models. |
| `apps/desktop/src/main/developer-settings-flag.ts` | The main-process poll and its interval. |
| `apps/desktop/src/renderer/lib/agent-models.ts` | How every model id reads on screen — the menu's names and groups, and the shortening the conversation's read-only pill applies to an id the closed set does not admit. |
| `apps/desktop/src/renderer/components/composer-input.tsx` | The one model control, in both of its shapes: the choosable menu that would pin a conversation being started (offered by no composer today), and the locked pill inside one that already exists. |
| `packages/db/src/index.ts`, `apps/api/src/durable-objects/workstream-object-product.ts` | Where compatibility reads and authoritative object reads re-validate a stored model pin before it reaches routing. |

### Why a flag rather than a Worker variable

Model selection used to live entirely in `OPENROUTER_*` Worker variables, so
moving one agent to a new model meant editing both regional Wrangler files and
redeploying. Flags decouple the two: a model swap is an audited flag change that
takes effect on the next evaluation, can be staged per region, and can be rolled
out to a percentage of workspaces before it reaches all of them.

The Worker variables stay. They are the checked-in default that every agent
falls back to, so the deployed configuration remains readable in the repository
and Rally keeps running unchanged when Flagship is unreachable.

### One flag per agent

Each adjustable model-using agent type uses a flag keyed
`agent-model-<agent>`. Background agents use the conversation agent type and
inherit the source conversation's model override:

| Agent | Flag key | Default model | Fallback models |
| --- | --- | --- | --- |
| Conversation agent | `agent-model-workstream` | `OPENROUTER_PRIMARY_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Pasted-text naming (role `workstream_naming`) | `agent-model-workstream-naming` | `OPENROUTER_CLASSIFIER_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Memory sweep | `agent-model-memory-sweep` | `OPENROUTER_PRIMARY_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Sidekick wizard | `agent-model-sidekick-authoring` | `OPENROUTER_PRIMARY_MODEL` | `OPENROUTER_FALLBACK_MODELS` |

The checked-in primary model is `openai/gpt-6.1-sol`, with low reasoning
from the harness model-default registry. Flagship variations still override
the primary model.

Message addressing is deliberately absent from this table and from Ace. Its
evaluated cascade fixes JEV as primary and
`deepseek/deepseek-v4-flash-0731` through `wafer/fast` as the low-reasoning
fallback, with no model or provider fallbacks. Changing either side requires a
new evaluation and deploy; leaving an editable Flagship value in front of the
measured route would let production silently diverge from its evidence. The
conversation entry matches the `AgentInferenceSource` value written to the
inference ledger, so a ledger row and its flag key name the same agent; an
automation activation and its delegation workers remain `workstream` runs on
the conversation agent's flag. The Sidekick's authoring Main (`automation` parent,
substream `0`) and the background agents it starts use `sidekick_authoring`,
independently defaulting to Sol even when the conversation flag serves Terra. An explicit conversation model pin still
wins. The rest
are the standalone structured-output agents: message addressing uses the
agent-harness JEV/fallback cascade; the pasted-text title (the
`workstream_naming` role) uses the bounded structured-inference gateway.
The memory sweep ([`agent-memory.md`](agent-memory.md)) is a role on the
primary model. Text search's document embeddings use the same gateway's native
OpenRouter embeddings path but deliberately have no Flagship role: their fixed
`qwen/qwen3-embedding-8b` model is hashed into the Turbopuffer namespace, so
changing it is a code change and a reindex, not a flag.
Substream context summaries are another deliberate non-flagged route. Their
model is platform policy recorded in the durable context recipe before
inference starts. The structured-inference gateway accepts that explicit route
with an empty fallback list, so a retry cannot pick up a later flag evaluation
or Worker fallback change and produce a different seed under the same receipt.
The `workstream_description` and `suggestion_draft` roles are retired: their
callers (the description loop, the conversation suggestions) were deleted in
plan step C-2, and the Ace deploy retires `agent-model-workstream-description`
and `agent-model-suggestion-draft` through `retireFlag`. `workstream_naming`
keeps its Thread-era name because it is a Flagship key, and now titles pasted
text (`pasted-text-service.ts`); a rename would be a flag migration for no
change in behaviour. The loop read a window of up to 600 messages to judge whether
a Thread's purpose had moved, which is why it once wanted a stronger default
than the classifiers it shared one with; its retirement record is in
[`workstream-durable-object.md`](workstream-durable-object.md#changelog).

Naming sits at the cheap end: it relabels one request in a single turn, runs
while somebody watches for the result, and asks for no reasoning at all, so the
smallest classifier model is the right default and latency is the thing a
retarget would spend.

**Adding an agent means adding a flag.** The set above is the whole of what
`agent-model-flags.ts` knows about; an agent that reads `OPENROUTER_*` directly
is invisible to every rollout. ESLint forbids those reads outside the resolver
(with the health endpoint as the narrow availability-check exception) and also
forbids API feature modules from constructing an OpenRouter client outside the
structured-inference gateway. The exhaustiveness checks on
`AGENT_MODEL_FLAG_KEYS` and `defaultAgentModelRouting` catch a *role* that was
declared and not wired, but nothing catches a new service that never declared
one.

### Flag value

Each flag is a **JSON** flag whose variations carry one agent's whole route
plan, using OpenRouter model ids exactly as OpenRouter publishes them:

```json
{
  "model": "openai/gpt-6.1-sol",
  "reasoningEffort": "low",
  "fallbackModels": ["google/gemini-3.8-flash"]
}
```

- `model` — the OpenRouter model id the agent asks for first. Required, non-empty.
- `fallbackModels` — OpenRouter model ids the route plan traverses, in order,
  under Bind's classified failure policy. Optional; omitted means no fallbacks.

`reasoningEffort` is optional: `low`, `medium`, or `high`. Omission uses each
selected model's configured default. An explicit flag effort applies to the
primary and every fallback; a task's explicit reasoning setting wins over it.
Ace exposes the same choice, and MCP `update_model_flag` accepts it inside
`routing`. Older flag values continue to work unchanged.

The default model and its fallbacks live in **one** flag value rather than two
flags on purpose. A route plan is only meaningful as a whole, so a variation
change is atomic: an agent can never end up serving a new default model against
the previous generation's fallbacks.

### A conversation's own model

One thing sits above the flags: a conversation may be pinned to a single model,
recorded in its own `model_override`. The pin wins, and the flag is not
consulted at all.

The two answer different questions. A flag is a fleet-wide default, rolled out
per workspace, identical for every conversation in it. A pin is somebody asking
what *this* piece of work looks like on some other model — decided once, when
the conversation is created, and not something to stage a rollout for. Precedence
follows from that: a rollout reaching the workspace must not quietly take the
pinned conversation with it.

**The row a run reads is its own, not its parent's.** Each conversation is a
separate object with a separate `model_override`, and routing resolves the one
the run is executing in. Nothing copies a pin from a parent to a child
implicitly: that would move conversations onto a model nobody chose, and make
the selector's **Default** entry — which says it follows the flag — untrue in
exactly the case somebody is looking at it.

A Canvas is created unpinned (`createCanvas` writes `modelOverride: null`); the
Thread and Breakout composers that used to carry a pin from the developer model
selector are retired with them. An automation's pin is the
`model_override` column on its `automation_directory` row; there is exactly one path
that creates a run, `provisionSidekickRun`, which serves manual,
scheduled, connector-event, and inbound-email triggers alike, and it copies
`model_override` onto the run's child conversation, so a run resolves its model
from its own row like every other conversation.

That used to be three paths, two of which built the conversation row inline, so
a pin that reached only one looked correct under **Run now** and was silently
ignored by every scheduled run. That is how this shipped in review, and it is
the concrete reason [`automation-lifecycle.md`](automation-lifecycle.md) has
one producer. A field a run needs comes from `readRunDefinition`; a field added
to the conversation row without going through the definition is a field an
automation run does not get.

Nothing else writes the column, so an ordinary conversation is unpinned and
reads exactly as this document describes above. The control's choosable shape,
which no composer offers today, says so plainly: unpinned is its own menu entry,
labelled **Default** and described as following this flag, rather than named
after a model the renderer cannot know is being served.

The pin carries **no fallbacks**. It is a request to observe one specific model,
and routing onward would answer a question nobody asked. An explicit pin stays
fixed rather than routed.

That leaves a pinned run's route plan with nowhere to traverse when the provider
faults, so recovery has to come from somewhere else: the harness re-executes the
plan against **the same pinned model** after a retriable transport failure, which
keeps the pin's promise while stopping one stalled request from discarding a
whole run. [`agent-harness.md`](agent-harness.md#failure-modes-and-limits) owns
the budget and the failure code. Do not answer a pinned run's provider outage by
adding fallbacks here.

It reaches the conversation agent, which also authors Sidekicks, runs their
occurrences, and executes background work. A background agent inherits its
source conversation's override. The retired inline-child flag does not control
these agents.

The set of ids a pin may name is closed — `AGENT_MODEL_OVERRIDES` in
`@rally/contracts` — because a pin bypasses the rollout, so what it can reach
is a reviewed product decision rather than whatever string a client sends. The
Google family is ordered newest first, with 3.8 Flash above 3.7 Flash; the
OpenAI family is ordered by capability, with Sol above Terra and Luna. The
API validates it on write and again on read, which is what lets a model be
retired from the list without a migration: the conversations still naming it log
`workstream_model_override_unknown` and return to the flag. `resolveWorkstreamModelRouting`
is the resolver that applies all of this; `resolveAgentModelRouting` stays purely
about flags.

An automation's pin follows the same rule from a different place. The
automation row's `model_override` is a plain nullable string, a record of what
was authorized rather than a second validator, and `readRunDefinition` hands it
to the run as `modelOverride`. `provisionSidekickRun` re-validates it
through `automationModelOverride` on the way onto each run, so a model retired
from `AGENT_MODEL_OVERRIDES` since it was set drops back to the flag's choice
and logs `workstream_model_override_unknown` rather than being handed to the
provider as though it still existed. Retiring a model therefore still needs no
migration.

#### Reading it back inside the conversation

The composer of a conversation that already exists — Main's and a
substream's — shows the same control in the same place, behind the same **Debug
enabled** preference: the identical dropdown, trigger and pill and chevron, with
the trigger `disabled`. That is what
stops it opening, and its menu is left unrendered because a disabled trigger can
never reach one. Disabled rather than merely quiet is the honest shape here: the
pin is written once, when the conversation is created, and nothing afterwards
edits it, so a menu would offer a change the next run would not honour.

**Same place** is load-bearing and was not always true. The single-row message
capsule the launchers and conversations wear has no room for a pill beside its
attachment button, so the choice was moved into that button's menu while the
pill stayed in the toolbar layout — which gave one control two homes, and moved
the answer to "which model is this?" out of the composer at exactly the moment
it stopped being a question. The capsule's leading column now sizes to its
contents (a row holding the attachment button alone still measures the 42px it
was fixed at) and the pill sits beside it in every layout and both shapes.

The accessible name and the tooltip carry the full model id and say what may
truthfully be said about it, **which is not the same sentence for every
conversation**. A pin is fixed: `resolveWorkstreamModelRouting` finds it on the row and
never reads the flag, so every run uses it. An unpinned conversation re-evaluates
`agent-model-workstream` on *every* launch, so the id shown is what the latest
run happened to resolve and a later run may differ. What is immutable there is
the setting, not the model — an earlier draft of this control said a conversation
keeps the model it started on, which is a stability guarantee the server does
not make for the unpinned majority. The renderer therefore takes `pinned`
alongside the id and picks the claim from it. It says "conversation" rather than
"Canvas" or "Sidekick" for the same reason the column is read per row: in a substream,
naming the parent's kind would describe a row this pill is not showing.

The tooltip survives the disable — checked in a real window rather than assumed,
because the reverse is the intuitive guess: a disabled button swallows the click
that would open the menu, but Radix's tooltip is driven by pointer movement that
still reaches it. What the disable does cost is keyboard focus, since Tab skips a
disabled button, which is why the id has to be in the accessible name and not
only in the tooltip.

What it names is **`latestHarnessRun.model` first, and the pin only as a
fallback**. The pin alone would answer for almost nobody: an unpinned
conversation is nearly all of them, and the flag's served variation is not visible to
a client at all — but every parent run records a model, which is the pin where
there is one and the flag's answer where there is not. That column is the only
place a client can see which model a given conversation is actually running. It
follows that the id shown need not be one `AGENT_MODEL_OVERRIDES` admits; the
pill shortens an unknown id to its model segment and the tooltip carries it
whole.

The pin sits behind it because of one case the run cannot cover. The column is
written twice: `launchWorkstreamHarness` records the model it resolved at
schedule time, and the run host may overwrite it at settle — while its lease is
live and before terminalization — with the model that actually streamed. A run
that failed before its first token streams nothing, so that second write puts
**null** there. On a pinned conversation that is exactly where a run-only pill
would fall back to **Default** and describe it as following a flag it never
consults. `WorkstreamDetail` therefore carries `modelOverride`, projected by the
object's own summary and re-validated against the closed set on the way out
exactly as `resolveWorkstreamModelRouting`
re-validates it, and the pill reads it when the run has nothing to say. Only a
conversation that is both unpinned and has no recorded model reads **Default**,
for the same reason an untouched composer does.

What the pill still cannot show is a run whose attempts did not agree: the
column holds one id, and the inference ledger is what records the model behind
every attempt. See the `harness_runs.model` entry under [Failure modes and
limits](#failure-modes-and-limits).

### Evaluation

`resolveAgentModelRouting(env, role, context)` evaluates the agent's flag with
`getObjectDetails`, passing the Worker-variable default as the evaluation
default. The context it sends is the run's identity, plus the attributes
`flag-targeting-attributes.ts` loads for that subject.

#### Identity

A caller supplies only these, and only what it knows:

| Attribute | Value |
| --- | --- |
| `agent` | The role key, e.g. `workstream` |
| `appEnv` | `APP_ENV` |
| `workspaceId` | Present wherever the caller knows it; the right key for percentage rollouts |
| `workstreamId` | Present on conversation, subagent, and classifier evaluations |
| `userId` | Present on conversation naming evaluations |

Identity wins over attributes: the loaded facts are spread underneath these, so
nothing read from D1 can redefine the id a percentage rollout buckets on.

#### Attributes

Ids alone cannot express a rule anybody would want to write. Nobody targets a
uuid; they target the dogfooding workspace, the teams rather than the solo
accounts, the conversations a person started rather than the ones an automation
did. Each id the caller passes brings its facts with it:

| Attribute | Type | Value | Needs |
| --- | --- | --- | --- |
| `workspaceSlug` | string | The workspace's slug — how a rule names one workspace without pasting a uuid. **User-authored**; see the carve-out below | `workspaceId` |
| `workspaceMemberCount` | number | Members whose membership is `active`; invited and suspended do not count | `workspaceId` |
| `workspaceAgeDays` | number | Whole days since the workspace was created | `workspaceId` |
| `workspaceOwnerEmailDomain` | string | Email domain of the user who created the workspace | `workspaceId` |
| `userEmailDomain` | string | Email domain of the user the evaluation is for | `userId` |
| `userRole` | string | `owner`, `admin`, or `member` **in the workspace being evaluated** | `userId` + `workspaceId` |
| `userPlatformId` | string | The person, stable across regions. **Bucket a per-person rollout by this, not by `userId`** | `userId` |
| `workstreamOrigin` | string | `ad_hoc`; the `automation` value has had no writer since runs became conversations under their automation | `workstreamId` |
| `workstreamScope` | string | `personal` or `workspace` — who may read it | `workstreamId` |
| `workstreamCreatedByUserId` | string | Who created it | `workstreamId` |
| `workstreamCreatorEmailDomain` | string | That person's email domain | `workstreamId` |
| `workstreamFromOpportunity` | boolean | Whether it was started from a suggested work item | `workstreamId` |
| `workstreamIsSystem` | boolean | Whether it is machinery (`system_kind`), such as a conversation an older digest created | `workstreamId` |

An attribute whose fact is unknown is **omitted rather than sent empty**, so a
rule can never match a placeholder. The consequence worth knowing: a rule on an
attribute that was not sent silently never matches, which is why
`agent_model_flag_resolved` and `client_flag_resolved` log the attribute *names*
that were sent.

`userPlatformId` is the one to reach for when a rollout is per *person* rather
than per workspace. `userId` names a regional `users` row, and one person with
workspaces in configured deployments has one in each — bucketing on it would place them in
a different bucket per region and hand them a half-rolled-out feature on one of
them. The platform id is established once by the Global control plane and is
immutable in configured deployments ([`regionalization.md`](regionalization.md)). It is
absent only for an account predating that control plane, and an absent attribute
does not match, so such an account sits out the rollout rather than landing in
the wrong half of it.

`workspaceOwnerEmailDomain` exists because it is the only domain most
evaluations can have. A conversation run, a subagent, and the
classifiers carry no `userId` — nobody is asking, the workspace is — so without
the owner's domain no rule could reach a customer's tenancy or the dogfooding
workspaces on the paths that do the most inference.

#### What may become an attribute

An attribute leaves the Worker on every evaluation and lands in a flag-targeting
system that is not a place for anyone's data. The line is therefore drawn at the
loader, not at the rule author's discretion:

- **Yes** — ids, counts, ages, the enums the schema itself declares
  (`origin_type`, `scope`, `role`), and the **domain** half of an email address.
- **No** — a person's name, a full email address or its local part, a
  conversation's title or objective, a note, a message, a prompt, or anything else a
  person wrote.
- **One carve-out: `workspaceSlug`.** It is user-authored text — the workspace
  name typed at onboarding, slugified, with eight characters of the workspace id
  appended (`workspace-service.ts`) — so it can name a company, a team, or, on a
  solo account, a person, and it crosses from configured deployments. It is sent anyway,
  because the alternative is rules written against uuids, and a rule nobody can
  read six weeks later is a rollout nobody can safely revert. This is the one
  exception; a second one is a decision, not a precedent.

A domain is a cohort — a customer, a team, the people dogfooding — and that is
what makes a rule expressible. The local part is the individual, and it never
leaves the Worker; `flag-targeting-attributes.ts` keeps a test on exactly that,
scoped to the fields the rule covers rather than passing by accident on the
carve-out.

#### Freshness and cost

- Facts are cached in the isolate for five minutes, keyed by subject. A
  membership or a slug moves on a human timescale, so the staleness is free and
  a hot agent path does not pay for a read per run.
- **Evaluations that describe the same subject at the same moment share one
  read.** The cache is written when a read resolves, so concurrent resolvers
  would otherwise all miss and all read — and a single request now resolves
  several flags at once. The pending read is dropped as soon as it settles, so
  it de-duplicates rather than adding a second cache with its own staleness.
- A **miss is not cached.** A scheduled-creation path resolves a model for a
  conversation id whose product facts are not populated yet, so remembering "no such
  conversation" would leave those conversations unattributed through their first
  runs. They are unattributed for that first evaluation either way — a fact the
  rows do not yet hold cannot be sent.
- A brand-new Durable Object keeps its conversation id in the first model
  evaluation for identity and bucketing, but loads only workspace attributes
  until the atomic authoritative root, opening message, and first run commit.
  Querying conversation facts while the root is still `preparing` is not a miss:
  it crosses the authority fence, logs an operational error, and suppresses the
  now-readable row for ten seconds. Later runs load the complete conversation
  attributes normally.
- Scheduled creation uses the same resolver. `provisionSidekickRun`
  calls `scheduledWorkstreamModel` after the run's child conversation is
  provisioned but before its harness run is admitted, when the authoritative
  shell still carries placeholder facts, which is not a valid targeting
  subject, so that resolver deliberately loads workspace attributes only. A pinned automation skips the
  call, but only after `automationModelOverride` has accepted the pin; a pin it
  drops falls through to the flag like an unpinned run.
- A **failed read is held down for ten seconds**, keyed by entity and subject.
  That is the one case where retrying immediately helps nobody: while D1 is
  unhealthy, every agent path would otherwise re-issue its reads and warn again
  on every run, so an outage would arrive with a log flood on top of it. Ten
  seconds is short enough that recovery is prompt and a row written moments
  later is still picked up. "No row" and "no read" are therefore different
  outcomes internally, even though both send no attributes.
- At most three reads, issued concurrently, and each failure degrades to "no
  attributes from that entity" and logs `flag_targeting_attributes_unavailable`.
  A D1 error warns in every environment: unlike the Flagship binding, D1 works
  locally, so a failed read there is a real defect rather than the expected
  local state.
- Attributes are an enrichment, never a precondition. Loading them cannot fail
  an agent run, and a run with no attributes still resolves its flag on identity.

Four failures resolve to the same place — the Worker variables:

- **No binding.** `env.FLAGS` is undefined because the Worker does not declare it.
- **A call that throws.** Logged as `agent_model_flag_unavailable`, at `debug`
  rather than `warn` in development and test, because an unreachable binding is
  the normal local state (see below) and would otherwise warn once per agent run.
- **A flag that does not resolve** — missing, mistyped, disabled, or
  type-mismatched. Flagship reports these by returning the default with an
  `errorCode` rather than throwing, so they are caught by reading
  `getObjectDetails().errorCode` and logged as `agent_model_flag_unresolved`.
  Without that check a typo in `AGENT_MODEL_FLAG_KEYS` would be indistinguishable
  from a correctly provisioned flag.
- **Malformed value.** The served variation fails the zod schema. Rejected
  whole — never merged field by field — and logged as `agent_model_flag_invalid`.

A successful resolution logs `agent_model_flag_resolved` at `debug` with the
served `variant` and `reason`, which is how a staged rollout is confirmed from
the Worker side; the inference ledger records only the model that resulted.

`resolveAgentModelRouting` never throws, so a Flagship outage can never fail an
agent run.

Deployment does not depend on Flagship either: `wrangler deploy` writes the
binding into the Worker's script metadata without calling the Flagship API, so
the deployment token needs no Flagship permission — only the provisioning
commands above do. `GET /health` reports the binding as `featureFlags`, and
counts it as required in production, so a Worker deployed without a working
`FLAGS` binding fails the release health gate rather than quietly running every
agent on the Worker variables.

Evaluation is per run, not per model turn. A flag change reaches an in-flight
run only at its next admission; runs already streaming keep the plan they
started with. `harness_runs.model` records the model a scheduled run is expected
to use, resolved from the same flag at schedule time — a flag changed between
scheduling and execution makes that column an expectation rather than a
guarantee. The inference ledger records what each attempt actually used.

### Client-visible flags

A client flag decides what the desktop is allowed to *offer*, or how it should
behave:

| Flag key | Type | Default | Decides |
| --- | --- | --- | --- |
| `developer-settings` | boolean | `false` | Whether Application → Developer exists on this device |
| `suggested-work-enabled` | boolean | `false` | Still served; it gated the Suggested Work surfaces, which are deleted, so no client reads it |
| `multiple-workspaces-enabled` | boolean | `false` | Whether Electron shows workspace switching, invitations, creation, and background attention |

`GET /feature-flags` serves them all as one object — `{ "developerSettings":
false,
"suggestedWorkEnabled": false, "multipleWorkspacesEnabled": false }` — resolved for the
signed-in person. It answers under *identity* auth rather than workspace auth:
eligibility belongs to the account, and a device that has not chosen an
workspace yet still has to be told the feature is off rather than read a
403 as an outage.

The managed product Boolean names deliberately end in **Enabled**, as do their
camel-case response fields. `true` therefore always means the surface may be
shown and `false` means it is hidden; no caller has to infer whether a bare name
means disabled, hidden, or selected.

The managed product Booleans are presentation-only. Only
Electron consumes them to show or hide product surfaces; the API routes and
underlying product capabilities do not evaluate them. They are rollout
controls for discovery and visibility, not authorization, entitlements, or
server-side kill switches. The same rule applies to workspace-template
and multiple-workspace operations. Turning the
multiple-workspaces flag off hides the account-menu affordances; it does not
collapse memberships or discard stored workspace credentials.

The Developer section is for Juno staff, and **that is a Flagship targeting
rule, not a condition in the Worker** — see [the rule the flag is provisioned
with](#provisioning). `client-feature-flags.ts` contains no cohort of its own:
it describes the person, evaluates the flag, and serves the answer. Changing who
gets the section is a flag change with a changelog entry, not a deploy, and the
console shows the whole truth about who is in.

#### What a client flag's rules match on

The same [identity](#identity) and [attributes](#attributes) an agent
evaluation sends, from the same loader, with identity spread over the top so
nothing read from D1 can redefine an id a rollout buckets on. There is no second
vocabulary: a rule written for a client flag reads like every other rule, and
the boundary in [what may become an attribute](#what-may-become-an-attribute)
applies unchanged — the staff scope is `userEmailDomain`, never an address.

The one difference is which attributes are *reachable at all*. A client flag
always knows a `userId`, because there is a person asking rather than a
workspace running something, so the `user*` attributes are the ones to write a
rule against here — where most agent evaluations cannot use them. That is a
statement about which rules are worth writing, not a guarantee that a given
attribute was sent: the usual omissions still apply below, so a rule on
`userEmailDomain` is a rule the client flags can express, not one that always
matches. `workstreamId` is never known here, so no `workstream*` attribute ever
appears. `workspaceId` is present only once a workspace has been chosen.

Everything that is not an explicit `true` resolves to off: no binding, a binding
that throws, a flag that does not resolve, a non-boolean value.
`resolveClientFeatureFlags` never throws, so a Flagship outage cannot fail the
poll; it just leaves the answer off. Attribute loading fails the same way — an
unreadable account yields no `user*` attributes rather than an error, so a
cohort rule stops matching instead of the request failing.

A resolution logs `client_flag_resolved` at `debug` with the served `variant`,
the `reason`, and the attribute *names* that were sent. The variant and reason
tell a rule that excluded someone from one that never fired; the names tell you
whether the fact the rule is written against was even available. Neither carries
a value.

#### The desktop half

The three managed product Booleans arrive on the private
WorkspaceDO subscribe response and on `workspace_feature_flags` events. They
replace the renderer's one `['feature-flags']` cache as a complete object; a
partial event cannot leave a mixed generation behind. Reconnect always
re-evaluates them even if a live notification was missed.

Ace delays fan-out for 30 seconds because Cloudflare documents that Flagship
configuration changes can take
[up to 30 seconds to propagate](https://developers.cloudflare.com/flagship/concepts/).
The regional object evaluates after that delay; it does not trust a value from
the administrative write response.

`DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS` in
`apps/desktop/src/main/developer-settings-flag.ts` — one minute — is how long a
flag change takes to reach a running app. The poll lives in the **main
process**, not a renderer, because that is where `application-settings.json` and
the session are, and because both windows then read one answer instead of each
deciding for itself. It is a poll rather than a socket: the only realtime
channel Rally has is the per-conversation room, which a device without a
conversation open is not connected to, and a flag change is not worth a second
channel. A sign-in re-asks immediately rather than waiting out the interval; a
sign-out closes the section on the way past.

Each renderer treats a live application-settings event as newer than every
snapshot read or mutation reply that was already in flight. The listener is
installed before the initial read to make that lifetime explicit, but the
generation check carries the ordering: `ipcRenderer.invoke` replies and
`webContents.send` events are independent asynchronous channels. The main
process broadcasts transitions rather than repeating the same value on every
poll, so accepting an older reply after the transition would leave that
renderer stale with no later identical poll to repair it.

The effective preference the renderer sees is the stored **Debug enabled**
choice *and* the flag, computed once in `desktopApplicationSettings()`:

- A `application-settings.json` that says `debugEnabled: true` grants nothing
  while the flag is off. The stored bit is left alone rather than rewritten, so
  the choice is still there when the flag comes back.
- The Settings pane hides the whole section rather than disabling its toggle. A
  section the account is not in the cohort for is not a control that happens to
  be unavailable.
- A poll that cannot reach the service leaves the last answer standing.
  Revoking the section on a dropped connection would flicker it, and it crosses
  no trust boundary — it reveals debugging affordances the renderer already
  holds, per [`security.md`](security.md). Only an answer, a sign-out, or a
  shutdown turns it off.

## Invariants

- **Nothing calls `env.FLAGS` outside the two resolvers.** They exist as
  separate modules because they fail in opposite directions; a shared resolver
  with a parameter is one place for that direction to be chosen wrongly.
- **Model flags fail open, client feature flags fail closed.**
  A client feature that failed open would ship an unreleased feature on the
  first Flagship outage.
- **A route plan is one flag value, never two flags.** A variation change is
  atomic, so an agent can never serve a new default model against the previous
  generation's fallbacks.
- **A malformed variation is rejected whole, never merged field by field.**
- **A conversation's pin wins and the flag is not consulted at all.** A rollout
  reaching the workspace must not quietly take a pinned conversation with it.
- **A run resolves the pin on the row of the conversation it is executing in.**
  A conversation's main conversation and each substream is a separate object with
  a separate column, so nothing inherits: a substream is pinned by being created
  pinned. Copying a parent's pin downward would move work nobody chose for it.
- **The one path that creates a run copies `model_override` onto that run's
  conversation.** `provisionSidekickRun` reads it from the Sidekick's row.
  The invariant used to read "every path", because there were three and two of
  them built the row inline; a pin that reached only one looked correct under
  **Run now** and was silently ignored by every scheduled run. A second producer
  brings that failure straight back.
- **A pin carries no fallbacks.** It is a request to observe one specific model,
  and routing onward would answer a question nobody asked. A provider fault on a
  pinned run is recovered by retrying that same model, never by widening the
  route — see [`agent-harness.md`](agent-harness.md#failure-modes-and-limits).
- **The set of pinnable ids is closed** (`AGENT_MODEL_OVERRIDES`), validated on
  write *and* on read, which is what lets a model be retired without a migration.
  A conversation's pin is re-validated by `resolveWorkstreamModelRouting`; an
  automation's frozen pin by `automationModelOverride` as each run is
  provisioned. A run path that reads the automation's `model_override`
  without that call reintroduces the gap — the context's type is deliberately
  wide.
- **Identity is spread over the loaded attributes, never under them**, so nothing
  read from D1 can redefine the id a percentage rollout buckets on.
- **An attribute whose fact is unknown is omitted rather than sent empty**, so a
  rule can never match a placeholder. The consequence is that a rule on an
  attribute that was not sent silently never matches — which is why
  `agent_model_flag_resolved` and `client_flag_resolved` log the attribute *names*
  that were sent.
- **Bucket a per-person rollout on `userPlatformId`, never `userId`.** `userId`
  names a regional row, and one person with workspaces in configured deployments has one in
  each; bucketing on it hands them a half-rolled-out feature on one region.
- **What may leave the Worker is decided at the loader, not by the rule author.**
  Ids, counts, ages, schema enums, and the *domain* half of an email address —
  never a name, a full address or its local part, a title, an objective, a note, a
  message, a prompt, or anything else a person wrote. `workspaceSlug` is the one
  carve-out, and a second one is a decision, not a precedent.
- **Attributes are an enrichment, never a precondition.** Loading them cannot fail
  an agent run, and a run with no attributes still resolves its flag on identity.
- **Nothing that protects data is scoped by a flag.** Flag targeting is a product
  scope; a poll that cannot reach the service keeps its last answer, which is the
  wrong failure mode for a confidentiality boundary — see
  [`security.md`](security.md).
- **A cohort is a Flagship targeting rule, not a condition in the Worker.**
  `client-feature-flags.ts` describes the person, evaluates the flag, and serves
  the answer; changing who is in is a flag change with a changelog entry, not a
  deploy.
- **Product Boolean flag names explain true.** `suggested-work-enabled` maps
  to `suggestedWorkEnabled`; a bare or negatively named Boolean invites one
  layer to invert another.
- **A product-flag notification carries a key, never a value.** Two people in
  one workspace may match different rules, so WorkspaceDO evaluates each user
  before sending a private event. The subscribe response is the repair path.
- **Ace is the managed product-flag write path.** Flagship has no documented
  webhook or Queue notification surface; a dashboard edit changes evaluation
  but cannot wake connected Avalon clients.
- **Evaluation is per run, not per model turn.** A flag change reaches an
  in-flight run only at its next admission.

## Boundary

This document owns the `FLAGS` binding, the three resolvers, the attribute loader,
and the one thing that overrides a flag. It does not own the agents themselves or
what they do with the model they are handed:

| For | Read |
| --- | --- |
| The run loop, the route plan's failure policy, the inference ledger | [`agent-harness.md`](agent-harness.md) |
| The `model_override` column and where it is copied | [`data-model.md`](data-model.md) |
| Why **Debug enabled** crosses no trust boundary | [`security.md`](security.md) |
| Why `userPlatformId` is the stable per-person id | [`regionalization.md`](regionalization.md) |
| The retired description loop's retirement record | [`workstream-durable-object.md`](workstream-durable-object.md#changelog) |
| Provisioning credentials and the release health gate | [`runbook.md`](runbook.md) |

A subsystem that wants a rollout adds a flag here and reads it through the
resolver for its kind. It does not read `env.FLAGS`, and it does not read
`OPENROUTER_*` — ESLint forbids both outside the resolver.

## Failure modes and limits

Four failures resolve a model flag to the Worker variables, and every one of them
is logged distinctly rather than collapsed:

| Failure | Log event |
| --- | --- |
| No binding — `env.FLAGS` undefined because the Worker does not declare it | *(none; the normal local state)* |
| A call that throws | `agent_model_flag_unavailable`, at `debug` in development and test |
| A flag that does not resolve — missing, mistyped, disabled, type-mismatched | `agent_model_flag_unresolved` |
| A served variation that fails the zod schema | `agent_model_flag_invalid` |

Flagship reports the third by returning the default with an `errorCode` rather
than throwing, so it is caught by reading `getObjectDetails().errorCode`. Without
that check a typo in `AGENT_MODEL_FLAG_KEYS` would be indistinguishable from a
correctly provisioned flag.

- **`resolveAgentModelRouting` and `resolveClientFeatureFlags` never throw.** A
  Flagship outage cannot fail an agent run or the client poll.
- **Everything that is not an explicit `true` resolves a client flag to off** — no
  binding, a binding that throws, an unresolved flag, a non-boolean value.
- **Facts are cached in the isolate for five minutes, keyed by subject**, and
  concurrent evaluations of the same subject share one read. A **miss is not
  cached**: the automation paths resolve a model for a conversation id one statement
  before they insert the row, so remembering "no such conversation" would leave those
  conversations unattributed through their first runs.
- **A failed read is held down for ten seconds**, keyed by entity and subject.
  While D1 is unhealthy every agent path would otherwise re-issue its reads and
  warn again on every run, so an outage would arrive with a log flood on top of it.
  "No row" and "no read" are therefore different outcomes internally, even though
  both send no attributes.
- **At most three reads, issued concurrently**, each degrading to "no attributes
  from that entity" and logging `flag_targeting_attributes_unavailable`. A D1 error
  warns in *every* environment — unlike the Flagship binding, D1 works locally, so a
  failed read there is a real defect rather than the expected local state.
- **A pin naming a retired model logs `workstream_model_override_unknown` and
  returns to the flag**, rather than failing the run.
- **`harness_runs.model` is an expectation, not a guarantee.** It records the model
  a scheduled run was expected to use, resolved at schedule time; a flag changed
  between scheduling and execution makes it wrong. The run host overwrites it at
  settle with the model that actually streamed, but only while its lease is live
  and the run is not yet terminalized — and a run that never streamed overwrites
  it with **null**. The inference ledger records what each attempt actually used.
- **A desktop poll that cannot reach the service leaves the last answer standing.**
  Only an answer, a sign-out, or a shutdown turns the Developer section off; a flag
  change takes up to `DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS` (one minute) to
  arrive, and a sign-in re-asks immediately.
- **Product features do not use that open last-answer behavior.** Their shared
  schema defaults false, sign-out resets it, reconnect receives a fresh answer,
  and recording requires exactly true again inside main.
- **`GET /health` counts `featureFlags` as required in production**, so a Worker
  deployed without a working binding fails the release health gate rather than
  quietly running every agent on the Worker variables. Deployment itself does not
  depend on Flagship: `wrangler deploy` writes the binding into script metadata
  without calling the Flagship API, so the deployment token needs no Flagship
  permission — only the provisioning commands do.
- **Nothing catches a new service that never declared a flag.** The exhaustiveness
  checks on `AGENT_MODEL_FLAG_KEYS` and `defaultAgentModelRouting` catch a *role*
  declared and not wired; an agent that reads `OPENROUTER_*` directly is invisible
  to every rollout, and only the ESLint rule stands between the two.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/agent-model-flags.test.ts` | Each resolver's failure direction, unresolved cases, and zod rejection. |
| `apps/api/test/agent-model-override.test.ts` | Pin precedence, the closed id set validated on write and read, and the three run-creation paths that must copy the column. |
| `apps/api/test/client-feature-flags.test.ts` | That everything but an explicit `true` resolves to off. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | Initial private values and per-user live re-evaluation over a real hibernating WebSocket. |
| `apps/ace/test` | Safe rule vocabulary and Flagship limits, signed-site failure behavior, key-only notification, and cross-region Queue fan-out. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx` | Initial and live full-contract replacement in the feature-flag cache. |
| Desktop menu, sidebar, conversation, and meeting suites | Every visible entry point remains hidden until explicitly enabled while product actions remain otherwise unchanged. |
| `apps/api/test/flag-targeting-attributes.test.ts` | The attribute vocabulary, the omitted-not-empty rule, the cache and its negative cases, and — scoped to the fields the rule covers — that no local part or authored text leaves the Worker. |
| `apps/desktop/src/main/developer-settings-flag.test.ts` | The poll, the last-answer-standing behavior, and that a stored `debugEnabled` grants nothing while the flag is off. |
| `apps/desktop/src/renderer/screens/workspace-settings.test.tsx`, `apps/desktop/src/renderer/lib/use-debug-enabled.test.tsx` | Live application-setting broadcasts win over older reads, read failures, and mutation replies, so a poll can reveal or withdraw Developer without a relaunch. |

| `apps/desktop/src/renderer/components/workstream-composer.test.tsx` | The locked pill inside a conversation: the same gate, the exact id and the claim each of `pinned`'s two states may make, and that it opens no menu. |


Run one with
`pnpm --filter @rally/api exec vitest run test/agent-model-flags.test.ts` — the
path is package-relative.

Two traps. Flagship is unreachable in local development and test, which is the
*expected* state, so a suite that asserts a flag resolved is really asserting the
fallback; stub the binding rather than relying on the environment. And the
attribute test is deliberately scoped to the fields its rule covers rather than
asserting over the whole payload — a broad assertion passes by accident on the
`workspaceSlug` carve-out.

### Provisioning

Both regional Workers bind the **one** `avalon-api` Flagship app
(`bec01d3a-d6b6-4d8c-b89a-37440ed63b8c`), already provisioned:

```jsonc
"flagship": [
  { "binding": "FLAGS", "app_id": "bec01d3a-d6b6-4d8c-b89a-37440ed63b8c", "remote": true }
]
```

One app rather than one per region. Unlike D1, R2, and the Durable Object
namespaces, a flag *holds* no workspace data — only model ids — so the regional
isolation those resources need does not apply to what is stored, and splitting
would mean maintaining two copies of every flag that are meant to stay
identical. Staging a rollout per region does not need a second app either:
`region` is in the evaluation context, so a targeting rule reaches one region.

Ace automatically ensures all eight `agent-model-*` JSON flags plus
`meeting-recording-enabled`, `suggested-work-enabled`,
`multiple-workspaces-enabled`, and `push-notifications-enabled` exist on every
merge-to-main deployment. It seeds model flags from the checked-in Worker
defaults and does not overwrite an existing definition. Every product flag
defaults off except `push-notifications-enabled`, which defaults **on** for
everyone from launch. Once created,
edit product flags and each model flag's current default route through Ace
rather than the Flagship dashboard: Flagship's
documented API has no outbound change webhook, so only Ace performs the Queue
fan-out that wakes connected clients. [`ace.md`](ace.md) owns that release and recovery path.

To provision the app in a fresh account:

```bash
pnpm exec wrangler flagship apps create "avalon-api" --json
```

Add the returned id as `app_id` to both regional Wrangler files by hand.
`--binding FLAGS --update-config` writes it for you but reformats the whole
configuration file — retabbing it and expanding every inline object — so it is
not worth the diff.

**`app_id` is not optional in practice.** `wrangler deploy` refuses a flagship
binding without one (`FLAGS bindings must have an "app_id" field`), and neither
CI gate catches its absence: a dry-run build substitutes an inherit placeholder
for the missing id and passes. Wrangler can provision an app during deploy, but
that path prompts interactively, which a CI runner cannot answer. The failure
would therefore land mid-release, in the deploy job that runs *after* the remote
D1 migrations have applied. `agent-model-flags.test.ts` asserts both regional
files carry an `app_id` so the gap fails on the pull request instead.

Both paths need a Cloudflare API token carrying **Flagship write** access. A
read-only Flagship grant is enough to list apps and flags but returns
`Authentication error [code: 10000]` on any create, so a token that passes
`wrangler whoami` and `wrangler flagship apps list` can still fail to provision.
[The runbook](runbook.md#required-hosted-resources) lists the full token
permission set.

Ace's deployment normally creates one JSON flag per agent, seeded from the
checked-in route catalog. Those values match the Wrangler defaults in both
regional configurations; a deployment does not read a locally overridden
Wrangler value when it provisions an absent flag. If a fresh account is being
assembled outside that release path, the equivalent manual command is:

```bash
pnpm exec wrangler flagship flags create <APP_ID> agent-model-workstream --type json \
  -V current='{"model":"openai/gpt-5.6-terra","fallbackModels":["google/gemini-3.8-flash"]}' \
  --default current \
  -d "Work-stream agent OpenRouter models"
```

Repeat for every key in the table above, or deploy Ace and let its idempotent
provisioner create only the missing keys. An agent whose flag does not exist
keeps running on its Worker variables, so the flags may be created one at a
time.

Then the client flags, seeded **off**, which is what an absent flag already
resolves to:

```bash
pnpm exec wrangler flagship flags create <APP_ID> developer-settings --type boolean \
  -V off=false -V on=true \
  --default off \
  -d "Application → Developer in the desktop client. Staff-scoped by the rule below" \
  --rule "serve=on; when=userEmailDomain equals juno-labs.com"
```

**The staff scope is that `--rule`, and it is the only thing holding it.**
Nothing in the Worker narrows the flag, so a `developer-settings` served with no
rule reaches every account it is evaluated for. `create` takes rules, so give it
one there rather than adding it afterwards with `update --add-rule`: a flag that
exists for even a minute without its rule is a flag that is live and unscoped
for that minute.

Leave the default variation at `off` rather than promoting `on` with the rule
attached: the default is what an account the rule does not match falls through
to, so `set … -V on` would hand the section to everyone regardless of the rule.

To stage it among staff, roll out within that rule and bucket by
`userPlatformId` — not `userId`, which would bucket a person with workspaces in
configured deployments twice. There is no workspace worth keeping consistent here, because
the section describes one person's device:

```bash
pnpm exec wrangler flagship flags rollout <APP_ID> developer-settings \
  --to on --from off --percentage 50 --by userPlatformId
```

To hand it to one person outside a cohort — a contractor, a support session —
target them by their platform id rather than by address, which is not an
attribute and never will be ([what may become an
attribute](#what-may-become-an-attribute)):

```bash
pnpm exec wrangler flagship flags update <APP_ID> developer-settings \
  --add-rule "serve=on; when=userPlatformId equals <platform-user-id>"
```

Withdrawing the section from everyone is `set … -V off`, which overrides every
rule, and `wrangler flagship flags changelog <APP_ID> developer-settings` is the
audit trail for who had it when.

### Changing an agent's models

For a fleet-wide default change, use Ace → **Models**. Choose one of the known
model ids or enter any OpenRouter id, edit the ordered fallback array, and save.
Ace validates every id against OpenRouter's live endpoints while it is edited
and repeats the check immediately before the Flagship write. An unknown id, an
id without a current route, or an unavailable validation service leaves the
existing flag unchanged. Each provider lookup is aborted after the
product-owner-selected five-second deadline; a timeout is treated as validation
unavailable and returns `502` without reading or mutating Flagship.
Ace replaces only the current default variation's atomic `{ model,
fallbackModels }` plan after reading the live flag; it preserves the flag's
status, targeting rules, rollout percentages, and every staged variation.
Cloudflare's API exposes no conditional-update token: like Wrangler, Ace must
read and then replace the complete definition. Concurrent edits to the same
flag are therefore last-writer-wins. Avoid changing one model flag in two
operator surfaces at once, and use
`wrangler flagship flags changelog <APP_ID> <FLAG_KEY>` to audit or reconstruct
an overlapping change.

For a targeted rollout, add the new plan as a second variation with Wrangler,
roll it out, then promote it. Ace deliberately does not flatten these advanced
variations into its default-route editor:

```bash
pnpm exec wrangler flagship flags update <APP_ID> agent-model-workstream --type json \
  --set-variation next='{"model":"x-ai/grok-5","fallbackModels":["x-ai/grok-4.3"]}'
pnpm exec wrangler flagship flags rollout <APP_ID> agent-model-workstream \
  --to next --from current --percentage 10 --by workspaceId
pnpm exec wrangler flagship flags set <APP_ID> agent-model-workstream -V next
```

Bucket the rollout by `workspaceId` rather than `workstreamId` or `userId`: it
keeps every agent in a workspace on one generation, so a conversation run and the
subagents and classifiers around it stay consistent.

Because configured deployments share the app, a rollout reaches both unless you scope it.
To stage one region first, target `region` instead:

The same shape reaches any attribute in the table above — the dogfooding
workspaces before anyone else, then the teams, then everybody:

```bash
pnpm exec wrangler flagship flags update <APP_ID> agent-model-workstream \
  --add-rule "serve=next; when=workspaceOwnerEmailDomain equals with-avalon.com"
pnpm exec wrangler flagship flags update <APP_ID> agent-model-workstream \
  --add-rule "serve=next; when=workspaceMemberCount greater_than 1"
```

Prefer a rule whose attribute is present on the evaluations it is meant to
reach. `userRole` and `userEmailDomain` only exist where a caller knows a user —
the automation compiler and meeting notes — so a rule written on them leaves the
conversation agent on the old variation, which is rarely what a rollout means to
say. `workspaceOwnerEmailDomain` reaches every evaluation that knows a
workspace, which is all of them.

To revert, `set` the flag back to the previous variation. Flagship keeps a
changelog per flag (`wrangler flagship flags changelog <APP_ID> <key>`), which is
the audit trail for a model change; the Wrangler variables are the audit trail
for a default change.

Keep the Worker variables in step with the variation a flag serves by default.
They are what a fresh region falls back to, and letting them drift means an
outage silently moves every agent to an older model.

### Local development

Flagship bindings are always remote. `wrangler dev --local` — which is what
`pnpm dev:api:local` runs, and what a sandbox must use — prints the binding as
`not supported`, but it does **not** omit it: `env.FLAGS` is present and its
methods exist, and every call rejects with `Error: Binding FLAGS needs to be run
remotely`. Local runs therefore reach the Worker variables through the
throw-catching path rather than the missing-binding one, which is why both are
handled and why the throw is logged at `debug` in development.

The practical consequence is that `typeof env.FLAGS` proves nothing about
whether flags actually work — including in `GET /health`, whose `featureFlags`
check reports the binding as available locally.

Attributes are loaded before that throw, so a local run does read the subject's
rows and then discard the evaluation. That is deliberate rather than wasteful:
the attribute reads are the half of the path that *does* work locally, so a
loader that returns nothing, or a query that fails, is visible in development
instead of only after a deploy.

To exercise a real flag locally you need Cloudflare credentials and
`pnpm dev:api`, which opens a remote proxy session for the remote bindings.

### Adding a flag

1. Add the key and its typed value to `agent-model-flags.ts` if it is about
   model routing, to `client-feature-flags.ts` if a client reads it, or to a new
   module alongside them otherwise. Keep `env.FLAGS` out of call sites. Declare
   a product Boolean's key constant as `ProductFeatureFlagKey` rather than a
   bare string: that annotation is what turns step 5 from something to remember
   into a typecheck error naming the keys that do exist.
2. Give it a default that reproduces today's behavior, and hand that same
   default to Flagship so an absent flag and an unreachable Flagship agree. For
   a client *feature* that means `false`: a feature nobody has been given yet is
   the behavior an outage has to reproduce. For a value with no off — a cadence,
   a limit, a window — it means the number already in the code, defined once and
   read by every end, so a flag nobody can reach leaves every reader agreeing.
   Such a value does not belong in `client-feature-flags.ts`, whose whole
   contract is failing closed; give it a module beside it.
3. Parse the served value with zod and reject it whole on failure. A boolean
   flag is the degenerate case — anything that is not `true` is off.
4. **Write who gets it as a targeting rule, never as a condition in the
   resolver.** A cohort in code is invisible from the console, needs a deploy to
   change, and overrides the flag it is supposed to implement. If a rule cannot
   express the cohort, add the missing *attribute* below — that is the fix, not
   an `if`.
5. **Register it in Ace, in all three places, or the flag does not exist.** A
   key the Worker resolves is not a flag: nothing creates it in Flagship,
   nothing lists it for an operator, and nothing accepts a change to it, so it
   resolves off for everyone permanently and warns on every poll. A product
   Boolean — any key ending `-enabled` — needs that key added to
   `ProductFeatureFlagKeySchema` in `@rally/contracts`, to `MANAGED_FLAGS` in
   `apps/ace/src/protocol.ts`, and to an `ensureFlag` call in
   `apps/ace/scripts/deploy.mjs` carrying the identical description and
   default. Merging those three redeploys Ace, and that deployment is what
   creates the flag. With the annotation from step 1 in place, `pnpm typecheck`
   fails until the first of those three is done. `apps/ace/test/protocol.test.ts`
   then fails when a product Boolean the Worker serves is missing from the
   catalog. No test checks that `deploy.mjs` provisions a catalogued flag with
   the same description and default, so match those by hand. A flag
   deliberately kept *outside* Ace keeps a key that does not end in `-enabled`,
   the way `developer-settings` does — the suffix is the rule, not a list.
6. Add the flag to the table above and create the rules that scope it. There is
   one app for configured deployments, so it is created once — and a flag created without
   its rule is live and unscoped until the rule lands. Ace provisions with no
   rules at the default variation, so for a feature that is off for everyone
   until the rule lands, which is the safe order.

### Adding an attribute

A rule that needs a fact the table above does not carry gets it from
`flag-targeting-attributes.ts`, never from a call site: callers pass ids, and
one module decides what those ids mean. Add the fact to the loader for its
entity, emit it only when it is known, keep it inside the boundary above, and
add it to the attribute table here. If it needs a read of its own, it needs a
cache entry of its own — three reads is the standing budget for an evaluation.

## Apple push

`push-notifications-enabled` defaults on for everyone and is provisioned by Ace. The client
contract exposes `pushNotificationsEnabled`; the same boolean evaluator gates
both intent enqueue and delivery. Turning it off stops queued sends as well as
hiding the Notifications section.

## Changelog

### 2026-11-07 — The session-import and suggested-work model roles are retired

**What changed:** `session_import`, `work_opportunity_admission` and
`work_opportunity_ranking` left `AGENT_MODEL_ROLES`, the structured-inference
roles, the route defaults and Ace's catalog, and the Ace deploy retires
`agent-model-session-import`, `agent-model-work-opportunity-admission` and
`agent-model-work-opportunity-ranking` instead of ensuring them.

**Why:** session import made Channels and suggested work made Threads, both
retired by the Canvases and Sidekicks pivot (plan step B-8); nothing calls the
roles. `session_import` stays in the usage ledger's `METERED_ACTIVITIES` and
`ORGANIZATION_PAYS`, so a usage event already queued still parses. With the
two suggested-work roles gone `OPENROUTER_STRUCTURED_MODEL` has no reader;
removing the Worker variable is a later, deploy-affecting change.

### 2026-11-07 — Thread-era model roles and `live-artifacts-enabled` are retired

**What changed:** `workstream_description` and `suggestion_draft` left
`AGENT_MODEL_ROLES`, the structured-inference roles, the route defaults and
Ace's catalog; the Ace deploy retires their Flagship keys.
`workstream_naming` stays, relabelled in Ace as pasted-text naming. The
`liveArtifactsEnabled` client field, the `live-artifacts-enabled` managed key,
its Ace editor entry and its `ensureFlag` provisioning are gone: Ace's deploy
`retireFlag`s the key, and `useSiteArtifacts` builds the rail's site detail,
preview pane, Data view and artifact window for every signed-in surface that
has a bridge to present through.

**Why:** Plan step C-2 of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)
deleted both roles' only callers, and a key left in Flagship can still be
served and edited in Ace for nothing. The PRD makes a live artifact the Canvas
itself, and a Canvas is opened through exactly the site surfaces, so a flag
that can hide them would hide the product's primary object.

**Considered and rejected:** Renaming `workstream_naming` to a pasted-text
role. It is a Flagship key, so the rename is a flag migration with no change
in what runs. The `turn_disposition_classifier` and `suggestion_draft` metered
activities stay in the usage contract: a usage event queued before the deploy
must still parse, or the consumer drops it as invalid and the call goes
unbilled.

**Consequences:** Do not revive `live-artifacts-enabled` for a new purpose; a
site-surface rollout control would now be a kill switch for Canvases, which
is a different decision from a presentation flag. An older desktop build
still defaults the missing field to `false`, so it hides the site surfaces
until the updater delivers this build; that is expected, not a bug.
`suggested-work-enabled` is still served with no reader; retiring it is the
same `retireFlag` step.

Design: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.

### 2026-10-21 — Route the Sidekick wizard independently on Sol

**What changed:** Sidekick authoring Main uses `agent-model-sidekick-authoring`,
whose checked-in default is the primary Sol route. Ace and Engineering MCP expose
the role, and inference traces identify its flag. Wake-up admission carries the
conversation type and substream into model selection so its stored run label
matches inference routing. Explicit pins still win; activations, background
agents and ordinary Threads keep their existing route.

**Why:** A spreadsheet-to-calendar retry activated polling without resolving a
declared event binding. The setup wizard needs the stronger model for composing
trigger selection and durable instructions, independently of the live Terra
route used for ordinary conversations.

**Considered and rejected:** Raising `agent-model-workstream` would change every
ordinary conversation and activation. Pinning each wizard would prevent future
fleet routing and omit its fallback models.

**Consequences:** Existing unpinned wizards pick up the new role on their next
evaluation after deployment. No change to the live work-stream flag is needed;
an absent authoring flag uses the checked-in default until Ace provisions it.

### 2026-10-16 — The digest kill switch and its fail-open resolver are removed

**What changed:** `digest-flags.ts` and the `digestsEnabled` client field are
gone, so two modules read `env.FLAGS`, and every client feature flag fails
closed with no exception.

**Why:** The flag guarded the agent-run digest that the 2026-10-15 rewrite
replaced, and its live default had drifted to `off`, silently hiding the Daily
digest settings and stopping delivery. See `digests.md` (retired).

**Consequences:** A future flag that must fail open belongs in a module of its
own, as this one did; do not revive `digests-enabled` for a new purpose.

### 2026-10-05 — Naming defaults to GPT-5.6 Terra

**What changed:** `OPENROUTER_CLASSIFIER_MODEL`, the default route for
`agent-model-workstream-naming`, is now `openai/gpt-5.6-terra` in the Worker
variables, the sandbox defaults and Ace's catalog.

**Why:** `google/gemini-2.5-flash-lite` answers every naming request with a
400: Google AI Studio refuses the 253-value icon enum as "too much branching
for serving". Production names only because its flag already serves Terra, so
any unreachable or absent flag, and every local sandbox, got no names and no
icons. Terra accepts the schema.

**Consequences:** The Gemini fallbacks serve naming only with the plain-string
icon and `reasoningRequired` from the same pull request; see
the naming retirement record in [`workstream-durable-object.md`](workstream-durable-object.md#changelog). A
`.env.local` that sets the key, as one copied from the old `.env.example` does,
outranks the new default until it is edited.

Pull request: [#1099](https://github.com/juno-ai-labs/avalon/pull/1099).

### 2026-10-02 — Reasoning is part of the atomic model route

Operators can set optional `reasoningEffort` in the same variation as the model
and fallbacks, through Ace or the engineering MCP. Import comparisons showed
material timing and cost differences between reasoning levels; requiring a
code deployment for every experiment prevented targeted evaluation. Omission
keeps existing model defaults, explicit task settings win, and the selected
flag effort applies throughout the fallback route.

### 2026-10-02 — The default route moves to GPT-5.6 Terra and Gemini 3.8 Flash

**What changed:** `OPENROUTER_PRIMARY_MODEL` is now `openai/gpt-5.6-terra` and
`OPENROUTER_FALLBACK_MODELS` is `google/gemini-3.8-flash`, in the Worker
variables, the sandbox defaults, and Ace's catalog and seed values for every
role that mirrors them.

**Why:** A team decision to change the default models; its reasoning was not
recorded here.

**Consequences:** The work-stream, inline-child and import roles were
Azure-first on `x-ai/grok-4.3`; `openai/gpt-5.6-terra` has no Azure binding, so
they now reach OpenRouter alone. Ace never overwrites a flag that exists, so
production keeps whatever each `agent-model-*` flag serves until someone edits
it in Ace: changing these defaults moves only an absent or unreachable flag.
Terra accepts image input on OpenRouter, which the import role needs. The
2026-09-11 Sidekick delivery research recorded Terra failing a tool-calling turn
with `completion_defect` three times in a row before the fallback served it;
that fix is deferred, so a role moved onto Terra leans on its fallback for
those turns.

PR #1062.

### 2026-09-17 — Addressing leaves the model-flag catalog

**What changed:** Message addressing no longer has an
`agent-model-addressing-classifier` Flagship role, Worker model variable, Ace
editor row, or provisioning entry. The agent harness owns one fixed JEV primary
and exact DeepSeek/`wafer/fast` fallback as a single measured cascade.

**Why:** The JEV request, `0.5` threshold, fallback model, provider, and low
reasoning effort were evaluated together. Keeping only the fallback model
editable would make the operator surface claim a supported degree of freedom
that invalidates the accuracy and latency evidence behind the cascade.

**Considered and rejected:** Retaining a disabled or empty-default flag for
emergency substitution. An emergency edit would still create an unmeasured
route, while provider failures already take the explicit fallback path and a
real model change can ship as one reviewed constant after evaluation.

**Consequences:** Existing remote copies of the retired flag are inert and may
be deleted independently; runtime code never evaluates them. Ace catalog parity
now guards only genuinely adjustable roles, and addressing model changes require
an eval-backed code change.

### 2026-09-14 — Retire built-in meeting controls

Meeting recording, Control Tower cadence, and the meeting-notes model role were removed because the built-in feature is retired. Dictation uses the existing transcription configuration and has no dependency on these flags. Historical entries below describe earlier releases.

### 2026-09-10 — A substream can carry a model pin, and the model control has one home in every layout

**What changed:** A substream can be pinned to a model when it is created, by
the same developer-mode selector the work-stream launcher has;
`POST …/substreams/confirm` carries it and the child's own row records it. The
object's summary projection now emits `modelOverride`, which
`WorkstreamDetail` has declared and nothing populated, so the locked pill can
fall back to the pin when a run recorded no model. This section is written in
terms of a *conversation* rather than a work stream throughout, because that is
what the column has always belonged to.

The single-row message capsule shows the model pill beside its attachment
button instead of hiding the choice inside that button's menu, and the
capsule's leading grid column sizes to its contents rather than to a fixed
42px.

**Why:** Routing already resolved the pin from the row of the conversation a run
executes in — a substream reads its own row, not its parent's — but nothing
could ever write a substream's, so the column was permanently null there and the
one thing a developer wanted to ask ("what does this branch look like on another
model?") could only be asked by starting a fresh work stream and losing the
branch. The projection gap was the matching half: this document already claimed
`WorkstreamDetail` carried the pin, and a pinned work stream whose run failed
before its first token was being described as following a flag it never
consults.

The control also had two homes depending on the layout *and* the state: a
radio group in the composer-actions menu while a work stream was being started,
and a pill in the toolbar once it existed. The answer to "which model is this?"
therefore moved the moment it stopped being a question, and a substream's
composer — capsule-shaped like every conversation — had nowhere to show a pin at
all.

**Considered and rejected:** Falling back to the parent's row when a substream's
is null, and the equivalent copy-at-creation. Both make a pin travel to work
nobody pinned, and the read-time version adds a second object read to every
unpinned substream's run. Also rejected: emitting the pin from the directory
projection as well, which would put it in every sidebar row to serve one pill.

For the control, keeping the menu for the choice and adding the pill only for
the settled state. That is the same two-homes problem with the seam moved, and
it makes a read-only pill more prominent than the decision it records.

**Consequences:** A substream of a pinned work stream still follows the flag
unless it names a model itself — that is unchanged behaviour, now deliberate
rather than incidental. `modelOverride` is on the per-conversation summary, so
every `get`, create and update response carries it; it is validated with
`agentModelOverride` on the way out, so a retired model reads as unpinned rather
than failing the whole response on the schema.

A row holding only the attachment button still measures 42px, so composers with
no model control are pixel-identical. A composer that does show one gives the
pill its label width out of the text column; the names are short and never
wrap.

### 2026-09-04 — Frozen substream summaries use their recorded route

**What changed:** The structured-inference gateway can execute the explicit
single-model route stored in a substream context recipe. It bypasses Flagship
and default fallbacks for that operation while preserving the gateway's normal
provider, diagnostic and accounting path.

**Why:** A context seed is immutable and retryable. Re-evaluating a targeted
model flag after interruption could generate a different summary under the
same creation receipt.

**Considered and rejected:** Adding a targeted substream-summary model flag,
which would contradict the single platform policy; and constructing a provider
client in the feature, which would fork deadlines and inference evidence.

**Consequences:** Context-policy changes affect new preparation receipts only.
An admitted receipt keeps its exact requested model and has no fallback route.

### 2026-09-03 — The automation compiler and disposition roles are gone

**What changed:** `agent-model-automation-compiler` and
`agent-model-automation-result-disposition` are no longer roles, and
`OPENROUTER_AUTOMATION_MODEL` is no longer a Worker variable. Drafting an
automation is a turn of the work-stream agent in the automation's own
conversation, and a run posts its own result, so both roles lost their caller.
`automation-workspace-templates-enabled` is gone with templates. An
automation's pin lives on its `AutomationDO` row and reaches each run through
`readRunDefinition`; the run-context copy it used to be frozen into no longer
exists.

**Why:** [`automation-lifecycle.md`](automation-lifecycle.md) records the
rebuild; this entry records that two flags whose agents no longer exist were
removed rather than left as dead keys a rollout could target.

**Consequences:** A pinned automation still bypasses the flag on every run, and
the one producer rule still holds; the object's `provisionRun` is that
producer. `workstreamOrigin` remains a targeting attribute but only ever reads
`ad_hoc` now.

### 2026-09-03 — HyperSight flags and model selection are deleted

**What changed:** The client feature flag, Block Dashboard model role, defaults,
Ace editor entry, and runtime resolution were removed. Ace deployment also
deletes the two retired Flagship keys when they still exist.

**Why:** A flag is not a deletion boundary. Keeping one would preserve a
configurable feature contract even when every visible consumer is gone.

**Consequences:** Old flag values cannot reactivate the feature, and repeated
deployments absorb an already-absent key without recreating it.

Shipped in #541.

### 2026-09-02 — GPT-5.6 Sol joins the closed pin list above Terra and Luna

**What changed:** `openai/gpt-5.6-sol` was added to the shared pinnable-model
contract and its desktop presentation, ordered above Terra and Luna. The same
contract-derived order now appears in the new-work-stream developer selector
and in Ace suggestions for roles whose complete execution path is Azure-routed.

**Why:** Sol is the strongest GPT-5.6 family member and is deployed in Rally's
Azure resource, so operators need to be able to pin work streams and choose it
for managed model roles without displaying it below less capable siblings.

**Considered and rejected:** Duplicating Sol in Ace's `MODEL_CHOICES` or in the
pricing worker's selector inventory. Both already derive from
`AGENT_MODEL_OVERRIDES`; the pricing union also already named the Azure
deployment, so the set continues to write one KV record for Sol.

**Consequences:** The model ID is now a valid explicit pin. The selector cannot
know whether the run's target region has the Azure credential pair, so a Sol pin
may still fail closed there. It also fails closed for a PDF/file-parser or audio
turn that the Azure binding does not admit. A work-stream pin is immutable;
recover by starting a new work stream with another model. Its Azure-only
provider policy is owned by the harness rather than this product list: choosing
Sol never authorizes an OpenRouter route for the same model.

### 2026-09-02 — Live application settings outrank an older initial snapshot

**What changed:** The Settings pane and the shared debug-preference hook now
ignore an initial application-settings snapshot if a live change arrives first.
The Settings pane applies the same generation rule to every in-flight mutation
reply and suppresses stale read failures. Causal renderer tests cover stale
off-after-on, stale on-after-off, stale mutation, and stale failure orderings.

**Why:** The main process announces only transitions. A renderer could apply the
new flag value, then overwrite it with the older snapshot it requested while
mounting; later polls saw no transition and therefore never repaired the stale
screen. Relaunching happened to remount the renderer and read the current value.

**Considered and rejected:** Re-broadcasting every successful one-minute poll.
That would mask the ordering error with a delayed repair while continuing to let
old replies overwrite newer state. Adding a revision to the cross-process
contract would order every answer, but the renderer only needs to invalidate
operations already pending when its ordered live stream advances, so a local
generation solves the race without widening the contract.

**Consequences:** A live application-settings event is authoritative over every
older pending read and Settings mutation, including over an older read failure.
Both renderers still accept the initial snapshot when no live event has arrived,
and a mutation reply remains usable when no live event overtook it.

### 2026-09-01 — Serving a flag key is not adding a flag

**What changed:** "Adding a flag" gained an explicit Ace registration step
naming all three edits a product Boolean needs — the contracts key enum, Ace's
`MANAGED_FLAGS` catalog, and the `ensureFlag` call in Ace's deploy script — and
`multiple-workspaces-enabled` was registered in each. Every product Boolean's
key constant is now declared `ProductFeatureFlagKey`, so an unregistered key is
a typecheck error at the declaration. Tests now fail when a product Boolean this
document's client table lists is missing from Ace's catalog, and when a served
key opts out of Ace by not being named `-enabled`.

**Why:** Step 5 previously read "create it in the `avalon-api` app", which
describes an outcome without naming the mechanism that produces it. #464 read
that as satisfied by serving the key from `client-feature-flags.ts`, and the
flag was never created in Flagship. Because the resolver treats a missing flag
and a provisioned-off flag identically, nothing failed and nothing looked
wrong — the feature was simply off for everyone with no way to change it.

**Considered and rejected:** Making the Worker create an absent flag on first
evaluation. That puts flag provisioning on a request path, needs Flagship write
credentials in configured regional Workers where only read access belongs, and would
create a flag with no rule — live and unscoped — at whatever moment the first
poll arrives.

**Consequences:** The failure that used to be silent now fails on the pull
request — at typecheck for anything declared through the shared type, and in
Ace's suite for anything that bypasses it. Flags outside Ace stay outside it by keeping a key that does not end
in `-enabled`; `developer-settings` and `control-tower-refresh-seconds` are the
two, and both keep their Wrangler paths documented here. A flag whose key is
renamed to end in `-enabled` becomes Ace's to manage and must be registered.

### 2026-09-01 — Grok 4.6 and Gemini 3.7 Flash join the pinnable set

**What changed:** `x-ai/grok-4.6` and `google/gemini-3.7-flash` were added to
`AGENT_MODEL_OVERRIDES`, and every family in that list is now ordered **newest
first** — which moved `x-ai/grok-4.6` to the head of the list and `x-ai/grok-4.3`
to the end of its own family. The desktop selector gained the two short names the
menu shows in place of the raw ids.

**Why the ordering:** The selector groups by vendor, so a family's order is what
a reader sees under its heading, and the model somebody is most likely to want
is the one they should not have to scan for. Fixing it as a rule also settles
where the *next* model goes — the top of its family — rather than leaving each
addition to argue the question again.

**Why:** Both models were already reachable by this repository — 4.6 through the
checked-in Monad Azure binding, and both through a flag variation naming them —
but neither could be *pinned*, which is the only way a developer selects a model
per work stream. The gap was in the closed list alone, not in routing.

**What the reorder did break** is prose that had quietly fused two facts: that
`x-ai/grok-4.3` was first in the list, and that it is what
`agent-model-workstream` serves. Step 7 of the desktop model-selector acceptance
procedure in [`e2e.md`](e2e.md) said "pin explicitly to the first listed model"
and expected the trigger to read **Grok 4.3**, which after the reorder pins
Grok 4.6 and waits for a label that never appears. It now names Grok 4.3 as the
flag's default and adds Grok 4.6 as the first entry, so the step proves the
control reads a pin rather than a position. Step 3's model count went the same
way and is now stated as the contract rather than a number.

Reordering was otherwise safe because nothing reads position 0. The contract's own comment
claimed the first entry was what the selector showed before anything was chosen,
and that stopped being true when the unpinned state became a row of its own: the
menu renders `UNPINNED_AGENT_MODEL` above every group and labels it **Default**,
precisely so the renderer never names a model for a variation it cannot see. The
comment and the one test that pinned `AGENT_MODEL_OVERRIDES[0]` to `x-ai/grok-4.3`
were both stale, and both are replaced by the ordering rule.

**Considered and rejected:** Adding the two ids to Ace's `MODEL_CHOICES` and the
pricing worker's `OPENROUTER_PRICING_MODEL_IDS` as well. Both derive from
`AGENT_MODEL_OVERRIDES` and picked the models up from this one edit; writing them
out again would create three lists that can disagree, which is what the derived
shape exists to prevent. `x-ai/grok-4.6` is now named by both the developer list
and `AZURE_DEPLOYED_OPENROUTER_MODEL_IDS`, and the pricing worker's `Set` union
still prices it once.

**Consequences:** The pricing cron now warms two more KV keys per run, one of
them (`google/gemini-3.7-flash`) for a model with no Azure deployment — the
cache covers every developer-selectable id whether or not Azure can serve it, so
that is the list working as intended rather than a stray entry. A pin naming
`x-ai/grok-4.6` inherits its Azure-first route from `agent-harness.md`'s
checked-in binding, so a pinned run there is not OpenRouter-only. A model added
to this list from now on goes at the top of its family; a test enforces that for
every family whose ids carry comparable version numbers, which is all of them
except `gpt-5.6-*` and `deepseek-v4-*`, whose members share a version and are
ordered by hand.

### 2026-08-31 — Multiple-workspace rollout is presentation-only and defaults off

**What changed:** `multiple-workspaces-enabled` is served as
`multipleWorkspacesEnabled`, defaulting to `false`. Electron uses it to expose
the switcher, invitation and creation affordances, and background attention;
the plural server contracts and stored credential set remain active either way.

**Why:** Rollout needs a reversible presentation control without making a flag
an authorization boundary or destroying memberships already created by a newer
client.

**Considered and rejected:** Gating plural onboarding and membership lifecycle
on the same flag. That would make turning presentation off mutate account state
and could strand a credential whose workspace still exists.

**Consequences:** Older clients keep using the singular compatibility workspace,
and newer clients with the flag off open their device-local active workspace.
Server routes must never treat this flag as entitlement.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-30 — The Suggested context model route was retired

**What changed:** `activity_structured` and
`agent-model-activity-structured` were removed from the shared role contract,
ACE catalog, deployment defaults, and this registry.

**Why:** The only consumer was the removed Suggested context classifier. A
model flag without a runnable agent is configuration that falsely appears
operable.

**Considered and rejected:** Leaving the route reserved for a future classifier.
A future feature can introduce a role whose name and default match its actual
contract.

**Consequences:** ACE exposes ten model routes, and no deployment creates the
retired Flagship key.

### 2026-08-28 — One producer copies an automation's pin, from a frozen run context

**What changed:** The three producers that copied `model_override` onto an
automation run's work stream are gone. Acceptance validates the pin against
`AGENT_MODEL_OVERRIDES`, freezes it on the automation's acceptance row, and
copies it into every occurrence's `AutomationRunContextV1`;
`AutomationAgent.provisionNextRun` is the single reader, and it re-validates the
frozen value through `automationModelOverride` before admitting the harness run.

**Why:** The three-producer arrangement is what let a pin reach **Run now** and
silently miss every scheduled and activity-triggered run, and no shared helper
had stopped it, because each producer still wrote the work-stream row itself. The
durable automation lifecycle collapsed run creation to one path, which removes
that whole class of drift. Freezing the pin in the run context follows the rule
the rest of that context follows: a run executes what it was admitted with, not
what the automation says now.

**Considered and rejected:** Re-resolving the *pin itself* per occurrence from
the live acceptance row, which would let an edit change the model of a run that
was already claimed — the thing a pin exists to prevent. Re-validating it against
the closed catalog is the opposite question and is done: a frozen id and a
retired model are different facts, and only the second may change a run.

**Consequences:** Adding a field a run needs means adding it to
`AutomationRunContextV1`, not to the work-stream row; a field added only to the
row does not reach an automation run. `AutomationRunContextV1.modelOverride` is
typed as a plain nullable string on purpose — the context records what was
authorized, and the closed-catalog check belongs at the point of use. A future
path that reads it without calling `automationModelOverride` hands a retired
model to the provider with nothing in the logs naming the pin.

Shipped in the pull request for this change. Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md).

### 2026-08-27 — Memory embeddings are excluded from Flagship routing

**What changed:** Durable-memory query and document embeddings use the fixed
`qwen/qwen3-embedding-8b` OpenRouter model with no fallback models. There is
no `agent-model-memory-embedding` flag, Worker model variable, or Ace editor row.

**Why:** A successful live route change is unsafe here: document and query
vectors produced by independently trained models do not share a semantic space,
even when both outputs have 1,024 dimensions.

**Considered and rejected:** A dedicated flag with an empty default fallback
list. Rules, rollouts, and later operator edits could still change the primary
or add a fallback without atomically rebuilding the corpus.

**Consequences:** Diagnostics still identify the static `memory_embedding`
feature category and intended model. Any future model change must ship with a
durable active-memory requeue rather than through Flagship.

### 2026-08-26 — Ace owns the ordinary default-route edit

**What changed:** Ace now catalogs all model roles and edits the atomic
route plan in each flag's current default variation. Its inputs suggest every
model id already reviewed or checked in, accept another OpenRouter id as free
text after live exact-id and endpoint validation, and keep fallbacks ordered.
The Worker repeats validation before mutation, then the save path reads the live flag before its
full-definition PUT, preserving status, rules, rollout percentages, and staged
variations. Ace deployment also provisions missing model flags from the Worker
defaults.

**Why:** The runtime already centralized every model choice in Flagship, but an
ordinary model change still required remembering opaque role keys and writing
JSON through Wrangler or the provider dashboard. The code knew both what each
role did and what fallback it used; the operator surface did not.

**Considered and rejected:** Giving Ace a second model-routing store. It would
make Ace authoritative only on paper while every run continued to evaluate
Flagship, leaving a synchronization problem on the hottest part of the path.
Flattening a flag to one variation on every save was also rejected because a
default change must not erase a staged regional or workspace rollout.

**Consequences:** Ace is the normal path for fleet-wide default changes;
Wrangler remains the path for adding and rolling out non-default variations.
Model changes do not enter the product-feature notification Queues because no
client caches them and each run evaluates on admission. Adding a role to
the shared `AGENT_MODEL_ROLES` contract now fails Ace's catalog-parity test until
its explanation and checked-in fallback are added to Ace's hard-coded catalog.
Ace and the API also consume one shared route-value schema, including the
runtime's empty fallback default, so a manually authored Flagship value cannot
silently resolve differently in the operator surface. OpenRouter outages fail
model writes closed, preserving the last known route. The Flagship API has no
conditional write primitive, so concurrent edits to one flag remain
last-writer-wins and are diagnosed through its changelog. The selected
five-second OpenRouter deadline prevents a stalled provider connection from
holding either validation or save indefinitely.

### 2026-08-25 — digests-enabled joins the client-visible flags

**What changed:** `digestsEnabled` was added to `ClientFeatureFlagsSchema`
and `client-feature-flags.ts`, resolved through the same
`resolveDigestsEnabled` the entry below already introduced. It is the sixth
Boolean in the client response and the second field overall — after
`controlTowerRefreshSeconds` — that does not default the way the rest of the
schema does.

**Why:** The entry below deliberately drew the line at the server: nothing
about firing a digest needed a value pushed to a connected socket, so
teaching the client about this flag looked like unnecessary scope. It became
necessary once Electron needed to hide the Digest settings section for
someone the flag currently excludes — showing a section that looks active
while silently doing nothing is worse than the scope of reading one more
field.

**Considered and rejected:** Nothing new here beyond what
`digests.md` (retired)'s matching entry already weighs — a "paused"
notice instead of hiding the section outright, and a client-side check
combined from workspace and user facts rather than one evaluation reused.

**Consequences:** This document's tables, the client-visible-flags count, and
the "presentation-only" claim about the four original product Booleans all
now carry the exception. Ace's Queue fan-out on a `digests-enabled` save,
previously a documented no-op for any connected client, now has a real
effect the same way a `hypersight-enabled` save always did.

### 2026-08-25 — A fourth resolver: the digest kill switch

**What changed:** `digest-flags.ts` joins the three resolvers this document
already named, reading a new `digests-enabled` boolean. It fails open, the
same direction as the model flags and for the same reason. It is Ace's fifth
managed flag — the first that is not presentation-only and the first Ace
provisions on rather than off. `docs/ace.md` and the retired `docs/digests.md` (in git history)
carry the full rationale; this document's tables and provisioning walkthrough
now include it alongside the other three resolvers.

**Why:** A subsystem whose default failure direction does not match any
existing resolver needs its own module — the same reasoning that already
separates the other three. Digests are on by default, so failing this flag
closed would make a Flagship outage indistinguishable from an operator
decision to stop sending. It is Ace-managed, despite reading fresh at fire
time rather than needing a push to a connected client, because a second
undiscoverable way to change a Boolean flag is worse than one editor doing
slightly more work than its fan-out strictly needs.

**Consequences:** A caller that wants to know whether digests may fire reads
`digest-flags.ts`, never `env.FLAGS` directly, exactly as every other kind
already requires. The Testing table, the Boundary table, and the Invariants
list here now speak of four resolvers rather than three. Ace's Queue fan-out
now also fires on a flag no client reads, which is harmless: it always
re-evaluates and re-sends the complete client contract regardless of which key
changed.

### 2026-08-24 — Enabled-named product flags push per-user values through WorkspaceDO, and Suggested Work and workspace templates join them

**What changed:** `hypersight-enabled` and `meeting-recording-enabled` join the
client contract as fail-closed Boolean flags. Ace is their write path; a shared
Queue enumerates both regional D1 workspace directories, regional consumers RPC
the owning WorkspaceDO, and each connected user receives a privately evaluated
full flag object. Subscribe returns the same object for reconciliation.

`suggested-work-enabled` and `automation-workspace-templates-enabled` joined
the same Ace-managed Boolean flag set. Electron hides their entry points while
off and avoids view-local reads for surfaces it does not draw. Suggested Work
and workspace-template API routes do not evaluate these flags.

**Why:** Product managers need targeting changes without a deploy, while a
minute poll leaves visible application surfaces stale and one value cannot
represent multiple users in a targeted workspace. The names were made
directional because a bare Boolean name does not say what true means.

Suggested Work and workspace templates need per-person and per-workspace staged
visibility in Electron. The rollout controls whether the application presents
the feature; it is not an entitlement or authorization boundary, so it must not
change server behavior for older clients, integrations, or direct API callers.

**Considered and rejected:** A value-bearing broadcast is wrong for per-user
rules. A permanent desktop poll repeats work while still leaving a delay.
Direct Flagship dashboard edits cannot drive a push because Flagship exposes no
documented outbound notification endpoint.

Enforcing the Suggested Work and template flags on product routes and Electron
action authorities. That would turn a show/hide control into a product
capability gate and make targeted visibility unexpectedly alter API behavior.
Also rejected: stopping Suggested Work generation, because opportunities remain
workspace product state regardless of whether one person's Electron shows them.

**Consequences:** Managed product flags are edited through Ace, Queue/RPC
messages remain key-only, Electron visibility fails closed, and new Boolean
application flags use an Enabled name with an off default. Product API
availability is independent of these flags.

All four flags fail closed until Flagship returns exact `true`. Template update
metadata may still exist on an automation while the flag is off, but Electron
does not expose it. All Suggested Work and workspace-template API operations
remain available. Future consumers may use these flags for Electron visibility
only and must not add server-side action gates.

Earlier reasoning in this document predates the running changelog and was not
reconstructed.

### 2026-08-22 — A preparing work stream is identity, not readable attributes

**What changed:** The first-run model resolver keeps the new work-stream id in
Flagship's evaluation context but asks the attribute loader only for the
already-authoritative workspace facts. Direct object creation and both
scheduled creation paths use that boundary until their product facts commit.
Once creation commits, the ordinary resolver again loads the complete
work-stream attributes.

**Why:** Production Computer Use QA created four fresh private work streams and
all four logged `workstream_runtime_sql_commit_failed` with
`workstream_runtime_authority_fenced` before creation completed. The object had
an identity row, but that row was deliberately still `preparing` while the root,
opening message, and first run were assembled. Model selection tried to read it
through the authoritative runtime port anyway. The attribute loader recovered,
but rules on work-stream facts could not match the first run and its ten-second
failure suppression could also hide the row from an inline child that started
immediately afterward.

**Considered and rejected:** Allowing runtime SQL reads through the preparing
authority fence would expose placeholder `personal`, `restoring`, and null
creator/origin facts as if they described the finished work stream. Splitting
creation so the root becomes authoritative before model selection would expose
an incomplete object and break the atomic root/message/run invariant. Omitting
the work-stream id from the evaluation would avoid the read but also change its
identity and any explicit bucketing rule. Separating the evaluation subject from
the attribute-read subject preserves the identity without inventing facts.

**Consequences:** Workspace-level rules and the recommended workspace-id rollout
remain available on the first run. Rules that require work-stream product facts
begin matching only after creation commits, which is the first point those facts
are authoritative. A future creation path must use this resolver while its root
is preparing or only a bootstrapped runtime shell, rather than relaxing the
runtime authority fence or targeting on placeholder facts.

### 2026-08-20 — Work-stream targeting follows the final authority boundary

**What changed:** Work-stream flag attributes now load product facts such as
title, origin, status, and creator id from the WorkstreamDO execution database,
then resolve only the creator's email domain from regional identity D1. A
final-schema test runs this path with the three-column regional work-stream
anchor.

**Why:** Migration 0090 removes product columns from regional D1. Keeping the
old join would make every work-stream flag silently lose its targeting facts
after deployment even though the authoritative object still had them.

**Considered and rejected:** retaining product columns on the D1 anchor for
flag evaluation. That would preserve a second read model and its synchronization
burden for a latency-tolerant loader that already has an authority-aware object
client.

**Consequences:** Work-stream flag loads cross the authority boundary in two
explicit reads: product state from WorkstreamDO, then optional creator identity
from regional D1. Cache behavior and the three-read evaluation budget are
unchanged.

Entries before the one below were never written. This document predates the
changelog rule in [`module-documents.md`](module-documents.md#starting-one), and
the reasoning behind each failure direction, the attribute boundary, and the
pin's precedence is recorded inline above rather than as dated entries; it was
not reconstructed into them.

Note that a *flag value* change is not a change to this module and gets no entry
here — the Flagship console is the audit record for who was rolled out to and when.

### 2026-08-16 — HyperSight's empty fallback list is a default, not an invariant

**What changed:** `NO_FALLBACK_ROLES` and the `agent_model_flag_fallbacks_ignored`
warning are gone. A `fallbackModels` served by `agent-model-hypersight` is now
honoured exactly as every other role's is. HyperSight still has no fallbacks when
no flag answers — `defaultAgentModelRouting` is unchanged — so nothing moves
until someone edits that flag.

**Why:** the invariant was real but it was enforced in the wrong place, and the
enforcement was invisible. An operator set a three-model fallback list on
`agent-model-hypersight`; the Flagship API accepted it, the console showed it,
and the resolver silently discarded it on every evaluation. The only trace was a
`warn` in Workers Logs that nobody has a reason to read, so the flag and the
behaviour disagreed indefinitely with nothing surfacing the disagreement. A
control that accepts a value and does not apply it is worse than one that has no
value to set.

The product reasoning it protected still holds — a block that routes onward can
change voice between refreshes of one configuration — but that is an argument for
the *default* being empty, which it still is, not for overriding an operator who
has asked for something else. The resolver cannot tell a mistake from a
deliberate choice, and the person editing the flag can. Rejected alternative:
keeping the drop and making it loud (surfacing it in the console or failing the
evaluation) — that still spends an operator's time discovering that a documented,
API-accepted field does nothing, and the flag set is small enough that a
per-role capability table earns nothing over honouring what is served. A future
change that wants a role's plan constrained again should constrain it where it is
*set* rather than where it is read, so the disagreement cannot exist.

### 2026-08-13 — A work stream shows the model it is running on, read off its latest run

**What changed:** The composer inside an existing work stream now shows the model
control too, behind the same **Debug enabled** preference as the launch
composers: the same dropdown, with its trigger `disabled` and its menu
unrendered. It names `latestHarnessRun.model`, falling back to the pin — newly on
`WorkstreamDetail` as `modelOverride` — when a run recorded none.

**Why:** The selector existed only where a model could still be *chosen*, so the
moment a work stream started, the answer to "which model wrote this?" left the
screen — and that question is asked far more often than the pinning one, because
it is asked about every work stream rather than the handful somebody pinned.
Recovering it meant querying D1 by hand for a fact the client was already
holding. The one control anybody had learned to read was the natural place to put
it, so it is the same component, minus the input.

**Considered and rejected:** Showing only the *pin*, the exact mirror of the
composer. It answers for almost nobody: an unpinned work stream — nearly all of
them — would read **Default** forever, which is true and useless, and the flag's
served variation is not visible to a client at all. The run row is the one place
the resolved model is legible from the renderer. Also rejected in the other
direction: showing only the run, and leaving `WorkstreamDetail` alone. A run that
fails before its first token settles with `model` null, and a pinned work stream
described as following the flag is not an incomplete answer but a false one —
which is what the pin fallback exists to prevent, and why it is worth a field on
the wire.

This first shipped as a distinct read-only pill — `aria-disabled`, a lock icon,
no dropdown around it — and was rejected in review for the plainer thing: the
launch composer's own dropdown with `disabled` set. Two renderings of one control
drift, and `aria-disabled` is a control that only claims to be off. The argument
for the first shape was that a disabled button cannot fire a tooltip, and that
turned out to be false here — it does — so the cost was keyboard focus alone.
`.model-selector-trigger.is-settled:disabled` lifts the global `.48` dim to
`.74`, because a 10.5px model name at `.48` cannot be read and being read is the
entire point of showing it.

**Consequences:** The pill can now show an id that is not in
`AGENT_MODEL_OVERRIDES`, because a flag variation may serve any OpenRouter model
— anything reading that string must not assume the closed set. `modelOverride`
is on `WorkstreamSchema`, so every work stream on the wire carries it, and the
mapper narrows an unrecognized stored value to null rather than failing the
response — a model retired from the list must not make the work streams pinned
to it unopenable. Retiring one no longer only affects pins: the work streams that
ran on it keep naming it in the pill, shortened to its model segment, which is
correct — that is what they ran on.
