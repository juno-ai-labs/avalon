import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";

function testEnv(region: "global" | "eu"): Env {
  return {
    ALLOWED_ORIGINS: "app://avalon",
    AVALON_REGION: region,
    LOG_LEVEL: "error",
  } as Env;
}

async function expectSafeInvalidRequest(response: Response, requestId: string): Promise<void> {
  expect(response.status).toBe(400);
  expect(response.headers.get("x-request-id")).toBe(requestId);

  const payload = await response.json();
  expect(payload).toEqual({
    error: {
      code: "invalid_request",
      message: "The request is invalid",
      requestId,
    },
  });

  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(/ZodError|invalid_format|pattern|regex|desktopAttemptId|token/iu);
}

describe("public validation errors", () => {
  it.each(["global", "eu"] as const)(
    "uses the standard error envelope without schema details in the %s region",
    async (region) => {
      const requestId = `validation-${region}`;
      const response = await createApp().request(
        "https://api.example.com/auth/google/start",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          body: JSON.stringify({
            desktopAttemptId: "does-not-match-the-internal-schema",
            desktopCodeChallenge: "also-invalid",
          }),
        },
        testEnv(region),
      );

      await expectSafeInvalidRequest(response, requestId);
    },
  );

  it("normalizes query validation failures", async () => {
    const requestId = "validation-query";
    const response = await createApp().request(
      "https://api.example.com/auth/invitations/preview?token=short",
      { headers: { "x-request-id": requestId } },
      testEnv("global"),
    );

    await expectSafeInvalidRequest(response, requestId);
  });

  it("normalizes malformed JSON raised before schema validation", async () => {
    const requestId = "validation-malformed-json";
    const response = await createApp().request(
      "https://api.example.com/auth/google/start",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: "{",
      },
      testEnv("global"),
    );

    await expectSafeInvalidRequest(response, requestId);
  });
});
