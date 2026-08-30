import {
  EngineeringSqlLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringWorkstreamListLookupSchema,
  InspectionSqlBindingSchema,
  ListEngineeringWorkspacesResultSchema,
} from "@rally/contracts/engineering-inspection";
import {
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
  global: T,
  eu: T,
  target: string,
): T & { found: true } {
  const found = [global, eu].filter((result): result is T & { found: true } => result.found);
  if (found.length === 0) throw new Error(`${target} was not found in either Rally region`);
  if (found.length !== 1) throw new Error(`${target} exists in both Rally regions; inspection refused`);
  return found[0]!;
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
    description: "List Rally workspaces from both Global and EU regional identity stores.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => tool(principal, "list_workspaces", {}, async () => {
    const [globalRaw, euRaw] = await Promise.all([
      env.GLOBAL_INSPECTION.listWorkspaces({}),
      env.EU_INSPECTION.listWorkspaces({}),
    ]);
    const global = ListEngineeringWorkspacesResultSchema.parse(globalRaw);
    const eu = ListEngineeringWorkspacesResultSchema.parse(euRaw);
    return [...global.items, ...eu.items].sort((left, right) =>
      left.name.localeCompare(right.name) || left.workspaceId.localeCompare(right.workspaceId));
  }));

  server.registerTool("list_workstreams", {
    description: "List every work stream in the authoritative WorkspaceDO for a workspace ID.",
    inputSchema: { workspaceId: WorkspaceIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId }) => tool(principal, "list_workstreams", { workspace_id: workspaceId }, async () => {
    const [globalRaw, euRaw] = await Promise.all([
      env.GLOBAL_INSPECTION.listWorkstreams({ workspaceId }),
      env.EU_INSPECTION.listWorkstreams({ workspaceId }),
    ]);
    const found = oneRegionalResult(
      EngineeringWorkstreamListLookupSchema.parse(globalRaw),
      EngineeringWorkstreamListLookupSchema.parse(euRaw),
      `Workspace ${workspaceId}`,
    );
    return found.value;
  }));

  server.registerTool("list_substreams", {
    description: "List main substream 0 and every child substream for a work-stream ID.",
    inputSchema: { workstreamId: WorkstreamIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workstreamId }) => tool(principal, "list_substreams", { workstream_id: workstreamId }, async () => {
    const [globalRaw, euRaw] = await Promise.all([
      env.GLOBAL_INSPECTION.listSubstreams({ workstreamId }),
      env.EU_INSPECTION.listSubstreams({ workstreamId }),
    ]);
    const found = oneRegionalResult(
      EngineeringSubstreamListLookupSchema.parse(globalRaw),
      EngineeringSubstreamListLookupSchema.parse(euRaw),
      `Work stream ${workstreamId}`,
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
      const [globalRaw, euRaw] = await Promise.all([
        env.GLOBAL_INSPECTION.runWorkspaceSql({ workspaceId, query: { sql, bindings } }),
        env.EU_INSPECTION.runWorkspaceSql({ workspaceId, query: { sql, bindings } }),
      ]);
      return oneRegionalResult(
        EngineeringSqlLookupSchema.parse(globalRaw),
        EngineeringSqlLookupSchema.parse(euRaw),
        `Workspace ${workspaceId}`,
      ).value;
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
      const [globalRaw, euRaw] = await Promise.all([
        env.GLOBAL_INSPECTION.runWorkstreamSql({ workstreamId, query: { sql, bindings } }),
        env.EU_INSPECTION.runWorkstreamSql({ workstreamId, query: { sql, bindings } }),
      ]);
      return oneRegionalResult(
        EngineeringSqlLookupSchema.parse(globalRaw),
        EngineeringSqlLookupSchema.parse(euRaw),
        `Work stream ${workstreamId}`,
      ).value;
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
      const [globalRaw, euRaw] = await Promise.all([
        env.GLOBAL_INSPECTION.runSubstreamSql({
          workspaceId,
          workstreamId,
          substreamId,
          query: { sql, bindings },
        }),
        env.EU_INSPECTION.runSubstreamSql({
          workspaceId,
          workstreamId,
          substreamId,
          query: { sql, bindings },
        }),
      ]);
      return oneRegionalResult(
        EngineeringSqlLookupSchema.parse(globalRaw),
        EngineeringSqlLookupSchema.parse(euRaw),
        `Substream ${substreamId}`,
      ).value;
    },
  ));

  return server;
}
