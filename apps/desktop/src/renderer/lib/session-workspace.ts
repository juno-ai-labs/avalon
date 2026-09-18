// `ClientSession` rather than `DesktopSession`: this builds the workspace's
// *presentation*, and every field it reads is on the session both the desktop
// and the lite browser carry. `DesktopSession extends ClientSession`, so the
// desktop still passes one; the narrower type is what lets a host-agnostic
// surface use the same placeholder.
import type { ClientSession } from '@rally/contracts/client-session';
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
 *   member, so a stale role can never grant anything.
 *
 * **Do not gate a control on the `role` this returns.** It says what the
 * session was issued with, and a role can now change while somebody is signed
 * in: an administrator can promote or demote them from Workspace settings. The
 * session's copy is replaced only by `bridge.refreshSession()`, a minute before
 * an access token expires, so this can be a whole token window out of date —
 * long enough that somebody promoted in order to connect a workspace account
 * went on being told they could not. Gates read the `['workspace']` query
 * through `use-workspace.ts`, which the `workspace_profile` sync topic
 * invalidates; this stays what the first paint is drawn from while that read is
 * in flight.
 */
export function workspaceFromSession(session: ClientSession | null): Workspace | null {
  const workspace = session?.workspace;
  // `user` is checked rather than assumed: this is reached from more than the
  // one caller that built the session now, and all-or-nothing has to mean a
  // `null` rather than a throw for a session that cannot describe the person.
  if (!session?.user || !workspace) return null;
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
      ...(workspace.accessClass ? { accessClass: workspace.accessClass } : {}),
    },
  };
}
