import type { DurableObjectMigrationCommand } from "@rally/contracts/durable-object-migrations";

import type { AccessEnvironment } from "./access";
import type { MigrationRegistry } from "./registry";

export interface Env extends AccessEnvironment {
  MIGRATION_REGISTRY: DurableObjectNamespace<MigrationRegistry>;

  /**
   * The forced-migration command queues, one per region.
   *
   * Optional together, and for the same reason the API's report queue binding
   * is: a local `wrangler dev` and the workerd test config run without them.
   * The site reads them as a capability — an unbound region cannot be forced,
   * and the page says so rather than pretending the dispatch succeeded.
   */
  GLOBAL_MIGRATION_COMMAND_QUEUE?: Queue<DurableObjectMigrationCommand>;
  [binding: `${string}_MIGRATION_COMMAND_QUEUE`]: Queue<DurableObjectMigrationCommand> | undefined;

  APP_ENV: "development" | "test" | "staging" | "production";
  APP_VERSION?: string;

  /**
   * Local-only Access bypass, held to the same shape as the API's
   * `RALLY_DEV_AUTH`: it is honoured in `development` and nowhere else, so a
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
