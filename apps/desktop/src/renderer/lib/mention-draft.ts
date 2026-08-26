import type { MentionIdentity } from './api';

/** Complete the `@query` immediately before the caret with one visible name. */
export function completeMentionAtCaret(
  text: string,
  caret: number,
  label: string,
): { text: string; caret: number } | null {
  const before = text.slice(0, caret);
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;
  const after = text.slice(caret);
  const separator = /^\s/u.test(after) ? '' : ' ';
  return {
    text: `${before.slice(0, atIndex)}@${label}${separator}${after}`,
    caret: atIndex + label.length + 1 + separator.length,
  };
}

/** Keep only selected identities whose visible label is still in the draft. */
export function mentionsStillPresent(
  text: string,
  mentions: readonly MentionIdentity[],
): MentionIdentity[] {
  const normalized = text.toLowerCase();
  return mentions.filter((mention) => normalized.includes(`@${mention.label.toLowerCase()}`));
}

/** One identity per provider target, while preserving the latest visible label. */
export function upsertMentionIdentity(
  mentions: readonly MentionIdentity[],
  identity: MentionIdentity,
): MentionIdentity[] {
  return [
    ...mentions.filter((mention) => !(
      mention.type === identity.type
      && mention.userId === identity.userId
      && mention.connectorType === identity.connectorType
    )),
    identity,
  ];
}
