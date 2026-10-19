/**
 * The object rejected the request itself — a bad protocol or a misrouted stub.
 *
 * Distinct from a refused write, which is an ordinary outcome and is returned
 * in the operation's own result rather than thrown. Anything reaching here is a
 * defect in the caller or the routing, or an object that cannot serve yet, not
 * a state an ordinary work stream is in.
 *
 * One class for all four ports. There were four, one per port, and no caller
 * ever caught any of them by type — they existed only to be thrown. The `code`
 * still says which authority refused and why.
 *
 * Its own module so `diagnosticErrorCode` can read `code` without importing the
 * port, whose stub resolution imports the logger.
 */
export class ObjectPortError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ObjectPortError";
  }
}

/**
 * What a conversation object answers every port operation with while it is
 * not authoritative: `preparing` before its initialization or import commits,
 * or `quarantined`. The object writes it and a caller that has to tell this
 * refusal from the others reads it, so both name it here.
 */
export const AUTHORITY_FENCED_CODE = "workstream_runtime_authority_fenced";
