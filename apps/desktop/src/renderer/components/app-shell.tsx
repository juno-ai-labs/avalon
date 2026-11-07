import { NavigationHistoryProvider } from './navigation-history';
import { AccessRequestDialog } from './access-request-dialog';
import { AddMembersDialog } from './add-members-dialog';
import { useViewerIsWorkspaceAdmin } from '../lib/use-workspace';
import { useAccessRequests } from '../lib/access-requests';
import type { WorkspaceAttention } from '@rally/contracts';
import type { ClientSession } from '@rally/contracts/client-session';
import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PropsWithChildren, useContext } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DesktopWorkspaceOnboardingState, DesktopWorkspaceSummary } from '../../common/desktop';
import { desktopWorkspaceIdentityKey } from '../../common/desktop';
import { workspaceActivationFailureCode } from '../../common/workspace-activation-error';
import {
  AccountSignInFailedError,
  AccountSignInSupersededError,
  useAppSession,
  WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY,
} from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import { isWindowSurfaceRoute } from '../lib/window-surface';
import { MacDownloadLink } from './mac-download-link';
import { MAC_APP_DOWNLOADABLE } from '../lib/browser-connectors';
import { useAttentionItems } from '../lib/attention-items';
import { useDockBadge } from '../lib/dock-badge';
import { MemberPresentationContext } from '../lib/member-presentation';
import { openLink } from '../lib/browser-rail-links';
import { associativeWorkstreamsForSidebar, conversationDirectoryQueryKey } from '../lib/conversation-directory';
import { desktopBridge } from '../lib/platform';
import { useSupportWorkspaces } from '../lib/use-support-workspaces';
import { layoutKey, writeLayout } from '../lib/desktop-layout';
import { restorableRoute } from '../lib/landing';
import { uuidV7 } from '../lib/telemetry';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { useRailFillsPane } from '../lib/rail-split';
import { SIDEBAR_CONTENT_MIN_WIDTH, useUiStore } from '../lib/ui-store';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { useWorkspaceSocket } from '../lib/workspace-socket';
import { channelDestination } from '../lib/workstream-landing';
import { openCanvasId } from '../lib/canvases';
import { heldChannelBreakouts, isWorkstreamChildrenQueryKey, type ChannelBreakoutLists } from '../lib/channel-viewer-state';
import { AttachmentLightbox } from './attachment-lightbox';
import type { AttachmentPreview } from './attachments';
import { SearchModal, type SearchPlace } from './search-modal';
import { NavigationSidebar } from './navigation-sidebar';
import { PHONE_NAVIGATION_CONTROL, PhoneHeaderContext, type PhoneHeader } from '@rally/ui/components/title-pill';
import { useSheetOpener } from '../lib/sheet-opener';
import { IconSearch } from '@tabler/icons-react';
import { useDownloadedUpdate } from '../lib/use-downloaded-update';
import { OrganizationUsageMenuItem } from './organization-usage';
import { WorkspaceAccountMenu } from './workspace-account-menu';
import { KonamiEgg } from './easter-eggs/konami';
import { useDeviceTimezoneSync } from '../lib/device-timezone';

interface AppShellProps extends PropsWithChildren {
  workspace: Workspace;
}

/**
 * The account directory with the active workspace's row named from
 * `GET /workspace`. Discovery fills the directory and no sync topic reruns it,
 * while the `workspace_profile` topic refreshes that read on a rename, so this
 * is what keeps a renamed Organization's name current on the account menu.
 */
export function withActiveWorkspaceName(
  rows: readonly DesktopWorkspaceSummary[],
  active: { id: string; name: string; region: string },
): DesktopWorkspaceSummary[] {
  return rows.map((row) => (
    row.id === active.id && row.region === active.region ? { ...row, name: active.name } : row
  ));
}


/**
 * The shell class that says the window's own buttons are painted over the page,
 * or none. Reserving room for them is `docs/assumptions.md` item 25.
 *
 * Only macOS paints them there: the main window asks `hiddenInset` of darwin
 * and `hidden` of everything else, and off darwin that leaves the buttons in
 * the window manager's own frame or, on Windows, not drawn at all. `undefined`
 * — the runtime config still in flight — answers the same as any other
 * non-macOS platform, which is the reading that leaves a header where it
 * already is rather than jumping it sideways when the answer lands.
 */
export function windowControlsShellClass(platform: string | undefined): string {
  return platform === 'darwin' ? 'has-overlay-window-controls' : '';
}


export function invitationAccountMismatch(invitationEmail: string, accountEmail: string): string | null {
  if (invitationEmail.toLocaleLowerCase('en-US') === accountEmail.toLocaleLowerCase('en-US')) return null;
  return `This invitation is for ${invitationEmail}. Sign in with that account to continue.`;
}

/** How long the panes take to fade up on a new workspace; matches `workspace-enter` in `app.css`. */
const WORKSPACE_ENTER_MS = 320;

/**
 * Whether the active workspace shell has a Space rail. A session without an
 * active workspace never mounts this shell; null remains enabled for the
 * legacy startup frame.
 */
export function spacesEnabledForSession(session: ClientSession | null): boolean {
  return session === null || session.workspace !== undefined;
}

/**
 * The Channels search lists, each followed by its Breakouts: the ones the
 * socket holds for this reader as a member (`held`), and the ones a grant
 * reaches, which only the shared navigation directory lists. A Channel still
 * being created is left to the caller to drop.
 */
export function searchChannelPlaces(
  channels: readonly WorkstreamSummary[],
  held: ChannelBreakoutLists,
  directory: SharedNavigationDirectory | undefined,
): SearchPlace[] {
  const shared = new Map((directory?.workstreams ?? []).map((entry) => [entry.parentId, entry.conversations]));
  return channels.flatMap((channel): SearchPlace[] => {
    const breakouts = new Map<string, { title: string; appearance?: WorkstreamSummary['appearance'] }>();
    for (const conversation of shared.get(channel.id) ?? []) {
      if (conversation.substreamId !== '0' && !conversation.archived) breakouts.set(conversation.substreamId, conversation);
    }
    for (const breakout of held[channel.id] ?? []) breakouts.set(breakout.substreamId, breakout);
    return [
      { kind: 'channel', id: channel.id, name: channel.title, substreamId: channel.associativeSubstreamId, appearance: channel.appearance },
      ...[...breakouts].map(([substreamId, breakout]): SearchPlace => ({
        kind: 'breakout', id: substreamId, channelId: channel.id, channelName: channel.title,
        name: breakout.title, appearance: breakout.appearance, channelAppearance: channel.appearance })),
    ];
  });
}

export function AppShell({ workspace, children }: AppShellProps): React.JSX.Element {
  const personalPresentation = useContext(MemberPresentationContext).get(workspace.currentUser.id);
  const {
    acceptInvitation,
    activateWorkspace,
    api,
    clearPendingAccessRequest,
    clearPendingInvitation,
    declineInvitation,
    finishWorkspaceSetup,
    getOnboardingState,
    invitationApi,
    pendingAccessRequestId,
    pendingInvitation,
    abandonAccountSignIn,
    runtime,
    session,
    signOut,
    listSupportWorkspaces,
    listSupportPeople,
    startSupportSession,
    endSupportSession,
  } = useAppSession();
  const { host, guest: guestSession } = useShellCapabilities();
  const accessRequests = useAccessRequests(workspace.id);
  // A request row chosen in the attention menu; the menu bar's arrives as
  // `pendingAccessRequestId` instead. Either opens the one dialog.
  const [openAccessRequestId, setOpenAccessRequestId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  // Inviting is an administrator's; the server refuses anyone else. The
  // shell's own workspace comes from the session and carries no role.
  const canInvite = useViewerIsWorkspaceAdmin({ api: api ?? null, session: session ?? null }) && !guestSession;
  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (api && (event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyF' && !event.isComposing) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', openSearch);
    return () => window.removeEventListener('keydown', openSearch);
  }, [api]);
  const searchIdentity = `${workspace.id}:${workspace.currentUser.id}`;
  const [searchPreview, setSearchPreview] = useState<{ identity: string; preview: AttachmentPreview } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    // A Canvas or a Sidekick, or either home: what reopens next time.
    const path = restorableRoute(location.pathname);
    if (path) writeLayout(layoutKey(workspace.id, workspace.currentUser.id, 'last-route'), path);
  }, [location.pathname, workspace.id, workspace.currentUser.id]);
  const queryClient = useQueryClient();
  const railOpen = useUiStore((state) => state.railOpen);
  const railWidth = useUiStore((state) => state.railWidth);
  const railLeaving = useUiStore((state) => state.railLeaving);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  // Only true at phone width, where the navigation sheet covers the pane.
  const navigationSheetOpen = useUiStore((state) => state.sidebarOpen);
  const setNavigationSheetOpen = useUiStore((state) => state.setSidebarOpen);
  // At phone width a pane's header is the only one on screen, so it opens the
  // sheet and carries the search the sheet's own header offers. A window
  // surface in a browser tab draws no sidebar, so there is no sheet to open.
  const openNavigation = useSheetOpener(navigationSheetOpen, setNavigationSheetOpen, PHONE_NAVIGATION_CONTROL);
  const windowSurface = host === 'browser' && isWindowSurfaceRoute(location.pathname);
  const phoneHeader = useMemo<PhoneHeader>(() => ({
    openNavigation,
    actions: [{
      key: 'search',
      label: 'Search organization',
      icon: <IconSearch aria-hidden="true" size={16} stroke={1.9} />,
      disabled: !api,
      onSelect: () => setSearchOpen(true),
    }],
  }), [api, openNavigation]);
  const spacesEnabled = spacesEnabledForSession(session);
  // The main pane keeps room for a sidebar that is still fading out.
  const showShellRail = railOpen || railLeaving;
  const railFillsPane = useRailFillsPane(sidebarWidth);
  const railExpanded = useUiStore((state) => state.railExpanded);
  // Nothing here loads the sidebar. Subscribing to the workspace socket is
  // answered with the whole of it — the first page of work streams, the
  // Sidekicks and the notes — and WorkspaceDO pushes each list again whenever
  // it changes a row. This query exists for what a person asks for afterwards:
  // scrolling past page one, or widening the list with Debug enabled.
  const workstreams = useWorkstreamsQuery();
  const { active: spaces } = useSpaceDirectories();
  const associativeNavigation = useQuery({
    queryKey: conversationDirectoryQueryKey(workspace.id),
    queryFn: ({ signal }) => api!.getSharedNavigationDirectory(signal),
    enabled: Boolean(api),
    // Says which conversation a Channel the socket lists opens on when Main is
    // not this person's. Refreshed by the socket's own signals — a Channel's
    // tombstone, a listed Channel's metadata frame — not on every focus.
    refetchOnWindowFocus: false,
  });
  const sidebarWorkstreams = useMemo(
    () => associativeWorkstreamsForSidebar(associativeNavigation.data, workstreams.data),
    [associativeNavigation.data, workstreams.data],
  );
  const { items: attentionItems, breakoutListsLoaded } = useAttentionItems(sidebarWorkstreams);
  // The menu only says "nothing" once every Channel is loaded: the Space walk
  // has finished, no page is left unread, and the walk did not fail.
  const attentionComplete = workstreams.data !== undefined && !workstreams.hasMore
    && !workstreams.isFetching && !workstreams.isError;
  // A Breakout list still on its way would make the count a floor, and the
  // dock would then lower the badge APNs set from the full count.
  // The attention button's number: waiting conversations and access requests.
  useDockBadge(attentionItems.length + accessRequests.length, attentionComplete && breakoutListsLoaded);
  const downloadedUpdate = useDownloadedUpdate();
  // While search is open, a Breakout list the socket writes re-reads the
  // places, so a Breakout created or renamed meanwhile shows at once.
  const [breakoutListsVersion, setBreakoutListsVersion] = useState(0);
  useEffect(() => {
    if (!searchOpen) return;
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && isWorkstreamChildrenQueryKey(event.query.queryKey)) setBreakoutListsVersion((version) => version + 1);
    });
  }, [searchOpen, queryClient]);
  const searchChannels = useMemo(() => {
    if (!searchOpen) return [];
    const channels = sidebarWorkstreams.filter((channel) => !channel.pending);
    return searchChannelPlaces(channels, heldChannelBreakouts(queryClient, channels.map((channel) => channel.id)),
      associativeNavigation.data);
    // `breakoutListsVersion` is how a Breakout list written to the cache reaches this read.
  }, [searchOpen, sidebarWorkstreams, associativeNavigation.data, breakoutListsVersion, queryClient]);
  const searchSpaces = useMemo(() => (spaces.data?.items ?? []).map((space): SearchPlace => (
    { kind: 'space', id: space.id, name: space.name, iconKey: space.iconKey, colorKey: space.colorKey })), [spaces.data]);
  const featureFlags = useClientFeatureFlags(api);
  const multipleWorkspacesEnabled = featureFlags.data?.multipleWorkspacesEnabled === true;
  const workspaceDirectory = useQuery<DesktopWorkspaceOnboardingState>({
    queryKey: WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY,
    queryFn: getOnboardingState,
    enabled: multipleWorkspacesEnabled,
  });
  // A support session runs on the impersonator's device, not the person's.
  useDeviceTimezoneSync(api ?? null, !session?.impersonator);
  const supportWorkspaces = useSupportWorkspaces(session?.impersonator?.id ?? session?.user.id, listSupportWorkspaces);
  const impersonator = session?.impersonator
    ? { id: session.impersonator.id, name: session.impersonator.name, email: session.impersonator.email,
        timezone: 'UTC', ...(session.impersonator.avatarUrl ? { avatarUrl: session.impersonator.avatarUrl } : {}) }
    : null;
  // Main lists the stored set whatever happened to discovery. The account's
  // own state is not read here: a switch or a creation that finds the
  // identity credential missing signs in through the browser and continues
  // by itself (see `activateWorkspace`), so no row is ever marked on a state
  // this renderer may be holding stale.
  const pendingInvitationPreview = useQuery({
    queryKey: ['workspace-invitation-preview', pendingInvitation?.region, pendingInvitation?.token],
    queryFn: ({ signal }) => invitationApi!.getInvitationPreview(pendingInvitation!.token, signal),
    enabled: Boolean(multipleWorkspacesEnabled && pendingInvitation && invitationApi),
    retry: false,
  });
  useEffect(() => {
    if (!pendingInvitationPreview.error) return;
    clearPendingInvitation();
    void desktopBridge().showDeepLinkError(
      pendingInvitationPreview.error instanceof Error
        ? pendingInvitationPreview.error.message
        : 'This invitation is invalid, expired, or no longer available.',
    );
  }, [clearPendingInvitation, pendingInvitationPreview.error]);
  useEffect(() => {
    if (!pendingInvitationPreview.data || !session) return;
    const mismatch = invitationAccountMismatch(pendingInvitationPreview.data.email, session.user.email);
    if (!mismatch) return;
    clearPendingInvitation();
    void desktopBridge().showDeepLinkError(mismatch);
  }, [clearPendingInvitation, pendingInvitationPreview.data, session]);
  const directoryWorkspaces = workspaceDirectory.data
    ? withActiveWorkspaceName(workspaceDirectory.data.workspaces, workspace)
    : undefined;
  const activeWorkspace: DesktopWorkspaceSummary = directoryWorkspaces?.find((candidate) => (
    candidate.id === workspace.id && candidate.region === workspace.region
  )) ?? {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.id,
      region: workspace.region,
      role: session?.workspace ? session.workspace.role : 'member',
      ...(session?.workspace?.accessClass === 'guest' ? { accessClass: 'guest' as const } : {}),
      createdAt: new Date(0).toISOString(),
    };
  const knownWorkspaces = directoryWorkspaces?.length ? directoryWorkspaces : [activeWorkspace];
  const promptedInvitation = pendingInvitationPreview.data
    ? workspaceDirectory.data?.invitations.find((candidate) => (
      candidate.workspaceId === pendingInvitationPreview.data.workspaceId
      && candidate.region === pendingInvitationPreview.data.region
    )) ?? null
    : null;
  const backgroundWorkspaces = knownWorkspaces.filter((candidate) => (
    candidate.id !== workspace.id || candidate.region !== workspace.region
  ));
  // Attention is read with each workspace's own stored credential, so only the
  // rows this device holds one for can answer. A row discovery listed that was
  // never opened here has none, and asking would fail the whole batch. A guest
  // relationship is refused the attention route, so its row shows no count.
  const attentionWorkspaces = backgroundWorkspaces.filter((candidate) => (
    candidate.credentialStored === true && candidate.accessClass !== 'guest'
  ));
  const attentionWorkspaceKeys = attentionWorkspaces.map((candidate) => (
    desktopWorkspaceIdentityKey(candidate.region, candidate.id)
  ));
  const workspaceAttention = useQuery<Record<string, WorkspaceAttention>>({
    queryKey: ['workspace-attention', ...attentionWorkspaceKeys],
    queryFn: async () => Object.fromEntries(await Promise.all(attentionWorkspaces.map(async (candidate) => (
      [
        desktopWorkspaceIdentityKey(candidate.region, candidate.id),
        await desktopBridge().getWorkspaceAttention({ region: candidate.region, workspaceId: candidate.id }),
      ] as const
    )))),
    enabled: multipleWorkspacesEnabled && attentionWorkspaces.length > 0,
    placeholderData: (previous) => previous,
    retry: false,
  });
  useEffect(() => {
    if (!workspaceAttention.isError || !navigator.onLine) return;
    // A removed background membership first surfaces through its own attention
    // credential. Reconcile discovery immediately so that stable revocation
    // removes the row; an ordinary transport failure leaves cached discovery
    // untouched and the stale count remains visible.
    void workspaceDirectory.refetch();
  }, [workspaceAttention.isError]);
  useEffect(() => {
    if (!multipleWorkspacesEnabled) return undefined;
    const refresh = (): void => {
      void workspaceDirectory.refetch();
      if (attentionWorkspaces.length > 0) void workspaceAttention.refetch();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [attentionWorkspaceKeys.join(':'), multipleWorkspacesEnabled]);
  const [switchingWorkspaceKey, setSwitchingWorkspaceKey] = useState<string | null>(null);
  const [signingInWorkspaceKey, setSigningInWorkspaceKey] = useState<string | null>(null);
  const [workspaceErrors, setWorkspaceErrors] = useState<Record<string, string | undefined>>({});
  // Choosing a row again while it waits on the browser starts a newer switch;
  // the earlier one then stands down without touching the row it shares.
  const switchAttemptRef = useRef(0);
  const switchingWorkspace = knownWorkspaces.find((candidate) => (
    desktopWorkspaceIdentityKey(candidate.region, candidate.id) === switchingWorkspaceKey
  ));
  // A switch is a dissolve rather than a cut. While the new credential is
  // minted the screen dims in place, and once the session changes the same
  // panes fade back up over the same backdrop showing the new workspace —
  // possible because `activateWorkspace` fetches what this shell needs before
  // the old workspace is torn down, so nothing blank sits between the two.
  const workspaceKey = desktopWorkspaceIdentityKey(workspace.region, workspace.id);
  const [enteringWorkspaceKey, setEnteringWorkspaceKey] = useState<string | null>(null);
  const shownWorkspaceKey = useRef(workspaceKey);
  useEffect(() => {
    if (shownWorkspaceKey.current === workspaceKey) return undefined;
    shownWorkspaceKey.current = workspaceKey;
    setEnteringWorkspaceKey(workspaceKey);
    const timer = window.setTimeout(() => setEnteringWorkspaceKey(null), WORKSPACE_ENTER_MS);
    return () => window.clearTimeout(timer);
  }, [workspaceKey]);
  const shellClassName = [
    'workspace-shell',
    'app-shell',
    windowControlsShellClass(runtime?.platform),
    showShellRail ? 'rail-open' : '',
    railFillsPane ? 'rail-fills-pane' : '',
    // A panel expanded over its conversation covers the pane as a narrow
    // window's does, by choice rather than for want of room.
    showShellRail && railExpanded ? 'rail-expanded' : '',
    // Where there is no window to open, a window surface takes the whole tab.
    host === 'browser' && isWindowSurfaceRoute(location.pathname) ? 'is-window-surface' : '',
    switchingWorkspaceKey !== null ? 'is-switching-workspace' : '',
    enteringWorkspaceKey === workspaceKey ? 'is-entering-workspace' : '',
  ].filter(Boolean).join(' ');
  const { setForegroundWorkstreamId } = useWorkspaceSocket();

  // A Canvas id is a conversation-parent id, so presence names the open
  // Canvas the way it named an open Thread (`docs/canvases.md`, Presence).
  const foregroundWorkstreamId = openCanvasId(location.pathname);
  useEffect(() => {
    setForegroundWorkstreamId(foregroundWorkstreamId);
  }, [foregroundWorkstreamId, setForegroundWorkstreamId]);
  useEffect(() => {
    return () => setForegroundWorkstreamId(null);
  }, [setForegroundWorkstreamId]);


  // One custom property carries the right sidebar's width, so the panel in the
  // slot, the grab handle beside it, and the room the main pane leaves for it
  // all animate together when the slot changes hands. It follows whichever panel
  // is on screen, so a panel closing on its own dissolves at its own width
  // rather than resizing to a width nothing is about to show.
  const shellStyle = {
    '--rail-width': `${railWidth}px`,
    '--conversation-min-width': `${SIDEBAR_CONTENT_MIN_WIDTH}px`,
    '--av-cmp-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <>
      <AddMembersDialog api={api ?? null} open={addMembersOpen} onClose={() => setAddMembersOpen(false)} />
      <AccessRequestDialog
        api={api ?? null}
        onClose={() => { setOpenAccessRequestId(null); clearPendingAccessRequest(); }}
        requestId={openAccessRequestId ?? pendingAccessRequestId}
        workspaceId={workspace.id}
      />
      <div className={shellClassName} style={shellStyle}>
      <NavigationSidebar
        onOpenSearch={api ? () => setSearchOpen(true) : undefined}
        // A desktop browser tab offers the Mac app, member or guest; a phone or tablet cannot run it.
        footerItems={host === 'browser' && MAC_APP_DOWNLOADABLE ? <MacDownloadLink /> : undefined}
        accountMenu={(
          <WorkspaceAccountMenu
            activeWorkspace={activeWorkspace}
            // The meter reads `/workspace/usage`, which refuses a guest.
            activeUsage={guestSession ? null : (
              <OrganizationUsageMenuItem
                api={api ?? null}
                onSelect={() => { void desktopBridge().openSettings('workspace'); }}
              />
            )}
            attention={workspaceAttention.data ?? {}}
            currentUser={{ ...workspace.currentUser, name: personalPresentation?.displayName ?? workspace.currentUser.name }}
            enabled={multipleWorkspacesEnabled}
            invitations={workspaceDirectory.data?.invitations ?? []}
            promptedInvitation={promptedInvitation}
            onAcceptInvitation={async (invitation, operationId) => {
              await acceptInvitation(invitation.region, invitation.id, operationId);
              clearPendingInvitation();
              await workspaceDirectory.refetch();
            }}
            // No directory refetch: the creation lands the new workspace, which
            // remounts this shell, and the new one reads discovery itself.
            onCreateWorkspace={(input, operationId, progress) => (
              finishWorkspaceSetup(input.name, input.region, operationId, progress)
            )}
            onDeclineInvitation={async (invitation) => {
              await declineInvitation(invitation.region, invitation.id);
              await workspaceDirectory.refetch();
            }}
            onMenuOpen={() => {
              void workspaceDirectory.refetch();
              if (attentionWorkspaces.length > 0) void workspaceAttention.refetch();
            }}
            onAbandonSignIn={abandonAccountSignIn}
            onInvitationPromptDismiss={clearPendingInvitation}
            onAddMembers={() => setAddMembersOpen(true)}
            canAddMembers={canInvite}
            onOpenSettings={() => { void desktopBridge().openSettings(); }}
            onSignOut={() => {
              if (impersonator) void endSupportSession().catch(() => undefined);
              else void signOut().catch(() => undefined);
            }}
            impersonator={impersonator}
            supportWorkspaces={supportWorkspaces.data ?? []}
            loadSupportPeople={listSupportPeople}
            onStartSupportSession={(target, person) => startSupportSession({ region: target.region, workspaceId: target.id }, person.id)}
            onSwitchWorkspace={async (target) => {
              const targetKey = desktopWorkspaceIdentityKey(target.region, target.id);
              if (!navigator.onLine) {
                setWorkspaceErrors((current) => ({ ...current, [targetKey]: 'Connect to open this organization' }));
                return false;
              }
              const attempt = ++switchAttemptRef.current;
              setWorkspaceErrors((current) => ({ ...current, [targetKey]: undefined }));
              setSigningInWorkspaceKey(null);
              setSwitchingWorkspaceKey(targetKey);
              try {
                await activateWorkspace(target.region, target.id, uuidV7(), {
                  onSignInRequired: () => {
                    if (switchAttemptRef.current === attempt) setSigningInWorkspaceKey(targetKey);
                  },
                });
                return true;
              } catch (error) {
                // A superseded attempt, or one whose row a newer attempt has
                // since taken over, has nothing left to say about that row.
                if (error instanceof AccountSignInSupersededError || switchAttemptRef.current !== attempt) return false;
                const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
                const activationFailure = workspaceActivationFailureCode(error);
                setWorkspaceErrors((current) => ({
                  ...current,
                  [targetKey]: error instanceof AccountSignInFailedError
                    ? error.message
                    : code === 'workspace_access_denied' || activationFailure === 'workspace_access_denied'
                    ? 'You are no longer a member of this organization'
                    : 'Rally could not open this organization',
                }));
                if (code === 'workspace_access_denied' || activationFailure === 'workspace_access_denied') {
                  await workspaceDirectory.refetch();
                }
                return false;
              } finally {
                if (switchAttemptRef.current === attempt) {
                  setSwitchingWorkspaceKey(null);
                  setSigningInWorkspaceKey(null);
                }
              }
            }}
            signingInWorkspaceKey={signingInWorkspaceKey}
            presentation="grok"
            staleAt={workspaceAttention.isError && workspaceAttention.dataUpdatedAt > 0
              ? new Date(workspaceAttention.dataUpdatedAt).toISOString()
              : null}
            switchingWorkspaceKey={switchingWorkspaceKey}
            workspaceErrors={workspaceErrors}
            workspaces={knownWorkspaces}
          />
        )}
        downloadedUpdate={downloadedUpdate}
        workspace={workspace}
      />
        <span aria-live="polite" className="sr-only">
          {switchingWorkspace ? `Opening ${switchingWorkspace.name}…` : ''}
        </span>
        <main className="main-pane" inert={navigationSheetOpen}>
          <NavigationHistoryProvider enabled={host === 'desktop'}>
            <PhoneHeaderContext value={windowSurface ? null : phoneHeader}>{children}</PhoneHeaderContext>
          </NavigationHistoryProvider>
        </main>
      </div>
      {api && <SearchModal key={`${workspace.id}:${workspace.currentUser.id}`} workspaceId={`${workspace.id}:${workspace.currentUser.id}`}
        open={searchOpen} onOpenChange={setSearchOpen}
        search={(request, signal) => api.searchWorkspace(request, signal)}
        channels={searchChannels} spaces={spacesEnabled ? searchSpaces : undefined}
        onSelectPlace={(place) => {
          if (place.kind === 'space') navigate(`/spaces/${encodeURIComponent(place.id)}`);
          else if (place.kind === 'breakout') navigate(channelDestination({ id: place.channelId, associativeSubstreamId: place.id }));
          else navigate(channelDestination({ id: place.id, associativeSubstreamId: place.substreamId }));
        }}
        onSelect={(result) => {
          const target = result.location;
          if (target.kind === 'message') {
            navigate(`/workstreams/${target.workstreamId}?substream=${encodeURIComponent(target.substreamId)}&turn=${encodeURIComponent(target.turnId)}&sequence=${target.transcriptSequence}`);
          } else if (target.kind === 'link') {
            void openLink(target.url);
          } else {
            setSearchPreview({ identity: searchIdentity, preview: { name: result.title, ...(target.mimeType ? { mimeType: target.mimeType } : {}), loadContent: (signal) => api.getSearchResourcePreviewContent(target.resourceId, signal) } });
          }
        }} />}
      <AttachmentLightbox key={`lightbox:${searchIdentity}`} preview={searchPreview?.identity === searchIdentity ? searchPreview.preview : null} onClose={() => setSearchPreview(null)} />
      <KonamiEgg />
    </>
  );
}
