import { configuredRegions, regionConfiguration } from "@rally/contracts/regions";
import {
  EngineeringArtifactListLookupSchema,
  EngineeringArtifactTargetLookupSchema,
  EngineeringD1DatabaseSchema,
  EngineeringD1SqlResultSchema,
  CreateEngineeringOrgInputSchema,
  CreateEngineeringOrgResultSchema,
  CreateEngineeringChannelInputSchema,
  CreateEngineeringChannelResultSchema,
  CreateEngineeringThreadInputSchema,
  CreateEngineeringThreadResultSchema,
  SendEngineeringMessageInputSchema,
  SendEngineeringMessageResultSchema,
  SetEngineeringSidekickPausedInputSchema,
  SetEngineeringSidekickPausedResultSchema,
  RetireEngineeringOrgInputSchema,
  RetireEngineeringOrgResultSchema,
  ReadEngineeringChannelInputSchema,
  ReadEngineeringConversationInputSchema,
  EngineeringTextResultSchema,
  ListEngineeringUserChannelsInputSchema,
  ListEngineeringUserConversationsInputSchema,
  EngineeringSidekickListLookupSchema,
  EngineeringSpaceListLookupSchema,
  EngineeringSqlLookupSchema,
  EngineeringSubstreamListLookupSchema,
  EngineeringSubstreamTargetLookupSchema,
  EngineeringWorkspaceTargetLookupSchema,
  EngineeringWorkstreamListLookupSchema,
  InspectionSqlBindingSchema,
  ListEngineeringWorkspacesResultSchema,
  SearchEngineeringOrganizationsInputSchema,
  SearchEngineeringUsersInputSchema,
} from "@rally/contracts/engineering-inspection";
import {
  ArtifactIdSchema,
  SpaceDirectorySchema,
  SpaceChannelPageSchema,
  SubstreamIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "@rally/contracts";
import { platformErrorCode } from "@rally/contracts/platform-diagnostics";
import { isCodeShaped, isDiagnosticCode, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ManagedFlagUpdateSchema,
  ManagedModelUpdateSchema,
  type FlagAdministrationResult,
} from "../../ace/src/protocol";
import type { AccessPrincipal } from "./access";
import type { Env } from "./env";
import { CloudflareQueryError } from "./cloudflare-api";
import { LAKEHOUSE_TABLES, LAKEHOUSES, queryLakehouse } from "./lakehouse";
import { observabilityQueryInputSchema, queryObservability } from "./observability";
import { organizationPage, organizationPageInputSchema } from "./organizations";
import { userPage, userPageInputSchema } from "./users";

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
  const server = new McpServer({
    name: "Rally engineering",
    version: "1.0.0",
    description: "Inspect and administer Rally organizations, Channels, Threads, Breakouts, Sidekicks and artifacts. Read production databases, inference data and Worker logs; manage feature flags and model routing; create organizations and conversations and send messages as a selected Rally user.",
  }, {
    instructions: [
      "Use these tools for Rally engineering investigations and requested administration.",
      "Product names differ from storage: an Organization is a workspace, a Channel is a Space, a Thread is a workstream, and a Breakout is a substream. Main is substream 0.",
      "Resolve the exact organization, user and conversation before investigating. Start with the list/search tools and inspect database schemas before querying rows; bind SQL values with placeholders.",
      "For participant-visible content use read_channel, read_thread or read_breakout as the selected user and follow pagination. Those reads omit internal tools and thinking; use the exact conversation's inspection SQL and observability tools when diagnosing execution failures.",
      "SQL tools can mutate production data. Use read-only queries for investigations; make changes only within the user's request. For creation and message sends, reuse the same operationId and arguments after an uncertain outcome rather than creating a second operation.",
      "Filter logs and analytical queries to the relevant time window and identifiers. Never expose credentials, OAuth codes, socket tickets or unrelated private content found in diagnostic data.",
      "Separate verified durable state, observed tool results and inference from hypotheses, and distinguish a local change from a merged or deployed fix.",
    ].join("\n\n"),
  });

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

  async function organizationBinding(orgId: string) {
    const results = await Promise.all(inspectionBindings(env).map((binding) => binding.resolveWorkspace({ workspaceId: WorkspaceIdSchema.parse(orgId) })));
    return oneRegionalTarget(env, results.map((result) => EngineeringWorkspaceTargetLookupSchema.parse(result)), `Organization ${orgId}`).binding;
  }

  server.registerTool("create_channel", {
    description: "Create an Organization-wide Rally Channel in orgId and seat participantUserIds plus its creator. The selected user and participants must satisfy the app's ordinary creation and audience permissions. A Channel is stored as a Space, not a workstream. Reuse operationId and the same arguments after an uncertain outcome; channelId is operationId.",
    inputSchema: CreateEngineeringChannelInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (request) => tool(principal, "create_channel", {
    workspace_id: request.orgId, space_id: request.operationId, creator_user_id: request.creatorUserId,
  }, async () => CreateEngineeringChannelResultSchema.parse(await (await organizationBinding(request.orgId)).createChannel(request, principal))));

  server.registerTool("create_thread", {
    description: "Start a Rally Thread in channelId (a stored Space) in orgId, as creatorUserId, with prompt as its opening message. Starts the normal agent run, which may use connected tools. The creator must satisfy the app's ordinary Thread creation and Channel participation permissions. Private Channels keep the Thread private. Reuse operationId and the same arguments after an uncertain outcome; threadId is operationId.",
    inputSchema: CreateEngineeringThreadInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (request) => tool(principal, "create_thread", {
    workspace_id: request.orgId, space_id: request.channelId, workstream_id: request.operationId, creator_user_id: request.creatorUserId,
  }, async () => CreateEngineeringThreadResultSchema.parse(await (await organizationBinding(request.orgId)).createThread(request, principal))));

  server.registerTool("send_message", {
    description: "Send a message as userId to a Thread's Main or the named Breakout, through the same composer admission as the app. The message is attributed to userId, as though that user sent it. Enforces that user's access, uses normal addressing, queue/steer behavior, notifications and agent execution; recordOnly posts it for readers without starting a run. Reuse operationId and the same arguments to retry an uncertain send.",
    inputSchema: SendEngineeringMessageInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (request) => tool(principal, "send_message", {
    workspace_id: request.orgId, workstream_id: request.threadId, substream_id: request.breakoutId,
    user_id: request.userId, operation_id: request.operationId,
  }, async () => SendEngineeringMessageResultSchema.parse(await (await organizationBinding(request.orgId)).sendMessage(request, principal))));

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
      await (await organizationBinding(request.orgId)).setSidekickPaused({ ...request, paused }, principal))));
  }

  server.registerTool("retire_org", {
    description: "Retire an Organization permanently, through the same door as Ace's Retire button: nobody can sign in to it, every Channel, Thread, Sidekick and socket in it stops, and nothing reopens. There is no undo. Members simply lose it. Retiring the demo template stops new demos from being prepared. The result reports complete: false while parts are still open; call again with the same orgId to resume the walk.",
    inputSchema: RetireEngineeringOrgInputSchema.unwrap().shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, (request) => tool(principal, "retire_org", { workspace_id: request.orgId },
    async () => RetireEngineeringOrgResultSchema.parse(
      await (await organizationBinding(request.orgId)).retireOrg(request, principal))));

  server.registerTool("read_channel", {
    description: "Read the Channel feed visible to userId as plain text, with messages and Thread cards in app order. The app's ordinary feed pagination applies; follow the returned cursor for older history. Does not read the contents of every Thread.",
    inputSchema: ReadEngineeringChannelInputSchema.unwrap().shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (request) => tool(principal, "read_channel", {
    workspace_id: request.orgId, space_id: request.channelId, user_id: request.userId,
  }, async () => EngineeringTextResultSchema.parse(await (await organizationBinding(request.orgId)).readChannel(request)).text));

  const conversationReadSchema = ReadEngineeringConversationInputSchema.unwrap().omit({ breakoutId: true });
  server.registerTool("read_thread", {
    description: "Read the Thread's participant-visible message text as userId through ordinary conversation authorization. Omits tools, thinking and internal agent messages. Returns 20 committed turns by default, or the requested limit; follow the returned sequence fence to continue a page.",
    inputSchema: conversationReadSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (request) => tool(principal, "read_thread", {
    workspace_id: request.orgId, workstream_id: request.threadId, user_id: request.userId,
  }, async () => EngineeringTextResultSchema.parse(await (await organizationBinding(request.orgId)).readConversation(request)).text));

  server.registerTool("read_breakout", {
    description: "Read a Breakout's participant-visible message text as userId. The user's access to this exact Breakout is checked independently of the parent Thread. Returns plain text with the same history paging as read_thread.",
    inputSchema: conversationReadSchema.extend({ breakoutId: SubstreamIdSchema.refine((id) => id !== "0", "A Breakout ID is required") }).shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (request) => tool(principal, "read_breakout", {
    workspace_id: request.orgId, workstream_id: request.threadId, substream_id: request.breakoutId, user_id: request.userId,
  }, async () => EngineeringTextResultSchema.parse(await (await organizationBinding(request.orgId)).readConversation(request)).text));

  server.registerTool("list_channels", {
    description: "List the active Rally Channels visible to userId in orgId, in that user's app sidebar order. Uses the ordinary member/guest directory rules. Each item's id is a channelId for Channel reads and Thread creation; Personal Channels belong only to their owner.",
    inputSchema: ListEngineeringUserChannelsInputSchema.unwrap().shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (request) => tool(principal, "list_channels", {
    workspace_id: request.orgId, user_id: request.userId,
  }, async () => SpaceDirectorySchema.parse(await (await organizationBinding(request.orgId)).listUserChannels(request))));

  const conversationListSchema = ListEngineeringUserConversationsInputSchema.unwrap().omit({ kind: true });
  for (const [name, kind] of [["list_threads", "channel"], ["list_breakouts", "breakout"]] as const) {
    server.registerTool(name, {
      description: kind === "channel"
        ? "List all unarchived Threads userId may open in channelId (a stored Space), newest activity first, including settled/read Threads. Each item's id is a threadId. Returns the app's ordinary conversation cards and nextCursor; repeat with cursor until nextCursor is null."
        : "List all unarchived Breakouts visible to userId in channelId (a stored Space), across its Threads, including settled/read Breakouts. Each item's id is a breakoutId; breakoutOf.workstreamId is the threadId needed to read or send. Uses ordinary child visibility rules. Repeat with cursor until nextCursor is null.",
      inputSchema: conversationListSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, (request) => tool(principal, name, {
      workspace_id: request.orgId, space_id: request.channelId, user_id: request.userId,
    }, async () => SpaceChannelPageSchema.parse(await (await organizationBinding(request.orgId)).listUserConversations({ ...request, kind }))));
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

  server.registerTool("list_workstreams", {
    description: "List every Rally Thread (stored as a workstream) in the authoritative WorkspaceDO for an Organization's workspace ID.",
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
    description: "List every Rally Channel (stored as a Space) in the authoritative WorkspaceDO for an Organization's workspace ID, including archived Channels. Each spaceId can be passed as channelId to create_thread.",
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
    description: "Replace the route plan (primary OpenRouter model, ordered fallbacks, and optional reasoningEffort: low, medium, or high) in an agent role's model flag's default variation. Omit reasoningEffort to use each selected model's configured default; an explicit effort applies to the whole route. Every model id is checked against OpenRouter first; targeting rules and other variations are kept. New runs pick up the change on their next evaluation.",
    inputSchema: ManagedModelUpdateSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (update) => tool(principal, "update_model_flag", { agent_role: update.role }, async () =>
    administered(await env.FLAG_ADMINISTRATION.updateModelRouting({
      actor: { subject: principal.subject },
      update,
    }))));

  server.registerTool("query_data_lake", {
    title: "Query Data Lake",
    description: `Run a read-only Basin SQL (formerly R2 SQL) query against one Global analytical lakehouse. Each lakehouse is a separate catalog, so a query reaches only its own table: ${Object.values(LAKEHOUSES).map(({ table }) => table).join(", ")}. Run DESCRIBE <table> for its columns. Billing is by bytes scanned, so filter on the table's timestamp column and add a LIMIT. Pipeline rolls files every 300 seconds, so a row can take about five minutes to appear, and delivery is at-least-once: rows sharing event_id are one event. llm_inference holds raw prompts and model output; select its request, response and error columns only for a specific inference_request_id.`,
    inputSchema: {
      lakehouse: z.enum(LAKEHOUSE_TABLES).describe("The table to query; it selects the catalog."),
      sql: z.string().min(1).describe("Basin SQL SELECT statement naming the table as <namespace>.<table>."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ lakehouse, sql }) => tool(principal, "query_data_lake", { lakehouse }, () =>
    queryLakehouse({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.BASIN_SQL_API_TOKEN }, lakehouse, sql)));

  server.registerTool("query_worker_observability", {
    title: "Query Worker Logs and Traces",
    description: "Query Cloudflare Workers Observability: the structured logs, invocation logs and trace spans of every Worker on the account, as the dashboard's Query Builder shows them. Narrow to one Worker with a filter on $metadata.service (avalon-api-global is the Global API). Rally logs one JSON object per line, so filter on its fields (event, level, code, request_id, workspace_id) rather than with needle. To read one trace's spans and logs, query the events view filtered on $metadata.traceId. Retention is seven days. Invocation logs and spans carry full request URLs and SQL bindings, which can hold one-time OAuth codes, socket tickets and message text.",
    inputSchema: observabilityQueryInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (query) => tool(principal, "query_worker_observability", { view: query.view }, () =>
    queryObservability({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.WORKERS_OBSERVABILITY_API_TOKEN }, query)));

  return server;
}
