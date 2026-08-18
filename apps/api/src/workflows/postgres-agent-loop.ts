import {
  runHarness,
  type HarnessEvent,
  type ModelMessage,
} from "@avalon/agent-harness";
import {
  uuidV7,
  type JsonValue,
  type MaterializedRun,
  type MaterializedRunPart,
  type RunOutcome,
} from "@avalon/postgres";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import type { Env } from "../env";
import { numericEnv } from "../env";
import { createPostgresClient } from "../postgres/runtime";
import { resolveAgentModelRouting } from "../services/agent-model-flags";

const PostgresAgentLoopInputSchema = z.object({
  version: z.literal(1),
  region: z.enum(["global", "eu"]),
  runId: z.string().uuid(),
  workflowInstanceId: z.string().min(1).max(100),
  expectedRunRevision: z.number().int().positive(),
}).strict();

export type PostgresAgentLoopInput = z.infer<typeof PostgresAgentLoopInputSchema>;

const ClaimedRunSchema = z.object({
  state: z.string(),
  run_revision: z.coerce.number().int().positive(),
  control_revision: z.coerce.number().int().positive(),
  terminal: z.boolean(),
});

const PendingSignalSchema = z.object({
  id: z.string().uuid(),
  expected_control_revision: z.coerce.number().int().positive(),
  signal_kind: z.enum(["steer", "interrupt", "cancel", "resume", "provider_event"]),
});

const CompletedToolResultSchema = z.object({
  output: z.unknown(),
  summary: z.string(),
  providerOperationId: z.string().optional(),
  halt: z.enum(["needs_input", "completed"]).optional(),
}).strict();

type DurableLoopOutcome = {
  status: RunOutcome;
  runId: string;
  finalPartId?: string;
  contentHash?: string;
};

type StreamBatch = {
  byte_start: number;
  byte_end: number;
  text: string;
  content_hash: string;
};

type ActiveAttempt = {
  runId: string;
  actionId: string;
  attemptId: string;
  partId: string;
  controlRevision: number;
  checkpointRevision: number;
  byteOffset: number;
  text: string;
  pending: string;
  pendingFirstFrame: number | null;
  pendingThroughFrame: number;
  lastFlushAt: number;
  previousBatches: StreamBatch[];
};

type DurableToolPlan = {
  toolCallId: string;
  pluginId: string;
  canonicalToolName: string;
  inputHash: string;
  mode: "read" | "write";
};

type ActiveToolEffect = DurableToolPlan & {
  actionId: string;
  effectId: string;
  input: JsonValue;
};

const SYSTEM_PROMPT = [
  "You are Avalon, a careful collaborative agent.",
  "Use the work-stream transcript as the authoritative conversation order.",
  "If you need information that is not present, explain what is missing rather than inventing it.",
].join("\n");

const encoder = new TextEncoder();

function utf8Chunks(value: string, maxBytes: number): string[] {
  if (encoder.encode(value).byteLength <= maxBytes) return [value];
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (chunkBytes + characterBytes > maxBytes && chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

async function sha256(value: string): Promise<{ bytes: Uint8Array; hex: string }> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return {
    bytes: digest,
    hex: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key, jsonValue(nested, `${label}.${key}`),
    ]));
  }
  throw new Error(`${label}_not_json`);
}

function hexDigest(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("tool_input_hash_invalid");
  return Uint8Array.from(value.match(/.{2}/gu)!.map((pair) => Number.parseInt(pair, 16)));
}

function partToModelMessage(part: MaterializedRunPart): ModelMessage {
  if (part.content_ref_id) throw new Error(`materialized_content_ref_requires_storage_fetch:${part.id}`);
  if (part.kind === "tool_call") {
    const payload = jsonRecord(part.structured_payload);
    return {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: part.provider_call_id ?? part.id,
        type: "function",
        function: {
          name: typeof payload.tool_name === "string" ? payload.tool_name : "unknown_tool",
          arguments: JSON.stringify(payload.input ?? {}),
        },
      }],
    };
  }
  if (part.kind === "tool_result") {
    const payload = jsonRecord(part.structured_payload);
    return {
      role: "tool",
      tool_call_id: part.provider_call_id ?? part.related_part_id ?? part.id,
      content: JSON.stringify(payload.result ?? payload),
    };
  }
  if (part.text === undefined) {
    throw new Error(`materialized_part_has_no_inline_projection:${part.id}`);
  }
  return { role: part.role, content: part.text };
}

export function materializedRunMessages(run: MaterializedRun): ModelMessage[] {
  return run.parts.map(partToModelMessage);
}

function safeNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}_invalid`);
  return parsed;
}

async function checkpointAttempt(
  client: ReturnType<typeof createPostgresClient>,
  attempt: ActiveAttempt,
): Promise<number | null> {
  if (attempt.pending.length === 0 && attempt.checkpointRevision > 0) return null;
  const byteLength = encoder.encode(attempt.pending).byteLength;
  if (byteLength > 16_384) throw new Error("postgres_output_checkpoint_too_large");
  const byteStart = attempt.byteOffset;
  const nextText = attempt.text + attempt.pending;
  const prefixHash = await sha256(nextText);
  const batchHash = await sha256(attempt.pending);
  const response = jsonRecord(await client.checkpointOutput({
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    expectedRevision: attempt.checkpointRevision,
    expectedByteOffset: attempt.byteOffset,
    firstFrameSeq: attempt.pendingFirstFrame ?? attempt.pendingThroughFrame,
    throughFrameSeq: attempt.pendingThroughFrame,
    delta: attempt.pending,
    tokenEstimateThrough: Math.ceil(encoder.encode(nextText).byteLength / 4),
    prefixHash: prefixHash.bytes,
    providerCursor: { version: 1, through_frame_seq: attempt.pendingThroughFrame },
    previousBatches: attempt.previousBatches,
  }));
  if (response.superseded === true) {
    return safeNumber(response.control_revision, "superseding_control_revision");
  }
  const nextRevision = safeNumber(response.checkpoint_revision, "checkpoint_revision");
  const nextOffset = safeNumber(response.byte_offset, "checkpoint_byte_offset");
  attempt.previousBatches.push({
    byte_start: byteStart,
    byte_end: nextOffset,
    text: attempt.pending,
    content_hash: batchHash.hex,
  });
  attempt.previousBatches = attempt.previousBatches.slice(-2);
  attempt.text = nextText;
  attempt.pending = "";
  attempt.pendingFirstFrame = null;
  attempt.checkpointRevision = nextRevision;
  attempt.byteOffset = nextOffset;
  attempt.lastFlushAt = Date.now();
  return null;
}

async function openAttempt(
  client: ReturnType<typeof createPostgresClient>,
  input: PostgresAgentLoopInput,
  actionId: string,
  controlRevision: number,
): Promise<ActiveAttempt> {
  const opened = await client.beginOutputAttempt({
    runId: input.runId,
    actionId,
    expectedControlRevision: controlRevision,
    attemptId: uuidV7(),
    partId: uuidV7(),
    expiresAt: new Date(Date.now() + 35 * 60 * 1_000),
  });
  return {
    runId: input.runId,
    actionId,
    attemptId: opened.attemptId,
    partId: opened.partId,
    controlRevision,
    checkpointRevision: opened.checkpointRevision,
    byteOffset: opened.byteOffset,
    text: opened.recoveredText,
    pending: "",
    pendingFirstFrame: null,
    pendingThroughFrame: opened.throughFrameSeq,
    lastFlushAt: Date.now(),
    previousBatches: [],
  };
}

async function beginAttempt(
  client: ReturnType<typeof createPostgresClient>,
  input: PostgresAgentLoopInput,
  actionId: string,
  controlRevision: number,
): Promise<ActiveAttempt> {
  let opened = await openAttempt(client, input, actionId, controlRevision);
  // A Workflow retry may find a partially streamed provider attempt. OpenRouter
  // cannot resume that HTTP stream, so preserve its bytes for forensics, emit a
  // durable reset, and allocate a fresh attempt under the same semantic model
  // action. An empty attempt is safe to reuse after a timed-out begin RPC.
  if (opened.byteOffset > 0) {
    await client.supersedeOutput({
      runId: input.runId,
      attemptId: opened.attemptId,
      expectedAttemptControlRevision: controlRevision,
      supersedeAction: false,
    });
    opened = await openAttempt(client, input, actionId, controlRevision);
    if (opened.byteOffset > 0) throw new Error("output_attempt_reset_failed");
  }
  return opened;
}

async function runOneModelAction(
  env: Env,
  input: PostgresAgentLoopInput,
  controlRevision: number,
  iteration: number,
): Promise<{
  status: "completed" | "needs_input" | "failed" | "stopped" | "steered";
  controlRevision: number;
  partId?: string;
  contentHash?: string;
}> {
  const client = createPostgresClient(env, "workflow_runner");
  const abortController = new AbortController();
  let attempt: ActiveAttempt | null = null;
  let steeringRevision: number | null = null;
  let preparedCompactionJobId: string | null = null;
  const toolPlans = new Map<string, DurableToolPlan>();
  const activeToolEffects = new Map<string, ActiveToolEffect>();
  try {
    const materialized = await client.materializeRun(input.runId, controlRevision);
    const materializedThroughSeq = materialized.parts.reduce(
      (maximum, part) => Math.max(maximum, part.seq),
      0,
    );
    const modelRouting = await resolveAgentModelRouting(env, "workstream", {
      workspaceId: materialized.workspace_id,
      workstreamId: materialized.workstream_id,
      ...(materialized.execution_principal_kind === "user"
        ? { userId: materialized.execution_principal_id }
        : {}),
    });
    const action = await client.beginAction({
      runId: input.runId,
      expectedControlRevision: controlRevision,
      actionKind: "model",
      operationId: `${input.runId}/control/${controlRevision}/model/${iteration}`,
    });
    if (action.state === "succeeded" && action.semanticOutcome) {
      return {
        status: action.semanticOutcome,
        controlRevision,
        ...(action.outputRef ? { partId: action.outputRef } : {}),
      };
    }
    if (action.state !== "started") throw new Error("model_action_not_resumable");
    if (action.semanticOutcome) {
      // The provider finished and its semantic outcome committed, but the
      // Workflow step may have crashed before sealing the durable bytes. Do
      // not call the model again: finalize the recovered prefix exactly once.
      attempt = await openAttempt(client, input, action.actionId, controlRevision);
      let partId: string | undefined;
      if (attempt.byteOffset > 0) {
        const finalHash = await sha256(attempt.text);
        partId = await client.finalizeOutput({
          runId: input.runId,
          attemptId: attempt.attemptId,
          expectedRevision: attempt.checkpointRevision,
          expectedByteOffset: attempt.byteOffset,
          finalContentHash: finalHash.bytes,
          terminalRun: action.semanticOutcome === "completed",
        });
      } else {
        await client.supersedeOutput({
          runId: input.runId,
          attemptId: attempt.attemptId,
          expectedAttemptControlRevision: controlRevision,
          supersedeAction: false,
        });
        await client.completeModelWithoutOutput({
          runId: input.runId,
          actionId: action.actionId,
          expectedControlRevision: controlRevision,
        });
      }
      return {
        status: action.semanticOutcome,
        controlRevision,
        ...(partId ? { partId } : {}),
      };
    }
    attempt = await beginAttempt(client, input, action.actionId, controlRevision);
    const startedAt = Date.now();

    const onEvent = async (event: HarnessEvent): Promise<void> => {
      if (event.type === "tool_started") {
        const plan = toolPlans.get(event.toolCallId);
        if (!plan || plan.pluginId !== event.pluginId) throw new Error("tool_execution_plan_missing");
        const inputValue = jsonValue(event.input, "tool_input");
        const action = await client.beginAction({
          runId: input.runId,
          expectedControlRevision: controlRevision,
          actionKind: event.pluginId === "avalon:terminal" ? "terminal" : "tool",
          operationId: `${input.runId}/tool/${event.toolCallId}`,
        });
        await client.beginToolExchange({
          runId: input.runId,
          actionId: action.actionId,
          expectedControlRevision: controlRevision,
          providerCallId: event.toolCallId,
          toolName: plan.canonicalToolName,
          pluginId: event.pluginId,
          toolInput: inputValue,
        });
        const effect = await client.beginToolEffect({
          runId: input.runId,
          actionId: action.actionId,
          expectedControlRevision: controlRevision,
          effectKind: plan.mode,
          effectKey: `${event.pluginId}:${plan.canonicalToolName}`,
          operationId: `${input.runId}/tool/${event.toolCallId}/effect`,
          requestHash: hexDigest(plan.inputHash),
        });
        if (typeof effect.effect_id !== "string") throw new Error("tool_effect_id_missing");
        if (effect.recovered === true || effect.state !== "started") {
          // A previous step crossed the external-effect boundary. Its provider
          // reference/result must be reconciled; blindly invoking the plugin
          // again would turn a Workflow retry into a duplicate write.
          throw new Error("tool_effect_reconciliation_required");
        }
        activeToolEffects.set(event.toolCallId, {
          ...plan, actionId: action.actionId, effectId: effect.effect_id, input: inputValue,
        });
        return;
      }
      if (event.type === "tool_completed") {
        const effect = activeToolEffects.get(event.toolCallId);
        if (!effect) throw new Error("active_tool_effect_missing");
        const result = jsonValue(event.result, "tool_result");
        const resultHash = await sha256(JSON.stringify(result));
        await client.settleToolEffect({
          effectId: effect.effectId,
          state: "succeeded",
          ...(event.result.providerOperationId
            ? { providerReference: event.result.providerOperationId }
            : {}),
          responseHash: resultHash.bytes,
        });
        await client.commitToolExchange({
          runId: input.runId,
          actionId: effect.actionId,
          expectedControlRevision: controlRevision,
          providerCallId: event.toolCallId,
          toolName: effect.canonicalToolName,
          pluginId: effect.pluginId,
          toolInput: effect.input,
          toolResult: result,
          succeeded: true,
        });
        activeToolEffects.delete(event.toolCallId);
        return;
      }
      if (event.type === "tool_failed") {
        const effect = activeToolEffects.get(event.toolCallId);
        if (!effect) return;
        const failure = jsonValue({
          error: event.error,
          phase: event.phase,
          outcome: event.outcome,
          ...(event.data ? { data: event.data } : {}),
        }, "tool_failure");
        const resultHash = await sha256(JSON.stringify(failure));
        await client.settleToolEffect({
          effectId: effect.effectId,
          state: event.outcome === "ambiguous_external_write" ? "response_uncertain" : "failed",
          responseHash: resultHash.bytes,
        });
        await client.commitToolExchange({
          runId: input.runId,
          actionId: effect.actionId,
          expectedControlRevision: controlRevision,
          providerCallId: event.toolCallId,
          toolName: effect.canonicalToolName,
          pluginId: effect.pluginId,
          toolInput: effect.input,
          toolResult: failure,
          succeeded: false,
        });
        activeToolEffects.delete(event.toolCallId);
        return;
      }
      if (event.type !== "stream_delta") return;
      if (event.reset) {
        attempt!.pending = "";
        await client.supersedeOutput({
          runId: input.runId,
          attemptId: attempt!.attemptId,
          expectedAttemptControlRevision: controlRevision,
          supersedeAction: false,
        });
        attempt = await beginAttempt(client, input, action.actionId, controlRevision);
      }
      for (const deltaChunk of utf8Chunks(event.delta, 12_288)) {
        if (attempt!.pending.length > 0
            && encoder.encode(attempt!.pending + deltaChunk).byteLength > 16_384) {
          steeringRevision = await checkpointAttempt(client, attempt!);
          if (steeringRevision !== null) {
            abortController.abort("steered");
            return;
          }
        }
        if (attempt!.pendingFirstFrame === null) attempt!.pendingFirstFrame = event.streamSeq;
        attempt!.pendingThroughFrame = event.streamSeq;
        attempt!.pending += deltaChunk;
        const pendingBytes = encoder.encode(attempt!.pending).byteLength;
        if (pendingBytes >= 12_288 || Date.now() - attempt!.lastFlushAt >= 500) {
          steeringRevision = await checkpointAttempt(client, attempt!);
          if (steeringRevision !== null) {
            abortController.abort("steered");
            return;
          }
        }
      }
    };

    const outcome = await runHarness({
      config: {
        apiKey: env.OPENROUTER_API_KEY,
        primaryModel: materialized.model_name === "runtime-selected"
          ? modelRouting.model
          : materialized.model_name,
        fallbackModels: materialized.model_name === "runtime-selected"
          ? modelRouting.fallbackModels
          : [],
        sameModelRetries: 0,
        appUrl: env.PUBLIC_API_BASE_URL,
        appName: "Avalon",
        toolTimeoutMs: numericEnv(env, "TOOL_DEFAULT_TIMEOUT_MS", 30_000),
        maxWebResults: numericEnv(env, "WEB_SEARCH_MAX_RESULTS", 8),
        requestEstablishmentTimeoutMs: numericEnv(env, "HARNESS_REQUEST_ESTABLISHMENT_TIMEOUT_MS", 20_000),
        ttftTimeoutMs: numericEnv(env, "HARNESS_TTFT_TIMEOUT_MS", 45_000),
        streamIdleTimeoutMs: numericEnv(env, "HARNESS_STREAM_IDLE_TIMEOUT_MS", 30_000),
      },
      workspaceId: materialized.workspace_id,
      workstreamId: materialized.workstream_id,
      harnessRunId: input.runId,
      executionPrincipal: materialized.execution_principal_kind === "user"
        ? { type: "user", userId: materialized.execution_principal_id }
        : { type: "workspace", workspaceId: materialized.execution_principal_id },
      systemPrompt: SYSTEM_PROMPT,
      messages: materializedRunMessages(materialized),
      ...(materializedThroughSeq > 0 ? { compaction: {
        prepare: async () => {
          const prepared = await client.prepareCompaction({
            runId: input.runId,
            expectedControlRevision: controlRevision,
            throughSeq: materializedThroughSeq,
            formatVersion: "avalon-provider-messages-v1",
            model: materialized.model_name === "runtime-selected"
              ? modelRouting.model
              : materialized.model_name,
            modelVersion: "openrouter-runtime-v1",
            promptVersion: "avalon-compaction-v1",
          });
          if (typeof prepared.job_id !== "string") throw new Error("compaction_job_id_missing");
          preparedCompactionJobId = prepared.job_id;
        },
        renderAppendix: () => "",
        persist: async (checkpoint) => {
          if (!preparedCompactionJobId) throw new Error("compaction_prepare_missing");
          await client.finalizeCompaction({
            runId: input.runId,
            expectedControlRevision: controlRevision,
            jobId: preparedCompactionJobId,
            summary: checkpoint.summary,
          });
          preparedCompactionJobId = null;
        },
      } } : {}),
      corePlugins: [],
      plugins: [],
      pluginDiscovery: false,
      includeWebSearch: true,
      findCompletedToolResult: async (toolCallId, inputHash, policy) => {
        const result = await client.findToolResult({
          runId: input.runId,
          providerCallId: toolCallId,
          pluginId: policy.pluginId,
          toolName: policy.canonicalToolName,
          requestHash: hexDigest(inputHash),
        });
        if (result === null) return null;
        const parsed = CompletedToolResultSchema.parse(result);
        return {
          output: parsed.output,
          summary: parsed.summary,
          ...(parsed.providerOperationId === undefined
            ? {}
            : { providerOperationId: parsed.providerOperationId }),
          ...(parsed.halt === undefined ? {} : { halt: parsed.halt }),
        };
      },
      persistToolExecutionPlan: async (plan) => {
        toolPlans.set(plan.toolCallId, {
          toolCallId: plan.toolCallId,
          pluginId: plan.pluginId,
          canonicalToolName: plan.canonicalToolName,
          inputHash: plan.inputHash,
          mode: plan.mode,
        });
      },
      onEvent,
      onLiveness: async () => {
        if (attempt!.pending.length > 0 && Date.now() - attempt!.lastFlushAt >= 500) {
          steeringRevision = await checkpointAttempt(client, attempt!);
          if (steeringRevision !== null) abortController.abort("steered");
        }
        const pendingSignals = await client.pendingSignals(input.runId);
        const newestRevision = pendingSignals.reduce((maximum, signal) => {
          const revision = Number(signal.expected_control_revision);
          return Number.isSafeInteger(revision) ? Math.max(maximum, revision) : maximum;
        }, controlRevision);
        if (newestRevision > controlRevision) {
          steeringRevision = newestRevision;
          abortController.abort("steered");
        }
      },
      signal: abortController.signal,
    });

    if (steeringRevision !== null) {
      return { status: "steered", controlRevision: steeringRevision };
    }
    if (attempt.pending.length > 0) {
      steeringRevision = await checkpointAttempt(client, attempt);
      if (steeringRevision !== null) {
        return { status: "steered", controlRevision: steeringRevision };
      }
    }
    const finalHash = await sha256(attempt.text);
    const shouldSeal = attempt.text.length > 0;
    await client.recordRunProgress({
      runId: input.runId,
      expectedControlRevision: controlRevision,
      inputTokens: outcome.stats.inputTokens,
      outputTokens: outcome.stats.outputTokens,
      elapsedMs: Date.now() - startedAt,
    });
    await client.recordModelOutcome({
      runId: input.runId,
      actionId: action.actionId,
      expectedControlRevision: controlRevision,
      outcome: outcome.status,
    });
    let partId: string | undefined;
    if (shouldSeal) {
      partId = await client.finalizeOutput({
        runId: input.runId,
        attemptId: attempt.attemptId,
        expectedRevision: attempt.checkpointRevision,
        expectedByteOffset: attempt.byteOffset,
        finalContentHash: finalHash.bytes,
        terminalRun: outcome.status === "completed",
      });
    } else {
      await client.supersedeOutput({
        runId: input.runId,
        attemptId: attempt.attemptId,
        expectedAttemptControlRevision: controlRevision,
        supersedeAction: false,
      });
      await client.completeModelWithoutOutput({
        runId: input.runId,
        actionId: action.actionId,
        expectedControlRevision: controlRevision,
      });
    }
    return {
      status: outcome.status,
      controlRevision,
      ...(partId ? { partId } : {}),
      ...(shouldSeal ? { contentHash: finalHash.hex } : {}),
    };
  } catch (error) {
    if (steeringRevision !== null) {
      if (attempt) {
        await client.supersedeOutput({
          runId: input.runId,
          attemptId: attempt.attemptId,
          expectedAttemptControlRevision: controlRevision,
        });
      }
      return { status: "steered", controlRevision: steeringRevision };
    }
    throw error;
  } finally {
    await client.close();
  }
}

/**
 * One Cloudflare Workflow instance owns one complete semantic agent loop.
 * Prompt and generated text live only inside the model step and Supabase; the
 * persisted Workflow result contains identifiers and hashes only.
 */
export class PostgresAgentLoopWorkflow extends WorkflowEntrypoint<Env, PostgresAgentLoopInput> {
  override async run(
    event: Readonly<WorkflowEvent<PostgresAgentLoopInput>>,
    step: WorkflowStep,
  ): Promise<DurableLoopOutcome> {
    const input = PostgresAgentLoopInputSchema.parse(event.payload);
    if (input.region !== this.env.AVALON_REGION) throw new Error("workflow_region_mismatch");

    const claim = await step.do("claim-postgres-run", async () => {
      const client = createPostgresClient(this.env, "workflow_runner");
      try {
        return ClaimedRunSchema.parse(await client.claimRun({
          runId: input.runId,
          expectedRunRevision: input.expectedRunRevision,
          workflowInstanceId: input.workflowInstanceId,
        }));
      } finally {
        await client.close();
      }
    });
    if (claim.terminal) return { status: claim.state as RunOutcome, runId: input.runId };

    let controlRevision = claim.control_revision;
    let iteration = 0;
    for (;;) {
      iteration += 1;
      const actionOutcome = await step.do(
        `run-postgres-model-action-${iteration}`,
        {
          retries: { limit: 1, delay: "1 second", backoff: "constant" },
        },
        async () => runOneModelAction(this.env, input, controlRevision, iteration),
      );

      if (actionOutcome.status === "steered") {
        controlRevision = actionOutcome.controlRevision;
        const observed = await this.observePendingSignals(step, input, controlRevision, iteration);
        controlRevision = observed.revision ?? controlRevision;
        if (observed.terminalOutcome) {
          await this.settleRun(step, input, controlRevision, observed.terminalOutcome, iteration);
          return { status: observed.terminalOutcome, runId: input.runId };
        }
        continue;
      }
      const databaseOutcome: RunOutcome = actionOutcome.status === "needs_input"
        ? "waiting_user"
        : actionOutcome.status === "stopped"
          ? "interrupted"
          : actionOutcome.status;
      await this.settleRun(step, input, controlRevision, databaseOutcome, iteration);
      if (databaseOutcome !== "waiting_user") {
        return {
          status: databaseOutcome,
          runId: input.runId,
          ...(actionOutcome.partId ? { finalPartId: actionOutcome.partId } : {}),
          ...(actionOutcome.contentHash ? { contentHash: actionOutcome.contentHash } : {}),
        };
      }

      await step.waitForEvent(`wait-for-postgres-run-signal-${iteration}`, {
        type: "run-signal",
        timeout: "30 days",
      });
      const nextRevision = await this.observePendingSignals(step, input, undefined, iteration);
      if (nextRevision.revision === null) throw new Error("workflow_signal_event_has_no_durable_signal");
      if (nextRevision.terminalOutcome) {
        await this.settleRun(
          step, input, nextRevision.revision, nextRevision.terminalOutcome, iteration,
        );
        return { status: nextRevision.terminalOutcome, runId: input.runId };
      }
      controlRevision = nextRevision.revision;
    }
  }

  private async settleRun(
    step: WorkflowStep,
    input: PostgresAgentLoopInput,
    controlRevision: number,
    outcome: RunOutcome,
    iteration: number,
  ): Promise<void> {
    await step.do(`settle-postgres-run-${iteration}-${outcome}`, async () => {
      const client = createPostgresClient(this.env, "workflow_runner");
      try {
        await client.finishRun({
          runId: input.runId,
          expectedControlRevision: controlRevision,
          outcome,
          terminalReason: outcome,
          ...(outcome === "failed" ? { errorClass: "agent_loop_failed" } : {}),
        });
        return { settled: true };
      } finally {
        await client.close();
      }
    });
  }

  private async observePendingSignals(
    step: WorkflowStep,
    input: PostgresAgentLoopInput,
    knownRevision: number | undefined,
    iteration: number,
  ): Promise<{ revision: number | null; terminalOutcome?: RunOutcome }> {
    return step.do(`observe-postgres-run-signals-${iteration}`, async () => {
      const client = createPostgresClient(this.env, "workflow_runner");
      try {
        const signals = z.array(PendingSignalSchema).parse(await client.pendingSignals(input.runId));
        let revision = knownRevision ?? null;
        let terminalOutcome: RunOutcome | undefined;
        for (const signal of signals) {
          await client.observeSignal(input.runId, signal.id, signal.expected_control_revision);
          revision = Math.max(revision ?? 0, signal.expected_control_revision);
          if (signal.signal_kind === "cancel" || signal.signal_kind === "interrupt") {
            terminalOutcome = "interrupted";
          }
        }
        return {
          revision,
          ...(terminalOutcome ? { terminalOutcome } : {}),
        };
      } finally {
        await client.close();
      }
    });
  }
}
