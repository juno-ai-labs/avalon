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
      kind: "assistant_accepted";
      generation: number;
      message: BindLoopMessage;
      turnId: string;
      modelTurnIndex: number;
    }
  | BindLoopTransitionBase & {
      kind: "tool_result_accepted";
      generation: number;
      message: BindLoopMessage;
      turnId: string;
      toolCallId: string;
      callIndex: number;
    }
  | BindLoopTransitionBase & {
      kind: "protocol_user_appended";
      generation: number;
      message: BindLoopMessage;
      origin: "protocol" | "derived";
      sourceId: string | null;
    }
  | BindLoopTransitionBase & {
      /**
       * Bind's validator is allowed to repair a provider transcript immediately
       * before dispatch. Persist the repaired value as the provider-facing truth
       * instead of pretending the pre-repair array was sent.
       */
      kind: "state_reconciled";
      generation: number;
      systemProjection: BindSystemProjection;
      nonSystemMessages: readonly BindLoopMessage[];
      reason: "provider_validation" | "resume_validation";
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
  systemProjection: BindSystemProjection;
  nonSystemMessages: BindLoopMessage[];
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
      systemProjection: cloneJson(transition.systemProjection),
      nonSystemMessages: transition.nonSystemMessages.map(cloneJson),
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
    return {
      loopId: previous.loopId,
      generation: transition.nextGeneration,
      stateRevision: transition.stateRevision,
      systemProjection: cloneJson(transition.systemProjection),
      nonSystemMessages: transition.nonSystemMessages.map(cloneJson),
    };
  }

  if (transition.kind === "state_reconciled") {
    return {
      loopId: previous.loopId,
      generation: previous.generation,
      stateRevision: transition.stateRevision,
      systemProjection: cloneJson(transition.systemProjection),
      nonSystemMessages: transition.nonSystemMessages.map(cloneJson),
    };
  }

  const next: BindLoopProjectionState = {
    ...previous,
    stateRevision: transition.stateRevision,
    systemProjection: cloneJson(previous.systemProjection),
    nonSystemMessages: previous.nonSystemMessages.map(cloneJson),
  };
  if (transition.kind === "system_projection_changed") {
    next.systemProjection = cloneJson(transition.systemProjection);
  } else {
    next.nonSystemMessages.push(cloneJson(transition.message));
  }
  return next;
}

export function projectBindLoopMessages(state: BindLoopProjectionState): BindLoopMessage[] {
  return [
    cloneJson(state.systemProjection.message),
    ...state.nonSystemMessages.map(cloneJson),
  ];
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
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJson(nested)]));
  }
  throw new Error("bind_loop_non_json_value");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalizeBindLoop(value)) as T;
}
