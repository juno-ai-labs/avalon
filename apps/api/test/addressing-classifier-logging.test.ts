import "../../../tests/isolated-region";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { classifyWorkstreamMessage } from "../src/services/integrations";
import type { InferenceLakehouseRecord } from "../src/services/inference-lakehouse";
import {
  createCloudflareTestBinding,
  createTestEnv,
} from "./helpers/cloudflare-test";

function fixture(options: {
  beforePayloadPut?: () => Promise<void>;
} = {}) {
  const objects = new Map<string, string>();
  const deferred: Promise<unknown>[] = [];
  const payloadPut = vi.fn(async (key: string, value: string) => {
    await options.beforePayloadPut?.();
    objects.set(key, value);
  });
  const getObjectDetails = vi.fn(async () => {
    throw new Error("addressing_flag_should_not_be_evaluated");
  });
  const env = createTestEnv({
    APP_ENV: "production",
    AVALON_REGION: "global",
    LOG_LEVEL: "info",
    OPENROUTER_API_KEY: "openrouter-secret",
    TYPESAFE_API_KEY: "typesafe-secret",
    OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
    OPENROUTER_FALLBACK_MODELS: "",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_STRUCTURED_MODEL: "google/gemini-2.5-flash-lite",
    FLAGS: createCloudflareTestBinding<Flagship>({ getObjectDetails }),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({
      put: payloadPut,
      async delete(key: string) {
        objects.delete(key);
      },
    }),
    INFERENCE_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({
      async send() {},
    }),
    INFERENCE_LAKEHOUSE: createCloudflareTestBinding<Env["INFERENCE_LAKEHOUSE"]>({
      async send() {},
    }),
  });
  return {
    env,
    getObjectDetails,
    objects,
    payloadPut,
    defer(promise: Promise<unknown>) {
      deferred.push(promise);
    },
    async settleDeferred() {
      await Promise.all(deferred);
    },
  };
}

const input = {
  message: "Please review the launch plan",
  activeTask: false,
  connectorMentions: [],
  humanMentions: [],
  recentMessages: [],
  workspaceId: "workspace-1",
  workstreamId: "workstream-1",
  userId: "user-1",
};

function records(objects: Map<string, string>): InferenceLakehouseRecord[] {
  return [...objects.values()].map((value) => JSON.parse(value) as InferenceLakehouseRecord);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("addressing classifier logging", () => {
  it("does not hold the classifier result behind lakehouse storage", async () => {
    const { env } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    env.PAYLOADS = createCloudflareTestBinding<R2Bucket>({ put: vi.fn(() => blocked) });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      model: "jev-1.13.0",
      answers: {
        addressing: {
          type: "choice",
          choice: "rally_should_act",
          confidence: 0.91,
          probabilities: { rally_should_act: 0.91, people_only: 0.09 },
        },
      },
      usage: { input_tokens: 181, output_tokens: 12 },
    })));
    vi.spyOn(console, "info").mockImplementation(() => {});

    let settled = false;
    const deferred: Promise<unknown>[] = [];
    const classification = classifyWorkstreamMessage(env, {
      ...input,
      defer: (promise) => deferred.push(promise),
    }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(true));
    await expect(classification).resolves.toMatchObject({ classification: "agent_action" });
    release();
    await Promise.all(deferred);
  });

  it("logs an accepted JEV outcome and archives the exact inference response", async () => {
    const { env, getObjectDetails, objects, defer, settleDeferred } = fixture();
    const response = {
      model: "jev-1.13.0",
      answers: {
        addressing: {
          type: "choice",
          choice: "rally_should_act",
          confidence: 0.91,
          probabilities: { rally_should_act: 0.91, people_only: 0.09 },
        },
      },
      usage: { input_tokens: 181, output_tokens: 12 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(response)));
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(classifyWorkstreamMessage(env, { ...input, defer })).resolves.toMatchObject({
      classification: "agent_action",
      confidence: 0.91,
    });
    await settleDeferred();
    expect(getObjectDetails).not.toHaveBeenCalled();

    const entries = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "structured_inference",
        provider: "typesafe",
        stage: "complete",
        trace_id: expect.any(String),
        inference_request_id: expect.any(String),
        response_bytes: expect.any(Number),
        success: true,
      }),
      expect.objectContaining({
        event: "addressing_classifier_outcome",
        trace_id: expect.any(String),
        success: true,
        outcome: "typesafe_accepted",
        selected_provider: "typesafe",
        typesafe_status: "success",
        fallback_attempted: false,
        classification: "agent_action",
        confidence: 0.91,
      }),
    ]));
    await vi.waitFor(() => {
      expect(records(objects)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_type: "attempt",
          provider: "typesafe",
          success: true,
          response,
        }),
      ]));
    });
  });

  it("counts a low-confidence JEV response separately from fallback success", async () => {
    const { env, objects, defer, settleDeferred } = fixture();
    const typesafeResponse = {
      model: "jev-1.13.0",
      answers: {
        addressing: {
          type: "choice",
          choice: "people_only",
          confidence: 0.5,
          probabilities: { rally_should_act: 0.5, people_only: 0.5 },
        },
      },
      usage: { input_tokens: 180, output_tokens: 12 },
    };
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) return Response.json(typesafeResponse);
      return Response.json({
        id: "fallback-generation",
        model: "deepseek/deepseek-v4-flash-0731",
        choices: [{ message: { content: JSON.stringify({
          classification: "agent_action",
          confidence: 0.82,
          rationaleCode: "imperative",
        }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 210, completion_tokens: 18 },
      });
    }));
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(classifyWorkstreamMessage(env, { ...input, defer })).resolves.toMatchObject({
      classification: "agent_action",
      confidence: 0.82,
    });
    await settleDeferred();

    const outcome = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "addressing_classifier_outcome");
    expect(outcome).toMatchObject({
      success: true,
      outcome: "typesafe_low_confidence_fallback",
      selected_provider: "openrouter",
      typesafe_status: "success",
      fallback_attempted: true,
      classification: "agent_action",
      confidence: 0.82,
    });
    await vi.waitFor(() => {
      expect(records(objects).filter((record) => record.event_type === "attempt")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "typesafe", success: true, response: typesafeResponse }),
          expect.objectContaining({ provider: "openrouter", success: true }),
        ]),
      );
    });
  });

  it("names the deterministic floor when both remote cascade stages fail", async () => {
    const { env, defer, settleDeferred } = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(classifyWorkstreamMessage(env, { ...input, defer })).resolves.toMatchObject({
      classification: "agent_action",
      rationaleCode: "imperative",
    });
    await settleDeferred();

    const outcome = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "addressing_classifier_outcome");
    expect(outcome).toMatchObject({
      success: true,
      outcome: "typesafe_and_openrouter_failure_terminal_heuristic",
      selected_provider: "heuristic",
      typesafe_status: "failure",
      fallback_attempted: true,
      classification: "agent_action",
    });
  });

  it("starts JEV without waiting for inference archive staging", async () => {
    let releasePayloadPut!: () => void;
    const payloadPutReleased = new Promise<void>((resolve) => {
      releasePayloadPut = resolve;
    });
    const { env, defer, objects, payloadPut, settleDeferred } = fixture({
      beforePayloadPut: async () => { await payloadPutReleased; },
    });
    const fetcher = vi.fn(async () => Response.json({
      model: "jev-1.13.0",
      answers: {
        addressing: {
          type: "choice",
          choice: "rally_should_act",
          confidence: 0.91,
          probabilities: { rally_should_act: 0.91, people_only: 0.09 },
        },
      },
    }));
    vi.stubGlobal("fetch", fetcher);

    const classification = classifyWorkstreamMessage(env, { ...input, defer });
    try {
      await vi.waitFor(() => expect(payloadPut).toHaveBeenCalled());
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(classification).resolves.toMatchObject({
        classification: "agent_action",
      });
    } finally {
      releasePayloadPut();
      await settleDeferred();
    }
    expect(payloadPut).toHaveBeenCalledTimes(2);
    expect(records(objects)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "request", provider: "typesafe" }),
      expect.objectContaining({ event_type: "attempt", provider: "typesafe", success: true }),
    ]));
  });
  it.each([true, false])("uses continuation for ready or inactive follow-ups (%s)", async (resume) => {
    const { env, objects, defer, settleDeferred } = fixture();
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      requests.push(body);
      const isContinuation = "continuation" in body.questions;
      return Response.json({
        model: "jev-1.13.0",
        answers: isContinuation
          ? { continuation: { type: "choice", choice: resume ? "resume_requested_work" : "followup_without_rally_action", confidence: 0.9 }, assignment: { type: "choice", choice: "assigned_to_rally", confidence: 0.9 }, contributors: { type: "choice", choice: "contributors_present", confidence: 0.9 } }
          : { addressing: { type: "choice", choice: resume ? "people_only" : "rally_should_act", confidence: 0.95 } },
      });
    }));
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await classifyWorkstreamMessage(env, {
      ...input,
      authorName: "Ren",
      message: "My review found a missing backup.",
      recentMessages: [{ authorType: "human", authorName: "Jo", message: "Rally, once Ren sends their review, summarize the risks." }],
      defer,
    });
    expect(result).toMatchObject(resume
      ? { classification: "agent_action", confidence: 0.9, rationaleCode: "deferred_request" }
      : { classification: "human_only", confidence: 0.9, rationaleCode: "human_coordination" });
    expect(requests).toHaveLength(2);
    expect(requests.find((request) => "continuation" in (request.questions as Record<string, unknown>))).toMatchObject({ state: { new_message: { authorName: "Ren" } } });
    const outcomes = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({
      event: "addressing_classifier_outcome",
      outcome: resume ? "continuation_accepted" : "continuation_inactive",
      continuation_stage: "primary",
      continuation_decision: resume ? "resume_requested_work" : "followup_without_rally_action",
    })]));
    await settleDeferred();
    expect(records(objects).filter((record) => record.schema_name === "message_continuation")).toHaveLength(2);
  });

  it("leaves an already admitted uncertain active-task message on its existing path", async () => {
    const { env, defer, settleDeferred } = fixture();
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      return Response.json({ model: "jev-1.13.0", answers: "continuation" in body.questions ? {
        continuation: { type: "choice", choice: "followup_without_rally_action", confidence: 0.9 },
        assignment: { type: "choice", choice: "not_assigned_to_rally", confidence: 0.9 }, contributors: { type: "choice", choice: "contributors_present", confidence: 0.9 },
      } : { addressing: { type: "choice", choice: "no_clear_request", confidence: 0.9 },
    } }); });
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(classifyWorkstreamMessage(env, {
      ...input, activeTask: true,
      recentMessages: [{ authorType: "human", authorName: "Jo", message: "Rally, review the risks." }],
      defer,
    })).resolves.toMatchObject({ classification: "uncertain" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await settleDeferred();
  });

  it("uses ordinary addressing if continuation providers are unavailable", async () => {
    const { env, defer, settleDeferred } = fixture();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions?: Record<string, unknown> };
      return body.questions && "addressing" in body.questions
        ? Response.json({ model: "jev-1.13.0", answers: {
          addressing: { type: "choice", choice: "rally_should_act", confidence: 0.9 },
        } })
        : new Response("unavailable", { status: 503 });
    }));
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(classifyWorkstreamMessage(env, {
      ...input,
      recentMessages: [{ authorType: "human", authorName: "Jo", message: "The draft is ready." }],
      defer,
    })).resolves.toMatchObject({ classification: "agent_action", confidence: 0.9 });
    const entries = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({
      event: "addressing_classifier_outcome",
      fallback_attempted: true,
      continuation_stage: "floor",
      continuation_primary_status: "failure",
      continuation_decision: "use_addressing",
    })]));
    await settleDeferred();
  });

});
