import { useSyncExternalStore } from 'react';

export interface DeepLinkWorkstreamNavigation {
  revision: number;
  workstreamId: string;
}

let revision = 0;
let pending: DeepLinkWorkstreamNavigation | null = null;
const listeners = new Set<() => void>();

/**
 * Carries the one distinction the hash route cannot: this Channel was opened
 * by a desktop deep link rather than by navigation inside the renderer.
 *
 * The value is retained until the sidebar can resolve the Channel's directory
 * row. During an Organization switch the link arrives before the destination
 * shell and its Space directory are mounted.
 */
export function markDeepLinkWorkstreamNavigation(workstreamId: string): void {
  pending = { revision: ++revision, workstreamId };
  listeners.forEach((listener) => listener());
}

export function useDeepLinkWorkstreamNavigation(): DeepLinkWorkstreamNavigation | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
  );
}

export function consumeDeepLinkWorkstreamNavigation(expectedRevision: number): void {
  if (pending?.revision !== expectedRevision) return;
  pending = null;
  listeners.forEach((listener) => listener());
}
