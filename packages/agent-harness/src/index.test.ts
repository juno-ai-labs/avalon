import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  canonicalToolInputHash,
  classifyAddressingHeuristically,
  OpenRouterClient,
  runHarness,
  type HarnessEvent,
  type HarnessTool,
} from "./index";

describe("agent harness", () => {
  it("keeps explicit connector requests agent-directed", () => {
    expect(
      classifyAddressingHeuristically({
        message: "Can you find the thread?",
        activeTask: false,
        connectorMentions: ["gmail"]
      }).classification
    ).toBe("agent_action");
  });

  it("allows human acknowledgement to remain unanswered", () => {
    expect(
      classifyAddressingHeuristically({ message: "Sounds good!", activeTask: false }).classification
    ).toBe("human_only");
  });

  it("canonicalizes tool inputs for stable hashes", () => {
    expect(__testing.canonicalJson({ b: 2, a: { z: 1, y: 0 } })).toBe(
      '{"a":{"y":0,"z":1},"b":2}'
    );
  });

  it("uses one stable canonical hash for tool retry lookups", async () => {
    await expect(canonicalToolInputHash({ b: 2, a: { z: 1, y: 0 } })).resolves.toBe(
      await canonicalToolInputHash({ a: { y: 0, z: 1 }, b: 2 }),
    );
  });

  it("binds host fetch before invoking it from the client", async () => {
    const receiverAwareFetch = function (this: unknown): Promise<Response> {
      if (this !== globalThis) throw new TypeError("illegal invocation");
      return Promise.resolve(Response.json({
        choices: [{ message: { content: '{"ok":true}' } }],
      }));
    } as typeof fetch;
    const client = new OpenRouterClient({
      apiKey: "test-key",
      primaryModel: "test/model",
      fetch: receiverAwareFetch,
    });

    await expect(client.structured({
      messages: [{ role: "user", content: "test" }],
      schemaName: "host_fetch",
      jsonSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      parse: (value) => value as { ok: boolean },
    })).resolves.toEqual({ ok: true });
  });

  it("retries transient stream failures on the same model before fallback", async () => {
    const requests: string[] = [];
    const responses = [
      Response.json({ error: { message: "still busy" } }, { status: 503 }),
      streamResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
    ];
    const fetcher = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      requests.push((JSON.parse(String(init?.body)) as { model: string }).model);
      if (requests.length === 1) throw new TypeError("network unavailable");
      return responses.shift()!;
    }) as typeof fetch;
    const client = new OpenRouterClient({
      apiKey: "test-key",
      primaryModel: "primary/model",
      fallbackModels: ["fallback/model"],
      sameModelRetries: 1,
      fetch: fetcher,
    });

    await expect(client.stream({ messages: [{ role: "user", content: "test" }] }, () => {}))
      .resolves.toMatchObject({ model: "fallback/model", content: "ok" });
    expect(requests).toEqual(["primary/model", "primary/model", "fallback/model"]);
  });

  it("treats OpenRouter auth failures as terminal", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { error: { message: "invalid key" } },
      { status: 401 },
    )) as typeof fetch;
    const client = new OpenRouterClient({
      apiKey: "test-key",
      primaryModel: "primary/model",
      fallbackModels: ["fallback/model"],
      fetch: fetcher,
    });

    await expect(client.stream({ messages: [{ role: "user", content: "test" }] }, () => {}))
      .rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries or falls back after streamed assistant output", async () => {
    const fetcher = vi.fn(async () => streamResponse([
      { choices: [{ delta: { content: "partial" }, finish_reason: null }] },
      { error: { message: "provider stream broke" } },
    ])) as typeof fetch;
    const client = new OpenRouterClient({
      apiKey: "test-key",
      primaryModel: "primary/model",
      fallbackModels: ["fallback/model"],
      fetch: fetcher,
    });

    await expect(client.stream({ messages: [{ role: "user", content: "test" }] }, () => {}))
      .rejects.toThrow("provider stream broke");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies its wall-clock deadline separately from external cancellation", async () => {
    const hangingFetch = ((_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) rejectAbort();
      else signal?.addEventListener("abort", rejectAbort, { once: true });
    })) as typeof fetch;
    const deadline = await runHarness(runInput(hangingFetch, { maxWallClockMs: 5 }));
    expect(deadline).toMatchObject({
      status: "failed",
      failure: { kind: "deadline", code: "harness_deadline_exceeded" },
    });

    const controller = new AbortController();
    controller.abort("stopped_by_user");
    const stopped = await runHarness({ ...runInput(hangingFetch), signal: controller.signal });
    expect(stopped).toMatchObject({ status: "stopped" });
    expect(stopped.failure).toBeUndefined();
  });

  it("uses stable invocation IDs while preserving provider tool-result order and run stats", async () => {
    const requestBodies: Array<{ messages: Array<{ role: string; tool_call_id?: string }> }> = [];
    const responses = [
      streamResponse([{
        choices: [{
          delta: {
            tool_calls: [
              toolDelta(0, "provider-write-1", "write_one"),
              toolDelta(1, "provider-read-1", "read_one"),
              toolDelta(2, "provider-read-2", "read_two"),
              toolDelta(3, "provider-write-2", "write_two"),
            ],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }]),
      streamResponse([{
        choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }]),
    ];
    const fetcher = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as typeof requestBodies[number]);
      return responses.shift()!;
    }) as typeof fetch;
    const events: HarnessEvent[] = [];
    const executionOrder: string[] = [];
    const tools = [
      harnessTool("write_one", "write", executionOrder),
      harnessTool("read_one", "read", executionOrder),
      harnessTool("read_two", "read", executionOrder),
      harnessTool("write_two", "write", executionOrder),
    ];

    const outcome = await runHarness({
      ...runInput(fetcher),
      tools,
      onEvent: (event) => { events.push(event); },
    });

    expect(outcome).toMatchObject({
      status: "completed",
      iterations: 2,
      toolCalls: 4,
      stats: { turns: 2, toolCalls: 4, inputTokens: 15, outputTokens: 5 },
    });
    expect(outcome.stats.toolTimeBreakdownMs).toEqual(expect.objectContaining({
      write_one: expect.any(Number),
      read_one: expect.any(Number),
      read_two: expect.any(Number),
      write_two: expect.any(Number),
    }));
    expect(executionOrder.filter((entry) => entry.startsWith("write"))).toEqual([
      "write_one:start", "write_one:end", "write_two:start", "write_two:end",
    ]);
    expect(events.filter((event) => event.type === "tool_started").map((event) =>
      event.type === "tool_started" ? event.toolCallId : ""
    )).toEqual([
      "run-1:turn:1:tool:1",
      "run-1:turn:1:tool:2",
      "run-1:turn:1:tool:0",
      "run-1:turn:1:tool:3",
    ]);
    expect(requestBodies[1]!.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id))
      .toEqual(["provider-write-1", "provider-read-1", "provider-read-2", "provider-write-2"]);
  });

  it("bounds a signal-ignoring tool and emits one terminal event for its start", async () => {
    const responses = [
      streamResponse([{
        choices: [{
          delta: { tool_calls: [toolDelta(0, "provider-slow", "slow_read")] },
          finish_reason: "tool_calls",
        }],
      }]),
      streamResponse([{ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] }]),
    ];
    const fetcher = vi.fn(async () => responses.shift()!) as typeof fetch;
    const events: HarnessEvent[] = [];
    const slowTool = harnessTool("slow_read", "read", [], () => new Promise(() => {}));
    const outcome = await runHarness({
      ...runInput(fetcher, { toolTimeoutMs: 5 }),
      tools: [slowTool],
      onEvent: (event) => { events.push(event); },
    });

    expect(outcome.status).toBe("completed");
    const lifecycle = events.filter((event) => event.type.startsWith("tool_"));
    expect(lifecycle.map((event) => event.type)).toEqual(["tool_started", "tool_failed"]);
    expect(lifecycle[1]).toMatchObject({ phase: "execution" });
  });

  it("does not swallow external cancellation as a normal tool error", async () => {
    const fetcher = vi.fn(async () => streamResponse([{
      choices: [{
        delta: { tool_calls: [toolDelta(0, "provider-slow", "slow_read")] },
        finish_reason: "tool_calls",
      }],
    }])) as typeof fetch;
    const controller = new AbortController();
    const events: HarnessEvent[] = [];
    const outcome = await runHarness({
      ...runInput(fetcher),
      signal: controller.signal,
      tools: [harnessTool("slow_read", "read", [], () => new Promise(() => {}))],
      onEvent: (event) => {
        events.push(event);
        if (event.type === "tool_started") controller.abort("stopped_by_user");
      },
    });

    expect(outcome.status).toBe("stopped");
    expect(events.filter((event) => event.type === "tool_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_failed")).toHaveLength(1);
  });

  it("normalizes provider-compatible flat automation triggers", () => {
    expect(
      __testing.normalizeAutomationDraft({
        name: "Weekly update",
        description: "Summarize the week",
        instructions: "Write a short update.",
        triggers: [{
          type: "calendar",
          rrule: "FREQ=WEEKLY;BYDAY=FR",
          timezone: "America/Los_Angeles",
          summary: "Friday afternoon",
          intervalSeconds: null,
          connectorType: null,
          eventTypes: null,
          deterministicFilters: null,
          deterministicPrefilter: null,
          condition: null,
          resourceId: null
        }],
        requiredCapabilities: [],
        expectedOutputs: ["changelog"],
        defaultBehavior: "{\"tone\":\"concise\"}",
        suggestedScope: "workspace",
        followUpQuestion: null,
        ready: true
      })
    ).toMatchObject({
      triggers: [{
        type: "calendar",
        rrule: "FREQ=WEEKLY;BYDAY=FR",
        timezone: "America/Los_Angeles"
      }],
      defaultBehavior: { tone: "concise" }
    });
    expect(JSON.stringify(__testing.automationJsonSchema)).not.toContain('"oneOf"');
  });
});

function streamResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function toolDelta(index: number, id: string, name: string) {
  return {
    index,
    id,
    type: "function" as const,
    function: { name, arguments: "{}" },
  };
}

function runInput(fetcher: typeof fetch, overrides: Partial<{
  maxWallClockMs: number;
  toolTimeoutMs: number;
}> = {}) {
  return {
    config: {
      apiKey: "test-key",
      primaryModel: "test/model",
      fetch: fetcher,
      maxIterations: 4,
      maxToolCalls: 10,
      maxWallClockMs: overrides.maxWallClockMs ?? 1_000,
      toolTimeoutMs: overrides.toolTimeoutMs ?? 100,
      maxWebResults: 4,
    },
    workspaceId: "workspace-1",
    workstreamId: "workstream-1",
    harnessRunId: "run-1",
    executionPrincipal: { type: "user" as const, userId: "user-1" },
    systemPrompt: "Be useful.",
    messages: [{ role: "user" as const, content: "Do the work" }],
    tools: [] as HarnessTool[],
    onEvent: () => {},
  };
}

function harnessTool(
  name: string,
  mode: "read" | "write",
  executionOrder: string[],
  execute?: () => Promise<never>,
): HarnessTool {
  return {
    definition: {
      name,
      description: `Run ${name}`,
      inputSchema: { type: "object", additionalProperties: false },
      capability: `${name}.run`,
      mode,
      idempotency: mode === "read" ? "safe" : "provider_key",
    },
    execute: async () => {
      executionOrder.push(`${name}:start`);
      if (execute) return execute();
      await Promise.resolve();
      executionOrder.push(`${name}:end`);
      return { output: { name }, summary: `Ran ${name}` };
    },
  };
}
