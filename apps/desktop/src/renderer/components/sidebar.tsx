import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import {
  ChevronDown,
  ChevronsLeft,
  CirclePause,
  GitBranch,
  LogOut,
  Menu,
  MessageSquarePlus,
  Plus,
  Settings,
  Zap,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { formatRelative, groupWorkstreams } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import type { AutomationSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { Avatar, Badge, IconButton, StatusDot } from './primitives';

interface SidebarProps {
  workspace: Workspace;
  automations: AutomationSummary[];
  workstreams: WorkstreamSummary[];
  loading?: boolean;
  onSignOut: () => void;
}

function AutomationRow({ automation }: { automation: AutomationSummary }): React.JSX.Element {
  return (
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
  );
}

function WorkstreamRow({ workstream }: { workstream: WorkstreamSummary }): React.JSX.Element {
  const showAutomationMarker = workstream.origin === 'automation' && workstream.harnessStatus === 'completed';
  return (
    <NavLink className={({ isActive }) => clsx('sidebar-row workstream-row', isActive && 'is-active')} to={`/workstreams/${workstream.id}`}>
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
  );
}

export function Sidebar({ workspace, automations, workstreams, loading, onSignOut }: SidebarProps): React.JSX.Element {
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const groups = groupWorkstreams(workstreams);

  return (
    <>
      <IconButton className="mobile-sidebar-trigger" label="Open navigation" onClick={() => setSidebarOpen(true)}>
        <Menu size={17} />
      </IconButton>
      {sidebarOpen && <button aria-label="Close navigation" className="sidebar-scrim" onClick={() => setSidebarOpen(false)} type="button" />}
      <aside aria-label="Avalon navigation" className={clsx('sidebar', sidebarOpen && 'is-mobile-open')}>
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
                {automations.map((automation) => <AutomationRow automation={automation} key={automation.id} />)}
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
                    {group.streams.map((workstream) => <WorkstreamRow key={workstream.id} workstream={workstream} />)}
                  </div>
                </div>
              ))
            )}
          </section>
        </nav>

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
      </aside>
    </>
  );
}
