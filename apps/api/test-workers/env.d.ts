import type { Env as AvalonEnv } from "../src/env";
import type { MigrationProbeDO } from "../src/durable-objects/migration-probe-do";

declare global {
  namespace Cloudflare {
    // The Workers test pool discovers bindings only through this ambient name.
    interface Env extends AvalonEnv {
      MIGRATION_PROBE_DO?: DurableObjectNamespace<MigrationProbeDO>;
    }
  }
}

export {};
