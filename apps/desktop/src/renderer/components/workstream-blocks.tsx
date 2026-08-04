import clsx from 'clsx';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Copy,
  FileText,
  LoaderCircle,
  Pin,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Highlight, Prism, type Language, type PrismTheme } from 'prism-react-renderer';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDuration, formatRelative } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import type { ActivitySuggestionData, ElicitationData, Message, MessageMention } from '../lib/types';
import { type AttachmentPreview, MessageAttachments } from './attachments';
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
  const normalizedLanguage = language.trim().toLowerCase() || 'plain';
  const requestedLanguage = markdownLanguageAliases[normalizedLanguage] ?? normalizedLanguage;
  const highlightedLanguage: Language = Prism.languages[requestedLanguage]
    ? requestedLanguage
    : 'plain';

  const copy = async (): Promise<void> => {
    try {
      await desktopBridge().copyText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="markdown-code-block" data-language={normalizedLanguage}>
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

function MarkdownTable({ children, node, style, ...props }: React.ComponentProps<'table'> & ExtraProps): React.JSX.Element {
  const section = node?.children.find((child) => child.type === 'element' && (child.tagName === 'thead' || child.tagName === 'tbody'));
  const row = section?.type === 'element'
    ? section.children.find((child) => child.type === 'element' && child.tagName === 'tr')
    : undefined;
  const columnCount = row?.type === 'element'
    ? row.children.filter((child) => child.type === 'element' && (child.tagName === 'th' || child.tagName === 'td')).length
    : 1;
  const tableStyle = {
    ...style,
    '--markdown-table-columns': Math.max(1, columnCount),
  } as React.CSSProperties;

  return (
    <div className="markdown-table-scroll fade-x fade-scrollbar-safe-x">
      <table {...props} data-column-count={columnCount} style={tableStyle}>{children}</table>
    </div>
  );
}

const PERSON_LINK_PATTERN = /^person:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu;

function personIdFromHref(href: string | undefined): string | undefined {
  return href?.match(PERSON_LINK_PATTERN)?.[1]?.toLowerCase();
}

function mentionInitials(label: string): string {
  return label
    .replace(/^@/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';
}

function MentionChip({ fallbackLabel, mention, personId }: {
  fallbackLabel: React.ReactNode;
  mention?: MessageMention;
  personId: string;
}): React.JSX.Element {
  const fallbackText = typeof fallbackLabel === 'string' ? fallbackLabel : '@Person';
  const label = mention?.displayName
    ? `@${mention.displayName.replace(/^@/u, '')}`
    : fallbackLabel;
  const initials = mentionInitials(mention?.displayName ?? fallbackText);

  return (
    <span className="mention-chip" data-person-id={personId}>
      <span aria-hidden="true" className="mention-chip-avatar">
        <span>{initials}</span>
        {mention?.avatarUrl && (
          <img
            alt=""
            onError={(event) => { event.currentTarget.hidden = true; }}
            src={mention.avatarUrl}
          />
        )}
      </span>
      <span className="mention-chip-label">{label}</span>
    </span>
  );
}

function MarkdownBody({ children, mentions = [] }: { children: string; mentions?: MessageMention[] }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={{
          a: ({ children: linkChildren, href, node, ...props }) => {
            void node;
            const personId = personIdFromHref(href);
            if (personId) {
              const mention = mentions.find((candidate) => (
                candidate.type === 'person' && candidate.personId?.toLowerCase() === personId
              ));
              if (!mention) return <span className="mention-text-fallback">{linkChildren}</span>;
              return <MentionChip fallbackLabel={linkChildren} mention={mention} personId={personId} />;
            }
            return <a {...props} href={href} rel="noopener noreferrer" target="_blank">{linkChildren}</a>;
          },
          code: MarkdownCode,
          pre: ({ children: preChildren }) => <>{preChildren}</>,
          table: MarkdownTable,
        }}
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key, node) => (
          key === 'href' && node.tagName === 'a' && personIdFromHref(url)
            ? url
            : defaultUrlTransform(url)
        )}
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

function elicitationAnswerLabel(elicitation: ElicitationData): string {
  const answer = elicitation.answer;
  if (answer == null) return 'Skipped';
  const values = Array.isArray(answer) ? answer : [String(answer)];
  const labels = values.map((value) => elicitation.options?.find((option) => option.value === value)?.label ?? value);
  return labels.join(', ');
}

export function ElicitationPanel({
  elicitation,
  onAnswer,
}: {
  elicitation: ElicitationData;
  onAnswer: (answer: string | string[] | null, customResponse?: string) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [customSelected, setCustomSelected] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const isAnswered = elicitation.status === 'answered';
  const isMulti = elicitation.responseType === 'multi_select';
  const isText = elicitation.responseType === 'text';
  const minimumSelections = isText ? 1 : Math.max(1, elicitation.minimumSelections ?? 1);
  const maximumSelections = isMulti ? elicitation.maximumSelections : 1;
  const selectionCount = selected.length + (customSelected && text.trim() ? 1 : 0);
  const canSubmit = isText
    ? text.trim().length > 0
    : selectionCount >= minimumSelections && (maximumSelections == null || selectionCount <= maximumSelections);

  useEffect(() => {
    setText('');
    setSelected([]);
    setCustomSelected(false);
    setCollapsed(false);
    setError(null);
  }, [elicitation.id]);

  if (isAnswered) {
    return (
      <div aria-label="Elicitation response" className="elicitation-resolved-answer">
        {elicitationAnswerLabel(elicitation)}
      </div>
    );
  }

  const toggle = (value: string): void => {
    setError(null);
    if (!isMulti) {
      setSelected([value]);
      setCustomSelected(false);
      return;
    }
    setSelected((current) => {
      if (current.includes(value)) return current.filter((item) => item !== value);
      if (maximumSelections != null && current.length + (customSelected && text.trim() ? 1 : 0) >= maximumSelections) {
        setError(`Choose no more than ${maximumSelections} ${maximumSelections === 1 ? 'option' : 'options'}.`);
        return current;
      }
      return [...current, value];
    });
  };

  const selectCustom = (): void => {
    setError(null);
    if (!isMulti) setSelected([]);
    if (!customSelected && isMulti && maximumSelections != null && selected.length >= maximumSelections) {
      setError(`Choose no more than ${maximumSelections} ${maximumSelections === 1 ? 'option' : 'options'}.`);
      return;
    }
    setCustomSelected(true);
    requestAnimationFrame(() => customInputRef.current?.focus());
  };

  const toggleCustom = (): void => {
    if (isMulti && customSelected) {
      setCustomSelected(false);
      setError(null);
      return;
    }
    selectCustom();
  };

  const submit = async (): Promise<void> => {
    const customResponse = customSelected && text.trim() ? text.trim() : undefined;
    const answer = isText
      ? text.trim()
      : isMulti
        ? [...selected, ...(customResponse ? [customResponse] : [])]
        : customResponse ?? selected[0];
    if (!answer || !canSubmit) {
      setError('Choose or enter a response before continuing.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(answer, customResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your response could not be saved.');
    } finally {
      setSubmitting(false);
    }
  };

  const skip = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This question could not be skipped.');
    } finally {
      setSubmitting(false);
    }
  };

  const options = elicitation.options ?? [];
  const question = isMulti && !/pick (?:everything|all)|select (?:everything|all)|choose (?:everything|all)/iu.test(elicitation.prompt)
    ? `${elicitation.prompt} Pick everything that applies.`
    : elicitation.prompt;
  if (collapsed) {
    return (
      <button className="elicitation-collapsed-bar" onClick={() => setCollapsed(false)} type="button">
        <span>Avalon needs input</span>
        <strong>{elicitation.prompt}</strong>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
    );
  }

  return (
    <section
      aria-labelledby={`elicitation-${elicitation.id}`}
      className="elicitation-panel"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit && !submitting) {
          event.preventDefault();
          void submit();
          return;
        }
        const target = event.target as HTMLElement;
        if (isText || target.matches('input, textarea') || event.metaKey || event.ctrlKey || event.altKey) return;
        const index = Number(event.key) - 1;
        if (!Number.isInteger(index) || index < 0 || index > options.length) return;
        event.preventDefault();
        const option = options[index];
        if (option) toggle(option.value);
        else toggleCustom();
      }}
    >
      <header className="elicitation-panel-header">
        <div>
          <h3 id={`elicitation-${elicitation.id}`}>{question}</h3>
        </div>
        <div className="elicitation-header-actions">
          <button aria-label="Collapse question" onClick={() => setCollapsed(true)} type="button">
            <ChevronDown aria-hidden="true" size={16} />
          </button>
        </div>
      </header>
      {isText ? (
        <textarea
          aria-label="Response"
          className="elicitation-text-response"
          onChange={(event) => setText(event.target.value)}
          placeholder="Type your answer here"
          rows={3}
          value={text}
        />
      ) : (
        <fieldset className="elicitation-options">
          <legend className="sr-only">Response options</legend>
          {options.map((option, index) => (
            <label className={clsx('elicitation-option', selected.includes(option.value) && 'is-selected')} key={option.value}>
              <input
                checked={selected.includes(option.value)}
                name={`elicitation-${elicitation.id}`}
                onChange={() => toggle(option.value)}
                type={isMulti ? 'checkbox' : 'radio'}
                value={option.value}
              />
              <span className="elicitation-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {isMulti ? (
                <span aria-hidden="true" className="elicitation-checkbox">{selected.includes(option.value) && <Check size={12} strokeWidth={3} />}</span>
              ) : (
                <kbd aria-hidden="true">{index + 1}</kbd>
              )}
            </label>
          ))}
          <div
            className={clsx('elicitation-option', 'elicitation-other-option', customSelected && 'is-selected')}
            onClick={toggleCustom}
          >
            <input
              aria-label="Other"
              checked={customSelected}
              name={`elicitation-${elicitation.id}`}
              onChange={toggleCustom}
              type={isMulti ? 'checkbox' : 'radio'}
            />
            <span className="elicitation-option-copy">
              <strong>Other</strong>
              <input
                aria-label="Other response"
                onChange={(event) => {
                  setText(event.target.value);
                  if (event.target.value) selectCustom();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  selectCustom();
                }}
                placeholder="Type your own answer here"
                ref={customInputRef}
                type="text"
                value={text}
              />
            </span>
            {isMulti ? (
              <span aria-hidden="true" className="elicitation-checkbox">{customSelected && <Check size={12} strokeWidth={3} />}</span>
            ) : (
              <kbd aria-hidden="true">{options.length + 1}</kbd>
            )}
          </div>
        </fieldset>
      )}
      {!isAnswered && (
        <div className="elicitation-actions">
          {error && <InlineError>{error}</InlineError>}
          <Button className="elicitation-skip" disabled={submitting} onClick={() => void skip()}>Skip</Button>
          <Button className="elicitation-submit" disabled={!canSubmit || submitting} onClick={() => void submit()}>
            {submitting ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
            Submit <kbd aria-hidden="true">⌘↵</kbd>
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
  loadAttachmentContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpenAttachment?: (preview: AttachmentPreview) => void;
  onAnswerElicitation: (elicitationId: string, answer: string | string[] | null, customResponse?: string) => Promise<void>;
  onResolveSuggestion: (suggestionId: string, action: 'accept' | 'dismiss') => Promise<void>;
}

export function MessageBlock({
  currentUserId,
  loadAttachmentContent,
  message,
  onAnswerElicitation,
  onOpenAttachment,
  onResolveSuggestion,
}: MessageBlockProps): React.JSX.Element {
  if (message.messageType === 'tool_event') return <div className="transcript-event" id={`message-${message.id}`}><ToolBlock message={message} /></div>;
  if (message.messageType === 'artifact') return <div className="transcript-event" id={`message-${message.id}`}><ArtifactBlock message={message} /></div>;
  if (message.messageType === 'elicitation' && message.elicitation) {
    return <div className="transcript-event" id={`message-${message.id}`}><ElicitationPanel elicitation={message.elicitation} onAnswer={(answer, customResponse) => onAnswerElicitation(message.elicitation!.id, answer, customResponse)} /></div>;
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
  const sending = message.deliveryState === 'sending';
  return (
    <article
      aria-label={sending ? 'Sending message' : human ? `Message from ${humanAuthorName}` : undefined}
      aria-busy={message.streaming || sending || undefined}
      className={clsx(
        'message-block',
        human ? 'human-message' : 'agent-message',
        human && (ownHumanMessage ? 'own-human-message' : 'coworker-message'),
        message.streaming && 'is-streaming',
        sending && 'is-sending',
      )}
      id={`message-${message.id}`}
      style={human ? { '--person-accent': personAccent(message.author?.id ?? message.id) } as React.CSSProperties : undefined}
    >
      {!sending && (!human || !ownHumanMessage) && (
        <header>
          {human && <span aria-hidden="true" className="message-author-dot" />}
          <span className="message-author">{human ? humanAuthorName : 'Avalon'}</span>
          <time dateTime={message.createdAt}>{formatRelative(message.createdAt)}</time>
        </header>
      )}
      {sending
        ? <span aria-hidden="true" className="message-skeleton" />
        : human ? (
            <div className="human-message-content">
              {message.attachments?.length && loadAttachmentContent && onOpenAttachment ? (
                <MessageAttachments
                  attachments={message.attachments}
                  loadContent={loadAttachmentContent}
                  onOpen={onOpenAttachment}
                />
              ) : null}
              {message.text ? (
                <div className="human-message-bubble">
                  <MarkdownBody mentions={message.mentions}>{message.text}</MarkdownBody>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              {message.attachments?.length && loadAttachmentContent && onOpenAttachment ? (
                <MessageAttachments
                  attachments={message.attachments}
                  loadContent={loadAttachmentContent}
                  onOpen={onOpenAttachment}
                />
              ) : null}
              {message.text ? <MarkdownBody mentions={message.mentions}>{message.text}</MarkdownBody> : null}
            </>
          )}
      {!human && !message.streaming && (
        <footer className="agent-message-actions">
          <button aria-label="Copy response" onClick={() => void desktopBridge().copyText(message.text ?? '')} type="button"><Clipboard size={12} /> Copy</button>
        </footer>
      )}
      {message.streaming && <span className="streaming-caret" aria-hidden="true" />}
    </article>
  );
}
