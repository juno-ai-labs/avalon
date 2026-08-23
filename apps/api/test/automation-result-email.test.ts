import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  text: [
    "## Deep dive",
    "",
    "- **Positioning:** they now claim the multiplayer angle",
    "",
    "Two new models shipped.",
    "<script>alert('result')</script>",
  ].join("\n"),
  outcomeStatus: "completed",
};

const target = {
  id: "target-1",
  user_id: "user-1",
  email_address: "owner@example.com",
  last_delivered_workstream_id: null as string | null,
  inbound_address: "calm-bright-gentle-otter@automation.with-avalon.com",
};

interface DatabaseCalls {
  statements: string[];
  bindings: unknown[][];
}

/**
 * A database that answers by statement, and throws on anything it was not
 * asked about.
 *
 * One row for every query hid the two things this service is: the membership
 * re-check, which could not fail and so could not be tested, and the fact that
 * the target lives in WorkspaceDO while the member and their timezone live in
 * regional D1 — with one answer for both, dropping the regional hop still
 * passed here and failed in production with `no such table`.
 */
function environment(
  overrides: Partial<Env> = {},
  row: typeof target | null = target,
  recipient: { timezone: string | null } | null = { timezone: "Europe/London" },
): { env: Env; calls: DatabaseCalls } {
  const calls: DatabaseCalls = { statements: [], bindings: [] };
  const prepare = vi.fn((statement: string) => {
    calls.statements.push(statement);
    return {
      bind: (...bindings: unknown[]) => {
        calls.bindings.push(bindings);
        return {
          first: async () => {
            if (statement.includes("automation_delivery_targets")) return row;
            if (statement.includes("workspace_members")) return recipient;
            throw new Error(`unexpected query: ${statement}`);
          },
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
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
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
  // The subject carries the run's date, so the clock is pinned: asserting on
  // today's date passes on the day it is written and fails the next morning.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Late enough in the UTC day that a reader east of it is already on the
    // next date, which is what the timezone case below turns on.
    vi.setSystemTime(new Date("2026-08-22T21:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
      subject: "Daily <Azure> tracker Injected · 22 Aug 2026",
      reply_to: "calm-bright-gentle-otter@automation.with-avalon.com",
      tags: [
        { name: "category", value: "automation_result" },
        { name: "region", value: "global" },
      ],
    });
    // A mail client will not linkify `avalon://`, so the canonical HTTPS link
    // is what both parts of the message carry.
    expect(String(body.text)).toContain(`https://with-avalon.com/app/workstreams/${input.workstreamId}`);
    expect(String(body.html)).toContain(`https://with-avalon.com/app/workstreams/${input.workstreamId}`);
    expect(String(body.html)).not.toContain("avalon://");
    expect(String(body.html)).toContain("&lt;script&gt;alert(&#39;result&#39;)&lt;/script&gt;");
    expect(String(body.html)).not.toContain("<script>alert('result')</script>");
    expect(calls.statements.some((statement) => statement.includes("UPDATE automation_delivery_targets"))).toBe(true);
    expect(calls.bindings.at(-1)).toContain(input.workstreamId);
  });

  it("renders the result's markdown instead of mailing its markup", async () => {
    const { env } = environment();
    const resend = successfulResend();

    await deliverAutomationResultEmail(env, input, resend);

    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    const html = String((JSON.parse(String(init.body)) as { html: string }).html);
    // The body a briefing automation actually produces: before this rendered,
    // the reader got `## Deep dive` and `**Positioning:**` as literal text.
    expect(html).toContain("<h2");
    expect(html).toContain("Deep dive");
    expect(html).toContain("<strong");
    expect(html).toContain("<li");
    expect(html).not.toContain("## Deep dive");
    expect(html).not.toContain("**Positioning:**");
    // A stylesheet is stripped by most mail clients, so every rule is inline.
    expect(html).not.toContain("<style");
  });

  it("labels a run that stopped for input", async () => {
    const { env } = environment();
    const resend = successfulResend();

    await deliverAutomationResultEmail(env, { ...input, outcomeStatus: "needs_input" }, resend);

    const calls = resend.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]?.[1].body)) as Record<string, unknown>;
    expect(body.subject).toBe("Action needed · Daily <Azure> tracker Injected · 22 Aug 2026");
  });

  it("dates the subject in the reader's own timezone", async () => {
    const { env } = environment({}, target, { timezone: "Pacific/Auckland" });
    const resend = successfulResend();

    await deliverAutomationResultEmail(env, input, resend);

    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { subject: string };
    // 21:00 UTC on 22 August is 09:00 on the 23rd in Auckland. A briefing dated
    // by the Worker's clock rather than the reader's is dated wrong for
    // everybody far enough east of it.
    expect(body.subject).toContain("23 Aug 2026");
  });

  it("says in the subject and the body when a run produced no result", async () => {
    const { env } = environment();
    const resend = successfulResend();

    await deliverAutomationResultEmail(env, { ...input, outcomeStatus: "failed", text: "connection reset" }, resend);

    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { subject: string; html: string };
    // The same shell, the same brand, and one unexplained sentence is not a
    // briefing — the reader has to be able to tell before opening it.
    expect(body.subject.startsWith("Did not finish · ")).toBe(true);
    expect(body.html).toContain("This run did not finish.");
  });

  it("skips a target whose owner is no longer an active member", async () => {
    const { env } = environment({}, target, null);
    const resend = successfulResend();

    await expect(deliverAutomationResultEmail(env, input, resend)).resolves.toBe("skipped");
    expect(resend).not.toHaveBeenCalled();
  });

  it("converts the plain-text part rather than mailing raw markdown", async () => {
    const { env } = environment();
    const resend = successfulResend();

    await deliverAutomationResultEmail(env, input, resend);

    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    const text = String((JSON.parse(String(init.body)) as { text: string }).text);
    expect(text).toContain("Deep dive");
    expect(text).not.toContain("## Deep dive");
    expect(text).not.toContain("**Positioning:**");
  });

  it("keeps the rendered email under the size a client will show", async () => {
    const { env } = environment();
    const resend = successfulResend();
    // Every bullet carries bold, a link and a code span: the shape that renders
    // to seven times its source and lands past Gmail's clip.
    const dense = Array.from({ length: 900 }, (_, index) =>
      `- **Item ${index}:** see [the source](https://example.com/${index}) and \`field_${index}\``).join("\n");

    await deliverAutomationResultEmail(env, { ...input, text: dense }, resend);

    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    const html = String((JSON.parse(String(init.body)) as { html: string }).html);
    expect(new TextEncoder().encode(html).length).toBeLessThanOrEqual(90_000);
    // Still a whole document, not a byte-cut one.
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
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
