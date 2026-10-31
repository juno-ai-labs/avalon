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
 * Wall clock of one program, in milliseconds. **Provisional**, not open: an
 * unbounded program holds the Durable Object's I/O context and the platform
 * caps concurrent Dynamic Workers per object at ten, so `+Infinity` is not
 * inert here. 120 s covers the observed PostHog case (four to seven SQL calls
 * of 2 to 9 s each) with room; Cloudflare's own default is 30 s; the harness
 * tool cap is 1,050,000 ms. The team confirms or moves this number.
 */
export const CODE_PROGRAM_DEADLINE_MS = 120_000;

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

/** The one-line bound on a model-visible error message copied from a program. */
export const CODE_ERROR_MESSAGE_MAX_CHARS = 500;
