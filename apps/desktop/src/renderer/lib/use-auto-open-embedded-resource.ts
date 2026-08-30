import { embeddedResourceCitations, type CitationTarget } from '@rally/contracts/citations';
import { useEffect, useRef } from 'react';
import type { Message } from './types';
import { useUiStore } from './ui-store';

/**
 * How many recent text turns are searched for an announced resource.
 *
 * The product request named this window: the last two messages, on a new
 * streamed turn and when a work stream is opened. It is a product number,
 * not a defensive cap.
 */
export const EMBEDDED_RESOURCE_AUTOPEN_LOOKBACK = 2;

export interface LatestEmbeddedResource {
  readonly messageId: string;
  /** The resource's own id, after resolving any alias the citation used. */
  readonly resourceId: string;
}

/**
 * The most recent resolvable embed card in the last two text turns.
 *
 * Plugin, thought, and tool rows are not messages in this sense — they sit
 * between turns without announcing a document — so the lookback counts only
 * `text` rows. An unresolved citation is skipped the same way the renderer
 * skips it: there is no card, and the rail would open onto an unavailable
 * detail. When two cards qualify, the later one wins, including a second
 * card that finishes streaming into the same turn.
 */
export function latestEmbeddedResource(
  messages: readonly Pick<Message, 'id' | 'messageType' | 'text'>[],
  resolve: (resourceId: string) => { id: string } | undefined,
  lookback = EMBEDDED_RESOURCE_AUTOPEN_LOOKBACK,
): LatestEmbeddedResource | null {
  const recent: Pick<Message, 'id' | 'messageType' | 'text'>[] = [];
  for (let index = messages.length - 1; index >= 0 && recent.length < lookback; index -= 1) {
    const message = messages[index];
    if (message?.messageType === 'text') recent.push(message);
  }
  recent.reverse();

  let latest: LatestEmbeddedResource | null = null;
  for (const message of recent) {
    if (!message.text) continue;
    for (const citation of embeddedResourceCitations(message.text)) {
      const resource = resolve(citation.resourceId);
      if (resource) latest = { messageId: message.id, resourceId: resource.id };
    }
  }
  return latest;
}

/**
 * Opens the inspector onto the latest embed in the last two text turns.
 *
 * Fires when a work stream's feed belongs to the current route — open,
 * reconnect, a snapshot refresh that first makes the turns available — and
 * again when a streamed turn announces a *different* document. Closing the
 * rail for the same announcement does not reopen it; leaving the work stream
 * and coming back does, because that is a new visit.
 */
export function useAutoOpenLatestEmbeddedResource({
  enabled,
  open,
  resolve,
  transcript,
  workstreamId,
}: {
  enabled: boolean;
  open: (target: CitationTarget) => void;
  resolve: (resourceId: string) => { id: string } | undefined;
  transcript: readonly Pick<Message, 'id' | 'messageType' | 'text'>[];
  workstreamId: string;
}): void {
  const opened = useRef<{ workstreamId: string; key: string } | null>(null);
  const railOpen = useUiStore((state) => state.railOpen);
  const inspector = useUiStore((state) => state.inspector);

  useEffect(() => {
    // A new visit starts when the route's work stream changes, even if this
    // feed has no embed yet — otherwise coming back to a document we already
    // auto-opened would see the old key and stay closed.
    if (opened.current?.workstreamId !== workstreamId) opened.current = null;
    if (!enabled) return;
    const found = latestEmbeddedResource(transcript, resolve);
    if (!found) return;
    const key = `${found.messageId}:${found.resourceId}`;
    if (opened.current?.key === key) return;
    opened.current = { workstreamId, key };
    // Already showing this document: record the announcement so a later
    // close does not reopen it, and skip `open` because that path clears
    // the inspector before selecting, which would flash the list.
    if (railOpen && inspector?.type === 'resource' && inspector.id === found.resourceId) return;
    open({ scheme: 'resource', resourceId: found.resourceId });
  }, [enabled, inspector, open, railOpen, resolve, transcript, workstreamId]);
}
