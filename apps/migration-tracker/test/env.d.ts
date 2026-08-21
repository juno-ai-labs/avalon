import type { Env as TrackerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // The Workers test pool discovers bindings only through this ambient name.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends TrackerEnv {}
  }
}

export {};
