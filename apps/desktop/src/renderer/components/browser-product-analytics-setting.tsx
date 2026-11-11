import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppSession } from '../lib/app-session';
import { settings } from '../settings/registry';
import { SettingToggle } from '../settings/setting-toggle';
import { ErrorNotice } from './primitives';

/** Account consent uses the identity cookie, independent of the open Organization. */
export function BrowserProductAnalyticsSetting(): React.JSX.Element {
  const { session, region, identityApi: api } = useAppSession();
  const client = useQueryClient();
  const queryKey = ['product-analytics-preference', region, session?.user.id];
  const preference = useQuery({
    queryKey,
    queryFn: ({ signal }) => api!.getProductAnalyticsPreference(signal),
    enabled: Boolean(session && api),
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api!.updateProductAnalyticsPreference(enabled, preference.data!.version),
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: (value) => client.setQueryData(queryKey, value),
    // A lost response may still have committed; reconcile with the account.
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  return <>
    <div className="settings-list-card">
      <SettingToggle setting={settings.analytics} aria-label="Product analytics" role="switch"
        checked={preference.data?.enabled ?? false}
        disabled={!preference.data || save.isPending}
        onChange={(event) => save.mutate(event.currentTarget.checked)} />
    </div>
    {(preference.error || save.error) && <ErrorNotice occurrence={preference.error ?? save.error}>
      {(preference.error ?? save.error)?.message}
    </ErrorNotice>}
  </>;
}
