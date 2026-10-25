import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MessageExportRequest } from '../common/message-export';
import { exportSyntaxPalette } from '../common/theme-assets';
import {
  isMessageExportUrl,
  MESSAGE_EXPORT_SCHEME,
  MessageExporter,
  messageExportDocument,
  messageExportFooter,
  parseMessageExportRequest,
  type MessageExportDependencies,
  type MessageExportPrintOptions,
  type MessageExportWindow,
} from './message-export';

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';

function request(overrides: Partial<MessageExportRequest> = {}): MessageExportRequest {
  return {
    format: 'image',
    contentHtml: '<h1>Pipeline</h1><p>Two things moved.</p>',
    fileName: 'pipeline-2026-08-13',
    logoDataUrl: LOGO,
    ...overrides,
  };
}

function harness(options: {
  measuredHeight?: number;
  savePath?: string | null;
  failOn?: 'load' | 'capture' | 'font';
} = {}) {
  const state = {
    loaded: [] as string[],
    captures: [] as number[],
    prints: [] as MessageExportPrintOptions[],
    resizes: [] as Array<{ width: number; height: number; zoom: number }>,
    destroyed: 0,
    fontReads: [] as string[],
    evaluated: [] as string[],
    written: [] as Array<{ path: string; bytes: Uint8Array }>,
    documentAtLoad: null as string | null,
    documentAtMeasure: null as string | null,
  };
  let loadedUrl = '';
  let openWindows = 0;
  let token = 0;
  let failNextLoad = false;

  const dependencies: MessageExportDependencies = {
    createWindow: () => {
      openWindows += 1;
      // Two export windows alive at once would mean the queue stopped serializing.
      expect(openWindows).toBe(1);
      const window: MessageExportWindow = {
        load: async (url) => {
          state.loaded.push(url);
          // What the window can actually read is what the protocol would serve.
          loadedUrl = url;
          state.documentAtLoad = exporter.document(url);
          if (failNextLoad) {
            failNextLoad = false;
            throw new Error('did-fail-load');
          }
          if (options.failOn === 'load') throw new Error('did-fail-load');
        },
        evaluate: async (script) => {
          state.evaluated.push(script);
          state.documentAtMeasure = exporter.document(loadedUrl);
          return options.measuredHeight ?? 1_400;
        },
        resize: (width, height, zoom) => state.resizes.push({ width, height, zoom }),
        captureJpeg: async (quality) => {
          if (options.failOn === 'capture') throw new Error('no surface');
          state.captures.push(quality);
          return new Uint8Array([0xff, 0xd8, quality]);
        },
        printPdf: async (printOptions) => {
          state.prints.push(printOptions);
          return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        },
        destroy: () => {
          openWindows -= 1;
          state.destroyed += 1;
        },
      };
      return window;
    },
    showSaveDialog: async ({ defaultFileName }) =>
      options.savePath === undefined ? `/home/ada/Downloads/${defaultFileName}` : options.savePath,
    writeFile: async (path, bytes) => {
      state.written.push({ path, bytes });
    },
    readFont: async (file) => {
      state.fontReads.push(file);
      if (options.failOn === 'font') throw new Error('ENOENT');
      return new TextEncoder().encode(file);
    },
    logWarning: () => undefined,
    randomToken: () => `token-${++token}`,
    now: () => 1_700_000_000_000,
    delay: async () => undefined,
  };
  const exporter = new MessageExporter(dependencies);
  return { dependencies, exporter, state, failNextLoad: () => { failNextLoad = true; } };
}

describe('message export requests', () => {
  it('accepts a well-formed request', () => {
    expect(parseMessageExportRequest(request())).toMatchObject({ format: 'image' });
  });

  it.each([
    ['a file name that could leave the chosen directory', { fileName: '../../etc/passwd' }],
    ['a file name with a separator', { fileName: 'notes/pipeline' }],
    ['an empty document', { contentHtml: '' }],
    ['a logo that is not a PNG data URL', { logoDataUrl: 'https://example.com/mark.png' }],
    ['a logo carrying something other than base64', { logoDataUrl: 'data:image/png;base64,<script>' }],
    ['an unknown format', { format: 'svg' as MessageExportRequest['format'] }],
    ['one message past its bound', { contentHtml: 'x'.repeat(600_001) }],
    ['a conversation as a picture', { scope: 'conversation' as const, format: 'image' as const }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => parseMessageExportRequest(request(overrides))).toThrow('Invalid message export request');
  });

  it('names the field it rejected', () => {
    expect(() => parseMessageExportRequest(request({ scope: 'conversation', format: 'image' })))
      .toThrow('Invalid message export request: format:custom');
  });

  it('accepts a whole conversation past one message\'s bound', () => {
    const contentHtml = '<p>Turn</p>'.repeat(60_001);
    expect(parseMessageExportRequest(request({ scope: 'conversation', format: 'pdf', contentHtml })))
      .toMatchObject({ scope: 'conversation', format: 'pdf' });
  });
});

describe('recognising an export URL', () => {
  // The application's own `onHeadersReceived` asks this before it attaches the
  // renderer's Content-Security-Policy, so a URL it fails to recognise is an
  // export document rendered under the wrong — much broader — policy.
  it.each([
    [`${MESSAGE_EXPORT_SCHEME}://sheet/token-1`, true],
    [`${MESSAGE_EXPORT_SCHEME}://sheet/`, true],
    [`${MESSAGE_EXPORT_SCHEME}://elsewhere/token-1`, false],
    ['app://rallywithai/index.html', false],
    ['https://sheet/token-1', false],
    ['not a url', false],
  ])('answers %s with %s', (url, expected) => {
    expect(isMessageExportUrl(url)).toBe(expected);
  });
});

/**
 * Every `citation-*` class `markdown-citations.tsx` puts in the DOM.
 *
 * Read off the source with `node:fs`, the way the renderer's own guards read
 * theirs — this file runs in the node project, so that is available here.
 */
function citationClassesTheRendererEmits(): string[] {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/markdown-citations.tsx'),
    'utf8',
  );
  const classes = new Set<string>();
  for (const [, value] of source.matchAll(/className="([^"]*)"/gu)) {
    for (const name of value!.split(/\s+/u)) if (name.startsWith('citation-')) classes.add(name);
  }
  // The renderer also builds nodes by hand — the embed row is hast the rehype
  // pass constructs, whose class arrives as `className: ['citation-card-row']`
  // rather than as a JSX string. Scanning only the JSX form left that class
  // outside the guard entirely, which is exactly the drift this function is
  // here to prevent: the export could have lost its rule for the row without
  // any test noticing.
  for (const [, value] of source.matchAll(/className:\s*\[([^\]]*)\]/gu)) {
    for (const [, name] of value!.matchAll(/['"]([^'"]+)['"]/gu)) {
      if (name!.startsWith('citation-')) classes.add(name!);
    }
  }
  if (classes.size === 0) throw new Error('No citation classes found — has the renderer moved?');
  return [...classes].sort();
}

describe('the exported document', () => {
  it('renders the message inside the card, signed, for a picture', () => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>Hello</p>', logoDataUrl: LOGO });

    expect(html).toContain('<div class="markdown-body"><p>Hello</p></div>');
    expect(html).toContain('Saved from Rally');
    expect(html).toContain(`-webkit-mask: url('${LOGO}')`);
    // The splash is the card's own background; a picture has no page to bleed to.
    expect(html).not.toContain('export-sheet');
  });

  it('wraps the card in the splash frame for a PDF, and signs it in the page footer instead', () => {
    const html = messageExportDocument({ format: 'pdf', contentHtml: '<p>Hello</p>', logoDataUrl: LOGO });

    // The frame is a box the page break clones, which is what puts the splash
    // and the rounded white card on every page rather than only the first.
    expect(html).toContain('<div class="export-sheet">');
    expect(html).toContain('-webkit-box-decoration-break: clone');
    expect(html).not.toContain('<div class="export-signature">');
    expect(messageExportFooter(LOGO)).toContain(`src="${LOGO}"`);
    expect(messageExportFooter(LOGO)).toContain('Saved from Rally');
  });

  /**
   * `MarkdownBody` colours highlighted code with `var(--av-sys-color-syntax-*)`
   * in inline styles. Everywhere else those resolve against the application's
   * cascade; this document is the one place that markup is re-hosted outside it,
   * and it loads no stylesheet of ours. Without these declarations every
   * reference is invalid at computed-value time, `color` falls back to the
   * inherited near-black, and the code block renders near-black on near-black —
   * about 1.05:1, which is to say invisible, and silently so.
   */
  it('declares every syntax token the highlighter names, so code survives the trip out', () => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>Hello</p>', logoDataUrl: LOGO });

    expect(Object.keys(exportSyntaxPalette).length).toBeGreaterThan(0);
    for (const [property, value] of Object.entries(exportSyntaxPalette)) {
      expect(html).toContain(`${property}: ${value};`);
    }
  });

  /**
   * The card is deliberately not themed — a fixed light sheet with a fixed dark
   * code block — so the palette it declares has to be legible against that
   * block whatever the person exporting it happens to be looking at.
   */
  it('gives the code block a palette light enough to read on its dark ground', () => {
    const luminance = (hex: string): number => {
      const channel = (pair: string): number => {
        const value = Number.parseInt(pair, 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(hex.slice(1, 3))
        + 0.7152 * channel(hex.slice(3, 5))
        + 0.0722 * channel(hex.slice(5, 7));
    };
    // `.markdown-code-block`'s background, which this document fixes at #1b1c18.
    const ground = luminance('#1b1c18');

    for (const [property, value] of Object.entries(exportSyntaxPalette)) {
      const contrast = (luminance(value) + 0.05) / (ground + 0.05);
      expect({ property, contrast: Math.round(contrast * 10) / 10 })
        .toEqual({ property, contrast: expect.any(Number) });
      expect(contrast).toBeGreaterThan(3);
    }
  });

  it('hides the code block copy button, which is a control rather than content', () => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>x</p>', logoDataUrl: LOGO });

    expect(html).toContain('.markdown-code-block-header button { display: none; }');
  });

  // The label is a <span>, and a vertical margin on an inline box is a no-op —
  // without `display: block` the label sits flush against the code with no gap,
  // which nothing here renders to catch.
  it('blockifies the code language label so its margin actually opens a gap', () => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>x</p>', logoDataUrl: LOGO });

    expect(html).toMatch(/\.markdown-code-language\s*\{[^}]*\bdisplay:\s*block;/u);
  });

  /**
   * The card shares `MarkdownBody`'s markup and none of its stylesheet, so a
   * class introduced there has no rule here until somebody writes one — and the
   * miss shows up as an unstyled element in the first card anybody looks at,
   * not as a failure anywhere near the change that caused it. This is the guard
   * that turns that into a test failure instead.
   *
   * The list is read off the renderer rather than typed here, which is the only
   * version that closes the category: a hand-kept list cannot fail for a class
   * added tomorrow, and the first hand-kept version was already missing four of
   * the seventeen on the day it landed.
   */
  it.each(citationClassesTheRendererEmits())('styles .%s, which the renderer emits and this document would not', (className) => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>x</p>', logoDataUrl: LOGO });

    // `\b` matches between `p` and `-`, so `.citation-chip` was satisfied by
    // `.citation-chip-icon {` — the three rules that matter most could each be
    // deleted with this test still green.
    expect(html).toMatch(new RegExp(`\\.${className}(?![\\w-])[^{]*\\{`, 'u'));
  });

  /**
   * Caught in a real capture, not in a component test: GFM gives the footnote
   * section a heading it expects the host to hide, and this document loads none
   * of the application stylesheet. Without a rule of its own the card printed a
   * bare "Footnotes" heading above the list — a word from the renderer's
   * plumbing, in the middle of somebody's saved picture.
   */
  it('hides a visually-hidden element, which this document has no rule for otherwise', () => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>x</p>', logoDataUrl: LOGO });

    expect(html).toMatch(/\.sr-only\b[^{]*\{[^}]*(?:display:\s*none|clip-path)/u);
  });

  it('drops the popover, an affordance a still card cannot offer', () => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>x</p>', logoDataUrl: LOGO });

    expect(html).toMatch(/\.citation-pill-popover\b[^{]*\{[^}]*display:\s*none;/u);
  });

  it('splashes two different messages differently and the same message the same way', () => {
    const splash = (contentHtml: string): string =>
      messageExportDocument({ format: 'image', contentHtml, logoDataUrl: LOGO })
        .match(/radial-gradient\([^)]*\)[^;]*/u)?.[0] ?? '';

    expect(splash('<p>one</p>')).toBe(splash('<p>one</p>'));
    expect(splash('<p>one</p>')).not.toBe(splash('<p>a different message entirely</p>'));
  });
});

describe('saving a message', () => {
  it('serves the document to its own window, captures it at twice its measured height, and writes it', async () => {
    const test = harness({ measuredHeight: 1_400 });

    const result = await test.exporter.save(request());

    expect(result).toEqual({ saved: true });
    expect(test.state.loaded).toEqual([`${MESSAGE_EXPORT_SCHEME}://sheet/token-1`]);
    expect(test.state.documentAtLoad).toContain('Two things moved.');
    expect(test.state.resizes).toEqual([{ width: 1_920, height: 2_800, zoom: 2 }]);
    expect(test.state.captures).toEqual([92]);
    expect(test.state.written).toEqual([
      { path: '/home/ada/Downloads/pipeline-2026-08-13.jpg', bytes: new Uint8Array([0xff, 0xd8, 92]) },
    ]);
  });

  it('drops to one pixel per pixel rather than asking Chromium for a surface it cannot hold', async () => {
    const test = harness({ measuredHeight: 9_000 });

    await test.exporter.save(request());

    expect(test.state.resizes).toEqual([{ width: 960, height: 9_000, zoom: 1 }]);
  });

  it('prints a PDF with the footer on every page, and never captures', async () => {
    const test = harness();

    await test.exporter.save(request({ format: 'pdf' }));

    expect(test.state.captures).toEqual([]);
    expect(test.state.prints).toHaveLength(1);
    expect(test.state.prints[0]?.footerHtml).toContain('Saved from Rally');
    expect(test.state.prints[0]?.margins.bottom).toBeGreaterThan(test.state.prints[0]!.margins.top);
    expect(test.state.written[0]?.path).toBe('/home/ada/Downloads/pipeline-2026-08-13.pdf');
  });

  it('sets the card in the embedded faces and waits for them before printing', async () => {
    const test = harness();

    await test.exporter.save(request({ format: 'pdf' }));

    expect(test.state.documentAtLoad).toContain('font-family: "Rally Export Sans"; font-style: normal; font-weight: 600; src: url(data:font/ttf;base64,SW50ZXItU2VtaUJvbGQudHRm) format("truetype");');
    expect(test.state.documentAtLoad).toContain('font-family: "Rally Export Mono"; font-style: normal; font-weight: 400; src: url(data:font/ttf;base64,R2Vpc3RNb25vLVJlZ3VsYXIudHRm)');
    expect(test.state.documentAtLoad).toContain('font-family: "Rally Export Sans", Inter,');
    expect(test.state.evaluated).toEqual(['document.fonts.ready.then(() => true)']);
    // Chromium gives a footer no web fonts; Arial is the static TrueType face every Mac has.
    expect(test.state.prints[0]?.footerHtml).toContain('font-family:Arial,Helvetica,sans-serif');
  });

  it('reads the faces once for the session', async () => {
    const test = harness();

    await test.exporter.save(request({ format: 'pdf' }));
    await test.exporter.save(request({ format: 'image' }));

    expect(test.state.fontReads).toEqual(['Inter-Regular.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf', 'Inter-Italic.ttf', 'GeistMono-Regular.ttf']);
  });

  it('fails an export whose faces cannot be read, closes its window, and reads them again next time', async () => {
    const test = harness({ failOn: 'font' });

    await expect(test.exporter.save(request({ format: 'pdf' }))).rejects.toThrow('ENOENT');
    await expect(test.exporter.save(request({ format: 'pdf' }))).rejects.toThrow('ENOENT');

    expect(test.state.destroyed).toBe(2);
    expect(test.state.written).toEqual([]);
    expect(test.state.fontReads).toHaveLength(10);
  });

  it('writes nothing when the save dialog is dismissed', async () => {
    const test = harness({ savePath: null });

    expect(await test.exporter.save(request())).toEqual({ saved: false });
    expect(test.state.written).toEqual([]);
    expect(test.state.destroyed).toBe(1);
  });

  it('closes the window and reports the failure when the card cannot be rendered', async () => {
    const test = harness({ failOn: 'capture' });

    await expect(test.exporter.save(request())).rejects.toThrow('no surface');
    expect(test.state.destroyed).toBe(1);
    expect(test.state.written).toEqual([]);
  });

  it('recovers after a failed export instead of wedging its own queue', async () => {
    // One exporter, one queue: a fresh instance would prove nothing, since the
    // wedge this guards against is a rejected tail the *next* save chains onto.
    const test = harness();
    test.failNextLoad();

    const failure = test.exporter.save(request());
    const afterwards = test.exporter.save(request({ format: 'pdf' }));

    await expect(failure).rejects.toThrow('did-fail-load');
    expect(await afterwards).toEqual({ saved: true });
    expect(test.state.written).toHaveLength(1);
    expect(test.state.destroyed).toBe(2);
  });

  it('stops serving a document the moment its window has loaded, not when the render ends', async () => {
    const test = harness();

    await test.exporter.save(request());

    expect(test.state.documentAtLoad).not.toBeNull();
    // Measuring and capturing a long card takes seconds, and the window already
    // holds everything it needs; the document is not still on offer meanwhile.
    expect(test.state.documentAtMeasure).toBeNull();
    expect(test.exporter.document(`${MESSAGE_EXPORT_SCHEME}://sheet/token-1`)).toBeNull();
  });

  it.each([
    ['an unknown token', `${MESSAGE_EXPORT_SCHEME}://sheet/nope`],
    ['another host on the export scheme', `${MESSAGE_EXPORT_SCHEME}://elsewhere/token-1`],
    ['the renderer scheme', 'app://rallywithai/token-1'],
    ['a path that is not a URL at all', 'not a url'],
  ])('serves nothing for %s', (_label, url) => {
    const test = harness();

    expect(test.exporter.document(url)).toBeNull();
  });

  it('gives up rather than hanging when Chromium never finishes', async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      const stalled = new MessageExporter({
        ...test.dependencies,
        createWindow: () => ({
          load: () => new Promise<void>(() => undefined),
          evaluate: async () => 100,
          resize: () => undefined,
          captureJpeg: async () => new Uint8Array(),
          printPdf: async () => new Uint8Array(),
          destroy: () => undefined,
        }),
      });

      const save = stalled.save(request());
      const assertion = expect(save).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
