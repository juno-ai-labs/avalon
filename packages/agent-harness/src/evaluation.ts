import { z } from 'zod';
import {
  forkLoopCheckpoint, applyCheckpointInput, parseLoopCheckpoint,
  type LoopCheckpoint, type CheckpointBindings, type CheckpointInput,
} from '@juno-ai/bind/session';
import type { PreparedConversation } from '@rally/contracts';
import type { RunHarnessInput } from './index';
import { runHarnessWithBind } from './bind-runtime';
import { bindLoopMessageChain, type BindLoopProjectionState } from './bind-loop-projection';
import { preparedContentMessages } from './prepared-content';

/** Flat host state avoids serializing the production projection's linked list. */
export interface RallyCheckpoint {
  loop: LoopCheckpoint;
  projection: Omit<BindLoopProjectionState, 'nonSystemMessageTail'> & { messages: Record<string, unknown>[] };
  activationHints: string[];
  skillActivationHints: string[];
}
export interface RallyCheckpointPort {
  start?: LoopCheckpoint;
  bindings: CheckpointBindings;
  captureBindings(): Promise<CheckpointBindings>;
  commit(checkpoint: RallyCheckpoint): Promise<void>;
}

const projectionSchema = z.object({
  loopId: z.string(), generation: z.number().int().positive(), stateRevision: z.number().int().positive(),
  lastModelTurnIndex: z.number().int().nonnegative(),
  lastAssistantReservation: z.object({ turnId: z.string(), modelTurnIndex: z.number().int().positive(),
    transcriptSequence: z.number().int().positive().nullable(), status: z.enum(['pending', 'accepted', 'failed', 'stopped']) }).nullable(),
  systemProjection: z.object({ revision: z.number().int().positive(), rendererVersion: z.string(),
    inputHash: z.string(), message: z.record(z.string(), z.unknown()) }),
  messages: z.array(z.record(z.string(), z.unknown())),
});
export function parseRallyCheckpoint(value: unknown): RallyCheckpoint {
  const parsed = z.object({ loop: z.unknown(), projection: projectionSchema,
    activationHints: z.array(z.string()), skillActivationHints: z.array(z.string()) }).parse(value);
  return { ...parsed, loop: parseLoopCheckpoint(parsed.loop) };
}

/** The host restores real configuration and an isolated tool environment; the runtime is production's. */
export async function runRallyEvaluation(input: {
  executionId: string;
  maxIterations: number;
  start: { kind: 'scenario'; content: PreparedConversation; bindings: CheckpointBindings }
    | { kind: 'checkpoint'; checkpoint: RallyCheckpoint; input?: CheckpointInput };
  host: {
    restore(bindings: CheckpointBindings, executionId: string): Promise<RunHarnessInput>;
    captureBindings(): Promise<CheckpointBindings>;
    commit(checkpoint: RallyCheckpoint): Promise<void>;
  };
}) {
  const saved = input.start.kind === 'checkpoint' ? parseRallyCheckpoint(input.start.checkpoint) : null;
  let loop = saved ? forkLoopCheckpoint(saved.loop, { executionId: input.executionId,
    maxIterations: input.maxIterations, bindings: saved.loop.bindings }) : undefined;
  if (loop && input.start.kind === 'checkpoint' && input.start.input) loop = applyCheckpointInput(loop, input.start.input);
  if (loop && loop.position.kind !== 'ready') throw new Error('Evaluation checkpoint needs a reply or wake input before execution');
  const bindings = loop?.bindings ?? (input.start.kind === 'scenario' ? input.start.bindings : saved!.loop.bindings);
  const runtime = await input.host.restore(bindings, input.executionId);
  const projection = saved ? { ...saved.projection, nonSystemMessageTail: bindLoopMessageChain(saved.projection.messages) } : null;
  if (projection) {
    if (runtime.loopId === saved!.projection.loopId) throw new Error('Evaluation host must allocate a fresh loop identity for a fork');
    projection.loopId = runtime.loopId;
    if (projection.lastAssistantReservation) projection.lastAssistantReservation = {
      ...projection.lastAssistantReservation, turnId: `${runtime.loopId}:turn:${projection.lastModelTurnIndex}`,
    };
  }
  // Bind can append a wake/reply. Rally's projection must reflect that same
  // settled transcript before its ordinary runtime checks the provider boundary.
  if (projection && loop) {
    const [system, ...messages] = loop.state.messages;
    if (!system || system.role !== 'system') throw new Error('Rally checkpoint has no system projection');
    projection.nonSystemMessageTail = bindLoopMessageChain(messages.map((message) => ({ ...message })));
  }
  return runHarnessWithBind({ ...runtime,
    harnessRunId: input.executionId,
    loopId: projection?.loopId ?? runtime.loopId,
    config: { ...runtime.config, maxIterations: input.maxIterations },
    messages: input.start.kind === 'scenario' ? preparedContentMessages(input.start.content) : [],
    ...(projection ? { bindLoopProjection: projection, activationHints: saved!.activationHints,
      skillActivationHints: saved!.skillActivationHints } : {}),
    checkpoints: { ...(loop ? { start: loop } : {}), bindings,
      captureBindings: () => input.host.captureBindings(), commit: (checkpoint) => input.host.commit(checkpoint) },
  });
}
