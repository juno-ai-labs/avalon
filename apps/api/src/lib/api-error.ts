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

export function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /constraint|unique|foreign key|SQLITE_CONSTRAINT/i.test(error.message)
  );
}
