import { MobileCrashReportSchema, type MobileCrashScope } from '@rally/contracts/crash-reports';
import { z } from 'zod';
import type { MobileCommand, MobileEvent } from './protocol';

type CrashStore = {
  prepare(scope: MobileCrashScope): void;
  configure(scope: MobileCrashScope | null): void;
  pending(scope: MobileCrashScope): Promise<string[]>;
  acknowledge(uploadId: string): void;
};
function sameScope(a: MobileCrashScope | null, b: MobileCrashScope | null): boolean {
  return a !== null && b !== null && a.userId === b.userId && a.workspaceId === b.workspaceId && a.route === b.route;
}

/** Correlates approval and upload replies to the current authenticated verification. */
export class CrashReporting {
  private scope: MobileCrashScope | null = null;
  private requestId: string | null = null;
  private approved: MobileCrashScope | null = null;
  private readonly pending = new Set<string>();
  constructor(private readonly store: CrashStore, private readonly send: (command: MobileCommand) => void,
    private readonly failure: () => void) {}

  verify(scope: MobileCrashScope | null, requestId: string): void {
    this.requestId = requestId; this.approved = null; this.pending.clear();
    this.scope = scope;
    try {
      if (scope) this.store.prepare(scope);
      else this.store.configure(null);
    } catch { this.failure(); return; }
    if (scope) this.send({ type: 'crash-status', requestId });
  }
  dispose(): void {
    // Unmount invalidates replies, but does not renew or revoke saved approval.
    this.requestId = null; this.scope = null; this.approved = null; this.pending.clear();
  }
  clear(): void {
    this.dispose();
    try { this.store.configure(null); } catch { this.failure(); }
  }
  async receive(event: MobileEvent): Promise<void> {
    if (event.type === 'signed-out') { this.clear(); return; }
    if (event.type === 'crash-permission') {
      if (event.requestId !== this.requestId || !sameScope(event.scope, this.scope)) return;
      // Consume the verification, so duplicate replies cannot reverse opt-out.
      this.requestId = null;
      if (!event.enabled) { this.clear(); return; }
      const scope = event.scope;
      this.approved = scope;
      try {
        this.store.configure(scope);
        const reports = await this.store.pending(scope);
        if (this.approved !== scope) return;
        let sent = 0;
        for (const encoded of reports) {
          let value: unknown;
          try { value = JSON.parse(encoded); } catch { this.failure(); continue; }
          const parsed = MobileCrashReportSchema.safeParse(value);
          if (!parsed.success) {
            // Native filenames are the captured upload ID; discard malformed
            // envelopes when that ID remains readable, without exporting data.
            const identity = z.object({ metadata: z.object({ uploadId: z.string().uuid() }) }).safeParse(value);
            if (identity.success) this.store.acknowledge(identity.data.metadata.uploadId);
            this.failure(); continue;
          }
          const report = parsed.data;
          if (!sameScope(report.scope, scope) || report.deleteAfter <= Date.now()) {
            this.store.acknowledge(report.metadata.uploadId); continue;
          }
          if (this.pending.has(report.metadata.uploadId)) continue;
          this.pending.add(report.metadata.uploadId);
          this.send({ type: 'crash-upload', report });
          // Same five-report pass as the desktop regional uploader.
          if (++sent === 5) break;
        }
      } catch { this.failure(); }
    }
    if (event.type === 'crash-uploaded' && this.approved && sameScope(event.scope, this.approved)
      && this.pending.delete(event.uploadId)) {
      if (event.ok) {
        try { this.store.acknowledge(event.uploadId); } catch { this.failure(); }
      } else this.failure();
    }
  }
}
