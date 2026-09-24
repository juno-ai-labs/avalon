import type { CitationContext } from '../components/markdown-citations';
import type { WorkstreamResource } from './types';

/**
 * The right-click actions on a breakout's generated artifacts.
 *
 * "Attach to channel" links the artifact into the Channel's main conversation.
 * The breakout keeps its own link and each link grants its own readers, so
 * everyone in either room can open it. Only artifacts get the action: a source
 * the breakout was given came from somewhere a person can attach it from
 * already. One the Channel already holds keeps the item, disabled, so the menu
 * says why nothing would happen.
 */
export function breakoutResourceActions({ attach, breakoutResources, channelResources }: {
  attach: (resource: WorkstreamResource) => void;
  breakoutResources: readonly WorkstreamResource[];
  channelResources: readonly WorkstreamResource[];
}): NonNullable<CitationContext['actions']> {
  const artifacts = new Map(breakoutResources
    .filter((resource) => resource.direction === 'artifact')
    .map((resource) => [resource.id, resource]));
  const inChannel = new Set(channelResources.map((resource) => resource.id));
  return (resourceId) => {
    const resource = artifacts.get(resourceId);
    if (!resource) return undefined;
    return [{
      id: 'attach-to-channel',
      label: 'Attach to channel',
      disabled: inChannel.has(resource.id),
      onSelect: () => attach(resource),
    }];
  };
}
