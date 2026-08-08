import { ConnectorError } from "@avalon/connectors";
import { z } from "zod";
import { ApiError } from "./api-error";

export interface ConnectorOAuthCallbackFailure {
  errorCode: string;
  level: "warn" | "error";
  diagnostics: Record<string, unknown>;
}

/**
 * Convert callback failures into durable, user-safe error codes and a narrowly
 * allowlisted set of diagnostics. Provider messages and response bodies are
 * intentionally excluded because they can contain account data or OAuth
 * credentials.
 */
export function classifyConnectorOAuthCallbackFailure(
  error: unknown,
): ConnectorOAuthCallbackFailure {
  const errorName = error instanceof Error ? error.name : typeof error;
  if (error instanceof ApiError) {
    return {
      errorCode: error.code,
      level: error.status >= 500 ? "error" : "warn",
      diagnostics: { error_name: errorName },
    };
  }
  if (error instanceof ConnectorError) {
    const details = recordValue(error.details);
    const stage = safeStage(details?.oauthStage);
    const providerStatus = safeProviderStatus(details?.status);
    return {
      errorCode: `connector_${error.code}`,
      level: error.code === "unauthorized" ? "warn" : "error",
      diagnostics: {
        error_name: errorName,
        connector_code: error.code,
        ...(stage ? { stage } : {}),
        ...(providerStatus ? { provider_status: providerStatus } : {}),
        ...(details?.timedOut === true ? { timed_out: true } : {}),
        ...(details?.responseInvalid === true ? { response_invalid: true } : {}),
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      errorCode: "connector_provider_response_invalid",
      level: "error",
      diagnostics: {
        error_name: errorName,
        response_invalid: true,
        validation_issue_count: error.issues.length,
      },
    };
  }
  return {
    errorCode: "connector_oauth_failed",
    level: "error",
    diagnostics: { error_name: errorName },
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeStage(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,49}$/u.test(value)
    ? value
    : null;
}

function safeProviderStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}
