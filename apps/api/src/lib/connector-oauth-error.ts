import { ConnectorError } from "@rally/connectors";
import { describeZodIssues, isCodeShaped, codeShaped } from "@rally/contracts/zod-diagnostics";
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
    // Which field the response was missing. An adapter's stage helper
    // attaches the failing paths and issue codes — schema shape, and the
    // whole diagnosis of a provider that answered with a body this binary
    // does not model — and nothing else reaches this key; the shape test
    // bounds what would if one did.
    const responseIssues = safeResponseIssues(details?.responseIssues);
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
        ...(responseIssues ? { response_issues: responseIssues } : {}),
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
        response_issues: codeShaped(describeZodIssues(error)),
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

function safeResponseIssues(value: unknown): string | null {
  return typeof value === "string" && isCodeShaped(value) ? value : null;
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
 * **Two guards, and the first is the real one.** What makes this safe is the
 * *source*: the callers read `details.providerError` and `details.error`, which
 * are the provider's error-code field by construction — Slack's is
 * `apiError.data.error` off an `{ok: false}` envelope, and `providerJsonResponse`
 * extracts the OAuth `error`/`code` key. A credential or an address is never
 * what lives there.
 *
 * The shape test is the second guard, and it bounds the blast radius if a
 * provider ever puts something else in that field. It is deliberately not a
 * semantic proof and should not be read as one — `secret` is a valid-looking
 * identifier — but it is much tighter than "an identifier": **every
 * underscore-separated segment must be alphabetic**, which is true of every
 * OAuth vocabulary (`invalid_grant`, `bad_redirect_uri`,
 * `unsupported_grant_type`, `account_inactive`) and false of every credential
 * shape, because secrets carry entropy and entropy carries digits.
 *
 * Two earlier drafts were looser and each admitted a real credential. `[a-z0-9_-]`
 * took a Slack user token (`xoxp-10164519659008-11799907517957-…`); dropping the
 * hyphen still took a 32-character lowercase-hex client secret. Both were caught
 * by this module's own test rather than in production, which is the argument for
 * keeping that test adversarial: add the credential formats, not more
 * obviously-wrong strings. An error code carrying a digit is dropped rather than
 * relayed — the failure still reports `connector_code`, so the cost is one
 * diagnostic, and that is the right direction to fail.
 *
 * Widening either guard — this character class, or the set of fields the
 * callers read from — means re-deriving that property. A provider-specific
 * allowlist was considered and rejected: an unrecognised code is precisely what
 * an operator needs during the kind of incident this exists for, and an
 * allowlist would suppress exactly that case while adding a list to forget to
 * update.
 */
function safeProviderError(value: unknown): string | null {
  return typeof value === "string" && /^[a-z]{1,20}(?:_[a-z]{1,20}){0,4}$/u.test(value)
    ? value
    : null;
}
