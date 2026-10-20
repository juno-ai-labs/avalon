import { z } from "zod";
import { IdSchema, SubstreamIdSchema } from "./identifiers";
import { HarnessStatusSchema } from "./conversation-attention";
import {
  TranscriptActivitySchema,
  TranscriptPluginRunSchema,
  TranscriptTextBlockSchema,
  TranscriptTurnSchema,
  WorkstreamTranscriptSnapshotSchema,
  type TranscriptRangeResult,
} from "./workstream-transcript";

/** A display projection has no tool payloads, call identities, or reasoning. */
export const ConversationViewTurnSchema = TranscriptTurnSchema.safeExtend({
  blocks: z.array(TranscriptTextBlockSchema.omit({ structuredContent: true }).strict()),
});
export const ConversationViewContentSchema = z.strictObject({
  turn: ConversationViewTurnSchema,
  activities: z.array(TranscriptActivitySchema.extend({
    scope: z.enum(["assistant_turn", "plugin"]),
  })),
  pluginRuns: z.array(TranscriptPluginRunSchema.omit({ toolCallIds: true }).strict()),
});
export const ConversationViewHeaderSchema = z.strictObject({
  title: z.string(),
  titleStatus: z.enum(["naming", "automatic", "settled"]),
  scope: z.enum(["personal", "workspace"]),
  harnessStatus: HarnessStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export const ConversationViewRequestSchema = z.strictObject({
  type: z.literal("conversation_view"),
  requestId: IdSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
});
export const WorkspaceConversationViewEventSchema = z.strictObject({
  type: z.literal("workspace_conversation_view"),
  requestId: IdSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  view: z.strictObject({
    header: ConversationViewHeaderSchema,
    transcript: WorkstreamTranscriptSnapshotSchema,
  }).nullable(),
});
export type ConversationViewContent = z.infer<typeof ConversationViewContentSchema>;
export type ConversationViewHeader = z.infer<typeof ConversationViewHeaderSchema>;
export type WorkspaceConversationViewEvent = z.infer<typeof WorkspaceConversationViewEventSchema>;

/** Explicitly construct the allowlist before crossing the authority boundary. */
export function projectConversationView(range: TranscriptRangeResult): ConversationViewContent | null {
  const turn = range.turns[0];
  if (!turn) return null;
  const blocks = turn.blocks.flatMap((block) => {
    if (block.type !== "text") return [];
    const { structuredContent: _structuredContent, ...visible } = block;
    void _structuredContent;
    return [visible];
  });
  const pluginRuns = range.pluginRuns.filter((run) => run.toolCallIds.length > 0
    || (run.durationMs ?? 0) > 0 || (run.elapsedMsAtSnapshot ?? 0) > 0);
  if (!blocks.length && !pluginRuns.length) return null;
  return ConversationViewContentSchema.parse({
    turn: { ...turn, blocks, blockCount: blocks.length, blocksOmitted: false },
    activities: range.activities.filter((activity) =>
      activity.scope === "assistant_turn" || activity.scope === "plugin"),
    pluginRuns: pluginRuns.map(({ toolCallIds: _toolCallIds, ...run }) => { void _toolCallIds; return run; }),
  });
}
