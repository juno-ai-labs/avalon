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
