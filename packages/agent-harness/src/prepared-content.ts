import { PreparedConversationSchema, type PreparedConversation } from "@rally/contracts";
import { createLoopCheckpoint, type CheckpointBindings } from "@juno-ai/bind/session";

/** Project resolved fixture history; the eval host owns the referenced resources. */
export function preparedContentMessages(content: PreparedConversation) {
  return PreparedConversationSchema.parse(content).messages.map(({ role, text, attachmentIds }) => ({ role,
    content: [text, ...(attachmentIds?.length ? [`Attached resources: ${JSON.stringify(attachmentIds)}`] : [])].filter(Boolean).join("\n\n"),
  }));
}

/** The host supplies environment identity and budget; Bind owns checkpoint semantics. */
export function checkpointFromContent(input: {
  content: PreparedConversation;
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
