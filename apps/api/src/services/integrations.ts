import {
  classifyAddressing,
  compileAutomation,
  canonicalToolInputHash,
  renderTriggerActivityMessage,
  renderUntrustedInboundEmailMessage,
  renderWorkstreamSystemPrompt,
  runHarness,
  type HarnessEvent,
  type HarnessTool,
  type ModelMessage,
  type StructuredModelDiagnostic,
} from "@avalon/agent-harness";
import type {
  AddressingClassification,
  AutomationDraft,
  ConnectorPollWorkflowInput,
  Message,
  NormalizedActivity,
  ServerSocketEvent,
  ToolInvocation,
  WorkstreamWorkflowInput,
} from "@avalon/contracts";
import { createDatabase, newId, nowIso } from "@avalon/db";
import {
  ConnectorError,
  type ConnectorConnectionContext,
} from "@avalon/connectors";
import { z } from "zod";
import type { Env } from "../env";
import { numericEnv } from "../env";
import { decryptString, encryptString } from "../lib/crypto";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import {
  FIRECRAWL_CACHE_MAX_AGE_MS,
  FirecrawlClient,
  FirecrawlError,
} from "../lib/firecrawl";
import { logStructuredEvent } from "../observability/logger";

const TOOL_REPLAY_MAX_BYTES = 256_000;

function modelMessageContent(message: Message): string {
  const people = message.mentions.flatMap((mention) =>
    mention.type === "person" && mention.userId
      ? [{
          type: "person" as const,
          person_id: mention.userId,
          ...(mention.displayName ? { display_name: mention.displayName } : {}),
        }]
      : [],
  );
  if (people.length === 0) return message.textContent;
  return `${message.textContent}\n\n<avalon_mentions>${JSON.stringify(people)}</avalon_mentions>`;
}

export async function classifyWorkstreamMessage(
  env: Env,
  input: { message: string; activeTask: boolean; connectorMentions: string[] },
): Promise<AddressingClassification> {
  return classifyAddressing({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_CLASSIFIER_MODEL,
    fallbackModels: splitModels(env.OPENROUTER_FALLBACK_MODELS),
    message: input.message,
    activeTask: input.activeTask,
    connectorMentions: input.connectorMentions,
  });
}

export async function compileAutomationDraft(
  env: Env,
  input: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    currentDraft?: AutomationDraft | null;
    defaultTimezones: { personal: string; workspace: string };
    requestId: string;
    workspaceId: string;
  },
): Promise<AutomationDraft> {
  return compileAutomation({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_STRUCTURED_MODEL,
    fallbackModels: splitModels(env.OPENROUTER_FALLBACK_MODELS),
    messages: input.messages,
    currentDraft: input.currentDraft ?? null,
    defaultTimezones: input.defaultTimezones,
    onDiagnostic: (diagnostic: StructuredModelDiagnostic) => {
      logStructuredEvent(env, diagnostic.validationIssues ? "warn" : "info", "automation_compiler", {
        request_id: input.requestId,
        workspace_id: input.workspaceId,
        stage: diagnostic.stage,
        schema_name: diagnostic.schemaName,
        provider: "openrouter",
        model: diagnostic.model,
        attempt: diagnostic.attempt,
        fallback_attempt: diagnostic.fallbackAttempt,
        repair_attempt: diagnostic.repairAttempt,
        latency_ms: diagnostic.latencyMs,
        response_bytes: diagnostic.responseBytes,
        validation_issues: diagnostic.validationIssues,
      });
    },
  });
}

export async function startWorkstreamWorkflow(env: Env, input: WorkstreamWorkflowInput): Promise<string> {
  const instanceId = `workstream-${input.harnessRunId}`;
  try {
    await env.WORKSTREAM_LOOP_WORKFLOW.create({ id: instanceId, params: input });
  } catch (error) {
    // Workflow IDs are deterministic, so a duplicate means an earlier attempt
    // reached Cloudflare but failed before Avalon could persist the launch.
    if (!workflowAlreadyExists(error)) throw error;
  }
  const launchedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE harness_runs
       SET workflow_instance_id = ?,
           status = CASE WHEN status = 'scheduled' THEN 'running' ELSE status END,
           started_at = COALESCE(started_at, ?)
       WHERE id = ? AND workspace_id = ?`,
    ).bind(instanceId, launchedAt, input.harnessRunId, input.workspaceId),
    env.DB.prepare(
      `UPDATE automation_runs
       SET workflow_instance_id = ?,
           status = CASE WHEN status = 'scheduled' THEN 'running' ELSE status END,
           started_at = COALESCE(started_at, ?)
       WHERE workstream_id = ? AND workspace_id = ?`,
    ).bind(instanceId, launchedAt, input.workstreamId, input.workspaceId),
    env.DB.prepare(
      `UPDATE workstreams
       SET harness_status = CASE WHEN harness_status = 'scheduled' THEN 'running' ELSE harness_status END,
           updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).bind(launchedAt, input.workstreamId, input.workspaceId),
  ]);
  return instanceId;
}

function workflowAlreadyExists(error: unknown): boolean {
  return error instanceof Error && /(already exists|duplicate|conflict)/iu.test(error.message);
}

interface StreamDeltaBatcher {
  push(delta: string): Promise<void>;
  flush(): Promise<void>;
}

function createStreamDeltaBatcher(
  publish: (delta: string) => Promise<void>,
  options: { maxCharacters?: number; maxDelayMs?: number; now?: () => number } = {},
): StreamDeltaBatcher {
  const maxCharacters = options.maxCharacters ?? 2_048;
  const maxDelayMs = options.maxDelayMs ?? 75;
  const now = options.now ?? Date.now;
  let pending = "";
  let lastFlushAt = now();

  const flush = async (): Promise<void> => {
    if (!pending) return;
    const delta = pending;
    pending = "";
    lastFlushAt = now();
    await publish(delta);
  };

  return {
    async push(delta: string): Promise<void> {
      pending += delta;
      if (pending.length >= maxCharacters || now() - lastFlushAt >= maxDelayMs) {
        await flush();
      }
    },
    flush,
  };
}

export async function publishWorkstreamEvent(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  event: Omit<ServerSocketEvent, "sequence" | "occurredAt"> | Record<string, unknown>,
): Promise<void> {
  try {
    const rooms = durableObjectNamespaceForRegion(env.WORKSTREAM_ROOMS, env.AVALON_REGION, env.APP_ENV);
    const id = rooms.idFromName(`${env.AVALON_REGION}:${workspaceId}:${workstreamId}`);
    await rooms.get(id).fetch("https://room.internal/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch {
    // Realtime delivery is an optimization. Canonical D1 state and snapshots
    // recover the UI after a room outage without replaying product mutations.
  }
}

export async function runWorkstreamHarness(
  env: Env,
  input: WorkstreamWorkflowInput,
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>,
): Promise<{ status: "completed" | "needs_input" | "failed" | "stopped"; messageId?: string; error?: { code: string; message: string } }> {
  const database = createDatabase(env.DB);
  const workstream = await database.workstreams.get(input.workspaceId, input.workstreamId);
  if (!workstream) return { status: "failed", error: { code: "workstream_not_found", message: "Work stream not found" } };
  const initialRun = await env.DB.prepare(
    "SELECT status FROM harness_runs WHERE id = ? AND workspace_id = ? AND workstream_id = ?",
  ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<{ status: string }>();
  if (!initialRun) return { status: "failed", error: { code: "harness_run_not_found", message: "Harness run not found" } };
  if (initialRun.status === "stopped") return { status: "stopped" };
  const messageId = input.harnessRunId;
  const existingMessage = await env.DB.prepare(
    `SELECT id FROM messages WHERE workstream_id = ? AND client_message_id = ?`,
  ).bind(input.workstreamId, `harness:${input.harnessRunId}`).first<{ id: string }>();
  if (existingMessage) {
    const terminalStatus = initialRun.status === "needs_input" || initialRun.status === "failed"
      ? initialRun.status
      : "completed";
    return { status: terminalStatus, messageId: existingMessage.id };
  }
  const storedMessages = await database.workstreams.listMessages(input.workspaceId, input.workstreamId, 80);
  const rawModelMessages: ModelMessage[] = storedMessages
    // Provider-controlled mail remains visible in the human transcript, but is
    // not implicit model history. The one email explicitly selected as an
    // automation trigger is admitted as clearly labelled untrusted user data;
    // every other inbound email must be discovered through its attached
    // provenance-preserving resource.
    .filter((message) => message.structuredContent?.kind !== "inbound_email"
      || message.id === input.triggerMessageId)
    .map((message): ModelMessage => {
      const isSelectedInboundEmail = message.id === input.triggerMessageId
        && message.structuredContent?.kind === "inbound_email";
      return isSelectedInboundEmail
        ? renderUntrustedInboundEmailMessage(modelMessageContent(message))
        : {
            role: message.author.type === "human" ? "user" : "assistant",
            content: modelMessageContent(message),
          };
    });
  const promptContext = await loadRunPromptContext(env, input, {
    title: workstream.title,
    objective: workstream.objective,
    plannedFor: workstream.plannedFor,
  });
  const boundedContext = boundModelContext(
    promptContext.systemPrompt,
    [...rawModelMessages, ...promptContext.additionalMessages],
    numericEnv(env, "HARNESS_MAX_CONTEXT_BYTES", 200_000),
  );
  const modelMessages = boundedContext.messages;
  let streamedText = "";
  let modelName: string | null = null;
  let streamStarted = false;
  let sequenceNumber: number | null = null;
  const harnessTools = await loadHarnessTools(env, input);
  const stopController = new AbortController();
  let lastStopCheck = 0;
  let ambiguousToolOutcome = false;

  const ensureSequence = async (): Promise<number> => {
    if (sequenceNumber != null) return sequenceNumber;
    const row = await env.DB.prepare(
      `UPDATE workstreams SET next_sequence_number = next_sequence_number + 1, updated_at = ?
       WHERE id = ? AND workspace_id = ? RETURNING next_sequence_number - 1 AS sequence_number`,
    )
      .bind(nowIso(), input.workstreamId, input.workspaceId)
      .first<{ sequence_number: number }>();
    if (!row) throw new Error("Work stream disappeared while the harness was running");
    sequenceNumber = row.sequence_number;
    return row.sequence_number;
  };

  const publishEvent = async (event: Record<string, unknown>) => {
    await onEvent?.(event);
    await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, event);
  };
  const streamDeltaBatcher = createStreamDeltaBatcher((delta) => publishEvent({
    type: "stream_delta",
    messageId,
    delta,
  }));
  const emit = async (event: Record<string, unknown>) => {
    // Preserve event order across the batched token stream and tool/status
    // events without paying for a Durable Object request per model token.
    await streamDeltaBatcher.flush();
    await publishEvent(event);
  };

  if (await isHarnessStopped(env, input.harnessRunId)) stopController.abort("stopped_by_user");

  const outcome = await runHarness({
    config: {
      apiKey: env.OPENROUTER_API_KEY,
      primaryModel: env.OPENROUTER_PRIMARY_MODEL,
      fallbackModels: splitModels(env.OPENROUTER_FALLBACK_MODELS),
      appUrl: env.PUBLIC_API_BASE_URL,
      appName: "Avalon",
      maxIterations: numericEnv(env, "HARNESS_MAX_MODEL_ITERATIONS", 8),
      maxToolCalls: numericEnv(env, "HARNESS_MAX_TOOL_CALLS", 24),
      maxWallClockMs: numericEnv(env, "HARNESS_MAX_WALL_CLOCK_MS", 240_000),
      toolTimeoutMs: numericEnv(env, "TOOL_DEFAULT_TIMEOUT_MS", 30_000),
      maxWebResults: numericEnv(env, "WEB_SEARCH_MAX_RESULTS", 8),
    },
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    harnessRunId: input.harnessRunId,
    executionPrincipal: input.executionPrincipal,
    systemPrompt: boundedContext.systemPrompt,
    messages: modelMessages,
    tools: harnessTools.tools,
    includeWebSearch: false,
    signal: stopController.signal,
    findCompletedToolResult: async (toolCallId, inputHash) => {
      const row = await env.DB.prepare(
        `SELECT id, tool_name, input_hash, status, output_ref, output_summary
         FROM tool_invocations WHERE harness_run_id = ? AND tool_call_id = ?`,
      )
        .bind(input.harnessRunId, toolCallId)
        .first<{
          id: string;
          tool_name: string;
          input_hash: string;
          status: string;
          output_ref: string | null;
          output_summary: string | null;
      }>();
      if (!row) return null;
      if (row.status === "completed" && row.input_hash === inputHash) {
        const invocation = await loadToolInvocation(env, input.harnessRunId, toolCallId);
        if (invocation) {
          await persistToolTranscriptMessage(env, input, invocation);
          await emit({ type: "tool_completed", invocation });
        }
        const replayedOutput = row.output_ref
          ? await loadToolReplayOutput(env, row.output_ref)
          : null;
        return {
          output: replayedOutput ?? { summary: row.output_summary },
          summary: row.output_summary ?? "Completed",
        };
      }
      const mode = harnessTools.modeByTool.get(row.tool_name) ?? "write";
      if (mode === "write" || row.input_hash !== inputHash) {
        ambiguousToolOutcome = true;
        const newlyAmbiguous = row.status !== "ambiguous";
        if (row.status !== "ambiguous") {
          await markToolInvocationAmbiguous(
            env,
            input.harnessRunId,
            toolCallId,
            row.input_hash === inputHash
              ? "A previous write may have reached the provider and will not be repeated"
              : "A stable tool-call ID was reused with different input",
          );
        }
        const invocation = await loadToolInvocation(env, input.harnessRunId, toolCallId);
        if (invocation) {
          await persistToolTranscriptMessage(env, input, invocation);
          await emit({ type: "tool_failed", invocation });
          if (newlyAmbiguous) {
            await recordToolAudit(env, input, invocation.id, row.tool_name, mode, "ambiguous");
          }
        }
        return {
          output: { error: "ambiguous_external_write", invocationId: row.id },
          summary: "Existing write invocation requires human resolution",
          halt: "needs_input",
        };
      }
      return null;
    },
    onEvent: async (event: HarnessEvent) => {
      if (Date.now() - lastStopCheck > 750) {
        lastStopCheck = Date.now();
        const state = await env.DB.prepare("SELECT status FROM harness_runs WHERE id = ?")
          .bind(input.harnessRunId).first<{ status: string }>();
        if (state?.status === "stopped") stopController.abort("stopped_by_user");
      }
      switch (event.type) {
        case "stream_started":
          modelName = event.model;
          if (!streamStarted) {
            streamStarted = true;
            await emit({ type: "stream_started", messageId, harnessRunId: input.harnessRunId });
          }
          break;
        case "stream_delta":
          if (!streamStarted) {
            streamStarted = true;
            await emit({ type: "stream_started", messageId, harnessRunId: input.harnessRunId });
          }
          streamedText += event.delta;
          await streamDeltaBatcher.push(event.delta);
          break;
        case "tool_started": {
          const invocationId = newId();
          const inputHash = await canonicalToolInputHash(event.input);
          const startedAt = nowIso();
          const inserted = await env.DB.prepare(
            `INSERT INTO tool_invocations
             (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
              connection_id, input_hash, input_json, status, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)
             ON CONFLICT(harness_run_id, tool_call_id) DO NOTHING`,
          )
            .bind(
              invocationId,
              input.workspaceId,
              input.workstreamId,
              input.harnessRunId,
              event.toolCallId,
              event.toolName,
              harnessTools.connectionByTool.get(event.toolName) ?? null,
              inputHash,
              JSON.stringify(event.input),
              startedAt,
            )
            .run();
          if (Number(inserted.meta.changes ?? 0) === 0) {
            const existing = await env.DB.prepare(
              `SELECT input_hash, status FROM tool_invocations
               WHERE harness_run_id = ? AND tool_call_id = ?`,
            ).bind(input.harnessRunId, event.toolCallId).first<{ input_hash: string; status: string }>();
            const mode = harnessTools.modeByTool.get(event.toolName) ?? "write";
            if (!existing || mode === "write" || existing.input_hash !== inputHash) {
              ambiguousToolOutcome = true;
              if (existing) {
                await markToolInvocationAmbiguous(
                  env,
                  input.harnessRunId,
                  event.toolCallId,
                  existing.input_hash === inputHash
                    ? "Concurrent execution encountered a pre-existing write invocation"
                    : "A stable tool-call ID was reused with different input",
                );
                const invocation = await loadToolInvocation(env, input.harnessRunId, event.toolCallId);
                if (invocation) {
                  await persistToolTranscriptMessage(env, input, invocation);
                  await emit({ type: "tool_failed", invocation });
                }
              }
              stopController.abort("ambiguous_external_write");
              throw new Error("ambiguous_external_write");
            }
            await env.DB.prepare(
              `UPDATE tool_invocations SET status = 'started', started_at = ?, completed_at = NULL,
               output_ref = NULL, output_summary = NULL, provider_operation_id = NULL, error_json = NULL
               WHERE harness_run_id = ? AND tool_call_id = ? AND input_hash = ?`,
            ).bind(startedAt, input.harnessRunId, event.toolCallId, inputHash).run();
          }
          const invocation = await loadToolInvocation(env, input.harnessRunId, event.toolCallId);
          if (invocation) {
            await persistToolTranscriptMessage(env, input, invocation);
            await emit({ type: "tool_started", invocation });
          }
          break;
        }
        case "tool_completed": {
          const completedAt = nowIso();
          const outputRef = toolReplayOutputKey(env, input, event.toolCallId);
          const replayPayload = serializeToolReplayOutput(event.result.output);
          await env.PAYLOADS.put(outputRef, replayPayload, {
            httpMetadata: { contentType: "application/json; charset=utf-8" },
            customMetadata: {
              workspaceId: input.workspaceId,
              workstreamId: input.workstreamId,
              harnessRunId: input.harnessRunId,
            },
          });
          await env.DB.prepare(
            `UPDATE tool_invocations SET status = 'completed', output_ref = ?, output_summary = ?,
             provider_operation_id = ?, completed_at = ?
             WHERE harness_run_id = ? AND tool_call_id = ?`,
          )
            .bind(outputRef, event.result.summary, event.result.providerOperationId ?? null, completedAt, input.harnessRunId, event.toolCallId)
            .run();
          const invocation = await loadToolInvocation(env, input.harnessRunId, event.toolCallId);
          if (invocation) {
            await persistToolTranscriptMessage(env, input, invocation);
            await emit({ type: "tool_completed", invocation });
            await recordToolAudit(env, input, invocation.id, event.toolName, harnessTools.modeByTool.get(event.toolName) ?? "read", "completed");
          }
          break;
        }
        case "tool_failed": {
          const completedAt = nowIso();
          const ambiguous = event.phase === "execution"
            && harnessTools.idempotencyByTool.get(event.toolName) === "record_before_execute";
          const errorCode = event.phase === "validation"
            ? "tool_validation_failed"
            : ambiguous
              ? "ambiguous_external_write"
              : "tool_failed";
          if (ambiguous) ambiguousToolOutcome = true;
          const inputHash = await canonicalToolInputHash({});
          await env.DB.prepare(
            `INSERT INTO tool_invocations
             (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
              connection_id, input_hash, input_json, status, started_at, completed_at, error_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
             ON CONFLICT(harness_run_id, tool_call_id) DO NOTHING`,
          ).bind(
            newId(),
            input.workspaceId,
            input.workstreamId,
            input.harnessRunId,
            event.toolCallId,
            event.toolName,
            harnessTools.connectionByTool.get(event.toolName) ?? null,
            inputHash,
            ambiguous ? "ambiguous" : "failed",
            event.phase === "execution" ? completedAt : null,
            completedAt,
            JSON.stringify({ code: errorCode, message: event.error }),
          ).run();
          await env.DB.prepare(
            `UPDATE tool_invocations SET status = ?, error_json = ?, completed_at = ?
             WHERE harness_run_id = ? AND tool_call_id = ?`,
          )
            .bind(ambiguous ? "ambiguous" : "failed", JSON.stringify({ code: errorCode, message: event.error }), completedAt, input.harnessRunId, event.toolCallId)
            .run();
          const invocation = await loadToolInvocation(env, input.harnessRunId, event.toolCallId);
          if (invocation) {
            await persistToolTranscriptMessage(env, input, invocation);
            await emit({ type: "tool_failed", invocation });
            await recordToolAudit(env, input, invocation.id, event.toolName, harnessTools.modeByTool.get(event.toolName) ?? "read", ambiguous ? "ambiguous" : "failed");
          }
          if (ambiguous) {
            stopController.abort("ambiguous_external_write");
            throw new Error("ambiguous_external_write");
          }
          break;
        }
        case "needs_input":
          await emit({ type: "harness_status_changed", status: "needs_input" });
          break;
        case "stream_completed":
          streamedText = event.content;
          break;
      }
    },
  });

  await streamDeltaBatcher.flush();

  const stoppedByUser = await isHarnessStopped(env, input.harnessRunId);
  if (streamedText) {
    const at = nowIso();
    await env.DB.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type, message_type, text_content, sequence_number, created_at)
       VALUES (?, ?, ?, ?, 'agent', 'text', ?, ?, ?)
       ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
    )
      .bind(messageId, `harness:${input.harnessRunId}`, input.workspaceId, input.workstreamId, streamedText, await ensureSequence(), at)
      .run();
  }
  const finalStatus = stoppedByUser
    ? "stopped"
    : ambiguousToolOutcome
    ? "needs_input"
    : outcome.status === "stopped"
      ? "stopped"
      : outcome.status === "needs_input"
        ? "needs_input"
        : outcome.status === "completed"
          ? "completed"
          : "failed";
  const workstreamStatus = finalStatus === "stopped" ? "idle" : finalStatus;
  if (!stoppedByUser) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE harness_runs SET status = ?, completed_at = ?, model = ?, usage_json = ?, error_json = ?
         WHERE id = ? AND status != 'stopped'`,
      ).bind(
        finalStatus,
        nowIso(),
        outcome.model ?? modelName,
        JSON.stringify({ ...outcome.usage, run_stats: outcome.stats }),
        outcome.failure
          ? JSON.stringify(outcome.failure)
          : outcome.error
            ? JSON.stringify({ code: "harness_execution_failed", kind: "execution", message: outcome.error })
            : null,
        input.harnessRunId,
      ),
      env.DB.prepare(
        `UPDATE workstreams SET harness_status = ?, last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND NOT EXISTS (SELECT 1 FROM harness_runs WHERE id = ? AND status = 'stopped')`,
      ).bind(workstreamStatus, nowIso(), nowIso(), input.workstreamId, input.workspaceId, input.harnessRunId),
    ]);
    await emit({ type: "harness_status_changed", status: workstreamStatus });
  }
  if (finalStatus === "completed" && streamedText) {
    const createdAt = nowIso();
    await emit({
      type: "stream_completed",
      message: {
        id: messageId,
        clientMessageId: null,
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        author: { type: "agent" },
        messageType: "text",
        textContent: streamedText,
        structuredContent: null,
        mentions: [],
        sequenceNumber: await ensureSequence(),
        createdAt,
        editedAt: null,
      },
    });
  }
  if (stoppedByUser) return { status: "stopped", ...(streamedText ? { messageId } : {}) };
  if (ambiguousToolOutcome) return { status: "needs_input", ...(streamedText ? { messageId } : {}) };
  return outcome.status === "completed"
    ? { status: "completed", messageId }
    : outcome.status === "needs_input"
      ? { status: "needs_input", messageId }
      : outcome.status === "stopped"
        ? { status: "stopped", ...(streamedText ? { messageId } : {}) }
      : {
          status: "failed",
          ...(streamedText ? { messageId } : {}),
          error: {
            code: outcome.failure?.code ?? "harness_execution_failed",
            message: outcome.error ?? "Harness execution failed",
          },
        };
}

async function loadRunPromptContext(
  env: Env,
  input: WorkstreamWorkflowInput,
  workstream: { title: string; objective: string; plannedFor: string | null },
): Promise<{ systemPrompt: string; additionalMessages: ModelMessage[] }> {
  let automationContext:
    | {
        name: string;
        versionNumber: number;
        instructions: string;
        expectedOutputs: string[];
        defaultBehavior: Record<string, unknown>;
        overrides: Record<string, unknown>;
      }
    | undefined;
  if (input.automationSubscriptionId) {
    const automation = await env.DB.prepare(
      `SELECT t.name, v.version_number, v.instructions, v.expected_outputs_json,
              v.default_behavior_json, s.overrides_json
       FROM automation_subscriptions s
       JOIN automation_templates t ON t.id = s.template_id
       JOIN automation_template_versions v ON v.id = s.template_version_id AND v.template_id = s.template_id
       JOIN workstreams w ON w.id = ? AND w.workspace_id = s.workspace_id
         AND w.automation_subscription_id = s.id
       WHERE s.id = ? AND s.workspace_id = ?`,
    ).bind(input.workstreamId, input.automationSubscriptionId, input.workspaceId).first<{
      name: string;
      version_number: number;
      instructions: string;
      expected_outputs_json: string;
      default_behavior_json: string;
      overrides_json: string;
    }>();
    if (!automation) throw new Error("automation_subscription_context_not_found");
    automationContext = {
      name: automation.name,
      versionNumber: automation.version_number,
      instructions: automation.instructions,
      expectedOutputs: parseJson(automation.expected_outputs_json, []),
      defaultBehavior: parseJson(automation.default_behavior_json, {}),
      overrides: parseJson(automation.overrides_json, {}),
    };
  }
  const additionalMessages: ModelMessage[] = [];
  if (input.activityId) {
    const activity = await env.DB.prepare(
      `SELECT provider, event_type, occurred_at, title, summary, text_snippet, metadata_json
       FROM activities WHERE id = ? AND workspace_id = ?`,
    ).bind(input.activityId, input.workspaceId).first<Record<string, unknown>>();
    if (!activity) throw new Error("trigger_activity_context_not_found");
    additionalMessages.push(renderTriggerActivityMessage({
      id: input.activityId,
      provider: activity.provider,
      eventType: activity.event_type,
      occurredAt: activity.occurred_at,
      title: activity.title,
      summary: activity.summary,
      textSnippet: activity.text_snippet,
      metadata: parseJson(activity.metadata_json, {}),
    }));
  }
  return {
    systemPrompt: renderWorkstreamSystemPrompt({
      title: workstream.title,
      objective: workstream.objective,
      runReason: input.reason,
      currentTime: nowIso(),
      plannedFor: workstream.plannedFor,
      interactive: ["opening_message", "human_message", "elicitation_answer"].includes(input.reason),
      ...(automationContext ? { automation: automationContext } : {}),
    }),
    additionalMessages,
  };
}

function boundModelContext(
  systemPrompt: string,
  messages: ModelMessage[],
  configuredMaxBytes: number,
): { systemPrompt: string; messages: ModelMessage[]; byteLength: number } {
  const maxBytes = Math.max(1, Math.min(configuredMaxBytes, 2_000_000));
  const systemBudget = Math.max(1, Math.floor(maxBytes * 0.6));
  const boundedSystemPrompt = truncateUtf8(systemPrompt, systemBudget);
  let usedBytes = utf8Length(boundedSystemPrompt);
  const selected: ModelMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const content = message.content ?? "";
    const remaining = maxBytes - usedBytes;
    if (remaining <= 0) break;
    const overhead = utf8Length(message.role) + 8;
    if (remaining <= overhead) break;
    const boundedContent = truncateUtf8(content, remaining - overhead);
    if (!boundedContent && content) break;
    selected.push({ ...message, content: boundedContent });
    usedBytes += overhead + utf8Length(boundedContent);
    if (boundedContent !== content) break;
  }
  selected.reverse();
  return { systemPrompt: boundedSystemPrompt, messages: selected, byteLength: usedBytes };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let truncated = new TextDecoder().decode(encoded.slice(0, maxBytes));
  while (truncated && utf8Length(truncated) > maxBytes) truncated = truncated.slice(0, -1);
  return truncated;
}

function toolReplayOutputKey(
  env: Env,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "harnessRunId">,
  stableToolCallId: string,
): string {
  return `${env.AVALON_REGION}/${input.workspaceId}/workstreams/${input.workstreamId}/harness/${input.harnessRunId}/tool-results/${encodeURIComponent(stableToolCallId)}.json`;
}

function serializeToolReplayOutput(output: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify({ replayVersion: 1, output: output ?? null });
  } catch {
    return JSON.stringify({
      replayVersion: 1,
      output: { truncated: true, preview: "Tool output was not JSON-serializable" },
    });
  }
  if (utf8Length(serialized) <= TOOL_REPLAY_MAX_BYTES) return serialized;
  const previewBudget = TOOL_REPLAY_MAX_BYTES - 200;
  return JSON.stringify({
    replayVersion: 1,
    output: {
      truncated: true,
      preview: truncateUtf8(serialized, previewBudget),
    },
  });
}

async function loadToolReplayOutput(env: Env, outputRef: string): Promise<unknown | null> {
  try {
    const object = await env.PAYLOADS.get(outputRef);
    if (!object || object.size > TOOL_REPLAY_MAX_BYTES) return null;
    const envelope = JSON.parse(await object.text()) as { replayVersion?: unknown; output?: unknown };
    if (envelope.replayVersion !== 1 || !("output" in envelope)) return null;
    return envelope.output;
  } catch {
    // The D1 summary is a safe fallback when a payload was evicted or damaged.
    return null;
  }
}

function splitModels(value: string): string[] {
  return value.split(",").map((model) => model.trim()).filter(Boolean);
}

async function loadHarnessTools(
  env: Env,
  input: WorkstreamWorkflowInput,
): Promise<{
  tools: HarnessTool[];
  connectionByTool: Map<string, string>;
  idempotencyByTool: Map<string, "safe" | "provider_key" | "record_before_execute">;
  modeByTool: Map<string, "read" | "write">;
}> {
  const [bindingRows, attachedRows, connectionRows] = await Promise.all([
    input.automationSubscriptionId
      ? env.DB.prepare(
          `SELECT json_each.key AS capability, json_each.value AS connection_id
           FROM automation_subscriptions s, json_each(s.connector_bindings_json)
           WHERE s.id = ? AND s.workspace_id = ?`,
        ).bind(input.automationSubscriptionId, input.workspaceId).all<{ capability: string; connection_id: string }>()
      : Promise.resolve({ results: [] as Array<{ capability: string; connection_id: string }> }),
    env.DB.prepare(
      `SELECT DISTINCT r.connection_id FROM workstream_resources wr
       JOIN resources r ON r.id = wr.resource_id
       WHERE wr.workstream_id = ? AND r.workspace_id = ? AND r.connection_id IS NOT NULL`,
    ).bind(input.workstreamId, input.workspaceId).all<{ connection_id: string }>(),
    env.DB.prepare(
      `SELECT * FROM connector_connections WHERE workspace_id = ? AND status = 'healthy'
       ORDER BY created_at ASC`,
    ).bind(input.workspaceId).all<Record<string, unknown>>(),
  ]);
  const automationBindings = new Map(
    (bindingRows.results ?? []).map((row) => [row.capability, row.connection_id]),
  );
  const explicitlyBound = new Set(automationBindings.values());
  const attached = new Set((attachedRows.results ?? []).map((row) => row.connection_id));
  const registry = connectorRegistryForEnv(env);
  const tools: HarnessTool[] = createAvalonTools(env, input);
  const connectionByTool = new Map<string, string>();
  const idempotencyByTool = new Map<string, "safe" | "provider_key" | "record_before_execute">();
  const modeByTool = new Map<string, "read" | "write">(
    tools.map((tool) => [tool.definition.name, tool.definition.mode]),
  );
  const orderedConnectionRows = [...(connectionRows.results ?? [])].sort((left, right) => {
    const priority = connectorSelectionPriority(left, input.executionPrincipal, attached)
      - connectorSelectionPriority(right, input.executionPrincipal, attached);
    if (priority !== 0) return priority;
    return String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
  });
  for (const row of orderedConnectionRows) {
    if (row.workspace_id !== input.workspaceId) continue;
    const connectionId = String(row.id);
    const scope = row.scope === "workspace" ? "workspace" : "personal";
    const eligible = input.automationSubscriptionId
      ? explicitlyBound.has(connectionId)
      : scope === "workspace" ||
        attached.has(connectionId) ||
        (input.executionPrincipal.type === "user" && scope === "personal" && row.owner_user_id === input.executionPrincipal.userId);
    if (!eligible) continue;
    if (scope === "personal" && (input.executionPrincipal.type !== "user" || row.owner_user_id !== input.executionPrincipal.userId)) continue;
    let credentials: Record<string, unknown> = {};
    if (typeof row.encrypted_credentials === "string" && typeof row.credential_iv === "string") {
      credentials = JSON.parse(
        await decryptString(row.encrypted_credentials, row.credential_iv, env.CONNECTOR_CREDENTIALS_KEY, connectionId),
      ) as Record<string, unknown>;
    }
    const connection: ConnectorConnectionContext = {
      id: connectionId,
      workspaceId: input.workspaceId,
      scope,
      ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id),
      grantedScopes: parseJson(row.granted_scopes_json, []),
      credentials,
      cursor: parseJson(row.cursor_json, {}),
      config: parseJson(row.config_json, {}),
    };
    const adapter = registry.get(String(row.connector_type));
    await withConnectorCredentialLifecycle(env, connection, async () => {
      if (
        adapter.refreshCredentials &&
        typeof connection.credentials.expiresAt === "string" &&
        Date.parse(connection.credentials.expiresAt) < Date.now() + 60_000
      ) {
        connection.credentials = await adapter.refreshCredentials(
          connection,
          AbortSignal.timeout(numericEnv(env, "TOOL_DEFAULT_TIMEOUT_MS", 30_000)),
        );
      }
    });
    for (const definition of adapter.manifest.tools) {
      // A mailbox From header is not a strong authentication primitive. Email-
      // triggered automations may inspect bound connector data, but external
      // connector writes require a subsequent human-started run.
      if (input.reason === "inbound_email" && definition.mode === "write") continue;
      if (input.automationSubscriptionId && automationBindings.get(definition.capability) !== connectionId) continue;
      if (!connection.grantedScopes.includes(definition.capability) || connectionByTool.has(definition.name)) continue;
      connectionByTool.set(definition.name, connectionId);
      idempotencyByTool.set(definition.name, definition.idempotency);
      modeByTool.set(definition.name, definition.mode);
      tools.push({
        definition,
        execute: async (toolInput, context) => {
          const effectivePrincipal = connection.scope === "workspace"
            ? { type: "workspace" as const, workspaceId: input.workspaceId }
            : context.executionPrincipal;
          return withConnectorCredentialLifecycle(env, connection, () =>
            adapter.executeTool(definition.name, toolInput, {
              connection,
              principal: effectivePrincipal,
              signal: context.signal,
            }),
          );
        },
      });
    }
  }
  return { tools, connectionByTool, idempotencyByTool, modeByTool };
}

function connectorSelectionPriority(
  row: Record<string, unknown>,
  principal: WorkstreamWorkflowInput["executionPrincipal"],
  attachedConnectionIds: ReadonlySet<string>,
): number {
  if (attachedConnectionIds.has(String(row.id))) return 0;
  if (
    row.scope === "personal"
    && principal.type === "user"
    && row.owner_user_id === principal.userId
  ) {
    return 1;
  }
  if (row.scope === "workspace") return 2;
  return 3;
}

function createAvalonTools(env: Env, input: WorkstreamWorkflowInput): HarnessTool[] {
  const requestElicitationSchema = z.object({
    prompt: z.string().min(1).max(4_000),
    responseType: z.enum(["text", "radio", "single_select", "multi_select"]),
    options: z.array(z.object({
      value: z.string().min(1).max(200),
      label: z.string().min(1).max(300),
      description: z.string().max(800).nullable().default(null),
    })).max(30).default([]),
    minimumSelections: z.number().int().nonnegative().default(0),
    maximumSelections: z.number().int().positive().nullable().default(null),
    targetUserId: z.string().uuid().nullable().default(null),
  });
  const tools: HarnessTool[] = [
    {
      definition: {
        name: "avalon.read_workstream",
        description: "Read the current work stream's objective, status, and index of explicitly attached resources. Use the returned resource IDs with avalon.read_resource.",
        capability: "workstream.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      execute: async () => {
        const [row, attached] = await Promise.all([
          env.DB.prepare(
            `SELECT title, objective, harness_status, planned_for, last_activity_at
             FROM workstreams WHERE id = ? AND workspace_id = ?`,
          ).bind(input.workstreamId, input.workspaceId).first<Record<string, unknown>>(),
          env.DB.prepare(
            `SELECT r.id, r.title, r.resource_type, r.provider, r.mime_type,
                    wr.relationship_type, wr.attached_at
             FROM workstream_resources wr
             JOIN resources r ON r.id = wr.resource_id AND r.workspace_id = ?
             WHERE wr.workstream_id = ?
             ORDER BY wr.attached_at DESC
             LIMIT 50`,
          ).bind(input.workspaceId, input.workstreamId).all<Record<string, unknown>>(),
        ]);
        if (!row) throw new Error("Work stream not found");
        return {
          output: { ...row, attachedResources: attached.results ?? [] },
          summary: "Read work-stream details and attached-resource index",
        };
      },
    },
    {
      definition: {
        name: "avalon.read_resource",
        description: "Read a text resource explicitly attached to this work stream.",
        capability: "resource.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: { resourceId: { type: "string", format: "uuid" } }, required: ["resourceId"],
        },
      },
      execute: async (raw) => {
        const args = z.object({ resourceId: z.string().uuid() }).parse(raw);
        const row = await env.DB.prepare(
          `SELECT r.title, r.mime_type, r.content_ref FROM resources r
           JOIN workstream_resources wr ON wr.resource_id = r.id
           WHERE r.id = ? AND wr.workstream_id = ? AND r.workspace_id = ?`,
        ).bind(args.resourceId, input.workstreamId, input.workspaceId).first<{ title: string; mime_type: string | null; content_ref: string | null }>();
        if (!row?.content_ref) throw new Error("Attached resource content is not hydrated");
        if (row.mime_type && !row.mime_type.startsWith("text/") && row.mime_type !== "application/json") {
          throw new Error("This resource must be exported to readable text before use");
        }
        const object = await env.PAYLOADS.get(row.content_ref);
        if (!object) throw new Error("Attached resource content is unavailable");
        const text = truncateUtf8(
          await object.text(),
          numericEnv(env, "HARNESS_MAX_CONTEXT_BYTES", 200_000),
        );
        return { output: { title: row.title, text }, summary: `Read ${text.length} characters from ${row.title}` };
      },
    },
    {
      definition: {
        name: "avalon.create_artifact",
        description: "Create a durable text artifact in this work stream.",
        capability: "artifact.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 300 },
            artifactType: { type: "string", minLength: 1, maxLength: 80 },
            content: { type: "string", maxLength: 500000 },
          },
          required: ["title", "artifactType", "content"],
        },
      },
      execute: async (raw) => {
        const args = z.object({ title: z.string().min(1).max(300), artifactType: z.string().min(1).max(80), content: z.string().max(500_000) }).parse(raw);
        const id = newId();
        const key = `${env.AVALON_REGION}/${input.workspaceId}/artifacts/${id}.txt`;
        await env.PAYLOADS.put(key, args.content, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
        const at = nowIso();
        await env.DB.prepare(
          `INSERT INTO artifacts
           (id, workspace_id, workstream_id, harness_run_id, artifact_type, title,
            content_ref, preview_text, status, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', '{}', ?, ?)`,
        ).bind(id, input.workspaceId, input.workstreamId, input.harnessRunId, args.artifactType, args.title, key, args.content.slice(0, 1_000), at, at).run();
        return { output: { artifactId: id, title: args.title }, summary: `Created artifact “${args.title}”`, providerOperationId: id };
      },
    },
    {
      definition: {
        name: "avalon.request_elicitation",
        description: "Ask a person a structured blocking question and pause this harness run.",
        capability: "elicitation.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 4000 },
            responseType: { type: "string", enum: ["text", "radio", "single_select", "multi_select"] },
            options: {
              type: "array", maxItems: 30,
              items: {
                type: "object", additionalProperties: false,
                properties: { value: { type: "string" }, label: { type: "string" }, description: { type: ["string", "null"] } },
                required: ["value", "label", "description"],
              },
            },
            minimumSelections: { type: "integer", minimum: 0 },
            maximumSelections: { type: ["integer", "null"], minimum: 1 },
            targetUserId: { type: ["string", "null"], format: "uuid" },
          },
          required: ["prompt", "responseType", "options", "minimumSelections", "maximumSelections", "targetUserId"],
        },
      },
      execute: async (raw) => {
        const args = requestElicitationSchema.parse(raw);
        if (args.responseType !== "text" && args.options.length === 0) throw new Error("Selection questions require options");
        if (args.targetUserId) {
          const target = await env.DB.prepare(
            `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
          ).bind(input.workspaceId, args.targetUserId).first();
          if (!target) throw new Error("Target responder is not an active workspace member");
        }
        const id = newId();
        const at = nowIso();
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO elicitations
             (id, workspace_id, workstream_id, harness_run_id, prompt, response_type,
              options_json, minimum_selections, maximum_selections, target_user_id,
              status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          ).bind(id, input.workspaceId, input.workstreamId, input.harnessRunId, args.prompt, args.responseType, JSON.stringify(args.options), args.minimumSelections, args.maximumSelections, args.targetUserId, at),
          env.DB.prepare(
            `UPDATE workstreams SET harness_status = 'needs_input', last_activity_at = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
          ).bind(at, at, input.workstreamId, input.workspaceId),
        ]);
        const elicitation = {
          id, workstreamId: input.workstreamId, harnessRunId: input.harnessRunId,
          prompt: args.prompt, responseType: args.responseType, options: args.options,
          minimumSelections: args.minimumSelections, maximumSelections: args.maximumSelections,
          targetUserId: args.targetUserId, status: "open" as const, answer: null,
          answeredByUserId: null, createdAt: at, answeredAt: null,
        };
        await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, { type: "elicitation_created", elicitation });
        return { output: { elicitationId: id }, summary: "Requested human input", providerOperationId: id, halt: "needs_input" as const };
      },
    },
  ];
  // Inbound email is untrusted external data. It may use explicitly bound
  // connector reads, but it cannot open an outbound channel that could be
  // abused to exfiltrate those private results through a query or URL.
  if (input.reason !== "inbound_email") {
    tools.splice(2, 0, ...createFirecrawlWebTools(env));
  }
  return tools;
}

const WEB_RECENCY_TO_TBS = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
} as const;

function createFirecrawlWebTools(env: Env): HarnessTool[] {
  const apiKey = env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) return [];

  const maxSearchResults = Math.max(
    1,
    Math.min(20, numericEnv(env, "WEB_SEARCH_MAX_RESULTS", 8)),
  );
  const defaultSearchResults = Math.min(5, maxSearchResults);
  const searchInputSchema = z.object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(maxSearchResults).optional(),
    recency: z.enum(["day", "week", "month", "year"]).optional(),
  });
  const fetchInputSchema = z.object({
    url: z.string().url(),
    must_be_fresh: z.boolean().optional(),
  });
  const client = new FirecrawlClient({ apiKey });

  return [
    {
      definition: {
        name: "avalon.web_search",
        description:
          "Search the public web only when the request is about public information. Never use this instead of an available connector for private workspace data such as Drive, Gmail, GitHub, Linear, or Notion. Returns ranked links with titles and descriptions, not page content. Read selected results with avalon.web_fetch.",
        capability: "web.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 500 },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: maxSearchResults,
              description: `Maximum results to return; defaults to ${defaultSearchResults}.`,
            },
            recency: {
              type: "string",
              enum: ["day", "week", "month", "year"],
              description: "Optionally restrict results to recently published content.",
            },
          },
          required: ["query"],
        },
      },
      execute: async (raw, context) => {
        const args = searchInputSchema.parse(raw);
        try {
          const response = await client.search({
            query: args.query,
            limit: args.limit ?? defaultSearchResults,
            ...(args.recency ? { tbs: WEB_RECENCY_TO_TBS[args.recency] } : {}),
          }, { signal: context.signal });
          return {
            output: { query: args.query, results: response.results },
            summary: `Found ${response.results.length} web result${response.results.length === 1 ? "" : "s"}`,
          };
        } catch (error) {
          rethrowFirecrawlToolError("search", error, context.signal);
        }
      },
    },
    {
      definition: {
        name: "avalon.web_fetch",
        description:
          "Read a public HTTP or HTTPS page with Firecrawl and return its main content as clean markdown.",
        capability: "web.fetch",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", format: "uri" },
            must_be_fresh: {
              type: "boolean",
              description: "Set true only when a freshly fetched copy is essential; otherwise a cached copy up to two days old may be used.",
            },
          },
          required: ["url"],
        },
      },
      execute: async (raw, context) => {
        const args = fetchInputSchema.parse(raw);
        assertSafePublicUrl(args.url);
        try {
          const response = await client.scrape({
            url: args.url,
            maxAgeMs: args.must_be_fresh ? 0 : FIRECRAWL_CACHE_MAX_AGE_MS,
          }, { signal: context.signal });
          const maxBytes = Math.min(
            numericEnv(env, "WEB_FETCH_MAX_BYTES", 2_000_000),
            numericEnv(env, "HARNESS_MAX_CONTEXT_BYTES", 200_000),
          );
          const markdown = truncateUtf8(response.markdown, maxBytes);
          const resultUrl = response.url ?? args.url;
          return {
            output: {
              url: resultUrl,
              title: response.title,
              markdown,
              statusCode: response.statusCode,
              truncated: markdown !== response.markdown,
              totalChars: response.markdown.length,
            },
            summary: `Fetched ${markdown.length} characters from ${new URL(args.url).hostname}`,
          };
        } catch (error) {
          rethrowFirecrawlToolError("fetch", error, context.signal);
        }
      },
    },
  ];
}

function rethrowFirecrawlToolError(
  operation: "search" | "fetch",
  error: unknown,
  signal: AbortSignal,
): never {
  if (signal.aborted) throw error;
  if (
    error instanceof FirecrawlError &&
    [400, 404, 413, 422].includes(error.status) &&
    error.providerMessage
  ) {
    throw new Error(
      `Web ${operation} request was rejected: ${error.providerMessage.slice(0, 500)}`,
    );
  }
  throw new Error(
    `Web ${operation} is temporarily unavailable. Please try again.`,
    { cause: error },
  );
}

function assertSafePublicUrl(value: string): void {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    !["http:", "https:"].includes(url.protocol) || Boolean(url.username || url.password) ||
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    host.endsWith(".lan") || host.endsWith(".localhost") || host.endsWith(".home.arpa") ||
    host === "metadata.google.internal" || host === "0.0.0.0" || host === "::1" || host === "::" ||
    /^f[cd][0-9a-f]{2}:/u.test(host) || /^fe[89ab][0-9a-f]:/u.test(host) ||
    /^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host) ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host)
  ) throw new Error("Private and local network URLs are not allowed");
}

export async function pollConnectorConnection(
  env: Env,
  input: { workspaceId: string; connectionId: string },
): Promise<{
  activityIds: string[];
  cursor: unknown;
  baseCursorJson: string;
  nextPollAt?: string | null;
}> {
  const row = await env.DB.prepare(
    `SELECT * FROM connector_connections WHERE id = ? AND workspace_id = ? AND status = 'healthy'`,
  ).bind(input.connectionId, input.workspaceId).first<Record<string, unknown>>();
  if (!row) throw new Error("Connector connection is unavailable");
  let credentials: Record<string, unknown> = {};
  if (typeof row.encrypted_credentials === "string" && typeof row.credential_iv === "string") {
    credentials = JSON.parse(
      await decryptString(
        row.encrypted_credentials,
        row.credential_iv,
        env.CONNECTOR_CREDENTIALS_KEY,
        String(row.id),
      ),
    ) as Record<string, unknown>;
  }
  const context: ConnectorConnectionContext = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    scope: row.scope === "workspace" ? "workspace" : "personal",
    ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id),
    grantedScopes: parseJson(row.granted_scopes_json, []),
    credentials,
    cursor: parseJson(row.cursor_json, {}),
    config: { ...parseJson<Record<string, unknown>>(row.config_json, {}), region: env.AVALON_REGION },
  };
  const registry = connectorRegistryForEnv(env);
  const adapter = registry.get(String(row.connector_type));
  const baseCursorJson = typeof row.cursor_json === "string" ? row.cursor_json : "{}";
  if (!adapter.poll) {
    return { activityIds: [], cursor: context.cursor, baseCursorJson, nextPollAt: null };
  }
  const result = await withConnectorCredentialLifecycle(env, context, async () => {
    const pollTimeoutMs = numericEnv(env, "CONNECTOR_POLL_TIMEOUT_MS", 20_000);
    const signal = AbortSignal.timeout(pollTimeoutMs);
    if (
      adapter.refreshCredentials &&
      typeof context.credentials.expiresAt === "string" &&
      Date.parse(context.credentials.expiresAt) < Date.now() + 60_000
    ) {
      credentials = await adapter.refreshCredentials(
        context,
        signal,
      );
      context.credentials = credentials;
    }
    return adapter.poll!(context, signal);
  });
  const activityIds = new Set<string>();
  for (const activity of result.activities) {
    for (const activityId of await persistPolledActivity(env.DB, activity)) {
      activityIds.add(activityId);
    }
  }
  return {
    activityIds: [...activityIds],
    cursor: result.cursor,
    baseCursorJson,
    nextPollAt: result.nextPollAt ?? null,
  };
}

async function withConnectorCredentialLifecycle<T>(
  env: Pick<Env, "DB" | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION">,
  connection: ConnectorConnectionContext,
  operation: () => Promise<T>,
): Promise<T> {
  const credentialsBefore = JSON.stringify(connection.credentials);
  try {
    return await operation();
  } catch (error) {
    if (!isReconnectRequiredConnectorError(error)) throw error;
    const reason = reconnectReason(error);
    await markConnectorNeedsReconnect(env.DB, connection, reason);
    throw new ConnectorError(
      "unauthorized",
      "This connector connection needs reconnecting",
      {
        reconnectRequired: true,
        reason,
      },
    );
  } finally {
    if (JSON.stringify(connection.credentials) !== credentialsBefore) {
      await persistConnectorCredentials(env, connection);
    }
  }
}

function isReconnectRequiredConnectorError(error: unknown): error is ConnectorError {
  if (!(error instanceof ConnectorError) || error.code !== "unauthorized") return false;
  const details = error.details;
  return Boolean(
    details &&
    typeof details === "object" &&
    "reconnectRequired" in details &&
    details.reconnectRequired === true
  );
}

function reconnectReason(error: ConnectorError): string {
  const details = error.details;
  if (!details || typeof details !== "object" || !("reason" in details) || typeof details.reason !== "string") {
    return "authorization_failed";
  }
  return [
    "invalid_grant",
    "api_unauthorized",
    "missing_access_token",
    "missing_credentials",
    "missing_refresh_token",
  ].includes(details.reason)
    ? details.reason
    : "authorization_failed";
}

async function persistConnectorCredentials(
  env: Pick<Env, "DB" | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION">,
  connection: ConnectorConnectionContext,
): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify(connection.credentials),
    env.CONNECTOR_CREDENTIALS_KEY,
    connection.id,
  );
  await env.DB.prepare(
    `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?,
     credential_key_version = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'healthy'`,
  ).bind(
    encrypted.ciphertext,
    encrypted.iv,
    Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
    nowIso(),
    connection.id,
    connection.workspaceId,
  ).run();
}

async function markConnectorNeedsReconnect(
  database: D1Database,
  connection: Pick<ConnectorConnectionContext, "id" | "workspaceId">,
  reason: string,
): Promise<void> {
  await database.prepare(
    `UPDATE connector_connections SET status = 'needs_reconnect', error_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status != 'disabled'`,
  ).bind(
    JSON.stringify({
      code: "connector_reauthorization_required",
      message: "Reconnect this connector account",
      reconnectRequired: true,
      reason,
    }),
    nowIso(),
    connection.id,
    connection.workspaceId,
  ).run();
}

async function persistPolledActivity(
  database: D1Database,
  activity: Omit<NormalizedActivity, "id">,
): Promise<string[]> {
  const id = newId();
  const inserted = await database.prepare(
    `INSERT INTO activities
     (id, workspace_id, connection_id, connection_scope, connection_owner_user_id,
      provider, provider_event_id, event_type, resource_type, provider_resource_id,
      actor_json, subject_json, occurred_at, received_at, title, summary, text_snippet,
      payload_ref, visibility_json, entity_keys_json, dedupe_key, raw_content_hash,
      processing_status, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT DO NOTHING RETURNING id, processing_status`,
  ).bind(
    id,
    activity.workspaceId,
    activity.connectionId,
    activity.connectionScope,
    activity.connectionOwnerUserId,
    activity.provider,
    activity.providerEventId,
    activity.eventType,
    activity.resourceType,
    activity.providerResourceId,
    JSON.stringify(activity.actor),
    JSON.stringify(activity.subject),
    activity.occurredAt,
    activity.receivedAt,
    activity.title,
    activity.summary,
    activity.textSnippet,
    activity.payloadRef,
    JSON.stringify(activity.visibility),
    JSON.stringify(activity.entityKeys),
    activity.dedupeKey,
    activity.rawContentHash,
    JSON.stringify(activity.metadata),
  ).first<{ id: string; processing_status: string }>();
  if (inserted) return [inserted.id];

  // A workflow step can be retried after D1 accepted the insert but before the
  // step result was checkpointed. Recover every canonical row that could have
  // won either unique constraint so pending/failed work is enqueued before the
  // provider cursor advances. Already-processed rows intentionally stay quiet.
  const canonical = await database.prepare(
    `SELECT id, processing_status
       FROM activities
      WHERE workspace_id = ?1
        AND connection_id = ?2
        AND (
          (provider_event_id = ?3 AND event_type = ?4)
          OR dedupe_key = ?5
        )
        AND processing_status IN ('pending', 'failed')`,
  ).bind(
    activity.workspaceId,
    activity.connectionId,
    activity.providerEventId,
    activity.eventType,
    activity.dedupeKey,
  ).all<{ id: string; processing_status: string }>();
  return [...new Set(canonical.results.map((row) => row.id))];
}

export type ConnectorCursorCommit = "committed" | "already_committed" | "superseded";

export async function commitConnectorCursor(
  database: D1Database,
  input: Pick<ConnectorPollWorkflowInput, "workspaceId" | "connectionId">,
  result: { cursorJson: string; baseCursorJson: string },
  now: string,
): Promise<ConnectorCursorCommit> {
  const updated = await database.prepare(
    `UPDATE connector_connections
        SET cursor_json = ?1,
            last_sync_at = ?2,
            error_json = NULL,
            updated_at = ?2
      WHERE id = ?3
        AND workspace_id = ?4
        AND status = 'healthy'
        AND cursor_json = ?5`,
  )
    .bind(result.cursorJson, now, input.connectionId, input.workspaceId, result.baseCursorJson)
    .run();
  if ((updated.meta.changes ?? 0) === 1) return "committed";

  const current = await database.prepare(
    `SELECT cursor_json
       FROM connector_connections
      WHERE id = ?1 AND workspace_id = ?2 AND status = 'healthy'
      LIMIT 1`,
  )
    .bind(input.connectionId, input.workspaceId)
    .first<{ cursor_json: string }>();
  if (!current) throw new Error("connector_cursor_commit_failed");
  return current.cursor_json === result.cursorJson ? "already_committed" : "superseded";
}

export async function advanceOwningPollTarget(
  database: D1Database,
  input: Pick<ConnectorPollWorkflowInput, "workspaceId" | "connectionId" | "pollScheduleId">,
  nextPollAt: string,
  now: string,
): Promise<boolean> {
  const [schedule, watch] = await database.batch([
    database.prepare(
      `UPDATE schedules
          SET next_run_at = ?1,
              last_run_at = ?2,
              version = version + 1,
              updated_at = ?2
        WHERE id = ?3
          AND workspace_id = ?4
          AND connector_connection_id = ?5
          AND enabled = 1
          AND (next_run_at <= ?2 OR next_run_at > ?1)`,
    ).bind(nextPollAt, now, input.pollScheduleId, input.workspaceId, input.connectionId),
    database.prepare(
      `UPDATE resource_watches
          SET next_poll_at = ?1,
              updated_at = ?2
        WHERE id = ?3
          AND workspace_id = ?4
          AND connection_id = ?5
          AND enabled = 1
          AND (next_poll_at IS NULL OR next_poll_at <= ?2 OR next_poll_at > ?1)`,
    ).bind(nextPollAt, now, input.pollScheduleId, input.workspaceId, input.connectionId),
  ]);
  return (schedule?.meta.changes ?? 0) + (watch?.meta.changes ?? 0) > 0;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function summarize(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").slice(0, maxLength);
}

/**
 * Store the observed tool block in the same sequence domain as transcript
 * messages. The invocation UUID is also the message UUID, which makes every
 * lifecycle update idempotent without adding another cross-table identifier.
 *
 * The guarded sequence increment is important: completion and replay updates
 * refresh the existing block without consuming a new transcript position.
 */
async function persistToolTranscriptMessage(
  env: Env,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId">,
  invocation: ToolInvocation,
): Promise<void> {
  const createdAt = invocation.startedAt ?? invocation.completedAt ?? nowIso();
  const editedAt = invocation.status === "pending" || invocation.status === "started"
    ? null
    : invocation.completedAt ?? nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type, message_type,
        text_content, structured_content_json, sequence_number, created_at, edited_at)
       SELECT ?, ?, ?, w.id, 'agent', 'tool', '', ?, w.next_sequence_number, ?, ?
       FROM workstreams w
       WHERE w.id = ? AND w.workspace_id = ?
       ON CONFLICT(id) DO UPDATE SET
         structured_content_json = excluded.structured_content_json,
         edited_at = excluded.edited_at
       WHERE messages.workspace_id = excluded.workspace_id
         AND messages.workstream_id = excluded.workstream_id
         AND messages.message_type = 'tool'`,
    ).bind(
      invocation.id,
      `tool:${invocation.id}`,
      input.workspaceId,
      JSON.stringify({ invocation }),
      createdAt,
      editedAt,
      input.workstreamId,
      input.workspaceId,
    ),
    env.DB.prepare(
      `UPDATE workstreams
       SET next_sequence_number = next_sequence_number + 1, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND next_sequence_number = (
           SELECT sequence_number FROM messages
           WHERE id = ? AND workspace_id = ? AND workstream_id = ? AND message_type = 'tool'
         )`,
    ).bind(
      nowIso(),
      input.workstreamId,
      input.workspaceId,
      invocation.id,
      input.workspaceId,
      input.workstreamId,
    ),
  ]);
}

async function loadToolInvocation(env: Env, harnessRunId: string, toolCallId: string): Promise<ToolInvocation | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM tool_invocations WHERE harness_run_id = ? AND tool_call_id = ?`,
  ).bind(harnessRunId, toolCallId).first<Record<string, unknown>>();
  if (!row) return null;
  const error = parseJson<{ code: string; message: string } | null>(row.error_json, null);
  return {
    id: String(row.id),
    harnessRunId: String(row.harness_run_id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    connectionId: row.connection_id == null ? null : String(row.connection_id),
    status: String(row.status) as ToolInvocation["status"],
    inputSummary: summarize(parseJson(row.input_json, {}), 1_000),
    outputSummary: row.output_summary == null ? null : summarize(String(row.output_summary), 4_000),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    error,
  };
}

async function markToolInvocationAmbiguous(
  env: Env,
  harnessRunId: string,
  toolCallId: string,
  message: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tool_invocations SET status = 'ambiguous', error_json = ?, completed_at = ?
     WHERE harness_run_id = ? AND tool_call_id = ?`,
  ).bind(
    JSON.stringify({ code: "ambiguous_external_write", message }),
    nowIso(),
    harnessRunId,
    toolCallId,
  ).run();
}

async function isHarnessStopped(env: Env, harnessRunId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT status FROM harness_runs WHERE id = ?")
    .bind(harnessRunId)
    .first<{ status: string }>();
  return row?.status === "stopped";
}

async function recordToolAudit(
  env: Env,
  input: WorkstreamWorkflowInput,
  invocationId: string,
  toolName: string,
  mode: "read" | "write",
  status: "completed" | "failed" | "ambiguous",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
     (id, workspace_id, actor_type, actor_user_id, workstream_id, action,
      target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'tool_invocation', ?, ?, ?)`,
  ).bind(
    newId(),
    input.workspaceId,
    input.executionPrincipal.type,
    input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null,
    input.workstreamId,
    `${mode === "write" ? "external_write" : "tool_read"}.${status}`,
    invocationId,
    JSON.stringify({ toolName, harnessRunId: input.harnessRunId }),
    nowIso(),
  ).run();
}

export const __integrationTesting = {
  boundModelContext,
  assertSafePublicUrl,
  createAvalonTools,
  loadHarnessTools,
  serializeToolReplayOutput,
  persistToolTranscriptMessage,
  persistPolledActivity,
  withConnectorCredentialLifecycle,
  createStreamDeltaBatcher,
};
