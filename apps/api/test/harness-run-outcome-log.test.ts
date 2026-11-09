import { asHarnessRunId, asWorkspaceId } from '@rally/contracts';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { logHarnessRunOutcome } from '../src/services/integrations';
import { createTestEnv } from './helpers/cloudflare-test';

const env = createTestEnv({ LOG_LEVEL: 'debug', AVALON_REGION: 'global' });
const input = { harnessRunId: asHarnessRunId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4'), workspaceId: asWorkspaceId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2'), parentId: 'parent-1' };

const logged = (spy: MockInstance<(...data: unknown[]) => void>) => spy.mock.calls.map((call) => call[0] as Record<string, unknown>);

describe('a harness run that did not complete, in the log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a run that asked and waits as waiting, never as failed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logHarnessRunOutcome(env, input, { status: 'needs_input' }, false);
    expect(logged(warn)).toEqual([]);
    expect(logged(info)).toMatchObject([{ level: 'info', event: 'workstream_harness_run_waiting',
      request_id: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4', workspace_id: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2', workstream_id: 'parent-1' }]);
  });

  it('keeps a failed run at warn with its failure code, kind and message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logHarnessRunOutcome(env, input, { status: 'failed', failure: { code: 'provider_unavailable', kind: 'provider', message: 'upstream 503' } }, false);
    expect(logged(warn)).toMatchObject([{ event: 'workstream_harness_run_failed', outcome_status: 'failed',
      failure_code: 'provider_unavailable', failure_kind: 'provider', failure_message: 'upstream 503' }]);
  });

  it('logs nothing for a completed run or a stop the person asked for', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logHarnessRunOutcome(env, input, { status: 'completed' }, false);
    logHarnessRunOutcome(env, input, { status: 'stopped' }, true);
    expect([...logged(warn), ...logged(info)]).toEqual([]);
  });
});
