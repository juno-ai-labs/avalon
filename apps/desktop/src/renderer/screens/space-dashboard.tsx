import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FileText, FolderPlus, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  type SpaceColorKey,
  type SpaceDirectory,
  type SpaceIconKey,
  type SpaceSummary,
} from '@rally/contracts';
import { SpaceAppearancePicker } from '@rally/ui/components/space-appearance-picker';
import {
  SpaceChannelRow,
  SpaceDashboardHeader,
  SpaceDashboardSection,
  SpaceDefaultList,
  type SpaceDefaultItem,
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
import { PROJECT_COLOR_DEFAULT } from '../lib/project-palette';
import { workstreamMarkerStatus } from '../lib/format';
import { spaceFailureSentence } from '../lib/space-failure-copy';
import { SIDEBAR_LIST_QUERY_KEYS, INACTIVE_SPACES_QUERY_KEY, SPACES_QUERY_KEY, useSocketOwnedList } from '../lib/sidebar-list-store';
import type { AutomationSummary, SpaceDefaultKind, Workspace } from '../lib/types';
import { useSpaceDirectories, useSpacesReady } from '../lib/use-space-directories';
import { useOpenFirstWorkstream } from '../lib/workstream-landing';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';

/** What each kind of default calls itself on this screen. */
const defaultCopy: Record<SpaceDefaultKind, { heading: string; description: string; empty: string; headingId: string }> = {
  resource: {
    heading: 'Resources',
    description: 'Resources added here are attached to every channel in this space, now and later.',
    empty: 'No resources',
    headingId: 'space-resources-heading',
  },
  sidekick: {
    heading: 'Sidekicks',
    description: 'Sidekicks recommended here are offered in every channel in this space, now and later.',
    empty: 'No Sidekicks',
    headingId: 'space-sidekicks-heading',
  },
};

/**
 * Where a refusal is shown, one slot per surface that can produce one.
 *
 * Scoped rather than shared: a single `error` string was rendered in the body
 * and in every open modal at once, so a failed rename appeared inside the
 * participant picker, and closing one modal carried the sentence to the next.
 */
type FailureSlot =
  | 'restore'
  | 'name'
  | 'archive'
  | 'channels'
  | 'addChannels'
  | 'addDefault'
  | 'participants'
  | 'audience'
  | 'appearance'
  | `defaults:${SpaceDefaultKind}`;

/**
 * A Space's own screen: what it is, who it is for, what is in it, and what it
 * hands down.
 *
 * A Space has no feed. There is deliberately no composer, transcript, feed
 * socket, Main link or Breakout list here — the backing conversation exists,
 * and nothing in the product opens it.
 */
export function SpaceDashboardScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const openFirstWorkstream = useOpenFirstWorkstream();
  const { spaceId } = useParams<{ spaceId: string }>();
  const queryClient = useQueryClient();
  const workstreams = useWorkstreamsQuery();
  const spacesReady = useSpacesReady();
  const { active: spaces, inactive: inactiveSpaces } = useSpaceDirectories();
  const [failures, setFailures] = useState<Partial<Record<FailureSlot, string>>>({});
  const [saving, setSaving] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [editIconKey, setEditIconKey] = useState<SpaceIconKey>('briefcase');
  const [editColorKey, setEditColorKey] = useState<SpaceColorKey>(PROJECT_COLOR_DEFAULT);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [editParticipants, setEditParticipants] = useState<Set<string>>(new Set());
  const [pendingScope, setPendingScope] = useState<'personal' | 'workspace' | null>(null);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [defaultPicker, setDefaultPicker] = useState<SpaceDefaultKind | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // A Space has no socket of its own: what it paints is the Organization's
  // directory, and the directory the local cache seeded is what is showing
  // until the workspace socket's first subscribe answer replaces it.
  const workspaceSocket = useOptionalWorkspaceSocket();
  const directoryFromLocalCache = workspaceSocket !== null && workspaceSocket.sidebarConnect === null;
  const resources = useQuery({
    queryKey: ['space-resource-picker'],
    queryFn: ({ signal }) => api!.listResources({ limit: 100, signal }),
    enabled: Boolean(api),
  });
  const workspaceMembers = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
  });
  // The Space's membership is paginated: General holds every Channel in the
  // Organization, so it is the one Space read that cannot ride the socket.
  const channelPages = useInfiniteQuery({
    queryKey: ['space-channels', spaceId],
    queryFn: ({ pageParam, signal }) => api!.listSpaceChannels(spaceId!, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api) && Boolean(spaceId),
  });
  // Subscribed rather than read: a `getQueryData` read of the same entry does
  // not re-render when the socket replaces the list, so a Sidekick default
  // rendered as "Sidekick" until something unrelated on this screen changed.
  const sidekicks = useSocketOwnedList<AutomationSummary>(SIDEBAR_LIST_QUERY_KEYS.automations).data ?? [];
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
  // Owner and administrator are one gate everywhere a Space is edited, and the
  // role only decides which control is drawn: the server reauthorizes it.
  const isAdministrator = ['owner', 'admin'].includes(workspace.currentUser.role ?? '');
  // Every Space edit sends the whole record back, so an edit made against the
  // seed would carry fields another client may have changed since the row was
  // written. A remembered Space is read-only until the directory is live.
  const editable = space.status === 'active' && !directoryFromLocalCache;
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
  const save = async (
    slot: FailureSlot,
    change: () => Promise<SpaceSummary>,
    fallback: string,
  ): Promise<void> => {
    setSaving(true);
    report(slot, null);
    try {
      applySpace(await change());
    } catch (cause) {
      // Never the server's own sentence: it is a diagnostic a Worker wrote for
      // a log, in the Organization's internal words, and it changes whenever
      // the server's wording does. `fallback` is this action's own sentence,
      // used when the refusal carried no Space code to name.
      report(slot, spaceFailureSentence(cause, fallback));
    } finally {
      setSaving(false);
    }
  };
  const channelIds = (channelPages.data?.pages ?? []).flatMap((page) => page.items as string[]);
  const placed = channelIds
    .flatMap((id) => (workstreams.data ?? []).find((workstream) => workstream.id === id) ?? []);
  const participantIds = new Set(space.participants.map((participant) => participant.userId as string));
  const spaceMembers = (workspaceMembers.data ?? []).filter((member) => participantIds.has(member.id));
  const resourcesById = new Map((resources.data?.items ?? []).map((resource) => [resource.id, resource]));
  const sidekicksById = new Map(sidekicks.map((sidekick) => [sidekick.id, sidekick]));
  const defaultItems = (kind: SpaceDefaultKind): SpaceDefaultItem[] => (
    kind === 'resource'
      ? space.defaultResourceIds.map((id) => ({
        id,
        title: resourcesById.get(id)?.title ?? 'Resource',
        subtitle: resourcesById.get(id)?.provider ?? undefined,
      }))
      : space.defaultSidekickIds.map((id) => ({
        id,
        title: sidekicksById.get(id)?.name ?? 'Sidekick',
        subtitle: sidekicksById.get(id)?.description ?? undefined,
      }))
  );
  const pickerChoices = defaultPicker === 'resource'
    ? (resources.data?.items ?? [])
      .filter((resource) => !space.defaultResourceIds.includes(resource.id))
      .map((resource) => ({ id: resource.id, title: resource.title, subtitle: `${resource.provider ?? 'Rally'} · ${resource.resourceType}` }))
    : sidekicks
      // The PRD's "Sidekick recommendations inherited by current and future
      // member Channels": a Space default is offered in every Channel the
      // Space holds, now and later. A `workstream`-scoped Sidekick belongs to
      // one Channel and cannot be that, and a draft or paused one would be
      // recommended everywhere while being unable to run.
      .filter((sidekick) => sidekick.scope !== 'workstream' && sidekick.status === 'active')
      .filter((sidekick) => !space.defaultSidekickIds.includes(sidekick.id))
      .map((sidekick) => ({ id: sidekick.id, title: sidekick.name, subtitle: sidekick.description }));
  const addableChannels = (workstreams.data ?? [])
    .filter((workstream) => !workstream.spaceIds.includes(space.id) && workstream.archivedAt === undefined);
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
          actions={space.status === 'active'
            // General is the Organization's fallback home. Its identity,
            // lifecycle and audience are immutable; its name and mark are not.
            ? (!isGeneral && <IconButton
              className="icon-button-danger"
              disabled={!editable}
              label="Archive space"
              onClick={() => { report('archive', null); setArchiveConfirmOpen(true); }}
            >
              <Archive aria-hidden="true" size={15} />
            </IconButton>)
            : <Button disabled={directoryFromLocalCache || saving} onClick={() => void save(
              'restore',
              () => api!.restoreSpace(space.id),
              'The space could not be restored.',
            )}><RotateCcw aria-hidden="true" size={15} /> Restore space</Button>}
          appearance={space}
          {...(isGeneral ? {} : {
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
          {...(isGeneral ? {} : {
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

        <SpaceDashboardSection
          action={<div className="space-dashboard-header-actions">
            <Button disabled={!editable} onClick={() => { report('addChannels', null); setSelectedIds(new Set()); setChannelPickerOpen(true); }}>Add channel</Button>
            <IconButton
              disabled={space.status !== 'active'}
              label={`New channel in ${space.name}`}
              onClick={() => void navigate(`/spaces/${space.id}/workstreams/new`)}
            >
              <Plus aria-hidden="true" size={15} />
            </IconButton>
          </div>}
          heading="Channels"
          headingId="space-channels-heading"
        >
          {channelPages.isPending
            ? <LoadingState label="Loading channels…" />
            : channelIds.length === 0
              ? <EmptyState title="No channels yet" description={space.status === 'active' ? 'Start one with the plus button in this section.' : 'This archived space has no channels.'} />
              : <div className="waiting-workstream-list">
                {placed.map((workstream) => (
                  <SpaceChannelRow
                    key={workstream.id}
                    link={<NavLink className="waiting-workstream-row" to={`/workstreams/${workstream.id}`}>
                      <StatusDot status={workstreamMarkerStatus(workstream)} />
                      <span className="waiting-workstream-copy"><strong>{workstream.title}</strong>{workstream.preview && <span>{workstream.preview}</span>}</span>
                      <RelativeTime value={workstream.lastActivityAt} />
                    </NavLink>}
                    onRemove={() => void save(
                      'channels',
                      () => api!.removeChannelFromSpace(space.id, workstream.id),
                      'The channel could not be removed from this space.',
                    )}
                    removeDisabled={!editable || saving}
                  />
                ))}
              </div>}
          {channelPages.hasNextPage && (
            <p className="space-dashboard-muted">
              <Button disabled={channelPages.isFetchingNextPage} onClick={() => void channelPages.fetchNextPage()}>Load more</Button>
            </p>
          )}
          {failures.channels && <InlineError>{failures.channels}</InlineError>}
        </SpaceDashboardSection>

        {(['resource', 'sidekick'] as const).map((kind) => (
          <SpaceDashboardSection
            action={<Button disabled={!editable || saving} onClick={() => { report('addDefault', null); setSelectedIds(new Set()); setDefaultPicker(kind); }}>
              <FolderPlus aria-hidden="true" size={15} /> Add {kind === 'resource' ? 'resource' : 'Sidekick'}
            </Button>}
            description={defaultCopy[kind].description}
            heading={defaultCopy[kind].heading}
            headingId={defaultCopy[kind].headingId}
            key={kind}
          >
            <SpaceDefaultList
              disabled={!editable || saving}
              emptyLabel={defaultCopy[kind].empty}
              items={defaultItems(kind)}
              onRemove={(id) => void save(
                `defaults:${kind}`,
                () => api!.removeSpaceDefault(space.id, kind, id),
                'That could not be removed from this space.',
              )}
            />
            {failures[`defaults:${kind}`] && <InlineError>{failures[`defaults:${kind}`]}</InlineError>}
          </SpaceDashboardSection>
        ))}
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
            }).catch((cause: unknown) => report(
              'archive',
              spaceFailureSentence(cause, 'The space could not be archived.'),
            )).finally(() => setSaving(false));
          }}>Archive space</Button></>}
          onOpenChange={setArchiveConfirmOpen}
          open={archiveConfirmOpen}
          title="Archive space?"
        >
          {/* Which Channel has to move is not on the refusal yet: the archive
              answers `space_membership_final` with no list, and the server is
              gaining a `channelIds` details field to carry one. Until it does,
              this says what has to be true rather than naming the Channel. */}
          <p>Its channels keep the resources and Sidekicks they already have, and stay in every other space they belong to. A channel whose only space is this one has to be moved first.</p>
          {failures.archive && <InlineError>{failures.archive}</InlineError>}
        </Modal>

        <Modal
          description="Choose the channels to add to this space. They keep every space they are already in."
          footer={<><Button disabled={saving} onClick={() => setChannelPickerOpen(false)}>Cancel</Button><Button className="button-primary" disabled={saving || selectedIds.size === 0} onClick={() => {
            void (async () => {
              for (const workstreamId of selectedIds) {
                await save(
                  'addChannels',
                  () => api!.addChannelToSpace(space.id, workstreamId),
                  'The channel could not be added to this space.',
                );
              }
              setSelectedIds(new Set());
              setChannelPickerOpen(false);
              void channelPages.refetch();
            })();
          }}>Add channels</Button></>}
          onOpenChange={(open) => { if (!saving) setChannelPickerOpen(open); }}
          open={channelPickerOpen}
          title="Add channels"
        >
          {addableChannels.length === 0
            ? <EmptyState title="No channels to add" description="Every channel loaded on this device is already in this space." />
            : <div aria-label="Channels" className="member-picker-list" role="group">
              {addableChannels.map((workstream) => (
                <label className="member-picker-row" key={workstream.id}>
                  <input
                    checked={selectedIds.has(workstream.id)}
                    onChange={() => setSelectedIds((current) => {
                      const next = new Set(current);
                      if (next.has(workstream.id)) next.delete(workstream.id); else next.add(workstream.id);
                      return next;
                    })}
                    type="checkbox"
                  />
                  <span><strong>{workstream.title}</strong></span>
                  <span aria-hidden="true" className="member-checkbox" />
                </label>
              ))}
            </div>}
          {failures.addChannels && <InlineError>{failures.addChannels}</InlineError>}
        </Modal>

        <Modal
          description={defaultPicker === 'sidekick'
            ? 'Every channel in this space is offered these Sidekicks.'
            : 'Every channel in this space gets these resources attached.'}
          footer={<><Button disabled={saving} onClick={() => setDefaultPicker(null)}>Cancel</Button><Button className="button-primary" disabled={saving || selectedIds.size === 0} onClick={() => {
            const kind = defaultPicker;
            if (!kind) return;
            void (async () => {
              for (const targetId of selectedIds) {
                await save(
                  'addDefault',
                  () => api!.addSpaceDefault(space.id, kind, targetId),
                  'That could not be added to this space.',
                );
              }
              setSelectedIds(new Set());
              setDefaultPicker(null);
            })();
          }}>Add</Button></>}
          onOpenChange={(open) => { if (!saving && !open) setDefaultPicker(null); }}
          open={defaultPicker !== null}
          title={defaultPicker === 'sidekick' ? 'Add Sidekicks' : 'Add resources'}
        >
          {pickerChoices.length === 0
            ? <EmptyState title="Nothing to add" description="Everything available is already a default in this space." />
            : <div aria-label={defaultPicker === 'sidekick' ? 'Sidekicks' : 'Resources'} className="member-picker-list" role="group">
              {pickerChoices.map((choice) => (
                <label className="member-picker-row" key={choice.id}>
                  <input
                    checked={selectedIds.has(choice.id)}
                    onChange={() => setSelectedIds((current) => {
                      const next = new Set(current);
                      if (next.has(choice.id)) next.delete(choice.id); else next.add(choice.id);
                      return next;
                    })}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="resource-picker-icon"><FileText size={15} /></span>
                  <span><strong>{choice.title}</strong><small>{choice.subtitle}</small></span>
                  <span aria-hidden="true" className="member-checkbox" />
                </label>
              ))}
            </div>}
          {failures.addDefault && <InlineError>{failures.addDefault}</InlineError>}
        </Modal>

        <Modal
          description="Choose the organization members who participate in this space."
          footer={<><Button disabled={saving} onClick={() => setParticipantsOpen(false)}>Cancel</Button><Button className="button-primary" disabled={saving || editParticipants.size === 0} onClick={() => {
            void save(
              'participants',
              () => api!.updateSpaceAudience(space.id, { scope: space.scope, participantUserIds: [...editParticipants] }),
              'Space participants could not be saved.',
            ).then(() => setParticipantsOpen(false));
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
