import { describe, expect, it } from "vitest";

import {
  OpenRouterClient,
  OpenRouterError,
  OpenRouterRequestError,
  createResponsesStreamReducer,
  openRouterResponsesRequest,
  toResponsesInput,
} from "./index";
import { sseBody } from "./test-support/responses-stream";

/**
 * The OpenRouter wire layer: Bind's Chat-shaped transcript out as Responses
 * input, and a Responses event stream back as the Chat-shaped result Bind
 * stores. The events are the shapes OpenRouter streamed for
 * `openai/gpt-6.1-sol`, `google/gemini-3.8-flash` and `x-ai/grok-4.6`
 * (2026-10-09), trimmed to the fields the reducer reads plus their neighbours.
 */

function reduce(events: readonly Record<string, unknown>[], headerGenerationId: string | null = null) {
  const reducer = createResponsesStreamReducer(headerGenerationId);
  const steps = events.map((event) => reducer.apply(JSON.stringify(event)));
  return { steps, result: reducer.result() };
}

const completedUsage = {
  input_tokens: 115,
  input_tokens_details: { cached_tokens: 64 },
  output_tokens: 18,
  output_tokens_details: { reasoning_tokens: 7 },
  total_tokens: 133,
  cost: 0.00041,
  is_byok: false,
  cost_details: {
    upstream_inference_cost: 0.00041,
    upstream_inference_input_cost: 0.00023,
    upstream_inference_output_cost: 0.00018,
  },
};

describe("Responses stream reducer", () => {
  it("assembles a streamed function call and reports usage under Chat names", () => {
    const { steps, result } = reduce([
      { type: "response.created", response: { id: "gen-1", status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_tmp_1", type: "function_call", status: "in_progress", call_id: "call_berlin", name: "get_weather", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_tmp_1", delta: "{\"city\":\"" },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_tmp_1", delta: "Berlin\"}" },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_tmp_1", name: "get_weather", arguments: "{\"city\":\"Berlin\"}" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "fc_tmp_1", type: "function_call", status: "completed", call_id: "call_berlin", name: "get_weather", arguments: "{\"city\":\"Berlin\"}" },
      },
      {
        type: "response.completed",
        response: {
          id: "gen-1",
          status: "completed",
          incomplete_details: null,
          usage: completedUsage,
          openrouter_metadata: { requested: "openai/gpt-6.1-sol", attempt: 1 },
        },
      },
    ], "gen-header");

    expect(steps.map((step) => step.answered)).toEqual([false, true, true, true, true, true, false]);
    expect(result).toEqual({
      content: "",
      toolCalls: [{ id: "call_berlin", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Berlin\"}" } }],
      finishReason: "tool_calls",
      usage: {
        prompt_tokens: 115,
        completion_tokens: 18,
        total_tokens: 133,
        cost: 0.00041,
        reasoning_tokens: 7,
        cached_tokens: 64,
      },
      // The response header wins over the body id, as on Chat Completions.
      generationId: "gen-header",
      openRouterMetadata: { requested: "openai/gpt-6.1-sol", attempt: 1 },
    });
  });

  it("streams text, ignores a trailing reasoning item, and stops", () => {
    const { steps, result } = reduce([
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "Paris is" },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: " 18°C." },
      { type: "response.output_item.added", output_index: 1, item: { id: "rs_1", type: "reasoning", summary: [] } },
      { type: "response.reasoning_summary_text.delta", output_index: 1, delta: "thinking" },
      { type: "response.completed", response: { id: "gen-2", status: "completed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
    ]);

    expect(steps.map((step) => step.text)).toEqual(["", "Paris is", " 18°C.", "", "", ""]);
    expect(steps.map((step) => step.answered)).toEqual([false, true, true, false, false, false]);
    expect(result).toMatchObject({ content: "Paris is 18°C.", toolCalls: [], finishReason: "stop", generationId: "gen-2" });
  });

  it("reads a max-output-tokens cut as a length finish, which Bind treats as truncation", () => {
    const { result } = reduce([
      { type: "response.output_text.delta", output_index: 0, delta: "Rivers are" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    expect(result.finishReason).toBe("length");
  });

  it("adds a bring-your-own-key provider charge to OpenRouter's fee", () => {
    const { result } = reduce([{
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 93,
          output_tokens: 20,
          total_tokens: 113,
          cost: 0,
          is_byok: true,
          cost_details: { upstream_inference_cost: 0.0002895 },
        },
      },
    }]);
    expect(result.usage?.cost).toBe(0.0002895);
  });

  it("raises a failed response with the provider's own error", () => {
    const reducer = createResponsesStreamReducer(null);
    const failed = JSON.stringify({
      type: "response.failed",
      response: { status: "failed", error: { code: "server_error", message: "upstream failed" } },
    });
    expect(() => reducer.apply(failed)).toThrow(OpenRouterError);
    try {
      reducer.apply(failed);
    } catch (error) {
      expect((error as OpenRouterError).details).toMatchObject({ providerError: { code: "server_error" } });
    }
  });
});

describe("Responses input", () => {
  it("splits an assistant turn into its text and one function_call per tool call, answered by call id", () => {
    expect(toResponsesInput([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [{ id: "call.abc/1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
      },
      { role: "tool", tool_call_id: "call.abc/1", content: "18C" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-2", type: "function", function: { name: "noop", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-2", content: [{ type: "text", text: "ok" }] },
    ])).toEqual([
      { type: "message", role: "system", content: "Be terse." },
      { type: "message", role: "user", content: "Weather in Paris?" },
      { type: "message", role: "assistant", content: "Checking." },
      // Responses requires an fc_ id on a replayed call; it names nothing upstream.
      { type: "function_call", id: "fc_call_abc_1", callId: "call.abc/1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
      { type: "function_call_output", callId: "call.abc/1", output: "18C" },
      { type: "function_call", id: "fc_call-2", callId: "call-2", name: "noop", arguments: "{}" },
      { type: "function_call_output", callId: "call-2", output: [{ type: "input_text", text: "ok" }] },
    ]);
  });

  it("refuses audio in a tool result, which Responses has no slot for", () => {
    expect(() => toResponsesInput([
      { role: "tool", tool_call_id: "call-1", content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }] },
    ])).toThrow(OpenRouterRequestError);
  });
});

describe("Responses request", () => {
  it("serializes the wire body: flat tools, multimodal parts, reasoning, usage accounting, trace", () => {
    const body = openRouterResponsesRequest("openai/gpt-6.1-sol", {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Read these." },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "file", file: { filename: "brief.pdf", file_data: "data:application/pdf;base64,AAAA" } },
        ],
      }],
      tools: [{ type: "function", function: { name: "save", description: "Save it", parameters: { type: "object", properties: {} } } }],
      plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
      reasoningEffort: "low",
      trace: {
        user: "user-1",
        session_id: "session-1",
        trace: { trace_id: "t", trace_name: "n", span_name: "s", generation_name: "g", turn: "turn-1" },
      },
    });

    expect(body).toEqual({
      model: "openai/gpt-6.1-sol",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Read these." },
          { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
          { type: "input_file", filename: "brief.pdf", file_data: "data:application/pdf;base64,AAAA" },
        ],
      }],
      stream: true,
      tools: [{ type: "function", name: "save", description: "Save it", parameters: { type: "object", properties: {} } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
      reasoning: { effort: "low" },
      // SDK defaults, stated on the wire: OpenRouter stores nothing.
      store: false,
      service_tier: "auto",
      user: "user-1",
      session_id: "session-1",
      trace: { trace_id: "t", trace_name: "n", span_name: "s", generation_name: "g", turn: "turn-1" },
      usage: { include: true },
    });
  });

  it("is what the streaming client sends, to the Responses endpoint", async () => {
    let url = "";
    let sent: unknown;
    const client = new OpenRouterClient({
      apiKey: "key",
      primaryModel: "openai/gpt-6.1-sol",
      sameModelRetries: 0,
      fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
        url = String(request);
        sent = JSON.parse(String(init?.body));
        return new Response(sseBody([
          { type: "response.output_text.delta", output_index: 0, delta: "hi" },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]), { headers: { "content-type": "text/event-stream", "x-generation-id": "gen-x" } });
      }) as typeof fetch,
    });
    const messages = [{ role: "user" as const, content: "hello" }];

    const result = await client.stream({ messages, reasoningEffort: "low" }, () => undefined);

    expect(url).toBe("https://openrouter.ai/api/v1/responses");
    expect(sent).toEqual(openRouterResponsesRequest("openai/gpt-6.1-sol", { messages, reasoningEffort: "low" }));
    expect(result).toMatchObject({ content: "hi", finishReason: "stop", generationId: "gen-x" });
  });
});
