import type { ActivityItem } from '@rally/contracts';
import { compareRecentChannels } from '../common/recency-groups';
import type { ActivityFeedSnapshot } from './activity-feed-watch';
import type { ChannelDirectorySnapshot } from './channel-directory-watch';
import type { MenuBarAttentionRow, MenuBarContent, MenuBarWorkstream } from './menu-bar-menu';

/** Shown for a Channel Rally has not finished naming. The renderer draws a
 * skeleton in that state; a menu row cannot, and the placeholder title on the
 * wire is not written to be read. */
const UNNAMED_WORKSTREAM_LABEL = 'Untitled thread';

/**
 * What happened, as the row's detail line. The Activity tab writes it as
 * "*actor* *verb* *title*"; a menu row leads with the title, so the actor and
 * verb move under it. A start carries no name (the tab resolves it from the
 * member directory, which the main process does not hold), so it reads as
 * what it is rather than as "Someone".
 */
function activityDetail(item: ActivityItem): string {
  const actor = item.actorLabel.trim();
  switch (item.kind) {
    case 'mentioned': return actor ? `${actor} mentioned you` : 'Mentioned you';
    case 'added': return actor ? `${actor} added you` : 'Added you';
    case 'thread_started': return actor ? `${actor} started it` : 'New thread';
    case 'breakout_started': return actor ? `${actor} started it` : 'New breakout';
    case 'run_finished': return actor ? `${actor} finished` : 'Finished';
    case 'merged': return item.breakout
      ? `${actor || 'Someone'} merged ${item.breakout.title} into it`
      : item.mergedInto?.threadPrivate
        ? `${actor || 'Someone'} merged a private thread into it`
        : `${actor || 'Someone'} merged it into ${item.mergedInto?.name ?? 'a channel'}`;
    case 'artifact_updated': return `${actor || 'Someone'} updated it`;
  }
}

/** One unread Activity row as a menu row, opening where the tab's row opens. */
function attentionRow(item: ActivityItem): MenuBarAttentionRow {
  const detail = activityDetail(item);
  // An artifact's row leads with the artifact, and names its thread below.
  const title = item.kind === 'artifact_updated' ? item.artifact?.title ?? item.threadTitle
    : item.kind === 'merged' ? (item.mergedInto?.threadPrivate ? item.mergedInto.name : item.threadTitle)
      : item.breakout?.title ?? item.threadTitle;
  return {
    key: item.id,
    workstreamId: item.threadId,
    // A breakout's merge is about the thread it landed in.
    substreamId: item.kind === 'merged' ? null : item.breakout?.substreamId ?? null,
    title: title.trim().length > 0 ? title : UNNAMED_WORKSTREAM_LABEL,
    // A thread's merge opens where it landed, as the Activity tab's row does.
    ...(item.kind === 'merged' && item.mergedInto ? { channelId: item.mergedInto.channelId } : {}),
    detail: item.kind === 'artifact_updated' || (item.breakout && item.kind !== 'merged') ? `${detail} in ${item.threadTitle}` : detail,
  };
}

/**
 * The menu's content, from the two lists the main process holds:
 *
 * - **Needs attention** is the Activity tab's unread rows, in its order
 *   (newest first), under the access requests the tab also lists first. It
 *   is the tab's list rather than the Threads tab's attention list, so the
 *   menu and the tab never disagree about what is new: a row stays until
 *   Mark all read, as the tab's dot does.
 * - **Most recent** is every listed Channel in the sidebar's Recent order,
 *   unfiltered by Space and ignoring pins, which belong to one Space. A Channel
 *   listed to the reader only through a Breakout (`mainWithheld`) opens that
 *   Breakout, as its sidebar row does, since Main is not theirs to open; one
 *   whose Breakout list has not arrived is left out rather than opening Main.
 */
export function menuBarContent(directory: ChannelDirectorySnapshot, activity: ActivityFeedSnapshot): MenuBarContent {
  const named = directory.channels.map((channel) => (
    channel.titleStatus === 'naming' || channel.title.trim().length === 0
      ? { ...channel, title: UNNAMED_WORKSTREAM_LABEL }
      : channel
  ));
  return {
    accessRequests: directory.accessRequests.map((request) => ({
      id: request.id, requesterName: request.requesterName, title: request.title,
    })),
    attention: activity.items.filter((item) => item.unread).map(attentionRow),
    attentionComplete: activity.complete,
    recentsComplete: directory.complete,
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
