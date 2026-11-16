import { AppErrorBoundary } from '@rally/ui/components/app-error-boundary';
import { inPlaceHash } from './session';
import { PinPlacementError, writeMobilePins } from './mobile-pins';
import { MobileWrites, uploadMobileReport } from './mobile-writes';
import { canvasCanonicalUrl, parseLinkTarget } from '@rally/contracts/links';
import { ConfiguredRegionSchema } from '@rally/contracts/regions';
import { ErrorNotice } from '@rally/ui/components/error-notice';
import { canvasNeedsConversation, mobileStorage, rememberMobileWorkspace } from './mobile-session';
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HashRouter, useLocation, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Plus, Search, Sparkles, Store } from 'lucide-react';
import type { CanvasSidebarRow } from '@rally/contracts';
import { CANVAS_FILTERS, ELSEWHERE_CANVAS_FACTS, canvasFilterFacts, matchesCanvasFilter, type CanvasFilter, type CanvasFilterFacts } from '@rally/contracts/canvas-filters';
import { ARTIFACT_PICKER_CAPABILITY, MOBILE_COMMAND_EVENT, MOBILE_SETTINGS_SECTIONS, MOBILE_SETTINGS_TITLES, MobileCommandSchema, MobileSettingsSectionSchema, VISIBLE_PIN_COUNT, type MobileCommand, type MobileSnapshot } from '../../mobile/src/protocol';
import { GUEST_SETTINGS_SECTIONS } from '../../desktop/src/common/settings';
import { useResourceHeads } from '../../desktop/src/renderer/lib/resource-heads';
import { useAppSession } from '../../desktop/src/renderer/lib/app-session';
import { LocalCacheScopeProvider } from '../../desktop/src/renderer/lib/local-cache-scope';
import { localCacheScope } from '../../desktop/src/renderer/lib/local-cache';
import { WorkspaceSocketProvider, useWorkspaceSocket } from '../../desktop/src/renderer/lib/workspace-socket';
import { CANVASES_ROUTE, canvasRoute, openCanvasId, useCanvasList } from '../../desktop/src/renderer/lib/canvases';
import { SpeechPlaybackProvider } from '../../desktop/src/renderer/components/speech-playback';
import { canvasMark } from '../../desktop/src/renderer/components/canvas-mark';
import { useOtherOrganizationCanvases, type OtherOrganizationCanvas } from '../../desktop/src/renderer/lib/shared-canvases';
import { mobileCapability, mobileScreenReady, postMobileEvent } from './mobile-bridge';
import './mobile.css';
import { useMobileCanvasDetail, useMobileCanvasUpdates } from './mobile-canvas-detail';
// Chat/composition and file previews are paid for only when those screens open.
// eslint-disable-next-line rally/no-dynamic-import
const MobileConversation = lazy(() => import('./mobile-conversation').then(module => ({ default: module.MobileConversation })));
// eslint-disable-next-line rally/no-dynamic-import
const CreateCanvas = lazy(() => import('./mobile-conversation').then(module => ({ default: module.CreateCanvas })));
// eslint-disable-next-line rally/no-dynamic-import
const MobileSettings = lazy(() => import('./mobile-settings').then(module => ({ default: module.MobileSettings })));
// eslint-disable-next-line rally/no-dynamic-import
const InspectorRail = lazy(() => import('../../desktop/src/renderer/components/inspector-rail').then(module => ({ default: module.InspectorRail })));
const opening = <div className="mobile-empty" role="status">Opening…</div>;

export type Descriptor = Pick<MobileSnapshot, 'view' | 'title' | 'artifactId' | 'artifactPicker'>;

/** Cookie-authenticated web content. The native shell never receives tokens. */
export function MobileCanvasApp(): React.JSX.Element | null {
  const { api, session, surrenderActiveWorkspace } = useAppSession();
  if (!api || !session?.workspace) return null;
  const scope = localCacheScope(session.user.id, session.workspace.region, session.workspace.id, session.workspace.accessClass ?? 'member');
  return <LocalCacheScopeProvider scope={scope}>
    <WorkspaceSocketProvider api={api} region={session.workspace.region} workspaceId={session.workspace.id} onAccessRevoked={surrenderActiveWorkspace}>
      <SpeechPlaybackProvider api={api}><HashRouter><MobileContent /></HashRouter></SpeechPlaybackProvider>
    </WorkspaceSocketProvider>
  </LocalCacheScopeProvider>;
}

function MobileContent(): React.JSX.Element {
  const { api, session, signOut } = useAppSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const directory = useCanvasList();
  const elsewhere = useOtherOrganizationCanvases();
  useMobileCanvasUpdates();
  const socket = useWorkspaceSocket();
  const [pinBusy, setPinBusy] = useState(false);
  const pinInFlight = useRef(false);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const rows = useMemo(() => directory ?? [], [directory]);
  const pinnedIds = useMemo<string[]>(() => rows.filter((row) => row.pinnedPosition !== null)
    .sort((a, b) => a.pinnedPosition! - b.pinnedPosition!).map((row) => row.id), [rows]);
  const summaries = useMemo(() => rows.map((row) => ({ id: row.id, title: row.title || 'Untitled canvas', updatedAt: row.updatedAt, icon: row.appearance?.icon ?? null, color: row.appearance?.color ?? null,
    facts: canvasFilterFacts(row, session?.user.id) })), [rows, session?.user.id]);
  const sharedElsewhere = useMemo(() => elsewhere.map(({ canvas, organization }) => ({ id: canvas.id, title: canvas.title || 'Untitled canvas', updatedAt: canvas.updatedAt,
    icon: canvas.appearance?.icon ?? null, color: canvas.appearance?.color ?? null, organization: { id: organization.id, name: organization.name, region: organization.region } })), [elsewhere]);
  const directoryError = directory === undefined && (socket.state === 'unavailable' || socket.state === 'reconnecting' || socket.state === 'update_required');
  useEffect(() => {
    if (session?.workspace) rememberMobileWorkspace(mobileStorage(), session.user.id, session.workspace);
  }, [session?.user.id, session?.workspace]);
  const canvasId = openCanvasId(location.pathname);
  const params = new URLSearchParams(location.search);
  const returnLocation = useRef<{ pathname: string; search: string; state: unknown } | null>(null);
  const conversation = Boolean(canvasId && (params.get('view') === 'chat' || params.has('turn')));
  // Home keeps preparing pins while its inline conversation is open. Dedicated
  // conversation sheets and pinned browser renderers never become this owner.
  const canPreparePins = !params.has('tab') && !conversation;
  const [preparePins, setPreparePins] = useState(canPreparePins);
  useEffect(() => { if (canPreparePins) setPreparePins(true); }, [canPreparePins]);
  const [lastConversation, setLastConversation] = useState<string | null>(conversation ? canvasId : null);
  useEffect(() => { if (conversation && canvasId) setLastConversation(canvasId); }, [conversation, canvasId]);
  const [creationSession, setCreationSession] = useState(false);
  const creating = location.pathname === CANVASES_ROUTE && location.state?.createCanvas === true;
  // The Marketplace is the create flow opened on its templates, so a template
  // starts a Canvas exactly as a typed prompt does.
  const marketplace = creating && location.state?.marketplace === true;
  const currentCreating = useRef(creating);
  currentCreating.current = creating;
  const create = (fromMarketplace = false) => { returnLocation.current = null; void navigate(CANVASES_ROUTE, { state: { createCanvas: true, marketplace: fromMarketplace } }); };
  useEffect(() => { if (location.pathname === '/') void navigate(CANVASES_ROUTE, { replace: true }); }, [location.pathname, navigate]);
  useEffect(() => { if (creating) setCreationSession(true); }, [creating]);
  // A shared Settings page, which reads its section from the route once, so
  // each request mounts it afresh (keyed by the navigation) on the section asked for.
  const settingsSection = location.pathname === SETTINGS_ROUTE ? MobileSettingsSectionSchema.safeParse(new URLSearchParams(location.search).get('section')).data ?? null : null;
  const guest = session?.workspace?.accessClass === 'guest';
  const settingsSections = useMemo(() => MOBILE_SETTINGS_SECTIONS.filter((section) => !guest || GUEST_SETTINGS_SECTIONS.has(section)), [guest]);
  const tabId = canvasId && new URLSearchParams(location.search).get('tab') === '1' && pinnedIds.includes(canvasId) ? canvasId : null;
  const [visited, setVisited] = useState<string[]>([]);
  const [descriptors, setDescriptors] = useState<Record<string, Descriptor>>({});
  useEffect(() => {
    if (canvasId && !conversation) setVisited((ids) => ids.includes(canvasId) ? ids : [...ids, canvasId]);
  }, [canvasId, conversation]);
  const describe = useCallback((id: string, descriptor: Descriptor) => {
    setDescriptors((current) => JSON.stringify(current[id]) === JSON.stringify(descriptor) ? current : { ...current, [id]: descriptor });
  }, []);
  const open = useCallback((id: string, pinned = false) => { returnLocation.current = null; void navigate(`${canvasRoute(id)}${pinned ? '?tab=1' : ''}`); }, [navigate]);
  const currentPushScope = useRef({ userId: session?.user.id, workspaceId: session?.workspace?.id });
  currentPushScope.current = { userId: session?.user.id, workspaceId: session?.workspace?.id };
  const pushWrite = useRef<MobileWrites | null>(null);
  useEffect(() => {
    currentPushScope.current = { userId: session?.user.id, workspaceId: session?.workspace?.id };
    const writes = new MobileWrites();
    pushWrite.current = writes;
    return () => { writes.close(); pushWrite.current = null; currentPushScope.current = { userId: undefined, workspaceId: undefined }; };
  }, [api, session?.user.id, session?.workspace?.id]);
  const command = useRef<(command: MobileCommand) => void>(() => undefined);
  command.current = (message) => {
    switch (message.type) {
      case 'home': returnLocation.current = null; void navigate(CANVASES_ROUTE); break;
      case 'crash-status': {
        if (!api || !session?.workspace) break;
        const scope = { userId: session.user.id, workspaceId: session.workspace.id, route: session.workspace.region };
        void api.getProductAnalyticsPreference().then((preference) => {
          if (currentPushScope.current.userId === scope.userId && currentPushScope.current.workspaceId === scope.workspaceId) {
            postMobileEvent({ type: 'crash-permission', requestId: message.requestId, scope, enabled: preference.enabled });
          }
        }).catch(() => undefined);
        break;
      }
      case 'crash-upload': {
        const { report } = message;
        if (!api || report.scope.userId !== session?.user.id || report.scope.workspaceId !== session.workspace?.id
          || report.scope.route !== session.workspace.region || report.metadata.route !== report.scope.route
          || report.metadata.format !== 'mobile-json') break;
        const registeredApi = api;
        void pushWrite.current?.enqueue(async (signal) => {
          if (currentPushScope.current.userId !== report.scope.userId || currentPushScope.current.workspaceId !== report.scope.workspaceId) return;
          await uploadMobileReport(report, signal, (report, signal) => registeredApi.uploadMobileCrash(report, signal), postMobileEvent);
        });
        break;
      }
      case 'open-chat':
        if (!returnLocation.current) returnLocation.current = { pathname: location.pathname, search: location.search, state: location.state };
        void navigate(`${canvasRoute(message.id)}?view=chat`);
        break;
      case 'close-chat': {
        const previous = returnLocation.current;
        returnLocation.current = null;
        void navigate(previous ? previous.pathname + previous.search : CANVASES_ROUTE, { replace: true, state: previous?.state });
        break;
      }
      case 'create': create(message.marketplace); break;
      case 'settings':
        returnLocation.current = null;
        void navigate(`${SETTINGS_ROUTE}?section=${message.section}`);
        break;
      case 'open': open(message.id, message.pinned); break;
      case 'open-elsewhere': {
        const region = ConfiguredRegionSchema.safeParse(message.region);
        if (region.success) openElsewhere({ region: region.data, workspaceId: message.workspaceId, canvasId: message.canvasId });
        break;
      }
      case 'load-more': break; // The current Canvas directory is pushed as one list.
      // Native sends this on resume and on reconnection. A socket that slept
      // can still read OPEN with its connection gone, so replace it outright.
      case 'refresh': socket.replace(); void queryClient.invalidateQueries({ queryKey: ['canvas'] }); break;
      case 'sign-out':
        // Session revocation also disables every device bound only to that session.
        void signOut(); break;
      case 'push-device': {
        if (!api || message.userId !== session?.user.id || message.workspaceId !== session.workspace?.id) break;
        const registeredApi = api;
        void pushWrite.current?.enqueue(async (signal) => {
          if (currentPushScope.current.userId !== message.userId || currentPushScope.current.workspaceId !== message.workspaceId) return;
          try {
            if (message.registration) await registeredApi.registerPushDevice(message.installationId, message.registration, signal);
            else await registeredApi.deletePushDevice(message.installationId, signal);
            postMobileEvent({ type: 'push-device-result', requestId: message.requestId, userId: message.userId, workspaceId: message.workspaceId, ok: true, enabled: Boolean(message.registration) });
          } catch {
            postMobileEvent({ type: 'push-device-result', requestId: message.requestId, userId: message.userId, workspaceId: message.workspaceId, ok: false, enabled: false });
          }
        });
        break;
      }
      case 'open-notification': {
        returnLocation.current = null;
        const target = parseLinkTarget(message.url, { webBaseUrl: window.location.origin });
        postMobileEvent({ type: 'notification-opened', url: message.url });
        if (target?.kind === 'canvas') {
          const hash = inPlaceHash(window.location.pathname, message.url);
          if (hash) { window.location.hash = hash; break; }
          const destination = new URL(message.url);
          destination.searchParams.set('mobile', '1');
          window.location.assign(destination.href);
        }
        break;
      }
      case 'switch-workspace': locationAssignWorkspacePicker(); break;
      case 'open-prepared-artifact': {
        if (!api || message.userId !== session?.user.id || message.workspaceId !== session.workspace?.id) break;
        const { canvas, requestId, userId, workspaceId } = message;
        void api.openArtifact(canvas.resourceId).then((access) => {
          if (currentPushScope.current.userId === userId && currentPushScope.current.workspaceId === workspaceId) {
            postMobileEvent({ type: 'prepared-artifact', requestId, artifact: { ...canvas, openUrl: access.openUrl, canonicalUrl: access.canonicalUrl } });
          }
        }, () => {
          if (currentPushScope.current.userId === userId && currentPushScope.current.workspaceId === workspaceId) postMobileEvent({ type: 'prepared-artifact', requestId, artifact: null });
        });
        break;
      }
      case 'reopen-artifact': void queryClient.invalidateQueries({ queryKey: ['mobile-site-access', message.canvasId, message.resourceId] }); break;
      case 'pin':
      case 'reorder': {
        if (!api || pinInFlight.current) return;
        if (message.type === 'pin' && message.pinned && !pinnedIds.includes(message.id) && pinnedIds.length >= VISIBLE_PIN_COUNT) {
          setPinNotice('Unpin a canvas to make room for another tab.'); return;
        }
        pinInFlight.current = true; setPinBusy(true); setPinNotice(null);
        const write = writeMobilePins(api, pinnedIds, message);
        void write.then(() => { pinInFlight.current = false; setPinBusy(false); }, (error: unknown) => { pinInFlight.current = false; setPinBusy(false); setPinNotice(error instanceof PinPlacementError ? 'Pinned, but couldn’t move it there. Try moving it again.' : 'Your tabs couldn’t be saved. Try again.'); });
        break;
      }
    }
  };
  useEffect(() => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const parsed = MobileCommandSchema.safeParse(event.detail);
      if (parsed.success) command.current(parsed.data);
    };
    window.addEventListener(MOBILE_COMMAND_EVENT, listener);
    return () => window.removeEventListener(MOBILE_COMMAND_EVENT, listener);
  }, []);
  useEffect(() => {
    if (!session?.workspace) return;
    const descriptor = canvasId ? descriptors[canvasId] : null;
    postMobileEvent({ type: 'snapshot', snapshot: {
      userId: session.user.id, userName: session.user.name, workspaceId: session.workspace.id, workspaceName: session.workspace.name,
      workspacePath: `/app/workspaces/${session.workspace.region}/${session.workspace.id}`,
      canvases: summaries, sharedElsewhere,
      pins: pinnedIds, hasMore: false, loading: directory === undefined,
      pinBusy, pinError: pinNotice, directoryError, canvasId, tabId, inlineChat: true,
      view: settingsSection ? 'settings' : creating ? 'create' : conversation ? 'conversation' : canvasId ? descriptor?.view ?? 'artifact' : 'home',
      title: settingsSection ? MOBILE_SETTINGS_TITLES[settingsSection] : marketplace ? 'Marketplace' : creating ? 'New canvas' : canvasId ? descriptor?.title ?? rows.find((row) => row.id === canvasId)?.title ?? 'Canvas' : 'Your canvases',
      artifactId: descriptor?.artifactId ?? null, artifactPicker: descriptor?.artifactPicker ?? false,
      settingsSections,
    } });
  }, [session, rows, summaries, sharedElsewhere, pinnedIds, directory, directoryError, pinBusy, pinNotice, canvasId, tabId, creating, marketplace, conversation, descriptors, settingsSection, settingsSections]);
  return <main className="mobile-canvas-app">
    {Reflect.get(window, 'ReactNativeWebView') && preparePins && pinnedIds.slice(0, VISIBLE_PIN_COUNT).map((id) => <PrepareCanvas key={id} id={id} />)}
    <section hidden={Boolean(canvasId || creating || settingsSection)} className="mobile-page"><Dashboard rows={rows} elsewhere={elsewhere} openElsewhere={(item) => { const region = ConfiguredRegionSchema.safeParse(item.organization.region); if (region.success) openElsewhere({ region: region.data, workspaceId: item.organization.id, canvasId: item.canvas.id }); }} loading={directory === undefined} failed={directoryError} retry={socket.retry} hasMore={false} more={() => undefined} open={(id) => { if (Reflect.get(window, 'ReactNativeWebView')) postMobileEvent({ type: 'open-canvas', id }); else open(id); }} create={() => create()} openMarketplace={session?.workspace?.accessClass === 'guest' ? undefined : () => create(true)} userId={session?.user.id} /></section>
    {visited.map((id) => <section key={id} hidden={id !== canvasId || conversation || creating} className="mobile-page mobile-artifact"><Canvas id={id} active={id === canvasId && !conversation} describe={describe} /></section>)}
    {(conversation ? canvasId : lastConversation) && <section hidden={!conversation} className="mobile-page mobile-conversation"><AppErrorBoundary onError={mobileScreenReady}><Suspense fallback={opening}><MobileConversation key={conversation ? canvasId : lastConversation} id={(conversation ? canvasId : lastConversation)!} active={conversation} describe={describe} /></Suspense></AppErrorBoundary></section>}
    {settingsSection && <section key={location.key} className="mobile-page mobile-settings"><AppErrorBoundary onError={mobileScreenReady}><Suspense fallback={opening}><MobileSettings /></Suspense></AppErrorBoundary></section>}
    {creationSession && <section hidden={!creating} className="mobile-page"><AppErrorBoundary onError={mobileScreenReady}><Suspense fallback={opening}><CreateCanvas marketplace={marketplace} created={(id) => { setCreationSession(false); socket.retry(); if (currentCreating.current) void navigate(`${canvasRoute(id)}?view=chat`); }} /></Suspense></AppErrorBoundary></section>}
  </main>;
}

const SETTINGS_ROUTE = '/settings';

/**
 * A Canvas in another of this person's Organizations: its canonical page, which
 * opens that Organization, kept in the mobile presentation as a notification's
 * link is (`open-notification`), in the same native or preview host.
 */
function openElsewhere(target: { region: Parameters<typeof canvasCanonicalUrl>[1]['region']; workspaceId: string; canvasId: string }): void {
  const destination = new URL(canvasCanonicalUrl(window.location.origin, target));
  destination.searchParams.set('mobile', '1');
  // The browser preview's own parameter, which the entry carries through (`shellLocation`).
  const preview = new URLSearchParams(window.location.search).get('mobilePreviewOrigin');
  if (preview) destination.searchParams.set('mobilePreviewOrigin', preview);
  window.location.assign(destination.href);
}

/** The browser preview's dashboard; a native shell draws its own from the snapshot. */
function Dashboard({ rows, elsewhere, openElsewhere: openOther, loading, failed, retry, hasMore, more, open, create, openMarketplace, userId }: {
  rows: CanvasSidebarRow[];
  elsewhere: OtherOrganizationCanvas[];
  openElsewhere: (item: OtherOrganizationCanvas) => void;
  loading: boolean; failed: boolean; retry: () => void; hasMore: boolean; more: () => void;
  open: (id: string) => void; create: () => void; openMarketplace: (() => void) | undefined; userId: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CanvasFilter>('all');
  type Card = { row: OtherOrganizationCanvas['canvas']; organization?: OtherOrganizationCanvas['organization']; facts: CanvasFilterFacts };
  const own = rows.map((row): Card => ({ row, facts: canvasFilterFacts(row, userId) }));
  const all: Card[] = elsewhere.length === 0 ? own
    : [...own, ...elsewhere.map(({ canvas, organization }): Card => ({ row: canvas, organization, facts: ELSEWHERE_CANVAS_FACTS }))]
      .sort((a, b) => b.row.updatedAt.localeCompare(a.row.updatedAt));
  const filtered = all.filter(({ row, facts }) => row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && matchesCanvasFilter(facts, filter));
  const narrowed = query !== '' || filter !== 'all';
  return <div className="mobile-dashboard"><div className="mobile-dashboard-heading"><h1>Your canvases</h1>{openMarketplace && <button className="mobile-secondary" onClick={openMarketplace}><Store size={16} aria-hidden="true" />Marketplace</button>}</div>
    <label className="mobile-search"><Search size={19} /><input aria-label="Find a canvas" placeholder="Find a canvas" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {all.length > 0 && <div aria-label="Canvas filter" className="mobile-filters" role="group">
      {CANVAS_FILTERS.map(([value, label]) => <button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} type="button">{label}</button>)}
    </div>}
    {failed ? <Recovery title="Your canvases couldn’t load" retry={retry} /> : loading ? <div role="status" className="mobile-skeleton">Loading your canvases…</div> : <>
      <div className="mobile-section-heading"><h2>{narrowed ? 'Search results' : 'Pick up where you left off'}</h2><span>{filtered.length} {filtered.length === 1 ? 'canvas' : 'canvases'}</span></div>
      <div className="mobile-grid">{filtered.map(({ row, organization }, index) => {
        const { icon: Icon, ink, tint, color } = canvasMark(row.id, row.appearance);
        const style = { '--card-hue': `var(--av-sys-color-project-${color})`, '--card-tint': tint, '--card-ink': ink } as React.CSSProperties;
        const from = organization ? `Shared from ${organization.name}` : undefined;
        return <button className="mobile-card" key={`${organization?.id ?? ''}:${row.id}`} onClick={() => organization ? openOther({ canvas: row, organization }) : open(row.id)} style={style}>
          {organization && <span aria-hidden="true" className="mobile-card-organization organization-badge-initial">{organization.name.slice(0, 1).toLocaleUpperCase()}</span>}
          <div className="mobile-card-art" aria-hidden="true"><Icon size={index === 0 ? 50 : 32} strokeWidth={1.5} /></div><h3>{row.title || 'Untitled canvas'}</h3><p>{from ?? 'Open canvas'} <ArrowUpRight size={14} aria-hidden="true" /></p></button>;
      })}</div>
      {!filtered.length && <div className="mobile-empty"><Sparkles size={32} /><h2>{narrowed ? 'No canvases found' : 'Make room for an idea.'}</h2><p>{narrowed ? 'Try another name or filter.' : 'Create a plan, a little tool, or something just for you.'}</p>{!narrowed && <button className="mobile-primary" onClick={create}><Plus size={18} /> Create a canvas</button>}</div>}
      {hasMore && <button className="mobile-load" onClick={more}>Load more canvases</button>}
    </>}
  </div>;
}

/** The existing Home session discovers pins before native tabs open.
 * The native shell redeems access immediately; no single-use URL is cached. */
function PrepareCanvas({ id }: { id: string }) {
  const { session } = useAppSession();
  const query = useMobileCanvasDetail(id);
  const heads = useResourceHeads();
  const artifacts = query.data?.artifacts ?? [];
  // A shell with a native picker takes any canvas with a site, opening the one
  // this page would (its first site); an older shell only a single-site canvas.
  const picker = mobileCapability(ARTIFACT_PICKER_CAPABILITY);
  const resource = picker
    ? artifacts.find((item) => item.kind === 'site') ?? null
    : artifacts.length === 1 && artifacts[0]?.kind === 'site' ? artifacts[0] : null;
  const current = (item: { resourceId: string; version: number }) => Math.max(item.version, heads[item.resourceId]?.version ?? 0);
  const version = resource ? current(resource) : 0;
  const listed = picker && artifacts.length > 1
    ? artifacts.map((item) => ({ resourceId: item.resourceId, title: item.title, version: current(item), kind: item.kind }))
    : undefined;
  const listKey = JSON.stringify(listed ?? null);
  useEffect(() => {
    if (!session?.workspace || (!query.data && !query.isError)) return;
    postMobileEvent({ type: 'prepared-canvas', userId: session.user.id, workspaceId: session.workspace.id, canvasId: id,
      canvas: resource ? { canvasId: id, resourceId: resource.resourceId, version, title: query.data!.title, ...(listed ? { artifacts: listed } : {}) } : null });
  // `listed` is rebuilt each render; `listKey` is its content.
  }, [session, id, resource, version, query.data, query.isError, listKey]);
  return null;
}

function Canvas({ id, active, describe }: { id: string; active: boolean; describe: (id: string, descriptor: Descriptor) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { api } = useAppSession();
  const query = useMobileCanvasDetail(id, active);
  const heads = useResourceHeads();
  const artifacts = query.data?.artifacts ?? [];
  // Once an empty canvas opens its chat, stay there until View canvas is tapped.
  useEffect(() => {
    if (canvasNeedsConversation({ active, loaded: Boolean(query.data), fetching: query.isFetching, failed: query.isError, artifactCount: artifacts.length })) {
      const params = new URLSearchParams(location.search);
      params.set('view', 'chat');
      void navigate(`${canvasRoute(id)}?${params}`, { replace: true });
    }
  }, [active, artifacts.length, id, location.search, navigate, query.data, query.isError, query.isFetching]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get('artifact');
    if (active && requested) setSelected(requested);
  }, [active, location.search]);
  const selectArtifact = (resourceId: string) => {
    const params = new URLSearchParams(location.search);
    params.set('artifact', resourceId);
    void navigate(`${canvasRoute(id)}?${params}`, { replace: true });
  };
  const resource = artifacts.find((item) => item.resourceId === selected) ?? artifacts.find((item) => item.kind === 'site') ?? artifacts[0];
  useEffect(() => {
    if (!active) return;
    if (query.isError) { describe(id, { title: 'Canvas', artifactId: null, artifactPicker: false, view: 'artifact' }); return; }
    if (!query.data) return;
    describe(id, { title: query.data.title, artifactId: resource?.resourceId ?? null, artifactPicker: artifacts.length > 1, view: resource ? 'artifact' : 'conversation' });
  }, [active, describe, id, query.data, query.isError, resource, artifacts.length]);
  const version = resource ? Math.max(resource.version, heads[resource.resourceId]?.version ?? 0) : undefined;
  const content = useQuery({ queryKey: ['mobile-resource', resource?.resourceId, version], queryFn: () => api!.getResource(resource!.resourceId), enabled: Boolean(api && resource && resource.kind !== 'site' && active) });
  useEffect(() => {
    if (active && resource && resource.kind !== 'site' && content.isError) postMobileEvent({ type: 'artifact-unavailable', canvasId: id, resourceId: resource.resourceId });
  }, [active, id, resource, content.isError]);
  const loadContent = useCallback((resourceId: string, signal?: AbortSignal) => api!.getResourcePreviewContent(resourceId, signal), [api]);
  const loadOriginal = useCallback((resourceId: string, signal?: AbortSignal) => api!.getResourceContent(resourceId, signal), [api]);
  if (query.isError) return <Recovery title="This canvas couldn’t load" retry={() => void query.refetch()} />;
  if (!query.data) return <div className="mobile-empty" role="status">Opening canvas…</div>;
  if (!resource) return null;
  return <>
    {artifacts.length > 1 && <label className="mobile-artifact-picker">Artifact <select aria-label="Choose artifact" value={resource.resourceId} onChange={(event) => selectArtifact(event.target.value)}>{artifacts.map((item) => <option key={item.resourceId} value={item.resourceId}>{item.title}</option>)}</select></label>}
    {resource.kind === 'site'
      ? <HostedSite key={`${resource.resourceId}:${version}`} canvasId={id} resourceId={resource.resourceId} version={version ?? resource.version} title={resource.title} active={active} />
      : content.isError ? <Recovery title="This artifact couldn’t load" retry={() => void content.refetch()} /> : !content.data ? <div className="mobile-empty" role="status">Opening artifact…</div>
      : <AppErrorBoundary onError={mobileScreenReady}><Suspense fallback={opening}><div key="content" className="mobile-artifact-content" data-density="default"><InspectorRail resource={content.data} panel={{ resourceId: resource.resourceId, detached: true, onClose: () => undefined }} loadResourceContent={loadContent} loadOriginalResourceContent={loadOriginal} /></div></Suspense></AppErrorBoundary>}
  </>;
}

function HostedSite({ canvasId, resourceId, version, title, active }: { canvasId: string; resourceId: string; version: number; title: string; active: boolean }) {
  const { api } = useAppSession();
  const native = Boolean(Reflect.get(window, 'ReactNativeWebView'));
  const instance = useId();
  const access = useQuery({ queryKey: ['mobile-site-access', canvasId, resourceId, version, instance], queryFn: () => api!.openArtifact(resourceId), enabled: active && Boolean(api), staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false });
  useEffect(() => {
    if (!native) return;
    if (active && access.isError) { postMobileEvent({ type: 'artifact-unavailable', canvasId, resourceId }); return; }
    if (active && access.data) postMobileEvent({ type: 'artifact', artifact: { canvasId, resourceId, version, openUrl: access.data.openUrl, canonicalUrl: access.data.canonicalUrl } });
  }, [native, active, access.data, access.isError, canvasId, resourceId, version]);
  if (access.isError) return <Recovery title="This canvas couldn’t open" retry={() => void access.refetch()} />;
  // Native uses a first-party WebView; the browser preview frames that same
  // hosted document. Neither surface receives the application's bridge.
  if (!native && access.data) return <iframe className="mobile-hosted-artifact" title={title || 'Canvas artifact'} src={access.data.openUrl} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" />;
  return <div className="mobile-empty" role="status">Opening canvas…</div>;
}

function Recovery({ title, retry }: { title: string; retry: () => void }) {
  return <div className="mobile-empty"><ErrorNotice title={title}>Check your connection and try again.</ErrorNotice><button className="mobile-primary" onClick={retry}>Try again</button></div>;
}

function locationAssignWorkspacePicker(): void {
  window.location.assign('/?mobile=1&chooseWorkspace=1');
}
