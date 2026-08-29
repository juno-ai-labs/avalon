import { describe, expect, it } from 'vitest';
import { pluginGroup } from './plugin-groups';

describe('pluginGroup', () => {
  it.each([
    'rally:core',
    'rally:discovery',
    'rally:memory',
    'rally:tables',
    'rally.skills',
  ])('folds %s into one Rally row', (pluginId) => {
    expect(pluginGroup(pluginId, pluginId)).toEqual({ key: 'rally', name: 'Rally', icon: 'rally' });
    // Still Rally the day the harness gives one of them a display name: these
    // are named in the map, not swept up by the unnamed-first-party fallback.
    expect(pluginGroup(pluginId, 'Memory')).toEqual({ key: 'rally', name: 'Rally', icon: 'rally' });
  });

  it.each(['rally:terminal', 'rally:workstream'])('folds %s into one Computer row', (pluginId) => {
    // Both carry a display name of their own — Terminal, Workstream — and are
    // grouped anyway: the map, not the naming, is what decides.
    expect(pluginGroup(pluginId, 'Terminal')).toEqual({
      key: 'computer', name: 'Computer', icon: 'computer',
    });
  });

  it('folds an unnamed first-party plugin nobody has decided about into Rally', () => {
    expect(pluginGroup('rally:ledger', 'rally:ledger')).toEqual(
      { key: 'rally', name: 'Rally', icon: 'rally' },
    );
    expect(pluginGroup('rally:ledger', undefined)).toEqual(
      { key: 'rally', name: 'Rally', icon: 'rally' },
    );
  });

  it('leaves a named first-party plugin its own row', () => {
    expect(pluginGroup('rally:web', 'Web')).toEqual(
      { key: 'name:Web', name: 'Web', icon: 'world-search' },
    );
  });

  it('keys a connector on its name so two connections to one service share a row', () => {
    // The canonical block says `connection:<uuid>` and the live pre-canonical
    // row says `plugin_slack`; a reader looking at either sees Slack.
    expect(pluginGroup('connection:aaaaaaaa-0000-4000-8000-000000000001', 'Slack'))
      .toEqual(pluginGroup('plugin_slack', 'Slack'));
    expect(pluginGroup('connection:aaaaaaaa-0000-4000-8000-000000000002', 'Slack'))
      .toEqual({ key: 'name:Slack', name: 'Slack', icon: 'brand-slack' });
  });

  it.each([
    ['GitHub', 'brand-github'],
    ['Google Mail + Calendar', 'brand-google'],
    ['Google Drive + Docs + Sheets', 'brand-google-drive'],
    ['Linear', 'linear'],
    ['Notion', 'brand-notion'],
    ['Generic webhook', 'webhook'],
    // Adapters with no brand glyph in the icon set share the generic plug,
    // exactly as the backend's own mapping does.
    ['Granola', 'plug'],
    ['X', 'plug'],
  ])('draws %s with the %s mark', (displayName, icon) => {
    expect(pluginGroup('connection:one', displayName)?.icon).toBe(icon);
  });

  it('declines to group a tool whose owner the transcript has not named yet', () => {
    // A planned tool block learns its plugin only when the call starts.
    expect(pluginGroup(undefined, undefined)).toBeNull();
  });
});
