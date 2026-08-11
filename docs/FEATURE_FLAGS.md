# Feature flags

Avalon evaluates feature flags with [Cloudflare Flagship](https://developers.cloudflare.com/flagship/)
through the `FLAGS` binding on both regional Workers. The binding owns two
things: which OpenRouter model each agent runs on, and which client-visible
features the desktop is allowed to offer. Read this document before adding a
flag, changing an agent's models, or changing what happens when a flag cannot be
evaluated. One thing overrides a flag rather than being one — a work stream
pinned to a single model — and it has [its own
section](#a-work-streams-own-model) below.

Two modules read the binding, one per kind, and nothing else calls `env.FLAGS`
directly:

| Module | Owns | Fails |
| --- | --- | --- |
| `apps/api/src/services/agent-model-flags.ts` | One flag per model-using agent, and the pin that overrides one | **Open** — to the Worker variables, because an agent still has to run |
| `apps/api/src/services/client-feature-flags.ts` | The features the desktop polls | **Closed** — to off, because a client feature has nothing it must do |
| `apps/api/src/services/control-tower-flags.ts` | Control Tower's refresh cadence | **Open** — to the checked-in default, because a cadence has no off |

Failure direction is the reason these are separate modules rather than one
resolver with a parameter. A client feature that fell back the way a model flag
does would ship an unreleased feature on the first Flagship outage; a cadence
that failed closed would leave a recording meeting with no briefing at all,
which is not a safe reading of an outage. Because the pin lives with the model
flags, every answer to "which model does this run use" still comes from one file.

The cadence is the one flag with two readers that must agree: the desktop reads
it through `GET /feature-flags` to set the timer that commits a transcript
segment and asks for the next briefing, and the meeting-notes generator reads it
to tell the model how soon it runs again. Both go through the same module for
that reason — see [`meeting-notes.md`](meeting-notes.md).

`apps/api/src/services/flag-targeting-attributes.ts` is the companion both of
them evaluate through: it turns the ids a caller happens to hold into the
attributes a targeting rule matches on, and it is where the line between a fact
and a person's data is drawn.

## Why a flag rather than a Worker variable

Model selection used to live entirely in `OPENROUTER_*` Worker variables, so
moving one agent to a new model meant editing both regional Wrangler files and
redeploying. Flags decouple the two: a model swap is an audited flag change that
takes effect on the next evaluation, can be staged per region, and can be rolled
out to a percentage of workspaces before it reaches all of them.

The Worker variables stay. They are the checked-in default that every agent
falls back to, so the deployed configuration remains readable in the repository
and Avalon keeps running unchanged when Flagship is unreachable.

## One flag per agent

Every model-using agent owns exactly one flag, keyed `agent-model-<agent>`:

| Agent | Flag key | Default model | Fallback models |
| --- | --- | --- | --- |
| Work-stream agent | `agent-model-workstream` | `OPENROUTER_PRIMARY_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Inline subagent | `agent-model-inline-child` | `OPENROUTER_PRIMARY_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| Automation architect | `agent-model-automation-compiler` | `OPENROUTER_AUTOMATION_MODEL` | `OPENROUTER_FALLBACK_MODELS` |
| HyperSight block | `agent-model-hypersight` | `HYPERSIGHT_MODEL` (`apps/api/src/env.ts`) | none |
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
triggering, contextual routing, the two halves of suggested work, and the
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

HyperSight deliberately has no fallbacks. Its blocks pin one model and never
route onward, so a refresh cannot change voice partway through a configuration.
That invariant is enforced in the resolver rather than left to the flag: a
`fallbackModels` served to `agent-model-hypersight` is dropped and logged as
`agent_model_flag_fallbacks_ignored`, so the flag can retarget the model but
cannot turn routing on.

## Flag value

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

## A work stream's own model

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

It reaches only the work-stream agent. The inline subagent, the automation
architect that drafts the automation, and HyperSight keep their own flags: each
is a distinct agent, and the whole point of giving it a flag was that it can be
moved on its own.

The set of ids a pin may name is closed — `AGENT_MODEL_OVERRIDES` in
`@avalon/contracts` — because a pin bypasses the rollout, so what it can reach
is a reviewed product decision rather than whatever string a client sends. The
API validates it on write and again on read, which is what lets a model be
retired from the list without a migration: the work streams still naming it log
`workstream_model_override_unknown` and return to the flag. `resolveWorkstreamModelRouting`
is the resolver that applies all of this; `resolveAgentModelRouting` stays purely
about flags.

## Evaluation

`resolveAgentModelRouting(env, role, context)` evaluates the agent's flag with
`getObjectDetails`, passing the Worker-variable default as the evaluation
default. The context it sends is the run's identity, plus the attributes
`flag-targeting-attributes.ts` loads for that subject.

### Identity

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

### Attributes

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
immutable in both regions ([`REGIONALIZATION.md`](REGIONALIZATION.md)). It is
absent only for an account predating that control plane, and an absent attribute
does not match, so such an account sits out the rollout rather than landing in
the wrong half of it.

`workspaceOwnerEmailDomain` exists because it is the only domain most
evaluations can have. A work-stream run, a subagent, HyperSight, and the
classifiers carry no `userId` — nobody is asking, the workspace is — so without
the owner's domain no rule could reach a customer's tenancy or the dogfooding
workspaces on the paths that do the most inference.

### What may become an attribute

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

### Freshness and cost

- Facts are cached in the isolate for five minutes, keyed by subject. A
  membership or a slug moves on a human timescale, so the staleness is free and
  a hot agent path does not pay for a read per run.
- A **miss is not cached.** The automation paths resolve a model for a work
  stream id one statement before they insert the row, so remembering "no such
  work stream" would leave those work streams unattributed through their first
  runs. They are unattributed for that first evaluation either way — a fact the
  rows do not yet hold cannot be sent.
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

## Client-visible flags

A client flag decides what the desktop is allowed to *offer*, or how it should
behave. There are two today:

| Flag key | Type | Default | Decides |
| --- | --- | --- | --- |
| `developer-settings` | boolean | `false` | Whether Application → Developer exists on this device |
| `control-tower-refresh-seconds` | number | `60` | How often a recording meeting commits a transcript segment and rewrites its Control Tower briefing |

`GET /feature-flags` serves them all as one object — `{ "developerSettings":
false, "controlTowerRefreshSeconds": 60 }` — resolved for the signed-in person.
It answers under *identity* auth rather than workspace auth: eligibility belongs
to the account, and a device that has not chosen an organization yet still has to
be told the feature is off rather than read a 403 as an outage.

The two are not the same kind of answer, and the response schema says so.
`developerSettings` is a feature and defaults to off. `controlTowerRefreshSeconds`
is a setting with no off: it defaults to the cadence the client would have used
anyway, and both ends read that number from one definition —
`CONTROL_TOWER_REFRESH_SECONDS` in `@avalon/contracts` — so an unreachable
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

The Developer section is for Juno staff, and **that is a Flagship targeting
rule, not a condition in the Worker** — see [the rule the flag is provisioned
with](#provisioning). `client-feature-flags.ts` contains no cohort of its own:
it describes the person, evaluates the flag, and serves the answer. Changing who
gets the section is a flag change with a changelog entry, not a deploy, and the
console shows the whole truth about who is in.

### What a client flag's rules match on

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

### The desktop half

`DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS` in
`apps/desktop/src/main/developer-settings-flag.ts` — one minute — is how long a
flag change takes to reach a running app. The poll lives in the **main
process**, not a renderer, because that is where `application-settings.json` and
the session are, and because both windows then read one answer instead of each
deciding for itself. It is a poll rather than a socket: the only realtime
channel Avalon has is the per-work-stream room, which a device without a work
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
  holds, per [`SECURITY.md`](SECURITY.md). Only an answer, a sign-out, or a
  shutdown turns it off.

## Provisioning

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
[The runbook](RUNBOOK.md#required-hosted-resources) lists the full token
permission set.

Then create one JSON flag per agent, seeded with the model ids currently in the
Wrangler variables so provisioning changes nothing:

```bash
pnpm exec wrangler flagship flags create <APP_ID> agent-model-workstream --type json \
  -V current='{"model":"x-ai/grok-4.3","fallbackModels":["google/gemini-3.6-flash"]}' \
  --default current \
  -d "Work-stream agent OpenRouter models"
```

Repeat for every key in the table above. An agent whose flag does not exist
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

## Changing an agent's models

Add the new plan as a second variation, roll it out, then promote it:

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

## Local development

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

## Adding a flag

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

## Adding an attribute

A rule that needs a fact the table above does not carry gets it from
`flag-targeting-attributes.ts`, never from a call site: callers pass ids, and
one module decides what those ids mean. Add the fact to the loader for its
entity, emit it only when it is known, keep it inside the boundary above, and
add it to the attribute table here. If it needs a read of its own, it needs a
cache entry of its own — three reads is the standing budget for an evaluation.
