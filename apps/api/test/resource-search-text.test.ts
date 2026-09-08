import { describe, expect, it } from 'vitest';
import { resourceSearchRevision } from '../src/services/resource-search-text';
import { diagnosticErrorCode } from '../src/observability/logger';

describe('resource search snapshot revision', () => {
  it('preserves the canonical integer revision', () => {
    expect(resourceSearchRevision(42)).toBe(42);
  });
  it.each([undefined, null, '42', 1.5, NaN, Infinity, {}])('diagnoses invalid revision %s without source data', (value) => {
    let failure: unknown;
    try { resourceSearchRevision(value); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(diagnosticErrorCode(failure, 'search_unavailable')).toBe('search_resource_revision_invalid');
  });
});
