import { describe, expect, it } from 'vitest';
import { initialDirectoryLookup } from '../src/client/main';

describe('Ace condition editor', () => {
  it('initializes a loaded directory condition from its stored opaque ID', () => {
    expect(initialDirectoryLookup({ value: 'workspace-loaded-id' })).toBe('workspace-loaded-id');
    expect(initialDirectoryLookup({})).toBe('');
  });
});
