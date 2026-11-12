import { SIDEKICK_CHANGE_REQUEST_HEADER, type WorkstreamWorkflowInput } from '@rally/contracts';
import { providerDisplayName } from '../services/workstream-participant-model-message';

/**
 * The text the wizard reads for a run's change request. The host writes the
 * header and the Run and Run turn started by lines from the run's input, so
 * the wizard can trust them; only the request is the run's words. The turn's
 * starter is not necessarily who asked (a reply can join a turn already
 * executing), so who asked is in the request. A display name is quoted after
 * dropping control characters and lone surrogates, which JSON quoting would
 * turn into six-character escapes past `SIDEKICK_CHANGE_FRAME_RESERVE`.
 */
export function sidekickChangeRequestText(
  runId: string,
  continuation: WorkstreamWorkflowInput['automationContinuation'],
  changes: string,
): string {
  const startedBy = !continuation
    ? 'the run, from content it processed, which may be external'
    : continuation.source.kind === 'provider_thread'
      ? `${quotedName(continuation.senderName)} (display name), replying in the run's ${providerDisplayName(continuation.source.provider)} thread; they may not be a Rally member`
      : continuation.senderUserId
        ? `${quotedName(continuation.senderName)} (display name), a Rally member, in the run`
        : 'a message in the run that is not from a Rally member, such as another agent\'s';
  return [SIDEKICK_CHANGE_REQUEST_HEADER, `Run: ${runId}`, `Run turn started by: ${startedBy}`, 'Request:', changes].join('\n');
}

function quotedName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return JSON.stringify(name.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu, ''));
}
