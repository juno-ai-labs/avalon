import type {
  TerminalOperation,
  TerminalOperationFailure,
} from "../../durable-objects/workstream-terminal-protocol";

/**
 * A typed failure from the object-local Terminal authority with explicit retry safety.
 *
 * Its own module, as `ObjectPortError` is, so `diagnosticErrorCode` can read
 * `code` without importing the port, whose stub resolution imports the logger.
 */
export class TerminalObjectPortError extends Error {
  readonly code: TerminalOperationFailure["code"];
  readonly details: {
    operation: TerminalOperation;
    outcome: TerminalOperationFailure["outcome"];
    retryable: TerminalOperationFailure["retryable"];
  };

  constructor(operation: TerminalOperation, failure: TerminalOperationFailure) {
    super(failure.message);
    this.name = "TerminalObjectPortError";
    this.code = failure.code;
    this.details = {
      operation,
      outcome: failure.outcome,
      retryable: failure.retryable,
    };
  }
}
