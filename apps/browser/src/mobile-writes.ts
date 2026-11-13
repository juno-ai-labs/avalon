import type { MobileCrashReport } from '@rally/contracts/crash-reports';
import type { MobileEvent } from '../../mobile/src/protocol';

/** A mounted account owns both queued work and network-recovery retries. */
export class MobileWrites {
  private readonly controller = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  close(): void { this.controller.abort(); }
  enqueue(write: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const { signal } = this.controller;
    this.tail = this.tail.catch(() => undefined).then(async () => {
      if (!signal.aborted) await write(signal);
    });
    return this.tail;
  }
}

export async function uploadMobileReport(
  report: MobileCrashReport,
  signal: AbortSignal,
  upload: (report: MobileCrashReport, signal: AbortSignal) => Promise<void>,
  post: (event: MobileEvent) => void,
): Promise<void> {
  let ok = true;
  try {
    // The report may have expired while waiting behind another write.
    if (report.deleteAfter > Date.now()) await upload(report, signal);
  } catch (error) {
    // Permanent malformed/conflicting/oversized reports cannot improve on retry.
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
    ok = status === 400 || status === 409 || status === 413 || status === 422;
  }
  if (!signal.aborted) post({ type: 'crash-uploaded', scope: report.scope, uploadId: report.metadata.uploadId, ok });
}
