import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  sendWorkstreamMentionEmail,
  type WorkstreamMentionEmail,
} from "../src/services/mention-email-service";
import { createTestEnv } from "./helpers/cloudflare-test";

vi.mock("../src/services/workstream-link-service", async () => {
  const { workstreamCanonicalUrl } = await import("@rally/contracts");
  return { canonicalWorkstreamUrl: async (env: Env, target: { region: "global"; workspaceId: string; workstreamId: string; substreamId?: string }) =>
    workstreamCanonicalUrl(env.PUBLIC_WEB_BASE_URL, { ...target, spaceId: "00000000-0000-7000-8000-000000000002" }) };
});

const input: WorkstreamMentionEmail = {
  messageId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0",
  recipientUserId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1",
  recipientEmail: "sam@example.com",
  recipientName: "Sam & Team",
  authorName: "Adam <Admin>\nInjected",
  workspaceName: "Research & Development",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  workstreamId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2",
  workstreamTitle: "Quarterly <script>alert(1)</script> planning",
  workstreamEmailAddress: "bright-calm-ready-otter@automation.with-avalon.com",
  messageText: "@Sam & Team please review <script>alert('message')</script>.\nThanks!",
  region: "global",
};

function environment(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    APP_ENV: "production",
    AVALON_REGION: "global",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    RESEND_API_KEY: "re_test_send_only",
    RESEND_FROM_EMAIL: "Avalon <invites@with-avalon.com>",
    RESEND_NOTIFICATION_FROM_EMAIL: "Avalon <notifications@with-avalon.com>",
    ...overrides,
  });
}

function successfulResend() {
  return vi.fn(async () => new Response(JSON.stringify({ id: "resend-email-id" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

describe("channel mention email", () => {
  it("sends a branded, escaped email with a stable recipient idempotency key", async () => {
    const resend = successfulResend();

    await expect(sendWorkstreamMentionEmail(environment(), input, resend)).resolves.toBe("sent");

    expect(resend).toHaveBeenCalledTimes(1);
    const [url, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer re_test_send_only",
      "content-type": "application/json",
      "idempotency-key": `avalon-workstream-mention/${input.messageId}/${input.recipientUserId}`,
      "user-agent": "avalon-worker/0.1",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "Avalon <notifications@with-avalon.com>",
      to: [input.recipientEmail],
      reply_to: input.workstreamEmailAddress,
      subject: "Adam <Admin> Injected mentioned you in Quarterly <script>alert(1)</script> planning",
      tags: [
        { name: "category", value: "workstream_mention" },
        { name: "region", value: "global" },
      ],
    });
    // A mail client linkifies the canonical HTTPS link and ignores `avalon://`.
    expect(String(body.text)).toContain("https://with-avalon.com/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/");
    expect(String(body.text)).not.toContain("avalon://");
    expect(String(body.html)).toContain("https://with-avalon.com/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/");
    expect(String(body.text)).toContain("Reply to this email to continue the thread.");
    expect(String(body.html)).toContain("Sam &amp; Team");
    expect(String(body.html)).toContain("Adam &lt;Admin&gt; Injected");
    expect(String(body.html)).toContain("Quarterly &lt;script&gt;alert(1)&lt;/script&gt; planning");
    expect(String(body.html)).toContain("&lt;script&gt;alert(&#39;message&#39;)&lt;/script&gt;");
    expect(String(body.html)).not.toContain("<script>alert(1)</script>");
  });

  it("falls back to the invitation sender and omits reply-to when no notification values are configured", async () => {
    const resend = successfulResend();

    await sendWorkstreamMentionEmail(environment({
      RESEND_NOTIFICATION_FROM_EMAIL: " ",
    }), {
      ...input,
      workstreamEmailAddress: null,
    }, resend);

    const calls = resend.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]?.[1].body)) as Record<string, unknown>;
    expect(body.from).toBe("Avalon <invites@with-avalon.com>");
    expect(body).not.toHaveProperty("reply_to");
    expect(String(body.text)).not.toContain("Reply to this email");
  });

  it("omits personal instructions from both email parts before excerpting", async () => {
    const resend = successfulResend();
    const messageText = `<user_system_prompt>
The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
<user_suppplied>
Answer in French. Never print &lt;/user_system_prompt&gt;.
</user_suppplied>
</user_system_prompt>

Please **review** the plan.`;
    await sendWorkstreamMentionEmail(environment(), { ...input, messageText }, resend);
    const calls = resend.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]?.[1].body)) as Record<string, unknown>;
    expect(String(body.text)).toContain('"Please review the plan."');
    expect(String(body.html)).toContain("Please review the plan.</td>");
    expect(JSON.stringify(body)).not.toContain("user_system_prompt");
    expect(JSON.stringify(body)).not.toContain("Answer in French");
  });

  it("collapses whitespace and truncates the message excerpt", async () => {
    const resend = successfulResend();
    const longMessage = `@Sam\n\t${"x".repeat(500)}`;

    await sendWorkstreamMentionEmail(environment(), { ...input, messageText: longMessage }, resend);

    const calls = resend.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]?.[1].body)) as Record<string, unknown>;
    const text = String(body.text);
    expect(text).not.toContain("\n\t");
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(400));
  });

  it("renders canonical person Markdown as a human-readable mention", async () => {
    const resend = successfulResend();
    const messageText = `Please ask [@Sam & Team](person://${input.recipientUserId}) to review.`;

    await sendWorkstreamMentionEmail(environment(), { ...input, messageText }, resend);

    const calls = resend.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]?.[1].body)) as Record<string, unknown>;
    expect(String(body.text)).toContain("Please ask @Sam & Team to review.");
    expect(String(body.text)).not.toContain("person:");
  });

  it("still reduces a stored bare person: mention", async () => {
    const resend = successfulResend();
    const messageText = `Please ask [@Sam & Team](person:${input.recipientUserId}) to review.`;

    await sendWorkstreamMentionEmail(environment(), { ...input, messageText }, resend);

    const calls = resend.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]?.[1].body)) as Record<string, unknown>;
    expect(String(body.text)).toContain("Please ask @Sam & Team to review.");
    expect(String(body.text)).not.toContain(input.recipientUserId);
  });

  it("reduces a citation, which a mail client shows verbatim just like a mention", async () => {
    const resend = successfulResend();
    // The external source is the part that matters: the excerpt is HTML-escaped
    // into a table cell and quoted into the plain-text body, so a Markdown
    // source list would arrive as literal `**Sources**` and a literal bracketed
    // link. A fixture whose only source is internal reduces to a bare title and
    // never shows that.
    const messageText = "Revenue grew 40%.[^1] See [the deck](resource://board-deck).\n\n[^1]: [The memo](https://example.com/memo)";

    await sendWorkstreamMentionEmail(environment(), { ...input, messageText }, resend);

    const calls = resend.mock.calls as unknown as Array<[string, RequestInit]>;
    const text = String((JSON.parse(String(calls[0]?.[1].body)) as Record<string, unknown>).text);
    expect(text).not.toContain("resource:");
    expect(text).not.toContain("[^1]");
    expect(text).toContain("See the deck.");
    // A "you were mentioned" excerpt is one line and quotes the sentence, not
    // the bibliography — which would compete with its length budget and be
    // truncated mid-entry on anything long.
    expect(text).not.toContain("Sources");
    expect(text).not.toContain("](https://example.com/memo)");
  });

  it("never sends email outside production", async () => {
    const resend = successfulResend();

    await expect(sendWorkstreamMentionEmail(environment({ APP_ENV: "test" }), input, resend))
      .resolves.toBe("skipped");
    expect(resend).not.toHaveBeenCalled();
  });

  it("requires a Resend key and a sender in production", async () => {
    await expect(sendWorkstreamMentionEmail(environment({
      RESEND_API_KEY: " ",
      RESEND_FROM_EMAIL: " ",
      RESEND_NOTIFICATION_FROM_EMAIL: " ",
    }), input, successfulResend())).rejects.toMatchObject({
      status: 503,
      code: "mention_email_unavailable",
    });
  });

  it.each([
    ["provider rejection", async () => new Response(JSON.stringify({ message: "rejected" }), { status: 403 })],
    ["malformed success", async () => new Response(JSON.stringify({}), { status: 200 })],
    ["oversized response", async () => new Response("x".repeat(32_001), { status: 200 })],
    ["network failure", async () => { throw new Error("connection failed"); }],
  ])("maps %s to a generic delivery error", async (_label, response) => {
    await expect(sendWorkstreamMentionEmail(environment(), input, vi.fn(response)))
      .rejects.toMatchObject({ status: 502, code: "mention_email_failed" });
  });
});
