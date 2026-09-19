import type { Env as AvalonEnv } from "../src/env";
import type { MigrationProbeDO } from "../src/durable-objects/migration-probe-do";
import type {
  TerminalProviderRpcBinding,
  TerminalProviderRpcCallbackResult,
  TerminalProviderRpcResult,
} from "../src/services/terminal/provider-rpc-contract";
import type { TelemetryDeliveryRpcBinding } from "../src/telemetry/telemetry-delivery-contract";

interface TerminalRpcTestBinding extends TerminalProviderRpcBinding {
  throwNotFound(): Promise<never>;
  returnNotFound(): Promise<TerminalProviderRpcResult<never>>;
  invokeCallback(
    callback: () => Promise<TerminalProviderRpcCallbackResult>,
  ): Promise<TerminalProviderRpcCallbackResult>;
  createCounterSession(): Promise<{
    next(): Promise<number>;
    [Symbol.dispose](): void;
  }>;
  createCallbackSession(callback: (value: string) => Promise<string>): Promise<{
    call(value: string): Promise<string>;
    [Symbol.dispose](): void;
  }>;
  createSession(): Promise<{
    startSandbox(idOrName: string, options?: unknown, callbacks?: unknown): Promise<unknown>;
    recoverSandbox(idOrName: string, options?: unknown, callbacks?: unknown): Promise<unknown>;
    [Symbol.dispose](): void;
  }>;
}

declare global {
  namespace Cloudflare {
    // The Workers test pool discovers bindings only through this ambient name.
    interface Env extends AvalonEnv {
      MIGRATION_PROBE_DO?: DurableObjectNamespace<MigrationProbeDO>;
      TELEMETRY_RPC_TEST?: TelemetryDeliveryRpcBinding;
      TERMINAL_RPC_TEST?: TerminalRpcTestBinding;
    }
  }
}

export {};
