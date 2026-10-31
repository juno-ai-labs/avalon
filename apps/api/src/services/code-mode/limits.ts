/**
 * The bounds on one `code_execute` program.
 *
 * Two numbers are set and one guard is open. Every other bound a review asked
 * for (program bytes, calls per program, log bytes) was removed rather than
 * written open: the loader compiles what it is given, the deadline ends a
 * program that loops, and the result bound covers the logs. A limit that
 * enforces nothing and guards nothing the deadline does not is a decision
 * nobody made, per docs/adding-security-defensive-and-other-limits.md. The
 * handover table is in docs/code-mode.md#failure-modes-and-limits.
 */

/**
 * The one runtime bound on a program: its maximum runtime, in milliseconds.
 * Loops are allowed, as many calls as the program wants are allowed; what
 * ends a program is this clock. **Provisional**, not open: an unbounded
 * program holds the Durable Object's I/O context and the platform caps
 * concurrent Dynamic Workers per object at ten, so `+Infinity` is not inert
 * here. 120 s covers the observed PostHog case (four to seven SQL calls of 2
 * to 9 s each) with room; Cloudflare's own default is 30 s; the harness tool
 * cap is 1,050,000 ms. The team confirms or moves this number.
 *
 * Enforced twice, because one clock cannot stop both kinds of program: the
 * entry module's timer ends a program that is waiting (on a call, on a
 * promise that never settles), and the runtime's CPU limit below ends one
 * that is busy (a loop that never yields), where no timer can fire. Both
 * report as `code_program_timed_out`.
 */
export const CODE_PROGRAM_DEADLINE_MS = 120_000;

/**
 * The force kill: CPU time one program may use before the runtime throws
 * inside the isolate and ends it, in milliseconds. Set to the deadline, since
 * CPU time cannot exceed wall time, so a program that is still running at the
 * deadline is stopped whether it is busy or waiting. Not a separate decision.
 */
export const CODE_PROGRAM_CPU_MS = CODE_PROGRAM_DEADLINE_MS;

/**
 * Time the isolate gets to load before the host-side race gives up on it, on
 * top of the deadline. **Provisional**: a cold Dynamic Worker loads in well
 * under a second; the allowance exists so a stuck isolate cannot hold the
 * program's tool timer open past the deadline. The team confirms or moves it.
 */
export const CODE_PROGRAM_LOAD_ALLOWANCE_MS = 15_000;

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: bytes of a program's serialized return value plus its captured
 *   console output, which together are the tool output the model reads.
 * Without it: a program returns the data instead of the answer and the result
 *   fills the context the tool exists to protect. The hosted MCP string bound
 *   is 80,000 characters.
 */
export const CODE_RESULT_MAX_BYTES = Number.POSITIVE_INFINITY;

/**
 * Bind's timer for the tools that run a program: `code_execute`, a saved
 * `custom_<name>` and the wizard's `sidekick_tool_test`. The deadline plus
 * the load allowance at both ends, so Bind's clock never fires before the
 * program's own. One constant so the three tools cannot disagree: a test
 * that timed out at Bind's 30 s default would refuse a tool that a run could
 * execute.
 */
export const CODE_PROGRAM_TOOL_TIMEOUT_MS = CODE_PROGRAM_DEADLINE_MS + 2 * CODE_PROGRAM_LOAD_ALLOWANCE_MS;

/** The one-line bound on a model-visible error message copied from a program. */
export const CODE_ERROR_MESSAGE_MAX_CHARS = 500;
