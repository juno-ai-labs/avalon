import { embeddedResourceCitations, type CitationTarget } from '@rally/contracts/citations';
import { useEffect, useMemo, useRef } from 'react';
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
  /**
   * The turn this announcement belongs to. Canonical blocks and the live
   * stream overlay share `transcriptTurnId`; falling back to `id` covers a
   * row that has not been given one yet.
   */
  readonly announcementId: string;
  /** The resource's own id, after resolving any alias the citation used. */
  readonly resourceId: string;
}

type TranscriptRow = Pick<Message, 'authorType' | 'id' | 'messageType' | 'text' | 'transcriptTurnId'>;

function announcementId(message: TranscriptRow): string {
  return message.transcriptTurnId ?? message.id;
}

/**
 * The most recent resolvable embed card in the last two text turns.
 *
 * The window is **turns**, not flattened text blocks: one assistant turn can
 * be several `text` rows, and counting rows would let the later blocks of
 * that turn push its own first-block card out of the window. Plugin, thought,
 * and tool rows sit between turns without announcing a document, so they are
 * not counted.
 *
 * Only agent text is scanned. Human and external turns render markdown
 * verbatim, without the citation context, so `![Title](resource://id)` there
 * is label text, not a card — auto-opening would steal the rail for a
 * document the transcript never announced.
 *
 * An unresolved citation is skipped the same way the renderer skips it.
 * When two cards qualify, the later one wins.
 */
export function latestEmbeddedResource(
  messages: readonly TranscriptRow[],
  resolve: (resourceId: string) => { id: string } | undefined,
  lookback = EMBEDDED_RESOURCE_AUTOPEN_LOOKBACK,
): LatestEmbeddedResource | null {
  const recent: TranscriptRow[] = [];
  const seenTurns: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.messageType !== 'text') continue;
    const turn = announcementId(message);
    const latestTurn = seenTurns[seenTurns.length - 1];
    if (turn === latestTurn) {
      recent.push(message);
      continue;
    }
    if (seenTurns.length === lookback) break;
    seenTurns.push(turn);
    recent.push(message);
  }
  recent.reverse();

  let latest: LatestEmbeddedResource | null = null;
  for (const message of recent) {
    if (message.authorType !== 'agent' || !message.text) continue;
    for (const citation of embeddedResourceCitations(message.text)) {
      const resource = resolve(citation.resourceId);
      if (resource) latest = { announcementId: announcementId(message), resourceId: resource.id };
    }
  }
  return latest;
}

/**
 * Opens the inspector onto the latest embed in the last two text turns.
 *
 * Fires when a work stream's feed belongs to the current route — open,
 * reconnect, a snapshot refresh that first makes the turns available — and
 * again when a streamed turn announces a document this visit has not already
 * opened. Closing the rail for that announcement does not reopen it, including
 * when the live overlay is later replaced by its canonical block. Leaving the
 * work stream and coming back does, because that is a new visit.
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
  transcript: readonly TranscriptRow[];
  workstreamId: string;
}): void {
  const opened = useRef<{ workstreamId: string; key: string } | null>(null);
  const railOpen = useUiStore((state) => state.railOpen);
  const inspector = useUiStore((state) => state.inspector);
  const found = useMemo(
    () => (enabled ? latestEmbeddedResource(transcript, resolve) : null),
    [enabled, resolve, transcript],
  );
  const announcement = found?.announcementId ?? null;
  const resourceId = found?.resourceId ?? null;

  useEffect(() => {
    // A new visit starts when the route's work stream changes, even if this
    // feed has no embed yet — otherwise coming back to a document we already
    // auto-opened would see the old key and stay closed.
    if (opened.current?.workstreamId !== workstreamId) opened.current = null;
    if (announcement === null || resourceId === null) return;
    const key = `${announcement}:${resourceId}`;
    if (opened.current?.key === key) return;
    opened.current = { workstreamId, key };
    // Already showing this document: record the announcement so a later
    // close does not reopen it, and skip `open` because that path clears
    // the inspector before selecting, which would flash the list.
    if (railOpen && inspector?.type === 'resource' && inspector.id === resourceId) return;
    open({ scheme: 'resource', resourceId });
  }, [announcement, inspector, open, railOpen, resourceId, workstreamId]);
}
