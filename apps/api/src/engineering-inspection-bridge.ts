import { asSubstreamId, asWorkspaceId } from "@rally/contracts";
import {
  EngineeringSqlLookupSchema,
  EngineeringSubstreamTargetLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringWorkspaceTargetLookupSchema,
  EngineeringWorkstreamTargetLookupSchema,
  EngineeringWorkstreamListLookupSchema,
  ListEngineeringWorkspacesInputSchema,
  ListEngineeringWorkspacesResultSchema,
  SubstreamSqlInspectionInputSchema,
  SubstreamInspectionInputSchema,
  WorkspaceInspectionInputSchema,
  WorkspaceSqlInspectionInputSchema,
  WorkstreamInspectionInputSchema,
  WorkstreamSqlInspectionInputSchema,
  type EngineeringInspectionRpcBinding,
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

import { substreamAgentName, workspaceDOName } from "./durable-objects/names";
import {
  resolveInspectionWorkspaceRoute,
  resolveInspectionWorkstreamRoute,
  type InspectionWorkstreamRoute,
} from "./engineering-inspection-routes";
import type { Env } from "./env";
import { durableObjectStubForWorkspace } from "./lib/durable-object-namespace";
import { parseRpcInput } from "./lib/rpc-contracts";

const WorkspaceInventoryRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  region: z.enum(["global", "eu"]),
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
      substreamAgentName(
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
}
