import { RequestElicitationInputSchema, createResponsesStreamReducer } from "@rally/agent-harness";
import { describe, expect, it } from "vitest";

import { DEMO_SEED_EXHAUSTED_CODE, DEMO_SEED_FALLBACK_MODEL, demoSeedModelRoute, demoSeedProviderFetch } from "../src/services/demo-seed-provider";

/**
 * The seam answers one inference request from the seed and refuses the next.
 *
 * Two of these matter beyond the wire shape. The `ask` turn's tool arguments
 * are parsed with the real `RequestElicitationInputSchema`, because the failure
 * when they drift is silent: the tool rejects them, no question opens, Bind is
 * told to try again, and the run dies on a second request instead. And the
 * second request is refused rather than answered again — a seam that repeats
 * its turn lets a loop that never ends replay it forever.
 */

const RESPONSES = "https://openrouter.ai/api/v1/responses";
const seed = (assistant: Parameters<typeof demoSeedProviderFetch>[0]["assistant"]) => ({
  packVersion: "test",
  actionId: "step-1",
  assistant,
});

function turnRequest(body: Record<string, unknown>): [string, RequestInit] {
  return [RESPONSES, { method: "POST", body: JSON.stringify({ model: "double/primary", ...body }) }];
}

/** The seam's bytes read by the harness's own stream reducer, as a run reads them. */
async function parsed(response: Response) {
  const text = await response.text();
  const reducer = createResponsesStreamReducer(null);
  for (const line of text.split("\n\n")) {
    if (line.startsWith("data: ") && line !== "data: [DONE]") reducer.apply(line.slice("data: ".length));
  }
  return reducer.result();
}

describe("the seeded provider", () => {
  it("streams a say turn as the text, the stop, and the usage Bind expects", async () => {
    const fetch = demoSeedProviderFetch(seed({ kind: "say", text: "Here is the memo." }));
    const response = await fetch(...turnRequest({ stream: true, input: [] }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const result = await parsed(response);
    expect(result.content).toBe("Here is the memo.");
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
    // No inference happened, so no tokens are claimed for it.
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("answers an ask turn with a request_elicitation call the tool accepts", async () => {
    const fetch = demoSeedProviderFetch(seed({
      kind: "ask",
      prompt: "Which position should I write the proposal against?",
      options: ["Include at no uplift", "Include at the $4k uplift"],
    }));
    // Streamed, like every turn a run asks for: the seam has no second
    // wire form, because no seeded run reaches the harness's one
    // non-streaming call (the addressing classifier a seed skips).
    const result = await parsed(await fetch(...turnRequest({ stream: true, input: [] })));
    expect(result.finishReason).toBe("tool_calls");
    const call = result.toolCalls[0];
    expect(call?.id).toBe("demo-seed-step-1");
    expect(call?.function.name).toBe("request_elicitation");
    // The real schema, not a copy of what it accepted last time.
    expect(RequestElicitationInputSchema.parse(JSON.parse(call!.function.arguments))).toEqual({
      prompt: "Which position should I write the proposal against?",
      responseType: "radio",
      options: [
        { value: "Include at no uplift", label: "Include at no uplift", description: null },
        { value: "Include at the $4k uplift", label: "Include at the $4k uplift", description: null },
      ],
      minimumSelections: 1,
      maximumSelections: 1,
    });
  });

  it("refuses a second inference request instead of repeating the turn", async () => {
    const fetch = demoSeedProviderFetch(seed({ kind: "say", text: "Once." }));
    await (await fetch(...turnRequest({ stream: true, input: [] }))).text();
    const second = await fetch(...turnRequest({ stream: true, input: [] }));
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: { code: DEMO_SEED_EXHAUSTED_CODE } });
  });

  it("answers anything that is not a streamed turn emptily, so nothing sent through the seam leaves the machine", async () => {
    const fetch = demoSeedProviderFetch(seed({ kind: "say", text: "Once." }));
    expect(await (await fetch("https://openrouter.ai/api/v1/models")).json()).toEqual({ data: [] });
    // The catalog read did not spend the turn.
    expect((await parsed(await fetch(...turnRequest({ stream: true, input: [] })))).content).toBe("Once.");
  });

  it("cannot be built from a seed that says nothing", () => {
    expect(() => demoSeedProviderFetch(seed(null))).toThrow("demo_seed_run_without_script");
  });
});

describe("the seeded run's route", () => {
  // The seam covers the OpenRouter client only. The bindings consulted here
  // are the harness's real table: `x-ai/grok-4.3` (production's default) is
  // Azure-first, `openai/gpt-5.6-sol` is Azure-only, the Gemini ids are unbound.
  it("keeps an unbound model and drops the fallbacks", () => {
    expect(demoSeedModelRoute({ model: "google/gemini-3.6-flash", fallbackModels: ["x-ai/grok-4.3"] }))
      .toEqual({ model: "google/gemini-3.6-flash", fallbackModels: [] });
  });

  it("steps past an Azure-bound primary to the first unbound fallback", () => {
    expect(demoSeedModelRoute({ model: "x-ai/grok-4.3", fallbackModels: ["openai/gpt-5.6-sol", "google/gemini-3.6-flash"] }))
      .toEqual({ model: "google/gemini-3.6-flash", fallbackModels: [] });
  });

  it("falls back to a fixed unbound id when every routed model is bound or absent", () => {
    expect(demoSeedModelRoute({ model: "x-ai/grok-4.3", fallbackModels: ["x-ai/grok-4.6"] }))
      .toEqual({ model: DEMO_SEED_FALLBACK_MODEL, fallbackModels: [] });
    expect(demoSeedModelRoute({ model: "", fallbackModels: [] }).model).toBe(DEMO_SEED_FALLBACK_MODEL);
  });
});
