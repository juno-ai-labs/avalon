import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { commandScript, isAppUrl, MOBILE_CHANNEL, mobileUrl, movePin, parseMobileEvent, trustedArtifact } from './protocol';

const app = 'https://app.rallywith.ai';
const token = 'main-frame-capability';
const ready = JSON.stringify({ channel: MOBILE_CHANNEL, token, event: { type: 'ready' } });

describe('native web-view boundary', () => {
  it('accepts an event from the application with the main-frame token', () => {
    expect(parseMobileEvent(ready, `${app}/app/workspaces/global/workspace-a`, app, token)).toEqual({ type: 'ready' });
  });
  it('rejects an artifact origin, a resource document, and a guessed token', () => {
    expect(parseMobileEvent(ready, 'https://artifact.rallyusercontent.com/', app, token)).toBeNull();
    expect(parseMobileEvent(ready, `${app}/regional/global/browser/api/w/resources/r/content`, app, token)).toBeNull();
    expect(parseMobileEvent(ready, `${app}/`, app, 'different-view-token')).toBeNull();
    expect(isAppUrl('https://app.rallywith.ai.evil.example/', app)).toBe(false);
    expect(isAppUrl('https://attacker@app.rallywith.ai/', app)).toBe(false);
  });
  it('rejects malformed messages without breaking the native shell', () => {
    expect(parseMobileEvent('not json', app, app, token)).toBeNull();
    expect(parseMobileEvent(JSON.stringify({ channel: MOBILE_CHANNEL, token, event: { type: 'snapshot', snapshot: {} } }), app, app, token)).toBeNull();
  });
  it('passes commands as data even when a canvas ID contains script syntax', () => {
    let delivered: unknown;
    class CustomEvent {
      constructor(public type: string, public options: { detail: unknown }) {}
    }
    runInNewContext(commandScript({ type: 'open', id: '"); throw Error("injection"); //', pinned: false }), {
      CustomEvent,
      window: { dispatchEvent: (event: CustomEvent) => { delivered = { type: event.type, detail: event.options.detail }; } },
    });
    expect(delivered).toEqual({ type: 'rally:mobile-command', detail: { type: 'open', id: '"); throw Error("injection"); //', pinned: false } });
  });
  it('opens a conversation on the browser host without putting a credential in its URL', () => {
    expect(mobileUrl(app, '/app/workspaces/global/workspace-a', 'canvas/one')).toBe('https://app.rallywith.ai/app/workspaces/global/workspace-a?mobile=1#/canvases/canvas%2Fone?view=chat');
  });
  it('delivers a sign-in proof only while the WebView still holds the application document', () => {
    const proof = { ticket: 'abcdefghijklmnopqrst', region: 'global', attemptId: 'a'.repeat(43), codeVerifier: 'v'.repeat(43) };
    for (const [url, accepted] of [[`${app}/?mobile=1`, true], [`${app}/app/workspaces/global/example`, true], [`${app}/regional/global/browser/api/w/resources/r/content`, false], ['https://example.rallyusercontent.com/', false]] as const) {
      const events: unknown[] = [];
      class CustomEvent { constructor(public type: string, public options: { detail: unknown }) {} }
      runInNewContext(commandScript({ type: 'sign-in-complete', proof }, app), {
        location: new URL(url), CustomEvent,
        window: { dispatchEvent: (event: CustomEvent) => events.push(event.options.detail) },
      });
      expect(events).toEqual(accepted ? [{ type: 'sign-in-complete', proof }] : []);
    }
  });
});

describe('pin ordering', () => {
  it('moves a pin in either direction without changing the input or losing other desktop pins', () => {
    const pins = ['trip', 'garden', 'week', 'reading', 'recipes'];
    expect(movePin(pins, 4, 0)).toEqual(['recipes', 'trip', 'garden', 'week', 'reading']);
    expect(movePin(pins, 0, 3)).toEqual(['garden', 'week', 'reading', 'trip', 'recipes']);
    expect(pins).toEqual(['trip', 'garden', 'week', 'reading', 'recipes']);
  });
  it('ignores out-of-bounds accessibility moves instead of deleting a pin', () => {
    expect(movePin(['trip', 'garden'], 0, -1)).toEqual(['trip', 'garden']);
    expect(movePin(['trip', 'garden'], 1, 2)).toEqual(['trip', 'garden']);
    expect(movePin([], 0, 1)).toEqual([]);
  });
});


describe('native artifact isolation', () => {
  const access = { canvasId: 'canvas', resourceId: 'resource', version: 1, openUrl: 'https://example.rallyusercontent.com/_open?ticket=opaque', canonicalUrl: 'https://example.rallyusercontent.com/' };
  it('accepts only the configured artifact host and keeps both URLs on the same origin', () => {
    expect(trustedArtifact(access, 'rallyusercontent.com')).toBe(true);
    for (const openUrl of ['https://app.rallywith.ai/', 'https://nested.example.rallyusercontent.com/', 'https://example.rallyusercontent.com.evil.example/', 'https://user@example.rallyusercontent.com/', 'http://example.rallyusercontent.com/']) {
      expect(trustedArtifact({ ...access, openUrl }, 'rallyusercontent.com')).toBe(false);
    }
    expect(trustedArtifact({ ...access, canonicalUrl: 'https://another.rallyusercontent.com/' }, 'rallyusercontent.com')).toBe(false);
  });
  it('allows HTTP only for an explicitly configured local artifact domain', () => {
    const local = { ...access, openUrl: 'http://example.rallyusercontent.localhost:8789/_open', canonicalUrl: 'http://example.rallyusercontent.localhost:8789/' };
    expect(trustedArtifact(local, 'rallyusercontent.localhost')).toBe(true);
    expect(trustedArtifact(local, 'rallyusercontent.com')).toBe(false);
  });
});
