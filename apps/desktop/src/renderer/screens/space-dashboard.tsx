import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Copy, RotateCcw } from 'lucide-react';
import { IconChevronsRight } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import {
  type SpaceColorKey,
  type SpaceDirectory,
  type SpaceIconKey,
  type SpaceSummary,
} from '@rally/contracts';
import { SpaceAppearancePicker } from '@rally/ui/components/space-appearance-picker';
import { ConversationIdentityTip } from '@rally/ui/components/conversation-identity-tip';
import { WorkstreamGlyph, WorkstreamMark } from '@rally/ui/components/workstream-glyph';
import {
  SpaceDashboardHeader,
  SpaceDashboardSection,
} from '@rally/ui/components/space-dashboard';

import { ConnectingCard, ConnectingCardSlot } from '../components/connecting-card';
import { SpacesOpeningCard } from '../components/space-sidebar-section';
import { RelativeTime } from '../components/relative-time';
import {
  Avatar,
  Button,
  EmptyState,
  IconButton,
  InlineError,
  LoadingState,
  Modal,
  StatusDot,
} from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { copySpaceLink } from '../lib/copy-workstream-link';
import { PROJECT_COLOR_DEFAULT } from '../lib/project-palette';
import { workstreamMarkerStatus } from '../lib/format';
import { blockedChannelLabel, spaceFailureSentence, spaceRefusalChannelIds } from '../lib/space-failure-copy';
import { INACTIVE_SPACES_QUERY_KEY, SPACES_QUERY_KEY, spaceConversationsQueryKey } from '../lib/sidebar-list-store';
import type { Workspace } from '../lib/types';
import { useSpaceDirectories, useSpacesReady } from '../lib/use-space-directories';
import { useCachedWorkstreams } from '../lib/use-workstreams-query';
import { useOpenFirstWorkstream } from '../lib/workstream-landing';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';

/**
 * Where a refusal is shown, one slot per surface that can produce one.
 *
 * Scoped rather than shared: a single `error` string was rendered in the body
 * and in every open modal at once, so a failed rename appeared inside the
 * participant picker, and closing one modal carried the sentence to the next.
 */
type FailureSlot =
  | 'copy'
  | 'restore'
  | 'name'
  | 'archive'
  | 'participants'
  | 'audience'
  | 'appearance';

/**
 * A Space's own screen: what it is, who it is for, and what is in it.
 *
 * A Space has no feed. There is deliberately no composer, transcript, feed
 * socket, Main link or Breakout list here — the backing conversation exists,
 * and nothing in the product opens it.
 */
export function SpaceDashboardScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { api } = useAppSession();
  const openFirstWorkstream = useOpenFirstWorkstream();
  const { spaceId } = useParams<{ spaceId: string }>();
  const queryClient = useQueryClient();
  const spacesReady = useSpacesReady();
  const { active: spaces, inactive: inactiveSpaces } = useSpaceDirectories();
  const directoryWorkstreams = useCachedWorkstreams() ?? [];
  const [failures, setFailures] = useState<Partial<Record<FailureSlot, string>>>({});
  const [saving, setSaving] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  // The Channels the last blocked archive named. Held apart from the refusal
  // sentence because it is a list rather than a sentence, and cleared by the
  // next attempt rather than by closing the modal: a person who reopens it
  // should still see what they were told to move.
  const [blockedChannelIds, setBlockedChannelIds] = useState<string[]>([]);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [editIconKey, setEditIconKey] = useState<SpaceIconKey>('briefcase');
  const [editColorKey, setEditColorKey] = useState<SpaceColorKey>(PROJECT_COLOR_DEFAULT);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [editParticipants, setEditParticipants] = useState<Set<string>>(new Set());
  const [pendingScope, setPendingScope] = useState<'personal' | 'workspace' | null>(null);
  // A Space has no socket of its own: what it paints is the Organization's
  // directory, and the directory the local cache seeded is what is showing
  // until the workspace socket's first subscribe answer replaces it.
  const workspaceSocket = useOptionalWorkspaceSocket();
  const directoryFromLocalCache = workspaceSocket !== null && workspaceSocket.sidebarConnect === null;
  const workspaceMembers = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
  });
  // The Space's membership is paginated: General holds every Channel in the
  // Organization, so it is the one Space read that cannot ride the socket.
  const channelPages = useInfiniteQuery({
    queryKey: spaceConversationsQueryKey(spaceId),
    queryFn: ({ pageParam, signal }) => api!.listSpaceChannels(spaceId!, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api) && Boolean(spaceId),
  });
  // That page is the one thing on this screen the socket cannot replace, and
  // an activity-ordered, state-filtered list goes stale on far more than a
  // membership change: a message in a member Channel or breakout reorders it,
  // a run finishing drops a row out of it, and opening one takes it off this
  // reader's list and nobody else's. All of it arrives as one
  // `space_conversations_changed` nudge, which `workspace-socket.tsx`
  // invalidates this entry on — so there is one refetch trigger for Channels
  // and breakouts rather than one each.
  //
  // This effect is the other half: a nudge sent while the socket was away is
  // never re-sent, and nothing durable records that it happened, so a fresh
  // connect payload is the client's only evidence that it may have missed one.
  // `sidebarConnect.generation` is what the directory query already reads a
  // reconnect from. The generation the screen mounted at is taken as observed:
  // the query's own mount fetch is that read.
  const connectGeneration = workspaceSocket?.sidebarConnect?.generation ?? null;
  const observedConnect = useRef(connectGeneration);
  useEffect(() => {
    if (spaceId === undefined || connectGeneration === null) return;
    if (connectGeneration === observedConnect.current) return;
    observedConnect.current = connectGeneration;
    void queryClient.invalidateQueries({ queryKey: spaceConversationsQueryKey(spaceId) });
  }, [queryClient, spaceId, connectGeneration]);
  // A refusal belongs to the Space it was about. This screen is one component
  // for every Space, so without this "That space no longer exists" followed
  // the reader onto the next Space's dashboard and stayed there.
  useEffect(() => {
    setFailures({});
    setBlockedChannelIds([]);
  }, [spaceId]);
  if (spaces.data === undefined || inactiveSpaces.data === undefined) {
    return <LoadingState label="Opening space…" />;
  }
  if (!spacesReady) {
    return <div className="space-dashboard-screen"><SpacesOpeningCard /></div>;
  }
  const space = spaces.data.items.find((item) => item.id === spaceId)
    ?? inactiveSpaces.data.items.find((item) => item.id === spaceId);
  if (!space) return <EmptyState title="Space not found" description="It may have been archived or you may no longer have access." />;
  const isGeneral = space.systemRole === 'general';
  // This reader reaches the Space only because they can read a Channel placed
  // in it. They are told its mark and name so that Channel has somewhere to be
  // drawn, and that is the whole of what this screen may say. Its participants,
  // audience and lifecycle are not theirs to see, and the server refuses every
  // write by name. What is left is the header and the conversation list — and
  // that list is already filtered to the Channels they can read, by the same
  // predicate that let them see the Space at all.
  const reachedThroughChannel = space.reach === 'through_channel';
  // Owner and administrator are one gate everywhere a Space is edited, and the
  // role only decides which control is drawn: the server reauthorizes it.
  const isAdministrator = ['owner', 'admin'].includes(workspace.currentUser.role ?? '');
  // Every Space edit sends the whole record back, so an edit made against the
  // seed would carry fields another client may have changed since the row was
  // written. A remembered Space is read-only until the directory is live.
  const editable = space.status === 'active' && !directoryFromLocalCache && !reachedThroughChannel;
  const report = (slot: FailureSlot, sentence: string | null): void => setFailures((current) => {
    const next = { ...current };
    if (sentence === null) delete next[slot];
    else next[slot] = sentence;
    return next;
  });
  const applySpace = (updated: SpaceSummary): void => {
    for (const queryKey of [SPACES_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY] as const) {
      queryClient.setQueryData<SpaceDirectory>(queryKey, (current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === updated.id ? updated : item),
      } : current);
    }
  };
  /**
   * Make one change, and say whether it landed.
   *
   * The answer matters because each of these sentences is rendered *inside*
   * the dialog that asked for the change: a dialog that closes on the refusal
   * closes over the only place the person would have read it.
   */
  const save = async (
    slot: FailureSlot,
    change: () => Promise<SpaceSummary>,
    fallback: string,
  ): Promise<boolean> => {
    setSaving(true);
    report(slot, null);
    try {
      applySpace(await change());
      return true;
    } catch (cause) {
      // Never the server's own sentence: it is a diagnostic a Worker wrote for
      // a log, in the Organization's internal words, and it changes whenever
      // the server's wording does. `fallback` is this action's own sentence,
      // used when the refusal carried no Space code to name.
      report(slot, spaceFailureSentence(cause, fallback));
      return false;
    } finally {
      setSaving(false);
    }
  };
  // The Space's own answer, not the device's directory page filtered by it: a
  // Space holds Channels this device has never listed, and naming only the ones
  // it happens to hold made the section under-report every Space bigger than
  // one page of the sidebar. Breakouts are in the same list for the same
  // reason — this device has never listed most of them either.
  const conversations = (channelPages.data?.pages ?? []).flatMap((page) => page.items);
  const participantIds = new Set(space.participants.map((participant) => participant.userId as string));
  const spaceMembers = (workspaceMembers.data ?? []).filter((member) => participantIds.has(member.id));
  return (
    <div className="space-dashboard-frame">
      <ConnectingCardSlot>
        {directoryFromLocalCache && (
          <ConnectingCard
            detail={space.status === 'active' ? 'Editing is available once Rally connects' : undefined}
            name={space.name}
            state={workspaceSocket.state === 'unavailable' ? 'offline' : 'connecting'}
            subject="space"
          />
        )}
      </ConnectingCardSlot>
      <div className="space-dashboard-screen">
        <div className="screen-drag-strip window-drag" />
        <SpaceDashboardHeader
          actions={reachedThroughChannel ? undefined : space.status === 'active'
            // General is the Organization's fallback home. Its identity,
            // lifecycle and audience are immutable; its name and mark are not.
            ? <><IconButton
              label="Copy space link"
              onClick={() => void copySpaceLink({ region: workspace.region, workspaceId: workspace.id }, space.id).catch(() => {
                setFailures((current) => ({ ...current, copy: 'The space link could not be copied.' }));
              })}
            ><Copy aria-hidden="true" size={15} /></IconButton>
            {!isGeneral && <IconButton
              className="icon-button-danger"
              disabled={!editable}
              label="Archive space"
              onClick={() => { report('archive', null); setArchiveConfirmOpen(true); }}
            >
              <Archive aria-hidden="true" size={15} />
            </IconButton>}</>
            : <Button disabled={directoryFromLocalCache || saving} onClick={() => void save(
              'restore',
              () => api!.restoreSpace(space.id),
              'The space could not be restored.',
            )}><RotateCcw aria-hidden="true" size={15} /> Restore space</Button>}
          appearance={space}
          {...(isGeneral || reachedThroughChannel ? {} : {
            audience: {
              scope: space.scope,
              onChange: (scope: 'personal' | 'workspace') => {
                if (scope === space.scope) return;
                report('audience', null);
                setPendingScope(scope);
              },
            },
          })}
          editable={editable}
          key={space.id}
          name={space.name}
          nameError={failures.name ?? null}
          onEditAppearance={() => {
            report('appearance', null);
            setEditIconKey(space.iconKey);
            setEditColorKey(space.colorKey);
            setAppearanceOpen(true);
          }}
          onRename={(name) => void save(
            'name',
            () => api!.updateSpacePresentation(space.id, { name, iconKey: space.iconKey, colorKey: space.colorKey }),
            'The space name could not be saved.',
          )}
          {...(isGeneral || reachedThroughChannel ? {} : {
            participants: {
              members: spaceMembers,
              onManage: () => {
                report('participants', null);
                setEditParticipants(new Set(participantIds));
                setParticipantsOpen(true);
              },
            },
          })}
        />
        {failures.copy && <InlineError>{failures.copy}</InlineError>}

        <SpaceDashboardSection heading="Needs attention" headingId="space-channels-heading">
          {channelPages.isPending
            ? <LoadingState label="Loading channels…" />
            : conversations.length === 0
              // Two empty states, because they are two different facts and
              // telling a reader "no channels yet" about a Space with forty of
              // them would send them looking for a bug. The count is what
              // separates them: it is the Organization's own answer to "is
              // there anything in here at all", while the list above is
              // "is any of it yours to deal with".
              ? space.channelCount === 0
                ? <EmptyState title="No channels yet" description={space.status === 'active' ? 'Channels will appear here when they need your attention.' : 'This archived space has no channels.'} />
                : <EmptyState
                    description="Everything in this space has been read and nothing is running. Channels and breakouts show up here while they need you; the rest stay in the sidebar and in search."
                    title="Nothing here needs you right now"
                  />
              : <div className="waiting-workstream-list">
                {conversations.map((conversation) => conversation.breakoutOf
                  ? <NavLink
                      className="waiting-workstream-row space-breakout-row"
                      key={conversation.id}
                      to={`/workstreams/${conversation.breakoutOf.workstreamId}?substream=${conversation.breakoutOf.substreamId}`}
                    >
                      <StatusDot status={workstreamMarkerStatus(conversation)} />
                      <span aria-hidden="true" className="waiting-conversation-identity">
                        <ConversationIdentityTip
                          icon={<WorkstreamMark appearance={conversation.breakoutOf.appearance} id={conversation.breakoutOf.workstreamId} size={16} />}
                          name={conversation.breakoutOf.title}
                          side="top"
                        >
                          <span className="waiting-conversation-icon">
                            <WorkstreamGlyph appearance={conversation.breakoutOf.appearance} id={conversation.breakoutOf.workstreamId} size={17} />
                          </span>
                        </ConversationIdentityTip>
                        <IconChevronsRight className="waiting-conversation-arrow" size={16} stroke={1.7} />
                        <ConversationIdentityTip
                          icon={<WorkstreamMark appearance={conversation.appearance} id={conversation.id} size={16} />}
                          name={conversation.title}
                          side="top"
                        >
                          <span className="waiting-conversation-icon">
                            <WorkstreamMark appearance={conversation.appearance} id={conversation.id} size={11} />
                          </span>
                        </ConversationIdentityTip>
                      </span>
                      <span className="waiting-workstream-copy">
                        <strong>{conversation.title}</strong>
                        <span>in {conversation.breakoutOf.title}</span>
                      </span>
                      <RelativeTime value={conversation.lastActivityAt} />
                    </NavLink>
                  : <NavLink className="waiting-workstream-row" key={conversation.id} to={`/workstreams/${conversation.id}`}>
                      <StatusDot status={workstreamMarkerStatus(conversation)} />
                      <span aria-hidden="true" className="waiting-conversation-identity">
                        <ConversationIdentityTip
                          icon={<WorkstreamMark appearance={conversation.appearance} id={conversation.id} size={16} />}
                          name={conversation.title}
                          side="top"
                        >
                          <span className="waiting-conversation-icon">
                            <WorkstreamGlyph appearance={conversation.appearance} id={conversation.id} size={17} />
                          </span>
                        </ConversationIdentityTip>
                      </span>
                      <span className="waiting-workstream-copy"><strong>{conversation.title}</strong>{conversation.preview && <span>{conversation.preview}</span>}</span>
                      <RelativeTime value={conversation.lastActivityAt} />
                    </NavLink>)}
              </div>}
          {channelPages.hasNextPage && (
            <p className="space-dashboard-muted">
              <Button disabled={channelPages.isFetchingNextPage} onClick={() => void channelPages.fetchNextPage()}>Load more</Button>
            </p>
          )}
        </SpaceDashboardSection>

        {failures.restore && <InlineError>{failures.restore}</InlineError>}

        <Modal
          footer={<><Button onClick={() => setArchiveConfirmOpen(false)}>Cancel</Button><Button className="button-danger" disabled={saving} onClick={() => {
            report('archive', null);
            setSaving(true);
            void api!.archiveSpace(space.id).then((archived) => {
              setArchiveConfirmOpen(false);
              queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
                ...current,
                items: current.items.filter((item) => item.id !== archived.id),
              } : current);
              queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, (current) => current ? {
                ...current,
                items: current.items.some((item) => item.id === archived.id)
                  ? current.items.map((item) => item.id === archived.id ? archived : item)
                  : [archived, ...current.items],
              } : current);
              openFirstWorkstream();
            }).catch((cause: unknown) => {
              setBlockedChannelIds(spaceRefusalChannelIds(cause));
              report('archive', spaceFailureSentence(cause, 'The space could not be archived.'));
            }).finally(() => setSaving(false));
          }}>Archive space</Button></>}
          onOpenChange={setArchiveConfirmOpen}
          open={archiveConfirmOpen}
          title="Archive space?"
        >
          <p>Its channels keep the resources and Sidekicks they already have, and stay in every other space they belong to. A channel whose only space is this one has to be moved first.</p>
          {failures.archive && <InlineError>{failures.archive}</InlineError>}
          {/* The Channels the refusal named, which is what turns "some channel
              has to move" into something a person can act on. It can be empty
              even on a refusal: the server names only the Channels this viewer
              may already read, and the sentence above stands without it.
              Titles come from Needs attention and from the sidebar directory,
              because an idle Channel is in the second and not the first. */}
          {blockedChannelIds.length > 0 && (
            <ul aria-label="Channels to move first" className="space-dashboard-blocked-channels">
              {blockedChannelIds.map((id) => (
                <li key={id}>{blockedChannelLabel(id, [...conversations, ...directoryWorkstreams])}</li>
              ))}
            </ul>
          )}
        </Modal>

        <Modal
          description="Choose the organization members who participate in this space."
          footer={<><Button disabled={saving} onClick={() => setParticipantsOpen(false)}>Cancel</Button><Button className="button-primary" disabled={saving || editParticipants.size === 0} onClick={() => {
            // Only on success: this roster has a refusal of its own now — a
            // personal Space cannot be narrowed to a list its own editor is
            // not on — and the sentence for it is drawn inside this dialog.
            void save(
              'participants',
              () => api!.updateSpaceAudience(space.id, { scope: space.scope, participantUserIds: [...editParticipants] }),
              'Space participants could not be saved.',
            ).then((saved) => { if (saved) setParticipantsOpen(false); });
          }}>Save</Button></>}
          onOpenChange={(open) => { if (!saving) setParticipantsOpen(open); }}
          open={participantsOpen}
          title="Space participants"
        >
          <div aria-label="Organization members" className="member-picker-list" role="group">
            {(workspaceMembers.data ?? []).map((member) => {
              // Taking somebody else out of a Space is an administrator's to
              // do; adding is anybody's. The server reauthorizes either way —
              // this only decides which control is drawn.
              const removingSomebodyElse = participantIds.has(member.id)
                && member.id !== workspace.currentUser.id;
              const mayRemove = isAdministrator || !removingSomebodyElse;
              return (
                <label className="member-picker-row" key={member.id}>
                  <input
                    checked={editParticipants.has(member.id)}
                    disabled={editParticipants.has(member.id) && !mayRemove}
                    onChange={() => setEditParticipants((current) => {
                      const next = new Set(current);
                      if (next.has(member.id)) next.delete(member.id); else next.add(member.id);
                      return next;
                    })}
                    type="checkbox"
                  />
                  <Avatar member={member} size="medium" />
                  <span><strong>{member.name}</strong><small>{member.email}</small></span>
                  <span aria-hidden="true" className="member-checkbox" />
                </label>
              );
            })}
          </div>
          {failures.participants && <InlineError>{failures.participants}</InlineError>}
        </Modal>

        <Modal
          footer={<><Button disabled={saving} onClick={() => setPendingScope(null)}>Cancel</Button><Button className="button-primary" disabled={saving} onClick={() => {
            if (pendingScope === null) return;
            void save(
              'audience',
              () => api!.updateSpaceAudience(space.id, {
                scope: pendingScope,
                participantUserIds: [...participantIds],
              }),
              'The space audience could not be changed.',
            ).then(() => setPendingScope(null));
          }}>Continue</Button></>}
          onOpenChange={(open) => { if (!open && !saving) setPendingScope(null); }}
          open={pendingScope !== null}
          title="Change who can see this space?"
        >
          <p>{pendingScope === 'workspace'
            ? 'Everyone in the organization will be able to see this space and every channel in it. Current participants stay participants.'
            : 'Only this space’s participants will be able to see it. Channels stay public if another source still says so.'}</p>
          {failures.audience && <InlineError>{failures.audience}</InlineError>}
        </Modal>

        <Modal
          footer={<><Button disabled={saving} onClick={() => setAppearanceOpen(false)}>Cancel</Button><Button className="button-primary" disabled={saving} onClick={() => {
            void save(
              'appearance',
              () => api!.updateSpacePresentation(space.id, { name: space.name, iconKey: editIconKey, colorKey: editColorKey }),
              'The icon and color could not be saved.',
            ).then(() => setAppearanceOpen(false));
          }}>Save</Button></>}
          onOpenChange={(open) => { if (!saving) setAppearanceOpen(open); }}
          open={appearanceOpen}
          title="Space icon and color"
        >
          <SpaceAppearancePicker colorKey={editColorKey} iconKey={editIconKey} onColorChange={setEditColorKey} onIconChange={setEditIconKey} />
          {failures.appearance && <InlineError>{failures.appearance}</InlineError>}
        </Modal>
      </div>
    </div>
  );
}
