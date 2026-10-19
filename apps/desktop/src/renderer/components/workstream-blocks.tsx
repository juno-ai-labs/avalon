import { MessageAnnotations } from './artifact-annotations';
import { rehypeAnnotationSource } from '../lib/annotation-source';
import clsx from 'clsx';
import { personalColor, personalColorInk } from './personal-avatar';
import { MemberPresentationContext } from '../lib/member-presentation';
import {
  IconBrain,
  IconDeviceDesktop,
  IconImageGeneration,
  IconAlertTriangle,
  IconCircleCheck,
  IconCornerDownRight,
  IconCornerUpLeft,
  IconKeyframes,
  IconMailAi,
  IconPlug,
  IconStackBackward,
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
  Square,
  TerminalSquare,
  Volume2,
  X,
} from 'lucide-react';
import { Children, Fragment, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type PropsWithChildren } from 'react';
import { Highlight, Prism, type Language, type PrismTheme } from 'prism-react-renderer';
import {
  citationFootnotes,
  citationScheme,
  connectorMentionHref,
  connectorTypeFromEmbedHref,
  connectorTypeFromMentionHref,
  footnoteReferencePattern,
  isConnectorHref,
  openFootnoteReferencePattern,
  personIdFromMentionHref,
  personMentionMarkdownRanges,
} from '@rally/contracts/citations';
import {
  ConnectorConnectionCard,
  ConnectorConnectionUpdateCard,
  ConnectorResourceAuthorizationCard,
  ConnectorEmbedCard,
  ConnectorMentionChip,
  connectorConnectionCardInput,
  connectorConnectionCardProvider,
  connectorConnectionCardSelectionKey,
  isUnrecognizedConnectorConnectionCard,
  connectorResourceAuthorizationRequest,
} from './connector-mentions';
import { markdownLineKinds } from '@rally/contracts/markdown-code';
import { normalizeModelMarkdown, normalizeModelText } from '@rally/contracts/model-markdown';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { logError } from '../../common/logger';
import { messageExportDate, messageExportFileName, type MessageExportFormat } from '../../common/message-export';
import { formatDuration } from '../lib/format';
import { isComposingKeyEvent } from '../lib/ime';
import {
  markdownDefinitionBlocks,
  splitCollapsibleMarkdown,
  withMarkdownDefinitions,
} from '../lib/markdown-collapse';
import { saveMessageExport } from '../lib/message-export';
import { desktopBridge, desktopServicesAvailable } from '../lib/platform';
import { useCopy } from '../lib/use-copy';
import { useEmailMentionTarget } from '../lib/workspace-invitees';
import { bareAddressAutolink, EMAIL_MENTION, EMAIL_MENTION_AT } from '@rally/contracts/email-mentions';
import { pluginGroupIconForContract, type PluginGroupIcon } from '../lib/plugin-groups';
import { isPluginBrandMark, type PluginBrandMark } from '../lib/plugin-marks';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import { httpHostname, useHostFavicon } from '../lib/host-favicon';
import { isThinkingEvent, thoughtVerb } from '../lib/transcript';
import type { ElicitationData, Message, MessageAttachment, MessageMention, MessageMergedInto, WorkTotal } from '../lib/types';
import { useTextClamped } from '../lib/use-text-clamped';
import { AgentWorkTiming } from './agent-work-timing';
import { MessageByline } from './message-byline';
import { MessageTextMenu } from './message-text-menu';
import {
  MarkdownCollapseAllButton,
  MarkdownCollapseController,
  MarkdownCollapseH2,
  MarkdownCollapseH3,
  MarkdownCollapseH4,
  MarkdownCollapseH5,
  MarkdownCollapseH6,
  MarkdownCollapseSection,
  useMarkdownCollapse,
} from './markdown-collapse';
import { MarkdownMermaid } from './markdown-mermaid';
import {
  CitationEmbedRow,
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
import { MergedIntoDivider, MergeMessage } from '@rally/ui/components/merge-message';
import { Avatar, Button, ConnectorMark, InlineError, RallyAvatar, RallyMark, Tip, TipGroup } from './primitives';
import { RelativeTime } from './relative-time';
import { useSpeechPlayback } from './speech-playback';

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

/**
 * The accent a person's turn is drawn with, from whichever identity the turn
 * actually carries.
 *
 * Both human rows — the ordinary authored one and a settled elicitation answer —
 * state this on the article, and both have to state the *same* thing: the dot's
 * background resolves through `--person-accent`, so a row that omits it paints
 * a transparent dot and leaves the byline half-drawn. "These two rows are the
 * same row" is the claim this file makes; a copied expression is how that stops
 * being true. The name no longer reads it: the byline's ink is the same for
 * everybody, and only the dot carries whose turn this is.
 */
function turnAccent(message: Message): string {
  return personAccent(message.author?.id ?? message.externalActor?.providerUserId ?? message.id);
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

function MarkdownCodeBlock({ code, glance, language, renderDiagrams, telemetry, annotationRange }: {
  code: string;
  annotationRange?: [number,number] | undefined;
  glance?: boolean;
  language: string;
  renderDiagrams?: boolean;
  telemetry?: MessageCopyTelemetry;
}): React.JSX.Element {
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

  // The header's control is its own element rather than a `CopyButton`: the
  // block renders wherever markdown does, including a card drawn for export
  // with no tooltip provider above it, and the header's rule already sizes and
  // paints the button. The behaviour underneath is still the shared one.
  const { copy, state: copyState } = useCopy({
    value: code,
    onCopied: () => {
      if (telemetry) reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'code_block', resourceType: 'message',
        resourceId: telemetry.messageId, workstreamId: telemetry.workstreamId,
      });
    },
  });

  const highlighted = (
    <Highlight code={code} language={highlightedLanguage} theme={markdownCodeTheme}>
      {({ className, getLineProps, getTokenProps, style, tokens }) => (
        <pre className={className} style={style}>
          <code data-annotation-text={annotationRange ? true : undefined} data-annotation-start={annotationRange?.[0]} data-annotation-end={annotationRange?.[1]}>
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
  );

  return (
    <div className="markdown-code-block" data-language={normalizedLanguage}>
      {glance ? null : (
        <div className="markdown-code-block-header">
          <span className="markdown-code-language">{languageLabel}</span>
          <button
            aria-label={copyState === 'copied' ? 'Code copied' : copyState === 'failed' ? 'Copy failed — click to retry' : 'Copy code'}
            data-clipboard-exclude=""
            onClick={() => void copy()}
            type="button"
          >
            {copyState === 'copied'
              ? <Check aria-hidden="true" size={14} />
              : copyState === 'failed'
                ? <CircleAlert aria-hidden="true" size={14} />
                : <Copy aria-hidden="true" size={14} />}
          </button>
        </div>
      )}
      {renderDiagrams && normalizedLanguage === 'mermaid'
        ? <MarkdownMermaid code={code} fallback={highlighted} />
        : highlighted}
    </div>
  );
}

function MarkdownCode({ children, className, glance, renderDiagrams, telemetry, annotationRange }: React.ComponentProps<'code'> & {
  glance?: boolean;
  renderDiagrams?: boolean;
  telemetry?: MessageCopyTelemetry;
  annotationRange?: [number,number] | undefined;
}): React.JSX.Element {
  const source = String(children ?? '');
  const languageMatch = /(?:^|\s)language-([\w#+.-]+)/u.exec(className ?? '');
  const isBlock = Boolean(languageMatch) || source.endsWith('\n');

  if (!isBlock) return <code className="markdown-inline-code" data-annotation-text={annotationRange ? true : undefined} data-annotation-start={annotationRange?.[0]} data-annotation-end={annotationRange?.[1]}>{children}</code>;

  return (
    <MarkdownCodeBlock
      code={source.replace(/\n$/u, '')}
      annotationRange={annotationRange}
      glance={glance}
      language={languageMatch?.[1]?.toLowerCase() ?? ''}
      renderDiagrams={renderDiagrams}
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

/**
 * Models write `<br/>` for a line break — especially inside a GFM table cell,
 * which cannot contain a real newline without ending the row. This renderer
 * does not parse HTML (`rehype-raw` is deliberately off), so those tags would
 * otherwise print as characters, or vanish when micromark classifies them as
 * `html` and remark-rehype drops the node. The rewrite is the closed
 * exception: a bare break tag becomes an mdast `break`, which is a real
 * `<br>` downstream. Code is skipped, because a sample may be showing the
 * tag on purpose.
 *
 * It runs on every body, verbatim included. This is a renderer affordance for
 * one HTML tag, not a repair of what a model meant — a stored document's table
 * uses the same workaround, and rewriting it is showing the line break the
 * file asked for.
 *
 * The pattern is a bare tag only. `<br class="x">` and every other element
 * stay as they were, which is what keeps this from becoming an HTML parser.
 */
const BARE_BREAK_TAG = /^<br\s*\/?>$/iu;

/**
 * The slice of an mdast node the two rewrites below read. Structural rather
 * than imported: the renderer depends on `mdast` only transitively through
 * react-markdown. `data` is remark-rehype's element escape hatch — a node
 * carrying `hName`/`hProperties`/`hChildren` becomes exactly that element,
 * which is how the pending citation pill exists without a Markdown syntax of
 * its own.
 */
interface MarkdownRewriteNode {
  type: string;
  value?: string;
  children?: MarkdownRewriteNode[];
  /** Where this node came from in the source, which is how an escape is told from what it decoded to. */
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    /** `never[]` because the only element built this way is empty: a skeleton has nothing to say. */
    hChildren?: never[];
  };
}

function remarkHtmlBreaks() {
  return (tree: unknown) => {
    rewriteMarkdownBreaks(tree as MarkdownRewriteNode);
  };
}

/** Chat input uses newlines as visible breaks, unlike document soft wrapping. */
function remarkSoftBreaks() {
  return (tree: unknown) => {
    const visit = (node: MarkdownRewriteNode): void => {
      // Labels must stay text for mention/citation resolution; code is literal.
      if (node.type === 'link' || node.type === 'code' || node.type === 'inlineCode') return;
      const children = node.children;
      if (!children) return;
      node.children = children.flatMap((child, index) => {
        if (child.type === 'text' && child.value !== undefined && /[\r\n]/u.test(child.value)) {
          let value = child.value.replace(/\r\n?/gu, '\n');
          // A bare <br> already owns its surrounding line break. Do not add
          // blank lines around it, or at the edges of a parsed paragraph.
          if (index === 0 || children[index - 1]?.type === 'break') value = value.replace(/^\n+/u, '');
          if (index === children.length - 1 || children[index + 1]?.type === 'break') value = value.replace(/\n+$/u, '');
          return value.split('\n').flatMap((part, partIndex) => [
            ...(partIndex > 0 ? [{ type: 'break' }] : []),
            ...(part ? [{ type: 'text', value: part }] : []),
          ]);
        }
        visit(child);
        return [child];
      });
    };
    visit(tree as MarkdownRewriteNode);
  };
}

/**
 * A typed `@Rally` in a person's message, matched with the composer's own
 * boundaries (`mention-highlight.ts`): an opening space or bracket before the
 * `@`, and a space, punctuation, or the end after the name.
 */
const RALLY_MENTION = /(^|[\s([{])(@rally)(?=[\s\p{P}]|$)/giu;

/**
 * Rally's chip: the person chip's shape with Rally's own avatar. Built from
 * nested `hName` nodes, so remark-rehype emits the spans directly and no
 * component or link scheme stands behind it for message text to forge.
 */
function rallyMentionNode(): MarkdownRewriteNode {
  return {
    type: 'rallyMention',
    data: { hName: 'span', hProperties: { className: ['mention-chip', 'mention-chip-rally'] } },
    children: [
      {
        type: 'rallyMentionAvatar',
        data: { hName: 'span', hProperties: { className: ['mention-chip-avatar', 'mention-chip-avatar-rally'], 'aria-hidden': 'true' } },
        children: [{ type: 'rallyMentionInitial', data: { hName: 'span' }, children: [{ type: 'text', value: 'R' }] }],
      },
      {
        type: 'rallyMentionLabel',
        data: { hName: 'span', hProperties: { className: ['mention-chip-label'] } },
        children: [{ type: 'text', value: 'Rally' }],
      },
    ],
  };
}

/**
 * Where an `@address` goes: a span the `span` override resolves against the
 * Organization's people when it renders, which is what lets the chip read as
 * the person's name once they join. Its text is the fallback, so an address
 * nobody here holds stays exactly as written.
 */
function emailMentionNode(email: string): MarkdownRewriteNode {
  return {
    type: 'emailMention',
    data: { hName: 'span', hProperties: { dataEmailMention: email.toLowerCase() } },
    children: [{ type: 'text', value: `@${email}` }],
  };
}

/** `@Rally` and `@address` chips out of one text node, or nothing when it names neither. */
function typedMentionParts(value: string): MarkdownRewriteNode[] | null {
  const found = [
    ...[...value.matchAll(RALLY_MENTION)].map((match) => ({
      start: match.index + match[1]!.length, length: match[2]!.length, node: rallyMentionNode(),
    })),
    ...[...value.matchAll(EMAIL_MENTION)].map((match) => ({
      start: match.index + match[1]!.length, length: match[2]!.length, node: emailMentionNode(match[3]!),
    })),
  ].sort((left, right) => left.start - right.start);
  if (found.length === 0) return null;
  const parts: MarkdownRewriteNode[] = [];
  let cursor = 0;
  for (const item of found) {
    if (item.start < cursor) continue;
    if (item.start > cursor) parts.push({ type: 'text', value: value.slice(cursor, item.start) });
    parts.push(item.node);
    cursor = item.start + item.length;
  }
  if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) });
  return parts;
}

/**
 * Draws a person's `@Rally` and `@address` as chips. Neither carries a stored
 * mention identity, so the text is the mention, exactly as the composer
 * highlights it. Links keep their labels and code stays literal; the one link
 * read is the `mailto:` GFM makes of a bare address, which an `@` before it
 * turns back into a mention.
 */
function remarkRallyMentions() {
  return (tree: unknown, file: { value?: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '');
    const visit = (node: MarkdownRewriteNode): void => {
      if (node.type === 'link' || node.type === 'code' || node.type === 'inlineCode') return;
      const children = node.children;
      if (!children) return;
      const rebuilt: MarkdownRewriteNode[] = [];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]!;
        if (child.type !== 'text' || child.value === undefined) {
          visit(child);
          rebuilt.push(child);
          continue;
        }
        let value = child.value;
        const address = EMAIL_MENTION_AT.test(value) ? bareAddressAutolink(children[index + 1], source) : undefined;
        if (address !== undefined) value = value.slice(0, -1);
        const parts = typedMentionParts(value);
        if (parts) rebuilt.push(...parts);
        else if (value) rebuilt.push({ ...child, value });
        if (address !== undefined) {
          rebuilt.push(emailMentionNode(address));
          index += 1;
        }
      }
      node.children = rebuilt;
    };
    visit(tree as MarkdownRewriteNode);
  };
}

function rewriteMarkdownBreaks(node: MarkdownRewriteNode): void {
  if (node.type === 'code' || node.type === 'inlineCode') return;
  const children = node.children;
  if (children === undefined) return;
  let rebuilt: MarkdownRewriteNode[] | undefined;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (child.type === 'html' && child.value !== undefined && BARE_BREAK_TAG.test(child.value.trim())) {
      rebuilt ??= children.slice(0, index);
      rebuilt.push({ type: 'break' });
      continue;
    }
    rewriteMarkdownBreaks(child);
    rebuilt?.push(child);
  }
  if (rebuilt !== undefined) node.children = rebuilt;
}

/**
 * The skeleton a citation wears between being written and being defined.
 *
 * A GFM footnote reference is only a reference to a parser that can already
 * see its definition. While a turn streams, the model writes `[^avalon]` in a
 * sentence and the `[^avalon]: [file](resource://…)` that defines it seconds
 * later, at the bottom — so for the whole intervening stretch remark-gfm reads
 * the marker as ordinary text and the reader watches raw `[^avalon]` sit in
 * the middle of a paragraph until the turn settles. On a long grounded answer
 * that is most of the answer's lifetime, and it is the one place Rally shows
 * somebody its own markup.
 *
 * What goes there instead is the pill's own box with the number not yet in it:
 * same font size, same padding, same raise off the baseline, so the line does
 * not reflow when the definition lands and the pill takes over. It is
 * `aria-hidden` because it names nothing — a screen reader gets the source
 * when the pill arrives with its label, and a shimmering rectangle announced
 * as "1" would be a claim about a citation nobody has read yet.
 *
 * **Streaming only.** A settled message whose definition never arrived keeps
 * its literal `[^avalon]`, which is the honest rendering of a reference to
 * nothing; a permanent skeleton would promise a source that is never coming.
 */
function pendingCitationNode(): MarkdownRewriteNode {
  return {
    type: 'pendingCitation',
    data: {
      hName: 'span',
      hProperties: { className: ['citation-pill-pending'], 'aria-hidden': 'true' },
      hChildren: [],
    },
  };
}

/**
 * The pending-pill rewrite, over the text remark-gfm left behind.
 *
 * It reads no definitions and asks the document no questions, which is what
 * keeps it a hoisted constant rather than a per-render closure: a reference
 * whose definition this parse *can* see is already a `footnoteReference` node
 * and never reaches a text node at all. So "still a `[^…]` in the text" is
 * exactly "not resolved here", decided by the parser rather than restated.
 * Code is skipped for free — an inline span and a fenced block both hold their
 * source as their own `value`, not as text children — which is what keeps a
 * message *explaining* footnote syntax from sprouting skeletons.
 *
 * The tail variant below adds the reference that is still being typed. Only
 * the stream's final segment gets it: there the last text node may hold a
 * half-arrived `[^ava`, and letting that grow a character at a time in front
 * of the reader is the same raw markup by a slower route. Everywhere else the
 * text has settled, and a trailing `[^` is a bracket a model wrote.
 *
 * Both variants read the source through {@link undecodedPrefixLength} rather
 * than trusting the decoded value, because `\[^avalon]` and `&#91;^avalon]`
 * both decode to the same characters as the real thing.
 */
function remarkPendingCitations() {
  return (tree: unknown, file: unknown) => {
    rewriteFootnoteReferences(tree as MarkdownRewriteNode, String(file));
  };
}

/** The same rewrite at the open end of the stream. */
function remarkPendingTailCitations() {
  return (tree: unknown, file: unknown) => {
    const root = tree as MarkdownRewriteNode;
    const source = String(file);
    rewriteFootnoteReferences(root, source);
    rewriteOpenFootnoteReference(root, source);
  };
}

/**
 * How much of a text run is still the characters the author actually typed.
 *
 * A text node is the *decoded* run: `\[^avalon]` and `&#91;^avalon]` both
 * reach a plugin as `[^avalon]`, indistinguishable from a real unresolved
 * reference, because micromark consumes the escape and the entity before any
 * transformer runs. A rewrite that trusted the value would put a skeleton over
 * syntax somebody escaped precisely in order to *show* — and then take it away
 * at settle, when the source is re-parsed and the escape is honoured.
 *
 * So the run is compared against its own source span, and what is returned is
 * the length of their common prefix: the point up to which nothing has been
 * decoded. A match that ends at or before it came from literal characters. A
 * match reaching past it might not have, and is left alone.
 *
 * A prefix rather than a whole-run verdict, and rather than an offset mapping.
 * A verdict on the run would lose a real citation's skeleton because an escape
 * appeared *later in the same paragraph* — and, while streaming, lose it
 * halfway through, so the skeleton would appear and then revert to raw
 * `[^avalon]` as the escape arrived. A prefix cannot do that: whether a match
 * qualifies depends only on the text before it, which has already arrived and
 * will not change, so a skeleton drawn once is never taken back. Mapping a
 * decoded offset back through an escape would be exact in both directions, but
 * it needs a running correspondence between two strings of different lengths —
 * a second decoder to keep in step with micromark's, to buy the case where an
 * escape precedes a real citation in one run.
 */
function undecodedPrefixLength(node: MarkdownRewriteNode, source: string): number {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  const value = node.value;
  // A synthesized node has no span to check against, so nothing in it counts
  // as source this may read a reference out of.
  if (start === undefined || end === undefined || value === undefined) return 0;
  const raw = source.slice(start, end);
  let index = 0;
  while (index < raw.length && index < value.length && raw[index] === value[index]) index += 1;
  return index;
}

function rewriteFootnoteReferences(node: MarkdownRewriteNode, source: string): void {
  const children = node.children;
  if (children === undefined) return;
  let rebuilt: MarkdownRewriteNode[] | undefined;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const split = child.type === 'text' && child.value !== undefined
      ? splitFootnoteReferences(child.value, undecodedPrefixLength(child, source))
      : undefined;
    if (split !== undefined) {
      rebuilt ??= children.slice(0, index);
      rebuilt.push(...split);
      continue;
    }
    rewriteFootnoteReferences(child, source);
    rebuilt?.push(child);
  }
  if (rebuilt !== undefined) node.children = rebuilt;
}

/**
 * The pieces of a text node with its unresolved references lifted out, or
 * `undefined` for text with none to lift — which includes text whose only
 * matches reach past `literalUpTo` into decoded characters.
 */
function splitFootnoteReferences(value: string, literalUpTo: number): MarkdownRewriteNode[] | undefined {
  const pattern = footnoteReferencePattern();
  const pieces: MarkdownRewriteNode[] = [];
  let consumed = 0;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    if (match.index + match[0].length > literalUpTo) break;
    if (match.index > consumed) pieces.push({ type: 'text', value: value.slice(consumed, match.index) });
    pieces.push(pendingCitationNode());
    consumed = match.index + match[0].length;
  }
  if (pieces.length === 0) return undefined;
  if (consumed < value.length) pieces.push({ type: 'text', value: value.slice(consumed) });
  return pieces;
}

/**
 * The reference that is still being typed: the document's last leaf, when it
 * is text ending in a marker whose bracket has not closed.
 *
 * Descending to the last leaf rather than scanning is what keeps an open
 * fence out of it — a code node holds its source as a value and is not text —
 * and what keeps this from firing on a `[^` in the middle of settled prose.
 *
 * A bare trailing `[` is dropped rather than covered. One character in, the
 * stream has not said what it is: `[^1]`, `[Title](…)`, a task list's `[ ]`,
 * or a bracket in prose. A skeleton there would flash a pill in front of every
 * link, and leaving it would put the opening bracket of a citation on screen —
 * which is the whole thing this rewrite exists to prevent. Showing nothing for
 * the one frame before the next character decides it is the only answer that
 * is right whichever it turns out to be.
 */
function rewriteOpenFootnoteReference(node: MarkdownRewriteNode, source: string): void {
  const children = node.children;
  if (children === undefined || children.length === 0) return;
  const last = children[children.length - 1]!;
  if (last.children !== undefined && last.children.length > 0) {
    rewriteOpenFootnoteReference(last, source);
    return;
  }
  if (last.type !== 'text' || last.value === undefined) return;
  const match = openFootnoteReferencePattern().exec(last.value);
  // The open marker runs to the end of the text, so it qualifies only when
  // nothing in the run was decoded on the way to it.
  if (match === null || last.value.length > undecodedPrefixLength(last, source)) return;
  const before = last.value.slice(0, match.index);
  children.splice(
    children.length - 1,
    1,
    ...(before ? [{ type: 'text', value: before }] : []),
    // `[` alone is not yet a citation, so it waits rather than wearing a pill.
    ...(match[0] === '[' ? [] : [pendingCitationNode()]),
  );
}

function personIdFromHref(href: string | undefined): string | undefined {
  return personIdFromMentionHref(href);
}

/**
 * A `connector:` / `connector://` link counts only when it carries this render's
 * token. The token is minted in the browser and never appears in the stored
 * message, so a link someone wrote into the text cannot carry it — no guessing
 * at labels or offsets.
 */
export function createConnectorMentionToken(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/gu, '')
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function tokenedConnectorType(href: string | undefined, token: string): string | undefined {
  return connectorTypeFromMentionHref(href, token);
}

/**
 * Keeps a label literal: brackets would end the link, emphasis marks would style
 * it, and `&` would let a character reference decode into something else.
 */
function escapeMarkdownLabel(label: string): string {
  return label
    .replace(/&/gu, '&amp;')
    .replace(/[\\[\]*_`~]/gu, (character) => `\\${character}`);
}

/** The rendered label of a link, when it is a single plain string. */
function linkLabelText(children: React.ReactNode): string | undefined {
  const parts = Children.toArray(children);
  if (parts.length !== 1) return undefined;
  return typeof parts[0] === 'string' ? parts[0] : undefined;
}

/**
 * Person mentions arrive as durable `[@Name](person://<id>)` Markdown — bare
 * `person:<id>` still resolves — but a connection mention stays human-readable
 * text because Rally has no identity-bearing connector reference yet. Its
 * stored offsets are still authoritative, so this turns them into the same link
 * shape at render time — presentation only, leaving the message text models and
 * Slack see untouched.
 *
 * Each emitted link carries `token`, which is what makes it authoritative: a
 * `connector:` / `connector://` link already present in the message text is
 * something a person or a model wrote, cannot carry the token, and must not be
 * dressed as a mention.
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
    output += `[${escapeMarkdownLabel(source)}](${connectorMentionHref(token, connectorType)})`;
    cursor = endOffset;
  }
  return output + text.slice(cursor);
}

const RENDERED_PERSON_MENTION_PREFIX = 'person://render:';

function renderedPersonMentionHref(token: string, personId: string): string {
  return `${RENDERED_PERSON_MENTION_PREFIX}${token}:${personId}`;
}

function renderedPersonId(href: string | undefined, token: string): string | undefined {
  const prefix = `${RENDERED_PERSON_MENTION_PREFIX}${token}:`;
  if (!href?.toLowerCase().startsWith(prefix.toLowerCase())) return undefined;
  return personIdFromMentionHref(`person:${href.slice(prefix.length)}`);
}

/**
 * Mint render-local identity links only for the exact authoritative ranges.
 * A second model-authored link to the same person must not borrow authority
 * from the first one merely because its destination has the same id.
 */
function withAuthoritativeMentionLinks(text: string, mentions: MessageMention[], token: string): string {
  const candidates = mentions
    .filter((mention) => mention.type === 'connector' ? mention.connectorType : mention.personId)
    .sort((left, right) => left.startOffset - right.startOffset);
  if (candidates.length === 0) return text;
  const hasPersonCandidate = candidates.some((mention) => mention.type === 'person');
  const personRanges = new Set((hasPersonCandidate ? personMentionMarkdownRanges(text) : []).map((range) => (
    `${range.startOffset}:${range.endOffset}:${range.personId}`
  )));

  let cursor = 0;
  let output = '';
  for (const mention of candidates) {
    const { startOffset, endOffset } = mention;
    if (startOffset < cursor || endOffset > text.length || endOffset <= startOffset) continue;
    const source = text.slice(startOffset, endOffset);
    let replacement: string | undefined;
    if (mention.type === 'connector' && mention.connectorType && source.startsWith('@')) {
      replacement = `[${escapeMarkdownLabel(source)}](${connectorMentionHref(token, mention.connectorType)})`;
    } else if (mention.type === 'person' && mention.personId) {
      const personId = mention.personId.toLowerCase();
      if (personRanges.has(`${startOffset}:${endOffset}:${personId}`)) {
        const destinationStart = source.lastIndexOf('](');
        if (destinationStart >= 0) {
          replacement = `${source.slice(0, destinationStart + 2)}${renderedPersonMentionHref(token, personId)})`;
        }
      }
    }
    if (replacement === undefined) continue;
    output += text.slice(cursor, startOffset) + replacement;
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
    ? mention.displayName.replace(/^@/u, '')
    : typeof fallbackLabel === 'string' ? fallbackLabel.replace(/^@/u, '') : fallbackLabel;
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

/**
 * A typed `@address`: the member who holds it, as a person chip, or someone
 * invited who has not joined, as a muted chip with the address. Anybody else's
 * address is the text that was written.
 */
function EmailMentionChip({ children, email }: PropsWithChildren<{ email: string }>): React.JSX.Element {
  const target = useEmailMentionTarget(email);
  if (!target) return <>{children}</>;
  if (target.kind === 'member') {
    return (
      <span className="mention-chip" data-person-id={target.member.id}>
        <span aria-hidden="true" className="mention-chip-avatar">
          <span>{mentionInitials(target.member.name)}</span>
          {target.member.avatarUrl && (
            <img alt="" onError={(event) => { event.currentTarget.hidden = true; }} src={target.member.avatarUrl} />
          )}
        </span>
        <span className="mention-chip-label">{target.member.name}</span>
      </span>
    );
  }
  return (
    <span className="mention-chip mention-chip-invited" title={`${target.email} · Invited`}>
      <span aria-hidden="true" className="mention-chip-avatar">
        <span>{mentionInitials(target.email)}</span>
      </span>
      <span className="mention-chip-label">{target.email}</span>
    </span>
  );
}

/** Whether a link names a person or connector, which a glance still draws as a chip. */
function isIdentityHref(href: string | undefined): boolean {
  return href !== undefined && (citationScheme(href) === 'person' || isConnectorHref(href));
}

/** The schemes whose cells need the target the model actually wrote. */
const INTERNAL_CITATION_SCHEMES: ReadonlySet<string> = new Set(['resource', 'person']);

/**
 * Which targets bypass `defaultUrlTransform` on their way to a component.
 *
 * An allowlist of citation schemes plus the render-minted connector mention
 * href, in two positions, and nothing wider: everything else — `javascript:`,
 * `data:`, `file:` — keeps going through the default transform, which empties
 * what it rejects. The position matters as much as the scheme, because
 * `resource:` has to survive on an `img` as well as an `a`: the embed card is
 * reached through image syntax.
 *
 * Passing a scheme here is not the same as rendering it. Every cell downstream
 * emits a chip, a card, or text — never the value itself as a destination.
 * Connector hrefs are allowed through so the identity path can chip them; they
 * are not a {@link citationScheme}.
 */
function isInternalCitationTarget(url: string, key: string, tagName: string): boolean {
  const position = (key === 'href' && tagName === 'a') || (key === 'src' && tagName === 'img');
  if (!position) return false;
  if (isConnectorHref(url)) return true;
  return INTERNAL_CITATION_SCHEMES.has(citationScheme(url));
}

/**
 * The identity cells of the citation matrix, in one place.
 *
 * Mentions are unchanged by citations and stay unchanged here: a `person:` /
 * `person://` href resolves against this render's `mentions`, a `connector:` /
 * `connector://` one counts only when it carries this render's token, and
 * neither is ever emitted as something with a destination. What moved is only
 * where the decision is called from.
 */
function renderIdentity(
  href: string | undefined,
  label: React.ReactNode,
  mentions: MessageMention[],
  token: string,
): React.ReactNode {
  const personId = renderedPersonId(href, token);
  if (personId) {
    const mention = mentions.find((candidate) => (
      candidate.type === 'person' && candidate.personId?.toLowerCase() === personId
    ));
    if (!mention) return <span className="mention-text-fallback">{label}</span>;
    return <MentionChip fallbackLabel={label} mention={mention} personId={personId} />;
  }
  if (personIdFromHref(href)) return <span className="mention-text-fallback">{label}</span>;
  if (isConnectorHref(href)) {
    const connectorType = tokenedConnectorType(href, token);
    const text = linkLabelText(label);
    // Without this render's token the link is text someone wrote, not a
    // mention: it neither earns a chip nor becomes something clickable.
    if (connectorType === undefined || text === undefined) {
      return <span className="mention-text-fallback">{label}</span>;
    }
    return <ConnectorMentionChip connectorType={connectorType} label={text} />;
  }
  // A `person:` target that is not an id is text a model wrote. It reaches here
  // intact because `urlTransform` passes the whole scheme through —
  // `defaultUrlTransform` would empty it instead, and an anchor with nothing
  // behind it reads as a mention that opens a blank window.
  return <span className="mention-text-fallback">{label}</span>;
}

const REMARK_PLUGINS = [remarkGfm, remarkHtmlBreaks];
/**
 * The same list plus the pending-pill rewrite, for a message that is still
 * growing. Two hoisted constants rather than a memo: both are compared by
 * identity where they reach a settled segment, and neither depends on anything
 * but which half of a streaming render is being drawn.
 */
const STREAMING_REMARK_PLUGINS = [remarkGfm, remarkHtmlBreaks, remarkPendingCitations];
/** The open end of that message, where the last reference may be half-written. */
const STREAMING_TAIL_REMARK_PLUGINS = [remarkGfm, remarkHtmlBreaks, remarkPendingTailCitations];
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
type MarkdownRemarkPlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']>;

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
  let previousEmbed = false;
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
    const embed = /^ {0,3}(?:!\[[^\]\n]*\]\(resource:[^\n)]+\)[ \t]*)+$/u.test(line);
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
        if (previousBlank && offset > segmentStart && !CONTINUES_ACROSS_BLANK.test(line) && !(embed && previousEmbed)) {
          cut();
          listMarker = null;
        }
      }
    }
    // A blank line inside a fence is code, not a paragraph seam.
    if (!blank) previousEmbed = embed && !fenced;
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
const SettledMarkdownSegment = memo(function SettledMarkdownSegment({ components, rehypeOptions, rehypePlugins, remarkPlugins, source, urlTransform }: {
  components: MarkdownComponents;
  rehypeOptions: MarkdownRehypeOptions;
  rehypePlugins: MarkdownRehypePlugins;
  remarkPlugins: MarkdownRemarkPlugins;
  source: string;
  urlTransform: MarkdownUrlTransform;
}): React.JSX.Element {
  return (
    <ReactMarkdown
      components={components}
      rehypePlugins={rehypePlugins}
      remarkPlugins={remarkPlugins}
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
const EMPTY_DEFINITION_BLOCKS: string[] = [];

function MarkdownLinkFavicon({ href }: { href: string | undefined }): React.JSX.Element | null {
  const { onError, source } = useHostFavicon(href);
  return source
    ? <img alt="" aria-hidden="true" className="markdown-link-favicon" onError={onError} src={source} />
    : <span aria-hidden="true" className="markdown-link-favicon-sentinel" />;
}

export function MarkdownBody({
  children,
  citations,
  collapseHeadings = false,
  glance = false,
  mentions = NO_MENTIONS,
  preserveLineBreaks = false,
  rallyMentions = false,
  speechKind = 'response',
  still = false,
  streaming = false,
  telemetry,
  verbatim = false,
  sourcePositions = false,
}: {
  children: string;
  sourcePositions?: boolean;
  /**
   * How this surface resolves a cited resource and where it opens one. Absent
   * on a surface with no work stream behind it, which is exactly the condition
   * under which every citation degrades to the label text the message already
   * carried.
   */
  citations?: CitationContext;
  /**
   * Whether h2-h6 sections use the compact accordion treatment. It is opt-in
   * because the main message feed is the one compact scanning surface; document
   * readers and every other Markdown host render the source fully expanded.
   */
  collapseHeadings?: boolean;
  /**
   * This body is a glance inside a card, not a reader. Links, images, and
   * code-block copy controls stay out of the DOM so the card remains one
   * button: an `<a>` or a nested `<button>` inside it is invalid HTML, and an
   * external image would fetch from a URL the document chose merely because
   * the card painted. Mentions still draw as chips, which have no destination.
   */
  glance?: boolean;
  mentions?: MessageMention[];
  /** Human chat messages keep the visible line breaks entered in the composer. */
  preserveLineBreaks?: boolean;
  /** A person's message, where a typed `@Rally` addresses Rally and draws as a chip. */
  rallyMentions?: boolean;
  /**
   * This body is being rendered into a picture rather than onto the screen.
   *
   * The saved card is the only caller. A citation's sources live in a popover
   * there, which a still image cannot open — so a still keeps the trailing
   * source list that the transcript trades away for the space.
   */
  still?: boolean;
  /**
   * Whether Speak's accessible name is *Speak response* (an assistant turn)
   * or *Speak* (a person's own words). Human bodies keep the visible *Speak*
   * and must not answer to *Speak response*.
   */
  speechKind?: 'response' | 'message';
  /**
   * The message is still growing. Rendering switches to settled segments plus
   * an open tail so a per-frame commit does not re-parse the whole body. When
   * heading collapse is off, the commit that ends the stream renders the source
   * whole again, which is also what heals any seam segmentation could not
   * preserve. When collapse is on, each section stays its own parse after
   * settle — footnote and link-reference definitions are appended onto fragments
   * that do not already carry them, so a `[^1]` in one section still
   * resolves against a definition under a later heading.
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
  // Socket hydration may replace a message with an equivalent object and a
  // newly allocated mentions array. Preserve the semantic value's identity so
  // that metadata-only refresh does not rebuild the parsed Markdown tree.
  const mentionsKey = JSON.stringify(mentions.map((mention) => [
    mention.type,
    mention.personId,
    mention.connectorType,
    mention.displayName,
    mention.avatarUrl,
    mention.startOffset,
    mention.endOffset,
  ]));
  const stableMentions = useMemo(() => mentions, [mentionsKey]);
  // Mentions first, normalization second, and the order is load-bearing: the
  // connector offsets are measured against the stored text, so anything that
  // changes its length has to run after they have been resolved into links.
  const linked = withAuthoritativeMentionLinks(children, stableMentions, token);
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
  // Code rendering does not depend on citation resolution or the identity of
  // the mentions array. Keep its component type stable when either of those
  // inputs is refreshed: ReactMarkdown treats a new inline function as a new
  // component type, which used to unmount a finished Mermaid diagram, show its
  // much shorter source fallback, and then render the diagram again.
  const annotationSource = sourcePositions ? markdown : '';
  const renderCode = useCallback((properties: React.ComponentProps<'code'> & ExtraProps): React.JSX.Element => {
    const start = properties.node?.position?.start.offset;
    const end = properties.node?.position?.end.offset;
    const raw = String(properties.children ?? '').replace(/\n$/u,'');
    const fragment = start !== undefined && end !== undefined ? annotationSource.slice(start,end) : '';
    const bodyStart = /^[ \t]*(?:`{3,}|~{3,})/u.test(fragment) ? fragment.indexOf('\n') + 1 : 0;
    const relative = fragment.indexOf(raw,bodyStart);
    const annotationRange: [number,number] | undefined = sourcePositions && start !== undefined && relative >= 0 ? [start+relative,start+relative+raw.length] : undefined;
    return (
    <MarkdownCode
      {...properties}
      annotationRange={annotationRange}
      glance={glance}
      // An open fence changes on every streaming commit, and Mermaid's
      // asynchronous parse cannot be cancelled. Render once the turn is
      // complete; glances and saved stills deliberately keep source code.
      renderDiagrams={!glance && !still && !streaming}
      telemetry={messageId !== undefined && workstreamId !== undefined ? { messageId, workstreamId } : undefined}
    />
  ); }, [glance, messageId, still, streaming, workstreamId,sourcePositions,annotationSource]);
  // Stable across commits that change nothing they depend on, for two reasons:
  // the settled segments' memo compares them by identity, and the memoised
  // element below reuses the whole rendered body while they hold still.
  const { components, urlTransform } = useMemo(() => ({
    components: {
      a: ({ children: linkChildren, href, node, ...props }) => (
        glance
          ? isIdentityHref(href) ? renderIdentity(href, linkChildren, stableMentions, token) : <>{linkChildren}</>
          : (
            <CitationLink
              anchor={{ ...props, href }}
              footnoteRef={node?.properties?.dataFootnoteRef !== undefined}
              href={href}
              identity={() => renderIdentity(href, linkChildren, stableMentions, token)}
            >
              {!still && httpHostname(href)
                ? <><MarkdownLinkFavicon key={href} href={href} />{linkChildren}</>
                : linkChildren}
            </CitationLink>
          )
      ),
      img: ({ alt, node, src, ...props }) => {
        void node;
        if (glance) return <>{alt}</>;
        // Connector embeds are not a citation scheme. Image syntax still reaches
        // here because urlTransform lets the href through; draw the card before
        // the matrix would degrade it to alt text.
        if (isConnectorHref(src)) {
          const connectorType = connectorTypeFromEmbedHref(src);
          if (connectorType === undefined) return <>{alt}</>;
          return <ConnectorEmbedCard connectorType={connectorType} label={alt} />;
        }
        return <CitationImage alt={alt} image={{ ...props, alt, src }} src={src} />;
      },
      // A task list's checkbox is a form control, which a glance's button
      // may not hold.
      input: ({ node, ...props }) => {
        void node;
        return glance ? null : <input {...props} />;
      },
      span: ({ children: spanChildren, node, ...props }) => {
        const email = node?.properties?.dataEmailMention;
        if (typeof email === 'string') return <EmailMentionChip email={email}>{spanChildren}</EmailMentionChip>;
        return <span {...props}>{spanChildren}</span>;
      },
      div: ({ children: divChildren, node, ...props }) => {
        if (!glance && node?.properties?.className instanceof Array && node.properties.className.includes('citation-card-row')) {
          return <CitationEmbedRow node={node}>{divChildren}</CitationEmbedRow>;
        }
        return <div {...props}>{divChildren}</div>;
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
      code: renderCode,
      pre: ({ children: preChildren, node }) => sourcePositions ? <div data-annotation-start={node?.position?.start.offset} data-annotation-end={node?.position?.end.offset} data-annotation-container>{preChildren}</div> : <>{preChildren}</>,
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
  }), [glance, renderCode, stableMentions, still, token, sourcePositions]);
  // Heading overrides are a second map so a nested h3 in a section body does
  // not grow a chevron: only the section's own heading markdown uses these.
  const headingComponents = useMemo<MarkdownComponents>(() => ({
    ...components,
    h2: MarkdownCollapseH2,
    h3: MarkdownCollapseH3,
    h4: MarkdownCollapseH4,
    h5: MarkdownCollapseH5,
    h6: MarkdownCollapseH6,
  }), [components]);
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
  const collapseParts = useMemo(() => {
    // A glance is already clamped; a still is a picture that cannot be
    // toggled. A surface can also opt out while retaining the ordinary link
    // and citation behavior that `still` deliberately changes. A document
    // with no collapsible heading keeps the single-parse path so streaming's
    // settled/streaming DOM still match.
    if (!collapseHeadings || glance || still || markdown === '') return null;
    const parts = splitCollapsibleMarkdown(markdown);
    return parts.some((part) => part.type === 'section') ? parts : null;
  }, [collapseHeadings, glance, markdown, still]);
  const collapseSectionIds = useMemo(
    () => collapseParts?.flatMap((part) => (part.type === 'section' ? [part.id] : [])) ?? [],
    [collapseParts],
  );
  const hostedCollapse = useMarkdownCollapse();
  // Each section is its own react-markdown mount. A [^1] in ## Claims cannot
  // see a [^1]: under ## Sources unless the definition rides along with the
  // fragment. Identity of `fragment` is preserved when nothing is missing, so
  // the parse that already owns the defs is unchanged.
  const definitionBlocks = useMemo(
    () => (collapseParts ? markdownDefinitionBlocks(markdown) : EMPTY_DEFINITION_BLOCKS),
    [collapseParts, markdown],
  );
  const dropBorrowedFootnotes = useMemo<MarkdownComponents['section']>(() => (
    ({ children: sectionChildren, node, ...props }) => {
      if (node?.properties?.dataFootnotes !== undefined) return null;
      return <section {...props}>{sectionChildren}</section>;
    }
  ), []);
  const borrowedComponents = useMemo<MarkdownComponents>(() => ({
    ...components,
    section: dropBorrowedFootnotes,
  }), [components, dropBorrowedFootnotes]);
  const borrowedHeadingComponents = useMemo<MarkdownComponents>(() => ({
    ...headingComponents,
    section: dropBorrowedFootnotes,
  }), [dropBorrowedFootnotes, headingComponents]);
  // A streaming body draws the pending pill; a settled one never does, so the
  // literal `[^foo]` of a reference nothing ever defined stays literal.
  const remarkPlugins = useMemo(() => {
    const base = streaming ? STREAMING_REMARK_PLUGINS : REMARK_PLUGINS;
    if (!preserveLineBreaks && !rallyMentions) return base;
    return [...base, ...(preserveLineBreaks ? [remarkSoftBreaks] : []), ...(rallyMentions ? [remarkRallyMentions] : [])];
  }, [preserveLineBreaks, rallyMentions, streaming]);
  const tailRemarkPlugins = useMemo(() => preserveLineBreaks
    ? [...STREAMING_TAIL_REMARK_PLUGINS, remarkSoftBreaks]
    : STREAMING_TAIL_REMARK_PLUGINS, [preserveLineBreaks]);
  const rendered = useMemo(() => {
    const componentsFor = (source: string, extra: MarkdownComponents): {
      resolved: string;
      used: MarkdownComponents;
    } => {
      const resolved = withMarkdownDefinitions(source, definitionBlocks);
      const borrowed = resolved !== source;
      if (!borrowed) return { resolved, used: extra };
      if (extra === headingComponents) return { resolved, used: borrowedHeadingComponents };
      if (extra === components) return { resolved, used: borrowedComponents };
      return { resolved, used: { ...extra, section: dropBorrowedFootnotes } };
    };
    const renderMarkdown = (
      source: string,
      extra: MarkdownComponents = components,
      plugins: MarkdownRemarkPlugins = remarkPlugins,
    ): React.JSX.Element => {
      const { resolved, used } = componentsFor(source, extra);
      return (
        <ReactMarkdown
          components={used}
          rehypePlugins={sourcePositions ? [...rehypePlugins, rehypeAnnotationSource] : rehypePlugins}
          remarkPlugins={plugins}
          remarkRehypeOptions={rehypeOptions}
          urlTransform={urlTransform}
        >
          {resolved}
        </ReactMarkdown>
      );
    };
    const renderStreaming = (source: string, extra: MarkdownComponents = components): React.JSX.Element => {
      const { settled, tail } = splitStreamingMarkdown(source);
      return (
        <>
          {settled.map((segment, index) => {
            const { resolved, used } = componentsFor(segment, extra);
            return (
              <SettledMarkdownSegment
                components={used}
                rehypePlugins={rehypePlugins}
                key={index}
                rehypeOptions={rehypeOptions}
                remarkPlugins={remarkPlugins}
                source={resolved}
                urlTransform={urlTransform}
              />
            );
          })}
          {/* Only here is the source's last line still arriving. */}
          {renderMarkdown(tail, extra, tailRemarkPlugins)}
        </>
      );
    };
    const renderSettled = (source: string, extra: MarkdownComponents = components): React.JSX.Element => {
      const { resolved, used } = componentsFor(source, extra);
      return (
        <SettledMarkdownSegment
          components={used}
          rehypePlugins={rehypePlugins}
          rehypeOptions={rehypeOptions}
          remarkPlugins={remarkPlugins}
          source={resolved}
          urlTransform={urlTransform}
        />
      );
    };
    if (!collapseParts) {
      return streaming ? renderStreaming(markdown) : renderMarkdown(markdown);
    }
    const lastIndex = collapseParts.length - 1;
    return (
      <>
        {collapseParts.map((part, index) => {
          const streamThis = streaming && index === lastIndex;
          if (part.type === 'preamble') {
            if (!part.source) return null;
            return (
              <Fragment key={`preamble-${index}`}>
                {streamThis ? renderStreaming(part.source) : renderSettled(part.source)}
              </Fragment>
            );
          }
          return (
            <MarkdownCollapseSection
              heading={(
                <SettledMarkdownSegment
                  components={headingComponents}
                  rehypePlugins={rehypePlugins}
                  rehypeOptions={rehypeOptions}
                  remarkPlugins={remarkPlugins}
                  source={part.heading}
                  urlTransform={urlTransform}
                />
              )}
              id={part.id}
              key={part.id}
            >
              {streamThis
                ? renderStreaming(part.body)
                : part.body
                  ? renderSettled(part.body)
                  : null}
            </MarkdownCollapseSection>
          );
        })}
      </>
    );
  }, [
    borrowedComponents,
    borrowedHeadingComponents,
    collapseParts,
    components,
    definitionBlocks,
    dropBorrowedFootnotes,
    headingComponents,
    markdown,
    rehypeOptions,
    rehypePlugins,
    remarkPlugins,
    streaming,
    tailRemarkPlugins,
    urlTransform,
    sourcePositions,
  ]);
  // The provider sits outside the memoised body deliberately: a definition that
  // arrives mid-stream has to reach the pills, and a context update crosses a
  // `memo` boundary where a changed prop would have re-parsed everything under
  // it instead.
  const bodyInner = <div className="markdown-body">{rendered}</div>;
  const body = (
    <CitationsProvider value={render}>
      {telemetry && !glance && !still ? (
        <MessageTextMenu markdown={children} speechKind={speechKind} streaming={streaming} telemetry={telemetry}>{bodyInner}</MessageTextMenu>
      ) : bodyInner}
    </CitationsProvider>
  );
  if (!collapseParts) return body;
  // The agent turn wraps this body in a controller so collapse-all in the
  // header shares ids. A nested MarkdownBody (the embed glance) must not reuse
  // that controller: its heading set is a different document.
  if (
    hostedCollapse
    && hostedCollapse.sectionIds.join('\0') === collapseSectionIds.join('\0')
  ) {
    return body;
  }
  return (
    <MarkdownCollapseController sectionIds={collapseSectionIds}>
      {body}
    </MarkdownCollapseController>
  );
}

/**
 * What a person can do with a finished turn: copy it, keep it as a file, or
 * carry it into a substream.
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

/**
 * One action in a turn's hover row: the words on the button, and the sentence
 * that says what pressing it does.
 *
 * The row is read at 10px in the margin of a turn, so its labels are one or two
 * words and three of them — **Image**, **PDF**, **New substream** — name a thing
 * rather than an action. `description` is the sentence, and it is the button's
 * accessible name *and* its tip from one string: the explanation a reader waits
 * on hover for is the one a screen reader is given, and neither can be added to
 * this row without the other. Keep the visible words inside it, per WCAG
 * 2.5.3 — voice control reaches this row by what it says.
 *
 * The two exports break that in one state, deliberately: a failed save shows
 * **Image failed** or **PDF failed** while the name stays the sentence, because
 * a name that moves with state is one a person cannot say twice and reach the
 * same control. The fixed name is chosen just below, where the state is spoken
 * instead; this is what it costs, and it is the only exception on the row.
 *
 * That name is stated here rather than accepted from a caller, and `type` with
 * it: a control in this row that could be renamed from outside, or submit
 * something, would not be the thing this component says it is. The three props
 * that would do it are off the type *and* the fixed attributes come after the
 * spread, because either one alone is a rule a future edit can undo by moving a
 * line.
 *
 * Nothing here states its own opacity or metrics; the row owns the fade and
 * `.message-actions button` owns the rest.
 */
function MessageAction({ children, description, ...props }: PropsWithChildren<
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'aria-labelledby' | 'type'>
  & { description: string }
>): React.JSX.Element {
  return (
    // Below the row, the way every other control in the app opens its tip: the
    // row sits directly under the turn's last line, so a box above it lands on
    // the words being read instead of in the gap under them.
    //
    // The sentence is this button's name, so the tip does not also describe it:
    // a screen reader would otherwise read the name and then the identical
    // description, twice over, for a control that only ever had one sentence.
    <Tip describesTrigger={false} label={description}>
      <button {...props} aria-label={description} type="button">{children}</button>
    </Tip>
  );
}

/**
 * Branch a private conversation off the turn this sits under, with that turn as
 * the cutoff. It reads as one of the turn's actions rather than as part of its
 * identity line, so it is rendered in the same row as copy and the exports —
 * both the agent's row and the shorter one a person's own message gets.
 */
function StartSubstreamButton({ onStart }: { onStart: () => void }): React.JSX.Element {
  return (
    <MessageAction
      className="message-start-substream"
      // The visible words have to appear in the accessible name, or a person
      // driving by voice cannot say what they can see ("click New substream")
      // and reach it. The name extends the label rather than replacing it,
      // which is what every button beside it does — Copy is "Copy response",
      // PDF is "Save response as a PDF" — and the arrow is decorative, so it
      // stays out of both the name and the announcement.
      description="New breakout from this message"
      onClick={onStart}
    ><IconCornerDownRight aria-hidden="true" size={12} stroke={1.9} /> New breakout</MessageAction>
  );
}

/**
 * Merge this message's words back up: a Breakout's into its Thread, a
 * Thread's into one of its Channels. Second in the row, after New breakout:
 * the two actions that move work between levels lead it. The icon is the breakout mark rotated
 * 180°: work goes down into a Breakout and comes back up.
 */
function MergeButton({ merge, text }: { merge: MessageMergeAction; text: string }): React.JSX.Element {
  return (
    <MessageAction className="message-merge" description={merge.label} onClick={() => merge.onMerge(text)}>
      <IconCornerUpLeft aria-hidden="true" size={12} stroke={1.9} /> {merge.label}
    </MessageAction>
  );
}

/**
 * Where a message's Merge action goes, as its host names it ("Merge to thread",
 * "Merge to GTM"). The turn is named so the host can open the response card
 * under the message the merge was asked from.
 */
export interface MessageMergeAction {
  label: string;
  onMerge: (text: string, turnId?: string) => void;
}

/**
 * The hover row under a message: the one row every surface that shows messages
 * draws, so a Channel, a Thread and a Breakout offer the same actions in the
 * same order with the same metrics. The host says what it can offer; the row
 * decides how it is drawn, revealed and announced.
 *
 * - `onStartSubstream` and `onMerge` are the host's, because only it knows
 *   whether this message can be a cutoff or has somewhere to merge to.
 * - `textActions` (copy, speech, the two exports) default on. A person's own
 *   turn in a Thread turns them off, as it always has: the row under a bubble
 *   is for moving work between levels, not for taking a person's words back.
 * - `subject` names the message in each action's sentence, so a person's
 *   message in a Channel is not called a "response".
 * - `verbatim` says the host drew the text as typed (kept line breaks, no
 *   model repairs), so the exports draw it the same way.
 * - `rendered` is the text the host drew, when it differs from the stored
 *   `text`: a Channel resolves typed @names into mention links before drawing.
 *   The exports draw it, so a chip on screen is a chip in the file; Copy and
 *   Speak keep the stored words.
 *
 * The row is always laid out, even empty: under a person's bubble it is the
 * slot that keeps the next turn off it (see `.human-message .message-actions`).
 */
export function MessageActions({
  citations,
  mentions = NO_MENTIONS,
  onMerge,
  onStartSubstream,
  rendered,
  subject = 'response',
  telemetry,
  text,
  textActions = true,
  verbatim = false,
}: {
  citations?: CitationContext;
  mentions?: MessageMention[];
  onMerge?: MessageMergeAction;
  onStartSubstream?: () => void;
  rendered?: { text: string; mentions: MessageMention[] };
  subject?: 'response' | 'message';
  /** A Channel's own message is in no Thread, so it reports no `workstreamId`. */
  telemetry?: { messageId: string; workstreamId?: string };
  text: string;
  textActions?: boolean;
  verbatim?: boolean;
}): React.JSX.Element {
  const [saving, setSaving] = useState<MessageExportFormat | null>(null);
  const [failed, setFailed] = useState<MessageExportFormat | null>(null);
  const exportsAvailable = desktopServicesAvailable();
  const fallbackSpeechId = useId();
  const speech = useSpeechPlayback();
  const speechId = telemetry?.messageId ?? fallbackSpeechId;
  const speaking = speech?.activeMessageId === speechId;

  const copyResponse = async (): Promise<void> => {
    await desktopBridge().copyText(text);
    if (telemetry) reportTelemetryProductIntent({
      kind: 'content_copied', contentType: 'message_response', resourceType: 'message',
      resourceId: telemetry.messageId,
      ...(telemetry.workstreamId ? { workstreamId: telemetry.workstreamId } : {}),
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
        content: <MarkdownBody
          citations={citations}
          mentions={rendered?.mentions ?? mentions}
          preserveLineBreaks={verbatim}
          rallyMentions={verbatim}
          still
          verbatim={verbatim}
        >{rendered?.text ?? text}</MarkdownBody>,
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

  // A settled turn can carry attachments and no prose, and the cutoff it offers
  // does not depend on there being words to take. Copy, speech and the exports
  // do: each of them acts on the response text, and an empty one gives a person
  // an empty clipboard, silence, or a blank card. So the row still appears for
  // the branch alone, with nothing on it that has nothing to work on.
  const hasText = text.length > 0;
  const offersText = textActions && hasText;

  return (
    // One group for the row: the first tip waits, and reading along the rest of
    // the row does not wait again. It also carries the tooltip provider, so the
    // row explains itself wherever a turn is rendered rather than only under the
    // app that happens to mount one.
    <TipGroup>
      <footer
        className={clsx('message-actions', speaking && 'is-speaking')}
        // The row itself is transient, so the failure on it should be too: it has
        // been read by the time the pointer leaves, and a stale "Image failed"
        // sitting under a turn the next day reads as a broken feature rather than
        // as one attempt that did not work.
        onPointerLeave={() => setFailed(null)}
      >
        {onStartSubstream && <StartSubstreamButton onStart={onStartSubstream} />}
        {hasText && onMerge && <MergeButton merge={onMerge} text={text} />}
        {offersText && (
          <MessageAction description={`Copy ${subject}`} onClick={() => void copyResponse().catch(() => undefined)}><Clipboard size={12} /> Copy</MessageAction>
        )}
        {offersText && speech && (
          <MessageAction
            description={speaking ? 'Stop speaking' : `Speak ${subject}`}
            onClick={() => speaking ? speech.stop() : speech.speak(speechId, text)}
          >
            {speaking ? <Square aria-hidden="true" fill="currentColor" size={11} /> : <Volume2 aria-hidden="true" size={12} />}
            {speaking ? 'Stop speaking' : 'Speak'}
          </MessageAction>
        )}
        {offersText && exportsAvailable && (
          <>
            <MessageAction
              aria-busy={saving === 'image' || undefined}
              description={`Save ${subject} as an image`}
              disabled={saving !== null}
              onClick={() => void save('image')}
            >
              {saving === 'image' ? <LoaderCircle aria-hidden="true" className="spin" size={12} /> : null}
              {saving !== 'image' && failed === 'image' ? <CircleAlert aria-hidden="true" size={12} /> : null}
              {saving !== 'image' && failed !== 'image' ? <ImageDown aria-hidden="true" size={12} /> : null}
              {failed === 'image' ? 'Image failed' : 'Image'}
            </MessageAction>
            <MessageAction
              aria-busy={saving === 'pdf' || undefined}
              description={`Save ${subject} as a PDF`}
              disabled={saving !== null}
              onClick={() => void save('pdf')}
            >
              {saving === 'pdf' ? <LoaderCircle aria-hidden="true" className="spin" size={12} /> : null}
              {saving !== 'pdf' && failed === 'pdf' ? <CircleAlert aria-hidden="true" size={12} /> : null}
              {saving !== 'pdf' && failed !== 'pdf' ? <FileDown aria-hidden="true" size={12} /> : null}
              {failed === 'pdf' ? 'PDF failed' : 'PDF'}
            </MessageAction>
            {/* Each button keeps a fixed accessible name so it stays findable, which
                means neither the spinner nor the changed label announces anything on
                its own. This is where the state is spoken. A disabled button takes no
                pointer events either, so a save in flight is not a hover away — it is
                only here. */}
            <span className="sr-only" role="status">{exportStatusMessage(saving, failed)}</span>
          </>
        )}
      </footer>
    </TipGroup>
  );
}

export function AssistantMessageContent({
  afterText,
  citations,
  collapseHeadings = false,
  // The hoisted constant, not `= []`: a per-render array here would feed
  // MarkdownBody an always-new `mentions` and defeat its streaming memo.
  mentions = NO_MENTIONS,
  onMerge,
  onStartSubstream,
  showCopy = true,
  streaming = false,
  text,
  telemetry,
}: {
  afterText?: React.ReactNode;
  citations?: CitationContext;
  collapseHeadings?: boolean;
  mentions?: MessageMention[];
  onMerge?: MessageMergeAction;
  onStartSubstream?: () => void;
  showCopy?: boolean;
  streaming?: boolean;
  text: string;
  telemetry?: MessageCopyTelemetry;
}): React.JSX.Element {
  return (
    <>
      {text ? (
        <MarkdownBody citations={citations} collapseHeadings={collapseHeadings} mentions={mentions} streaming={streaming} telemetry={telemetry}>{text}</MarkdownBody>
      ) : null}
      {afterText}
      {showCopy && !streaming && (text !== '' || onStartSubstream !== undefined) && (
        <MessageActions
          citations={citations}
          mentions={mentions}
          onMerge={onMerge}
          onStartSubstream={onStartSubstream}
          telemetry={telemetry}
          text={text}
        />
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
 * Which collapsible rows are open, held by a caller that virtualizes its
 * transcript. Two kinds of row use it — a clamped system note, and a settled
 * run's work accordion — and one set covers both: message ids are unique, and
 * the question ("which rows has this reader opened") is the same one.
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
export interface RowDisclosure {
  expanded: ReadonlySet<string>;
  onToggle: (messageId: string) => void;
}

function HumanMessageBubble({
  children,
  disclosure,
  messageId,
  text,
}: {
  children: React.ReactNode;
  disclosure?: RowDisclosure;
  messageId: string;
  text: string;
}): React.JSX.Element {
  const [locallyExpanded, setLocallyExpanded] = useState(false);
  const [bodyNode, setBodyNode] = useState<HTMLElement | null>(null);
  const expanded = disclosure ? disclosure.expanded.has(messageId) : locallyExpanded;
  const clamped = useTextClamped(bodyNode, text, !expanded);

  return (
    <div
      className="human-message-bubble"
      data-clamped={clamped ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
    >
      <div className="human-message-bubble-body" ref={setBodyNode}>{children}</div>
      {(expanded || clamped) && (
        <button
          aria-expanded={expanded}
          className="human-message-toggle"
          onClick={() => {
            if (disclosure) disclosure.onToggle(messageId);
            else setLocallyExpanded((current) => !current);
          }}
          type="button"
        >
          {expanded ? 'Show less' : 'Show more'}
          <ChevronDown aria-hidden="true" size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * A person's words and files, as their turn draws them. Shared with the screen
 * a thread shows while it is being started, so the opening looks the same
 * before and after the room has it.
 */
export function HumanMessageBody({
  attachments,
  disclosure,
  loadAttachmentContent,
  mentions,
  messageId,
  onOpenAttachment,
  telemetry,
  text,
}: {
  attachments?: MessageAttachment[] | undefined;
  disclosure?: RowDisclosure | undefined;
  loadAttachmentContent?: ((id: string, signal?: AbortSignal) => Promise<Blob>) | undefined;
  mentions?: MessageMention[] | undefined;
  messageId: string;
  onOpenAttachment?: ((preview: AttachmentPreview) => void) | undefined;
  telemetry?: MessageCopyTelemetry | undefined;
  text?: string | undefined;
}): React.JSX.Element {
  return (
    <>
      {text ? (
        <HumanMessageBubble disclosure={disclosure} messageId={messageId} text={text}>
          <MarkdownBody
            mentions={mentions}
            preserveLineBreaks
            rallyMentions
            speechKind="message"
            telemetry={telemetry}
            verbatim
          >{text}</MarkdownBody>
        </HumanMessageBubble>
      ) : null}
      {attachments?.length && loadAttachmentContent && onOpenAttachment ? (
        <MessageAttachments attachments={attachments} loadContent={loadAttachmentContent} onOpen={onOpenAttachment} />
      ) : null}
    </>
  );
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
/**
 * The card proposing an automation an agent drafted in this room.
 *
 * A card rather than prose because there is something to decide, and the thing
 * being decided is what it would create — so the card shows the triggers and
 * the scope rather than describing them. An unfinished draft offers no accept:
 * accepting one would freeze the gap the agent is still asking about.
 */
function DraftProposedCard({
  detail,
  messageId,
  onAccept,
  accepting,
  failed,
}: {
  detail: NonNullable<Message['draftProposed']>;
  messageId: string;
  onAccept?: (automationId: string) => void;
  accepting?: boolean;
  failed?: boolean | undefined;
}): React.JSX.Element {
  const scope = detail.suggestedScope === 'workstream'
    ? 'This thread'
    : detail.suggestedScope === 'workspace' ? 'The organization' : 'You';
  return (
    <div className="system-message automation-draft-card" id={`message-${messageId}`} role="group">
      <span aria-hidden="true" className="system-message-dot" />
      <div className="system-message-body">
        <p className="system-message-text">
          <strong>{detail.automationName}</strong> — {detail.description}
        </p>
        {detail.triggerSummaries.length > 0 && (
          <ul className="automation-draft-triggers" aria-label="Triggers">
            {detail.triggerSummaries.map((summary) => <li key={summary}>{summary}</li>)}
          </ul>
        )}
        {/* Who will be able to see and change it, which cannot be changed after
            acceptance and is therefore the part worth reading before pressing. */}
        <p className="system-message-text"><small>{scope} can manage it.</small></p>
        {failed && <p className="system-message-text">That Sidekick couldn’t be created. Try again.</p>}
        <div className="automation-draft-actions">
          {detail.ready ? (
            <button
              className="system-message-toggle"
              disabled={accepting || !onAccept}
              onClick={() => onAccept?.(detail.automationId)}
              type="button"
            >
              {accepting ? 'Creating…' : 'Create this Sidekick'}
            </button>
          ) : (
            <p className="system-message-text"><small>Still being drafted.</small></p>
          )}
          {/* The draft is reviewed and edited on the automation's own screen,
              which is also where it is applied later. A hash link rather than a
              router link: the app routes by hash, and the card renders on
              surfaces with no router of their own. */}
          <a className="system-message-toggle automation-draft-link" href={`#/automations/${detail.automationId}`}>
            Open Sidekick
          </a>
        </div>
      </div>
    </div>
  );
}

function SystemMessageBlock({ disclosure, message }: { disclosure?: RowDisclosure; message: Message }): React.JSX.Element {
  // The fallback for a caller that does not virtualize. Where one does, the
  // state has to outlive the row — see `RowDisclosure`.
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
 * How a settled total reads, in a message header or on an accordion.
 *
 * It takes the `WorkTotal` both of those carry rather than one field's own
 * type, because the total moves between them and this is the one place either
 * is turned into a sentence.
 *
 * Null is an unknown duration, not a zero one — or a stretch with no total of
 * its own — and the line then says only that Rally worked: the same rule the
 * plugin rows follow, for the same reason. A transcript that cannot see how
 * long something took must not report a time it does not have.
 */
function workSummaryLabel(summary: WorkTotal): string {
  if (summary.durationMs === null) return 'Worked';
  const duration = formatDuration(summary.durationMs) ?? '0ms';
  return summary.timingAccuracy === 'upper_bound'
    ? `Worked for at most ${duration}`
    : `Worked for ${duration}`;
}

/**
 * The mark a thinking row wears, in the orb's place.
 *
 * The orb says only that something is running, which the shimmering label
 * beside it already says. Every other row in this column names the place the
 * work happened — Slack, the web, a computer, Rally — through a mark, and
 * reasoning is a place like any of them, so it gets the one glyph that names
 * it. It borrows the plugin marks' own box and pulse rather than growing a
 * second set: this is the same 20px column, and a thinking row that is still
 * going has exactly the fact to convey that a running plugin row does.
 *
 * `active` is the row's reported status, which is what a plugin mark pulses on
 * too — not `AgentWorkTiming`'s narrower `running`, which additionally demands
 * a start to count from. The orb answered that question the other way, and the
 * difference shows in one state: an activity still marked active whose
 * intervals have all closed parks the number and the label's shimmer, and the
 * mark keeps breathing. That row is reporting a live activity, so the mark is
 * saying the true thing and the frozen number beside it is the defect; the
 * plugin rows have carried the same pair since they replaced their spinners.
 */
function ThinkingGlyph({ active }: { active: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={clsx('plugin-face', active && 'plugin-face-active')}
    >
      <IconBrain size={15} stroke={1.8} />
    </span>
  );
}

function ThoughtBlock({ message }: { message: Message }): React.JSX.Element | null {
  const thought = message.thoughtEvent;
  if (!thought) return null;
  const active = thought.status === 'started';
  // Only the model's own reasoning gets the brain. The other row this block
  // draws is the response's overall total — tool calls and all — and it keeps
  // the orb, the shape that stands for work in general rather than for
  // thinking. The verb is what tells them apart, through the same predicate
  // the collapse and the fold read it with.
  const thinking = isThinkingEvent(thought);
  return (
    <AgentWorkTiming
      active={active}
      icon={thinking ? <ThinkingGlyph active={active} /> : undefined}
      // This block renders both kinds of thought row — a turn's thinking and a
      // response's overall work — so the subject comes from the row's own verb
      // rather than being fixed here: "Rally is thinking", "Rally is working".
      activeName={`Rally is ${thoughtVerb(thought)}`}
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
  // The two ends of a worker's life the transcript records. They take marks of
  // their own rather than the stack above them, because a reader may have to
  // act on either and neither should look like the row that merely says work
  // was handed out.
  'agent-failed': IconAlertTriangle,
  'agent-finished': IconCircleCheck,
  // Mail, not the agent stack: this row counts what was said between agents,
  // while `background-agents` stands for the agents themselves and still marks
  // starting, listing and stopping one.
  'agent-messages': IconMailAi,
  automations: IconKeyframes,
  'background-agents': IconStackBackward,
  computer: IconDeviceDesktop,
  'image-generation': IconImageGeneration,
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
 * chip has no guaranteed contrast against a transcript in both appearances.
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
 * The wording is the plugin's own — "Using Slack for 4m 02s" becoming "Used
 * Slack for 5m 02s" — so the row reads as a place rather than as a mechanism,
 * which is the whole point of hiding the calls underneath it.
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

/**
 * One row inside a work accordion.
 *
 * Only the two kinds `collapseSettledWorkIntoAccordion` swallows: the drawer is
 * built from the feed's own rows and draws them the way the feed did, so a
 * plugin's mark, wording, and tense are decided in exactly one place whether
 * the run is open or closed. They lose the `message-<id>` anchor their feed
 * rows carried — the accordion above them holds the one for this stretch, and
 * two elements answering to the same anchor is worse than none.
 */
function WorkAccordionRow({ message }: { message: Message }): React.JSX.Element | null {
  if (message.messageType === 'thought') return <ThoughtBlock message={message} />;
  if (message.messageType === 'plugin_activity') return <PluginActivityBlock message={message} />;
  return null;
}

/**
 * One finished stretch of a run's work, closed behind the answer it produced.
 *
 * "Worked for 41m 17s" where the stretch is the whole response, its own union
 * of when the rows inside worked where the run narrated itself into several and
 * no one of them is what the response timer measured — with the plugin and
 * thinking rows behind a chevron either way. A plain "Worked" is what is left
 * when neither can be established. While a stretch is running those rows are the progress a
 * reader is watching and the feed shows them; once an answer reports on them
 * they are a receipt for a sentence the reader has now read, and a reader who
 * wants the breakdown asks for it. See `collapseSettledWorkIntoAccordion` for
 * what goes in and when the total moves out of the message header to get
 * here.
 *
 * The control is the markdown headings' collapse: the same `ChevronRight` at
 * the same size and weight, in the same muted neutral, rotating a quarter turn
 * when the drawer opens. A reader has already learned that chevron on the
 * answer below — every agent message folds its sections with it — and a second
 * collapse affordance drawn a second way, a few pixels above the first, would
 * read as a different kind of thing. It hangs in the gutter the same way too —
 * outdented into the margin, so the total starts on the transcript's own left
 * edge and the chevron is the only thing outside it; `.work-accordion-chevron`
 * has why.
 *
 * The open flag comes from the feed where there is one, because this row is
 * exactly the shape the virtualizer mismeasures: it grows by a run's worth of
 * rows when opened, and a row that scrolls away open and returns closed leaves
 * the size cache expecting the taller one. See `RowDisclosure`.
 */
function WorkAccordionBlock({ disclosure, message }: {
  disclosure?: RowDisclosure;
  message: Message;
}): React.JSX.Element | null {
  // The fallback for a caller that does not virtualize, as the system row has.
  const [locallyExpanded, setLocallyExpanded] = useState(false);
  const accordion = message.workAccordion;
  if (!accordion) return null;
  const expanded = disclosure ? disclosure.expanded.has(message.id) : locallyExpanded;
  // The same sentence the message header prints, from the same function: where
  // the total moved here it did not change, only where it is written, and where
  // there is none this row says exactly what an unknown duration says.
  const label = workSummaryLabel(accordion);
  return (
    <div className="work-accordion">
      <button
        aria-expanded={expanded}
        className="work-accordion-toggle"
        onClick={() => {
          if (disclosure) disclosure.onToggle(message.id);
          else setLocallyExpanded((current) => !current);
        }}
        type="button"
      >
        {/* One chevron, rotated by CSS, exactly as a heading's is: swapping the
            glyph for a down-pointing one would lose the quarter turn the reader
            watches, which is the part that says the two states are one thing. */}
        <span aria-hidden="true" className="work-accordion-chevron">
          <ChevronRight size={14} strokeWidth={1.8} />
        </span>
        <span className="work-accordion-total">{label}</span>
      </button>
      {expanded && (
        <div className="work-accordion-rows">
          {accordion.rows.map((row) => <WorkAccordionRow key={row.id} message={row} />)}
        </div>
      )}
    </div>
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
  if (elicitation.status === 'cancelled') {
    return <div aria-label="Question cancelled" className="elicitation-resolved-answer human-message-bubble">Question cancelled</div>;
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
    } catch {
      setError('Your response couldn’t be saved. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const skip = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(null);
    } catch {
      setError('This question couldn’t be skipped. Try again.');
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
        const index = /^[a-z]$/iu.test(event.key) ? event.key.toUpperCase().charCodeAt(0) - 65 : Number(event.key) - 1;
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
            <X aria-hidden="true" size={16} />
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
              <kbd aria-hidden="true">{index < 26 ? String.fromCharCode(65 + index) : index + 1}</kbd>
              {isMulti ? (
                <span aria-hidden="true" className="elicitation-checkbox">{selected.includes(option.value) && <Check size={12} strokeWidth={3} />}</span>
              ) : null}
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
              <kbd aria-hidden="true">{options.length < 26 ? String.fromCharCode(65 + options.length) : options.length + 1}</kbd>
              {isMulti ? (
                <span aria-hidden="true" className="elicitation-checkbox">{customSelected && <Check size={12} strokeWidth={3} />}</span>
              ) : null}
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
  onStartSubstream?: (throughTurnId: string) => void;
  /** The host's Merge action, offered on every settled text message; absent where nothing can merge. */
  merge?: MessageMergeAction;
  /** Opens a Breakout a merge names. */
  onOpenBreakout?: (breakoutId: string) => void;
  /** Opens the merge a source's Merged chip names, where it landed. */
  onOpenMerge?: (merge: MessageMergedInto) => void;
  /**
   * How this transcript resolves and opens a citation. Absent on a surface
   * without a work stream behind it, which is exactly when every citation in a
   * message degrades to the label text it already carried.
   */
  citations?: CitationContext;
  /**
   * Whether agent-message headings use the compact feed accordions. This is a
   * host decision because MessageBlock also renders automation and launch
   * conversations, which are not the main work-stream feed.
   */
  collapseHeadings?: boolean;
  currentUserId?: string;
  /**
   * The signed-in person's display name, for the one row that needs naming from
   * the session rather than from the turn: their own elicitation answer, in the
   * window before the canonical human turn replaces the optimistic projection.
   */
  currentUserName?: string;
  message: Message;
  loadAttachmentContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpenAttachment?: (preview: AttachmentPreview) => void;
  onAnswerElicitation: (elicitationId: string, answer: string | string[] | null, customResponse?: string) => Promise<void>;
  rowDisclosure?: RowDisclosure;
  /** Creates the automation a proposal card names. */
  onAcceptDraft?: (automationId: string) => void;
  acceptingDraftFor?: string | null;
  acceptDraftFailureFor?: string | null;
  /** Main-feed opt-in; other transcript hosts keep core tools as neutral rows. */
  connectorConnectionCards?: boolean;
  connectedConnectorSelections?: ReadonlySet<string>;
  onConnectorConnected?: (selectionKey: string) => void;
  authorizedResourceToolIds?: ReadonlySet<string>;
  onResourceAuthorized?: (failedToolInvocationId: string) => void;
}

export function MessageBlock({
  onStartSubstream,
  merge,
  onOpenBreakout,
  onOpenMerge,
  citations,
  collapseHeadings = false,
  currentUserId,
  currentUserName,
  loadAttachmentContent,
  message,
  onAnswerElicitation,
  onOpenAttachment,
  rowDisclosure,
  onAcceptDraft,
  acceptingDraftFor,
  acceptDraftFailureFor,
  connectorConnectionCards = false,
  connectedConnectorSelections,
  onConnectorConnected,
  authorizedResourceToolIds,
  onResourceAuthorized,
}: MessageBlockProps): React.JSX.Element {
  const presentations = useContext(MemberPresentationContext);
  const profileUserId = message.authorType === 'human' ? message.author?.id
    : message.authorType === 'agent' && !message.author && message.messageType === 'elicitation'
      && message.elicitation?.status === 'answered' ? currentUserId : undefined;
  const profile = profileUserId ? presentations.get(profileUserId) : undefined;
  const personStyle = {
    // The dot's colour, and only the dot's. A profiled member overrides it with
    // their own accent below; the hash is what an unprofiled or external sender
    // falls back to.
    '--person-accent': turnAccent(message),
    // Straight from the palette. There used to be a `cmp.member-message.*` token
    // per accent name restating the same fill and ink; it duplicated the palette
    // by hand, had already drifted from it, and could not survive the accent set
    // changing. The accent *is* a palette colour now, so there is nothing left
    // to indirect through.
    ...(profile ? {
      '--person-dot': personalColor(profile.color),
      '--av-cmp-bubble-human-background': personalColor(profile.color),
      '--av-cmp-bubble-human-foreground': personalColorInk(profile.color),
    } : {}),
  } as React.CSSProperties;
  if (message.messageType === 'thought') return <div className="transcript-event" id={`message-${message.id}`}><ThoughtBlock message={message} /></div>;
  if (message.messageType === 'tool_event') {
    const resourceAuthorization = connectorConnectionCards
      ? connectorResourceAuthorizationRequest(message)
      : null;
    const connectionCard = connectorConnectionCards ? connectorConnectionCardInput(message) : null;
    const connectionCardProvider = connectionCard ? connectorConnectionCardProvider(connectionCard) : null;
    return (
      <div className="transcript-event" id={`message-${message.id}`}>
        {resourceAuthorization ? (
          <ConnectorResourceAuthorizationCard
            request={resourceAuthorization}
            latchedAuthorized={Boolean(authorizedResourceToolIds?.has(resourceAuthorization.continuationId))}
            {...(onResourceAuthorized ? { onAuthorized: onResourceAuthorized } : {})}
          />
        ) : connectionCard && connectionCardProvider ? (
          <ConnectorConnectionCard
            latchedConnected={Boolean(connectedConnectorSelections?.has(
              connectorConnectionCardSelectionKey(connectionCard),
            ))}
            {...(onConnectorConnected ? { onConnected: onConnectorConnected } : {})}
            request={connectionCard}
          />
        ) : connectorConnectionCards && (connectionCard || isUnrecognizedConnectorConnectionCard(message)) ? (
          <ConnectorConnectionUpdateCard />
        ) : <ToolBlock message={message} />}
      </div>
    );
  }
  if (message.messageType === 'plugin_activity') return <div className="transcript-event" id={`message-${message.id}`}><PluginActivityBlock message={message} /></div>;
  if (message.messageType === 'work_accordion') {
    return (
      <div className="transcript-event" id={`message-${message.id}`}>
        <WorkAccordionBlock disclosure={rowDisclosure} message={message} />
      </div>
    );
  }
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
        // Answering marks the assistant's question turn answered where it
        // stands, and that turn carries no author record until the canonical
        // human turn lands a moment later. Falling through to the anonymous
        // label there would attribute the reader's own answer to a "Workspace
        // member" on a row this same branch labels as theirs, so the session's
        // own name stands in for that window.
        : profile?.displayName ?? message.author?.name
          ?? (ownHumanResponse ? currentUserName : undefined)
          ?? 'Organization member';
      return (
        <article
          aria-label={ownHumanResponse ? 'Your elicitation response' : `Response from ${responseAuthor}`}
          className={clsx(
            'message-block human-message elicitation-response-message',
            ownHumanResponse ? 'own-human-message' : 'coworker-message',
          )}
          id={`message-${message.id}`}
          data-profile-color={profile?.color}
          style={personStyle}
        >
          {/* The same identity line every human turn carries, the reader's own
              included — see the header on the ordinary authored row below. */}
          <MessageByline align="end" author={responseAuthor} createdAt={message.createdAt} dot />
          <div className="human-message-content">
            <ElicitationPanel
              elicitation={message.elicitation}
              onAnswer={(answer, customResponse) => onAnswerElicitation(message.elicitation!.id, answer, customResponse)}
            />
            {/* The same slot every person's turn ends with — see the authored
                row below. An answer is never a cutoff, so it is always empty
                here, and it is the clearance the next turn sits under. */}
            <footer className="message-actions" />
          </div>
        </article>
      );
    }
    return <div className="transcript-event" id={`message-${message.id}`}><ElicitationPanel elicitation={message.elicitation} onAnswer={(answer, customResponse) => onAnswerElicitation(message.elicitation!.id, answer, customResponse)} /></div>;
  }
  // Ahead of the system branch, and on the type rather than the author: an
  // activation is appended by Rally on an automation's behalf, so it arrives
  // with a machine author and would otherwise fall into the row that means
  // "Rally is noting something that happened *to* this work stream". It is not
  // that. It is what an automation found, for the people in the room to read.
  // Ahead of the system branch for the same reason as the card below: a
  // clamped paragraph would bury what the room is being asked to decide.
  if (message.draftProposed) {
    return (
      <DraftProposedCard
        accepting={acceptingDraftFor === message.draftProposed.automationId}
        detail={message.draftProposed}
        failed={acceptDraftFailureFor === message.draftProposed.automationId}
        messageId={message.id}
        {...(onAcceptDraft ? { onAccept: onAcceptDraft } : {})}
      />
    );
  }
  const automation = message.messageType === 'automation_activation';
  // The Sidekick that delivered it, under the name frozen into the row at
  // delivery. A row whose structured content did not parse keeps the generic
  // label rather than showing a blank author.
  const automationName = message.automationActivation?.automationName;
  const automationAuthor = automationName ?? 'Sidekick';
  // A merge's mark in its source: a divider whose line opens the merge where
  // it landed, ahead of the system branch it would otherwise read as a note in.
  const mergedInto = message.mergedInto;
  if (mergedInto) {
    const merger = presentations.get(mergedInto.mergedByUserId)?.displayName;
    return (
      <MergedIntoDivider
        byRally={mergedInto.actingAgent}
        id={`message-${message.id}`}
        mergedBy={merger}
        onOpen={onOpenMerge ? () => onOpenMerge(mergedInto) : undefined}
        target={mergedInto.title || (mergedInto.kind === 'thread' ? 'the thread' : 'the channel')}
        time={<RelativeTime value={message.createdAt} />}
      />
    );
  }
  if (!automation && (message.authorType === 'system' || message.messageType === 'system')) {
    return <SystemMessageBlock disclosure={rowDisclosure} message={message} />;
  }

  // The ordinary authored row, not a kind of its own: the same block a
  // colleague's message gets, with a different name in the author slot. A
  // bespoke row would need its own empty and error states, and its own answer
  // every time this family changes, to present something a reader already knows
  // how to read.
  const human = message.authorType === 'human' || message.authorType === 'external';
  const external = message.authorType === 'external';
  // Cowork and Claude Code share a JSONL decoder and source provider. Keep the
  // attribution accurate for both without exposing the storage format.
  const importedProvider = message.importProvenance?.source.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
  const ownHumanMessage = message.authorType === 'human' && !message.importProvenance
    && currentUserId !== undefined && message.author?.id === currentUserId;
  const humanAuthorName = message.importProvenance ? `${importedProvider} user`
    : external ? `${message.externalActor?.displayName ?? 'Slack workspace member'} · Slack`
    : profile?.displayName ?? message.author?.name ?? 'Organization member';
  const sending = message.deliveryState === 'sending';
  const pending = message.deliveryState === 'steer_pending'
    || message.deliveryState === 'queue_pending';
  // Every queued message says the same thing, whatever will deliver it: Rally
  // has not read it yet.
  const pendingLabel = pending ? 'Unseen' : null;
  // Only a settled turn of what was said can be a cutoff: text, or a
  // Sidekick's result, which the capture keeps. A streaming or undelivered one
  // has no fixed end to freeze. The id is read into a local so the callback
  // closes over the value the condition checked rather than re-asserting it.
  const cutoffTurnId = message.transcriptTurnId;
  const startSubstream = onStartSubstream && cutoffTurnId !== undefined
    && (message.messageType === 'text' || message.messageType === 'automation_activation')
    && !message.streaming && !message.deliveryState
    ? () => onStartSubstream(cutoffTurnId)
    : undefined;
  // The same settled-text rule: a merge carries words that are done.
  const mergeAction: MessageMergeAction | undefined = merge && message.text && message.messageType === 'text'
    && !message.streaming && !message.deliveryState
    ? { label: merge.label, onMerge: (text) => merge.onMerge(text, cutoffTurnId) }
    : undefined;
  const mergedFrom = message.mergedFrom;
  if (mergedFrom && message.text) {
    // A merged result reads as one, on the leading side, in the same block a
    // Channel draws a thread's merge with; see `MergeMessage`.
    const author = message.author;
    return (
      <MergeMessage
        actions={<MessageActions
          citations={citations}
          mentions={message.mentions}
          onMerge={mergeAction}
          onStartSubstream={startSubstream}
          telemetry={{ messageId: message.id, workstreamId: message.workstreamId }}
          text={message.text}
        />}
        className="message-block"
        id={`message-${message.id}`}
        label={`${mergedFrom.title || 'A breakout'}, merged by ${humanAuthorName}`}
        mergedBy={<>
          {/* Rally merged on this person's request: both, Rally first. */}
          {mergedFrom.actingAgent && <><RallyAvatar size="small" />Rally<span className="merge-message-for"> for </span></>}
          {author && <Avatar member={{ id: author.id, name: author.name, email: author.email ?? '', timezone: author.timezone ?? 'UTC', ...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}) }} size="small" title={null} />}
          {humanAuthorName}
        </>}
        source={{
          mark: <IconCornerDownRight size={10} stroke={2} />,
          title: mergedFrom.title || 'A breakout',
          onOpen: onOpenBreakout ? () => onOpenBreakout(mergedFrom.breakoutId) : undefined,
        }}
        time={<RelativeTime value={message.createdAt} />}
      >
        {/* A merge is written to be read as a result: its markdown and its
            `resource://` embeds render, which a typed message's verbatim
            body does not. */}
        <MarkdownBody
          citations={citations}
          mentions={message.mentions}
          speechKind="message"
          telemetry={{ messageId: message.id, workstreamId: message.workstreamId }}
        >{message.text}</MarkdownBody>
      </MergeMessage>
    );
  }
  const article = (
    <article
      aria-label={sending ? 'Sending message' : pending && pendingLabel
        ? `${pendingLabel}: message from ${humanAuthorName}`
        : human ? `Message from ${humanAuthorName}`
          : automation ? `Result from ${automationAuthor}` : undefined}
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
      data-profile-color={human ? profile?.color : undefined}
      style={human ? personStyle : undefined}
    >
      {/* One identity line for every turn in the feed, the reader's own
          included. A person reading back a long transcript is reading a room,
          not a private thread: whose words these are and when they were said is
          the same question about their own turn as about anybody else's, and a
          turn that answers it only for other people makes the reader's own
          messages the one thing on screen with no time against it. */}
      <MessageByline
        align={human ? 'end' : 'start'}
        author={human ? humanAuthorName : message.importProvenance ? importedProvider : automation ? automationAuthor : 'Rally'}
        importedBy={message.importProvenance?.importedByName}
        contextLabel={message.importProvenance?.supersedesTurnId ? 'Updated source message' : message.contextLabel}
        createdAt={message.createdAt}
        dot={human}
        workSummary={message.workSummary ? workSummaryLabel(message.workSummary) : undefined}
      >
        {!human && collapseHeadings && <MarkdownCollapseAllButton />}
      </MessageByline>
      {human ? (
        <div className="human-message-content">
          <HumanMessageBody
            attachments={message.attachments}
            disclosure={rowDisclosure}
            loadAttachmentContent={loadAttachmentContent}
            mentions={message.mentions}
            messageId={message.id}
            onOpenAttachment={onOpenAttachment}
            telemetry={{ messageId: message.id, workstreamId: message.workstreamId }}
            text={message.text}
          />
          <MessageAnnotations content={message.annotationContent} onOpen={onOpenAttachment} />
          {pendingLabel && <span className="message-delivery-pill">{pendingLabel}</span>}
          {/* The slot, whether or not there is a control to put in it. It is
              laid out always and painted on hover, and the turn after this one
              sits one unit under it — so it is the slot, not the gap, that
              keeps the next turn off this bubble. A surface that cannot start
              a substream (an automation's conversation, a substream other than
              the main one, the launch provenance) still needs that clearance,
              and so does a turn that is not yet a cutoff; leaving the slot out
              there handed the next turn a 4px clearance on the bubble itself. */}
          <MessageActions
            onMerge={mergeAction}
            onStartSubstream={startSubstream}
            text={message.text ?? ''}
            textActions={false}
          />
        </div>
      ) : (
        <>
          <AssistantMessageContent
            afterText={message.attachments?.length && loadAttachmentContent && onOpenAttachment ? (
              <MessageAttachments attachments={message.attachments} loadContent={loadAttachmentContent} onOpen={onOpenAttachment} />
            ) : null}
            citations={citations}
            collapseHeadings={collapseHeadings}
            mentions={message.mentions}
            onMerge={mergeAction}
            onStartSubstream={startSubstream}
            streaming={message.streaming}
            text={message.text ?? ''}
            telemetry={{ messageId: message.id, workstreamId: message.workstreamId }}
          />

        </>
      )}
    </article>
  );
  if (human || !collapseHeadings) return article;
  // Same repair the body applies, so the header's collapse-all and the
  // body's section wrappers agree on `section-${index}` ids. Mentions are
  // inline links and cannot change the heading count.
  return (
    <MarkdownCollapseController markdown={normalizeModelMarkdown(message.text ?? '')}>
      {article}
    </MarkdownCollapseController>
  );
}
