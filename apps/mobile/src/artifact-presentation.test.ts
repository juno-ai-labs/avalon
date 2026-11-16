import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { artifactBackground, artifactPresented, artifactPresentationScript, statusBarStyleFor } from './artifact-presentation';

it('applies the inset at DOM readiness and reveals after painting without waiting for load', () => {
  const listeners = new Map<string, () => void>();
  const attributes = new Map<string, string>();
  const frames: Array<() => void> = [];
  const messages: string[] = [];
  const body = { hasAttribute: (key: string) => attributes.has(key), getAttribute: (key: string) => attributes.get(key), setAttribute: (key: string, value: string) => attributes.set(key, value), style: { paddingTop: '8px' } };
  const environment = {
    document: { readyState: 'loading', body, documentElement: { style: { setProperty: () => undefined } }, addEventListener: (type: string, receive: () => void) => listeners.set(type, receive) },
    location: { pathname: '/' }, getComputedStyle: () => ({ paddingTop: body.style.paddingTop }),
    requestAnimationFrame: (frame: () => void) => frames.push(frame),
    window: { ReactNativeWebView: { postMessage: (message: string) => messages.push(message) } },
  };
  runInNewContext(artifactPresentationScript(64), environment);
  expect(messages).toEqual([]);
  listeners.get('DOMContentLoaded')!();
  expect(body.style.paddingTop).toBe('72px');
  expect(messages).toEqual([]);
  while (frames.length) frames.shift()!();
  expect(artifactPresented(messages[0]!, 'https://site.example/', 'https://site.example/')).toBe(true);
  environment.document.readyState = 'complete';
  runInNewContext(artifactPresentationScript(80), environment);
  expect(body.style.paddingTop).toBe('88px');
  expect(artifactPresented('open-chat', 'https://site.example/', 'https://site.example/')).toBe(false);
  expect(artifactPresented(messages[0]!, 'https://other.example/', 'https://site.example/')).toBe(false);
  expect(artifactPresented(messages[0]!, 'https://site.example/__rally/open', 'https://site.example/')).toBe(false);
  listeners.clear(); environment.location.pathname = '/__rally/open';
  environment.document.readyState = 'loading';
  runInNewContext(artifactPresentationScript(64), environment);
  expect(listeners.size).toBe(0);
});

it('reports the page background after presenting, and picks status bar text that reads over it', () => {
  const frames: Array<() => void> = [];
  const messages: string[] = [];
  const environment = {
    document: { readyState: 'complete', body: { hasAttribute: () => true, getAttribute: () => '0', setAttribute: () => undefined, style: { paddingTop: '0px' } }, documentElement: { style: { setProperty: () => undefined } }, addEventListener: () => undefined },
    location: { pathname: '/' },
    getComputedStyle: (element: { style: unknown }) => ({ paddingTop: '0px', backgroundColor: element === environment.document.documentElement ? 'rgb(13, 17, 23)' : 'rgba(0, 0, 0, 0)' }),
    requestAnimationFrame: (frame: () => void) => frames.push(frame),
    window: { ReactNativeWebView: { postMessage: (message: string) => messages.push(message) } },
  };
  runInNewContext(artifactPresentationScript(64), environment);
  while (frames.length) frames.shift()!();
  const background = artifactBackground(messages[1]!, 'https://site.example/', 'https://site.example/');
  expect(background).toBe('rgb(13, 17, 23)');
  expect(statusBarStyleFor(background!)).toBe('light');
  expect(statusBarStyleFor('rgb(250, 250, 250)')).toBe('dark');
  expect(artifactBackground(messages[1]!, 'https://other.example/', 'https://site.example/')).toBeNull();
  expect(artifactBackground('rally:artifact-background url(evil)', 'https://site.example/', 'https://site.example/')).toBeNull();
});

it('reads the background from the element under the status bar when body and html are transparent', () => {
  const frames: Array<() => void> = [];
  const messages: string[] = [];
  const body = { hasAttribute: () => true, getAttribute: () => '0', setAttribute: () => undefined, style: { paddingTop: '0px' }, parentElement: null };
  const wrapper = { parentElement: body, style: {} };
  const environment = {
    innerWidth: 390,
    document: { readyState: 'complete', body, documentElement: { style: { setProperty: () => undefined } }, addEventListener: () => undefined,
      elementFromPoint: (x: number, y: number) => x === 195 && y === 1 ? wrapper : null },
    location: { pathname: '/' },
    getComputedStyle: (element: unknown) => ({ paddingTop: '0px', backgroundColor: element === wrapper ? 'rgb(15, 23, 42)' : 'rgba(0, 0, 0, 0)' }),
    requestAnimationFrame: (frame: () => void) => frames.push(frame),
    window: { ReactNativeWebView: { postMessage: (message: string) => messages.push(message) } },
  };
  runInNewContext(artifactPresentationScript(64), environment);
  while (frames.length) frames.shift()!();
  expect(artifactBackground(messages[1]!, 'https://site.example/', 'https://site.example/')).toBe('rgb(15, 23, 42)');
});
