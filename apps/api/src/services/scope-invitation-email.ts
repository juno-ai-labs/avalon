import type { ConversationPreview } from "./conversation-preview";
import { escapeHtml, singleLine } from "./resend";

/**
 * What a scoped invitation says, in both parts of the same message.
 *
 * Its old body named nobody and nothing: a link, and a sentence about signing
 * in. A recipient could not tell who was asking, what for, or whether the mail
 * was meant for them, and the address it was sent to was often the only clue
 * that it was real. So it now leads with the person and the workspace, and
 * shows the end of the conversation being offered.
 *
 * **That content leaves the product to an address nobody has authenticated.**
 * The sharer chose the address and can read everything they are sharing, which
 * is the authority this rests on, and the preview is drawn from the offered
 * scope alone. A mistyped address still receives it, and a revoked invitation
 * cannot unsend it. `docs/scope-invitations.md` records that decision.
 */
export interface ScopeInvitationEmailContent {
  recipientEmail: string;
  link: string;
  inviterName: string | null;
  workspaceName: string | null;
  conversationTitle: string | null;
  preview: ConversationPreview | null;
}

/**
 * How much of the conversation this email shows.
 *
 * The product owner asked for five turns at a hundred words each: enough for a
 * recipient to recognize the work, short enough that a long thread does not
 * arrive in their mailbox.
 *
 * `PREVIEW_BYTES` is the size those words are allowed to weigh, which is a
 * different question and not the product owner's to answer. A word limit is not
 * a size limit — a message with no spaces is one word however long it is — and
 * the ceiling is Gmail's: it clips a message past 102,400 bytes and hides the
 * rest behind "view entire message", which would take the footer and the link
 * with it (https://support.google.com/mail/answer/81126, read 2026-09-19). The
 * arithmetic from there is: leave 8 KiB for everything that is not a quoted
 * turn, divide what remains across the five of them, and divide again by six
 * because that is the longest entity `escapeHtml` produces (`&quot;`), so a
 * turn made entirely of quote characters still fits.
 */
export const PREVIEW_TURNS = 5;
export const PREVIEW_WORDS = 100;
const GMAIL_CLIP_BYTES = 102_400;
const TEMPLATE_BYTES = 8 * 1024;
const MAX_ESCAPE_EXPANSION = 6;
export const PREVIEW_BYTES = Math.floor((GMAIL_CLIP_BYTES - TEMPLATE_BYTES) / (PREVIEW_TURNS * MAX_ESCAPE_EXPANSION));

/** Two seconds on Rally, for a recipient who has never heard of it and is being asked to sign in to it. */
const ABOUT_RALLY = "Rally keeps each piece of work in one shared conversation, where your team and its Sidekicks work it through together.";

const NOT_ACCESS_YET = "This invitation does not grant access until you sign in and accept it.";

/** Collapsed and trimmed: a name or a title carrying a newline would forge lines in the text part. */
const line = (value: string | null): string => value ? singleLine(value).trim() : "";

/** One reading of the content, so the two parts of the message cannot say different things. */
function view(content: ScopeInvitationEmailContent) {
  const inviter = line(content.inviterName);
  const workspace = line(content.workspaceName);
  const turns = content.preview?.turns ?? [];
  return {
    inviter,
    workspace,
    // Degrades to the sentence this email carried before whenever a name is
    // missing, rather than rendering a gap where one should be.
    heading: inviter && workspace ? `${inviter} invited you to ${workspace} on Rally.`
      : inviter ? `${inviter} invited you to collaborate in Rally.`
      : workspace ? `You have been invited to ${workspace} on Rally.`
      : "You have been invited to collaborate in Rally.",
    title: line(content.conversationTitle),
    earlier: content.preview && content.preview.earlier > 0
      ? `${content.preview.earlier} earlier ${content.preview.earlier === 1 ? "message" : "messages"}` : "",
    turns: turns.map((turn) => ({
      author: line(turn.author) || "A teammate",
      text: `${turn.text}${turn.truncated ? "…" : ""}`,
    })),
  };
}

/** Both parts of the invitation. A client that strips the HTML still gets everything the message says. */
export function scopeInvitationEmailParts(content: ScopeInvitationEmailContent): { text: string; html: string } {
  const rendered = view(content);
  return { text: textPart(content, rendered), html: htmlPart(content, rendered) };
}

function textPart(content: ScopeInvitationEmailContent, rendered: ReturnType<typeof view>): string {
  return [
    rendered.heading,
    "",
    `Sign in with ${content.recipientEmail} and accept:`,
    content.link,
    // Quoted with `>`, and after everything this email says in its own voice,
    // because the turns are written by workspace members: a message ending in a
    // plausible-looking sign-in sentence must not be able to sit where the real
    // one does.
    ...(rendered.turns.length === 0 ? [] : ["",
      ...(rendered.title ? [rendered.title] : []),
      ...(rendered.earlier ? [rendered.earlier] : []),
      ...rendered.turns.flatMap((turn) => ["", `> ${turn.author}: ${turn.text}`])]),
    "",
    NOT_ACCESS_YET,
    "",
    ABOUT_RALLY,
  ].join("\n");
}

/**
 * The same message, styled the way Rally's other invitation is.
 *
 * Tables and inline styles only, because that is what every client this is read
 * in agrees on: Gmail drops a `<style>` block in several of its surfaces, so
 * anything load-bearing has to be on the element. No flexbox, no grid, no
 * positioning, no `@font-face`, no background images — all of them fail
 * somewhere popular, and none of them is needed to lay out one column. The one
 * remote asset is the brand mark, and the layout does not depend on it loading.
 *
 * `max-width` with `width:100%` is the whole of the responsive behaviour, which
 * is why there is no media query to lose. Long unbroken strings wrap through
 * `overflow-wrap:anywhere` on the card rather than widening it.
 */
function htmlPart(content: ScopeInvitationEmailContent, rendered: ReturnType<typeof view>): string {
  const link = escapeHtml(content.link);
  const sentence = rendered.inviter && rendered.workspace
    ? `${escapeHtml(rendered.inviter)} invited you to <strong style="color:#141414">${escapeHtml(rendered.workspace)}</strong> on Rally.`
    : escapeHtml(rendered.heading);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
  </head>
  <body style="margin:0;background:#ffffff;color:#141414;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;table-layout:fixed;overflow-wrap:anywhere;background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;padding:28px">
          <tr><td><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:10px;vertical-align:middle"><img src="https://rallywith.ai/brand/rally-mark-email.png" width="32" height="32" alt="" style="display:block;border:0"></td><td style="font-size:18px;font-weight:700;color:#141414;vertical-align:middle">Rally</td></tr></table></td></tr>
          <tr><td><h1 style="margin:18px 0 12px;font-size:28px;line-height:1.2;color:#141414">${escapeHtml(rendered.title || rendered.workspace || "Join the conversation")}</h1></td></tr>
          <tr><td style="font-size:16px;line-height:1.6;color:#3d3d3d">${sentence}</td></tr>
          <tr><td style="padding-top:8px;font-size:16px;line-height:1.6;color:#3d3d3d">Sign in with <strong style="color:#141414">${escapeHtml(content.recipientEmail)}</strong> to accept.</td></tr>
          <tr><td style="padding:28px 0"><a href="${link}" style="display:inline-block;background:#070707;color:#fcfcfc;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:8px">Accept invitation</a></td></tr>
          ${previewRows(rendered)}
          <tr><td style="font-size:13px;line-height:1.6;color:#696969">${NOT_ACCESS_YET}</td></tr>
          <tr><td style="padding-top:24px;font-size:12px;line-height:1.5;color:#696969;border-top:1px solid #e5e5e5">${ABOUT_RALLY}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/**
 * The quoted turns, below the button for the same reason the text part puts
 * them below the link: they are written by workspace members, and a message
 * ending in its own sign-in sentence must not sit above ours. The rule down the
 * left is a border on the cell, which every client renders.
 */
function previewRows(rendered: ReturnType<typeof view>): string {
  if (rendered.turns.length === 0) return "";
  const header = rendered.earlier
    ? `<tr><td style="padding-bottom:8px;font-size:12px;line-height:1.5;color:#696969">${escapeHtml(rendered.earlier)}</td></tr>`
    : "";
  const turns = rendered.turns.map((turn) =>
    `<tr><td style="padding-bottom:14px"><div style="font-size:13px;font-weight:700;color:#141414;padding-bottom:2px">${escapeHtml(turn.author)}</div><div style="font-size:14px;line-height:1.6;color:#3d3d3d">${escapeHtml(turn.text)}</div></td></tr>`).join("");
  return `<tr><td style="padding-bottom:24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed">
            <tr><td style="border-left:3px solid #e5e5e5;padding:2px 0 2px 14px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${header}${turns}</table></td></tr>
          </table></td></tr>`;
}
