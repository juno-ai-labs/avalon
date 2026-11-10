import type { Region } from "@rally/contracts";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";

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
  /** Transactional uncertainty needs review; notices retry and retain completed receipts. */
  durableDelivery?: "review" | "retry";
  /** The caller's own error identities, so each surface keeps its own codes. */
  errors: { unavailable: EmailFailure; failed: EmailFailure };
}

/** Shared production sender; callers select durable receipts or their own authority. */
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
  const deliver = () => sendNativeEmail(sender, from, email);
  if (!email.durableDelivery) return deliver();
  const db = workspaceRegionalDatabase(env);
  const key = email.idempotencyKey;
  const completed = await db.prepare("SELECT state FROM email_delivery_receipts WHERE delivery_key = ?")
    .bind(key).first<{ state: string }>();
  if (completed?.state === "sent") return "sent";
  if (email.durableDelivery === "retry") {
    // The queue owns retry policy. A crash after acceptance may duplicate a
    // send, but a completed invocation's redelivery must not send it again.
    const result = await deliver();
    await db.prepare(`INSERT INTO email_delivery_receipts (delivery_key, state, updated_at)
      VALUES (?, 'sent', ?) ON CONFLICT(delivery_key) DO UPDATE SET state = 'sent', updated_at = excluded.updated_at`)
      .bind(key, Date.now()).run();
    return result;
  }
  await db.prepare(`INSERT OR IGNORE INTO email_delivery_receipts (delivery_key, state, updated_at)
    VALUES (?, 'pending', ?)`).bind(key, Date.now()).run();
  const token = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE email_delivery_receipts SET state = 'sending', attempt_token = ?, updated_at = ?
    WHERE delivery_key = ? AND state = 'pending' RETURNING delivery_key`).bind(token, Date.now(), key).first();
  if (!claimed) {
    const current = await db.prepare("SELECT state FROM email_delivery_receipts WHERE delivery_key = ?")
      .bind(key).first<{ state: string }>();
    if (current?.state === "sent") return "sent";
    throw new ApiError(503, email.errors.failed.code, email.errors.failed.message,
      { retryable: false }, "email_delivery_review_required");
  }
  let accepted = false;
  try {
    const result = await deliver();
    accepted = true;
    const settled = await db.prepare(`UPDATE email_delivery_receipts SET state = 'sent', updated_at = ?
      WHERE delivery_key = ? AND state = 'sending' AND attempt_token = ?`).bind(Date.now(), key, token).run();
    if (settled.meta.changes !== 1) throw new Error("email_delivery_claim_lost");
    return result;
  } catch (error) {
    const uncertain = accepted || !(error instanceof ApiError) || error.details?.deliveryOutcomeUnknown === true;
    const retryable = !uncertain && error instanceof ApiError && error.details?.retryable !== false;
    const diagnostic = accepted ? "email_delivery_settlement_failed"
      : error instanceof ApiError ? error.diagnosticCode ?? error.code : "email_delivery_attempt_failed";
    await db.prepare(`UPDATE email_delivery_receipts SET state = ?, diagnostic_code = ?, updated_at = ?
      WHERE delivery_key = ? AND state = 'sending' AND attempt_token = ?`)
      .bind(uncertain ? "review_required" : retryable ? "pending" : "failed", diagnostic, Date.now(), key, token).run();
    if (uncertain) throw new ApiError(503, email.errors.failed.code, email.errors.failed.message,
      { retryable: false, deliveryOutcomeUnknown: true }, diagnostic);
    throw error;
  }
}

/** Refusals documented by Cloudflare, checked 2026-11-09 in the Workers API. */
const PERMANENT_REFUSALS = new Set([
  "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_ACCOUNT_SUSPENDED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_CONTENT_TOO_LARGE", "E_DELIVERY_FAILED",
  "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID", "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY",
]);

async function sendNativeEmail(sender: (message: EmailMessageBuilder) => Promise<EmailSendResult>, from: string, email: Email): Promise<EmailDelivery> {
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
    if (!result?.messageId) throw Object.assign(new Error("email_send_result_missing_message_id"), { code: "email_send_result_missing_message_id" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const permanent = typeof code === "string" && PERMANENT_REFUSALS.has(code);
    const refused = permanent || code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED";
    const diagnostic = typeof code === "string" && (/^E_[A-Z_]+$/u.test(code) || code === "email_send_result_missing_message_id")
      ? code : "email_send_outcome_unknown";
    throw new ApiError(502, email.errors.failed.code, email.errors.failed.message,
      { retryable: !permanent, deliveryOutcomeUnknown: !refused }, diagnostic);
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
