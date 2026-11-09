import { describe, expect, it } from 'vitest';

import { isApplePlatform, primaryShortcutLabel } from './shortcut-label';

describe('the primary shortcut label', () => {
  it('spells Command on Apple platforms and Control elsewhere', () => {
    expect(primaryShortcutLabel({ apple: '↵', other: 'Enter' }, 'MacIntel')).toBe('⌘↵');
    expect(primaryShortcutLabel({ apple: '↵', other: 'Enter' }, 'Linux x86_64')).toBe('Ctrl+Enter');
    expect(primaryShortcutLabel({ apple: '↵', other: 'Enter' }, 'Win32')).toBe('Ctrl+Enter');
    expect(isApplePlatform('iPad')).toBe(true);
  });
});
