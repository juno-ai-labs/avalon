import type { ConversationPreview } from "./conversation-preview";
import { singleLine } from "./resend";

/**
 * What a scoped invitation says.
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

/** Two seconds on Rally, for a recipient who has never heard of it and is being asked to sign in to it. */
const ABOUT_RALLY = "Rally keeps each piece of work in one shared conversation, where your team and its Sidekicks work it through together.";

/** Collapsed and trimmed: a name or a title carrying a newline would forge lines in a plain-text email. */
const line = (value: string | null): string => value ? singleLine(value).trim() : "";

export function scopeInvitationEmailText(content: ScopeInvitationEmailContent): string {
  const inviter = line(content.inviterName);
  const workspace = line(content.workspaceName);
  // Degrades to the sentence this email carried before whenever a name is
  // missing, rather than rendering a gap where one should be.
  const heading = inviter && workspace ? `${inviter} invited you to ${workspace} on Rally.`
    : inviter ? `${inviter} invited you to collaborate in Rally.`
    : workspace ? `You have been invited to ${workspace} on Rally.`
    : "You have been invited to collaborate in Rally.";
  return [
    heading,
    "",
    `Sign in with ${content.recipientEmail} and accept:`,
    content.link,
    ...previewLines(content),
    "",
    "This invitation does not grant access until you sign in and accept it.",
    "",
    ABOUT_RALLY,
  ].join("\n");
}

/**
 * The tail of the conversation, below the link rather than above it.
 *
 * Quoted with `>`, and after everything this email says in its own voice,
 * because the turns are written by workspace members: a message ending in a
 * plausible-looking sign-in sentence must not be able to sit where the real one
 * does.
 */
function previewLines(content: ScopeInvitationEmailContent): string[] {
  if (!content.preview || content.preview.turns.length === 0) return [];
  const title = line(content.conversationTitle);
  const earlier = content.preview.earlier;
  return [
    "",
    ...(title ? [title] : []),
    ...(earlier > 0 ? [`${earlier} earlier ${earlier === 1 ? "message" : "messages"}`] : []),
    ...content.preview.turns.flatMap((turn) => ["",
      `> ${line(turn.author) || "A teammate"}: ${turn.text}${turn.truncated ? "…" : ""}`]),
  ];
}
