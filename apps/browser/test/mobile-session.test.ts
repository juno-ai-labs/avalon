import { describe, expect, it } from 'vitest';
import { canvasNeedsConversation, forgetMobileWorkspace, mobileTurnTarget, rememberMobileWorkspace, restoreMobileWorkspace } from '../src/mobile-session';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const first = { id: 'organization-a', region: 'global' };
const second = { id: 'organization-b', region: 'global' };

it('turns a validated message link into an embedded conversation scroll request', () => {
  const turn = '00000000-0000-7000-8000-000000000001';
  expect(mobileTurnTarget(`?turn=${turn}&sequence=12`)).toEqual({ turnId: turn, nonce: 12 });
  for (const search of [`?turn=${turn}`, `?turn=${turn}&sequence=0`, `?turn=${turn}&sequence=1.5`, '?turn=invalid&sequence=12']) {
    expect(mobileTurnTarget(search)).toBeNull();
  }
});

describe('mobile organization preference', () => {
  it('restores only an organization still in this authenticated user’s directory', () => {
    const saved = storage();
    rememberMobileWorkspace(saved, 'alice', first);
    expect(restoreMobileWorkspace(saved, 'alice', [first, second])).toEqual(first);
    expect(restoreMobileWorkspace(saved, 'bob', [first])).toBeNull();
    expect(restoreMobileWorkspace(saved, 'alice', [second])).toBeNull();
    expect(restoreMobileWorkspace(saved, 'alice', [{ ...first, region: 'another-region' }])).toBeNull();
  });
  it('replaces the preference when switching and removes it on sign-out', () => {
    const saved = storage();
    rememberMobileWorkspace(saved, 'alice', first);
    rememberMobileWorkspace(saved, 'alice', second);
    expect(restoreMobileWorkspace(saved, 'alice', [first, second])).toEqual(second);
    forgetMobileWorkspace(saved);
    expect(restoreMobileWorkspace(saved, 'alice', [first, second])).toBeNull();
  });
  it('does not prevent entry when device storage is unavailable or corrupt', () => {
    expect(restoreMobileWorkspace(null, 'alice', [first])).toBeNull();
    expect(restoreMobileWorkspace({ ...storage(), getItem: () => 'not json' }, 'alice', [first])).toBeNull();
    expect(() => rememberMobileWorkspace(null, 'alice', first)).not.toThrow();
  });
});

describe('artifact-first navigation', () => {
  const empty = { active: true, loaded: true, fetching: false, failed: false, artifactCount: 0 };
  it('opens chat only after a successful empty resource read', () => {
    expect(canvasNeedsConversation(empty)).toBe(true);
    expect(canvasNeedsConversation({ ...empty, artifactCount: 1 })).toBe(false);
    expect(canvasNeedsConversation({ ...empty, failed: true })).toBe(false);
    expect(canvasNeedsConversation({ ...empty, loaded: false })).toBe(false);
  });
  it('waits for refreshed resources when returning from chat and ignores hidden canvases', () => {
    expect(canvasNeedsConversation({ ...empty, fetching: true })).toBe(false);
    expect(canvasNeedsConversation({ ...empty, active: false })).toBe(false);
  });
});
