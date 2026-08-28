import { DurableObject } from "cloudflare:workers";

/** Empty SQLite object used only by the workerd migration test binding. */
export class MigrationProbeDO extends DurableObject {
  ping(): true {
    return true;
  }
}
