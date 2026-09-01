/**
 * A scripted stand-in for OpenRouter, for workerd tests that let a run reach
 * the model.
 *
 * The workers suite has no provider double and a placeholder API key, so a run
 * that reaches inference makes a real outbound request. That request cannot
 * succeed here, but it does not fail quickly either: the harness allows an
 * establishment timeout, a transport retry, and each configured fallback model
 * before it gives up, which is far longer than a test's budget. The run stays
 * `executing`, and the test that was waiting on it times out somewhere
 * unrelated to what it was asserting.
 *
 * `vi.stubGlobal` is what installs this rather than `fetchMock` from
 * `cloudflare:test`: that export does not exist in this generation of
 * `@cloudflare/vitest-pool-workers` (0.22.0) or Miniflare, even though the
 * package still ships the `MockAgent` types and advertises the feature. The
 * test file, the production modules, and the code running inside a Durable
 * Object share one isolate here, so a global installed by the test is the same
 * global the object's `fetch` resolves.
 *
 * See [`docs/testing.md`](../../../../docs/testing.md#letting-a-run-reach-the-model)
 * for when a test should use this and when it should keep the run away from the
 * model instead.
 */
import { afterEach, beforeEach, expect, vi } from "vitest";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const CHAT_COMPLETIONS_PATH = "/api/v1/chat/completions";
const MODELS_PATH = "/api/v1/models";

/** One inference request, as the handler sees it. */
export interface ProviderCall {
  /** The model the router selected for this attempt. */
  readonly model: string;
  /** Whether the harness asked for a streamed response. */
  readonly stream: boolean;
  /** The full protocol transcript sent for this turn. */
  readonly messages: readonly { role: string; content: unknown }[];
  /** Names of the tools offered on this turn, in the order they were sent. */
  readonly toolNames: readonly string[];
  /** The raw request payload, for anything the fields above do not model. */
  readonly body: Record<string, unknown>;
}

/**
 * What the handler wants the provider to answer.
 *
 * `say` ends the turn — the loop stops when an assistant message arrives with
 * no tool calls. `callTool` drives a tool round trip, so the handler is called
 * again with the tool's result in `messages`.
 */
export type ProviderReply =
  | { readonly say: string }
  | { readonly callTool: { readonly id?: string; readonly name: string; readonly arguments: unknown } }
  | { readonly httpError: { readonly status: number; readonly body?: unknown } }
  | { readonly raw: Response };

export type ProviderHandler = (call: ProviderCall) => ProviderReply | Promise<ProviderReply>;

export interface OpenRouterDouble {
  /** Every inference request the run made, in order. */
  readonly calls: readonly ProviderCall[];
}

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * The stream the harness parses: a chunk carrying output, then a finish reason,
 * then usage.
 *
 * Only the output chunk is load-bearing for ending a turn — the loop stops when
 * an assistant message arrives with no tool calls, and dropping the
 * `finish_reason` chunk was verified not to change that. The finish reason is
 * sent anyway because it is what a real stream carries, it is what the harness
 * reads to detect a length-truncated turn, and a double whose shape drifts from
 * the provider's teaches the next reader the wrong thing.
 */
function streamedReply(reply: Exclude<ProviderReply, { raw: Response } | { httpError: unknown }>): Response {
  if ("say" in reply) {
    return sse([
      { choices: [{ delta: { content: reply.say }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
  }
  const call = reply.callTool;
  return sse([
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: call.id ?? `call-${call.name}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        },
        finish_reason: null,
      }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
}

/** The non-streamed shape, for the structured calls that do not stream. */
function jsonReply(
  model: string,
  reply: Exclude<ProviderReply, { raw: Response } | { httpError: unknown }>,
): Response {
  const message = "say" in reply
    ? { role: "assistant", content: reply.say }
    : {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: reply.callTool.id ?? `call-${reply.callTool.name}`,
          type: "function",
          function: {
            name: reply.callTool.name,
            arguments: JSON.stringify(reply.callTool.arguments),
          },
        }],
      };
  return Response.json({
    id: "double-completion",
    model,
    choices: [{ message, finish_reason: "say" in reply ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/**
 * Serve OpenRouter from `handler` for the duration of each test in the
 * enclosing `describe`.
 *
 * Any other outbound host is refused rather than passed through, and the
 * refusal is recorded as well as thrown: production code turns a failed
 * provider fetch into a run failure and a failed catalog fetch into a shrug, so
 * a throw alone can be swallowed on the way out. The recorded list is asserted
 * empty after every test, which is what makes an unexpected call visible
 * instead of a surprise later.
 */
export function useOpenRouterDouble(handler: ProviderHandler): OpenRouterDouble {
  const calls: ProviderCall[] = [];
  const unexpected: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    unexpected.length = 0;
    vi.stubGlobal("fetch", async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url);
      if (url.origin !== OPENROUTER_ORIGIN) {
        unexpected.push(url.toString());
        throw new Error(`openrouter_double_unexpected_host:${url.origin}${url.pathname}`);
      }
      if (url.pathname === MODELS_PATH) {
        // Deliberately empty: the harness falls back to its own documented
        // context window for a model the catalog does not describe, and this
        // double is not the place to invent a number for one.
        return Response.json({ data: [] });
      }
      if (url.pathname !== CHAT_COMPLETIONS_PATH) {
        unexpected.push(url.toString());
        throw new Error(`openrouter_double_unexpected_path:${url.pathname}`);
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const call: ProviderCall = {
        model: String(body.model ?? ""),
        stream: body.stream === true,
        messages: Array.isArray(body.messages)
          ? body.messages as { role: string; content: unknown }[]
          : [],
        toolNames: Array.isArray(body.tools)
          ? body.tools.flatMap((tool) => {
            const name = (tool as { function?: { name?: unknown } })?.function?.name;
            return typeof name === "string" ? [name] : [];
          })
          : [],
        body,
      };
      calls.push(call);

      const reply = await handler(call);
      if ("raw" in reply) return reply.raw;
      if ("httpError" in reply) {
        return Response.json(
          reply.httpError.body ?? { error: { message: "provider refused" } },
          { status: reply.httpError.status },
        );
      }
      return call.stream ? streamedReply(reply) : jsonReply(call.model, reply);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Read before clearing so the next test starts clean even when this fails.
    const seen = [...unexpected];
    unexpected.length = 0;
    expect(seen, "outbound requests the OpenRouter double did not expect").toEqual([]);
  });

  return {
    get calls() {
      return calls;
    },
  };
}
