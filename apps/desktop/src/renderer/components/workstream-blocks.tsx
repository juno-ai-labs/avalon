import clsx from 'clsx';
import {
  IconDeviceDesktop,
  IconPlug,
  IconWebhook,
  IconWorldSearch,
  type TablerIcon,
} from '@tabler/icons-react';
import type { AutomationPluginActivity } from '@rally/contracts';
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
  Pin,
  TerminalSquare,
  X,
} from 'lucide-react';
import { Children, memo, useEffect, useMemo, useRef, useState } from 'react';
import { Highlight, Prism, type Language, type PrismTheme } from 'prism-react-renderer';
import { citationFootnotes, citationScheme } from '@rally/contracts/citations';
import { markdownLineKinds } from '@rally/contracts/markdown-code';
import { normalizeModelMarkdown, normalizeModelText } from '@rally/contracts/model-markdown';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { logError } from '../../common/logger';
import { messageExportDate, messageExportFileName, type MessageExportFormat } from '../../common/message-export';
import { formatDuration, formatRelative } from '../lib/format';
import { isComposingKeyEvent } from '../lib/ime';
import { saveMessageExport } from '../lib/message-export';
import { desktopBridge, desktopServicesAvailable } from '../lib/platform';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import { useTextClamped } from '../lib/use-text-clamped';
import { pluginGroupIconForContract, type PluginGroupIcon } from '../lib/plugin-groups';
import { isPluginBrandMark, type PluginBrandMark } from '../lib/plugin-marks';
import type { ActivitySuggestionData, ElicitationData, Message, MessageMention } from '../lib/types';
import { AgentWorkTiming } from './agent-work-timing';
import {
  CitationFootnoteItem,
  CitationFootnoteSection,
  CitationImage,
  CitationLink,
  CitationsProvider,
  rehypeCitationEmbedRows,
  type CitationContext,
  type CitationRender,
} from './markdown-citations';
import { type AttachmentPreview, MessageAttachments } from './attachments';
import { Badge, Button, ConnectorMark, InlineError, RallyMark } from './primitives';

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

const markdownLanguageDisplayNames: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  dockerfile: 'Dockerfile',
  go: 'Go',
  graphql: 'GraphQL',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  kotlin: 'Kotlin',
  less: 'Less',
  markdown: 'Markdown',
  markup: 'HTML',
  objectivec: 'Objective-C',
  php: 'PHP',
  plain: 'Plain text',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  sass: 'Sass',
  scss: 'SCSS',
  sql: 'SQL',
  svg: 'SVG',
  swift: 'Swift',
  tsx: 'TSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
};

/** The header label: the Prism-resolved name where there is one, otherwise the fence's own word, capitalized. */
function codeLanguageLabel(normalizedLanguage: string, requestedLanguage: string): string {
  const known = markdownLanguageDisplayNames[requestedLanguage] ?? markdownLanguageDisplayNames[normalizedLanguage];
  if (known) return known;
  return normalizedLanguage.charAt(0).toUpperCase() + normalizedLanguage.slice(1);
}

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
  const rawLanguage = language.trim().toLowerCase();
  const normalizedLanguage = rawLanguage || 'plain';
  const requestedLanguage = markdownLanguageAliases[normalizedLanguage] ?? normalizedLanguage;
  const highlightedLanguage: Language = Prism.languages[requestedLanguage]
    ? requestedLanguage
    : 'plain';
  // A fence that named no language gets no header label — "Plain text" would
  // otherwise caption the most common fence in a transcript with a word nobody
  // wrote. An explicit ```text or ```plain fence still gets one.
  const languageLabel = rawLanguage ? codeLanguageLabel(normalizedLanguage, requestedLanguage) : '';

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
      <div className="markdown-code-block-header">
        <span className="markdown-code-language">{languageLabel}</span>
        <button aria-label={copied ? 'Code copied' : 'Copy code'} onClick={() => void copy()} type="button">
          {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
        </button>
      </div>
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
      language={languageMatch?.[1]?.toLowerCase() ?? ''}
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
 * connection mention stays human-readable text because Rally has no
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

/** The three schemes whose cells need the target the model actually wrote. */
const INTERNAL_CITATION_SCHEMES: ReadonlySet<string> = new Set(['resource', 'person', 'connector']);

/**
 * Which targets bypass `defaultUrlTransform` on their way to a component.
 *
 * An allowlist of three schemes in two positions, and nothing wider: everything
 * else — `javascript:`, `data:`, `file:` — keeps going through the default
 * transform, which empties what it rejects. The position matters as much as the
 * scheme, because `resource:` has to survive on an `img` as well as an `a`: the
 * embed card is reached through image syntax.
 *
 * Passing a scheme here is not the same as rendering it. Every cell downstream
 * emits a chip, a card, or text — never the value itself as a destination.
 */
function isInternalCitationTarget(url: string, key: string, tagName: string): boolean {
  const position = (key === 'href' && tagName === 'a') || (key === 'src' && tagName === 'img');
  return position && INTERNAL_CITATION_SCHEMES.has(citationScheme(url));
}

/**
 * The identity cells of the citation matrix, in one place.
 *
 * Mentions are unchanged by citations and stay unchanged here: a `person:` href
 * resolves against this render's `mentions`, a `connector:` one counts only when
 * it carries this render's token, and neither is ever emitted as something with
 * a destination. What moved is only where the decision is called from.
 */
function renderIdentity(
  href: string | undefined,
  label: React.ReactNode,
  mentions: MessageMention[],
  token: string,
): React.ReactNode {
  const personId = personIdFromHref(href);
  if (personId) {
    const mention = mentions.find((candidate) => (
      candidate.type === 'person' && candidate.personId?.toLowerCase() === personId
    ));
    if (!mention) return <span className="mention-text-fallback">{label}</span>;
    return <MentionChip fallbackLabel={label} mention={mention} personId={personId} />;
  }
  if (isConnectorHref(href)) {
    const connectorType = connectorTypeFromHref(href, token);
    const text = linkLabelText(label);
    // Without this render's token the link is text someone wrote, not a
    // mention: it neither earns a chip nor becomes something clickable.
    if (connectorType === undefined || text === undefined) {
      return <span className="mention-text-fallback">{label}</span>;
    }
    return (
      <span className="mention-chip mention-chip-connector" data-connector-type={connectorType}>
        <span className="mention-chip-label">{text}</span>
      </span>
    );
  }
  // A `person:` target that is not an id is text a model wrote. It reaches here
  // intact because `urlTransform` passes the whole scheme through —
  // `defaultUrlTransform` would empty it instead, and an anchor with nothing
  // behind it reads as a mention that opens a blank window.
  return <span className="mention-text-fallback">{label}</span>;
}

const REMARK_PLUGINS = [remarkGfm];
/**
 * The embed-row pass groups only what the citation matrix will draw as a card,
 * so a surface with no citation context groups nothing at all — and gets a
 * hoisted empty array rather than a new one per render, because these reach the
 * settled segments' memo by identity.
 */
const NO_REHYPE_PLUGINS: MarkdownRehypePlugins = [];

type MarkdownComponents = NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>;
type MarkdownUrlTransform = NonNullable<React.ComponentProps<typeof ReactMarkdown>['urlTransform']>;
type MarkdownRehypeOptions = NonNullable<React.ComponentProps<typeof ReactMarkdown>['remarkRehypeOptions']>;
/** Taken from the component's own props rather than from `unified`, which is a transitive dependency. */
type MarkdownRehypePlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>;

/** A blank line: the classic boundary between markdown blocks. */
const BLANK_LINE = /^\s*$/u;
/**
 * A top-level list-item line. Indent is capped at one space — CommonMark
 * allows three, but a nested item sits at two or more and must never be cut
 * away from its parent, so the extra two columns of top-level tolerance are
 * given up for that safety. Group 2 is the marker; its last character
 * (`-`/`*`/`+`/`.`/`)`) identifies the list a same-marker item continues.
 */
const TOP_LEVEL_LIST_ITEM = /^ {0,1}([-*+]|\d{1,9}([.)]))(\s|$)/u;
/**
 * A line that can continue the block before it across a blank line — a list
 * item (any marker, deeper indents included), an indented continuation (two
 * columns is enough to continue a list item's paragraph, so the guard starts
 * there rather than at code-block depth), or a blockquote line. Cutting
 * before one of these would tear a construct apart; not cutting only means
 * the tail stays larger.
 */
const CONTINUES_ACROSS_BLANK = /^( {0,3}([-*+]|\d{1,9}[.)])(\s|$)| {2,}|\t| {0,3}>)/u;

/**
 * Where a streaming markdown source can be cut so everything before the cut is
 * finished. Cuts are decided only at complete lines — the still-arriving final
 * line decides nothing, because its classification can change as it grows (a
 * bare `1` is a paragraph until the `.` lands and makes it a list item) — and
 * land, outside any code fence, at:
 *
 * - the start of a non-blank line that follows a blank line and does not
 *   continue the previous block (`CONTINUES_ACROSS_BLANK`);
 * - the start of a top-level list item that follows an item of the same
 *   marker, blank line between or not. A blank line genuinely does not end a
 *   list, but the next same-marker item is a boundary the previous item
 *   cannot extend across — and without this cut a list-dominant reply would
 *   produce no settled segments at all and re-parse whole on every commit.
 *
 * Splitting a list per item is an approximation the settled re-render heals:
 * each item renders as its own single-item list while the message streams
 * (ordered numbering survives via the `start` attribute; a loose item renders
 * tight until the turn completes). The alternative was the whole list staying
 * in the tail, which is the O(reply) re-parse this function exists to remove.
 *
 * `settled.join('') + tail === source`, and for an append-only source each
 * settled segment is final — deciding only at complete lines is what makes
 * that unconditional — so later text can only add segments or grow the tail,
 * which is what lets a segment's rendering be memoised while the message
 * streams. What segmentation cannot preserve — a reference link or a footnote
 * whose definition arrives in a later segment — renders literally until the
 * turn completes and the settled message re-renders whole.
 *
 * Where a fenced block ends is `@rally/contracts/markdown-code`'s answer, not
 * this function's, so the splitter and the two delivery rewrites cannot
 * disagree about it. That rule closes a block on any run of the opener's
 * character at least as long, info string or not, where this splitter used to
 * demand a bare closer — so a same-length fence nested inside another now cuts
 * the outer block in two while it streams. Transient by construction: the
 * commit that ends the stream re-renders the source whole. Only the fence kinds
 * are read; an indented block is not a cut boundary, and
 * `CONTINUES_ACROSS_BLANK` already refuses to cut before an indented line.
 */
export function splitStreamingMarkdown(source: string): { settled: string[]; tail: string } {
  const settled: string[] = [];
  let segmentStart = 0;
  let offset = 0;
  let previousBlank = false;
  /**
   * The marker character of the top-level list the current segment run is in
   * (`-`, `*`, `+`, `.`, `)`), or null outside one. Blank lines keep it (a
   * loose list continues across them); a cut to a non-list block clears it.
   */
  let listMarker: string | null = null;
  const lines = source.split('\n');
  const kinds = markdownLineKinds(lines);
  const cut = (): void => {
    settled.push(source.slice(segmentStart, offset));
    segmentStart = offset;
  };
  // `< length - 1`, never the last element: only a line followed by a newline
  // is complete, and only complete lines decide anything.
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    const blank = BLANK_LINE.test(line);
    const kind = kinds[index]!;
    // Only the fence kinds matter here: a fenced block is a boundary this
    // function must not cut inside, while an indented one is ordinary
    // continuation that `CONTINUES_ACROSS_BLANK` already refuses to cut before.
    const fenced = kind === 'fence-open' || kind === 'fence-content' || kind === 'fence-close';
    if (kind === 'fence-open') {
      if (previousBlank && offset > segmentStart) cut();
      listMarker = null;
    } else if (!fenced) {
      const item = TOP_LEVEL_LIST_ITEM.exec(line);
      if (!blank && item) {
        const marker = item[2] ?? item[1]!;
        if (offset > segmentStart && (
          marker === listMarker
          || (listMarker === null && previousBlank)
        )) cut();
        listMarker = marker;
      } else if (!blank) {
        if (previousBlank && offset > segmentStart && !CONTINUES_ACROSS_BLANK.test(line)) {
          cut();
          listMarker = null;
        }
      }
    }
    // A blank line inside a fence is code, not a paragraph seam.
    previousBlank = blank && !fenced;
    offset += line.length + 1;
  }
  return { settled, tail: source.slice(segmentStart) };
}

/**
 * A finished chunk of a streaming message. `memo` on the source string is what
 * makes a paced reveal affordable: each animation-frame commit re-parses only
 * the open tail, while every settled segment's element is reused untouched.
 */
const SettledMarkdownSegment = memo(function SettledMarkdownSegment({ components, rehypeOptions, rehypePlugins, source, urlTransform }: {
  components: MarkdownComponents;
  rehypeOptions: MarkdownRehypeOptions;
  rehypePlugins: MarkdownRehypePlugins;
  source: string;
  urlTransform: MarkdownUrlTransform;
}): React.JSX.Element {
  return (
    <ReactMarkdown
      components={components}
      rehypePlugins={rehypePlugins}
      remarkPlugins={REMARK_PLUGINS}
      remarkRehypeOptions={rehypeOptions}
      urlTransform={urlTransform}
    >
      {source}
    </ReactMarkdown>
  );
});

/**
 * The default for an absent `mentions` prop, hoisted for identity: a `= []`
 * default is a new array per render, which would invalidate the memoised
 * components below on every commit and with them every settled segment —
 * turning the streaming fast path back into a whole-body re-parse.
 */
const NO_MENTIONS: MessageMention[] = [];

export function MarkdownBody({
  children,
  citations,
  mentions = NO_MENTIONS,
  still = false,
  streaming = false,
  telemetry,
  verbatim = false,
}: {
  children: string;
  /**
   * How this surface resolves a cited resource and where it opens one. Absent
   * on a surface with no work stream behind it, which is exactly the condition
   * under which every citation degrades to the label text the message already
   * carried.
   */
  citations?: CitationContext;
  mentions?: MessageMention[];
  /**
   * This body is being rendered into a picture rather than onto the screen.
   *
   * The saved card is the only caller. A citation's sources live in a popover
   * there, which a still image cannot open — so a still keeps the trailing
   * source list that the transcript trades away for the space.
   */
  still?: boolean;
  /**
   * The message is still growing. Rendering switches to settled segments plus
   * an open tail so a per-frame commit does not re-parse the whole body; the
   * commit that ends the stream renders the source whole again, which is also
   * what heals any seam segmentation could not preserve.
   */
  streaming?: boolean;
  telemetry?: MessageCopyTelemetry;
  /**
   * The text is a person's or a file's, shown as written: the model-text
   * repair is a repair of what a *model* wrote, and applying it to a member's
   * own message or to the bytes of an attached document silently rewrites
   * something the app has no business rewriting.
   */
  verbatim?: boolean;
}): React.JSX.Element {
  // One token per mounted body, so the links keep stable identity across renders.
  const token = useMemo(createConnectorMentionToken, []);
  // Mentions first, normalization second, and the order is load-bearing: the
  // connector offsets are measured against the stored text, so anything that
  // changes its length has to run after they have been resolved into links.
  const linked = withConnectorMentionLinks(children, mentions, token);
  const markdown = verbatim ? linked : normalizeModelMarkdown(linked);
  const messageId = telemetry?.messageId;
  const workstreamId = telemetry?.workstreamId;
  // Footnote ids are namespaced per mounted body. GFM writes the same
  // `fn-1`/`fnref-1` into every message otherwise, and a transcript is dozens
  // of mounts of it — so an anchor or an ARIA reference would resolve against
  // whichever message happened to render first.
  const prefix = `c${token}-`;
  // Parsed here rather than in the components' memo, because the definitions
  // change with the text and the components must not: they are what the settled
  // segments' memo compares by identity. The `[^` test is the fast path — the
  // overwhelming majority of messages have no footnotes at all, and this runs on
  // every commit of a streaming reply.
  const footnoteSource = markdown.includes('[^') ? markdown : '';
  const render = useMemo<CitationRender>(() => {
    const { citations: found, definitions, referenced } = citationFootnotes(footnoteSource);
    const numbers = new Map<string, number>();
    for (const identifier of referenced) {
      if (definitions.has(identifier)) numbers.set(identifier, numbers.size + 1);
    }
    return { ...(citations ? { citations } : {}), footnotes: found, numbers, prefix, still };
  }, [citations, footnoteSource, prefix, still]);
  // Stable across commits that change nothing they depend on, for two reasons:
  // the settled segments' memo compares them by identity, and the memoised
  // element below reuses the whole rendered body while they hold still.
  const { components, urlTransform } = useMemo(() => ({
    components: {
      a: ({ children: linkChildren, href, node, ...props }) => (
        <CitationLink
          anchor={{ ...props, href }}
          footnoteRef={node?.properties?.dataFootnoteRef !== undefined}
          href={href}
          identity={() => renderIdentity(href, linkChildren, mentions, token)}
        >{linkChildren}</CitationLink>
      ),
      img: ({ alt, node, src, ...props }) => {
        void node;
        return <CitationImage alt={alt} image={{ ...props, alt, src }} src={src} />;
      },
      li: ({ children: itemChildren, node, ...props }) => {
        void node;
        return <CitationFootnoteItem item={props}>{itemChildren}</CitationFootnoteItem>;
      },
      section: ({ children: sectionChildren, node, ...props }) => {
        // Only the footnote section is the citation renderer's business; GFM
        // emits no other, but a model writing raw HTML would not reach here
        // anyway — `rehype-raw` is deliberately not configured.
        if (node?.properties?.dataFootnotes === undefined) return <section {...props}>{sectionChildren}</section>;
        return <CitationFootnoteSection section={props}>{sectionChildren}</CitationFootnoteSection>;
      },
      code: (properties) => (
        <MarkdownCode
          {...properties}
          telemetry={messageId !== undefined && workstreamId !== undefined ? { messageId, workstreamId } : undefined}
        />
      ),
      pre: ({ children: preChildren }) => <>{preChildren}</>,
      table: MarkdownTable,
    } satisfies MarkdownComponents,
    urlTransform: ((url, key, node) => (
      // Every internal scheme reaches its component intact so the citation
      // matrix can decide there. The whole scheme passes, not only a
      // well-formed id: `defaultUrlTransform` empties what it rejects, and an
      // emptied target would reach the component as '' — indistinguishable
      // from a link with no target, and too late for the cell to know which
      // scheme it was. What the components then emit is never the raw value:
      // an identity is a chip or inert text, and a `resource://` target is a
      // chip, a card, or its label.
      isInternalCitationTarget(url, key, node.tagName)
        ? url
        : defaultUrlTransform(url)
    )) satisfies MarkdownUrlTransform,
  }), [mentions, messageId, token, workstreamId]);
  // A settled body's element is reused whenever the markdown has not changed,
  // so a commit elsewhere on the screen — another message streaming at 60
  // commits a second included — skips this subtree instead of re-parsing it.
  const rehypeOptions = useMemo<MarkdownRehypeOptions>(() => ({ clobberPrefix: prefix }), [prefix]);
  // The row pass is told what the matrix will draw, so it groups embeds only
  // where they become cards. A surface with no citation context takes the
  // hoisted empty list: without that, a run of `resource://` images that render
  // as their label text — which is what every such surface does — would be laid
  // out side by side in a horizontal scroller instead of reading as sentences.
  const rehypePlugins = useMemo<MarkdownRehypePlugins>(
    () => (citations
      ? [rehypeCitationEmbedRows((resourceId) => citations.resolve(resourceId) !== undefined)]
      : NO_REHYPE_PLUGINS),
    [citations],
  );
  const rendered = useMemo(() => {
    if (!streaming) {
      return (
        <ReactMarkdown
          components={components}
          rehypePlugins={rehypePlugins}
          remarkPlugins={REMARK_PLUGINS}
          remarkRehypeOptions={rehypeOptions}
          urlTransform={urlTransform}
        >
          {markdown}
        </ReactMarkdown>
      );
    }
    const { settled, tail } = splitStreamingMarkdown(markdown);
    return (
      <>
        {settled.map((segment, index) => (
          <SettledMarkdownSegment
            components={components}
            rehypePlugins={rehypePlugins}
            key={index}
            rehypeOptions={rehypeOptions}
            source={segment}
            urlTransform={urlTransform}
          />
        ))}
        <ReactMarkdown
          components={components}
          rehypePlugins={rehypePlugins}
          remarkPlugins={REMARK_PLUGINS}
          remarkRehypeOptions={rehypeOptions}
          urlTransform={urlTransform}
        >
          {tail}
        </ReactMarkdown>
      </>
    );
  }, [components, markdown, rehypeOptions, streaming, urlTransform]);
  // The provider sits outside the memoised body deliberately: a definition that
  // arrives mid-stream has to reach the pills, and a context update crosses a
  // `memo` boundary where a changed prop would have re-parsed everything under
  // it instead.
  return (
    <CitationsProvider value={render}>
      <div className="markdown-body">{rendered}</div>
    </CitationsProvider>
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

function AssistantMessageActions({ citations, mentions, telemetry, text }: {
  citations?: CitationContext;
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
        // The same context the turn above was rendered with: the card is the
        // turn, saved, and a chip that is a chip on screen must not be plain
        // text in the file somebody keeps. `still` is what the card does not
        // share with the turn — nothing in a picture can be hovered, so the
        // sources a pill's popover holds are printed under it instead.
        content: <MarkdownBody citations={citations} mentions={mentions} still>{text}</MarkdownBody>,
        // The file name slugs the first line the way the card *shows* it — a
        // saved image named `…-backlog-rightarrow-done` outlives the render
        // that repaired the text it pictures. Copy stays the stored bytes.
        fileName: messageExportFileName(normalizeModelText(text), messageExportDate(new Date())),
        format,
      });
    } catch (error) {
      // The label says one attempt failed; the console is where the reason is,
      // and it is the only trail a support conversation has to go on.
      logError('rally', `could not save this message as ${format === 'image' ? 'an image' : 'a PDF'}`, error);
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
  citations,
  // The hoisted constant, not `= []`: a per-render array here would feed
  // MarkdownBody an always-new `mentions` and defeat its streaming memo.
  mentions = NO_MENTIONS,
  showCopy = true,
  streaming = false,
  text,
  telemetry,
}: {
  citations?: CitationContext;
  mentions?: MessageMention[];
  showCopy?: boolean;
  streaming?: boolean;
  text: string;
  telemetry?: MessageCopyTelemetry;
}): React.JSX.Element {
  return (
    <>
      {text ? <MarkdownBody citations={citations} mentions={mentions} streaming={streaming} telemetry={telemetry}>{text}</MarkdownBody> : null}
      {showCopy && !streaming && text && (
        <AssistantMessageActions citations={citations} mentions={mentions} telemetry={telemetry} text={text} />
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
          <small>{tool.summary !== undefined ? normalizeModelText(tool.summary) : tool.status === 'started' ? 'Running…' : tool.status}</small>
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
          <div><h4>Activity</h4><p>{normalizeModelText(tool.summary)}</p></div>
        )}
        {tool.status === 'ambiguous' && <p className="tool-warning">Rally could not confirm whether this external action completed. It will not retry automatically.</p>}
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
 * A system row: the note Rally leaves in the transcript when something happened
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

  if (message.statusEvent) {
    return (
      <div className="assistant-turn-status-pill" id={`message-${message.id}`} role="status">
        <CircleAlert aria-hidden="true" size={12} />
        <span>{text}</span>
      </div>
    );
  }

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

/**
 * How a settled response's total reads in a message header.
 *
 * Null is an unknown duration, not a zero one, and the header then says only
 * that Rally worked — the same rule the plugin rows follow, for the same
 * reason: a transcript that cannot see how long something took must not
 * report a time it does not have.
 */
function workSummaryLabel(summary: NonNullable<Message['workSummary']>): string {
  if (summary.durationMs === null) return 'Worked';
  const duration = formatDuration(summary.durationMs) ?? '0ms';
  return summary.timingAccuracy === 'upper_bound'
    ? `Worked for at most ${duration}`
    : `Worked for ${duration}`;
}

function ThoughtBlock({ message }: { message: Message }): React.JSX.Element | null {
  const thought = message.thoughtEvent;
  if (!thought) return null;
  return (
    <AgentWorkTiming
      active={thought.status === 'started'}
      // This block renders both kinds of thought row — a turn's thinking and a
      // response's overall work — so the subject comes from the row's own verb
      // rather than being fixed here: "Rally is thinking", "Rally is working".
      activeName={`Rally is ${thought.activeVerb ?? 'working'}`}
      durationMs={thought.durationMs}
      monotonicStartedAt={thought.monotonicStartedAt}
      timingAccuracy={thought.timingAccuracy}
      activeVerb={thought.activeVerb}
      completedVerb={thought.completedVerb}
      {...(thought.startedAt === undefined ? {} : { startedAt: thought.startedAt })}
    />
  );
}

/**
 * The shapes no company owns. Everything else is a brand's own mark and comes
 * from `PLUGIN_BRAND_MARKS` instead.
 */
const unbrandedIconByKey: Record<Exclude<PluginGroupIcon, PluginBrandMark | 'rally'>, TablerIcon> = {
  computer: IconDeviceDesktop,
  plug: IconPlug,
  web: IconWorldSearch,
  webhook: IconWebhook,
};

/**
 * A brand's mark, or the line icon that stands in where there is no brand.
 *
 * Rally's own mark and every company mark are painted through a mask — see
 * `plugin-marks.ts` for why — so they take `currentColor` like the line icons
 * beside them and need no per-theme artwork.
 */
function PluginGlyphMark({ icon }: { icon: PluginGroupIcon }): React.JSX.Element {
  if (icon === 'rally') return <RallyMark className="plugin-face-mark" />;
  // The guard narrows, so the table below stays exhaustive over what is left
  // and a glyph added to one table but not the other is a typecheck failure
  // rather than an undefined component at render time.
  if (isPluginBrandMark(icon)) return <ConnectorMark className="plugin-face-mark" mark={icon} />;
  const PluginIcon = unbrandedIconByKey[icon];
  return <PluginIcon aria-hidden="true" size={15} stroke={1.8} />;
}

/**
 * The mark for one plugin, drawn bare.
 *
 * No chip, no ring: a row of enclosed glyphs reads as a toolbar, and these are
 * not controls. The glyph takes a single high-contrast neutral rather than each
 * connector's brand colour, because a brand colour chosen to sit on its own
 * chip has no guaranteed contrast against a transcript in four themes.
 *
 * `pulsing` is how a group says it is still working. It replaces the per-plugin
 * spinner: one mark that breathes carries the same fact in the space the mark
 * already occupies.
 */
function PluginGlyph({ icon, name, pulsing = false }: {
  icon: PluginGroupIcon;
  name: string;
  pulsing?: boolean;
}): React.JSX.Element {
  return (
    <span
      aria-label={`Plugin: ${name}`}
      className={clsx('plugin-face', `plugin-face-${icon}`, pulsing && 'plugin-face-active')}
      role="img"
      title={name}
    >
      <PluginGlyphMark icon={icon} />
    </span>
  );
}

/** A row shows the plugin that owns the tool it ran, so there is only ever one. */
function PluginFace({ plugin }: { plugin: AutomationPluginActivity }): React.JSX.Element {
  return <PluginGlyph icon={pluginGroupIconForContract(plugin.icon)} name={plugin.displayName} />;
}

/**
 * One plugin's stretch of work, standing in for every tool call it made.
 *
 * The wording is the plugin's own — "Slack is working for 4m 02s" becoming
 * "Slack worked for 5m 02s" — so the row reads as a place rather than as a
 * mechanism, which is the whole point of hiding the calls underneath it.
 */
function PluginActivityBlock({ message }: { message: Message }): React.JSX.Element | null {
  const group = message.pluginActivity;
  if (!group) return null;
  return (
    <AgentWorkTiming
      active={group.active}
      activeName={group.activeVerb}
      activeVerb={group.activeVerb}
      completedVerb={group.completedVerb}
      durationMs={group.durationMs}
      icon={<PluginGlyph icon={group.icon} name={group.name} pulsing={group.active} />}
      monotonicStartedAt={group.monotonicStartedAt}
      timingAccuracy={group.timingAccuracy}
    />
  );
}

function elicitationAnswerLabel(elicitation: ElicitationData): string {
  const answer = elicitation.answer;
  if (answer == null) return 'Skipped';
  const values = Array.isArray(answer) ? answer : [String(answer)];
  const labels = values.map((value) => elicitation.options?.find((option) => option.value === value)?.label ?? value);
  // The labels come from the same model call as the question, so they take the
  // same plain-text repair the question does.
  return normalizeModelText(labels.join(', '));
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
        <span>Rally needs input</span>
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
          // `isComposing` is set on every key dispatched during a composition,
          // chords included, and this one answers a question that resumes a
          // paused run: submitting mid-composition would send the pre-conversion
          // reading as the answer. See `../lib/ime.ts`.
          if (isComposingKeyEvent(event.nativeEvent)) return;
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
              <span className="elicitation-option-copy"><strong>{normalizeModelText(option.label)}</strong>{option.description && <small>{normalizeModelText(option.description)}</small>}</span>
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
  /**
   * How this transcript resolves and opens a citation. Absent on a surface
   * without a work stream behind it, which is exactly when every citation in a
   * message degrades to the label text it already carried.
   */
  citations?: CitationContext;
  currentUserId?: string;
  message: Message;
  loadAttachmentContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpenAttachment?: (preview: AttachmentPreview) => void;
  onAnswerElicitation: (elicitationId: string, answer: string | string[] | null, customResponse?: string) => Promise<void>;
  onResolveSuggestion: (suggestionId: string, action: 'accept' | 'dismiss') => Promise<void>;
  systemRowDisclosure?: SystemRowDisclosure;
}

export function MessageBlock({
  citations,
  currentUserId,
  loadAttachmentContent,
  message,
  onAnswerElicitation,
  onOpenAttachment,
  onResolveSuggestion,
  systemRowDisclosure,
}: MessageBlockProps): React.JSX.Element {
  if (message.messageType === 'thought') return <div className="transcript-event" id={`message-${message.id}`}><ThoughtBlock message={message} /></div>;
  if (message.messageType === 'tool_event') return <div className="transcript-event" id={`message-${message.id}`}><ToolBlock message={message} /></div>;
  if (message.messageType === 'plugin_activity') return <div className="transcript-event" id={`message-${message.id}`}><PluginActivityBlock message={message} /></div>;
  if (message.messageType === 'elicitation' && message.elicitation) {
    if (message.elicitation.status === 'answered') {
      const externalResponse = message.authorType === 'external';
      const ownHumanResponse = (message.authorType === 'human'
        && currentUserId !== undefined
        && message.author?.id === currentUserId)
        // The automation builder resolves its assistant-authored question in
        // place before it appends the person's follow-up turn. That local-only
        // representation has no second author record, but it can only be the
        // signed-in person's response; canonical work-stream answers arrive as
        // attributed human or external turns.
        || (message.authorType === 'agent' && message.author === undefined);
      const responseAuthor = externalResponse
        ? `${message.externalActor?.displayName ?? 'Slack workspace member'} · Slack`
        : message.author?.name ?? 'Workspace member';
      return (
        <article
          aria-label={ownHumanResponse ? 'Your elicitation response' : `Response from ${responseAuthor}`}
          className={clsx(
            'message-block human-message elicitation-response-message',
            ownHumanResponse ? 'own-human-message' : 'coworker-message',
          )}
          id={`message-${message.id}`}
        >
          {!ownHumanResponse && <header><span aria-hidden="true" className="message-author-dot" /><span className="message-author">{responseAuthor}</span><time dateTime={message.createdAt}>{formatRelative(message.createdAt)}</time></header>}
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
  if (message.messageType === 'activity_suggestion' && message.activitySuggestion) {
    return <div className="transcript-event" id={`message-${message.id}`}><SuggestionBlock onResolve={(action) => onResolveSuggestion(message.activitySuggestion!.id, action)} suggestion={message.activitySuggestion} /></div>;
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
  const pending = message.deliveryState === 'steer_pending'
    || message.deliveryState === 'queue_pending';
  const pendingLabel = message.deliveryState === 'steer_pending'
    ? 'Will steer after this response'
    : message.deliveryState === 'queue_pending'
      ? 'Queued for the next loop'
      : null;
  return (
    <article
      aria-label={sending ? 'Sending message' : pending && pendingLabel
        ? `${pendingLabel}: message from ${humanAuthorName}`
        : human ? `Message from ${humanAuthorName}` : undefined}
      aria-busy={message.streaming || sending || undefined}
      className={clsx(
        'message-block',
        human ? 'human-message' : 'agent-message',
        human && (ownHumanMessage ? 'own-human-message' : 'coworker-message'),
        message.streaming && 'is-streaming',
        sending && 'is-sending',
        pending && 'is-pending-delivery',
      )}
      id={`message-${message.id}`}
      style={human ? { '--person-accent': personAccent(message.author?.id ?? message.externalActor?.providerUserId ?? message.id) } as React.CSSProperties : undefined}
    >
      {/* Your own turn carries no identity line — you know who you are. A
          context label is the exception, and the reason the header renders at
          all here: a suggested-work brief is attributed to the person who
          selected it but written by Rally, so the line saying where the words
          came from is the only thing standing between them and a turn they do
          not remember typing. The name stays suppressed; only the label and the
          time appear. */}
      {!sending && (!human || !ownHumanMessage || message.contextLabel) && (
        <header>
          {!ownHumanMessage && (
            <>
              {human && <span aria-hidden="true" className="message-author-dot" />}
              <span className="message-author">{human ? humanAuthorName : 'Rally'}</span>
            </>
          )}
          {message.contextLabel && <span className="message-context-label">{message.contextLabel}</span>}
          <time dateTime={message.createdAt}>{formatRelative(message.createdAt)}</time>
          {message.workSummary && <span className="message-work-summary">{workSummaryLabel(message.workSummary)}</span>}
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
                    verbatim
                  >{message.text}</MarkdownBody>
                </div>
              ) : null}
              {pendingLabel && <span className="message-delivery-pill">{pendingLabel}</span>}
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
                citations={citations}
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
