export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 426 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const API_ERROR_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 413, 422, 426, 429, 500, 502, 503]);

/**
 * The `ApiError` an error is, including one that crossed a Durable Object RPC.
 *
 * A thrown error survives the RPC boundary with its `name`, `message`, and own
 * enumerable fields, but as a plain `Error`: `instanceof ApiError` is false on
 * the Worker side, and a handler that tests only that turns an object's 404 or
 * 409 into a 500. This recognizes the shape and rebuilds the instance, and
 * answers null for anything that is not an `ApiError` by name and fields.
 */
export function asApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (!(error instanceof Error) || error.name !== "ApiError") return null;
  const { status, code, details } = error as Error & { status?: unknown; code?: unknown; details?: unknown };
  if (typeof status !== "number" || !API_ERROR_STATUSES.has(status) || typeof code !== "string") return null;
  return new ApiError(
    status as ApiError["status"],
    code,
    error.message,
    details !== null && typeof details === "object" ? details as Record<string, unknown> : undefined,
  );
}

export function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /constraint|unique|foreign key|SQLITE_CONSTRAINT/i.test(error.message)
  );
}
