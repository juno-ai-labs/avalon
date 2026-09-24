import { z } from 'zod';

/**
 * What the main window hands the import window when it opens it: the Spaces a
 * new Channel may be placed in. The import window reads it rather than
 * waiting on a directory socket of its own.
 */
export const BrowserImportContextSchema = z.strictObject({
  spaces: z.array(z.strictObject({ id: z.string().min(1), name: z.string() })),
  /** Opened from one Space's channel list: import there and offer no other. */
  spaceLocked: z.boolean().optional(),
});
export type BrowserImportContext = z.infer<typeof BrowserImportContextSchema>;

/** Checked before it becomes part of a deep link; the deep-link parser checks the rest. */
export const BrowserImportedWorkstreamIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/u);
