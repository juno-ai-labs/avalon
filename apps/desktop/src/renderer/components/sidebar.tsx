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
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { formatRelative, groupActivityItems } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import type { AutomationSummary, NoteSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { Avatar, Badge, Button, IconButton, InlineError, Modal, StatusDot } from './primitives';

interface SidebarProps {
  workspace: Workspace;
  automations: AutomationSummary[];
  notes?: NoteSummary[];
  workstreams: WorkstreamSummary[];
  loading?: boolean;
  onArchiveDraftAutomation: (automation: AutomationSummary) => Promise<void>;
  onArchiveNote: (note: NoteSummary) => Promise<void>;
  onChangeNoteScope: (note: NoteSummary, scope: 'personal' | 'workspace') => Promise<void>;
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
  onMarkUnread,
  onRename,
}: {
  debugEnabled: boolean;
  workstream: WorkstreamSummary;
  onMarkUnread: (workstream: WorkstreamSummary) => void;
  onRename: (workstream: WorkstreamSummary) => void;
}): React.JSX.Element {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="sidebar-context-target">
          <NavLink
            className={({ isActive }) => clsx('sidebar-row workstream-row', isActive && 'is-active', workstream.hasUnread && 'is-unread')}
            to={`/workstreams/${workstream.id}`}
          >
            <span className="sidebar-row-icon">
              <StatusDot compact status={workstream.harnessStatus} tooltip />
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">{workstream.title}</span>
              {(workstream.preview || workstream.automationName) && (
                <span className="sidebar-row-hint">
                  <span className="sidebar-row-hint-text">
                    {workstream.preview ?? workstream.automationName}
                  </span>
                </span>
              )}
            </span>
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
            {note.scope === 'personal' && (
              <span aria-label="Private note" className="sidebar-note-privacy" role="img">
                <IconLock aria-hidden="true" size={15} stroke={1.8} />
              </span>
            )}
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
  const [renameTarget, setRenameTarget] = useState<WorkstreamSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // Both note actions apply straight from the menu, so a rejection has nowhere
  // to land unless it is raised here: the row simply stays as it was.
  const [noteError, setNoteError] = useState<{ copy: string; message: string; title: string } | null>(null);
  const [scopePendingNoteId, setScopePendingNoteId] = useState<string | null>(null);
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
      setNoteError({
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
      setNoteError({
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

  useEffect(() => {
    if (!resizing) return undefined;

    const move = (event: PointerEvent): void => setSidebarWidth(event.clientX);
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
                        onMarkUnread={(target) => void onMarkWorkstreamUnread(target).catch(() => undefined)}
                        onRename={openRename}
                        workstream={item.workstream}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>
        </nav>

        <OnboardingChecklist />

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
          className="sidebar-resizer"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setSidebarWidth(sidebarWidth - 16);
            if (event.key === 'ArrowRight') setSidebarWidth(sidebarWidth + 16);
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          role="separator"
          tabIndex={0}
        />
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
        footer={<Button onClick={() => setNoteError(null)}>Close</Button>}
        onOpenChange={(open) => {
          if (!open) setNoteError(null);
        }}
        open={Boolean(noteError)}
        title={noteError?.title ?? 'Note could not be updated'}
      >
        <p className="modal-copy">{noteError?.copy}</p>
        {noteError && <InlineError>{noteError.message}</InlineError>}
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
