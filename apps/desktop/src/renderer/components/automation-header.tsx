import { AutomationGlyph } from './workstream-glyph';
import { AppearancePicker } from './appearance-picker';
import { OwningThreadLabel } from './owning-thread-label';
import { useState, type ReactNode } from 'react';
import { Archive, CirclePause, Copy, Ellipsis, History, Mail, Play } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArchiveAutomationDialog } from './archive-automation-dialog';
import type { WorkstreamAppearancePatch } from '@rally/contracts';
import type { AutomationDetail, AutomationRun } from '../lib/types';
import { statusLabel } from '../lib/format';
import { Badge, Button, IconButton, ErrorNotice, Modal, StatusDot } from './primitives';
import { MenuActionItem } from '@rally/ui/components/menu-action-item';
import { RelativeTime } from './relative-time';

export type AutomationHeaderAction = 'pause' | 'resume' | 'archive' | 'run';

export interface AutomationHeaderProps {
  automation: AutomationDetail;
  delegation?: ReactNode;
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
  /** Archives the Sidekick once confirmed. */
  onArchive: () => Promise<void>;
  onRunNow: () => void;
  /**
   * Saves one icon or colour choice. Rejecting leaves the error in the open
   * palette and puts the committed appearance back, so a member without
   * management authority sees the refusal rather than a glyph that reverts on
   * its own later.
   */
  onAppearanceChange: (patch: WorkstreamAppearancePatch) => Promise<void>;
  /** Copies the Sidekick's shareable link. Rejecting shows the failure under the description. */
  onCopyLink: () => Promise<void>;
}

const lifecycleLabel: Record<AutomationDetail['lifecycle'], string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  deleted: 'Deleted',
};

function scopeLabel(scope: AutomationDetail['scope']): string {
  return scope === 'you' ? 'Only you' : scope === 'workspace' ? 'Organization' : 'Thread';
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
  delegation,
  runs,
  runsError,
  pending = null,
  error,
  onPause,
  onResume,
  onArchive,
  onRunNow,
  onAppearanceChange,
  onCopyLink,
}: AutomationHeaderProps): React.JSX.Element {
  const definition = automation.currentDefinition;
  const name = definition?.name ?? automation.name;
  const description = definition?.description ?? automation.description;
  const listedRuns = runs ?? automation.recentRuns;
  // The object runs only an active automation with triggers. Keep unavailable
  // commands visible and explain the same constraints without issuing them.
  const hasTriggers = automation.runnable ?? ((definition?.triggers.length ?? 0) > 0);
  const isPaused = automation.lifecycle === 'paused';
  const pendingReason = pending !== null ? 'Please wait for the current action to finish.' : undefined;
  const disabledReason = pendingReason ?? {
    draft: 'Finish setting up this Sidekick in the conversation before you can pause it.',
    active: undefined,
    paused: undefined,
    deleted: 'This Sidekick has been archived and can no longer be paused.',
  }[automation.lifecycle];
  const runDisabledReason = pendingReason ?? {
    draft: 'Finish setting up this Sidekick in the conversation before starting a run.',
    active: hasTriggers ? undefined : 'Add a trigger in the conversation before starting a run.',
    paused: 'Resume this Sidekick before starting a run.',
    deleted: 'This Sidekick has been archived and cannot run.',
  }[automation.lifecycle];
  const historyDisabledReason = hasTriggers || listedRuns.length > 0
    ? undefined : 'This Sidekick has no triggers or previous runs.';
  // Older accepted definitions receive email without listing an email trigger.
  const triggerSummaries = automation.triggerSummaries.length === 0 && automation.emailAddress
    ? ['When an email arrives'] : automation.triggerSummaries;
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [showRunHistory, setShowRunHistory] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  return (
    <div className="automation-header">
      <span className="sidekick-profile-glyph">
        <AppearancePicker
          id={automation.id}
          {...(automation.appearance ? { appearance: automation.appearance } : {})}
          label="Change Sidekick icon and color"
          onChange={onAppearanceChange}
          renderGlyph={(appearance) => <AutomationGlyph appearance={appearance} id={automation.id} />}
        />
      </span>
      <div className="automation-header-row">
        <div className="workstream-header-left window-no-drag">
          <div className="workstream-title-block">
            <div className="automation-title-line">
              <h1>{name}</h1>
              <Badge className={`automation-lifecycle is-${automation.lifecycle}`}>
                {lifecycleLabel[automation.lifecycle]}
              </Badge>
              {automation.scope === 'workstream' && automation.owningThread
                ? <Badge className="scope-badge owning-thread-badge"><OwningThreadLabel thread={automation.owningThread} /></Badge>
                : <Badge className="scope-badge">{scopeLabel(automation.scope)}</Badge>}
            </div>
            <div className="automation-description">
              {description}
              {error && <ErrorNotice>{error}</ErrorNotice>}
              {copyFailed && <ErrorNotice>The Sidekick link could not be copied.</ErrorNotice>}
            </div>
          </div>
        </div>
        <div className="workstream-header-actions window-no-drag">
          <Button disabledReason={disabledReason} onClick={isPaused ? onResume : onPause}>
            {isPaused ? <Play aria-hidden="true" size={14} /> : <CirclePause aria-hidden="true" size={14} />}
            {pending === 'pause' ? 'Pausing…' : pending === 'resume' ? 'Resuming…' : isPaused ? 'Resume' : 'Pause'}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <IconButton label="More Sidekick actions"><Ellipsis size={16} /></IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
                <MenuActionItem disabled={Boolean(runDisabledReason)} disabledReason={runDisabledReason} onSelect={onRunNow} tooltipSide="right">
                  <Play size={14} /> {pending === 'run' ? 'Starting…' : 'Run now'}
                </MenuActionItem>
                <MenuActionItem disabled={Boolean(historyDisabledReason)} disabledReason={historyDisabledReason} onSelect={() => setShowRunHistory(true)} tooltipSide="right">
                  <History size={14} /> Run history
                </MenuActionItem>
                <DropdownMenu.Item className="menu-item" onSelect={() => {
                  setCopyFailed(false);
                  void onCopyLink().catch(() => setCopyFailed(true));
                }}>
                  <Copy size={14} /> Copy sidekick link
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Item
                  className="menu-item menu-item-danger"
                  disabled={pending !== null}
                  onSelect={() => setConfirmingArchive(true)}
                >
                  <Archive size={14} />
                  {automation.lifecycle === 'draft' ? 'Archive draft' : 'Archive Sidekick'}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <ArchiveAutomationDialog
            onClose={() => setConfirmingArchive(false)}
            onConfirm={onArchive}
            target={confirmingArchive ? { name, status: automation.lifecycle } : null}
          />
        </div>
      </div>
      <div className="automation-header-details">
        {automation.delegationAttention && <p role="status">{automation.delegationAttention.message}</p>}
        {delegation}
        <section className="sidekick-profile-section">
          <h2>When to expect it</h2>
          {triggerSummaries.length === 0 && !automation.nextRunAt && <p className="automation-timing-empty">No timing details yet.</p>}
          {triggerSummaries.length > 0 && <ul aria-label="Triggers" className="automation-header-triggers">
            {triggerSummaries.map((summary) => <li key={summary}>{summary}</li>)}
          </ul>}
          {automation.nextRunAt && <p className="automation-runs-next">Next <RelativeTime value={automation.nextRunAt} /></p>}
        </section>
        {automation.emailAddress && <details className="sidekick-profile-section sidekick-email-details"><summary>Email this Sidekick</summary><span className="automation-header-email"><Mail aria-hidden="true" size={14} /><span>{automation.emailAddress}</span></span></details>}
      </div>
      <Modal open={showRunHistory} onOpenChange={setShowRunHistory} title="Run history" description="Technical details for troubleshooting this Sidekick.">
          {runsError ? (
            <ErrorNotice>Could not load runs</ErrorNotice>
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
                          ? <>Running <RelativeTime value={run.startedAt ?? run.createdAt} /></>
                          : <RelativeTime value={run.completedAt ?? run.startedAt ?? run.plannedFor ?? run.createdAt} />)}
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
