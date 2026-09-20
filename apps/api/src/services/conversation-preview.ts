import { ExternalActorSchema } from "@rally/contracts";
import type { Env } from "../env";
import { createMessageObjectPort } from "../runtime/message-port";

/**
 * The last few turns of one conversation, for somewhere outside the product
 * that has to say what the conversation is.
 *
 * The invitation email is the first such place: a recipient deciding whether to
 * sign in is deciding about work they cannot see, and a title alone does not
 * tell them what they are being asked to join. Everything here is therefore
 * written to leave the product: it reads only what people said, it names
 * authors the way the transcript would, and it carries no identifier.
 *
 * It reads exactly one conversation, the one being offered. A preview that
 * widened to a parent or a sibling would put work outside the shared scope into
 * an unauthenticated mailbox, which is the whole thing scoped invitations exist
 * to prevent.
 */

/** Only what was said. Tool output and system notices are not conversation and never leave the product this way. */
const SAID_TEXT = { include: ["text"] } as const;

/**
 * Exact rather than capped.
 *
 * The transcript's own readers bound their counts because they run on every
 * message and every run; this one runs once per invitation, against a local
 * index, and its number is shown to a person. "12 earlier messages" is worth a
 * full count where "99+ earlier messages" would be a ceiling nobody chose.
 */
const UNCAPPED = Number.MAX_SAFE_INTEGER;

/** The agent's name in a preview, because a transcript's own label for it is a UI affordance rather than a name. */
const AGENT_AUTHOR = "Rally";

/** Someone whose profile row is gone or nameless. Never their email: a preview says who spoke, not how to reach them. */
const UNKNOWN_AUTHOR = "A teammate";

export interface ConversationPreviewTurn {
  author: string;
  text: string;
  /** Whether `text` stops short of what was said, so a renderer can say so. */
  truncated: boolean;
}

export interface ConversationPreview {
  /** How many said turns came before the ones here. */
  earlier: number;
  turns: ConversationPreviewTurn[];
}

/**
 * Null when the conversation has said nothing yet, which is not a failure: an
 * invitation to an empty conversation is an ordinary thing to send.
 */
export async function readConversationPreview(env: Env, input: {
  workspaceId: string;
  parentId: string;
  substreamId: string;
  /** How many turns to show, and how much of each. All three belong to whatever is rendering. */
  turns: number;
  words: number;
  /**
   * A ceiling in UTF-8 bytes on one turn, because a word limit is not a size
   * limit: a message with no spaces in it is one word however long it is, and
   * five of those would be as large as the transcript allows.
   */
  bytes: number;
}): Promise<ConversationPreview | null> {
  const port = createMessageObjectPort(env, input.workspaceId, input.parentId, undefined, input.substreamId);
  const rows = await port.saidMessages({ messageTypes: SAID_TEXT, order: "newest", limit: input.turns });
  if (rows.length === 0) return null;
  const said = await port.saidMessageCount({ messageTypes: SAID_TEXT, limit: UNCAPPED });
  const names = await authorNames(env, rows.flatMap((row) => row.author_type === "human" && row.author_user_id ? [row.author_user_id] : []));
  return {
    earlier: Math.max(0, said - rows.length),
    turns: rows.map((row) => ({
      author: row.author_type === "human" ? names.get(row.author_user_id ?? "") ?? UNKNOWN_AUTHOR
        : row.author_type === "external" ? externalName(row.external_actor_json) : AGENT_AUTHOR,
      ...truncateTurn(row.text_content, input.words, input.bytes),
    })),
  };
}

/**
 * Whole words up to `limit`, with the whitespace collapsed.
 *
 * Collapsing is what makes a turn one line wherever this lands: a transcript
 * turn carries the newlines its author typed, and a paragraph break inside a
 * quoted message reads as the end of the quote.
 */
export function truncateWords(text: string, limit: number): { text: string; truncated: boolean } {
  const words = text.trim().split(/\s+/u).filter((word) => word.length > 0);
  return { text: words.slice(0, limit).join(" "), truncated: words.length > limit };
}

const encoder = new TextEncoder();

/**
 * The word limit, and then a hard ceiling in bytes.
 *
 * Both, because they bound different things. The words are what a reader was
 * promised; the bytes are what the thing rendering this can carry, and one
 * unbroken hundred-thousand-character "word" satisfies the first while
 * defeating the second. Cut by code point so a multi-byte character is never
 * split in half, and measure in UTF-8 because that is what a byte budget
 * downstream is counted in.
 */
export function truncateTurn(text: string, words: number, bytes: number): { text: string; truncated: boolean } {
  const byWords = truncateWords(text, words);
  if (encoder.encode(byWords.text).length <= bytes) return byWords;
  const points = [...byWords.text];
  let used = 0;
  let kept = 0;
  while (kept < points.length) {
    const size = encoder.encode(points[kept]!).length;
    if (used + size > bytes) break;
    used += size;
    kept += 1;
  }
  return { text: points.slice(0, kept).join(""), truncated: true };
}

async function authorNames(env: Env, userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await env.DB.prepare(
    `SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`,
  ).bind(...ids).all<{ id: string; name: string | null }>();
  return new Map((rows.results ?? []).flatMap((row) => row.name?.trim() ? [[row.id, row.name.trim()] as const] : []));
}

function externalName(actorJson: string | null): string {
  if (!actorJson) return UNKNOWN_AUTHOR;
  try {
    return ExternalActorSchema.parse(JSON.parse(actorJson)).displayName;
  } catch {
    // An actor this deployment cannot read is still someone who spoke; the
    // preview says so without guessing at a name.
    return UNKNOWN_AUTHOR;
  }
}
