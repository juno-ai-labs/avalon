const LAST_WORKSPACE = 'rally-mobile:last-workspace';
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function mobileStorage(): StoragePort | null {
  try { return window.localStorage; } catch { return null; }
}
type Workspace = { id: string; region: string };

/** A device preference only. The authenticated directory remains the authority. */
export function rememberMobileWorkspace(storage: StoragePort | null, userId: string, workspace: Workspace): void {
  try { storage?.setItem(LAST_WORKSPACE, JSON.stringify({ userId, ...workspace })); } catch { /* Storage is optional. */ }
}
export function forgetMobileWorkspace(storage: StoragePort | null): void {
  try { storage?.removeItem(LAST_WORKSPACE); } catch { /* Storage is optional. */ }
}
export function restoreMobileWorkspace(storage: StoragePort | null, userId: string, workspaces: readonly Workspace[]): Workspace | null {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(LAST_WORKSPACE) ?? 'null');
    if (!saved || typeof saved !== 'object' || !('userId' in saved) || saved.userId !== userId || !('id' in saved) || !('region' in saved)) return null;
    return workspaces.find((workspace) => workspace.id === saved.id && workspace.region === saved.region) ?? null;
  } catch { return null; }
}

/** A stale empty result must not send View canvas straight back into chat. */
export function canvasNeedsConversation(state: { active: boolean; loaded: boolean; fetching: boolean; failed: boolean; artifactCount: number }): boolean {
  return state.active && state.loaded && !state.fetching && !state.failed && state.artifactCount === 0;
}
