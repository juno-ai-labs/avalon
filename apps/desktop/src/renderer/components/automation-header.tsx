import { AutomationGlyph } from './workstream-glyph';
import { useState } from 'react';
import { CirclePause, Ellipsis, History, Mail, Play, Trash2 } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { DeleteAutomationDialog } from './delete-automation-dialog';
import type { AutomationDetail, AutomationRun } from '../lib/types';
import { formatRelative, statusLabel } from '../lib/format';
import { Badge, Button, IconButton, InlineError, Modal, StatusDot } from './primitives';

export type AutomationHeaderAction = 'pause' | 'resume' | 'delete' | 'run';

export interface AutomationHeaderProps {
  automation: AutomationDetail;
  /**
   * Every run the automation has, newest first, from `GET /automations/:id/runs`.
   * `undefined` while loading, in which case the detail's recent runs stand in.
   */
  runs?: AutomationRun[];
  runsError?: string | undefined;
  /** The action in flight, so its button reads as busy and the rest stay put. */
  pending?: AutomationHeaderAction | null;
  error?: string | undefined;
  onPause: () => void;
  onResume: () => void;
  /** Runs the deletion once the person has confirmed it; a rejection stays in the dialog. */
  onDelete: () => Promise<void>;
  onRunNow: () => void;
}

const lifecycleLabel: Record<AutomationDetail['lifecycle'], string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  deleted: 'Deleted',
};

function scopeLabel(scope: AutomationDetail['scope']): string {
  return scope === 'you' ? 'Only you' : scope === 'workspace' ? 'Workspace' : 'This work stream';
}

function runTriggerLabel(run: AutomationRun): string {
  switch (run.triggerType) {
    case 'manual': return 'Manual';
    case 'schedule': return 'Scheduled';
    case 'external_event': return 'Event';
    case 'inbound_email': return 'Email';
  }
}

function runStatus(run: AutomationRun): React.ComponentProps<typeof StatusDot>['status'] {
  return run.status === 'pending' ? 'scheduled' : run.status;
}

/** Sidekick profile, lifecycle controls, and activity beside its authoring conversation. */
export function AutomationHeader({
  automation,
  runs,
  runsError,
  pending = null,
  error,
  onPause,
  onResume,
  onDelete,
  onRunNow,
}: AutomationHeaderProps): React.JSX.Element {
  const definition = automation.currentDefinition;
  const name = definition?.name ?? automation.name;
  const description = definition?.description ?? automation.description;
  const listedRuns = runs ?? automation.recentRuns;
  // The object runs only an active automation (`automation_not_active`
  // otherwise), so a paused one is not offered a command that always fails.
  const hasTriggers = automation.runnable ?? ((definition?.triggers.length ?? 0) > 0);
  const canRun = automation.lifecycle === 'active' && hasTriggers;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showRunHistory, setShowRunHistory] = useState(false);
  return (
    <div className="automation-header">
      <span className="sidekick-profile-glyph"><AutomationGlyph id={automation.id} /></span>
      <div className="automation-header-row">
        <div className="workstream-header-left window-no-drag">
          <div className="workstream-title-block">
            <div className="automation-title-line">
              <h1>{name}</h1>
              <Badge className={`automation-lifecycle is-${automation.lifecycle}`}>
                {lifecycleLabel[automation.lifecycle]}
              </Badge>
              <Badge className="scope-badge">{scopeLabel(automation.scope)}</Badge>
            </div>
            <div className="automation-description">
              {description}
              {error && <InlineError>{error}</InlineError>}
            </div>
          </div>
        </div>
        <div className="workstream-header-actions window-no-drag">
          {automation.lifecycle === 'active' && (
            <Button disabled={pending !== null} onClick={onPause}>
              <CirclePause aria-hidden="true" size={14} /> {pending === 'pause' ? 'Pausing…' : 'Pause'}
            </Button>
          )}
          {automation.lifecycle === 'paused' && (
            <Button disabled={pending !== null} onClick={onResume}>
              <Play aria-hidden="true" size={14} /> {pending === 'resume' ? 'Resuming…' : 'Resume'}
            </Button>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <IconButton label="More Sidekick actions"><Ellipsis size={16} /></IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
                {hasTriggers && <DropdownMenu.Item className="menu-item" disabled={!canRun || pending !== null} onSelect={onRunNow}>
                  <Play size={14} /> {pending === 'run' ? 'Starting…' : 'Run now'}
                </DropdownMenu.Item>}
                {(hasTriggers || listedRuns.length > 0) && <DropdownMenu.Item className="menu-item" onSelect={() => setShowRunHistory(true)}>
                  <History size={14} /> Run history
                </DropdownMenu.Item>}
                {(hasTriggers || listedRuns.length > 0) && <DropdownMenu.Separator className="menu-separator" />}
                <DropdownMenu.Item
                  className="menu-item menu-item-danger"
                  disabled={pending !== null}
                  onSelect={() => setConfirmingDelete(true)}
                >
                  <Trash2 size={14} /> {automation.lifecycle === 'draft' ? 'Delete draft' : 'Delete Sidekick'}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <DeleteAutomationDialog
            onClose={() => setConfirmingDelete(false)}
            onConfirm={onDelete}
            target={confirmingDelete ? { name, status: automation.lifecycle } : null}
          />
        </div>
      </div>
      <div className="automation-header-details">
        {(automation.triggerSummaries.length > 0 || automation.nextRunAt) && (
          <section className="sidekick-profile-section"><h2>When to expect it</h2>{automation.triggerSummaries.length > 0 && <ul aria-label="Triggers" className="automation-header-triggers">
            {automation.triggerSummaries.map((summary) => <li key={summary}>{summary}</li>)}
          </ul>}{automation.nextRunAt && <p className="automation-runs-next">Next {formatRelative(automation.nextRunAt)}</p>}</section>
        )}
        <section className="sidekick-profile-section sidekick-guidance">
          <h2>Make it work for you</h2>
          <p>Ask for changes in the conversation. Try “Keep it short” or “Use a more casual tone.”</p>
        </section>
        {automation.emailAddress && <details className="sidekick-profile-section sidekick-email-details"><summary>Email this Sidekick</summary><span className="automation-header-email"><Mail aria-hidden="true" size={14} /><span>{automation.emailAddress}</span></span></details>}
      </div>
      <Modal open={showRunHistory} onOpenChange={setShowRunHistory} title="Run history" description="Technical details for troubleshooting this Sidekick.">
          {runsError ? (
            <p className="automation-runs-empty">Could not load runs</p>
          ) : listedRuns.length === 0 ? (
            <p className="automation-runs-empty">No runs yet</p>
          ) : (
            <ul aria-label="Runs" className="automation-runs-list">
              {listedRuns.map((run) => (
                <li className="automation-run-row" key={run.id}>
                  <StatusDot compact status={runStatus(run)} />
                  <span className="automation-run-copy">
                    <strong>{runTriggerLabel(run)}</strong>
                    <small>
                      {run.resultSummary
                        ?? (run.status === 'running'
                          ? `Running ${formatRelative(run.startedAt ?? run.createdAt)}`
                          : formatRelative(run.completedAt ?? run.startedAt ?? run.plannedFor ?? run.createdAt))}
                    </small>
                  </span>
                  <Badge>{statusLabel[runStatus(run)]}</Badge>
                </li>
              ))}
            </ul>
          )}
      </Modal>
    </div>
  );
}
