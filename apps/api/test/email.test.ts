import { describe, expect, it, vi } from "vitest";
import { sendEmail, type Email } from "../src/services/email";
import { createTestEnv } from "./helpers/cloudflare-test";

// Cloudflare's external delivery service cannot deliver real mail in this suite.
const email: Email = {
  recipientEmail: "reader@example.com", subject: "A message", text: "Hello",
  idempotencyKey: "delivery/one", category: "test", region: "global", sender: "transactional",
  errors: { unavailable: { code: "mail_unavailable", message: "Unavailable" }, failed: { code: "mail_failed", message: "Failed" } },
};

describe("Cloudflare email sender", () => {
  it("uses the native binding with named senders and a text-only body", async () => {
    const send = vi.fn<(message: EmailMessageBuilder) => Promise<EmailSendResult>>(async () => ({ messageId: "accepted" }));
    const env = createTestEnv({ APP_ENV: "production", EMAIL_FROM: "Rally <invites@rallywith.ai>", EMAIL: { send } });
    await expect(sendEmail(env, { ...email, replyTo: "reply@example.com" })).resolves.toBe("sent");
    expect(send).toHaveBeenCalledExactlyOnceWith({
      from: { email: "invites@rallywith.ai", name: "Rally" }, to: "reader@example.com",
      subject: "A message", text: "Hello", replyTo: "reply@example.com",
      headers: { "X-Rally-Delivery-Key": "delivery/one", "X-Rally-Category": "test", "X-Rally-Region": "global" },
    });
  });

  it("skips development and test mail before resolving a binding", async () => {
    for (const APP_ENV of ["development", "test"] as const) {
      await expect(sendEmail(createTestEnv({ APP_ENV }), email)).resolves.toBe("skipped");
    }
  });

  it("requires a production binding even with a configured sender", async () => {
    await expect(sendEmail(createTestEnv({ APP_ENV: "production", EMAIL_FROM: "sender@example.com" }), email))
      .rejects.toMatchObject({ status: 503, code: "mail_unavailable" });
  });

  it.each([
    ["E_RATE_LIMIT_EXCEEDED", true], ["E_DAILY_LIMIT_EXCEEDED", true],
    ["E_SENDER_NOT_VERIFIED", false], ["E_RECIPIENT_SUPPRESSED", false],
    ["E_INTERNAL_SERVER_ERROR", false], [undefined, false],
  ])("classifies %s without leaking provider details", async (code, retryable) => {
    const env = createTestEnv({ APP_ENV: "production", EMAIL_FROM: "sender@example.com", EMAIL: {
      send: async () => { throw Object.assign(new Error("private provider data"), { code }); },
    } });
    await expect(sendEmail(env, email)).rejects.toMatchObject({
      status: 502, code: "mail_failed", message: "Failed", details: { retryable },
    });
  });

  it("does not treat an empty provider receipt as success", async () => {
    const env = createTestEnv({ APP_ENV: "production", EMAIL_FROM: "sender@example.com", EMAIL: {
      send: async () => ({ messageId: "" }),
    } });
    await expect(sendEmail(env, email)).rejects.toMatchObject({ code: "mail_failed", details: { retryable: false } });
  });
});
