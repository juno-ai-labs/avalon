import type { DesktopSession } from '../../common/desktop';
import type { Workspace } from './types';

/**
 * The workspace a signed-in session already describes, without asking the API.
 *
 * `GET /workspace` returns the five fields `Workspace` carries — id, name,
 * region, timezone and the current member — and the desktop session main hands
 * this renderer over IPC already holds every one of them: `stored-session.ts`
 * requires `timezone` on both the user and the workspace, and the workspace's
 * `role` is what `getWorkspace` stamps onto `currentUser` anyway. So the read
 * that every surface used to wait on was re-fetching what the process was
 * started with.
 *
 * This exists to be a *placeholder*, not a cache: it is what a surface renders
 * while `GET /workspace` is in flight, and the answer replaces it. Two things
 * follow from that and are the reason this is a function rather than a shortcut
 * taken at each call site:
 *
 * - **All or nothing.** A field missing from the session makes this return
 *   `null` rather than guessing a default, and the surface then waits for the
 *   read exactly as it did before. A placeholder is a claim that the value is
 *   already known; half of one is a claim that is false.
 * - **The server stays authoritative.** `role` in particular is a presentation
 *   input here (it decides which admin controls are *drawn*), never an
 *   authorization one — every one of those controls is refused by the API for a
 *   member, so a role the session has not caught up on costs a redraw and
 *   nothing else.
 */
export function workspaceFromSession(session: DesktopSession | null): Workspace | null {
  const workspace = session?.workspace;
  if (!session || !workspace) return null;
  const { timezone: workspaceTimezone } = workspace;
  const { timezone: userTimezone } = session.user;
  if (!workspaceTimezone || !userTimezone) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    region: workspace.region,
    timezone: workspaceTimezone,
    currentUser: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      ...(session.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {}),
      timezone: userTimezone,
      role: workspace.role,
    },
  };
}
