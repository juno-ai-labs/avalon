import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import {
  Archive,
  ChevronDown,
  ChevronsLeft,
  Check,
  CirclePause,
  Cog,
  Copy,
  EyeOff,
  FileStack,
  Globe2,
  LogOut,
  Menu,
  MessageSquarePlus,
  Mic2,
  NotebookText,
  Pencil,
  Pin,
  Play,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { formatRelative, groupActivityItems } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import type { AutomationSummary, NoteSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { Avatar, Badge, Button, IconButton, InlineError, Modal, StatusDot, TitleSkeleton } from './primitives';

interface SidebarProps {
  workspace: Workspace;
  automations: AutomationSummary[];
  notes?: NoteSummary[];
  workstreams: WorkstreamSummary[];
  loading?: boolean;
  onArchiveDraftAutomation: (automation: AutomationSummary) => Promise<void>;
  onArchiveNote: (note: NoteSummary) => Promise<void>;
  onChangeNoteScope: (note: NoteSummary, scope: 'personal' | 'workspace') => Promise<void>;
  onChangeWorkstreamScope: (workstream: WorkstreamSummary, scope: 'personal' | 'workspace') => Promise<void>;
  onDeleteAutomation: (automation: AutomationSummary) => Promise<void>;
  onMarkWorkstreamUnread: (workstream: WorkstreamSummary) => Promise<void>;
  onRenameWorkstream: (workstream: WorkstreamSummary, title: string) => Promise<void>;
  onRunAutomation: (automation: AutomationSummary) => Promise<void>;
  onOpenMeetingNotes: (noteId?: string) => Promise<void>;
  onSignOut: () => void;
}

type RecentSidebarItem =
  | { type: 'note'; note: NoteSummary; id: string; lastActivityAt: string }
  | { type: 'workstream'; workstream: WorkstreamSummary; id: string; lastActivityAt: string };

/** How close the pointer comes to the navigation's edge before its pill shows. */
const EDGE_REVEAL_DISTANCE = 20;

const onboardingItems = [
  {
    id: 'connect-tools',
    title: 'Connect your tools',
    description: 'Bring Linear, GitHub, and Google Workspace into Avalon',
  },
  {
    id: 'create-automation',
    title: 'Create your first automation',
    description: 'Schedule a recurring brief, monitor, or follow-up',
  },
  {
    id: 'invite-teammate',
    title: 'Invite a teammate',
    description: 'Work together in a shared work stream',
  },
] as const;

// DISABLED — see the commented-out render call near the bottom of `Sidebar`
// for why this is not mounted. Left in place (rather than deleted) so the
// eventual real version has a starting point; do not delete this function
// without also resolving that comment.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for the reasons above; not currently rendered.
function OnboardingChecklist(): React.JSX.Element {
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const completedCount = completed.size;

  return (
    <section className="onboarding-checklist" aria-labelledby="onboarding-checklist-heading">
      <header>
        <h2 id="onboarding-checklist-heading">Get started with Avalon</h2>
        <span>{completedCount} / {onboardingItems.length}</span>
      </header>
      <div
        aria-label={`${completedCount} of ${onboardingItems.length} onboarding steps complete`}
        aria-valuemax={onboardingItems.length}
        aria-valuemin={0}
        aria-valuenow={completedCount}
        className="onboarding-progress"
        role="progressbar"
      >
        <span style={{ width: `${(completedCount / onboardingItems.length) * 100}%` }} />
      </div>
      <div className="onboarding-items">
        {onboardingItems.map((item) => {
          const isComplete = completed.has(item.id);
          return (
            <button
              aria-pressed={isComplete}
              className={isComplete ? 'is-complete' : undefined}
              key={item.id}
              onClick={() => {
                setCompleted((current) => {
                  const next = new Set(current);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
              }}
              type="button"
            >
              <span aria-hidden="true" className="onboarding-check">
                {isComplete && <Check size={12} strokeWidth={2.5} />}
              </span>
              <span className="onboarding-item-copy">
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Application → Developer → Debug enabled reveals this on every resource
 * right-click menu, so a bug report can name the exact row it came from. */
function CopyResourceIdItem({ id, label }: { id: string; label: string }): React.JSX.Element {
  return (
    <ContextMenu.Item
      className="menu-item"
      onSelect={() => void desktopBridge().copyText(id).catch(() => undefined)}
    >
      <Copy aria-hidden="true" size={16} /> {label}
    </ContextMenu.Item>
  );
}

function AutomationRow({
  automation,
  debugEnabled,
  onArchiveDraft,
  onDelete,
  onRunNow,
}: {
  automation: AutomationSummary;
  debugEnabled: boolean;
  onArchiveDraft: (automation: AutomationSummary) => void;
  onDelete: (automation: AutomationSummary) => void;
  onRunNow: (automation: AutomationSummary) => void;
}): React.JSX.Element {
  const isDraft = automation.status === 'draft';
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="sidebar-context-target">
          <NavLink className={({ isActive }) => clsx('sidebar-row', isActive && 'is-active', isDraft && 'is-draft')} to={`/automations/${automation.id}`}>
            <span className="sidebar-row-icon" aria-hidden="true">
              {automation.status === 'paused' ? <CirclePause size={13} /> : <span className={clsx('mini-state', automation.status)} />}
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">{automation.name}</span>
              {isDraft
                ? <span className="sidebar-row-hint">Draft</span>
                : automation.nextRunAt && <span className="sidebar-row-hint">Next {formatRelative(automation.nextRunAt)}</span>}
            </span>
            <Badge className="scope-badge">{automation.scope === 'you' ? 'You' : 'Workspace'}</Badge>
          </NavLink>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          <ContextMenu.Item
            className="menu-item"
            disabled={isDraft}
            onSelect={() => onRunNow(automation)}
          >
            <Play aria-hidden="true" size={16} /> Run now
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item">
            <FileStack aria-hidden="true" size={16} /> Turn into template
          </ContextMenu.Item>
          {debugEnabled && <CopyResourceIdItem id={automation.id} label="Copy automation id" />}
          <ContextMenu.Separator className="menu-separator" />
          {isDraft && (
            <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => onArchiveDraft(automation)}>
              <Archive aria-hidden="true" size={16} /> Archive draft
            </ContextMenu.Item>
          )}
          <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => onDelete(automation)}>
            <Trash2 aria-hidden="true" size={16} /> Delete automation
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function WorkstreamRow({
  debugEnabled,
  workstream,
  scopePending,
  onChangeScope,
  onMarkUnread,
  onRename,
}: {
  debugEnabled: boolean;
  workstream: WorkstreamSummary;
  scopePending: boolean;
  onChangeScope: (workstream: WorkstreamSummary, scope: 'personal' | 'workspace') => void;
  onMarkUnread: (workstream: WorkstreamSummary) => void;
  onRename: (workstream: WorkstreamSummary) => void;
}): React.JSX.Element {
  const isPrivate = workstream.scope === 'personal';
  // Two kinds of row take their audience from something other than this
  // column, so offering the toggle on them would describe a change that does
  // not happen: a subsystem's own work stream is machinery, and one an
  // automation generated is visible to whoever that automation is visible to.
  // The API refuses both; the menu simply does not raise the question.
  const scopeIsThisRowsToDecide = !workstream.systemKind && !workstream.automationSubscriptionId;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="sidebar-context-target">
          <NavLink
            className={({ isActive }) => clsx(
              'sidebar-row workstream-row',
              isActive && 'is-active',
              workstream.hasUnread && 'is-unread',
              // Machinery the reader has opted into seeing. Dimmed rather than
              // badged, so it reads as one level below the work it sits beside
              // without adding another thing to decode.
              workstream.systemKind && 'is-system',
            )}
            to={`/workstreams/${workstream.id}`}
          >
            <span className="sidebar-row-icon">
              <StatusDot compact status={workstream.harnessStatus} tooltip />
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">
                {workstream.systemKind && <Cog aria-label="System work stream" size={11} />}
                {workstream.titleStatus === 'naming'
                  ? <TitleSkeleton />
                  : workstream.title}
              </span>
              {(workstream.preview || workstream.automationName) && (
                <span className="sidebar-row-hint">
                  <span className="sidebar-row-hint-text">
                    {workstream.preview ?? workstream.automationName}
                  </span>
                </span>
              )}
            </span>
            {workstream.scope === 'personal' && <PrivacyMarker label="Private work stream" />}
          </NavLink>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          <ContextMenu.Item className="menu-item">
            <Pin aria-hidden="true" size={16} /> Pin
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => onMarkUnread(workstream)}>
            <EyeOff aria-hidden="true" size={16} /> Mark as unread
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => onRename(workstream)}>
            <Pencil aria-hidden="true" size={16} /> Rename
          </ContextMenu.Item>
          {/* Named for the state it moves to, the way the note item is. Private
              is not ownership: everyone left in the work stream can still read
              it, write to it, and bring somebody else in. */}
          {scopeIsThisRowsToDecide && (
            <ContextMenu.Item
              className="menu-item"
              disabled={scopePending}
              onSelect={() => onChangeScope(workstream, isPrivate ? 'workspace' : 'personal')}
            >
              {isPrivate
                ? <><Globe2 aria-hidden="true" size={16} /> Make public to workspace</>
                : <><IconLock aria-hidden="true" size={16} stroke={1.8} /> Make private</>}
            </ContextMenu.Item>
          )}
          {debugEnabled && <CopyResourceIdItem id={workstream.id} label="Copy work stream id" />}
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item className="menu-item menu-item-danger">
            <Archive aria-hidden="true" size={16} /> Archive
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The one "only you can see this" marker in the sidebar. Notes wear it when
 * their scope is personal; a system work stream wears it because nobody but its
 * participant can open it. Same badge either way — a reader should not have to
 * learn two ways of being told the same thing.
 */
function PrivacyMarker({ label }: { label: string }): React.JSX.Element {
  return (
    <span aria-label={label} className="sidebar-note-privacy" role="img">
      <IconLock aria-hidden="true" size={15} stroke={1.8} />
    </span>
  );
}

function NoteRow({
  debugEnabled,
  note,
  ownedByViewer,
  scopePending,
  onArchive,
  onChangeScope,
}: {
  debugEnabled: boolean;
  note: NoteSummary;
  ownedByViewer: boolean;
  scopePending: boolean;
  onArchive: (note: NoteSummary) => void;
  onChangeScope: (note: NoteSummary, scope: 'personal' | 'workspace') => void;
}): React.JSX.Element {
  const isPrivate = note.scope === 'personal';
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="sidebar-context-target">
          <NavLink
            className={({ isActive }) => clsx('sidebar-row note-row', isActive && 'is-active')}
            to={`/notes/${note.id}`}
          >
            <span className="sidebar-row-icon">
              <span aria-label="Note" className="sidebar-note-marker" role="img">
                <NotebookText aria-hidden="true" size={15} strokeWidth={1.8} />
              </span>
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">{note.title}</span>
            </span>
            {note.scope === 'personal' && <PrivacyMarker label="Private note" />}
          </NavLink>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          {/* A workspace note stays in everyone's sidebar, but only its owner
              can change or archive it, so the row offers both actions without
              pretending either would succeed for a reader. The visibility item
              names the state it moves to rather than the current one. */}
          <ContextMenu.Item
            className="menu-item"
            disabled={!ownedByViewer || scopePending}
            onSelect={() => onChangeScope(note, isPrivate ? 'workspace' : 'personal')}
          >
            {isPrivate
              ? <><Globe2 aria-hidden="true" size={16} /> Make public to workspace</>
              : <><IconLock aria-hidden="true" size={16} stroke={1.8} /> Make private</>}
          </ContextMenu.Item>
          {debugEnabled && <CopyResourceIdItem id={note.id} label="Copy note id" />}
          <ContextMenu.Separator className="menu-separator" />
          {/* Archiving a note the meeting window is still recording into would
              fail that window's next segment save — the recording continues
              with nothing being persisted — so the action waits for the
              recording to end. */}
          <ContextMenu.Item
            className="menu-item menu-item-danger"
            disabled={!ownedByViewer || note.recordingStatus === 'recording'}
            onSelect={() => onArchive(note)}
          >
            <Archive aria-hidden="true" size={16} /> Archive note
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function Sidebar({
  workspace,
  automations,
  notes = [],
  workstreams,
  loading,
  onArchiveDraftAutomation,
  onArchiveNote,
  onChangeNoteScope,
  onChangeWorkstreamScope,
  onDeleteAutomation,
  onMarkWorkstreamUnread,
  onRenameWorkstream,
  onRunAutomation,
  onOpenMeetingNotes,
  onSignOut,
}: SidebarProps): React.JSX.Element {
  const debugEnabled = useDebugEnabled();
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const [resizing, setResizing] = useState(false);
  // The handle stands in the strip beside the sidebar rather than on its edge,
  // so the pointer's own position is not the sidebar's width. Holding the
  // difference from the moment of the grab keeps the edge from jumping out to
  // meet a pointer that grabbed the far side of the strip.
  const grabOffset = useRef(0);
  const [pointerNearEdge, setPointerNearEdge] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkstreamSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // The note actions and a work stream's visibility apply straight from the
  // menu, so a rejection has nowhere to land unless it is raised here: the row
  // simply stays as it was.
  const [menuError, setMenuError] = useState<{ copy: string; message: string; title: string } | null>(null);
  const [scopePendingNoteId, setScopePendingNoteId] = useState<string | null>(null);
  const [scopePendingWorkstreamId, setScopePendingWorkstreamId] = useState<string | null>(null);
  const [archiveNoteTarget, setArchiveNoteTarget] = useState<NoteSummary | null>(null);
  const [archivingNote, setArchivingNote] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AutomationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Drafts are unfinished automations, so they sit under the ones that run
  // rather than interleaving with them by name. Among themselves they lead with
  // the one touched most recently, which is the draft still being worked on.
  const orderedAutomations = [
    ...automations.filter((automation) => automation.status !== 'draft'),
    ...automations
      .filter((automation) => automation.status === 'draft')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  ];
  const groups = groupActivityItems<RecentSidebarItem>([
    ...workstreams.map((workstream) => ({
      type: 'workstream' as const,
      id: `workstream:${workstream.id}`,
      lastActivityAt: workstream.lastActivityAt,
      workstream,
    })),
    ...notes.map((note) => ({
      type: 'note' as const,
      id: `note:${note.id}`,
      lastActivityAt: note.lastActivityAt,
      note,
    })),
  ]);

  const openRename = (workstream: WorkstreamSummary): void => {
    setRenameTarget(workstream);
    setRenameTitle(workstream.title);
    setRenameError(null);
  };

  const closeDelete = (): void => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteError(null);
  };

  const submitDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteAutomation(deleteTarget);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'The automation could not be deleted.');
    } finally {
      setDeleting(false);
    }
  };

  const closeArchiveNote = (): void => {
    if (archivingNote) return;
    setArchiveNoteTarget(null);
  };

  // Archiving is not reversible from any surface yet, so it confirms and names
  // its target the way deleting an automation does, rather than firing straight
  // off a right-click that landed one row away from where it was aimed.
  const submitArchiveNote = async (): Promise<void> => {
    if (!archiveNoteTarget) return;
    setArchivingNote(true);
    try {
      await onArchiveNote(archiveNoteTarget);
      setArchiveNoteTarget(null);
    } catch (error) {
      setArchiveNoteTarget(null);
      setMenuError({
        title: 'Note could not be archived',
        copy: 'The note is still in the sidebar. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The note could not be archived.',
      });
    } finally {
      setArchivingNote(false);
    }
  };

  const changeNoteScope = async (note: NoteSummary, scope: 'personal' | 'workspace'): Promise<void> => {
    setScopePendingNoteId(note.id);
    try {
      await onChangeNoteScope(note, scope);
    } catch (error) {
      setMenuError({
        title: 'Note visibility could not be changed',
        copy: scope === 'workspace'
          ? 'The note is still private. Try again in a moment.'
          : 'The note is still public to the workspace. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The note could not be updated.',
      });
    } finally {
      setScopePendingNoteId((current) => current === note.id ? null : current);
    }
  };

  const changeWorkstreamScope = async (
    workstream: WorkstreamSummary,
    scope: 'personal' | 'workspace',
  ): Promise<void> => {
    setScopePendingWorkstreamId(workstream.id);
    try {
      await onChangeWorkstreamScope(workstream, scope);
    } catch (error) {
      setMenuError({
        title: 'Work stream visibility could not be changed',
        copy: scope === 'workspace'
          ? 'The work stream is still private. Try again in a moment.'
          : 'The work stream is still visible to the workspace. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The work stream could not be updated.',
      });
    } finally {
      setScopePendingWorkstreamId((current) => current === workstream.id ? null : current);
    }
  };

  const closeRename = (): void => {
    if (renaming) return;
    setRenameTarget(null);
    setRenameError(null);
  };

  const submitRename = async (): Promise<void> => {
    const title = renameTitle.trim();
    if (!renameTarget || !title || title === renameTarget.title) return;
    setRenaming(true);
    setRenameError(null);
    try {
      await onRenameWorkstream(renameTarget, title);
      setRenameTarget(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : 'The work stream could not be renamed.');
    } finally {
      setRenaming(false);
    }
  };

  // The pill is revealed by how close the pointer is to the edge, not by
  // hovering the handle: a hit area wide enough to be a 20-pixel proximity
  // sensor would also be a 20-pixel column of the main pane that swallows
  // clicks, the window-drag region, and the left edge of the title. Watching
  // the pointer instead keeps the reveal generous and the hit area honest.
  useEffect(() => {
    const track = (event: PointerEvent): void => {
      const near = Math.abs(event.clientX - sidebarWidth) <= EDGE_REVEAL_DISTANCE;
      setPointerNearEdge((current) => current === near ? current : near);
    };
    window.addEventListener('pointermove', track);
    return () => window.removeEventListener('pointermove', track);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizing) return undefined;

    const move = (event: PointerEvent): void => setSidebarWidth(event.clientX - grabOffset.current);
    const stop = (): void => setResizing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, [resizing, setSidebarWidth]);

  return (
    <>
      <IconButton className="mobile-sidebar-trigger" label="Open navigation" onClick={() => setSidebarOpen(true)}>
        <Menu size={17} />
      </IconButton>
      {sidebarOpen && <button aria-label="Close navigation" className="sidebar-scrim" onClick={() => setSidebarOpen(false)} type="button" />}
      <aside aria-label="Avalon navigation" className={clsx('sidebar', sidebarOpen && 'is-mobile-open', resizing && 'is-resizing')}>
        <div className="sidebar-titlebar window-drag">
          <IconButton className="window-no-drag mobile-only" label="Close navigation" onClick={() => setSidebarOpen(false)}>
            <ChevronsLeft size={16} />
          </IconButton>
        </div>

        <nav className="sidebar-scroll" onClick={() => setSidebarOpen(false)}>
          <div className="sidebar-primary-actions">
            <NavLink className={({ isActive }) => clsx('sidebar-action', isActive && 'is-active')} to="/workstreams/new">
              <MessageSquarePlus aria-hidden="true" size={15} />
              <span>New work stream</span>
            </NavLink>
            <NavLink className={({ isActive }) => clsx('sidebar-action', isActive && 'is-active')} to="/automations/new">
              <Plus aria-hidden="true" size={15} />
              <span>New automation</span>
            </NavLink>
            <button className="sidebar-action" onClick={() => void onOpenMeetingNotes()} type="button">
              <Mic2 aria-hidden="true" size={15} />
              <span>New meeting/notes</span>
            </button>
          </div>

          <section className="sidebar-section" aria-labelledby="automations-heading">
            <div className="sidebar-section-heading">
              <h2 id="automations-heading">Automations</h2>
            </div>
            {loading && automations.length === 0 ? (
              <div className="sidebar-skeleton" aria-label="Loading automations" />
            ) : automations.length === 0 ? (
              <p className="sidebar-empty">No active automations</p>
            ) : (
              <div className="sidebar-list">
                {orderedAutomations.map((automation) => (
                  <AutomationRow
                    automation={automation}
                    debugEnabled={debugEnabled}
                    key={automation.id}
                    onArchiveDraft={(target) => {
                      void onArchiveDraftAutomation(target).catch((error: unknown) => {
                        setArchiveError(error instanceof Error ? error.message : 'The draft could not be archived.');
                      });
                    }}
                    onDelete={setDeleteTarget}
                    onRunNow={(target) => void onRunAutomation(target).catch(() => undefined)}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-label="Work streams" className="sidebar-section workstreams-section">
            {loading && workstreams.length === 0 && notes.length === 0 ? (
              <div className="sidebar-skeleton tall" aria-label="Loading work streams" />
            ) : groups.length === 0 ? (
              <p className="sidebar-empty">No work streams or notes yet</p>
            ) : (
              groups.map((group) => (
                <div className="sidebar-group" key={group.label}>
                  <h3>{group.label}</h3>
                  <div className="sidebar-list">
                    {group.streams.map((item) => item.type === 'note' ? (
                      <NoteRow
                        debugEnabled={debugEnabled}
                        key={item.id}
                        note={item.note}
                        onArchive={setArchiveNoteTarget}
                        onChangeScope={(target, scope) => void changeNoteScope(target, scope)}
                        ownedByViewer={item.note.ownerUserId === workspace.currentUser.id}
                        scopePending={scopePendingNoteId === item.note.id}
                      />
                    ) : (
                      <WorkstreamRow
                        debugEnabled={debugEnabled}
                        key={item.id}
                        onChangeScope={(target, scope) => void changeWorkstreamScope(target, scope)}
                        onMarkUnread={(target) => void onMarkWorkstreamUnread(target).catch(() => undefined)}
                        onRename={openRename}
                        scopePending={scopePendingWorkstreamId === item.workstream.id}
                        workstream={item.workstream}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>
        </nav>

        {/*
          OnboardingChecklist is disabled: it was left over from a demo and
          never wired to real product state. `completed` is local-only
          `useState`, seeded empty on every mount and never persisted, so the
          "3 / 3" a user sees is just three checkboxes they clicked themselves
          in the current session — there is no dismiss action because the box
          was never meant to reflect (or need clearing based on) anything
          real. Reported (Aug 2026) as blocking the chat input with no way to
          close it even at "3 / 3"; Morgan Ellis confirmed this is dead demo
          code, not a real feature.

          To bring this back for real: replace `completed` with derived state
          from actual signals (a connected tool/integration exists, an
          automation has been created, a teammate has been invited), and add
          a dismiss mechanism (e.g. a persisted "onboarding dismissed" flag)
          once those signals exist — a checklist that can reach 3/3 has to be
          closeable.
        */}
        {/* <OnboardingChecklist /> */}

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="account-trigger window-no-drag" type="button">
              <Avatar member={workspace.currentUser} size="small" />
              <span className="account-copy">
                <strong>{workspace.currentUser.name}</strong>
                <span>{workspace.name}</span>
              </span>
              <ChevronDown aria-hidden="true" size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" className="menu-content" side="top" sideOffset={8}>
              <DropdownMenu.Label className="menu-label">
                <span>{workspace.currentUser.email}</span>
                <small>{workspace.region === 'eu' ? 'European Union' : 'Global'} workspace</small>
              </DropdownMenu.Label>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item asChild className="menu-item">
                <button onClick={() => void desktopBridge().openSettings()} type="button">
                  <Settings size={14} /> Settings…
                </button>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>
                <LogOut size={14} /> Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <div
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className={clsx('sidebar-resizer', pointerNearEdge && 'is-near')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setSidebarWidth(sidebarWidth - 16);
            if (event.key === 'ArrowRight') setSidebarWidth(sidebarWidth + 16);
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            grabOffset.current = event.clientX - sidebarWidth;
            setResizing(true);
          }}
          role="separator"
          tabIndex={0}
        >
          <span />
        </div>
      </aside>
      <Modal
        footer={(
          <>
            <Button disabled={renaming} onClick={closeRename}>Cancel</Button>
            <Button
              className="button-primary"
              disabled={renaming || !renameTitle.trim() || renameTitle.trim() === renameTarget?.title}
              onClick={() => void submitRename()}
            >
              Rename
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeRename();
        }}
        open={Boolean(renameTarget)}
        title="Rename work stream"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <label className="form-field rename-workstream-field">
            <span>Name</span>
            <input
              aria-label="Work stream name"
              autoFocus
              maxLength={180}
              onChange={(event) => setRenameTitle(event.currentTarget.value)}
              value={renameTitle}
            />
          </label>
        </form>
        {renameError && <InlineError>{renameError}</InlineError>}
      </Modal>
      <Modal
        footer={<Button onClick={() => setArchiveError(null)}>Close</Button>}
        onOpenChange={(open) => {
          if (!open) setArchiveError(null);
        }}
        open={Boolean(archiveError)}
        title="Draft could not be archived"
      >
        <p className="modal-copy">The draft is still in the sidebar. Try again in a moment.</p>
        {archiveError && <InlineError>{archiveError}</InlineError>}
      </Modal>
      <Modal
        footer={(
          <>
            <Button disabled={archivingNote} onClick={closeArchiveNote}>Cancel</Button>
            <Button className="button-danger" disabled={archivingNote} onClick={() => void submitArchiveNote()}>
              Archive
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeArchiveNote();
        }}
        open={Boolean(archiveNoteTarget)}
        title="Archive note"
      >
        <p className="modal-copy">
          <strong>{archiveNoteTarget?.title}</strong> leaves the sidebar, stops being offered as a
          resource, and stops reaching the agent. Its transcript is kept, but Avalon has no way to
          bring the note back yet.
        </p>
      </Modal>
      <Modal
        footer={<Button onClick={() => setMenuError(null)}>Close</Button>}
        onOpenChange={(open) => {
          if (!open) setMenuError(null);
        }}
        open={Boolean(menuError)}
        title={menuError?.title ?? 'That could not be updated'}
      >
        <p className="modal-copy">{menuError?.copy}</p>
        {menuError && <InlineError>{menuError.message}</InlineError>}
      </Modal>
      <Modal
        footer={(
          <>
            <Button disabled={deleting} onClick={closeDelete}>Cancel</Button>
            <Button className="button-danger" disabled={deleting} onClick={() => void submitDelete()}>
              Delete
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
        open={Boolean(deleteTarget)}
        title="Delete automation"
      >
        <p className="modal-copy">
          <strong>{deleteTarget?.name}</strong> stops running and leaves the sidebar for good. Its past
          runs and the work streams it created stay where they are.
        </p>
        {deleteError && <InlineError>{deleteError}</InlineError>}
      </Modal>
    </>
  );
}
