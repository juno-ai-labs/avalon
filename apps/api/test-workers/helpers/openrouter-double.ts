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
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { providerRequestView, responsesStreamResponse } from "@rally/agent-harness/test-support/responses-stream";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
/** Streamed agent turns. */
const RESPONSES_PATH = "/api/v1/responses";
/** Structured, non-streamed calls, which stay on Chat Completions. */
const CHAT_COMPLETIONS_PATH = "/api/v1/chat/completions";
const MODELS_PATH = "/api/v1/models";

/** One inference request, as the handler sees it. */
export interface ProviderCall {
  /** The model the router selected for this attempt. */
  readonly model: string;
  /** Whether the harness asked for a streamed response. */
  readonly stream: boolean;
  /**
   * The full protocol transcript sent for this turn, Chat-shaped. A streamed
   * turn's Responses `input` is read back into messages by
   * `providerRequestView`; the raw items stay on `body.input`.
   */
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
  /** Completion judgments are a separate provider boundary, not acting-model turns. */
  readonly completionCalls: readonly Record<string, unknown>[];
}

/**
 * The stream the harness parses, described as a chunk carrying output, then a
 * finish reason, then usage, and sent as the Responses events OpenRouter
 * streams for them (output, then one `response.completed` carrying usage).
 *
 * Only the output is load-bearing for ending a turn — the loop stops when an
 * assistant message arrives with no tool calls. The terminal status is sent
 * anyway because it is what a real stream carries, it is what the harness
 * reads to detect a length-truncated turn, and a double whose shape drifts from
 * the provider's teaches the next reader the wrong thing.
 */
function streamedReply(reply: Exclude<ProviderReply, { raw: Response } | { httpError: unknown }>): Response {
  if ("say" in reply) {
    return responsesStreamResponse([
      { choices: [{ delta: { content: reply.say }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
  }
  const call = reply.callTool;
  return responsesStreamResponse([
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
 * enclosing `describe`. Completed scripted turns receive a successful JEV
 * completion judgment; other classifiers retain their unavailable response.
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
  const completionCalls: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const mutableEnv: { TYPESAFE_API_KEY?: string } = env;
  let originalTypesafeKey: string | undefined;

  beforeEach(() => {
    calls.length = 0;
    completionCalls.length = 0;
    unexpected.length = 0;
    originalTypesafeKey = mutableEnv.TYPESAFE_API_KEY;
    mutableEnv.TYPESAFE_API_KEY = "openrouter-double-completion-key";
    vi.stubGlobal("fetch", async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url);
      if (url.href === "https://api.typesafe.ai/v1/systemone") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body
          : input instanceof Request ? await input.clone().text() : "{}");
        if (!body.questions?.stopping) return Response.json({ error: "test_classifier_unavailable" }, { status: 503 });
        completionCalls.push(body);
        return Response.json({ model: "jev-1.14.0",
          answers: { stopping: { type: "choice", choice: "answer_or_result", confidence: 0.99 } } });
      }
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
      if (url.pathname !== RESPONSES_PATH && url.pathname !== CHAT_COMPLETIONS_PATH) {
        unexpected.push(url.toString());
        throw new Error(`openrouter_double_unexpected_path:${url.pathname}`);
      }

      const body = providerRequestView(JSON.parse(String(init?.body ?? "{}")));
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
    if (originalTypesafeKey === undefined) delete mutableEnv.TYPESAFE_API_KEY;
    else mutableEnv.TYPESAFE_API_KEY = originalTypesafeKey;
    // Read before clearing so the next test starts clean even when this fails.
    const seen = [...unexpected];
    unexpected.length = 0;
    expect(seen, "outbound requests the OpenRouter double did not expect").toEqual([]);
  });

  return {
    get calls() {
      return calls;
    },
    get completionCalls() {
      return completionCalls;
    },
  };
}
