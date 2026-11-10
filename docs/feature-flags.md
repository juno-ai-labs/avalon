# Feature flags

Rally resolves product features and agent model routes from centralized constants
in `packages/contracts/src/runtime-config.ts`, with optional Worker environment
variable overrides. Resolution is local and deployment-wide: there is no
Cloudflare Flagship binding, targeting database lookup, or remote flag service.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/runtime-config.ts` | Product defaults, runtime model choices, model-pin and provider catalogs, reasoning defaults, and environment names |
| `apps/api/src/services/client-feature-flags.ts` | Boolean environment parsing for HTTP, workspace subscription, and push delivery |
| `apps/api/src/services/agent-model-flags.ts` | Model environment overrides and conversation pin precedence |
| `apps/api/src/routes/feature-flags.ts` | Identity-authenticated `GET /feature-flags` |
| `packages/contracts/src/index.ts` | Client flag shape, agent roles, complete route schema, and the re-exported model-pin contract |
| `scripts/sync-dev-env.mjs`, `.env.example` | Optional local overrides forwarded to the Worker |

## How it works

### Client-visible flags

The checked-in product defaults are:

| Constant field | Default | Optional environment variable |
| --- | --- | --- |
| `developerSettings` | false | `FEATURE_FLAG_DEVELOPER_SETTINGS` |
| `multipleWorkspacesEnabled` | false | `FEATURE_FLAG_MULTIPLE_WORKSPACES_ENABLED` |
| `pushNotificationsEnabled` | true | `FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED` |

Overrides accept native JSON booleans and numbers `1`/`0`, or their string forms,
ignoring surrounding whitespace and case for strings. Unset or empty values use the constant. Values apply to every user in the
deployment. Product authorization still lives in its ordinary access checks;
presentation flags do not grant access to data or disable API authorization.

Desktop and browser clients keep their existing HTTP and workspace subscription
contracts. A reconnect or subsequent HTTP read picks up deployed configuration.
The old per-user targeting and key-only Queue fan-out are retired. The legacy
`workspace_feature_flags` event remains parseable by clients during rolling
deployments, but the new server does not publish it. Remove that event schema
and desktop handler once all API versions that publish it have been retired;
current clients already refresh through HTTP and subscription snapshots.

### Agent model routing

`AGENT_MODEL_DEFAULTS` holds the common models and ordered fallback list.
`AGENT_MODEL_ENV_KEYS` exhaustively maps each role to its model group:

| Roles | Default model | Shared override |
| --- | --- | --- |
| `canvas`, `sidekick_run` | `openai/gpt-6.1-terra` | `OPENROUTER_PRIMARY_MODEL` |
| `sidekick_wizard`, `memory_sweep` | `openai/gpt-6.1-sol` | `OPENROUTER_SMARTER_MODEL` |
| `resource_naming` | `openai/gpt-6.1-terra` | `OPENROUTER_FASTER_MODEL` |

`OPENROUTER_FALLBACK_MODEL` overrides the default `google/gemini-3.8-flash`
fallback. It is a comma-separated ordered list; an explicitly empty string
selects no fallbacks. Unset variables use the checked-in defaults. An explicitly
empty primary, smarter, or faster model disables that model group and fails
before provider I/O (`agent_model_disabled:<variable>`). The workerd suite uses
this to require an explicit provider double before reaching inference.

For one role, set `AGENT_MODEL_ROUTING_JSON` to a native JSON object or a JSON
string keyed by role. A
role's value replaces its complete route, including ordered fallbacks and
optional `reasoningEffort` (`low`, `medium`, or `high`):

```dotenv
AGENT_MODEL_ROUTING_JSON='{"canvas":{"model":"openai/gpt-6.1-terra","fallbackModels":[],"reasoningEffort":"low"}}'
```

Omitting `fallbackModels` in a role override means no fallbacks. Roles omitted
from the object continue to use their model group. Azure-only GPT-5.6 Sol is
rejected for direct OpenRouter roles (`resource_naming`, `memory_sweep`) in both
primary and fallback slots. Direct Canvas structured calls enforce that same
restriction at their gateway; ordinary Canvas/Sidekick harness calls can use
Azure-only models. Unsupported routes fall back as a whole. Persisted routes
that violate provider policy fail before I/O rather than silently changing models.
Other model IDs remain free-form overrides; the pin catalog is not a provider
availability whitelist. A task's explicit reasoning
setting retains precedence over route-level reasoning. Fixed embedding models keep their existing semantic contracts.

### Other runtime models

The same `@rally/contracts/runtime-config` module owns the model-ID catalog and
fixed choices for search embeddings, JEV classifiers and
completion verification, addressing/continuation fallbacks, image and speech
generation. It also owns Azure deployment names,
pricing catalogs, pin choices, and per-model reasoning defaults. API and harness
modules import these constants; older public imports re-export the same values.
Sol has no forced reasoning default; a caller may still request an explicit effort.
Dictation continues to select its deployment through
`AZURE_OPENAI_REALTIME_DEPLOYMENT`.

Centralizing a value preserves its existing contract: a changed embedding model
requires a reindex. These fixed paths do not inherit the ordinary agent JSON overrides.

### A conversation's own model

A conversation's stored `model_override` takes precedence over deployment
configuration. The closed `AGENT_MODEL_OVERRIDES` list validates pins on write
and read. A pin has no fallbacks: it requests that specific model. An absent
pin uses the conversation role's configured route; an unknown stored pin logs
`workstream_model_override_unknown` and returns to that route.

Pins belong to the conversation that was created with them. A Sidekick run
copies its definition's pin through
`provisionSidekickRun`; its authoring Main and background authoring agents use
`sidekick_wizard`, while occurrences and delegation workers use `sidekick_run`.
Canvas conversations use `canvas`. Scheduled Sidekick admission selects
`sidekick_run` before the run child exists, so its recorded model agrees with
the role the execution resolves. The former `sidekick_authoring` JSON key is
renamed to `sidekick_wizard`; deployments using that override must rename it.
The shared naming-model override is now `OPENROUTER_FASTER_MODEL`; rename any
existing `OPENROUTER_CLASSIFIER_MODEL` deployment variable to the new name.
The fallback override is now `OPENROUTER_FALLBACK_MODEL`; rename any existing
`OPENROUTER_FALLBACK_MODELS` deployment variable as well.
The conversation's served-model pill retains its existing behavior. See
[`automation-lifecycle.md`](automation-lifecycle.md).

## Invariants

- Constants are the default authority; all environment overrides are optional.
- A feature read and an ordinary model resolution perform no external I/O.
- HTTP, workspace subscription, and push delivery use the same Boolean resolver.
- A model route is accepted as a whole, and a conversation pin wins over it.
- Feature configuration contains no per-user or per-workspace targeting rules.
- `AGENT_MODEL_ENV_KEYS` is exhaustive over `AgentModelRole`, checked by TypeScript.

## Boundary

Configuration owns deployment-wide defaults. Authentication and product access
remain with their existing services. Reading a stored conversation pin still
uses its authoritative object. Ace and the engineering MCP no longer offer
remote flag or model-route editing; change constants or deployment variables.

## Failure modes and limits

An invalid Boolean override logs `feature_flag_override_invalid` with the variable
name and uses the constant. A malformed JSON document or invalid selected model
route logs `agent_model_override_invalid` with a field-level diagnostic and uses
the model group's route. No partial model override is applied. Override values
are not included in these diagnostics. There is no propagation delay or remote
flag-service availability requirement.

## Testing

`apps/api/test/client-feature-flags.test.ts` covers defaults, Boolean overrides,
invalid inputs, identical HTTP/socket answers, and the push gate.
`apps/api/test/agent-model-flags.test.ts` covers all role defaults, shared and
per-role overrides, malformed routes, scheduling before object creation, and
stored pin precedence through real SQLite-backed object fixtures. Push delivery
and workspace subscriptions also run through the real workerd suite.
Harness suites exercise classifier/fallback model requests, Azure routing, and
reasoning defaults. API suites cover embedding
identities, image/audio requests, transcription configuration, and pricing.

### Local development

Put optional overrides in `.env.local`, run `pnpm env:sync`, and restart the
Worker. No override or Cloudflare account is needed to use the constants.
Generated `.dev.vars.*` files do not retain superseded model defaults; explicit
empty model and fallback variables are preserved.

### Adding a flag

Add its field to `ClientFeatureFlagsSchema`, its constant and environment name
to `runtime-config.ts`, and its read to the Boolean resolver. Forward the
optional variable in `scripts/sync-dev-env.mjs`, document it in `.env.example`,
and add a behavioral test for its gate. A new agent role must be mapped in
`AGENT_MODEL_ENV_KEYS`; no service provisioning or admin editor is required.

## Changelog

Entries below the 2026-11-09 local-configuration change describe the retired
Flagship design, including the earlier entries from that same date.

### 2026-11-09 — Advance primary and naming defaults to GPT-6.1 Terra

**What changed:** Primary and faster defaults now use `openai/gpt-6.1-terra`.
Canvas and Sidekick runs, plus resource naming, inherit this choice. An unpinned
conversation with no deployment override switches on its next run.

**Why:** The team selected GPT-6.1 Terra for both groups. The comparative quality,
latency, and cost rationale for replacing GPT-5.6 Terra was not recorded here;
this entry does not establish a benchmark advantage.

**Alternatives:** GPT-5.6 Terra remains available through explicit routes and
existing pins. The tradeoff between retaining it as the default and adopting
GPT-6.1 Terra was not recorded.

**What future changes must respect:** Explicit environment routes and
conversation pins retain precedence. The selected model must support naming
with reasoning disabled, sanitized tool calls, and image input without a fallback
masking an unsupported request shape.

**Validation:** Live OpenRouter calls with fallbacks disabled returned a Canvas
title with `reasoningEffort: "none"` and completed a Bind run that identified a
synthetic red image, invoked its sanitized tool, and returned the expected final
answer. The tool fixture included a root union, a nullable field, and a Boolean
enum; this is a compatibility check, not a comparative model benchmark.

### 2026-11-09 — Resolve flags locally from constants and environment overrides

**What changed:** Product flags and model routing use one checked-in configuration
module in the shared contracts package and optional Worker variables. Runtime
model choices, pin/provider catalogs, and reasoning defaults share that module
so both the API and agent harness read one source. Cloudflare evaluation,
targeting lookups, remote administration, provisioning, and Queue-based flag
updates are removed.
Conversation pins and client response contracts are preserved. Primary runs use
Terra, while the smarter model group keeps the Sidekick wizard on Sol. Wizard
and run roles are independently configurable as `sidekick_wizard` and
`sidekick_run`, including scheduling and delegation. The faster model group also
defaults to `openai/gpt-5.6-terra`; explicit deployment and
per-role overrides retain precedence. The unused structured-model constant was
removed with its retired roles. The unused `inline_child` model role and its
logging-source type were also removed because no production caller selects it.
The conversation roles are named `canvas` and `resource_naming`; memory sweeps
share the smarter Sol model with the wizard. Existing JSON overrides must
rename `workstream` to `canvas` and `workstream_naming` to `resource_naming`.

**Why:** Feature configuration should be straightforward to review and run locally,
without depending on Cloudflare's feature flag service. Shared placement lets
the API and harness use the same catalog without importing an application
implementation into a library.

**Considered and rejected:** Keeping remote evaluation as a fallback would retain
the external dependency and two competing sources of configuration. Retaining
staff or workspace targeting would require identity reads on the local flag path;
the selected configuration deliberately applies to everyone in a deployment.
Developer settings and multi-workspace controls therefore no longer have a staff
cohort, and push delivery is controlled through a deployment variable rather than
a live Ace kill switch. The model defaults are the requested new choices, not a
snapshot of live Flagship variations.

**What future changes must respect:** Preserve complete-route validation and pin
precedence and embedding identities. User-specific
authorization belongs to product access services.

### 2026-11-09 — `suggested-work-enabled` and the structured model variable leave

**What changed:** `suggested-work-enabled` left `ProductFeatureFlagKeySchema`,
the served flags object and the API's resolver. The Worker's environment schema
stopped requiring `OPENROUTER_STRUCTURED_MODEL`. The composer's unbuilt `choice`
model control and its menu were deleted, leaving the read-only pill.

**Why:** each had no reader since the pivot (the dead-code PRD, phases 2, 4
and 7).

**Considered and rejected:** removing the variable from Wrangler in the same
deploy; a Worker built before this change requires it at start-up.

**Consequences:** the variable leaves `wrangler.global.jsonc`,
`scripts/sync-dev-env.mjs` and the inference-boundaries lint rule in the next
deploy, followed by `pnpm lint:fresh`. Older desktops parse the flags object
loosely with a false default, so the dropped field reads as off.

Shipped in juno-ai-labs/avalon#1500.

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
the naming retirement record in [`canvases.md`](canvases.md#retired-documents). A
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
