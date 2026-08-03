import { describe, expect, it } from 'vitest';
import { normalizeLegacyStoredSession } from './stored-session';

describe('legacy encrypted desktop sessions', () => {
  it('adds Pacific user and Global workspace defaults', () => {
    expect(normalizeLegacyStoredSession({
      user: { id: 'user-1' },
      workspace: { id: 'workspace-1', region: 'global' },
    })).toMatchObject({
      user: { timezone: 'America/Los_Angeles' },
      workspace: { timezone: 'America/Los_Angeles' },
    });
  });

  it('adds the London default to an EU workspace without replacing stored values', () => {
    expect(normalizeLegacyStoredSession({
      user: { timezone: 'Asia/Tokyo' },
      workspace: { region: 'eu' },
    })).toMatchObject({
      user: { timezone: 'Asia/Tokyo' },
      workspace: { timezone: 'Europe/London' },
    });
  });
});
