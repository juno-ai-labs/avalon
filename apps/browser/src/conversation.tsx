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
  const directory = useQuery({ queryKey: ['shared-directory'], enabled: Boolean(api),
    queryFn: ({ signal }) => api!.getSharedDirectory(signal), refetchOnWindowFocus: 'always' });
  const parent = directory.data?.workstreams.find((item) => item.parentId === parentId);
  const archived = parent?.conversations.find((item) => item.substreamId === substreamId)?.archived ?? false;
  const parentArchived = parent?.archived === true || (substreamId === '0' && archived);
  if (!parentId) return <section className="browser-empty"><NavigationButton onClick={onShowNavigation} /><p>This conversation link is incomplete.</p></section>;
  const changeArchive = async (value: boolean, target = substreamId) => {
    if (!api || changingArchive) return;
    setChangingArchive(true); setArchiveFailure(null);
    try {
      await api.setSubstreamArchived(parentId, target, value);
      await queryClient.invalidateQueries({ queryKey: ['shared-directory'] });
    } catch { setArchiveFailure(value ? 'archive' : 'restore'); }
    finally { setChangingArchive(false); }
  };
  return <>
    {api && session?.workspace && sharingSubstream !== null && <ShareConversationDialog api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={sharingSubstream} open onOpenChange={(open) => { if (!open) setSharingSubstream(null); }} />}
    <Modal open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }} title="Archive substream" description="This substream will leave the active list. You can restore it later.">
      <Button disabled={changingArchive} onClick={() => setArchiveTarget(null)}>Cancel</Button>
      <Button disabled={changingArchive} onClick={() => { void changeArchive(true, archiveTarget ?? substreamId).then(() => setArchiveTarget(null)); }}>Archive substream</Button>
    </Modal>
    {archiveFailure ? <InlineError>{archiveFailure === 'archive'
      ? 'The substream couldn’t be archived.'
      : 'The substream couldn’t be restored.'}</InlineError> : null}
    {archived ? <section className="browser-empty"><NavigationButton onClick={onShowNavigation} /><h1>{parentArchived ? 'Archived work stream' : 'Archived conversation'}</h1>
      {parentArchived ? <p>This work stream must be restored before its conversations can reopen.</p>
        : substreamId !== '0' && parent?.archived !== true
          ? <Button disabled={changingArchive} onClick={() => void changeArchive(false)}>Restore substream</Button>
          : <p>This conversation is archived.</p>}</section> :
      <ConversationSurface sidebarScope="conversation" parentKind="workstream" parentId={parentId} substreamId={substreamId}
        renderSidebar={(context) => <WorkstreamSidebar
          mainVisible={Boolean(parent?.conversations.some((item) => item.substreamId === '0'))}
          workstream={{ ...context.detail, title: parent?.title ?? 'Shared workstream',
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
          onRename={async (title) => { await context.rename(title); void queryClient.invalidateQueries({ queryKey: ['shared-directory'] }); }}
          onShowNavigation={onShowNavigation}
          onCopyLink={() => { void navigator.clipboard.writeText(location.href); }}
          actions={api && session?.workspace ? <ShareConversationButton api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={substreamId} /> : null} />} />}
  </>;
}

function SharedNavigation({ api, onSignOut, open, onClose }: { api: RallyApi; onSignOut: () => void; open: boolean; onClose: () => void }): React.JSX.Element {
  const { session } = useCollaborationSession();
  const { pathname } = useLocation();
  const directory = useQuery({ queryKey: ['shared-directory'], queryFn: ({ signal }) => api.getSharedDirectory(signal), refetchOnWindowFocus: 'always' });
  if (!session) return <></>;
  const user = { ...session.user, name: session.user.name ?? session.user.email, timezone: session.user.timezone ?? 'UTC', avatarUrl: session.user.avatarUrl ?? undefined };
  return <NavigationFrame className={open ? 'is-mobile-open' : undefined}>
    <div className="sidebar-titlebar window-drag"><IconButton className="mobile-only" label="Close navigation"
      onClick={onClose}><Menu size={16} /></IconButton></div>
    <div className="sidebar-scroll"><nav aria-label="Shared workstreams" className="sidebar-section">
      {directory.isError && <InlineError>Unable to load shared conversations.</InlineError>}
      {directory.isPending && <p>Loading shared conversations…</p>}
      {directory.data?.workstreams.length === 0 && <p>No shared conversations yet.</p>}
      {directory.data?.workstreams.map((workstream) => {
        const first = workstream.conversations.find((item) => !item.archived) ?? workstream.conversations[0];
        if (!first) return null;
        return <NavLink className={`sidebar-row workstream-row${pathname === `/workstreams/${workstream.parentId}` || pathname.startsWith(`/workstreams/${workstream.parentId}/`) ? ' is-active' : ''}`} onClick={onClose} key={workstream.parentId}
          to={`/workstreams/${workstream.parentId}${first.substreamId === '0' ? '' : `/substreams/${first.substreamId}`}`}>
          <NavigationRowContent id={workstream.parentId} title={workstream.title ?? first.title} appearance={workstream.appearance ?? undefined} />
        </NavLink>;
      })}
    </nav></div>
    <footer className="sidebar-footer"><DropdownMenu.Root><DropdownMenu.Trigger asChild>
      <AccountTrigger currentUser={user} workspaceName={session.workspace?.name ?? 'Workspace'} />
    </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content workspace-menu" align="start" sideOffset={8}>
      <DropdownMenu.Item className="menu-item" onSelect={() => location.assign('/')}>Switch workspace</DropdownMenu.Item>
      <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>Sign out</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></footer>
  </NavigationFrame>;
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
