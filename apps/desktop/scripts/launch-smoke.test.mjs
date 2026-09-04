import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopIsolatedProcesses } from './launch-smoke.mjs';

test('escalates an isolated process that ignores SIGTERM and then stops', async () => {
  const signals = [];
  const live = new Set([42]);
  await stopIsolatedProcesses(() => live, (pid, signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') live.delete(pid);
  }, async () => {});
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('reports permission failures rather than retrying forever', async () => {
  await assert.rejects(stopIsolatedProcesses(() => new Set([42]), () => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  }, async () => {}), /permission denied/);
});

test('reports survivors instead of hanging packaging indefinitely', async () => {
  await assert.rejects(stopIsolatedProcesses(() => new Set([42]), () => {}, async () => {}), /did not exit: 42/);
});
