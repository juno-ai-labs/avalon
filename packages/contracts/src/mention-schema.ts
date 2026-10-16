import { z } from "zod";

import { IdSchema } from "./identifiers";
import { HttpUrlSchema } from "./url-schemas";

/**
 * One mention in a message: a person or a connector, at its offsets in the
 * text. Its own module so a contract that carries mentions, such as a
 * merge request, imports it without importing the package index.
 */
export const MentionSchema = z.object({
  type: z.enum(["person", "connector"]),
  userId: IdSchema.nullable(),
  connectorType: z.string().max(80).nullable(),
  displayName: z.string().min(1).max(180).nullable().optional(),
  avatarUrl: HttpUrlSchema.nullable().optional(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive()
});
