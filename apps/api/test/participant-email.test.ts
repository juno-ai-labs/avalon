import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  sendWorkstreamParticipantAddedEmail,
  type WorkstreamParticipantAddedEmail,
} from "../src/services/participant-email-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const input: WorkstreamParticipantAddedEmail = {
  sourceId: "participant:018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2:018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1:0",
  recipientUserId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1",
  recipientEmail: "sam@example.com",
  recipientName: "Sam Okafor",
  actorName: "Adam <Admin>\nInjected",
  workspaceName: "Research & Development",
  workstreamId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2",
  workstreamTitle: "Quarterly <script>alert(1)</script> planning",
  workstreamObjective: "Settle pricing <script>alert('objective')</script>.\nBy Friday.",
  titleIsProvisional: false,
  workstreamEmailAddress: "bright-calm-ready-otter@automation.rallywith.ai",
  region: "global",
};

function environment(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    APP_ENV: "production",
    AVALON_REGION: "global",
    PUBLIC_WEB_BASE_URL: "https://rallywith.ai",
    RESEND_API_KEY: "re_test_send_only",
    RESEND_FROM_EMAIL: "Rally <invites@rallywith.ai>",
    RESEND_NOTIFICATION_FROM_EMAIL: "Rally <notifications@rallywith.ai>",
    ...overrides,
  });
}

function successfulResend() {
  return vi.fn(async () => new Response(JSON.stringify({ id: "resend-email-id" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function sentBody(resend: ReturnType<typeof successfulResend>): Record<string, unknown> {
  const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("work-stream participant-added email", () => {
  it("sends a branded, escaped email keyed on the participation", async () => {
    const resend = successfulResend();

    await expect(sendWorkstreamParticipantAddedEmail(environment(), input, resend))
      .resolves.toBe("sent");

    const [url, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({
      authorization: "Bearer re_test_send_only",
      // Keyed on the participation rather than the person's whole history with
      // the work stream: this is the only thing stopping a Queue redelivery
      // from sending a second copy.
      "idempotency-key":
        `avalon-workstream-participant-added/${input.sourceId}/${input.recipientUserId}`,
    });
    const body = sentBody(resend);
    expect(body).toMatchObject({
      from: "Rally <notifications@rallywith.ai>",
      to: ["sam@example.com"],
      reply_to: "bright-calm-ready-otter@automation.rallywith.ai",
    });
    // Every free-text value the sender controls reaches the HTML escaped, and
    // the newline in the actor's name cannot break the subject header.
    const html = String(body.html);
    expect(html).toContain("Adam &lt;Admin&gt; Injected");
    expect(html).toContain("Quarterly &lt;script&gt;alert(1)&lt;/script&gt; planning");
    expect(html).toContain("Settle pricing &lt;script&gt;alert(&#39;objective&#39;)&lt;/script&gt;.");
    expect(html).not.toContain("<script>");
    expect(String(body.subject)).not.toContain("\n");
    expect(String(body.subject))
      .toBe("Adam <Admin> Injected added you to Quarterly <script>alert(1)</script> planning");
  });

  it("says Rally, never Avalon, on both the text and HTML branches", async () => {
    const resend = successfulResend();
    // The unnamed-recipient branch is the one no fixture used to render, and it
    // is where the product name appears in prose rather than as a wordmark.
    await sendWorkstreamParticipantAddedEmail(
      environment(), { ...input, recipientName: "" }, resend,
    );

    const body = sentBody(resend);
    expect(String(body.text)).toContain("You were added to a work stream in Rally.");
    expect(String(body.text)).toContain("Open in Rally: https://rallywith.ai/app/workstreams/");
    expect(String(body.html)).toContain(">Rally</td>");
    expect(String(body.html)).toContain("Open in Rally</a>");
    expect(String(body.text)).not.toContain("Avalon");
    expect(String(body.html)).not.toContain("Avalon");
  });

  it("greets by first name, and drops the greeting when there is no name", async () => {
    const named = successfulResend();
    await sendWorkstreamParticipantAddedEmail(environment(), input, named);
    expect(String(sentBody(named).text)).toContain("Hi Sam,");
    expect(String(sentBody(named).text)).not.toContain("Hi Sam Okafor,");

    const unnamed = successfulResend();
    await sendWorkstreamParticipantAddedEmail(
      environment(), { ...input, recipientName: "" }, unnamed,
    );
    // The heading already says it; repeating it two lines below is the bug this
    // covers, not a missing greeting.
    const html = String(sentBody(unnamed).html);
    expect(html).toContain("You were added to a work stream</h1>");
    expect(html).not.toContain("You were added to a work stream in Rally.");
  });

  it("does not name a work stream the naming agent has not named yet", async () => {
    const resend = successfulResend();
    // What a create from the composer produces: the title is the opening
    // message's first line and the objective is the same line, so quoting the
    // title names the room by a fragment and then prints it twice.
    const opening = "Can someone dig into why the self-serve funnel dropped about 12% week over week";
    await sendWorkstreamParticipantAddedEmail(environment(), {
      ...input,
      titleIsProvisional: true,
      workstreamTitle: opening,
      workstreamObjective: opening,
    }, resend);

    const body = sentBody(resend);
    expect(String(body.subject)).toBe("Adam <Admin> Injected started a work stream with you");
    expect(String(body.text))
      .toContain("started a work stream in Research & Development and added you to it.");
    expect(String(body.html)).toContain("You're in a new work stream</h1>");
    // The opening line appears exactly once, as the objective, rather than
    // twice — once cut mid-sentence as a name and once whole.
    expect(String(body.text).split(opening)).toHaveLength(2);
  });

  it("skips outside production rather than sending from a developer's account", async () => {
    const resend = successfulResend();
    await expect(sendWorkstreamParticipantAddedEmail(
      environment({ APP_ENV: "test" }), input, resend,
    )).resolves.toBe("skipped");
    expect(resend).not.toHaveBeenCalled();
  });

  it("reports its own error identity when no sender is configured", async () => {
    const resend = successfulResend();
    await expect(sendWorkstreamParticipantAddedEmail(
      environment({ RESEND_FROM_EMAIL: " ", RESEND_NOTIFICATION_FROM_EMAIL: " " }), input, resend,
    )).rejects.toMatchObject({ status: 503, code: "participant_email_unavailable" });
    expect(resend).not.toHaveBeenCalled();
  });
});
