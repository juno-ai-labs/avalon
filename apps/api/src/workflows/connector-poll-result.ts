import { IdSchema } from "@rally/contracts";
import { DIAGNOSTIC_CODE_MAX_LENGTH } from "@rally/contracts/zod-diagnostics";
import { z } from "zod";

/**
 * What a connector poll step hands back to the workflow, as the step result
 * contract the workflow parses before it commits the cursor.
 *
 * In its own module because the workflow class extends `WorkflowEntrypoint`
 * from `cloudflare:workers`, which the Node suite's stand-in does not carry;
 * the contract is pure and its bounds are worth a Node test.
 */
export const PollResultSchema = z.object({
  activityIds: z.array(IdSchema).max(5_000),
  cursor: z.record(z.string(), z.unknown()),
  baseCursorJson: z.string().min(2).max(1_000_000),
  cursorOwner: z.enum(["connection", "watch"]),
  nextPollAt: z.string().datetime({ offset: true }).nullable().optional(),
  streamErrors: z.array(z.object({
    streamId: z.string().min(1).max(200),
    // A stream's code is now a diagnostic code as often as a connector's own,
    // and the primitive bounds those at 120. A cap of 100 here refused the
    // whole poll result for one long path, which the step then retried and
    // finally recorded as the connection failing — for a degradation of one
    // stream the result had already described.
    code: z.string().min(1).max(DIAGNOSTIC_CODE_MAX_LENGTH),
    message: z.string().min(1).max(500),
  })).max(100).optional(),
});
