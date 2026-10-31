/**
 * The bounds on one `code_execute` program.
 *
 * Every one of these is defensive and, except the deadline, open: the guard is
 * in place and enforcing nothing until the team sets a number, per
 * docs/adding-security-defensive-and-other-limits.md. The handover table is in
 * docs/PRDs/2026-10-31_code-mode-and-sidekick-custom-tools/design.md#limits.
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

/** Time the isolate gets to load before the deadline starts counting. */
export const CODE_PROGRAM_LOAD_ALLOWANCE_MS = 15_000;

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: bytes of the `code` argument of one program.
 * Without it: a program the size of a context window is compiled and run.
 *   Terminal's `run_command` accepts 32 KiB; a program is shorter.
 */
export const CODE_PROGRAM_MAX_BYTES = Number.POSITIVE_INFINITY;

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: tool calls one program may make.
 * Without it: a program loops over a connector until the deadline. The largest
 *   observed run makes 46 calls in total.
 */
export const CODE_CALLS_MAX = Number.POSITIVE_INFINITY;

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: bytes of a program's serialized return value, which is the tool
 *   output the model reads.
 * Without it: a program returns the data instead of the answer and the result
 *   fills the context the tool exists to protect. The hosted MCP string bound
 *   is 80,000 characters.
 */
export const CODE_RESULT_MAX_BYTES = Number.POSITIVE_INFINITY;

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: bytes of captured console output returned with a result.
 * Without it: a chatty program's logs dwarf its value. Same arithmetic as the
 *   result bound.
 */
export const CODE_LOG_MAX_BYTES = Number.POSITIVE_INFINITY;

/** The one-line bound on a model-visible error message copied from a program. */
export const CODE_ERROR_MESSAGE_MAX_CHARS = 500;
