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

/** Every chat-completions endpoint the harness can route to ends in this. */
const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

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

const USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * The `core_request_elicitation` call an `ask` turn makes, in the exact shape
 * `RequestElicitationInputSchema` accepts. Getting this wrong is silent: the
 * tool rejects the arguments, no elicitation opens, and Bind is told to try
 * again — against a seam that refuses the second request.
 */
function elicitationCall(turn: Extract<DemoSeedTurn, { kind: "ask" }>, seed: DemoSeed) {
  return {
    index: 0,
    id: `demo-seed-${seed.actionId}`,
    type: "function" as const,
    function: {
      name: "core_request_elicitation",
      arguments: JSON.stringify({
        prompt: turn.prompt,
        responseType: "radio",
        options: turn.options.map((option) => ({ value: option, label: option, description: null })),
        minimumSelections: 1,
        maximumSelections: 1,
      }),
    },
  };
}

function streamed(turn: DemoSeedTurn, seed: DemoSeed): Response {
  if (turn.kind === "say") {
    return sse([
      { choices: [{ delta: { content: turn.text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: USAGE },
    ]);
  }
  return sse([
    { choices: [{ delta: { tool_calls: [elicitationCall(turn, seed)] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { usage: USAGE },
  ]);
}

function unstreamed(model: string, turn: DemoSeedTurn, seed: DemoSeed): Response {
  const message = turn.kind === "say"
    ? { role: "assistant", content: turn.text }
    : {
        role: "assistant",
        content: null,
        tool_calls: [elicitationCall(turn, seed)].map(({ id, type, function: fn }) => ({ id, type, function: fn })),
      };
  return Response.json({
    id: `demo-seed-${seed.actionId}`,
    model,
    choices: [{ message, finish_reason: turn.kind === "say" ? "stop" : "tool_calls" }],
    usage: USAGE,
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  const text = typeof init?.body === "string"
    ? init.body
    : input instanceof Request
      ? await input.clone().text()
      : "";
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * A `fetch` the harness config accepts in place of the real one.
 *
 * Answers the run's one inference request from the seed's turn, in whichever
 * of the two wire forms the request asked for, and refuses every request after
 * it. Anything that is not a chat completion — a model catalog read, a pricing
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
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (!url.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) return Response.json({ data: [] });
    if (served) {
      return Response.json(
        { error: { code: DEMO_SEED_EXHAUSTED_CODE, message: "The seeded run asked the provider a second time" } },
        { status: 400 },
      );
    }
    served = true;
    const body = await requestBody(input, init);
    return body.stream === true
      ? streamed(turn, seed)
      : unstreamed(String(body.model ?? ""), turn, seed);
  }) as typeof globalThis.fetch;
}
