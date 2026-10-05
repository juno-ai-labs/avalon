import { IdSchema, PersonalSystemPromptSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * A member's personal system prompt for one Organization.
 *
 * WorkspaceDO is the authority: one row per person, since one object is one
 * Organization. Each SubstreamAgent keeps its own copy of the rows its runs
 * have read, and renders the prompt from that copy so inference never waits on
 * a call to WorkspaceDO. The copy refreshes after each run that reads it starts,
 * so an edit reaches a conversation from that conversation's next turn on, and
 * a conversation that has never run a turn for this person starts without it.
 * See docs/personal-system-prompt.md.
 */

/** WorkspaceDO. Absent means none, the same as empty text. */
export const WORKSPACE_PERSONAL_SYSTEM_PROMPT_MIGRATION: readonly string[] = [
  `CREATE TABLE member_personal_system_prompts (
    user_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/** SubstreamAgent. A copy of WorkspaceDO's rows, never written by anyone else. */
export const SUBSTREAM_PERSONAL_SYSTEM_PROMPT_MIGRATION: readonly string[] = [
  `CREATE TABLE personal_system_prompt_copies (
    user_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
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

export const PersonalSystemPromptResultSchema = PersonalSystemPromptSchema;
export type PersonalSystemPromptResult = z.infer<typeof PersonalSystemPromptResultSchema>;
