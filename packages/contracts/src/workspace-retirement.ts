import { z } from "zod";

import { IdSchema } from "./identifiers";

/**
 * Retiring a workspace, on the wire: what the regional API answers Ace with.
 * `docs/workspace-retirement.md` owns the walk; this is the shape both ends
 * parse.
 */

/**
 * Every kind of parent a retirement walk closes: the hosted Canvas and
 * Sidekick (`automation`), and the retired Thread (`workstream`) and Space
 * parents whose objects still await the Thread retirement operation. Wider
 * than `ConversationParentKindSchema`, which names only what is hosted, and an
 * independent list rather than an import: this contract crosses to Ace and is
 * parsed on both sides, so widening it is a deliberate decision about what an
 * operator is told, not a transitive one.
 */
export const RetirementParentKindSchema = z.enum(["workstream", "automation", "space", "canvas"]);
export type RetirementParentKind = z.infer<typeof RetirementParentKindSchema>;

/** What retiring a workspace answers with. */
export const WorkspaceRetirementResultSchema = z.strictObject({
  workspaceId: IdSchema,
  complete: z.boolean(),
  remaining: z.number().int().nonnegative(),
  /** Every work stream, automation and Space in the workspace, over all passes. */
  parents: z.number().int().nonnegative(),
  /** Closed by the pass that answered; a resumed pass closes what the last left. */
  retiredParents: z.number().int().nonnegative(),
  retiredChildren: z.number().int().nonnegative(),
  retainedOutbox: z.number().int().nonnegative(),
  failed: z.array(z.strictObject({
    parentKind: RetirementParentKindSchema,
    parentId: z.string().min(1),
    error: z.string().min(1),
  })),
});
export type WorkspaceRetirementResult = z.infer<typeof WorkspaceRetirementResultSchema>;
