import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { clickBurstCounter, KONAMI_CODE, keySequenceMatcher, useKeySequence } from './easter-eggs';

function typeKeys(matches: (key: string) => boolean, keys: readonly string[]): boolean[] {
  return keys.map((key) => matches(key));
}

describe('keySequenceMatcher', () => {
  it('answers true on the key that completes the Konami code, and only that one', () => {
    const answers = typeKeys(keySequenceMatcher(KONAMI_CODE), KONAMI_CODE);
    expect(answers).toEqual([false, false, false, false, false, false, false, false, false, true]);
  });

  it('still matches after a stray key before the code', () => {
    const matches = keySequenceMatcher(KONAMI_CODE);
    expect(typeKeys(matches, ['ArrowUp', ...KONAMI_CODE]).at(-1)).toBe(true);
  });

  it('takes a shifted B and A', () => {
    const matches = keySequenceMatcher(KONAMI_CODE);
    expect(typeKeys(matches, [...KONAMI_CODE.slice(0, 8), 'B', 'A']).at(-1)).toBe(true);
  });

  it('starts over after a match, rather than matching on the next key', () => {
    const matches = keySequenceMatcher(['a', 'a']);
    expect(typeKeys(matches, ['a', 'a', 'a', 'a'])).toEqual([false, true, false, true]);
  });
});

describe('clickBurstCounter', () => {
  it('fires on the seventh click within three seconds', () => {
    const click = clickBurstCounter(7, 3_000);
    expect([0, 100, 200, 300, 400, 500, 600].map(click)).toEqual([false, false, false, false, false, false, true]);
  });

  it('does not fire when the clicks are spread out', () => {
    const click = clickBurstCounter(7, 3_000);
    expect([0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000].map(click).some(Boolean)).toBe(false);
  });
});

describe('useKeySequence', () => {
  it('fires for keys typed on the page', () => {
    const onMatch = vi.fn();
    renderHook(() => useKeySequence(KONAMI_CODE, onMatch));
    for (const key of KONAMI_CODE) fireEvent.keyDown(document.body, { key });
    expect(onMatch).toHaveBeenCalledOnce();
  });

  it('ignores the same keys typed into a text field', () => {
    const onMatch = vi.fn();
    renderHook(() => useKeySequence(KONAMI_CODE, onMatch));
    const field = document.body.appendChild(document.createElement('textarea'));
    for (const key of KONAMI_CODE) fireEvent.keyDown(field, { key });
    field.remove();
    expect(onMatch).not.toHaveBeenCalled();
  });
});
