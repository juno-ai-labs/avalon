import { InspectOrgBillingSchema, OrgBillingResultSchema, ChangeSubscriptionSchema, RefundPaymentSchema, CorrectInvoiceSchema, InspectBillingCatalogSchema, CreateBillingPriceSchema, CreateBillingCouponSchema, ConfigureBillingCatalogSchema, BillingCatalogInspectionSchema, BillingMutationResultSchema } from "@rally/contracts/billing-admin";
import { BillingCreditsSchema, OverageCreditSchema, TrialMonthsGrantSchema } from "@rally/contracts/billing";
import { inspectQueues, peekDeadLetters } from "./queues";
import { configuredRegions, regionConfiguration } from "@rally/contracts/regions";
import {
  GrantEngineeringTrialMonthsInputSchema,
  InspectEngineeringCreditsInputSchema, GrantEngineeringCreditInputSchema, ExpireEngineeringCreditInputSchema,
  InspectEngineeringOrgSettingsInputSchema,
  UpdateEngineeringOrgSettingsInputSchema,
  EngineeringOrgSettingsResultSchema,
  InspectEngineeringUsageInputSchema,
  ChangeEngineeringPlanInputSchema,
  EngineeringUsageResultSchema,
  EngineeringPasswordUserInputSchema,
  EngineeringProvisionPasswordResultSchema,
  EngineeringRevokePasswordResultSchema,
  EngineeringArtifactListLookupSchema,
  EngineeringArtifactTargetLookupSchema,
  EngineeringD1DatabaseSchema,
  EngineeringD1SqlResultSchema,
  CreateEngineeringOrgInputSchema,
  CreateEngineeringOrgResultSchema,
  SendEngineeringMessageInputSchema,
  SendEngineeringMessageResultSchema,
  ArchiveEngineeringSidekickResultSchema,
  SetEngineeringSidekickPausedInputSchema,
  SetEngineeringSidekickPausedResultSchema,
  RetireEngineeringOrgInputSchema,
  RetireEngineeringOrgResultSchema,
  ReadEngineeringConversationInputSchema,
  EngineeringTextResultSchema,
  EngineeringSidekickListLookupSchema,
  EngineeringSqlLookupSchema,
  EngineeringCanvasListLookupSchema,
  EngineeringConversationTargetLookupSchema,
  EngineeringWorkspaceTargetLookupSchema,
  InspectionSqlBindingSchema,
  ListEngineeringWorkspacesResultSchema,
  SearchEngineeringOrganizationsInputSchema,
  SearchEngineeringUsersInputSchema,
} from "@rally/contracts/engineering-inspection";
import {
  ArtifactIdSchema,
  IdSchema,
  SubstreamIdSchema,
  WorkspaceIdSchema,
} from "@rally/contracts";
import { platformErrorCode } from "@rally/contracts/platform-diagnostics";
import { isCodeShaped, isDiagnosticCode, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { hasStableAccessSubject, type AccessPrincipal } from "./access";
import type { Env } from "./env";
import { CloudflareQueryError } from "./cloudflare-api";
import { LAKEHOUSE_TABLES, LAKEHOUSES, queryLakehouse } from "./lakehouse";
import { observabilityQueryInputSchema, queryObservability } from "./observability";
import { organizationPage, organizationPageInputSchema } from "./organizations";
import { userPage, userPageInputSchema } from "./users";
import { acceptsTasks, createTaskCarrier, registerTaskMethods, type EngineeringTaskInput } from "./tasks";
import { ENGINEERING_MCP_SERVER_INSTRUCTIONS } from "@rally/prompts/engineering-mcp/server-instructions";

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
export function toolErrorCode(error: unknown, tool: string): string {
  if (error instanceof InspectionRefusal || error instanceof CloudflareQueryError) return error.code;
  const schema = zodDiagnosticCode(error, tool);
  if (schema) return schema;
  if (!(error instanceof Error)) return "tool_failed";
  // This prefix is emitted only for the regional product adapter's ApiError
  // code, never its message (which may contain product data).
  if (error.message.startsWith("engineering_operation_failed:") && isCodeShaped(error.message)) return error.message;
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

function billingRegionBinding(env: Env, region: Parameters<typeof regionConfiguration>[0]) {
  const binding = env[`${regionConfiguration(region).bindingPrefix}_INSPECTION`];
  if (!binding) throw new InspectionRefusal("regional_inspection_unavailable", "regional_inspection_unavailable");
  return binding;
}

async function organizationBinding(env: Env, orgId: string) {
  const results = await Promise.all(inspectionBindings(env).map((binding) => binding.resolveWorkspace({ workspaceId: WorkspaceIdSchema.parse(orgId) })));
  return oneRegionalTarget(env, results.map((result) => EngineeringWorkspaceTargetLookupSchema.parse(result)), `Organization ${orgId}`).binding;
}

export async function executeEngineeringTask(env: Env, principal: AccessPrincipal, input: EngineeringTaskInput) {
  if (input.name === "query_data_lake") {
    return { result: await tool(principal, input.name, { lakehouse: input.arguments.lakehouse }, () =>
      queryLakehouse({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.BASIN_SQL_API_TOKEN }, input.arguments.lakehouse, input.arguments.sql)) };
  }
  let incomplete: z.infer<typeof RetireEngineeringOrgResultSchema> | undefined;
  const result = await tool(principal, input.name, { workspace_id: input.arguments.orgId }, async () => {
    const receipt = RetireEngineeringOrgResultSchema.parse(
      await (await organizationBinding(env, input.arguments.orgId)).retireOrg(input.arguments, principal));
    if (!receipt.complete) incomplete = receipt;
    return receipt;
  });
  return { result, incomplete };
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
  target: Record<string, string | boolean | undefined>,
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
    return typeof value === "string" ? { content: [{ type: "text", text: value }] } : jsonResult(value);
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

const sqlInputSchema = {
  sql: z.string().min(1).describe(
    "SQLite statement or semicolon-separated statements. This may read or mutate the target database.",
  ),
  bindings: InspectionSqlBindingSchema.array().optional().describe(
    "Positional values for ? parameters, in order.",
  ),
};

export function createEngineeringMcpServer(env: Env, principal: AccessPrincipal, onTaskCreated?: () => void): McpServer {
  // Access also admits service assertions without a subject. They may execute
  // tools synchronously, but cannot share an "unknown" owner for stored data.
  const hasTaskOwner = hasStableAccessSubject(principal);
  async function createTask(input: EngineeringTaskInput) {
    const carrier = await createTaskCarrier(env, principal, input);
    onTaskCreated?.();
    return carrier;
  }
  const server = new McpServer({
    name: "Rally engineering",
    version: "1.0.0",
    description: "Inspect and administer Rally organizations, Canvases, Sidekicks and artifacts. Read production databases, inference data and Worker logs; administer billing, create organizations and send messages as a selected Rally user.",
  }, {
    instructions: ENGINEERING_MCP_SERVER_INSTRUCTIONS,
  });

  server.registerTool("provision_user_password", {
    description: "Provision or rotate a password for an existing Global identity user (resolve with search_users). Returns a generated password ONCE; deliver it only to the intended recipient through an appropriate private channel, never put it in logs or routine status updates. Each call replaces the previous password; if the response is lost, call again and use the latest result. Sign-in requires an independently verified primary email. Does not create an account, verify an email, grant Organization access, or end existing sessions.",
    inputSchema: EngineeringPasswordUserInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, (request) => tool(principal, "provision_user_password", { user_id: request.userId }, async () =>
    EngineeringProvisionPasswordResultSchema.parse(await env.GLOBAL_INSPECTION.provisionUserPassword(request, principal))));

  server.registerTool("revoke_user_password", {
    description: "Disable password sign-in for an existing Global identity user. Repeating is safe. Prevents new password sign-ins; existing sessions and other sign-in methods remain valid.",
    inputSchema: EngineeringPasswordUserInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, (request) => tool(principal, "revoke_user_password", { user_id: request.userId }, async () =>
    EngineeringRevokePasswordResultSchema.parse(await env.GLOBAL_INSPECTION.revokeUserPassword(request, principal))));

  server.registerTool("create_org", {
    description: "Create a Rally Organization in the specified region, owned by creatorUserId, and directly add userIds as members. All users must already exist in that region (use search_users). No invitations or login credentials are created. Reuse operationId and the same arguments to resume an uncertain result; orgId is operationId.",
    inputSchema: CreateEngineeringOrgInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (request) => tool(principal, "create_org", {
    region: request.region, workspace_id: request.operationId, creator_user_id: request.creatorUserId,
  }, async () => {
    const binding = env[`${regionConfiguration(request.region).bindingPrefix}_INSPECTION`];
    if (!binding) throw new InspectionRefusal("regional_inspection_unavailable", "regional_inspection_unavailable");
    return CreateEngineeringOrgResultSchema.parse(await binding.createOrg(request, principal));
  }));

  server.registerTool("send_message", {
    description: "Send a message as userId to a Canvas's Chat or a Sidekick's shared conversation (conversationId is the Canvas or Sidekick ID), through the same composer admission as the app. The message is attributed to userId, as though that user sent it. Enforces that user's access, uses normal addressing, queue/steer behavior, notifications and agent execution; recordOnly posts it for readers without starting a run. Reuse operationId and the same arguments to retry an uncertain send.",
    inputSchema: SendEngineeringMessageInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (request) => tool(principal, "send_message", {
    workspace_id: request.orgId, workstream_id: request.conversationId,
    user_id: request.userId, operation_id: request.operationId,
  }, async () => SendEngineeringMessageResultSchema.parse(await (await organizationBinding(env, request.orgId)).sendMessage(request, principal))));

  const sidekickPauseSchema = SetEngineeringSidekickPausedInputSchema.unwrap().omit({ paused: true });
  for (const [name, paused] of [["pause_sidekick", true], ["resume_sidekick", false]] as const) {
    server.registerTool(name, {
      description: paused
        ? "Pause an active Sidekick as userId, exactly as the app's Pause button does: open runs stop, scheduled and pending runs are cancelled, and its activity triggers are cleared. userId must be allowed to manage the Sidekick in the app; its author always is. Pausing a paused Sidekick changes nothing; a draft or deleted one is refused. Returns the resulting lifecycle."
        : "Resume a paused Sidekick as userId, exactly as the app's Resume button does: schedules restart from now without firing what was missed, and its activity triggers are restored. userId must be allowed to manage the Sidekick in the app; its author always is. Resuming an active Sidekick changes nothing. Returns the resulting lifecycle.",
      inputSchema: sidekickPauseSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, (request) => tool(principal, name, {
      workspace_id: request.orgId, sidekick_id: request.sidekickId, user_id: request.userId,
    }, async () => SetEngineeringSidekickPausedResultSchema.parse(
      await (await organizationBinding(env, request.orgId)).setSidekickPaused({ ...request, paused }, principal))));
  }

  server.registerTool("archive_sidekick", {
    description: "Archive a Sidekick as userId, exactly as the app's Archive action does: open runs stop, scheduled and pending runs are cancelled, its activity triggers are cleared, and it leaves everyone's Sidekick list. There is no undo. userId must be allowed to manage the Sidekick in the app; its author always is. Works in any lifecycle; archiving an archived Sidekick changes nothing. Also works in an abandoned or retired Organization, as a user who is still an active member of it. Returns the resulting lifecycle.",
    inputSchema: sidekickPauseSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, (request) => tool(principal, "archive_sidekick", {
    workspace_id: request.orgId, sidekick_id: request.sidekickId, user_id: request.userId,
  }, async () => ArchiveEngineeringSidekickResultSchema.parse(
    await (await organizationBinding(env, request.orgId)).archiveSidekick(request, principal))));

  server.registerTool("retire_org", {
    description: "Retire an Organization permanently through the regional retirement service: nobody can sign in to it, every Canvas, Sidekick and socket in it stops, and nothing reopens. There is no undo. Task-capable clients receive a durable handle to poll while failed passes are retried. Synchronous results report complete: false while parts are still open; call again with the same orgId to resume the walk.",
    inputSchema: RetireEngineeringOrgInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (request, ctx) => {
    const input = { name: "retire_org" as const, arguments: request };
    return hasTaskOwner && acceptsTasks(ctx) ? createTask(input) : (await executeEngineeringTask(env, principal, input)).result;
  });

  const conversationReadSchema = ReadEngineeringConversationInputSchema.unwrap().omit({ kind: true, conversationId: true });
  for (const [name, kind, label] of [["read_canvas_chat", "canvas", "Canvas"], ["read_sidekick_conversation", "sidekick", "Sidekick"]] as const) {
    const idKey = kind === "canvas" ? "canvasId" : "sidekickId";
    server.registerTool(name, {
      description: kind === "canvas"
        ? "Read a Canvas's Chat as userId through ordinary conversation authorization: the participant-visible message text, omitting tools, thinking and internal agent messages. Returns 20 committed turns by default, or the requested limit; follow the returned sequence fence to continue a page."
        : "Read a Sidekick's shared conversation as userId through ordinary conversation authorization, with the same text and paging as read_canvas_chat.",
      inputSchema: { ...conversationReadSchema.shape, [idKey]: IdSchema.describe(`The ${label} ID.`) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, (request) => {
      const rest: Record<string, unknown> = { ...request };
      const conversationId = String(rest[idKey]);
      delete rest[idKey];
      return tool(principal, name, {
        workspace_id: request.orgId, workstream_id: conversationId, user_id: request.userId,
      }, async () => EngineeringTextResultSchema.parse(await (await organizationBinding(env, request.orgId))
        .readConversation(ReadEngineeringConversationInputSchema.parse({ ...rest, kind, conversationId }))).text);
    });
  }

  server.registerTool("list_workspaces", {
    description: "List Rally workspaces from configured regional identity stores.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => tool(principal, "list_workspaces", {}, async () => {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.listWorkspaces({})));
    return results.flatMap((result) => ListEngineeringWorkspacesResultSchema.parse(result).items).sort((left, right) =>
      left.name.localeCompare(right.name) || left.workspaceId.localeCompare(right.workspaceId));
  }));

  server.registerTool("list_orgs", {
    description: "List every Rally Organization (stored as a workspace) across configured regions, abandoned ones included, newest first unless ordered otherwise, with plan, creation time, active member count, and when a member was last seen. Returns { items, page, pageCount, total, nextPage }; while nextPage is not null, call again with the same arguments and page set to nextPage.",
    inputSchema: organizationPageInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (request) => tool(principal, "list_orgs", {}, () =>
    organizationPage(inspectionBindings(env), { abandoned: "include" }, request)));

  server.registerTool("search_orgs", {
    description: "Search Rally Organizations (stored as workspaces) across configured regions, newest first unless ordered otherwise. Every filter narrows the result; abandoned Organizations are excluded unless asked for. Returns { items, page, pageCount, total, nextPage }; while nextPage is not null, call again with the same arguments and page set to nextPage.",
    inputSchema: { ...SearchEngineeringOrganizationsInputSchema.unwrap().shape, ...organizationPageInputSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ orderBy, direction, limit, page, ...filter }) => tool(principal, "search_orgs", {}, () =>
    organizationPage(inspectionBindings(env), filter, { orderBy, direction, limit, page })));

  server.registerTool("list_users", {
    description: "List every Rally user across configured regions, newest first unless ordered otherwise, each with every Organization they belong to (role, guest or member, status, last seen). A person with accounts in two regions appears once per region. Returns { items, page, pageCount, total, nextPage }; while nextPage is not null, call again with the same arguments and page set to nextPage.",
    inputSchema: userPageInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (request) => tool(principal, "list_users", {}, () =>
    userPage(inspectionBindings(env), {}, request)));

  server.registerTool("search_users", {
    description: "Search Rally users across configured regions by name, email or ID, or by creation time, newest first unless ordered otherwise. Each result carries every Organization the user belongs to (role, guest or member, status, last seen). Returns { items, page, pageCount, total, nextPage }; while nextPage is not null, call again with the same arguments and page set to nextPage.",
    inputSchema: { ...SearchEngineeringUsersInputSchema.unwrap().shape, ...userPageInputSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ orderBy, direction, limit, page, ...filter }) => tool(principal, "search_users", {}, () =>
    userPage(inspectionBindings(env), filter, { orderBy, direction, limit, page })));

  server.registerTool("list_canvases", {
    description: "List every Canvas in the authoritative WorkspaceDO for an Organization's workspace ID, most recently updated first. A Canvas ID also names its Chat's conversation object (read_canvas_chat, run_canvas_sql).",
    inputSchema: { workspaceId: WorkspaceIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId }) => tool(principal, "list_canvases", { workspace_id: workspaceId }, async () => {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.listCanvases({ workspaceId })));
    const found = oneRegionalResult(
      results.map((result) => EngineeringCanvasListLookupSchema.parse(result)),
      `Workspace ${workspaceId}`,
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

  server.registerTool("run_canvas_sql", {
    description: "Run arbitrary SQLite against the conversation object (AgentLoopDO) of a Canvas's Chat or a Sidekick's shared conversation, named by the Canvas or Sidekick ID: its transcript, runs, tool calls and outbox. substreamId reaches a registered child instead: a Sidekick run's or a background agent's conversation. Statements may mutate production state.",
    inputSchema: {
      workspaceId: WorkspaceIdSchema,
      conversationId: IdSchema.describe("A Canvas ID or a Sidekick ID."),
      substreamId: SubstreamIdSchema.optional().describe("A registered child conversation under it; omit for the main conversation."),
      ...sqlInputSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ workspaceId, conversationId, substreamId, sql, bindings = [] }) => tool(
    principal,
    "run_canvas_sql",
    { workspace_id: workspaceId, workstream_id: conversationId, substream_id: substreamId },
    async () => {
      const target = { workspaceId, conversationId, ...(substreamId === undefined ? {} : { substreamId }) };
      const results = await Promise.all(inspectionBindings(env).map((binding) => binding.resolveConversation(target)));
      const resolved = oneRegionalTarget(
        env,
        results.map((result) => EngineeringConversationTargetLookupSchema.parse(result)),
        `Conversation ${conversationId}`,
      );
      return executedSql(await resolved.binding.runConversationSql({
        ...target,
        authorityGeneration: resolved.value.authorityGeneration,
        query: { sql, bindings },
      }), `Conversation ${conversationId}`);
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

  server.registerTool("run_d1_sql", {
    description: "Run arbitrary SQLite against one of a region's D1 databases: DB (the regional product database: users, workspaces, memberships, authority routes), TELEMETRY_DB, USAGE_DB (the usage ledger), PLATFORM_DB (routing shared by every region), or MESSAGE_ISSUES_DB (Oopsie message issue reports). Semicolon-separated statements all run when only the last has ? parameters; the result is the last statement's rows and counters, so rowsWritten counts only its writes. D1 refuses BEGIN and SAVEPOINT. A result with no rows lists no columns, since D1 names columns only through its rows, and a later column overwrites an earlier one of the same name, so alias duplicate names in a JOIN. Statements may mutate production state.",
    inputSchema: {
      region: z.enum(configuredRegions as [string, ...string[]]).describe("The deployment whose D1 database to query."),
      database: EngineeringD1DatabaseSchema.describe("The regional API Worker's D1 binding."),
      ...sqlInputSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ region, database, sql, bindings = [] }) => tool(
    principal,
    "run_d1_sql",
    { region, d1_database: database },
    async () => {
      const binding = env[`${regionConfiguration(region).bindingPrefix}_INSPECTION`];
      if (!binding) throw new InspectionRefusal("regional_inspection_unavailable", "regional_inspection_unavailable");
      return EngineeringD1SqlResultSchema.parse(await binding.runD1Sql({ database, query: { sql, bindings } }));
    },
  ));

  server.registerTool("query_data_lake", {
    title: "Query Data Lake",
    description: `Run a read-only Basin SQL (formerly R2 SQL) query against one Global analytical lakehouse. Each lakehouse is a separate catalog, so a query reaches only its own table: ${Object.values(LAKEHOUSES).map(({ table }) => table).join(", ")}. Run DESCRIBE <table> for its columns. Billing is by bytes scanned, so filter on the table's timestamp column and add a LIMIT. Pipeline rolls files every 300 seconds, so a row can take about five minutes to appear, and delivery is at-least-once: rows sharing event_id are one event. llm_inference holds raw prompts and model output; select its request, response and error columns only for a specific inference_request_id.`,
    inputSchema: {
      lakehouse: z.enum(LAKEHOUSE_TABLES).describe("The table to query; it selects the catalog."),
      sql: z.string().min(1).describe("Basin SQL SELECT statement naming the table as <namespace>.<table>."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (request, ctx) => {
    const input = { name: "query_data_lake" as const, arguments: request };
    return hasTaskOwner && acceptsTasks(ctx) ? createTask(input) : (await executeEngineeringTask(env, principal, input)).result;
  });

  server.registerTool("query_worker_observability", {
    title: "Query Worker Logs and Traces",
    description: "Query Cloudflare Workers Observability: the structured logs, invocation logs and trace spans of every Worker on the account, as the dashboard's Query Builder shows them. Narrow to one Worker with a filter on $metadata.service (avalon-api-global is the Global API). Rally logs one JSON object per line, so filter on its fields (event, level, code, request_id, workspace_id) rather than with needle. To read one trace's spans and logs, query the events view filtered on $metadata.traceId. Retention is seven days. Invocation logs and spans carry full request URLs and SQL bindings, which can hold one-time OAuth codes, socket tickets and message text.",
    inputSchema: observabilityQueryInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (query) => tool(principal, "query_worker_observability", { view: query.view }, () =>
    queryObservability({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.WORKERS_OBSERVABILITY_API_TOKEN }, query)));

  server.registerTool("inspect_queues", {
    description: "Inspect Cloudflare queue backlog metrics and active dead-letter relationships. Does not consume or acknowledge messages. Metrics describe a point in time, not successful delivery.",
    inputSchema: { deadLettersOnly: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ deadLettersOnly }) => tool(principal, "inspect_queues", { dead_letters_only: deadLettersOnly }, () => inspectQueues(env, deadLettersOnly)));

  server.registerTool("inspect_dead_letters", {
    description: "Peek messages in an active dead-letter queue returned by inspect_queues. Returns the provider's sample without consuming, leasing, replaying or acknowledging messages. Message bodies may contain customer data; inspect only for the requested investigation.",
    inputSchema: { queueId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ queueId }) => tool(principal, "inspect_dead_letters", { queue_id: queueId }, () => peekDeadLetters(env, queueId)));

  server.registerTool("inspect_org_settings", {
    description: "Read an Organization's stored presentation settings, including whether its model selector is visible. These values are independent of defaults for new Organizations.",
    inputSchema: InspectEngineeringOrgSettingsInputSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (request) => tool(principal, "inspect_org_settings", { workspace_id: request.orgId }, async () =>
    EngineeringOrgSettingsResultSchema.parse(await (await organizationBinding(env, request.orgId)).inspectOrganizationSettings(request))));

  server.registerTool("update_org_settings", {
    description: "Set whether the model selector is visible for everyone in an Organization on macOS and web, independent of Debug mode. Persists the setting and refreshes connected clients. Does not change model routing or pins. Safe to repeat after an uncertain result; inspect_org_settings reads the saved value.",
    inputSchema: UpdateEngineeringOrgSettingsInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (request) => tool(principal, "update_org_settings", { workspace_id: request.orgId, model_selector_visible: request.modelSelectorVisible }, async () =>
    EngineeringOrgSettingsResultSchema.parse(await (await organizationBinding(env, request.orgId)).updateOrganizationSettings(request, principal))));

  server.registerTool("inspect_org_billing", {
    description: "Inspect an Organization's Stripe subscriptions, invoice amounts and charge IDs, pending operator operations, and Rally entitlement/overage state. Pass nextInvoicePage as startingAfter for the next page. Does not create a Stripe customer. Local entitlement status may lag Stripe; subscriptions are live provider reads.",
    inputSchema: InspectOrgBillingSchema, annotations: { readOnlyHint: true, openWorldHint: true },
  }, request => tool(principal, "inspect_org_billing", { workspace_id: request.orgId }, async () => OrgBillingResultSchema.parse(await (await organizationBinding(env, request.orgId)).inspectOrgBilling(request))));
  server.registerTool("change_subscription", {
    description: "Change an existing paid Stripe subscription to a configured offer with explicit proration, schedule or immediately cancel it, undo scheduled cancellation, or replace/remove its subscription discount. Requires the exact current subscriptionId. Immediate cancellation does not refund invoices; opted-in overage obligations still settle. Resume cannot resurrect a canceled subscription. Longer billing intervals reject active repeating discounts, and repeating coupons require monthly pricing. Existing usage-plan overrides remain in force. Reason and stable operationId required; reuse identical arguments after uncertainty.",
    inputSchema: ChangeSubscriptionSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, request => tool(principal, "change_subscription", { workspace_id: request.orgId, operation_id: request.operationId }, async () => BillingMutationResultSchema.parse(await (await organizationBinding(env, request.orgId)).administerOrgBilling({ ...request, kind: "subscription" }, principal))));
  server.registerTool("refund_payment", {
    description: "Refund amountMinor in the charge currency to its original payment method, for a charge owned by this Organization. Does not cancel subscriptions or change invoice accounting. For invoice corrections use correct_invoice with a credit note. Returned status may be pending; a receipt does not guarantee the refund has reached the bank. Reuse operationId and arguments after uncertainty.",
    inputSchema: RefundPaymentSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, request => tool(principal, "refund_payment", { workspace_id: request.orgId, operation_id: request.operationId }, async () => BillingMutationResultSchema.parse(await (await organizationBinding(env, request.orgId)).administerOrgBilling({ ...request, kind: "refund" }, principal))));
  server.registerTool("correct_invoice", {
    description: "Correct an Organization-owned Stripe invoice: void an open invoice, mark it uncollectible, or issue a partial/full credit note against an open/paid invoice. amountMinor uses invoice currency. Choose how any already-paid portion is returned: refund or general customer balance credit (which can pay future plan fees). invoice_balance only reduces unpaid amounts. Does not cancel the subscription or erase Rally usage. Reason and stable operationId required.",
    inputSchema: CorrectInvoiceSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, request => tool(principal, "correct_invoice", { workspace_id: request.orgId, operation_id: request.operationId }, async () => BillingMutationResultSchema.parse(await (await organizationBinding(env, request.orgId)).administerOrgBilling({ ...request, kind: "invoice" }, principal))));
  server.registerTool("inspect_billing_catalog", {
    description: "Read a region's effective billing offers, catalog revision, and live Stripe price amounts, currency options, recurring intervals, tax behavior and coupon terms. Amounts use each resource's currency minor units. Deployment configuration enables billing; operator changes override only offers and pilot configuration. Retired offers remain mapped for existing subscriptions.",
    inputSchema: InspectBillingCatalogSchema, annotations: { readOnlyHint: true, openWorldHint: true },
  }, request => tool(principal, "inspect_billing_catalog", { region: request.region }, async () => BillingCatalogInspectionSchema.parse(await billingRegionBinding(env, request.region).inspectBillingCatalog(request))));
  server.registerTool("create_billing_price", {
    description: "Create an immutable Stripe recurring price on the product of sourceOfferId. amountMinor uses the specified currency; choose interval and inclusive/exclusive tax behavior explicitly. Does not publish the price, reprice subscribers, or edit the landing page. Publish a new offer ID with configure_billing_catalog afterward. Reuse operationId and arguments after uncertainty.",
    inputSchema: CreateBillingPriceSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, request => tool(principal, "create_billing_price", { region: request.region, operation_id: request.operationId }, async () => BillingMutationResultSchema.parse(await billingRegionBinding(env, request.region).administerBillingCatalog({ ...request, kind: "price" }, principal))));
  server.registerTool("create_billing_coupon", {
    description: "Create a percentage-off Stripe coupon scoped to paid plan products of offerIds. Select once, repeating months, or forever. Never scopes the coupon to overages. Does not activate the coupon: publish it as first-paid pilot or an offer coupon with configure_billing_catalog, or apply it to an existing subscription with change_subscription. Reuse operationId and arguments after uncertainty.",
    inputSchema: CreateBillingCouponSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, request => tool(principal, "create_billing_coupon", { region: request.region, operation_id: request.operationId }, async () => BillingMutationResultSchema.parse(await billingRegionBinding(env, request.region).administerBillingCatalog({ ...request, kind: "coupon" }, principal))));
  server.registerTool("configure_billing_catalog", {
    description: "Publish the complete commercial catalog for a region using expectedRevision from inspect_billing_catalog. Synchronizes monthly Billing Portal plan choices and subsequent Checkout offers; longer intervals require Checkout or an eligible operator change. Keep every historical offer ID and its plan, priceId and overagePriceId; set enabled:false to retire one. A replacement price requires a new offer ID. signupTrial configures automatic no-card trials (offerId, currency, calendar months, startsAt); signupTrial:null stops new signup awards. Omission preserves the current campaign. pilotCouponId:null stops new checkout pilot awards; existing subscriptions/discounts and open Checkout Sessions are unchanged until refreshed/expired. Does not change infrastructure meters, usage quotas, taxes or static landing-page copy. Reason and stable operationId required.",
    inputSchema: ConfigureBillingCatalogSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, request => tool(principal, "configure_billing_catalog", { region: request.region, operation_id: request.operationId }, async () => BillingMutationResultSchema.parse(await billingRegionBinding(env, request.region).administerBillingCatalog({ ...request, kind: "catalog" }, principal))));

  server.registerTool("grant_trial_months", {
    description: "Grant an Organization extra calendar months without subscription fees. Requires an existing active or trialing monthly paid plan. Extends Stripe's base-subscription trial after the existing paid/trial/pilot period; included plan usage stays available and opted-in overages remain billable on their separate metered subscription. Does not refund existing invoices. A reason and operationId are required; reuse identical arguments and the same ID after an uncertain outcome to avoid awarding twice. Month ends clamp to the shorter month's last day. The result is an award receipt, not a live billing-status read.",
    inputSchema: GrantEngineeringTrialMonthsInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (request) => tool(principal, "grant_trial_months", { workspace_id: request.orgId, operation_id: request.operationId }, async () =>
    TrialMonthsGrantSchema.parse(await (await organizationBinding(env, request.orgId)).grantTrialMonths(request, principal))));

  server.registerTool("inspect_overage_credits", {
    description: "Read an Organization's overage-only USD credit grants and available balances from Stripe. Includes grants made directly in Stripe with the dedicated overage price scope; does not include general invoice credits. Supply operationId to recover the result of a previously accepted grant after an uncertain response, including legacy non-expiring grants. This only looks up the existing Stripe grant: it never issues credit or changes its terms. An unknown operation is rejected; an empty grants list means no matching Stripe receipt was found, not permission to reissue under a new ID.",
    inputSchema: InspectEngineeringCreditsInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (request) => tool(principal, "inspect_overage_credits", { workspace_id: request.orgId }, async () =>
    BillingCreditsSchema.parse(await (await organizationBinding(env, request.orgId)).inspectOverageCredits(request))));

  server.registerTool("grant_overage_credit", {
    description: "Issue promotional USD credit for an Organization's future overage invoices in Stripe. Requires configured metered overage billing. amountCents is invoice dollars in cents, not effective usage. Never offsets plan fees or alters included usage. Supply a reason and expiresAt, which must be in the future and within two calendar years (UTC). Non-expiring grants are not supported. Reuse the same operationId and arguments after an uncertain outcome; a new ID issues another financial grant. For legacy operations accepted without expiresAt, recover by operationId with inspect_overage_credits instead.",
    inputSchema: GrantEngineeringCreditInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (request) => tool(principal, "grant_overage_credit", { workspace_id: request.orgId, operation_id: request.operationId }, async () =>
    OverageCreditSchema.parse(await (await organizationBinding(env, request.orgId)).grantOverageCredit(request, principal))));

  server.registerTool("expire_overage_credit", {
    description: "Expire the unused balance of an Organization's overage-only Stripe credit grant now. Cannot recover credits already applied to finalized invoices. Retry with the same grantId after an uncertain outcome.",
    inputSchema: ExpireEngineeringCreditInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (request) => tool(principal, "expire_overage_credit", { workspace_id: request.orgId, grant_id: request.grantId }, async () =>
    OverageCreditSchema.parse(await (await organizationBinding(env, request.orgId)).expireOverageCredit(request, principal))));

  server.registerTool("inspect_usage_plan", {
    description: "Read an Organization's current plan, weekly quota remaining and reset, and current-period overage from its owning region's authoritative usage ledger.",
    inputSchema: InspectEngineeringUsageInputSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (request) => tool(principal, "inspect_usage_plan", { workspace_id: request.orgId }, async () =>
    EngineeringUsageResultSchema.parse(await (await organizationBinding(env, request.orgId)).inspectOrganizationUsage(request))));

  server.registerTool("change_usage_plan", {
    description: "Set a persistent operator override of an Organization's usage plan. Stripe subscription changes preserve this override; this tool does not change the Stripe subscription or its price. Applies its new quota to the current week, records the plan change, and notifies connected members. Past weekly quotas remain unchanged. Resolve an uncertain outcome with inspect_usage_plan before retrying.",
    inputSchema: ChangeEngineeringPlanInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, (request) => tool(principal, "change_usage_plan", { workspace_id: request.orgId, plan: request.plan }, async () =>
    EngineeringUsageResultSchema.parse(await (await organizationBinding(env, request.orgId)).changeOrganizationPlan(request, principal))));

  server.registerTool("inspect_migration_progress", {
    description: "Inspect forced-migration outcomes, failures, invalid or misrouted commands and schema version shortfalls in a region's Worker logs. Filters by run or object when supplied. Seven-day log retention applies; missing logs do not prove a fleet or object is current. Use inspect_queues for command backlog and dead letters. Ordinary constructor migrations are not a fleet registry.",
    inputSchema: {
      region: z.enum(configuredRegions as [string, ...string[]]),
      from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }).optional(),
      runId: z.uuid().optional(), objectId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      limit: z.number().int().positive().optional(), offset: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ region, from, to, runId, objectId, limit, offset }) => tool(principal, "inspect_migration_progress", { region, run_id: runId, object_id: objectId }, () =>
    queryObservability({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.WORKERS_OBSERVABILITY_API_TOKEN }, {
      view: "events", from, to, limit, offset,
      filters: [
        { key: "$metadata.service", operation: "eq", type: "string", value: `avalon-api-${region}` },
        { kind: "group", filterCombination: "or", filters: ["migration_command_applied", "migration_command_failed", "migration_command_invalid", "migration_command_class_deleted", "migration_command_misrouted"].map((event) => ({ key: "event", operation: "eq" as const, type: "string" as const, value: event })) },
        ...(runId ? [{ key: "run_id", operation: "eq" as const, type: "string" as const, value: runId }] : []),
        ...(objectId ? [{ key: "object_id", operation: "eq" as const, type: "string" as const, value: objectId }] : []),
      ], filterCombination: "and",
    })));

  registerTaskMethods(server, env, principal);
  return server;
}
