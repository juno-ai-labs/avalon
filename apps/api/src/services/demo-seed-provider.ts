/**
 * The provider seam a seeded run answers itself from.
 *
 * A seeded assistant turn is produced by an ordinary run — the same admission,
 * Bind loop, reserved turn, tool surface and settlement as any other. The one
 * thing replaced is the *source of model output*: `OpenRouterConfig.fetch`, an
 * injection point the harness already exposes, is answered from the seed's turn
 * instead of by OpenRouter. Nothing here writes a transcript row, records a
 * receipt, or registers a tool; whatever this returns is parsed and persisted
 * by the production path exactly as a provider's bytes would be.
 *
 * The wire shapes are the ones `test-workers/helpers/openrouter-double.ts`
 * describes — the checked-in statement of what Bind sends and parses.
 * `docs/demo-workspaces.md` owns the feature; `docs/agent-harness.md` owns the
 * seam's place in the run.
 */
import type { DemoSeed, DemoSeedTurn } from "@rally/contracts";
import { isAzureBoundModel } from "@rally/agent-harness";


/**
 * The endpoint a streamed OpenRouter turn goes to. The seed never answers an
 * Azure turn (`demoSeedModelRoute` keeps the run off Azure), so Azure's Chat
 * Completions path is not served here.
 */
const RESPONSES_SUFFIX = "/responses";

/**
 * The refusal a second inference request gets. A seed has one turn, and a run
 * that asks again is a run the script did not anticipate: repeating the turn
 * would let a loop that never ends replay it forever (the first version of the
 * spike's adapter wedged the runtime exactly that way), so the seam fails the
 * run visibly instead, as a provider refusal Bind does not retry.
 */
export const DEMO_SEED_EXHAUSTED_CODE = "demo_seed_exhausted";

/**
 * Stands in for the provider key when the environment has none.
 *
 * Bind refuses to construct a client without a key, and a seeded run never
 * presents one anywhere — every request it makes is answered here. Production
 * always has the real key (`env.ts` requires it in both regions); this exists so
 * a sandbox without one can still seed.
 */
export const DEMO_SEED_PROVIDER_KEY = "demo-seed-no-provider";

/**
 * The model a seeded run is routed under, and no fallbacks.
 *
 * The seam replaces the OpenRouter client's `fetch` and nothing else, so a
 * seeded run has to be one the planner sends to OpenRouter alone. A model
 * bound to the Azure transport, such as `x-ai/grok-4.3`,
 * is tried there first or only there, and the seed would never be asked: the
 * turn would come from a live model, and an `ask` would fail its settlement.
 * So the route keeps the resolved model when it is unbound, otherwise the
 * first unbound fallback, otherwise a fixed unbound id. The seam answers
 * whatever name the request carries, so the choice affects only what the run
 * records about itself. Fallbacks are dropped because the seam refuses a
 * second request, and a fallback stage would spend that refusal for nothing.
 */
export const DEMO_SEED_FALLBACK_MODEL = "google/gemini-2.5-flash-lite";

export function demoSeedModelRoute(
  routing: { model: string; fallbackModels: readonly string[] },
): { model: string; fallbackModels: string[] } {
  const unbound = [routing.model, ...routing.fallbackModels]
    .find((model) => model.length > 0 && !isAzureBoundModel(model));
  return { model: unbound ?? DEMO_SEED_FALLBACK_MODEL, fallbackModels: [] };
}

const USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * The `request_elicitation` call an `ask` turn makes, in the exact shape
 * `RequestElicitationInputSchema` accepts. Getting this wrong is silent: the
 * tool rejects the arguments, no elicitation opens, and Bind is told to try
 * again — against a seam that refuses the second request.
 */
function elicitationCall(turn: Extract<DemoSeedTurn, { kind: "ask" }>, seed: DemoSeed) {
  return {
    type: "function_call" as const,
    id: `fc_demo-seed-${seed.actionId}`,
    call_id: `demo-seed-${seed.actionId}`,
    name: "request_elicitation",
    arguments: JSON.stringify({
      prompt: turn.prompt,
      responseType: "radio",
      options: turn.options.map((option) => ({ value: option, label: option, description: null })),
      minimumSelections: 1,
      maximumSelections: 1,
    }),
  };
}

/** One streamed Responses turn: the output item, then the terminal response with usage. */
function streamed(turn: DemoSeedTurn, seed: DemoSeed): Response {
  if (turn.kind === "say") {
    return sse([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: turn.text },
      { type: "response.completed", response: { status: "completed", usage: USAGE } },
    ]);
  }
  return sse([
    { type: "response.output_item.done", output_index: 0, item: elicitationCall(turn, seed) },
    { type: "response.completed", response: { status: "completed", usage: USAGE } },
  ]);
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
}

/**
 * A `fetch` the harness config accepts in place of the real one.
 *
 * Answers the run's one inference request from the seed's turn, in the
 * streamed form every run asks for, and refuses every request after it. Anything that is not a streamed turn — a model catalog read, a pricing
 * read — is answered emptily: nothing the client sends through this `fetch`
 * leaves the machine, and the harness already treats an unlisted model as one
 * with its documented default context window. The seam covers the client it is
 * handed to; the run's other provider path, admission-time memory recall, is
 * skipped for a seeded origin in `integrations.ts`.
 */
export function demoSeedProviderFetch(seed: DemoSeed): typeof globalThis.fetch {
  const turn = seed.assistant;
  if (turn === null) {
    // The object refuses to start a run from a seed that says nothing, so this
    // is a programming error rather than a state a run can reach.
    throw new Error("demo_seed_run_without_script");
  }
  let served = false;
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    if (!url.pathname.endsWith(RESPONSES_SUFFIX)) return Response.json({ data: [] });
    if (served) {
      return Response.json(
        { error: { code: DEMO_SEED_EXHAUSTED_CODE, message: "The seeded run asked the provider a second time" } },
        { status: 400 },
      );
    }
    served = true;
    // Streamed, always: every turn a run makes is streamed
    // (`bind-runtime.ts` sends `stream: true` on both provider branches), and
    // the one non-streaming call in the harness is the addressing classifier,
    // which a seeded message skips by construction.
    return streamed(turn, seed);
  }) as typeof globalThis.fetch;
}
