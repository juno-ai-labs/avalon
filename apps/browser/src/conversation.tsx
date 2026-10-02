import { createQueryClient } from "../../desktop/src/renderer/lib/query-client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { QueryClientProvider, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { uuidFromBase58, uuidToBase58 } from '@rally/contracts/uuid-base58';
import { watchWorkspaceReach } from '@rally/contracts/workspace-reach-watch';
import { workstreamCanonicalUrl } from '@rally/contracts/workstream-links';
import { AccountTrigger } from '@rally/ui/components/account-trigger';
import { ChannelRowContent } from '@rally/ui/components/navigation';
import {
  ResizableSidebar,
  SidebarFooter,
  SidebarHorizontalLine,
  SidebarList,
  SidebarRow,
  SidebarScroll,
} from '@rally/ui/components/resizable-sidebar';
import { SINGLE_SIDEBAR_DEFAULT_WIDTH } from '@rally/ui/lib/sidebar-geometry';
import { browserSidebarVisible, browserSidebarWidth } from './sidebar-layout';
import { MacDownloadLink } from './mac-download';
import type { BreakoutMark } from '@rally/ui/components/breakout-marks';
import { BreakoutMenu, ChannelMenu } from '@rally/ui/components/conversation-menus';
import { SpacePill, SpacePillStrip, SidebarTopActions } from '@rally/ui/components/space-pills';
import { SplitConversationLayout } from '@rally/ui/components/split-conversation';
import { TitlePillClose, TitlePillHeader, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { WorkstreamGlyph, WorkstreamMark } from '@rally/ui/components/workstream-glyph';
import { Button, InlineError, Modal, StatusDot } from '@rally/ui/components/primitives';
import { RallyApi } from '../../desktop/src/renderer/lib/api';
import { logWarn } from '../../desktop/src/common/logger';
import { useUiStore } from '../../desktop/src/renderer/lib/ui-store';
import { ShareConversationDialog } from '../../desktop/src/renderer/components/scope-sharing-panel';
import { SidekickPicker } from '../../desktop/src/renderer/components/sidekick-picker';
import { useCollaborationSession, CollaborationSessionProvider } from '../../desktop/src/renderer/lib/collaboration-session';
import { SpeechPlaybackProvider } from '../../desktop/src/renderer/components/speech-playback';
import { ConversationSurface, type ConversationHeaderContext } from '../../desktop/src/renderer/screens/conversation-surface';
import '@rally/ui/styles/app.css';

const SHARED_CHANNELS_SPACE_ID = 'shared-channels';

type SharedNavigationDirectory = Awaited<ReturnType<RallyApi['getSharedNavigationDirectory']>>;


/** The directory's Spaces, plus a local **Shared channels** group for Channels no visible Space holds. */
function sharedNavigationSpaces(directory: SharedNavigationDirectory | undefined) {
  const spaces = directory?.spaces ?? [];
  const placedWorkstreamIds = new Set(spaces.flatMap((space) => space.workstreamIds));
  const unplacedWorkstreamIds = (directory?.workstreams ?? [])
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
}

/** The sidebar's preferred width, for this tab only; the window clamps it. */
function useBrowserSidebarWidth(): [number, (requested: number) => void] {
  const [width, setWidth] = useState(() => browserSidebarWidth(SINGLE_SIDEBAR_DEFAULT_WIDTH, window.innerWidth));
  const resize = useCallback((requested: number): void => {
    setWidth(browserSidebarWidth(requested, window.innerWidth));
  }, []);
  return [width, resize];
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
      const target = sharedWorkstreamTarget(channel, spaceId);
      return target && <li key={channel.parentId}><NavLink to={target.path}>{channel.title ?? target.first.title}</NavLink></li>;
    })}</ul></nav>}
  </div>;
}

/**
 * Where selecting a Channel lands: its first active conversation, else its
 * first. The **Shared channels** group has no canonical Space, so it and a
 * null Space both give the legacy path.
 */
function sharedWorkstreamTarget<Conversation extends { substreamId: string; archived: boolean }>(
  workstream: { parentId: string; conversations: Conversation[] },
  spaceId: string | null,
): { first: Conversation; path: string } | null {
  const first = workstream.conversations.find((item) => !item.archived) ?? workstream.conversations[0];
  if (!first) return null;
  const placedSpaceId = spaceId && spaceId !== SHARED_CHANNELS_SPACE_ID ? spaceId : null;
  return { first, path: sharedConversationPath(placedSpaceId, workstream.parentId, first.substreamId) };
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

/**
 * A shared Channel, with the Breakout the route names open beside it. Main is
 * on the left whenever the directory lists it; a guest who holds only some
 * Breakouts reads the one open on its own, in Main's place.
 */
function SharedConversation({ parentId, substreamId, spaceId }: { parentId: string; substreamId: string; spaceId: string | null }): React.JSX.Element {
  const navigate = useNavigate();
  const { api, session } = useCollaborationSession();
  const queryClient = useQueryClient();
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [sharingSubstream, setSharingSubstream] = useState<string | null>(null);
  const [changingArchive, setChangingArchive] = useState(false);
  const [archiveFailure, setArchiveFailure] = useState<'archive' | 'restore' | null>(null);
  const [breakoutWidth, setBreakoutWidth] = useState<number | null>(null);
  const [scrollToTurn, setScrollToTurn] = useState<{ turnId: string; nonce: number } | null>(null);
  const railOpen = useUiStore((state) => state.railOpen);
  const railScope = useUiStore((state) => state.railScope);
  const closeRail = useUiStore((state) => state.closeRail);
  const directory = useQuery({ queryKey: ['shared-navigation'], enabled: Boolean(api),
    queryFn: ({ signal }) => api!.getSharedNavigationDirectory(signal), refetchOnWindowFocus: 'always' });
  const parent = directory.data?.workstreams.find((item) => item.parentId === parentId);
  const archived = parent?.conversations.find((item) => item.substreamId === substreamId)?.archived ?? false;
  const parentArchived = parent?.archived === true || (substreamId === '0' && archived);
  // Main is on screen when the route names it, or once the directory says this
  // reader holds it; a Breakout grant proves nothing about Main.
  const mainVisible = substreamId === '0'
    || Boolean(parent?.conversations.some((item) => item.substreamId === '0' && !item.archived));
  const openBreakoutId = substreamId !== '0' ? substreamId : null;
  const breakoutMarks = useMemo<BreakoutMark[] | undefined>(() => parent?.conversations
    .filter((item) => item.substreamId !== '0' && !item.archived)
    .map((item) => ({
      substreamId: item.substreamId,
      title: item.title,
      appearance: item.appearance,
      originTurnId: item.originTurnId ?? null,
      needsAttention: item.needsAttention,
    })), [parent]);
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
  // The right slot is one place, as on the desktop: a panel the Breakout opens
  // takes the Channel's side, and one the Channel opens takes the Breakout's.
  const breakoutOwnsRail = railOpen && openBreakoutId !== null && railScope === `${parentId}:${openBreakoutId}`;
  const mainOwnsRail = railOpen && railScope === parentId;
  const mode = openBreakoutId === null ? 'main' as const
    : !mainVisible || breakoutOwnsRail ? 'breakout' as const
      : mainOwnsRail ? 'main' as const : 'split' as const;
  const openBreakout = (target: string): void => {
    if (mainOwnsRail) closeRail();
    navigate(sharedConversationPath(spaceId, parentId, target));
  };
  const copyLink = (target: string): void => {
    if (!session?.workspace) return;
    const url = sharedConversationShareUrl(session.workspace.region, session.workspace.id, directory.data, spaceId, parentId, target);
    void navigator.clipboard.writeText(url);
  };
  const channelTitle = parent?.title ?? 'Shared channel';
  const channelLevel = (context: ConversationHeaderContext | null, onSelect?: () => void): TitlePillLevel => ({
    key: `channel:${parentId}`,
    icon: <WorkstreamGlyph appearance={parent?.appearance} id={parentId} size={24} />,
    title: channelTitle,
    label: `Channel menu: ${channelTitle}`,
    ...(onSelect ? { onSelect } : {}),
    menu: <ChannelMenu
      actions={{
        onShare: (target) => setSharingSubstream(target.substreamId),
        onCopyLink: (target) => copyLink(target.substreamId),
      }}
      addSidekick={context && <SidekickPicker substreamId="0" workstreamId={parentId} />}
      breakouts={breakoutMarks}
      onOpenArtifact={context?.openArtifact}
      onOpenBreakout={openBreakout}
      onParticipants={context?.openParticipantDialog}
      onRefreshSidekicks={context?.refreshSidekicks}
      onSidekickMenuOpen={context?.loadSidekickOptions}
      openSubstreamId={openBreakoutId}
      participantsPending={context === null}
      presentUserIds={context?.presentUserIds ?? []}
      sidekickFailure={context?.sidekickFailure}
      sidekicks={context?.sidekicks}
      workstream={{
        id: parentId,
        title: channelTitle,
        appearance: parent?.appearance,
        scope: parent?.scope,
        participants: context?.detail.participants ?? [],
        resources: context?.detail.resources ?? [],
      }}
    />,
  });
  const breakoutLevel = (context: ConversationHeaderContext): TitlePillLevel => {
    const breakoutId = openBreakoutId ?? '';
    const listed = parent?.conversations.find((item) => item.substreamId === breakoutId);
    return {
      key: `breakout:${breakoutId}`,
      icon: <WorkstreamMark appearance={listed?.appearance} id={breakoutId} size={20} />,
      title: context.detail.title,
      label: `Breakout menu: ${context.detail.title}`,
      menu: <BreakoutMenu
        actions={{
          onShare: (target) => setSharingSubstream(target.substreamId),
          onCopyLink: (target) => copyLink(target.substreamId),
          onArchive: (target) => setArchiveTarget(target.substreamId),
        }}
        breakout={{ substreamId: breakoutId, title: context.detail.title }}
        channel={{ id: parentId, title: channelTitle, appearance: parent?.appearance }}
        onParticipants={context.openParticipantDialog}
        onShowInChannel={mainVisible ? () => {
          if (breakoutOwnsRail) closeRail();
          const turnId = breakoutMarks?.find((breakout) => breakout.substreamId === breakoutId)?.originTurnId;
          if (turnId) setScrollToTurn((current) => ({ turnId, nonce: (current?.nonce ?? 0) + 1 }));
        } : undefined}
        participants={context.detail.participants}
        presentUserIds={context.presentUserIds}
        scope={listed?.scope}
      />,
    };
  };
  const mainPane = mainVisible ? <ConversationSurface
    breakouts={breakoutMarks}
    honorsSearchTarget={openBreakoutId === null}
    onOpenBreakout={openBreakout}
    openBreakoutId={openBreakoutId}
    parentId={parentId}
    parentKind="workstream"
    renderHeader={(context) => <TitlePillHeader current={channelLevel(context)} />}
    scrollToTurn={scrollToTurn}
    sidebarScope="conversation"
    substreamId="0"
  /> : null;
  const breakoutPane = openBreakoutId === null ? null : archived
    ? <section className="browser-empty"><h1>{parentArchived ? 'Archived channel' : 'Archived conversation'}</h1>
      {parentArchived ? <p>This channel must be restored before its conversations can reopen.</p>
        : parent?.archived !== true
          ? <Button disabled={changingArchive} onClick={() => void changeArchive(false)}>Restore breakout</Button>
          : <p>This conversation is archived.</p>}</section>
    : <ConversationSurface
      parentId={parentId}
      parentKind="workstream"
      renderHeader={(context) => <TitlePillHeader
        ancestors={mode === 'breakout' && mainVisible ? [channelLevel(null, closeRail)] : []}
        current={breakoutLevel(context)}
        trailing={mainVisible ? <TitlePillClose label="Close breakout" onClose={() => navigate(sharedConversationPath(spaceId, parentId, '0'))} /> : undefined}
      />}
      sidebarScope="conversation"
      substreamId={openBreakoutId}
    />;
  return <>
    {api && session?.workspace && sharingSubstream !== null && <ShareConversationDialog api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={sharingSubstream} open onOpenChange={(open) => { if (!open) setSharingSubstream(null); }} />}
    <Modal open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }} title="Archive breakout" description="This breakout will leave the active list. You can restore it later.">
      <Button disabled={changingArchive} onClick={() => setArchiveTarget(null)}>Cancel</Button>
      <Button disabled={changingArchive} onClick={() => { void changeArchive(true, archiveTarget ?? substreamId).then(() => setArchiveTarget(null)); }}>Archive breakout</Button>
    </Modal>
    {archiveFailure ? <InlineError>{archiveFailure === 'archive'
      ? 'The breakout couldn’t be archived.'
      : 'The breakout couldn’t be restored.'}</InlineError> : null}
    {substreamId === '0' && archived
      ? <section className="browser-empty"><h1>{parentArchived ? 'Archived channel' : 'Archived conversation'}</h1>
        <p>{parentArchived ? 'This channel must be restored before its conversations can reopen.' : 'This conversation is archived.'}</p></section>
      : <SplitConversationLayout
        breakout={breakoutPane}
        breakoutWidth={breakoutWidth}
        main={mainPane}
        mode={mode}
        onBreakoutWidthChange={setBreakoutWidth}
      />}
  </>;
}

function SharedNavigation({ accountMenu, directory, navigationSpaces }: {
  accountMenu: React.ReactNode;
  directory: UseQueryResult<SharedNavigationDirectory>;
  navigationSpaces: ReturnType<typeof sharedNavigationSpaces>;
}): React.JSX.Element {
  const { session } = useCollaborationSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const canonicalHost = !location.pathname.startsWith('/app/workspaces/');
  const legacyParentId = pathname.match(/^\/workstreams\/([^/]+)/u)?.[1] ?? null;
  const canonicalRoute = /^\/s\/([^/]+)(?:\/c\/([^/]+))?/u.exec(pathname);
  const routeParentId = legacyParentId ?? (canonicalRoute?.[2] ? uuidFromBase58(canonicalRoute[2]) : null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [preferredWidth, resize] = useBrowserSidebarWidth();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const measure = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const width = browserSidebarWidth(preferredWidth, viewportWidth);
  // The main pane leaves room for the sidebar through the shell's one width.
  useLayoutEffect(() => {
    const shell = sidebarRef.current?.closest<HTMLElement>('.workspace-shell');
    shell?.style.setProperty('--av-cmp-sidebar-width', `${width}px`);
    return () => { shell?.style.removeProperty('--av-cmp-sidebar-width'); };
  }, [width]);
  // Pills for the Spaces a reader chose; General is where a Channel is when it
  // is in none, and **All** already holds it.
  const pillSpaces = navigationSpaces.filter((space) => !('systemRole' in space) || space.systemRole !== 'general');
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const selectedSpace = pillSpaces.find((space) => space.id === selectedSpaceId) ?? null;
  useEffect(() => {
    // A Channel the filter would hide widens the list to All.
    if (selectedSpace && routeParentId && !selectedSpace.workstreamIds.includes(routeParentId)) setSelectedSpaceId(null);
  }, [routeParentId, selectedSpace]);
  if (!session) return <></>;
  const workstreams = [...(directory.data?.workstreams ?? [])]
    .filter((workstream) => !selectedSpace || selectedSpace.workstreamIds.includes(workstream.parentId))
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }));
  const spaceFor = (parentId: string): string | null => {
    if (selectedSpace && selectedSpace.id !== SHARED_CHANNELS_SPACE_ID) return selectedSpace.id;
    return navigationSpaces.find((space) => space.id !== SHARED_CHANNELS_SPACE_ID && space.workstreamIds.includes(parentId))?.id ?? null;
  };
  return <ResizableSidebar
    aria-label="Rally navigation"
    className="sidebar single-sidebar browser-sidebar"
    collapsible={false}
    compact={false}
    onResize={resize}
    resizeLabel="Resize navigation"
    sidebarRef={sidebarRef}
    style={{ width }}
    width={width}
  >
    <SidebarTopActions aria-label="Rally actions" />
    {pillSpaces.length > 0 && <SpacePillStrip>
      <SpacePill onClick={() => setSelectedSpaceId(null)} selected={selectedSpace === null}>All</SpacePill>
      {pillSpaces.map((space) => <SpacePill
        aria-description={space.scope === 'workspace' ? 'Public space' : undefined}
        key={space.id}
        onClick={() => {
          setSelectedSpaceId(space.id);
          if (canonicalHost && space.id !== SHARED_CHANNELS_SPACE_ID) navigate(`/s/${uuidToBase58(space.id)}/`);
        }}
        selected={selectedSpace?.id === space.id}
      >{space.name}</SpacePill>)}
    </SpacePillStrip>}
    <SidebarScroll><SidebarList as="nav" aria-label="Shared channels">
      {directory.isError && <InlineError>Unable to load shared conversations.</InlineError>}
      {directory.isPending && <p className="sidebar-empty">Loading channels…</p>}
      {directory.data && workstreams.length === 0 && <p className="sidebar-empty">No shared channels yet.</p>}
      {workstreams.map((workstream) => {
        const target = sharedWorkstreamTarget(workstream, canonicalHost ? spaceFor(workstream.parentId) : null);
        if (!target) return null;
        const { first, path: rowPath } = target;
        const spaceNames = navigationSpaces
          .filter((space) => space.id !== SHARED_CHANNELS_SPACE_ID
            && (!('systemRole' in space) || space.systemRole !== 'general')
            && space.workstreamIds.includes(workstream.parentId))
          .map((space) => space.name);
        const news = workstream.conversations.some((conversation) => conversation.needsAttention === true);
        return <SidebarRow as={NavLink} aria-label={workstream.title ?? first.title}
          aria-description={workstream.scope === 'workspace' ? 'Public channel' : 'Private channel'}
          className={`workstream-row channel-row${pathname.startsWith(rowPath) ? ' is-active' : ''}`}
          key={workstream.parentId} to={rowPath}>
          <ChannelRowContent
            appearance={workstream.appearance ?? undefined}
            id={workstream.parentId}
            marker={news ? <StatusDot compact status="unread" /> : undefined}
            subtitle={spaceNames.length > 0 ? spaceNames.join(', ') : undefined}
            title={workstream.title ?? first.title}
          />
        </SidebarRow>;
      })}
    </SidebarList></SidebarScroll>
    <MacDownloadLink />
    <SidebarHorizontalLine className="sidebar-footer-line" />
    <SidebarFooter leading={accountMenu} />
  </ResizableSidebar>;
}

/**
 * With nothing to choose between — the case the sidebar is hidden for — the one
 * Channel opens in place of the empty chooser. Lives beside the sidebar rather
 * than in it, since the sidebar is not mounted then.
 */
function OpenLoneWorkstream({ directory, navigationSpaces }: {
  directory: SharedNavigationDirectory | undefined;
  navigationSpaces: ReturnType<typeof sharedNavigationSpaces>;
}): null {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const canonicalHost = !location.pathname.startsWith('/app/workspaces/');
  const routeParentId = pathname.match(/^\/workstreams\/([^/]+)/u)?.[1]
    ?? (/^\/s\/[^/]+\/c\/[^/]+/u.test(pathname) ? pathname : null);
  const onlyWorkstream = directory && !browserSidebarVisible({
    spaceCount: navigationSpaces.length, channelCount: directory.workstreams.length,
  }) ? directory.workstreams[0] : undefined;
  useEffect(() => {
    if (!onlyWorkstream || routeParentId) return;
    const target = sharedWorkstreamTarget(onlyWorkstream, canonicalHost ? navigationSpaces[0]?.id ?? null : null);
    if (target) navigate(target.path, { replace: true });
  }, [canonicalHost, navigate, navigationSpaces, onlyWorkstream, routeParentId]);
  return null;
}

function BrowserWorkspace({ api, onSignOut }: { api: RallyApi; onSignOut: () => void }): React.JSX.Element {
  const { session } = useCollaborationSession();
  const directory = useQuery({ queryKey: ['shared-navigation'], queryFn: ({ signal }) => api.getSharedNavigationDirectory(signal), refetchOnWindowFocus: 'always' });
  const navigationSpaces = useMemo(() => sharedNavigationSpaces(directory.data), [directory.data]);
  // A failed refetch keeps the last data; the sidebar still shows so the error
  // inside it can be seen.
  const sidebarVisible = browserSidebarVisible(directory.data && !directory.isError ? {
    spaceCount: navigationSpaces.length,
    channelCount: directory.data.workstreams.length,
  } : undefined);
  const accountMenu = useMemo(() => {
    if (!session) return null;
    const user = { ...session.user, name: session.user.name ?? session.user.email, timezone: session.user.timezone ?? 'UTC', avatarUrl: session.user.avatarUrl ?? undefined };
    return <div className="spaces-account-slot"><DropdownMenu.Root><DropdownMenu.Trigger asChild>
      <AccountTrigger currentUser={user} workspaceName={session.workspace?.name ?? 'Organization'} />
    </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content workspace-menu" align="start" sideOffset={8}>
      <DropdownMenu.Item className="menu-item" onSelect={() => location.assign('/')}>Switch organization</DropdownMenu.Item>
      <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>Sign out</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>;
  }, [onSignOut, session]);
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
    <OpenLoneWorkstream directory={directory.data} navigationSpaces={navigationSpaces} />
    {sidebarVisible
      ? <SharedNavigation accountMenu={accountMenu} directory={directory} navigationSpaces={navigationSpaces} />
      // With no sidebar the account menu floats over the corner it would sit in.
      : <div className="browser-account-fallback"><MacDownloadLink />{accountMenu}</div>}
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
      onDiagnostic: (diagnostic) => logWarn('rally', 'membership updates paused', diagnostic.code,
        'closeCode' in diagnostic ? diagnostic.closeCode : diagnostic.error),
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
