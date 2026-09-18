import type { HarnessStatus } from './types';
export type WorkstreamMarkerStatus = HarnessStatus | 'unread' | 'mentioned' | 'unseen';

export const statusLabel: Record<WorkstreamMarkerStatus, string> = {
  scheduled: 'Scheduled',
  running: 'Running',
  needs_input: 'Needs input',
  completed: 'Latest run completed',
  failed: 'Needs intervention',
  stopped: 'Latest run stopped',
  unread: 'Unread',
  mentioned: 'You were mentioned',
  unseen: 'New to you',
};

/** What each dot color means, for the surfaces that show the dot on its own.
 * Each sentence opens with the label itself, so rewording one carries here. */
export const statusDescription: Record<WorkstreamMarkerStatus, string> = {
  scheduled: `${statusLabel.scheduled} — the next run has not started yet.`,
  running: `${statusLabel.running} — the agent is on it.`,
  needs_input: `${statusLabel.needs_input} — the agent is waiting on an answer.`,
  completed: `${statusLabel.completed} — nothing is running now.`,
  failed: `${statusLabel.failed} — the last run failed and stopped.`,
  stopped: `${statusLabel.stopped} — the run was stopped by request.`,
  unread: `${statusLabel.unread} — there are messages here you have not read.`,
  mentioned: `${statusLabel.mentioned} — somebody named you in a message you have not read.`,
  unseen: `${statusLabel.unseen} — you were added to this work stream and have not opened it yet.`,
};

/**
 * The marker a work stream's own run draws as.
 *
 * `scheduled` folds into `running`, so a work stream whose next run is queued
 * is presented as one that is already working. The distinction is real in the
 * data and worth nothing to somebody scanning a list: either way the agent has
 * the work and nobody is being asked for anything, and a person cannot act on
 * the difference between "started" and "about to start". Drawn separately it
 * was a marker of its own on a work stream that had done nothing yet.
 *
 * It is also the last step of a mapping the API had already made: the wire
 * folds `preparing_context` and `waiting_capacity` into `running` too
 * (`workstream-runtime-compat-schema.ts`), so admitted-but-not-launched was the
 * one non-executing run state still drawn as something of its own.
 *
 * Every surface that turns a run's status into a marker goes through here, so
 * the sidebar and the work-stream header cannot disagree. The return type says
 * so: `scheduled` survives in `WorkstreamMarkerStatus` for the Sidekick run
 * history — which lists runs rather than work streams, and where a pending run
 * is exactly what somebody opened the list to find — but it cannot come back
 * out of here.
 *
 * This governs presentation only. Run *control* deliberately keeps reading the
 * real status: the composer's queued delivery and its Stop affordance test
 * `harnessStatus === 'running'`, because a stop needs a live execution to fence
 * and there is none during admission.
 */
export function harnessMarkerStatus(status: HarnessStatus): Exclude<WorkstreamMarkerStatus, 'scheduled'> {
  return status === 'scheduled' ? 'running' : status;
}
