import type { TerminalProviderRpcCallbacks } from "./provider-rpc-contract";

export async function withTerminalProviderRpcAbort<T>(
  callbacks: TerminalProviderRpcCallbacks | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (callbacks?.initiallyAborted) {
    controller.abort(new Error("Terminal operation cancelled"));
  }
  let operationActive = true;
  const abortObservation = callbacks?.waitForAbort?.().then(
    (outcome) => {
      if (operationActive && outcome === "aborted") {
        controller.abort(new Error("Terminal operation cancelled"));
      }
    },
    () => {
      if (operationActive) controller.abort(new Error("Terminal caller disconnected"));
    },
  );
  try {
    return await operation(controller.signal);
  } finally {
    operationActive = false;
    await callbacks?.finishAbortWait?.().catch(() => undefined);
    await abortObservation;
  }
}
