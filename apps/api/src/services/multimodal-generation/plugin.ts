import type {
  HarnessPlugin,
  HarnessToolContext,
  HarnessToolResult,
} from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";

import type { Env } from "../../env";
import { numericEnv } from "../../env";
import { logStructuredEvent } from "../../observability/logger";
import { withWorkspaceRuntimeDatabase } from "../workspace-runtime-database";
import {
  calculateAzureImageCostUsd,
  loadAzureImageModelPricing,
  loadAzureTokenModelPricing,
  type AzureImageModelPricing,
  type AzureTokenModelPricingRecord,
} from "../openrouter-pricing-cache";
import type { WorkstreamRuntimeResourceAttacher } from "../workstream-object-client";
import {
  createAzureAudioClient,
  AzureAudioProviderError,
  type AzureAudioClient,
} from "./azure-audio-client";
import {
  createAzureImageClient,
  AzureImageProviderError,
  type AzureImageClient,
  type AzureImageUsage,
} from "./azure-client";
import {
  createMultimodalGenerationPlugin,
  MULTIMODAL_AUDIO_DEFAULT_VOICE,
  MULTIMODAL_AUDIO_MODEL,
  MULTIMODAL_AUDIO_PRICING_MODEL_ID,
  MULTIMODAL_GENERATION_PRICING_MODEL_ID,
  MultimodalGenerationError,
  type EditImageArguments,
  type GenerateAudioArguments,
  type GenerateImageArguments,
} from "./contract";
import {
  createMultimodalAudioResourceStore,
  type MultimodalAudioResourceStore,
  type PublishedMultimodalAudio,
} from "./audio-resource-service";
import {
  createMultimodalGenerationResourceStore,
  type MultimodalGenerationResourceStore,
  type PublishedMultimodalImage,
  type ResourceContext,
} from "./resource-service";

interface MultimodalGenerationPluginOptions {
  client?: AzureImageClient;
  resources?: MultimodalGenerationResourceStore;
  loadPricing?: () => Promise<AzureImageModelPricing>;
  audioClient?: AzureAudioClient;
  audioResources?: MultimodalAudioResourceStore;
  loadAudioPricing?: () => Promise<AzureTokenModelPricingRecord>;
}

export function createAvalonMultimodalGenerationPlugin(
  initialEnv: Env,
  input: WorkstreamWorkflowInput,
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
  options: MultimodalGenerationPluginOptions = {},
): HarnessPlugin | null {
  const endpoint = initialEnv.AZURE_INFERENCE_ENDPOINT?.trim();
  const apiKey = initialEnv.AZURE_INFERENCE_API_KEY?.trim();
  if (!endpoint && !apiKey) return null;
  if (!endpoint || !apiKey) {
    throw new Error("AZURE_INFERENCE_ENDPOINT and AZURE_INFERENCE_API_KEY must be configured together");
  }
  const env = withWorkspaceRuntimeDatabase(initialEnv, input.workspaceId);
  const client = options.client ?? createAzureImageClient({ endpoint, apiKey });
  const resources = options.resources
    ?? createMultimodalGenerationResourceStore(env, inObjectResourceAttacher);
  const loadPricing = options.loadPricing
    ?? (() => loadAzureImageModelPricing(env, MULTIMODAL_GENERATION_PRICING_MODEL_ID));
  const audioClient = options.audioClient ?? createAzureAudioClient({
    endpoint,
    apiKey,
    maximumBytes: numericEnv(env, "MAX_ATTACHMENT_BYTES", 25_000_000),
  });
  const audioResources = options.audioResources
    ?? createMultimodalAudioResourceStore(env, inObjectResourceAttacher);
  const loadAudioPricing = options.loadAudioPricing
    ?? (() => loadAzureTokenModelPricing(env, MULTIMODAL_AUDIO_PRICING_MODEL_ID));

  const execute = async (
    operation: "generate" | "edit",
    arguments_: GenerateImageArguments | EditImageArguments,
    context: HarnessToolContext,
  ): Promise<HarnessToolResult> => {
    const startedAt = Date.now();
    try {
      const resourceContext = requireResourceContext(context);
      const edit = operation === "edit" ? arguments_ as EditImageArguments : null;
      const replay = await resources.findPublished(resourceContext, operation, edit?.resourceId);
      if (replay) return toolResult(replay, operation);

      const pricing = await bestEffortPricing(env, context, operation, loadPricing);
      const requestedSize = arguments_.size ?? "auto";
      const editSources = edit
        ? await resources.loadEditSources(
            resourceContext,
            edit.resourceId,
            edit.maskResourceId,
          )
        : null;
      const providerResult = operation === "generate"
        ? await client.generate({
            prompt: arguments_.prompt,
            size: requestedSize,
            signal: context.signal,
          })
        : await client.edit({
            prompt: edit!.prompt,
            size: requestedSize,
            image: editSources!.image,
            ...(editSources!.mask ? { mask: editSources!.mask } : {}),
            signal: context.signal,
          });
      const billing = calculateBilling(env, context, operation, pricing, providerResult.usage);
      const published = await resources.publish(resourceContext, {
        bytes: providerResult.bytes,
        ...(arguments_.title ? { title: arguments_.title } : operation === "generate" ? { title: "Generated image" } : {}),
        operation,
        requestedSize,
        ...(providerResult.actualSize ? { actualSize: providerResult.actualSize } : {}),
        ...(providerResult.providerOperationId
          ? { providerOperationId: providerResult.providerOperationId }
          : {}),
        ...(edit ? { sourceResourceId: edit.resourceId } : {}),
        ...(editSources ? {
          sourceContentRef: editSources.image.contentRef,
          sourceContentSha256: editSources.image.storedSha256,
        } : {}),
        ...(edit?.maskResourceId ? { maskResourceId: edit.maskResourceId } : {}),
        billing,
      });
      logStructuredEvent(env, "info", "multimodal_generation_tool_finished", {
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        harness_run_id: context.harnessRunId,
        tool_invocation_id: context.effectIntentId ?? null,
        tool_call_id: context.toolCallId,
        operation,
        model: "gpt-image-2",
        state: "completed",
        duration_ms: Date.now() - startedAt,
        resource_id: published.resourceId,
        provider_operation_id: providerResult.providerOperationId ?? null,
        image_cost_usd: billing.costUsd,
        pricing_source_fingerprint: billing.pricingSourceFingerprint,
      });
      return {
        ...toolResult(published, operation),
        ...(providerResult.providerOperationId
          ? { providerOperationId: providerResult.providerOperationId }
          : {}),
      };
    } catch (error) {
      const translated = translateError(error);
      logStructuredEvent(env, "warn", "multimodal_generation_tool_finished", {
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        harness_run_id: context.harnessRunId,
        tool_invocation_id: context.effectIntentId ?? null,
        tool_call_id: context.toolCallId,
        operation,
        model: "gpt-image-2",
        state: "failed",
        code: translated.code,
        duration_ms: Date.now() - startedAt,
      });
      throw translated;
    }
  };

  const executeAudio = async (
    arguments_: GenerateAudioArguments,
    context: HarnessToolContext,
  ): Promise<HarnessToolResult> => {
    const startedAt = Date.now();
    try {
      const resourceContext = requireResourceContext(context);
      const replay = await audioResources.findPublished(resourceContext);
      if (replay) return audioToolResult(replay);

      const pricing = await bestEffortAudioPricing(env, context, loadAudioPricing);
      const voice = arguments_.voice ?? MULTIMODAL_AUDIO_DEFAULT_VOICE;
      const providerResult = await audioClient.generate({
        text: arguments_.text,
        voice,
        ...(arguments_.instructions ? { instructions: arguments_.instructions } : {}),
        signal: context.signal,
      });
      const billing = calculateAudioBilling(env, context, pricing);
      const published = await audioResources.publish(resourceContext, {
        bytes: providerResult.bytes,
        ...(arguments_.title ? { title: arguments_.title } : {}),
        voice,
        ...(providerResult.providerOperationId
          ? { providerOperationId: providerResult.providerOperationId }
          : {}),
        billing,
      });
      logStructuredEvent(env, "info", "multimodal_generation_tool_finished", {
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        harness_run_id: context.harnessRunId,
        tool_invocation_id: context.effectIntentId ?? null,
        tool_call_id: context.toolCallId,
        operation: "audio",
        model: MULTIMODAL_AUDIO_MODEL,
        state: "completed",
        duration_ms: Date.now() - startedAt,
        resource_id: published.resourceId,
        provider_operation_id: providerResult.providerOperationId ?? null,
        audio_cost_usd: billing.costUsd,
        pricing_source_fingerprint: billing.pricingSourceFingerprint,
      });
      return {
        ...audioToolResult(published),
        ...(providerResult.providerOperationId
          ? { providerOperationId: providerResult.providerOperationId }
          : {}),
      };
    } catch (error) {
      const translated = translateError(error);
      logStructuredEvent(env, "warn", "multimodal_generation_tool_finished", {
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        harness_run_id: context.harnessRunId,
        tool_invocation_id: context.effectIntentId ?? null,
        tool_call_id: context.toolCallId,
        operation: "audio",
        model: MULTIMODAL_AUDIO_MODEL,
        state: "failed",
        code: translated.code,
        duration_ms: Date.now() - startedAt,
      });
      throw translated;
    }
  };

  return createMultimodalGenerationPlugin({
    generate_image: (arguments_, context) => execute("generate", arguments_, context),
    edit_image: (arguments_, context) => execute("edit", arguments_, context),
    generate_audio: executeAudio,
  });
}

function requireResourceContext(context: HarnessToolContext): ResourceContext {
  if (!context.effectIntentId) {
    throw new MultimodalGenerationError(
      "effect_intent_required",
      "Rally could not establish a durable media-generation receipt. Retry the tool call.",
      { retryable: true },
    );
  }
  return {
    workspaceId: context.workspaceId,
    workstreamId: context.workstreamId,
    harnessRunId: context.harnessRunId,
    effectIntentId: context.effectIntentId,
    executionPrincipal: context.executionPrincipal,
  };
}

async function bestEffortAudioPricing(
  env: Env,
  context: HarnessToolContext,
  loadPricing: () => Promise<AzureTokenModelPricingRecord>,
): Promise<AzureTokenModelPricingRecord | null> {
  try {
    return await loadPricing();
  } catch (error) {
    logStructuredEvent(env, "error", "multimodal_generation_pricing_unavailable", {
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      harness_run_id: context.harnessRunId,
      tool_invocation_id: context.effectIntentId ?? null,
      tool_call_id: context.toolCallId,
      operation: "audio",
      model: MULTIMODAL_AUDIO_MODEL,
      pricing_model_id: MULTIMODAL_AUDIO_PRICING_MODEL_ID,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

function calculateAudioBilling(
  env: Env,
  context: HarnessToolContext,
  pricing: AzureTokenModelPricingRecord | null,
): {
  costUsd: null;
  pricingSourceFingerprint: string;
  usage: null;
} {
  if (pricing) {
    logStructuredEvent(env, "error", "multimodal_generation_usage_unavailable", {
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      harness_run_id: context.harnessRunId,
      tool_invocation_id: context.effectIntentId ?? null,
      tool_call_id: context.toolCallId,
      operation: "audio",
      model: MULTIMODAL_AUDIO_MODEL,
    });
  }
  return {
    costUsd: null,
    pricingSourceFingerprint: pricing?.sourceFingerprint ?? "unavailable",
    usage: null,
  };
}

async function bestEffortPricing(
  env: Env,
  context: HarnessToolContext,
  operation: "generate" | "edit",
  loadPricing: () => Promise<AzureImageModelPricing>,
): Promise<AzureImageModelPricing | null> {
  try {
    return await loadPricing();
  } catch (error) {
    logStructuredEvent(env, "error", "multimodal_generation_pricing_unavailable", {
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      harness_run_id: context.harnessRunId,
      tool_invocation_id: context.effectIntentId ?? null,
      tool_call_id: context.toolCallId,
      operation,
      model: "gpt-image-2",
      pricing_model_id: MULTIMODAL_GENERATION_PRICING_MODEL_ID,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

function calculateBilling(
  env: Env,
  context: HarnessToolContext,
  operation: "generate" | "edit",
  pricing: AzureImageModelPricing | null,
  usage?: AzureImageUsage,
): {
  costUsd: string | null;
  pricingSourceFingerprint: string;
  usage: Record<string, unknown> | null;
} {
  const usageRecord = usage ? JSON.parse(JSON.stringify(usage)) as Record<string, unknown> : null;
  if (!pricing || !usage) {
    if (pricing && !usage) {
      logStructuredEvent(env, "error", "multimodal_generation_usage_unavailable", {
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        harness_run_id: context.harnessRunId,
        tool_invocation_id: context.effectIntentId ?? null,
        tool_call_id: context.toolCallId,
        operation,
        model: "gpt-image-2",
      });
    }
    return {
      costUsd: null,
      pricingSourceFingerprint: pricing?.sourceFingerprint ?? "unavailable",
      usage: usageRecord,
    };
  }
  try {
    return {
      costUsd: calculateAzureImageCostUsd(pricing, {
        input_text: usage.input_tokens_details.text_tokens,
        input_image: usage.input_tokens_details.image_tokens,
        output_image: usage.output_tokens_details?.image_tokens ?? usage.output_tokens,
      }),
      pricingSourceFingerprint: pricing.sourceFingerprint,
      usage: usageRecord,
    };
  } catch (error) {
    logStructuredEvent(env, "error", "multimodal_generation_pricing_unavailable", {
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      harness_run_id: context.harnessRunId,
      tool_invocation_id: context.effectIntentId ?? null,
      tool_call_id: context.toolCallId,
      operation,
      model: "gpt-image-2",
      pricing_model_id: MULTIMODAL_GENERATION_PRICING_MODEL_ID,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return {
      costUsd: null,
      pricingSourceFingerprint: pricing.sourceFingerprint,
      usage: usageRecord,
    };
  }
}

function toolResult(
  published: PublishedMultimodalImage,
  operation: "generate" | "edit",
): HarnessToolResult {
  const metadata = published.metadata;
  const billing = metadata.billing && typeof metadata.billing === "object"
    ? metadata.billing
    : { costUsd: null, pricingSourceFingerprint: "unavailable", usage: null };
  return {
    output: {
      resourceId: published.resourceId,
      resourceUri: `resource://${published.resourceId}`,
      title: published.title,
      resourceType: published.resourceType,
      provider: published.provider,
      mimeType: published.mimeType,
      sizeBytes: published.bytes.byteLength,
      sourceSha256: published.sourceSha256,
      attachmentKind: "image",
      contentMode: "view",
      derivativeStatus: published.derivativeStatus,
      createdAt: published.createdAt,
      model: "gpt-image-2",
      inferenceProvider: "azure",
      operation,
      requestedSize: typeof metadata.requestedSize === "string" ? metadata.requestedSize : "auto",
      actualSize: typeof metadata.actualSize === "string" ? metadata.actualSize : null,
      width: typeof metadata.width === "number" ? metadata.width : null,
      height: typeof metadata.height === "number" ? metadata.height : null,
      billing,
    },
    summary: operation === "generate"
      ? `Generated one image and attached it as ${published.title}.`
      : `Published an edited version of ${published.title} without changing its resource ID.`,
    contentParts: [{
      type: "image_url",
      image_url: { url: `data:image/png;base64,${published.base64}`, detail: "auto" },
    }],
  };
}

function audioToolResult(published: PublishedMultimodalAudio): HarnessToolResult {
  const metadata = published.metadata;
  const billing = metadata.billing && typeof metadata.billing === "object"
    ? metadata.billing
    : { costUsd: null, pricingSourceFingerprint: "unavailable", usage: null };
  return {
    output: {
      resourceId: published.resourceId,
      resourceUri: `resource://${published.resourceId}`,
      title: published.title,
      resourceType: published.resourceType,
      provider: published.provider,
      mimeType: published.mimeType,
      sizeBytes: published.bytes.byteLength,
      sourceSha256: published.sourceSha256,
      attachmentKind: "audio",
      contentMode: "unsupported",
      derivativeStatus: published.derivativeStatus,
      createdAt: published.createdAt,
      model: MULTIMODAL_AUDIO_MODEL,
      inferenceProvider: "azure",
      operation: "audio",
      voice: typeof metadata.voice === "string" ? metadata.voice : MULTIMODAL_AUDIO_DEFAULT_VOICE,
      outputFormat: "mp3",
      aiGenerated: true,
      billing,
    },
    summary: `Generated one AI voice recording and attached it as ${published.title}.`,
  };
}

function translateError(error: unknown): MultimodalGenerationError {
  if (error instanceof MultimodalGenerationError) return error;
  if (error instanceof AzureImageProviderError) {
    return new MultimodalGenerationError(
      error.code,
      error.message,
      {
        retryable: error.retryable,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      },
      { cause: error },
    );
  }
  if (error instanceof AzureAudioProviderError) {
    return new MultimodalGenerationError(
      error.code,
      error.message,
      {
        retryable: error.retryable,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      },
      { cause: error },
    );
  }
  return new MultimodalGenerationError(
    "multimodal_generation_failed",
    "Rally could not complete the media request. Retry later.",
    { retryable: true },
    { cause: error },
  );
}
