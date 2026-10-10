/**
 * Streamed OpenRouter turns for tests, as the Responses events OpenRouter
 * sends.
 *
 * The harness suites describe a scripted turn in Chat Completions chunks
 * (`{ choices: [{ delta, finish_reason }], usage }`): the vocabulary they were
 * written in, and the one Bind's transcript still uses. OpenRouter turns now
 * stream the Responses API, so this re-expresses each chunk as the events that
 * API emits (text deltas, function-call items and argument deltas, then one
 * terminal `response.completed` or `response.incomplete` carrying usage). The
 * client under test parses real Responses bytes; only the fixture's wording is
 * Chat-shaped. Azure turns stay on Chat Completions and use `chatStreamResponse`.
 */

type ChatChunk = {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Record<string, unknown>;
  error?: Record<string, unknown>;
  openrouter_metadata?: Record<string, unknown>;
};

/** Stateful, so a test that writes chunks one at a time can still end the stream once. */
export function createResponsesFixtureEncoder() {
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let responseId: string | undefined;
  let metadata: Record<string, unknown> | undefined;
  const announced = new Set<number>();
  return {
    chunk(raw: unknown): Record<string, unknown>[] {
      const chunk = raw as ChatChunk;
      const events: Record<string, unknown>[] = [];
      if (chunk.id) responseId = chunk.id;
      if (chunk.openrouter_metadata) metadata = chunk.openrouter_metadata;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.error) {
        events.push({ type: "response.failed", response: { status: "failed", error: chunk.error } });
        return events;
      }
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const text = choice?.delta?.content;
      if (text) {
        events.push({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text });
      }
      for (const [position, call] of (choice?.delta?.tool_calls ?? []).entries()) {
        const index = call.index ?? position;
        if (!announced.has(index)) {
          announced.add(index);
          events.push({
            type: "response.output_item.added",
            output_index: index,
            item: {
              type: "function_call",
              id: `fc_${index}`,
              ...(call.id ? { call_id: call.id } : {}),
              name: call.function?.name ?? "",
              arguments: "",
            },
          });
        }
        if (call.function?.arguments) {
          events.push({
            type: "response.function_call_arguments.delta",
            output_index: index,
            delta: call.function.arguments,
          });
        }
      }
      return events;
    },
    finish(): Record<string, unknown>[] {
      if (finishReason === null && usage === null) return [];
      const incomplete = finishReason !== null
        && finishReason !== "stop"
        && finishReason !== "tool_calls";
      return [{
        type: incomplete ? "response.incomplete" : "response.completed",
        response: {
          ...(responseId ? { id: responseId } : {}),
          status: incomplete ? "incomplete" : "completed",
          ...(incomplete ? {
            incomplete_details: { reason: finishReason === "length" ? "max_output_tokens" : finishReason },
          } : {}),
          ...(usage ? { usage: responsesUsage(usage) } : {}),
          ...(metadata ? { openrouter_metadata: metadata } : {}),
        },
      }];
    },
  };
}

/** Chat-chunk fixtures as the Responses events OpenRouter streams for them. */
export function responsesEvents(chunks: readonly unknown[]): Record<string, unknown>[] {
  const encoder = createResponsesFixtureEncoder();
  return [...chunks.flatMap((chunk) => encoder.chunk(chunk)), ...encoder.finish()];
}

export function sseBody(events: readonly unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** An OpenRouter streamed turn. */
export function responsesStreamResponse(chunks: readonly unknown[]): Response {
  return new Response(sseBody(responsesEvents(chunks)), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** An Azure streamed turn, which is still Chat Completions. */
export function chatStreamResponse(chunks: readonly unknown[]): Response {
  return new Response(sseBody(chunks), { headers: { "content-type": "text/event-stream" } });
}

function responsesUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const costDetails = usage.cost_details as Record<string, unknown> | undefined;
  const cached = usage.cached_tokens ?? promptDetails?.cached_tokens;
  const reasoning = usage.reasoning_tokens ?? completionDetails?.reasoning_tokens;
  return {
    ...(usage.prompt_tokens === undefined ? {} : { input_tokens: usage.prompt_tokens }),
    ...(usage.completion_tokens === undefined ? {} : { output_tokens: usage.completion_tokens }),
    ...(usage.total_tokens === undefined ? {} : { total_tokens: usage.total_tokens }),
    ...(usage.cost === undefined ? {} : { cost: usage.cost }),
    ...(usage.is_byok === undefined ? {} : { is_byok: usage.is_byok }),
    ...(costDetails ? {
      cost_details: {
        upstream_inference_cost: costDetails.upstream_inference_cost,
        upstream_inference_input_cost: costDetails.upstream_inference_prompt_cost,
        upstream_inference_output_cost: costDetails.upstream_inference_completions_cost,
      },
    } : {}),
    ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }),
    ...(reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoning } }),
  };
}

type ChatViewMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

/**
 * A provider request body seen as Chat Completions, for tests that assert on
 * what the model was shown (the transcript, the tool surface) rather than on
 * the wire. A Responses body gains `messages` and Chat-shaped `tools` beside
 * its own fields, which stay intact for tests that assert on the wire; a Chat
 * Completions body (Azure) is returned unchanged.
 */
export function providerRequestView<T = Record<string, unknown>>(body: unknown): T {
  const request = body as Record<string, unknown>;
  if (!Array.isArray(request.input)) return body as T;
  return {
    ...request,
    messages: chatMessagesFromInput(request.input as Record<string, unknown>[]),
    ...(Array.isArray(request.tools) ? {
      tools: (request.tools as Record<string, unknown>[]).map((tool) => tool.type === "function"
        ? {
            type: "function",
            function: {
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              parameters: tool.parameters,
              ...(tool.strict === undefined ? {} : { strict: tool.strict }),
            },
          }
        : tool),
    } : {}),
  } as T;
}

export function chatMessagesFromInput(input: readonly Record<string, unknown>[]): ChatViewMessage[] {
  const messages: ChatViewMessage[] = [];
  for (const item of input) {
    if (item.type === "function_call") {
      const call = {
        id: String(item.call_id),
        type: "function" as const,
        function: { name: String(item.name), arguments: String(item.arguments) },
      };
      const previous = messages.at(-1);
      if (previous?.role === "assistant") (previous.tool_calls ??= []).push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", content: chatContent(item.output), tool_call_id: String(item.call_id) });
      continue;
    }
    messages.push({ role: String(item.role), content: chatContent(item.content) });
  }
  return messages;
}

function chatContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return (content as Record<string, unknown>[]).map((part) => {
    if (part.type === "input_text") return { type: "text", text: part.text };
    if (part.type === "input_image") return { type: "image_url", image_url: { url: part.image_url, detail: part.detail } };
    if (part.type === "input_file") return { type: "file", file: { filename: part.filename, file_data: part.file_data } };
    return part;
  });
}

/**
 * A streamed turn in the shape the endpoint at `request` sends: Responses from
 * OpenRouter, Chat Completions from Azure. For tests whose one fetcher serves
 * both providers on a routed turn.
 */
export function providerStreamResponse(request: RequestInfo | URL, chunks: readonly unknown[]): Response {
  const url = typeof request === "string" || request instanceof URL ? String(request) : request.url;
  return url.startsWith("https://openrouter.ai/") ? responsesStreamResponse(chunks) : chatStreamResponse(chunks);
}
