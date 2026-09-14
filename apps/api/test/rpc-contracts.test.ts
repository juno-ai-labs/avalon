import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";

import type { ApiError } from "../src/lib/api-error";
import {
  AutomationEmailRouteInputSchema,
  GitHubRouteStatusInputSchema,
  RPC_BATCH_LIMIT,
  RegionalWebhookInputSchema,
  ResendRegionalEmailInputSchema,
  SlackRouteInputSchema,
  parseRpcInput,
  rpcBatch,
} from "../src/lib/rpc-contracts";

const workspaceId = "019fc068-22e8-739a-8394-a760fdc7c376";
const connectionId = "019fc068-22e8-739a-8394-a760fdc7c377";

function refusal(schema: Parameters<typeof parseRpcInput>[0], input: unknown): ApiError {
  try {
    parseRpcInput(schema, input, "probe");
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the RPC input to be refused");
}

describe("internal RPC contracts", () => {
  it("accepts a well-formed route registration", () => {
    expect(parseRpcInput(SlackRouteInputSchema, {
      teamId: "T0123456", region: "enterprise", workspaceId, connectionId,
    }, "registerSlackRoute")).toEqual({
      teamId: "T0123456", region: "enterprise", workspaceId, connectionId,
    });
  });

  it("refuses a malformed region identifier", () => {
    // The value that decides which side of the Global/enterprise boundary a record
    // lands on. A TypeScript type never checked it at the hop.
    const error = refusal(SlackRouteInputSchema, {
      teamId: "T0123456", region: "not a region", workspaceId, connectionId,
    });
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_rpc_input");
    expect(error.details).toMatchObject({
      method: "probe",
      issues: [{ path: "region", code: "invalid_format" }],
    });
  });

  it("refuses a workspace id that is not an id", () => {
    expect(refusal(GitHubRouteStatusInputSchema, {
      installationId: "12345", region: "global", workspaceId: "'; DROP TABLE", status: "active",
    }).details).toMatchObject({ issues: [{ path: "workspaceId" }] });
  });

  it("refuses an unknown lifecycle status", () => {
    expect(refusal(GitHubRouteStatusInputSchema, {
      installationId: "12345", region: "global", workspaceId, status: "enabled",
    }).details).toMatchObject({ issues: [{ path: "status" }] });
  });

  it("carries field paths but never values into the error", () => {
    const error = refusal(ResendRegionalEmailInputSchema, {
      resendEmailId: "", svixId: "msg_secret_value", receivedAt: "yesterday",
      region: "global", workspaceId, localPart: "", emailAddress: "not-an-email",
    });
    const serialized = JSON.stringify(error.details);
    expect(serialized).toContain("resendEmailId");
    expect(serialized).toContain("emailAddress");
    // OAuth state, provider identifiers and addresses travel over this surface;
    // the refusal names fields so it can be diagnosed, and nothing else.
    expect(serialized).not.toContain("msg_secret_value");
    expect(serialized).not.toContain("not-an-email");
  });

  it("requires webhook bytes to be bytes", () => {
    const body = new ArrayBuffer(8);
    expect(parseRpcInput(RegionalWebhookInputSchema, { rawBody: body, headers: { "x-hub-signature-256": "sha256=..." } }, "ingest"))
      .toEqual({ rawBody: body, headers: { "x-hub-signature-256": "sha256=..." } });
    expect(refusal(RegionalWebhookInputSchema, { rawBody: "{}", headers: {} }).details)
      .toMatchObject({ issues: [{ path: "rawBody" }] });
    expect(refusal(RegionalWebhookInputSchema, { rawBody: body, headers: { "x-count": 7 } }).details)
      .toMatchObject({ issues: [{ path: "headers.x-count" }] });
  });

  it("bounds a batch so one regional caller cannot hold a Global invocation open", () => {
    const route = { region: "enterprise" as const, workspaceId, automationSubscriptionId: connectionId };
    const schema = rpcBatch(AutomationEmailRouteInputSchema);
    expect(parseRpcInput(schema, Array.from({ length: RPC_BATCH_LIMIT }, () => route), "reserveAutomations"))
      .toHaveLength(RPC_BATCH_LIMIT);
    expect(refusal(schema, Array.from({ length: RPC_BATCH_LIMIT + 1 }, () => route)).details)
      .toMatchObject({ issues: [{ path: "(root)", code: "too_big" }] });
  });

  it("keeps an optional routing target optional", () => {
    const base = {
      resendEmailId: "email_1", svixId: "msg_1", receivedAt: "2026-08-11T00:00:00.000Z",
      region: "global" as const, workspaceId, localPart: "granular-misty",
      emailAddress: "granular-misty@automation.with-avalon.com",
    };
    expect(parseRpcInput(ResendRegionalEmailInputSchema, base, "ingestResendEmail")).toEqual(base);
    expect(parseRpcInput(ResendRegionalEmailInputSchema, { ...base, targetType: "automation" }, "ingestResendEmail"))
      .toMatchObject({ targetType: "automation" });
    expect(refusal(ResendRegionalEmailInputSchema, { ...base, targetType: "mailbox" }).details)
      .toMatchObject({ issues: [{ path: "targetType" }] });
  });
});
