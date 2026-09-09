import type { Env } from '../env';
import { accessAcknowledgementContent } from './access-request-content';
import { markdownToEmailHtml, markdownToEmailText } from './email-markdown';
import { sendResendEmail } from './resend';

interface RequestRow {
  id: string;
  acknowledgement_subject: string;
  acknowledgement_markdown: string;
  acknowledgement_from: string;
  acknowledgement_status: 'pending' | 'sent' | 'failed' | 'skipped';
}

/** Persist before contacting Resend, retaining identical content/key across retries. */
export async function requestAccess(env: Env, email: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO access_requests
    (id, email, created_at, acknowledgement_subject, acknowledgement_markdown, acknowledgement_from)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING`)
    .bind(crypto.randomUUID(), email, new Date().toISOString(),
      accessAcknowledgementContent.subject, accessAcknowledgementContent.markdown, accessAcknowledgementContent.from).run();
  const row = await env.DB.prepare(`SELECT id, acknowledgement_subject,
    acknowledgement_markdown, acknowledgement_from, acknowledgement_status FROM access_requests WHERE email = ?`)
    .bind(email).first<RequestRow>();
  if (!row) throw new Error('Access request was not persisted');
  if (row.acknowledgement_status === 'sent' || row.acknowledgement_status === 'skipped') return;
  try {
    const status = await sendResendEmail(env, {
      recipientEmail: email,
      subject: row.acknowledgement_subject,
      from: row.acknowledgement_from,
      html: `<div style="background:#111210;color:#ecebe5;padding:32px;font-family:Arial,sans-serif">${markdownToEmailHtml(row.acknowledgement_markdown)}</div>`,
      text: markdownToEmailText(row.acknowledgement_markdown),
      idempotencyKey: `rally-access-request/${row.id}`,
      category: 'access_request', region: 'global', sender: 'transactional',
      errors: {
        unavailable: { code: 'access_email_unavailable', message: 'Your request was saved, but the confirmation email is unavailable. Please try again.' },
        failed: { code: 'access_email_failed', message: 'Your request was saved, but the confirmation email could not be sent. Please try again.' },
      },
    });
    await env.DB.prepare(`UPDATE access_requests SET acknowledgement_status = ?, acknowledged_at = ? WHERE id = ?`)
      .bind(status, status === 'sent' ? new Date().toISOString() : null, row.id).run();
  } catch (error) {
    // A concurrent successful attempt must not be overwritten by a failed one.
    await env.DB.prepare(`UPDATE access_requests SET acknowledgement_status = 'failed'
      WHERE id = ? AND acknowledgement_status NOT IN ('sent', 'skipped')`).bind(row.id).run();
    throw error;
  }
}
