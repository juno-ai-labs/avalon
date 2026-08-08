import type { ToolDefinition } from "@avalon/contracts";
import { z } from "zod";
import {
  isRecord,
  jsonHeaders,
  providerJson,
  providerJsonResponse,
  readResponseBytes,
  sha256Hex,
  stringValue,
  type FetchLike,
} from "./provider-utils";
import {
  assertPrincipalAccess,
  connectorRetryAfterMs,
  ConnectorError,
  defineConnectorAgentPlugin,
  type ConnectorAdapter,
  type ConnectorConnectionContext,
} from "./types";

const SLACK_API = "https://slack.com/api";
const SLACK_MCP = "https://mcp.slack.com/mcp";
const REPLAY_WINDOW_MS = 5 * 60_000;
// Keep one buffered provider response comfortably below the Worker memory
// ceiling. This does not truncate Slack data: oversized responses fail closed.
const SLACK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface SlackConnectorConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  redirectUri: string;
  appId?: string;
  fetch?: FetchLike;
  now?: () => number;
}

export const SlackCapabilities = {
  search: "slack.search",
  messagesRead: "slack.messages.read",
  filesRead: "slack.files.read",
  messagesWrite: "slack.messages.write",
  conversationsWrite: "slack.conversations.write",
  reactionsWrite: "slack.reactions.write",
  canvasesRead: "slack.canvases.read",
  canvasesWrite: "slack.canvases.write",
  usersRead: "slack.users.read",
  agent: "slack.agent",
  notificationsWrite: "slack.notifications.write",
} as const;

export const SlackWorkspaceBotScopes = [
  "assistant:write",
  "app_mentions:read",
  "channels:join",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "groups:history",
  "groups:read",
  "im:history",
  "im:write",
  "links:read",
  "links:write",
  "mpim:read",
  "search:read.files",
  "search:read.public",
  "search:read.users",
  "team.billing:read",
  "users:read",
  "users:read.email",
] as const;

export const SlackCapabilityScopes: Record<string, readonly string[]> = {
  [SlackCapabilities.search]: [
    "search:read.public", "search:read.private", "search:read.mpim", "search:read.im",
    "search:read.files", "search:read.users",
  ],
  [SlackCapabilities.messagesRead]: ["channels:history", "groups:history", "mpim:history", "im:history"],
  [SlackCapabilities.filesRead]: ["files:read"],
  [SlackCapabilities.messagesWrite]: ["chat:write"],
  [SlackCapabilities.conversationsWrite]: ["channels:write", "groups:write", "im:write", "mpim:write"],
  [SlackCapabilities.reactionsWrite]: ["reactions:write"],
  [SlackCapabilities.canvasesRead]: ["canvases:read"],
  [SlackCapabilities.canvasesWrite]: ["canvases:read", "canvases:write"],
  [SlackCapabilities.usersRead]: ["users:read", "users:read.email", "channels:read", "groups:read", "mpim:read"],
  [SlackCapabilities.agent]: SlackWorkspaceBotScopes,
  [SlackCapabilities.notificationsWrite]: ["chat:write"],
};

const objectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function tool(
  name: string,
  description: string,
  capability: string,
  mode: "read" | "write",
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    description,
    capability,
    mode,
    idempotency: mode === "read" ? "safe" : "record_before_execute",
    inputSchema: { ...objectSchema, properties, ...(required.length ? { required } : {}) },
  };
}

const id = { type: "string", minLength: 1 };
const query = { type: "string", minLength: 1 };

export const slackTools: ToolDefinition[] = [
  tool("search", "Search Slack messages, files, channels, and users visible to the authorized user.", SlackCapabilities.search, "read", { query, limit: { type: "integer", minimum: 1 } }, ["query"]),
  tool("read_channel", "Read messages from a Slack conversation.", SlackCapabilities.messagesRead, "read", { channel_id: id, limit: { type: "integer", minimum: 1 } }, ["channel_id"]),
  tool("read_thread", "Read a Slack message thread.", SlackCapabilities.messagesRead, "read", { channel_id: id, thread_ts: id, limit: { type: "integer", minimum: 1 } }, ["channel_id", "thread_ts"]),
  tool("read_file", "Read metadata and content for a Slack file.", SlackCapabilities.filesRead, "read", { file_id: id }, ["file_id"]),
  tool("send_message", "Send a Slack message as the authorized user.", SlackCapabilities.messagesWrite, "write", { channel_id: id, text: { type: "string", minLength: 1, maxLength: 40_000 }, thread_ts: { type: ["string", "null"] } }, ["channel_id", "text"]),
  tool("create_conversation", "Create a Slack channel, group DM, or direct message as the authorized user.", SlackCapabilities.conversationsWrite, "write", { name: { type: ["string", "null"] }, user_ids: { type: "array", items: id }, is_private: { type: "boolean" } }),
  tool("add_reaction", "Add an emoji reaction to a Slack message as the authorized user.", SlackCapabilities.reactionsWrite, "write", { channel_id: id, timestamp: id, name: { type: "string", minLength: 1 } }, ["channel_id", "timestamp", "name"]),
  tool("create_canvas", "Create a Slack canvas.", SlackCapabilities.canvasesWrite, "write", { title: { type: "string", minLength: 1 }, markdown: { type: "string" } }, ["title"]),
  tool("update_canvas", "Update an existing Slack canvas.", SlackCapabilities.canvasesWrite, "write", { canvas_id: id, markdown: { type: "string" } }, ["canvas_id", "markdown"]),
  tool("read_canvas", "Read a Slack canvas as markdown.", SlackCapabilities.canvasesRead, "read", { canvas_id: id }, ["canvas_id"]),
  tool("read_user_profile", "Read a Slack user profile.", SlackCapabilities.usersRead, "read", { user_id: id }, ["user_id"]),
  tool("list_channel_members", "List members of a Slack conversation.", SlackCapabilities.usersRead, "read", { channel_id: id, limit: { type: "integer", minimum: 1 } }, ["channel_id"]),
];

export const SlackAgentPluginDescriptor = defineConnectorAgentPlugin({
  providerType: "slack",
  wireNamePrefix: "slack",
  description: "Search and act in Slack using the connected user's permissions.",
  systemMessage: "Use Slack only for the user's explicit task. Never enumerate or mirror a workspace. Read only the bounded context needed and confirm consequential writes.",
  tools: slackTools,
});

const SlackIngressEnvelopeSchema = z.object({
  token: z.string().optional(),
  team_id: z.string().min(1).optional(),
  api_app_id: z.string().min(1).optional(),
  type: z.string().min(1),
  event_id: z.string().min(1).optional(),
  event_time: z.number().int().optional(),
  challenge: z.string().optional(),
  event: z.record(z.string(), z.unknown()).optional(),
  authorizations: z.array(z.record(z.string(), z.unknown())).optional(),
}).passthrough();

export type SlackIngressEnvelope = z.infer<typeof SlackIngressEnvelopeSchema>;

export type SlackAgentInvocation =
  | { kind: "event"; teamId: string; eventId: string; event: Record<string, unknown>; envelope: SlackIngressEnvelope }
  | { kind: "interaction"; teamId: string; userId: string; payload: Record<string, unknown> }
  | { kind: "command"; teamId: string; userId: string; command: string; text: string; channelId: string; triggerId: string; responseUrl: string | null };

const SlackIdSchema = z.string().min(1);
const SlackTimestampSchema = z.string().min(1);
const SlackBlockSchema = z.record(z.string(), z.unknown());
const SlackViewSchema = z.record(z.string(), z.unknown()).refine((view) => typeof view.type === "string", "Slack view type is required");
const SlackOkSchema = z.object({ ok: z.literal(true) }).passthrough();
const SlackChannelSchema = z.object({ id: SlackIdSchema }).passthrough();
const SlackConversationSchema = SlackChannelSchema.extend({
  is_private: z.boolean(),
  is_im: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
});
const SlackListedPublicChannelSchema = SlackChannelSchema.extend({
  is_archived: z.boolean().optional(),
  is_member: z.boolean().optional(),
  is_private: z.boolean().optional(),
});
const SlackMessageResponseSchema = SlackOkSchema.extend({ channel: SlackIdSchema, ts: SlackTimestampSchema });
const SlackStreamResponseSchema = SlackOkSchema.extend({ channel: SlackIdSchema, ts: SlackTimestampSchema });
const SlackThreadMessageSchema = z.object({
  type: z.string().optional(),
  user: SlackIdSchema.optional(),
  bot_id: SlackIdSchema.optional(),
  text: z.string().optional(),
  ts: SlackTimestampSchema,
  thread_ts: SlackTimestampSchema.optional(),
}).passthrough();
const SlackSearchMessageSchema = z.object({
  author_name: z.string().optional(),
  author_user_id: SlackIdSchema.optional(),
  team_id: SlackIdSchema,
  channel_id: SlackIdSchema,
  channel_name: z.string().optional(),
  message_ts: SlackTimestampSchema,
  content: z.string(),
  is_author_bot: z.boolean().optional(),
  permalink: z.string().url(),
  blocks: z.array(SlackBlockSchema).optional(),
  context_messages: z.object({
    before: z.array(z.record(z.string(), z.unknown())).optional(),
    after: z.array(z.record(z.string(), z.unknown())).optional(),
  }).passthrough().optional(),
}).passthrough();
const SlackSearchFileSchema = z.object({
  team_id: SlackIdSchema,
  file_id: SlackIdSchema,
  title: z.string(),
  file_type: z.string(),
  permalink: z.string().url(),
  content: z.string(),
}).passthrough();
const SlackSearchChannelSchema = z.object({
  team_id: SlackIdSchema,
  name: z.string(),
  permalink: z.string().url(),
}).passthrough();
const SlackSearchUserSchema = z.object({
  user_id: SlackIdSchema,
}).passthrough();
const SlackUserSchema = z.object({
  id: SlackIdSchema,
  team_id: SlackIdSchema,
  name: z.string().optional(),
  real_name: z.string().optional(),
  deleted: z.boolean().optional(),
  is_bot: z.boolean().optional(),
  is_app_user: z.boolean().optional(),
  profile: z.object({
    display_name: z.string().optional(),
    real_name: z.string().optional(),
    email: z.string().email().optional(),
    image_192: z.string().url().optional(),
    image_72: z.string().url().optional(),
  }).passthrough().optional(),
}).passthrough();
const SlackSearchContextResponseSchema = SlackOkSchema.extend({
  results: z.object({
    messages: z.array(SlackSearchMessageSchema).optional(),
    files: z.array(SlackSearchFileSchema).optional(),
    channels: z.array(SlackSearchChannelSchema).optional(),
    users: z.array(SlackSearchUserSchema).optional(),
  }).passthrough(),
  response_metadata: z.object({ next_cursor: z.string() }).passthrough().optional(),
});

const SlackWebApiSchemas = {
  "assistant.search.context": {
    request: z.object({
      query: z.string().min(1),
      action_token: z.string().min(1),
      channel_types: z.array(z.enum(["public_channel", "private_channel", "mpim", "im"])).optional(),
      content_types: z.array(z.enum(["messages", "files", "channels", "users"])).optional(),
      context_channel_id: SlackIdSchema.optional(),
      include_context_messages: z.boolean().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }).strict(),
    response: SlackSearchContextResponseSchema,
  },
  "assistant.threads.setStatus": {
    request: z.object({ channel_id: SlackIdSchema, thread_ts: SlackTimestampSchema, status: z.string() }).strict(),
    response: SlackOkSchema,
  },
  "assistant.threads.setTitle": {
    request: z.object({ channel_id: SlackIdSchema, thread_ts: SlackTimestampSchema, title: z.string().min(1) }).strict(),
    response: SlackOkSchema,
  },
  "auth.revoke": { request: z.object({}).strict(), response: SlackOkSchema.extend({ revoked: z.boolean().optional() }) },
  "auth.test": { request: z.object({}).strict(), response: SlackOkSchema },
  "chat.appendStream": {
    request: z.object({ channel: SlackIdSchema, ts: SlackTimestampSchema, markdown_text: z.string().min(1).max(12_000) }).strict(),
    response: SlackStreamResponseSchema,
  },
  "chat.postMessage": {
    request: z.object({
      channel: SlackIdSchema,
      text: z.string().min(1).max(40_000),
      thread_ts: SlackTimestampSchema.optional(),
      client_msg_id: z.string().uuid().optional(),
      blocks: z.array(SlackBlockSchema).max(50).optional(),
    }).strict(),
    response: SlackMessageResponseSchema,
  },
  "chat.startStream": {
    request: z.object({
      channel: SlackIdSchema,
      thread_ts: SlackTimestampSchema,
      markdown_text: z.string().max(12_000),
      recipient_user_id: SlackIdSchema,
      recipient_team_id: SlackIdSchema,
      task_display_mode: z.enum(["dense", "plan", "timeline"]).optional(),
    }).strict(),
    response: SlackStreamResponseSchema,
  },
  "chat.stopStream": {
    request: z.object({ channel: SlackIdSchema, ts: SlackTimestampSchema, blocks: z.array(SlackBlockSchema).max(50).optional() }).strict(),
    response: SlackStreamResponseSchema,
  },
  "chat.unfurl": {
    request: z.object({ channel: SlackIdSchema, ts: SlackTimestampSchema, unfurls: z.record(z.string(), z.unknown()) }).strict(),
    response: SlackOkSchema,
  },
  "conversations.open": {
    request: z.object({ users: SlackIdSchema }).strict(),
    response: SlackOkSchema.extend({ channel: SlackChannelSchema }),
  },
  "conversations.replies": {
    request: z.object({
      channel: SlackIdSchema,
      ts: SlackTimestampSchema,
      limit: z.number().int().min(1).max(15).optional(),
      cursor: z.string().min(1).optional(),
    }).strict(),
    response: SlackOkSchema.extend({
      messages: z.array(SlackThreadMessageSchema),
      has_more: z.boolean().optional(),
      response_metadata: z.object({ next_cursor: z.string() }).passthrough().optional(),
    }),
  },
  "conversations.info": {
    request: z.object({ channel: SlackIdSchema }).strict(),
    response: SlackOkSchema.extend({ channel: SlackConversationSchema }),
  },
  "conversations.join": {
    request: z.object({ channel: SlackIdSchema }).strict(),
    response: SlackOkSchema.extend({
      channel: SlackChannelSchema,
      warning: z.string().optional(),
    }),
  },
  "conversations.list": {
    request: z.object({
      cursor: z.string().min(1).optional(),
      exclude_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(999).optional(),
      types: z.literal("public_channel").optional(),
    }).strict(),
    response: SlackOkSchema.extend({
      channels: z.array(SlackListedPublicChannelSchema),
      response_metadata: z.object({ next_cursor: z.string().optional() }).passthrough().optional(),
    }),
  },
  "team.billing.info": { request: z.object({}).strict(), response: SlackOkSchema.extend({ plan: z.string().min(1) }) },
  "users.lookupByEmail": {
    request: z.object({ email: z.string().email().max(254) }).strict(),
    response: SlackOkSchema.extend({
      user: SlackUserSchema,
    }),
  },
  "users.info": {
    request: z.object({ user: SlackIdSchema }).strict(),
    response: SlackOkSchema.extend({ user: SlackUserSchema }),
  },
  "views.open": {
    request: z.object({ trigger_id: z.string().min(1), view: SlackViewSchema }).strict(),
    response: SlackOkSchema.extend({ view: z.record(z.string(), z.unknown()).optional() }),
  },
  "views.publish": {
    request: z.object({ user_id: SlackIdSchema, view: SlackViewSchema, hash: z.string().min(1).optional() }).strict(),
    response: SlackOkSchema.extend({ view: z.record(z.string(), z.unknown()).optional() }),
  },
} as const;

export type SlackWebApiMethod = keyof typeof SlackWebApiSchemas;
export type SlackApiRequest<M extends SlackWebApiMethod> = z.input<(typeof SlackWebApiSchemas)[M]["request"]>;
export type SlackApiResponse<M extends SlackWebApiMethod> = z.output<(typeof SlackWebApiSchemas)[M]["response"]>;

const SlackApiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
}).passthrough();

const SlackOAuthSuccessSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  bot_user_id: z.string().min(1).optional(),
  app_id: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  team: z.object({ id: z.string().min(1), name: z.string().optional() }).passthrough(),
  authed_user: z.object({
    id: z.string().min(1).optional(),
    access_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    expires_in: z.number().int().positive().optional(),
    refresh_token: z.string().min(1).optional(),
  }).passthrough().optional(),
  authed_user_id: z.string().min(1).optional(),
}).passthrough();

const SlackRefreshSuccessSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  authed_user: z.object({
    access_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    expires_in: z.number().int().positive().optional(),
    refresh_token: z.string().min(1).optional(),
  }).passthrough().optional(),
}).passthrough();

const SlackMcpInputSchemas = {
  search: z.object({ query: z.string().min(1), limit: z.number().int().min(1).optional() }).strict(),
  read_channel: z.object({ channel_id: SlackIdSchema, limit: z.number().int().min(1).optional() }).strict(),
  read_thread: z.object({ channel_id: SlackIdSchema, thread_ts: SlackTimestampSchema, limit: z.number().int().min(1).optional() }).strict(),
  read_file: z.object({ file_id: SlackIdSchema }).strict(),
  send_message: z.object({ channel_id: SlackIdSchema, text: z.string().min(1).max(40_000), thread_ts: SlackTimestampSchema.nullable().optional() }).strict(),
  create_conversation: z.object({ name: z.string().nullable().optional(), user_ids: z.array(SlackIdSchema).optional(), is_private: z.boolean().optional() }).strict(),
  add_reaction: z.object({ channel_id: SlackIdSchema, timestamp: SlackTimestampSchema, name: z.string().min(1) }).strict(),
  create_canvas: z.object({ title: z.string().min(1), markdown: z.string().optional() }).strict(),
  update_canvas: z.object({ canvas_id: SlackIdSchema, markdown: z.string() }).strict(),
  read_canvas: z.object({ canvas_id: SlackIdSchema }).strict(),
  read_user_profile: z.object({ user_id: SlackIdSchema }).strict(),
  list_channel_members: z.object({ channel_id: SlackIdSchema, limit: z.number().int().min(1).optional() }).strict(),
} as const;

export type SlackMcpTool = keyof typeof SlackMcpInputSchemas;

const McpJsonRpcErrorSchema = z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() });
const McpToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()).optional(), required: z.array(z.string()).optional(), additionalProperties: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional() }).passthrough(),
}).passthrough();
const McpInitializeResultSchema = z.object({
  protocolVersion: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()),
  serverInfo: z.object({ name: z.string().min(1), version: z.string().optional() }).passthrough(),
}).passthrough();
const McpToolsListResultSchema = z.object({ tools: z.array(McpToolSchema), nextCursor: z.string().min(1).optional() }).passthrough();
const McpToolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).passthrough(),
  z.object({ type: z.literal("audio"), data: z.string(), mimeType: z.string() }).passthrough(),
  z.object({ type: z.literal("resource"), resource: z.record(z.string(), z.unknown()) }).passthrough(),
  z.object({ type: z.literal("resource_link"), uri: z.string(), name: z.string() }).passthrough(),
]);
const McpCallToolResultSchema = z.object({
  content: z.array(McpToolContentSchema),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
}).passthrough();
const McpJsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().int()]),
  result: z.unknown().optional(),
  error: McpJsonRpcErrorSchema.optional(),
}).refine((value) => (value.result === undefined) !== (value.error === undefined), {
  message: "JSON-RPC response must contain exactly one of result or error",
});

export function parseSlackAgentInvocation(input: unknown): SlackAgentInvocation {
  if (!isRecord(input)) throw new ConnectorError("provider_error", "Slack invocation is malformed");
  if (input.kind === "event") {
    const envelope = SlackIngressEnvelopeSchema.parse(input.envelope);
    if (!envelope.team_id || !envelope.event_id || !envelope.event) {
      throw new ConnectorError("provider_error", "Slack event identity is missing");
    }
    return { kind: "event", teamId: envelope.team_id, eventId: envelope.event_id, event: envelope.event, envelope };
  }
  if (input.kind === "interaction" && isRecord(input.payload)) {
    const team = isRecord(input.payload.team) ? input.payload.team : {};
    const user = isRecord(input.payload.user) ? input.payload.user : {};
    const teamId = stringValue(team, "id");
    const userId = stringValue(user, "id");
    if (!teamId || !userId) throw new ConnectorError("provider_error", "Slack interaction identity is missing");
    return { kind: "interaction", teamId, userId, payload: input.payload };
  }
  if (input.kind === "command") {
    const schema = z.object({
      team_id: z.string().min(1), user_id: z.string().min(1), command: z.string().min(1),
      text: z.string().default(""), channel_id: z.string().min(1), trigger_id: z.string().min(1),
      response_url: z.string().url().nullable().default(null),
    });
    const command = schema.parse(input.payload);
    return { kind: "command", teamId: command.team_id, userId: command.user_id, command: command.command, text: command.text, channelId: command.channel_id, triggerId: command.trigger_id, responseUrl: command.response_url };
  }
  throw new ConnectorError("provider_error", "Slack invocation kind is unsupported");
}

export async function verifySlackRequest(input: {
  signingSecret: string;
  rawBody: string | Uint8Array;
  timestamp: string | null;
  signature: string | null;
  now?: number;
}): Promise<{ body: string; bodyHash: string }> {
  const bytes = typeof input.rawBody === "string" ? new TextEncoder().encode(input.rawBody) : input.rawBody;
  if (!input.timestamp || !/^\d{10}$/u.test(input.timestamp)) throw new ConnectorError("invalid_signature", "Slack request timestamp is missing or malformed");
  if (!input.signature || !/^v0=[0-9a-f]{64}$/iu.test(input.signature)) throw new ConnectorError("invalid_signature", "Slack request signature is missing or malformed");
  const now = input.now ?? Date.now();
  if (Math.abs(now - Number(input.timestamp) * 1_000) > REPLAY_WINDOW_MS) throw new ConnectorError("invalid_signature", "Slack request timestamp is outside the replay window");
  const body = new TextDecoder().decode(bytes);
  const base = `v0:${input.timestamp}:${body}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(input.signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  const supplied = hexBytes(input.signature.slice(3));
  if (!constantTimeEqual(expected, supplied)) throw new ConnectorError("invalid_signature", "Slack request signature is invalid");
  return { body, bodyHash: await sha256Hex(body) };
}

export function parseSlackEventEnvelope(payload: unknown, expectedAppId?: string): SlackIngressEnvelope {
  const envelope = SlackIngressEnvelopeSchema.parse(payload);
  if (expectedAppId && envelope.api_app_id && envelope.api_app_id !== expectedAppId) {
    throw new ConnectorError("unauthorized", "Slack event belongs to a different app");
  }
  return envelope;
}

export async function slackApi<M extends SlackWebApiMethod>(
  token: string,
  method: M,
  body: SlackApiRequest<M>,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<SlackApiResponse<M>> {
  return (await slackApiResponse(token, method, body, signal, fetcher)).data;
}

interface SlackApiCallResult<M extends SlackWebApiMethod> {
  data: SlackApiResponse<M>;
  oauthScopes: string[] | null;
}

const SlackGetMethods = new Set<SlackWebApiMethod>([
  "auth.revoke",
  "conversations.info",
  "conversations.list",
  "conversations.replies",
  "users.info",
  "users.lookupByEmail",
]);

async function slackApiResponse<M extends SlackWebApiMethod>(
  token: string,
  method: M,
  body: SlackApiRequest<M>,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<SlackApiCallResult<M>> {
  const definition = SlackWebApiSchemas[method] as {
    request: z.ZodType;
    response: z.ZodType;
  };
  const requestBody = definition.request.parse(body) as Record<string, unknown>;
  const url = new URL(`${SLACK_API}/${method}`);
  const headers = jsonHeaders(token);
  const useQueryTransport = SlackGetMethods.has(method);
  if (useQueryTransport) {
    headers.delete("content-type");
    for (const [key, value] of Object.entries(requestBody)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const responseWithMetadata = await providerJsonResponse(fetcher, url, {
    method: useQueryTransport ? "GET" : "POST",
    headers,
    ...(useQueryTransport ? {} : { body: JSON.stringify(requestBody) }),
    signal,
  }, SLACK_MAX_RESPONSE_BYTES);
  const payload = responseWithMetadata.data;
  const apiError = SlackApiErrorSchema.safeParse(payload);
  if (apiError.success) {
    const unauthorized = new Set(["account_inactive", "invalid_auth", "invalid_refresh_token", "not_authed", "token_expired", "token_revoked"]);
    throw new ConnectorError(unauthorized.has(apiError.data.error) ? "unauthorized" : "provider_error", apiError.data.error, apiError.data);
  }
  const response = definition.response.safeParse(payload);
  if (!response.success) {
    throw new ConnectorError("provider_error", `Slack ${method} returned a malformed response`, response.error.flatten());
  }
  const rawScopes = responseWithMetadata.headers.get("x-oauth-scopes");
  return {
    data: response.data as SlackApiResponse<M>,
    oauthScopes: rawScopes == null
      ? null
      : [...new Set(rawScopes.split(",").map((scope) => scope.trim()).filter(Boolean))].sort(),
  };
}

export type SlackPublicChannelJoinResult = "joined" | "already_member" | "skipped";

export interface SlackPublicChannelSyncResult {
  joined: number;
  alreadyMember: number;
  skipped: number;
  complete: boolean;
  retryAfterMs?: number;
}

const SlackUnjoinablePublicChannelErrors = new Set([
  "access_denied",
  "channel_not_found",
  "enterprise_is_restricted",
  "is_archived",
  "method_not_supported_for_channel_type",
  "no_permission",
  "restricted_action",
  "too_many_members",
  "user_is_restricted",
]);

function slackProviderErrorCode(error: unknown): string | null {
  return error instanceof ConnectorError
    && error.details
    && typeof error.details === "object"
    && typeof (error.details as { error?: unknown }).error === "string"
    ? String((error.details as { error: string }).error)
    : null;
}

function slackRateLimitRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof ConnectorError) || !error.details || typeof error.details !== "object") return null;
  const status = (error.details as { status?: unknown }).status;
  if (status !== 429 && slackProviderErrorCode(error) !== "ratelimited") return null;
  return connectorRetryAfterMs(error) ?? 60_000;
}

/** Join one public channel, while treating channel-specific policy failures as terminal. */
export async function joinSlackPublicChannel(
  token: string,
  channelId: string,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<SlackPublicChannelJoinResult> {
  try {
    const response = await slackApi(token, "conversations.join", { channel: channelId }, signal, fetcher);
    return response.warning === "already_in_channel" ? "already_member" : "joined";
  } catch (error) {
    const providerCode = slackProviderErrorCode(error);
    if (providerCode && SlackUnjoinablePublicChannelErrors.has(providerCode)) return "skipped";
    throw error;
  }
}

/** Enumerate and join every visible, active public channel with cursor-safe retries. */
export async function joinAllSlackPublicChannels(
  token: string,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<SlackPublicChannelSyncResult> {
  const summary = { joined: 0, alreadyMember: 0, skipped: 0 };
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    let page: SlackApiResponse<"conversations.list">;
    try {
      page = await slackApi(token, "conversations.list", {
        exclude_archived: true,
        limit: 200,
        types: "public_channel",
        ...(cursor ? { cursor } : {}),
      }, signal, fetcher);
    } catch (error) {
      const retryAfterMs = slackRateLimitRetryAfterMs(error);
      if (retryAfterMs != null) return { ...summary, complete: false, retryAfterMs };
      throw error;
    }
    for (const channel of page.channels) {
      if (channel.is_archived || channel.is_private) {
        summary.skipped += 1;
        continue;
      }
      if (channel.is_member) {
        summary.alreadyMember += 1;
        continue;
      }
      let result: SlackPublicChannelJoinResult;
      try {
        result = await joinSlackPublicChannel(token, channel.id, signal, fetcher);
      } catch (error) {
        const retryAfterMs = slackRateLimitRetryAfterMs(error);
        if (retryAfterMs != null) return { ...summary, complete: false, retryAfterMs };
        throw error;
      }
      if (result === "joined") summary.joined += 1;
      else if (result === "already_member") summary.alreadyMember += 1;
      else summary.skipped += 1;
    }
    const nextCursor = page.response_metadata?.next_cursor?.trim() || undefined;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new ConnectorError("provider_error", "Slack returned a repeated public-channel cursor");
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return { ...summary, complete: true };
}

export async function callSlackMcp(
  token: string,
  requestedTool: SlackMcpTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  const parsedArgs = SlackMcpInputSchemas[requestedTool].parse(args) as Record<string, unknown>;
  let sessionId: string | null = null;
  try {
    const initializeId = crypto.randomUUID();
    const initialized = await mcpRequest(fetcher, token, {
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Avalon", version: "0.32.0" },
      },
    }, signal, null, false);
    sessionId = initialized.sessionId;
    const initializeResult = McpInitializeResultSchema.parse(initialized.result);
    if (initializeResult.protocolVersion !== "2025-06-18") {
      throw new ConnectorError("unsupported_capability", `Slack MCP negotiated unsupported protocol ${initializeResult.protocolVersion}`);
    }

    await mcpNotification(fetcher, token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, signal, sessionId);

    const tools: z.infer<typeof McpToolSchema>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = await mcpRequest(fetcher, token, {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/list",
        params: cursor ? { cursor } : {},
      }, signal, sessionId, true);
      const result = McpToolsListResultSchema.parse(listed.result);
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new ConnectorError("provider_error", "Slack MCP returned a repeated pagination cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);

    const aliases = [requestedTool, `slack_${requestedTool}`, requestedTool.replaceAll("_", "-")];
    const discovered = tools.find((entry) => aliases.includes(entry.name));
    if (!discovered) throw new ConnectorError("unsupported_capability", `Slack MCP does not expose ${requestedTool}`);
    assertMcpArgumentsCompatible(discovered, parsedArgs);

    const called = await mcpRequest(fetcher, token, {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: discovered.name, arguments: parsedArgs },
    }, signal, sessionId, true);
    const result = McpCallToolResultSchema.parse(called.result);
    if (result.isError) throw new ConnectorError("provider_error", `Slack MCP tool ${requestedTool} failed`, result);
    return result;
  } finally {
    if (sessionId) await closeMcpSession(fetcher, token, sessionId);
  }
}

async function mcpRequest(
  fetcher: FetchLike,
  token: string,
  request: Record<string, unknown> & { id: string | number },
  signal: AbortSignal,
  sessionId: string | null,
  initialized: boolean,
): Promise<{ result: unknown; sessionId: string | null }> {
  const response = await fetchMcp(fetcher, token, "POST", request, signal, sessionId, initialized);
  const payload = McpJsonRpcResponseSchema.parse(await responseJson(response));
  if (payload.id !== request.id) throw new ConnectorError("provider_error", "Slack MCP returned a mismatched JSON-RPC response id");
  if (payload.error) throw new ConnectorError("provider_error", payload.error.message, payload.error);
  return { result: payload.result, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

async function mcpNotification(
  fetcher: FetchLike,
  token: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  sessionId: string | null,
): Promise<void> {
  const response = await fetchMcp(fetcher, token, "POST", request, signal, sessionId, true);
  if (response.status !== 202) throw new ConnectorError("provider_error", `Slack MCP notification returned unexpected HTTP ${response.status}`);
}

async function fetchMcp(
  fetcher: FetchLike,
  token: string,
  method: "POST" | "DELETE",
  request: Record<string, unknown> | null,
  signal: AbortSignal,
  sessionId: string | null,
  initialized: boolean,
): Promise<Response> {
  const headers = jsonHeaders(token);
  headers.set("accept", "application/json, text/event-stream");
  if (initialized) headers.set("mcp-protocol-version", "2025-06-18");
  if (sessionId) headers.set("mcp-session-id", sessionId);
  let response: Response;
  try {
    response = await fetcher(SLACK_MCP, {
      method,
      headers,
      ...(request ? { body: JSON.stringify(request) } : {}),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ConnectorError("provider_error", "Slack MCP request could not be completed", error);
  }
  if (!response.ok) {
    const payload = response.headers.get("content-type")?.includes("application/json")
      ? await responseJson(response).catch(() => ({}))
      : {};
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter.trim())
      ? Math.max(0, Math.ceil(Number(retryAfter) * 1_000))
      : null;
    throw new ConnectorError(
      response.status === 401 || response.status === 403 ? "unauthorized" : "provider_error",
      `Slack MCP returned HTTP ${response.status}`,
      { status: response.status, payload, ...(retryAfterMs != null ? { retryAfterMs } : {}) },
    );
  }
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new ConnectorError("provider_error", "Slack MCP returned an unsupported event stream response");
  }
  return response;
}

async function responseJson(response: Response): Promise<unknown> {
  const bytes = await readResponseBytes(response, SLACK_MAX_RESPONSE_BYTES);
  if (!bytes.byteLength) throw new ConnectorError("provider_error", "Slack MCP returned an empty JSON-RPC response");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new ConnectorError("provider_error", "Slack MCP returned malformed JSON", error);
  }
}

function assertMcpArgumentsCompatible(tool: z.infer<typeof McpToolSchema>, args: Record<string, unknown>): void {
  for (const required of tool.inputSchema.required ?? []) {
    if (!(required in args)) throw new ConnectorError("unsupported_capability", `Slack MCP requires unsupported argument ${required} for ${tool.name}`);
  }
  if (tool.inputSchema.additionalProperties === false && tool.inputSchema.properties) {
    for (const key of Object.keys(args)) {
      if (!(key in tool.inputSchema.properties)) throw new ConnectorError("unsupported_capability", `Slack MCP does not accept argument ${key} for ${tool.name}`);
    }
  }
}

async function closeMcpSession(fetcher: FetchLike, token: string, sessionId: string): Promise<void> {
  try {
    await fetchMcp(fetcher, token, "DELETE", null, AbortSignal.timeout(2_000), sessionId, true);
  } catch {
    // Closing is best effort after the tool result has already been received.
  }
}

function parseSlackSuccess<T extends z.ZodType>(
  payload: Record<string, unknown>,
  schema: T,
  fallbackMessage: string,
): z.output<T> {
  const apiError = SlackApiErrorSchema.safeParse(payload);
  if (apiError.success) {
    const unauthorized = new Set(["account_inactive", "invalid_auth", "invalid_refresh_token", "not_authed", "token_expired", "token_revoked"]);
    throw new ConnectorError(
      unauthorized.has(apiError.data.error) ? "unauthorized" : "provider_error",
      apiError.data.error,
      apiError.data,
    );
  }
  const result = schema.safeParse(payload);
  if (!result.success) throw new ConnectorError("provider_error", fallbackMessage, result.error.flatten());
  return result.data;
}

function isSlackMcpTool(name: string): name is SlackMcpTool {
  return Object.prototype.hasOwnProperty.call(SlackMcpInputSchemas, name);
}

export function createSlackConnector(config: SlackConnectorConfig): ConnectorAdapter {
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  return {
    manifest: {
      type: "slack",
      displayName: "Slack",
      surfaces: ["resource", "messaging_agent"],
      messagingAgent: {
        capability: SlackCapabilities.agent,
        invocationModes: ["direct_message", "mention", "shortcut", "command", "follow_up"],
        supportsStreaming: true,
        supportsThreads: true,
        supportsAppHome: true,
        supportsModals: true,
        supportsUnfurling: true,
        supportsProactiveDelivery: true,
        maturity: "stable",
        runtimeStatus: "operational",
        webhookResponseDeadlineMs: 3_000,
      },
      capabilities: [
        ...Object.values(SlackCapabilities)
          .filter((capability) => capability !== SlackCapabilities.agent && capability !== SlackCapabilities.notificationsWrite)
          .map((capability) => ({ id: capability, kind: "tool" as const })),
        { id: SlackCapabilities.notificationsWrite, kind: "host" as const },
        { id: SlackCapabilities.agent, kind: "messaging_agent" as const },
      ],
      supportedScopes: ["personal", "workspace"],
      oauthRequired: true,
      activityTypes: [],
      resourceTypes: ["slack_message", "slack_thread", "slack_file", "slack_canvas"],
      tools: slackTools,
      supportsWatches: false,
      supportsPolling: false,
      supportsWebhooks: true,
    },
    agentPlugin: SlackAgentPluginDescriptor,
    capabilityConnectionScopes: {
      [SlackCapabilities.agent]: ["workspace"],
      [SlackCapabilities.notificationsWrite]: ["workspace"],
      ...Object.fromEntries(Object.values(SlackCapabilities)
        .filter((capability) => capability !== SlackCapabilities.agent && capability !== SlackCapabilities.notificationsWrite)
        .map((capability) => [capability, ["personal"]])),
    },
    messagingAgent: {
      capability: SlackCapabilities.agent,
      parseInvocation: parseSlackAgentInvocation,
    },
    async beginAuthorization(input) {
      const connectionScope = input.connectionScope;
      if (connectionScope !== "personal" && connectionScope !== "workspace") throw new ConnectorError("invalid_configuration", "Slack authorization scope is required");
      const url = new URL(connectionScope === "personal" ? "https://slack.com/oauth/v2_user/authorize" : "https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", String(input.state ?? ""));
      const requested = Array.isArray(input.scopes) ? input.scopes.filter((scope): scope is string => typeof scope === "string") : [];
      if (connectionScope === "workspace") url.searchParams.set("scope", [...new Set([...SlackWorkspaceBotScopes, ...requested])].join(","));
      else {
        // The dedicated user-token endpoint follows OAuth's standard `scope`
        // parameter. `user_scope` belongs to the combined v2/authorize flow.
        url.searchParams.set("scope", [...new Set(requested)].join(","));
        if (typeof input.codeChallenge === "string") {
          url.searchParams.set("code_challenge", input.codeChallenge);
          url.searchParams.set("code_challenge_method", "S256");
        }
      }
      return { url: url.toString() };
    },
    async handleAuthorizationCallback(input) {
      const connectionScope = input.connectionScope;
      if (connectionScope !== "personal" && connectionScope !== "workspace") throw new ConnectorError("invalid_configuration", "Slack authorization scope is required");
      const endpoint = connectionScope === "personal" ? `${SLACK_API}/oauth.v2.user.access` : `${SLACK_API}/oauth.v2.access`;
      const form = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: String(input.code ?? ""), redirect_uri: config.redirectUri });
      if (connectionScope === "personal" && input.codeVerifier) form.set("code_verifier", String(input.codeVerifier));
      const response = parseSlackSuccess(await providerJson(fetcher, endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form }, SLACK_MAX_RESPONSE_BYTES), SlackOAuthSuccessSchema, "Slack OAuth failed");
      const team = response.team;
      const authedUser = response.authed_user ?? {};
      const teamId = team.id;
      if (connectionScope === "workspace") {
        const accessToken = response.access_token;
        if (!accessToken) throw new ConnectorError("provider_error", "Slack OAuth did not return a bot token");
        const oauthScopes = slackOAuthScopes(response.scope);
        const missingScopes = SlackWorkspaceBotScopes.filter((scope) => !oauthScopes.includes(scope));
        if (missingScopes.length > 0) {
          for (const token of [...new Set([response.refresh_token, accessToken].filter((value): value is string => Boolean(value)))]) {
            try { await slackApi(token, "auth.revoke", {}, AbortSignal.timeout(10_000), fetcher); } catch { /* best effort after an incomplete grant */ }
          }
          throw new ConnectorError(
            "unauthorized",
            `Slack authorization is missing required permissions: ${missingScopes.join(", ")}`,
            { missingScopes },
          );
        }
        const billing = await slackApi(accessToken, "team.billing.info", {}, AbortSignal.timeout(10_000), fetcher);
        const plan = billing.plan;
        if (plan === "free") {
          for (const token of [...new Set([response.refresh_token, accessToken].filter((value): value is string => Boolean(value)))]) {
            try { await slackApi(token, "auth.revoke", {}, AbortSignal.timeout(10_000), fetcher); } catch { /* best effort after an ineligible install */ }
          }
          throw new ConnectorError("unauthorized", "Avalon Agent and automation features require a paid Slack workspace plan. Remove the app from Slack App Management to finish uninstalling it.");
        }
        return { providerAccountId: teamId, teamId, workspaceName: team.name ?? teamId, slackPlan: plan, botAccessToken: accessToken, botUserId: response.bot_user_id ?? null, appId: response.app_id ?? config.appId ?? null, oauthScopes, refreshToken: response.refresh_token ?? null, expiresAt: expiresAt(response.expires_in, now()) };
      }
      const accessToken = response.access_token ?? authedUser.access_token;
      const userId = authedUser.id ?? response.authed_user_id;
      if (!accessToken || !userId) throw new ConnectorError("provider_error", "Slack OAuth did not return a user token and identity");
      return { providerAccountId: `${teamId}:${userId}`, teamId, slackUserId: userId, workspaceName: team.name ?? teamId, userAccessToken: accessToken, oauthScopes: slackOAuthScopes(response.scope ?? authedUser.scope), refreshToken: response.refresh_token ?? authedUser.refresh_token ?? null, expiresAt: expiresAt(response.expires_in ?? authedUser.expires_in, now()) };
    },
    async refreshCredentials(connection, signal) {
      const refreshToken = stringValue(connection.credentials, "refreshToken");
      if (!refreshToken) throw new ConnectorError("unauthorized", "Slack authorization must be reconnected");
      const endpoint = connection.scope === "personal" ? `${SLACK_API}/oauth.v2.user.access` : `${SLACK_API}/oauth.v2.access`;
      const response = parseSlackSuccess(await providerJson(fetcher, endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
        signal,
      }, SLACK_MAX_RESPONSE_BYTES), SlackRefreshSuccessSchema, "Slack token refresh failed");
      const authedUser = response.authed_user ?? {};
      const accessToken = response.access_token ?? authedUser.access_token;
      if (!accessToken) throw new ConnectorError("provider_error", "Slack token refresh did not return an access token");
      const returnedScope = response.scope ?? authedUser.scope;
      let oauthScopes = returnedScope == null
        ? (Array.isArray(connection.credentials.oauthScopes) ? connection.credentials.oauthScopes : [])
        : slackOAuthScopes(returnedScope);
      if (connection.scope === "workspace") {
        if (oauthScopes.length === 0) {
          const authentication = await slackApiResponse(accessToken, "auth.test", {}, signal, fetcher);
          oauthScopes = authentication.oauthScopes ?? [];
        }
        const granted = new Set(oauthScopes.filter((scope): scope is string => typeof scope === "string"));
        const missingScopes = SlackWorkspaceBotScopes.filter((scope) => !granted.has(scope));
        if (missingScopes.length > 0) {
          throw new ConnectorError(
            "unauthorized",
            `Slack authorization is missing required permissions: ${missingScopes.join(", ")}`,
            { missingScopes },
          );
        }
      }
      return {
        ...connection.credentials,
        ...(connection.scope === "personal" ? { userAccessToken: accessToken } : { botAccessToken: accessToken }),
        oauthScopes,
        refreshToken: response.refresh_token ?? authedUser.refresh_token ?? refreshToken,
        expiresAt: expiresAt(response.expires_in ?? authedUser.expires_in, now()),
      };
    },
    async revoke(connection, signal) {
      const accessToken = connection.scope === "workspace" ? botToken(connection) : userToken(connection);
      const refreshToken = stringValue(connection.credentials, "refreshToken");
      // Granular bot tokens cannot call apps.uninstall. Disconnect Avalon by
      // revoking the token; Slack workspace admins retain the explicit app
      // uninstall action in Slack App Management.
      const failures: unknown[] = [];
      for (const token of [...new Set([refreshToken, accessToken].filter((value): value is string => Boolean(value)))]) {
        try {
          await slackApi(token, "auth.revoke", {}, signal, fetcher);
        } catch (error) {
          // A credential Slack already invalidated has reached the requested
          // end state. Network and provider failures must still be surfaced so
          // callers never report a partially completed disconnect as success.
          if (!(error instanceof ConnectorError && error.code === "unauthorized")) failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Slack credentials could not all be revoked");
    },
    async executeTool(name, rawArgs, context) {
      assertPrincipalAccess(context.connection, context.principal);
      if (context.connection.scope !== "personal") throw new ConnectorError("unauthorized", "Slack MCP tools require a personal Slack connection");
      const definition = slackTools.find((candidate) => candidate.name === name);
      if (!definition || !context.connection.grantedScopes.includes(definition.capability)) throw new ConnectorError("unsupported_capability", `The Slack connection has not granted ${definition?.capability ?? name}`);
      if (!isSlackMcpTool(name)) throw new ConnectorError("unsupported_capability", `Slack MCP tool ${name} is unsupported`);
      const args = SlackMcpInputSchemas[name].parse(rawArgs) as Record<string, unknown>;
      const output = await callSlackMcp(userToken(context.connection), name, args, context.signal, fetcher);
      return { output, summary: `${definition.mode === "read" ? "Read from" : "Updated"} Slack with ${name}` };
    },
    async healthCheck(connection) {
      if (!connection) return { ok: Boolean(config.clientId && config.clientSecret && config.signingSecret), message: "Slack connector configuration is available" };
      try {
        const token = connection.scope === "workspace" ? botToken(connection) : userToken(connection);
        const authentication = await slackApiResponse(token, "auth.test", {}, AbortSignal.timeout(10_000), fetcher);
        if (connection.scope === "workspace") {
          if (authentication.oauthScopes == null) {
            return {
              ok: false,
              message: "Slack did not report the permissions granted to this bot; reconnect the workspace authorization",
              reconnectRequired: true,
            };
          }
          const granted = new Set(authentication.oauthScopes);
          const missing = SlackWorkspaceBotScopes.filter((scope) => !granted.has(scope));
          if (missing.length > 0) {
            return {
              ok: false,
              message: `Slack authorization is missing required permissions: ${missing.join(", ")}`,
              reconnectRequired: true,
            };
          }
        }
        return { ok: true, message: "Slack authorization is healthy" };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Slack authorization failed",
          reconnectRequired: error instanceof ConnectorError && error.code === "unauthorized",
        };
      }
    },
  };
}

function botToken(connection: ConnectorConnectionContext): string {
  const token = stringValue(connection.credentials, "botAccessToken");
  if (!token) throw new ConnectorError("unauthorized", "Slack bot authorization is unavailable");
  return token;
}

function userToken(connection: ConnectorConnectionContext): string {
  const token = stringValue(connection.credentials, "userAccessToken");
  if (!token) throw new ConnectorError("unauthorized", "Slack user authorization is unavailable");
  return token;
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function expiresAt(value: unknown, now: number): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(now + value * 1_000).toISOString()
    : null;
}

function slackOAuthScopes(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((scope) => scope.trim()).filter(Boolean))].sort();
}
