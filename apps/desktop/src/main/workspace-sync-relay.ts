import { WorkspaceSyncTopicSchema } from '@rally/contracts';
import { RegionSchema } from '@rally/contracts/regions';
import { codeShaped, describeZodIssues } from '@rally/contracts/zod-diagnostics';
import { z } from 'zod';
import { ConversationViewRequestSchema, WorkspaceConversationViewEventSchema } from '@rally/contracts/conversation-view';
import {
  sameWorkspaceSyncIdentity,
  type WorkspaceSyncPublication,
  type WorkspaceSyncRelayEvent,
  type WorkspaceSyncSourceSnapshot,
  type WorkspaceConversationViewRelayRequest,
} from '../common/workspace-sync-relay';

const identity = {
  region: RegionSchema,
  workspaceId: z.string().uuid(),
};

/**
 * The one shape main accepts from the main window's renderer — the relay's
 * untrusted edge. Closed: an unknown key is refused, so nothing but an
 * identity, connection state, topic names, a waterline, or a typed preview reply
 * can be relayed.
 */
const WorkspaceSyncPublicationSchema: z.ZodType<WorkspaceSyncPublication> = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('state'),
    ...identity,
    state: z.enum(['connecting', 'connected', 'reconnecting', 'unavailable']),
  }),
  z.strictObject({ type: z.literal('detach'), ...identity }),
  z.strictObject({
    type: z.literal('topics'),
    ...identity,
    waterline: z.number().int().nonnegative(),
    topics: z.array(z.union([WorkspaceSyncTopicSchema, z.literal('usage')])).min(1),
  }),
  z.strictObject({ type: z.literal('conversation_view_response'), ...identity, event: WorkspaceConversationViewEventSchema }),
]);
const ConversationViewRelayRequestSchema = z.discriminatedUnion('type', [
  ConversationViewRequestSchema.extend({ ...identity, type: z.literal('conversation_view_request') }),
  z.strictObject({ ...identity, type: z.literal('conversation_view_cancel'), requestId: z.string().uuid() }),
]);

/**
 * Main's half of the Organization-sync relay: which Organization the main
 * window's socket is serving, and the hop from that window to the ones
 * consuming it.
 *
 * No Electron import. `workspace-sync-relay-ipc.ts` decides who may publish
 * (the main window only) and who may read the source (the Settings window
 * only); `index.ts` decides who receives and when the publishing renderer is
 * gone (closed, crashed or navigating). This class holds the one piece of
 * state those decisions share.
 *
 * The source is attached by the main window's `state` publication and ends on
 * its `detach` — its provider unmounted with no successor, as when the tree
 * falls into the top-level error boundary — or when main releases it. A
 * `detach` for an identity that is no longer attached is stale and ignored, so
 * a successor's attach always wins.
 */
export class WorkspaceSyncRelay {
  private current: WorkspaceSyncSourceSnapshot = { revision: 0, source: null };

  constructor(private readonly deliver: (event: WorkspaceSyncRelayEvent) => void) {}

  snapshot(): WorkspaceSyncSourceSnapshot {
    return this.current;
  }

  /** A consumer may request only through the publisher for its Organization. */
  conversationViewRequest(raw: unknown): WorkspaceConversationViewRelayRequest | null {
    const parsed = ConversationViewRelayRequestSchema.safeParse(raw);
    if (!parsed.success) throw new Error(codeShaped(`workspace_conversation_view_request_invalid:${describeZodIssues(parsed.error)}`));
    return sameWorkspaceSyncIdentity(this.current.source, parsed.data) ? parsed.data : null;
  }

  /** Throws a code naming the rejected field on a publication main cannot read. */
  publish(raw: unknown): void {
    const parsed = WorkspaceSyncPublicationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(codeShaped(`workspace_sync_publication_invalid:${describeZodIssues(parsed.error)}`));
    }
    const publication = parsed.data;
    const source = this.current.source;
    if (publication.type === 'state') {
      if (source && sameWorkspaceSyncIdentity(source, publication) && source.state === publication.state) return;
      const { region, workspaceId, state } = publication;
      this.replace({ region, workspaceId, state });
      return;
    }
    if (!sameWorkspaceSyncIdentity(source, publication)) return;
    if (publication.type === 'detach') {
      this.replace(null);
      return;
    }
    this.deliver(publication);
  }

  /** The publishing renderer is gone: closed, crashed, or navigating away. */
  release(): void {
    if (this.current.source !== null) this.replace(null);
  }

  private replace(source: WorkspaceSyncSourceSnapshot['source']): void {
    this.current = { revision: this.current.revision + 1, source };
    this.deliver({ type: 'source', ...this.current });
  }
}
