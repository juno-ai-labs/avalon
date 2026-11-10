import {
  SIDEKICK_SOURCE_ERRORS,
  type ActivityItem,
  type SidekickSourceErrorCode,
  type SidekickSourceRequestView,
  type SidekickSourcesResult,
} from '@rally/contracts';
import type { SourceAsk, SourceWords } from '@rally/ui/components/sidekick-sources';
import type { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api';
import { connectorPresentation } from './connector-presentation';
import { sourceConnectorName } from '@rally/contracts/sidekick-source-words';

/**
 * The client's side of Sidekick sources (`docs/sidekick-sources.md`): the
 * cache keys its three surfaces read under, what moves them, and the words a
 * connector and its events are called. `sidekick-source-request-card.ts`
 * holds the card a tool call draws.
 */

/**
 * `GET /sidekicks/:id/sources`. Under the Sidekick's own key, so everything
 * that already invalidates a Sidekick (its list row moving, the `automations`
 * topic) re-reads its sources too.
 */
export function sidekickSourcesQueryKey(sidekickId: string): readonly unknown[] {
  return ['automation', sidekickId, 'sources'];
}

/** One card's requests, under the Sidekick's sources so one invalidation moves the panel and every card. */
export function sidekickSourceRequestsQueryKey(sidekickId: string, requestIds: readonly string[]): readonly unknown[] {
  return [...sidekickSourcesQueryKey(sidekickId), 'requests', ...requestIds];
}

/**
 * The person's own answer, as the server acknowledged it, written into every
 * read that holds the request: the panel's list and each card. Nothing here
 * is optimistic; the invalidation then re-reads for what the answer changed
 * beside the request (an approval's new sources).
 */
export function applyDecidedSourceRequest(queryClient: QueryClient, decided: SidekickSourceRequestView): void {
  const root = sidekickSourcesQueryKey(decided.sidekickId);
  const replace = (requests: readonly SidekickSourceRequestView[]): SidekickSourceRequestView[] =>
    requests.map((request) => request.requestId === decided.requestId ? decided : request);
  queryClient.setQueryData<SidekickSourcesResult>(root, (current) => current && { ...current, requests: replace(current.requests) });
  queryClient.setQueriesData<SidekickSourceRequestView[]>({ queryKey: [...root, 'requests'] }, (current) => current && replace(current));
  void queryClient.invalidateQueries({ queryKey: root });
}

/**
 * The Sidekicks whose source requests moved between two Activity pages: a
 * request's row arrived, left, or changed where it stands. The Activity push
 * is what tells the person asked and the person who asked that a request was
 * answered or replaced, so it is what their open panel and cards re-read on.
 */
export function sidekicksWithMovedSourceRequests(
  before: readonly ActivityItem[],
  after: readonly ActivityItem[],
): string[] {
  const standing = (items: readonly ActivityItem[]): Map<string, { sidekickId: string; state: string }> => new Map(items
    .filter((item) => item.sourceRequest)
    .map((item) => [item.id, { sidekickId: item.parentId, state: `${item.sourceRequest!.requestId}:${item.sourceRequest!.state}` }]));
  const was = standing(before);
  const moved = new Set<string>();
  for (const [id, row] of standing(after)) {
    if (was.get(id)?.state !== row.state) moved.add(row.sidekickId);
    was.delete(id);
  }
  for (const row of was.values()) moved.add(row.sidekickId);
  return [...moved];
}

/** Re-read the sources of every Sidekick whose requests an Activity push moved. */
export function invalidateMovedSourceRequests(
  queryClient: QueryClient,
  before: readonly ActivityItem[] | undefined,
  after: readonly ActivityItem[],
): void {
  // The first page this window hears has nothing to compare against, and
  // whatever is mounted read its state just now.
  if (before === undefined) return;
  for (const sidekickId of sidekicksWithMovedSourceRequests(before, after)) {
    void queryClient.invalidateQueries({ queryKey: sidekickSourcesQueryKey(sidekickId) });
  }
}

/**
 * An event type in words. The contract carries the connector's own type
 * (`email.received`) and no label, and the label a connector's manifest
 * declares stays on the server, where the request's push, email and Activity
 * preview are worded from it. This is that manifest's default rule
 * (`humanizeActivityEventType` in `packages/connectors/src/types.ts`: the
 * family dropped past two segments, underscores to spaces, a capital), so the
 * card and the panel say "Email received" as the notice does. A connector
 * that overrides a label reads differently here until the contract carries
 * the label.
 */
export function sourceEventWords(eventType: string): string {
  const parts = eventType.split('.');
  if (parts.length > 2) parts.shift();
  const text = parts.join(' ').replaceAll('_', ' ').trim();
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : eventType;
}

/**
 * What a source's connector and events are called. Every other connector is
 * named by `connectorPresentation`, the name its mention and its Settings
 * card already wear.
 */
export const sourceWords: SourceWords = ({ connectorType, eventTypes }: SourceAsk) => ({
  // One rule with the notices' and the emailed page's (`sourceConnectorName`).
  connector: sourceConnectorName(connectorType, eventTypes, connectorPresentation(connectorType).name),
  events: eventTypes.map(sourceEventWords).join(', '),
});

/**
 * Why an answer or a withdrawal was refused, in the product's words: the
 * contract's own sentence for each refusal it names, and for an approval with
 * nothing connected, which account to connect first. Anything else is the
 * server's own message.
 */
export function sourceRefusal(error: Error, ask?: SourceAsk): string {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'sidekick_source_connection_missing' && ask) {
    return `Connect your ${sourceWords(ask).connector} account in Settings first. There is nothing to allow until it is connected.`;
  }
  if (code !== undefined && code in SIDEKICK_SOURCE_ERRORS) return SIDEKICK_SOURCE_ERRORS[code as SidekickSourceErrorCode];
  return error.message;
}
