// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;
let fire: Callback = () => {};

beforeEach(() => {
  vi.resetModules();
  document.head.innerHTML = '';
  document.body.innerHTML = '<figure data-tech-schematic data-tech-src="/assets/technology-abc.js"></figure>';
  // Like the real observer, a disconnected one stops calling back.
  vi.stubGlobal('IntersectionObserver', class {
    private live = true;
    constructor(callback: Callback) { fire = (entries) => { if (this.live) callback(entries); }; }
    observe(): void {}
    disconnect(): void { this.live = false; }
  });
});

const moduleScripts = (): string[] =>
  Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[type="module"]'), (script) => script.getAttribute('src') ?? '');

describe('technology schematic loader', () => {
  it('loads nothing until the figure nears the screen', async () => {
    await import('../src/technology-loader');
    fire([{ isIntersecting: false }]);
    expect(moduleScripts()).toEqual([]);
  });

  it('adds the schematic entry once, when the figure nears the screen', async () => {
    await import('../src/technology-loader');
    fire([{ isIntersecting: true }]);
    fire([{ isIntersecting: true }]);
    expect(moduleScripts()).toEqual(['/assets/technology-abc.js']);
  });
});
