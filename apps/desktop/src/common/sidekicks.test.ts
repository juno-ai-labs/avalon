import { describe, expect, it } from 'vitest';
import { NEW_SIDEKICK_TARGET, parseSidekicksWindowTarget } from './sidekicks';

describe('parseSidekicksWindowTarget', () => {
  it('takes a Sidekick id and the composer, and nothing else', () => {
    const sidekickId = '0191c0de-0000-7000-8000-00000000beef';
    expect(parseSidekicksWindowTarget(sidekickId)).toBe(sidekickId);
    expect(parseSidekicksWindowTarget(NEW_SIDEKICK_TARGET)).toBe('new');
    // The reason this parser exists rather than a looser id check: a target
    // becomes the window's route, so anything that is neither has to be refused
    // before it reaches the hash.
    for (const rejected of ['', 'newer', '../settings', 'new/../settings', 'not-a-uuid', 42, null, {}]) {
      expect(parseSidekicksWindowTarget(rejected)).toBeNull();
    }
    // Control characters and a trailing fragment, which would otherwise ride
    // into the window's hash on the end of an otherwise valid id.
    for (const rejected of [`${sidekickId}\n`, `${sidekickId}/../settings`, 'new\u0000']) {
      expect(parseSidekicksWindowTarget(rejected)).toBeNull();
    }
  });
});
