import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { artifactPresented, artifactPresentationScript } from './artifact-presentation';

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
