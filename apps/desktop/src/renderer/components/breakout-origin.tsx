import { formatDateTime } from '../lib/format';
import type { Message } from '../lib/types';

/** How many of the Channel's messages before the origin are shown for context. */
const ORIGIN_CONTEXT_MESSAGES = 3;

/**
 * The Channel messages a Breakout opens under: the one it started from, and
 * up to three said before it, oldest first.
 *
 * Only what people and Rally said — tool rows and notes are how a turn was
 * made, not what was said in it. A turn can carry several text rows, so the
 * origin is the last row of its turn. An origin outside the Channel's loaded
 * window is not an error: the Breakout is still the one asked for, and its
 * origin is simply not on the client to draw.
 */
export function breakoutOriginMessages(
  channelTranscript: readonly Message[],
  originTurnId: string | null | undefined,
): { context: Message[]; origin: Message } | null {
  if (!originTurnId) return null;
  const said = channelTranscript.filter((message) => message.messageType === 'text'
    && (message.authorType === 'human' || message.authorType === 'agent' || message.authorType === 'external')
    && (message.text ?? '').trim() !== '');
  let index = -1;
  said.forEach((message, position) => {
    if (message.transcriptTurnId === originTurnId) index = position;
  });
  if (index < 0) return null;
  return {
    context: said.slice(Math.max(0, index - ORIGIN_CONTEXT_MESSAGES), index),
    origin: said[index]!,
  };
}

/** Markdown read as a line of plain text, for an excerpt rather than a render. */
export function originExcerpt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/(\*\*|__)(.+?)\1/gu, '$2')
    // A single marker only where it wraps words, so `New_York` keeps its underscore.
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/gu, '$1$2')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function byline(message: Message): string {
  return message.authorType === 'agent' ? 'Rally' : message.author?.name ?? message.externalActor?.displayName ?? 'Someone';
}

/**
 * The top of a Breakout: the Channel message it started from, as a card, with
 * the few messages before it fading in above so the reader has the lead-up
 * without the Channel taking over the Breakout.
 */
export function BreakoutOrigin({ channelTitle, context, origin }: {
  channelTitle: string;
  context: readonly Message[];
  origin: Message;
}): React.JSX.Element {
  return (
    <section aria-label="Where this breakout started" className="breakout-origin">
      {context.length > 0 && (
        <ol className="breakout-origin-context">
          {context.map((message, index) => (
            <li
              className="breakout-origin-context-item"
              key={message.id}
              // Oldest faintest; each nearer message a step clearer.
              style={{ '--origin-step': context.length - index } as React.CSSProperties}
            >
              <span className="breakout-origin-author">{byline(message)}</span>
              <span className="breakout-origin-context-text">{originExcerpt(message.text ?? '')}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="breakout-origin-card">
        <span className="breakout-origin-byline">
          {byline(origin)} · {formatDateTime(origin.createdAt)} · in {channelTitle}
        </span>
        <span className="breakout-origin-text">{originExcerpt(origin.text ?? '')}</span>
      </div>
    </section>
  );
}
