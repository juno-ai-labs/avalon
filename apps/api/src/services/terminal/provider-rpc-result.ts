import { isTerminalProviderNotFound } from "./provider-contract";
import type {
  TerminalProviderRpcCallbackResult,
  TerminalProviderRpcResult,
} from "./provider-rpc-contract";

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

export async function terminalProviderRpcCall<T>(
  operation: () => Promise<T>,
): Promise<TerminalProviderRpcResult<T>> {
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
