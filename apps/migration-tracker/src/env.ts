import type { AccessEnvironment } from "./access";
import type { MigrationRegistry } from "./registry";

export interface Env extends AccessEnvironment {
  MIGRATION_REGISTRY: DurableObjectNamespace<MigrationRegistry>;

  APP_ENV: "development" | "test" | "staging" | "production";
  APP_VERSION?: string;

  /**
   * Local-only Access bypass, held to the same shape as the API's
   * `AVALON_DEV_AUTH`: it is honoured in `development` and nowhere else, so a
   * value left set in a hosted deployment changes nothing.
   */
  MIGRATION_TRACKER_DEV_AUTH?: string;

  /** Read-only Cloudflare credentials for the inventory sweep. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

/** True only where a local developer is meant to bypass Cloudflare Access. */
export function devAuthEnabled(env: Env): boolean {
  return env.APP_ENV === "development" && env.MIGRATION_TRACKER_DEV_AUTH === "true";
}
