import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  it('lets a later class override an earlier one in the same group', () => {
    expect(cn('bg-surface-raised', 'bg-surface-sunken')).toBe('bg-surface-sunken');
    expect(cn('text-ink-muted', 'text-ink')).toBe('text-ink');
  });

  it('keeps classes that only look like they collide', () => {
    // A size and a colour, both spelled `text-*`. The stock configuration reads
    // the size as a colour and drops it; the extension in `cn.ts` is what makes
    // this pass, so breaking that extension fails here rather than in a screen.
    expect(cn('text-hint', 'text-ink-muted')).toBe('text-hint text-ink-muted');
    expect(cn('font-ui', 'font-strong')).toBe('font-ui font-strong');
    expect(cn('border-hairline', 'border-line')).toBe('border-hairline border-line');
  });

  it('resolves the scales against each other, not against colours', () => {
    expect(cn('text-title', 'text-hint')).toBe('text-hint');
    expect(cn('rounded-sm', 'rounded-lg')).toBe('rounded-lg');
    expect(cn('shadow-sm', 'shadow-focus')).toBe('shadow-focus');
  });

  it('drops falsy inputs so a conditional class reads as one', () => {
    const collapsed = false;
    expect(cn('p-pane', collapsed && 'hidden', undefined, 'gap-row')).toBe('p-pane gap-row');
  });
});
