import type { HarnessStatus } from './types';

/**
 * The words for one automation run, shared by every surface that lists one.
 *
 * The run list on the automation screen and the runs rail beside it were each
 * writing their own sentence for the same run, so the same run read as two
 * different things a few hundred pixels apart. There is one answer here
 * instead, and the surfaces differ only in what they put around it.
 */

/**
 * What separates one run from the next, since the title cannot.
 *
 * Every run of an automation is titled after the automation, so a list of them
 * is the same sentence repeated. What actually differs is why each one started
 * and when.
 */
export function runTriggerLabel(triggerType: string): string {
  if (triggerType === 'manual') return 'Run now';
  if (triggerType === 'scheduled') return 'On schedule';
  if (triggerType === 'inbound_email') return 'By email';
  if (triggerType === 'external_event') return 'By activity';
  return triggerType.replaceAll('_', ' ');
}

/**
 * How each run state reads when the run carries no summary of its own.
 *
 * Every state gets a sentence, because the server can produce every one of them
 * with `resultSummary` null — `runSummariesUnchecked` in `automation-agent.ts`
 * has nowhere to read a summary from, so today that is *every* run. Falling
 * through to "No result summary" meant a finished run reported an absence, and
 * `needs_input` — the one state that needs the reader to go and do something —
 * reported an absence too.
 */
const statusFallback: Record<HarnessStatus, string> = {
  scheduled: 'Not started yet',
  running: 'Rally is working…',
  needs_input: 'Waiting for you',
  completed: 'Finished',
  // "No result summary" is what a failed run said before, which reads as an
  // absence rather than as the thing that happened.
  failed: 'Failed',
  stopped: 'Stopped',
};

export function runResultSummary(run: { status: HarnessStatus; resultSummary?: string }): string {
  if (run.resultSummary) return run.resultSummary;
  // A status outside the contract's own enum can only reach here from a server
  // ahead of this build, and it is the one case with nothing true to say.
  return statusFallback[run.status] ?? 'No result summary';
}
