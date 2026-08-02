import clsx from 'clsx';
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Copy,
  FileText,
  LoaderCircle,
  Pin,
  Sparkles,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Highlight, type Language, type PrismTheme } from 'prism-react-renderer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDuration, formatRelative } from '../lib/format';
import type { ActivitySuggestionData, ElicitationData, Message } from '../lib/types';
import { Badge, Button, InlineError } from './primitives';

function personAccent(id: string): string {
  const palette = ['#8db6de', '#c79bd5', '#81bfa5', '#d2a47f', '#a6a0d9', '#cf9ba2'];
  const hash = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return palette[hash % palette.length] ?? palette[0]!;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 8_000 ? `${text.slice(0, 8_000)}\n…` : text;
  } catch {
    return 'Details unavailable';
  }
}

const markdownCodeTheme: PrismTheme = {
  plain: { backgroundColor: 'transparent', color: '#e5e4df' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#777772' } },
    { types: ['punctuation'], style: { color: '#aaa9a3' } },
    { types: ['namespace'], style: { opacity: 0.72 } },
    { types: ['tag', 'constant', 'symbol', 'deleted'], style: { color: '#ff8a50' } },
    { types: ['boolean', 'number'], style: { color: '#e6a06b' } },
    { types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'], style: { color: '#b995f5' } },
    { types: ['operator', 'entity', 'url'], style: { color: '#d8d7d2' } },
    { types: ['atrule', 'attr-value', 'keyword'], style: { color: '#ff7b2c' } },
    { types: ['function'], style: { color: '#17a9f5' } },
    { types: ['regex', 'important', 'variable'], style: { color: '#e8b75c' } },
    { types: ['important', 'bold'], style: { fontWeight: '700' } },
    { types: ['italic'], style: { fontStyle: 'italic' } },
    { types: ['class-name', 'maybe-class-name'], style: { color: '#b995f5' } },
  ],
};

const markdownLanguageAliases: Record<string, Language> = {
  cs: 'csharp',
  html: 'markup',
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  text: 'plain',
  ts: 'typescript',
  txt: 'plain',
  yml: 'yaml',
  zsh: 'bash',
};

function MarkdownCodeBlock({ code, language }: { code: string; language: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const highlightedLanguage = markdownLanguageAliases[language] ?? language ?? 'plain';

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="markdown-code-block" data-language={language || 'plain'}>
      <Highlight code={code} language={highlightedLanguage} theme={markdownCodeTheme}>
        {({ className, getLineProps, getTokenProps, style, tokens }) => (
          <pre className={className} style={style}>
            <code>
              {tokens.map((line, lineIndex) => (
                <span {...getLineProps({ line })} key={lineIndex}>
                  {line.map((token, tokenIndex) => (
                    <span {...getTokenProps({ token })} key={tokenIndex} />
                  ))}
                  {lineIndex < tokens.length - 1 ? '\n' : null}
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
      <button aria-label={copied ? 'Code copied' : 'Copy code'} onClick={() => void copy()} type="button">
        {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
      </button>
    </div>
  );
}

function MarkdownCode({ children, className }: React.ComponentProps<'code'>): React.JSX.Element {
  const source = String(children ?? '');
  const languageMatch = /(?:^|\s)language-([\w#+.-]+)/u.exec(className ?? '');
  const isBlock = Boolean(languageMatch) || source.endsWith('\n');

  if (!isBlock) return <code className="markdown-inline-code">{children}</code>;

  return (
    <MarkdownCodeBlock
      code={source.replace(/\n$/u, '')}
      language={languageMatch?.[1]?.toLowerCase() ?? 'plain'}
    />
  );
}

function MarkdownBody({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={{
          a: ({ children: linkChildren, ...props }) => <a {...props} rel="noopener noreferrer" target="_blank">{linkChildren}</a>,
          code: MarkdownCode,
          pre: ({ children: preChildren }) => <>{preChildren}</>,
          table: ({ children: tableChildren }) => (
            <div className="markdown-table-scroll">
              <table>{tableChildren}</table>
            </div>
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function ToolBlock({ message }: { message: Message }): React.JSX.Element | null {
  const tool = message.toolEvent;
  if (!tool) return null;
  return (
    <details className={clsx('tool-block', `tool-${tool.status}`)}>
      <summary>
        <span className="tool-icon"><TerminalSquare aria-hidden="true" size={14} /></span>
        <span className="tool-summary">
          <strong>{tool.name}</strong>
          <small>{tool.summary ?? (tool.status === 'started' ? 'Running…' : tool.status)}</small>
        </span>
        <span className="tool-state">
          {tool.status === 'started' && <LoaderCircle aria-hidden="true" className="spin" size={13} />}
          {tool.status === 'completed' && <Check aria-hidden="true" size={13} />}
          {(tool.status === 'failed' || tool.status === 'ambiguous') && <CircleAlert aria-hidden="true" size={13} />}
          <span className="sr-only">{tool.status}</span>
        </span>
        {tool.durationMs !== undefined && <span className="tool-duration">{formatDuration(tool.durationMs)}</span>}
        <ChevronRight aria-hidden="true" className="disclosure-chevron" size={13} />
      </summary>
      <div className="tool-details">
        {tool.input !== undefined && <div><h4>Input</h4><pre>{safeJson(tool.input)}</pre></div>}
        {tool.output !== undefined && <div><h4>Result</h4><pre>{safeJson(tool.output)}</pre></div>}
        {tool.status === 'ambiguous' && <p className="tool-warning">Avalon could not confirm whether this external action completed. It will not retry automatically.</p>}
      </div>
    </details>
  );
}

function ArtifactBlock({ message }: { message: Message }): React.JSX.Element | null {
  const artifact = message.artifact;
  if (!artifact) return null;
  return (
    <button className="artifact-block" type="button">
      <span className="artifact-icon"><FileText aria-hidden="true" size={17} /></span>
      <span><small>{artifact.artifactType}</small><strong>{artifact.title}</strong>{artifact.previewText && <p>{artifact.previewText}</p>}</span>
      <ArrowRight aria-hidden="true" size={15} />
    </button>
  );
}

function ElicitationBlock({
  elicitation,
  onAnswer,
}: {
  elicitation: ElicitationData;
  onAnswer: (answer: unknown) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAnswered = elicitation.status === 'answered';

  const toggle = (value: string): void => {
    if (elicitation.responseType !== 'multi_select') {
      setSelected([value]);
      return;
    }
    setSelected((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  };

  const submit = async (): Promise<void> => {
    const answer = elicitation.responseType === 'text'
      ? text.trim()
      : elicitation.responseType === 'multi_select'
        ? selected
        : selected[0];
    if (!answer || (Array.isArray(answer) && answer.length < (elicitation.minimumSelections ?? 1))) {
      setError('Choose or enter a response before continuing.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(answer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your response could not be saved.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={clsx('elicitation-block', isAnswered && 'is-answered')} aria-labelledby={`elicitation-${elicitation.id}`}>
      <div className="elicitation-heading">
        <span><Sparkles aria-hidden="true" size={15} /></span>
        <div><small>{isAnswered ? 'Answered' : 'Avalon needs input'}</small><h3 id={`elicitation-${elicitation.id}`}>{elicitation.prompt}</h3></div>
      </div>
      {isAnswered ? (
        <div className="answered-value"><Check aria-hidden="true" size={14} /><span>{Array.isArray(elicitation.answer) ? elicitation.answer.join(', ') : String(elicitation.answer ?? 'Response submitted')}</span></div>
      ) : elicitation.responseType === 'text' ? (
        <textarea aria-label="Response" onChange={(event) => setText(event.target.value)} placeholder="Type your response…" rows={3} value={text} />
      ) : (
        <fieldset className="elicitation-options">
          <legend className="sr-only">Response options</legend>
          {elicitation.options?.map((option) => (
            <label className="elicitation-option" key={option.value}>
              <input
                checked={selected.includes(option.value)}
                name={`elicitation-${elicitation.id}`}
                onChange={() => toggle(option.value)}
                type={elicitation.responseType === 'multi_select' ? 'checkbox' : 'radio'}
                value={option.value}
              />
              <span className="option-control" aria-hidden="true" />
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </label>
          ))}
        </fieldset>
      )}
      {!isAnswered && (
        <div className="elicitation-actions">
          {error && <InlineError>{error}</InlineError>}
          <Button className="button-primary" disabled={submitting} onClick={() => void submit()}>
            {submitting && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
            Submit response
          </Button>
        </div>
      )}
    </section>
  );
}

function SuggestionBlock({
  suggestion,
  onResolve,
}: {
  suggestion: ActivitySuggestionData;
  onResolve: (action: 'accept' | 'dismiss') => Promise<void>;
}): React.JSX.Element {
  const [pending, setPending] = useState<'accept' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (action: 'accept' | 'dismiss'): Promise<void> => {
    setPending(action);
    setError(null);
    try {
      await onResolve(action);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The suggestion could not be updated.');
    } finally {
      setPending(null);
    }
  };
  return (
    <section className={clsx('suggestion-block', suggestion.status !== 'pending' && 'is-resolved')}>
      <header>
        <span><Pin aria-hidden="true" size={15} /></span>
        <div><small>Suggested context</small><h3>{suggestion.title}</h3></div>
        {suggestion.source && <Badge>{suggestion.source}</Badge>}
      </header>
      <div className="suggestion-reason"><small>Why</small><p>{suggestion.reason}</p></div>
      {suggestion.status === 'pending' ? (
        <footer>
          <Button disabled={pending !== null} onClick={() => void resolve('dismiss')}><X size={14} /> Dismiss</Button>
          <Button className="button-primary" disabled={pending !== null} onClick={() => void resolve('accept')}>
            {pending === 'accept' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Add to work stream
          </Button>
        </footer>
      ) : (
        <p className="suggestion-resolution"><Check size={13} /> {suggestion.status === 'accepted' ? 'Added to this work stream' : 'Dismissed'}</p>
      )}
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}

interface MessageBlockProps {
  currentUserId?: string;
  message: Message;
  onAnswerElicitation: (elicitationId: string, answer: unknown) => Promise<void>;
  onResolveSuggestion: (suggestionId: string, action: 'accept' | 'dismiss') => Promise<void>;
}

export function MessageBlock({ currentUserId, message, onAnswerElicitation, onResolveSuggestion }: MessageBlockProps): React.JSX.Element {
  if (message.messageType === 'tool_event') return <div className="transcript-event" id={`message-${message.id}`}><ToolBlock message={message} /></div>;
  if (message.messageType === 'artifact') return <div className="transcript-event" id={`message-${message.id}`}><ArtifactBlock message={message} /></div>;
  if (message.messageType === 'elicitation' && message.elicitation) {
    return <div className="transcript-event" id={`message-${message.id}`}><ElicitationBlock elicitation={message.elicitation} onAnswer={(answer) => onAnswerElicitation(message.elicitation!.id, answer)} /></div>;
  }
  if (message.messageType === 'activity_suggestion' && message.activitySuggestion) {
    return <div className="transcript-event" id={`message-${message.id}`}><SuggestionBlock onResolve={(action) => onResolveSuggestion(message.activitySuggestion!.id, action)} suggestion={message.activitySuggestion} /></div>;
  }
  if (message.authorType === 'system' || message.messageType === 'system') {
    return <div className="system-message" id={`message-${message.id}`}><span />{message.text}</div>;
  }

  const human = message.authorType === 'human';
  const ownHumanMessage = human && currentUserId !== undefined && message.author?.id === currentUserId;
  const humanAuthorName = message.author?.name ?? 'Workspace member';
  return (
    <article
      aria-label={human ? `Message from ${humanAuthorName}` : undefined}
      aria-busy={message.streaming || undefined}
      className={clsx(
        'message-block',
        human ? 'human-message' : 'agent-message',
        human && (ownHumanMessage ? 'own-human-message' : 'coworker-message'),
        message.streaming && 'is-streaming',
      )}
      id={`message-${message.id}`}
      style={human ? { '--person-accent': personAccent(message.author?.id ?? message.id) } as React.CSSProperties : undefined}
    >
      {(!human || !ownHumanMessage) && (
        <header>
          {human && <span aria-hidden="true" className="message-author-dot" />}
          <span className="message-author">{human ? humanAuthorName : 'Avalon'}</span>
          <time dateTime={message.createdAt}>{formatRelative(message.createdAt)}</time>
        </header>
      )}
      {message.text && <MarkdownBody>{message.text}</MarkdownBody>}
      {!human && !message.streaming && (
        <footer className="agent-message-actions">
          <button aria-label="Copy response" onClick={() => void navigator.clipboard.writeText(message.text ?? '')} type="button"><Clipboard size={12} /> Copy</button>
        </footer>
      )}
      {message.streaming && <span className="streaming-caret" aria-hidden="true" />}
    </article>
  );
}
