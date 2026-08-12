import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  deliverAutomationResultEmail,
  type AutomationResultEmail,
} from "../src/services/automation-email-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const input: AutomationResultEmail = {
  workspaceId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b7900",
  automationSubscriptionId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b7901",
  workstreamId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b7902",
  title: "Daily <Azure> tracker\nInjected",
  text: "Two new models shipped.\n<script>alert('result')</script>",
  outcomeStatus: "completed",
};

const target = {
  id: "target-1",
  email_address: "owner@example.com",
  last_delivered_workstream_id: null as string | null,
};

interface DatabaseCalls {
  statements: string[];
  bindings: unknown[][];
}

function environment(
  overrides: Partial<Env> = {},
  row: typeof target | null = target,
): { env: Env; calls: DatabaseCalls } {
  const calls: DatabaseCalls = { statements: [], bindings: [] };
  const prepare = vi.fn((statement: string) => {
    calls.statements.push(statement);
    return {
      bind: (...bindings: unknown[]) => {
        calls.bindings.push(bindings);
        return {
          first: async () => row,
          run: async () => ({ success: true }),
        };
      },
    };
  });
  return {
    calls,
    env: createTestEnv({
      APP_ENV: "production",
      AVALON_REGION: "global",
      DB: { prepare },
      RESEND_API_KEY: "re_test_send_only",
      RESEND_FROM_EMAIL: "Avalon <invites@with-avalon.com>",
      RESEND_NOTIFICATION_FROM_EMAIL: "Avalon <notifications@with-avalon.com>",
      ...overrides,
    }),
  };
}

function successfulResend() {
  return vi.fn(async () => new Response(JSON.stringify({ id: "resend-email-id" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

describe("automation result email", () => {
  it("sends an escaped result to the frozen address and records the delivery", async () => {
    const { env, calls } = environment();
    const resend = successfulResend();

    await expect(deliverAutomationResultEmail(env, input, resend)).resolves.toBe("sent");

    expect(resend).toHaveBeenCalledTimes(1);
    const [url, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({
      authorization: "Bearer re_test_send_only",
      "idempotency-key": `avalon-automation-result/${target.id}/${input.workstreamId}`,
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "Avalon <notifications@with-avalon.com>",
      to: ["owner@example.com"],
      subject: "Daily <Azure> tracker Injected",
      tags: [
        { name: "category", value: "automation_result" },
        { name: "region", value: "global" },
      ],
    });
    expect(String(body.text)).toContain(`avalon://workstreams/${input.workstreamId}`);
    expect(String(body.html)).toContain("&lt;script&gt;alert(&#39;result&#39;)&lt;/script&gt;");
    expect(String(body.html)).not.toContain("<script>alert('result')</script>");
    expect(calls.statements.some((statement) => statement.includes("UPDATE automation_delivery_targets"))).toBe(true);
    expect(calls.bindings.at(-1)).toContain(input.workstreamId);
  });

  it("labels a run that stopped for input", async () => {
    const { env } = environment();
    const resend = successfulResend();

    await deliverAutomationResultEmail(env, { ...input, outcomeStatus: "needs_input" }, resend);

    const calls = resend.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]?.[1].body)) as Record<string, unknown>;
    expect(body.subject).toBe("Action needed · Daily <Azure> tracker Injected");
  });

  it("skips an automation with no email target", async () => {
    const { env } = environment({}, null);
    const resend = successfulResend();

    await expect(deliverAutomationResultEmail(env, input, resend)).resolves.toBe("skipped");
    expect(resend).not.toHaveBeenCalled();
  });

  it("skips a work stream the target already received", async () => {
    const { env } = environment({}, { ...target, last_delivered_workstream_id: input.workstreamId });
    const resend = successfulResend();

    await expect(deliverAutomationResultEmail(env, input, resend)).resolves.toBe("skipped");
    expect(resend).not.toHaveBeenCalled();
  });

  it("skips an empty or explicitly nothing-to-report result", async () => {
    const { env } = environment();
    const resend = successfulResend();

    await expect(deliverAutomationResultEmail(env, { ...input, text: "  " }, resend)).resolves.toBe("skipped");
    await expect(deliverAutomationResultEmail(env, { ...input, text: "No qualifying emails today." }, resend))
      .resolves.toBe("skipped");
    expect(resend).not.toHaveBeenCalled();
  });

  it("never sends email outside production", async () => {
    const { env } = environment({ APP_ENV: "test" });
    const resend = successfulResend();

    await expect(deliverAutomationResultEmail(env, input, resend)).resolves.toBe("skipped");
    expect(resend).not.toHaveBeenCalled();
  });

  it("requires a Resend key and a sender in production", async () => {
    const { env } = environment({
      RESEND_API_KEY: " ",
      RESEND_FROM_EMAIL: " ",
      RESEND_NOTIFICATION_FROM_EMAIL: " ",
    });

    await expect(deliverAutomationResultEmail(env, input, successfulResend())).rejects.toMatchObject({
      status: 503,
      code: "automation_email_unavailable",
    });
  });

  it.each([
    ["provider rejection", async () => new Response(JSON.stringify({ message: "rejected" }), { status: 403 })],
    ["malformed success", async () => new Response(JSON.stringify({}), { status: 200 })],
    ["oversized response", async () => new Response("x".repeat(32_001), { status: 200 })],
    ["network failure", async () => { throw new Error("connection failed"); }],
  ])("records %s and raises a retryable delivery error", async (_label, response) => {
    const { env, calls } = environment();

    await expect(deliverAutomationResultEmail(env, input, vi.fn(response)))
      .rejects.toMatchObject({ status: 502, code: "automation_email_failed" });
    expect(calls.statements.some((statement) => statement.includes("last_error_json = ?"))).toBe(true);
  });
});
