import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asUserId, asWorkspaceId, asWorkstreamId, asSubstreamId } from "@rally/contracts";
import { SubstreamHistoryContextPartSchema, type ResolvedContextPart, type SubstreamContextCapture, type SubstreamContextPolicy } from "@rally/contracts/substream-creation";
import {
  CONTEXT_SELECTORS, CONTEXT_STRATEGIES, CONTEXT_TRANSFORMS, MEMBERSHIP_INITIALIZERS,
  SUBSTREAM_CONTEXT_POLICY, SUBSTREAM_MEMBERSHIP_POLICY,
  createContextPipeline, createPluginRegistry, substreamContextPipeline,
  type ContextTransformServices, type MembershipInitializerPlugin,
} from "../src/services/substream-context";

const creator = asUserId("00000000-0000-7000-8000-000000000001");
const policy = (id: string, config: SubstreamContextPolicy["config"] = {}): SubstreamContextPolicy => ({ revision: "test-policy", strategy: { id, version: 1 }, config });
function capture(): SubstreamContextCapture {
  return {
    source: {
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000010"),
      workstreamId: asWorkstreamId("00000000-0000-7000-8000-000000000020"),
      substreamId: asSubstreamId("0"),
    },
    throughTurnId: "turn-4", throughSequence: 8, sourceRevision: 11,
    messages: [1, 2, 3, 4].map((number) => ({
      turnId: `turn-${number}`, transcriptSequence: number * 2,
      actor: number % 2 ? "human" : "assistant",
      authorUserId: number % 2 ? creator : null,
      authorLabel: number % 2 ? "Creator" : "Rally",
      createdAt: "2026-09-04T12:00:00.000Z",
      blocks: [{ text: `Message ${number}`, mentions: [], attachments: [] }],
    })),
  };
}
const noInference: ContextTransformServices = {
  summarize: async () => { throw new Error("unexpected_inference"); },
};

describe("substream context hooks", () => {
  it("uses Gemini as the single platform summary policy and seats only the creator", () => {
    expect(substreamContextPipeline.plan(SUBSTREAM_CONTEXT_POLICY)).toMatchObject({
      policy: { strategy: { id: "summary", version: 1 } },
      parts: [{ transform: { id: "summarize", version: 1 }, transformConfig: { model: "google/gemini-2.5-flash-lite" } }],
    });
    const initializer = createPluginRegistry(MEMBERSHIP_INITIALIZERS).resolve(SUBSTREAM_MEMBERSHIP_POLICY.plugin);
    expect(initializer.initialize({ creator, config: {} })).toEqual([creator]);
  });

  it("empty preparation performs no source or model work and cannot accept a hidden capture", async () => {
    const recipe = substreamContextPipeline.plan(policy("empty"));
    expect(await substreamContextPipeline.prepare({ recipe, capture: null, services: noInference })).toMatchObject({
      schemaVersion: 1, recipe, capture: null, captureHash: null, parts: [],
      recipeHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    await expect(substreamContextPipeline.prepare({ recipe, capture: capture(), services: noInference })).rejects.toThrow("context_capture_mismatch");
  });

  it.each([
    ["full-history", {}, ["turn-1", "turn-2", "turn-3", "turn-4"]],
    ["last-n", { count: 2 }, ["turn-3", "turn-4"]],
    ["last-n", { count: 20 }, ["turn-1", "turn-2", "turn-3", "turn-4"]],
    ["range", { firstTurnId: "turn-2", lastTurnId: "turn-3" }, ["turn-2", "turn-3"]],
  ] as const)("selects %s by complete participant messages, not sequence distance", async (id, config, expected) => {
    const seed = await substreamContextPipeline.prepare({ recipe: substreamContextPipeline.plan(policy(id, config)), capture: capture(), services: noInference });
    expect(seed.parts[0]?.sourceTurnIds).toEqual(expected);
    const history = seed.parts[0]?.content;
    expect(history?.kind).toBe("history");
    if (history?.kind !== "history") throw new Error("history_expected");
    expect(history.messages.map((message) => message.blocks[0]?.text)).toEqual(expected.map((id) => `Message ${id.slice(-1)}`));
  });

  it("preserves attachments with their containing message", async () => {
    const source = capture();
    const attachment = { id: "00000000-0000-7000-8000-000000000030", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 20, contentAvailable: true, createdAt: "2026-09-04T12:00:00.000Z" };
    source.messages[3]!.blocks[0]!.attachments.push(attachment);
    const seed = await substreamContextPipeline.prepare({ recipe: substreamContextPipeline.plan(policy("last-n", { count: 1 })), capture: source, services: noInference });
    expect(seed.parts[0]?.content).toMatchObject({ kind: "history", messages: [{ turnId: "turn-4", blocks: [{ attachments: [attachment] }] }] });
    source.messages[3]!.blocks[0]!.attachments.length = 0;
    expect(seed.parts[0]?.content).toMatchObject({ kind: "history", messages: [{ blocks: [{ attachments: [attachment] }] }] });
  });

  it.each([
    { firstTurnId: "missing", lastTurnId: "turn-3" },
    { firstTurnId: "turn-3", lastTurnId: "turn-1" },
  ])("rejects stale or reversed ranges", async (config) => {
    await expect(substreamContextPipeline.prepare({ recipe: substreamContextPipeline.plan(policy("range", config)), capture: capture(), services: noInference })).rejects.toThrow("context_range_invalid");
  });

  it("hybrid freezes prefix and tail before inference and reuses a persisted summary on retry", async () => {
    const source = capture();
    const completedParts: ResolvedContextPart[] = [];
    let calls = 0;
    const services: ContextTransformServices = { summarize: async ({ messages, model }) => {
      calls += 1;
      expect(messages.map((message) => message.turnId)).toEqual(["turn-1", "turn-2"]);
      source.messages[3]!.blocks[0]!.text = "Changed while summarizing";
      return { kind: "summary", text: "Frozen older history", requestedModel: model, resolvedModel: model, inputTokens: 20, outputTokens: 5 };
    } };
    const recipe = substreamContextPipeline.plan(policy("hybrid", { count: 2, model: "google/gemini-2.5-flash-lite" }));
    const frozen = capture();
    const seed = await substreamContextPipeline.prepare({ recipe, capture: source, services, onPartPrepared: async (part) => { completedParts.push(part); } });
    expect(seed.parts.map((part) => part.sourceTurnIds)).toEqual([["turn-1", "turn-2"], ["turn-3", "turn-4"]]);
    expect(seed.parts[1]?.content).toMatchObject({ kind: "history", messages: [{}, { blocks: [{ text: "Message 4" }] }] });
    const retried = await substreamContextPipeline.prepare({ recipe, capture: frozen, services: noInference, completedParts });
    expect(retried).toEqual(seed);
    expect(calls).toBe(1);
  });

  it("does not summarize an empty older prefix", async () => {
    const seed = await substreamContextPipeline.prepare({ recipe: substreamContextPipeline.plan(policy("hybrid", { count: 10, model: "model" })), capture: capture(), services: noInference });
    expect(seed.parts.map((part) => part.recipe.id)).toEqual(["recent-history"]);
  });

  it("registers another strategy and transform without changing the orchestrator", async () => {
    const pipeline = createContextPipeline({
      strategies: [...CONTEXT_STRATEGIES, { id: "test-strategy", version: 2, configSchema: z.strictObject({}), plan: () => ({ capture: "source", parts: [{ id: "part", selector: { id: "last-n", version: 1 }, selectorConfig: { count: 1 }, transform: { id: "test-transform", version: 3 }, transformConfig: {} }] }) }],
      selectors: CONTEXT_SELECTORS,
      transforms: [...CONTEXT_TRANSFORMS, { id: "test-transform", version: 3, configSchema: z.strictObject({}), outputSchema: SubstreamHistoryContextPartSchema, transform: async ({ messages }) => ({ kind: "history", messages: [...messages] }) }],
    });
    const recipe = pipeline.plan({ revision: "other-policy", strategy: { id: "test-strategy", version: 2 }, config: {} });
    const seed = await pipeline.prepare({ recipe, capture: capture(), services: noInference });
    expect(seed.parts[0]?.sourceTurnIds).toEqual(["turn-4"]);
    expect(seed.parts[0]?.recipe.transform).toEqual({ id: "test-transform", version: 3 });
  });

  it("membership policies can evolve independently of context strategies", () => {
    const future: MembershipInitializerPlugin = {
      id: "test-main-roster", version: 1, configSchema: z.strictObject({}),
      initialize: ({ creator }) => [creator],
    };
    const registry = createPluginRegistry([...MEMBERSHIP_INITIALIZERS, future]);
    expect(registry.resolve(future).initialize({ creator, config: {} })).toEqual([creator]);
    expect(MEMBERSHIP_INITIALIZERS.map((plugin) => plugin.id)).toEqual(["creator-only"]);
  });

  it("rejects duplicate or missing plugin versions instead of substituting", () => {
    expect(() => createPluginRegistry([...CONTEXT_STRATEGIES, CONTEXT_STRATEGIES[0]!])).toThrow("duplicate_context_plugin");
    expect(() => substreamContextPipeline.plan({ ...policy("summary", { model: "model" }), strategy: { id: "summary", version: 99 } })).toThrow("unsupported_context_plugin");
  });

  it("rejects a persisted recipe that differs from its pinned strategy plan", async () => {
    const recipe = substreamContextPipeline.plan(policy("full-history"));
    recipe.parts.push({ ...recipe.parts[0]!, id: "duplicate-history" });
    await expect(substreamContextPipeline.prepare({ recipe, capture: capture(), services: noInference })).rejects.toThrow("context_recipe_strategy_mismatch");
  });

  it("rejects duplicate messages and messages beyond the frozen boundary", async () => {
    const source = capture();
    source.messages.push(source.messages[0]!);
    const recipe = substreamContextPipeline.plan(policy("full-history"));
    await expect(substreamContextPipeline.prepare({ recipe, capture: source, services: noInference })).rejects.toThrow("context_capture_order_invalid");
    const beyond = capture();
    beyond.throughSequence = 2;
    await expect(substreamContextPipeline.prepare({ recipe, capture: beyond, services: noInference })).rejects.toThrow("context_capture_order_invalid");
  });

  it("rejects contradictory frozen boundaries and non-main sources", async () => {
    const recipe = substreamContextPipeline.plan(policy("full-history"));
    const wrongBoundary = capture();
    wrongBoundary.throughTurnId = "turn-3";
    await expect(substreamContextPipeline.prepare({ recipe, capture: wrongBoundary, services: noInference })).rejects.toThrow("context_capture_boundary_invalid");
    const childSource = capture();
    childSource.source.substreamId = asSubstreamId("00000000-0000-7000-8000-000000000099");
    await expect(substreamContextPipeline.prepare({ recipe, capture: childSource, services: noInference })).rejects.toThrow("context_source_must_be_main");
  });

  it("binds checkpoints to the selected capture and rejects altered persisted content", async () => {
    const recipe = substreamContextPipeline.plan(policy("full-history"));
    const first = await substreamContextPipeline.prepare({ recipe, capture: capture(), services: noInference });
    const altered = structuredClone(first.parts[0]!);
    if (altered.content.kind !== "history") throw new Error("history_expected");
    altered.content.messages[0]!.blocks[0]!.text = "Injected history";
    await expect(substreamContextPipeline.prepare({
      recipe, capture: capture(), services: noInference, completedParts: [altered],
    })).rejects.toThrow("context_checkpoint_mismatch");

    await expect(substreamContextPipeline.prepare({
      recipe, capture: capture(), services: noInference,
      completedParts: [first.parts[0]!, first.parts[0]!],
    })).rejects.toThrow("duplicate_context_checkpoint");
  });

  it("propagates a failed summary instead of returning empty context", async () => {
    await expect(substreamContextPipeline.prepare({ recipe: substreamContextPipeline.plan(policy("summary", { model: "model" })), capture: capture(), services: noInference })).rejects.toThrow("unexpected_inference");
  });

  it("does not checkpoint a transform that finished after cancellation", async () => {
    const controller = new AbortController();
    const completed: ResolvedContextPart[] = [];
    await expect(substreamContextPipeline.prepare({
      recipe: substreamContextPipeline.plan(policy("summary", { model: "model" })), capture: capture(), signal: controller.signal,
      onPartPrepared: async (part) => { completed.push(part); },
      services: { summarize: async () => {
        controller.abort(new Error("cancelled"));
        return { kind: "summary", text: "Late summary", requestedModel: "model", resolvedModel: "model", inputTokens: 1, outputTokens: 1 };
      } },
    })).rejects.toThrow("cancelled");
    expect(completed).toEqual([]);
  });
});
