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
    expect(pluginGroup(pluginId, pluginId)).toMatchObject({ key: 'rally', name: 'Rally', icon: 'rally' });
    // Still Rally the day the harness gives one of them a display name: these
    // are named in the map, not swept up by the unnamed-first-party fallback.
    expect(pluginGroup(pluginId, 'Memory')).toMatchObject({ key: 'rally', name: 'Rally', icon: 'rally' });
  });

  it.each(['rally:terminal', 'rally:workstream'])('folds %s into one Computer row', (pluginId) => {
    // Both carry a display name of their own — Terminal, Workstream — and are
    // grouped anyway: the map, not the naming, is what decides.
    expect(pluginGroup(pluginId, 'Terminal')).toEqual({
      key: 'computer',
      name: 'Computer',
      icon: 'computer',
      // The one group whose name is a common noun, so the one that takes an
      // article: "Used a computer", never "Used Computer".
      activeVerb: 'Using a computer',
      completedVerb: 'Used a computer',
    });
  });

  it('folds an unnamed first-party plugin nobody has decided about into Rally', () => {
    expect(pluginGroup('rally:ledger', 'rally:ledger')).toMatchObject(
      { key: 'rally', name: 'Rally', icon: 'rally' },
    );
    expect(pluginGroup('rally:ledger', undefined)).toMatchObject(
      { key: 'rally', name: 'Rally', icon: 'rally' },
    );
  });

  it('leaves a named first-party plugin its own row', () => {
    expect(pluginGroup('rally:web', 'Web')).toEqual(
      {
        key: 'name:Web',
        name: 'Web',
        icon: 'web',
        // A plugin Rally reached for reads as something Rally did with it.
        activeVerb: 'Using Web',
        completedVerb: 'Used Web',
      },
    );
  });

  it('pins multimodal generation to its canonical id regardless of display name', () => {
    expect(pluginGroup('rally:multimodal-generation', 'Multimodal generation')).toEqual(
      {
        key: 'name:Multimodal generation',
        name: 'Multimodal generation',
        icon: 'image-generation',
        activeVerb: 'Using Multimodal generation',
        completedVerb: 'Used Multimodal generation',
      },
    );
    expect(pluginGroup('rally:multimodal-generation', 'Image generation')).toMatchObject({
      key: 'name:Multimodal generation',
      icon: 'image-generation',
    });
    expect(pluginGroup('rally:multimodal-generation', undefined)).toMatchObject({
      key: 'name:Multimodal generation',
      icon: 'image-generation',
    });
  });

  it('pins the Sidekicks plugin to its canonical id regardless of display name', () => {
    expect(pluginGroup('rally:sidekicks', 'Automations')).toEqual(
      {
        key: 'name:Automations',
        name: 'Automations',
        icon: 'automations',
        activeVerb: 'Using Automations',
        completedVerb: 'Used Automations',
      },
    );
    // The plug is what the display-name fallback would reach for; the pin is
    // what keeps the row wearing the keyframes mark instead.
    expect(pluginGroup('rally:sidekicks', 'Scheduled work')).toMatchObject({
      key: 'name:Automations',
      icon: 'automations',
    });
    expect(pluginGroup('rally:sidekicks', undefined)).toMatchObject({
      key: 'name:Automations',
      icon: 'automations',
    });
    // A row a transcript stored before the rename still carries the old id,
    // and still draws the same glyph.
    expect(pluginGroup('rally:automations', 'Sidekicks')).toMatchObject({
      key: 'name:Automations',
      icon: 'automations',
    });
  });

  it('phrases Rally as the actor and every other plugin as something it used', () => {
    // Rally is the agent, so it works. A connector is a thing the agent picked
    // up, so it gets used — and only the common-noun group takes an article.
    expect(pluginGroup('rally:core', 'rally:core')).toMatchObject({
      activeVerb: 'Rally is working', completedVerb: 'Rally worked',
    });
    expect(pluginGroup('connection:one', 'Slack')).toMatchObject({
      activeVerb: 'Using Slack', completedVerb: 'Used Slack',
    });
    expect(pluginGroup('rally:terminal', 'Terminal')).toMatchObject({
      activeVerb: 'Using a computer', completedVerb: 'Used a computer',
    });
  });

  it('keeps a custom MCP named Slack separate from Slack and another same-named server', () => {
    const custom = pluginGroup('connection:custom', 'Slack', 'custom_mcp');
    expect(custom).toMatchObject({ key: 'custom_mcp:connection:custom', name: 'Slack', icon: 'model-context-protocol', activeVerb: 'Using Slack' });
    expect(custom?.key).not.toBe(pluginGroup('connection:slack', 'Slack', 'slack')?.key);
    expect(custom?.key).not.toBe(pluginGroup('connection:other', 'Slack', 'custom_mcp')?.key);
    expect(pluginGroup('connection:github', 'GitHub internal MCP', 'custom_mcp')?.icon).toBe('model-context-protocol');
  });

  it('keys a connector on its name so two connections to one service share a row', () => {
    // The canonical block says `connection:<uuid>` and the live pre-canonical
    // row says `plugin_slack`; a reader looking at either sees Slack.
    expect(pluginGroup('connection:aaaaaaaa-0000-4000-8000-000000000001', 'Slack'))
      .toEqual(pluginGroup('plugin_slack', 'Slack'));
    expect(pluginGroup('connection:aaaaaaaa-0000-4000-8000-000000000002', 'Slack'))
      .toMatchObject({ key: 'name:Slack', name: 'Slack', icon: 'slack' });
  });

  it.each([
    ['Apollo.io', 'apollo'],
    ['Canva', 'canva'],
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
    ['apollo', 'Apollo.io'],
    ['canva', 'Canva'],
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
    const shipped = ['Apollo.io', 'Ashby', 'Canva', 'Fireflies', 'GitHub', 'Google Workspace', 'Granola', 'Linear', 'Notion', 'Slack', 'X'];
    expect(shipped.filter((name) => pluginGroup('connection:one', name)?.icon === 'plug')).toEqual([]);
  });

  it('does not claim a later connector that merely starts with x', () => {
    expect(pluginGroup('connection:one', 'Xero')?.icon).toBe('plug');
    expect(pluginGroup('connection:one', 'Apollo GraphQL')?.icon).toBe('plug');
    expect(pluginGroup('connection:custom', 'Apollo.io', 'custom_mcp')?.icon).toBe('model-context-protocol');
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

  it('never names a row after a connection id it cannot resolve', () => {
    // A connector block whose plugin activity has not arrived — or never will —
    // carries an id and no name. "connection:9c1f… worked for 0ms" is worse than
    // the tool name this feed already declines to show, and it would key on the
    // id, so the activity landing later would open a second row beside it.
    expect(pluginGroup('connection:9c1f0000-0000-4000-8000-000000000001', undefined)).toBeNull();
    expect(pluginGroup('plugin_something_new', undefined)).toBeNull();
  });
});
