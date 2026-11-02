import { renderSidekickMentionMarkdown } from '@rally/contracts/message-mentions';
import type { MentionIdentity } from './api';

export interface ResolvedMentionIdentity {
  type: 'person' | 'connector';
  userId: string | null;
  connectorType: string | null;
  startOffset: number;
  endOffset: number;
}

interface CandidateMatch {
  candidate: MentionIdentity;
  candidateOrder: number;
  bound: boolean;
  startOffset: number;
  endOffset: number;
}

/** Complete the `@query` immediately before the caret with one visible name. */
export function completeMentionAtCaret(
  text: string,
  caret: number,
  label: string,
  selectionEnd: number = caret,
): { text: string; caret: number; startOffset: number; endOffset: number } | null {
  const before = text.slice(0, caret);
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;
  const after = text.slice(Math.max(caret, selectionEnd));
  const separator = /^\s/u.test(after) ? '' : ' ';
  return {
    text: `${before.slice(0, atIndex)}@${label}${separator}${after}`,
    caret: atIndex + label.length + 1 + separator.length,
    startOffset: atIndex,
    endOffset: atIndex + label.length + 1,
  };
}

/**
 * Move selected mention spans through one textarea edit and discard a span
 * when the edit touches its visible `@Name`. Legacy unbound draft identities
 * remain label-based until the user selects them again.
 */
export function rebaseMentionIdentities(
  previousText: string,
  nextText: string,
  mentions: readonly MentionIdentity[],
): MentionIdentity[] {
  if (previousText === nextText) return [...mentions];
  let prefix = 0;
  while (prefix < previousText.length && prefix < nextText.length
    && previousText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previousText.length - prefix && suffix < nextText.length - prefix
    && previousText[previousText.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix += 1;
  const previousEditEnd = previousText.length - suffix;
  const nextEditEnd = nextText.length - suffix;
  const shift = nextEditEnd - previousEditEnd;
  const normalized = nextText.toLowerCase();

  return mentions.flatMap((mention) => {
    if (mention.startOffset === undefined || mention.endOffset === undefined) {
      return normalized.includes(`@${mention.label.toLowerCase()}`) ? [mention] : [];
    }
    if (mention.endOffset <= prefix) return [mention];
    if (mention.startOffset >= previousEditEnd) {
      return [{
        ...mention,
        startOffset: mention.startOffset + shift,
        endOffset: mention.endOffset + shift,
      }];
    }
    return [];
  });
}

/** Align draft spans with the trimmed value sent over the wire. */
export function mentionsInTrimmedText(
  text: string,
  mentions: readonly MentionIdentity[],
): { text: string; mentions: MentionIdentity[] } {
  const withoutLeading = text.trimStart();
  const leadingAdjusted = rebaseMentionIdentities(text, withoutLeading, mentions);
  const trimmed = withoutLeading.trimEnd();
  return {
    text: trimmed,
    mentions: rebaseMentionIdentities(withoutLeading, trimmed, leadingAdjusted),
  };
}

/** One identity per visible range; the same person may be named twice. */
export function upsertMentionIdentity(
  mentions: readonly MentionIdentity[],
  identity: MentionIdentity,
): MentionIdentity[] {
  const bound = identity.startOffset !== undefined && identity.endOffset !== undefined;
  return [
    ...mentions.filter((mention) => !(
      bound
        ? mention.startOffset === identity.startOffset && mention.endOffset === identity.endOffset
        : mention.type === identity.type
          && mention.userId === identity.userId
          && mention.connectorType === identity.connectorType
    )),
    identity,
  ];
}

function visibleMatches(text: string, candidate: MentionIdentity): boolean {
  if (candidate.startOffset === undefined || candidate.endOffset === undefined) return false;
  if (candidate.startOffset < 0 || candidate.endOffset <= candidate.startOffset || candidate.endOffset > text.length) return false;
  const visible = text.slice(candidate.startOffset, candidate.endOffset);
  if (visible.toLowerCase() !== `@${candidate.label}`.toLowerCase()) return false;
  const before = text[candidate.startOffset - 1];
  const after = text[candidate.endOffset];
  return (candidate.startOffset === 0 || /[\s([{]/u.test(before ?? ''))
    && (candidate.endOffset === text.length || /[\s\p{P}]/u.test(after ?? ''));
}

/**
 * Resolve visible mention spans without losing the identity selected for a
 * particular occurrence. Ambiguous hand-typed same-name ranges are omitted;
 * an explicit bound selection is the only evidence that can disambiguate them.
 */
export function resolveMentionPayload(
  text: string,
  selected: readonly MentionIdentity[],
  discovered: readonly MentionIdentity[],
): ResolvedMentionIdentity[] {
  // A Sidekick selection is Markdown by now (`sidekickMentionsAsMarkdown`);
  // one that is not names nothing the server could store.
  const people = selected.filter((candidate) => candidate.type !== 'sidekick');
  const selectedLabels = new Set(people.map((candidate) => candidate.label.toLowerCase()));
  const candidates = [
    ...people.map((candidate) => ({ candidate, bound: candidate.startOffset !== undefined && candidate.endOffset !== undefined })),
    ...discovered
      .filter((candidate) => !selectedLabels.has(candidate.label.toLowerCase()))
      .map((candidate) => ({ candidate, bound: false })),
  ];
  const matches: CandidateMatch[] = [];
  candidates.forEach(({ candidate, bound }, candidateOrder) => {
    if (bound) {
      if (!visibleMatches(text, candidate)) return;
      matches.push({
        candidate,
        candidateOrder,
        bound,
        startOffset: candidate.startOffset!,
        endOffset: candidate.endOffset!,
      });
      return;
    }
    const escaped = candidate.label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const expression = new RegExp(`@${escaped}(?=$|[\\s\\p{P}])`, 'giu');
    for (const match of text.matchAll(expression)) {
      const startOffset = match.index;
      if (startOffset !== 0 && !/[\s([{]/u.test(text[startOffset - 1] ?? '')) continue;
      matches.push({
        candidate,
        candidateOrder,
        bound,
        startOffset,
        endOffset: startOffset + match[0].length,
      });
    }
  });
  matches.sort((left, right) => left.startOffset - right.startOffset
    || right.endOffset - left.endOffset
    || Number(right.bound) - Number(left.bound)
    || left.candidateOrder - right.candidateOrder);

  const resolved: ResolvedMentionIdentity[] = [];
  let cursor = 0;
  for (let index = 0; index < matches.length;) {
    const first = matches[index]!;
    const sameRange = matches.slice(index).filter((match) => (
      match.startOffset === first.startOffset && match.endOffset === first.endOffset
    ));
    index += sameRange.length;
    if (first.startOffset < cursor) continue;
    const bound = sameRange.filter((match) => match.bound);
    const eligible = bound.length > 0 ? bound : sameRange;
    const targets = new Set(eligible.map((match) => (
      `${match.candidate.type}:${match.candidate.userId ?? ''}:${match.candidate.connectorType ?? ''}`
    )));
    // Plain text cannot identify which of two same-named people the author
    // meant. Persist no identity rather than attaching the wrong one.
    if (targets.size !== 1) {
      cursor = first.endOffset;
      continue;
    }
    const chosen = eligible[0]!;
    if (chosen.candidate.type === 'sidekick') {
      cursor = first.endOffset;
      continue;
    }
    resolved.push({
      type: chosen.candidate.type,
      userId: chosen.candidate.userId,
      connectorType: chosen.candidate.connectorType,
      startOffset: chosen.startOffset,
      endOffset: chosen.endOffset,
    });
    cursor = chosen.endOffset;
  }
  return resolved;
}

/**
 * Turn each Sidekick picked from the mention list into its durable
 * `[@Name](sidekick://<id>)` link, and move every other selection by the
 * length that link adds before it.
 *
 * Done in the draft rather than on the server because a Sidekick mention has
 * no mention row to resolve: it is a reference, not a grant, so the text is
 * the whole of it. A selection whose visible `@Name` was edited away is
 * dropped and its text left as typed, the same rule a person selection follows.
 */
export function sidekickMentionsAsMarkdown(
  text: string,
  mentions: readonly MentionIdentity[],
): { text: string; mentions: MentionIdentity[] } {
  const sidekicks = mentions
    .filter((mention) => mention.type === 'sidekick' && mention.sidekickId && visibleMatches(text, mention))
    .sort((left, right) => left.startOffset! - right.startOffset!);
  if (sidekicks.length === 0) {
    return { text, mentions: mentions.filter((mention) => mention.type !== 'sidekick') };
  }
  const replaced: Array<{ start: number; end: number; shift: number }> = [];
  let output = '';
  let cursor = 0;
  let shift = 0;
  for (const mention of sidekicks) {
    const start = mention.startOffset!;
    const end = mention.endOffset!;
    if (start < cursor) continue;
    const link = renderSidekickMentionMarkdown({ id: mention.sidekickId!, name: mention.label });
    output += text.slice(cursor, start) + link;
    shift += link.length - (end - start);
    replaced.push({ start, end, shift });
    cursor = end;
  }
  output += text.slice(cursor);
  const others = mentions.flatMap((mention) => {
    if (mention.type === 'sidekick') return [];
    if (mention.startOffset === undefined || mention.endOffset === undefined) return [mention];
    const { startOffset, endOffset } = mention;
    if (replaced.some((range) => startOffset < range.end && endOffset > range.start)) return [];
    const offset = replaced.filter((range) => range.end <= startOffset).at(-1)?.shift ?? 0;
    return [{ ...mention, startOffset: startOffset + offset, endOffset: endOffset + offset }];
  });
  return { text: output, mentions: others };
}
