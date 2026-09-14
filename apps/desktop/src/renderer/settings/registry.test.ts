import { describe, expect, it } from 'vitest';
import { desktopSettingsSections } from '../../common/settings';
import { collectSettings, coreSettingsProvider, defineSetting, searchSettings, settings, type SettingsSearchContext } from './registry';

const context: SettingsSearchContext = {
  sections: new Set(desktopSettingsSections),
  admin: true, developer: true, menuBar: true, login: true,
};
describe('settings registry', () => {
  it('makes a new definition searchable without a keyword list', () => {
    const setting = defineSetting({ id: 'new', section: 'application', kind: 'select',
      label: 'Rendering quality', description: 'Choose display fidelity.', options: ['Balanced', 'Detailed'] });
    const entries = collectSettings([{ id: 'extension', entries: [{ key: setting.id, definition: setting }] }], context);
    for (const query of ['rendering', 'fidelity', 'DETAILED', '  rendering detailed  ']) {
      expect(searchSettings(entries, query).map((entry) => entry.key)).toEqual(['new']);
    }
  });
  it('finds every core definition by its displayed label before any screen mounts', () => {
    const entries = collectSettings([coreSettingsProvider], context);
    for (const setting of Object.values(settings)) {
      expect(searchSettings(entries, setting.label).some((entry) => entry.definition.id === setting.id)).toBe(true);
    }
  });
  it('uses availability without making disabled controls undiscoverable', () => {
    const entries = collectSettings([coreSettingsProvider], {
      ...context, admin: false, developer: false, menuBar: false, login: false,
      sections: new Set(['account', 'workspace', 'application']),
    });
    expect(entries.some((entry) => entry.definition.id === 'lockdown')).toBe(true);
    for (const id of ['debug', 'telemetry', 'menuBar', 'login', 'invitations', 'inviteEmail', 'digestDays']) {
      expect(entries.some((entry) => entry.definition.id === id)).toBe(false);
    }
  });
  it('ranks labels before descriptions and shares selectable option labels', () => {
    const entries = collectSettings([coreSettingsProvider], context);
    expect(searchSettings(entries, 'appearance')[0]?.definition.id).toBe('appearance');
    expect(searchSettings(entries, 'weekends').some((entry) => entry.definition.id === 'digestDays')).toBe(true);
    expect(searchSettings(entries, 'dark').some((entry) => entry.definition.id === 'appearance')).toBe(true);
    expect(searchSettings(entries, 'time zone').some((entry) => entry.definition.id === 'personalTimezone')).toBe(true);
    expect(searchSettings(entries, '')).toEqual([]);
  });
  it('keeps provider instances distinct and ignores replayed metadata', () => {
    const entries = ['first', 'second'].map((instanceId) => ({
      key: 'github:' + instanceId, definition: settings.githubAccess, instanceId, instanceLabel: instanceId,
    }));
    expect(searchSettings(collectSettings([{ id: 'github', entries }], context), 'second')[0]?.instanceId).toBe('second');
    expect(collectSettings([{ id: 'replay', entries: [entries[0]!, entries[0]!] }], context)).toEqual([entries[0]]);
  });
  it('preserves legacy vocabulary and English casing independent of host locale', () => {
    const entries = collectSettings([coreSettingsProvider], context);
    for (const query of ['startup', 'keychain', 'integrations', 'organization', 'roles', 'notifications', 'diagnostics', 'summary', 'security', 'privacy', 'developer', 'status item', 'meetings', "Mac's keystore", 'invitations']) {
      expect(searchSettings(entries, query).length, query).toBeGreaterThan(0);
    }
    expect(new Set(coreSettingsProvider.entries.map((entry) => entry.key)).size).toBe(coreSettingsProvider.entries.length);
  });
  it('ranks competing labels before metadata and non-actions before tied actions', () => {
    const entries = collectSettings([coreSettingsProvider], context);
    expect(searchSettings(entries, 'email')[0]?.definition.id).toBe('digestEmail');
    expect(searchSettings(entries, 'digest')[0]?.definition.id).toBe('digestEnabled');
    const withoutInstalledMcp = collectSettings([coreSettingsProvider], { ...context, sections: new Set(['connections']) });
    expect(searchSettings(withoutInstalledMcp, 'Tools Rally may use')[0]?.definition.entryPoint).toBe('provider:custom-mcp');
  });
});
