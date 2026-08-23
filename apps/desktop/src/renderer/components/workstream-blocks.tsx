import clsx from 'clsx';
import {
  IconBrandGithub,
  IconBrandGoogle,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconBrandSlack,
  IconPlug,
  IconStack2,
  IconWebhook,
  IconWorldSearch,
  type TablerIcon,
} from '@tabler/icons-react';
import type { AutomationPluginActivity, AutomationPluginIcon } from '@avalon/contracts';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Copy,
  FileDown,
  ImageDown,
  LoaderCircle,
  TerminalSquare,
} from 'lucide-react';
import { Children, useEffect, useMemo, useRef, useState } from 'react';
import { Highlight, Prism, type Language, type PrismTheme } from 'prism-react-renderer';
import { normalizeModelMarkdown, normalizeModelText } from '@avalon/contracts/model-markdown';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { logError } from '../../common/logger';
import { messageExportDate, messageExportFileName, type MessageExportFormat } from '../../common/message-export';
import { formatDuration, formatRelative } from '../lib/format';
import { saveMessageExport } from '../lib/message-export';
import { desktopBridge, desktopServicesAvailable } from '../lib/platform';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import { useTextClamped } from '../lib/use-text-clamped';
import type { ElicitationData, Message, MessageMention } from '../lib/types';
import { AgentWorkTiming } from './agent-work-timing';
import { type AttachmentPreview, MessageAttachments } from './attachments';
import { Button, InlineError } from './primitives';

/**
 * A stable colour per participant. The values are the theme's, reached through
 * custom properties rather than named here, so a light theme can darken all six
 * without this function knowing there is more than one theme.
 */
function personAccent(id: string): string {
  const palette = ['--av-sys-color-person-1', '--av-sys-color-person-2', '--av-sys-color-person-3', '--av-sys-color-person-4', '--av-sys-color-person-5', '--av-sys-color-person-6'];
  const hash = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return `var(${palette[hash % palette.length] ?? palette[0]!})`;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 8_000 ? `${text.slice(0, 8_000)}\n…` : text;
  } catch {
    return 'Details unavailable';
  }
}

/**
 * The syntax palette, in the theme's own colours.
 *
 * `prism-react-renderer` takes a JavaScript object and writes it into inline
 * styles, so nothing here can be a class — but a custom property in an inline
 * style resolves against the element's cascade like any other, which is why
 * these are `var()` rather than literals. Literals were the previous shape and
 * they pinned every code block to the dark theme.
 */
const markdownCodeTheme: PrismTheme = {
  plain: { backgroundColor: 'transparent', color: 'var(--av-sys-color-syntax-plain)' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--av-sys-color-syntax-comment)' } },
    { types: ['punctuation'], style: { color: 'var(--av-sys-color-syntax-punctuation)' } },
    { types: ['namespace'], style: { opacity: 0.72 } },
    { types: ['tag', 'constant', 'symbol', 'deleted'], style: { color: 'var(--av-sys-color-syntax-tag)' } },
    { types: ['boolean', 'number'], style: { color: 'var(--av-sys-color-syntax-number)' } },
    { types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'], style: { color: 'var(--av-sys-color-syntax-string)' } },
    { types: ['operator', 'entity', 'url'], style: { color: 'var(--av-sys-color-syntax-operator)' } },
    { types: ['atrule', 'attr-value', 'keyword'], style: { color: 'var(--av-sys-color-syntax-keyword)' } },
    { types: ['function'], style: { color: 'var(--av-sys-color-syntax-function)' } },
    { types: ['regex', 'important', 'variable'], style: { color: 'var(--av-sys-color-syntax-variable)' } },
    { types: ['important', 'bold'], style: { fontWeight: '700' } },
    { types: ['italic'], style: { fontStyle: 'italic' } },
    { types: ['class-name', 'maybe-class-name'], style: { color: 'var(--av-sys-color-syntax-string)' } },
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

interface MessageCopyTelemetry {
  messageId: string;
  workstreamId: string;
}

function MarkdownCodeBlock({ code, language, telemetry }: {
  code: string;
  language: string;
  telemetry?: MessageCopyTelemetry;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const normalizedLanguage = language.trim().toLowerCase() || 'plain';
  const requestedLanguage = markdownLanguageAliases[normalizedLanguage] ?? normalizedLanguage;
  const highlightedLanguage: Language = Prism.languages[requestedLanguage]
    ? requestedLanguage
    : 'plain';

  const copy = async (): Promise<void> => {
    try {
      await desktopBridge().copyText(code);
      if (telemetry) reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'code_block', resourceType: 'message',
        resourceId: telemetry.messageId, workstreamId: telemetry.workstreamId,
      });
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

function MarkdownCode({ children, className, telemetry }: React.ComponentProps<'code'> & {
  telemetry?: MessageCopyTelemetry;
}): React.JSX.Element {
  const source = String(children ?? '');
  const languageMatch = /(?:^|\s)language-([\w#+.-]+)/u.exec(className ?? '');
  const isBlock = Boolean(languageMatch) || source.endsWith('\n');

  if (!isBlock) return <code className="markdown-inline-code">{children}</code>;

  return (
    <MarkdownCodeBlock
      code={source.replace(/\n$/u, '')}
      language={languageMatch?.[1]?.toLowerCase() ?? 'plain'}
      telemetry={telemetry}
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
const CONNECTOR_LINK_PATTERN = /^connector:([0-9a-z]+):(.+)$/u;

function personIdFromHref(href: string | undefined): string | undefined {
  return href?.match(PERSON_LINK_PATTERN)?.[1]?.toLowerCase();
}

/**
 * A `connector:` link counts only when it carries this render's token. The token
 * is minted in the browser and never appears in the stored message, so a link
 * someone wrote into the text cannot carry it — no guessing at labels or offsets.
 */
export function createConnectorMentionToken(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/gu, '')
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** Any `connector:` href, tokened or not — all of them stay inert rather than navigating. */
function isConnectorHref(href: string | undefined): boolean {
  return href !== undefined && href.startsWith('connector:');
}

function connectorTypeFromHref(href: string | undefined, token: string): string | undefined {
  const match = href?.match(CONNECTOR_LINK_PATTERN);
  if (!match || match[1] !== token) return undefined;
  try {
    return decodeURIComponent(match[2] ?? '');
  } catch {
    // Message text is authored by people and models, so `[x](connector:%)` is a
    // reachable input. A malformed escape is simply not a connector reference —
    // it must not throw through the renderer and take the transcript with it.
    return undefined;
  }
}

/**
 * Keeps a label literal: brackets would end the link, emphasis marks would style
 * it, and `&` would let a character reference decode into something else.
 */
function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]*_`~&]/gu, (character) => `\\${character}`);
}

/** The rendered label of a link, when it is a single plain string. */
function linkLabelText(children: React.ReactNode): string | undefined {
  const parts = Children.toArray(children);
  if (parts.length !== 1) return undefined;
  return typeof parts[0] === 'string' ? parts[0] : undefined;
}

/**
 * Person mentions arrive as durable `[@Name](person:<id>)` Markdown, but a
 * connection mention stays human-readable text because Avalon has no
 * identity-bearing connector reference yet. Its stored offsets are still
 * authoritative, so this turns them into the same link shape at render time —
 * presentation only, leaving the message text models and Slack see untouched.
 *
 * Each emitted link carries `token`, which is what makes it authoritative: a
 * `connector:` link already present in the message text is something a person or
 * a model wrote, cannot carry the token, and must not be dressed as a mention.
 */
export function withConnectorMentionLinks(text: string, mentions: MessageMention[], token: string): string {
  const connectors = mentions
    .filter((mention) => mention.type === 'connector' && mention.connectorType)
    .sort((left, right) => left.startOffset - right.startOffset);
  if (connectors.length === 0) return text;

  let cursor = 0;
  let output = '';
  for (const mention of connectors) {
    const { connectorType, startOffset, endOffset } = mention;
    if (connectorType === undefined || startOffset < cursor || endOffset > text.length) continue;
    const source = text.slice(startOffset, endOffset);
    if (!source.startsWith('@')) continue;
    output += text.slice(cursor, startOffset);
    output += `[${escapeMarkdownLabel(source)}](connector:${token}:${encodeURIComponent(connectorType)})`;
    cursor = endOffset;
  }
  return output + text.slice(cursor);
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

export function MarkdownBody({ children, mentions = [], telemetry }: {
  children: string;
  mentions?: MessageMention[];
  telemetry?: MessageCopyTelemetry;
}): React.JSX.Element {
  // One token per mounted body, so the links keep stable identity across renders.
  const token = useMemo(createConnectorMentionToken, []);
  // Mentions first, normalization second, and the order is load-bearing: the
  // connector offsets are measured against the stored text, so anything that
  // changes its length has to run after they have been resolved into links.
  const markdown = normalizeModelMarkdown(withConnectorMentionLinks(children, mentions, token));
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
            // A `person:` target that is not an id is text a model wrote, and
            // `defaultUrlTransform` empties it rather than rejecting it — which
            // renders as an anchor with nothing behind it, opening a blank
            // window when a reader takes it for the mention it looks like.
            if (href?.startsWith('person:')) return <span className="mention-text-fallback">{linkChildren}</span>;
            if (isConnectorHref(href)) {
              const connectorType = connectorTypeFromHref(href, token);
              const label = linkLabelText(linkChildren);
              // Without this render's token the link is text someone wrote, not a
              // mention: it neither earns a chip nor becomes something clickable.
              if (connectorType === undefined || label === undefined) {
                return <span className="mention-text-fallback">{linkChildren}</span>;
              }
              return (
                <span className="mention-chip mention-chip-connector" data-connector-type={connectorType}>
                  <span className="mention-chip-label">{label}</span>
                </span>
              );
            }
            return <a {...props} href={href} rel="noopener noreferrer" target="_blank">{linkChildren}</a>;
          },
          code: (properties) => <MarkdownCode {...properties} telemetry={telemetry} />,
          pre: ({ children: preChildren }) => <>{preChildren}</>,
          table: MarkdownTable,
        }}
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key, node) => (
          // Both schemes reach the `a` component intact so it can decide there;
          // neither is ever rendered as a navigable link.
          key === 'href' && node.tagName === 'a' && (personIdFromHref(url) || isConnectorHref(url))
            ? url
            : defaultUrlTransform(url)
        )}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/**
 * What a person can do with a finished turn: copy it, or keep it as a file.
 *
 * Both exports render the same `MarkdownBody` the turn above is made of, so the
 * saved card cannot drift from what was on screen —
 * [`docs/message-export.md`](../../../../../docs/message-export.md) owns the rest.
 * A dismissed save dialog is not a failure and says nothing; a render or a write
 * that failed replaces the label until the pointer leaves, because unlike a
 * failed copy there is no other copy of the file to fall back on.
 */
function exportStatusMessage(saving: MessageExportFormat | null, failed: MessageExportFormat | null): string {
  const noun = (format: MessageExportFormat): string => (format === 'image' ? 'image' : 'PDF');
  if (saving) return `Preparing the ${noun(saving)}…`;
  if (failed) return `The ${noun(failed)} could not be saved.`;
  return '';
}

function AssistantMessageActions({ mentions, telemetry, text }: {
  mentions: MessageMention[];
  telemetry?: MessageCopyTelemetry;
  text: string;
}): React.JSX.Element {
  const [saving, setSaving] = useState<MessageExportFormat | null>(null);
  const [failed, setFailed] = useState<MessageExportFormat | null>(null);
  const exportsAvailable = desktopServicesAvailable();

  const copyResponse = async (): Promise<void> => {
    await desktopBridge().copyText(text);
    if (telemetry) reportTelemetryProductIntent({
      kind: 'content_copied', contentType: 'message_response', resourceType: 'message',
      resourceId: telemetry.messageId, workstreamId: telemetry.workstreamId,
    });
  };

  const save = async (format: MessageExportFormat): Promise<void> => {
    if (saving) return;
    setSaving(format);
    setFailed(null);
    try {
      await saveMessageExport({
        content: <MarkdownBody mentions={mentions}>{text}</MarkdownBody>,
        fileName: messageExportFileName(text, messageExportDate(new Date())),
        format,
      });
    } catch (error) {
      // The label says one attempt failed; the console is where the reason is,
      // and it is the only trail a support conversation has to go on.
      logError('avalon', `could not save this message as ${format === 'image' ? 'an image' : 'a PDF'}`, error);
      setFailed(format);
    } finally {
      setSaving(null);
    }
  };

  return (
    <footer
      className="agent-message-actions"
      // The row itself is transient, so the failure on it should be too: it has
      // been read by the time the pointer leaves, and a stale "Image failed"
      // sitting under a turn the next day reads as a broken feature rather than
      // as one attempt that did not work.
      onPointerLeave={() => setFailed(null)}
    >
      <button aria-label="Copy response" onClick={() => void copyResponse().catch(() => undefined)} type="button"><Clipboard size={12} /> Copy</button>
      {exportsAvailable && (
        <>
          <button
            aria-busy={saving === 'image' || undefined}
            aria-label="Download response as an image"
            disabled={saving !== null}
            onClick={() => void save('image')}
            type="button"
          >
            {saving === 'image' ? <LoaderCircle aria-hidden="true" className="spin" size={12} /> : null}
            {saving !== 'image' && failed === 'image' ? <CircleAlert aria-hidden="true" size={12} /> : null}
            {saving !== 'image' && failed !== 'image' ? <ImageDown aria-hidden="true" size={12} /> : null}
            {failed === 'image' ? 'Image failed' : 'Image'}
          </button>
          <button
            aria-busy={saving === 'pdf' || undefined}
            aria-label="Save response as a PDF"
            disabled={saving !== null}
            onClick={() => void save('pdf')}
            type="button"
          >
            {saving === 'pdf' ? <LoaderCircle aria-hidden="true" className="spin" size={12} /> : null}
            {saving !== 'pdf' && failed === 'pdf' ? <CircleAlert aria-hidden="true" size={12} /> : null}
            {saving !== 'pdf' && failed !== 'pdf' ? <FileDown aria-hidden="true" size={12} /> : null}
            {failed === 'pdf' ? 'PDF failed' : 'PDF'}
          </button>
          {/* Each button keeps a fixed accessible name so it stays findable, which
              means neither the spinner nor the changed label announces anything on
              its own. This is where the state is spoken. */}
          <span className="sr-only" role="status">{exportStatusMessage(saving, failed)}</span>
        </>
      )}
    </footer>
  );
}

export function AssistantMessageContent({
  mentions = [],
  showCopy = true,
  streaming = false,
  text,
  telemetry,
}: {
  mentions?: MessageMention[];
  showCopy?: boolean;
  streaming?: boolean;
  text: string;
  telemetry?: MessageCopyTelemetry;
}): React.JSX.Element {
  return (
    <>
      {text ? <MarkdownBody mentions={mentions} telemetry={telemetry}>{text}</MarkdownBody> : null}
      {showCopy && !streaming && text && (
        <AssistantMessageActions mentions={mentions} telemetry={telemetry} text={text} />
      )}
      {streaming && <span className="streaming-caret" aria-hidden="true" />}
    </>
  );
}

function ToolBlock({ message }: { message: Message }): React.JSX.Element | null {
  const tool = message.toolEvent;
  if (!tool) return null;
  const owningPlugin = tool.plugin;
  return (
    <details className={clsx('tool-block', `tool-${tool.status}`, owningPlugin && 'plugin-activity')}>
      <summary>
        {owningPlugin
          ? <PluginFace plugin={owningPlugin} />
          : <span className="tool-icon"><TerminalSquare aria-hidden="true" size={14} /></span>}
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
        {tool.input === undefined && tool.output === undefined && tool.summary && (
          <div><h4>Activity</h4><p>{tool.summary}</p></div>
        )}
        {tool.status === 'ambiguous' && <p className="tool-warning">Avalon could not confirm whether this external action completed. It will not retry automatically.</p>}
      </div>
    </details>
  );
}

/**
 * Which system rows are open, held by a caller that virtualizes its transcript.
 *
 * `useState` inside the row is not enough there. The work-stream transcript
 * unmounts a row that scrolls out of the window, and the row's open/closed flag
 * would go with it — which is worse than a forgotten preference, because the
 * virtualizer keeps the height it measured while the row was open. A row that
 * comes back collapsed re-measures thousands of pixels shorter, and
 * `resizeItem` deliberately declines to compensate a re-measurement while the
 * reader is scrolling backward, so the transcript jumps under them by the whole
 * delta. Holding the flag above the virtual window keeps the returning row the
 * size the cache already expects. A caller that mounts its rows once needs none
 * of this and can leave it undefined.
 */
export interface SystemRowDisclosure {
  expanded: ReadonlySet<string>;
  onToggle: (messageId: string) => void;
}

/**
 * A system row: the note Avalon leaves in the transcript when something happened
 * to the work stream rather than in it.
 *
 * Most are a sentence — a scheduled wake-up, a delivery confirmation. A few are
 * the entire input a run was launched with: a digest brief, an automation's
 * opening prompt, an inbound email. Those arrive thousands of words long and
 * used to be laid out in full, burying the conversation they preface under a
 * screen or more of scrolling. Every system row is clamped to the five lines
 * that `--system-message-lines` sets, and the reader opens the rest; the short
 * ones look exactly as they did, because the control appears only once the
 * clamp is actually hiding something. Nothing distinguishes a prompt from a
 * one-liner on the wire, and the height is the only honest discriminator.
 */
function SystemMessageBlock({ disclosure, message }: { disclosure?: SystemRowDisclosure; message: Message }): React.JSX.Element {
  // The fallback for a caller that does not virtualize. Where one does, the
  // state has to outlive the row — see `SystemRowDisclosure`.
  const [locallyExpanded, setLocallyExpanded] = useState(false);
  const [textNode, setTextNode] = useState<HTMLElement | null>(null);
  const text = message.text ?? '';
  const expanded = disclosure ? disclosure.expanded.has(message.id) : locallyExpanded;
  const clamped = useTextClamped(textNode, text, !expanded);

  return (
    <div className="system-message" id={`message-${message.id}`}>
      <span aria-hidden="true" className="system-message-dot" />
      <div className="system-message-body">
        <p className="system-message-text" data-expanded={expanded ? 'true' : undefined} ref={setTextNode}>{text}</p>
        {/*
          An open row always keeps its control, measured or not. A row that
          mounts already open — the caller held the state while it was outside a
          virtual window — has never had the clamp applied, so it has no
          measurement to offer and `clamped` is false. Keying the control on the
          measurement alone would hand the reader back an opened row with no way
          to close it. The pause inside the hook is still what stops the control
          disappearing at the moment of the click; these are two different
          guards against the same stranding.
        */}
        {(expanded || clamped) && (
          <button
            aria-expanded={expanded}
            aria-label={expanded ? 'Show less of this note' : 'Show this note in full'}
            className="system-message-toggle"
            onClick={() => {
              if (disclosure) disclosure.onToggle(message.id);
              else setLocallyExpanded((current) => !current);
            }}
            type="button"
          >
            {expanded ? 'less' : 'more'}
            <ChevronDown aria-hidden="true" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function ThoughtBlock({ message }: { message: Message }): React.JSX.Element | null {
  const thought = message.thoughtEvent;
  if (!thought) return null;
  return (
    <AgentWorkTiming
      active={thought.status === 'started'}
      durationMs={thought.durationMs}
      {...(thought.startedAt === undefined ? {} : { startedAt: thought.startedAt })}
    />
  );
}

const pluginIconByKey: Record<AutomationPluginIcon, TablerIcon> = {
  'brand-github': IconBrandGithub,
  'brand-google': IconBrandGoogle,
  'brand-google-drive': IconBrandGoogleDrive,
  'brand-notion': IconBrandNotion,
  'brand-slack': IconBrandSlack,
  linear: IconStack2,
  plug: IconPlug,
  webhook: IconWebhook,
  'world-search': IconWorldSearch,
};

/** A row shows the plugin that owns the tool it ran, so there is only ever one. */
function PluginFace({ plugin }: { plugin: AutomationPluginActivity }): React.JSX.Element {
  const PluginIcon = pluginIconByKey[plugin.icon];
  return (
    <span
      aria-label={`Plugin: ${plugin.displayName}`}
      className={clsx('plugin-face', `plugin-face-${plugin.icon}`)}
      role="img"
      title={plugin.displayName}
    >
      <PluginIcon aria-hidden="true" size={14} stroke={1.8} />
    </span>
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
  const allowOther = elicitation.allowOther ?? true;
  const minimumSelections = isText ? 1 : Math.max(1, elicitation.minimumSelections ?? 1);
  const maximumSelections = isMulti ? elicitation.maximumSelections : 1;
  const selectionCount = selected.length + (allowOther && customSelected && text.trim() ? 1 : 0);
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
      <div aria-label="Elicitation response" className="elicitation-resolved-answer human-message-bubble">
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
  // The question is a label, not a body: it is shown as plain text, so it takes
  // the plain-text repair rather than being sent through `MarkdownBody`.
  const prompt = normalizeModelText(elicitation.prompt);
  const question = isMulti && !/pick (?:everything|all)|select (?:everything|all)|choose (?:everything|all)/iu.test(prompt)
    ? `${prompt} Pick everything that applies.`
    : prompt;
  if (collapsed) {
    return (
      <button className="elicitation-collapsed-bar" onClick={() => setCollapsed(false)} type="button">
        <span>Avalon needs input</span>
        <strong>{prompt}</strong>
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
        if (!Number.isInteger(index) || index < 0 || index >= options.length + (allowOther ? 1 : 0)) return;
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
          {allowOther && (
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
          )}
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

interface MessageBlockProps {
  currentUserId?: string;
  message: Message;
  loadAttachmentContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpenAttachment?: (preview: AttachmentPreview) => void;
  onAnswerElicitation: (elicitationId: string, answer: string | string[] | null, customResponse?: string) => Promise<void>;
  systemRowDisclosure?: SystemRowDisclosure;
}

export function MessageBlock({
  currentUserId,
  loadAttachmentContent,
  message,
  onAnswerElicitation,
  onOpenAttachment,
  systemRowDisclosure,
}: MessageBlockProps): React.JSX.Element {
  if (message.messageType === 'thought') return <div className="transcript-event" id={`message-${message.id}`}><ThoughtBlock message={message} /></div>;
  if (message.messageType === 'tool_event') return <div className="transcript-event" id={`message-${message.id}`}><ToolBlock message={message} /></div>;
  if (message.messageType === 'elicitation' && message.elicitation) {
    if (message.elicitation.status === 'answered') {
      const externalResponse = message.authorType === 'external';
      return (
        <article
          aria-label={externalResponse ? `Response from ${message.externalActor?.displayName ?? 'Slack workspace member'}` : 'Human elicitation response'}
          className={clsx(
            'message-block human-message elicitation-response-message',
            externalResponse ? 'coworker-message' : 'own-human-message',
          )}
          id={`message-${message.id}`}
        >
          {externalResponse && <header><span aria-hidden="true" className="message-author-dot" /><span className="message-author">{message.externalActor?.displayName ?? 'Slack workspace member'} · Slack</span><time dateTime={message.createdAt}>{formatRelative(message.createdAt)}</time></header>}
          <div className="human-message-content">
            <ElicitationPanel
              elicitation={message.elicitation}
              onAnswer={(answer, customResponse) => onAnswerElicitation(message.elicitation!.id, answer, customResponse)}
            />
          </div>
        </article>
      );
    }
    return <div className="transcript-event" id={`message-${message.id}`}><ElicitationPanel elicitation={message.elicitation} onAnswer={(answer, customResponse) => onAnswerElicitation(message.elicitation!.id, answer, customResponse)} /></div>;
  }
  if (message.authorType === 'system' || message.messageType === 'system') {
    return <SystemMessageBlock disclosure={systemRowDisclosure} message={message} />;
  }

  const human = message.authorType === 'human' || message.authorType === 'external';
  const external = message.authorType === 'external';
  const ownHumanMessage = message.authorType === 'human' && currentUserId !== undefined && message.author?.id === currentUserId;
  const humanAuthorName = external
    ? `${message.externalActor?.displayName ?? 'Slack workspace member'} · Slack`
    : message.author?.name ?? 'Workspace member';
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
      style={human ? { '--person-accent': personAccent(message.author?.id ?? message.externalActor?.providerUserId ?? message.id) } as React.CSSProperties : undefined}
    >
      {/* Your own turn carries no identity line — you know who you are. A
          context label is the exception, and the reason the header renders at
          all here: a suggested-work brief is attributed to the person who
          selected it but written by Avalon, so the line saying where the words
          came from is the only thing standing between them and a turn they do
          not remember typing. The name stays suppressed; only the label and the
          time appear. */}
      {!sending && (!human || !ownHumanMessage || message.contextLabel) && (
        <header>
          {!ownHumanMessage && (
            <>
              {human && <span aria-hidden="true" className="message-author-dot" />}
              <span className="message-author">{human ? humanAuthorName : 'Avalon'}</span>
            </>
          )}
          {message.contextLabel && <span className="message-context-label">{message.contextLabel}</span>}
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
                  <MarkdownBody
                    mentions={message.mentions}
                    telemetry={{ messageId: message.id, workstreamId: message.workstreamId }}
                  >{message.text}</MarkdownBody>
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
              <AssistantMessageContent
                mentions={message.mentions}
                streaming={message.streaming}
                text={message.text ?? ''}
                telemetry={{ messageId: message.id, workstreamId: message.workstreamId }}
              />
            </>
          )}
    </article>
  );
}
