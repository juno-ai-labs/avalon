export interface ClaudeCodeSessionChoice {
  title: string;
  updatedAt: number;
}

/** Keep both ends of a user-authored title visible in a native macOS menu. */
export function shortenSessionLabel(value: string, length: number): string {
  const glyphs = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), ({ segment }) => segment);
  if (glyphs.length <= length) return value;
  const before = Math.ceil((length - 1) * 0.65);
  return `${glyphs.slice(0, before).join('')}…${glyphs.slice(-(length - before - 1)).join('')}`;
}

export function claudeCodeSessionOption(session: ClaudeCodeSessionChoice, sessions: readonly ClaudeCodeSessionChoice[]): string {
  if (sessions.filter((other) => other.title === session.title).length === 1) return shortenSessionLabel(session.title, 56);
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(session.updatedAt);
  return `${shortenSessionLabel(session.title, 36)} · ${date}`;
}
