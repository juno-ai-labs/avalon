import type { Env as AvalonEnv } from "../src/env";
import type { MigrationProbeDO } from "../src/durable-objects/migration-probe-do";
import type {
  TerminalProviderRpcCallbackResult,
  TerminalProviderRpcResult,
} from "../src/services/terminal/provider-rpc-contract";
import type { TelemetryDeliveryRpcBinding } from "../src/telemetry/telemetry-delivery-contract";

interface TerminalRpcTestBinding {
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
