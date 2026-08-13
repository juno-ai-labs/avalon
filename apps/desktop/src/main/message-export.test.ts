import { describe, expect, it, vi } from 'vitest';
import type { MessageExportRequest } from '../common/message-export';
import {
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
  failOn?: 'load' | 'capture';
} = {}) {
  const state = {
    loaded: [] as string[],
    captures: [] as number[],
    prints: [] as MessageExportPrintOptions[],
    resizes: [] as Array<{ width: number; height: number; zoom: number }>,
    destroyed: 0,
    written: [] as Array<{ path: string; bytes: Uint8Array }>,
    documentAtLoad: null as string | null,
  };
  let openWindows = 0;
  let token = 0;

  const dependencies: MessageExportDependencies = {
    createWindow: () => {
      openWindows += 1;
      // Two export windows alive at once would mean the queue stopped serializing.
      expect(openWindows).toBe(1);
      const window: MessageExportWindow = {
        load: async (url) => {
          state.loaded.push(url);
          // What the window can actually read is what the protocol would serve.
          state.documentAtLoad = exporter.document(url);
          if (options.failOn === 'load') throw new Error('did-fail-load');
        },
        evaluate: async () => options.measuredHeight ?? 1_400,
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
    logWarning: () => undefined,
    randomToken: () => `token-${++token}`,
    now: () => 1_700_000_000_000,
    delay: async () => undefined,
  };
  const exporter = new MessageExporter(dependencies);
  return { dependencies, exporter, state };
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
  ])('rejects %s', (_label, overrides) => {
    expect(() => parseMessageExportRequest(request(overrides))).toThrow('Invalid message export request');
  });
});

describe('the exported document', () => {
  it('renders the message inside the card, signed, for a picture', () => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>Hello</p>', logoDataUrl: LOGO });

    expect(html).toContain('<div class="markdown-body"><p>Hello</p></div>');
    expect(html).toContain('Saved from Avalon');
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
    expect(messageExportFooter(LOGO)).toContain('Saved from Avalon');
  });

  it('hides the code block copy button, which is a control rather than content', () => {
    const html = messageExportDocument({ format: 'image', contentHtml: '<p>x</p>', logoDataUrl: LOGO });

    expect(html).toContain('.markdown-code-block > button { display: none; }');
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
    expect(test.state.prints[0]?.footerHtml).toContain('Saved from Avalon');
    expect(test.state.prints[0]?.margins.bottom).toBeGreaterThan(test.state.prints[0]!.margins.top);
    expect(test.state.written[0]?.path).toBe('/home/ada/Downloads/pipeline-2026-08-13.pdf');
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

  it('recovers after a failed export instead of wedging the queue', async () => {
    const failing = harness({ failOn: 'load' });
    await expect(failing.exporter.save(request())).rejects.toThrow('did-fail-load');

    const test = harness();
    await Promise.all([test.exporter.save(request()), test.exporter.save(request({ format: 'pdf' }))]);

    expect(test.state.written).toHaveLength(2);
    expect(test.state.destroyed).toBe(2);
  });

  it('stops serving a document once its window has loaded', async () => {
    const test = harness();

    await test.exporter.save(request());

    expect(test.state.documentAtLoad).not.toBeNull();
    expect(test.exporter.document(`${MESSAGE_EXPORT_SCHEME}://sheet/token-1`)).toBeNull();
  });

  it.each([
    ['an unknown token', `${MESSAGE_EXPORT_SCHEME}://sheet/nope`],
    ['another host on the export scheme', `${MESSAGE_EXPORT_SCHEME}://elsewhere/token-1`],
    ['the renderer scheme', 'app://avalon/token-1'],
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
