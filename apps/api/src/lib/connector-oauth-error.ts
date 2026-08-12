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
 *
 * The provider's own *error code* is the one exception, and it is the reason
 * this exists: a Slack personal connection failed three times with nothing
 * recorded but `connector_code: "provider_error"`, which names the layer that
 * failed and not the fault. Slack had said exactly what was wrong — its OAuth
 * vocabulary is a short fixed set like `invalid_code` or `bad_redirect_uri` —
 * and the classifier discarded it, leaving an operator to guess at a string the
 * system had already been told. `safeProviderError` admits only a short
 * identifier-shaped token, which no Slack token (`xoxp-…`, far longer), address
 * (an `@`), or name (spaces, capitals) can satisfy.
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
    const providerError = safeProviderError(details?.providerError) ?? safeProviderError(details?.error);
    // A schema mismatch and a provider refusal are both `provider_error`, and
    // they call for opposite responses — one is Avalon's bug, the other is a
    // configuration or a spent code. The Zod flatten an adapter attaches is the
    // only thing that distinguishes them, so its *shape* is reported even
    // though its contents are not.
    const responseInvalid = details?.responseInvalid === true
      || (details !== null && ("fieldErrors" in details || "formErrors" in details));
    return {
      errorCode: `connector_${error.code}`,
      level: error.code === "unauthorized" ? "warn" : "error",
      diagnostics: {
        error_name: errorName,
        connector_code: error.code,
        ...(stage ? { stage } : {}),
        ...(providerError ? { provider_error: providerError } : {}),
        ...(providerStatus ? { provider_status: providerStatus } : {}),
        ...(details?.timedOut === true ? { timed_out: true } : {}),
        ...(responseInvalid ? { response_invalid: true } : {}),
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

/**
 * A provider's error code, admitted only in the shape every OAuth vocabulary
 * uses: a short lowercase `snake_case` identifier. `invalid_code`,
 * `bad_redirect_uri`, `invalid_grant`, `unsupported_grant_type` — the whole
 * space is underscores.
 *
 * Hyphens and dots are deliberately *not* allowed, and the exclusion is
 * load-bearing rather than tidy: a Slack user token is
 * `xoxp-10164519659008-11799907517957-…`, which is lowercase, alphanumeric,
 * and short enough to pass a laxer pattern. The first draft of this admitted
 * one, and its test caught it. Widening this character class means re-deriving
 * that no credential fits — no provider needs it for an error code.
 */
function safeProviderError(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/u.test(value)
    ? value
    : null;
}
