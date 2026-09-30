import { describe, expect, it } from 'vitest';
import { parseDesktopSettingsSection } from '../common/settings';

describe('desktop settings sections', () => {
  it('accepts a supported section unchanged', () => {
    expect(parseDesktopSettingsSection('notifications')).toBe('notifications');
    expect(parseDesktopSettingsSection('custom-mcp')).toBe('custom-mcp');
  });

  it.each([undefined, null, '', 'general', 'Organization', 'workspace/people', 1, {}])(
    'rejects an invalid section without coercion: %j',
    (value) => {
      expect(parseDesktopSettingsSection(value)).toBeNull();
    },
  );
});
