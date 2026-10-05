import type { RallyDesktopBridge } from '../../common/desktop';
import type { NetworkTicketObservation } from '../../common/network-recovery';

const pendingRequests = new Map<AbortController, number>();
let observedBridge: RallyDesktopBridge | undefined;
let unsubscribeBridge: (() => void) | undefined;

function observeRecovery(bridge: RallyDesktopBridge | undefined): void {
  if (bridge === observedBridge) return;
  unsubscribeBridge?.();
  observedBridge = bridge;
  unsubscribeBridge = bridge?.onNetworkRecoveryState?.((state) => {
    // Stop old reads before they can transparently retry on the replacement
    // connections. Body streams whose headers already arrived are terminated
    // by Chromium's native reset itself; they cannot retry their HTTP request.
    for (const [request, generation] of pendingRequests) {
      if (generation < state.generation || state.phase === 'resetting') {
        request.abort(new DOMException('Rally is recovering its network connections.', 'AbortError'));
        pendingRequests.delete(request);
      }
    }
  });
}

function recoveryBridge(): RallyDesktopBridge | undefined {
  const bridge = window.rally;
  observeRecovery(bridge);
  return bridge;
}

/** Track pending HTTP attempts across all API clients without replaying them. */
export async function fetchWithNetworkRecovery(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const bridge = recoveryBridge();
  if (!bridge?.onNetworkRecoveryState) return fetch(input, init);
  const controller = new AbortController();
  const owner = init.signal;
  const cancelled = (): void => {
    controller.abort(owner?.reason);
    pendingRequests.delete(controller);
  };
  owner?.throwIfAborted();
  owner?.addEventListener('abort', cancelled, { once: true });
  pendingRequests.set(controller, bridge?.getNetworkRecoveryState?.().generation ?? 0);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    pendingRequests.delete(controller);
    owner?.removeEventListener('abort', cancelled);
  }
}

/** Only the reset itself holds new requests. Awaiting a live frame does not. */
export function waitForNetworkRecovery(signal?: AbortSignal): Promise<void> | undefined {
  const bridge = recoveryBridge();
  signal?.throwIfAborted();
  if (bridge?.getNetworkRecoveryState?.().phase !== 'resetting') return;
  return new Promise<void>((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const finish = (): void => {
      unsubscribe();
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    const aborted = (): void => {
      unsubscribe();
      signal?.removeEventListener('abort', aborted);
      reject(signal?.reason);
    };
    unsubscribe = bridge.onNetworkRecoveryState!((state) => {
      if (state.phase !== 'resetting') finish();
    });
    signal?.addEventListener('abort', aborted, { once: true });
    // Cover a reset finishing between the first read and subscription.
    if (signal?.aborted) aborted();
    else if (bridge.getNetworkRecoveryState!().phase !== 'resetting') finish();
  });
}

export function networkRecoveryGeneration(): number {
  return recoveryBridge()?.getNetworkRecoveryState?.().generation ?? 0;
}

export function reportNetworkTicket(observation: NetworkTicketObservation): void {
  // Browser clients use their existing reconnect behavior. An absent native
  // bridge never turns a normal API request into a desktop-only requirement.
  void recoveryBridge()?.reportNetworkTicket?.(observation).catch(() => undefined);
}
