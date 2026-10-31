# Research: Code Mode and wizard-authored tools

> Investigation record for [`prd.md`](prd.md), written 2026-10-30 and
> 2026-10-31. Production numbers were read from the
> systems named beside them; nothing is inferred from a screenshot.

## What exists in the tree

- A Sidekick definition holds no tools. `AutomationDraftSchema`
  (`packages/contracts/src/index.ts`) carries instructions (12,000 characters at
  most), triggers, memory tables, a free-form `defaultBehavior` object rendered
  into the prompt, and `recommendedPlugins[].recommendedTools`, which nothing
  reads.
- A run gets the same tool surface as any conversation (`loadHarnessTools`,
  `apps/api/src/services/integrations.ts`). `defaultPluginIds` only preloads.
  Production metadata shows 76 tool definitions on a fresh turn.
- The only tools defined from data are hosted and custom MCP: `tools/list`
  becomes `ToolDefinition`s at `load_plugin`, validated to 128 tools, with
  surface hashes for receipt replay.
- `AgentProfile` can fix a conversation's whole tool surface; its only entry is
  `session_import`.
- The one existing bound argument is `conversation_post.conversation`, which
  defaults to the Sidekick's home conversation.
- The Worker Loader binding `ARTIFACT_LOADER` is live in production for live
  web artifacts, loaded with `globalOutbound: null`
  (`apps/api/src/artifacts/index.ts`). Every Sidekick has a Daytona sandbox
  shared by its wizard and runs; it has no callback into Rally tools.
- No `eval`, `new Function`, or `vm` in `apps/api` or `packages`. No Code Mode
  implementation. `@cloudflare/codemode` appears only as an optional peer of the
  `agents` package used by `apps/engineering-mcp`.
- Prior decisions: no trigger narrows tools and no silent delivery
  (`automation-lifecycle.md`, 2026-09-03). "Dynamic Workers per automation" was
  rejected because the trigger vocabulary must stay declarative and
  inspectable; that decision was about triggers, not run bodies. The Terminal
  PRD research called connector Code Mode "a credible second plugin".

## Production evidence

### Streaming work-stream turns, 2026-10-16 to 2026-10-30, production

From `avalon.llm_inference`.

| Measure | Value |
| --- | --- |
| Model calls | 66,727 |
| Distinct substreams | 5,118 |
| Avg input tokens per call | 56,348 |
| Avg cached input tokens per call | 43,923 |
| Avg output tokens per call | 232 |
| Avg latency per call | 6.1 s |
| Provider cost | $1,887 |

By model: gpt-5.6-terra 43,833 calls (57k avg input); gemini-3.8-flash 15,583;
grok-4.6 5,908; gpt-6.1-sol 1,220 (136k avg input, the wizard); gpt-5.6-sol 179.

### The PostHog report Sidekicks

Juno Labs Organization, workspace `019fc068-22e8-739a-8394-a760fdc7c376`.
PostHog is a custom MCP connection (`mcp.posthog.com`) exposing one `exec` tool
(`custom_mcp_4_exec`) that takes CLI-style commands: `learn`, `search`, `info`,
`call read-data-schema`, `call execute-sql`. Runs execute on gpt-5.6-terra;
the wizard route resolves to the primary-model flag.

"Daily Signup, Traffic & Attribution Report" (`8824170a-f31f-5dd8-a68a-7fc3cc9ff192`,
revision 10, posts to Slack `C0A4UF9RWAU`) and "Daily new-user report"
(`036204cf-0e1b-5898-be30-c6b016be3d9c`, revision 3, posts to its home
conversation). Receipts read from each run child's `tool_effects`; tokens from
`avalon.llm_inference` by `substream_id`.

| Run (PT date) | Tool calls | PostHog exec calls | Discovery (learn, info, schema) | SQL | Terra calls | Input tokens | Cost | Wall clock | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Signup 10-25 (`01a17a3a`) | 46 | 42 | 34 | 4 | | | | 260 s | posted |
| Signup 10-26 (`01a17f60`) | 40 | 36 | 30 | 5 | | | | 199 s | blocked |
| Signup 10-27 (`01a18487`) | 46 | 41 | 32 | 6 | | | | 525 s | posted, also a block notice |
| Signup 10-28 (`01a189ad`) | 37 | 31 | 25 | 7 | 16 | 799k | $0.39 | 170 s | posted |
| Signup 10-30 (`01a18ed4`) | 34 | 32 | 30 | 2 | 17 | 986k | $0.45 | 161 s | blocked |
| New-user 10-28 (`01a1852b`) | 39 | 32 | 24 | 6 | 13 + 1 Gemini | 698k | $0.60 | 184 s | zero signups |
| New-user 10-29 (`01a18a52`) | 32 | 26 | 22 | 1 | 15 + 1 Gemini | 715k | $0.56 | 163 s | zero signups |

Observations:

- 75 to 85 percent of tool calls re-discover facts the wizard verified at
  setup: project id, event names, property values, columns, relationships, tool
  schemas. The instructions record the verification ("Setup verified project
  marketing goal ... live signup_completed accountStatus value new was
  verified") and then require it again every run.
- The 10-30 block: two SQL diagnostic forms disagreed on a pageview count (50
  against 67 against 56) from timezone literal handling. The run's own blocked
  post says "investigate timestamp literal/timezone handling in the PostHog SQL
  diagnostic path".
- Revisions 7 to 10 of the Signup report added prose to loosen Terra's checks
  ("Treat differences of up to 5% as agreement, not a blocker"). The next run
  still blocked.
- Both Sidekicks call `slack_find_channels` each run with the channel id already
  in their prose, and `load_skill` fails in three of five Signup runs (the
  instructions name a PostHog skill as if it were a Rally skill).
- Per-run cost is about fifty cents. The case is reliability and the three to
  nine minute wall clock, not dollars.

### The Hourly joke Sidekick

`docs/PRDs/2026-09-11_sidekick-delivery-reliability/research.md` records the
earlier case: channel id in prose, double posts, replies threaded under the
wrong message. Its PRD proposes a typed `slack_channel` destination resolved at
acceptance; it is in progress.

## Platform facts

Read 2026-10-30 from Cloudflare and Anthropic documentation.

- **Code Mode** (developers.cloudflare.com/agents/tools/codemode): a tool-use
  pattern; configured tools exposed as typed methods; one code-execution tool;
  "experimental and may introduce breaking changes". Guidance: direct calls for
  small known tool sets and simple tasks; Code Mode for composed or dependent
  calls, large catalogs, loops, branching, filtering, result shaping, reusable
  logic.
- **Dynamic Workers**: code loaded at runtime in a sandboxed isolate; the parent
  chooses bindings and network egress (`globalOutbound: null` blocks `fetch`
  and `connect`); capabilities are passed as `WorkerEntrypoint` stubs made with
  `ctx.exports`, with `props` only the loader can read; stubs have no global
  identifier and cannot be forged. Workers Paid only. Concurrency: 4 distinct
  Dynamic Workers in flight per Worker request context, 10 per Durable Object
  context. Pricing from 2026-05-26: $0.002 per unique Worker per day, $0.30 per
  million requests, $0.02 per million CPU ms, beyond 1,000 Workers, 10M requests
  and 30M CPU ms a month.
- **`@cloudflare/codemode` 0.1.0** (changelog 2026-02-20): runtime-agnostic
  `execute(code, fns)` Executor contract; `DynamicWorkerExecutor` over a loader
  binding with a 30 s default timeout and console capture; `createCodeTool()`
  returns a Vercel AI SDK `Tool`; the rewrite removed `experimental_codemode()`
  and `CodeModeProxy` and moved the import path.
- **Anthropic programmatic tool calling**: GA on the Claude API, AWS and
  Foundry; requires `code_execution_20260120`; tools marked
  `allowed_callers: ["code_execution_20260120"]` become async Python functions
  the model's code awaits; the API pauses with a `caller` field and resumes when
  the developer returns the result; containers idle out after about 5 minutes
  and a pending call times out after about 4. Not reachable from Rally's Azure
  and OpenRouter routes.

## The SDK

Why the PRD builds rather than adopts `@cloudflare/codemode`:

- The hard part is Bind-specific: nested receipts, replay by occurrence key,
  authorization through `HarnessTool.execute`, activity rows, byte-stable
  prompt sections. The SDK owns none of it.
- The SDK's tool wrapper targets the Vercel AI SDK, which Rally does not use.
- The package is experimental with a breaking rewrite in its history.
- The reusable parts, the executor and the type renderer, are each a few
  hundred lines and are read for their edge cases.

## Sources

- https://developers.cloudflare.com/agents/tools/codemode/
- https://developers.cloudflare.com/changelog/2026-02-20-codemode-sdk-rewrite
- https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader
- https://developers.cloudflare.com/dynamic-workers/pricing/
- https://developers.cloudflare.com/dynamic-workers/platform/limits/
- https://developers.cloudflare.com/dynamic-workers/usage/bindings/
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
