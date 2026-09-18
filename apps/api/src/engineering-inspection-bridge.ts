import { RegionSchema } from "@rally/contracts/regions";
import { asArtifactId, asSubstreamId, asWorkspaceId } from "@rally/contracts";
import {
  ArtifactInspectionInputSchema,
  ArtifactSqlInspectionInputSchema,
  EngineeringArtifactListLookupSchema,
  EngineeringArtifactTargetLookupSchema,
  EngineeringSidekickListLookupSchema,
  EngineeringSidekickTargetLookupSchema,
  EngineeringSqlLookupSchema,
  EngineeringSubstreamTargetLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringWorkspaceTargetLookupSchema,
  EngineeringWorkstreamTargetLookupSchema,
  EngineeringWorkstreamListLookupSchema,
  ListEngineeringWorkspacesInputSchema,
  ListEngineeringWorkspacesResultSchema,
  SidekickInspectionInputSchema,
  SidekickSqlInspectionInputSchema,
  SubstreamSqlInspectionInputSchema,
  SubstreamInspectionInputSchema,
  WorkspaceInspectionInputSchema,
  WorkspaceSqlInspectionInputSchema,
  WorkstreamInspectionInputSchema,
  WorkstreamSqlInspectionInputSchema,
  type EngineeringInspectionRpcBinding,
  type EngineeringArtifactListLookup,
  type EngineeringArtifactTargetLookup,
  type EngineeringSidekickListLookup,
  type EngineeringSidekickTargetLookup,
  type EngineeringSqlLookup,
  type EngineeringSubstreamListLookup,
  type EngineeringSubstreamTargetLookup,
  type EngineeringWorkspaceTargetLookup,
  type EngineeringWorkstreamListLookup,
  type EngineeringWorkstreamTargetLookup,
  type ListEngineeringWorkspacesResult,
} from "@rally/contracts/engineering-inspection";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import {
  artifactHostDOName,
  automationDOName,
  conversationObjectName,
  workspaceDOName,
} from "./durable-objects/names";
import {
  resolveInspectionWorkspaceRoute,
  resolveInspectionWorkstreamRoute,
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

const SidekickDirectoryRowSchema = z.strictObject({
  automation_id: z.string(),
  lifecycle: z.string(),
  scope: z.string(),
  owning_workstream_id: z.string().nullable(),
  title: z.string(),
  next_run_at: z.number().int().nullable(),
  projected_at: z.number().int().nonnegative(),
});

async function workspaceStub(env: Env, workspaceId: string) {
  const brandedWorkspaceId = asWorkspaceId(workspaceId);
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, brandedWorkspaceId),
  );
}

async function workstreamStub(env: Env, route: InspectionWorkstreamRoute) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    route.workspace_id,
    route.object_name,
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
  const workstream = await workstreamStub(env, route);
  const directory = await workstream.runInspectionSql({
    sql: `SELECT substream_id FROM substream_directory WHERE substream_id = ?`,
    bindings: [input.substreamId],
  });
  return directory.rows.length === 0 ? null : route;
}

/**
 * A Sidekick is fenced by its workspace, because that is what owns both halves
 * of its identity: the directory row that proves the object exists, and the
 * workspace id its Durable Object is named by.
 *
 * The directory is consulted for the same reason a child substream's is. A
 * SidekickDO shares the parent-id namespace with every work stream — both are
 * bare UUIDs in `workstream_authority_routes` — so an active route alone cannot
 * tell the two apart, and resolving a work-stream id here would name, and
 * thereby create, an empty SidekickDO that never existed. The directory row is
 * the only thing in reach that distinguishes them.
 *
 * It costs a real object: a Sidekick created since the last projection is
 * refused until its directory row lands. Refusing an object that exists is the
 * recoverable half of that trade; materializing one that does not is not.
 */
async function resolveInspectionSidekickRoute(
  env: Env,
  input: { workspaceId: string; sidekickId: string },
  expectedGeneration?: number,
): Promise<InspectionWorkspaceRoute | null> {
  const route = await resolveInspectionWorkspaceRoute(
    env,
    input.workspaceId,
    expectedGeneration,
  );
  if (!route) return null;
  const workspace = await workspaceStub(env, input.workspaceId);
  const directory = await workspace.runInspectionSql({
    sql: `SELECT automation_id FROM automation_directory
           WHERE automation_id = ? AND workspace_id = ?`,
    bindings: [input.sidekickId, input.workspaceId],
  });
  return directory.rows.length === 0 ? null : route;
}

/**
 * An artifact is fenced by its workspace for the same reason a Sidekick is, and
 * with more need of it: ArtifactHostDO's name carries no workspace segment at
 * all, so nothing about the name itself proves the caller may reach it, and
 * every artifact UUID in the account is a valid object name.
 *
 * `artifact_registry` lives in WorkspaceDO beside the resource authority rather
 * than in D1, and it is the only place that says which artifacts a workspace
 * has. An unregistered UUID is refused here rather than materializing an empty
 * supervisor.
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
  async listWorkspaces(input: Record<string, never>): Promise<ListEngineeringWorkspacesResult> {
    parseRpcInput(ListEngineeringWorkspacesInputSchema, input, "listWorkspaces");
    const result = await this.env.DB.prepare(
      `SELECT workspace.id, workspace.name, workspace.slug, workspace.region,
              workspace.placement_affinity, route.state AS authority_state
         FROM workspaces workspace
         LEFT JOIN workspace_product_authority_routes route
           ON route.workspace_id = workspace.id
        WHERE workspace.region = ?
        ORDER BY workspace.name COLLATE NOCASE, workspace.id`,
    ).bind(this.env.AVALON_REGION).all<unknown>();
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

  async listWorkstreams(input: unknown): Promise<EngineeringWorkstreamListLookup> {
    const request = parseRpcInput(WorkspaceInspectionInputSchema, input, "listWorkstreams");
    if (!await resolveInspectionWorkspaceRoute(this.env, request.workspaceId)) {
      return { found: false };
    }
    const workspace = await workspaceStub(this.env, request.workspaceId);
    const result = await workspace.runInspectionSql({
      sql: `SELECT workstream_id, title, scope, exact_state, system_kind,
                   last_activity_at, archived_at
              FROM workspace_workstream_directory
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
    const workstream = await workstreamStub(this.env, route);
    const result = await workstream.runInspectionSql({
      sql: `SELECT '0' AS substream_id
            UNION
            SELECT substream_id FROM substream_directory
            ORDER BY substream_id`,
      bindings: [],
    });
    return EngineeringSubstreamListLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: route.workspace_id,
        workstreamId: route.workstream_id,
        items: z.array(SubstreamDirectoryRowSchema).parse(result.rows).map((row) => ({
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

  async resolveWorkstream(input: unknown): Promise<EngineeringWorkstreamTargetLookup> {
    const request = parseRpcInput(WorkstreamInspectionInputSchema, input, "resolveWorkstream");
    const route = await resolveInspectionWorkstreamRoute(this.env, request.workstreamId);
    if (!route) return { found: false };
    return EngineeringWorkstreamTargetLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: route.workspace_id,
        workstreamId: route.workstream_id,
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

  async resolveSidekick(input: unknown): Promise<EngineeringSidekickTargetLookup> {
    const request = parseRpcInput(SidekickInspectionInputSchema, input, "resolveSidekick");
    const route = await resolveInspectionSidekickRoute(this.env, request);
    if (!route) return { found: false };
    return EngineeringSidekickTargetLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        sidekickId: request.sidekickId,
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

  async runWorkstreamSql(input: unknown): Promise<EngineeringSqlLookup> {
    const request = parseRpcInput(WorkstreamSqlInspectionInputSchema, input, "runWorkstreamSql");
    const route = await resolveInspectionWorkstreamRoute(
      this.env,
      request.workstreamId,
      request.authorityGeneration,
    );
    if (!route) return { found: false };
    const workstream = await workstreamStub(this.env, route);
    return EngineeringSqlLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: route.workspace_id,
        workstreamId: route.workstream_id,
        substreamId: null,
        result: await workstream.runInspectionSql(request.query),
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

  async runSidekickSql(input: unknown): Promise<EngineeringSqlLookup> {
    const request = parseRpcInput(SidekickSqlInspectionInputSchema, input, "runSidekickSql");
    if (!await resolveInspectionSidekickRoute(
      this.env,
      request,
      request.authorityGeneration,
    )) return { found: false };
    const sidekick = await durableObjectStubForWorkspace(
      this.env,
      this.env.AUTOMATION_DOS,
      request.workspaceId,
      automationDOName(this.env.AVALON_REGION, request.workspaceId, request.sidekickId),
    );
    return EngineeringSqlLookupSchema.parse({
      found: true,
      value: {
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        workstreamId: null,
        substreamId: null,
        sidekickId: request.sidekickId,
        result: await sidekick.runInspectionSql(request.query),
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
}
