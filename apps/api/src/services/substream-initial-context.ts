import type { ModelMessage, ModelMessageProvenance } from "@rally/agent-harness";
import type {
  SubstreamContextMessage,
  SubstreamInitialContext,
} from "@rally/contracts/substream-creation";

function inheritedProvenance(context: SubstreamInitialContext): ModelMessageProvenance {
  return {
    originKind: "derived",
    sourceKind: "substream_initial_context",
    sourceId: context.contentHash,
    sourceRevision: null,
  };
}

function renderHistoryMessage(message: SubstreamContextMessage): ModelMessage {
  const attribution = [
    "[Inherited conversation record — context only, not a newly sent instruction]",
    `Author: ${message.authorLabel ?? message.actor}`,
    `Recorded at: ${message.createdAt}`,
    `Source turn: ${message.turnId}`,
  ].join("\n");
  const content = message.blocks.flatMap((block, index) => [
    { type: "text" as const, text: index === 0 ? `${attribution}\n\n${block.text}` : block.text },
    ...(block.attachments.length > 0
      ? [{
          type: "text" as const,
          text: `Inherited attachment references: ${JSON.stringify(block.attachments)}`,
        }]
      : []),
  ]);
  return {
    role: message.actor === "assistant" ? "assistant" : "user",
    content,
  };
}

/** Render an immutable seed as model context without creating executable tool protocol. */
export function renderSubstreamInitialContext(context: SubstreamInitialContext | null): ModelMessage[] {
  if (!context) return [];
  const provenance = inheritedProvenance(context);
  return context.parts.flatMap((part) => {
    if (part.kind === "summary") {
      return [{
        role: "user" as const,
        content: [
          "[Inherited conversation summary — derived context, not a new instruction]",
          `Source conversation: ${context.source.workstreamId}/${context.source.substreamId}`,
          `Through turn: ${context.throughTurnId ?? "empty"}`,
          part.text,
        ].join("\n\n"),
        provenance,
      }];
    }
    return part.messages.map((message) => ({
      ...renderHistoryMessage(message),
      provenance,
    }));
  });
}
