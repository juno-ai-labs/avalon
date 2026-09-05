import { z } from "zod";
import {
  PreparedSubstreamContextSchema,
  type ContextConfigSchema,
  ResolvedContextPartSchema,
  SubstreamHistoryContextPartSchema,
  SubstreamSummaryContextPartSchema,
  SubstreamContextCaptureSchema,
  SubstreamContextPolicySchema,
  SubstreamContextRecipeSchema,
  type ContextPluginRef,
  type ContextRecipePart,
  type PreparedSubstreamContext,
  type ResolvedContextPart,
  type SubstreamContextCapture,
  type SubstreamContextMessage,
  type SubstreamContextPart,
  type SubstreamContextPolicy,
  type SubstreamContextRecipe,
} from "@rally/contracts/substream-creation";
import type { UserId } from "@rally/contracts";
import { canonicalTranscriptJson } from "../durable-objects/ordered-transcript-sqlite/canonical-payload-store";
import { sha256Hex } from "../lib/crypto";

type Config = z.infer<typeof ContextConfigSchema>;
type RecipePlan = Pick<SubstreamContextRecipe, "capture" | "parts">;

export interface ContextStrategyPlugin extends ContextPluginRef {
  configSchema: z.ZodType<Config>;
  plan(config: Config): RecipePlan;
}

export interface ContextSelectorPlugin extends ContextPluginRef {
  configSchema: z.ZodType<Config>;
  select(capture: SubstreamContextCapture, config: Config): readonly string[];
}

export interface ContextTransformServices {
  summarize(input: {
    messages: readonly SubstreamContextMessage[];
    model: string;
    signal?: AbortSignal;
  }): Promise<Extract<SubstreamContextPart, { kind: "summary" }>>;
}

export interface ContextTransformPlugin extends ContextPluginRef {
  configSchema: z.ZodType<Config>;
  outputSchema: z.ZodType<SubstreamContextPart>;
  transform(input: {
    messages: readonly SubstreamContextMessage[];
    config: Config;
    services: ContextTransformServices;
    signal?: AbortSignal;
  }): Promise<SubstreamContextPart>;
}

export interface MembershipInitializerPlugin extends ContextPluginRef {
  configSchema: z.ZodType<Config>;
  initialize(input: { creator: UserId; config: Config }): UserId[];
}

function pluginKey(ref: ContextPluginRef): string {
  return JSON.stringify([ref.id, ref.version]);
}

/** Static registrations only; adding a plugin does not modify orchestration. */
export function createPluginRegistry<T extends ContextPluginRef>(plugins: readonly T[]): {
  resolve(ref: ContextPluginRef): T;
} {
  const registered = new Map<string, T>();
  for (const plugin of plugins) {
    const key = pluginKey(plugin);
    if (registered.has(key)) throw new Error(`duplicate_context_plugin:${key}`);
    registered.set(key, plugin);
  }
  return {
    resolve(ref) {
      const plugin = registered.get(pluginKey(ref));
      if (!plugin) throw new Error(`unsupported_context_plugin:${pluginKey(ref)}`);
      return plugin;
    },
  };
}

const noConfig = z.strictObject({});
const tailConfig = z.strictObject({ count: z.number().int().positive() });
const rangeConfig = z.strictObject({ firstTurnId: z.string().min(1), lastTurnId: z.string().min(1) });
const summaryConfig = z.strictObject({ model: z.string().min(1) });
const historyOutput = SubstreamHistoryContextPartSchema;
const summaryOutput = SubstreamSummaryContextPartSchema;
const ref = (id: string): ContextPluginRef => ({ id, version: 1 });

const wholeHistory: ContextSelectorPlugin = {
  ...ref("all"),
  configSchema: noConfig,
  select(capture, config) {
    noConfig.parse(config);
    return capture.messages.map((message) => message.turnId);
  },
};
const recentHistory: ContextSelectorPlugin = {
  ...ref("last-n"),
  configSchema: tailConfig,
  select(capture, config) {
    const { count } = tailConfig.parse(config);
    return capture.messages.slice(-count).map((message) => message.turnId);
  },
};
const olderHistory: ContextSelectorPlugin = {
  ...ref("before-last-n"),
  configSchema: tailConfig,
  select(capture, config) {
    const { count } = tailConfig.parse(config);
    return capture.messages.slice(0, Math.max(0, capture.messages.length - count)).map((message) => message.turnId);
  },
};
const rangedHistory: ContextSelectorPlugin = {
  ...ref("range"),
  configSchema: rangeConfig,
  select(capture, config) {
    const { firstTurnId, lastTurnId } = rangeConfig.parse(config);
    const first = capture.messages.findIndex((message) => message.turnId === firstTurnId);
    const last = capture.messages.findIndex((message) => message.turnId === lastTurnId);
    if (first < 0 || last < first) throw new Error("context_range_invalid");
    return capture.messages.slice(first, last + 1).map((message) => message.turnId);
  },
};

function recipePart(id: string, selector: string, selectorConfig: Config, transform: string, transformConfig: Config): ContextRecipePart {
  return { id, selector: ref(selector), selectorConfig, transform: ref(transform), transformConfig };
}

export const CONTEXT_STRATEGIES: readonly ContextStrategyPlugin[] = [
  { ...ref("empty"), configSchema: noConfig, plan(config) { noConfig.parse(config); return { capture: "none", parts: [] }; } },
  { ...ref("full-history"), configSchema: noConfig, plan(config) {
    noConfig.parse(config);
    return { capture: "source", parts: [recipePart("history", "all", {}, "verbatim", {})] };
  } },
  { ...ref("summary"), configSchema: summaryConfig, plan(config) {
    const parsed = summaryConfig.parse(config);
    return { capture: "source", parts: [recipePart("summary", "all", {}, "summarize", parsed)] };
  } },
  { ...ref("last-n"), configSchema: tailConfig, plan(config) {
    const parsed = tailConfig.parse(config);
    return { capture: "source", parts: [recipePart("history", "last-n", parsed, "verbatim", {})] };
  } },
  { ...ref("range"), configSchema: rangeConfig, plan(config) {
    const parsed = rangeConfig.parse(config);
    return { capture: "source", parts: [recipePart("history", "range", parsed, "verbatim", {})] };
  } },
  { ...ref("hybrid"), configSchema: z.strictObject({ count: z.number().int().positive(), model: z.string().min(1) }), plan(config) {
    const { count, model } = z.strictObject({ count: z.number().int().positive(), model: z.string().min(1) }).parse(config);
    return { capture: "source", parts: [
      recipePart("older-summary", "before-last-n", { count }, "summarize", { model }),
      recipePart("recent-history", "last-n", { count }, "verbatim", {}),
    ] };
  } },
];

export const CONTEXT_SELECTORS = [wholeHistory, recentHistory, olderHistory, rangedHistory];
export const CONTEXT_TRANSFORMS: readonly ContextTransformPlugin[] = [
  { ...ref("verbatim"), configSchema: noConfig, outputSchema: historyOutput, async transform({ messages, config }) {
    noConfig.parse(config);
    return { kind: "history", messages: structuredClone([...messages]) };
  } },
  { ...ref("summarize"), configSchema: summaryConfig, outputSchema: summaryOutput, async transform({ messages, config, services, signal }) {
    const { model } = summaryConfig.parse(config);
    return services.summarize({ messages, model, ...(signal ? { signal } : {}) });
  } },
];

export const MEMBERSHIP_INITIALIZERS: readonly MembershipInitializerPlugin[] = [
  { ...ref("creator-only"), configSchema: noConfig, initialize({ creator, config }) { noConfig.parse(config); return [creator]; } },
];

/** One policy for the platform, never chosen by a request, participant or region. */
export const SUBSTREAM_CONTEXT_POLICY: SubstreamContextPolicy = {
  revision: "2026-09-04-gemini-flash-lite-v1",
  strategy: ref("summary"),
  config: { model: "google/gemini-2.5-flash-lite" },
};
export const SUBSTREAM_MEMBERSHIP_POLICY = { plugin: ref("creator-only"), config: {} };

async function canonicalHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalTranscriptJson(value));
}

function validateCapture(capture: SubstreamContextCapture): void {
  if (capture.source.substreamId !== "0") throw new Error("context_source_must_be_main");
  if (capture.messages.length === 0) {
    if (capture.throughTurnId !== null || capture.throughSequence !== 0) {
      throw new Error("context_capture_boundary_invalid");
    }
    return;
  }
  const last = capture.messages.at(-1)!;
  if (capture.throughTurnId !== last.turnId || capture.throughSequence !== last.transcriptSequence) {
    throw new Error("context_capture_boundary_invalid");
  }
}

export function createContextPipeline(plugins: {
  strategies: readonly ContextStrategyPlugin[];
  selectors: readonly ContextSelectorPlugin[];
  transforms: readonly ContextTransformPlugin[];
}) {
  const strategies = createPluginRegistry(plugins.strategies);
  const selectors = createPluginRegistry(plugins.selectors);
  const transforms = createPluginRegistry(plugins.transforms);
  const plan = (input: SubstreamContextPolicy): SubstreamContextRecipe => {
    const policy = SubstreamContextPolicySchema.parse(input);
    const strategy = strategies.resolve(policy.strategy);
    const config = strategy.configSchema.parse(structuredClone(policy.config));
    const planned = strategy.plan(config);
    const recipe = SubstreamContextRecipeSchema.parse({ policy, ...planned });
    if (recipe.capture === "none" && recipe.parts.length) throw new Error("context_capture_required");
    const ids = new Set<string>();
    for (const part of recipe.parts) {
      if (ids.has(part.id)) throw new Error("duplicate_context_part");
      ids.add(part.id);
      selectors.resolve(part.selector).configSchema.parse(structuredClone(part.selectorConfig));
      transforms.resolve(part.transform).configSchema.parse(structuredClone(part.transformConfig));
    }
    return recipe;
  };
  return {
    plan,
    async prepare(input: {
      recipe: SubstreamContextRecipe;
      capture: SubstreamContextCapture | null;
      services: ContextTransformServices;
      completedParts?: readonly ResolvedContextPart[];
      onPartPrepared?: (part: ResolvedContextPart) => Promise<void>;
      signal?: AbortSignal;
    }): Promise<PreparedSubstreamContext> {
      const recipe = SubstreamContextRecipeSchema.parse(input.recipe);
      // A retry uses its persisted recipe, not today's policy or today's transcript.
      const pinnedRecipe = plan(recipe.policy);
      if (canonicalTranscriptJson(recipe) !== canonicalTranscriptJson(pinnedRecipe)) {
        throw new Error("context_recipe_strategy_mismatch");
      }
      const recipeHash = await canonicalHash(recipe);
      const capture = input.capture ? SubstreamContextCaptureSchema.parse(input.capture) : null;
      if ((recipe.capture === "source") !== (capture !== null)) throw new Error("context_capture_mismatch");
      if (!capture) {
        if (recipe.parts.length || input.completedParts?.length) throw new Error("empty_context_has_parts");
        const contentHash = await canonicalHash({ schemaVersion: 1, recipeHash, captureHash: null, parts: [] });
        return { schemaVersion: 1, recipe, recipeHash, capture: null, captureHash: null, parts: [], contentHash };
      }
      const captureHash = await canonicalHash(capture);
      const positions = new Map<string, number>();
      let sequence = 0;
      capture.messages.forEach((message, index) => {
        if (positions.has(message.turnId) || message.transcriptSequence <= sequence || message.transcriptSequence > capture.throughSequence) throw new Error("context_capture_order_invalid");
        positions.set(message.turnId, index);
        sequence = message.transcriptSequence;
      });
      validateCapture(capture);
      // Validate every selection before any inference or checkpoint write.
      let previousPosition = -1;
      const selections = recipe.parts.map((part) => {
        const selector = selectors.resolve(part.selector);
        const selectorConfig = selector.configSchema.parse(structuredClone(part.selectorConfig));
        const ids = [...selector.select(structuredClone(capture), selectorConfig)];
        const messages = ids.map((id) => {
          const position = positions.get(id);
          if (position === undefined || position <= previousPosition) throw new Error("context_selection_overlap_or_order_invalid");
          previousPosition = position;
          return capture.messages[position]!;
        });
        return { part, ids, messages };
      });
      const expectedPartIds = new Set(selections.filter(({ messages }) => messages.length > 0)
        .map(({ part }) => part.id));
      const checkpoints = new Map<string, ResolvedContextPart>();
      for (const raw of input.completedParts ?? []) {
        const checkpoint = ResolvedContextPartSchema.parse(raw);
        if (checkpoints.has(checkpoint.recipe.id)) throw new Error("duplicate_context_checkpoint");
        if (!expectedPartIds.has(checkpoint.recipe.id)) throw new Error("unexpected_context_checkpoint");
        checkpoints.set(checkpoint.recipe.id, checkpoint);
      }
      const parts: ResolvedContextPart[] = [];
      for (const { part, ids, messages } of selections) {
        input.signal?.throwIfAborted();
        if (!messages.length) continue;
        const transform = transforms.resolve(part.transform);
        const transformConfig = transform.configSchema.parse(structuredClone(part.transformConfig));
        const selectionHash = await canonicalHash({ recipeHash, captureHash, part, sourceTurnIds: ids });
        const existing = checkpoints.get(part.id);
        if (existing) {
          const content = transform.outputSchema.parse(existing.content);
          const contentHash = await canonicalHash(content);
          if (canonicalTranscriptJson(existing.recipe) !== canonicalTranscriptJson(part)
            || canonicalTranscriptJson(existing.sourceTurnIds) !== canonicalTranscriptJson(ids)
            || existing.selectionHash !== selectionHash || existing.contentHash !== contentHash
            || (content.kind === "history"
              && canonicalTranscriptJson(content.messages) !== canonicalTranscriptJson(messages))) {
            throw new Error("context_checkpoint_mismatch");
          }
          parts.push(structuredClone(existing));
          continue;
        }
        const content = transform.outputSchema.parse(await transform.transform({
          messages: structuredClone(messages), config: transformConfig, services: input.services,
          ...(input.signal ? { signal: input.signal } : {}),
        }));
        input.signal?.throwIfAborted();
        const contentHash = await canonicalHash(content);
        const prepared = ResolvedContextPartSchema.parse({
          recipe: part, sourceTurnIds: ids, selectionHash, content, contentHash,
        });
        await input.onPartPrepared?.(structuredClone(prepared));
        parts.push(prepared);
      }
      const contentHash = await canonicalHash({ schemaVersion: 1, recipeHash, captureHash, parts });
      return PreparedSubstreamContextSchema.parse({
        schemaVersion: 1, recipe, recipeHash, capture, captureHash, parts, contentHash,
      });
    },
  };
}

export const substreamContextPipeline = createContextPipeline({
  strategies: CONTEXT_STRATEGIES, selectors: CONTEXT_SELECTORS, transforms: CONTEXT_TRANSFORMS,
});

export const membershipInitializerRegistry = createPluginRegistry(MEMBERSHIP_INITIALIZERS);
