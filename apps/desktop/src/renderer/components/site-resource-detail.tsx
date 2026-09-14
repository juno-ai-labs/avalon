import { Database, ExternalLink, Maximize2 } from 'lucide-react';
import React from 'react';

import { DetailHeaderActions } from './detail-header-actions';
import { CopyButton } from './copy-button';
import { EmptyState, IconButton, InsetSurface, SegmentedControl } from './primitives';

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
  resourceId: string;
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
    close: () => Promise<void>;
    popOut: (request: { artifactId: string; url: string; title: string }) => Promise<void>;
    copyText: (text: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
}

export function SiteResourceDetail({
  resourceId,
  title,
  openArtifact,
  describeData,
  loadTable,
  surface,
}: SiteResourceDetailProps): React.JSX.Element {
  const paneRef = React.useRef<HTMLDivElement | null>(null);
  const [access, setAccess] = React.useState<SiteArtifactAccess | null>(null);
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
  /**
   * The site's stored rows, in place of the page.
   *
   * A state rather than a panel among panels: the page *is* this detail, and
   * everything else it can show is a departure from it. The composited view is
   * torn down while this is on, because the pane it was measured against is
   * not on screen to be covered.
   */
  const [showingData, setShowingData] = React.useState(false);

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

  // Once per artifact, for what the detail renders from — the canonical URL,
  // the mode, and whether it keeps data. The code this also mints is not the
  // one any navigation uses; `mintAccess` gets a fresh one at the click.
  React.useEffect(() => {
    let cancelled = false;
    setAccess(null);
    setAccessError(null);
    setPreviewShown(null);
    // The data view goes with it. This element is not keyed on the resource, so
    // the same instance is reconciled across a switch, and the control that
    // turns this back off only exists for an artifact that keeps data: carried
    // into one that does not, it would show that artifact's empty data view
    // with no way back to the page.
    setShowingData(false);

    void openArtifact(resourceId)
      .then((result) => { if (!cancelled) setAccess(result); })
      .catch((error: unknown) => {
        if (!cancelled) setAccessError(error instanceof Error ? error.message : 'Could not open this site.');
      });
    return () => { cancelled = true; };
  }, [openArtifact, resourceId]);

  const measure = React.useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const pane = paneRef.current;
    if (!pane) return null;
    // The owning lightbox is allowed; menus and dialogs above it must win
    // over Electron's native view, which otherwise paints above the DOM.
    const occluded = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')]
      .some((overlay) => !overlay.contains(pane) && overlay.getAttribute('data-state') !== 'closed');
    if (occluded) return { x: 0, y: 0, width: 0, height: 0 };
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
    if (!access || showingData) return undefined;
    const bounds = measure();
    if (!bounds) return undefined;
    let cancelled = false;
    void mintAccess()
      .then(async (navigation) => {
        // Minting crosses the API and can finish after a work-stream switch has
        // unmounted this detail. Its cleanup has already closed the native view
        // by then, so presenting here would resurrect an ownerless old preview.
        if (cancelled) return false;
        return await surface.present({
          artifactId: navigation.artifactId,
          url: navigation.openUrl,
          bounds: measure() ?? bounds,
          cornerRadius: paneCorner(),
        });
      })
      .then((shown) => { if (!cancelled) setPreviewShown(shown); })
      // A refused mint or a main process that cannot composite both land here.
      // Without this the pane keeps its `null` state and renders an empty box
      // with no message and no way out.
      .catch(() => { if (!cancelled) setPreviewShown(false); });
    return () => {
      cancelled = true;
      void surface.close();
    };
  }, [access, measure, mintAccess, paneCorner, showingData, surface]);

  // Native content must remain clipped to its owning scroll viewport and
  // disappear behind nested DOM dialogs; Electron cannot infer either.
  React.useEffect(() => {
    // Nothing to track while the data view has the pane: the composited view is
    // already torn down, and this effect would go on re-querying the document
    // on every scroll and mutation to move something that is not there.
    if (previewShown !== true || showingData) return undefined;
    const update = (): void => {
      const bounds = measure();
      if (bounds) void surface.setBounds(bounds);
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = new ResizeObserver(update);
    if (paneRef.current) observer.observe(paneRef.current);
    const overlays = new MutationObserver(update);
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'role'] });
    update();
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer.disconnect();
      overlays.disconnect();
    };
  }, [measure, previewShown, showingData, surface]);

  return (
    <div className="site-detail">
      {/*
        Into the host's header, beside its own controls, rather than into a row
        of this detail's own: chrome drawn over a page reads as the page's.
      */}
      <DetailHeaderActions>
      {/*
        Every one of these opens *upward*. The pane below the header is covered
        by a composited `WebContentsView` whenever a live artifact is showing,
        and that view paints above all renderer DOM: a tooltip hanging down from
        this header lands behind the page, and no `z-index` reaches it, because
        it is not a DOM sibling. Radix flips to the other side only when there
        is no room above, and this dialog is inset from the top of the window.
      */}
        {access?.stateful && (
          <IconButton
            aria-pressed={showingData}
            className="icon-button-toggle"
            tooltipSide="top"
            // The name stays the same in both states: `aria-pressed` is what
            // says which one it is in, and a name that changes with it makes a
            // screen reader announce the state twice.
            label="Stored data"
            onClick={() => setShowingData((showing) => !showing)}
          >
            <Database size={15} />
          </IconButton>
        )}
        <IconButton
          disabled={!access}
          label="Pop out"
          tooltipSide="top"
          onClick={() => {
            if (!access) return;
            void mintAccess().then(
              async (navigation) => await surface.popOut({
                artifactId: navigation.artifactId,
                url: navigation.openUrl,
                title,
              }),
            );
          }}
        >
          <Maximize2 size={15} />
        </IconButton>
        {/* The canonical public link carries no access code or viewer
            identity. Copying it shares the current site with anyone. */}
        <CopyButton
          copyText={surface.copyText}
          disabled={!access}
          label="Copy public link"
          size={15}
          tooltipSide="top"
          value={access?.canonicalUrl ?? ''}
        />
        <IconButton
          disabled={!access}
          label="Open in browser"
          tooltipSide="top"
          onClick={() => void mintAccess().then(
            async (navigation) => await surface.openExternal(navigation.openUrl),
          )}
        >
          <ExternalLink size={15} />
        </IconButton>
      </DetailHeaderActions>

      {showingData && access
        ? <SiteDataPanel describeData={describeData} loadTable={loadTable} resourceId={resourceId} surface={surface} />
        : (
          <div className="site-detail-pane" data-testid="site-preview-pane" ref={paneRef}>
            {accessError && <EmptyState description={accessError} title="This site could not be opened" />}
            {!accessError && !access && <p className="site-detail-status">Opening…</p>}
            {/*
              Nothing is rendered *into* the pane when the preview is live: the
              composited view covers it. This placeholder is what a person sees
              where no view can be composited — a browser build, or a refused URL.
            */}
            {access && previewShown === false && (
              <EmptyState
                description="Open it in your browser to see the live page."
                title="Preview unavailable here"
              />
            )}
          </div>
        )}
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
