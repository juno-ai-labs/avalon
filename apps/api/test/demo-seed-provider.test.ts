import { RequestElicitationInputSchema } from "@rally/agent-harness";
import { describe, expect, it } from "vitest";

import { DEMO_SEED_EXHAUSTED_CODE, demoSeedProviderFetch } from "../src/services/demo-seed-provider";

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

const CHAT = "https://openrouter.ai/api/v1/chat/completions";
const seed = (assistant: Parameters<typeof demoSeedProviderFetch>[0]["assistant"]) => ({
  packVersion: "test",
  actionId: "step-1",
  assistant,
});

function chatRequest(body: Record<string, unknown>): [string, RequestInit] {
  return [CHAT, { method: "POST", body: JSON.stringify({ model: "double/primary", ...body }) }];
}

async function events(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("the seeded provider", () => {
  it("streams a say turn as the chunk, the stop, and the usage Bind expects", async () => {
    const fetch = demoSeedProviderFetch(seed({ kind: "say", text: "Here is the memo." }));
    const response = await fetch(...chatRequest({ stream: true, messages: [] }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const chunks = await events(response);
    expect(chunks[0]).toEqual({ choices: [{ delta: { content: "Here is the memo." }, finish_reason: null }] });
    expect(chunks[1]).toEqual({ choices: [{ delta: {}, finish_reason: "stop" }] });
    // No inference happened, so no tokens are claimed for it.
    expect(chunks[2]).toEqual({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  });

  it("answers an ask turn with a core_request_elicitation call the tool accepts", async () => {
    const fetch = demoSeedProviderFetch(seed({
      kind: "ask",
      prompt: "Which position should I write the proposal against?",
      options: ["Include at no uplift", "Include at the $4k uplift"],
    }));
    const response = await fetch(...chatRequest({ stream: false, messages: [] }));
    const body = await response.json() as {
      choices: { finish_reason: string; message: { tool_calls: { function: { name: string; arguments: string } }[] } }[];
    };
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    const call = body.choices[0]?.message.tool_calls[0];
    expect(call?.function.name).toBe("core_request_elicitation");
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
    await (await fetch(...chatRequest({ stream: true, messages: [] }))).text();
    const second = await fetch(...chatRequest({ stream: true, messages: [] }));
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: { code: DEMO_SEED_EXHAUSTED_CODE } });
  });

  it("answers anything that is not a chat completion emptily, so nothing sent through the seam leaves the machine", async () => {
    const fetch = demoSeedProviderFetch(seed({ kind: "say", text: "Once." }));
    expect(await (await fetch("https://openrouter.ai/api/v1/models")).json()).toEqual({ data: [] });
    // The catalog read did not spend the turn.
    const chunks = await events(await fetch(...chatRequest({ stream: true, messages: [] })));
    expect(chunks[0]).toEqual({ choices: [{ delta: { content: "Once." }, finish_reason: null }] });
  });

  it("cannot be built from a seed that says nothing", () => {
    expect(() => demoSeedProviderFetch(seed(null))).toThrow("demo_seed_run_without_script");
  });
});
