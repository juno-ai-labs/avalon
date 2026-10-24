import { messageExportDate, messageExportFileName, type MessageExportResult } from '../../common/message-export';
import { saveMessageExport } from '../lib/message-export';
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
 * said, and is left out. Names follow the feed's byline.
 */
export function conversationExportTurns(messages: readonly Message[]): ConversationExportTurn[] {
  return messages.flatMap((message) => {
    const text = message.text?.trim();
    if (!text || message.deliveryState) return [];
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

const TIME_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

export async function saveConversationExport(input: {
  title: string;
  messages: readonly Message[];
  citations?: CitationContext | undefined;
}): Promise<MessageExportResult> {
  const turns = conversationExportTurns(input.messages);
  if (turns.length === 0) throw new Error('This conversation has no messages to export.');
  return await saveMessageExport({
    content: <>
      {input.title && <h1 className="export-conversation-title">{input.title}</h1>}
      {turns.map((turn) => <section className="export-turn" key={turn.id}>
        <div className="export-turn-byline">
          <span className="export-turn-author">{turn.author}</span>
          <time className="export-turn-time" dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleString(undefined, TIME_FORMAT)}</time>
        </div>
        <div className="export-turn-body">
          {/* As the feed draws each: a person's words as typed, Rally's with
              their citations. `still` keeps the sources a hover would show. */}
          <MarkdownBody
            {...(turn.human ? {} : input.citations ? { citations: input.citations } : {})}
            mentions={turn.mentions}
            preserveLineBreaks={turn.human}
            rallyMentions={turn.human}
            still
            verbatim={turn.human}
          >{turn.text}</MarkdownBody>
        </div>
      </section>)}
    </>,
    fileName: messageExportFileName(input.title || turns[0]!.text, messageExportDate(new Date())),
    format: 'pdf',
    scope: 'conversation',
  });
}
