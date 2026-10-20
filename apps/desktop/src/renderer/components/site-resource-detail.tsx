import { isComposingKeyEvent } from '@rally/ui/lib/ime';
import { buildAnnotation, type ArtifactPickerPin } from '@rally/contracts';
import { AnnotationComment, useAnnotationDraft } from './artifact-annotations';
import { IconAlertCircle, IconCheck, IconCopy, IconDatabase, IconExternalLink, IconPointerCollaboration, IconWindowMaximize } from '@tabler/icons-react';
import React from 'react';
import { flushSync } from 'react-dom';
import type { DesktopSiteArtifactWindowRequest } from '../../common/desktop';

import type { DetailHeaderAction } from './detail-header-actions';
import { useCopy } from '../lib/use-copy';
import { useDetailHeaderActions } from './detail-header-actions';
import { CopyButton, CopyStatus, copyStateLabel } from './copy-button';
import { EmptyState, InsetSurface, SegmentedControl } from './primitives';

/**
 * The rail's detail for a **live artifact**: a published site Rally serves.
 *
 * It is the one resource detail whose body is not something the renderer drew.
 * The preview is an Electron view the *main process* composites over the
 * rectangle this component measures — the renderer never embeds, fetches, or
 * parses artifact content, because an iframe would graft remote model-authored
 * content into the application DOM as a navigable, postMessage-reachable child.
 *
 * So what this component actually does is: measure a rectangle, hand it over,
 * and get out of the way. Everything below the pane — the actions, the data,
 * the error log — is ordinary Rally UI reading ordinary authorized routes.
 *
 * See `docs/live-web-artifacts.md`.
 */

export interface SiteArtifactAccess {
  openUrl: string;
  canonicalUrl: string;
  artifactId: string;
  mode: 'static' | 'active';
  stateful: boolean;
}

export interface SiteArtifactTable {
  name: string;
  columns: { name: string; type: string }[];
  rowCount: number;
}

export interface SiteResourceDetailProps {
  editable?: boolean;
  resourceId: string;
  version: number;
  title: string;
  /**
   * Mints access. Called once per *navigation*, not once per artifact:
   * the code it returns is single-use, so every surface that navigates —
   * the preview, the pop-out window, the system browser — needs its own.
   */
  openArtifact: (resourceId: string) => Promise<SiteArtifactAccess>;
  describeData: (resourceId: string) => Promise<{ tables: SiteArtifactTable[] }>;
  loadTable: (resourceId: string, table: string) => Promise<{
    rows: Record<string, unknown>[];
    csv: string;
  }>;
  /** The desktop bridge. Absent where nothing can composite a view. */
  surface: {
    present: (request: {
      artifactId: string;
      url: string;
      bounds: { x: number; y: number; width: number; height: number };
      cornerRadius: number;
    }) => Promise<boolean>;
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
    /** A still of the live view as an image data URL. */
    snapshot: () => Promise<string | null>;
    pick?: (() => Promise<ArtifactPickerPin | null>) | undefined;
    stopPicking?: (() => Promise<void>) | undefined;
    close: () => Promise<void>;
    popOut: (request: DesktopSiteArtifactWindowRequest) => Promise<boolean>;
    copyText: (text: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    /**
     * Set by a browser host: preview in a sandboxed `<iframe>`
     * (`ARTIFACT_FRAME_SANDBOX`) instead of a composited view.
     */
    framed?: true;
  };
}

/**
 * What a framed artifact may do. It needs its own origin (`allow-same-origin`)
 * for its viewer cookie and storage, scripts, and forms; it gets no top
 * navigation, popups or downloads. The artifact host is a different
 * registrable domain and allows exactly the browser origin to frame it, so
 * `allow-same-origin` means the artifact's origin, never the app's. Widening
 * this is a security change: see `docs/live-web-artifacts.md`.
 */
const ARTIFACT_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

/** Resolves once `src` is decoded, so mounting it paints on the next frame. */
async function decoded(src: string): Promise<void> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    // An undecodable still is shown as-is; the hide must not wait on it.
  }
}

/** Resolves after the browser has painted the current DOM. */
async function nextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * How long a menu or dialog waits, under the view, for the still before the
 * view hides without one. The overlay is invisible and unclickable until the
 * hide goes out, so a slow or hung `capturePage` must not hold it. Past this,
 * the pane is blank under the overlay, as it was before stills existed.
 * Set by the team (2026-10-18): a normal capture, resize and encode is
 * roughly 20 to 80 ms, and 150 ms covers that with margin.
 */
const STILL_WAIT_MS = 150;

/** The still, or `null` once `STILL_WAIT_MS` passes without one. */
async function stillWithin(take: () => Promise<string | null>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), STILL_WAIT_MS); });
  try {
    return await Promise.race([take().catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The rectangle that collapses the composited view while keeping its page loaded. */
const HIDDEN = { x: 0, y: 0, width: 0, height: 0 };

export function SiteResourceDetail({
  editable = false,
  resourceId,
  version,
  title,
  openArtifact,
  describeData,
  loadTable,
  surface,
}: SiteResourceDetailProps): React.JSX.Element {
  const annotationDraft = useAnnotationDraft();
  const [picking, setPicking] = React.useState(false);
  const pickingRef = React.useRef(false);
  const [editingPin, setEditingPin] = React.useState<string | null>(null);
  const [commentAnchor,setCommentAnchor]=React.useState({x:12,y:60});
  const [pickError, setPickError] = React.useState<string | null>(null);
  const lastPin = React.useRef<string | undefined>(undefined);
  const paneRef = React.useRef<HTMLDivElement | null>(null);
  const initialAccessRef = React.useRef<{
    resourceId: string;
    version: number;
    openArtifact: SiteResourceDetailProps['openArtifact'];
    promise: Promise<SiteArtifactAccess>;
  } | null>(null);
  const previewAccessRef = React.useRef<SiteArtifactAccess | null>(null);
  const [loadedAccess, setLoadedAccess] = React.useState<{
    resourceId: string;
    value: SiteArtifactAccess;
  } | null>(null);
  // A prop switch renders before passive-effect cleanup can reset state. Never
  // let the previous resource's access participate in that intermediate render.
  const access = loadedAccess?.resourceId === resourceId ? loadedAccess.value : null;
  const [accessError, setAccessError] = React.useState<string | null>(null);
  /**
   * Tri-state on purpose: `null` means the view has not been asked for yet.
   *
   * A boolean cannot tell "not attempted" from "attempted and refused", so the
   * pane would render its unavailable state in the gap between access arriving
   * and the main process answering — a flash of a failure message on a page
   * that is about to work.
   */
  const [previewShown, setPreviewShown] = React.useState<boolean | null>(null);
  // The browser host's preview: the freshly minted URL, rendered as a frame.
  // Keyed by resource like `loadedAccess`: on a switch the new resource renders
  // before the old effect's cleanup runs, and must not show the old page.
  const [frame, setFrame] = React.useState<{ resourceId: string; url: string } | null>(null);
  const frameUrl = frame?.resourceId === resourceId ? frame.url : null;
  // The page as it looked when a menu or dialog opened over it.
  const [snapshot, setSnapshot] = React.useState<{
    src: string;
    /** Where the view was, relative to the pane: a clipped view is a slice of it. */
    placement: React.CSSProperties;
  } | null>(null);

  /**
   * A fresh open code, for one navigation.
   *
   * Minted per use because redemption clears the code in the same statement
   * that reads it: a second surface handed the same URL redeems nothing and
   * lands on Rally's neutral page instead of the site. The code also lives 60
   * seconds, so one held from mount is stale by the time somebody clicks.
   */
  const mintAccess = React.useCallback(
    async (): Promise<SiteArtifactAccess> => await openArtifact(resourceId),
    [openArtifact, resourceId],
  );

  // Once per artifact, for both the initial preview navigation and the metadata
  // the detail renders. Later navigations mint their own code because this
  // response's code is spent by the preview.
  React.useEffect(() => {
    let cancelled = false;
    previewAccessRef.current = null;
    setLoadedAccess(null);
    setAccessError(null);
    setPreviewShown(null);
    let request = initialAccessRef.current;
    if (request?.resourceId !== resourceId || request.version !== version
      || request.openArtifact !== openArtifact) {
      request = { resourceId, version, openArtifact, promise: openArtifact(resourceId) };
      initialAccessRef.current = request;
    }
    void request.promise
      .then((result) => {
        if (cancelled) return;
        previewAccessRef.current = result;
        setLoadedAccess({ resourceId, value: result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setAccessError(error instanceof Error ? error.message : 'Could not open this site.');
      });
    return () => { cancelled = true; };
  }, [openArtifact, resourceId, version]);

  const measure = React.useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const pane = paneRef.current;
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    const viewport = pane.closest('.rail-scroll')?.getBoundingClientRect();
    const left = Math.max(rect.left, viewport?.left ?? 0, 0);
    const top = Math.max(rect.top, viewport?.top ?? 0, 0);
    const right = Math.min(rect.right, viewport?.right ?? window.innerWidth, window.innerWidth);
    const bottom = Math.min(rect.bottom, viewport?.bottom ?? window.innerHeight, window.innerHeight);
    // Window-relative, because the main process composites over the window
    // rather than over this component's own coordinate space.
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(0, Math.round(right - left)),
      height: Math.max(0, Math.round(bottom - top)),
    };
  }, []);

  // The owning lightbox is allowed. Modal overlays always win; tooltips
  // only pause the live page when they actually cover its visible rectangle.
  const occluded = React.useCallback((): boolean => {
    const pane = paneRef.current;
    if (!pane) return false;
    return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"]')]
      .some((overlay) => {
        if (overlay.contains(pane)) return false;
        if (overlay.getAttribute('role') !== 'tooltip') return overlay.getAttribute('data-state') !== 'closed';
        // With an aria-label Radix puts the role on a hidden span. Measure
        // the positioned wrapper, and read open/closed off the content.
        if (overlay.closest('[data-state]')?.getAttribute('data-state') === 'closed') return false;
        const rect = (overlay.closest('[data-radix-popper-content-wrapper]') ?? overlay).getBoundingClientRect();
        const bounds = measure();
        return bounds !== null && rect.width > 0 && rect.height > 0
          && rect.left < bounds.x + bounds.width && rect.right > bounds.x
          && rect.top < bounds.y + bounds.height && rect.bottom > bounds.y;
      });
  }, [measure]);

  /**
   * The corner this pane draws, for the view that covers it.
   *
   * Read back off the element rather than stated twice: the stylesheet decides
   * whether this pane meets a rounded outside edge (the lightbox) or nothing
   * of the kind (the plain rail), and a number kept in the main process beside
   * it would be a second answer to that question, wrong on whichever host it
   * was not written for.
   */
  const paneCorner = React.useCallback((): number => {
    const pane = paneRef.current;
    if (!pane) return 0;
    const drawn = Number.parseFloat(window.getComputedStyle(pane).borderBottomLeftRadius);
    return Number.isFinite(drawn) ? drawn : 0;
  }, []);

  // Present when the artifact and its pane are both ready, and tear down when
  // the detail closes or the artifact changes — one live preview at a time.
  React.useEffect(() => {
    if (!access) return undefined;
    const bounds = measure();
    if (!bounds) return undefined;
    let cancelled = false;
    const initialNavigation = previewAccessRef.current === access;
    const navigation = initialNavigation ? Promise.resolve(access) : mintAccess();
    if (initialNavigation) previewAccessRef.current = null;
    void navigation
      .then(async (navigation) => {
        // Opening or minting can finish after a Channel switch has unmounted
        // this detail. Its cleanup has already closed the native view by then,
        // so presenting here would resurrect an ownerless old preview.
        if (cancelled) return false;
        // The frame reports itself shown from its own `load`, below: the
        // bootstrap it lands on first never fires one, so that is the site.
        if (surface.framed) {
          setFrame({ resourceId, url: navigation.openUrl });
          return null;
        }
        return await surface.present({
          artifactId: navigation.artifactId,
          url: navigation.openUrl,
          bounds: occluded() ? HIDDEN : measure() ?? bounds,
          cornerRadius: paneCorner(),
        });
      })
      .then((shown) => { if (!cancelled && shown !== null) setPreviewShown(shown); })
      // A refused mint or a main process that cannot composite both land here.
      // Without this the pane keeps its `null` state and renders an empty box
      // with no message and no way out.
      .catch(() => { if (!cancelled) setPreviewShown(false); });
    return () => {
      cancelled = true;
      setFrame(null);
      // The next presentation starts unshown, so leaving the data view puts
      // "Opening…" back rather than a frame still over its bootstrap.
      setPreviewShown(null);
      void surface.close();
    };
  }, [access, measure, mintAccess, occluded, paneCorner, resourceId, surface]);

  // Native content must remain clipped to its owning scroll viewport and
  // disappear behind nested DOM dialogs; Electron cannot infer either.
  React.useEffect(() => {
    // Nothing to track while the data view has the pane: the composited view is
    // already torn down, and this effect would go on re-querying the document
    // on every scroll and mutation to move something that is not there.
    //
    // Tracked from access onward, not from `previewShown`: the main process
    // holds the view hidden until the site's document is ready and then
    // reveals it at the last bounds it was sent. A dialog opened or a pane
    // moved during that load must already be reflected by then.
    if (!access || previewShown === false || surface.framed) return undefined;
    let disposed = false;
    let hidden = false;
    let capturing = false;
    const update = (): void => {
      const bounds = measure();
      if (!bounds || capturing) return;
      const covered = occluded();
      if (covered && !hidden) {
        // The still is taken before the view collapses, because a collapsed
        // view paints nothing to take. Updates in the meantime wait for it,
        // and the one it runs on finishing sees whatever is current then.
        capturing = true;
        const pane = paneRef.current?.getBoundingClientRect();
        const placement: React.CSSProperties = {
          left: bounds.x - (pane?.left ?? 0),
          top: bounds.y - (pane?.top ?? 0),
          width: bounds.width,
          height: bounds.height,
        };
        void stillWithin(surface.snapshot)
          .then(async (image) => {
            // On screen before the hide is sent, or the pane shows empty for
            // the frames between the view collapsing and React painting.
            if (image) await decoded(image);
            if (disposed) return;
            if (!occluded()) {
              // The overlay closed while the still was being taken: the view
              // never left, so there is nothing to stand in for.
              capturing = false;
              update();
              return;
            }
            flushSync(() => setSnapshot(image ? { src: image, placement } : null));
            await nextPaint();
            capturing = false;
            if (disposed) return;
            hidden = true;
            update();
          });
        return;
      }
      hidden = covered;
      void surface.setBounds(covered ? HIDDEN : bounds).then(() => {
        // Dropped only once the view is back over it, so the pane never shows
        // empty in between.
        if (!hidden && !disposed) setSnapshot(null);
      });
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = new ResizeObserver(update);
    if (paneRef.current) observer.observe(paneRef.current);
    // Floating UI positions the wrapper after mount; its style mutation must
    // recheck overlap even when the tooltip's own state has not changed.
    const overlays = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.attributeName !== 'style'
        || (mutation.target instanceof Element && mutation.target.matches('[data-radix-popper-content-wrapper]')))) update();
    });
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'role', 'style'] });
    update();
    return () => {
      disposed = true;
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer.disconnect();
      overlays.disconnect();
      setSnapshot(null);
    };
  }, [access, measure, occluded, previewShown, surface]);

  const acceptPin = React.useCallback(async (pin: ArtifactPickerPin): Promise<void> => {
    if (!annotationDraft || !pickingRef.current) return;
    let imageAttachmentId: string | undefined;
    if (!surface.framed && pin.screenshot?.startsWith('data:image/png;base64,') && annotationDraft.upload) {
      const binary = atob(pin.screenshot.slice('data:image/png;base64,'.length));
      const bytes = Uint8Array.from(binary,(character)=>character.charCodeAt(0));
      imageAttachmentId = await annotationDraft.upload(new File([bytes], `Site annotation — ${title}.png`, { type: 'image/png' }));
    }
    if (!pickingRef.current) return;
    const id = annotationDraft.add(buildAnnotation({ target: { resourceId, version, locator: { type: 'element', pagePath: pin.pagePath, css: pin.css, box: pin.box, visibleText: pin.visibleText } },
      content: { exact: pin.html, source: 'rendered', before: '', after: '', truncated: false, ...(imageAttachmentId ? { imageAttachmentId } : {}) }, comment: '' }), title, () => {if(!paneRef.current?.isConnected)return false;paneRef.current.scrollIntoView({block:'center'});setEditingPin(id);return true;}, pin.replace ? lastPin.current : undefined, true);
    const pane=paneRef.current?.getBoundingClientRect();
    if(pane)setCommentAnchor({x:Math.max(12,Math.min(pane.x+(pin.point?.x??12),window.innerWidth-320)),y:Math.max(12,Math.min(pane.y+(pin.point?.y??12)+12,window.innerHeight-190))});
    lastPin.current = id; setEditingPin(id);
  }, [annotationDraft, resourceId, title, version, surface.framed]);
  React.useEffect(()=>{
    if(!picking)return;
    const cancel=(event:KeyboardEvent):void=>{if(isComposingKeyEvent(event))return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setEditingPin(null);setPicking(false);}};
    window.addEventListener('keydown',cancel,true);return()=>window.removeEventListener('keydown',cancel,true);
  },[picking]);
  const acceptPinRef = React.useRef(acceptPin);
  acceptPinRef.current = acceptPin;
  React.useEffect(() => {
    pickingRef.current = picking;
    if (!picking) { void surface.stopPicking?.(); return; }
    let active = true;
    if (!surface.framed && surface.pick) {
      void (async () => {
        while (active) {
          const pin = await surface.pick!();
          if (!active) return;
          if (!pin) { setPicking(false); return; }
          await acceptPinRef.current(pin);
        }
      })().catch(() => { if (active) { setPicking(false); setPickError('The page could not be picked. Try again.'); } });
    }
    return () => { active = false; pickingRef.current = false; void surface.stopPicking?.(); };
  }, [picking, resourceId, version, surface]);

  // The canonical public link carries no access code or viewer identity.
  // Copying it shares the current site with anyone.
  const { copy, state: copyState } = useCopy({ copyText: surface.copyText, value: access?.canonicalUrl ?? '' });

  /*
   * Into the host's header, beside its own controls, rather than into a row of
   * this detail's own: chrome drawn over a page reads as the page's. Which way
   * their labels open is the host's call, since only it knows where its header
   * sits against the composited page below.
   */
  const headerActions = React.useMemo((): DetailHeaderAction[] => [
    ...(annotationDraft ? [{ key: 'comment-mode', className: 'annotation-mode-button', label: 'Comment mode', disabledReason: surface.framed ? 'Website comments require the Rally Mac app.' : undefined, icon: <IconPointerCollaboration aria-hidden="true" size={16} stroke={1.9} />, pressed: picking, disabled: Boolean(surface.framed) || previewShown !== true, onSelect: () => { if (!surface.framed) setPicking((value) => !value); } }] : []),
    ...(access?.stateful ? [{
      key: 'stored-data',
      label: 'Stored data',
      icon: <IconDatabase aria-hidden="true" size={16} stroke={1.9} />,
      menu: <section aria-label="Stored data" data-title-menu-autofocus="" tabIndex={-1}><SiteDataPanel describeData={describeData} loadTable={loadTable} resourceId={resourceId} surface={surface} /></section>,
      onSelect: () => undefined,
    }] : []),
    {
      key: 'new-window',
      label: 'Open in a new window',
      icon: <IconWindowMaximize aria-hidden="true" size={16} stroke={1.9} />,
      disabled: !access,
      onSelect: () => {
        if (!access) return;
        void mintAccess().then(
          async (navigation) => await surface.popOut({
            kind: 'site',
            editable,
            resourceId,
            version,
            canonicalUrl: navigation.canonicalUrl,
            mode: navigation.mode,
            stateful: navigation.stateful,
            artifactId: navigation.artifactId,
            url: navigation.openUrl,
            title,
          }),
        );
      },
    },
    {
      key: 'copy-link',
      label: copyStateLabel(copyState, 'Copy public link'),
      // The header's own set (Tabler), not `CopyButton`'s, so it matches its neighbours.
      icon: copyState === 'copied'
        ? <IconCheck aria-hidden="true" size={16} stroke={1.9} />
        : copyState === 'failed'
          ? <IconAlertCircle aria-hidden="true" size={16} stroke={1.9} />
          : <IconCopy aria-hidden="true" size={16} stroke={1.9} />,
      disabled: !access,
      onSelect: () => void copy(),
    },
    {
      key: 'open-browser',
      label: 'Open in browser',
      icon: <IconExternalLink aria-hidden="true" size={16} stroke={1.9} />,
      disabled: !access,
      onSelect: () => void mintAccess().then(
        async (navigation) => await surface.openExternal(navigation.openUrl),
      ),
    },
  ], [access, copy, copyState, mintAccess, resourceId, surface, title, version, annotationDraft, picking, previewShown, describeData, loadTable, editable]);
  const orderedHeaderActions = React.useMemo(() => [...headerActions.filter((action) => action.key !== 'comment-mode'), ...headerActions.filter((action) => action.key === 'comment-mode')], [headerActions]);
  useDetailHeaderActions(orderedHeaderActions);

  const editingSelection = annotationDraft?.selections.find((p) => p.id === editingPin);
  return (
    <div className="site-detail">
      <CopyStatus state={copyState} visible />
      {pickError && <p role="alert">{pickError}</p>}

          <div className="site-detail-pane" data-testid="site-preview-pane" ref={paneRef}>
            {accessError && <EmptyState description={accessError} title="This site could not be opened" />}
            {!accessError && previewShown === null && <p className="site-detail-status">Opening…</p>}
            {/*
              Nothing is rendered *into* the pane when the preview is live: the
              composited view covers it. The exceptions are the still shown
              while an overlay hides that view, and the placeholder a person
              sees where no view can be composited — a browser build, or a
              refused URL.
            */}
            {frameUrl && surface.framed && (
              <iframe
                className="site-detail-frame"
                data-loading={previewShown === true ? undefined : ''}
                onLoad={() => setPreviewShown(true)}
                sandbox={ARTIFACT_FRAME_SANDBOX}
                src={frameUrl}
                title={title}
                referrerPolicy="no-referrer"
              />
            )}
            {snapshot && <img alt="" className="site-detail-snapshot" src={snapshot.src} style={snapshot.placement} />}
            {access && previewShown === false && (
              <EmptyState
                description="Open it in your browser to see the live page."
                title="Preview unavailable here"
              />
            )}
          </div>
      {editingSelection && <AnnotationComment pin={editingSelection} label="Comment on site selection" style={{left:commentAnchor.x,top:commentAnchor.y}} onClose={() => setEditingPin(null)} onEscape={() => setPicking(false)} />}
    </div>
  );
}

/** The rows a stateful site has collected, browsable and exportable. */
function SiteDataPanel({
  describeData,
  loadTable,
  resourceId,
  surface,
}: Pick<SiteResourceDetailProps, 'describeData' | 'loadTable' | 'resourceId' | 'surface'>): React.JSX.Element {
  const [tables, setTables] = React.useState<SiteArtifactTable[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Record<string, unknown>[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void describeData(resourceId)
      .then((result) => {
        if (cancelled) return;
        setTables(result.tables);
        setSelected(result.tables[0]?.name ?? null);
      })
      .catch(() => { if (!cancelled) setError('Could not read this site’s data.'); });
    return () => { cancelled = true; };
  }, [describeData, resourceId]);

  React.useEffect(() => {
    if (!selected) return undefined;
    let cancelled = false;
    void loadTable(resourceId, selected)
      .then((page) => { if (!cancelled) setRows(page.rows); })
      .catch(() => { if (!cancelled) setError('Could not read that table.'); });
    return () => { cancelled = true; };
  }, [loadTable, resourceId, selected]);

  if (error) return <EmptyState description={error} title="Data unavailable" />;
  if (!tables) return <p className="site-detail-status">Reading…</p>;
  if (tables.length === 0) {
    return <EmptyState description="Nothing has been submitted yet." title="No data yet" />;
  }

  const columns = tables.find((table) => table.name === selected)?.columns ?? [];
  return (
    <div className="site-data">
      <div className="site-data-toolbar">
        <SegmentedControl
          ariaLabel="Which stored table to show"
          onChange={setSelected}
          options={tables.map((table) => ({
            value: table.name,
            label: table.name,
            // The count is what a person picks a table by, and the control takes
            // plain text labels, so it rides along as the segment's own tooltip.
            title: `${table.rowCount} rows`,
          }))}
          value={selected ?? ''}
        />
        <CopyButton
          copyText={surface.copyText}
          disabled={!selected}
          label="Copy as CSV"
          value={() => loadTable(resourceId, selected ?? '').then(({ csv }) => csv)}
        />
      </div>
      <InsetSurface className="site-data-scroll">
        <table>
          <thead>
            <tr>{columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // The index is the right key here rather than a lazy one: a
              // model-designed schema has no column guaranteed unique, and a
              // page is replaced wholesale rather than reordered or spliced, so
              // position *is* this row's identity within it.
              <tr key={`row-${index}`}>
                {columns.map((column) => (
                  // Rendered as text, never as markup: these values were
                  // written by the page's visitors.
                  <td key={column.name}>{formatCell(row[column.name])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </InsetSurface>
    </div>
  );
}

/**
 * One stored value as a cell.
 *
 * Everything becomes a string, because a model-designed column can hold
 * anything and React would render an object as `[object Object]` while a
 * `null` would render as nothing at all — which reads as an empty value rather
 * than as an absent one.
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
