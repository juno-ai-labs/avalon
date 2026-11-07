import { z } from 'zod';
import type { MessageRow } from '../durable-objects/workstream-message-storage';
import { agentMessageNotice } from '@rally/contracts';
import type { CreateMessageIssue, MessageIssueReceipt } from '@rally/contracts/message-issues';

import type { AuthContext, Env } from '../env';
import { ApiError } from '../lib/api-error';

import { createMessageObjectPort } from '../runtime/message-port';
import { ConversationService } from './conversation-service';

/** Explicit issue reports are stored apart from product and telemetry databases. */
export class MessageIssueService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async create(input: CreateMessageIssue): Promise<MessageIssueReceipt> {
    const target = input.target;
    // A Channel message was reportable from its feed; Channels are retired
    // (plan step C-2), so a report names a Canvas's or a Sidekick's message.
    if (target.kind !== 'conversation') throw messageNotFound();
    const parent = await new ConversationService(this.env, this.auth).authorizeViewer(target.parentId, target.substreamId);
    const message = await createMessageObjectPort(this.env, this.auth.workspaceId, target.parentId,
      undefined, target.substreamId).message({ messageId: input.messageId });
    if (!message || !reportableMessage(message)) throw messageNotFound();
    const parentId = parent.id;
    const parentKind = parent.kind;
    const threadId: string | null = null;
    const channelId: string | null = null;
    const metadata: Record<string, unknown> = {
      authorType: message.author_type, authorUserId: message.author_user_id,
      messageType: message.message_type, messageCreatedAt: message.created_at,
      sequenceNumber: message.sequence_number, harnessRunId: message.harness_run_id,
      harnessAttemptId: message.harness_attempt_id,
    };
    const substreamId = target.kind === 'conversation' ? target.substreamId : null;
    const breakoutId: string | null = null;
    const requestJson = JSON.stringify({ target, messageId: input.messageId, description: input.description, blockId: input.blockId ?? null });
    const createdAt = new Date().toISOString();
    await this.env.MESSAGE_ISSUES_DB.prepare(`INSERT INTO message_issues
      (id, workspace_id, reporter_user_id, impersonator_user_id, session_id, region, message_id,
       parent_kind, parent_id, substream_id, thread_id, breakout_id, channel_id, description,
       request_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).bind(input.id, this.auth.workspaceId, this.auth.userId,
      this.auth.impersonatorUserId ?? null, this.auth.sessionId, this.env.AVALON_REGION, input.messageId,
      parentKind, parentId, substreamId, threadId, breakoutId, channelId, input.description,
      requestJson, JSON.stringify({ ...metadata, blockId: input.blockId ?? input.messageId }), createdAt).run();
    const stored = await this.env.MESSAGE_ISSUES_DB.prepare(
      'SELECT workspace_id, reporter_user_id, request_json, created_at FROM message_issues WHERE id = ?',
    ).bind(input.id).first<{ workspace_id: string; reporter_user_id: string; request_json: string; created_at: string }>();
    if (!stored || stored.workspace_id !== this.auth.workspaceId || stored.reporter_user_id !== this.auth.userId
      || stored.request_json !== requestJson) {
      throw new ApiError(409, 'message_issue_id_conflict', 'This report changed. Close it and try again.');
    }
    return { id: input.id, createdAt: stored.created_at };
  }
}

function messageNotFound(): ApiError {
  return new ApiError(404, 'message_issue_message_not_found', 'This message is no longer available.');
}

/** System turns only expose authored prose for Sidekick results and the opening brief. */
function reportableMessage(message: MessageRow): boolean {
  if (['human', 'agent', 'external'].includes(message.author_type)) return true;
  if (message.message_type === 'automation_activation') return true;
  if (message.sequence_number !== 1 || !message.structured_content_json) return false;
  const opening = z.looseObject({ kind: z.literal('agent_message'), notice: z.unknown().optional() })
    .safeParse(JSON.parse(message.structured_content_json));
  return opening.success && agentMessageNotice(opening.data) === null;
}
