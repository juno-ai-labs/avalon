import type { RallyRegion } from '../common/desktop';

export interface WorkspaceSelectionTarget {
  region: RallyRegion;
  workspaceId: string;
}

interface WorkspaceBoundSession {
  workspace: { id: string; region: RallyRegion } | null;
}

export interface ActiveWorkspaceClaimDependencies<Session extends WorkspaceBoundSession> {
  activeSession: Session | null;
  /** Mint the next selection intent. Claiming makes this link the newest
   * selection, so a network activation still in flight keeps its credential
   * when it lands but no longer takes over the window. */
  nextSelectionIntent(): number;
}

/**
 * Claim the active workspace for a link that names it, without a request.
 *
 * A link carries routing, not authority: the regional API re-checks membership
 * on every request the workspace credential makes, so a link to the workspace
 * already in front of the person gains nothing from the platform round trip
 * that minted a fresh credential for it. What the round trip did provide was
 * ordering — it took a selection intent — and that is kept here.
 *
 * Resolves `null` when the target is not the active workspace, so the caller
 * goes to platform activation, which is the only path that revalidates
 * membership for a workspace the person is switching into.
 */
export function claimActiveWorkspace<Session extends WorkspaceBoundSession>(
  target: WorkspaceSelectionTarget,
  dependencies: ActiveWorkspaceClaimDependencies<Session>,
): Session | null {
  const active = dependencies.activeSession;
  if (
    !active?.workspace
    || active.workspace.id !== target.workspaceId
    || active.workspace.region !== target.region
  ) return null;
  dependencies.nextSelectionIntent();
  return active;
}
