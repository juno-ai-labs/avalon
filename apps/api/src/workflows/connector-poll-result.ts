import { IdSchema } from "@rally/contracts";
import { ConnectorError, connectorDiagnosticCode } from "@rally/connectors";
import { DIAGNOSTIC_CODE_MAX_LENGTH, isCodeShaped } from "@rally/contracts/zod-diagnostics";
import { z } from "zod";

import { diagnosticErrorCode } from "../observability/logger";

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

/**
 * A poll attempt's failure named by what it was: an adapter's code with the
 * provider's status, a schema rejection's paths, or a D1 failure. The step
 * boundary hands the workflow a plain `Error` for all of them, so the terminal
 * log said `connector_poll_failed` and `Error` and nothing else.
 */
export function pollAttemptErrorCode(error: unknown): string {
  return error instanceof ConnectorError
    ? connectorDiagnosticCode(error)
    : diagnosticErrorCode(error, "connector_poll_failed");
}

const POLL_ATTEMPT_FAILURE = "connector_poll_attempt_failed:";

/**
 * The error an attempt rethrows, carrying its code in the one field the step
 * boundary keeps. The workflow's terminal catch may run in a later invocation
 * that replays the failed step from its checkpoint without running the
 * callback, so the code has to travel with the error rather than beside it.
 * A timeout or abort is rethrown as itself: the terminal catch tells a timeout
 * apart by its type.
 */
export function pollAttemptFailure(error: unknown, code: string): unknown {
  if (error instanceof DOMException) return error;
  return new Error(`${POLL_ATTEMPT_FAILURE}${code}`);
}

/** The code `pollAttemptFailure` put on an error, after it crossed the step boundary. */
export function failedPollAttemptCode(error: unknown): string | null {
  if (!(error instanceof Error) || !error.message.startsWith(POLL_ATTEMPT_FAILURE)) return null;
  const code = error.message.slice(POLL_ATTEMPT_FAILURE.length);
  return isCodeShaped(code) ? code : null;
}

/** Safe, replay-stable reason stored on the connection as well as logged. */
export function terminalPollFailure(error: unknown): { code: string; message: string } {
  const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  const code = timedOut ? "connector_poll_timeout" : failedPollAttemptCode(error) ?? pollAttemptErrorCode(error);
  return { code, message: timedOut ? "Connector poll timed out" : `Connector poll failed after retries: ${code}` };
}
