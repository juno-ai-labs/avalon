import { attentionItems, type BreakoutLists } from '../common/attention-items';
import { compareRecentChannels } from '../common/recency-groups';
import type { ChannelDirectorySnapshot } from './channel-directory-watch';
import type { MenuBarContent, MenuBarWorkstream } from './menu-bar-menu';

/** Shown for a Channel Rally has not finished naming. The renderer draws a
 * skeleton in that state; a menu row cannot, and the placeholder title on the
 * wire is not written to be read. */
const UNNAMED_WORKSTREAM_LABEL = 'Untitled channel';

/**
 * The menu's content, derived from the Channel directory the main process
 * holds over its own workspace socket.
 *
 * Both sections are the sidebar's lists computed the sidebar's way, from the
 * same rows:
 *
 * - **Needs attention** is `attentionItems`, the function behind the sidebar's
 *   attention button. Breakout lists are read only for a Channel whose row
 *   counts a Breakout needing the reader, exactly as `useAttentionItems` reads
 *   them, so a Breakout the sidebar would not list is not counted here either.
 * - **Most recent** is every listed Channel in the sidebar's Recent order,
 *   unfiltered by Space and ignoring pins, which belong to one Space. A Channel
 *   listed to the reader only through a Breakout (`mainWithheld`) opens that
 *   Breakout, as its sidebar row does, since Main is not theirs to open; one
 *   whose Breakout list has not arrived is left out rather than opening Main.
 */
export function menuBarContentFromDirectory(directory: ChannelDirectorySnapshot): MenuBarContent {
  const breakouts: Record<string, BreakoutLists[string]> = {};
  for (const channel of directory.channels) {
    if ((channel.breakoutAttentionCount ?? 0) > 0) breakouts[channel.id] = directory.breakouts[channel.id];
  }
  const named = directory.channels.map((channel) => (
    channel.titleStatus === 'naming' || channel.title.trim().length === 0
      ? { ...channel, title: UNNAMED_WORKSTREAM_LABEL }
      : channel
  ));
  return {
    accessRequests: directory.accessRequests.map((request) => ({
      id: request.id, requesterName: request.requesterName, title: request.title,
    })),
    attention: attentionItems(named, breakouts).map((item) => ({
      key: item.key,
      workstreamId: item.workstreamId,
      substreamId: item.substreamId,
      title: item.title,
      channelTitle: item.channelTitle,
      reason: item.reason,
    })),
    attentionComplete: directory.complete,
    recents: named
      .filter((channel) => !channel.archivedAt && !channel.systemKind)
      .sort(compareRecentChannels)
      .flatMap((channel): MenuBarWorkstream[] => {
        if (channel.mainWithheld !== true) return [{ id: channel.id, title: channel.title, substreamId: null }];
        const entry = directory.breakouts[channel.id]?.[0];
        return entry ? [{ id: channel.id, title: channel.title, substreamId: entry.substreamId }] : [];
      }),
  };
}
