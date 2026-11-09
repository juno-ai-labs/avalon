import type { Region } from "@rally/contracts";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";

export type EmailDelivery = "sent" | "skipped";

export interface EmailFailure {
  code: string;
  message: string;
}

export interface Email {
  recipientEmail: string;
  subject: string;
  /**
   * The styled part, omitted for a message that is meant to arrive unformatted.
   *
   * Every email here carried both parts because every one of them was a model's
   * Markdown, which needs elements to read as anything. Authored mail does not:
   * the access acknowledgement is a person's four paragraphs, and wrapping them
   * in the app's dark palette made a short note look like a marketing send. The
   * text part is the message when this is absent, not a fallback for it.
   */
  html?: string;
  text: string;
  /** Stable caller reference; Cloudflare does not deduplicate this header. */
  idempotencyKey: string;
  category: string;
  region: Region;
  replyTo?: string;
  /** Trusted, caller-owned sender for authored mail; never taken from a public request. */
  from?: string;
  /**
   * `notification` prefers the notification sender and falls back to the
   * transactional one; `transactional` only ever uses the transactional sender.
   */
  sender: "notification" | "transactional";
  /** The caller's own error identities, so each surface keeps its own codes. */
  errors: { unavailable: EmailFailure; failed: EmailFailure };
}

/** The shared production sender. Delivery receipts remain owned by each caller. */
export async function sendEmail(
  env: Env,
  email: Email,
  send?: (message: EmailMessageBuilder) => Promise<EmailSendResult>,
): Promise<EmailDelivery> {
  if (env.APP_ENV !== "production") return "skipped";
  const transactional = env.EMAIL_FROM?.trim();
  const from = email.from?.trim() || (email.sender === "notification"
    ? env.EMAIL_NOTIFICATION_FROM?.trim() || transactional
    : transactional);
  const sender = send ?? env.EMAIL?.send.bind(env.EMAIL);
  if (!sender || !from) {
    throw new ApiError(503, email.errors.unavailable.code, email.errors.unavailable.message);
  }
  try {
    const result = await sender({
      from: emailAddress(from),
      to: email.recipientEmail,
      subject: email.subject,
      ...(email.html ? { html: email.html } : {}),
      text: email.text,
      ...(email.replyTo ? { replyTo: emailAddress(email.replyTo) } : {}),
      headers: {
        "X-Rally-Delivery-Key": email.idempotencyKey,
        "X-Rally-Category": email.category,
        "X-Rally-Region": email.region,
      },
    });
    if (!result?.messageId) throw new Error("email_send_result_missing_message_id");
  } catch (error) {
    // Cloudflare has no provider idempotency key. Retry only explicit quota
    // refusals; an unknown outcome may already have sent the message.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const retryable = code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED";
    throw new ApiError(502, email.errors.failed.code, email.errors.failed.message, { retryable });
  }
  return "sent";
}

/** Existing sender settings use the familiar `Name <mailbox>` syntax. */
function emailAddress(value: string): string | EmailAddress {
  const match = value.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/u);
  return match ? { email: match[2]!.trim(), name: match[1]!.trim().replace(/^"(.*)"$/u, "$1") }
    : value.trim();
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

export function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
}
