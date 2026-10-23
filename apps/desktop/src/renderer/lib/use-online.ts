import { useSyncExternalStore } from 'react';

function subscribe(changed: () => void): () => void {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

/** Consent is sent only by a current online action, never queued for reconnect. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}
