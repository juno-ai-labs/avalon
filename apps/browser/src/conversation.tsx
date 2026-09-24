import { createQueryClient } from "../../desktop/src/renderer/lib/query-client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { uuidFromBase58, uuidToBase58 } from '@rally/contracts/uuid-base58';
import { watchWorkspaceReach } from '@rally/contracts/workspace-reach-watch';
import { workstreamCanonicalUrl } from '@rally/contracts/workstream-links';
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
  const { spaceId, parentId, substreamId = '0' } = useParams();
  const canonical = useLocation().pathname.startsWith('/s/');
  const decodedSpaceId = canonical ? uuidFromBase58(spaceId ?? '') : null;
  const decodedParentId = canonical ? uuidFromBase58(parentId ?? '') : parentId;
  const decodedSubstreamId = canonical && substreamId !== '0' ? uuidFromBase58(substreamId) : substreamId;
  if (!decodedParentId || !decodedSubstreamId || (canonical && !decodedSpaceId)) return <InlineError>This link is invalid.</InlineError>;
  return <SharedConversation key={`${decodedParentId}:${decodedSubstreamId}`} parentId={decodedParentId} substreamId={decodedSubstreamId} spaceId={decodedSpaceId} />;
}

function SharedSpaceRoute(): React.JSX.Element {
  const { spaceId: encodedSpaceId } = useParams();
  const { api } = useCollaborationSession();
  const directory = useQuery({ queryKey: ['shared-navigation'], queryFn: ({ signal }) => api!.getSharedNavigationDirectory(signal), enabled: Boolean(api) });
  if (directory.isPending) return <div className="browser-empty"><p>Opening Space…</p></div>;
  if (directory.isError) return <InlineError>Unable to open this Space.</InlineError>;
  return <SharedSpaceOverview encodedSpaceId={encodedSpaceId ?? ''} directory={directory.data} />;
}

export function SharedSpaceOverview({ encodedSpaceId, directory }: {
  encodedSpaceId: string;
  directory: Awaited<ReturnType<RallyApi['getSharedNavigationDirectory']>>;
}): React.JSX.Element {
  const spaceId = uuidFromBase58(encodedSpaceId);
  if (!spaceId) return <InlineError>This Space link is invalid.</InlineError>;
  const space = directory.spaces.find((item) => item.id === spaceId);
  if (!space) return <InlineError>This Space is not available to you.</InlineError>;
  const channels = space.workstreamIds
    .map((id) => directory.workstreams.find((item) => item.parentId === id))
    .filter((item) => item !== undefined);
  return <div className="browser-empty browser-space-overview">
    <h1>{space.name}</h1>
    <p>{channels.length === 0 ? 'There are no shared channels in this Space.' : 'Channels in this Space'}</p>
    {channels.length > 0 && <nav aria-label={`Channels in ${space.name}`}><ul>{channels.map((channel) => {
      const first = channel.conversations.find((item) => !item.archived) ?? channel.conversations[0];
      return first && <li key={channel.parentId}><NavLink to={sharedConversationPath(spaceId, channel.parentId, first.substreamId)}>{channel.title ?? first.title}</NavLink></li>;
    })}</ul></nav>}
  </div>;
}

function sharedConversationPath(spaceId: string | null, parentId: string, substreamId: string): string {
  return spaceId
    ? `/s/${uuidToBase58(spaceId)}/c/${uuidToBase58(parentId)}${substreamId === '0' ? '' : `/b/${uuidToBase58(substreamId)}`}`
    : `/workstreams/${parentId}${substreamId === '0' ? '' : `/substreams/${substreamId}`}`;
}

export function sharedConversationShareUrl(region: string, organizationId: string, directory: Awaited<ReturnType<RallyApi['getSharedNavigationDirectory']>> | undefined, selectedSpaceId: string | null, parentId: string, substreamId: string): string {
  const availableSpaces = directory?.spaces.filter((space) => space.workstreamIds.includes(parentId)) ?? [];
  const space = availableSpaces.find((item) => item.id === selectedSpaceId)
    ?? [...availableSpaces].sort((a, b) => Number(a.scope === 'personal') - Number(b.scope === 'personal') || a.id.localeCompare(b.id))[0];
  if (space) return workstreamCanonicalUrl('https://rallywith.ai', {
    region, workspaceId: organizationId, spaceId: space.id, workstreamId: parentId,
    ...(substreamId === '0' ? {} : { substreamId }),
  });
  return new URL(`/app/workspaces/${region}/${organizationId}${sharedConversationPath(null, parentId, substreamId)}`, 'https://rallywith.ai').toString();
}

function SharedConversation({ parentId, substreamId, spaceId }: { parentId: string; substreamId: string; spaceId: string | null }): React.JSX.Element {
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
            scope: parent?.scope ?? context.detail.scope,
            privateChildren: parent?.conversations.filter((item) => item.substreamId !== '0' && !item.archived) }}
          mainActions={{ onShare: (target) => setSharingSubstream(target.substreamId) }}
          substreamActions={{ onShare: (target) => setSharingSubstream(target.substreamId), onArchive: (target) => setArchiveTarget(target.substreamId) }}
          selectedSubstreamId={substreamId} presentUserIds={context.presentUserIds}
          onSelectSubstream={(id) => navigate(sharedConversationPath(spaceId, parentId, id))}
          onParticipants={context.openParticipantDialog} onFocusTranscript={context.focusTranscript}
          onOpenArtifact={context.openArtifact} onOpenResource={context.openResource} sidekicks={context.sidekicks} sidekickFailure={context.sidekickFailure}
          onSidekickMenuOpen={context.loadSidekickOptions} onRefreshSidekicks={context.refreshSidekicks}
          addSidekick={<SidekickPicker workstreamId={parentId} substreamId={substreamId} />} />}
        renderHeader={(context) => <ConversationHeader grokBotMode workstream={context.detail} socketState={context.socketState}
          substreamId={substreamId} currentUserId={session?.user.id} presentUserIds={context.presentUserIds}
          onAddParticipant={context.openParticipantDialog} onOpenRail={context.openRail}
          onRename={async (title) => { await context.rename(title); void queryClient.invalidateQueries({ queryKey: ['shared-navigation'] }); }}
          onShowNavigation={() => undefined}
          onCopyLink={() => {
            if (!session?.workspace) return;
            const url = sharedConversationShareUrl(session.workspace.region, session.workspace.id, directory.data, spaceId, parentId, substreamId);
            void navigator.clipboard.writeText(url);
          }}
          actions={api && session?.workspace ? <ShareConversationButton api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={substreamId} /> : null} />} />}
  </>;
}

function SharedNavigation({ api, onSignOut }: { api: RallyApi; onSignOut: () => void }): React.JSX.Element {
  const { session } = useCollaborationSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const canonicalHost = !location.pathname.startsWith('/app/workspaces/');
  const directory = useQuery({ queryKey: ['shared-navigation'], queryFn: ({ signal }) => api.getSharedNavigationDirectory(signal), refetchOnWindowFocus: 'always' });
  const legacyParentId = pathname.match(/^\/workstreams\/([^/]+)/u)?.[1] ?? null;
  const canonicalRoute = /^\/s\/([^/]+)(?:\/c\/([^/]+))?/u.exec(pathname);
  const routeParentId = legacyParentId ?? (canonicalRoute?.[2] ? uuidFromBase58(canonicalRoute[2]) : null);
  const spacesSidebar = useBrowserSidebar(Boolean(routeParentId));
  const channelsSidebar = useBrowserSidebar(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(() => canonicalRoute ? uuidFromBase58(canonicalRoute[1]!) : null);
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
      scope: null,
      workstreamIds: unplacedWorkstreamIds,
    }];
  }, [directory.data]);
  useEffect(() => {
    setSelectedSpaceId((current) => {
      const routeSpaceId = canonicalRoute ? uuidFromBase58(canonicalRoute[1]!) : null;
      if (routeSpaceId && navigationSpaces.some((space) => space.id === routeSpaceId)) return routeSpaceId;
      if (routeParentId) {
        const currentSpace = navigationSpaces.find((space) =>
          space.id === current && space.workstreamIds.includes(routeParentId));
        if (currentSpace) return currentSpace.id;
        const routeSpace = navigationSpaces.find((space) => space.workstreamIds.includes(routeParentId));
        if (routeSpace) return routeSpace.id;
      }
      return navigationSpaces.some((space) => space.id === current) ? current : navigationSpaces[0]?.id ?? null;
    });
  }, [navigationSpaces, routeParentId, pathname]);
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
  const openWorkstream = (parentId: string, requestedSpaceId = selectedSpaceId) => {
    const workstream = directory.data?.workstreams.find((item) => item.parentId === parentId);
    const first = workstream?.conversations.find((item) => !item.archived) ?? workstream?.conversations[0];
    if (!first) return;
    spacesSidebar.setCompact(true);
    const spaceId = canonicalHost && requestedSpaceId && requestedSpaceId !== SHARED_CHANNELS_SPACE_ID ? requestedSpaceId : null;
    const targetPath = sharedConversationPath(spaceId, parentId, first.substreamId);
    if (pathname !== targetPath) navigate(targetPath);
  };
  const selectSpace = (spaceId: string) => {
    setSelectedSpaceId(spaceId);
    if (canonicalHost && spaceId !== SHARED_CHANNELS_SPACE_ID) {
      spacesSidebar.setCompact(false);
      navigate(`/s/${uuidToBase58(spaceId)}/`);
      return;
    }
    const space = navigationSpaces.find((item) => item.id === spaceId);
    const containedWorkstreams = space?.workstreamIds
      .map((id) => directory.data?.workstreams.find((item) => item.parentId === id))
      .filter((item) => item !== undefined) ?? [];
    const firstActive = containedWorkstreams.find((workstream) =>
      !workstream.archived && workstream.conversations.some((conversation) => !conversation.archived));
    const target = firstActive ?? containedWorkstreams[0];
    spacesSidebar.setCompact(true);
    if (target) openWorkstream(target.parentId, spaceId);
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
          {navigationSpaces.map((space) => {
            const description = space.scope === null
              ? space.workstreamIds.length === 1 ? '1 channel' : `${space.workstreamIds.length} channels`
              : `${space.scope === 'workspace' ? 'Public' : 'Private'} · ${space.workstreamIds.length === 1 ? '1 channel' : `${space.workstreamIds.length} channels`}`;
            return <SidebarRow aria-label={space.name} aria-description={description}
            aria-pressed={space.id === selectedSpace?.id}
            className={`spaces-sidebar-row browser-space-row${space.id === selectedSpace?.id ? ' is-active' : ''}`}
            key={space.id} onClick={() => selectSpace(space.id)} type="button">
            <SidebarNavigationRowContent
              activity={description}
              icon={<span className="spaces-sidebar-mark"><SpaceIcon size={22} space={space} /></span>}
              title={space.name}
            />
          </SidebarRow>;
          })}
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
        const rowPath = sharedConversationPath(canonicalHost && selectedSpace?.id !== SHARED_CHANNELS_SPACE_ID ? selectedSpace?.id ?? null : null, workstream.parentId, first.substreamId);
        return <SidebarRow as={NavLink} aria-label={workstream.title ?? first.title} aria-description={workstream.scope === 'workspace' ? 'Public channel' : 'Private channel'} className={`workstream-row${pathname === rowPath ? ' is-active' : ''}`} onClick={() => {
          spacesSidebar.setCompact(true);
        }} key={workstream.parentId} to={rowPath}>
          <NavigationRowContent activity={workstream.scope === 'workspace' ? 'Public channel' : 'Private channel'} id={workstream.parentId} title={workstream.title ?? first.title} appearance={workstream.appearance ?? undefined} />
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
      <Route path="/s/:spaceId" element={<SharedSpaceRoute />} />
      <Route path="/s/:spaceId/c/:parentId" element={<SharedConversationRoute />} />
      <Route path="/s/:spaceId/c/:parentId/b/:substreamId" element={<SharedConversationRoute />} />
      <Route path="/workstreams/:parentId" element={<SharedConversationRoute />} />
      <Route path="/workstreams/:parentId/substreams/:substreamId" element={<SharedConversationRoute />} />
      <Route path="*" element={<div className="browser-empty"><h1>Shared conversations</h1><p>Choose a conversation to start collaborating.</p></div>} />
    </Routes></main>
  </div>;
}

/**
 * A tab owns its visible feed and one workspace socket for membership nudges.
 * It never installs the desktop socket swarm.
 */
export default function BrowserConversation({ session, onSignOut }: { session: CookieClientSession; onSignOut: () => void }): React.JSX.Element {
  const [queryClient] = useState(() => createQueryClient());
  // Metadata/expiry reconciliation must preserve pending commands and the live socket.
  const api = useMemo(() => new RallyApi(session.apiBaseUrl, session), [
    session.apiBaseUrl, session.user.id, session.workspace?.id, session.workspace?.region,
    session.workspace?.role, session.workspace?.accessClass,
  ]);
  useLayoutEffect(() => { api.setSession(session); }, [api, session]);
  // The tab's one workspace socket, and the only thing it listens for: this
  // person joining or leaving a Channel or Breakout. Without it the sidebar
  // learns of a new grant only on focus or from the open conversation's own
  // metadata, and a guest is sent no Space snapshot to stand in.
  const workspaceId = session.workspace?.id;
  useEffect(() => {
    if (!workspaceId) return;
    return watchWorkspaceReach({
      ticket: () => api.getWorkspaceSocketTicket(),
      open: (url, ticket) => new WebSocket(url, socketTicketProtocols(ticket)),
      onStale: () => { void queryClient.invalidateQueries({ queryKey: ['shared-navigation'] }); },
    });
  }, [api, queryClient, workspaceId]);
  if (!session.workspace) return <p>Open a shared conversation to continue.</p>;
  const canonicalBase = `/app/${session.workspace.region}/${uuidToBase58(session.workspace.id)}`;
  const basename = location.pathname.startsWith(`${canonicalBase}/`)
    ? canonicalBase
    : `/app/workspaces/${session.workspace.region}/${session.workspace.id}`;
  return <QueryClientProvider client={queryClient}>
    <CollaborationSessionProvider api={api} session={session}>
      <Tooltip.Provider><SpeechPlaybackProvider api={api}>
        <BrowserRouter basename={basename}><BrowserWorkspace api={api} onSignOut={onSignOut} /></BrowserRouter>
      </SpeechPlaybackProvider></Tooltip.Provider>
    </CollaborationSessionProvider>
  </QueryClientProvider>;
}
