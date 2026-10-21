import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownMermaid } from './markdown-mermaid';

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({}),
  desktopServicesAvailable: () => false,
}));

vi.mock('./markdown-mermaid-theme', () => ({
  readMermaidThemeConfig: () => ({
    fontFamily: 'Arial',
    fontSize: 14,
    themeCSS: '.trusted-mermaid-theme { fill: rgb(1, 2, 3); }',
    themeVariables: {
      background: '#ffffff',
      fontFamily: 'Arial',
      fontSize: '14px',
      lineColor: '#333333',
      primaryBorderColor: '#222222',
      primaryColor: '#eeeeee',
      primaryTextColor: '#111111',
      textColor: '#111111',
    },
  }),
}));

describe('Mermaid trust boundary', () => {
  const computedTextLength = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getComputedTextLength');
  const getBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');

  beforeEach(() => {
    Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', {
      configurable: true,
      value: () => 100,
    });
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ height: 20, width: 100, x: 0, y: 0 }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (computedTextLength) {
      Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', computedTextLength);
    } else {
      Reflect.deleteProperty(SVGElement.prototype, 'getComputedTextLength');
    }
    if (getBBox) {
      Object.defineProperty(SVGElement.prototype, 'getBBox', getBBox);
    } else {
      Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
    }
  });

  it('keeps the trusted theme and removes live links from real Mermaid output', async () => {
    const source = `---
config:
  theme: dark
  themeCSS: '.attacker { fill: rgb(9, 8, 7); }'
  themeVariables:
    primaryColor: '#ff00ff'
  fontFamily: Attacker
  altFontFamily: Attacker
  fontSize: 99
  look: handDrawn
---
flowchart TD
  accTitle: Review flow
  accDescr: A request moves from review to done.
  A[Review] --> B[Done]
  click A "https://example.invalid/phish"`;

    const { container } = render(
      <MarkdownMermaid code={source} fallback={<pre>{source}</pre>} />,
    );

    const diagram = await screen.findByRole('img', { name: 'Review flow' }, { timeout: 10_000 });
    expect(diagram).toHaveAccessibleDescription('A request moves from review to done.');
    const svg = container.querySelector('.markdown-mermaid-svg svg');
    expect(svg).not.toBeNull();
    expect(svg?.outerHTML).toContain('trusted-mermaid-theme');
    expect(svg?.outerHTML).not.toContain('example.invalid');
    expect(svg?.outerHTML).not.toContain('#ff00ff');
    expect(svg?.outerHTML).not.toContain('rgb(9, 8, 7)');
    expect(svg?.outerHTML).not.toContain('Attacker');
    expect(svg?.outerHTML).not.toContain('font-size:99');
    expect(svg?.querySelector('a')).toBeNull();
    expect(Array.from(svg?.querySelectorAll('[href], [xlink\\:href]') ?? []).every((element) => {
        const href = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '';
        return href.startsWith('#');
      })).toBe(true);
  });

  it('rejects external CSS resources emitted by real Mermaid styling syntax', async () => {
    const source = `flowchart TD
  A[Review] --> B[Done]
  classDef remote fill:url(https://example.invalid/beacon)
  class B remote`;

    const { container } = render(<MarkdownMermaid code={source} fallback={<pre>{source}</pre>} />);

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(container.querySelector('pre')?.textContent).toBe(source);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('rejects external resources in block styles before rendering', async () => {
    const source = `block-beta
  A["Review"]
  style A fill:url(https://example.invalid/beacon.svg)`;

    const { container } = render(<MarkdownMermaid code={source} fallback={<pre>{source}</pre>} />);

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(container.querySelector('pre')?.textContent).toBe(source);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('rejects flowchart images before Mermaid can assign their external URL', async () => {
    const assignedSource = vi.fn();
    class InstrumentedImage {
      naturalHeight = 1;
      naturalWidth = 1;

      set src(value: string) {
        assignedSource(value);
      }

      async decode(): Promise<void> {}
    }
    vi.stubGlobal('Image', InstrumentedImage);
    const source = `flowchart TD
  A@{ img: "https://example.invalid/beacon.png" }`;

    const { container } = render(<MarkdownMermaid code={source} fallback={<pre>{source}</pre>} />);

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Couldn’t render diagram; showing source.');
    expect(assignedSource).not.toHaveBeenCalled();
    expect(container.querySelector('pre')?.textContent).toBe(source);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('never mounts HTML image labels while Mermaid renders', async () => {
    const mountedSources: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          const images = node.matches('img') ? [node] : Array.from(node.querySelectorAll('img'));
          for (const image of images) mountedSources.push(image.getAttribute('src') ?? '');
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const source = `flowchart TD
  A["<img src='https://example.invalid/beacon.png'>"]`;

    const { container } = render(<MarkdownMermaid code={source} fallback={<pre>{source}</pre>} />);

    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    await Promise.resolve();
    observer.disconnect();
    expect(mountedSources).not.toContain('https://example.invalid/beacon.png');
    expect(container.querySelector('.markdown-mermaid-svg img')).toBeNull();
    expect(container.querySelector('.markdown-mermaid-svg foreignObject')).toBeNull();
  });
});
