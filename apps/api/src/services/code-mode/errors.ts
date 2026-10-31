/**
 * A typed `code_execute` failure: a stable code, a model-visible sentence with
 * the shortest safe next action, and only allowlisted details. Read by the
 * harness through `readStructuredFailure`, which forwards `code` and the
 * allowlisted keys of `details` and nothing else.
 */
export class CodeModeToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CodeModeToolError";
  }
}
