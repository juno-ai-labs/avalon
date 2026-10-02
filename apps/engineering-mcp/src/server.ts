import { configuredRegions, regionConfiguration } from "@rally/contracts/regions";
import {
  EngineeringArtifactListLookupSchema,
  EngineeringArtifactTargetLookupSchema,
  EngineeringSidekickListLookupSchema,
  EngineeringSidekickTargetLookupSchema,
  EngineeringSpaceListLookupSchema,
  EngineeringSqlLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringSubstreamTargetLookupSchema,
  EngineeringWorkspaceTargetLookupSchema,
  EngineeringWorkstreamListLookupSchema,
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
import { platformErrorCode } from "@rally/contracts/platform-diagnostics";
import { isDiagnosticCode, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ManagedFlagUpdateSchema,
  ManagedModelUpdateSchema,
  type FlagAdministrationResult,
} from "../../ace/src/protocol";
import type { AccessPrincipal } from "./access";
import type { Env } from "./env";

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** A refusal this server decided, with the code its log names it by. */
class InspectionRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InspectionRefusal";
  }
}

/**
 * Why a tool failed, in a form a log field can carry: this server's own
 * refusal, a schema rejection's paths, a code a regional object composed, or
 * the platform failure behind a SQL statement. The message is returned to the
 * engineer who ran the tool and stays off the log, since a SQL error can quote
 * what the statement touched.
 */
function toolErrorCode(error: unknown, tool: string): string {
  if (error instanceof InspectionRefusal) return error.code;
  const schema = zodDiagnosticCode(error, tool);
  if (schema) return schema;
  if (!(error instanceof Error)) return "tool_failed";
  if (isDiagnosticCode(error.message)) return error.message;
  const platform = platformErrorCode(error);
  return platform ? `tool_failed:${platform}` : "tool_failed";
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
  if (found.length === 0) throw new InspectionRefusal("target_not_found", `${target} was not found in any configured Rally region`);
  if (found.length !== 1) throw new InspectionRefusal("target_in_multiple_regions", `${target} exists in multiple Rally regions; inspection refused`);
  return found[0]!;
}

type Lookup<T> = { found: false } | { found: true; value: T };

function inspectionBindings(env: Env) {
  return configuredRegions.map((region) => {
    const binding = env[`${regionConfiguration(region).bindingPrefix}_INSPECTION`];
    if (!binding) throw new InspectionRefusal("regional_inspection_unavailable", "regional_inspection_unavailable");
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
  if (found.length !== 1) throw new InspectionRefusal("target_not_in_one_region", `${target} must resolve to one region`);
  return found[0]!;
}

function executedSql(value: unknown, target: string) {
  const result = EngineeringSqlLookupSchema.parse(value);
  if (!result.found) {
    throw new InspectionRefusal(
      "target_authority_changed",
      `${target} authority changed before SQL execution; inspection refused`,
    );
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
      error_name: error instanceof Error ? error.name : typeof error,
      error_code: toolErrorCode(error, name),
    }));
    return errorResult(error);
  }
}

/** Ace's answer, or the refusal it named, under Ace's code. */
function administered<T>(result: FlagAdministrationResult<T>): T {
  if (!result.ok) throw new InspectionRefusal(result.code, result.message);
  return result.value;
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

  server.registerTool("list_spaces", {
    description: "List every Space in the authoritative WorkspaceDO for a workspace ID, archived Spaces included. A Space groups Channels; its parent state lives in the WorkspaceDO and it has no message feed. Until the Space directory projection ships, the list is empty for every workspace, so an empty answer here does not mean the workspace has no Spaces.",
    inputSchema: { workspaceId: WorkspaceIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId }) => tool(principal, "list_spaces", { workspace_id: workspaceId }, async () => {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.listSpaces({ workspaceId })));
    const found = oneRegionalResult(
      results.map((result) => EngineeringSpaceListLookupSchema.parse(result)),
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

  server.registerTool("list_feature_flags", {
    description: "List every product feature flag Ace manages, with what it controls, its provisioned default, and its live Cloudflare Flagship definition (enabled state, default variation, and ordered targeting rules).",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => tool(principal, "list_feature_flags", {}, async () =>
    administered(await env.FLAG_ADMINISTRATION.listProductFlags())));

  server.registerTool("update_feature_flag", {
    description: "Replace a managed product feature flag's whole Flagship definition: description, enabled state, default variation, and ordered targeting rules. Rules and fields left out are removed, so read the flag with list_feature_flags first and send it back with your change. Connected desktop clients are notified after Flagship's propagation window. Changes production for every user the rules reach.",
    inputSchema: ManagedFlagUpdateSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, (update) => tool(principal, "update_feature_flag", { flag_key: update.key }, async () =>
    administered(await env.FLAG_ADMINISTRATION.updateProductFlag({
      actor: { subject: principal.subject },
      update,
    }))));

  server.registerTool("list_model_flags", {
    description: "List every agent model-routing flag Ace manages: the agent role, what it runs, its checked-in default route, and its live Flagship definition. A role's served route is the value of the flag's default variation unless a targeting rule picks another.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => tool(principal, "list_model_flags", {}, async () =>
    administered(await env.FLAG_ADMINISTRATION.listModelFlags())));

  server.registerTool("update_model_flag", {
    description: "Replace the route plan (primary OpenRouter model and ordered fallbacks) in an agent role's model flag's default variation. Every model id is checked against OpenRouter first; targeting rules and other variations are kept. New runs pick up the change on their next evaluation.",
    inputSchema: ManagedModelUpdateSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (update) => tool(principal, "update_model_flag", { agent_role: update.role }, async () =>
    administered(await env.FLAG_ADMINISTRATION.updateModelRouting({
      actor: { subject: principal.subject },
      update,
    }))));

  return server;
}
