# Feature flags

Rally evaluates feature flags with [Cloudflare Flagship](https://developers.cloudflare.com/flagship/)
through the `FLAGS` binding on both regional Workers. The binding owns two
things: which OpenRouter model each agent runs on, and which client-visible
features the desktop is allowed to offer. Read this document before adding a
flag, changing an agent's models, or changing what happens when a flag cannot be
evaluated. One thing overrides a flag rather than being one — a work stream
pinned to a single model — and it has [its own
section](#a-work-streams-own-model) below.

## Where the code lives

Four modules read the binding, one per kind, and **nothing else calls
`env.FLAGS` directly**:

| Module | Owns | Fails |
| --- | --- | --- |
| `apps/api/src/services/agent-model-flags.ts` | One flag per model-using agent, and the pin that overrides one | **Open** — to the Worker variables, because an agent still has to run |
| `apps/api/src/services/client-feature-flags.ts` | The features the desktop polls | **Closed** — to off, because a client feature has nothing it must do |
| `apps/api/src/services/control-tower-flags.ts` | Control Tower's refresh cadence | **Open** — to the checked-in default, because a cadence has no off |
| `apps/api/src/services/digest-flags.ts` | The `digests-enabled` kill switch | **Open** — to enabled, because a digest already sends by default and an outage must not silently stop it |

Failure direction is the reason these are separate modules rather than one
resolver with a parameter. A client feature that fell back the way a model flag
does would ship an unreleased feature on the first Flagship outage; a cadence
that failed closed would leave a recording meeting with no briefing at all,
which is not a safe reading of an outage; a digest kill switch that failed
closed would turn every digest off on the first Flagship hiccup, which is a
product regression triggered by infrastructure rather than a decision anybody
made. Because the pin lives with the model flags, every answer to "which model
does this run use" still comes from one file.

The cadence is the one flag whose value has to be the *same* value in two places.
The desktop reads it through `GET /feature-flags` and snapshots it for the length
of one meeting; that snapshot then travels with each generate request, so the
prompt describes the schedule the client is actually keeping. The resolver is
consulted server-side only when a request carries no cadence. A flag change
therefore reaches a meeting at its next recording rather than mid-way through one
— see [`meeting-notes.md`](meeting-notes.md).

`apps/api/src/services/flag-targeting-attributes.ts` is the companion all of them
evaluate through: it turns the ids a caller happens to hold into the attributes a
targeting rule matches on, and it is where the line between a fact and a person's
data is drawn.

The rest:

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/flag-targeting-attributes.ts` | Loads the facts, caches them, and holds the line on what may leave the Worker. |
| `apps/api/src/routes/feature-flags.ts` | `GET /feature-flags`, answered under identity auth. |
| `apps/ace` | Access-protected editor and write authority for the managed user-facing product flags. See [`ace.md`](ace.md). |
| `apps/api/src/queues/product-feature-flag-consumer.ts`, `WorkspaceDO.notifyProductFeatureFlagChanged` | Regional key-only fan-out and private per-user socket refresh. |
| `packages/contracts` — `AGENT_MODEL_OVERRIDES`, `CONTROL_TOWER_REFRESH_SECONDS` | The closed set of pinnable models, and the one definition of the cadence both ends read. |
| `apps/desktop/src/main/developer-settings-flag.ts` | The main-process poll and its interval. |
| `apps/desktop/src/renderer/lib/agent-models.ts` | How every model id reads on screen — the menu's names and groups, and the shortening the work stream's read-only pill applies to an id the closed set does not admit. |
| `apps/desktop/src/renderer/components/composer-input.tsx` | The one model control, in both of its shapes: the menu that pins a work stream being started, and the locked pill inside one that already exists. |
| `packages/db/src/index.ts`, `apps/api/src/durable-objects/workstream-object-product.ts` | Where compatibility reads and authoritative object reads re-validate a stored model pin before it reaches routing. |
| `apps/api/wrangler.global.jsonc`, `apps/api/wrangler.eu.jsonc` | The `FLAGS` binding on each deployment. |

## How it works

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

Every model-using agent owns exactly one flag, keyed `agent-model-<agent>`:

| Agent | Flag key | Default model | Fallback models |
| --- | --- | --- | --- |
| Work-stream agent | `agent-model-workstream` | `OPENROUTER_PRIMARY_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Inline subagent | `agent-model-inline-child` | `OPENROUTER_PRIMARY_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Automation architect | `agent-model-automation-compiler` | `OPENROUTER_AUTOMATION_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| HyperSight block | `agent-model-block-dashboard` | `BLOCK_DASHBOARD_MODEL` (`apps/api/src/env.ts`) | none by default; a flag may add them |
| Meeting notes | `agent-model-meeting-notes` | `OPENROUTER_PRIMARY_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Addressing classifier | `agent-model-addressing-classifier` | `OPENROUTER_CLASSIFIER_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Work-stream naming | `agent-model-workstream-naming` | `OPENROUTER_CLASSIFIER_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Activity classifier | `agent-model-activity-structured` | `OPENROUTER_STRUCTURED_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Suggested-work admission | `agent-model-work-opportunity-admission` | `OPENROUTER_STRUCTURED_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Suggested-work ranking | `agent-model-work-opportunity-ranking` | `OPENROUTER_STRUCTURED_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Work-stream description | `agent-model-workstream-description` | `OPENROUTER_STRUCTURED_MODEL` | `OPENROUTER_FALLBACK_MODELS` |

The first five names match the `AgentInferenceSource` values written to the
inference ledger, so a ledger row and a flag key name the same agent. The rest
are the standalone structured-output agents: message addressing uses the
agent-harness classifier helper; work-stream naming, semantic activity
triggering, the two halves of suggested work, and the
work-stream description loop use the bounded structured-inference gateway.
Admission and ranking get separate flags because admission turns connector
activity into prompts while ranking orders them per user, and pinning one should
not move the other.

The description loop is the one role whose default is most likely to want
raising. It reads a window of up to 600 messages and decides whether a work
stream's purpose has moved, which is a harder judgment than the classifiers it
shares a default with — see
[`workstream-descriptions.md`](workstream-descriptions.md). Retarget the flag
rather than changing the shared `OPENROUTER_STRUCTURED_MODEL` variable, which
would move the classifiers with it.

Naming sits at the other end: it relabels one request in a single turn, runs
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

HyperSight has no fallbacks by default. A block that routes onward can change
voice between refreshes of one configuration, so routing is something an
operator turns on for it deliberately rather than the state it starts in. That
is now a **default rather than an invariant**: `agent-model-block-dashboard` may
serve a `fallbackModels` and the resolver honours it exactly as it does for
every other role.

### Flag value

Each flag is a **JSON** flag whose variations carry one agent's whole route
plan, using OpenRouter model ids exactly as OpenRouter publishes them:

```json
{
  "model": "x-ai/grok-4.3",
  "fallbackModels": ["google/gemini-3.6-flash"]
}
```

- `model` — the OpenRouter model id the agent asks for first. Required, non-empty.
- `fallbackModels` — OpenRouter model ids the route plan traverses, in order,
  under Bind's classified failure policy. Optional; omitted means no fallbacks.

The default model and its fallbacks live in **one** flag value rather than two
flags on purpose. A route plan is only meaningful as a whole, so a variation
change is atomic: an agent can never end up serving a new default model against
the previous generation's fallbacks.

### A work stream's own model

One thing sits above the flags: a work stream may be pinned to a single model,
recorded in `workstreams.model_override`. The pin wins, and the flag is not
consulted at all.

The two answer different questions. A flag is a fleet-wide default, rolled out
per workspace, identical for every work stream in it. A pin is somebody asking
what *this* piece of work looks like on some other model — decided once, when
the work stream is created, and not something to stage a rollout for. Precedence
follows from that: a rollout reaching the workspace must not quietly take the
pinned work stream with it.

A pin comes from one place — the model selector in the composers that start work,
which appears only while Application → Developer → **Debug enabled** is on. A new
work stream carries the choice directly; a new automation holds it on the
subscription, and **every** path that creates a run copies it onto that run's
work stream, so a run resolves its model from its own row like every other work
stream. There are three such paths and they are easy to miss: `createRun` in
`automation-service.ts` (manual runs and inbound email), `startAutomation` in
the workspace scheduler (scheduled runs), and `startActivityAutomation` in the
activity queue consumer (connector-activity runs). The last two build the work
stream row inline rather than going through the service, so a new column on it
has to be added to each by hand — a pin that reaches only `createRun` looks
correct under **Run now** and is silently ignored by every scheduled run, which
is how this shipped in review.

Nothing else writes the column, and choosing nothing writes nothing, so an
ordinary work stream is unpinned and reads exactly as this document describes
above. The selector says so plainly: unpinned is its own menu entry, labelled
**Default** and described as following this flag, rather than named after a
model the renderer cannot know is being served.

The pin carries **no fallbacks**. It is a request to observe one specific model,
and routing onward would answer a question nobody asked — the same reasoning
that keeps HyperSight pinned rather than routed.

That leaves a pinned run's route plan with nowhere to traverse when the provider
faults, so recovery has to come from somewhere else: the harness re-executes the
plan against **the same pinned model** after a retriable transport failure, which
keeps the pin's promise while stopping one stalled request from discarding a
whole run. [`agent-harness.md`](agent-harness.md#failure-modes-and-limits) owns
the budget and the failure code. Do not answer a pinned run's provider outage by
adding fallbacks here.

It reaches only the work-stream agent. The inline subagent, the automation
architect that drafts the automation, and HyperSight keep their own flags: each
is a distinct agent, and the whole point of giving it a flag was that it can be
moved on its own.

The set of ids a pin may name is closed — `AGENT_MODEL_OVERRIDES` in
`@rally/contracts` — because a pin bypasses the rollout, so what it can reach
is a reviewed product decision rather than whatever string a client sends. The
API validates it on write and again on read, which is what lets a model be
retired from the list without a migration: the work streams still naming it log
`workstream_model_override_unknown` and return to the flag. `resolveWorkstreamModelRouting`
is the resolver that applies all of this; `resolveAgentModelRouting` stays purely
about flags.

#### Reading it back inside the work stream

The composer of a work stream that already exists shows the same control in the
same place, behind the same **Debug enabled** preference — the identical
dropdown, trigger and pill and chevron, with the trigger `disabled`. That is what
stops it opening, and its menu is left unrendered because a disabled trigger can
never reach one. Disabled rather than merely quiet is the honest shape here: the
pin is written once, when the work stream is created, and nothing afterwards
edits it, so a menu would offer a change the next run would not honour.

The accessible name and the tooltip carry the full model id and say what may
truthfully be said about it, **which is not the same sentence for every work
stream**. A pin is fixed: `resolveWorkstreamModelRouting` finds it on the row and
never reads the flag, so every run uses it. An unpinned work stream re-evaluates
`agent-model-workstream` on *every* launch, so the id shown is what the latest
run happened to resolve and a later run may differ. What is immutable there is
the setting, not the model — an earlier draft of this control said a work stream
keeps the model it started on, which is a stability guarantee the server does
not make for the unpinned majority. The renderer therefore takes `pinned`
alongside the id and picks the claim from it.

The tooltip survives the disable — checked in a real window rather than assumed,
because the reverse is the intuitive guess: a disabled button swallows the click
that would open the menu, but Radix's tooltip is driven by pointer movement that
still reaches it. What the disable does cost is keyboard focus, since Tab skips a
disabled button, which is why the id has to be in the accessible name and not
only in the tooltip.

What it names is **`latestHarnessRun.model` first, and the pin only as a
fallback**. The pin alone would answer for almost nobody: an unpinned work
stream is nearly all of them, and the flag's served variation is not visible to
a client at all — but every parent run records a model, which is the pin where
there is one and the flag's answer where there is not. That column is the only
place a client can see which model a given work stream is actually running. It
follows that the id shown need not be one `AGENT_MODEL_OVERRIDES` admits; the
pill shortens an unknown id to its model segment and the tooltip carries it
whole.

The pin sits behind it because of one case the run cannot cover. The column is
written twice: `launchWorkstreamHarness` records the model it resolved at
schedule time, and the run host may overwrite it at settle — while its lease is
live and before terminalization — with the model that actually streamed. A run
that failed before its first token streams nothing, so that second write puts
**null** there. On a pinned work stream that is exactly where a run-only pill
would fall back to **Default** and describe it as following a flag it never
consults. `WorkstreamDetail` therefore carries `modelOverride`, re-validated
against the closed set on the way out exactly as `resolveWorkstreamModelRouting`
re-validates it, and the pill reads it when the run has nothing to say. Only a
work stream that is both unpinned and has no recorded model reads **Default**,
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
| `region` | `AVALON_REGION` — `global` or `eu` |
| `appEnv` | `APP_ENV` |
| `workspaceId` | Present wherever the caller knows it; the right key for percentage rollouts |
| `workstreamId` | Present on work-stream, subagent, HyperSight, and classifier evaluations |
| `userId` | Present on automation-compiler, meeting-notes, and work-stream naming evaluations |

Identity wins over attributes: the loaded facts are spread underneath these, so
nothing read from D1 can redefine the id a percentage rollout buckets on.

#### Attributes

Ids alone cannot express a rule anybody would want to write. Nobody targets a
uuid; they target the dogfooding workspace, the teams rather than the solo
accounts, the work streams a person started rather than the ones an automation
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
| `workstreamOrigin` | string | `ad_hoc` or `automation` | `workstreamId` |
| `workstreamScope` | string | `personal` or `workspace` — who may read it | `workstreamId` |
| `workstreamCreatedByUserId` | string | Who created it; absent when an automation did | `workstreamId` |
| `workstreamCreatorEmailDomain` | string | That person's email domain | `workstreamId` |
| `workstreamFromOpportunity` | boolean | Whether it was started from a suggested work item | `workstreamId` |
| `workstreamIsSystem` | boolean | Whether it is machinery (`system_kind`), such as a digest's work stream | `workstreamId` |

An attribute whose fact is unknown is **omitted rather than sent empty**, so a
rule can never match a placeholder. The consequence worth knowing: a rule on an
attribute that was not sent silently never matches, which is why
`agent_model_flag_resolved` and `client_flag_resolved` log the attribute *names*
that were sent.

`userPlatformId` is the one to reach for when a rollout is per *person* rather
than per workspace. `userId` names a regional `users` row, and one person with
workspaces in both regions has one in each — bucketing on it would place them in
a different bucket per region and hand them a half-rolled-out feature on one of
them. The platform id is established once by the Global control plane and is
immutable in both regions ([`regionalization.md`](regionalization.md)). It is
absent only for an account predating that control plane, and an absent attribute
does not match, so such an account sits out the rollout rather than landing in
the wrong half of it.

`workspaceOwnerEmailDomain` exists because it is the only domain most
evaluations can have. A work-stream run, a subagent, HyperSight, and the
classifiers carry no `userId` — nobody is asking, the workspace is — so without
the owner's domain no rule could reach a customer's tenancy or the dogfooding
workspaces on the paths that do the most inference.

#### What may become an attribute

An attribute leaves the Worker on every evaluation and lands in a flag-targeting
system that is not a place for anyone's data. The line is therefore drawn at the
loader, not at the rule author's discretion:

- **Yes** — ids, counts, ages, the enums the schema itself declares
  (`origin_type`, `scope`, `role`), and the **domain** half of an email address.
- **No** — a person's name, a full email address or its local part, a work
  stream's title or objective, a note, a message, a prompt, or anything else a
  person wrote.
- **One carve-out: `workspaceSlug`.** It is user-authored text — the workspace
  name typed at onboarding, slugified, with eight characters of the workspace id
  appended (`workspace-service.ts`) — so it can name a company, a team, or, on a
  solo account, a person, and it crosses from both regions. It is sent anyway,
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
- A **miss is not cached.** The automation paths resolve a model for a work
  stream id one statement before they insert the row, so remembering "no such
  work stream" would leave those work streams unattributed through their first
  runs. They are unattributed for that first evaluation either way — a fact the
  rows do not yet hold cannot be sent.
- A brand-new Durable Object keeps its work-stream id in the first model
  evaluation for identity and bucketing, but loads only workspace attributes
  until the atomic authoritative root, opening message, and first run commit.
  Querying work-stream facts while the root is still `preparing` is not a miss:
  it crosses the authority fence, logs an operational error, and suppresses the
  now-readable row for ten seconds. Later runs load the complete work-stream
  attributes normally.
- Scheduled creation uses the same resolver. The activity consumer selects its
  model before runtime bootstrap, when a work-stream read would hit the fence;
  automation creation selects after bootstrap but before its product insert,
  when the authoritative shell still carries placeholder facts. Neither state
  is a valid targeting subject.
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
behave. There are seven today:

| Flag key | Type | Default | Decides |
| --- | --- | --- | --- |
| `developer-settings` | boolean | `false` | Whether Application → Developer exists on this device |
| `hypersight-enabled` | boolean | `false` | Whether Electron shows HyperSight surfaces |
| `meeting-recording-enabled` | boolean | `false` | Whether Electron shows meeting-recording actions |
| `suggested-work-enabled` | boolean | `false` | Whether Electron shows Suggested Work surfaces |
| `automation-workspace-templates-enabled` | boolean | `false` | Whether Electron shows workspace-template surfaces |
| `digests-enabled` | boolean | `true` | Whether Electron shows the Digest settings section — resolved through `digest-flags.ts`, the same function that gates delivery; see [`digests.md`](digests.md#the-run) |
| `control-tower-refresh-seconds` | number | `60` | How often a recording meeting commits a transcript segment and rewrites its Control Tower briefing |

`GET /feature-flags` serves them all as one object — `{ "developerSettings":
false, "hypersightEnabled": false, "meetingRecordingEnabled": false,
"suggestedWorkEnabled": false, "automationWorkspaceTemplatesEnabled": false,
"digestsEnabled": true, "controlTowerRefreshSeconds": 60 }` — resolved for the
signed-in person. It answers under *identity* auth rather than workspace auth:
eligibility belongs to the account, and a device that has not chosen an
organization yet still has to be told the feature is off rather than read a
403 as an outage. `digestsEnabled` is the exception to "not chosen yet reads
as off": with no workspace to evaluate against, it reads `true`, the same gap
every other absence in this flag's evaluation resolves to.

The fields are not all the same kind of answer, and the response schema says
so. Five of the six Boolean features default to off; `digestsEnabled` is the
one exception, for the same reason it is discussed on its own below.
`controlTowerRefreshSeconds` is a setting with no off: it defaults to the
cadence the client would have used anyway, and both ends read that number
from one definition —
`CONTROL_TOWER_REFRESH_SECONDS` in `@rally/contracts` — so an unreachable
Flagship, an older service, and the desktop fallback cannot disagree. The
resolver clamps what Flagship serves to that range before serving it, because
every refresh is an inference: a flag typed in milliseconds would otherwise turn
one meeting into thousands of runs. A clamp logs
`control_tower_refresh_flag_clamped` rather than passing quietly.

The desktop reads the cadence from the **renderer** that acts on it — the
meeting screen, once when it opens — rather than through the main-process poll
below. A meeting window exists for one meeting, and a cadence that changed
underneath a recording would move the transcript's own segment boundaries
mid-conversation.

The managed product Boolean names deliberately end in **Enabled**, as do their
camel-case response fields. `true` therefore always means the surface may be
shown and `false` means it is hidden; no caller has to infer whether a bare name
means disabled, hidden, or selected.

The four original managed product Booleans are presentation-only. Only
Electron consumes them to show or hide product surfaces; the API routes and
underlying product capabilities do not evaluate them. They are rollout
controls for discovery and visibility, not authorization, entitlements, or
server-side kill switches. A hidden Suggested Work surface may skip its own
fetch and impressions because nothing was drawn, but the Suggested Work API
remains available. The same rule applies to workspace-template,
meeting-recording, and HyperSight operations.

**`digestsEnabled` breaks that pattern on purpose.** As a client field it is
presentation-only exactly like the other five — Electron shows or hides a
settings section, nothing else changes. But the Flagship flag behind it,
`digests-enabled`, is not merely a rollout control: `fireDigestSchedule`
reads the identical flag to decide whether to actually send. A hidden
Suggested Work surface sits above a live API; a hidden Digest section sits
above delivery that has genuinely stopped. This is one evaluation read from
two places, not a presentation flag that happens to share a name with a
kill switch elsewhere.

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
appears. `workspaceId` is present only once an organization has been chosen.

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

The four managed product Booleans arrive on the private
WorkspaceDO subscribe response and on `workspace_feature_flags` events. They
replace the renderer's one `['feature-flags']` cache as a complete object; a
partial event cannot leave a mixed generation behind. Reconnect always
re-evaluates them even if a live notification was missed.

Ace delays fan-out for 30 seconds because Cloudflare documents that Flagship
configuration changes can take
[up to 30 seconds to propagate](https://developers.cloudflare.com/flagship/concepts/).
The regional object evaluates after that delay; it does not trust a value from
the administrative write response.

HyperSight hides its header control and panel until the value is exactly true;
because the panel is not mounted, its view-local query and sockets naturally do
not run. Meeting recording hides its actions in the sidebar, macOS menu, and
meeting screen. Neither flag is checked by an API route or by the Electron IPC
handler that performs an already-selected action.

`DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS` in
`apps/desktop/src/main/developer-settings-flag.ts` — one minute — is how long a
flag change takes to reach a running app. The poll lives in the **main
process**, not a renderer, because that is where `application-settings.json` and
the session are, and because both windows then read one answer instead of each
deciding for itself. It is a poll rather than a socket: the only realtime
channel Rally has is the per-work-stream room, which a device without a work
stream open is not connected to, and a flag change is not worth a second
channel. A sign-in re-asks immediately rather than waiting out the interval; a
sign-out closes the section on the way past.

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

- **Nothing calls `env.FLAGS` outside the three resolvers.** They exist as
  separate modules because they fail in opposite directions; a shared resolver
  with a parameter is one place for that direction to be chosen wrongly.
- **Model flags fail open, client feature flags fail closed, the cadence falls
  back to the checked-in default, and the digest kill switch fails open too.**
  A client feature that failed open would ship an unreleased feature on the
  first Flagship outage; a cadence that failed closed would leave a recording
  meeting with no briefing at all; a digest kill switch that failed closed
  would stop every digest on the first Flagship hiccup.
- **A route plan is one flag value, never two flags.** A variation change is
  atomic, so an agent can never serve a new default model against the previous
  generation's fallbacks.
- **A malformed variation is rejected whole, never merged field by field.**
- **A work stream's pin wins and the flag is not consulted at all.** A rollout
  reaching the workspace must not quietly take a pinned work stream with it.
- **Every path that creates a run copies `model_override` onto that run's work
  stream.** There are three, and two of them build the row inline rather than
  going through the service: `createRun`, the scheduler's `startAutomation`, and
  the activity consumer's `startActivityAutomation`. A pin that reaches only
  `createRun` looks correct under **Run now** and is silently ignored by every
  scheduled run — which is how it shipped in review.
- **A pin carries no fallbacks.** It is a request to observe one specific model,
  and routing onward would answer a question nobody asked. A provider fault on a
  pinned run is recovered by retrying that same model, never by widening the
  route — see [`agent-harness.md`](agent-harness.md#failure-modes-and-limits).
- **The set of pinnable ids is closed** (`AGENT_MODEL_OVERRIDES`), validated on
  write *and* on read, which is what lets a model be retired without a migration.
- **Identity is spread over the loaded attributes, never under them**, so nothing
  read from D1 can redefine the id a percentage rollout buckets on.
- **An attribute whose fact is unknown is omitted rather than sent empty**, so a
  rule can never match a placeholder. The consequence is that a rule on an
  attribute that was not sent silently never matches — which is why
  `agent_model_flag_resolved` and `client_flag_resolved` log the attribute *names*
  that were sent.
- **Bucket a per-person rollout on `userPlatformId`, never `userId`.** `userId`
  names a regional row, and one person with workspaces in both regions has one in
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
- **Product Boolean flag names explain true.** `hypersight-enabled` and
  `meeting-recording-enabled` map to `hypersightEnabled` and
  `meetingRecordingEnabled`; a bare or negatively named Boolean invites one
  layer to invert another.
- **A product-flag notification carries a key, never a value.** Two people in
  one workspace may match different rules, so WorkspaceDO evaluates each user
  before sending a private event. The subscribe response is the repair path.
- **Ace is the managed product-flag write path.** Flagship has no documented
  webhook or Queue notification surface; a dashboard edit changes evaluation
  but cannot wake connected Avalon clients.
- **The cadence has one definition** — `CONTROL_TOWER_REFRESH_SECONDS` in
  `@rally/contracts` — read by the resolver, the service default, and the desktop
  fallback, and the resolver clamps what Flagship serves to that range before
  serving it. Every refresh is an inference; a flag typed in milliseconds would
  otherwise turn one meeting into thousands of runs.
- **Evaluation is per run, not per model turn.** A flag change reaches an
  in-flight run only at its next admission.

## Boundary

This document owns the `FLAGS` binding, the four resolvers, the attribute loader,
and the one thing that overrides a flag. It does not own the agents themselves or
what they do with the model they are handed:

| For | Read |
| --- | --- |
| Why digests need a kill switch, and exactly where it is checked | [`digests.md`](digests.md#the-run) |
| The run loop, the route plan's failure policy, the inference ledger | [`agent-harness.md`](agent-harness.md) |
| The `model_override` column and where it is copied | [`data-model.md`](data-model.md) |
| The cadence's other half, and what a snapshot travels with | [`meeting-notes.md`](meeting-notes.md) |
| Why **Debug enabled** crosses no trust boundary | [`security.md`](security.md) |
| Why `userPlatformId` is the stable per-person id | [`regionalization.md`](regionalization.md) |
| The description loop that most wants its default raised | [`workstream-descriptions.md`](workstream-descriptions.md) |
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
  cached**: the automation paths resolve a model for a work-stream id one statement
  before they insert the row, so remembering "no such work stream" would leave those
  work streams unattributed through their first runs.
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
- **A `fallbackModels` served to `agent-model-block-dashboard` is honoured**, like every
  other role's. HyperSight's empty fallback list is the checked-in default, not a
  resolver invariant.
- **A clamped cadence logs `control_tower_refresh_flag_clamped`** rather than
  passing quietly.
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
| `apps/api/test/agent-model-flags.test.ts` | Each resolver's failure direction, the four unresolved cases, the zod rejection, and that HyperSight honours its flag's fallbacks like every other role. |
| `apps/api/test/agent-model-override.test.ts` | Pin precedence, the closed id set validated on write and read, and the three run-creation paths that must copy the column. |
| `apps/api/test/client-feature-flags.test.ts` | That everything but an explicit `true` resolves to off, and that the cadence is clamped to `CONTROL_TOWER_REFRESH_SECONDS`. |
| `apps/api/test/digest-flags.test.ts` | That everything but an explicit `false` resolves to enabled — the one resolver in this table that fails toward `true`. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | Initial private values and per-user live re-evaluation over a real hibernating WebSocket. |
| `apps/ace/test` | Safe rule vocabulary and Flagship limits, signed-site failure behavior, key-only notification, and cross-region Queue fan-out. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx` | Initial and live full-contract replacement in the feature-flag cache. |
| Desktop menu, sidebar, work-stream, and meeting suites | Every visible entry point remains hidden until explicitly enabled while product actions remain otherwise unchanged. |
| `apps/api/test/flag-targeting-attributes.test.ts` | The attribute vocabulary, the omitted-not-empty rule, the cache and its negative cases, and — scoped to the fields the rule covers — that no local part or authored text leaves the Worker. |
| `apps/desktop/src/main/developer-settings-flag.test.ts` | The poll, the last-answer-standing behavior, and that a stored `debugEnabled` grants nothing while the flag is off. |
| `apps/desktop/src/renderer/screens/new-workstream.test.tsx` | The selector's **Debug enabled** gate, that an untouched control sends no override, and that an explicit pin to the flag's own default is still sent. |
| `apps/desktop/src/renderer/components/workstream-composer.test.tsx` | The locked pill inside a work stream: the same gate, the run's model ahead of the pin, the pin where a run recorded none, an id outside the closed set, and that it opens no menu. |
| `apps/api/test/workstream-row-contracts.test.ts` | That the stored pin is re-validated on read, and that a retired model reads as unpinned rather than failing the response. |

Run one with
`pnpm --filter @rally/api exec vitest run test/agent-model-flags.test.ts` — the
path is package-relative.

Two traps. Flagship is unreachable in local development and test, which is the
*expected* state, so a suite that asserts a flag resolved is really asserting the
fallback; stub the binding rather than relying on the environment. And the
attribute test is deliberately scoped to the fields its rule covers rather than
asserting over the whole payload — a broad assertion passes by accident on the
`workspaceSlug` carve-out.

## Operations

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

What both regions do send this one app is the evaluation context, and since the
attributes above it carries facts about EU workspaces, work streams, and people
as well as Global ones. That is the reason the attribute boundary is drawn where
it is rather than left to whoever adds the next rule: what crosses is a slug, a
count, an age, a schema-declared enum, an id, and an email domain — never a
name, an address, or anything a person wrote. Widening that set is a data
decision about both regions at once, not a local change to a loader.

Ace automatically ensures all eleven `agent-model-*` JSON flags plus
`hypersight-enabled`, `meeting-recording-enabled`, `suggested-work-enabled`,
`automation-workspace-templates-enabled`, and `digests-enabled` exist on every
merge-to-main deployment. It seeds model flags from the checked-in Worker
defaults and does not overwrite an existing definition. Every product flag
defaults off except
`digests-enabled`, which defaults **on** — a digest already sends by default
for every existing person, so provisioning it must not be the thing that
silently stops delivery; see [`digests.md`](digests.md#the-run). Once created,
edit product flags and each model flag's current default route through Ace
rather than the Flagship dashboard: Flagship's
documented API has no outbound change webhook, so only Ace performs the Queue
fan-out that wakes connected clients — including for `digests-enabled`, whose
save now reaches a client the same way the presentation flags' do, serving
`digestsEnabled` in the `GET /feature-flags` response the way any other field
here is served. [`ace.md`](ace.md) owns that release and recovery path.

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

Ace's deployment normally creates one JSON flag per agent, seeded with the model
ids currently in the Wrangler variables so provisioning changes nothing. If a
fresh account is being assembled outside that release path, the equivalent
manual command is:

```bash
pnpm exec wrangler flagship flags create <APP_ID> agent-model-workstream --type json \
  -V current='{"model":"x-ai/grok-4.3","fallbackModels":["google/gemini-3.6-flash"]}' \
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

Then the cadence, seeded at the checked-in default so provisioning changes
nothing. It is served to everyone rather than scoped by a rule — it is a tuning
knob, not a feature somebody is let into — so it is created with no rules and
retargeted only to stage a change:

```bash
pnpm exec wrangler flagship flags create <APP_ID> control-tower-refresh-seconds --type number \
  -V current=60 \
  --default current \
  -d "Seconds between Control Tower refreshes while a meeting records. 15-600; the service clamps"
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
both regions twice. There is no workspace worth keeping consistent here, because
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

To stop every digest, use Ace to set `digests-enabled` to off, or reach it
directly with `wrangler flagship flags set <APP_ID> digests-enabled -V off`. To
stop delivery for one cohort while everyone else keeps sending, add a rule
that serves `off` to that cohort and leave the default at `on` — the inverse
of how `developer-settings` reaches staff — either in Ace's editor or with
`wrangler flagship flags update <APP_ID> digests-enabled --add-rule "serve=off; when=workspaceOwnerEmailDomain equals example.com"`.
`wrangler flagship flags changelog <APP_ID> digests-enabled` is the audit trail
for who turned digests off and when regardless of which surface made the
change. See [`digests.md`](digests.md#the-run) for why this flag exists and
why it fails open rather than closed.

### Changing an agent's models

For a fleet-wide default change, use Ace → **Models**. Choose one of the known
model ids or enter any OpenRouter id, edit the ordered fallback array, and save.
Ace validates every id against OpenRouter's live endpoints while it is edited
and repeats the check immediately before the Flagship write. An unknown id, an
id without a current route, or an unavailable validation service leaves the
existing flag unchanged.
Ace replaces only the current default variation's atomic `{ model,
fallbackModels }` plan after reading the live flag; it preserves the flag's
status, targeting rules, rollout percentages, and every staged variation.

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
keeps every agent in a workspace on one generation, so a work-stream run and the
subagents and classifiers around it stay consistent.

Because both regions share the app, a rollout reaches both unless you scope it.
To stage one region first, target `region` instead:

```bash
pnpm exec wrangler flagship flags update <APP_ID> agent-model-workstream \
  --add-rule "serve=next; when=region equals eu"
```

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
work-stream agent on the old variation, which is rarely what a rollout means to
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
   module alongside them otherwise. Keep `env.FLAGS` out of call sites.
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
5. Add the flag to the table above and create it in the `avalon-api` app,
   together with the rules that scope it. There is one app for both regions, so
   it is created once — and a flag created without its rule is live and
   unscoped until the rule lands.

### Adding an attribute

A rule that needs a fact the table above does not carry gets it from
`flag-targeting-attributes.ts`, never from a call site: callers pass ids, and
one module decides what those ids mean. Add the fact to the loader for its
entity, emit it only when it is known, keep it inside the boundary above, and
add it to the attribute table here. If it needs a read of its own, it needs a
cache entry of its own — three reads is the standing budget for an evaluation.

## Changelog

### 2026-08-26 — Ace owns the ordinary default-route edit

**What changed:** Ace now catalogs all eleven model roles and edits the atomic
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
`AGENT_MODEL_ROLES` now also requires adding its explanation and checked-in
fallback to Ace's hard-coded catalog. OpenRouter outages fail model writes
closed, preserving the last known route.

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
[`digests.md`](digests.md)'s matching entry already weighs — a "paused"
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
provisions on rather than off. `docs/digests.md#the-run` and `docs/ace.md`
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

### 2026-08-24 — Suggested Work and workspace templates become managed product flags

**What changed:** `suggested-work-enabled` and
`automation-workspace-templates-enabled` joined the Ace-managed Boolean flag
set. Electron hides their entry points while off and avoids view-local reads for
surfaces it does not draw. Suggested Work and workspace-template API routes do
not evaluate these flags.

**Why:** These features need per-person and per-workspace staged visibility in
Electron. The rollout controls whether the application presents the feature; it
is not an entitlement or authorization boundary, so it must not change server
behavior for older clients, integrations, or direct API callers.

**Considered and rejected:** Enforcing the same flags on product routes and
Electron action authorities. That would turn a show/hide control into a product
capability gate and make targeted visibility unexpectedly alter API behavior.
Also rejected: stopping Suggested Work generation, because opportunities remain
workspace product state regardless of whether one person's Electron shows them.

**Consequences:** Both flags fail closed until Flagship returns exact `true`.
Template update metadata may still exist on an automation while the flag is off,
but Electron does not expose it. All Suggested Work and workspace-template API
operations remain available. Future consumers may use these flags for Electron
visibility only and must not add server-side action gates.

### 2026-08-24 — Enabled-named product flags push per-user values through WorkspaceDO

**What changed:** `hypersight-enabled` and `meeting-recording-enabled` join the
client contract as fail-closed Boolean flags. Ace is their write path; a shared
Queue enumerates both regional D1 workspace directories, regional consumers RPC
the owning WorkspaceDO, and each connected user receives a privately evaluated
full flag object. Subscribe returns the same object for reconciliation.

**Why:** Product managers need targeting changes without a deploy, while a
minute poll leaves visible application surfaces stale and one value cannot
represent multiple users in a targeted workspace. The names were made
directional because a bare Boolean name does not say what true means.

**Considered and rejected:** A value-bearing broadcast is wrong for per-user
rules. A permanent desktop poll repeats work while still leaving a delay.
Direct Flagship dashboard edits cannot drive a push because Flagship exposes no
documented outbound notification endpoint.

**Consequences:** Managed product flags are edited through Ace, Queue/RPC
messages remain key-only, Electron visibility fails closed, and new Boolean
application flags use an Enabled name with an off default. Product API
availability is independent of these flags. Earlier reasoning in this document
predates the running changelog and was not reconstructed.

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

### 2026-08-18 — The HyperSight model flag adopts its BlockDashboard role

**What changed:** The HyperSight block runtime now evaluates the
`block_dashboard` role through `agent-model-block-dashboard`, with
`BLOCK_DASHBOARD_MODEL` as its no-fallback default.

**Why:** Flag identity is operational, so it must match the internal agent,
telemetry source, and SQL origin rather than the product label.

**Considered and rejected:** Retaining `agent-model-hypersight` as an alias.
This flag surface has not shipped, and an alias would make targeting and audit
history ambiguous.

**Consequences:** Internal dogfood environments must provision the renamed flag.
The user-facing feature and any product copy continue to say HyperSight.

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
