import type { ToolDefinition } from "@rally/contracts";
import { HttpsUrlSchema } from "@rally/contracts/url-schemas";
import { z } from "zod";
import {
  base64,
  isRecord,
  providerJson,
  readResponseBytes,
  stringValue,
  truncateText,
  type FetchLike,
} from "./provider-utils";
import {
  ConnectorError,
  type AuthorizedConnectorConnection,
  type ConnectorDynamicAgentTools,
  type ConnectorDynamicAgentCatalog,
  type ConnectorServerMetadata,
  type ConnectorToolResult,
} from "./types";

export const HOSTED_MCP_PROTOCOL_VERSION = "2025-06-18";

const HOSTED_MCP_CLIENT_NAME = "Rally";
const HOSTED_MCP_CLIENT_VERSION = "1.0.0";
export const HOSTED_MCP_DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** The shared hosted-MCP response ceiling, for callers reading a catalog directly. */
export const HOSTED_MCP_DEFAULT_RESPONSE_BYTES = 2_000_000;
const DEFAULT_RESPONSE_BYTES = HOSTED_MCP_DEFAULT_RESPONSE_BYTES;
const MAX_TOOL_COUNT = 128;
const MAX_TOOL_PAGES = 20;
const MAX_SCHEMA_BYTES = 100_000;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_RESULT_STRING_CHARS = 80_000;

const ProtectedResourceMetadataSchema = z.looseObject({
  resource: HttpsUrlSchema,
  authorization_servers: z.array(HttpsUrlSchema).min(1),
  scopes_supported: z.array(z.string().min(1)).optional(),
});

const AuthorizationServerMetadataSchema = z.looseObject({
  authorization_endpoint: HttpsUrlSchema,
  token_endpoint: HttpsUrlSchema,
  registration_endpoint: HttpsUrlSchema,
  revocation_endpoint: HttpsUrlSchema.optional(),
  scopes_supported: z.array(z.string().min(1)).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

const ClientRegistrationSchema = z.looseObject({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional(),
});

const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().min(1).default("Bearer"),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  user_id: z.string().min(1).optional(),
  workspace_id: z.string().min(1).optional(),
  email_domain: z.string().optional(),
});

const McpToolInputSchema = z.looseObject({
  type: z.literal("object"),
});

const McpToolSchema = z.looseObject({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  inputSchema: McpToolInputSchema,
  annotations: z.looseObject({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }).optional(),
});

const ToolsListResultSchema = z.looseObject({
  tools: z.array(McpToolSchema),
  nextCursor: z.string().min(1).optional(),
});

const ToolCallResultSchema = z.looseObject({
  content: z.array(z.unknown()).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});

export type HostedMcpTool = z.infer<typeof McpToolSchema>;
export type HostedMcpTokenResponse = z.infer<typeof TokenResponseSchema>;

export interface HostedMcpOAuthState extends Record<string, unknown> {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  scope: string;
}

export interface HostedMcpOAuthConfig {
  providerName: string;
  serverUrl: string;
  redirectUri: string;
  /** Explicit native-app exception; ordinary callbacks remain HTTPS-only. */
  allowLoopbackRedirect?: boolean;
  /** Provider-declared resource identifier when it differs from the MCP endpoint. */
  resourceUrl?: string;
  clientName?: string;
  clientUri?: string;
  /** Exact origins trusted to receive OAuth requests and client credentials. */
  allowedAuthorizationOrigins?: readonly string[];
  /**
   * Admit whichever authorization server the MCP resource itself advertises.
   *
   * A code-authored provider names its origins above, because Rally knows them
   * and a server that suddenly points somewhere else is a compromise rather
   * than a deployment. A server somebody typed into Rally has no such list to
   * check against: the URL is the trust anchor the person supplied, and RFC 9728
   * exists precisely so that resource can name its own authorization server.
   * Every endpoint must still be HTTPS and share that advertised origin.
   */
  trustAdvertisedAuthorizationServer?: boolean;
  /** Extra scopes Rally requires even when protected-resource metadata omits them. */
  additionalScopes?: readonly string[];
  fetch?: FetchLike;
  maxResponseBytes?: number;
}

/**
 * The exact headers one hosted-MCP request authenticates with.
 *
 * A bearer token is the common case and `hostedMcpBearerAuth` builds it, but a
 * server somebody configured in Rally may authenticate with headers of its own,
 * and those cannot be represented as a token.
 */
export type HostedMcpRequestAuth = Readonly<Record<string, string>>;

export function hostedMcpBearerAuth(accessToken: string): HostedMcpRequestAuth {
  return { authorization: `Bearer ${accessToken}` };
}

interface HostedMcpPassthroughBaseConfig {
  providerName: string;
  /**
   * The MCP endpoint, or a resolver that reads it from the connection for a
   * connector whose server is configured per connection rather than in source.
   */
  serverUrl: string | ((connection: AuthorizedConnectorConnection) => string);
  capabilities: readonly string[];
  connectionScopes: ConnectorDynamicAgentTools["connectionScopes"];
  /** Select the capability written into this connection's discovered tools. */
  capabilityForConnection(connection: AuthorizedConnectorConnection): string;
  /**
   * Narrow the server's own catalog before Rally converts it.
   *
   * Applied at discovery and again to the fresh catalog read before every
   * `tools/call`, so a tool this rejects is unreachable rather than merely
   * unadvertised — an activation that predates a narrowing cannot spend it.
   */
  selectTools?(
    tools: readonly HostedMcpTool[],
    connection: AuthorizedConnectorConnection,
  ): readonly HostedMcpTool[];
  /** Enable the shared protected-resource discovery, DCR, and PKCE flow. */
  oauth?: Omit<HostedMcpOAuthConfig, "providerName" | "serverUrl" | "fetch" | "maxResponseBytes">;
  /** Rally-authored deadlines keyed by the exact provider operation name. */
  toolTimeoutMsByName?: Readonly<Record<string, number>>;
  fetch?: FetchLike;
  maxResponseBytes?: number;
}

/**
 * How a declaration authenticates, as exactly one of two shapes rather than two
 * optional callbacks: a provider holding a bearer token, or a connection
 * carrying its own request headers. Offering both would leave which one wins to
 * the order of two `??` at a call site nobody reads.
 */
interface HostedMcpBearerAccess {
  withAccessToken<T>(
    connection: AuthorizedConnectorConnection,
    signal: AbortSignal,
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T>;
  withRequestAuth?: never;
}

interface HostedMcpHeaderAccess {
  withRequestAuth<T>(
    connection: AuthorizedConnectorConnection,
    signal: AbortSignal,
    operation: (auth: HostedMcpRequestAuth) => Promise<T>,
  ): Promise<T>;
  withAccessToken?: never;
}

export type HostedMcpPassthroughConfig =
  HostedMcpPassthroughBaseConfig & (HostedMcpBearerAccess | HostedMcpHeaderAccess);

export interface HostedMcpAuthorization {
  /** `serverUrl` names the resource when the declaration resolves one per connection. */
  begin(input: {
    state: string;
    codeChallenge: string;
    serverUrl?: string;
  }): Promise<{ url: string; state: HostedMcpOAuthState }>;
  exchangeCode(
    state: HostedMcpOAuthState,
    input: { code: string; codeVerifier: string },
  ): Promise<HostedMcpTokenResponse>;
  refresh(
    state: HostedMcpOAuthState,
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<HostedMcpTokenResponse>;
  parseState(value: unknown): HostedMcpOAuthState;
}

export interface HostedMcpPassthrough {
  dynamicAgentTools: ConnectorDynamicAgentTools;
  /** Standards-based OAuth, present when the declaration includes `oauth`. */
  authorization?: HostedMcpAuthorization;
  /** Call through this declaration with a freshly issued token, for callback identity lookups. */
  call(
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: unknown; tool: HostedMcpTool }>;
  execute(
    connection: AuthorizedConnectorConnection,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ConnectorToolResult>;
}

export interface AuthorizedHostedMcpPassthrough extends HostedMcpPassthrough {
  authorization: HostedMcpAuthorization;
}

/**
 * Build the complete live-tool half of a hosted-MCP connector.
 *
 * The server remains authoritative for names, descriptions, schemas, and tool
 * additions/removals. Rally contributes only its authorization capability and
 * conservative execution policy. Provider annotations remain model hints, not
 * authorization facts, so every dynamic tool uses conservative write execution and a
 * durable record-before-execute receipt.
 */
export function createHostedMcpPassthrough(
  config: HostedMcpPassthroughConfig & { oauth: NonNullable<HostedMcpPassthroughConfig["oauth"]> },
): AuthorizedHostedMcpPassthrough;
export function createHostedMcpPassthrough(config: HostedMcpPassthroughConfig): HostedMcpPassthrough;
export function createHostedMcpPassthrough(config: HostedMcpPassthroughConfig): HostedMcpPassthrough {
  const fetcher = config.fetch ?? globalThis.fetch;
  const declaredServerUrl = typeof config.serverUrl === "string" ? normalizeHttpsUrl(config.serverUrl) : null;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES;

  /** The adapter-level endpoint, for the paths that have no connection to read. */
  const requireDeclaredServerUrl = (): string => {
    if (!declaredServerUrl) {
      throw new ConnectorError(
        "invalid_configuration",
        `${config.providerName} MCP resolves its server per connection and has no adapter-level endpoint`,
      );
    }
    return declaredServerUrl;
  };
  const serverUrlFor = (connection: AuthorizedConnectorConnection): string => (
    declaredServerUrl ?? normalizeHttpsUrl((config.serverUrl as (
      value: AuthorizedConnectorConnection,
    ) => string)(connection))
  );
  const withAuth = <T>(
    connection: AuthorizedConnectorConnection,
    signal: AbortSignal,
    operation: (auth: HostedMcpRequestAuth) => Promise<T>,
  ): Promise<T> => (config.withRequestAuth
    ? config.withRequestAuth(connection, signal, operation)
    : config.withAccessToken(
        connection,
        signal,
        (accessToken) => operation(hostedMcpBearerAuth(accessToken)),
      ));
  const selectTools = config.selectTools;
  const authorizedCapability = (connection: AuthorizedConnectorConnection): string => {
    const capability = config.capabilityForConnection(connection);
    if (!config.capabilities.includes(capability) || !connection.grantedScopes.includes(capability)) {
      throw new ConnectorError("unsupported_capability", `${config.providerName} MCP access is not granted`);
    }
    return capability;
  };
  const call = (
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: unknown; tool: HostedMcpTool }> => callHostedMcpTool({
    providerName: config.providerName,
    serverUrl: requireDeclaredServerUrl(),
    auth: hostedMcpBearerAuth(accessToken),
    name,
    args,
    signal,
    fetch: fetcher,
    maxResponseBytes,
  });
  const discoverCatalog = async (
    connection: AuthorizedConnectorConnection,
    signal: AbortSignal,
  ): Promise<ConnectorDynamicAgentCatalog> => {
    const capability = authorizedCapability(connection);
    const serverUrl = serverUrlFor(connection);
    return withAuth(
      connection,
      signal,
      async (auth) => {
        const catalog = await listHostedMcpCatalog({
          providerName: config.providerName,
          serverUrl,
          auth,
          signal,
          fetch: fetcher,
          maxResponseBytes,
        });
        const selected = selectTools ? selectTools(catalog.tools, connection) : catalog.tools;
        return {
          tools: hostedMcpToolDefinitions(selected, capability, config.toolTimeoutMsByName),
          server: hostedMcpServerMetadata(catalog.server, selected),
        };
      },
    );
  };
  const oauthConfigFor = (serverUrl: string): HostedMcpOAuthConfig => ({
    ...config.oauth!,
    providerName: config.providerName,
    serverUrl,
    fetch: fetcher,
    maxResponseBytes,
  });
  const authorization: HostedMcpAuthorization | null = config.oauth
    ? {
        begin: (input) => beginHostedMcpAuthorization(
          oauthConfigFor(input.serverUrl ?? requireDeclaredServerUrl()),
          input,
        ),
        exchangeCode: (state, input) => exchangeHostedMcpAuthorizationCode(
          oauthConfigFor(state.resource),
          state,
          input,
        ),
        refresh: (state, refreshToken, signal) => refreshHostedMcpAuthorization(
          oauthConfigFor(state.resource),
          state,
          refreshToken,
          signal,
        ),
        parseState: parseHostedMcpOAuthState,
      }
    : null;

  return {
    dynamicAgentTools: {
      capabilities: [...config.capabilities],
      connectionScopes: [...config.connectionScopes],
      discover: async (connection, signal) => (await discoverCatalog(connection, signal)).tools,
      discoverCatalog,
    },
    ...(authorization ? { authorization } : {}),
    call,
    async execute(connection, name, rawArgs, signal) {
      if (!isRecord(rawArgs)) {
        throw new ConnectorError("invalid_payload", `${config.providerName} MCP tool arguments must be an object`);
      }
      authorizedCapability(connection);
      const serverUrl = serverUrlFor(connection);
      const invoked = await withAuth(connection, signal, (auth) => callHostedMcpTool({
        providerName: config.providerName,
        serverUrl,
        auth,
        name,
        args: rawArgs,
        signal,
        fetch: fetcher,
        maxResponseBytes,
        ...(selectTools ? { selectTools: (tools) => selectTools(tools, connection) } : {}),
      }));
      return {
        output: boundHostedMcpValue(invoked.output),
        summary: `Used ${config.providerName} MCP tool ${name}`,
      };
    },
  };
}

export function hostedMcpToolDefinitions(
  tools: readonly HostedMcpTool[],
  capability: string,
  toolTimeoutMsByName: Readonly<Record<string, number>> = {},
): ToolDefinition[] {
  const parsedTools = z.array(McpToolSchema).parse(tools);
  const definitions: ToolDefinition[] = [];
  const remoteNames = new Set<string>();
  const canonicalNames = new Set<string>();
  const wireNames = new Set<string>();
  for (const tool of parsedTools) {
    if (remoteNames.has(tool.name)) {
      throw new ConnectorError("provider_error", `Hosted MCP returned duplicate tool ${tool.name}`);
    }
    const canonicalName = avalonHostedMcpToolName(tool.name);
    const wireName = normalizeToolWireName(canonicalName);
    if (canonicalNames.has(canonicalName)) {
      throw new ConnectorError("provider_error", `Hosted MCP tool names collide after canonicalization: ${tool.name}`);
    }
    if (!wireName || wireNames.has(wireName)) {
      throw new ConnectorError("provider_error", `Hosted MCP tool names collide after normalization: ${tool.name}`);
    }
    const schemaBytes = new TextEncoder().encode(JSON.stringify(tool.inputSchema)).byteLength;
    if (schemaBytes > MAX_SCHEMA_BYTES) {
      throw new ConnectorError("payload_too_large", `Hosted MCP schema for ${tool.name} is too large`);
    }
    remoteNames.add(tool.name);
    canonicalNames.add(canonicalName);
    wireNames.add(wireName);
    const timeoutMs = Object.hasOwn(toolTimeoutMsByName, tool.name)
      ? toolTimeoutMsByName[tool.name]!
      : HOSTED_MCP_DEFAULT_TOOL_TIMEOUT_MS;
    definitions.push({
      name: canonicalName,
      providerOperationName: tool.name,
      description: cleanDescription(tool.description, tool.name),
      inputSchema: structuredClone(tool.inputSchema),
      capability,
      mode: "write",
      idempotency: "record_before_execute",
      timeoutMs,
    });
  }
  if (!definitions.length) {
    throw new ConnectorError("unsupported_capability", "Hosted MCP exposed no model-compatible tools");
  }
  return definitions;
}

export async function beginHostedMcpAuthorization(
  config: HostedMcpOAuthConfig,
  input: { state: string; codeChallenge: string },
): Promise<{ url: string; state: HostedMcpOAuthState }> {
  const fetcher = config.fetch ?? globalThis.fetch;
  const serverUrl = normalizeHttpsUrl(config.serverUrl);
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES;
  const allowedOrigins = new Set(
    (config.allowedAuthorizationOrigins ?? [new URL(serverUrl).origin]).map(normalizeHttpsOrigin),
  );
  const protectedMetadata = ProtectedResourceMetadataSchema.parse(await discoverOAuthMetadata(
    fetcher,
    protectedResourceMetadataUrls(config.resourceUrl ?? serverUrl),
    maxResponseBytes,
  ));
  if (normalizeHttpsUrl(protectedMetadata.resource) !== normalizeHttpsUrl(config.resourceUrl ?? serverUrl)) {
    throw new ConnectorError("invalid_configuration", `${config.providerName} MCP advertised an unexpected protected resource`);
  }
  const authorizationServer = normalizeHttpsUrl(protectedMetadata.authorization_servers[0]!);
  // A server Rally names in source is checked against the origins Rally knows.
  // A server somebody configured has no such list, so the resource it typed is
  // allowed to name its own authorization server — and that origin, once
  // admitted, still has to cover every endpoint below.
  if (config.trustAdvertisedAuthorizationServer) allowedOrigins.add(normalizeHttpsOrigin(authorizationServer));
  if (!allowedOrigins.has(new URL(authorizationServer).origin)) {
    throw new ConnectorError("invalid_configuration", `${config.providerName} MCP advertised an untrusted authorization server`);
  }
  const metadata = AuthorizationServerMetadataSchema.parse(await discoverOAuthMetadata(
    fetcher,
    authorizationServerMetadataUrls(authorizationServer),
    maxResponseBytes,
  ));
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint, ...(metadata.revocation_endpoint ? [metadata.revocation_endpoint] : [])]) {
    if (!allowedOrigins.has(new URL(endpoint).origin)) {
      throw new ConnectorError("invalid_configuration", `${config.providerName} MCP advertised an untrusted OAuth endpoint`);
    }
  }
  if (!(metadata.code_challenge_methods_supported ?? []).includes("S256")) {
    throw new ConnectorError("unsupported_capability", `${config.providerName} OAuth does not advertise PKCE S256`);
  }
  const advertisedMethods = metadata.token_endpoint_auth_methods_supported ?? ["none"];
  const requestedAuthMethod = advertisedMethods.includes("client_secret_post")
    ? "client_secret_post" as const
    : advertisedMethods.includes("none")
      ? "none" as const
      : advertisedMethods.includes("client_secret_basic")
        ? "client_secret_basic" as const
        : null;
  if (!requestedAuthMethod) {
    throw new ConnectorError("unsupported_capability", `${config.providerName} OAuth does not advertise a supported token authentication method`);
  }
  const scopes = [...new Set([
    ...(protectedMetadata.scopes_supported ?? metadata.scopes_supported ?? []),
    ...(config.additionalScopes ?? []),
  ])];
  const registered = ClientRegistrationSchema.parse(await providerJson(
    fetcher,
    metadata.registration_endpoint,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_name: config.clientName ?? HOSTED_MCP_CLIENT_NAME,
        ...(config.clientUri ? { client_uri: config.clientUri } : {}),
        redirect_uris: [normalizeHostedMcpRedirect(config.redirectUri, config.allowLoopbackRedirect)],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: requestedAuthMethod,
        ...(scopes.length ? { scope: scopes.join(" ") } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    },
    maxResponseBytes,
  ));
  const tokenEndpointAuthMethod = registered.token_endpoint_auth_method ?? requestedAuthMethod;
  if (tokenEndpointAuthMethod !== "none" && !registered.client_secret) {
    throw new ConnectorError("provider_error", `${config.providerName} OAuth registration omitted its client secret`);
  }
  const authorizationState: HostedMcpOAuthState = {
    resource: protectedMetadata.resource,
    authorizationEndpoint: normalizeHttpsUrl(metadata.authorization_endpoint),
    tokenEndpoint: normalizeHttpsUrl(metadata.token_endpoint),
    ...(metadata.revocation_endpoint ? { revocationEndpoint: normalizeHttpsUrl(metadata.revocation_endpoint) } : {}),
    clientId: registered.client_id,
    ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
    tokenEndpointAuthMethod,
    scope: scopes.join(" "),
  };
  const url = new URL(authorizationState.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", authorizationState.clientId);
  url.searchParams.set("redirect_uri", normalizeHostedMcpRedirect(config.redirectUri, config.allowLoopbackRedirect));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", authorizationState.resource);
  if (authorizationState.scope) url.searchParams.set("scope", authorizationState.scope);
  url.searchParams.set("prompt", "consent");
  return { url: url.toString(), state: authorizationState };
}

export async function exchangeHostedMcpAuthorizationCode(
  config: Pick<HostedMcpOAuthConfig, "providerName" | "redirectUri" | "allowLoopbackRedirect" | "fetch" | "maxResponseBytes">,
  state: HostedMcpOAuthState,
  input: { code: string; codeVerifier: string },
): Promise<HostedMcpTokenResponse> {
  return hostedMcpTokenRequest(config, state, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: normalizeHostedMcpRedirect(config.redirectUri, config.allowLoopbackRedirect),
    resource: state.resource,
  });
}

export async function refreshHostedMcpAuthorization(
  config: Pick<HostedMcpOAuthConfig, "providerName" | "fetch" | "maxResponseBytes">,
  state: HostedMcpOAuthState,
  refreshToken: string,
  signal: AbortSignal,
): Promise<HostedMcpTokenResponse> {
  return hostedMcpTokenRequest(config, state, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource: state.resource,
  }, signal);
}

/** RFC 7009: a successful revocation may have an empty response body. */
export async function revokeHostedMcpAuthorization(
  config: Pick<HostedMcpOAuthConfig, "providerName" | "fetch">,
  state: HostedMcpOAuthState,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token",
  signal: AbortSignal,
): Promise<void> {
  if (!state.revocationEndpoint) {
    throw new ConnectorError("unsupported_capability", `${config.providerName} did not advertise token revocation`);
  }
  const form = new URLSearchParams({ token, token_type_hint: tokenTypeHint, client_id: state.clientId });
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (state.tokenEndpointAuthMethod !== "none" && !state.clientSecret) {
    throw new ConnectorError("invalid_configuration", `${config.providerName} OAuth client secret is unavailable`);
  }
  if (state.tokenEndpointAuthMethod === "client_secret_post") form.set("client_secret", state.clientSecret!);
  if (state.tokenEndpointAuthMethod === "client_secret_basic") {
    headers.set("authorization", `Basic ${base64(`${state.clientId}:${state.clientSecret}`)}`);
  }
  const response = await (config.fetch ?? globalThis.fetch)(state.revocationEndpoint, {
    method: "POST", headers, body: form, signal, redirect: "error",
  });
  await response.body?.cancel();
  if (!response.ok) throw new ConnectorError("provider_error", `${config.providerName} refused token revocation`, { status: response.status });
}

export function parseHostedMcpOAuthState(value: unknown): HostedMcpOAuthState {
  const parsed = z.object({
    resource: HttpsUrlSchema,
    authorizationEndpoint: HttpsUrlSchema,
    tokenEndpoint: HttpsUrlSchema,
    revocationEndpoint: HttpsUrlSchema.optional(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).nullable().optional(),
    tokenEndpointAuthMethod: z.enum(["none", "client_secret_post", "client_secret_basic"]),
    scope: z.string(),
  }).parse(value);
  return {
    resource: parsed.resource,
    authorizationEndpoint: normalizeHttpsUrl(parsed.authorizationEndpoint),
    tokenEndpoint: normalizeHttpsUrl(parsed.tokenEndpoint),
    ...(parsed.revocationEndpoint ? { revocationEndpoint: normalizeHttpsUrl(parsed.revocationEndpoint) } : {}),
    clientId: parsed.clientId,
    ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
    tokenEndpointAuthMethod: parsed.tokenEndpointAuthMethod,
    scope: parsed.scope,
  };
}

async function hostedMcpTokenRequest(
  config: Pick<HostedMcpOAuthConfig, "providerName" | "fetch" | "maxResponseBytes">,
  state: HostedMcpOAuthState,
  fields: Record<string, string>,
  signal: AbortSignal = AbortSignal.timeout(15_000),
): Promise<HostedMcpTokenResponse> {
  const form = new URLSearchParams({ ...fields, client_id: state.clientId });
  const headers = new Headers({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
  if (state.tokenEndpointAuthMethod === "client_secret_post") {
    if (!state.clientSecret) throw new ConnectorError("invalid_configuration", `${config.providerName} OAuth client secret is unavailable`);
    form.set("client_secret", state.clientSecret);
  } else if (state.tokenEndpointAuthMethod === "client_secret_basic") {
    if (!state.clientSecret) throw new ConnectorError("invalid_configuration", `${config.providerName} OAuth client secret is unavailable`);
    headers.set("authorization", `Basic ${base64(`${state.clientId}:${state.clientSecret}`)}`);
  }
  return TokenResponseSchema.parse(await providerJson(
    config.fetch ?? globalThis.fetch,
    state.tokenEndpoint,
    { method: "POST", headers, body: form, signal },
    config.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
  ));
}

export async function listHostedMcpTools(input: HostedMcpRequestInput): Promise<HostedMcpTool[]> {
  return (await listHostedMcpCatalog(input)).tools;
}

export async function listHostedMcpCatalog(input: HostedMcpRequestInput): Promise<{
  tools: HostedMcpTool[];
  server: { description?: string; instructions?: string };
}> {
  return withHostedMcpSession(input, async (session) => ({
    tools: await listSessionTools(input, session), server: session.server,
  }));
}

/** Reuse the existing tool-description bound for the server's catalog description. */
export function hostedMcpServerMetadata(
  server: { description?: string; instructions?: string },
  tools: readonly HostedMcpTool[],
): ConnectorServerMetadata {
  const description = server.description?.trim() || `Available tools: ${tools.map((tool) =>
    `${tool.name}${tool.description?.trim() ? `: ${tool.description.trim()}` : ""}`).join("; ")}`;
  return {
    description: cleanDescription(description.replace(/[\p{Cc}\p{Cf}\s]+/gu, " "), "MCP server"),
    ...(server.instructions?.trim() ? { instructions: server.instructions.trim() } : {}),
  };
}

export async function callHostedMcpTool(
  input: HostedMcpRequestInput & {
    name: string;
    args: Record<string, unknown>;
    /** The same narrowing discovery applied, re-run against the fresh catalog. */
    selectTools?: (tools: readonly HostedMcpTool[]) => readonly HostedMcpTool[];
  },
): Promise<{ output: unknown; tool: HostedMcpTool }> {
  return withHostedMcpSession(input, async (session) => {
    const listed = await listSessionTools(input, session);
    // Re-run the activation-time collision checks against the fresh catalog.
    // The caller supplies the exact provider operation captured at activation;
    // a different remote tool that happens to equal its Rally alias must never
    // inherit the already-authorized call. The collision check reads the whole
    // catalog rather than the narrowed one: a name a policy hid still collides.
    hostedMcpToolDefinitions(listed, "hosted_mcp.execution");
    const tools = input.selectTools ? input.selectTools(listed) : listed;
    const tool = tools.find((candidate) => candidate.name === input.name);
    if (!tool) {
      throw new ConnectorError("unsupported_capability", `${input.providerName} MCP no longer exposes ${input.name}`);
    }
    const called = await mcpRequest(input, session, {
      jsonrpc: "2.0",
      id: session.nextId++,
      method: "tools/call",
      params: { name: tool.name, arguments: input.args },
    });
    const result = ToolCallResultSchema.parse(called);
    if (result.isError) {
      throw new ConnectorError("provider_error", mcpErrorText(result.content) ?? `${input.providerName} MCP tool ${input.name} failed`, result);
    }
    return { output: normalizeMcpToolOutput(result), tool };
  });
}

export interface HostedMcpRequestInput {
  providerName: string;
  serverUrl: string;
  auth: HostedMcpRequestAuth;
  signal: AbortSignal;
  fetch: FetchLike;
  maxResponseBytes: number;
}

interface HostedMcpSession {
  id: string | null;
  nextId: number;
  server: { description?: string; instructions?: string };
}

async function withHostedMcpSession<T>(
  input: HostedMcpRequestInput,
  operation: (session: HostedMcpSession) => Promise<T>,
): Promise<T> {
  const session: HostedMcpSession = { id: null, nextId: 1, server: {} };
  try {
    const initialized = z.looseObject({
      protocolVersion: z.string(),
      serverInfo: z.looseObject({ description: z.string().optional() }).optional(),
      instructions: z.string().optional(),
    }).parse(await mcpRequest(input, session, {
      jsonrpc: "2.0",
      id: session.nextId++,
      method: "initialize",
      params: {
        protocolVersion: HOSTED_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: HOSTED_MCP_CLIENT_NAME, version: HOSTED_MCP_CLIENT_VERSION },
      },
    }, false));
    if (initialized.protocolVersion !== HOSTED_MCP_PROTOCOL_VERSION) {
      throw new ConnectorError("unsupported_capability", `${input.providerName} MCP negotiated unsupported protocol ${initialized.protocolVersion}`);
    }
    session.server = {
      ...(initialized.serverInfo?.description === undefined ? {} : { description: initialized.serverInfo.description }),
      ...(initialized.instructions === undefined ? {} : { instructions: initialized.instructions }),
    };
    await mcpNotification(input, session, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    return await operation(session);
  } finally {
    if (session.id) await closeMcpSession(input, session.id);
  }
}

async function listSessionTools(
  input: HostedMcpRequestInput,
  session: HostedMcpSession,
): Promise<HostedMcpTool[]> {
  const tools: HostedMcpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > MAX_TOOL_PAGES) throw new ConnectorError("payload_too_large", `${input.providerName} MCP tool pagination exceeded its limit`);
    const listed = ToolsListResultSchema.parse(await mcpRequest(input, session, {
      jsonrpc: "2.0",
      id: session.nextId++,
      method: "tools/list",
      params: cursor ? { cursor } : {},
    }));
    tools.push(...listed.tools);
    if (tools.length > MAX_TOOL_COUNT) throw new ConnectorError("payload_too_large", `${input.providerName} MCP exposed too many tools`);
    cursor = listed.nextCursor;
    if (cursor && seenCursors.has(cursor)) {
      throw new ConnectorError("provider_error", `${input.providerName} MCP returned a repeated pagination cursor`);
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return tools;
}

async function mcpRequest(
  input: HostedMcpRequestInput,
  session: HostedMcpSession,
  request: Record<string, unknown> & { id: string | number },
  initialized = true,
): Promise<unknown> {
  const response = await fetchMcp(input, session, "POST", request, initialized);
  const payload = JsonRpcResponseSchema.parse(await readMcpResponse(response, input.maxResponseBytes, input.providerName));
  if (payload.id !== request.id) throw new ConnectorError("provider_error", `${input.providerName} MCP returned a mismatched JSON-RPC id`);
  if (payload.error) throw new ConnectorError("provider_error", payload.error.message, payload.error);
  return payload.result;
}

async function mcpNotification(
  input: HostedMcpRequestInput,
  session: HostedMcpSession,
  request: Record<string, unknown>,
): Promise<void> {
  const response = await fetchMcp(input, session, "POST", request, true);
  if (response.status === 202 || response.status === 204) return;
  if (response.ok) await response.body?.cancel().catch(() => undefined);
}

async function fetchMcp(
  input: HostedMcpRequestInput,
  session: HostedMcpSession,
  method: "POST" | "DELETE",
  request: Record<string, unknown> | null,
  initialized: boolean,
): Promise<Response> {
  const headers = new Headers(input.auth);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  if (initialized) headers.set("mcp-protocol-version", HOSTED_MCP_PROTOCOL_VERSION);
  if (session.id) headers.set("mcp-session-id", session.id);
  let response: Response;
  try {
    // Workers' native fetch rejects an arbitrary receiver. Keep the injected
    // function a plain call, rather than binding it to this request object.
    const fetcher = input.fetch;
    response = await fetcher(input.serverUrl, {
      method,
      headers,
      ...(request ? { body: JSON.stringify(request) } : {}),
      signal: input.signal,
      // Every request here carries a credential — a bearer token, or the
      // headers a person configured on the connection. A followed redirect
      // re-sends them to whatever host the response names, so a server that
      // answers `302 https://collector.example` would be handed them. The
      // runtime follows redirects by default, so this has to be said, and a
      // 3xx is then an answer rather than a step.
      redirect: "manual",
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    throw new ConnectorError("provider_error", `${input.providerName} MCP request could not be completed`, error);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError(
      "provider_error",
      `${input.providerName} MCP redirected the request; configure the endpoint it redirects to instead`,
      { status: response.status },
    );
  }
  session.id = response.headers.get("mcp-session-id") ?? session.id;
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter.trim())
      ? Math.max(0, Math.ceil(Number(retryAfter) * 1_000))
      : null;
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError(
      response.status === 401 || response.status === 403 ? "unauthorized" : "provider_error",
      `${input.providerName} MCP returned HTTP ${response.status}`,
      { status: response.status, ...(retryAfterMs != null ? { retryAfterMs } : {}) },
    );
  }
  return response;
}

async function readMcpResponse(response: Response, maxBytes: number, providerName: string): Promise<unknown> {
  const text = new TextDecoder().decode(await readResponseBytes(response, maxBytes));
  if (!text) throw new ConnectorError("provider_error", `${providerName} MCP returned an empty JSON-RPC response`);
  try {
    if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text) as unknown;
    const messages = text.split(/\r?\n\r?\n/u).flatMap((event) => {
      const data = event.split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") return [];
      return [JSON.parse(data) as unknown];
    });
    const message = messages.at(-1);
    if (!message) throw new Error("No SSE data message");
    return message;
  } catch (error) {
    throw new ConnectorError("provider_error", `${providerName} MCP returned malformed JSON-RPC`, error);
  }
}

async function closeMcpSession(input: HostedMcpRequestInput, sessionId: string): Promise<void> {
  try {
    await fetchMcp(
      { ...input, signal: AbortSignal.timeout(2_000) },
      { id: sessionId, nextId: 1, server: {} },
      "DELETE",
      null,
      true,
    );
  } catch {
    // Session cleanup is best effort after the requested operation completed.
  }
}

function normalizeMcpToolOutput(result: z.infer<typeof ToolCallResultSchema>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content.map((block) => {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      try {
        return JSON.parse(block.text) as unknown;
      } catch {
        return block.text;
      }
    }
    return block;
  });
  return content.length === 1 ? content[0] : content;
}

function mcpErrorText(content: readonly unknown[]): string | null {
  const text = content
    .filter((block): block is Record<string, unknown> => (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
    ))
    .map((block) => stringValue(block, "text"))
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  return text ? truncateText(text, 1_000).text : null;
}

function boundHostedMcpValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateText(value, MAX_RESULT_STRING_CHARS).text;
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => boundHostedMcpValue(item, depth + 1));
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value).slice(0, 200).map(([key, item]) => [key, boundHostedMcpValue(item, depth + 1)]),
  );
}

function cleanDescription(value: string | undefined, toolName: string): string {
  const clean = [...(value ?? `Remote MCP tool: ${toolName}`)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && character !== "\n" && character !== "\r" && character !== "\t")
        || code === 127
        ? " "
        : character;
    })
    .join("")
    .trim();
  return truncateText(clean || `Remote MCP tool: ${toolName}`, MAX_DESCRIPTION_CHARS).text;
}

function normalizeToolWireName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64);
}

function avalonHostedMcpToolName(value: string): string {
  return /^[a-z][a-z0-9_.-]*$/u.test(value) ? value : normalizeToolWireName(value);
}

function protectedResourceMetadataUrls(resource: string): URL[] {
  return oauthMetadataUrls(resource, "oauth-protected-resource");
}

function authorizationServerMetadataUrls(issuer: string): URL[] {
  return oauthMetadataUrls(issuer, "oauth-authorization-server");
}

/** RFC 9728 / RFC 8414 path insertion, followed by the MCP root fallback. */
function oauthMetadataUrls(identifier: string, metadataName: string): URL[] {
  const url = new URL(normalizeHttpsUrl(identifier));
  const pathSpecific = new URL(url.origin);
  pathSpecific.pathname = `/.well-known/${metadataName}${url.pathname === "/" ? "" : url.pathname}`;
  const root = new URL(`/.well-known/${metadataName}`, url.origin);
  return pathSpecific.href === root.href ? [pathSpecific] : [pathSpecific, root];
}

async function discoverOAuthMetadata(
  fetcher: FetchLike,
  urls: readonly URL[],
  maxResponseBytes: number,
): Promise<Record<string, unknown>> {
  let missing: unknown = null;
  for (const [index, url] of urls.entries()) {
    try {
      return await providerJson(
        fetcher,
        url,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
        maxResponseBytes,
      );
    } catch (error) {
      const status = error instanceof ConnectorError && isRecord(error.details)
        ? Number(error.details.status)
        : null;
      if (index === urls.length - 1 || (status !== 404 && status !== 405)) throw error;
      missing = error;
    }
  }
  throw missing ?? new ConnectorError("provider_error", "OAuth metadata is unavailable");
}

/** Only the fixed IPv4 loopback callback used by Rally's native listener. */
export function normalizeHostedMcpRedirect(value: string, allowLoopback = false): string {
  const url = new URL(value);
  if (allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1"
    && url.port && url.pathname === "/callback" && !url.username && !url.password
    && !url.search && !url.hash) return url.toString();
  return normalizeHttpsUrl(value);
}

function normalizeHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ConnectorError("invalid_configuration", "Hosted MCP URLs must use HTTPS without embedded credentials");
  }
  return url.toString();
}

function normalizeHttpsOrigin(value: string): string {
  return new URL(normalizeHttpsUrl(value)).origin;
}
