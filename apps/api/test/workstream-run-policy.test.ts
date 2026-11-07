import { describe, expect, it } from 'vitest';
import { workstreamRunLimits } from '../src/services/workstream-run-policy';

describe('run limits', () => {
  it('bounds model iterations and sets no wall clock, including in serialized scope', () => {
    expect(workstreamRunLimits()).toEqual({ maxIterations: 1000 });
    expect(JSON.parse(JSON.stringify(workstreamRunLimits()))).toEqual({ maxIterations: 1000 });
  });
});
