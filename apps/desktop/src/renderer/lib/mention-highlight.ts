/**
 * Splits composer text into plain runs and `@resource` runs so the composer can
 * paint a highlight behind the tokens a message will actually resolve to.
 *
 * Only labels the workspace knows about are highlighted: a half-typed `@ada`
 * stays plain until it names a real person or connection, which keeps the
 * highlight an honest signal that the mention will be delivered.
 */
export type MentionHighlightSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string };

/** Characters that may precede an `@` — mirrors the mention detection used when sending. */
const OPENING_BOUNDARY = /[\s([{]/u;
/** Characters that may follow a mention label without breaking it. */
const CLOSING_BOUNDARY = /[\s\p{P}]/u;

function isOpeningBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  return OPENING_BOUNDARY.test(value.charAt(index - 1));
}

function isClosingBoundary(value: string, index: number): boolean {
  if (index >= value.length) return true;
  return CLOSING_BOUNDARY.test(value.charAt(index));
}

function matchLabelAt(value: string, index: number, labels: string[]): string | null {
  for (const label of labels) {
    // Sliced by the label's own length, never a case-folded one: lowercasing can
    // change length (`İ` folds to two code units), and slicing by the folded
    // length would miss a mention the send path still resolves.
    const candidate = value.slice(index, index + label.length);
    if (candidate.length !== label.length) continue;
    // `toLowerCase`, not `toLocaleLowerCase`: the send path matches with a
    // case-insensitive regex, whose folding does not follow the host locale.
    // A Turkish locale must not make the highlight disagree with what is sent.
    if (candidate.toLowerCase() !== label.toLowerCase()) continue;
    if (!isClosingBoundary(value, index + label.length)) continue;
    return candidate;
  }
  return null;
}

/** Deduplicates case-insensitively and orders longest-first so `@Ada Lovelace` wins over `@Ada`. */
export function normalizeMentionLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (trimmed.length === 0 || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    unique.push(trimmed);
  }
  return unique.sort((left, right) => right.length - left.length);
}

export function splitMentionHighlights(value: string, labels: readonly string[]): MentionHighlightSegment[] {
  const normalized = normalizeMentionLabels(labels);
  if (value.length === 0 || normalized.length === 0) {
    return value.length > 0 ? [{ kind: 'text', text: value }] : [];
  }
  const segments: MentionHighlightSegment[] = [];
  let plainStart = 0;
  let cursor = 0;
  while (cursor < value.length) {
    const at = value.indexOf('@', cursor);
    if (at === -1) break;
    const label = isOpeningBoundary(value, at) ? matchLabelAt(value, at + 1, normalized) : null;
    if (label === null) {
      cursor = at + 1;
      continue;
    }
    if (at > plainStart) segments.push({ kind: 'text', text: value.slice(plainStart, at) });
    segments.push({ kind: 'mention', text: `@${label}` });
    cursor = at + 1 + label.length;
    plainStart = cursor;
  }
  if (plainStart < value.length) segments.push({ kind: 'text', text: value.slice(plainStart) });
  return segments;
}
