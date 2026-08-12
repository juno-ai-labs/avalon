import { ConnectorError } from "@avalon/connectors";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError } from "../src/lib/api-error";
import { classifyConnectorOAuthCallbackFailure } from "../src/lib/connector-oauth-error";

describe("connector OAuth callback failures", () => {
  it("retains only allowlisted connector diagnostics", () => {
    expect(classifyConnectorOAuthCallbackFailure(new ConnectorError(
      "unauthorized",
      "provider message that must not be logged",
      {
        oauthStage: "token_exchange",
        status: 401,
        accessToken: "must-not-appear",
        responseBody: { email: "must-not-appear@example.test" },
      },
    ))).toEqual({
      errorCode: "connector_unauthorized",
      level: "warn",
      diagnostics: {
        error_name: "ConnectorError",
        connector_code: "unauthorized",
        stage: "token_exchange",
        provider_status: 401,
      },
    });
  });

  it("reports the provider's own error code, and refuses anything not shaped like one", () => {
    // A Slack personal connection failed three times recording only
    // `connector_code: "provider_error"` — the layer, not the fault. Slack had
    // said `invalid_code`; the classifier dropped it.
    expect(classifyConnectorOAuthCallbackFailure(
      new ConnectorError("provider_error", "Slack OAuth failed", { error: "invalid_code" }),
    ).diagnostics).toMatchObject({ provider_error: "invalid_code" });
    expect(classifyConnectorOAuthCallbackFailure(
      new ConnectorError("provider_error", "failed", { providerError: "bad_redirect_uri" }),
    ).diagnostics).toMatchObject({ provider_error: "bad_redirect_uri" });

    // Never a credential, an address, or a name: the shape is the whole guard.
    for (const unsafe of [
      "xoxp-10164519659008-11799907517957-secret",
      "adam@juno-labs.com",
      "Something went wrong",
      "a".repeat(80),
      "invalid.code",
    ]) {
      expect(classifyConnectorOAuthCallbackFailure(
        new ConnectorError("provider_error", "failed", { error: unsafe }),
      ).diagnostics).not.toHaveProperty("provider_error");
    }
  });

  it("separates a malformed provider response from a provider refusal", () => {
    // Both arrive as `provider_error` and call for opposite responses: one is
    // Avalon's bug, the other a spent code or a misconfiguration.
    const flattened = z.object({ team: z.object({ id: z.string() }) })
      .safeParse({ ok: true });
    expect(flattened.success).toBe(false);
    if (flattened.success) return;

    expect(classifyConnectorOAuthCallbackFailure(
      new ConnectorError("provider_error", "Slack OAuth failed", flattened.error.flatten()),
    ).diagnostics).toMatchObject({ response_invalid: true });
    expect(classifyConnectorOAuthCallbackFailure(
      new ConnectorError("provider_error", "Slack OAuth failed", { error: "invalid_code" }),
    ).diagnostics).not.toHaveProperty("response_invalid");
  });

  it("classifies schema, API, and unknown failures without their messages", () => {
    const schemaError = z.object({ token: z.string() }).safeParse({ token: 1 });
    expect(schemaError.success).toBe(false);
    if (schemaError.success) return;
    expect(classifyConnectorOAuthCallbackFailure(schemaError.error)).toEqual({
      errorCode: "connector_provider_response_invalid",
      level: "error",
      diagnostics: {
        error_name: "ZodError",
        response_invalid: true,
        validation_issue_count: 1,
      },
    });
    expect(classifyConnectorOAuthCallbackFailure(new ApiError(401, "invalid_oauth_state", "private")))
      .toEqual({
        errorCode: "invalid_oauth_state",
        level: "warn",
        diagnostics: { error_name: "ApiError" },
      });
    expect(classifyConnectorOAuthCallbackFailure(new Error("private"))).toEqual({
      errorCode: "connector_oauth_failed",
      level: "error",
      diagnostics: { error_name: "Error" },
    });
  });
});
