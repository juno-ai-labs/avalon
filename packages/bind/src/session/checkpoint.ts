import { z } from "zod";
import type { TranscriptMessage } from "../contracts/turn";
import { accumulateRun, emptyRunStats } from "../contracts/turn";
import { assertCheckpointTranscript, type LoopBoundary } from "../loop/boundary";
export { assertCheckpointTranscript } from "../loop/boundary";
import type { ToolLoopState } from "../loop/tool-loop";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().nonnegative();
const textPart = z.object({ type: z.literal("text"), text: z.string() });
const contentPart = z.discriminatedUnion("type", [
  textPart,
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string(), detail: z.enum(["auto", "low", "high"]).optional() }) }),
  z.object({ type: z.literal("input_audio"), input_audio: z.object({ data: z.string(), format: z.enum(["wav", "mp3"]) }) }),
  z.object({ type: z.literal("file"), file: z.object({ file_data: z.string().optional(), file_id: z.string().optional(), filename: z.string().optional() }) }),
  z.object({ type: z.literal("refusal"), refusal: z.string() }),
]);
const toolCall = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("function"), function: z.object({ name: z.string().min(1), arguments: z.string() }) }),
  z.object({ id: z.string().min(1), type: z.literal("custom"), custom: z.object({ name: z.string().min(1), input: z.string() }) }),
]);
const messageShape = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPart)]).nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCall).optional(),
  tool_call_id: z.string().min(1).optional(),
  refusal: z.string().nullable().optional(),
}).superRefine((message, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (message.role === "tool" && !message.tool_call_id) issue("Tool result needs an id");
  if (message.role !== "tool" && message.tool_call_id !== undefined) issue("Only a tool result has a tool_call_id");
  if (message.role !== "assistant" && message.tool_calls !== undefined) issue("Only an assistant can request tools");
  if (message.role !== "assistant" && message.content == null) issue("Message needs content");
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (message.role !== "user" && part.type !== "text"
        && !(message.role === "assistant" && part.type === "refusal")) issue("Content part is invalid for this role");
      if (message.role === "user" && part.type === "refusal") issue("Refusal is assistant content");
    }
  }
  if (message.function_call !== undefined) issue("Legacy function calls are not checkpointable");
});

// Validate the wire shape without throwing away provider extension fields.
const messageSchema = z.custom<TranscriptMessage>((value) =>
  z.json().safeParse(value).success && messageShape.safeParse(value).success,
  "Invalid checkpoint message");

// SDK message objects can explicitly carry undefined optional properties.
// Normalize only these known omissions when capturing live messages; storage
// parsing remains strict and unsupported extension values still fail validation.
function captureMessage(message: TranscriptMessage): TranscriptMessage {
  const captured = { ...message };
  for (const key of ["content", "name", "tool_calls", "tool_call_id", "refusal"] as const) {
    if (key in captured && Reflect.get(captured, key) === undefined) {
      Reflect.deleteProperty(captured, key);
    }
  }
  return captured;
}
const stateSchema = z.strictObject({
  messages: z.array(messageSchema),
  inputTokens: amount,
  outputTokens: amount,
  costCents: amount,
  lastPromptTokens: amount,
  lastOutputTokens: amount,
  hasFreshTokenCount: z.boolean(),
  toolCalls: count,
  endedTurnViaTool: z.boolean().optional(),
  suspended: z.strictObject({
    toolCallId: z.string().min(1),
    reason: z.string(),
    resumeKind: z.literal("answer"),
    request: z.json().optional(),
  }).optional(),
});
const statsSchema = z.strictObject({
  turns: count, toolCalls: count, inputTokens: amount, outputTokens: amount,
  cachedInputTokens: amount, costCents: amount, modelTimeMs: amount,
  toolTimeMs: amount, outputTokensPerSecond: amount.nullable(),
  toolTimeBreakdownMs: z.record(z.string(), amount),
});
const positionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({ kind: z.literal("waiting"), reason: z.enum(["waiting_for_reply", "resuming_later"]) }),
  z.strictObject({ kind: z.literal("finished"), reason: z.enum(["done", "iteration_limit", "aborted"]) }),
]);

/** Host-owned configuration/version pins and restorable environment reference. No credentials. */
export const CheckpointBindingsSchema = z.strictObject({
  configuration: z.record(z.string(), z.json()),
  environment: z.json(),
});
export type CheckpointBindings = z.infer<typeof CheckpointBindingsSchema>;

const checkpointSchema = z.strictObject({
  version: z.literal(1),
  executionId: z.string().min(1),
  revision: count,
  parent: z.strictObject({ executionId: z.string().min(1), revision: count }).nullable(),
  position: positionSchema,
  iterationsUsed: count,
  maxIterations: count,
  state: stateSchema,
  stats: statsSchema,
  bindings: CheckpointBindingsSchema,
});

export type LoopCheckpoint = z.infer<typeof checkpointSchema>;

/** Parse untrusted storage before it can become executable state. Always detached. */
export function parseLoopCheckpoint(value: unknown): LoopCheckpoint {
  const parsed = checkpointSchema.parse(value);
  if (parsed.iterationsUsed > parsed.maxIterations || parsed.stats.turns !== parsed.iterationsUsed) {
    throw new Error("checkpoint_iteration_mismatch");
  }
  if (parsed.state.inputTokens !== parsed.stats.inputTokens
    || parsed.state.outputTokens !== parsed.stats.outputTokens
    || parsed.state.costCents !== parsed.stats.costCents) throw new Error("checkpoint_accounting_mismatch");
  const waitingForReply = parsed.position.kind === "waiting" && parsed.position.reason === "waiting_for_reply";
  if (waitingForReply !== (parsed.state.suspended !== undefined)) throw new Error("checkpoint_suspension_mismatch");
  assertCheckpointTranscript(parsed.state.messages, parsed.state.suspended?.toolCallId ?? null);
  // The schema has checked every field for finite JSON values. No shared arrays
  // survive between a persisted checkpoint, a fork, and a running loop.
  return JSON.parse(JSON.stringify(parsed)) as LoopCheckpoint;
}

export function serializeLoopCheckpoint(checkpoint: LoopCheckpoint): string {
  return JSON.stringify(parseLoopCheckpoint(checkpoint));
}

export function createLoopCheckpoint(input: {
  executionId: string;
  messages: TranscriptMessage[];
  maxIterations: number;
  bindings: CheckpointBindings;
}): LoopCheckpoint {
  return parseLoopCheckpoint({
    version: 1, executionId: input.executionId, revision: 0, parent: null,
    position: { kind: "ready" }, iterationsUsed: 0, maxIterations: input.maxIterations,
    state: {
      messages: input.messages.map(captureMessage), inputTokens: 0, outputTokens: 0, costCents: 0,
      lastPromptTokens: 0, lastOutputTokens: 0, hasFreshTokenCount: false, toolCalls: 0,
    },
    stats: emptyRunStats(), bindings: input.bindings,
  });
}

/** Pure boundary reducer used by the real loop's checkpoint driver. */
export function advanceLoopCheckpoint(
  previous: LoopCheckpoint,
  boundary: LoopBoundary,
  invocationStart: LoopCheckpoint,
  bindings: CheckpointBindings,
): LoopCheckpoint {
  if (previous.executionId !== invocationStart.executionId
    || boundary.iterationsUsed < previous.iterationsUsed
    || previous.position.kind !== "ready") throw new Error("checkpoint_transition_out_of_order");
  const stats = accumulateRun(invocationStart.stats, boundary.stats);
  return parseLoopCheckpoint({
    ...previous,
    revision: previous.revision + 1,
    position: boundary.position,
    iterationsUsed: boundary.iterationsUsed,
    // One canonical spend total avoids floating-point grouping differences
    // between base + per-turn state and base + invocation statistics on resume.
    state: { ...boundary.state, messages: boundary.state.messages.map(captureMessage),
      inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, costCents: stats.costCents },
    stats,
    bindings,
  });
}

/** A fork inherits history and context pressure, but never spend or future identity. */
export function forkLoopCheckpoint(source: LoopCheckpoint, input: {
  executionId: string;
  maxIterations: number;
  bindings: CheckpointBindings;
}): LoopCheckpoint {
  const checkpoint = parseLoopCheckpoint(source);
  if (input.executionId === checkpoint.executionId) throw new Error("checkpoint_fork_identity_reused");
  return parseLoopCheckpoint({
    ...checkpoint, executionId: input.executionId, revision: 0,
    parent: { executionId: checkpoint.executionId, revision: checkpoint.revision },
    iterationsUsed: 0, maxIterations: input.maxIterations, stats: emptyRunStats(),
    state: { ...checkpoint.state, inputTokens: 0, outputTokens: 0, costCents: 0, toolCalls: 0 },
    bindings: input.bindings,
  });
}

export type CheckpointInput =
  | { kind: "reply"; message: Extract<TranscriptMessage, { role: "tool" }> }
  | { kind: "wake"; messages: Extract<TranscriptMessage, { role: "user" }>[] }
  | { kind: "message"; message: Extract<TranscriptMessage, { role: "user" }> };

/** Resolve a waiting state explicitly. A finished history needs new input to run again. */
export function applyCheckpointInput(source: LoopCheckpoint, input: CheckpointInput): LoopCheckpoint {
  const checkpoint = parseLoopCheckpoint(source);
  const state: ToolLoopState = checkpoint.state;
  switch (input.kind) {
    case "reply":
      if (checkpoint.position.kind !== "waiting" || checkpoint.position.reason !== "waiting_for_reply"
        || input.message.role !== "tool"
        || input.message.tool_call_id !== state.suspended?.toolCallId) throw new Error("checkpoint_reply_mismatch");
      state.messages.push(captureMessage(input.message));
      delete state.suspended;
      break;
    case "wake":
      if (checkpoint.position.kind !== "waiting" || checkpoint.position.reason !== "resuming_later") {
        throw new Error("checkpoint_not_waiting_for_wake");
      }
      if (input.messages.some((message) => message.role !== "user")) throw new Error("checkpoint_input_role_invalid");
      state.messages.push(...input.messages.map(captureMessage));
      break;
    case "message":
      if (checkpoint.position.kind === "waiting") throw new Error("checkpoint_input_blocked");
      if (input.message.role !== "user") throw new Error("checkpoint_input_role_invalid");
      state.messages.push(captureMessage(input.message));
      break;
    default: {
      const exhaustive: never = input;
      throw new Error(`Unknown input: ${exhaustive}`);
    }
  }
  delete state.endedTurnViaTool;
  return parseLoopCheckpoint({ ...checkpoint, revision: checkpoint.revision + 1, position: { kind: "ready" }, state });
}
