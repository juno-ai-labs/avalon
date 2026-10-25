import { agentMessageNotice, annotationCommentText, ElicitationSchema, isAgentMessageContent, messageAnnotations } from "@rally/contracts";
import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import { elicitationAnswerLabel, visibleParticipantText } from "@rally/contracts/text";
import type { TranscriptTurn } from "@rally/contracts";

/** Room-visible prose only, using the same hidden-prefix and mailbox rules as the feed. */
export function conversationAsText(turns: readonly TranscriptTurn[]): string {
  return turns.map((turn) => {
    const parts = turn.blocks.slice().sort((a, b) => a.blockIndex - b.blockIndex).flatMap((block) => {
      if (block.type !== "text" || block.messageType === "suggestion") return [];
      if (isAgentMessageContent(block.structuredContent)
        && (turn.transcriptSequence !== 1 || agentMessageNotice(block.structuredContent) !== null)) return [];
      const structured = block.structuredContent;
      const elicitation = block.messageType === "elicitation"
        ? ElicitationSchema.safeParse(structured && "elicitation" in structured ? structured.elicitation : structured) : null;
      const prose = elicitation?.success ? [elicitation.data.prompt,
        ...elicitation.data.options.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`),
        // An answered question with no answer was skipped; without the line, a
        // skip read as the person posting the question back.
        ...(elicitation.data.status === "answered" || elicitation.data.answer !== null
          ? [`Answer: ${elicitationAnswerLabel(elicitation.data)}`] : []),
      ].join("\n") : visibleParticipantText(block.text, turn.actor);
      const body = rewriteMessageAsPlainText(annotationCommentText(prose, messageAnnotations(structured)));
      const attachments = (block.attachments ?? []).map((attachment) => `Attachment: ${attachment.fileName}`);
      return [body, ...attachments].filter((text) => text.trim().length > 0);
    });
    if (parts.length === 0) return "";
    const author = turn.actor === "human" ? turn.authorSnapshot!.displayName
      : turn.actor === "external" ? turn.externalActor?.displayName ?? "External participant"
      : turn.actor === "assistant" ? "Rally" : "System";
    return `${author} · ${turn.createdAtUtc}\n${parts.join("\n\n")}`;
  }).filter(Boolean).join("\n\n");
}
