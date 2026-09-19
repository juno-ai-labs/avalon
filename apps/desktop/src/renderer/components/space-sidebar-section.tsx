import { IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  type CreateSpaceRequest,
  type SpaceColorKey,
  type SpaceIconKey,
  type SpaceSummary,
} from '@rally/contracts';
import { SpaceAppearancePicker, SpaceIcon } from '@rally/ui/components/space-appearance-picker';
import { SpacePlacementList, SpaceRow, SpaceRowContent } from '@rally/ui/components/space-row';
import { SPACE_SCOPE_OPTIONS } from '@rally/ui/components/space-dashboard';

import { compareWorkstreamRecency } from '../lib/format';
import { PROJECT_COLOR_DEFAULT } from '../lib/project-palette';
import { Button, DropdownSelect, IconButton, InlineError, Modal } from './primitives';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import type { WorkstreamSummary } from '../lib/types';

/**
 * Every visible failure this section can produce, as a closed union.
 *
 * The same rule the Projects section it replaces was put under: a Space action
 * shares persistent navigation with unrelated requests, so a server diagnostic
 * rendered here reads as Space content long after the action that was refused.
 * Adding a failure means adding its sentence below.
 */
type SpaceSectionFailure = 'reorder' | 'add_channel';

const spaceSectionFailureCopy: Record<SpaceSectionFailure, string> = {
  reorder: 'Spaces couldn’t be reordered.',
  add_channel: 'That channel couldn’t be added to the space.',
};

/** The transfer type a Channel row writes, and the only one a Space accepts. */
const CHANNEL_DRAG_TYPE = 'application/x-rally-workstream-id';

/**
 * The Organization is still creating General and placing every Channel in it.
 *
 * Shown instead of the hierarchy rather than beside it: a Space directory
 * missing General, or a Channel with no Space, is not a state any surface is
 * allowed to render, so there is nothing truthful to show underneath.
 */
export function SpacesOpeningCard({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={clsx('space-opening-card', className)} role="status">
      <span>Rally is opening this organization. Spaces appear once every channel has one.</span>
    </div>
  );
}

interface SpaceSidebarSectionProps {
  spaces: SpaceSummary[];
  inactiveSpaces: SpaceSummary[];
  workstreams: WorkstreamSummary[];
  loading: boolean;
  /** False while the Organization has not finished its one-time cutover. */
  ready: boolean;
  /**
   * The rows on screen are the last ones the socket delivered and a refresh
   * failed. They stay — an emptier sidebar is a worse lie than a stale one —
   * and say so.
   */
  outOfDate: boolean;
  onRetry: () => void;
  onCreate: (input: CreateSpaceRequest) => Promise<SpaceSummary>;
  onAddChannel: (spaceId: string, workstreamId: string) => Promise<void>;
  onReorder: (spaceIds: string[]) => Promise<void>;
  onRestore: (spaceId: string) => Promise<void>;
  /** Placements use the same row the rest of the sidebar does. */
  renderWorkstream: (workstream: WorkstreamSummary) => ReactNode;
}

/**
 * The Organization's Spaces, and the Channels placed in each one.
 *
 * Always drawn, in every shell: every Channel belongs to at least one Space, so
 * a sidebar without this section would be a sidebar that cannot say where
 * anything lives. General is in the directory like any other Space and needs no
 * case here.
 *
 * A placement is not a copy. The rows under an expanded Space come from the
 * same work-stream list the sections below render, filtered by the Channel's
 * own `spaceIds`, and go through the same `renderWorkstream` — so a Channel in
 * two Spaces is one record shown twice, with one unread state and one
 * destination.
 */
export function SpaceSidebarSection({
  spaces,
  inactiveSpaces,
  workstreams,
  loading,
  ready,
  outOfDate,
  onRetry,
  onCreate,
  onAddChannel,
  onReorder,
  onRestore,
  renderWorkstream,
}: SpaceSidebarSectionProps): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [name, setName] = useState('');
  const [iconKey, setIconKey] = useState<SpaceIconKey>('briefcase');
  const [colorKey, setColorKey] = useState<SpaceColorKey>(PROJECT_COLOR_DEFAULT);
  const [scope, setScope] = useState<'personal' | 'workspace'>('personal');
  const [saving, setSaving] = useState(false);
  const [modalFailure, setModalFailure] = useState<'create' | 'restore' | null>(null);
  const [sectionFailure, setSectionFailure] = useState<SpaceSectionFailure | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragging = useRef<string | null>(null);
  const ordered = dragOrder
    ? dragOrder.flatMap((id) => spaces.find((space) => space.id === id) ?? [])
    : spaces;

  const closeCreate = (): void => {
    if (saving) return;
    setCreateOpen(false);
    setName('');
    setIconKey('briefcase');
    setColorKey(PROJECT_COLOR_DEFAULT);
    setScope('personal');
    setModalFailure(null);
  };

  const submit = async (): Promise<void> => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setModalFailure(null);
    try {
      const created = await onCreate({ name: name.trim(), iconKey, colorKey, scope });
      setExpanded((current) => new Set(current).add(created.id));
      setSaving(false);
      closeCreate();
      void navigate(`/spaces/${created.id}`);
    } catch {
      setModalFailure('create');
      setSaving(false);
    }
  };

  const move = (ids: string[], id: string, position: number): string[] => {
    const rest = ids.filter((candidate) => candidate !== id);
    return [...rest.slice(0, position), id, ...rest.slice(position)];
  };

  const commit = async (ids: string[]): Promise<void> => {
    setDragOrder(ids);
    setSectionFailure(null);
    try {
      await onReorder(ids);
    } catch {
      setSectionFailure('reorder');
    } finally {
      setDragOrder(null);
    }
  };

  const toggle = (spaceId: string): void => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(spaceId)) next.delete(spaceId);
    else next.add(spaceId);
    return next;
  });

  return (
    <>
      <section aria-labelledby="spaces-heading" className="sidebar-section spaces-section">
        <div className="sidebar-section-heading">
          <h2 id="spaces-heading">Spaces</h2>
          {/* Nothing to create into while the Organization is still opening;
              the server refuses it with `space_bootstrap_pending`, and a
              control that can only fail is worse than one that is not there. */}
          {ready && <IconButton className="space-sidebar-action" label="New space" onClick={() => { setModalFailure(null); setCreateOpen(true); }}>
            <IconPlus size={15} stroke={1.8} />
          </IconButton>}
        </div>
        {!ready ? (
          <SpacesOpeningCard />
        ) : loading && spaces.length === 0 ? (
          // The same placeholder rows the lists below use. Spaces arrive on the
          // same answer they do, so a line of prose here read as a third kind
          // of wait next to two sections already showing their shape.
          <SidebarSkeletonRows count={3} />
        ) : spaces.length === 0 ? (
          <p className="sidebar-empty">No spaces yet</p>
        ) : (
          <div aria-describedby="spaces-reorder-help" className="sidebar-list">
            <p className="sr-only" id="spaces-reorder-help">Hold Alt and press the up or down arrow to reorder spaces.</p>
            {outOfDate && (
              <div className="space-sidebar-stale">
                <p role="status">These spaces may be out of date.</p>
                <Button onClick={onRetry}>Try again</Button>
              </div>
            )}
            {ordered.map((space, index) => {
              const isExpanded = expanded.has(space.id);
              const destination = `/spaces/${space.id}`;
              const placements = workstreams
                .filter((workstream) => workstream.spaceIds.includes(space.id))
                .sort(compareWorkstreamRecency);
              // The Space's own count is the authority on how many Channels it
              // holds; the sidebar's directory is one page of the Organization,
              // so the rest are on the dashboard rather than missing.
              const unlisted = space.channelCount - placements.length;
              return (
                <SpaceRow
                  active={location.pathname === destination || location.pathname.startsWith(`${destination}/`)}
                  drag={{
                    onDragEnd: () => {
                      const ids = dragOrder ?? spaces.map((item) => item.id);
                      dragging.current = null;
                      if (ids.join() !== spaces.map((item) => item.id).join()) void commit(ids);
                      else setDragOrder(null);
                    },
                    onDragEnter: (event) => {
                      event.preventDefault();
                      const active = dragging.current;
                      if (!active || active === space.id) return;
                      setDragOrder((current) => move(current ?? spaces.map((item) => item.id), active, index));
                    },
                    onDragStart: (event) => {
                      dragging.current = space.id;
                      setDragOrder(spaces.map((item) => item.id));
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('application/x-rally-space-id', space.id);
                    },
                    onDrop: (event) => {
                      const workstreamId = event.dataTransfer.getData(CHANNEL_DRAG_TYPE);
                      if (!workstreamId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      dragging.current = null;
                      setSectionFailure(null);
                      void onAddChannel(space.id, workstreamId).catch(() => {
                        setSectionFailure('add_channel');
                      });
                    },
                  }}
                  expanded={isExpanded}
                  key={space.id}
                  link={(
                    <NavLink
                      className={({ isActive }: { isActive: boolean }) => clsx('space-row-link', isActive && 'is-active')}
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current);
                        // Opening a Space selects its dashboard and expands its
                        // row; clicking the row you are already on is the one
                        // way to close it again.
                        if (location.pathname === destination && next.has(space.id)) next.delete(space.id);
                        else next.add(space.id);
                        return next;
                      })}
                      to={destination}
                    >
                      <SpaceRowContent space={space} />
                    </NavLink>
                  )}
                  newChannelLabel={`New channel in ${space.name}`}
                  onNewChannel={() => void navigate(`${destination}/workstreams/new`)}
                  onRowKeyDown={(event) => {
                    // Alt rather than a bare arrow: the arrows move focus
                    // through the sidebar, and a Space must stay reachable by
                    // somebody who is reading rather than rearranging.
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                    event.preventDefault();
                    const to = event.key === 'ArrowUp' ? index - 1 : index + 1;
                    if (to < 0 || to >= spaces.length) return;
                    void commit(move(spaces.map((item) => item.id), space.id, to));
                  }}
                  onToggleExpanded={() => toggle(space.id)}
                  space={space}
                >
                  {isExpanded && (placements.length === 0 && unlisted <= 0
                    ? <p className="space-sidebar-empty">No channels</p>
                    : <SpacePlacementList spaceId={space.id}>
                      {placements.map((workstream) => (
                        <Fragment key={workstream.id}>{renderWorkstream(workstream)}</Fragment>
                      ))}
                      {unlisted > 0 && <p className="space-sidebar-empty">{space.channelCount} channels; open this space to see all</p>}
                    </SpacePlacementList>)}
                </SpaceRow>
              );
            })}
          </div>
        )}
        {sectionFailure && <InlineError>{spaceSectionFailureCopy[sectionFailure]}</InlineError>}
      </section>
      <Modal
        footer={<>
          {inactiveSpaces.length > 0 && <Button disabled={saving} onClick={() => { closeCreate(); setRecoveryOpen(true); }}>Restore archived space</Button>}
          <Button disabled={saving} onClick={closeCreate}>Cancel</Button>
          <Button className="button-primary" disabled={saving || !name.trim()} onClick={() => void submit()}>Create space</Button>
        </>}
        onOpenChange={(open) => open ? setCreateOpen(true) : closeCreate()}
        open={createOpen}
        title="New space"
      >
        <form className="space-create-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="form-field">
            <span>Name</span>
            <input autoFocus onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <SpaceAppearancePicker colorKey={colorKey} iconKey={iconKey} onColorChange={setColorKey} onIconChange={setIconKey} />
          <div className="form-field">
            <span>Who can see this space?</span>
            <DropdownSelect
              ariaLabel="Space audience"
              onValueChange={(value) => setScope(value as 'personal' | 'workspace')}
              options={[...SPACE_SCOPE_OPTIONS]}
              value={scope}
            />
          </div>
          {modalFailure === 'create' && <InlineError>The space couldn’t be created.</InlineError>}
        </form>
      </Modal>
      <Modal
        footer={<Button onClick={() => { setModalFailure(null); setRecoveryOpen(false); }}>Cancel</Button>}
        onOpenChange={(open) => { if (!open) setModalFailure(null); setRecoveryOpen(open); }}
        open={recoveryOpen}
        title="Restore archived space"
      >
        <div className="space-recovery-list">{inactiveSpaces.map((space) => (
          <Button key={space.id} onClick={() => {
            setModalFailure(null);
            void onRestore(space.id)
              .then(() => { setRecoveryOpen(false); void navigate(`/spaces/${space.id}`); })
              .catch(() => setModalFailure('restore'));
          }}><SpaceIcon space={space} /> {space.name}</Button>
        ))}</div>
        {modalFailure === 'restore' && <InlineError>The space couldn’t be restored.</InlineError>}
      </Modal>
    </>
  );
}
