import { ATTACHMENT_CONVERTER_TIMEOUT_MS, ATTACHMENT_PROCESSING_LEASE_MS } from '@rally/contracts';
import { ApiError } from './api';

/**
 * Reading a resource's readable text through `/resources/:id/preview`.
 *
 * This is the protocol half of the rail's detail panel, and it lives here
 * rather than in that component because it has a second caller: the embed card
 * a citation renders reads the same derivative, so the card and the panel it
 * opens onto cannot disagree about a document. A hook in `lib/` reaching into a
 * screen-sized component module for it was one import away from a cycle, and
 * pulled the rail's chrome into every test that touched the reader.
 */

/** How a caller fetches the preview bytes. The rail and the embed card share one. */
export type ResourcePreviewLoader = (resourceId: string, signal?: AbortSignal) => Promise<Blob>;

/**
 * The delay the route named for a preview it is still preparing, or `null` for
 * every other rejection.
 *
 * `409 resource_processing` is the one answer from `/resources/:id/preview`
 * that is not a verdict: a PDF or an Office file's text derivative is being
 * materialized, and `retryAfterMs` says when to come back. The route knows
 * whether it is waiting on a claim, a hash write or a conversion and names
 * 250ms or 1s accordingly, so the wait is read off the response rather than
 * invented as a schedule here.
 *
 * A processing answer carrying no usable delay reads as terminal. That is the
 * degradation this file already had, and the alternative is a number nobody
 * chose driving a loop against a route that converts documents. Zero counts as
 * no delay: `wait(0)` resolves on the next tick, so a route that answered `0`
 * would be asked again as fast as the network allows — the wall-clock budget
 * bounds how long that lasts but not how many requests it makes, and clamping
 * it to a floor instead would mean inventing the floor.
 *
 * There is deliberately no upper bound on the delay here, even though a
 * `setTimeout` delay above 2^31 - 1 ms clamps to ~1ms rather than waiting: the
 * caller refuses to *begin* a wait that would end past its deadline, so a delay
 * that large is already rejected before any timer is armed. A second guard over
 * the same value would be a number to keep honest for a case the first one
 * cannot let through.
 */
function processingRetryDelayMs(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.code !== 'resource_processing') return null;
  const details: unknown = error.details;
  if (typeof details !== 'object' || details === null || !('retryAfterMs' in details)) return null;
  const retryAfterMs: unknown = (details as { retryAfterMs: unknown }).retryAfterMs;
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return null;
  return retryAfterMs;
}

/** Resolves after `ms`, or as soon as `signal` aborts — whichever comes first. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer = 0;
    const settle = (): void => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', settle);
      resolve();
    };
    timer = window.setTimeout(settle, ms);
    signal.addEventListener('abort', settle, { once: true });
  });
}

/**
 * How long one mounted preview keeps re-asking `/resources/:id/preview` while
 * the route answers `409 resource_processing`.
 *
 * Bounds: elapsed time from the first attempt, spent by the requests as much as
 *   by the waits between them. It is not a request timeout: it decides whether
 *   to ask *again*, and never cancels an attempt already in flight. A single
 *   read that never settles leaves the panel loading — which is what it did
 *   before this loop existed, and what every other read in `lib/api.ts` does,
 *   none of which carries a deadline. Bounding that is a different limit on a
 *   path this change does not touch.
 * Measured on `performance.now()`, not `Date.now()`: the sleeps between attempts
 *   are `setTimeout`, which a system clock adjustment does not move, so a budget
 *   read off the wall clock would be the one part of this loop an NTP step could
 *   shorten or stretch. Monotonic time is the same base the waits already keep.
 * Derived: `ATTACHMENT_PROCESSING_LEASE_MS` + `ATTACHMENT_CONVERTER_TIMEOUT_MS`
 *   — the server's own two numbers, read from `@rally/contracts` rather than
 *   copied, so raising either on the server does not silently leave this client
 *   giving up early. Their sum is the longest a `processing` answer can still be
 *   followed by a ready one: another request's claim running out its whole lease
 *   without publishing, then this client's next attempt taking the stale claim
 *   and spending a full converter timeout doing the conversion itself. Nothing
 *   here invents a number; both halves already existed.
 * Without it: every *named* processing path is self-terminating, so this is a
 *   guard on the unnamed one. A conversion that runs long records
 *   `conversion_timeout`, and a conversion that fails records its reason — both
 *   terminal and cached against the extractor version, so the next read is told
 *   no rather than asked to wait. A lost hash race or a lost claim resolves
 *   inside a lease. What none of that covers is a conversion killed without
 *   recording anything — an evicted isolate leaves the row claimed with nobody
 *   converting — and a panel left open would then re-ask for as long as the
 *   reader leaves the rail open: once a second while a claim looks live, four
 *   times a second on the paths that answer 250ms. The live-claim answer returns
 *   before the route reads R2, so a steady-state poll costs a D1 read rather
 *   than a source fetch; the R2 read and the Workers AI OCR pass belong to the
 *   attempt that wins the claim, which in this case is the one being killed.
 *   Only our own server can drive that, which is why the bound is generous
 *   rather than tight.
 * Wall clock rather than an attempt count, because the route answers 250ms for a
 *   lost race and 1s for a held claim, so the same count of attempts means
 *   anywhere from 100 seconds to 6½ minutes depending on which it hits. The
 *   thing worth bounding is how long a reader watches a spinner.
 * Trips: the retry stops and the panel shows "This preview is not available.",
 *   which is what it already shows for every terminal rejection. The metadata
 *   above it is unaffected.
 * Decided: the sum above is what the team chose on 2026-08-28, against 60
 *   seconds, the lease alone, and no ceiling at all. What they were pricing is
 *   the trip: an unchanging "Loading preview…" for up to five and a half
 *   minutes, in exchange for never ending a wait that could still have
 *   produced the document. The derivation is not a substitute for that
 *   decision — it was the arithmetic put to them, and the value is one edit if
 *   the trade reads differently later.
 */
export const MAX_RESOURCE_PREVIEW_WAIT_MS = ATTACHMENT_PROCESSING_LEASE_MS + ATTACHMENT_CONVERTER_TIMEOUT_MS;

/**
 * Reads a resource's preview, waiting out the route's own "still preparing"
 * answer instead of taking it for a verdict.
 *
 * Collapsing every rejection into the failed state — which is what a bare
 * `.catch` does — meant opening a citation to a freshly attached PDF or Word
 * file landed on "This preview is not available." and stayed there for the life
 * of that mount, seconds after the derivative was ready. The reader had to
 * close the rail and reopen it to discover the preview existed.
 *
 * The poll is not only how this learns the answer, it is what causes the work:
 * `ResourceService.preview` materializes the derivative inside the request, so
 * an attempt that wins the conversion claim is the one that converts. That is
 * why this waits rather than subscribing — there is no background writer to
 * subscribe to.
 *
 * `maxWaitMs` is a parameter rather than a read of the constant so a test can
 * prove the deadline against a budget it does not have to spend in real time.
 */
export async function readResourcePreviewText(
  loadResourceContent: ResourcePreviewLoader,
  resourceId: string,
  signal: AbortSignal,
  maxWaitMs: number,
): Promise<string> {
  const deadline = performance.now() + maxWaitMs;
  for (;;) {
    try {
      const blob = await loadResourceContent(resourceId, signal);
      return await blob.text();
    } catch (error) {
      const retryAfterMs = processingRetryDelayMs(error);
      // A wait that would end past the deadline is not started at all, so the
      // panel gives up on time rather than one whole delay late.
      if (retryAfterMs === null || signal.aborted || performance.now() + retryAfterMs > deadline) throw error;
      await wait(retryAfterMs, signal);
      if (signal.aborted) throw error;
    }
  }
}
