import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import {
  Archive,
  ChevronDown,
  ChevronsLeft,
  Check,
  CirclePause,
  EyeOff,
  FileStack,
  GitBranch,
  LogOut,
  Menu,
  MessageSquarePlus,
  Pencil,
  Pin,
  Play,
  Plus,
  Settings,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { formatRelative, groupWorkstreams } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import type { AutomationSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useUiStore } from '../lib/ui-store';
import { Avatar, Badge, Button, IconButton, InlineError, Modal, StatusDot } from './primitives';

interface SidebarProps {
  workspace: Workspace;
  automations: AutomationSummary[];
  workstreams: WorkstreamSummary[];
  loading?: boolean;
  onMarkWorkstreamUnread: (workstream: WorkstreamSummary) => Promise<void>;
  onRenameWorkstream: (workstream: WorkstreamSummary, title: string) => Promise<void>;
  onRunAutomation: (automation: AutomationSummary) => Promise<void>;
  onSignOut: () => void;
}

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

function AutomationRow({
  automation,
  onRunNow,
}: {
  automation: AutomationSummary;
  onRunNow: (automation: AutomationSummary) => void;
}): React.JSX.Element {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="sidebar-context-target">
          <NavLink className={({ isActive }) => clsx('sidebar-row', isActive && 'is-active')} to={`/automations/${automation.id}`}>
            <span className="sidebar-row-icon" aria-hidden="true">
              {automation.status === 'paused' ? <CirclePause size={13} /> : <span className={clsx('mini-state', automation.status)} />}
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">{automation.name}</span>
              {automation.nextRunAt && <span className="sidebar-row-hint">Next {formatRelative(automation.nextRunAt)}</span>}
            </span>
            <Badge className="scope-badge">{automation.scope === 'you' ? 'You' : 'Workspace'}</Badge>
          </NavLink>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          <ContextMenu.Item
            className="menu-item"
            disabled={automation.status === 'draft'}
            onSelect={() => onRunNow(automation)}
          >
            <Play aria-hidden="true" size={16} /> Run now
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item">
            <FileStack aria-hidden="true" size={16} /> Turn into template
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item className="menu-item menu-item-danger">
            <Archive aria-hidden="true" size={16} /> Archive
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function WorkstreamRow({
  workstream,
  onMarkUnread,
  onRename,
}: {
  workstream: WorkstreamSummary;
  onMarkUnread: (workstream: WorkstreamSummary) => void;
  onRename: (workstream: WorkstreamSummary) => void;
}): React.JSX.Element {
  const showAutomationMarker = workstream.origin === 'automation' && workstream.harnessStatus === 'completed';
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="sidebar-context-target">
          <NavLink
            className={({ isActive }) => clsx('sidebar-row workstream-row', isActive && 'is-active', workstream.hasUnread && 'is-unread')}
            to={`/workstreams/${workstream.id}`}
          >
            <span className="sidebar-row-icon">
              {showAutomationMarker ? (
                <span aria-label="Automation-generated, latest run completed" className="sidebar-automation-marker" role="img">
                  <GitBranch aria-hidden="true" size={15} strokeWidth={1.8} />
                </span>
              ) : (
                <StatusDot compact status={workstream.harnessStatus} />
              )}
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">{workstream.title}</span>
              {(workstream.preview || workstream.automationName) && (
                <span className="sidebar-row-hint">
                  {workstream.origin === 'automation' && <Zap aria-label="Automation-generated" size={10} />}
                  {workstream.preview ?? workstream.automationName}
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
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item className="menu-item menu-item-danger">
            <Archive aria-hidden="true" size={16} /> Archive
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function Sidebar({
  workspace,
  automations,
  workstreams,
  loading,
  onMarkWorkstreamUnread,
  onRenameWorkstream,
  onRunAutomation,
  onSignOut,
}: SidebarProps): React.JSX.Element {
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkstreamSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const groups = groupWorkstreams(workstreams);

  const openRename = (workstream: WorkstreamSummary): void => {
    setRenameTarget(workstream);
    setRenameTitle(workstream.title);
    setRenameError(null);
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
                {automations.map((automation) => (
                  <AutomationRow
                    automation={automation}
                    key={automation.id}
                    onRunNow={(target) => void onRunAutomation(target).catch(() => undefined)}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-label="Work streams" className="sidebar-section workstreams-section">
            {loading && workstreams.length === 0 ? (
              <div className="sidebar-skeleton tall" aria-label="Loading work streams" />
            ) : groups.length === 0 ? (
              <p className="sidebar-empty">No work streams yet</p>
            ) : (
              groups.map((group) => (
                <div className="sidebar-group" key={group.label}>
                  <h3>{group.label}</h3>
                  <div className="sidebar-list">
                    {group.streams.map((workstream) => (
                      <WorkstreamRow
                        key={workstream.id}
                        onMarkUnread={(target) => void onMarkWorkstreamUnread(target).catch(() => undefined)}
                        onRename={openRename}
                        workstream={workstream}
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
    </>
  );
}
