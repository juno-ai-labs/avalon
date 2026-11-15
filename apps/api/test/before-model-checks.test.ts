import { HarnessLimitError, HarnessPortStepError } from '@rally/agent-harness';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api-error';
import { runBeforeModelChecks } from '../src/services/integrations';

const passes = async () => undefined;

describe('the checks a run passes before each model call', () => {
  it('names the usage allowance read when it fails, and runs nothing after it', async () => {
    const cause = new ApiError(500, 'billing_plan_invalid', 'Organization plan is invalid');
    const renewLease = vi.fn(passes);
    const runAuthority = vi.fn(passes);

    const failure = await runBeforeModelChecks({
      usageAllowance: async () => { throw cause; },
      renewLease,
      runAuthority,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessPortStepError);
    expect(failure).toMatchObject({ label: 'Usage allowance read failed', causeValue: cause });
    expect(renewLease).not.toHaveBeenCalled();
    expect(runAuthority).not.toHaveBeenCalled();
  });

  it('names the run authority check when it fails', async () => {
    const cause = new ApiError(403, 'workspace_member_not_found', 'Not a member');

    const failure = await runBeforeModelChecks({
      usageAllowance: passes,
      renewLease: passes,
      runAuthority: async () => { throw cause; },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessPortStepError);
    expect(failure).toMatchObject({ label: 'Run authority check failed', causeValue: cause });
  });

  it('lets a used-up allowance through under its own limit code', async () => {
    const failure = await runBeforeModelChecks({
      usageAllowance: async () => {
        throw new HarnessLimitError('usage_allowance_exhausted', "The organization's included weekly usage is used up");
      },
      renewLease: passes,
      runAuthority: passes,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessLimitError);
    expect(failure).toMatchObject({ code: 'usage_allowance_exhausted' });
  });

  it('leaves a lease failure unnamed, so it keeps the port label "Run liveness renewal failed"', async () => {
    const cause = new Error('attempt_lease_lost');

    const failure = await runBeforeModelChecks({
      usageAllowance: passes,
      renewLease: async () => { throw cause; },
      runAuthority: passes,
    }).catch((error: unknown) => error);

    expect(failure).toBe(cause);
  });

  it('resolves when every check passes', async () => {
    await expect(runBeforeModelChecks({ usageAllowance: passes, renewLease: passes, runAuthority: passes }))
      .resolves.toBeUndefined();
  });
});
