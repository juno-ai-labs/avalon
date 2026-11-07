import { describe, expect, it } from 'vitest';
import { workstreamRunLimits } from '../src/services/workstream-run-policy';

describe('import run lifetime policy', () => {
  it('leaves an open lifetime inert, including resumed runs and serialized scope', () => {
    expect(workstreamRunLimits(Number.POSITIVE_INFINITY, 500)).toEqual({ maxIterations: 1000 });
    expect(JSON.parse(JSON.stringify(workstreamRunLimits(Number.POSITIVE_INFINITY)))).toEqual({ maxIterations: 1000 });
  });
  it('subtracts already elapsed run time from a finite lifetime without renewing it on resume', () => {
    expect(workstreamRunLimits(500, 200)).toEqual({ maxIterations: 1000, maxWallClockMs: 300 });
    expect(workstreamRunLimits(500, 700)).toEqual({ maxIterations: 1000, maxWallClockMs: 0 });
  });
});
