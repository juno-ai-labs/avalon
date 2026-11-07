import { IdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

/** A member's personal system prompt per Organization. See docs/personal-system-prompt.md. */

/** WorkspaceDO, the authority. Absent means none, the same as empty text. */
export const WORKSPACE_PERSONAL_SYSTEM_PROMPT_MIGRATION: readonly string[] = [
  `CREATE TABLE member_personal_system_prompts (
    user_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/** AgentLoopDO: a copy of WorkspaceDO's rows, written only by the refresh. */
export const SUBSTREAM_PERSONAL_SYSTEM_PROMPT_MIGRATION: readonly string[] = [
  `CREATE TABLE personal_system_prompt_copies (
    user_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
    copied_at INTEGER NOT NULL
  ) STRICT`,
];

export const PersonalSystemPromptReadRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  userId: IdSchema,
});
export type PersonalSystemPromptReadRequest = z.infer<typeof PersonalSystemPromptReadRequestSchema>;

export const PersonalSystemPromptWriteRequestSchema = PersonalSystemPromptReadRequestSchema.extend({
  personalSystemPrompt: z.string(),
});
export type PersonalSystemPromptWriteRequest = z.infer<typeof PersonalSystemPromptWriteRequestSchema>;

/** `revision` is 0 for a member who never saved one; it orders refreshes of a copy. */
export const PersonalSystemPromptRecordSchema = z.strictObject({
  personalSystemPrompt: z.string(),
  revision: z.number().int().nonnegative(),
});
export type PersonalSystemPromptRecord = z.infer<typeof PersonalSystemPromptRecordSchema>;

/**
 * The run reasons that are a member's own act: a message, an answer, or a
 * retry, in Rally or from a linked Slack account. Only these carry the
 * member's personal system prompt, and only these read the member's own
 * memory digest (`services/memory-digest-service.ts`). Every other reason runs
 * as a user without that user acting, so the list allows rather than denies.
 */
export const PERSONAL_SYSTEM_PROMPT_REASONS: ReadonlySet<string> = new Set([
  "opening_message",
  "human_message",
  "elicitation_answer",
  "manual_retry",
  // The member's own message, resumed after they authorized a resource for it.
  "resource_authorization",
  "slack_workspace_opening_message",
  "slack_workspace_message",
  "slack_workspace_elicitation_answer",
]);
