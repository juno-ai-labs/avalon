import mermaid from 'mermaid';
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../lib/theme';
import { readMermaidThemeConfig } from './markdown-mermaid-theme';

interface RenderedDiagram {
  key: string;
  status: 'rendered';
  svg: string;
  width?: number;
}

interface FailedDiagram {
  key: string;
  status: 'failed';
}

type DiagramState = RenderedDiagram | FailedDiagram;

let renderQueue: Promise<void> = Promise.resolve();
let nextDiagramId = 0;

function diagramWidth(svg: string): number | undefined {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const values = document.documentElement.getAttribute('viewBox')?.trim().split(/\s+/u);
  const width = Number(values?.[2]);
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

/**
 * Mermaid keeps configuration at module scope. Serialising initialize + render
 * prevents two diagrams mounting together from racing one another's theme.
 */
async function renderMermaid(id: string, source: string): Promise<string> {
  const { themeCSS, themeVariables } = readMermaidThemeConfig();
  const execute = async (): Promise<string> => {
    mermaid.initialize({
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
      ],
      securityLevel: 'strict',
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: 'base',
      themeCSS,
      themeVariables,
    });
    const { svg } = await mermaid.render(id, source);
    return svg;
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
  const id = useMemo(() => `rally-mermaid-${++nextDiagramId}`, []);
  const key = `${resolved}\u0000${code}`;
  const [diagram, setDiagram] = useState<DiagramState>();

  useEffect(() => {
    let current = true;
    void renderMermaid(id, code).then(
      (svg) => {
        if (current) setDiagram({ key, status: 'rendered', svg, width: diagramWidth(svg) });
      },
      () => {
        if (current) setDiagram({ key, status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [code, id, key, resolved]);

  const current = diagram?.key === key ? diagram : undefined;
  if (current?.status === 'rendered') {
    return (
      <div
        aria-label="Mermaid diagram"
        className="markdown-mermaid-diagram"
        role="img"
      >
        <div
          className="markdown-mermaid-svg"
          // Mermaid's strict mode sanitises the generated SVG, disables links
          // and click handlers, and encodes HTML labels. The source remains
          // untrusted; this is the only generated-markup insertion point.
          dangerouslySetInnerHTML={{ __html: current.svg }}
          style={{ width: current.width ?? '100%' }}
        />
      </div>
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
