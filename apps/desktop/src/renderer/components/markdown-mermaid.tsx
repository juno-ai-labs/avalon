import { ErrorNotice } from './primitives';
import mermaid from 'mermaid';
import { useEffect, useId, useState } from 'react';
import { useTheme } from '../lib/theme';
import { readMermaidThemeConfig } from './markdown-mermaid-theme';

interface RenderedDiagram {
  key: string;
  status: 'rendered';
  svg: string;
  width?: number;
  title?: string;
  description?: string;
}

interface FailedDiagram {
  key: string;
  status: 'failed';
}

type DiagramState = RenderedDiagram | FailedDiagram;

let renderQueue: Promise<void> = Promise.resolve();

interface PreparedDiagram {
  svg: string;
  width?: number;
  title?: string;
  description?: string;
}

interface MermaidResourceBearingEntry {
  cssStyles?: unknown;
  img?: unknown;
  style?: unknown;
  styles?: unknown;
  textStyles?: unknown;
}

interface DiagramDatabaseWithResources {
  getBlocksFlat?: () => MermaidResourceBearingEntry[];
  getClasses?: () => Map<string, MermaidResourceBearingEntry>;
  getEdges?: () => MermaidResourceBearingEntry[];
  getVertices?: () => Map<string, MermaidResourceBearingEntry>;
}

function directChildText(root: Element, localName: string): string | undefined {
  const value = Array.from(root.children)
    .find((child) => child.localName === localName)
    ?.textContent
    ?.trim();
  return value || undefined;
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\(?:\r\n|[\n\r\f])/gu, '')
    .replace(/\\([\dA-Fa-f]{1,6})\s?|\\([^\dA-Fa-f])/gu, (_match, hex: string | undefined, escaped: string | undefined) => {
      if (!hex) return escaped ?? '';
      const codePoint = Number.parseInt(hex, 16);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
    });
}

function normalizedCss(value: string): string {
  return decodeCssEscapes(value).replace(/\/\*[\s\S]*?\*\//gu, '');
}

function hasExternalCssReferenceInNormalized(css: string): boolean {
  if (/@import\b|(?:-webkit-)?image-set\s*\(/iu.test(css)) return true;

  const urls = css.matchAll(/url\s*\(\s*([^)]*?)\s*\)/giu);
  for (const match of urls) {
    let target = match[1]?.trim() ?? '';
    if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1).trim();
    }
    if (!/^#[\w.:-]+$/u.test(target)) return true;
  }
  return false;
}

function hasExternalCssReference(value: string): boolean {
  return hasExternalCssReferenceInNormalized(normalizedCss(value));
}

function hasExternalCssResource(value: string): boolean {
  const css = normalizedCss(value);
  return /(?:https?|data|blob|file):|(?:^|[("'\s])\/\//iu.test(css) || hasExternalCssReferenceInNormalized(css);
}

function hasExternalCssStyleDirective(source: string): boolean {
  return source.split(/\r?\n/u).some((line) =>
    /^\s*(?:classDef|linkStyle|style)\b/iu.test(line) && hasExternalCssReference(line),
  );
}

const cssResourceAttributes = new Set([
  'background',
  'background-image',
  'clip-path',
  'cursor',
  'fill',
  'filter',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
  'style',
]);

/**
 * Flowchart image nodes construct a browser Image, and parsed styles are applied
 * to a live temporary SVG, while Mermaid is rendering. Inspect Mermaid's parsed
 * database first so untrusted diagram text cannot start an external request
 * before the resulting SVG can be sanitised.
 */
async function rejectRenderTimeResources(source: string): Promise<void> {
  if (hasExternalCssStyleDirective(source)) throw new Error('mermaid_render_time_resource');
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  const database = diagram.db as DiagramDatabaseWithResources;
  const vertices = database.getVertices?.();
  if (vertices && Array.from(vertices.values()).some((vertex) => typeof vertex.img === 'string' && vertex.img.trim())) {
    throw new Error('mermaid_render_time_resource');
  }

  const entries = [
    ...(database.getBlocksFlat?.() ?? []),
    ...Array.from(vertices?.values() ?? []),
    ...Array.from(database.getClasses?.().values() ?? []),
    ...(database.getEdges?.() ?? []),
  ];
  for (const entry of entries) {
    for (const candidate of [entry.cssStyles, entry.style, entry.styles, entry.textStyles]) {
      const styles = Array.isArray(candidate) ? candidate : [candidate];
      if (styles.some((style) => typeof style === 'string' && hasExternalCssResource(style))) {
        throw new Error('mermaid_render_time_resource');
      }
    }
  }
}

/**
 * Mermaid strict mode sanitises scriptable markup but deliberately preserves
 * ordinary links. Rally diagrams are non-interactive, so unwrap anchors and
 * remove every non-fragment URL before the SVG crosses into React.
 */
function prepareDiagram(svg: string): PreparedDiagram {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror')) throw new Error('mermaid_svg_invalid');
  const root = document.documentElement;
  const title = directChildText(root, 'title');
  const description = directChildText(root, 'desc');
  const viewBox = root.getAttribute('viewBox')?.trim().split(/\s+/u);
  const viewBoxWidth = Number(viewBox?.[2]);
  const width = Number.isFinite(viewBoxWidth) && viewBoxWidth > 0 ? viewBoxWidth : undefined;

  if (root.querySelector('script, foreignObject')) throw new Error('mermaid_svg_forbidden_element');
  for (const style of Array.from(root.querySelectorAll('style'))) {
    if (hasExternalCssResource(style.textContent ?? '')) throw new Error('mermaid_svg_external_resource');
  }
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (cssResourceAttributes.has(attribute.name) && hasExternalCssResource(attribute.value)) {
        throw new Error('mermaid_svg_external_resource');
      }
    }
  }

  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    const parent = anchor.parentNode;
    if (!parent) continue;
    while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
    anchor.remove();
  }
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of ['href', 'xlink:href']) {
      const value = element.getAttribute(attribute)?.trim();
      if (value && !value.startsWith('#')) element.removeAttribute(attribute);
    }
  }

  return { svg: new XMLSerializer().serializeToString(root), width, title, description };
}

/**
 * Mermaid keeps configuration at module scope. Serialising initialize + render
 * prevents two diagrams mounting together from racing one another's theme.
 */
async function renderMermaid(id: string, source: string, signal: AbortSignal): Promise<PreparedDiagram> {
  const execute = async (): Promise<PreparedDiagram> => {
    signal.throwIfAborted();
    const { fontFamily, fontSize, themeCSS, themeVariables } = readMermaidThemeConfig();
    mermaid.initialize({
      altFontFamily: fontFamily,
      flowchart: { htmlLabels: false },
      fontFamily,
      fontSize,
      htmlLabels: false,
      logLevel: 'fatal',
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        'htmlLabels',
        'theme',
        'themeCSS',
        'themeVariables',
        'fontFamily',
        'altFontFamily',
        'fontSize',
        'look',
      ],
      securityLevel: 'strict',
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: 'base',
      look: 'classic',
      themeCSS,
      themeVariables,
    });
    const maxTextSize = mermaid.mermaidAPI.getConfig().maxTextSize;
    if (typeof maxTextSize === 'number' && Number.isFinite(maxTextSize) && source.length > maxTextSize) {
      throw new Error('mermaid_text_too_large');
    }
    await rejectRenderTimeResources(source);
    signal.throwIfAborted();
    const { svg } = await mermaid.render(id, source);
    return prepareDiagram(svg);
  };

  const result = renderQueue.then(execute, execute);
  renderQueue = result.then(() => undefined, () => undefined);
  return await result;
}

export function MarkdownMermaid({ code, fallback }: {
  code: string;
  fallback: React.ReactNode;
}): React.JSX.Element {
  const { resolved } = useTheme();
  const id = `rally-mermaid-${useId().replace(/[^A-Za-z0-9_-]/gu, '-')}`;
  const key = `${resolved}\u0000${code}`;
  const [diagram, setDiagram] = useState<DiagramState>();

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    void renderMermaid(id, code, controller.signal).then(
      (prepared) => {
        if (!current) return;
        setDiagram({ key, status: 'rendered', ...prepared });
      },
      () => {
        if (current) setDiagram({ key, status: 'failed' });
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [code, id, key, resolved]);

  const current = diagram?.key === key ? diagram : undefined;
  if (current?.status === 'rendered') {
    const descriptionId = `${id}-description`;
    return (
      <>
        <div
          aria-describedby={descriptionId}
          aria-label={current.title ?? 'Mermaid diagram'}
          className="markdown-mermaid-diagram"
          role="img"
        >
          <div
            className="markdown-mermaid-svg"
            // Strict mode sanitises scriptable SVG; prepareDiagram additionally
            // removes links before this sole generated-markup insertion point.
            dangerouslySetInnerHTML={{ __html: current.svg }}
            style={{ width: current.width ?? '100%' }}
          />
        </div>
        <span className="sr-only" id={descriptionId}>
          {current.description ?? `Diagram source: ${code}`}
        </span>
      </>
    );
  }

  return (
    <>
      {current?.status === 'failed' ? (
        <ErrorNotice>Couldn’t render diagram; showing source.</ErrorNotice>
      ) : null}
      {fallback}
    </>
  );
}
