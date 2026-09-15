import { SubstreamContentSchema, type SubstreamContent } from "@rally/contracts";
import { createLoopCheckpoint, type CheckpointBindings } from "@juno-ai/bind/session";

/** One text projection for imported history, scripted demos and eval fixtures. */
export function preparedContentMessages(content: SubstreamContent) {
  return SubstreamContentSchema.parse(content).messages.map(({ role, text }) => ({ role, content: text }));
}

/** The host supplies environment identity and budget; Bind owns checkpoint semantics. */
export function checkpointFromContent(input: {
  content: SubstreamContent;
  executionId: string;
  maxIterations: number;
  bindings: CheckpointBindings;
}) {
  return createLoopCheckpoint({
    executionId: input.executionId,
    messages: preparedContentMessages(input.content),
    maxIterations: input.maxIterations,
    bindings: input.bindings,
  });
}

export {
  createLoopCheckpoint, parseLoopCheckpoint, serializeLoopCheckpoint,
  forkLoopCheckpoint, applyCheckpointInput, runFromCheckpoint,
  type LoopCheckpoint, type CheckpointBindings,
} from "@juno-ai/bind/session";
