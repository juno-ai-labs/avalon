import { expect, it, vi } from 'vitest';
import type { MobileCrashReport } from '@rally/contracts/crash-reports';
import { MobileWrites, uploadMobileReport } from '../src/mobile-writes';

it('cancels active transport retries and abandoned account writes', async () => {
  const writes = new MobileWrites();
  const first = deferred<void>();
  let active: AbortSignal | null = null;
  const run = writes.enqueue(async (signal) => { active = signal; await first.promise; });
  await Promise.resolve(); await Promise.resolve();
  const next = vi.fn(async () => undefined);
  const queued = writes.enqueue(next);
  writes.close(); first.resolve(); await run; await queued;
  expect((active as AbortSignal | null)?.aborted).toBe(true);
  expect(next).not.toHaveBeenCalled();
});
const report: MobileCrashReport = {
  scope: { userId: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000002', route: 'global' },
  deleteAfter: 0,
  metadata: { uploadId: '018f22f2-4c22-7abc-8def-0123456789ab', installationId: '018f22f2-4c22-7abc-8def-0123456789ac', launchId: '018f22f2-4c22-7abc-8def-0123456789ad', route: 'global', release: '1', buildId: 'ios-1', platform: 'darwin', architecture: 'arm64', processRole: 'renderer', channel: 'stable', format: 'mobile-json' },
  payload: { kind: 'hermes', report: 'Error', fatal: true, updateId: null },
};
it('acknowledges a queued report that expired without uploading it', async () => {
  const writes = new MobileWrites();
  const first = deferred<void>();
  void writes.enqueue(() => first.promise);
  const upload = vi.fn(async () => undefined), post = vi.fn();
  const current = { ...report, deleteAfter: Date.now() + 60_000 };
  const queued = writes.enqueue((signal) => uploadMobileReport(current, signal, upload, post));
  current.deleteAfter = 0;
  first.resolve(); await queued;
  expect(upload).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith({ type: 'crash-uploaded', scope: report.scope, uploadId: report.metadata.uploadId, ok: true });
});
it.each([[400, true], [413, true], [401, false], [429, false], [500, false]])('classifies upload HTTP %s for spool retention', async (status, ok) => {
  const post = vi.fn();
  await uploadMobileReport({ ...report, deleteAfter: Date.now() + 60_000 }, new AbortController().signal,
    async () => { throw { status }; }, post);
  expect(post).toHaveBeenCalledWith({ type: 'crash-uploaded', scope: report.scope, uploadId: report.metadata.uploadId, ok });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
