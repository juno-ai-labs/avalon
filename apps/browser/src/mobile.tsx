import { inPlaceHash } from './session';
import { writeMobilePins } from './mobile-pins';
import { MobileWrites, uploadMobileReport } from './mobile-writes';
import { parseLinkTarget } from '@rally/contracts/links';
import { ErrorNotice } from '@rally/ui/components/error-notice';
import { canvasNeedsConversation, mobileStorage, mobileTurnTarget, rememberMobileWorkspace } from './mobile-session';
import type { WorkstreamResource } from '../../desktop/src/renderer/lib/types';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HashRouter, useLocation, useNavigate } from 'react-router-dom';
import { ArrowUpRight, FileText, Plus, Search, Sparkles } from 'lucide-react';
import { asWorkstreamId } from '@rally/contracts';
import { MOBILE_COMMAND_EVENT, MobileCommandSchema, VISIBLE_PIN_COUNT, type MobileCommand, type MobileSnapshot } from '../../mobile/src/protocol';
import { useResourceHeads } from '../../desktop/src/renderer/lib/resource-heads';
import { useWorkspaceMembers } from '../../desktop/src/renderer/lib/workspace-members';
import { useAppSession } from '../../desktop/src/renderer/lib/app-session';
import { LocalCacheScopeProvider } from '../../desktop/src/renderer/lib/local-cache-scope';
import { localCacheScope } from '../../desktop/src/renderer/lib/local-cache';
import { WorkspaceSocketProvider, useWorkspaceSocket } from '../../desktop/src/renderer/lib/workspace-socket';
import { CANVASES_ROUTE, canvasRoute, openCanvasId, canvasDetailQueryKey, useCanvasList } from '../../desktop/src/renderer/lib/canvases';
import { SpeechPlaybackProvider } from '../../desktop/src/renderer/components/speech-playback';
import { InspectorRail } from '../../desktop/src/renderer/components/inspector-rail';
import { ConversationSurface } from '../../desktop/src/renderer/screens/conversation-surface';
import { WorkstreamComposer } from '../../desktop/src/renderer/components/workstream-composer';
import { useFileAttachments } from '../../desktop/src/renderer/lib/use-file-attachments';
import { AttachmentLightbox } from '../../desktop/src/renderer/components/attachment-lightbox';
import type { AttachmentPreview } from '../../desktop/src/renderer/components/attachments';
import { uuidV7 } from '../../desktop/src/renderer/lib/telemetry';
import { postMobileEvent } from './mobile-bridge';
import './mobile.css';

type Descriptor = Pick<MobileSnapshot, 'view' | 'title' | 'artifactId' | 'artifactPicker'>;

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
  const socket = useWorkspaceSocket();
  const [pinBusy, setPinBusy] = useState(false);
  const pinInFlight = useRef(false);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const rows = useMemo(() => directory ?? [], [directory]);
  const pinnedIds = useMemo<string[]>(() => rows.filter((row) => row.pinnedPosition !== null)
    .sort((a, b) => a.pinnedPosition! - b.pinnedPosition!).map((row) => row.id), [rows]);
  const summaries = useMemo(() => rows.map((row) => ({ id: row.id, title: row.title || 'Untitled canvas', updatedAt: row.updatedAt, icon: row.appearance?.icon ?? null, color: row.appearance?.color ?? null })), [rows]);
  const directoryError = directory === undefined && (socket.state === 'unavailable' || socket.state === 'reconnecting' || socket.state === 'update_required');
  useEffect(() => {
    if (session?.workspace) rememberMobileWorkspace(mobileStorage(), session.user.id, session.workspace);
  }, [session?.user.id, session?.workspace]);
  const canvasId = openCanvasId(location.pathname);
  const params = new URLSearchParams(location.search);
  const conversation = Boolean(canvasId && (params.get('view') === 'chat' || params.has('turn')));
  const [creationSession, setCreationSession] = useState(false);
  const creating = location.pathname === CANVASES_ROUTE && location.state?.createCanvas === true;
  const currentCreating = useRef(creating);
  currentCreating.current = creating;
  const create = () => { void navigate(CANVASES_ROUTE, { state: { createCanvas: true } }); };
  useEffect(() => { if (location.pathname === '/') void navigate(CANVASES_ROUTE, { replace: true }); }, [location.pathname, navigate]);
  useEffect(() => { if (creating) setCreationSession(true); }, [creating]);
  const tabId = canvasId && new URLSearchParams(location.search).get('tab') === '1' && pinnedIds.includes(canvasId) ? canvasId : null;
  const [visited, setVisited] = useState<string[]>([]);
  const [descriptors, setDescriptors] = useState<Record<string, Descriptor>>({});
  useEffect(() => {
    if (canvasId && !conversation) setVisited((ids) => ids.includes(canvasId) ? ids : [...ids, canvasId]);
  }, [canvasId, conversation]);
  const describe = useCallback((id: string, descriptor: Descriptor) => {
    setDescriptors((current) => JSON.stringify(current[id]) === JSON.stringify(descriptor) ? current : { ...current, [id]: descriptor });
  }, []);
  const open = useCallback((id: string, pinned = false) => { void queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(id) }); void navigate(`${canvasRoute(id)}${pinned ? '?tab=1' : ''}`); }, [navigate, queryClient]);
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
      case 'home': void navigate(CANVASES_ROUTE); break;
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
      case 'create': create(); break;
      case 'open': open(message.id, message.pinned); break;
      case 'load-more': break; // The current Canvas directory is pushed as one list.
      case 'refresh': socket.retry(); void queryClient.invalidateQueries({ queryKey: ['canvas'] }); break;
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
      case 'reopen-artifact': void queryClient.invalidateQueries({ queryKey: ['mobile-site-access', message.canvasId, message.resourceId] }); break;
      case 'pin':
      case 'reorder': {
        if (!api || pinInFlight.current) return;
        if (message.type === 'pin' && message.pinned && !pinnedIds.includes(message.id) && pinnedIds.length >= VISIBLE_PIN_COUNT) {
          setPinNotice('Unpin a canvas to make room for another tab.'); return;
        }
        pinInFlight.current = true; setPinBusy(true); setPinNotice(null);
        const write = writeMobilePins(api, pinnedIds, message);
        void write.then(() => { pinInFlight.current = false; setPinBusy(false); }, () => { pinInFlight.current = false; setPinBusy(false); setPinNotice('Your tabs couldn’t be saved. Try again.'); });
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
      canvases: summaries,
      pins: pinnedIds, hasMore: false, loading: directory === undefined,
      pinBusy, pinError: pinNotice, directoryError, canvasId, tabId,
      view: creating ? 'create' : conversation ? 'conversation' : canvasId ? descriptor?.view ?? 'artifact' : 'home',
      title: creating ? 'New canvas' : canvasId ? descriptor?.title ?? rows.find((row) => row.id === canvasId)?.title ?? 'Canvas' : 'Your canvases',
      artifactId: descriptor?.artifactId ?? null, artifactPicker: descriptor?.artifactPicker ?? false,
    } });
  }, [session, rows, summaries, pinnedIds, directory, directoryError, pinBusy, pinNotice, canvasId, tabId, creating, conversation, descriptors]);
  return <main className="mobile-canvas-app">
    <section hidden={Boolean(canvasId || creating)} className="mobile-page"><Dashboard rows={rows} loading={directory === undefined} failed={directoryError} retry={socket.retry} hasMore={false} more={() => undefined} open={(id) => { if (Reflect.get(window, 'ReactNativeWebView')) postMobileEvent({ type: 'open-canvas', id }); else open(id); }} create={create} /></section>
    {visited.map((id) => <section key={id} hidden={id !== canvasId || conversation || creating} className="mobile-page mobile-artifact"><Canvas id={id} active={id === canvasId && !conversation} describe={describe} /></section>)}
    {conversation && canvasId && <section className="mobile-page mobile-conversation"><MobileConversation key={canvasId} id={canvasId} describe={describe} /></section>}
    {creationSession && <section hidden={!creating} className="mobile-page"><CreateCanvas created={(id) => { setCreationSession(false); socket.retry(); if (currentCreating.current) void navigate(`${canvasRoute(id)}?view=chat`); }} /></section>}
  </main>;
}

function Dashboard({ rows, loading, failed, retry, hasMore, more, open, create }: {
  rows: Array<{ id: string; title: string; updatedAt: string }>;
  loading: boolean; failed: boolean; retry: () => void; hasMore: boolean; more: () => void;
  open: (id: string) => void; create: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = rows.filter((row) => row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="mobile-dashboard"><p className="mobile-eyebrow">A little space for everything</p><h1>Your canvases</h1>
    <label className="mobile-search"><Search size={19} /><input aria-label="Find a canvas" placeholder="Find a canvas" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {failed ? <Recovery title="Your canvases couldn’t load" retry={retry} /> : loading ? <div role="status" className="mobile-skeleton">Loading your canvases…</div> : <>
      <div className="mobile-section-heading"><h2>{query ? 'Search results' : 'Pick up where you left off'}</h2><span>{filtered.length} canvases</span></div>
      <div className="mobile-grid">{filtered.map((row, index) => <button className={`mobile-card mobile-card-${index % 4}`} key={row.id} onClick={() => open(row.id)}><div className="mobile-card-art" aria-hidden="true"><FileText size={index === 0 ? 50 : 32} strokeWidth={1} /></div><h3>{row.title || 'Untitled canvas'}</h3><p>Open canvas <ArrowUpRight size={14} aria-hidden="true" /></p></button>)}</div>
      {!filtered.length && <div className="mobile-empty"><Sparkles size={32} /><h2>{query ? 'No canvases found' : 'Make room for an idea.'}</h2><p>{query ? 'Try another name, or load more canvases.' : 'Create a plan, a little tool, or something just for you.'}</p>{!query && <button className="mobile-primary" onClick={create}><Plus size={18} /> Create a canvas</button>}</div>}
      {hasMore && <button className="mobile-load" onClick={more}>Load more canvases</button>}
    </>}
  </div>;
}

/** Follow only this canvas's publication timestamp and the resource topic,
 * not unrelated directory presence/pin changes. Both artifact and chat use it. */
function useMobileCanvasDetail(id: string, active = true) {
  const { api } = useAppSession();
  const queryClient = useQueryClient();
  const row = useCanvasList()?.find((canvas) => canvas.id === id);
  const { topicWaterlines, sidebarConnect } = useWorkspaceSocket();
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(id) });
  }, [id, queryClient, row?.updatedAt, row?.artifactKind, topicWaterlines.resources, sidebarConnect?.generation]);
  return useQuery({ queryKey: canvasDetailQueryKey(id), queryFn: ({ signal }) => api!.getCanvas(id, signal), enabled: Boolean(api && active) });
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
  const content = useQuery({ queryKey: ['mobile-resource', resource?.resourceId, version], queryFn: () => api!.getResource(resource!.resourceId), enabled: Boolean(api && resource && active) });
  useEffect(() => {
    if (active && resource && content.isError) postMobileEvent({ type: 'artifact-unavailable', canvasId: id, resourceId: resource.resourceId });
  }, [active, id, resource, content.isError]);
  const loadContent = useCallback((resourceId: string, signal?: AbortSignal) => api!.getResourcePreviewContent(resourceId, signal), [api]);
  const loadOriginal = useCallback((resourceId: string, signal?: AbortSignal) => api!.getResourceContent(resourceId, signal), [api]);
  if (query.isError) return <Recovery title="This canvas couldn’t load" retry={() => void query.refetch()} />;
  if (!query.data) return <div className="mobile-empty" role="status">Opening canvas…</div>;
  if (!resource) return null;
  return <>
    {artifacts.length > 1 && <label className="mobile-artifact-picker">Artifact <select aria-label="Choose artifact" value={resource.resourceId} onChange={(event) => selectArtifact(event.target.value)}>{artifacts.map((item) => <option key={item.resourceId} value={item.resourceId}>{item.title}</option>)}</select></label>}
    {content.isError ? <Recovery title="This artifact couldn’t load" retry={() => void content.refetch()} /> : !content.data ? <div className="mobile-empty" role="status">Opening artifact…</div> : resource.kind === 'site'
      ? <HostedSite key={`${resource.resourceId}:${version}`} canvasId={id} resource={content.data} active={active} />
      : <InspectorRail resource={content.data} panel={{ resourceId: resource.resourceId, detached: true, onClose: () => undefined }} loadResourceContent={loadContent} loadOriginalResourceContent={loadOriginal} />}
  </>;
}

function HostedSite({ canvasId, resource, active }: { canvasId: string; resource: WorkstreamResource; active: boolean }) {
  const { api } = useAppSession();
  const native = Boolean(Reflect.get(window, 'ReactNativeWebView'));
  const instance = useId();
  const access = useQuery({ queryKey: ['mobile-site-access', canvasId, resource.id, resource.currentVersion, instance], queryFn: () => api!.openArtifact(resource.id), enabled: active && Boolean(api), staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false });
  useEffect(() => {
    if (!native) return;
    if (active && access.isError) { postMobileEvent({ type: 'artifact-unavailable', canvasId, resourceId: resource.id }); return; }
    if (active && access.data) postMobileEvent({ type: 'artifact', artifact: { canvasId, resourceId: resource.id, version: resource.currentVersion, openUrl: access.data.openUrl, canonicalUrl: access.data.canonicalUrl } });
  }, [native, active, access.data, access.isError, canvasId, resource.id, resource.currentVersion]);
  if (access.isError) return <Recovery title="This canvas couldn’t open" retry={() => void access.refetch()} />;
  // Native uses a first-party WebView; the browser preview frames that same
  // hosted document. Neither surface receives the application's bridge.
  if (!native && access.data) return <iframe className="mobile-hosted-artifact" title={resource.title || 'Canvas artifact'} src={access.data.openUrl} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" />;
  return <div className="mobile-empty" role="status">Opening canvas…</div>;
}

function MobileConversation({ id, describe }: { id: string; describe: (id: string, descriptor: Descriptor) => void }) {
  const detail = useMobileCanvasDetail(id);
  const location = useLocation();
  const scrollToTurn = useMemo(() => mobileTurnTarget(location.search), [location.search]);
  const resource = detail.data?.artifacts[0];
  useEffect(() => {
    if (detail.data) describe(id, { title: detail.data.title, view: 'conversation', artifactId: resource?.resourceId ?? null, artifactPicker: false });
  }, [describe, id, detail.data, resource]);
  return <div className="mobile-conversation-stack">{resource && <button className="mobile-view-canvas" onClick={() => postMobileEvent({ type: 'open-canvas', id })}>View canvas <ArrowUpRight size={15} aria-hidden="true" /></button>}<ConversationSurface parentKind="canvas" parentId={id} substreamId="0" embedded scrollToTurn={scrollToTurn} /></div>;
}

function CreateCanvas({ created }: { created: (id: string) => void }) {
  const { api, session } = useAppSession();
  const [sending, setSending] = useState(false);
  const guest = session?.workspace?.accessClass === 'guest';
  const roster = useWorkspaceMembers(api, { enabled: !guest });
  const members = roster.data ?? [];
  const participants = members.filter((member) => member.id === session?.user.id);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const draftKey = `mobile-canvas:${session?.workspace?.id}:${session?.user.id}:new`;
  const attachments = useFileAttachments(api, draftKey);
  const fileInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ signature: string; operationId: string; workstreamId: string; clientMessageId: string } | null>(null);
  return <div className="mobile-create"><Sparkles size={36} strokeWidth={1.2} /><h1>What would you<br />like to make?</h1><p>A plan, a tiny tool, a space for something you love. Start with an idea.</p>
    <div className="mobile-create-composer"><WorkstreamComposer
      placeholder="Describe what you’d like…" ariaLabel="Describe your canvas" submitLabel="Create canvas" draftKey={draftKey}
      workstream={{ participants, scope: 'personal', harnessStatus: 'completed' }} members={members}
      fileInputRef={fileInput} sending={sending} sendBlocked={sending || (!guest && !roster.data)} uploading={attachments.uploading} attachments={attachments.attachments}
      onAttach={attachments.addFiles} onOpenAttachment={setPreview} onRemoveAttachment={attachments.removeAttachment} onRetryAttachment={attachments.retryAttachment}
      error={failed ? 'Your canvas couldn’t be created. Your draft is safe; try again.' : attachments.error}
      onStop={async () => undefined}
      onSend={async (text, mentions, participantIds = []) => {
        if (!api || sending) return;
        setSending(true); setFailed(false);
        let lease: Awaited<ReturnType<typeof attachments.leaseReady>> | undefined;
        try {
          lease = await attachments.leaseReady();
          const request = { openingMessage: text, mentions, participantIds, attachmentIds: lease.attachments.flatMap((item) => item.resource ? [item.resource.id] : []) };
          const signature = JSON.stringify(request);
          if (attempt.current?.signature !== signature) attempt.current = { signature, operationId: uuidV7(), workstreamId: attempt.current?.workstreamId ?? uuidV7(), clientMessageId: uuidV7() };
          const result = await api.createCanvas({ canvasId: asWorkstreamId(attempt.current.workstreamId) });
          await api.sendConversationMessage(result.canvasId, {
            text, clientMessageId: attempt.current.clientMessageId, attachmentIds: request.attachmentIds, confirmedParticipantUserIds: participantIds,
            mentions: await api.messageMentionPayload(text, mentions, members),
          }, attempt.current.operationId);
          attachments.commitLease(lease.leaseId);
          created(result.canvasId);
        } catch (error) { if (lease) await attachments.restoreLease(lease.leaseId); setFailed(true); throw error; }
        finally { setSending(false); }
      }} />
    </div><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} />
  </div>;
}
function Recovery({ title, retry }: { title: string; retry: () => void }) {
  return <div className="mobile-empty"><ErrorNotice title={title}>Check your connection and try again.</ErrorNotice><button className="mobile-primary" onClick={retry}>Try again</button></div>;
}

function locationAssignWorkspacePicker(): void {
  window.location.assign('/?mobile=1&chooseWorkspace=1');
}
