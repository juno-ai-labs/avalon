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

function diagramWidth(svg: string): number | undefined {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const values = document.documentElement.getAttribute('viewBox')?.trim().split(/\s+/u);
  const width = Number(values?.[2]);
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

interface PreparedDiagram {
  svg: string;
  title?: string;
  description?: string;
}

function directChildText(root: Element, localName: string): string | undefined {
  const value = Array.from(root.children)
    .find((child) => child.localName === localName)
    ?.textContent
    ?.trim();
  return value || undefined;
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

  return { svg: new XMLSerializer().serializeToString(root), title, description };
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
        setDiagram({ key, status: 'rendered', ...prepared, width: diagramWidth(prepared.svg) });
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
        <p className="markdown-mermaid-error" role="status">Couldn’t render diagram; showing source.</p>
      ) : null}
      {fallback}
    </>
  );
}
