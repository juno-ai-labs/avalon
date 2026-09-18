import { useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Archive, Menu } from 'lucide-react';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { AccountTrigger } from '@rally/ui/components/account-trigger';
import { NavigationFrame, NavigationRowContent } from '@rally/ui/components/navigation';
import { ConversationHeader } from '@rally/ui/components/conversation-header';
import { WorkstreamSidebar } from '@rally/ui/components/workstream-sidebar';
import { Button, IconButton, InlineError } from '@rally/ui/components/primitives';
import { RallyApi } from '../lib/api';
import { ShareConversationButton } from '../components/scope-sharing-panel';
import { SidekickPicker } from '../components/sidekick-picker';
import { useCollaborationSession, CollaborationSessionProvider } from '../lib/collaboration-session';
import { SpeechPlaybackProvider } from '../components/speech-playback';
import { ConversationSurface } from './conversation-surface';
import '@rally/ui/styles/app.css';

function SharedConversationRoute(): React.JSX.Element {
  const { parentId, substreamId = '0' } = useParams();
  return <SharedConversation key={`${parentId}:${substreamId}`} />;
}

function SharedConversation(): React.JSX.Element {
  const { parentId, substreamId = '0' } = useParams();
  const navigate = useNavigate();
  const { api, session } = useCollaborationSession();
  const queryClient = useQueryClient();
  const [changingArchive, setChangingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const directory = useQuery({ queryKey: ['shared-directory'], enabled: Boolean(api),
    queryFn: ({ signal }) => api!.getSharedDirectory(signal), refetchOnWindowFocus: 'always' });
  const parent = directory.data?.workstreams.find((item) => item.parentId === parentId);
  const archived = parent?.conversations.find((item) => item.substreamId === substreamId)?.archived ?? false;
  if (!parentId) return <p>This conversation link is incomplete.</p>;
  const changeArchive = async (value: boolean) => {
    if (!api || changingArchive) return;
    setChangingArchive(true); setArchiveError(null);
    try {
      await api.setSubstreamArchived(parentId, substreamId, value);
      await queryClient.invalidateQueries({ queryKey: ['shared-directory'] });
    } catch (error) { setArchiveError(error instanceof Error ? error.message : 'Unable to change archive state.'); }
    finally { setChangingArchive(false); }
  };
  return <>
    {archiveError ? <InlineError>{archiveError}</InlineError> : null}
    {archived ? <section className="browser-empty"><h1>Archived conversation</h1>
      <Button disabled={changingArchive} onClick={() => void changeArchive(false)}>Restore substream</Button></section> :
      <ConversationSurface sidebarScope="conversation" parentKind="workstream" parentId={parentId} substreamId={substreamId}
        renderSidebar={(context) => <WorkstreamSidebar
          mainVisible={Boolean(parent?.conversations.some((item) => item.substreamId === '0'))}
          workstream={{ ...context.detail, title: parent?.title ?? 'Shared workstream',
            privateChildren: parent?.conversations.filter((item) => item.substreamId !== '0' && !item.archived) }}
          selectedSubstreamId={substreamId} presentUserIds={context.presentUserIds}
          onSelectSubstream={(id) => navigate(`/workstreams/${parentId}${id === '0' ? '' : `/substreams/${id}`}`)}
          onParticipants={context.openParticipantDialog} onFocusTranscript={context.focusTranscript}
          onOpenArtifact={context.openArtifact} onOpenResource={context.openResource} sidekicks={context.sidekicks} sidekicksError={context.sidekicksError}
          onSidekickMenuOpen={context.loadSidekickOptions}
          addSidekick={<SidekickPicker workstreamId={parentId} substreamId={substreamId} />} />}
        renderHeader={(context) => <ConversationHeader grokBotMode workstream={context.detail} socketState={context.socketState}
          substreamId={substreamId} currentUserId={session?.user.id} presentUserIds={context.presentUserIds}
          onAddParticipant={context.openParticipantDialog} onOpenRail={context.openRail}
          onRename={async (title) => { await context.rename(title); void queryClient.invalidateQueries({ queryKey: ['shared-directory'] }); }}
          onShowNavigation={() => document.querySelector('.browser-workspace .sidebar')?.classList.toggle('is-mobile-open')}
          onCopyLink={() => { void navigator.clipboard.writeText(location.href); }}
          actions={<>{substreamId !== '0' && <IconButton label="Archive substream" disabled={changingArchive} onClick={() => void changeArchive(true)}><Archive size={16} /></IconButton>}
            {api && session?.workspace && <ShareConversationButton api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={substreamId} />}</>} />} />}
  </>;
}

function SharedNavigation({ api, onSignOut }: { api: RallyApi; onSignOut: () => void }): React.JSX.Element {
  const { session } = useCollaborationSession();
  const { pathname } = useLocation();
  const directory = useQuery({ queryKey: ['shared-directory'], queryFn: ({ signal }) => api.getSharedDirectory(signal), refetchOnWindowFocus: 'always' });
  if (!session) return <></>;
  const user = { ...session.user, name: session.user.name ?? session.user.email, timezone: session.user.timezone ?? 'UTC', avatarUrl: session.user.avatarUrl ?? undefined };
  return <NavigationFrame>
    <div className="sidebar-titlebar window-drag"><IconButton className="mobile-only" label="Close navigation"
      onClick={() => document.querySelector('.browser-workspace .sidebar')?.classList.remove('is-mobile-open')}><Menu size={16} /></IconButton></div>
    <div className="sidebar-scroll"><nav aria-label="Shared workstreams" className="sidebar-section">
      {directory.isError && <InlineError>Unable to load shared conversations.</InlineError>}
      {directory.isPending && <p>Loading shared conversations…</p>}
      {directory.data?.workstreams.length === 0 && <p>No shared conversations yet.</p>}
      {directory.data?.workstreams.map((workstream) => {
        const first = workstream.conversations.find((item) => !item.archived) ?? workstream.conversations[0];
        if (!first) return null;
        return <NavLink className={`sidebar-row workstream-row${pathname === `/workstreams/${workstream.parentId}` || pathname.startsWith(`/workstreams/${workstream.parentId}/`) ? ' is-active' : ''}`}  key={workstream.parentId}
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

/** A tab owns only its visible feed. It never installs the desktop socket swarm. */
export default function BrowserConversation({ session, onSignOut }: { session: CookieClientSession; onSignOut: () => void }): React.JSX.Element {
  const [queryClient] = useState(() => new QueryClient());
  const api = useMemo(() => new RallyApi(session.apiBaseUrl, session), [session]);
  if (!session.workspace) return <p>Open a shared conversation to continue.</p>;
  const basename = `/app/workspaces/${session.workspace.region}/${session.workspace.id}`;
  return <QueryClientProvider client={queryClient}>
    <CollaborationSessionProvider api={api} session={session}>
      <Tooltip.Provider><SpeechPlaybackProvider api={api}>
        <BrowserRouter basename={basename}><div className="browser-workspace workspace-shell">
          <SharedNavigation api={api} onSignOut={onSignOut} /><main className="browser-feed main-pane"><Routes>
          <Route path="/workstreams/:parentId" element={<SharedConversationRoute />} />
          <Route path="/workstreams/:parentId/substreams/:substreamId" element={<SharedConversationRoute />} />
          <Route path="*" element={<div className="browser-empty"><h1>Shared conversations</h1><p>Choose a conversation to start collaborating.</p></div>} />
        </Routes></main></div></BrowserRouter>
      </SpeechPlaybackProvider></Tooltip.Provider>
    </CollaborationSessionProvider>
  </QueryClientProvider>;
}
