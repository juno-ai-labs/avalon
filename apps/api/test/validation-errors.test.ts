import "../../../tests/isolated-region";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

function testEnv(region: string): Env {
  return createTestEnv({
    ALLOWED_ORIGINS: "app://avalon",
    AVALON_REGION: region,
    LOG_LEVEL: "error",
  });
}

function authenticatedTestEnv(): Env {
  const statement = {
    bind: () => statement,
    first: async () => ({ role: "owner" }),
  };
  return createTestEnv({
    ...testEnv("global"),
    APP_ENV: "development",
    RALLY_DEV_AUTH: "true",
    DB: createTestD1Database({
      prepare: () => statement,
    }),
  });
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public validation errors", () => {
  it("logs rejected request fields and issue codes without logging their values", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requestId = "validation-diagnostic";
    const invalidParticipantId = "member-supplied-participant-value";
    const env = { ...authenticatedTestEnv(), LOG_LEVEL: "info" } satisfies Env;

    const response = await createApp().request(
      "https://api.example.com/workspace/pinned-order",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          "x-rally-dev-user-id": "00000000-0000-7000-8000-0000000000e1",
          "x-rally-dev-workspace-id": "00000000-0000-7000-8000-0000000000e2",
        },
        body: JSON.stringify({
          kind: "canvas",
          itemIds: [invalidParticipantId],
          diagnosticShape: {
            label: "member-supplied-label",
            count: 47,
            enabled: true,
            missing: null,
            tokenLikeValue: "member-supplied-token-value",
            nested: [{ value: "member-supplied-nested-value" }],
          },
        }),
      },
      env,
    );

    await expectSafeInvalidRequest(response, requestId);
    const entry = logged.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .find((value) => value.event === "request_failed");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      event: "request_failed",
      status: 400,
      code: "invalid_request",
      method: "PUT",
      path: "/workspace/pinned-order",
      route: "/workspace/pinned-order",
      validation_target: "json",
      validation_issues: expect.arrayContaining([
        expect.objectContaining({ path: "itemIds.0" }),
      ]),
      request_body: {
        kind: "***",
        itemIds: ["***"],
        diagnosticShape: {
          label: "***",
          count: -1,
          enabled: "***",
          missing: "***",
          tokenLikeValue: "***",
          nested: [{ value: "***" }],
        },
      },
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(invalidParticipantId);
    expect(serialized).not.toContain("member-supplied-label");
    expect(serialized).not.toContain("member-supplied-nested-value");
    expect(serialized).not.toContain("member-supplied-token-value");
    expect(JSON.stringify(entry?.request_body)).not.toContain("47");
  });

  it.each(["global", "enterprise"] as const)(
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

  it("rejects personal X connections at the public API boundary", async () => {
    const requestId = "validation-personal-x";
    const response = await createApp().request(
      "https://api.example.com/connections/x",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          "x-rally-dev-user-id": "00000000-0000-7000-8000-0000000000e1",
          "x-rally-dev-workspace-id": "00000000-0000-7000-8000-0000000000e2",
        },
        body: JSON.stringify({ scope: "personal", capabilities: ["x.read"] }),
      },
      authenticatedTestEnv(),
    );

    await expectSafeInvalidRequest(response, requestId);
  });
});
