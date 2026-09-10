import { AlertTriangle, Check, Copy, Database, ExternalLink, Maximize2, RefreshCcw } from 'lucide-react';
import React from 'react';

import {
  Button,
  EmptyState,
  IconButton,
  InsetList,
  InsetSurface,
  SegmentedControl,
  type SegmentedOption,
} from './primitives';

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

export interface SiteArtifactError {
  occurredAt: number;
  version: number;
  requestPath: string;
  message: string;
  stack: string | null;
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
  loadErrors: (resourceId: string) => Promise<SiteArtifactError[]>;
  /** The desktop bridge. Absent where nothing can composite a view. */
  surface: {
    present: (request: {
      artifactId: string;
      url: string;
      bounds: { x: number; y: number; width: number; height: number };
    }) => Promise<boolean>;
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
    close: () => Promise<void>;
    popOut: (request: { artifactId: string; url: string; title: string }) => Promise<void>;
    copyText: (text: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
}

type Panel = 'preview' | 'data' | 'errors';

export function SiteResourceDetail({
  resourceId,
  title,
  openArtifact,
  describeData,
  loadTable,
  loadErrors,
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
  const [panel, setPanel] = React.useState<Panel>('preview');
  const [copied, setCopied] = React.useState(false);

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

  // Present when the artifact and its pane are both ready, and tear down when
  // the detail closes or the artifact changes — one live preview at a time.
  React.useEffect(() => {
    if (!access || panel !== 'preview') return undefined;
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
  }, [access, measure, mintAccess, panel, surface]);

  // Native content must remain clipped to its owning scroll viewport and
  // disappear behind nested DOM dialogs; Electron cannot infer either.
  React.useEffect(() => {
    if (previewShown !== true) return undefined;
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
  }, [measure, previewShown, surface]);

  // A site that keeps no data has no Data panel to offer, so the choice is
  // built from what this artifact actually is rather than shown and disabled.
  const panels: SegmentedOption<Panel>[] = [
    { value: 'preview', label: 'Preview' },
    ...access?.stateful ? [{ value: 'data' as const, label: <><Database size={14} /> Data</> }] : [],
    { value: 'errors', label: <><AlertTriangle size={14} /> Errors</> },
  ];

  return (
    <div className="site-detail">
      {/*
        The actions live in this row rather than under the pane: they are
        chrome, and a row of bordered buttons below the page reads as part of
        the page. The title is not repeated here at all, because the header
        this detail renders under already carries it.
      */}
      <div className="site-detail-toolbar">
        <SegmentedControl label="Which part of this site to show" onChange={setPanel} options={panels} value={panel} />
        <p className="site-detail-kind">
          {access?.mode === 'active'
            ? access.stateful ? 'Live site · keeps data' : 'Live site'
            : 'Live page'}
        </p>
        <div className="site-detail-actions">
          <IconButton
            disabled={!access}
            label="Pop out"
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
          <IconButton
            disabled={!access}
            label={copied ? 'Copied' : 'Copy public link'}
            onClick={() => {
              if (!access) return;
              // The canonical public link carries no access code or viewer
              // identity. Copying it shares the current site with anyone.
              void surface.copyText(access.canonicalUrl).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              });
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
          <IconButton
            disabled={!access}
            label="Open in browser"
            onClick={() => void mintAccess().then(
              async (navigation) => await surface.openExternal(navigation.openUrl),
            )}
          >
            <ExternalLink size={15} />
          </IconButton>
        </div>
      </div>

      {panel === 'preview' && (
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

      {panel === 'data' && access && (
        <SiteDataPanel describeData={describeData} loadTable={loadTable} resourceId={resourceId} surface={surface} />
      )}

      {panel === 'errors' && (
        <SiteErrorPanel loadErrors={loadErrors} resourceId={resourceId} />
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
      <SegmentedControl
        label="Which stored table to show"
        onChange={setSelected}
        options={tables.map((table) => ({
          value: table.name,
          // The row count reads as part of the name without the screen reader
          // running the two together as one word.
          label: <>{table.name} <small>{table.rowCount}</small></>,
          name: `${table.name}, ${table.rowCount} rows`,
        }))}
        value={selected ?? ''}
      />
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
      <Button
        className="site-data-export"
        onClick={() => {
          if (!selected) return;
          void loadTable(resourceId, selected).then(({ csv }) => surface.copyText(csv));
        }}
      >
        <Copy size={14} /> Copy as CSV
      </Button>
    </div>
  );
}

/** What the site's own code threw, so a participant can paste it into chat. */
function SiteErrorPanel({
  loadErrors,
  resourceId,
}: Pick<SiteResourceDetailProps, 'loadErrors' | 'resourceId'>): React.JSX.Element {
  const [errors, setErrors] = React.useState<SiteArtifactError[] | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    void loadErrors(resourceId)
      .then((result) => { if (!cancelled) setErrors(result); })
      .catch(() => { if (!cancelled) setErrors([]); });
    return () => { cancelled = true; };
  }, [loadErrors, reloadKey, resourceId]);

  if (!errors) return <p className="site-detail-status">Reading…</p>;
  if (errors.length === 0) {
    return <EmptyState description="This site has not thrown an error." title="No errors" />;
  }
  return (
    <div className="site-errors">
      <Button className="site-errors-refresh" onClick={() => setReloadKey((key) => key + 1)}>
        <RefreshCcw size={14} /> Refresh
      </Button>
      <InsetList>
        {errors.map((entry) => (
          <li key={`${entry.occurredAt}-${entry.requestPath}`}>
            <code>{entry.requestPath}</code>
            {/* Model-authored text: displayed, never interpreted. */}
            <p>{entry.message}</p>
            <small>v{entry.version} · {new Date(entry.occurredAt).toLocaleString()}</small>
          </li>
        ))}
      </InsetList>
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
