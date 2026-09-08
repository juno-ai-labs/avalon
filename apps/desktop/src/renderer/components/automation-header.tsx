import { useState } from 'react';
import { CirclePause, Ellipsis, Mail, Play, Trash2 } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { DeleteAutomationDialog } from './delete-automation-dialog';
import type { AutomationDetail, AutomationRun } from '../lib/types';
import { formatRelative } from '../lib/format';
import { Badge, Button, IconButton, InlineError, StatusDot } from './primitives';

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

/**
 * The strip above an automation's conversation: what it is, where it stands in
 * its lifecycle, and the few things a person does to it from outside the chat.
 *
 * The draft itself is written in the conversation, so the header carries no
 * editor. Create and Apply are one button: the first press creates the
 * automation from its ready definition, every later press re-applies an edit,
 * and the label says which.
 */
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
  return (
    <header className="workstream-header automation-header window-drag">
      <div className="automation-header-row">
        <div className="workstream-header-left window-no-drag">
          <div className="workstream-title-block">
            <div className="workstream-title-line">
              <h1>{name}</h1>
              <Badge className={`automation-lifecycle is-${automation.lifecycle}`}>
                {lifecycleLabel[automation.lifecycle]}
              </Badge>
              <Badge className="scope-badge">{scopeLabel(automation.scope)}</Badge>
            </div>
            <div className="workstream-subtitle">
              {error ? <InlineError>{error}</InlineError> : (
                <>
                  <span>{description}</span>
                  {automation.emailAddress && (
                    <span className="automation-header-email" title={automation.emailAddress}>
                      <Mail aria-hidden="true" size={11} /> {automation.emailAddress}
                    </span>
                  )}
                </>
              )}
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
                <DropdownMenu.Separator className="menu-separator" />
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
      <div className="automation-header-details window-no-drag">
        {automation.triggerSummaries.length > 0 && (
          <ul aria-label="Triggers" className="automation-header-triggers">
            {automation.triggerSummaries.map((summary) => <li key={summary}>{summary}</li>)}
          </ul>
        )}
        {(hasTriggers || listedRuns.length > 0) && <details className="automation-runs">
          <summary>
            Runs{listedRuns.length > 0 ? ` (${listedRuns.length})` : ''}
            {automation.nextRunAt && <span className="automation-runs-next"> · Next {formatRelative(automation.nextRunAt)}</span>}
          </summary>
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
                  <Badge>{run.status.replace('_', ' ')}</Badge>
                </li>
              ))}
            </ul>
          )}
        </details>}
      </div>
    </header>
  );
}
