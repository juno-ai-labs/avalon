/**
 * Compares two or more OpenRouter models on Avalon's structured decisions.
 *
 *   OPENROUTER_API_KEY=... pnpm eval:models
 *   OPENROUTER_API_KEY=... pnpm eval:models --models x-ai/grok-4.3,google/gemini-3.6-flash --repeat 5
 *
 * Requests go through the same `OpenRouterClient.structured` path the Workers
 * use, with the product's own prompts and JSON schemas, so a result reflects
 * how the model behaves inside Avalon rather than on a synthetic benchmark.
 */
import { z } from "zod";
import { AddressingClassificationSchema, ActivityRoutingResultSchema } from "@avalon/contracts";
import {
  OpenRouterClient,
  addressingJsonSchema,
  runHarness,
  type HarnessEvent,
  type StructuredModelDiagnostic,
} from "../index";
import {
  activityRoutingJsonSchema,
  renderActivityRoutingMessages,
  renderAddressingMessages,
  renderSemanticTriggerMessages,
  renderWorkstreamSystemPrompt,
  semanticTriggerJsonSchema,
} from "../prompts";
import { agenticCases, createStandInSurface, gradeAgenticCase, standInToolNames } from "./agentic";
import {
  activityRoutingCases,
  addressingCases,
  semanticTriggerCases,
  type SuiteId,
} from "./cases";
import {
  formatPassRate,
  gradeActivityRouting,
  gradeAddressing,
  gradeSemanticTrigger,
  type CaseVerdict,
  type SuiteTally,
} from "./grade";

const DEFAULT_MODELS = ["x-ai/grok-4.3", "google/gemini-3.6-flash"];
const SEMANTIC_TRIGGER_RESULT = z.object({
  matches: z.boolean(),
  confidence: z.number().min(0).max(1),
});

interface Options {
  models: string[];
  repeat: number;
  concurrency: number;
  suites: SuiteId[] | null;
  json: boolean;
}

interface Attempt {
  model: string;
  suite: SuiteId;
  caseId: string;
  intent: string;
  run: number;
  verdict: CaseVerdict;
  latencyMs: number;
  repairs: number;
  /** Wire names the agentic loop actually invoked, for tool coverage. */
  toolsCalled: string[];
  error?: string;
}

/** What a task needs to reach the model: structured suites use the client, the agentic suite drives the loop. */
interface RunContext {
  client: OpenRouterClient;
  model: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    models: DEFAULT_MODELS,
    repeat: 3,
    concurrency: 4,
    suites: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (value === undefined) throw new Error(`${flag} requires a value`);
    switch (flag) {
      case "--models":
        options.models = value.split(",").map((model) => model.trim()).filter(Boolean);
        break;
      case "--repeat":
        options.repeat = Number.parseInt(value, 10);
        break;
      case "--concurrency":
        options.concurrency = Number.parseInt(value, 10);
        break;
      case "--suite":
        options.suites = value.split(",").map((suite) => suite.trim()) as SuiteId[];
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
    index += 1;
  }
  if (options.models.length < 1) throw new Error("--models needs at least one model");
  if (!Number.isFinite(options.repeat) || options.repeat < 1) throw new Error("--repeat must be >= 1");
  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be >= 1");
  }
  return options;
}

/** One unit of work: a single case executed once against one model. */
interface Task {
  model: string;
  suite: SuiteId;
  caseId: string;
  intent: string;
  run: number;
  execute: (context: RunContext, onDiagnostic: Diagnostic) => Promise<TaskOutcome>;
}

interface TaskOutcome {
  verdict: CaseVerdict;
  toolsCalled: string[];
}

type Diagnostic = (event: StructuredModelDiagnostic) => void;

function structuredOutcome(verdict: CaseVerdict): TaskOutcome {
  return { verdict, toolsCalled: [] };
}

function buildTasks(options: Options): Task[] {
  const wanted = (suite: SuiteId): boolean => options.suites === null || options.suites.includes(suite);
  const tasks: Task[] = [];
  for (const model of options.models) {
    for (let run = 1; run <= options.repeat; run += 1) {
      if (wanted("addressing")) {
        for (const testCase of addressingCases) {
          tasks.push({
            model,
            suite: "addressing",
            caseId: testCase.id,
            intent: testCase.intent,
            run,
            execute: async (context, onDiagnostic) => {
              const response = await context.client.structured({
                messages: renderAddressingMessages(testCase.input),
                schemaName: "message_addressing",
                jsonSchema: addressingJsonSchema,
                parse: (value) => AddressingClassificationSchema.parse(value),
                onDiagnostic,
              });
              return structuredOutcome(gradeAddressing(testCase.expected, response));
            },
          });
        }
      }
      if (wanted("semantic_trigger")) {
        for (const testCase of semanticTriggerCases) {
          tasks.push({
            model,
            suite: "semantic_trigger",
            caseId: testCase.id,
            intent: testCase.intent,
            run,
            execute: async (context, onDiagnostic) => {
              const response = await context.client.structured({
                messages: renderSemanticTriggerMessages(testCase.input),
                schemaName: "semantic_activity_trigger",
                jsonSchema: semanticTriggerJsonSchema,
                parse: (value) => SEMANTIC_TRIGGER_RESULT.parse(value),
                onDiagnostic,
              });
              return structuredOutcome(gradeSemanticTrigger(testCase.expected, response));
            },
          });
        }
      }
      if (wanted("activity_routing")) {
        for (const testCase of activityRoutingCases) {
          const candidateIds = testCase.input.candidates.map((candidate) => candidate.id);
          tasks.push({
            model,
            suite: "activity_routing",
            caseId: testCase.id,
            intent: testCase.intent,
            run,
            execute: async (context, onDiagnostic) => {
              const response = await context.client.structured({
                messages: renderActivityRoutingMessages(testCase.input),
                schemaName: "activity_workstream_route",
                jsonSchema: activityRoutingJsonSchema,
                parse: (value) => ActivityRoutingResultSchema.parse(value),
                onDiagnostic,
              });
              return structuredOutcome(gradeActivityRouting(testCase.expected, response, candidateIds));
            },
          });
        }
      }
      if (wanted("agentic")) {
        for (const testCase of agenticCases) {
          tasks.push({
            model,
            suite: "agentic",
            caseId: testCase.id,
            intent: testCase.intent,
            run,
            execute: async (context) => {
              const surface = createStandInSurface();
              const events: HarnessEvent[] = [];
              const outcome = await runHarness({
                config: {
                  apiKey: context.apiKey,
                  primaryModel: context.model,
                  // No fallbacks: a run must measure the named model.
                  fallbackModels: [],
                  ...(context.fetchImpl ? { fetch: context.fetchImpl } : {}),
                  maxIterations: 8,
                  maxToolCalls: 16,
                  maxWallClockMs: 180_000,
                  toolTimeoutMs: 15_000,
                  maxWebResults: 4,
                },
                workspaceId: "workspace-eval",
                workstreamId: "workstream-eval",
                harnessRunId: `eval-${testCase.id}-${run}`,
                executionPrincipal: { type: "user", userId: "user-eval" },
                systemPrompt: renderWorkstreamSystemPrompt({
                  title: testCase.id,
                  objective: testCase.objective,
                }),
                messages: [{ role: "user", content: testCase.message }],
                corePlugins: surface.corePlugins,
                plugins: surface.deferredPlugins,
                onEvent: (event) => { events.push(event); },
              });
              return {
                verdict: gradeAgenticCase(testCase.expected, outcome, events),
                toolsCalled: surface.invocations.map((invocation) => invocation.wireName),
              };
            },
          });
        }
      }
    }
  }
  return tasks;
}

async function runTask(task: Task, context: RunContext): Promise<Attempt> {
  let repairs = 0;
  const startedAt = Date.now();
  const onDiagnostic: Diagnostic = (event) => {
    if (event.stage === "repair") repairs += 1;
  };
  try {
    const { verdict, toolsCalled } = await task.execute(context, onDiagnostic);
    return {
      model: task.model,
      suite: task.suite,
      caseId: task.caseId,
      intent: task.intent,
      run: task.run,
      verdict,
      latencyMs: Date.now() - startedAt,
      repairs,
      toolsCalled,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      model: task.model,
      suite: task.suite,
      caseId: task.caseId,
      intent: task.intent,
      run: task.run,
      // An unrecoverable request is a failure of the model under test, not a
      // skipped case: a model that cannot return the schema cannot hold the slot.
      verdict: { passed: false, actual: "error", expected: "a completed run", note: message },
      latencyMs: Date.now() - startedAt,
      repairs,
      toolsCalled: [],
      error: message,
    };
  }
}

async function runPool(tasks: Task[], contexts: Map<string, RunContext>, concurrency: number): Promise<Attempt[]> {
  const attempts: Attempt[] = new Array<Attempt>(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (!task) return;
      const context = contexts.get(task.model);
      if (!context) return;
      attempts[index] = await runTask(task, context);
      process.stderr.write(".");
    }
  });
  await Promise.all(workers);
  return attempts;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function tally(attempts: Attempt[]): SuiteTally {
  return {
    passed: attempts.filter((attempt) => attempt.verdict.passed).length,
    total: attempts.length,
  };
}

function report(options: Options, attempts: Attempt[]): void {
  const suites: SuiteId[] = options.suites ?? ["addressing", "semantic_trigger", "activity_routing", "agentic"];
  process.stdout.write("\n");
  for (const model of options.models) {
    const forModel = attempts.filter((attempt) => attempt.model === model);
    process.stdout.write(`${model}\n`);
    process.stdout.write(`  overall          ${formatPassRate(tally(forModel))}\n`);
    for (const suite of suites) {
      const forSuite = forModel.filter((attempt) => attempt.suite === suite);
      if (forSuite.length === 0) continue;
      process.stdout.write(`  ${suite.padEnd(16)} ${formatPassRate(tally(forSuite))}\n`);
    }
    process.stdout.write(`  median latency   ${Math.round(median(forModel.map((a) => a.latencyMs)))}ms\n`);
    process.stdout.write(`  schema repairs   ${forModel.reduce((sum, a) => sum + a.repairs, 0)}\n`);

    // Which agent tools this model actually reached. A tool no case exercises
    // is untested surface, so name it rather than let the pass rate imply cover.
    const agentic = forModel.filter((attempt) => attempt.suite === "agentic");
    if (agentic.length > 0) {
      const exercised = new Set(agentic.flatMap((attempt) => attempt.toolsCalled));
      const missed = standInToolNames.filter((name) => !exercised.has(name));
      process.stdout.write(
        `  tools exercised  ${exercised.size}/${standInToolNames.length}${missed.length ? ` (never called: ${missed.join(", ")})` : ""}\n`,
      );
    }

    // Cases that did not pass on every run: a case that is right twice out of
    // three times is a reliability problem, not a pass.
    const byCase = new Map<string, Attempt[]>();
    for (const attempt of forModel) {
      byCase.set(attempt.caseId, [...(byCase.get(attempt.caseId) ?? []), attempt]);
    }
    const unstable = [...byCase.entries()].filter(([, runs]) => runs.some((run) => !run.verdict.passed));
    if (unstable.length > 0) {
      process.stdout.write("  failures\n");
      for (const [caseId, runs] of unstable) {
        const failures = runs.filter((run) => !run.verdict.passed);
        const first = failures[0];
        if (!first) continue;
        const detail = first.verdict.note ? ` — ${first.verdict.note}` : "";
        process.stdout.write(
          `    ${caseId} ${failures.length}/${runs.length} failed: got ${first.verdict.actual}, wanted ${first.verdict.expected}${detail}\n`,
        );
        process.stdout.write(`      ${first.intent}\n`);
      }
    }
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    process.stderr.write("OPENROUTER_API_KEY is not set. Export it, or run with the key from .env.local.\n");
    process.exitCode = 1;
    return;
  }
  const baseUrl = process.env.AVALON_EVAL_BASE_URL;
  // A stub base URL lets the runner be exercised end to end without a real key.
  const fetchImpl: typeof globalThis.fetch | null = baseUrl
    ? ((input, init) =>
        fetch(typeof input === "string" ? input.replace("https://openrouter.ai", baseUrl) : input, init))
    : null;
  const contexts = new Map<string, RunContext>(
    options.models.map((model) => [
      model,
      {
        model,
        apiKey,
        fetchImpl,
        client: new OpenRouterClient({
          apiKey,
          primaryModel: model,
          // No fallbacks: a run must measure the named model, never a stand-in.
          fallbackModels: [],
          appName: "Avalon model eval",
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        }),
      },
    ]),
  );

  const tasks = buildTasks(options);
  process.stderr.write(
    `Running ${tasks.length} requests: ${options.models.length} models x ${tasks.length / options.models.length / options.repeat} cases x ${options.repeat} runs\n`,
  );
  const attempts = await runPool(tasks, contexts, options.concurrency);

  if (options.json) {
    process.stdout.write(`\n${JSON.stringify({ options, attempts }, null, 2)}\n`);
    return;
  }
  report(options, attempts);

  const anyFailed = attempts.some((attempt) => !attempt.verdict.passed);
  process.exitCode = anyFailed ? 1 : 0;
}

await main();
