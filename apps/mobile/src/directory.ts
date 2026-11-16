import type { MobileSnapshot } from './protocol';

/** What the native shell shows from Home's directory. Home posts a snapshot on
 * every canvas change, including `updatedAt` ticks while agents write and its
 * own navigation; neither changes a native screen, and a new directory object
 * re-renders every tab. Two snapshots with the same key are the same directory.
 * A new snapshot field the shell shows must be added here, or its changes are dropped. */
export function directoryKey(snapshot: MobileSnapshot | null): string {
  if (!snapshot) return '';
  const { userId, userName, workspaceId, workspaceName, workspacePath, pins, hasMore, loading, pinBusy, pinError, directoryError, inlineChat } = snapshot;
  // With Canvases from elsewhere, the dashboard sorts everything by date, so
  // this Organization's dates move cards too; without them they do not.
  const merged = snapshot.sharedElsewhere.length > 0;
  const canvases = snapshot.canvases.map(({ id, title, icon, color, updatedAt, facts }) => ({ id, title, icon, color, facts, ...(merged ? { updatedAt } : {}) }));
  // Their date places them among this Organization's Canvases, so it is shown.
  const sharedElsewhere = snapshot.sharedElsewhere.map(({ id, title, icon, color, updatedAt, organization }) => ({ id, title, icon, color, updatedAt, organization }));
  return JSON.stringify({ userId, userName, workspaceId, workspaceName, workspacePath, canvases, sharedElsewhere, pins, hasMore, loading, pinBusy, pinError, directoryError, inlineChat });
}
