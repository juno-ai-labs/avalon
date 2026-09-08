import { z } from "zod";

import { IdSchema } from "./identifiers";

/**
 * Retiring a workspace, on the wire: what the regional API answers Ace with.
 * `docs/workspace-retirement.md` owns the walk; this is the shape both ends
 * parse.
 */

/** What retiring a workspace answers with. */
export const WorkspaceRetirementResultSchema = z.strictObject({
  workspaceId: IdSchema,
  complete: z.boolean(),
  remaining: z.number().int().nonnegative(),
  retiredParents: z.number().int().nonnegative(),
  retiredChildren: z.number().int().nonnegative(),
  retainedOutbox: z.number().int().nonnegative(),
  failed: z.array(z.strictObject({
    parentKind: z.enum(["workstream", "automation"]),
    parentId: z.string().min(1),
    error: z.string().min(1),
  })),
});
export type WorkspaceRetirementResult = z.infer<typeof WorkspaceRetirementResultSchema>;
