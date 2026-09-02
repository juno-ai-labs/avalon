import type { RallyRegion } from '../common/desktop';
import {
  selectStoredWorkspace,
  storedWorkspaceCredential,
  type StoredAuth,
  type StoredAuthSet,
} from './stored-auth';

export interface WorkspaceSelectionTarget {
  region: RallyRegion;
  workspaceId: string;
}

export interface WorkspaceSelectionDependencies<Session, Result> {
  loadAuthSet(): Promise<StoredAuthSet | null>;
  /** The cached session for one stored credential, or null when its profile
   * cache is missing and only a network activation can rebuild it. */
  sessionForCredential(credential: StoredAuth): Promise<Session | null>;
  /** Persist the selection and hand the renderer its session. Runs under the
   * caller's session mutation lock. */
  commit(auth: StoredAuthSet, session: Session): Promise<Result>;
}

/**
 * Make an already-stored workspace the active one without a network request.
 *
 * A stored credential selects a workspace; it never authorizes a read. The
 * regional API re-checks membership on every request that credential makes,
 * and a revoked one is surrendered on its first rejection exactly as it would
 * be after a network activation. What this skips is the platform round trip
 * that minted a fresh credential for a workspace the device already holds one
 * for.
 *
 * Resolves `null` when nothing is stored for the target — no credential, or a
 * credential whose profile cache is gone — so the caller falls back to platform
 * activation, which is the only path that can create what is missing.
 */
export async function selectStoredWorkspaceLocally<Session, Result>(
  target: WorkspaceSelectionTarget,
  dependencies: WorkspaceSelectionDependencies<Session, Result>,
): Promise<Result | null> {
  const auth = await dependencies.loadAuthSet();
  if (!auth) return null;
  const credential = storedWorkspaceCredential(auth, target.workspaceId, target.region);
  if (!credential) return null;
  const session = await dependencies.sessionForCredential(credential);
  if (!session) return null;
  return dependencies.commit(selectStoredWorkspace(auth, target.workspaceId, target.region), session);
}
