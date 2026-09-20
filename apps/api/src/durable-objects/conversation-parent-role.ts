import type { Region, SpaceId, WorkspaceId, WorkstreamId } from "@rally/contracts";
import { asSpaceId, asWorkstreamId } from "@rally/contracts";

import type { Env } from "../env";
import { spaceDOName, workstreamDOName } from "./names";
import type { DurableObjectSqliteMigration } from "./sqlite-migrations";
import type { WorkstreamDO } from "./workstream-do";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "./workstream-do-schema";

/**
 * What a `WorkstreamDO` instance *is*, fixed at construction and never read
 * from data. Every field is a behavior the base class reads; nothing here is
 * advisory.
 *
 * Why a role rather than `class SpaceDO extends WorkstreamDO`, and what the
 * role does and does not change: `docs/workstream-durable-object.md`, "A Space
 * is this class under a role".
 */
export interface ConversationParentRole {
  /**
   * The parent kind this object writes into the conversation-parent contract.
   *
   * `automation` is absent because `SidekickDO` is not this class: it extends
   * `ConversationParentDurableObject` directly and has its own schema and
   * lifecycle. This is a role of `WorkstreamDO`, not of every parent.
   */
  kind: "workstream" | "space";
  /** The binding this object registers itself under and is addressed through. */
  namespace: (env: Env) => DurableObjectNamespace<WorkstreamDO>;
  /** This object's deterministic name inside {@link namespace}. */
  objectName: (region: Region, workspaceId: WorkspaceId, parentId: string) => string;
  /**
   * The migration runner's component, the class the tracker reports, and the
   * ledger this object applies.
   *
   * Three fields rather than one because they do not move together.
   * `component` and `className` are this role's alone — `forceMigration`
   * refuses a command whose `className` disagrees with the plan, and the
   * tracker keys its rollup by `component`, so two roles under one component
   * would file two classes' version histories under one count. `migrations`
   * is the opposite: both roles run {@link WORKSTREAM_DO_SCHEMA_MIGRATIONS},
   * because they are the same class and an inherited method that met a missing
   * table would fail at a request rather than at a deploy. Each component
   * keeps its own `_sql_schema_migrations` receipts of that one array.
   */
  migration: {
    component: string;
    className: string;
    migrations: readonly DurableObjectSqliteMigration[];
  };
  /** Whether `GET /socket` may upgrade. A Space has no feed to open. */
  admitsClientSockets: boolean;
  /**
   * Whether a grant written here is published to the shared scope-grant
   * directory.
   *
   * A Space's grants reach its own conversation and nothing else: the
   * directory is how a Channel becomes discoverable to someone who was granted
   * it, and a Space is discovered through the Organization's Space directory
   * instead. The grant still commits — only its publication is suppressed.
   */
  publishesGrantDirectory: boolean;
  /**
   * Whether this parent forwards its child's activity, notification and
   * grant-directory effects on to the workspace.
   *
   * `false` keeps `directory_common` and `directory_user` — the Space's own
   * presentation and its per-viewer state, which the Space directory is built
   * from — and drops the rest at the parent. That is where they have to be
   * dropped: an effect that reached the outbox would be delivered, and a Space
   * has no feed for an activity event to appear in and no notification anyone
   * asked for.
   */
  forwardsFeedEffects: boolean;
  /**
   * Whether construction starts the main conversation warming.
   *
   * A Channel's control socket and its feed socket open together, so waking the
   * child during the parent's cold start removes a latency a person waits
   * through. Nothing opens a Space's conversation, so the same wake would be a
   * subrequest and a second object's cold start bought for nobody.
   */
  wakesMainEagerly: boolean;
}

export const WORKSTREAM_ROLE: ConversationParentRole = {
  kind: "workstream",
  namespace: (env) => env.WORKSTREAM_DOS,
  objectName: (region, workspaceId, parentId) =>
    workstreamDOName(region, workspaceId, asWorkstreamId(parentId) as WorkstreamId),
  migration: {
    component: "workstream_do",
    className: "WorkstreamDO",
    migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
  },
  admitsClientSockets: true,
  publishesGrantDirectory: true,
  forwardsFeedEffects: true,
  wakesMainEagerly: true,
};

export const SPACE_ROLE: ConversationParentRole = {
  kind: "space",
  namespace: (env) => env.SPACE_DOS,
  objectName: (region, workspaceId, parentId) =>
    spaceDOName(region, workspaceId, asSpaceId(parentId) as SpaceId),
  migration: {
    component: "space_do",
    className: "SpaceDO",
    // The Channel's ledger, not a rendering of it. A hand-copied one version
    // was tried and dropped: see the comment on the `migration` field.
    migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
  },
  admitsClientSockets: false,
  publishesGrantDirectory: false,
  forwardsFeedEffects: false,
  wakesMainEagerly: false,
};
