import { useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { BrowserRouter, NavLink, Route, Routes, useParams } from 'react-router-dom';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { RallyApi } from '../lib/api';
import { Button, InlineError, Modal } from '../components/primitives';
import { ShareConversationButton } from '../components/scope-sharing-panel';
import { useCollaborationSession, CollaborationSessionProvider } from '../lib/collaboration-session';
import { SpeechPlaybackProvider } from '../components/speech-playback';
import { ConversationSurface, type ConversationHeaderContext } from './conversation-surface';
import '../styles/app.css';

function SharedConversationRoute(): React.JSX.Element {
  const { parentId, substreamId = '0' } = useParams();
  return <SharedConversation key={`${parentId}:${substreamId}`} />;
}

function SharedConversation(): React.JSX.Element {
  const { parentId, substreamId = '0' } = useParams();
  const { api, session } = useCollaborationSession();
  const queryClient = useQueryClient();
  const [changingArchive, setChangingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const directory = useQuery({ queryKey: ['shared-directory'],
    enabled: Boolean(api), queryFn: ({ signal }) => api!.getSharedDirectory(signal),
    refetchOnWindowFocus: 'always' });
  const archived = directory.data?.workstreams.find((workstream) => workstream.parentId === parentId)
    ?.conversations.find((conversation) => conversation.substreamId === substreamId)?.archived ?? false;
  if (!parentId) return <p>This conversation link is incomplete.</p>;
  const changeArchive = async (archived: boolean) => {
    if (!api || changingArchive) return;
    setChangingArchive(true); setArchiveError(null);
    try {
      await api.setSubstreamArchived(parentId, substreamId, archived);
      await queryClient.invalidateQueries({ queryKey: ['shared-directory'] });
    } catch (error) { setArchiveError(error instanceof Error ? error.message : 'Unable to change archive state.'); }
    finally { setChangingArchive(false); }
  };
  const archiveAction = substreamId !== '0' ? <Button disabled={changingArchive}
    onClick={() => void changeArchive(!archived)}>{archived ? 'Restore substream' : 'Archive substream'}</Button> : null;
  return <>
    {archiveError ? <InlineError>{archiveError}</InlineError> : null}
    {archived ? <section className="browser-empty"><h1>Archived conversation</h1>
      <p>This conversation is archived.</p>{archiveAction}</section> :
      <ConversationSurface key={`${parentId}:${substreamId}`} parentKind="workstream" parentId={parentId} substreamId={substreamId}
        renderHeader={(context) => <BrowserConversationHeader context={context} sharing={<>
          {archiveAction}{api && session?.workspace ? <ShareConversationButton api={api} workspaceId={session.workspace.id} parentId={parentId} substreamId={substreamId} /> : null}
        </>} />} />}
  </>;
}

/** Controls operate on this conversation, including when Main is inaccessible. */
export function BrowserConversationHeader({ context, sharing }: { context: ConversationHeaderContext; sharing: React.ReactNode }): React.JSX.Element {
  const resourcesTrigger = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const submitRename = async () => {
    const title = renameDraft?.trim();
    if (!title || renaming) return;
    setRenaming(true);
    setRenameError(null);
    try {
      await context.rename(title);
      setRenameDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['shared-directory'] });
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : 'Unable to rename this conversation.');
    } finally { setRenaming(false); }
  };
  return <header className="workstream-header browser-feed-header">
    <h1>{context.detail.title}</h1>
    <div className="browser-feed-actions">
      <button type="button" disabled={Boolean(context.detail.archivedAt)} onClick={() => {
        setRenameDraft(context.detail.title); setRenameError(null);
      }}>Rename</button>
      <button type="button" onClick={context.openParticipantDialog}>Participants ({context.detail.participants.length})</button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><button ref={resourcesTrigger} type="button">Resources ({context.detail.resources.length})</button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end" sideOffset={4}>
          {context.detail.resources.length === 0 ? <DropdownMenu.Item className="menu-item" disabled>No resources attached</DropdownMenu.Item> : context.detail.resources.map((resource) =>
            <DropdownMenu.Item className="menu-item" key={resource.id} onSelect={() => {
              if (resourcesTrigger.current) context.openResource(resource.id, resourcesTrigger.current);
            }}>{resource.title}</DropdownMenu.Item>)}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><button type="button">Sidekicks{context.sidekicks ? ` (${context.sidekicks.length})` : ''}</button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="menu-content browser-sidekick-menu" align="end" sideOffset={4}>
          {context.sidekicksError ? <p role="alert">{context.sidekicksError}</p> : null}
          {!context.sidekicks ? <DropdownMenu.Label>Loading Sidekicks…</DropdownMenu.Label> : context.sidekicks.length === 0 ? <DropdownMenu.Label>No Sidekicks available</DropdownMenu.Label> : <>
            <p className="browser-sidekick-description">Ask Rally to use an available Sidekick in this conversation.</p>
            {context.sidekicks.map((sidekick) => <DropdownMenu.Group key={sidekick.id}>
              <DropdownMenu.Label>{sidekick.name}</DropdownMenu.Label>
              <p className="browser-sidekick-description">{[sidekick.recommended ? 'Recommended' : 'Loaded in this conversation', sidekick.note].filter(Boolean).join(' · ')}</p>
              <p className="browser-sidekick-description">{sidekick.description}</p>
              {sidekick.onRemove ? <DropdownMenu.Item className="menu-item" onSelect={sidekick.onRemove}>Remove {sidekick.name} from this conversation</DropdownMenu.Item> : null}
              {sidekick.onRemoveRecommendation ? <DropdownMenu.Item className="menu-item" onSelect={sidekick.onRemoveRecommendation}>Remove workstream recommendation for {sidekick.name}</DropdownMenu.Item> : null}
              {sidekick.onRecommend ? <DropdownMenu.Item className="menu-item" onSelect={sidekick.onRecommend}>Recommend {sidekick.name} for this workstream</DropdownMenu.Item> : null}
            </DropdownMenu.Group>)}
          </>}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      {sharing}
    </div>
    <Modal open={renameDraft !== null} title="Rename conversation" dismissible={!renaming}
      onOpenChange={(open) => { if (!open && !renaming) setRenameDraft(null); }}
      footer={<>
        <Button disabled={renaming} onClick={() => setRenameDraft(null)}>Cancel</Button>
        <Button className="button-primary" disabled={renaming || !renameDraft?.trim()} onClick={() => void submitRename()}>Rename</Button>
      </>}>
      {renameError ? <InlineError>{renameError}</InlineError> : null}
      <form onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
        <label className="form-field"><span>Title</span>
          <input autoFocus maxLength={180} disabled={renaming} value={renameDraft ?? ''}
            onChange={(event) => { setRenameDraft(event.target.value); setRenameError(null); }} />
        </label>
      </form>
    </Modal>
  </header>;
}

function SharedNavigation({ api }: { api: RallyApi }): React.JSX.Element {
  const { session } = useCollaborationSession();
  const directory = useQuery({ queryKey: ['shared-directory'], queryFn: ({ signal }) => api.getSharedDirectory(signal),
    refetchOnWindowFocus: 'always' });
  return <details className="browser-navigation" open>
    <summary><span className="browser-workspace-identity">
      <span aria-hidden="true" className="workspace-mark">{session?.workspace?.name.slice(0, 1).toLocaleUpperCase()}</span>
      <span>{session?.workspace?.name}<small>Shared with you</small></span>
    </span></summary>
    <nav aria-label="Shared conversations">
      {directory.isPending ? <p>Loading shared conversations…</p> : null}
      {directory.isError ? <p role="alert">Unable to load shared conversations.</p> : null}
      {directory.data?.workstreams.length === 0 ? <p>No shared conversations yet. You can also open an invitation link.</p> : null}
      {directory.data?.workstreams.map((workstream) => <section key={workstream.parentId}>
        <h2>{workstream.title ?? 'Shared workstream'}</h2>
        {workstream.conversations.map((conversation) => <NavLink key={conversation.substreamId} end
          to={`/workstreams/${workstream.parentId}${conversation.substreamId === '0' ? '' : `/substreams/${conversation.substreamId}`}`}>
          {conversation.title}
        </NavLink>)}
      </section>)}
      <button type="button" disabled={directory.isFetching} onClick={() => { void directory.refetch(); }}>Refresh shared conversations</button>
    </nav>
  </details>;
}

/** A tab owns only its visible feed. It never installs the desktop socket swarm. */
export default function BrowserConversation({ session }: { session: CookieClientSession }): React.JSX.Element {
  const [queryClient] = useState(() => new QueryClient());
  const api = useMemo(() => new RallyApi(session.apiBaseUrl, session), [session]);
  if (!session.workspace) return <p>Open a shared conversation to continue.</p>;
  const basename = `/app/workspaces/${session.workspace.region}/${session.workspace.id}`;
  return <QueryClientProvider client={queryClient}>
    <CollaborationSessionProvider api={api} session={session}>
      <Tooltip.Provider><SpeechPlaybackProvider api={api}>
        <BrowserRouter basename={basename}><div className="browser-workspace">
          <SharedNavigation api={api} /><main className="browser-feed"><Routes>
          <Route path="/workstreams/:parentId" element={<SharedConversationRoute />} />
          <Route path="/workstreams/:parentId/substreams/:substreamId" element={<SharedConversationRoute />} />
          <Route path="*" element={<div className="browser-empty"><h1>Shared conversations</h1><p>Choose a conversation to start collaborating.</p></div>} />
        </Routes></main></div></BrowserRouter>
      </SpeechPlaybackProvider></Tooltip.Provider>
    </CollaborationSessionProvider>
  </QueryClientProvider>;
}
