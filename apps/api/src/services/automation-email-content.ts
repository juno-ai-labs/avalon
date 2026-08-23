import type { AutomationResultEmail } from "./automation-email-service";
import { COLOR, markdownToEmailHtml, markdownToEmailPreheader, RULE_STYLE } from "./email-markdown";
import { escapeHtml } from "./resend";

/**
 * The automation result email.
 *
 * The body is the run's final message, which is Markdown — the same text the
 * work stream shows. A mail client renders none of it, so it goes through the
 * shared `email-markdown` renderer rather than being escaped and line-broken:
 * before that, a briefing arrived as `## Heading` and `**bold**` in the
 * reader's inbox. The shell around it is the digest email's, because the two
 * are the same product arriving the same way.
 *
 * It is a module of its own, beside `digest-email-content.ts` and for the same
 * reason: the sending service reaches Cloudflare-only bindings, and a template
 * that cannot be imported without them is a template nobody can render to look
 * at.
 */

/** What the shell says above the body when the run produced no result. */
const OUTCOME_STATE: Record<AutomationResultEmail["outcomeStatus"], string> = {
  completed: "",
  needs_input: "This run stopped and needs an answer from you before it can continue.",
  failed: "This run did not finish. What it managed to report is below.",
  stopped: "This run was stopped before it finished.",
};


/**
 * Exported for `scripts/preview-automation-email.mjs`, which renders it for
 * somebody to look at. A component test asserts the markup contains a string;
 * only opening the file says whether a long briefing holds together.
 */
export function automationResultEmailHtml(input: {
  name: string;
  heading: string;
  ran: string;
  outcomeStatus: AutomationResultEmail["outcomeStatus"];
  body: string;
  workstreamUrl: string;
}): string {
  const heading = escapeHtml(input.heading);
  const name = escapeHtml(input.name);
  const workstreamUrl = escapeHtml(input.workstreamUrl);
  // What a phone shows beside the subject: the result's own opening words,
  // which are what decide whether this is read now or later.
  const preheader = escapeHtml(markdownToEmailPreheader(input.body));
  // A run that failed, stopped, or is waiting arrives in the same shell as a
  // briefing. Without this line the reader has brand furniture, a heading that
  // promises a result, and one unexplained sentence where the result should be.
  const state = OUTCOME_STATE[input.outcomeStatus];
  return `<!doctype html>
<html lang="en" style="color-scheme:dark;supported-color-schemes:dark;height:100%;background:${COLOR.canvas}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <title>${heading}</title>
  </head>
  <body style="margin:0;padding:0;width:100%;height:100%;background:${COLOR.canvas};color:${COLOR.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLOR.canvas};padding:36px 14px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">

          <tr><td style="padding:0 4px 14px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${COLOR.brand}">Avalon</td>
              <td align="right" style="font-size:12px;color:${COLOR.muted}">Automation</td>
            </tr></table>
          </td></tr>

          <tr><td style="background:${COLOR.surface};border:1px solid ${COLOR.line};border-radius:16px;padding:32px 30px">

            <h1 style="margin:0 0 6px;font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-.02em;color:${COLOR.ink}">${heading}</h1>
            <p style="margin:0 0 18px;font-size:13px;line-height:1.5;color:${COLOR.mutedDeep}">${escapeHtml(input.ran)}</p>
            ${state ? `<p style="margin:0 0 18px;padding:10px 14px;background:${COLOR.surfaceRaised};border-left:3px solid ${COLOR.mutedDeep};border-radius:0 8px 8px 0;font-size:14px;line-height:1.5;color:${COLOR.muted}">${state}</p>` : ""}

            <hr style="${RULE_STYLE}">

            ${markdownToEmailHtml(input.body)}

            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:30px"><tr><td style="border-radius:10px;background:${COLOR.brand}">
              <a href="${workstreamUrl}" style="display:inline-block;padding:13px 22px;font-size:14px;font-weight:700;color:${COLOR.onBrand};text-decoration:none">Open in Avalon &rarr;</a>
            </td></tr></table>

          </td></tr>

          <tr><td style="padding:20px 4px 0">
            <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${COLOR.muted}">Sent by your Avalon automation “${name}”. Generated by AI — check anything important.</p>
            <p style="margin:0;font-size:12px;line-height:1.6;color:${COLOR.muted}">To stop these emails, delete the automation in Avalon.</p>
          </td></tr>

        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
