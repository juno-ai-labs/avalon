import type { UserId, WorkspaceId } from '@rally/contracts';
import type { Env, IdentityAuthContext } from '../env';
import { runtimeDeferral, type WorkDeferral } from '../lib/defer';
import { diagnosticErrorCode, logWarn } from '../observability/logger';
import { emitProductUsageTelemetry, resourceTelemetryEventId } from './product-usage';

export interface MessageSentObservation {
  workspaceId: WorkspaceId;
  workstreamId: string;
  messageId: string;
  scope: 'personal' | 'workspace';
  origin: string;
  messageKind: 'message' | 'elicitation_response';
  attachmentCount: number;
  mentionCount: number;
  participantAddedCount: number;
}

const count = (value: number): number => Math.min(100, Math.max(0, Math.trunc(value)));

/**
 * Records a message a person sent, after it is durably admitted. Emitted by the
 * API rather than a client so the desktop app and the browser are counted by
 * the same code, and a retried send is one event: the id derives from the
 * message. Only a person's own session counts; a connector, a support session,
 * or a resource-authorization callback writes as someone without
 * that person sending anything.
 */
export function recordMessageSentTelemetry(
  env: Env,
  auth: Pick<IdentityAuthContext, 'userId' | 'principal' | 'impersonatorUserId'>,
  input: MessageSentObservation,
  defer: WorkDeferral = runtimeDeferral,
): void {
  if (auth.principal !== undefined || auth.impersonatorUserId !== undefined) return;
  try {
    const eventId = resourceTelemetryEventId(input.messageId, 1);
    emitProductUsageTelemetry(env, {
      workspaceId: input.workspaceId,
      userId: auth.userId as UserId,
      name: 'message_sent',
      properties: {
        workstreamId: input.workstreamId,
        messageId: input.messageId,
        visibility: input.scope === 'personal' ? 'private' : 'public',
        workstreamOrigin: input.origin === 'automation' ? 'automation' : 'ad_hoc',
        messageKind: input.messageKind,
        attachmentCount: count(input.attachmentCount),
        mentionCount: count(input.mentionCount),
        participantAddedCount: count(input.participantAddedCount),
      },
      operationId: eventId,
      eventId,
    }, defer);
  } catch (error) {
    // Observation never fails the send it observes.
    logWarn(env, 'message_sent_telemetry_failed', {
      workspace_id: input.workspaceId,
      code: diagnosticErrorCode(error, 'message_sent_telemetry_failed'),
    });
  }
}
