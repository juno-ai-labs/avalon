import { describe, expect, it } from 'vitest';
import { desktopSettingsSections, parseDesktopSettingsSection } from '../common/settings';

describe('desktop settings sections', () => {
  it('accepts every supported section exactly', () => {
    for (const section of desktopSettingsSections) {
      expect(parseDesktopSettingsSection(section)).toBe(section);
    }
  });

  it.each([undefined, null, '', 'general', 'Organization', 'workspace/people', 1, {}])(
    'rejects an invalid section without coercion: %j',
    (value) => {
      expect(parseDesktopSettingsSection(value)).toBeNull();
    },
  );
});
