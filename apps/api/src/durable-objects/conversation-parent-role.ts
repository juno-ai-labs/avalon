import type { Env } from "../env";
import type { DurableObjectSqliteMigration } from "./sqlite-migrations";
import type { WorkstreamDO } from "./workstream-do";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "./workstream-do-schema";

/**
 * What a legacy parent object is: a Channel's `WorkstreamDO` or a Space's
 * `SpaceDO`. Both now only export their rows to the Organization object that
 * hosts them (`docs/hosted-conversation-parents.md`), so all a role still
 * decides is which namespace the object answers in and which migration
 * component its ledger reports under.
 */
export interface LegacyParentRole {
  kind: "workstream" | "space";
  namespace: (env: Env) => DurableObjectNamespace<WorkstreamDO>;
  /**
   * The migration runner's component, the class the tracker reports, and the
   * ledger this object applies. Both roles run the same ledger under their own
   * component, because `forceMigration` fences on class name and the tracker
   * rolls up by component.
   */
  migration: {
    component: string;
    className: string;
    migrations: readonly DurableObjectSqliteMigration[];
  };
}

export const WORKSTREAM_ROLE: LegacyParentRole = {
  kind: "workstream",
  namespace: (env) => env.WORKSTREAM_DOS,
  migration: { component: "workstream_do", className: "WorkstreamDO", migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS },
};

export const SPACE_ROLE: LegacyParentRole = {
  kind: "space",
  namespace: (env) => env.SPACE_DOS,
  migration: { component: "space_do", className: "SpaceDO", migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS },
};
