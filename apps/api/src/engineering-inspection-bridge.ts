import { asSubstreamId, asWorkspaceId } from "@rally/contracts";
import {
  EngineeringSqlLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringWorkstreamListLookupSchema,
  ListEngineeringWorkspacesInputSchema,
  ListEngineeringWorkspacesResultSchema,
  SubstreamSqlInspectionInputSchema,
  WorkspaceInspectionInputSchema,
  WorkspaceSqlInspectionInputSchema,
  WorkstreamInspectionInputSchema,
  WorkstreamSqlInspectionInputSchema,
  type EngineeringInspectionRpcBinding,
  type EngineeringSqlLookup,
  type EngineeringSubstreamListLookup,
  type EngineeringWorkstreamListLookup,
  type ListEngineeringWorkspacesResult,
} from "@rally/contracts/engineering-inspection";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { substreamAgentName, workspaceDOName } from "./durable-objects/names";
import type { Env } from "./env";
import { durableObjectStubForWorkspace } from "./lib/durable-object-namespace";
import { parseRpcInput } from "./lib/rpc-contracts";

const WorkspaceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  region: z.enum(["global", "eu"]),
  placement_affinity: z.string(),
  authority_state: z.string().nullable(),
}).strict();
type WorkspaceRow = z.infer<typeof WorkspaceRowSchema>;

const WorkstreamRouteRowSchema = z.object({
  workspace_id: z.string(),
  workstream_id: z.string(),
  object_name: z.string(),
}).strict();
type WorkstreamRouteRow = z.infer<typeof WorkstreamRouteRowSchema>;

const WorkstreamDirectoryRowSchema = z.object({
  workstream_id: z.string(),
  title: z.string(),
  scope: z.string(),
  exact_state: z.string(),
  system_kind: z.string().nullable(),
  last_activity_at: z.number().int().nonnegative(),
  archived_at: z.number().int().nonnegative().nullable(),
}).strict();

const SubstreamDirectoryRowSchema = z.object({
  substream_id: z.string(),
}).strict();

async function workspaceRow(env: Env, workspaceId: string): Promise<WorkspaceRow | null> {
  const row = await env.DB.prepare(
    `SELECT workspace.id, workspace.name, workspace.slug, workspace.region,
            workspace.placement_affinity, route.state AS authority_state
       FROM workspaces workspace
       JOIN workspace_product_authority_routes route
         ON route.workspace_id = workspace.id
      WHERE workspace.id = ? AND workspace.region = ?`,
  ).bind(workspaceId, env.AVALON_REGION).first<unknown>();
  return row === null ? null : WorkspaceRowSchema.parse(row);
}

async function workstreamRoute(env: Env, workstreamId: string): Promise<WorkstreamRouteRow | null> {
  const row = await env.DB.prepare(
    `SELECT workspace_id, workstream_id, object_name
       FROM workstream_authority_routes
      WHERE workstream_id = ?`,
  ).bind(workstreamId).first<unknown>();
  return row === null ? null : WorkstreamRouteRowSchema.parse(row);
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

async function workstreamStub(env: Env, route: WorkstreamRouteRow) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    route.workspace_id,
    route.object_name,
  );
}

/**
 * Private regional data-plane surface for the Access-protected engineering MCP.
 * The class is exported as a named WorkerEntrypoint and has no HTTP route.
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
    const rows = z.array(WorkspaceRowSchema).parse(result.results ?? []);
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
    if (!await workspaceRow(this.env, request.workspaceId)) return { found: false };
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
    const route = await workstreamRoute(this.env, request.workstreamId);
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

  async runWorkspaceSql(input: unknown): Promise<EngineeringSqlLookup> {
    const request = parseRpcInput(WorkspaceSqlInspectionInputSchema, input, "runWorkspaceSql");
    if (!await workspaceRow(this.env, request.workspaceId)) return { found: false };
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
    const route = await workstreamRoute(this.env, request.workstreamId);
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
    const route = await workstreamRoute(this.env, request.workstreamId);
    if (!route || route.workspace_id !== request.workspaceId) return { found: false };
    if (request.substreamId !== "0") {
      const workstream = await workstreamStub(this.env, route);
      const directory = await workstream.runInspectionSql({
        sql: `SELECT substream_id FROM substream_directory WHERE substream_id = ?`,
        bindings: [request.substreamId],
      });
      if (directory.rows.length === 0) return { found: false };
    }
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
