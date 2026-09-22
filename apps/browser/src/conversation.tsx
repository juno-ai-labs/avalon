import { createQueryClient } from "../../desktop/src/renderer/lib/query-client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { AccountTrigger } from '@rally/ui/components/account-trigger';
import { NavigationRowContent, SidebarNavigationRowContent } from '@rally/ui/components/navigation';
import {
  ResizableSidebar,
  SidebarCollapseFooter,
  SidebarHeader,
  SidebarList,
  SidebarRow,
  SidebarScroll,
  SidebarTitleHeader,
} from '@rally/ui/components/resizable-sidebar';
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSE_DRAG_THRESHOLD,
  SIDEBAR_EXPAND_DRAG_THRESHOLD,
} from '@rally/ui/lib/sidebar-geometry';
import { browserSidebarLayout } from './sidebar-layout';
import { SpaceIcon } from '@rally/ui/components/space-appearance-picker';
import { ConversationHeader } from '@rally/ui/components/conversation-header';
import { WorkstreamSidebar } from '@rally/ui/components/workstream-sidebar';
import { Button, InlineError, Modal } from '@rally/ui/components/primitives';
import { RallyApi } from '../../desktop/src/renderer/lib/api';
import { ShareConversationButton, ShareConversationDialog } from '../../desktop/src/renderer/components/scope-sharing-panel';
import { SidekickPicker } from '../../desktop/src/renderer/components/sidekick-picker';
import { useCollaborationSession, CollaborationSessionProvider } from '../../desktop/src/renderer/lib/collaboration-session';
import { SpeechPlaybackProvider } from '../../desktop/src/renderer/components/speech-playback';
import { ConversationSurface } from '../../desktop/src/renderer/screens/conversation-surface';
import '@rally/ui/styles/app.css';

const SHARED_CHANNELS_SPACE_ID = 'shared-channels';

function useBrowserSidebar(initiallyCompact: boolean): {
  compact: boolean;
  ref: React.RefObject<HTMLElement | null>;
  resize: (requested: number, availableWidth: number) => void;
  setCompact: React.Dispatch<React.SetStateAction<boolean>>;
  toggle: () => void;
  width: number;
} {
  const [compact, setCompact] = useState(initiallyCompact);
  const [width, setWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const ref = useRef<HTMLElement>(null);
  const resize = useCallback((requested: number, availableWidth: number): void => {
    if (compact) {
      if (requested < SIDEBAR_EXPAND_DRAG_THRESHOLD || availableWidth < MIN_SIDEBAR_WIDTH) return;
      setWidth(Math.min(MAX_SIDEBAR_WIDTH, availableWidth, Math.max(MIN_SIDEBAR_WIDTH, requested)));
      setCompact(false);
      return;
    }
    if (requested < SIDEBAR_COLLAPSE_DRAG_THRESHOLD) {
      setCompact(true);
      return;
    }
    if (availableWidth < MIN_SIDEBAR_WIDTH) return;
    setWidth(Math.min(MAX_SIDEBAR_WIDTH, availableWidth, Math.max(MIN_SIDEBAR_WIDTH, requested)));
  }, [compact]);
  const toggle = useCallback(() => setCompact((current) => !current), []);
  return {
    compact,
    ref,
    resize,
    setCompact,
    toggle,
    width,
  };
}

function SharedConversationRoute(): React.JSX.Element {
  const { parentId, substreamId = '0' } = useParams();
  return <SharedConversation key={`${parentId}:${substreamId}`} />;
}

function SharedConversation(): React.JSX.Element {
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
  if (!parentId) return <section className="browser-empty"><p>This conversation link is incomplete.</p></section>;
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
    {archived ? <section className="browser-empty"><h1>{parentArchived ? 'Archived channel' : 'Archived conversation'}</h1>
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
          onSidekickMenuOpen={context.loadSidekickOptions} onRefreshSidekicks={context.refreshSidekicks}
          addSidekick={<SidekickPicker workstreamId={parentId} substreamId={substreamId} />} />}
        renderHeader={(context) => <ConversationHeader grokBotMode workstream={context.detail} socketState={context.socketState}
          substreamId={substreamId} currentUserId={session?.user.id} presentUserIds={context.presentUserIds}
          onAddParticipant={context.openParticipantDialog} onOpenRail={context.openRail}
          onRename={async (title) => { await context.rename(title); void queryClient.invalidateQueries({ queryKey: ['shared-navigation'] }); }}
          onShowNavigation={() => undefined}
          onCopyLink={() => { void navigator.clipboard.writeText(location.href); }}
          actions={api && session?.workspace ? <ShareConversationButton api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={substreamId} /> : null} />} />}
  </>;
}

function SharedNavigation({ api, onSignOut }: { api: RallyApi; onSignOut: () => void }): React.JSX.Element {
  const { session } = useCollaborationSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const directory = useQuery({ queryKey: ['shared-navigation'], queryFn: ({ signal }) => api.getSharedNavigationDirectory(signal), refetchOnWindowFocus: 'always' });
  const routeParentId = pathname.match(/^\/workstreams\/([^/]+)/u)?.[1] ?? null;
  const spacesSidebar = useBrowserSidebar(Boolean(routeParentId));
  const channelsSidebar = useBrowserSidebar(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const sidebarLayout = browserSidebarLayout({
    channelOpen: routeParentId !== null,
    channelsCollapsed: channelsSidebar.compact,
    channelsPreferredWidth: channelsSidebar.width,
    spacesCollapsed: spacesSidebar.compact,
    spacesPreferredWidth: spacesSidebar.width,
    viewportWidth,
  });
  const spacesDisplayedCompact = spacesSidebar.compact || sidebarLayout.spacesConstrained;
  const channelsDisplayedCompact = channelsSidebar.compact || sidebarLayout.channelsConstrained;
  useEffect(() => {
    const measure = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const navigationSpaces = useMemo(() => {
    const spaces = directory.data?.spaces ?? [];
    const placedWorkstreamIds = new Set(spaces.flatMap((space) => space.workstreamIds));
    const unplacedWorkstreamIds = (directory.data?.workstreams ?? [])
      .map((workstream) => workstream.parentId)
      .filter((parentId) => !placedWorkstreamIds.has(parentId));
    return unplacedWorkstreamIds.length === 0 ? spaces : [...spaces, {
      id: SHARED_CHANNELS_SPACE_ID,
      name: 'Shared channels',
      iconKey: 'users' as const,
      colorKey: 'blue' as const,
      workstreamIds: unplacedWorkstreamIds,
    }];
  }, [directory.data]);
  useEffect(() => {
    setSelectedSpaceId((current) => {
      if (routeParentId) {
        const currentSpace = navigationSpaces.find((space) =>
          space.id === current && space.workstreamIds.includes(routeParentId));
        if (currentSpace) return currentSpace.id;
        const routeSpace = navigationSpaces.find((space) => space.workstreamIds.includes(routeParentId));
        if (routeSpace) return routeSpace.id;
      }
      return navigationSpaces.some((space) => space.id === current) ? current : navigationSpaces[0]?.id ?? null;
    });
  }, [navigationSpaces, routeParentId]);
  useEffect(() => {
    if (!routeParentId) {
      spacesSidebar.setCompact(false);
      return;
    }
    spacesSidebar.setCompact(true);
  }, [routeParentId, spacesSidebar.setCompact]);
  useLayoutEffect(() => {
    const shell = spacesSidebar.ref.current?.closest<HTMLElement>('.workspace-shell');
    if (!shell) return undefined;
    shell.style.setProperty('--spaces-sidebar-width', `${sidebarLayout.spacesWidth}px`);
    return () => { shell.style.removeProperty('--spaces-sidebar-width'); };
  }, [sidebarLayout.spacesWidth, spacesSidebar.ref]);
  useLayoutEffect(() => {
    const shell = channelsSidebar.ref.current?.closest<HTMLElement>('.workspace-shell');
    if (!shell) return undefined;
    shell.style.setProperty('--av-cmp-sidebar-width', `${sidebarLayout.channelsWidth}px`);
    return () => { shell.style.removeProperty('--av-cmp-sidebar-width'); };
  }, [channelsSidebar.ref, sidebarLayout.channelsWidth]);
  if (!session) return <></>;
  const user = { ...session.user, name: session.user.name ?? session.user.email, timezone: session.user.timezone ?? 'UTC', avatarUrl: session.user.avatarUrl ?? undefined };
  const selectedSpace = navigationSpaces.find((space) => space.id === selectedSpaceId) ?? navigationSpaces[0];
  const workstreams = directory.data?.workstreams.filter((workstream) => selectedSpace?.workstreamIds.includes(workstream.parentId)) ?? [];
  const openWorkstream = (parentId: string) => {
    const workstream = directory.data?.workstreams.find((item) => item.parentId === parentId);
    const first = workstream?.conversations.find((item) => !item.archived) ?? workstream?.conversations[0];
    if (!first) return;
    spacesSidebar.setCompact(true);
    const targetPath = `/workstreams/${parentId}${first.substreamId === '0' ? '' : `/substreams/${first.substreamId}`}`;
    if (pathname !== targetPath) navigate(targetPath);
  };
  const selectSpace = (spaceId: string) => {
    setSelectedSpaceId(spaceId);
    const space = navigationSpaces.find((item) => item.id === spaceId);
    const containedWorkstreams = space?.workstreamIds
      .map((id) => directory.data?.workstreams.find((item) => item.parentId === id))
      .filter((item) => item !== undefined) ?? [];
    const firstActive = containedWorkstreams.find((workstream) =>
      !workstream.archived && workstream.conversations.some((conversation) => !conversation.archived));
    const target = firstActive ?? containedWorkstreams[0];
    spacesSidebar.setCompact(true);
    if (target) openWorkstream(target.parentId);
  };
  return <>
    <ResizableSidebar
      aria-label="Spaces sidebar"
      className="spaces-sidebar browser-spaces-sidebar"
      compact={spacesDisplayedCompact}
      constrained={sidebarLayout.spacesConstrained}
      onResize={(requested) => spacesSidebar.resize(requested, sidebarLayout.spacesAvailableWidth)}
      onToggle={spacesSidebar.toggle}
      resizeLabel="Resize spaces sidebar"
      sidebarRef={spacesSidebar.ref}
      width={sidebarLayout.spacesWidth}
    >
      <SidebarHeader className="spaces-sidebar-titlebar">
      </SidebarHeader>
      <SidebarScroll as="nav" aria-label="Shared spaces" className="spaces-sidebar-scroll">
        <SidebarList>
          {directory.isError && <InlineError>Unable to load shared conversations.</InlineError>}
          {directory.isPending && <p className="spaces-sidebar-empty">Loading spaces…</p>}
          {directory.data && navigationSpaces.length === 0 && <p className="spaces-sidebar-empty">No shared spaces yet.</p>}
          {navigationSpaces.map((space) => <SidebarRow aria-label={space.name}
            aria-pressed={space.id === selectedSpace?.id}
            className={`spaces-sidebar-row browser-space-row${space.id === selectedSpace?.id ? ' is-active' : ''}`}
            key={space.id} onClick={() => selectSpace(space.id)} type="button">
            <SidebarNavigationRowContent
              description={space.workstreamIds.length === 1 ? '1 channel' : `${space.workstreamIds.length} channels`}
              icon={<span className="spaces-sidebar-mark"><SpaceIcon size={22} space={space} /></span>}
              title={space.name}
            />
          </SidebarRow>)}
        </SidebarList>
      </SidebarScroll>
      <SidebarCollapseFooter
        collapseLabel="Collapse spaces"
        compact={spacesDisplayedCompact}
        constrained={sidebarLayout.spacesConstrained}
        constrainedTitle="Widen the window to expand spaces"
        expandLabel="Expand spaces"
        leading={<div className="spaces-account-slot"><DropdownMenu.Root><DropdownMenu.Trigger asChild>
          <AccountTrigger currentUser={user} workspaceName={session.workspace?.name ?? 'Organization'} />
        </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content workspace-menu" align="start" sideOffset={8}>
          <DropdownMenu.Item className="menu-item" onSelect={() => location.assign('/')}>Switch organization</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>Sign out</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>}
        onToggle={spacesSidebar.toggle}
      />
    </ResizableSidebar>
    <ResizableSidebar
      aria-label="Rally navigation"
      className="sidebar channels-sidebar browser-channels-sidebar"
      compact={channelsDisplayedCompact}
      constrained={sidebarLayout.channelsConstrained}
      data-sidebar-collapsed={channelsDisplayedCompact ? '' : undefined}
      onResize={(requested) => channelsSidebar.resize(requested, sidebarLayout.channelsAvailableWidth)}
      onToggle={channelsSidebar.toggle}
      resizeLabel="Resize navigation"
      sidebarRef={channelsSidebar.ref}
      width={sidebarLayout.channelsWidth}
    >
      {selectedSpace ? <SidebarTitleHeader
        className="sidebar-titlebar channels-sidebar-titlebar window-drag"
        icon={<SpaceIcon size={20} space={selectedSpace} />}
        title={selectedSpace.name}
        titleClassName="channels-sidebar-title"
      >
      </SidebarTitleHeader> : <SidebarHeader className="sidebar-titlebar channels-sidebar-titlebar window-drag">
      </SidebarHeader>}
      <SidebarScroll><SidebarList as="nav" aria-label="Shared channels">
      {!directory.isPending && selectedSpace && workstreams.length === 0 && <p>No shared channels in this space.</p>}
      {workstreams.map((workstream) => {
        const first = workstream.conversations.find((item) => !item.archived) ?? workstream.conversations[0];
        if (!first) return null;
        return <SidebarRow as={NavLink} className={`workstream-row${pathname === `/workstreams/${workstream.parentId}` || pathname.startsWith(`/workstreams/${workstream.parentId}/`) ? ' is-active' : ''}`} onClick={() => {
          spacesSidebar.setCompact(true);
        }} key={workstream.parentId} to={`/workstreams/${workstream.parentId}${first.substreamId === '0' ? '' : `/substreams/${first.substreamId}`}`}>
          <NavigationRowContent id={workstream.parentId} title={workstream.title ?? first.title} appearance={workstream.appearance ?? undefined} />
        </SidebarRow>;
      })}
      </SidebarList></SidebarScroll>
      <SidebarCollapseFooter
        collapseLabel="Collapse navigation"
        compact={channelsDisplayedCompact}
        constrained={sidebarLayout.channelsConstrained}
        constrainedTitle="Widen the window to expand navigation"
        expandLabel="Expand navigation"
        onToggle={channelsSidebar.toggle}
      />
    </ResizableSidebar>
  </>;
}

function BrowserWorkspace({ api, onSignOut }: { api: RallyApi; onSignOut: () => void }): React.JSX.Element {
  const [unsupportedWidth, setUnsupportedWidth] = useState(() => matchMedia('(max-width: 920px)').matches);
  useEffect(() => {
    const query = matchMedia('(max-width: 920px)');
    const update = () => setUnsupportedWidth(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  if (unsupportedWidth) return <main className="browser-width-warning">
    <section role="status">
      <h1>Make this window wider</h1>
      <p>Shared conversations aren’t supported at this width yet.</p>
    </section>
  </main>;
  return <div className="browser-workspace workspace-shell">
    <SharedNavigation api={api} onSignOut={onSignOut} />
    <main className="browser-feed main-pane"><Routes>
      <Route path="/workstreams/:parentId" element={<SharedConversationRoute />} />
      <Route path="/workstreams/:parentId/substreams/:substreamId" element={<SharedConversationRoute />} />
      <Route path="*" element={<div className="browser-empty"><h1>Shared conversations</h1><p>Choose a conversation to start collaborating.</p></div>} />
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
