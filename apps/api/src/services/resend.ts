import type { Region } from "@rally/contracts";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const MAX_RESEND_RESPONSE_CHARS = 32_000;

export type ResendDelivery = "sent" | "skipped";

export interface ResendFailure {
  code: string;
  message: string;
}

export interface ResendEmail {
  recipientEmail: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  category: string;
  region: Region;
  replyTo?: string;
  /**
   * `notification` prefers the notification sender and falls back to the
   * transactional one; `transactional` only ever uses the transactional sender.
   */
  sender: "notification" | "transactional";
  /** The caller's own error identities, so each surface keeps its own codes. */
  errors: { unavailable: ResendFailure; failed: ResendFailure };
}

/**
 * The one Resend caller. Every transactional email Avalon sends goes through
 * here so the production guard, the sender resolution, the response-size cap,
 * and the provider-id validation cannot drift apart between surfaces. Callers
 * own only what genuinely differs: their body and HTML, their error identities,
 * and whatever they record about a failure.
 */
export async function sendResendEmail(
  env: Env,
  email: ResendEmail,
  request: typeof fetch = fetch,
): Promise<ResendDelivery> {
  // Local and test traffic must never send transactional email through a
  // developer's production Resend account.
  if (env.APP_ENV !== "production") return "skipped";

  const apiKey = env.RESEND_API_KEY?.trim();
  const transactional = env.RESEND_FROM_EMAIL?.trim();
  const from = email.sender === "notification"
    ? env.RESEND_NOTIFICATION_FROM_EMAIL?.trim() || transactional
    : transactional;
  if (!apiKey || !from) {
    throw new ApiError(503, email.errors.unavailable.code, email.errors.unavailable.message);
  }

  // `retryable: false` means the provider rejected this message and will keep
  // rejecting it — an invalid recipient rather than a blip. A caller holding a
  // frozen destination uses it to stop retrying and surface the address.
  const failed = (retryable = true): ApiError =>
    new ApiError(502, email.errors.failed.code, email.errors.failed.message, { retryable });

  let response: Response;
  try {
    response = await request(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": email.idempotencyKey,
        "user-agent": "avalon-worker/0.1",
      },
      body: JSON.stringify({
        from,
        to: [email.recipientEmail],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        tags: [
          { name: "category", value: email.category },
          { name: "region", value: email.region },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw failed();
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    throw failed();
  }
  if (body.length > MAX_RESEND_RESPONSE_CHARS) throw failed();
  if (!response.ok) throw failed(response.status === 429 || response.status >= 500);
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    if (typeof parsed.id !== "string" || parsed.id.length === 0 || parsed.id.length > 200) {
      throw new Error("invalid Resend response");
    }
  } catch {
    throw failed();
  }
  return "sent";
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
