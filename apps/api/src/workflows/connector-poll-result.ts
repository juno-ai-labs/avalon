import { IdSchema } from "@rally/contracts";
import { ConnectorError, connectorDiagnosticCode } from "@rally/connectors";
import { DIAGNOSTIC_CODE_MAX_LENGTH, isCodeShaped } from "@rally/contracts/zod-diagnostics";
import { z } from "zod";

import { diagnosticErrorCode } from "../observability/logger";
import { isReconnectRequiredConnectorError } from "../services/connector-connection-access";

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

/** What the poll step returns, instead of throwing, for a poll refused on its grant. */
export interface RefusedPollResult {
  refusedCode: string;
}

/**
 * The step's answer to a failed attempt: a refusal when the adapter declared
 * the grant dead (`reconnectRequired`), otherwise `null` for a failure the
 * step rethrows and retries. A bare `unauthorized` is not a refusal: a 403 can
 * be a rate limit.
 */
export function refusedPollResult(error: unknown, code: string): RefusedPollResult | null {
  return isReconnectRequiredConnectorError(error) ? { refusedCode: code } : null;
}

/** The reason a refused poll stores on the connection; it was never retried. */
export function refusedPollFailure(code: string): { code: string; message: string } {
  return { code, message: `Connector poll refused: ${code}` };
}

/** Safe, replay-stable reason stored on the connection as well as logged. */
export function terminalPollFailure(error: unknown): { code: string; message: string } {
  const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  const code = timedOut ? "connector_poll_timeout" : failedPollAttemptCode(error) ?? pollAttemptErrorCode(error);
  return { code, message: timedOut ? "Connector poll timed out" : `Connector poll failed after retries: ${code}` };
}

/**
 * `warn` for a grant the provider refused (`unauthorized…`): that is the
 * member's account state, already recorded as `needs_reconnect`, and the poll
 * fires again on schedule. Logged as `error` it repeated every poll interval
 * per connection and buried real platform faults. Every other failure stays
 * `error`.
 */
export function terminalPollFailureLevel(error: unknown): "warn" | "error" {
  const code = failedPollAttemptCode(error) ?? pollAttemptErrorCode(error);
  return code === "unauthorized" || code.startsWith("unauthorized:") ? "warn" : "error";
}
