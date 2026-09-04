/**
 * SPIKE — throwaway. Not production code, not on the release path.
 *
 * The synthetic harness-outcome adapter.
 *
 * This is **not** a second transcript writer. A seeded assistant turn is
 * produced by the ordinary run: the same `runHarness` call, the same Bind loop,
 * the same reserved assistant turn, the same tool-receipt ports, the same
 * activity upserts, the same terminal settlement. Exactly two things are
 * replaced, and both are the *source of model output* rather than any part of
 * how Rally records it:
 *
 * 1. `OpenRouterConfig.fetch` — a production injection point the harness
 *    already exposes — answers `chat/completions` from a recorded script
 *    instead of calling OpenRouter.
 * 2. The plugins a recorded connector call names are registered for that run
 *    with executors that return the recorded provider answer. Nothing outbound
 *    happens, and no connector has to be connected; the receipt, the plugin
 *    activity row and its duration are written by the production path.
 *
 * The wire shapes below are copied from `test-workers/helpers/openrouter-double.ts`,
 * which is the checked-in description of what Bind sends and parses.
 */
import type { HarnessPlugin, HarnessTool } from "@rally/agent-harness";

import type { SpikeAssistantFixture, SpikeFixtureTurn } from "./replay";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const CHAT_COMPLETIONS_PATH = "/api/v1/chat/completions";

/** How long a recorded tool call is allowed to pretend to take. */
const MAX_SIMULATED_TOOL_MS = 1_500;

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolCallPayload(turn: Extract<SpikeFixtureTurn, { kind: "tools" }>) {
  return turn.calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function" as const,
    function: { name: call.toolName, arguments: JSON.stringify(call.arguments) },
  }));
}

function elicitationCallPayload(turn: Extract<SpikeFixtureTurn, { kind: "elicit" }>) {
  return [{
    index: 0,
    id: turn.id,
    type: "function" as const,
    function: {
      name: "core_request_elicitation",
      // The exact shape `RequestElicitationInputSchema` accepts. Getting it
      // wrong is silent: the tool rejects the arguments, no elicitation opens,
      // Bind is told to try again, and the run ends with a tool card and no
      // question — which is what the first version of this fixture produced.
      arguments: JSON.stringify({
        prompt: turn.prompt,
        responseType: "radio",
        options: turn.options.map((option) => ({
          value: option,
          label: option,
          description: null,
        })),
        minimumSelections: 1,
        maximumSelections: 1,
      }),
    },
  }];
}

function streamedTurn(turn: SpikeFixtureTurn): Response {
  if (turn.kind === "say") {
    return sse([
      { choices: [{ delta: { content: turn.text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
  }
  const calls = turn.kind === "tools" ? toolCallPayload(turn) : elicitationCallPayload(turn);
  return sse([
    { choices: [{ delta: { tool_calls: calls }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
}

function jsonTurn(model: string, turn: SpikeFixtureTurn): Response {
  const message = turn.kind === "say"
    ? { role: "assistant", content: turn.text }
    : {
        role: "assistant",
        content: null,
        tool_calls: (turn.kind === "tools" ? toolCallPayload(turn) : elicitationCallPayload(turn))
          .map(({ id, type, function: fn }) => ({ id, type, function: fn })),
      };
  return Response.json({
    id: "spike-replay-completion",
    model,
    choices: [{ message, finish_reason: turn.kind === "say" ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/**
 * A `fetch` the harness config accepts in place of the real one.
 *
 * The script advances per *inference request*, so an attempt Bind retries reads
 * the same turn again rather than skipping one — which is what a real provider
 * would do for a request the host never accepted.
 */
export function spikeProviderFetch(fixture: SpikeAssistantFixture): typeof globalThis.fetch {
  let served = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.origin !== OPENROUTER_ORIGIN) {
      // A model catalog read, a pricing read: answer emptily rather than let a
      // seed reach the network at all.
      return Response.json({ data: [] });
    }
    if (url.pathname !== CHAT_COMPLETIONS_PATH) return Response.json({ data: [] });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    // The evidence that a replayed run bootstrapped from the canonical
    // transcript: this is the protocol array the loop actually assembled and
    // was about to send. Printed rather than returned, because nothing above
    // this point can carry it back to the caller.
    const messages = Array.isArray(body.messages)
      ? body.messages as Array<{ role?: unknown; content?: unknown }>
      : [];
    // SPIKE: this runs inside the object, where the structured logger needs an
    // `env` the harness config does not carry, and the line is the whole
    // evidence that a replayed run bootstrapped from the canonical transcript.
    // eslint-disable-next-line no-console -- see above; delete with the spike.
    console.log("spike_provider_history", JSON.stringify({
      call: served + 1,
      model: body.model,
      messageCount: messages.length,
      roles: messages.map((message) => String(message.role ?? "?")),
      firstChars: messages.map((message) => typeof message.content === "string"
        ? message.content.replace(/\s+/gu, " ").slice(0, 70)
        : Array.isArray(message.content)
          ? JSON.stringify(message.content).slice(0, 70)
          : String(message.content).slice(0, 70)),
    }));
    const turn = fixture.turns[served];
    served += 1;
    if (!turn) {
      // Exhaustion is a hard stop, not a repeat of the last turn. Repeating it
      // is how the first version of this adapter wedged the whole runtime: a
      // one-turn fixture whose turn was `core_request_elicitation` was replayed
      // on every model call, and the loop never reached a turn that ends it.
      // A 4xx is what a provider refusal looks like, so the run fails visibly.
      return Response.json(
        { error: { message: "spike_fixture_exhausted", code: 400 } },
        { status: 400 },
      );
    }
    return body.stream === true ? streamedTurn(turn) : jsonTurn(String(body.model ?? ""), turn);
  }) as typeof globalThis.fetch;
}

/** The recorded answer for one tool, keyed the way the executor can find it. */
function recordedResults(fixture: SpikeAssistantFixture): Map<string, {
  result: string; summary: string; durationMs: number;
}> {
  const results = new Map<string, { result: string; summary: string; durationMs: number }>();
  for (const turn of fixture.turns) {
    if (turn.kind !== "tools") continue;
    for (const call of turn.calls) {
      results.set(call.toolName, {
        result: call.result,
        summary: call.summary,
        durationMs: Math.min(call.durationMs, MAX_SIMULATED_TOOL_MS),
      });
    }
  }
  return results;
}

export interface SpikePluginSurface {
  plugins: HarnessPlugin[];
  /** Tool policy the host's own authorization checks read. */
  modeByTool: Map<string, "read" | "write">;
  idempotencyByTool: Map<string, "safe" | "provider_key" | "record_before_execute">;
  /** Canonical ids the host must treat as run-scope-authorized built-ins. */
  canonicalIds: string[];
}

/**
 * Register the plugins a recorded connector call names.
 *
 * Every tool is `read`/`safe` by construction: a recorded outcome is a read of
 * something that already happened, and a spike must not be able to describe a
 * write it did not make.
 */
export function spikeFixturePlugins(fixture: SpikeAssistantFixture): SpikePluginSurface {
  const results = recordedResults(fixture);
  const modeByTool = new Map<string, "read" | "write">();
  const idempotencyByTool = new Map<string, "safe" | "provider_key" | "record_before_execute">();
  const plugins: HarnessPlugin[] = [];
  for (const plugin of fixture.plugins) {
    const tools: HarnessTool[] = plugin.tools.map((tool) => {
      modeByTool.set(tool.name, "read");
      idempotencyByTool.set(tool.name, "safe");
      return {
        definition: {
          name: tool.name,
          description: tool.description,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
          capability: `spike.${plugin.modelId}.read`,
          mode: "read" as const,
          idempotency: "safe" as const,
        },
        execute: async () => {
          const recorded = results.get(tool.name);
          if (!recorded) {
            return { output: "No recorded outcome for this call.", summary: "No recorded outcome" };
          }
          // The transcript renders a plugin row's duration from the interval
          // between the activity's start and complete upserts, both of which
          // are stamped with real elapsed time by the production path. A
          // recorded call therefore has to actually take its recorded time for
          // the row to show one — capped, so a pack stays quick to seed.
          if (recorded.durationMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, recorded.durationMs));
          }
          return { output: recorded.result, summary: recorded.summary };
        },
      };
    });
    plugins.push({
      canonicalId: `avalon:spike:${plugin.modelId}`,
      modelId: plugin.modelId,
      shortWireName: plugin.shortWireName,
      displayName: plugin.displayName,
      description: plugin.description,
      tools,
      preload: true,
      explicit: true,
    });
  }
  return {
    plugins,
    modeByTool,
    idempotencyByTool,
    canonicalIds: plugins.map((plugin) => plugin.canonicalId),
  };
}
