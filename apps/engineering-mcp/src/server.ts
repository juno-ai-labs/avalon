import {
  EngineeringSqlLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringSubstreamTargetLookupSchema,
  EngineeringWorkspaceTargetLookupSchema,
  EngineeringWorkstreamListLookupSchema,
  EngineeringWorkstreamTargetLookupSchema,
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

type Lookup<T> = { found: false } | { found: true; value: T };

function oneRegionalTarget<T>(
  env: Env,
  global: Lookup<T>,
  eu: Lookup<T>,
  target: string,
): { binding: Env["GLOBAL_INSPECTION"]; value: T } {
  if (global.found && eu.found) {
    throw new Error(`${target} exists in both Rally regions; inspection refused`);
  }
  if (global.found) return { binding: env.GLOBAL_INSPECTION, value: global.value };
  if (eu.found) return { binding: env.EU_INSPECTION, value: eu.value };
  throw new Error(`${target} was not found in either Rally region`);
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
  bindings: z.array(z.union([z.string(), z.number().finite(), z.null()])).optional().describe(
    "Positional values for ? parameters, in order.",
  ),
};

// The MCP SDK consumes Zod v4 schemas. Parse through the shared v3 contracts
// in a transform so the callback still receives Rally's branded identifiers.
const workspaceIdInputSchema = z.string().uuid().transform((value) => WorkspaceIdSchema.parse(value));
const workstreamIdInputSchema = z.string().uuid().transform((value) => WorkstreamIdSchema.parse(value));
const substreamIdInputSchema = z.union([
  z.literal("0"),
  z.string().uuid(),
]).transform((value) => SubstreamIdSchema.parse(value));

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
    inputSchema: { workspaceId: workspaceIdInputSchema },
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
    inputSchema: { workstreamId: workstreamIdInputSchema },
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
    inputSchema: { workspaceId: workspaceIdInputSchema, ...sqlInputSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workspaceId, sql, bindings = [] }) => tool(
    principal,
    "run_workspace_sql",
    { workspace_id: workspaceId },
    async () => {
      const [globalRaw, euRaw] = await Promise.all([
        env.GLOBAL_INSPECTION.resolveWorkspace({ workspaceId }),
        env.EU_INSPECTION.resolveWorkspace({ workspaceId }),
      ]);
      const resolved = oneRegionalTarget(
        env,
        EngineeringWorkspaceTargetLookupSchema.parse(globalRaw),
        EngineeringWorkspaceTargetLookupSchema.parse(euRaw),
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
    inputSchema: { workstreamId: workstreamIdInputSchema, ...sqlInputSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workstreamId, sql, bindings = [] }) => tool(
    principal,
    "run_workstream_sql",
    { workstream_id: workstreamId },
    async () => {
      const [globalRaw, euRaw] = await Promise.all([
        env.GLOBAL_INSPECTION.resolveWorkstream({ workstreamId }),
        env.EU_INSPECTION.resolveWorkstream({ workstreamId }),
      ]);
      const resolved = oneRegionalTarget(
        env,
        EngineeringWorkstreamTargetLookupSchema.parse(globalRaw),
        EngineeringWorkstreamTargetLookupSchema.parse(euRaw),
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
      workspaceId: workspaceIdInputSchema,
      workstreamId: workstreamIdInputSchema,
      substreamId: substreamIdInputSchema,
      ...sqlInputSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workspaceId, workstreamId, substreamId, sql, bindings = [] }) => tool(
    principal,
    "run_substream_sql",
    { workspace_id: workspaceId, workstream_id: workstreamId, substream_id: substreamId },
    async () => {
      const [globalRaw, euRaw] = await Promise.all([
        env.GLOBAL_INSPECTION.resolveSubstream({ workspaceId, workstreamId, substreamId }),
        env.EU_INSPECTION.resolveSubstream({ workspaceId, workstreamId, substreamId }),
      ]);
      const resolved = oneRegionalTarget(
        env,
        EngineeringSubstreamTargetLookupSchema.parse(globalRaw),
        EngineeringSubstreamTargetLookupSchema.parse(euRaw),
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

  return server;
}
