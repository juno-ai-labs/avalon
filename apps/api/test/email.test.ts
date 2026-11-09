import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { sendEmail, type Email } from "../src/services/email";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function durableSender(send: (message: EmailMessageBuilder) => Promise<EmailSendResult>) {
  const database = migratedSqliteDatabase();
  databases.push(database);
  return { database, env: createTestEnv({ DB: sqliteD1(database), APP_ENV: "production", EMAIL_FROM: "sender@example.com", EMAIL: { send } }) };
}

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
    ["E_INTERNAL_SERVER_ERROR", true], [undefined, true],
  ])("classifies %s without leaking provider details", async (code, retryable) => {
    const env = createTestEnv({ APP_ENV: "production", EMAIL_FROM: "sender@example.com", EMAIL: {
      send: async () => { throw Object.assign(new Error("private provider data"), { code }); },
    } });
    await expect(sendEmail(env, email)).rejects.toMatchObject({
      status: 502, code: "mail_failed", message: "Failed", details: { retryable },
      diagnosticCode: code ?? "email_send_outcome_unknown",
    });
  });

  it("does not treat an empty provider receipt as success", async () => {
    const env = createTestEnv({ APP_ENV: "production", EMAIL_FROM: "sender@example.com", EMAIL: {
      send: async () => ({ messageId: "" }),
    } });
    await expect(sendEmail(env, email)).rejects.toMatchObject({ code: "mail_failed", details: { retryable: true, deliveryOutcomeUnknown: true },
      diagnosticCode: "email_send_result_missing_message_id" });
  });

  it("atomically claims transactional sends and suppresses overlapping and completed deliveries", async () => {
    let release!: (result: EmailSendResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const send = vi.fn(async () => { entered(); return new Promise<EmailSendResult>((resolve) => { release = resolve; }); });
    const { database, env } = durableSender(send);
    const message = { ...email, durableDelivery: "review" as const };
    const first = sendEmail(env, message);
    await started;
    await expect(sendEmail(env, message)).rejects.toMatchObject({ details: { retryable: false } });
    release({ messageId: "accepted" });
    await expect(first).resolves.toBe("sent");
    await expect(sendEmail(env, message)).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT state FROM email_delivery_receipts").all()).toEqual([{ state: "sent" }]);
  });

  it("parks unknown transactional outcomes and retries only a confirmed quota refusal", async () => {
    const send = vi.fn(async () => { throw new Error("connection lost"); });
    const { database, env } = durableSender(send);
    const message = { ...email, durableDelivery: "review" as const };
    await expect(sendEmail(env, message)).rejects.toMatchObject({ details: { retryable: false }, diagnosticCode: "email_send_outcome_unknown" });
    await expect(sendEmail(env, message)).rejects.toMatchObject({ details: { retryable: false } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT state, diagnostic_code FROM email_delivery_receipts").all())
      .toEqual([{ state: "review_required", diagnostic_code: "email_send_outcome_unknown" }]);
    const quota = vi.fn(async () => ({ messageId: "accepted" }))
      .mockRejectedValueOnce(Object.assign(new Error("quota"), { code: "E_RATE_LIMIT_EXCEEDED" }));
    env.EMAIL = { send: quota };
    const second = { ...message, idempotencyKey: "delivery/two" };
    await expect(sendEmail(env, second)).rejects.toMatchObject({ details: { retryable: true } });
    await expect(sendEmail(env, second)).resolves.toBe("sent");
    expect(quota).toHaveBeenCalledTimes(2);
  });

  it("keeps notices retryable on internal failures and remembers completed queue deliveries", async () => {
    const send = vi.fn(async () => ({ messageId: "accepted" }))
      .mockRejectedValueOnce(Object.assign(new Error("temporarily unavailable"), { code: "E_INTERNAL_SERVER_ERROR" }));
    const { database, env } = durableSender(send);
    const message = { ...email, durableDelivery: "retry" as const };
    await expect(sendEmail(env, message)).rejects.toMatchObject({ details: { retryable: true } });
    await expect(sendEmail(env, message)).resolves.toBe("sent");
    await expect(sendEmail(env, message)).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
    expect(database.prepare("SELECT state FROM email_delivery_receipts").all()).toEqual([{ state: "sent" }]);
  });

  it("parks provider acceptance when receipt settlement fails instead of resending", async () => {
    const send = vi.fn(async () => ({ messageId: "accepted" }));
    const { database, env } = durableSender(send);
    const prepare = env.DB.prepare.bind(env.DB);
    let fail = true;
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("SET state = 'sent'") && fail) {
        statement.run = async () => { fail = false; throw new Error("D1 write unavailable"); };
      }
      return statement;
    });
    const message = { ...email, durableDelivery: "review" as const };
    await expect(sendEmail(env, message)).rejects.toMatchObject({ diagnosticCode: "email_delivery_settlement_failed", details: { retryable: false } });
    await expect(sendEmail(env, message)).rejects.toMatchObject({ details: { retryable: false } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT state FROM email_delivery_receipts").all()).toEqual([{ state: "review_required" }]);
  });

  it("does not settle a delivery after its attempt token has been replaced", async () => {
    let release!: (result: EmailSendResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const send = vi.fn(async () => { entered(); return new Promise<EmailSendResult>((resolve) => { release = resolve; }); });
    const { database, env } = durableSender(send);
    const attempt = sendEmail(env, { ...email, durableDelivery: "review" });
    await started;
    database.prepare("UPDATE email_delivery_receipts SET attempt_token = 'replacement-attempt'").run();
    release({ messageId: "accepted" });
    await expect(attempt).rejects.toMatchObject({ diagnosticCode: "email_delivery_settlement_failed", details: { retryable: false } });
    expect(database.prepare("SELECT state, attempt_token FROM email_delivery_receipts").all())
      .toEqual([{ state: "sending", attempt_token: "replacement-attempt" }]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
