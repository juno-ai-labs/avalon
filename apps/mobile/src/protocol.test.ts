import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MobileCommandSchema, MobileSnapshotSchema, mobileContentReady, type MobileSnapshot, artifactAuthHandoff, artifactLoadFailure, artifactPreparationNavigation, commandScript, isAppUrl, MOBILE_CHANNEL, mobileUrl, movePin, parseMobileEvent, trustedArtifact, webBuildFromHtml } from './protocol';

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


describe('artifact cookie preparation', () => {
  const canonicalUrl = 'https://site.rallyusercontent.com';
  it('allows only the bootstrap and redemption, stopping before artifact code or other origins', () => {
    expect(artifactPreparationNavigation(canonicalUrl, 'https://site.rallyusercontent.com/__rally/open#one')).toBe('allow');
    expect(artifactPreparationNavigation(canonicalUrl, 'https://site.rallyusercontent.com/__rally/redeem')).toBe('allow');
    expect(artifactPreparationNavigation(canonicalUrl, 'https://site.rallyusercontent.com/')).toBe('ready');
    expect(artifactPreparationNavigation(canonicalUrl, 'https://site.rallyusercontent.com/app.js')).toBe('block');
    expect(artifactPreparationNavigation(canonicalUrl, 'https://other.rallyusercontent.com/__rally/open')).toBe('block');
    expect(artifactPreparationNavigation(canonicalUrl, 'not a URL')).toBe('block');
  });
  it('renews rejected cookies once, without retrying access failures or subresource errors', () => {
    const access = { canonicalUrl, openUrl: canonicalUrl };
    expect(artifactLoadFailure(access, canonicalUrl + '/', 403)).toBe('renew');
    expect(artifactLoadFailure(access, canonicalUrl + '/', 401)).toBe('renew');
    expect(artifactLoadFailure(access, canonicalUrl + '/', 503)).toBe('fail');
    expect(artifactLoadFailure(access, canonicalUrl + '/image.png', 403)).toBe('ignore');
    expect(artifactLoadFailure(access, canonicalUrl + '/', 200)).toBe('ignore');
    expect(artifactLoadFailure({ ...access, openUrl: canonicalUrl + '/__rally/open#fresh' }, canonicalUrl + '/__rally/redeem', 403)).toBe('fail');
    expect(artifactLoadFailure({ ...access, openUrl: canonicalUrl + '/__rally/open#fresh' }, canonicalUrl + '/', 403)).toBe('fail');
  });
});


it('reveals usable content rather than bridge bootstrap, including legacy hosts and failure screens', () => {
  expect(mobileContentReady({ type: 'ready', waitForContent: true })).toBe(false);
  expect(mobileContentReady({ type: 'ready' })).toBe(true);
  expect(mobileContentReady({ type: 'screen-ready' })).toBe(true);
  expect(mobileContentReady({ type: 'signed-out' })).toBe(true);
  const snapshot = { loading: true, directoryError: false } as MobileSnapshot;
  expect(mobileContentReady({ type: 'snapshot', snapshot })).toBe(false);
  expect(mobileContentReady({ type: 'snapshot', snapshot: { ...snapshot, loading: false } })).toBe(true);
  expect(mobileContentReady({ type: 'snapshot', snapshot: { ...snapshot, directoryError: true } })).toBe(true);
});


it('recognizes only the trusted authentication handoff for the current artifact', () => {
  const canonical = 'https://level-luminous-sequential-schrodinger-g.rallyusercontent.com/';
  const app = 'https://app.rallywith.ai';
  const path = '/app/sites/global/level-luminous-sequential-schrodinger/%2F';
  expect(artifactAuthHandoff(canonical, app + path, app)).toBe(true);
  for (const target of ['https://evil.example' + path, app + '/app/sites/global/level-luminous-sequential-curie/%2F', app + '/', 'https://attacker@app.rallywith.ai' + path, 'not a url']) {
    expect(artifactAuthHandoff(canonical, target, app)).toBe(false);
  }
});

it('names a web build by the entry script its HTML loads', () => {
  const html = '<html><head><link rel="manifest" href="/manifest.webmanifest">  <script type="module" crossorigin src="/assets/index-C7nZHIE4.js"></script><link rel="stylesheet" href="/assets/index-D1.css"></head></html>';
  expect(webBuildFromHtml(html)).toBe('/assets/index-C7nZHIE4.js');
  expect(webBuildFromHtml('<html><script src="/assets/legacy.js"></script></html>')).toBeNull();
  expect(webBuildFromHtml('Rally is temporarily unavailable')).toBeNull();
});

describe('Canvases shared from other Organizations', () => {
  const base = {
    userId: 'u1', userName: 'Ada', workspaceId: 'w1', workspaceName: 'Labs', workspacePath: '/app/workspaces/global/w1',
    canvases: [], pins: [], hasMore: false, loading: false, pinBusy: false, pinError: null, directoryError: false,
    canvasId: null, tabId: null, view: 'home', title: 'Your canvases', artifactId: null, artifactPicker: false,
  };
  const event = (snapshot: object) => parseMobileEvent(JSON.stringify({ channel: MOBILE_CHANNEL, token, event: { type: 'snapshot', snapshot } }), app, app, token);
  it('reads a snapshot from a host that sends none as having none', () => {
    const parsed = event(base);
    expect(parsed?.type === 'snapshot' && parsed.snapshot.sharedElsewhere).toEqual([]);
  });
  it('keeps the Organization each one comes from', () => {
    const shared = { id: 'c9', title: 'Partner roadmap', updatedAt: '2026-11-15T10:00:00.000Z', organization: { id: 'w2', name: 'Acme', region: 'enterprise' } };
    const parsed = event({ ...base, sharedElsewhere: [shared] });
    expect(parsed?.type === 'snapshot' && parsed.snapshot.sharedElsewhere).toEqual([shared]);
    expect(event({ ...base, sharedElsewhere: [{ ...shared, organization: undefined }] })).toBeNull();
  });
  it('accepts a link to open outside only as an http(s) URL', () => {
    const external = (url: string) => parseMobileEvent(JSON.stringify({ channel: MOBILE_CHANNEL, token, event: { type: 'open-external', url } }), app, app, token);
    expect(external('https://checkout.stripe.com/c/pay/cs_test')).toEqual({ type: 'open-external', url: 'https://checkout.stripe.com/c/pay/cs_test' });
    expect(external('javascript:alert(1)')).toBeNull();
  });
  it('keeps the settings pages it knows when a newer host lists one it does not', () => {
    const parsed = event({ ...base, settingsSections: ['account', 'a-page-from-a-later-host', 'members'] });
    expect(parsed?.type === 'snapshot' && parsed.snapshot.settingsSections).toEqual(['account', 'members']);
  });
  it('accepts an open in another Organization only when it names the Organization and the Canvas', () => {
    expect(MobileCommandSchema.safeParse({ type: 'open-elsewhere', region: 'enterprise', workspaceId: 'w2', canvasId: 'c9' }).success).toBe(true);
    expect(MobileCommandSchema.safeParse({ type: 'open-elsewhere', region: 'enterprise', canvasId: 'c9' }).success).toBe(false);
  });
});

describe('the sidebar Google offer', () => {
  const snapshot = {
    userId: 'u', userName: 'Person', workspaceId: 'w', workspaceName: 'Team', workspacePath: '/app/workspaces/global/w',
    canvases: [], pins: [], hasMore: false, loading: false, pinBusy: false, pinError: null, canvasId: null, tabId: null,
    view: 'home', title: 'Your canvases', artifactId: null, artifactPicker: false,
  };
  it('reads the offered product and whether a sign-in holds it', () => {
    expect(MobileSnapshotSchema.parse({ ...snapshot, googleConnect: { product: 'google-drive', busy: true, pending: true } }).googleConnect)
      .toEqual({ product: 'google-drive', busy: true, pending: true });
    // An older page sends no `pending`: busy for another reason, so nothing is loading.
    expect(MobileSnapshotSchema.parse({ ...snapshot, googleConnect: { product: 'google-drive', busy: true } }).googleConnect)
      .toEqual({ product: 'google-drive', busy: true, pending: false });
    expect(MobileSnapshotSchema.parse({ ...snapshot, googleConnect: null }).googleConnect).toBeNull();
  });
  it('draws nothing for an older page that sends no offer', () => {
    expect(MobileSnapshotSchema.parse(snapshot).googleConnect).toBeUndefined();
  });
  it('reads a product a newer page offers but this shell does not know as nothing to offer, keeping the snapshot', () => {
    const parsed = MobileSnapshotSchema.parse({ ...snapshot, googleConnect: { product: 'google-photos', busy: false } });
    expect(parsed.googleConnect).toBeNull();
    expect(parsed.title).toBe('Your canvases');
  });
});
