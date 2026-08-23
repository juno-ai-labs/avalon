import { COLOR, markdownToEmailHtml, RULE_STYLE } from "./email-markdown";
import { escapeHtml } from "./resend";

/**
 * The digest email.
 *
 * Dark, and deliberately only dark: it is a copy of an Avalon surface, and the
 * app has one appearance. Every colour is the app's own token, written inline —
 * a mail client will strip a `<style>` block, and several rewrite a page that
 * declares a light scheme, so the palette is stated on the elements themselves
 * and stays put. The canvas is also asked to fill the reading pane rather than
 * stop at the last line — see `digestEmailHtml`.
 *
 * The body it wraps is model-authored Markdown, rendered by the shared
 * `email-markdown` renderer that every Avalon email uses.
 */

export interface DigestEmailContent {
  recipientName: string;
  workspaceName: string;
  /** e.g. "Tuesday 11 August · 9:00 AM" in the reader's own timezone. */
  occurrenceLabel: string;
  bodyMarkdown: string;
  itemCount: number;
  highlightCount: number;
  /** Where the reader goes to see everything, and where they change the schedule. */
  appUrl: string;
  settingsUrl: string;
}

function pill(text: string, options: { accent?: boolean } = {}): string {
  const style = options.accent
    ? `display:inline-block;padding:5px 11px;border-radius:999px;background:${COLOR.brand};color:${COLOR.onBrand};font-size:12px;font-weight:700;letter-spacing:.01em`
    : `display:inline-block;padding:5px 11px;border-radius:999px;background:${COLOR.surfaceRaised};border:1px solid ${COLOR.line};color:${COLOR.muted};font-size:12px;font-weight:600`;
  return `<span style="${style}">${escapeHtml(text)}</span>`;
}

export function digestEmailHtml(content: DigestEmailContent): string {
  const recipientName = escapeHtml(content.recipientName);
  const workspaceName = escapeHtml(content.workspaceName);
  const occurrence = escapeHtml(content.occurrenceLabel);
  const appUrl = escapeHtml(content.appUrl);
  const settingsUrl = escapeHtml(content.settingsUrl);
  const items = `${content.itemCount} update${content.itemCount === 1 ? "" : "s"}`;
  // The preheader is what a phone shows next to the subject, so it carries the
  // one number that decides whether this gets opened now or later.
  const preheader = content.highlightCount > 0
    ? `${content.highlightCount} need${content.highlightCount === 1 ? "s" : ""} you · ${items} in ${content.workspaceName}`
    : `${items} in ${content.workspaceName}`;

  // `height:100%` on the document and body, so a short digest does not end in a
  // hard edge with the client's own white below it.
  //
  // A body background normally propagates to the canvas and paints the whole
  // pane on its own. What defeats that is a client painting its own background
  // onto `html` — propagation only happens while the root has none — and that
  // is the only case this chain is for: a full-height body paints the pane
  // itself rather than relying on a propagation the client has already broken.
  //
  // A percentage is load-bearing, and a viewport unit would be wrong. Where a
  // webmail client strips `<body>` and injects this markup into its own page,
  // the percentage meets an auto-height ancestor and collapses to nothing,
  // leaving the message the height of its content — which is what a thread card
  // wants. `100vh` there would measure the browser window instead of the pane
  // and hang a tall dark tail off the bottom of the card. Nothing carries a
  // height on the layout table either: the Word engine reads that as a minimum
  // against the page box, which is the same tail in a different client.
  return `<!doctype html>
<html lang="en" style="color-scheme:dark;supported-color-schemes:dark;height:100%;background:${COLOR.canvas}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <title>Your ${workspaceName} digest</title>
  </head>
  <body style="margin:0;padding:0;width:100%;height:100%;background:${COLOR.canvas};color:${COLOR.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLOR.canvas};padding:36px 14px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">

          <tr><td style="padding:0 4px 14px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${COLOR.brand}">Avalon</td>
              <td align="right" style="font-size:12px;color:${COLOR.mutedDeep}">${workspaceName}</td>
            </tr></table>
          </td></tr>

          <tr><td style="background:${COLOR.surface};border:1px solid ${COLOR.line};border-radius:16px;padding:32px 30px">

            <h1 style="margin:0 0 6px;font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-.02em;color:${COLOR.ink}">Your digest</h1>
            <p style="margin:0 0 18px;font-size:13px;line-height:1.5;color:${COLOR.mutedDeep}">${occurrence}</p>
            <p style="margin:0 0 16px">${content.highlightCount > 0 ? `${pill(`${content.highlightCount} for you`, { accent: true })}&nbsp;` : ""}${pill(items)}</p>
            <p style="margin:0 0 4px;font-size:15px;line-height:1.6;color:${COLOR.inkSoft}">${recipientName ? `Hi ${recipientName} — here` : "Here"} is what moved since your last digest.</p>

            <hr style="${RULE_STYLE}">

            ${markdownToEmailHtml(content.bodyMarkdown)}

            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:30px"><tr><td style="border-radius:10px;background:${COLOR.brand}">
              <a href="${appUrl}" style="display:inline-block;padding:13px 22px;font-size:14px;font-weight:700;color:${COLOR.onBrand};text-decoration:none">Open Avalon &rarr;</a>
            </td></tr></table>

          </td></tr>

          <tr><td style="padding:20px 4px 0">
            <p style="margin:0 0 6px;font-size:11.5px;line-height:1.6;color:${COLOR.mutedDeep}">Written by Avalon from activity you already have access to. Generated by AI — check anything important.</p>
            <p style="margin:0;font-size:11.5px;line-height:1.6;color:${COLOR.mutedDeep}"><a href="${settingsUrl}" style="color:${COLOR.muted};text-decoration:underline">Change when you get this</a></p>
          </td></tr>

        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
