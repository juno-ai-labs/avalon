import { createQueryClient } from "../../desktop/src/renderer/lib/query-client";
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Menu } from 'lucide-react';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { AccountTrigger } from '@rally/ui/components/account-trigger';
import { NavigationFrame, NavigationRowContent } from '@rally/ui/components/navigation';
import { SpaceIcon } from '@rally/ui/components/space-appearance-picker';
import { ConversationHeader } from '@rally/ui/components/conversation-header';
import { WorkstreamSidebar } from '@rally/ui/components/workstream-sidebar';
import { Button, IconButton, InlineError, Modal } from '@rally/ui/components/primitives';
import { RallyApi } from '../../desktop/src/renderer/lib/api';
import { ShareConversationButton, ShareConversationDialog } from '../../desktop/src/renderer/components/scope-sharing-panel';
import { SidekickPicker } from '../../desktop/src/renderer/components/sidekick-picker';
import { useCollaborationSession, CollaborationSessionProvider } from '../../desktop/src/renderer/lib/collaboration-session';
import { SpeechPlaybackProvider } from '../../desktop/src/renderer/components/speech-playback';
import { ConversationSurface } from '../../desktop/src/renderer/screens/conversation-surface';
import '@rally/ui/styles/app.css';

function SharedConversationRoute({ onShowNavigation }: { onShowNavigation: () => void }): React.JSX.Element {
  const { parentId, substreamId = '0' } = useParams();
  return <SharedConversation key={`${parentId}:${substreamId}`} onShowNavigation={onShowNavigation} />;
}

function SharedConversation({ onShowNavigation }: { onShowNavigation: () => void }): React.JSX.Element {
  const { parentId, substreamId = '0' } = useParams();
  const navigate = useNavigate();
  const { api, session } = useCollaborationSession();
  const queryClient = useQueryClient();
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [sharingSubstream, setSharingSubstream] = useState<string | null>(null);
  const [changingArchive, setChangingArchive] = useState(false);
  const [archiveFailure, setArchiveFailure] = useState<'archive' | 'restore' | null>(null);
  const directory = useQuery({ queryKey: ['shared-navigation'], enabled: Boolean(api),
    queryFn: ({ signal }) => api!.getSharedNavigationDirectory(signal), refetchOnWindowFocus: 'always' });
  const parent = directory.data?.workstreams.find((item) => item.parentId === parentId);
  const archived = parent?.conversations.find((item) => item.substreamId === substreamId)?.archived ?? false;
  const parentArchived = parent?.archived === true || (substreamId === '0' && archived);
  if (!parentId) return <section className="browser-empty"><NavigationButton onClick={onShowNavigation} /><p>This conversation link is incomplete.</p></section>;
  const changeArchive = async (value: boolean, target = substreamId) => {
    if (!api || changingArchive) return;
    setChangingArchive(true); setArchiveFailure(null);
    try {
      await api.setSubstreamArchived(parentId, target, value);
      await queryClient.invalidateQueries({ queryKey: ['shared-navigation'] });
    } catch { setArchiveFailure(value ? 'archive' : 'restore'); }
    finally { setChangingArchive(false); }
  };
  return <>
    {api && session?.workspace && sharingSubstream !== null && <ShareConversationDialog api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={sharingSubstream} open onOpenChange={(open) => { if (!open) setSharingSubstream(null); }} />}
    <Modal open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }} title="Archive breakout" description="This breakout will leave the active list. You can restore it later.">
      <Button disabled={changingArchive} onClick={() => setArchiveTarget(null)}>Cancel</Button>
      <Button disabled={changingArchive} onClick={() => { void changeArchive(true, archiveTarget ?? substreamId).then(() => setArchiveTarget(null)); }}>Archive breakout</Button>
    </Modal>
    {archiveFailure ? <InlineError>{archiveFailure === 'archive'
      ? 'The breakout couldn’t be archived.'
      : 'The breakout couldn’t be restored.'}</InlineError> : null}
    {archived ? <section className="browser-empty"><NavigationButton onClick={onShowNavigation} /><h1>{parentArchived ? 'Archived channel' : 'Archived conversation'}</h1>
      {parentArchived ? <p>This channel must be restored before its conversations can reopen.</p>
        : substreamId !== '0' && parent?.archived !== true
          ? <Button disabled={changingArchive} onClick={() => void changeArchive(false)}>Restore breakout</Button>
          : <p>This conversation is archived.</p>}</section> :
      <ConversationSurface sidebarScope="conversation" parentKind="workstream" parentId={parentId} substreamId={substreamId}
        renderSidebar={(context) => <WorkstreamSidebar
          mainVisible={Boolean(parent?.conversations.some((item) => item.substreamId === '0'))}
          workstream={{ ...context.detail, title: parent?.title ?? 'Shared channel',
            privateChildren: parent?.conversations.filter((item) => item.substreamId !== '0' && !item.archived) }}
          mainActions={{ onShare: (target) => setSharingSubstream(target.substreamId) }}
          substreamActions={{ onShare: (target) => setSharingSubstream(target.substreamId), onArchive: (target) => setArchiveTarget(target.substreamId) }}
          selectedSubstreamId={substreamId} presentUserIds={context.presentUserIds}
          onSelectSubstream={(id) => navigate(`/workstreams/${parentId}${id === '0' ? '' : `/substreams/${id}`}`)}
          onParticipants={context.openParticipantDialog} onFocusTranscript={context.focusTranscript}
          onOpenArtifact={context.openArtifact} onOpenResource={context.openResource} sidekicks={context.sidekicks} sidekickFailure={context.sidekickFailure}
          onSidekickMenuOpen={context.loadSidekickOptions}
          addSidekick={<SidekickPicker workstreamId={parentId} substreamId={substreamId} />} />}
        renderHeader={(context) => <ConversationHeader grokBotMode workstream={context.detail} socketState={context.socketState}
          substreamId={substreamId} currentUserId={session?.user.id} presentUserIds={context.presentUserIds}
          onAddParticipant={context.openParticipantDialog} onOpenRail={context.openRail}
          onRename={async (title) => { await context.rename(title); void queryClient.invalidateQueries({ queryKey: ['shared-navigation'] }); }}
          onShowNavigation={onShowNavigation}
          onCopyLink={() => { void navigator.clipboard.writeText(location.href); }}
          actions={api && session?.workspace ? <ShareConversationButton api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={substreamId} /> : null} />} />}
  </>;
}

function SharedNavigation({ api, onSignOut, open, onClose }: { api: RallyApi; onSignOut: () => void; open: boolean; onClose: () => void }): React.JSX.Element {
  const { session } = useCollaborationSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const directory = useQuery({ queryKey: ['shared-navigation'], queryFn: ({ signal }) => api.getSharedNavigationDirectory(signal), refetchOnWindowFocus: 'always' });
  const routeParentId = pathname.match(/^\/workstreams\/([^/]+)/u)?.[1] ?? null;
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  useEffect(() => {
    const spaces = directory.data?.spaces ?? [];
    if (routeParentId) {
      const routeSpace = spaces.find((space) => space.workstreamIds.includes(routeParentId));
      if (routeSpace) { setSelectedSpaceId(routeSpace.id); return; }
    }
    setSelectedSpaceId((current) => spaces.some((space) => space.id === current) ? current : spaces[0]?.id ?? null);
  }, [directory.data?.spaces, routeParentId]);
  if (!session) return <></>;
  const user = { ...session.user, name: session.user.name ?? session.user.email, timezone: session.user.timezone ?? 'UTC', avatarUrl: session.user.avatarUrl ?? undefined };
  const selectedSpace = directory.data?.spaces.find((space) => space.id === selectedSpaceId) ?? directory.data?.spaces[0];
  const workstreams = directory.data?.workstreams.filter((workstream) => selectedSpace?.workstreamIds.includes(workstream.parentId)) ?? [];
  const openWorkstream = (parentId: string) => {
    const workstream = directory.data?.workstreams.find((item) => item.parentId === parentId);
    const first = workstream?.conversations.find((item) => !item.archived) ?? workstream?.conversations[0];
    if (!first) return;
    navigate(`/workstreams/${parentId}${first.substreamId === '0' ? '' : `/substreams/${first.substreamId}`}`);
    onClose();
  };
  const selectSpace = (spaceId: string) => {
    setSelectedSpaceId(spaceId);
    const space = directory.data?.spaces.find((item) => item.id === spaceId);
    const firstParentId = space?.workstreamIds.find((id) => directory.data?.workstreams.some((item) => item.parentId === id));
    if (firstParentId) openWorkstream(firstParentId);
  };
  return <>
    <aside aria-label="Spaces sidebar" className={`spaces-sidebar browser-spaces-sidebar${open ? ' is-mobile-open' : ''}`}>
      <div className="spaces-sidebar-titlebar"><span>Spaces</span></div>
      <nav aria-label="Shared spaces" className="spaces-sidebar-scroll">
        {directory.isError && <InlineError>Unable to load shared conversations.</InlineError>}
        {directory.isPending && <p className="spaces-sidebar-empty">Loading spaces…</p>}
        {directory.data?.spaces.length === 0 && <p className="spaces-sidebar-empty">No shared spaces yet.</p>}
        {directory.data?.spaces.map((space) => <button aria-label={space.name}
          className={`spaces-sidebar-row browser-space-row${space.id === selectedSpace?.id ? ' is-active' : ''}`}
          key={space.id} onClick={() => selectSpace(space.id)} type="button">
          <span className="spaces-sidebar-mark"><SpaceIcon size={22} space={space} /></span>
          <span className="spaces-sidebar-copy"><strong>{space.name}</strong>
            <small>{space.workstreamIds.length === 1 ? '1 channel' : `${space.workstreamIds.length} channels`}</small></span>
        </button>)}
      </nav>
      <footer className="spaces-sidebar-footer"><div className="spaces-account-slot"><DropdownMenu.Root><DropdownMenu.Trigger asChild>
        <AccountTrigger currentUser={user} workspaceName={session.workspace?.name ?? 'Organization'} />
      </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content workspace-menu" align="start" sideOffset={8}>
        <DropdownMenu.Item className="menu-item" onSelect={() => location.assign('/')}>Switch organization</DropdownMenu.Item>
        <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>Sign out</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div></footer>
    </aside>
    <NavigationFrame className={`channels-sidebar browser-channels-sidebar${open ? ' is-mobile-open' : ''}`}>
      <div className="sidebar-titlebar channels-sidebar-titlebar window-drag">
        {selectedSpace && <h2 className="channels-sidebar-title">{selectedSpace.name}</h2>}
        <IconButton className="mobile-only browser-navigation-close" label="Close navigation"
          onClick={onClose}><Menu size={16} /></IconButton>
      </div>
      <div className="sidebar-scroll"><nav aria-label="Shared channels" className="sidebar-section">
      {!directory.isPending && selectedSpace && workstreams.length === 0 && <p>No shared channels in this space.</p>}
      {workstreams.map((workstream) => {
        const first = workstream.conversations.find((item) => !item.archived) ?? workstream.conversations[0];
        if (!first) return null;
        return <NavLink className={`sidebar-row workstream-row${pathname === `/workstreams/${workstream.parentId}` || pathname.startsWith(`/workstreams/${workstream.parentId}/`) ? ' is-active' : ''}`} onClick={onClose} key={workstream.parentId}
          to={`/workstreams/${workstream.parentId}${first.substreamId === '0' ? '' : `/substreams/${first.substreamId}`}`}>
          <NavigationRowContent id={workstream.parentId} title={workstream.title ?? first.title} appearance={workstream.appearance ?? undefined} />
        </NavLink>;
      })}
      </nav></div>
    </NavigationFrame>
  </>;
}

function NavigationButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return <IconButton className="mobile-only" label="Show navigation" onClick={onClick}><Menu size={16} /></IconButton>;
}

function BrowserWorkspace({ api, onSignOut }: { api: RallyApi; onSignOut: () => void }): React.JSX.Element {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 920px)').matches);
  useEffect(() => {
    const query = matchMedia('(max-width: 920px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const { pathname } = useLocation();
  useEffect(() => { setNavigationOpen(false); }, [pathname]);
  const showNavigation = () => setNavigationOpen((open) => !open);
  return <div className="browser-workspace workspace-shell">
    {mobile ? <Dialog.Root open={navigationOpen} onOpenChange={setNavigationOpen}><Dialog.Portal>
      <Dialog.Overlay className="browser-navigation-scrim" />
      <Dialog.Content className="browser-navigation-dialog browser-workspace workspace-shell" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">Navigation</Dialog.Title>
        <SharedNavigation api={api} onSignOut={onSignOut} open onClose={() => setNavigationOpen(false)} />
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root> : <SharedNavigation api={api} onSignOut={onSignOut} open={false} onClose={() => setNavigationOpen(false)} />}
    <main className="browser-feed main-pane"><Routes>
      <Route path="/workstreams/:parentId" element={<SharedConversationRoute onShowNavigation={showNavigation} />} />
      <Route path="/workstreams/:parentId/substreams/:substreamId" element={<SharedConversationRoute onShowNavigation={showNavigation} />} />
      <Route path="*" element={<div className="browser-empty"><NavigationButton onClick={showNavigation} /><h1>Shared conversations</h1><p>Choose a conversation to start collaborating.</p></div>} />
    </Routes></main>
  </div>;
}

/** A tab owns only its visible feed. It never installs the desktop socket swarm. */
export default function BrowserConversation({ session, onSignOut }: { session: CookieClientSession; onSignOut: () => void }): React.JSX.Element {
  const [queryClient] = useState(() => createQueryClient());
  // Metadata/expiry reconciliation must preserve pending commands and the live socket.
  const api = useMemo(() => new RallyApi(session.apiBaseUrl, session), [
    session.apiBaseUrl, session.user.id, session.workspace?.id, session.workspace?.region,
    session.workspace?.role, session.workspace?.accessClass,
  ]);
  useLayoutEffect(() => { api.setSession(session); }, [api, session]);
  if (!session.workspace) return <p>Open a shared conversation to continue.</p>;
  const basename = `/app/workspaces/${session.workspace.region}/${session.workspace.id}`;
  return <QueryClientProvider client={queryClient}>
    <CollaborationSessionProvider api={api} session={session}>
      <Tooltip.Provider><SpeechPlaybackProvider api={api}>
        <BrowserRouter basename={basename}><BrowserWorkspace api={api} onSignOut={onSignOut} /></BrowserRouter>
      </SpeechPlaybackProvider></Tooltip.Provider>
    </CollaborationSessionProvider>
  </QueryClientProvider>;
}
