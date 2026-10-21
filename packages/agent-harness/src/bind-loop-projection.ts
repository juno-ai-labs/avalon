export type BindLoopMessage = Readonly<Record<string, unknown>>;

export interface BindLoopMessageOrigin {
  originKind: "canonical" | "protocol" | "derived";
  sourceKind: string | null;
  sourceId: string | null;
  sourceRevision: number | null;
}

export interface BindSystemProjection {
  revision: number;
  rendererVersion: string;
  inputHash: string;
  message: BindLoopMessage;
}

interface BindLoopTransitionBase {
  loopId: string;
  stateRevision: number;
}

export type BindLoopTransition =
  | BindLoopTransitionBase & {
      kind: "state_initialized";
      generation: 1;
      systemProjection: BindSystemProjection;
      nonSystemMessages: readonly BindLoopMessage[];
      nonSystemMessageOrigins: readonly BindLoopMessageOrigin[];
    }
  | BindLoopTransitionBase & {
      kind: "system_projection_changed";
      generation: number;
      systemProjection: BindSystemProjection;
    }
  | BindLoopTransitionBase & {
      kind: "assistant_reserved";
      generation: number;
      turnId: string;
      modelTurnIndex: number;
      transcriptSequence: number | null;
    }
  | BindLoopTransitionBase & {
      kind: "assistant_accepted";
      generation: number;
      message: BindLoopMessage;
      turnId: string;
      modelTurnIndex: number;
      transcriptSequence: number | null;
    }
  | BindLoopTransitionBase & {
      kind: "assistant_reservation_settled";
      generation: number;
      turnId: string;
      modelTurnIndex: number;
      transcriptSequence: number | null;
      outcome: "failed" | "stopped";
    }
  | BindLoopTransitionBase & {
      kind: "tool_result_accepted";
      generation: number;
      message: BindLoopMessage;
      turnId: string;
      toolCallId: string;
      /** Original position in the assistant's tool_calls array. */
      callIndex: number;
      /** Dense order in which durable tool results were accepted. */
      resultOrdinal: number;
      /** Host recovery provenance; ordinary Bind acceptance omits it. */
      recoverySource?: "tool_receipt" | "not_run";
    }
  | BindLoopTransitionBase & {
      kind: "protocol_user_appended";
      generation: number;
      message: BindLoopMessage;
      provenance: BindLoopMessageOrigin;
      /** Stable logical admission identity; independent of executor/run ID. */
      activationInputId: string | null;
    }
  | BindLoopTransitionBase & {
      kind: "state_replaced";
      generation: number;
      nextGeneration: number;
      systemProjection: BindSystemProjection;
      nonSystemMessages: readonly BindLoopMessage[];
      compactionEventId: string;
    };

export interface BindLoopProjectionState {
  loopId: string;
  generation: number;
  stateRevision: number;
  /** Last globally allocated model turn in this persistent loop. */
  lastModelTurnIndex: number;
  /** The last reservation and how it settled. */
  lastAssistantReservation: {
    turnId: string;
    modelTurnIndex: number;
    transcriptSequence: number | null;
    status: "pending" | "accepted" | "failed" | "stopped";
  } | null;
  systemProjection: BindSystemProjection;
  /**
   * Persistent immutable suffix chain. Ordinary transitions share the prior
   * prefix and allocate at most one node; only provider projection and
   * compaction materialize the complete ordered array.
   */
  nonSystemMessageTail: BindLoopMessageNode | null;
}

export interface BindLoopMessageNode {
  readonly message: BindLoopMessage;
  readonly previous: BindLoopMessageNode | null;
  readonly length: number;
}

export interface PendingBindToolCall {
  /** Provider protocol identity carried by the accepted assistant message. */
  providerToolCallId: string;
  /** Durable Rally receipt coordinate for this exact position in the loop. */
  receiptToolCallId: string;
  callIndex: number;
  toolName: string;
}

export interface PendingBindToolBatch {
  loopId: string;
  turnId: string;
  modelTurnIndex: number;
  generation: number;
  stateRevision: number;
  acceptedResultCount: number;
  calls: PendingBindToolCall[];
}

export interface BindProviderBoundary {
  loopId: string;
  generation: number;
  stateRevision: number;
  systemProjectionRevision: number;
  projectorVersion: string;
  projectedHash: string;
  bindHash: string;
}

export const BIND_LOOP_PROJECTOR_VERSION = "bind-loop-v1";
export const BIND_SYSTEM_RENDERER_VERSION = "workstream-system-v1";

export function applyBindLoopTransition(
  previous: BindLoopProjectionState | null,
  transition: BindLoopTransition,
): BindLoopProjectionState {
  if (transition.kind === "state_initialized") {
    if (previous !== null || transition.stateRevision !== 1) {
      throw new Error("bind_loop_initialization_out_of_order");
    }
    if (transition.nonSystemMessageOrigins.length !== transition.nonSystemMessages.length) {
      throw new Error("bind_loop_message_origin_count_mismatch");
    }
    return {
      loopId: transition.loopId,
      generation: 1,
      stateRevision: 1,
      lastModelTurnIndex: 0,
      lastAssistantReservation: null,
      systemProjection: cloneJson(transition.systemProjection),
      nonSystemMessageTail: bindLoopMessageChain(transition.nonSystemMessages),
    };
  }
  if (previous === null || previous.loopId !== transition.loopId) {
    throw new Error("bind_loop_not_initialized");
  }
  if (transition.stateRevision !== previous.stateRevision + 1) {
    throw new Error("bind_loop_revision_out_of_order");
  }
  if (transition.generation !== previous.generation) {
    throw new Error("bind_loop_generation_mismatch");
  }

  if (transition.kind === "state_replaced") {
    if (transition.nextGeneration !== previous.generation + 1) {
      throw new Error("bind_loop_replacement_generation_out_of_order");
    }
    if (previous.lastAssistantReservation?.status === "pending"
      || !lastAssistantStepIsSettled(previous)) {
      throw new Error("bind_loop_replacement_step_unsettled");
    }
    return {
      loopId: previous.loopId,
      generation: transition.nextGeneration,
      stateRevision: transition.stateRevision,
      lastModelTurnIndex: previous.lastModelTurnIndex,
      lastAssistantReservation: cloneJson(previous.lastAssistantReservation),
      systemProjection: cloneJson(transition.systemProjection),
      nonSystemMessageTail: bindLoopMessageChain(transition.nonSystemMessages),
    };
  }

  const next: BindLoopProjectionState = {
    ...previous,
    stateRevision: transition.stateRevision,
  };
  if (transition.kind === "system_projection_changed") {
    next.systemProjection = cloneJson(transition.systemProjection);
  } else if (transition.kind === "assistant_reserved") {
    if (previous.lastAssistantReservation?.status === "pending") {
      throw new Error("bind_loop_assistant_reservation_pending");
    }
    if (transition.modelTurnIndex !== previous.lastModelTurnIndex + 1) {
      throw new Error("bind_loop_model_turn_out_of_order");
    }
    if (!lastAssistantStepIsSettled(previous)) {
      throw new Error("bind_loop_assistant_step_unsettled");
    }
    if (transition.turnId !== `${transition.loopId}:turn:${transition.modelTurnIndex}`) {
      throw new Error("bind_loop_turn_id_invalid");
    }
    if (transition.transcriptSequence !== null
      && (!Number.isSafeInteger(transition.transcriptSequence)
        || transition.transcriptSequence < 1)) {
      throw new Error("bind_loop_transcript_sequence_invalid");
    }
    next.lastModelTurnIndex = transition.modelTurnIndex;
    next.lastAssistantReservation = {
      turnId: transition.turnId,
      modelTurnIndex: transition.modelTurnIndex,
      transcriptSequence: transition.transcriptSequence,
      status: "pending",
    };
  } else if (transition.kind === "assistant_reservation_settled") {
    const reservation = previous.lastAssistantReservation;
    if (!reservation
      || reservation.status !== "pending"
      || reservation.turnId !== transition.turnId
      || reservation.modelTurnIndex !== transition.modelTurnIndex
      || reservation.transcriptSequence !== transition.transcriptSequence) {
      throw new Error("bind_loop_assistant_reservation_mismatch");
    }
    next.lastAssistantReservation = { ...reservation, status: transition.outcome };
  } else if (transition.kind === "assistant_accepted") {
    const reservation = previous.lastAssistantReservation;
    if (!reservation
      || reservation.status !== "pending"
      || reservation.turnId !== transition.turnId
      || reservation.modelTurnIndex !== transition.modelTurnIndex
      || reservation.transcriptSequence !== transition.transcriptSequence) {
      throw new Error("bind_loop_assistant_reservation_mismatch");
    }
    if (transition.message.role !== "assistant") {
      throw new Error("bind_loop_assistant_message_invalid");
    }
    const toolCalls = transition.message.tool_calls;
    if (toolCalls !== undefined && (!Array.isArray(toolCalls)
      || toolCalls.some((call) => !toolCallId(call))
      || new Set(toolCalls.map(toolCallId)).size !== toolCalls.length)) {
      throw new Error("bind_loop_assistant_tool_calls_invalid");
    }
    next.nonSystemMessageTail = appendBindLoopMessage(previous, transition.message);
    next.lastAssistantReservation = { ...reservation, status: "accepted" };
  } else if (transition.kind === "tool_result_accepted") {
    const progress = lastAssistantToolProgress(previous);
    if (!progress
      || previous.lastAssistantReservation?.status !== "accepted"
      || transition.turnId !== previous.lastAssistantReservation.turnId
      || transition.resultOrdinal !== progress.acceptedToolCallIds.length
      || transition.callIndex >= progress.expectedToolCallIds.length
      || transition.toolCallId !== progress.expectedToolCallIds[transition.callIndex]
      || progress.acceptedToolCallIds.includes(transition.toolCallId)
      || transition.message.role !== "tool"
      || transition.message.tool_call_id !== transition.toolCallId) {
      throw new Error("bind_loop_tool_result_out_of_order");
    }
    next.nonSystemMessageTail = appendBindLoopMessage(previous, transition.message);
  } else {
    if (transition.message.role !== "user"
      || !validMessageOrigin(transition.provenance)
      || (transition.activationInputId !== null
        && (transition.activationInputId.length === 0
          || transition.provenance.originKind !== "derived"))
      || !lastAssistantStepIsSettled(previous)) {
      throw new Error("bind_loop_protocol_user_invalid");
    }
    next.nonSystemMessageTail = appendBindLoopMessage(previous, transition.message);
  }
  return next;
}

function validMessageOrigin(origin: BindLoopMessageOrigin): boolean {
  if (origin.originKind === "canonical" || origin.originKind === "protocol") {
    return origin.sourceKind === null
      && origin.sourceId === null
      && origin.sourceRevision === null;
  }
  return origin.originKind === "derived"
    && typeof origin.sourceKind === "string"
    && origin.sourceKind.length > 0
    && typeof origin.sourceId === "string"
    && origin.sourceId.length > 0
    && (origin.sourceRevision === null
      || (Number.isSafeInteger(origin.sourceRevision) && origin.sourceRevision >= 0));
}

function toolCallId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function lastAssistantToolProgress(state: BindLoopProjectionState): {
  expectedToolCallIds: string[];
  acceptedToolCallIds: string[];
} | null {
  const messagesAfterAssistant: BindLoopMessage[] = [];
  let cursor = state.nonSystemMessageTail;
  while (cursor && cursor.message.role !== "assistant") {
    messagesAfterAssistant.push(cursor.message);
    cursor = cursor.previous;
  }
  if (!cursor) return null;
  const assistant = cursor.message;
  const rawCalls = assistant.tool_calls;
  const expectedToolCallIds = Array.isArray(rawCalls)
    ? rawCalls.map(toolCallId).filter((id): id is string => id !== null)
    : [];
  const acceptedToolCallIds: string[] = [];
  for (const message of messagesAfterAssistant.reverse()) {
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") break;
    acceptedToolCallIds.push(message.tool_call_id);
  }
  return { expectedToolCallIds, acceptedToolCallIds };
}

function lastAssistantStepIsSettled(state: BindLoopProjectionState): boolean {
  const progress = lastAssistantToolProgress(state);
  return progress === null
    || progress.acceptedToolCallIds.length === progress.expectedToolCallIds.length;
}

/**
 * The unfinished suffix of the last accepted assistant tool batch.
 *
 * Bind intentionally refuses to heal this protocol state. The durable host
 * uses these two identities to reconcile Rally receipts without confusing the
 * provider's call id with the receipt coordinate, then appends terminal tool
 * messages in the original call order before any later provider boundary.
 */
export function pendingBindToolBatch(
  state: BindLoopProjectionState,
): PendingBindToolBatch | null {
  const progress = lastAssistantToolProgress(state);
  const reservation = state.lastAssistantReservation;
  if (!progress || reservation?.status !== "accepted"
    || progress.acceptedToolCallIds.length === progress.expectedToolCallIds.length) {
    return null;
  }
  let cursor = state.nonSystemMessageTail;
  while (cursor && cursor.message.role !== "assistant") cursor = cursor.previous;
  const rawCalls = cursor?.message.tool_calls;
  if (!Array.isArray(rawCalls)) throw new Error("bind_loop_assistant_tool_calls_invalid");
  const accepted = new Set(progress.acceptedToolCallIds);
  const calls = rawCalls.flatMap((rawCall, callIndex) => {
    if (!rawCall || typeof rawCall !== "object") {
      throw new Error("bind_loop_assistant_tool_calls_invalid");
    }
    const call = rawCall as {
      id?: unknown;
      function?: { name?: unknown };
    };
    const providerToolCallId = typeof call.id === "string" ? call.id : "";
    const toolName = typeof call.function?.name === "string" ? call.function.name : "tool";
    if (!providerToolCallId) throw new Error("bind_loop_assistant_tool_calls_invalid");
    if (accepted.has(providerToolCallId)) return [];
    return [{
      providerToolCallId,
      // Turn IDs survive relocation; receipts and elicitations retain that identity.
      receiptToolCallId: `${reservation.turnId}:tool:${callIndex}`,
      callIndex,
      toolName,
    }];
  });
  return {
    loopId: state.loopId,
    turnId: reservation.turnId,
    modelTurnIndex: reservation.modelTurnIndex,
    generation: state.generation,
    stateRevision: state.stateRevision,
    acceptedResultCount: progress.acceptedToolCallIds.length,
    calls,
  };
}

export function projectBindLoopMessages(state: BindLoopProjectionState): BindLoopMessage[] {
  return [
    cloneJson(state.systemProjection.message),
    ...bindLoopNonSystemMessages(state).map(cloneJson),
  ];
}

export function bindLoopMessageChain(
  messages: readonly BindLoopMessage[],
): BindLoopMessageNode | null {
  let tail: BindLoopMessageNode | null = null;
  let length = 0;
  for (const message of messages) {
    const previous: BindLoopMessageNode | null = tail;
    length += 1;
    tail = {
      message: cloneJson(message),
      previous,
      length,
    };
  }
  return tail;
}

export function bindLoopNonSystemMessageCount(state: BindLoopProjectionState): number {
  return state.nonSystemMessageTail?.length ?? 0;
}

export function bindLoopNonSystemMessages(state: BindLoopProjectionState): BindLoopMessage[] {
  const messages = new Array<BindLoopMessage>(bindLoopNonSystemMessageCount(state));
  let cursor = state.nonSystemMessageTail;
  while (cursor) {
    messages[cursor.length - 1] = cursor.message;
    cursor = cursor.previous;
  }
  return messages;
}

function appendBindLoopMessage(
  previous: BindLoopProjectionState,
  message: BindLoopMessage,
): BindLoopMessageNode {
  return {
    message: cloneJson(message),
    previous: previous.nonSystemMessageTail,
    length: bindLoopNonSystemMessageCount(previous) + 1,
  };
}

export function canonicalizeBindLoop(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

export async function hashBindLoop(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeBindLoop(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyBindProviderBoundary(input: {
  loopId: string;
  generation: number;
  stateRevision: number;
  systemProjectionRevision: number;
  projectedMessages: readonly BindLoopMessage[];
  bindMessages: readonly BindLoopMessage[];
}): Promise<BindProviderBoundary> {
  const [projectedHash, bindHash] = await Promise.all([
    hashBindLoop(input.projectedMessages),
    hashBindLoop(input.bindMessages),
  ]);
  if (projectedHash !== bindHash) throw new Error("bind_loop_projection_mismatch");
  return {
    loopId: input.loopId,
    generation: input.generation,
    stateRevision: input.stateRevision,
    systemProjectionRevision: input.systemProjectionRevision,
    projectorVersion: BIND_LOOP_PROJECTOR_VERSION,
    projectedHash,
    bindHash,
  };
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("bind_loop_non_finite_number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      // Relational string comparison is specified in UTF-16 code-unit order;
      // localeCompare delegates to runtime ICU data and is not a canonical
      // byte ordering across machines or locale upgrades.
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalJson(nested)]));
  }
  throw new Error("bind_loop_non_json_value");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalizeBindLoop(value)) as T;
}
