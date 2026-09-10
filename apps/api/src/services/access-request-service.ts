import type { Env } from '../env';
import { ApiError } from '../lib/api-error';
import { accessAcknowledgementContent } from './access-request-content';
import { markdownToEmailHtml, markdownToEmailText } from './email-markdown';
import { sendResendEmail } from './resend';
import { admitAccessEmail, MAX_ACCESS_EMAILS_PER_HOUR } from './access-request-limits';

interface RequestRow {
  id: string;
  acknowledgement_subject: string;
  acknowledgement_markdown: string;
  acknowledgement_from: string;
  acknowledgement_status: 'pending' | 'sending' | 'sent' | 'failed' | 'rejected' | 'review_required' | 'skipped' | 'suppressed';
  acknowledgement_generation: number;
  acknowledgement_first_attempt_at: string | null;
}

const rejectedEmail = () => new ApiError(502, 'access_email_rejected',
  'Your request was saved, but we could not deliver your confirmation email. Check that you entered the right address.');

// Resend retains keys for 24 hours (checked 2026-09-09):
// https://resend.com/docs/dashboard/emails/idempotency-keys
// Anchor to the first attempt, not the latest retry, or uncertainty can resend mail.
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const reviewRequired = () => new ApiError(503, 'access_email_review_required',
  'Your request was saved. We need to check the confirmation email before sending it again.');

/** Persist before contacting Resend, retaining identical content/key across retries. */
export async function requestAccess(env: Env, email: string, mailLimit = MAX_ACCESS_EMAILS_PER_HOUR): Promise<void> {
  await env.DB.prepare(`INSERT INTO access_requests
    (id, email, created_at, acknowledgement_subject, acknowledgement_markdown, acknowledgement_from)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING`)
    .bind(crypto.randomUUID(), email, new Date().toISOString(),
      accessAcknowledgementContent.subject, accessAcknowledgementContent.markdown, accessAcknowledgementContent.from).run();
  const row = await env.DB.prepare(`SELECT id, acknowledgement_subject,
    acknowledgement_markdown, acknowledgement_from, acknowledgement_status,
    acknowledgement_first_attempt_at, acknowledgement_generation FROM access_requests WHERE email = ?`)
    .bind(email).first<RequestRow>();
  if (!row) throw new Error('Access request was not persisted');
  if (row.acknowledgement_status === 'sent' || row.acknowledgement_status === 'skipped'
    || row.acknowledgement_status === 'sending' || row.acknowledgement_status === 'suppressed') return;
  if (row.acknowledgement_status === 'rejected') throw rejectedEmail();
  if (row.acknowledgement_status === 'review_required') throw reviewRequired();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.parse(now) - RESEND_IDEMPOTENCY_WINDOW_MS).toISOString();
  if (row.acknowledgement_first_attempt_at !== null && row.acknowledgement_first_attempt_at <= cutoff) {
    await env.DB.prepare(`UPDATE access_requests SET acknowledgement_status = 'review_required'
      WHERE id = ? AND acknowledgement_generation = ? AND acknowledgement_status IN ('pending', 'failed')`).bind(row.id, row.acknowledgement_generation).run();
    throw reviewRequired();
  }
  // One durable owner contacts the provider. A duplicate returns accepted while
  // that owner works; a crashed owner remains visible for operator reconciliation.
  const claimed = await env.DB.prepare(`UPDATE access_requests SET acknowledgement_status = 'sending',
    acknowledgement_first_attempt_at = COALESCE(acknowledgement_first_attempt_at, ?)
    WHERE id = ? AND acknowledgement_generation = ? AND acknowledgement_status IN ('pending', 'failed') RETURNING id`)
    .bind(now, row.id, row.acknowledgement_generation).first<{ id: string }>();
  if (!claimed) return;
  try {
    if (!await admitAccessEmail(env, mailLimit)) {
      // No provider attempt occurred. Preserve an earlier uncertainty window,
      // but do not age out a message that only ever waited for quota.
      await env.DB.prepare(`UPDATE access_requests SET acknowledgement_status = 'pending',
        acknowledgement_first_attempt_at = ? WHERE id = ? AND acknowledgement_generation = ? AND acknowledgement_status = 'sending'`)
        .bind(row.acknowledgement_first_attempt_at, row.id, row.acknowledgement_generation).run();
      return;
    }
    const status = await sendResendEmail(env, {
      recipientEmail: email,
      subject: row.acknowledgement_subject,
      from: row.acknowledgement_from,
      html: `<div style="background:#111210;color:#ecebe5;padding:32px;font-family:Arial,sans-serif">${markdownToEmailHtml(row.acknowledgement_markdown)}</div>`,
      text: markdownToEmailText(row.acknowledgement_markdown),
      idempotencyKey: `rally-access-request/${row.id}/${row.acknowledgement_generation}`,
      category: 'access_request', region: 'global', sender: 'transactional',
      errors: {
        unavailable: { code: 'access_email_unavailable', message: 'Your request was saved, but the confirmation email is unavailable. Please try again.' },
        failed: { code: 'access_email_failed', message: 'Your request was saved, but the confirmation email could not be sent. Please try again.' },
      },
    });
    await env.DB.prepare(`UPDATE access_requests SET acknowledgement_status = ?, acknowledged_at = ? WHERE id = ? AND acknowledgement_generation = ? AND acknowledgement_status = 'sending'`)
      .bind(status, status === 'sent' ? new Date().toISOString() : null, row.id, row.acknowledgement_generation).run();
  } catch (error) {
    // A concurrent successful attempt must not be overwritten by a failed one.
    const needsReview = error instanceof ApiError && error.details?.retryable === false;
    await env.DB.prepare(`UPDATE access_requests SET acknowledgement_status = ?
      WHERE id = ? AND acknowledgement_generation = ? AND acknowledgement_status = 'sending'`)
      .bind(needsReview ? 'review_required' : 'failed', row.id, row.acknowledgement_generation).run();
    throw needsReview ? reviewRequired() : error;
  }
}
