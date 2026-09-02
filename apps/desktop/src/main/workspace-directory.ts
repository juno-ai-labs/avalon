import type { DesktopWorkspaceSummary } from '../common/desktop';
import { desktopWorkspaceIdentityKey } from '../common/desktop';
import {
  storedWorkspaceCredential,
  workspaceReferenceKey,
  type StoredAuthSet,
  type StoredProfileSet,
  type StoredWorkspaceReference,
} from './stored-auth';

/**
 * The workspace rows the account menu lists, assembled from two sources that
 * fail independently.
 *
 * Global discovery is the account's complete membership across both regions,
 * and it is only reachable with the identity credential. The stored set is
 * what this device has already opened: one regional credential and cached
 * profile per workspace, readable with no network at all. A menu that listed
 * only discovery lost every other workspace the moment the identity credential
 * was unusable; a menu that listed only the stored set could never show an
 * invitation or a workspace joined from another machine. So the list is the
 * union, with discovery's fields winning where both know a workspace.
 */

function summaryKey(workspace: Pick<DesktopWorkspaceSummary, 'id' | 'region'>): string {
  return desktopWorkspaceIdentityKey(workspace.region, workspace.id);
}

function recencyRank(recency: StoredWorkspaceReference[]): Map<string, number> {
  return new Map(recency.map((reference, index) => [workspaceReferenceKey(reference), index]));
}

function sortByRecency<T extends Pick<DesktopWorkspaceSummary, 'id' | 'region'>>(
  rows: T[],
  recency: StoredWorkspaceReference[],
): T[] {
  const rank = recencyRank(recency);
  // A stable sort, so rows this device has never selected keep the order they
  // arrived in — discovery's, then the stored set's — behind the recent ones.
  return [...rows].sort((left, right) => (
    (rank.get(summaryKey(left)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(summaryKey(right)) ?? Number.MAX_SAFE_INTEGER)
  ));
}

/** Every workspace this device holds both a credential and a profile for. */
export function storedWorkspaceSummaries(
  auth: StoredAuthSet | null,
  profiles: StoredProfileSet | null,
): DesktopWorkspaceSummary[] {
  if (!auth || !profiles) return [];
  const rows = profiles.workspaces.flatMap((profile): DesktopWorkspaceSummary[] => {
    const workspace = profile.workspace;
    if (!workspace || !storedWorkspaceCredential(auth, workspace.id, workspace.region)) return [];
    return [{
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      region: workspace.region,
      role: workspace.role,
      createdAt: workspace.createdAt,
      credentialStored: true,
    }];
  });
  return sortByRecency(rows, auth.workspaceRecency);
}

/**
 * Discovery's rows, then whatever this device has stored that discovery did
 * not list, ordered by device recency with never-selected rows after.
 *
 * `discovered` may be the answer just received or the last one this run
 * received; either way a row known to both takes discovery's name and role
 * and the stored set's word that a credential is on this device.
 */
export function mergeWorkspaceDirectory(
  discovered: DesktopWorkspaceSummary[],
  stored: DesktopWorkspaceSummary[],
  recency: StoredWorkspaceReference[],
): DesktopWorkspaceSummary[] {
  const byKey = new Map<string, DesktopWorkspaceSummary>();
  for (const workspace of discovered) {
    byKey.set(summaryKey(workspace), { ...workspace, credentialStored: false });
  }
  for (const workspace of stored) {
    const key = summaryKey(workspace);
    const known = byKey.get(key);
    byKey.set(key, known ? { ...known, credentialStored: true } : { ...workspace, credentialStored: true });
  }
  return sortByRecency([...byKey.values()], recency);
}

/**
 * Stored workspaces whose membership a complete discovery says has ended.
 *
 * Discovery fails closed — a regional outage is a 503, never a shorter list —
 * so a stored workspace absent from a successful answer is one this account
 * can no longer open: removed by an owner, left from another device, or
 * abandoned. Two are never returned: the active workspace, whose revocation
 * the socket path owns and which the renderer must not lose from underneath
 * itself, and anything written after the discovery request began, because a
 * workspace created or activated while the request was in flight is exactly
 * what an answer started earlier would fail to list.
 */
export function endedStoredWorkspaces(
  auth: StoredAuthSet,
  profiles: StoredProfileSet,
  discovered: Pick<DesktopWorkspaceSummary, 'id' | 'region'>[],
  discoveredAt: string,
): StoredWorkspaceReference[] {
  const listed = new Set(discovered.map(summaryKey));
  return auth.workspaces.flatMap((credential): StoredWorkspaceReference[] => {
    const workspaceId = credential.binding.workspaceId;
    if (workspaceId === null) return [];
    const reference = { workspaceId, region: credential.binding.region };
    const key = workspaceReferenceKey(reference);
    if (listed.has(key)) return [];
    if (auth.activeWorkspace && workspaceReferenceKey(auth.activeWorkspace) === key) return [];
    const profile = profiles.workspaces.find((candidate) => (
      candidate.workspace?.id === workspaceId && candidate.workspace.region === credential.binding.region
    ));
    if (!profile || profile.cachedAt >= discoveredAt) return [];
    return [reference];
  });
}
