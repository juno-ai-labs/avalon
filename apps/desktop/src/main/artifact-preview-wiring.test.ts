import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The per-window preview registry lives in `index.ts` around real Electron
 * objects, so the controller's own suite cannot observe it: nothing there can
 * see `artifactPreviews`, and nothing can count a window's `closed` listeners.
 * These assertions read the wiring instead, which is what the main process's
 * other wiring tests do for the same reason.
 */
describe('artifact preview wiring', () => {
  const source = (): string => readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');

  it('keeps one controller per window, and so one `closed` listener', () => {
    const handler = source().match(
      /ipcMain\.handle\('artifact:close-preview',[\s\S]*?\n {2}\}\);/u,
    )?.[0];

    expect(handler).toBeDefined();
    expect(handler).toContain('artifactPreviews.get(window)?.destroy()');
    // `artifactPreviewFor` registers the window's one `closed` listener when it
    // builds a controller, so dropping the entry here would make the next
    // presentation build a second controller and add a second listener. The
    // controller is reusable after `destroy()`, so there is nothing to drop.
    expect(handler).not.toContain('artifactPreviews.delete');
  });

  it('confines both artifact surfaces with a handoff built from their own contents', () => {
    // Activation is per surface. A handoff shared between the rail preview and
    // a pop-out would let a press in one send the other's page to the browser,
    // and those two are showing different documents.
    const text = source();

    expect(text).toContain(
      'confineToArtifactOrigin(contents, new URL(request.url).origin, artifactLinkHandoff(contents))',
    );
    expect(text).toContain(
      'confineToArtifactOrigin(window.webContents, new URL(request.url).origin, artifactLinkHandoff(window.webContents))',
    );
    // The activation can only be reconstructed from the surface's own input
    // stream; nothing else in this process is told when a person presses
    // something inside model-authored content.
    expect(text).toContain("contents.on('input-event', (_event, input) => activation.record(input.type))");
  });

  it('removes the entry only when the window that owns it closes', () => {
    const factory = source().match(/function artifactPreviewFor\([\s\S]*?\n\}/u)?.[0];

    expect(factory).toBeDefined();
    expect(factory).toContain("window.once('closed'");
    expect(factory).toContain('artifactPreviews.delete(window)');
    // The adapter reports lifecycle rather than assuming it; the controller
    // decides what may still be touched.
    expect(factory).toContain('destroyed: () => window.isDestroyed()');
    expect(factory).toContain('destroyed: () => contents.isDestroyed()');
  });
});
