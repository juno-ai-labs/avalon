import { configuredRegions, regionConfiguration } from "@rally/contracts/regions";
import {
  EngineeringArtifactListLookupSchema,
  EngineeringArtifactTargetLookupSchema,
  EngineeringSidekickListLookupSchema,
  EngineeringSidekickTargetLookupSchema,
  EngineeringSqlLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringSubstreamTargetLookupSchema,
  EngineeringWorkspaceTargetLookupSchema,
  EngineeringWorkstreamListLookupSchema,
  EngineeringWorkstreamTargetLookupSchema,
  InspectionSqlBindingSchema,
  ListEngineeringWorkspacesResultSchema,
} from "@rally/contracts/engineering-inspection";
import {
  ArtifactIdSchema,
  AutomationIdSchema,
  SubstreamIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "@rally/contracts";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AccessPrincipal } from "./access";
import type { Env } from "./env";

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): ToolResult {
  return {
    content: [{
      type: "text",
      text: error instanceof Error ? error.message : "Engineering inspection failed",
    }],
    isError: true,
  };
}

function oneRegionalResult<T extends { found: boolean }>(
  results: T[],
  target: string,
): T & { found: true } {
  const found = results.filter((result): result is T & { found: true } => result.found);
  if (found.length === 0) throw new Error(`${target} was not found in any configured Rally region`);
  if (found.length !== 1) throw new Error(`${target} exists in multiple Rally regions; inspection refused`);
  return found[0]!;
}

type Lookup<T> = { found: false } | { found: true; value: T };

function inspectionBindings(env: Env) {
  return configuredRegions.map((region) => {
    const binding = env[`${regionConfiguration(region).bindingPrefix}_INSPECTION`];
    if (!binding) throw new Error('regional_inspection_unavailable');
    return binding;
  });
}
function oneRegionalTarget<T>(
  env: Env,
  results: Lookup<T>[],
  target: string,
): { binding: Env["GLOBAL_INSPECTION"]; value: T } {
  const bindings = inspectionBindings(env);
  const found = results.flatMap((result, index) => result.found ? [{ binding: bindings[index]!, value: result.value }] : []);
  if (found.length !== 1) throw new Error(`${target} must resolve to one region`);
  return found[0]!;
}

function executedSql(value: unknown, target: string) {
  const result = EngineeringSqlLookupSchema.parse(value);
  if (!result.found) {
    throw new Error(`${target} authority changed before SQL execution; inspection refused`);
  }
  return result.value;
}

async function tool(
  principal: AccessPrincipal,
  name: string,
  target: Record<string, string | undefined>,
  operation: () => Promise<unknown>,
): Promise<ToolResult> {
  try {
    const value = await operation();
    console.log(JSON.stringify({
      event: "engineering_mcp_tool_succeeded",
      actor_subject: principal.subject,
      actor_email: principal.email,
      tool: name,
      ...target,
    }));
    return jsonResult(value);
  } catch (error) {
    console.error(JSON.stringify({
      event: "engineering_mcp_tool_failed",
      actor_subject: principal.subject,
      actor_email: principal.email,
      tool: name,
      ...target,
      error_code: "tool_failed",
    }));
    return errorResult(error);
  }
}

const sqlInputSchema = {
  sql: z.string().min(1).describe(
    "SQLite statement or semicolon-separated statements. This may read or mutate the target database.",
  ),
  bindings: InspectionSqlBindingSchema.array().optional().describe(
    "Positional values for ? parameters, in order.",
  ),
};

export function createEngineeringMcpServer(env: Env, principal: AccessPrincipal): McpServer {
  const server = new McpServer({ name: "Rally engineering", version: "1.0.0" });

  server.registerTool("list_workspaces", {
    description: "List Rally workspaces from configured regional identity stores.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => tool(principal, "list_workspaces", {}, async () => {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.listWorkspaces({})));
    return results.flatMap((result) => ListEngineeringWorkspacesResultSchema.parse(result).items).sort((left, right) =>
      left.name.localeCompare(right.name) || left.workspaceId.localeCompare(right.workspaceId));
  }));

  server.registerTool("list_workstreams", {
    description: "List every work stream in the authoritative WorkspaceDO for a workspace ID.",
    inputSchema: { workspaceId: WorkspaceIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId }) => tool(principal, "list_workstreams", { workspace_id: workspaceId }, async () => {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.listWorkstreams({ workspaceId })));
    const found = oneRegionalResult(
      results.map((result) => EngineeringWorkstreamListLookupSchema.parse(result)),
      `Workspace ${workspaceId}`,
    );
    return found.value;
  }));

  server.registerTool("list_substreams", {
    description: "List main substream 0 and every child substream for a work-stream ID.",
    inputSchema: { workstreamId: WorkstreamIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workstreamId }) => tool(principal, "list_substreams", { workstream_id: workstreamId }, async () => {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.listSubstreams({ workstreamId })));
    const found = oneRegionalResult(
      results.map((result) => EngineeringSubstreamListLookupSchema.parse(result)),
      `Work stream ${workstreamId}`,
    );
    return found.value;
  }));

  server.registerTool("list_sidekicks", {
    description: "List every Sidekick in the authoritative WorkspaceDO for a workspace ID, in every lifecycle including deleted.",
    inputSchema: { workspaceId: WorkspaceIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId }) => tool(principal, "list_sidekicks", { workspace_id: workspaceId }, async () => {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.listSidekicks({ workspaceId })));
    const found = oneRegionalResult(
      results.map((result) => EngineeringSidekickListLookupSchema.parse(result)),
      `Workspace ${workspaceId}`,
    );
    return found.value;
  }));

  server.registerTool("list_artifacts", {
    description: "List every live web artifact in the authoritative WorkspaceDO registry for a workspace ID.",
    inputSchema: { workspaceId: WorkspaceIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId }) => tool(principal, "list_artifacts", { workspace_id: workspaceId }, async () => {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.listArtifacts({ workspaceId })));
    const found = oneRegionalResult(
      results.map((result) => EngineeringArtifactListLookupSchema.parse(result)),
      `Workspace ${workspaceId}`,
    );
    return found.value;
  }));

  server.registerTool("run_workspace_sql", {
    description: "Run arbitrary SQLite against a WorkspaceDO. Statements may mutate production state.",
    inputSchema: { workspaceId: WorkspaceIdSchema, ...sqlInputSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workspaceId, sql, bindings = [] }) => tool(
    principal,
    "run_workspace_sql",
    { workspace_id: workspaceId },
    async () => {
      const results = await Promise.all(inspectionBindings(env).map((binding) => binding.resolveWorkspace({ workspaceId })));
      const resolved = oneRegionalTarget(
        env,
        results.map((result) => EngineeringWorkspaceTargetLookupSchema.parse(result)),
        `Workspace ${workspaceId}`,
      );
      return executedSql(await resolved.binding.runWorkspaceSql({
        workspaceId,
        authorityGeneration: resolved.value.authorityGeneration,
        query: { sql, bindings },
      }), `Workspace ${workspaceId}`);
    },
  ));

  server.registerTool("run_workstream_sql", {
    description: "Run arbitrary SQLite against a WorkstreamDO. Statements may mutate production state.",
    inputSchema: { workstreamId: WorkstreamIdSchema, ...sqlInputSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workstreamId, sql, bindings = [] }) => tool(
    principal,
    "run_workstream_sql",
    { workstream_id: workstreamId },
    async () => {
      const results = await Promise.all(inspectionBindings(env).map((binding) => binding.resolveWorkstream({ workstreamId })));
      const resolved = oneRegionalTarget(
        env,
        results.map((result) => EngineeringWorkstreamTargetLookupSchema.parse(result)),
        `Work stream ${workstreamId}`,
      );
      return executedSql(await resolved.binding.runWorkstreamSql({
        workstreamId,
        authorityGeneration: resolved.value.authorityGeneration,
        query: { sql, bindings },
      }), `Work stream ${workstreamId}`);
    },
  ));

  server.registerTool("run_substream_sql", {
    description: "Run arbitrary SQLite against a SubstreamAgent. Parent IDs are required because they are part of the Durable Object name. Statements may mutate production state.",
    inputSchema: {
      workspaceId: WorkspaceIdSchema,
      workstreamId: WorkstreamIdSchema,
      substreamId: SubstreamIdSchema,
      ...sqlInputSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workspaceId, workstreamId, substreamId, sql, bindings = [] }) => tool(
    principal,
    "run_substream_sql",
    { workspace_id: workspaceId, workstream_id: workstreamId, substream_id: substreamId },
    async () => {
      const results = await Promise.all(inspectionBindings(env).map((binding) => binding.resolveSubstream({ workspaceId, workstreamId, substreamId })));
      const resolved = oneRegionalTarget(
        env,
        results.map((result) => EngineeringSubstreamTargetLookupSchema.parse(result)),
        `Substream ${substreamId}`,
      );
      return executedSql(await resolved.binding.runSubstreamSql({
        workspaceId,
        workstreamId,
        substreamId,
        authorityGeneration: resolved.value.authorityGeneration,
        query: { sql, bindings },
      }), `Substream ${substreamId}`);
    },
  ));

  server.registerTool("run_sidekick_sql", {
    description: "Run arbitrary SQLite against a SidekickDO — a Sidekick's own object, not its conversation. The workspace ID is required because it is part of the Durable Object name. Statements may mutate production state.",
    inputSchema: {
      workspaceId: WorkspaceIdSchema,
      sidekickId: AutomationIdSchema,
      ...sqlInputSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workspaceId, sidekickId, sql, bindings = [] }) => tool(
    principal,
    "run_sidekick_sql",
    { workspace_id: workspaceId, sidekick_id: sidekickId },
    async () => {
      const results = await Promise.all(inspectionBindings(env).map((binding) => binding.resolveSidekick({ workspaceId, sidekickId })));
      const resolved = oneRegionalTarget(
        env,
        results.map((result) => EngineeringSidekickTargetLookupSchema.parse(result)),
        `Sidekick ${sidekickId}`,
      );
      return executedSql(await resolved.binding.runSidekickSql({
        workspaceId,
        sidekickId,
        authorityGeneration: resolved.value.authorityGeneration,
        query: { sql, bindings },
      }), `Sidekick ${sidekickId}`);
    },
  ));

  server.registerTool("run_artifact_sql", {
    description: "Run arbitrary SQLite against an ArtifactHostDO — the artifact's supervisor, holding its current version, viewer sessions and error log. A stateful artifact's own tables live in a separate facet database this tool does not reach. The workspace ID is required: the Durable Object name carries none. Statements may mutate production state.",
    inputSchema: {
      workspaceId: WorkspaceIdSchema,
      artifactId: ArtifactIdSchema,
      ...sqlInputSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workspaceId, artifactId, sql, bindings = [] }) => tool(
    principal,
    "run_artifact_sql",
    { workspace_id: workspaceId, artifact_id: artifactId },
    async () => {
      const results = await Promise.all(inspectionBindings(env).map((binding) => binding.resolveArtifact({ workspaceId, artifactId })));
      const resolved = oneRegionalTarget(
        env,
        results.map((result) => EngineeringArtifactTargetLookupSchema.parse(result)),
        `Artifact ${artifactId}`,
      );
      return executedSql(await resolved.binding.runArtifactSql({
        workspaceId,
        artifactId,
        authorityGeneration: resolved.value.authorityGeneration,
        query: { sql, bindings },
      }), `Artifact ${artifactId}`);
    },
  ));

  return server;
}
