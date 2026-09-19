import { RegionSchema, type NormalizedActivity } from '@rally/contracts';
import { z } from 'zod';
import { sha256Hex } from './provider-utils';
import { ConnectorError, type AuthorizedConnectorConnection, type ConnectorPollingActivitySource } from './types';

// The agreed product polling floor, PRD 2026-09-17_canva-connector.
export const CANVA_POLL_SECONDS = 600;
const Id = z.string().min(1);
const Watch = z.object({ watchId: Id, designId: Id, accessReference: z.string().optional() });
const Item = z.looseObject({ id: Id, created_at: z.number().nonnegative() });
const Page = z.looseObject({
  items: z.array(Item), continuation: Id.optional(),
});
const Design = z.looseObject({ design: z.object({
  id: Id, title: z.string(), updated_at: z.number().nonnegative(),
}) });
const Cursor = z.object({
  designId: Id.optional(), updatedAt: z.number().optional(), baselineComplete: z.boolean().default(false),
  known: z.array(Id).default([]), seen: z.array(Id).default([]),
  threads: z.array(Id).default([]), threadIndex: z.number().int().nonnegative().default(0),
  phase: z.enum(['threads', 'replies']).default('threads'), continuation: Id.optional(),
});
type Call = (connection: AuthorizedConnectorConnection, name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** Consumed fields are parsed independently of the server's optional outputSchema. */
export function canvaDesign(value: unknown) { return Design.parse(value).design; }

export function createCanvaPolling(call: Call): ConnectorPollingActivitySource {
  return {
    streams(connection) {
      const watch = Watch.safeParse(connection.config.canvaWatch);
      if (!watch.success) return [];
      return ['design', 'discussion'].map((kind) => ({
        id: `${watch.data.watchId}:${kind}`, idlePollIntervalSeconds: CANVA_POLL_SECONDS,
        backlogPollIntervalSeconds: CANVA_POLL_SECONDS, failurePollIntervalSeconds: CANVA_POLL_SECONDS,
        // Shared-output/digest policy remains a launch gate; never widen an audience.
        digestible: false,
      }));
    },
    normalizeHighWatermark(_connection, _stream, value) { return Cursor.parse(value ?? {}); },
    async pollStream(connection, stream, watermark, signal) {
      const watch = Watch.parse(connection.config.canvaWatch);
      const stored = Cursor.parse(watermark);
      const cursor = stored.designId && stored.designId !== watch.designId ? Cursor.parse({}) : stored;
      cursor.designId = watch.designId;
      const activities: Omit<NormalizedActivity, 'id'>[] = [];
      async function activity(eventType: string, identity: string, timestamp: number, threadId?: string, replyId?: string) {
        if (!connection.ownerUserId) throw new ConnectorError('unauthorized', 'Canva watches require their connection owner.');
        const key = `canva:${watch.designId}:${identity}`;
        // Content-free stable payload: an edited title/body on a retry cannot change
        // the hash of an already accepted event. Hydration reads current content.
        const metadata = { designId: watch.designId, ...(threadId ? { threadId } : {}), ...(replyId ? { replyId } : {}) };
        activities.push({
          region: RegionSchema.parse(connection.config.region), workspaceId: connection.workspaceId, connectionId: connection.id,
          connectionScope: 'personal', connectionOwnerUserId: connection.ownerUserId,
          provider: 'canva', providerEventId: key, eventType, resourceType: 'canva_design',
          providerResourceId: watch.designId, actor: {},
          subject: { id: watch.designId, type: 'canva_design' },
          occurredAt: new Date(timestamp * 1000).toISOString(), receivedAt: new Date().toISOString(),
          title: eventType === 'design.revised' ? 'Canva design changed' : 'New Canva discussion activity',
          summary: '', textSnippet: '', payloadRef: null,
          visibility: { scope: 'restricted', userIds: [connection.ownerUserId] },
          targetUserIds: [connection.ownerUserId], entityKeys: [`canva:design:${watch.designId}`],
          dedupeKey: key, rawContentHash: await sha256Hex(JSON.stringify({ key, timestamp, metadata })), metadata,
        });
      }
      if (stream.id.endsWith(':design')) {
        const design = canvaDesign(await call(connection, 'get-design', { design_id: watch.accessReference ?? watch.designId, user_intent: 'Check an explicitly watched design for changes.' }, signal));
        if (design.id !== watch.designId) throw new ConnectorError('provider_error', 'Canva returned a different design.id.');
        if (cursor.updatedAt !== undefined && design.updated_at > cursor.updatedAt) {
          await activity('design.revised', `revision:${design.updated_at}`, design.updated_at);
        }
        return { activities, highWatermark: { designId: watch.designId, updatedAt: Math.max(cursor.updatedAt ?? 0, design.updated_at) }, hasMore: false };
      }
      const threadId = cursor.threads[cursor.threadIndex];
      const replies = cursor.phase === 'replies';
      if (replies && !threadId) throw new ConnectorError('invalid_configuration', 'Canva scan is missing its current thread.');
      const page = Page.parse(await call(connection, replies ? 'list-replies' : 'list-comments', {
        design_id: watch.designId, ...(replies ? { comment_id: threadId } : { limit: 100 }),
        ...(cursor.continuation ? { continuation: cursor.continuation } : {}),
        user_intent: 'Check an explicitly watched design for new comments and replies.',
      }, signal));
      if (page.continuation && page.continuation === cursor.continuation) {
        throw new ConnectorError('provider_error', 'Canva repeated its continuation token.');
      }
      const known = new Set(cursor.known);
      const seen = new Set(cursor.seen);
      for (const item of page.items) {
        const key = replies ? `reply:${threadId}:${item.id}` : `thread:${item.id}`;
        if (cursor.baselineComplete && !known.has(key)) {
          await activity('design.commented', key, item.created_at, replies ? threadId : item.id, replies ? item.id : undefined);
        }
        known.add(key); seen.add(key);
        if (!replies && !cursor.threads.includes(item.id)) cursor.threads.push(item.id);
      }
      cursor.known = [...known]; cursor.seen = [...seen];
      delete cursor.continuation;
      if (page.continuation) cursor.continuation = page.continuation;
      else if (!replies && cursor.threads.length) cursor.phase = 'replies';
      else if (replies && cursor.threadIndex + 1 < cursor.threads.length) cursor.threadIndex++;
      else return {
        activities, highWatermark: { designId: watch.designId, baselineComplete: true, known: cursor.seen }, hasMore: false,
      };
      return { activities, highWatermark: cursor, hasMore: true };
    },
  };
}
