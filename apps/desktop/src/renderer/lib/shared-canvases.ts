import type { CanvasSidebarRow } from '@rally/contracts';
import { readDevicePreferences, setDeviceSharedCanvasesInAllOrganizations } from '@rally/ui/lib/device-preferences';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { desktopWorkspaceIdentityKey, type DesktopWorkspaceSummary } from '../../common/desktop';
import { useOptionalAppSession, WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY } from './app-session';
import { useOptionalCollaborationSession } from './collaboration-session';
import type { DesktopWorkspaceOnboardingState } from './platform';
import { useClientFeatureFlags } from './use-client-feature-flags';

/*
 * Canvases shared with this person in their other Organizations, shown in the
 * Canvas list of the one in front (`docs/canvases.md`, "Shared from another
 * Organization"). Each Organization is read the way its account-menu count is:
 * on the Mac with its own stored credential, in the browser through the
 * identity cookie. Nothing here holds a socket for a background Organization;
 * the read is redone when the window regains focus.
 */

/** A Canvas from another Organization, and the Organization it belongs to. */
export interface OtherOrganizationCanvas {
  row: CanvasSidebarRow;
  organization: Pick<DesktopWorkspaceSummary, 'id' | 'name' | 'region'>;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window of this app (the Mac's Settings window) changed it.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function enabledOnThisDevice(): boolean {
  try { return readDevicePreferences().sharedCanvasesInAllOrganizations !== false; } catch { return true; }
}

/** Settings → Account → Preferences' switch: on unless this device turned it off. */
export function useSharedCanvasesInAllOrganizations(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, enabledOnThisDevice, () => true);
  const set = useCallback((next: boolean) => {
    setDeviceSharedCanvasesInAllOrganizations(next);
    for (const listener of listeners) listener();
  }, []);
  return [enabled, set];
}

export const OTHER_ORGANIZATION_CANVASES_QUERY_KEY = ['other-organization-canvases'] as const;

/**
 * The Canvases someone else shared with this person in every Organization but
 * the one in front, most recently active first. Empty while the setting is off,
 * on a support session, with one Organization, and before the reads answer; an
 * Organization whose read fails is left out, and the rest still show.
 */
export function useOtherOrganizationCanvases(): OtherOrganizationCanvas[] {
  const app = useOptionalAppSession();
  const collaboration = useOptionalCollaborationSession();
  const [enabled] = useSharedCanvasesInAllOrganizations();
  const api = collaboration?.api ?? null;
  const session = collaboration?.session ?? null;
  const active = session?.workspace ?? null;
  const multipleWorkspaces = useClientFeatureFlags(api).data?.multipleWorkspacesEnabled === true;
  const wanted = enabled && multipleWorkspaces && app !== null && active !== null && !session?.impersonator;
  // The account menu's directory read, shared by its key.
  const directory = useQuery<DesktopWorkspaceOnboardingState>({
    queryKey: WORKSPACE_ACCOUNT_DIRECTORY_QUERY_KEY,
    queryFn: () => app!.getOnboardingState(),
    enabled: wanted,
  });
  // Only an Organization this device holds a credential for can answer; the
  // browser's identity cookie stands in for one for every row.
  const others = (directory.data?.workspaces ?? []).filter((candidate) => candidate.credentialStored === true
    && (candidate.id !== active?.id || candidate.region !== active?.region));
  const keys = others.map((candidate) => desktopWorkspaceIdentityKey(candidate.region, candidate.id));
  const read = useQuery<OtherOrganizationCanvas[]>({
    queryKey: [...OTHER_ORGANIZATION_CANVASES_QUERY_KEY, ...keys],
    queryFn: async () => {
      const settled = await Promise.allSettled(others.map((organization) =>
        app!.getWorkspaceSharedCanvases({ region: organization.region, workspaceId: organization.id })));
      return settled.flatMap((result, index) => {
        if (result.status !== 'fulfilled') return [];
        const { id, name, region } = others[index]!;
        return result.value.map((row) => ({ row, organization: { id, name, region } }));
      });
    },
    enabled: wanted && others.length > 0,
    placeholderData: (previous) => previous,
    retry: false,
  });
  const { refetch } = read;
  useEffect(() => {
    if (!wanted) return undefined;
    const refresh = (): void => { void refetch(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refetch, wanted]);
  return useMemo(() => wanted && others.length > 0
    ? [...(read.data ?? [])].sort((a, b) => b.row.updatedAt.localeCompare(a.row.updatedAt))
    : [], [wanted, others.length, read.data]);
}
