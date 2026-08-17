import {
  runHarness,
  type HarnessEvent,
  type ModelMessage,
} from "@avalon/agent-harness";
import {
  uuidV7,
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
});

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

async function beginAttempt(
  client: ReturnType<typeof createPostgresClient>,
  input: PostgresAgentLoopInput,
  actionId: string,
  controlRevision: number,
): Promise<ActiveAttempt> {
  const attemptId = uuidV7();
  const partId = uuidV7();
  await client.beginOutputAttempt({
    runId: input.runId,
    actionId,
    expectedControlRevision: controlRevision,
    attemptId,
    partId,
    expiresAt: new Date(Date.now() + 35 * 60 * 1_000),
  });
  return {
    runId: input.runId,
    actionId,
    attemptId,
    partId,
    controlRevision,
    checkpointRevision: 0,
    byteOffset: 0,
    text: "",
    pending: "",
    pendingFirstFrame: null,
    pendingThroughFrame: 0,
    lastFlushAt: Date.now(),
    previousBatches: [],
  };
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
  try {
    const materialized = await client.materializeRun(input.runId, controlRevision);
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
    attempt = await beginAttempt(client, input, action.actionId, controlRevision);
    const startedAt = Date.now();

    const onEvent = async (event: HarnessEvent): Promise<void> => {
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
      corePlugins: [],
      plugins: [],
      pluginDiscovery: false,
      includeWebSearch: true,
      onEvent,
      onLiveness: async () => {
        if (attempt!.pending.length > 0 && Date.now() - attempt!.lastFlushAt >= 500) {
          steeringRevision = await checkpointAttempt(client, attempt!);
          if (steeringRevision !== null) abortController.abort("steered");
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
      });
    }
    return {
      status: outcome.status,
      controlRevision,
      ...(partId ? { partId } : {}),
      ...(shouldSeal ? { contentHash: finalHash.hex } : {}),
    };
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
        await this.observePendingSignals(step, input, controlRevision, iteration);
        continue;
      }
      const databaseOutcome: RunOutcome = actionOutcome.status === "needs_input"
        ? "waiting_user"
        : actionOutcome.status === "stopped"
          ? "interrupted"
          : actionOutcome.status;
      await step.do(`settle-postgres-run-${iteration}`, async () => {
        const client = createPostgresClient(this.env, "workflow_runner");
        try {
          await client.finishRun({
            runId: input.runId,
            expectedControlRevision: controlRevision,
            outcome: databaseOutcome,
            terminalReason: databaseOutcome,
            ...(databaseOutcome === "failed" ? { errorClass: "agent_loop_failed" } : {}),
          });
          return { settled: true };
        } finally {
          await client.close();
        }
      });
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
      if (nextRevision === null) throw new Error("workflow_signal_event_has_no_durable_signal");
      controlRevision = nextRevision;
    }
  }

  private async observePendingSignals(
    step: WorkflowStep,
    input: PostgresAgentLoopInput,
    knownRevision: number | undefined,
    iteration: number,
  ): Promise<number | null> {
    return step.do(`observe-postgres-run-signals-${iteration}`, async () => {
      const client = createPostgresClient(this.env, "workflow_runner");
      try {
        const signals = z.array(PendingSignalSchema).parse(await client.pendingSignals(input.runId));
        let revision = knownRevision ?? null;
        for (const signal of signals) {
          await client.observeSignal(input.runId, signal.id, signal.expected_control_revision);
          revision = Math.max(revision ?? 0, signal.expected_control_revision);
        }
        return revision;
      } finally {
        await client.close();
      }
    });
  }
}
