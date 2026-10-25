import { messageExportDate, messageExportFileName, type MessageExportResult } from '../../common/message-export';
import { renderToHtml, saveRenderedExport } from '../lib/message-export';
import type { Message } from '../lib/types';
import type { CitationContext } from './markdown-citations';
import { MarkdownBody } from './workstream-blocks';

/**
 * Saving a whole Thread or Breakout as a PDF: every text block in it, in
 * order, each under who said it and when. The card, Chromium and the save
 * dialog are the single-message export's; this only decides what goes on the
 * page. [`docs/message-export.md`](../../../../../docs/message-export.md) owns
 * the design.
 */

export interface ConversationExportTurn {
  id: string;
  author: string;
  createdAt: string;
  text: string;
  /** A person's words, drawn as typed, as the feed draws them. */
  human: boolean;
  mentions: NonNullable<Message['mentions']>;
}

/**
 * The turns a conversation's PDF prints: what people and Rally said, and a
 * Sidekick's delivered results. The machinery around them (thinking, tools,
 * system notes, questions) is how an answer was made, not part of what was
 * said, and is left out, and so is anything not finished being said: a turn
 * still streaming, or a message not yet delivered. Names follow the feed's byline.
 */
export function conversationExportTurns(messages: readonly Message[]): ConversationExportTurn[] {
  return messages.flatMap((message) => {
    const text = message.text?.trim();
    if (!text || message.deliveryState || message.streaming) return [];
    if (message.messageType !== 'text' && message.messageType !== 'automation_activation') return [];
    if (message.authorType === 'system') return [];
    const human = message.authorType === 'human' || message.authorType === 'external';
    const provider = message.importProvenance?.source.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
    const author = message.importProvenance ? (human ? `${provider} user` : provider)
      : message.authorType === 'external' ? `${message.externalActor?.displayName ?? 'Slack workspace member'} · Slack`
      : human ? message.author?.name ?? 'Organization member'
      : message.messageType === 'automation_activation' ? message.automationActivation?.automationName ?? 'Sidekick'
      : 'Rally';
    return [{ id: message.id, author, createdAt: message.createdAt, text: message.text!, human, mentions: message.mentions ?? [] }];
  });
}

/** The conversation has nothing `conversationExportTurns` would print. */
export class EmptyConversationExportError extends Error {
  constructor() {
    super('This conversation has no messages to export.');
    this.name = 'EmptyConversationExportError';
  }
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

function TurnSection({ citations, turn }: { citations: CitationContext | undefined; turn: ConversationExportTurn }): React.JSX.Element {
  return <section className="export-turn">
    <div className="export-turn-byline">
      <span className="export-turn-author">{turn.author}</span>
      <time className="export-turn-time" dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleString(undefined, TIME_FORMAT)}</time>
    </div>
    <div className="export-turn-body">
      {/* As the feed draws each: a person's words as typed, Rally's with
          their citations. `still` keeps the sources a hover would show. */}
      <MarkdownBody
        {...(turn.human ? {} : citations ? { citations } : {})}
        mentions={turn.mentions}
        preserveLineBreaks={turn.human}
        rallyMentions={turn.human}
        still
        verbatim={turn.human}
      >{turn.text}</MarkdownBody>
    </div>
  </section>;
}

/**
 * Each turn's section, rendered once and kept, so turns can be rendered as
 * their pages arrive and a second export of the same conversation renders
 * only what changed. A section is keyed by everything it draws, and the whole
 * cache by the citation context it was drawn with: a new context (the
 * conversation's resources changed) means a new renderer. The host holds one
 * per open conversation, which is what bounds it.
 */
export class ConversationExportRenderer {
  private readonly rendered = new Map<string, string>();

  constructor(readonly citations: CitationContext | undefined) {}

  /** Renders whatever is not rendered yet and answers every section, in order. */
  sections(messages: readonly Message[]): string[] {
    return conversationExportTurns(messages).map((turn) => {
      const key = JSON.stringify([turn.id, turn.author, turn.createdAt, turn.human, turn.text, turn.mentions]);
      let html = this.rendered.get(key);
      if (html === undefined) {
        html = renderToHtml(<TurnSection citations={this.citations} turn={turn} />);
        this.rendered.set(key, html);
      }
      return html;
    });
  }
}

export async function saveConversationExport(input: {
  title: string;
  messages: readonly Message[];
  renderer: ConversationExportRenderer;
}): Promise<MessageExportResult> {
  const sections = input.renderer.sections(input.messages);
  if (sections.length === 0) throw new EmptyConversationExportError();
  const title = input.title ? renderToHtml(<h1 className="export-conversation-title">{input.title}</h1>) : '';
  return await saveRenderedExport({
    contentHtml: title + sections.join(''),
    fileName: messageExportFileName(input.title || conversationExportTurns(input.messages)[0]!.text, messageExportDate(new Date())),
    format: 'pdf',
    scope: 'conversation',
  });
}
