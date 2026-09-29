import { describe, expect, it } from 'vitest';
import { parseDesktopSettingsSection } from '../common/settings';

describe('desktop settings sections', () => {

  it.each([undefined, null, '', 'general', 'Organization', 'workspace/people', 1, {}])(
    'rejects an invalid section without coercion: %j',
    (value) => {
      expect(parseDesktopSettingsSection(value)).toBeNull();
    },
  );
});
