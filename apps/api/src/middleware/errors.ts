import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { RepositoryError } from "@rally/db";
import { ConnectorError } from "@rally/connectors";
import type { HonoAppEnv } from "../env";
import { asApiError } from "../lib/api-error";
import { logEvent } from "../observability/logger";
import { RequestValidationError } from "./validation";

export const notFoundHandler: NotFoundHandler<HonoAppEnv> = (c) =>
  c.json(
    {
      error: {
        code: "not_found",
        message: "The requested API route does not exist",
        requestId: c.get("requestId") ?? null,
      },
    },
    404,
  );

export const errorHandler: ErrorHandler<HonoAppEnv> = (error, c) => {
  let status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 426 | 429 | 500 | 502 | 503 = 500;
  let code = "internal_error";
  let message = "An unexpected error occurred";
  let details: Record<string, unknown> | undefined;
  let malformedJson = false;

  const apiError = asApiError(error);
  if (apiError) {
    ({ status, code, message, details } = apiError);
  } else if (error instanceof HTTPException && error.status === 400) {
    // Hono raises this before Zod runs when a JSON body cannot be parsed. Keep
    // parser details behind the same public boundary as schema failures.
    status = 400;
    code = "invalid_request";
    message = "The request is invalid";
    malformedJson = true;
  } else if (error instanceof RepositoryError) {
    status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 500;
    code = error.code;
    message = error.message;
  } else if (error instanceof ConnectorError) {
    status = error.code === "invalid_configuration" ? 503
      : error.code === "unauthorized" || error.code === "invalid_signature" ? 401
      : error.code === "invalid_payload" ? 400
      : error.code === "payload_too_large" ? 413
      : error.code === "provider_error" ? 502
      : 422;
    code = error.code;
    message = error.message;
  }

  logEvent(c, status >= 500 ? "error" : "warn", "request_failed", {
    code,
    status,
    error_name: error.name,
    detail_keys: details ? Object.keys(details).slice(0, 25) : [],
    // A raw ZodError reaching here is a response that failed its own contract.
    // Without the issue paths the log says only "internal_error", which names
    // neither the field nor the route; the paths and codes are schema shape, not
    // member data, so they are safe to record where the values would not be.
    ...(error instanceof RequestValidationError
      ? {
        path: c.req.path,
        route: c.req.routePath,
        method: c.req.method,
        validation_target: error.validationTarget,
        validation_issues: error.validationIssues,
        ...(error.requestBody === undefined ? {} : { request_body: error.requestBody }),
      }
      : malformedJson
        ? {
          path: c.req.path,
          route: c.req.routePath,
          method: c.req.method,
          validation_target: "json",
          validation_issues: [{ path: "(root)", code: "invalid_json" }],
        }
        : error instanceof z.ZodError
      ? {
        path: c.req.path,
        // The template, not the resolved path: `/workstreams/:id` is what makes
        // 131 failures on one work stream aggregate into one line rather than
        // one per id.
        route: c.req.routePath,
        method: c.req.method,
        validation_issues: error.issues.slice(0, 25).map((issue) => ({
          path: issue.path.map(String).join(".") || "(root)",
          code: issue.code,
        })),
      }
      : {}),
  });

  return c.json(
    {
      error: {
        code,
        message,
        requestId: c.get("requestId") ?? null,
        ...(details ? { details } : {}),
      },
    },
    status,
  );
};
