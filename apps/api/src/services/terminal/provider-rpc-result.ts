import { AsyncLocalStorage } from "node:async_hooks";

import { isTerminalProviderNotFound } from "./provider-contract";
import type {
  TerminalProviderRpcCallbackResult,
  TerminalProviderRpcCallbacks,
  TerminalProviderRpcResult,
} from "./provider-rpc-contract";
import type { TerminalProviderRequestMeasurement } from "./tracing";

type CallbackFailure = Extract<TerminalProviderRpcCallbackResult, { ok: false }>["error"];

class TerminalProviderCallbackError extends Error {
  constructor(readonly failure: CallbackFailure) {
    super(failure.message);
    this.name = "TerminalProviderCallbackError";
  }
}

export async function requireTerminalProviderRpcCallback(
  result: Promise<TerminalProviderRpcCallbackResult>,
): Promise<void> {
  const settled = await result;
  if (!settled.ok) throw new TerminalProviderCallbackError(settled.error);
}

/**
 * The caller's per-call `observeRequest`, for the duration of that one RPC
 * call. The provider instance is shared by every call on a session, so its
 * instrumentation cannot name a caller; this is how a request it issues finds
 * the call it belongs to.
 */
const activeRequestObserver = new AsyncLocalStorage<
  NonNullable<TerminalProviderRpcCallbacks["observeRequest"]>
>();

/**
 * Report one provider request to whichever caller is inside this RPC call.
 * Returns the caller's promise so the provider can await delivery before its
 * own result returns; `undefined` when this call has no observer.
 */
export function observeTerminalProviderRequest(
  measurement: TerminalProviderRequestMeasurement,
): Promise<void> | undefined {
  return activeRequestObserver.getStore()?.(measurement);
}

export async function terminalProviderRpcCall<T>(
  operation: () => Promise<T>,
  callbacks?: TerminalProviderRpcCallbacks,
): Promise<TerminalProviderRpcResult<T>> {
  const observeRequest = callbacks?.observeRequest;
  if (observeRequest) {
    return activeRequestObserver.run(
      observeRequest,
      () => terminalProviderRpcCall(operation),
    );
  }
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof TerminalProviderCallbackError) {
      return {
        ok: false,
        error: error.failure.kind === "terminal_tool"
          ? error.failure
          : { kind: "provider", message: error.failure.message },
      };
    }
    if (isTerminalProviderNotFound(error)) {
      return {
        ok: false,
        error: {
          kind: "not_found",
          message: error instanceof Error ? error.message : "Terminal provider resource not found",
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "provider",
        message: error instanceof Error ? error.message : "Terminal provider call failed",
      },
    };
  }
}
