import type { SubstreamInitialContext } from '@rally/contracts/substream-creation';
import { MarkdownBody } from './workstream-blocks';

/** The same read-only selected context in preview and in the created feed. */
export function SubstreamContext({ context }: { context: SubstreamInitialContext }): React.JSX.Element {
  return <div className="substream-context-parts">
    {context.parts.length === 0 && <p>No earlier messages are included.</p>}
    {context.parts.map((part, index) => part.kind === 'summary'
      ? <section className="substream-context-part" key={index} aria-label="Summary">
        <MarkdownBody glance>{part.text}</MarkdownBody>
      </section>
      : <section className="substream-context-part" key={index} aria-label="Selected history">
        {part.messages.map((message) => <article key={message.turnId}>
          <small>{message.authorLabel} · {message.createdAt}</small>
          {message.blocks.map((block, blockIndex) => <div key={blockIndex}>
            <MarkdownBody glance>{block.text}</MarkdownBody>
            {block.attachments.map((attachment) => <p key={attachment.id}>Attachment: {attachment.fileName}</p>)}
          </div>)}
        </article>)}
      </section>)}
  </div>;
}
