import type { Message } from "./index";
import { personMentionHref, sidekickMentionHref } from "./citations";

type Mention = Message["mentions"][number];

export interface MentionPerson {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface PreparedMention extends Mention {
  displayName?: string | null;
  avatarUrl?: string | null;
}

/**
 * The people a prepared message explicitly mentions, as display names in
 * document order, for surfaces that reason about who a message is aimed at.
 * De-duplicated: a person mentioned twice is one audience entry.
 */
export function mentionedPersonNames(mentions: readonly PreparedMention[]): string[] {
  const names: string[] = [];
  for (const mention of mentions) {
    if (mention.type !== "person" || !mention.displayName) continue;
    if (!names.includes(mention.displayName)) names.push(mention.displayName);
  }
  return names;
}

function escapeMarkdownLabel(label: string): string {
  return label
    .replace(/\\/gu, "\\\\")
    .replace(/\[/gu, "\\[")
    .replace(/\]/gu, "\\]");
}

export function renderPersonMentionMarkdown(person: MentionPerson): string {
  return `[@${escapeMarkdownLabel(person.name)}](${personMentionHref(person.id)})`;
}

/** `[@Name](sidekick://<id>)`, escaped the way a person mention is. */
export function renderSidekickMentionMarkdown(sidekick: { id: string; name: string }): string {
  return `[@${escapeMarkdownLabel(sidekick.name)}](${sidekickMentionHref(sidekick.id)})`;
}

export function isCanonicalPersonMention(
  text: string,
  mention: Pick<Mention, "type" | "userId" | "startOffset" | "endOffset">,
): boolean {
  if (mention.type !== "person" || !mention.userId) return false;
  const value = text.slice(mention.startOffset, mention.endOffset);
  if (!value.startsWith("[@")) return false;
  // House form is person://; bare person: remains canonical for stored text.
  return value.endsWith(`](${personMentionHref(mention.userId)})`)
    || value.endsWith(`](person:${mention.userId})`);
}

function visiblePersonMentionMatches(value: string, person: MentionPerson): boolean {
  return value.localeCompare(`@${person.name}`, undefined, { sensitivity: "accent" }) === 0;
}

/**
 * Turn the composer's visible @Name ranges into durable, identity-bearing
 * Markdown. The database mention rows remain the authorization source of truth;
 * the Markdown target gives models and offline renderers the same stable ID.
 *
 * Shared rather than owned by the writer, because the desktop client builds the
 * optimistic turn it shows while a message is in flight and has to arrive at
 * byte-identical text: the mention chip is rendered *from* this Markdown, so a
 * client that skipped the rewrite showed a plain `@Name` that became a chip —
 * and widened the bubble — the moment the canonical turn landed. A second
 * implementation on the client would have to agree with this one about
 * escaping, overlap, ordering, and which selections are dropped; being the same
 * function is how it agrees.
 *
 * Invalid, overlapping, duplicate, or no-longer-active person mentions are
 * omitted rather than being allowed to create an invisible notification. Plain
 * message text is preserved for every omitted range.
 */
export function prepareMentionMarkdown(
  text: string,
  mentions: Mention[],
  people: ReadonlyMap<string, MentionPerson>,
): { text: string; mentions: PreparedMention[] } {
  const accepted: Array<{
    mention: Mention;
    replacement: string;
    displayName?: string;
    avatarUrl?: string | null;
    inputOrder: number;
  }> = [];
  const occupiedRanges = new Set<string>();

  mentions.forEach((mention, inputOrder) => {
    if (mention.endOffset > text.length || mention.endOffset <= mention.startOffset) return;
    const key = `${mention.startOffset}:${mention.endOffset}`;
    if (occupiedRanges.has(key)) return;

    const source = text.slice(mention.startOffset, mention.endOffset);
    if (mention.type === "person") {
      if (!mention.userId) return;
      const person = people.get(mention.userId);
      if (!person || !visiblePersonMentionMatches(source, person)) return;
      occupiedRanges.add(key);
      accepted.push({
        mention,
        replacement: renderPersonMentionMarkdown(person),
        displayName: person.name,
        avatarUrl: person.avatarUrl,
        inputOrder,
      });
      return;
    }

    // Connector mentions remain human-readable until Avalon has an
    // identity-bearing connector reference contract. Preserve the selected
    // range while still recalculating offsets after earlier person chips.
    if (mention.type === "connector" && mention.connectorType && source.startsWith("@")) {
      occupiedRanges.add(key);
      accepted.push({ mention, replacement: source, inputOrder });
    }
  });

  // Overlapping ranges are resolved by the loop below, which keeps the first and
  // skips anything starting inside it — so this order decides who wins. Longest
  // first at a shared start: a workspace holding both "Bob" and "Bob Builder"
  // emits a range for each against `@Bob Builder`, and the writer meant the
  // longer one. It is also what the composer highlights while the draft is typed.
  accepted.sort((left, right) =>
    left.mention.startOffset - right.mention.startOffset
    || right.mention.endOffset - left.mention.endOffset
    || left.inputOrder - right.inputOrder,
  );

  let cursor = 0;
  let output = "";
  const prepared: PreparedMention[] = [];
  for (const item of accepted) {
    if (item.mention.startOffset < cursor) continue;
    output += text.slice(cursor, item.mention.startOffset);
    const startOffset = output.length;
    output += item.replacement;
    const endOffset = output.length;
    prepared.push({
      type: item.mention.type,
      userId: item.mention.userId,
      connectorType: item.mention.connectorType,
      startOffset,
      endOffset,
      ...(item.displayName ? { displayName: item.displayName } : {}),
      ...(item.avatarUrl !== undefined ? { avatarUrl: item.avatarUrl } : {}),
    });
    cursor = item.mention.endOffset;
  }
  output += text.slice(cursor);
  return { text: output, mentions: prepared };
}
