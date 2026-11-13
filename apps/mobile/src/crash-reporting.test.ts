import { expect, it, vi } from 'vitest';
import { CrashReporting } from './crash-reporting';
import type { MobileCommand } from './protocol';

const scope = { userId: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000002', route: 'global' as const };
const report = { scope, deleteAfter: Date.now() + 60_000, metadata: {
  uploadId: '018f22f2-4c22-7abc-8def-0123456789ab', installationId: '018f22f2-4c22-7abc-8def-0123456789ac',
  launchId: '018f22f2-4c22-7abc-8def-0123456789ad', route: 'global', release: '1', buildId: 'ios-1',
  platform: 'darwin', architecture: 'arm64', processRole: 'renderer', channel: 'stable', format: 'mobile-json',
}, payload: { kind: 'hermes', fatal: true, updateId: null, report: 'Error: private' } };
function fixture(pending: () => Promise<string[]> = async () => []) {
  const commands: MobileCommand[] = [];
  const store = { prepare: vi.fn(), configure: vi.fn(), pending, acknowledge: vi.fn() };
  return { commands, store, reporting: new CrashReporting(store, (command) => commands.push(command), vi.fn()) };
}
it('ignores an older approval arriving after the latest opt-out', async () => {
  const { reporting, store, commands } = fixture();
  reporting.verify(scope, 'first'); reporting.verify(scope, 'second');
  await reporting.receive({ type: 'crash-permission', scope, requestId: 'second', enabled: false });
  await reporting.receive({ type: 'crash-permission', scope, requestId: 'first', enabled: true });
  expect(store.configure.mock.calls).toEqual([[null]]);
  expect(commands.map((command) => command.type)).toEqual(['crash-status', 'crash-status']);
});
it('does not adopt approval after an account switch or disposal', async () => {
  const { reporting, store } = fixture();
  reporting.verify(scope, 'first');
  reporting.verify({ ...scope, userId: '00000000-0000-4000-8000-000000000003' }, 'second');
  await reporting.receive({ type: 'crash-permission', scope, requestId: 'first', enabled: true });
  reporting.dispose();
  await reporting.receive({ type: 'crash-permission', scope, requestId: 'second', enabled: true });
  expect(store.configure).not.toHaveBeenCalled();
});
it('drops malformed and expired reports without starving the next valid report', async () => {
  const invalid = { ...report, payload: { kind: 'hermes' } };
  const expired = { ...report, deleteAfter: 0 };
  const { reporting, store, commands } = fixture(async () => ['broken json', ...Array(5).fill(JSON.stringify(invalid)), JSON.stringify(expired), JSON.stringify(report)]);
  reporting.verify(scope, 'current');
  await reporting.receive({ type: 'crash-permission', scope, requestId: 'current', enabled: true });
  expect(commands.map((command) => command.type)).toEqual(['crash-status', 'crash-upload']);
  expect(store.acknowledge).toHaveBeenCalledTimes(6);
  await reporting.receive({ type: 'crash-uploaded', scope, uploadId: report.metadata.uploadId, ok: true });
  expect(store.acknowledge).toHaveBeenCalledTimes(7);
});
it('drops an asynchronous spool read when newer verification revokes approval', async () => {
  const spool = deferred<string[]>();
  const { reporting, commands } = fixture(() => spool.promise);
  reporting.verify(scope, 'first');
  const read = reporting.receive({ type: 'crash-permission', scope, requestId: 'first', enabled: true });
  reporting.verify(scope, 'second');
  await reporting.receive({ type: 'crash-permission', scope, requestId: 'second', enabled: false });
  spool.resolve([JSON.stringify(report)]); await read;
  expect(commands.map((command) => command.type)).toEqual(['crash-status', 'crash-status']);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('waits for the latest verification when an older enabled reply arrives first', async () => {
  const { reporting, store } = fixture();
  reporting.verify(scope, 'first'); reporting.verify(scope, 'second');
  await reporting.receive({ type: 'crash-permission', scope, requestId: 'first', enabled: true });
  expect(store.configure).not.toHaveBeenCalled();
  await reporting.receive({ type: 'crash-permission', scope, requestId: 'second', enabled: false });
  expect(store.configure.mock.calls).toEqual([[null]]);
});
