import type { ConnectedMcpApp, ConnectedMcpApps } from '@rally/contracts/mcp-oauth';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, type RallyApi } from '../lib/api';
import { formatRelative } from '../lib/format';
import { SettingLabel } from '../settings/setting-label';
import { settings } from '../settings/registry';
import { Button, ErrorNotice, LoadingState } from './primitives';

/** The two calls the section makes. */
export type ConnectedAppsApi = Pick<RallyApi, 'getConnectedApps' | 'disconnectConnectedApp'>;

export function connectedAppsQueryKey(workspaceId: string) {
  return ['workspace', workspaceId, 'connected-apps'] as const;
}

const connectedDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * Where an app sends a person back after they approve it: the hosts of its
 * hosted redirects, and for a loopback redirect, the computer the app was
 * connected from (which need not be the one reading this).
 */
export function connectedAppDestination(app: Pick<ConnectedMcpApp, 'redirectOrigins' | 'loopback'>): string {
  const places = app.redirectOrigins.map((origin) => new URL(origin).host);
  if (app.loopback) places.push('the computer it was connected from');
  return `Returns to ${places.join(', ')}`;
}

/**
 * **Connected apps** under Settings › Account (`docs/rally-mcp.md`): the MCP
 * apps (Claude, ChatGPT, OpenCode and others) this person let act for them,
 * across their Organizations in this region, and **Disconnect**, which ends
 * that app's session at once. Like **Revoke access** beside it, Disconnect
 * asks nothing first: the app can be connected again from the app itself.
 *
 * The name is the one the app registered itself under, and nothing verifies
 * it, so the row says so and shows where the app returns to beside it.
 */
export function ConnectedAppsSetting({ api, workspaceId }: { api: ConnectedAppsApi; workspaceId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const key = connectedAppsQueryKey(workspaceId);
  const apps = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.getConnectedApps(signal),
    // What another device connected or disconnected shows on every open.
    refetchOnMount: 'always',
    staleTime: 0,
  });
  const disconnect = useMutation({
    mutationFn: async (id: string) => {
      try {
        await api.disconnectConnectedApp(id);
      } catch (error) {
        // Already gone, from another window or by the app itself.
        if (!(error instanceof ApiError && error.code === 'connected_app_not_found')) throw error;
      }
      return id;
    },
    onSuccess: async (id) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<ConnectedMcpApps>(key, (current) => current && { apps: current.apps.filter((app) => app.id !== id) });
    },
  });
  const now = new Date();
  return <>
    <div className="settings-pane-heading settings-pane-heading-spaced">
      <h2><SettingLabel setting={settings.connectedApps} /></h2>
      <p>{settings.connectedApps.description}</p>
    </div>
    <section aria-label="Connected apps" className="settings-list-card connected-apps">
      {apps.data === undefined
        ? apps.error
          ? <ErrorNotice occurrence={apps.error}>Your connected apps couldn’t be loaded.</ErrorNotice>
          : <LoadingState label="Loading connected apps…" />
        : apps.data.apps.length === 0
          ? <p className="connected-apps-empty">No apps are connected. When you connect Claude, ChatGPT or another app to Rally, it shows here.</p>
          : apps.data.apps.map((app) => {
            const pending = disconnect.isPending && disconnect.variables === app.id;
            return <div className="settings-preference-row connected-app-row" key={app.id}>
              <span className="settings-row-copy">
                <strong>
                  {app.clientName}
                  <span className="connected-app-name-note">the name the app gave itself</span>
                </strong>
                <small>{connectedAppDestination(app)}</small>
                <small>
                  {`${app.workspaceName} · Connected ${connectedDate.format(new Date(app.connectedAt))}`}
                  {app.lastActiveAt !== app.connectedAt && ` · Last used ${formatRelative(app.lastActiveAt, now)}`}
                </small>
              </span>
              <Button
                aria-label={`Disconnect ${app.clientName} from ${app.workspaceName}`}
                className="button-secondary"
                disabled={pending}
                onClick={() => disconnect.mutate(app.id)}
              >Disconnect</Button>
            </div>;
          })}
    </section>
    {disconnect.error && <ErrorNotice occurrence={disconnect.error}>{disconnect.error.message}</ErrorNotice>}
  </>;
}
