import { describe, expect, it } from 'vitest';

import { spaceChoices } from './space-choices';

describe('spaceChoices', () => {
  it('puts General first as All and the rest A–Z', () => {
    expect(spaceChoices([
      { id: 'b', name: 'Launch', systemRole: null },
      { id: 'c', name: 'Accounts', systemRole: null },
      { id: 'a', name: 'General', systemRole: 'general' },
    ]).map((space) => space.name)).toEqual(['All', 'Accounts', 'Launch']);
  });
});
