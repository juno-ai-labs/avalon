import { IdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * A member's display preferences for one Organization, held by its WorkspaceDO.
 * One row per person; absent means every default. Delivered in the workspace
 * socket's connect payload so the first frame already honours them.
 */
export const WORKSPACE_MEMBER_PREFERENCES_MIGRATION: readonly string[] = [
  `CREATE TABLE member_preferences (
    user_id TEXT PRIMARY KEY,
    show_agent_work INTEGER NOT NULL CHECK (show_agent_work IN (0, 1)),
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

export const MemberPreferencesReadRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  userId: IdSchema,
});
export type MemberPreferencesReadRequest = z.infer<typeof MemberPreferencesReadRequestSchema>;
