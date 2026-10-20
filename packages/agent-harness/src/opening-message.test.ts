import { describe, expect, it } from "vitest";
import { classifyOpeningMessage } from "./opening-message";

const input = { message: "Launch planning", humanMentions: [], connectorMentions: [], attachmentCount: 0, typesafeApiKey: "test-key" };
const reply = (choice: string, confidence: number): typeof fetch => async () => Response.json({
  model: "jev-test", answers: { opening_message: { type: "choice", choice, confidence } },
});

describe("opening message addressing", () => {
  it.each(["prompt_to_process", "human_to_human", "conversation_description"])("accepts %s", async (choice) => {
    expect(await classifyOpeningMessage({ ...input, fetch: reply(choice, 0.99) }))
      .toMatchObject({ classification: choice, outcome: "classified" });
  });

  it.each([0, 0.49, 0.5])("processes uncertain answers at confidence %s", async (confidence) => {
    expect(await classifyOpeningMessage({ ...input, fetch: reply("human_to_human", confidence) }))
      .toMatchObject({ classification: "prompt_to_process", outcome: "low_confidence" });
  });

  it("processes when the key is missing without calling a provider", async () => {
    expect(await classifyOpeningMessage({ ...input, typesafeApiKey: undefined,
      fetch: async () => { throw new Error("must not fetch"); } }))
      .toMatchObject({ classification: "prompt_to_process", failureKind: "typesafe_key_missing" });
  });

  it("processes an unavailable provider", async () => {
    expect(await classifyOpeningMessage({ ...input, fetch: async () => new Response("", { status: 503 }) }))
      .toMatchObject({ classification: "prompt_to_process", outcome: "unavailable", failureKind: "typesafe_http_503" });
  });

  it("processes invalid output and names the rejected field", async () => {
    expect(await classifyOpeningMessage({ ...input, fetch: reply("unknown", 1) }))
      .toMatchObject({ classification: "prompt_to_process", outcome: "unavailable",
        failureKind: expect.stringContaining("answers.opening_message.choice") });
  });

  it("passes the original text and structural context to JEV", async () => {
    let state: unknown;
    await classifyOpeningMessage({ ...input, message: "@Alex, review the plan", humanMentions: ["Alex"],
      connectorMentions: ["linear"], attachmentCount: 1,
      fetch: async (_url, init) => {
        state = JSON.parse(String(init?.body)).state;
        return reply("human_to_human", 0.99)(_url, init);
      } });
    expect(state).toEqual({ current_message: { text: "@Alex, review the plan",
      mentioned_people: ["Alex"], mentioned_connectors: ["linear"], attachment_count: 1 } });
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(classifyOpeningMessage({ ...input, signal: controller.signal,
      fetch: async () => { throw controller.signal.reason; } })).rejects.toMatchObject({ name: "AbortError" });
  });
});
