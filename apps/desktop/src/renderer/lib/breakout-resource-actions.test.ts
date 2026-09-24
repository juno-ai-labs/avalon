import { describe, expect, it, vi } from 'vitest';
import { breakoutResourceActions } from './breakout-resource-actions';
import type { WorkstreamResource } from './types';

const site: WorkstreamResource = {
  id: 'market-map',
  title: 'Market map',
  resourceType: 'generated_site',
  provider: 'rally_generated',
  refreshSupported: false,
  watchEnabled: false,
  watchStatus: 'unsupported',
  contentAvailable: true,
  currentVersion: 1,
  relationshipType: 'generated',
  direction: 'artifact',
};
const source: WorkstreamResource = { ...site, id: 'brief', relationshipType: 'attachment', direction: 'source' };

describe('breakoutResourceActions', () => {
  it('attaches a breakout artifact to the channel', () => {
    const attach = vi.fn();
    const actions = breakoutResourceActions({ attach, breakoutResources: [site], channelResources: [] })('market-map');
    expect(actions).toEqual([expect.objectContaining({ label: 'Attach to channel', disabled: false })]);
    actions![0]!.onSelect();
    expect(attach).toHaveBeenCalledWith(site);
  });

  it('disables the action once the channel holds the artifact', () => {
    const actions = breakoutResourceActions({ attach: vi.fn(), breakoutResources: [site], channelResources: [site] });
    expect(actions('market-map')?.[0]?.disabled).toBe(true);
  });

  it('disables every item while an attach is in flight', () => {
    const actions = breakoutResourceActions({ attach: vi.fn(), breakoutResources: [site], channelResources: [], pending: true });
    expect(actions('market-map')?.[0]?.disabled).toBe(true);
  });

  it('offers nothing for a source or a resource the breakout does not hold', () => {
    const actions = breakoutResourceActions({ attach: vi.fn(), breakoutResources: [source], channelResources: [] });
    expect(actions('brief')).toBeUndefined();
    expect(actions('market-map')).toBeUndefined();
  });
});
