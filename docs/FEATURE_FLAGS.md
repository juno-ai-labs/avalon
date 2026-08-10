# Feature flags

Avalon evaluates feature flags with [Cloudflare Flagship](https://developers.cloudflare.com/flagship/)
through the `FLAGS` binding on both regional Workers. Today the binding owns one
thing: which OpenRouter model each agent runs on. Read this document before
adding a flag, changing an agent's models, or changing what happens when a flag
cannot be evaluated.

`apps/api/src/services/agent-model-flags.ts` is the only module that reads the
binding. Nothing else calls `env.FLAGS` directly.

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
| Activity classifier | `agent-model-activity-structured` | `OPENROUTER_STRUCTURED_MODEL` | `OPENROUTER_FALLBACK_MODELS` |

The first five names match the `AgentInferenceSource` values written to the
inference ledger, so a ledger row and a flag key name the same agent. The last
two are the standalone structured-output classifiers — message addressing, and
semantic activity triggering plus contextual routing — which call OpenRouter
directly rather than through the harness.

HyperSight deliberately has no fallbacks. Its blocks pin one model and never
route onward, so a refresh cannot change voice partway through a configuration.

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

## Evaluation

`resolveAgentModelRouting(env, role, context)` evaluates the agent's flag with
`getObjectValue`, passing the Worker-variable default as the evaluation default.
The evaluation context carries the attributes targeting rules may match on:

| Attribute | Value |
| --- | --- |
| `agent` | The role key, e.g. `workstream` |
| `region` | `AVALON_REGION` — `global` or `eu` |
| `appEnv` | `APP_ENV` |
| `workspaceId` | Present wherever the caller knows it; the right key for percentage rollouts |
| `workstreamId` | Present on work-stream, subagent, HyperSight, and classifier evaluations |
| `userId` | Present on automation-compiler and meeting-notes evaluations |

Three failures resolve to the same place — the Worker variables:

- **No binding.** `env.FLAGS` is undefined, which is the normal state in local
  development (see below).
- **Failed evaluation.** The call throws or the flag does not exist. Logged as
  `agent_model_flag_unavailable`.
- **Malformed value.** The served variation fails the zod schema. Rejected
  whole — never merged field by field — and logged as `agent_model_flag_invalid`.

`resolveAgentModelRouting` never throws, so a Flagship outage can never fail an
agent run.

Evaluation is per run, not per model turn. A flag change reaches an in-flight
run only at its next admission; runs already streaming keep the plan they
started with. `harness_runs.model` records the model a scheduled run is expected
to use, resolved from the same flag at schedule time — a flag changed between
scheduling and execution makes that column an expectation rather than a
guarantee. The inference ledger records what each attempt actually used.

## Provisioning

Both regional Workers declare the binding without an `app_id`:

```jsonc
"flagship": [
  { "binding": "FLAGS", "remote": true }
]
```

Each region binds its own Flagship app so a model rollout can be staged per
region. Create the app and let Wrangler write the id back:

```bash
pnpm exec wrangler flagship apps create "avalon-api-global" \
  --binding FLAGS --update-config --config apps/api/wrangler.global.jsonc
pnpm exec wrangler flagship apps create "avalon-api-eu" \
  --binding FLAGS --update-config --config apps/api/wrangler.eu.jsonc
```

Wrangler also provisions an app automatically on the first deploy of a binding
that has no `app_id`, and writes the id into the configuration file either way.
Commit the resulting `app_id` values.

Then create one JSON flag per agent, seeded with the model ids currently in that
region's Wrangler variables so provisioning changes nothing:

```bash
pnpm exec wrangler flagship flags create <APP_ID> agent-model-workstream --type json \
  -V current='{"model":"x-ai/grok-4.3","fallbackModels":["google/gemini-3.6-flash"]}' \
  --default current \
  -d "Work-stream agent OpenRouter models"
```

Repeat for every key in the table above. An agent whose flag does not exist
keeps running on its Worker variables, so the flags may be created one at a
time.

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

To revert, `set` the flag back to the previous variation. Flagship keeps a
changelog per flag (`wrangler flagship flags changelog <APP_ID> <key>`), which is
the audit trail for a model change; the Wrangler variables are the audit trail
for a default change.

Keep the Worker variables in step with the variation a flag serves by default.
They are what a fresh region falls back to, and letting them drift means an
outage silently moves every agent to an older model.

## Local development

Flagship bindings are always remote. `wrangler dev --local` — which is what
`pnpm dev:api:local` runs, and what a sandbox must use — reports `env.FLAGS` as
`not supported` and leaves it undefined, so every agent uses its Worker
variables. That is the intended local behavior and needs no configuration.

To exercise a real flag locally you need Cloudflare credentials and
`pnpm dev:api`, which opens a remote proxy session for the remote bindings.

## Adding a flag

1. Add the key and its typed value to `agent-model-flags.ts`, or to a new
   module alongside it if the flag is not about model routing. Keep `env.FLAGS`
   out of call sites.
2. Give it a default that reproduces today's behavior, and hand that same
   default to Flagship so an absent flag and an unreachable Flagship agree.
3. Parse the served value with zod and reject it whole on failure.
4. Add the flag to the table above and create it in both regional apps.
