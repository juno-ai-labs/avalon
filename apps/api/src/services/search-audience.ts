import type { ConversationParentKind } from '@rally/contracts/conversation-parent';
import { sha256Hex } from '../lib/crypto';
import { isDraftUpload, requiresAttachment, type ResourceReadRow } from './resource-read-rules';

/**
 * The groups a search row admits, named by where the row lives rather than by
 * who may read it. A person's access changes move only that person's own list
 * of groups; a row's groups change only when the row moves (a resource is
 * attached or detached). See
 * docs/PRDs/2026-09-26_search-audience-filtering/design.md.
 *
 * An empty audience admits nobody. Organization-wide readability is the
 * explicit `members` group, never an absent list.
 */
export type SearchAudience = string[];

export const searchAudienceGroup = {
  user: (userId: string) => `user:${userId}`,
  /** Every active member whose access class is `member`; never a guest. */
  members: (workspaceId: string) => `members:${workspaceId}`,
  /** A Channel's or Space's conversation: Main is substream `0`, a Breakout its own. */
  conversation: (parentId: string, substreamId: string) => `conversation:${parentId}/${substreamId}`,
  /** Every conversation of a Sidekick shares one reader set. */
  sidekick: (automationId: string) => `sidekick:${automationId}`,
  connection: (connectionId: string) => `connection:${connectionId}`,
  /** Everyone who reads a Channel, for the resources a merge shared with it. */
  space: (spaceId: string) => `space:${spaceId}`,
} as const;

/** The group a conversation's turns and captured links carry. */
export function conversationSearchAudience(conversation: {
  parentKind: ConversationParentKind; parentId: string; substreamId: string;
}): SearchAudience {
  return [conversation.parentKind === 'automation'
    ? searchAudienceGroup.sidekick(conversation.parentId)
    : searchAudienceGroup.conversation(conversation.parentId, conversation.substreamId)];
}

/**
 * The groups a resource's rows carry. Mirrors the canonical resource check:
 * a connector resource is its connection's; a draft upload is its uploader's;
 * otherwise the uploader, every member where the provider allows it, every
 * conversation the canonical inventory places it in, and every Channel a merge
 * shared it with.
 */
export function resourceSearchAudience(workspaceId: string, row: ResourceReadRow,
  locations: readonly { parentId: string; substreamId: string; parentKind: string }[]): SearchAudience {
  if (row.connection_id) return [searchAudienceGroup.connection(row.connection_id)];
  const groups = new Set<string>();
  // The uploader reads without an attachment unless the provider needs one even for its owner.
  if (row.uploaded_by_user_id && !requiresAttachment(row, true)) groups.add(searchAudienceGroup.user(row.uploaded_by_user_id));
  if (isDraftUpload(row)) return [...groups];
  if (!requiresAttachment(row, false)) groups.add(searchAudienceGroup.members(workspaceId));
  for (const location of locations) {
    groups.add(location.parentKind === 'automation' ? searchAudienceGroup.sidekick(location.parentId)
      : location.parentKind === 'space' ? searchAudienceGroup.space(location.parentId)
        : searchAudienceGroup.conversation(location.parentId, location.substreamId));
  }
  return [...groups];
}

/**
 * The UUID a group is stored and queried as. Turbopuffer's permissions guide
 * recommends uuid over string for permission arrays
 * (https://turbopuffer.com/docs/permissions, read 2026-09-26). The first 128
 * bits of a namespaced SHA-256, marked as an RFC 9562 version 8 (custom) UUID.
 * The only place a group name becomes an ID.
 */
export function searchAudienceGroupId(group: string): Promise<string> {
  let id = groupIds.get(group);
  if (!id) {
    id = computeGroupId(group);
    groupIds.set(group, id);
  }
  return id;
}

/**
 * Every search derives the searcher's whole list, so each isolate keeps the
 * ids it has computed. The mapping never changes, so nothing here goes stale;
 * it holds one entry per group this isolate has seen.
 */
const groupIds = new Map<string, Promise<string>>();

async function computeGroupId(group: string): Promise<string> {
  const hex = (await sha256Hex(`rally-search-audience:v1:${group}`)).slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function searchAudienceGroupIds(audience: readonly string[]): Promise<string[]> {
  return Promise.all([...new Set(audience)].map(searchAudienceGroupId));
}
