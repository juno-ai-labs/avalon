import { RegionSchema } from "@rally/contracts/regions";
import { asArtifactId, asSubstreamId, asWorkspaceId, SpaceDirectorySchema, SpaceChannelPageSchema, type SpaceDirectory, type SpaceChannelPage } from "@rally/contracts";
import {
  ArtifactInspectionInputSchema,
  ArtifactSqlInspectionInputSchema,
  D1SqlInspectionInputSchema,
  SendEngineeringMessageInputSchema,
  SendEngineeringMessageResultSchema,
  ReadEngineeringChannelInputSchema,
  ReadEngineeringConversationInputSchema,
  EngineeringTextResultSchema,
  ListEngineeringUserChannelsInputSchema,
  ListEngineeringUserConversationsInputSchema,
  type SendEngineeringMessageResult,
  type EngineeringTextResult,
  CreateEngineeringOrgInputSchema,
  CreateEngineeringOrgResultSchema,
  CreateEngineeringChannelInputSchema,
  CreateEngineeringChannelResultSchema,
  CreateEngineeringThreadInputSchema,
  CreateEngineeringThreadResultSchema,
  type CreateEngineeringOrgResult,
  type CreateEngineeringChannelResult,
  type CreateEngineeringThreadResult,
  EngineeringArtifactListLookupSchema,
  EngineeringArtifactTargetLookupSchema,
  EngineeringD1SqlResultSchema,
  EngineeringSidekickListLookupSchema,
  EngineeringSqlLookupSchema,
  EngineeringSubstreamTargetLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringWorkspaceTargetLookupSchema,
  EngineeringWorkstreamListLookupSchema,
  ListEngineeringWorkspacesInputSchema,
  ListEngineeringWorkspacesResultSchema,
  SearchEngineeringOrganizationsInputSchema,
  SearchEngineeringOrganizationsResultSchema,
  SearchEngineeringUsersInputSchema,
  SearchEngineeringUsersResultSchema,
  EngineeringSpaceListLookupSchema,
  SubstreamSqlInspectionInputSchema,
  SubstreamInspectionInputSchema,
  WorkspaceInspectionInputSchema,
  WorkspaceSqlInspectionInputSchema,
  WorkstreamInspectionInputSchema,
  type EngineeringInspectionRpcBinding,
  type EngineeringArtifactListLookup,
  type EngineeringArtifactTargetLookup,
  type EngineeringD1SqlResult,
  type EngineeringSidekickListLookup,
  type EngineeringSpaceListLookup,
  type EngineeringSqlLookup,
  type EngineeringSubstreamListLookup,
  type EngineeringSubstreamTargetLookup,
  type EngineeringWorkspaceTargetLookup,
  type EngineeringWorkstreamListLookup,
  type ListEngineeringWorkspacesResult,
  type SearchEngineeringOrganizationsResult,
  type SearchEngineeringUsersResult,
  type InspectionSqlValue,
} from "@rally/contracts/engineering-inspection";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import {
  artifactHostDOName,
  conversationObjectName,
  workspaceDOName,
} from "./durable-objects/names";
import { base64 } from "./durable-objects/internally-inspectable-durable-object";
import {
  resolveInspectionWorkspaceRoute,
  resolveInspectionWorkstreamRoute,
  searchInspectionOrganizations,
  searchInspectionUsers,
  type InspectionWorkspaceRoute,
  type InspectionWorkstreamRoute,
} from "./engineering-inspection-routes";
import type { Env } from "./env";
import {
  durableObjectStubForArtifact,
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "./lib/durable-object-namespace";
import { parseRpcInput } from "./lib/rpc-contracts";
import { ApiError } from "./lib/api-error";
import { WORKSTREAM_DO_SERVING_CONTRACT_VERSION } from "./services/workstream-authority";
import { createEngineeringOrg, createEngineeringChannel, createEngineeringThread } from "./services/engineering-creation";
import { sendEngineeringMessage, readEngineeringChannel, readEngineeringConversation, listEngineeringUserChannels, listEngineeringUserConversations } from "./services/engineering-messages";

const WorkspaceInventoryRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  region: RegionSchema,
  placement_affinity: z.string(),
  authority_state: z.string().nullable(),
});

const WorkstreamDirectoryRowSchema = z.strictObject({
  workstream_id: z.string(),
  title: z.string(),
  scope: z.string(),
  exact_state: z.string(),
  system_kind: z.string().nullable(),
  last_activity_at: z.number().int().nonnegative(),
  archived_at: z.number().int().nonnegative().nullable(),
});

const SubstreamDirectoryRowSchema = z.strictObject({
  substream_id: z.string(),
});

const ArtifactRegistryRowSchema = z.strictObject({
  artifact_id: z.string(),
  workstream_id: z.string(),
  resource_id: z.string(),
  mode: z.string(),
  stateful: z.number().int().min(0).max(1),
  current_version: z.number().int().positive(),
  hostname_stub: z.string().nullable(),
  updated_at: z.number().int().nonnegative(),
});

const SpaceDirectoryRowSchema = z.strictObject({
  space_id: z.string(),
  title: z.string(),
  scope: z.string(),
  system_role: z.string().nullable(),
  archived_at: z.number().int().nonnegative().nullable(),
});

const SidekickDirectoryRowSchema = z.strictObject({
  automation_id: z.string(),
  lifecycle: z.string(),
  scope: z.string(),
  owning_workstream_id: z.string().nullable(),
  title: z.string(),
  next_run_at: z.number().int().nullable(),
  projected_at: z.number().int().nonnegative(),
});

/** D1 returns a BLOB as an array of byte values; the result shape names it a blob. */
function d1InspectionValue(value: unknown): InspectionSqlValue {
  return Array.isArray(value)
    ? { type: "blob", base64: base64(Uint8Array.from(value as number[]).buffer) }
    : value as InspectionSqlValue;
}

async function workspaceStub(env: Env, workspaceId: string) {
  const brandedWorkspaceId = asWorkspaceId(workspaceId);
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, brandedWorkspaceId),
  );
}

async function resolveInspectionSubstreamRoute(
  env: Env,
  input: { workspaceId: string; workstreamId: string; substreamId: string },
  expectedGeneration?: number,
): Promise<InspectionWorkstreamRoute | null> {
  const route = await resolveInspectionWorkstreamRoute(
    env,
    input.workstreamId,
    expectedGeneration,
  );
  if (!route || route.workspace_id !== input.workspaceId) return null;
  if (input.substreamId === "0") {
    // A route becomes active only after creation/import has initialized the
    // main substream, so this check cannot materialize a previously absent DO.
    return route;
  }
  const known = await inspectionSubstreamIds(env, route);
  return known.includes(input.substreamId) ? route : null;
}

/**
 * Every conversation a parent hosted by the Organization object has heard
 * from: a Channel's in the shared parent tables, a moved Sidekick's in its own.
 */
async function inspectionSubstreamIds(env: Env, route: InspectionWorkstreamRoute): Promise<string[]> {
  const workspace = await workspaceStub(env, route.workspace_id);
  const hosted = await workspace.runInspectionSql({
    sql: `SELECT substream_id FROM parent_child_projections WHERE parent_id = ?
          UNION SELECT substream_id FROM parent_children WHERE parent_id = ?
          UNION SELECT substream_id FROM sidekick_child_projections WHERE sidekick_id = ?
          UNION SELECT substream_id FROM sidekick_children WHERE sidekick_id = ?`,
    bindings: [route.workstream_id, route.workstream_id, route.workstream_id, route.workstream_id],
  });
  return hosted.rows.map((row) => String(row.substream_id));
}

/**
 * An artifact is fenced by its workspace: ArtifactHostDO's name carries no
 * workspace segment at all, so nothing about the name itself proves the caller
 * may reach it, and every artifact UUID in the account is a valid object name.
 *
 * `artifact_registry` lives in WorkspaceDO beside the resource authority rather
 * than in D1, and it is the only place that says which artifacts a workspace
 * has. An unregistered UUID is refused here rather than materializing an empty
 * supervisor.
 *
 * **Membership here does not imply the object, and knowingly so.**
 * `resource-bridge.ts` writes this registry row and only then calls
 * `pointArtifactAtVersion`, which is what initializes the supervisor —
 * deliberately last, so that serving never points at bytes a viewer cannot yet
 * read. Between those two calls, and permanently if the second never returns,
 * a registered artifact has no supervisor, and running SQL against it creates
 * an empty one.
 *
 * That window is left open rather than closed by reordering the publish path,
 * which would make the pointer commit before the row that describes it, or by a
 * readiness column, which is a WorkspaceDO migration and a product write for an
 * operator console's benefit. What an operator sees in the gap is a supervisor
 * with schema and no `artifact_state` row — which is the diagnosis of exactly
 * that half-finished publish, so the refusal it would take to hide it would
 * cost more than it saves. `docs/engineering-mcp.md` states the exception.
 */
async function resolveInspectionArtifactRoute(
  env: Env,
  input: { workspaceId: string; artifactId: string },
  expectedGeneration?: number,
): Promise<InspectionWorkspaceRoute | null> {
  const route = await resolveInspectionWorkspaceRoute(
    env,
    input.workspaceId,
    expectedGeneration,
  );
  if (!route) return null;
  const workspace = await workspaceStub(env, input.workspaceId);
  const registry = await workspace.runInspectionSql({
    sql: `SELECT artifact_id FROM artifact_registry
           WHERE artifact_id = ? AND workspace_id = ?`,
    bindings: [input.artifactId, input.workspaceId],
  });
  return registry.rows.length === 0 ? null : route;
}

/**
 * Private regional data-plane surface for the Access-protected engineering MCP.
 * Its intended callers are the private regional Service Bindings on the MCP
 * Worker; no product HTTP route exposes this entrypoint.
 */
export class EngineeringInspectionBridge extends WorkerEntrypoint<Env>
  implements EngineeringInspectionRpcBinding {
  async listUserChannels(input: unknown): Promise<SpaceDirectory> {
    return this.productOperation("listUserChannels", async () => SpaceDirectorySchema.parse(
      await listEngineeringUserChannels(this.env, ListEngineeringUserChannelsInputSchema.parse(input)),
    ));
  }

  async listUserConversations(input: unknown): Promise<SpaceChannelPage> {
    return this.productOperation("listUserConversations", async () => SpaceChannelPageSchema.parse(
      await listEngineeringUserConversations(this.env, ListEngineeringUserConversationsInputSchema.parse(input)),
    ));
  }
  async sendMessage(input: unknown): Promise<SendEngineeringMessageResult> {
    return this.productOperation("sendMessage", async () => SendEngineeringMessageResultSchema.parse(
      await sendEngineeringMessage(this.env, SendEngineeringMessageInputSchema.parse(input)),
    ));
  }

  async readChannel(input: unknown): Promise<EngineeringTextResult> {
    return this.productOperation("readChannel", async () => EngineeringTextResultSchema.parse(
      await readEngineeringChannel(this.env, ReadEngineeringChannelInputSchema.parse(input)),
    ));
  }

  async readConversation(input: unknown): Promise<EngineeringTextResult> {
    return this.productOperation("readConversation", async () => EngineeringTextResultSchema.parse(
      await readEngineeringConversation(this.env, ReadEngineeringConversationInputSchema.parse(input)),
    ));
  }
  private async productOperation<T>(name: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // RPC strips ZodError issues and ApiError properties. Preserve the reason
      // as a diagnostic code, without putting names, prompts or emails in logs.
      const schemaCode = zodDiagnosticCode(error, name);
      if (schemaCode) throw new Error(schemaCode, { cause: error });
      if (error instanceof ApiError) throw new Error(`engineering_operation_failed:${error.code}`, { cause: error });
      throw error;
    }
  }

  async createOrg(input: unknown): Promise<CreateEngineeringOrgResult> {
    return this.productOperation("createOrg", async () => CreateEngineeringOrgResultSchema.parse(
      await createEngineeringOrg(this.env, CreateEngineeringOrgInputSchema.parse(input)),
    ));
  }

  async createChannel(input: unknown): Promise<CreateEngineeringChannelResult> {
    return this.productOperation("createChannel", async () => CreateEngineeringChannelResultSchema.parse(
      await createEngineeringChannel(this.env, CreateEngineeringChannelInputSchema.parse(input), (work) => this.ctx.waitUntil(work)),
    ));
  }

  async createThread(input: unknown): Promise<CreateEngineeringThreadResult> {
    return this.productOperation("createThread", async () => CreateEngineeringThreadResultSchema.parse(
      await createEngineeringThread(this.env, CreateEngineeringThreadInputSchema.parse(input),
        (work) => this.ctx.waitUntil(work)),
    ));
  }

  async listWorkspaces(input: Record<string, never>): Promise<ListEngineeringWorkspacesResult> {
    parseRpcInput(ListEngineeringWorkspacesInputSchema, input, "listWorkspaces");
    const result = await this.env.DB.prepare(
      `SELECT workspace.id, workspace.name, workspace.slug, workspace.region,
              workspace.placement_affinity,
              CASE
                WHEN control.phase = 'durable_object_open'
                 AND control.serving_contract_version >= control.required_serving_contract_version
                 AND control.required_serving_contract_version <= ?
                THEN 'active'
                ELSE NULL
              END AS authority_state
         FROM workspaces workspace
         LEFT JOIN workstream_authority_control control
           ON control.id = 1
        WHERE workspace.region = ?
        ORDER BY workspace.name COLLATE NOCASE, workspace.id`,
    ).bind(WORKSTREAM_DO_SERVING_CONTRACT_VERSION, this.env.AVALON_REGION).all<unknown>();
    const rows = z.array(WorkspaceInventoryRowSchema).parse(result.results ?? []);
    return ListEngineeringWorkspacesResultSchema.parse({
      region: this.env.AVALON_REGION,
      items: rows.map((row) => ({
        workspaceId: row.id,
        name: row.name,
        slug: row.slug,
        region: row.region,
        placementAffinity: row.placement_affinity,
        authorityState: row.authority_state,
      })),
    });
  }

  async searchOrganizations(input: unknown): Promise<SearchEngineeringOrganizationsResult> {
    const filter = parseRpcInput(SearchEngineeringOrganizationsInputSchema, input, "searchOrganizations");
    // A ZodError reaches the far side of RPC as a bare Error, so its field
    // would be lost; the MCP reads a diagnostic-shaped message as the code.
    try {
      return await this.searchOrganizationsUnchecked(filter);
    } catch (error) {
      const code = zodDiagnosticCode(error, "searchOrganizations");
      throw code ? new Error(code) : error;
    }
  }

  private async searchOrganizationsUnchecked(
    filter: z.infer<typeof SearchEngineeringOrganizationsInputSchema>,
  ): Promise<SearchEngineeringOrganizationsResult> {
    const rows = await searchInspectionOrganizations(this.env, filter);
    return SearchEngineeringOrganizationsResultSchema.parse({
      region: this.env.AVALON_REGION,
      items: rows.map((row) => ({
        workspaceId: row.id,
        name: row.name,
        slug: row.slug,
        region: row.region,
        plan: row.plan,
        createdAt: row.created_at,
        abandonedAt: row.abandoned_at,
        memberCount: row.member_count,
        lastSeenAt: row.last_seen_at,
      })),
    });
  }

  async searchUsers(input: unknown): Promise<SearchEngineeringUsersResult> {
    const filter = parseRpcInput(SearchEngineeringUsersInputSchema, input, "searchUsers");
    try {
      return await this.searchUsersUnchecked(filter);
    } catch (error) {
      const code = zodDiagnosticCode(error, "searchUsers");
      throw code ? new Error(code) : error;
    }
  }

  private async searchUsersUnchecked(
    filter: z.infer<typeof SearchEngineeringUsersInputSchema>,
  ): Promise<SearchEngineeringUsersResult> {
    const rows = await searchInspectionUsers(this.env, filter);
    return SearchEngineeringUsersResultSchema.parse({
      region: this.env.AVALON_REGION,
      items: rows.map((row) => ({
        userId: row.id,
        name: row.name,
        email: row.email,
        region: this.env.AVALON_REGION,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        organizations: row.memberships.map((membership) => ({
          workspaceId: membership.workspace_id,
          name: membership.name,
          slug: membership.slug,
          role: membership.role,
          accessClass: membership.access_class,
          status: membership.status,
          lastSeenAt: membership.last_seen_at,
        })),
      })),
    });
  }

  async listWorkstreams(input: unknown): Promise<EngineeringWorkstreamListLookup> {
    const request = parseRpcInput(WorkspaceInspectionInputSchema, input, "listWorkstreams");
    if (!await resolveInspectionWorkspaceRoute(this.env, request.workspaceId)) {
      return { found: false };
    }
    const workspace = await workspaceStub(this.env, request.workspaceId);
    const result = await workspace.runInspectionSql({
      sql: `SELECT workstream_id, title, scope, exact_state, system_kind,
                   last_activity_at, archived_at
              FROM channels
             ORDER BY last_activity_at DESC, workstream_id`,
      bindings: [],
    });
    return EngineeringWorkstreamListLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        items: z.array(WorkstreamDirectoryRowSchema).parse(result.rows).map((row) => ({
          workspaceId: request.workspaceId,
          workstreamId: row.workstream_id,
          region: this.env.AVALON_REGION,
          title: row.title,
          scope: row.scope,
          state: row.exact_state,
          systemKind: row.system_kind,
          lastActivityAt: row.last_activity_at,
          archivedAt: row.archived_at,
        })),
      },
    });
  }

  async listSubstreams(input: unknown): Promise<EngineeringSubstreamListLookup> {
    const request = parseRpcInput(WorkstreamInspectionInputSchema, input, "listSubstreams");
    const route = await resolveInspectionWorkstreamRoute(this.env, request.workstreamId);
    if (!route) return { found: false };
    const substreamIds = [...new Set(["0", ...await inspectionSubstreamIds(this.env, route)])].sort();
    return EngineeringSubstreamListLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: route.workspace_id,
        workstreamId: route.workstream_id,
        items: z.array(SubstreamDirectoryRowSchema).parse(substreamIds.map((substreamId) => ({ substream_id: substreamId })))
          .map((row) => ({
          workspaceId: route.workspace_id,
          workstreamId: route.workstream_id,
          substreamId: row.substream_id,
          region: this.env.AVALON_REGION,
        })),
      },
    });
  }

  async listSidekicks(input: unknown): Promise<EngineeringSidekickListLookup> {
    const request = parseRpcInput(WorkspaceInspectionInputSchema, input, "listSidekicks");
    if (!await resolveInspectionWorkspaceRoute(this.env, request.workspaceId)) {
      return { found: false };
    }
    const workspace = await workspaceStub(this.env, request.workspaceId);
    // Every lifecycle, deleted included: the object outlives the product row,
    // and a deleted Sidekick is a common inspection target.
    const result = await workspace.runInspectionSql({
      sql: `SELECT automation_id, lifecycle, scope, owning_workstream_id, title,
                   next_run_at, projected_at
              FROM automation_directory
             WHERE workspace_id = ?
             ORDER BY title COLLATE NOCASE, automation_id`,
      bindings: [request.workspaceId],
    });
    return EngineeringSidekickListLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        items: z.array(SidekickDirectoryRowSchema).parse(result.rows).map((row) => ({
          workspaceId: request.workspaceId,
          sidekickId: row.automation_id,
          region: this.env.AVALON_REGION,
          lifecycle: row.lifecycle,
          scope: row.scope,
          owningWorkstreamId: row.owning_workstream_id,
          title: row.title,
          nextRunAt: row.next_run_at,
          projectedAt: row.projected_at,
        })),
      },
    });
  }

  /**
   * Every Space in a workspace, archived ones included.
   *
   * Read from `spaces` the way `listSidekicks` reads
   * `automation_directory`: the Organization's projection is what says a Space
   * exists, and an archived Space is a common inspection target even though no
   * product list shows it.
   */
  async listSpaces(input: unknown): Promise<EngineeringSpaceListLookup> {
    const request = parseRpcInput(WorkspaceInspectionInputSchema, input, "listSpaces");
    if (!await resolveInspectionWorkspaceRoute(this.env, request.workspaceId)) {
      return { found: false };
    }
    const workspace = await workspaceStub(this.env, request.workspaceId);
    const result = await workspace.runInspectionSql({
      sql: `SELECT space_id, title, scope, system_role, archived_at
              FROM spaces
             ORDER BY created_at, space_id`,
      bindings: [],
    });
    return EngineeringSpaceListLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        items: z.array(SpaceDirectoryRowSchema).parse(result.rows).map((row) => ({
          workspaceId: request.workspaceId,
          spaceId: row.space_id,
          region: this.env.AVALON_REGION,
          name: row.title,
          scope: row.scope,
          status: row.archived_at === null ? "active" : "archived",
          systemRole: row.system_role,
          archivedAt: row.archived_at,
        })),
      },
    });
  }

  async listArtifacts(input: unknown): Promise<EngineeringArtifactListLookup> {
    const request = parseRpcInput(WorkspaceInspectionInputSchema, input, "listArtifacts");
    if (!await resolveInspectionWorkspaceRoute(this.env, request.workspaceId)) {
      return { found: false };
    }
    const workspace = await workspaceStub(this.env, request.workspaceId);
    const result = await workspace.runInspectionSql({
      sql: `SELECT artifact_id, workstream_id, resource_id, mode, stateful,
                   current_version, hostname_stub, updated_at
              FROM artifact_registry
             WHERE workspace_id = ?
             ORDER BY updated_at DESC, artifact_id`,
      bindings: [request.workspaceId],
    });
    return EngineeringArtifactListLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        items: z.array(ArtifactRegistryRowSchema).parse(result.rows).map((row) => ({
          workspaceId: request.workspaceId,
          artifactId: row.artifact_id,
          region: this.env.AVALON_REGION,
          workstreamId: row.workstream_id,
          resourceId: row.resource_id,
          mode: row.mode,
          stateful: row.stateful === 1,
          currentVersion: row.current_version,
          hostnameStub: row.hostname_stub,
          updatedAt: row.updated_at,
        })),
      },
    });
  }

  async resolveWorkspace(input: unknown): Promise<EngineeringWorkspaceTargetLookup> {
    const request = parseRpcInput(WorkspaceInspectionInputSchema, input, "resolveWorkspace");
    const route = await resolveInspectionWorkspaceRoute(this.env, request.workspaceId);
    if (!route) return { found: false };
    return EngineeringWorkspaceTargetLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        authorityGeneration: route.authority_generation,
      },
    });
  }

  async resolveSubstream(input: unknown): Promise<EngineeringSubstreamTargetLookup> {
    const request = parseRpcInput(SubstreamInspectionInputSchema, input, "resolveSubstream");
    const route = await resolveInspectionSubstreamRoute(this.env, request);
    if (!route) return { found: false };
    return EngineeringSubstreamTargetLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        workstreamId: request.workstreamId,
        substreamId: request.substreamId,
        authorityGeneration: route.authority_generation,
      },
    });
  }

  async resolveArtifact(input: unknown): Promise<EngineeringArtifactTargetLookup> {
    const request = parseRpcInput(ArtifactInspectionInputSchema, input, "resolveArtifact");
    const route = await resolveInspectionArtifactRoute(this.env, request);
    if (!route) return { found: false };
    return EngineeringArtifactTargetLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        artifactId: request.artifactId,
        authorityGeneration: route.authority_generation,
      },
    });
  }

  async runWorkspaceSql(input: unknown): Promise<EngineeringSqlLookup> {
    const request = parseRpcInput(WorkspaceSqlInspectionInputSchema, input, "runWorkspaceSql");
    if (!await resolveInspectionWorkspaceRoute(
      this.env,
      request.workspaceId,
      request.authorityGeneration,
    )) return { found: false };
    const workspace = await workspaceStub(this.env, request.workspaceId);
    return EngineeringSqlLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        workstreamId: null,
        substreamId: null,
        result: await workspace.runInspectionSql(request.query),
      },
    });
  }

  async runSubstreamSql(input: unknown): Promise<EngineeringSqlLookup> {
    const request = parseRpcInput(SubstreamSqlInspectionInputSchema, input, "runSubstreamSql");
    const route = await resolveInspectionSubstreamRoute(
      this.env,
      request,
      request.authorityGeneration,
    );
    if (!route) return { found: false };
    const substream = await durableObjectStubForWorkspace(
      this.env,
      this.env.SUBSTREAM_AGENTS,
      request.workspaceId,
      conversationObjectName(
        this.env.AVALON_REGION,
        request.workspaceId,
        request.workstreamId,
        asSubstreamId(request.substreamId),
      ),
    );
    return EngineeringSqlLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        workstreamId: request.workstreamId,
        substreamId: request.substreamId,
        result: await substream.runInspectionSql(request.query),
      },
    });
  }

  async runArtifactSql(input: unknown): Promise<EngineeringSqlLookup> {
    const request = parseRpcInput(ArtifactSqlInspectionInputSchema, input, "runArtifactSql");
    if (!await resolveInspectionArtifactRoute(
      this.env,
      request,
      request.authorityGeneration,
    )) return { found: false };
    // The workspace's own affinity, the way the publish path passes it. The
    // platform honours a location hint only on an object's first lookup and a
    // registered artifact has had one, so this changes nothing here — but
    // passing the fallback would be a lie about where the object belongs.
    const artifact = durableObjectStubForArtifact(
      this.env,
      this.env.ARTIFACT_HOSTS,
      artifactHostDOName(this.env.AVALON_REGION, asArtifactId(request.artifactId)),
      await workspacePlacementAffinity(this.env, request.workspaceId),
    );
    return EngineeringSqlLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        workstreamId: null,
        substreamId: null,
        artifactId: request.artifactId,
        result: await artifact.runInspectionSql(request.query),
      },
    });
  }

  /**
   * Arbitrary SQL against one of this region's D1 databases. D1 has no
   * authority generation to fence on: the binding is the database. Given
   * several statements, D1 runs them all and answers with the last one's.
   */
  async runD1Sql(input: unknown): Promise<EngineeringD1SqlResult> {
    const request = parseRpcInput(D1SqlInspectionInputSchema, input, "runD1Sql");
    const result = await this.env[request.database]
      .prepare(request.query.sql)
      .bind(...request.query.bindings)
      .all<Record<string, unknown>>();
    const rows = result.results.map((row) => Object.fromEntries(
      Object.entries(row).map(([column, value]) => [column, d1InspectionValue(value)]),
    ));
    return EngineeringD1SqlResultSchema.parse({
      region: this.env.AVALON_REGION,
      database: request.database,
      result: {
        columns: Object.keys(rows[0] ?? {}),
        rows,
        rowsRead: result.meta.rows_read,
        rowsWritten: result.meta.rows_written,
      },
    });
  }
}
