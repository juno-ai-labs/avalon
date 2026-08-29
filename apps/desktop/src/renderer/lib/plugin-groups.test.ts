import { describe, expect, it } from 'vitest';
import { pluginGroup, pluginGroupIconForContract } from './plugin-groups';
import { connectorBrandMark } from './plugin-marks';

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
      { key: 'name:Web', name: 'Web', icon: 'web' },
    );
  });

  it('keys a connector on its name so two connections to one service share a row', () => {
    // The canonical block says `connection:<uuid>` and the live pre-canonical
    // row says `plugin_slack`; a reader looking at either sees Slack.
    expect(pluginGroup('connection:aaaaaaaa-0000-4000-8000-000000000001', 'Slack'))
      .toEqual(pluginGroup('plugin_slack', 'Slack'));
    expect(pluginGroup('connection:aaaaaaaa-0000-4000-8000-000000000002', 'Slack'))
      .toEqual({ key: 'name:Slack', name: 'Slack', icon: 'slack' });
  });

  it.each([
    ['GitHub', 'github'],
    ['Google Mail + Calendar', 'google'],
    ['Google Drive + Docs + Sheets', 'google-drive'],
    ['Linear', 'linear'],
    ['Notion', 'notion'],
    ['Slack', 'slack'],
    ['Granola', 'granola'],
    ['X', 'x'],
    ['Generic webhook', 'webhook'],
  ])('draws %s with its own mark', (displayName, icon) => {
    expect(pluginGroup('connection:one', displayName)?.icon).toBe(icon);
  });

  it.each([
    ['github', 'GitHub'],
    ['google', 'Google Mail + Calendar'],
    ['google', 'Google Drive + Docs + Sheets'],
    ['granola', 'Granola'],
    ['linear', 'Linear'],
    ['notion', 'Notion'],
    ['slack', 'Slack'],
    ['x', 'X'],
  ])('draws %s the same whether it is known by type or by name', (connectorType, displayName) => {
    // Settings reaches a mark from the connector type it holds; a transcript row
    // has only the name. They are two routes into one table, and this is what
    // stops one surface calling a company something the other does not.
    expect(pluginGroup('connection:one', displayName)?.icon)
      .toBe(connectorBrandMark(connectorType, displayName));
  });

  it('gives every connector Rally has an adapter for a mark of its own', () => {
    // The plug is the fallback for a connector this list has not learned about,
    // and every shipped adapter is on the list. A new one that reaches the feed
    // still drawing a plug means this mapping was not updated with it.
    const shipped = ['GitHub', 'Google Workspace', 'Granola', 'Linear', 'Notion', 'Slack', 'X'];
    expect(shipped.filter((name) => pluginGroup('connection:one', name)?.icon === 'plug')).toEqual([]);
  });

  it('does not claim a later connector that merely starts with x', () => {
    expect(pluginGroup('connection:one', 'Xero')?.icon).toBe('plug');
  });

  it('keeps the backend icon names working for the rows that still carry them', () => {
    expect(pluginGroupIconForContract('brand-google-drive')).toBe('google-drive');
    expect(pluginGroupIconForContract('world-search')).toBe('web');
    expect(pluginGroupIconForContract('plug')).toBe('plug');
  });

  it('declines to group a tool whose owner the transcript has not named yet', () => {
    // A planned tool block learns its plugin only when the call starts.
    expect(pluginGroup(undefined, undefined)).toBeNull();
  });
});
