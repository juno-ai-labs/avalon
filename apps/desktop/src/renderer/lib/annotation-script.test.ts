// @vitest-environment jsdom
import { artifactAnnotationScript, artifactAnnotationScriptPath, artifactAnnotationScriptVersion } from '@rally/contracts';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The shared annotation script, evaluated inside a frame the way every host
 * loads it. Clicks are not trusted in jsdom, so the picker's pins and the
 * cards' clicks are covered in real windows; what runs here is the API's own
 * lifecycle and the bridge a parent talks to.
 */
type Api = {
  pick: () => Promise<unknown>;
  stopPicking: () => void;
  comments: (pins: unknown[], selected?: string | null) => Promise<unknown>;
  watchAnchor: (callback: (rect: { x: number; width: number }) => void) => void;
  restore: (locator: unknown, exact: string) => Promise<boolean>;
  rect: (css: string) => { width: number } | null;
};

function framed(html: string): { frame: HTMLIFrameElement; api: Api; received: unknown[] } {
  const received: unknown[] = [];
  window.addEventListener('message', (event) => { received.push(event.data); });
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const inner = frame.contentWindow!;
  inner.document.open();
  inner.document.write(`<!doctype html><html><head></head><body>${html}</body></html>`);
  inner.document.close();
  (inner as unknown as { eval: (code: string) => unknown }).eval(artifactAnnotationScript(null));
  return { frame, api: (inner as unknown as { rallyAnnotations: Api }).rallyAnnotations, received };
}

const tick = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };
/** jsdom's `postMessage` carries no `source`, and the bridge insists on its parent. */
function fromParent(frame: HTMLIFrameElement, data: unknown): void {
  // Built with the frame's own constructors: vitest's outer `window` is a
  // wrapper that is not identical to the frame's `parent`.
  const inner = frame.contentWindow as unknown as { MessageEvent: typeof MessageEvent; parent: Window; dispatchEvent: (event: Event) => boolean };
  inner.dispatchEvent(new inner.MessageEvent('message', { data, source: inner.parent, origin: window.location.origin }));
}

afterEach(() => { document.body.innerHTML = ''; });

describe('the shared annotation script', () => {
  it('installs one API per document and answers a rectangle for a selector', () => {
    const { frame, api } = framed('<p id="x">Hello</p>');
    (frame.contentWindow as unknown as { eval: (code: string) => unknown }).eval(artifactAnnotationScript(null));
    expect((frame.contentWindow as unknown as { rallyAnnotations: Api }).rallyAnnotations).toBe(api);
    expect(api.rect('p')).toMatchObject({ width: expect.any(Number), viewportWidth: expect.any(Number) });
    expect(api.rect('h1')).toBeNull();
    expect(api.rect('p[')).toBeNull();
  });

  it('resolves a waiting pick with null when picking stops', async () => {
    const { api } = framed('<p>Hello</p>');
    const pin = api.pick();
    api.stopPicking();
    await expect(pin).resolves.toBeNull();
  });

  it('answers no cards with null and resolves replaced cards with null', async () => {
    const { api } = framed('<p>Hello</p>');
    await expect(api.comments([])).resolves.toBeNull();
    const pins = [{ id: 'one', annotation: { target: { resourceId: 'r', version: 1, locator: { type: 'element', css: 'p', box: { x: 0, y: 0, w: 1, h: 1 }, visibleText: 'Hello' } }, content: { exact: '<p>Hello</p>', source: 'rendered', before: '', after: '', truncated: false }, comment: 'Shorter' } }];
    const first = api.comments(pins);
    await tick();
    void api.comments(pins);
    await expect(first).resolves.toBeNull();
  });

  it('outlines the element a card is about, and takes the outline away with the card', async () => {
    const { frame, api } = framed('<p>Hello</p>');
    const pins = [{ id: 'one', annotation: { target: { resourceId: 'r', version: 1, locator: { type: 'element', css: 'p', box: { x: 0, y: 0, w: 1, h: 1 }, visibleText: 'Hello' } }, content: { exact: '<p>Hello</p>', source: 'rendered', before: '', after: '', truncated: false }, comment: 'Shorter' } }];
    void api.comments(pins);
    await new Promise((resolve) => (frame.contentWindow as unknown as { requestAnimationFrame: (cb: () => void) => void }).requestAnimationFrame(() => resolve(undefined)));
    const drawn = [...frame.contentDocument!.querySelectorAll<HTMLElement>('[data-rally-picker]')];
    const outline = drawn.find((node) => node.style.pointerEvents === 'none');
    const card = drawn.find((node) => node.style.pointerEvents !== 'none');
    expect(outline?.style.position).toBe('fixed');
    expect(outline?.style.display).toBe('block');
    expect(card?.style.display).toBe('block');
    await api.comments([]);
    expect(frame.contentDocument!.querySelectorAll('[data-rally-picker]')).toHaveLength(0);
  });

  it('draws cards asked for before the document has parsed once it has', async () => {
    // The script runs from the head while the body still streams in, as the
    // artifact Worker injects it, and the host hears `ready` and answers at
    // once. jsdom parses a written document in one go, so the loading state
    // is staged by hand.
    const { frame, api } = framed('');
    const inner = frame.contentWindow as unknown as Window & { Event: typeof Event };
    // Past jsdom's own DOMContentLoaded for the written document first.
    await tick();
    Object.defineProperty(inner.document, 'readyState', { value: 'loading', configurable: true });
    const pins = [{ id: 'one', annotation: { target: { resourceId: 'r', version: 1, locator: { type: 'element', css: 'p', box: { x: 0, y: 0, w: 1, h: 1 }, visibleText: 'Hello' } }, content: { exact: '<p>Hello</p>', source: 'rendered', before: '', after: '', truncated: false }, comment: 'Shorter' } }];
    const clicked = api.comments(pins, 'p');
    await tick();
    expect(inner.document.querySelector('[data-rally-picker]')).toBeNull();
    inner.document.body.insertAdjacentHTML('beforeend', '<p>Hello</p>');
    Object.defineProperty(inner.document, 'readyState', { value: 'complete', configurable: true });
    inner.document.dispatchEvent(new inner.Event('DOMContentLoaded'));
    await tick();
    const drawn = [...inner.document.querySelectorAll<HTMLElement>('[data-rally-picker]')];
    // The selection, the card and its outline.
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    expect(drawn.some((node) => node.style.pointerEvents !== 'none')).toBe(true);
    await api.comments([]);
    await expect(clicked).resolves.toBeNull();
  });

  it('restores only the element whose markup still matches the saved quote', async () => {
    const { api } = framed('<p>Hello</p><p>World</p>');
    const locator = { type: 'element', css: 'p:nth-of-type(2)', box: { x: 0, y: 0, w: 1, h: 1 }, visibleText: 'World' };
    await expect(api.restore(locator, '<p>World</p>')).resolves.toBe(true);
    await expect(api.restore(locator, '<p>Changed</p>')).resolves.toBe(false);
  });

  it('announces itself to its parent and answers a restore over the bridge', async () => {
    const { frame, received } = framed('<p>Hello</p>');
    await tick();
    expect(received).toContainEqual({ type: 'rally-annotation-ready', pagePath: expect.any(String) });
    fromParent(frame, { type: 'rally-annotation-restore', locator: { type: 'element', css: 'p', box: { x: 0, y: 0, w: 1, h: 1 }, visibleText: 'Hello' }, exact: '<p>Hello</p>' });
    await tick(); await tick();
    expect(received).toContainEqual({ type: 'rally-annotation-restored', resolved: true });
  });

  it('ignores a message that is not from its parent', async () => {
    const { frame } = framed('<p>Hello</p>');
    await tick();
    const inner = frame.contentWindow as unknown as { MessageEvent: typeof MessageEvent; dispatchEvent: (event: Event) => boolean };
    inner.dispatchEvent(new inner.MessageEvent('message', { data: { type: 'rally-annotation-picking', on: true }, source: frame.contentWindow, origin: window.location.origin }));
    await tick();
    expect(frame.contentDocument!.querySelector('[data-rally-picker]')).toBeNull();
  });

  it('turns picking off over the bridge by resolving the page-side pick with null', async () => {
    const { frame, received } = framed('<p>Hello</p>');
    await tick();
    fromParent(frame, { type: 'rally-annotation-picking', on: true });
    await tick();
    expect(frame.contentDocument!.querySelector('[data-rally-picker]')).not.toBeNull();
    fromParent(frame, { type: 'rally-annotation-picking', on: false });
    await tick(); await tick();
    // The host turned it off, so no "Escape" pin is reported back to it.
    expect(received.filter((message) => (message as { type: string }).type === 'rally-artifact-pin')).toEqual([]);
    expect(frame.contentDocument!.querySelector('[data-rally-picker]')).toBeNull();
  });

  it('keeps the selection highlighted and reports where it is', async () => {
    const { frame, api } = framed('<p>Hello</p><p id="two">World</p>');
    const anchors: { x: number; width: number }[] = [];
    api.watchAnchor((rect) => anchors.push(rect));
    await api.comments([], 'p:nth-of-type(2)');
    await new Promise((resolve) => (frame.contentWindow as unknown as { requestAnimationFrame: (cb: () => void) => void }).requestAnimationFrame(() => resolve(undefined)));
    const highlight = frame.contentDocument!.querySelector('[data-rally-picker]') as HTMLElement | null;
    expect(highlight?.style.position).toBe('fixed');
    expect(anchors.length).toBeGreaterThan(0);
    await api.comments([], null);
    expect(frame.contentDocument!.querySelector('[data-rally-picker]')).toBeNull();
  });

  it('names its served path by content', () => {
    expect(artifactAnnotationScriptPath('https://app.example')).toBe(`/__rally/picker-${artifactAnnotationScriptVersion('https://app.example')}.js`);
    expect(artifactAnnotationScriptVersion('https://app.example')).not.toBe(artifactAnnotationScriptVersion('https://other.example'));
  });
});
