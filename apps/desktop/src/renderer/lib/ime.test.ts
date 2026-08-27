import { describe, expect, it } from 'vitest';
import { isComposingKeyEvent } from './ime';

describe('isComposingKeyEvent', () => {
  it('takes the standard composition flag, whatever key carries it', () => {
    expect(isComposingKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isComposingKeyEvent({ isComposing: true, keyCode: 27 })).toBe(true);
  });

  it('takes the legacy composition keycode where the flag is unset or false', () => {
    expect(isComposingKeyEvent({ keyCode: 229 })).toBe(true);
    expect(isComposingKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it('leaves an ordinary keystroke alone', () => {
    expect(isComposingKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isComposingKeyEvent({ keyCode: 27 })).toBe(false);
    expect(isComposingKeyEvent({})).toBe(false);
  });
});
