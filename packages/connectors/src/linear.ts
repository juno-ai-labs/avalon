import type { NormalizedActivity, ToolDefinition } from "@avalon/contracts";
import { z } from "zod";
import {
  base64,
  isRecord,
  jsonHeaders,
  numberValue,
  providerJson,
  recordValue,
  sha256Hex,
  stringValue,
  truncateText,
  verifyHmacSha256,
  type FetchLike,
} from "./provider-utils";
import {
  assertPrincipalAccess,
  ConnectorError,
  type ConnectorAdapter,
  type ConnectorConnectionContext,
} from "./types";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const LINEAR_RESPONSE_BYTES = 512_000;
const LINEAR_TEXT_CHARS = 40_000;
const LINEAR_WEBHOOK_BYTES = 1_000_000;
const LINEAR_WEBHOOK_REPLAY_WINDOW_MS = 60_000;

export interface LinearConnectorConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: FetchLike;
  now?: () => number;
}

export const LinearCapabilities = {
  read: "linear.read",
  issueCreate: "linear.issue.create",
  commentCreate: "linear.comment.create",
  write: "linear.write",
} as const;

export const LinearCapabilityScopes = {
  [LinearCapabilities.read]: ["read"],
  [LinearCapabilities.issueCreate]: ["issues:create"],
  [LinearCapabilities.commentCreate]: ["comments:create"],
  [LinearCapabilities.write]: ["write"],
} as const;

const linearTools: ToolDefinition[] = [
  {
    name: "linear.search_issues",
    description: "Search recent Linear issues by title in the installed workspace.",
    capability: LinearCapabilities.read,
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        first: { type: "integer", minimum: 1, maximum: 25 },
        after: { type: ["string", "null"], maxLength: 500 },
      },
      required: ["query"],
    },
  },
  {
    name: "linear.read_issue",
    description: "Read one Linear issue and a bounded page of its comments.",
    capability: LinearCapabilities.read,
    mode: "read",
    idempotency: "safe",
    inputSchema: idInputSchema("issueId"),
  },
  {
    name: "linear.list_teams",
    description: "List teams available to the installed Linear app.",
    capability: LinearCapabilities.read,
    mode: "read",
    idempotency: "safe",
    inputSchema: pageInputSchema(50),
  },
  {
    name: "linear.list_projects",
    description: "List recently updated Linear projects.",
    capability: LinearCapabilities.read,
    mode: "read",
    idempotency: "safe",
    inputSchema: pageInputSchema(25),
  },
  {
    name: "linear.read_project",
    description: "Read one Linear project by provider ID.",
    capability: LinearCapabilities.read,
    mode: "read",
    idempotency: "safe",
    inputSchema: idInputSchema("projectId"),
  },
  {
    name: "linear.create_issue",
    description: "Create an issue in a Linear team as the installed Avalon app.",
    capability: LinearCapabilities.issueCreate,
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        teamId: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 500 },
        description: { type: ["string", "null"], maxLength: 40_000 },
        priority: { type: ["integer", "null"], minimum: 0, maximum: 4 },
        projectId: { type: ["string", "null"], maxLength: 200 },
        assigneeId: { type: ["string", "null"], maxLength: 200 },
      },
      required: ["teamId", "title"],
    },
  },
  {
    name: "linear.update_issue",
    description: "Update selected fields on an existing Linear issue as the installed Avalon app.",
    capability: LinearCapabilities.write,
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        issueId: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 500 },
        description: { type: ["string", "null"], maxLength: 40_000 },
        statusId: { type: ["string", "null"], maxLength: 200 },
        assigneeId: { type: ["string", "null"], maxLength: 200 },
        projectId: { type: ["string", "null"], maxLength: 200 },
        priority: { type: ["integer", "null"], minimum: 0, maximum: 4 },
        dueDate: { type: ["string", "null"], format: "date" },
      },
      required: ["issueId"],
      minProperties: 2,
    },
  },
  {
    name: "linear.create_comment",
    description: "Add a comment to a Linear issue as the installed Avalon app.",
    capability: LinearCapabilities.commentCreate,
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        issueId: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", minLength: 1, maxLength: 40_000 },
      },
      required: ["issueId", "body"],
    },
  },
];

const searchIssuesSchema = z.object({
  query: z.string().min(1).max(500),
  first: z.number().int().min(1).max(25).default(20),
  after: z.string().max(500).nullable().optional(),
});
const idSchema = z.string().min(1).max(200);
const pageSchema = (maximum: number) => z.object({
  first: z.number().int().min(1).max(maximum).default(Math.min(maximum, 25)),
  after: z.string().max(500).nullable().optional(),
});
const createIssueSchema = z.object({
  teamId: idSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(40_000).nullable().optional(),
  priority: z.number().int().min(0).max(4).nullable().optional(),
  projectId: idSchema.nullable().optional(),
  assigneeId: idSchema.nullable().optional(),
});
const updateIssueSchema = z.object({
  issueId: idSchema,
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(40_000).nullable().optional(),
  statusId: idSchema.nullable().optional(),
  assigneeId: idSchema.nullable().optional(),
  projectId: idSchema.nullable().optional(),
  priority: z.number().int().min(0).max(4).nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
}).refine((value) => Object.keys(value).some((key) => key !== "issueId"), {
  message: "Choose at least one issue field to update",
});
const createCommentSchema = z.object({ issueId: idSchema, body: z.string().min(1).max(40_000) });

const issueFields = `
  id identifier title description priority dueDate url createdAt updatedAt canceledAt completedAt
  team { id key name }
  state { id name type }
  assignee { id name }
  project { id name }
  creator { id name }
`;

export function createLinearConnector(config: LinearConnectorConfig): ConnectorAdapter {
  const fetcher = config.fetch ?? globalThis.fetch;
  const now = config.now ?? Date.now;
  assertConfig(config);

  const refresh = async (
    connection: ConnectorConnectionContext,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const refreshToken = credentialString(connection, "refreshToken");
    try {
      const payload = await providerJson(fetcher, LINEAR_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        signal,
      }, LINEAR_RESPONSE_BYTES);
      return {
        ...connection.credentials,
        ...normalizeToken(payload, now()),
      };
    } catch (error) {
      if (isRefreshRejected(error)) {
        throw new ConnectorError("unauthorized", "The Linear refresh token is no longer valid", {
          status: isRecord(error.details) ? error.details.status : 401,
          reconnectRequired: true,
          reason: "refresh_rejected",
        });
      }
      throw error;
    }
  };

  const withAccess = async <T>(
    connection: ConnectorConnectionContext,
    signal: AbortSignal,
    operation: (token: string) => Promise<T>,
  ): Promise<T> => {
    const expiration = stringValue(connection.credentials, "expiresAt");
    if (expiration && Date.parse(expiration) <= now() + 60_000) {
      connection.credentials = await refresh(connection, signal);
    }
    let token = credentialString(connection, "accessToken");
    try {
      return await operation(token);
    } catch (error) {
      if (!isProviderUnauthorized(error)) throw error;
      connection.credentials = await refresh(connection, signal);
      token = credentialString(connection, "accessToken");
      return operation(token);
    }
  };

  const graphql = async (
    connection: ConnectorConnectionContext,
    signal: AbortSignal,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => withAccess(connection, signal, (token) =>
    linearGraphql(fetcher, token, query, variables, signal));

  const readIssue = async (connection: ConnectorConnectionContext, issueId: string, signal: AbortSignal) => {
    const data = await graphql(connection, signal, `
      query AvalonReadIssue($id: String!) {
        issue(id: $id) {
          ${issueFields}
          comments(first: 25) {
            nodes { id body createdAt updatedAt user { id name } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `, { id: issueId });
    const issue = recordValue(data, "issue");
    if (!issue) throw new ConnectorError("provider_error", "Linear did not return the requested issue");
    return boundLinearValue(issue);
  };

  const readProject = async (connection: ConnectorConnectionContext, projectId: string, signal: AbortSignal) => {
    const data = await graphql(connection, signal, `
      query AvalonReadProject($id: String!) {
        project(id: $id) {
          id name summary description url createdAt updatedAt startDate targetDate
          status { id name type }
          lead { id name }
          teams { nodes { id key name } }
        }
      }
    `, { id: projectId });
    const project = recordValue(data, "project");
    if (!project) throw new ConnectorError("provider_error", "Linear did not return the requested project");
    return boundLinearValue(project);
  };

  return {
    manifest: {
      type: "linear",
      displayName: "Linear",
      supportedScopes: ["workspace"],
      oauthRequired: true,
      activityTypes: [
        "linear.issue.create", "linear.issue.update", "linear.issue.remove",
        "linear.comment.create", "linear.comment.update", "linear.comment.remove",
        "linear.project.create", "linear.project.update", "linear.project.remove",
        "linear.project_update.create", "linear.project_update.update", "linear.project_update.remove",
        "linear.document.create", "linear.document.update", "linear.document.remove",
        "linear.oauth_app.revoked", "linear.permission_change.update",
      ],
      resourceTypes: ["linear_issue", "linear_comment", "linear_project", "linear_document"],
      tools: linearTools,
      supportsWatches: true,
      supportsPolling: false,
      supportsWebhooks: true,
    },

    async beginAuthorization(input) {
      const parsed = z.object({
        state: z.string().min(20),
        codeChallenge: z.string().min(20),
        scopes: z.array(z.string().min(1)).min(1),
      }).parse(input);
      const scopes = [...new Set(["read", ...parsed.scopes])];
      if (scopes.some((scope) => scope === "admin" || !supportedLinearScopes.has(scope))) {
        throw new ConnectorError("unsupported_capability", "The requested Linear OAuth scope is not supported");
      }
      const url = new URL("https://linear.app/oauth/authorize");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("state", parsed.state);
      url.searchParams.set("actor", "app");
      url.searchParams.set("code_challenge", parsed.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { url: url.toString() };
    },

    async handleAuthorizationCallback(input) {
      const parsed = z.object({ code: z.string().min(1), codeVerifier: z.string().min(20) }).parse(input);
      const payload = await providerJson(fetcher, LINEAR_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          code: parsed.code,
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code_verifier: parsed.codeVerifier,
          grant_type: "authorization_code",
        }),
      }, LINEAR_RESPONSE_BYTES);
      const credentials = normalizeToken(payload, now());
      const identity = await linearGraphql(fetcher, String(credentials.accessToken), `
        query AvalonLinearIdentity {
          viewer { id name organization { id name urlKey } }
        }
      `, {}, AbortSignal.timeout(15_000));
      const viewer = requiredRecord(identity, "viewer", "Linear did not return the installed app identity");
      const organization = requiredRecord(viewer, "organization", "Linear did not return the installed organization");
      const organizationId = requiredString(organization, "id", "Linear did not return an organization ID");
      const organizationName = stringValue(organization, "name") ?? organizationId;
      return {
        ...credentials,
        appUserId: requiredString(viewer, "id", "Linear did not return the installed app user ID"),
        appUserName: stringValue(viewer, "name"),
        organizationId,
        organizationName,
        organizationUrlKey: stringValue(organization, "urlKey"),
        providerAccountId: organizationId,
        providerAccountName: organizationName,
      };
    },

    refreshCredentials: refresh,

    async revoke(connection, signal) {
      const token = stringValue(connection.credentials, "refreshToken") ?? stringValue(connection.credentials, "accessToken");
      if (!token) return;
      await providerJson(fetcher, LINEAR_REVOKE_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Basic ${base64(`${config.clientId}:${config.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token, token_type_hint: stringValue(connection.credentials, "refreshToken") ? "refresh_token" : "access_token" }),
        signal,
      }, 64_000);
    },

    async hydrateResource(connection, resource, signal) {
      assertWorkspaceConnection(connection);
      const resourceId = z.string().min(1).max(200).parse(resource.provider_resource_id);
      const resourceType = z.string().parse(resource.resource_type);
      if (resourceType === "linear_issue") return readIssue(connection, resourceId, signal);
      if (resourceType === "linear_project") return readProject(connection, resourceId, signal);
      if (resourceType === "linear_document") {
        const data = await graphql(connection, signal, `
          query AvalonReadDocument($id: String!) {
            document(id: $id) { id title content url createdAt updatedAt creator { id name } project { id name } }
          }
        `, { id: resourceId });
        const document = recordValue(data, "document");
        if (!document) throw new ConnectorError("provider_error", "Linear did not return the requested document");
        return boundLinearValue(document);
      }
      if (resourceType === "linear_comment") {
        const data = await graphql(connection, signal, `
          query AvalonReadComment($id: String!) {
            comment(id: $id) { id body createdAt updatedAt user { id name } issue { id identifier title url } }
          }
        `, { id: resourceId });
        const comment = recordValue(data, "comment");
        if (!comment) throw new ConnectorError("provider_error", "Linear did not return the requested comment");
        return boundLinearValue(comment);
      }
      throw new ConnectorError("unsupported_capability", `Linear cannot hydrate resource type ${resourceType}`);
    },

    async executeTool(name, rawArgs, context) {
      assertWorkspaceConnection(context.connection);
      assertPrincipalAccess(context.connection, context.principal);
      const definition = linearTools.find((candidate) => candidate.name === name);
      if (!definition || !context.connection.grantedScopes.includes(definition.capability)) {
        throw new ConnectorError("unsupported_capability", `The Linear connection has not granted ${definition?.capability ?? name}`);
      }

      if (name === "linear.search_issues") {
        const args = searchIssuesSchema.parse(rawArgs);
        const data = await graphql(context.connection, context.signal, `
          query AvalonSearchIssues($query: String!, $first: Int!, $after: String) {
            issues(
              first: $first
              after: $after
              orderBy: updatedAt
              filter: { title: { containsIgnoreCase: $query } }
            ) {
              nodes { ${issueFields} }
              pageInfo { hasNextPage endCursor }
            }
          }
        `, args);
        const issues = requiredRecord(data, "issues", "Linear did not return an issue search result");
        return { output: boundLinearValue(issues), summary: `Searched Linear issues for “${args.query.slice(0, 80)}”` };
      }

      if (name === "linear.read_issue") {
        const issueId = z.object({ issueId: idSchema }).parse(rawArgs).issueId;
        return { output: await readIssue(context.connection, issueId, context.signal), summary: `Read Linear issue ${issueId}` };
      }

      if (name === "linear.list_teams") {
        const args = pageSchema(50).parse(rawArgs);
        const data = await graphql(context.connection, context.signal, `
          query AvalonListTeams($first: Int!, $after: String) {
            teams(first: $first, after: $after) {
              nodes { id key name description private }
              pageInfo { hasNextPage endCursor }
            }
          }
        `, args);
        return { output: boundLinearValue(requiredRecord(data, "teams", "Linear did not return teams")), summary: "Listed Linear teams" };
      }

      if (name === "linear.list_projects") {
        const args = pageSchema(25).parse(rawArgs);
        const data = await graphql(context.connection, context.signal, `
          query AvalonListProjects($first: Int!, $after: String) {
            projects(first: $first, after: $after, orderBy: updatedAt) {
              nodes { id name summary url createdAt updatedAt startDate targetDate status { id name type } lead { id name } }
              pageInfo { hasNextPage endCursor }
            }
          }
        `, args);
        return { output: boundLinearValue(requiredRecord(data, "projects", "Linear did not return projects")), summary: "Listed Linear projects" };
      }

      if (name === "linear.read_project") {
        const projectId = z.object({ projectId: idSchema }).parse(rawArgs).projectId;
        return { output: await readProject(context.connection, projectId, context.signal), summary: `Read Linear project ${projectId}` };
      }

      if (name === "linear.create_issue") {
        const args = createIssueSchema.parse(rawArgs);
        const input = definedValues(args);
        const data = await graphql(context.connection, context.signal, `
          mutation AvalonCreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) { success issue { ${issueFields} } }
          }
        `, { input });
        const result = requiredRecord(data, "issueCreate", "Linear did not return an issue creation result");
        const issue = requiredRecord(result, "issue", "Linear did not return the created issue");
        const id = requiredString(issue, "id", "Linear did not return the created issue ID");
        return { output: boundLinearValue(issue), summary: `Created Linear issue ${stringValue(issue, "identifier") ?? id}`, providerOperationId: id };
      }

      if (name === "linear.update_issue") {
        const args = updateIssueSchema.parse(rawArgs);
        const { issueId, ...updates } = args;
        const data = await graphql(context.connection, context.signal, `
          mutation AvalonUpdateIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success issue { ${issueFields} } }
          }
        `, { id: issueId, input: definedValues(updates) });
        const result = requiredRecord(data, "issueUpdate", "Linear did not return an issue update result");
        const issue = requiredRecord(result, "issue", "Linear did not return the updated issue");
        const id = requiredString(issue, "id", "Linear did not return the updated issue ID");
        return { output: boundLinearValue(issue), summary: `Updated Linear issue ${stringValue(issue, "identifier") ?? id}`, providerOperationId: id };
      }

      if (name === "linear.create_comment") {
        const args = createCommentSchema.parse(rawArgs);
        const data = await graphql(context.connection, context.signal, `
          mutation AvalonCreateComment($input: CommentCreateInput!) {
            commentCreate(input: $input) { success comment { id body createdAt updatedAt url } }
          }
        `, { input: args });
        const result = requiredRecord(data, "commentCreate", "Linear did not return a comment creation result");
        const comment = requiredRecord(result, "comment", "Linear did not return the created comment");
        const id = requiredString(comment, "id", "Linear did not return the created comment ID");
        return { output: boundLinearValue(comment), summary: `Created a comment on Linear issue ${args.issueId}`, providerOperationId: id };
      }

      throw new ConnectorError("unsupported_capability", `Unsupported Linear tool: ${name}`);
    },

    async healthCheck(connection) {
      if (!connection) return { ok: true, message: "Linear OAuth is configured" };
      assertWorkspaceConnection(connection);
      const data = await graphql(connection, AbortSignal.timeout(15_000), "query AvalonLinearHealth { viewer { id } }");
      const viewer = recordValue(data, "viewer");
      return viewer?.id ? { ok: true, message: "Linear authorization is healthy" } : { ok: false, message: "Linear did not return an app identity" };
    },
  };
}

export interface VerifyLinearWebhookInput {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
  deliveryHeader: string | null;
  eventHeader?: string | null;
  timestampHeader?: string | null;
  now?: number;
  replayWindowMs?: number;
  maxBytes?: number;
}

export interface VerifiedLinearWebhook {
  deliveryId: string;
  eventName: string;
  organizationId: string;
  webhookId: string;
  webhookTimestamp: number;
  bodyHash: string;
  event: Record<string, unknown>;
}

export async function verifyLinearWebhook(input: VerifyLinearWebhookInput): Promise<VerifiedLinearWebhook> {
  const maxBytes = input.maxBytes ?? LINEAR_WEBHOOK_BYTES;
  if (new TextEncoder().encode(input.rawBody).byteLength > maxBytes) {
    throw new ConnectorError("payload_too_large", "The Linear webhook exceeded the configured size limit");
  }
  await verifyHmacSha256(input.secret, input.rawBody, input.signatureHeader);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody) as unknown;
  } catch (error) {
    throw new ConnectorError("provider_error", "Linear sent malformed webhook JSON", error);
  }
  if (!isRecord(parsed)) throw new ConnectorError("provider_error", "Linear sent an invalid webhook payload");
  const delivery = z.string().uuid().safeParse(input.deliveryHeader);
  if (!delivery.success) throw new ConnectorError("invalid_signature", "The Linear delivery ID is missing or malformed");
  const deliveryId = delivery.data;
  const webhookTimestamp = numberValue(parsed, "webhookTimestamp");
  if (webhookTimestamp == null) throw new ConnectorError("invalid_signature", "The Linear webhook timestamp is missing");
  if (input.timestampHeader != null) {
    const headerTimestamp = Number(input.timestampHeader);
    if (!Number.isFinite(headerTimestamp) || headerTimestamp !== webhookTimestamp) {
      throw new ConnectorError("invalid_signature", "The Linear webhook timestamp header does not match its payload");
    }
  }
  if (Math.abs((input.now ?? Date.now()) - webhookTimestamp) > (input.replayWindowMs ?? LINEAR_WEBHOOK_REPLAY_WINDOW_MS)) {
    throw new ConnectorError("invalid_signature", "The Linear webhook is outside the allowed replay window");
  }
  const type = requiredString(parsed, "type", "The Linear webhook type is missing");
  if (input.eventHeader && input.eventHeader !== type) {
    throw new ConnectorError("invalid_signature", "The Linear webhook event header does not match its payload");
  }
  return {
    deliveryId,
    eventName: type,
    organizationId: requiredString(parsed, "organizationId", "The Linear webhook organization is missing"),
    webhookId: requiredString(parsed, "webhookId", "The Linear webhook ID is missing"),
    webhookTimestamp,
    bodyHash: await sha256Hex(input.rawBody),
    event: parsed,
  };
}

export function normalizeLinearWebhook(
  connection: ConnectorConnectionContext,
  verified: VerifiedLinearWebhook,
  payloadRef: string | null = null,
): Omit<NormalizedActivity, "id"> {
  assertWorkspaceConnection(connection);
  const configuredOrganization = stringValue(connection.credentials, "organizationId") ?? stringValue(connection.config, "organizationId");
  if (configuredOrganization && configuredOrganization !== verified.organizationId) {
    throw new ConnectorError("unauthorized", "The Linear webhook does not belong to this installed organization");
  }
  const event = verified.event;
  const action = (stringValue(event, "action") ?? "update").toLowerCase();
  const type = toSnakeCase(verified.eventName);
  const data = recordValue(event, "data") ?? {};
  const actor = recordValue(event, "actor") ?? {};
  const resourceId = stringValue(data, "id");
  const url = stringValue(event, "url") ?? stringValue(data, "url");
  const label = stringValue(data, "identifier") ?? stringValue(data, "title") ?? stringValue(data, "name") ?? resourceId ?? verified.eventName;
  const text = stringValue(data, "body") ?? stringValue(data, "description") ?? stringValue(data, "content") ?? "";
  const occurredAt = validIso(stringValue(event, "createdAt")) ?? new Date(verified.webhookTimestamp).toISOString();
  const eventType = `linear.${type}.${action}`;
  const entityKeys = [resourceId, stringValue(data, "identifier"), url, verified.organizationId].filter((value): value is string => Boolean(value));
  return {
    workspaceId: connection.workspaceId,
    region: regionFromConnection(connection),
    connectionId: connection.id,
    connectionScope: connection.scope,
    connectionOwnerUserId: connection.ownerUserId,
    provider: "linear",
    providerEventId: verified.deliveryId,
    eventType,
    resourceType: linearResourceType(type),
    providerResourceId: resourceId,
    actor,
    subject: data,
    occurredAt,
    receivedAt: new Date().toISOString(),
    title: `Linear ${humanize(type)} ${action}: ${label}`.slice(0, 500),
    summary: truncateText(text || `${label} was ${action}d in Linear`, 1_000).text,
    textSnippet: truncateText(text, 4_000).text,
    payloadRef,
    visibility: { scope: connection.scope, organizationId: verified.organizationId },
    targetUserIds: [],
    entityKeys,
    dedupeKey: `${verified.webhookId}:${action}:${resourceId ?? verified.deliveryId}`,
    rawContentHash: verified.bodyHash,
    metadata: {
      deliveryId: verified.deliveryId,
      webhookId: verified.webhookId,
      organizationId: verified.organizationId,
      action,
      url,
      updatedFrom: recordValue(event, "updatedFrom") ?? {},
    },
  };
}

async function linearGraphql(
  fetcher: FetchLike,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const payload = await providerJson(fetcher, LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ query, variables }),
    signal,
  }, LINEAR_RESPONSE_BYTES);
  const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
  if (errors.length) {
    const first = errors[0]!;
    const extensions = recordValue(first, "extensions") ?? {};
    const code = stringValue(extensions, "code") ?? "GRAPHQL_ERROR";
    const message = stringValue(first, "message") ?? "Linear GraphQL request failed";
    if (["AUTHENTICATION_ERROR", "UNAUTHENTICATED", "INVALID_TOKEN"].includes(code)) {
      throw new ConnectorError("unauthorized", message, { status: 401, reconnectRequired: true, reason: "api_unauthorized" });
    }
    throw new ConnectorError("provider_error", message, { code });
  }
  return requiredRecord(payload, "data", "Linear returned no GraphQL data");
}

function normalizeToken(payload: Record<string, unknown>, now: number): Record<string, unknown> {
  const expiresIn = numberValue(payload, "expires_in");
  if (expiresIn == null || expiresIn <= 0) throw new ConnectorError("provider_error", "Linear did not return a valid token lifetime");
  const scope = payload.scope;
  return {
    accessToken: requiredString(payload, "access_token", "Linear did not return an access token"),
    refreshToken: requiredString(payload, "refresh_token", "Linear did not return a rotating refresh token"),
    tokenType: stringValue(payload, "token_type") ?? "Bearer",
    providerScopes: Array.isArray(scope) ? scope.filter((value): value is string => typeof value === "string") : typeof scope === "string" ? scope.split(/[ ,]+/u).filter(Boolean) : [],
    expiresAt: new Date(now + expiresIn * 1_000).toISOString(),
  };
}

function boundLinearValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateText(value, LINEAR_TEXT_CHARS).text;
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => boundLinearValue(item, depth + 1));
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, boundLinearValue(item, depth + 1)]));
}

function supportedScopeValues(): string[] {
  return Object.values(LinearCapabilityScopes).flatMap((value) => [...value]);
}
const supportedLinearScopes = new Set(supportedScopeValues());

function assertConfig(config: LinearConnectorConfig): void {
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new ConnectorError("invalid_configuration", "Linear OAuth client ID, secret, and redirect URI are required");
  }
  try {
    const redirect = new URL(config.redirectUri);
    if (redirect.protocol !== "https:" && redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") throw new Error("invalid protocol");
  } catch {
    throw new ConnectorError("invalid_configuration", "Linear OAuth redirect URI is invalid");
  }
}

function assertWorkspaceConnection(connection: ConnectorConnectionContext): void {
  if (connection.scope !== "workspace" || connection.ownerUserId !== null) {
    throw new ConnectorError("unauthorized", "Linear app connections must use Avalon workspace scope");
  }
}

function credentialString(connection: ConnectorConnectionContext, key: string): string {
  const value = stringValue(connection.credentials, key);
  if (!value) throw new ConnectorError("unauthorized", `Linear ${key} is missing`, { reconnectRequired: true, reason: `missing_${toSnakeCase(key)}` });
  return value;
}

function isProviderUnauthorized(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "unauthorized" && isRecord(error.details) && error.details.status === 401;
}

function isRefreshRejected(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError
    && isRecord(error.details)
    && [400, 401, 403].includes(Number(error.details.status));
}

function requiredRecord(record: Record<string, unknown>, key: string, message: string): Record<string, unknown> {
  const value = recordValue(record, key);
  if (!value) throw new ConnectorError("provider_error", message);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, message: string): string {
  const value = stringValue(record, key);
  if (!value) throw new ConnectorError("provider_error", message);
  return value;
}

function definedValues<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function idInputSchema(name: string): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties: { [name]: { type: "string", minLength: 1, maxLength: 200 } }, required: [name] };
}

function pageInputSchema(maximum: number): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false,
    properties: { first: { type: "integer", minimum: 1, maximum }, after: { type: ["string", "null"], maxLength: 500 } },
  };
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[^a-z0-9]+/giu, "_").replace(/^_+|_+$/gu, "").toLowerCase();
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function linearResourceType(type: string): string | null {
  if (["issue", "comment", "project", "document"].includes(type)) return `linear_${type}`;
  if (type === "project_update") return "linear_project";
  return null;
}

function validIso(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function regionFromConnection(connection: ConnectorConnectionContext): "global" | "eu" {
  return connection.config.region === "eu" ? "eu" : "global";
}
