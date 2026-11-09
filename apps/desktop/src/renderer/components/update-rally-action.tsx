import { useMutation } from '@tanstack/react-query';

import { desktopBridge, desktopServicesAvailable } from '../lib/platform';
import { useUpdateStatus } from '../lib/use-downloaded-update';
import { Button, ErrorNotice } from './primitives';

/**
 * The one way out of a build the server no longer serves, wherever Rally
 * needs a newer client: on desktop, install the update the main process has
 * downloaded or ask it to look for one; in a browser, reload the page, which
 * loads the build the server is serving.
 */
export function useUpdateRally(): {
  desktop: boolean; label: string; disabled: boolean; run(): void; error: Error | null;
} {
  const desktop = desktopServicesAvailable();
  const status = useUpdateStatus(desktop);
  const busy = status?.kind === 'checking' || status?.kind === 'downloading';
  const update = useMutation({
    mutationFn: async () => {
      if (!desktop) {
        globalThis.location.reload();
        return;
      }
      const bridge = desktopBridge();
      const current = await bridge.getUpdateStatus();
      if (current.kind === 'downloaded') {
        await bridge.installDownloadedUpdate();
      } else if (current.kind === 'idle') {
        await bridge.checkForUpdates();
      }
    },
  });
  return {
    desktop,
    label: status?.kind === 'checking' ? 'Checking…'
      : status?.kind === 'downloading' ? 'Downloading…'
        : status?.kind === 'downloaded' ? 'Restart to update'
          : desktop ? 'Update Rally' : 'Reload Rally',
    disabled: update.isPending || busy,
    run: () => update.mutate(),
    error: update.error,
  };
}

/** {@link useUpdateRally} as a button, with its failure beneath it. */
export function UpdateRallyAction({ className }: { className?: string }): React.JSX.Element {
  const update = useUpdateRally();
  return (
    <>
      <Button className={className} disabled={update.disabled} onClick={update.run}>{update.label}</Button>
      {update.error ? <ErrorNotice occurrence={update.error}>{update.error.message}</ErrorNotice> : null}
    </>
  );
}
