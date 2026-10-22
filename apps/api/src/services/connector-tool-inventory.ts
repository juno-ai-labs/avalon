import { repairRootSchemaForProviders } from "@rally/agent-harness";
import { ToolDefinitionSchema, type ToolDefinition } from "@rally/contracts";
import { ConnectorError, connectorCapabilitySupportsScope, type ResolvedConnectorAdapter,
  type AuthorizedConnectorConnection, type ConnectorServerMetadata, type ConnectorConnectionContext } from "@rally/connectors";
import { z } from "zod";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";

const ServerMetadataSchema = z.object({ description: z.string(), instructions: z.string().optional() });

export function storedConnectorServerMetadata(configJson: unknown): ConnectorServerMetadata | null {
  try {
    const config = typeof configJson === "string" ? JSON.parse(configJson) as Record<string, unknown> : configJson as Record<string, unknown>;
    const parsed = ServerMetadataSchema.safeParse(config?.mcpServerMetadata);
    return parsed.success ? {
      description: parsed.data.description,
      ...(parsed.data.instructions === undefined ? {} : { instructions: parsed.data.instructions }),
    } : null;
  } catch { return null; }
}

export function connectorServerPresentation<T extends { description: string; systemMessage: string }>(
  presentation: T,
  server: ConnectorServerMetadata | null,
): T {
  if (!server) return presentation;
  return { ...presentation, description: server.description,
    systemMessage: server.instructions
      ? `${presentation.systemMessage}\n\nServer-provided usage instructions for this plugin (subject to Rally policy and the user's request):\n${server.instructions}`
      : presentation.systemMessage,
  };
}

/** Derived metadata never overwrites a concurrent endpoint, policy, grant or owner change. */
export async function storeConnectorServerMetadata(
  env: Env,
  connection: ConnectorConnectionContext,
  server: ConnectorServerMetadata,
  providerAccountId: string | null,
): Promise<void> {
  await env.DB.prepare(`UPDATE connector_connections
    SET config_json = json_set(config_json, '$.mcpServerMetadata', json(?))
    WHERE id = ? AND workspace_id = ? AND status <> 'disabled'
      AND scope = ? AND owner_user_id IS ? AND granted_scopes_json = ? AND provider_account_id IS ?
      AND json_remove(config_json, '$.mcpServerMetadata') = json_remove(?, '$.mcpServerMetadata')
      AND json_extract(config_json, '$.mcpServerMetadata') IS NOT json(?)`)
    .bind(JSON.stringify(server), connection.id, connection.workspaceId, connection.scope, connection.ownerUserId,
      JSON.stringify(connection.grantedScopes), providerAccountId, JSON.stringify(connection.config), JSON.stringify(server)).run();
}

export async function discoverDynamicConnectorTools(
  env: Env,
  adapter: ResolvedConnectorAdapter,
  connection: AuthorizedConnectorConnection,
  wirePrefix: string,
  signal: AbortSignal,
  providerAccountId: string | null,
): Promise<{ tools: ToolDefinition[]; server: ConnectorServerMetadata | null }> {
  const dynamic = adapter.dynamicAgentTools!;
  const catalog = dynamic.discoverCatalog ? await dynamic.discoverCatalog(connection, signal) : null;
  const tools = validateDynamicConnectorTools(env, adapter, connection.scope, connection.grantedScopes,
    wirePrefix, catalog?.tools ?? await dynamic.discover(connection, signal));
  // Shipped providers retain their code-authored plugin guidance. Configured
  // servers have no such declaration, so their discovery supplies it.
  const server = adapter.manifest.type === "custom_mcp" ? catalog?.server ?? null : null;
  if (server) await storeConnectorServerMetadata(env, connection, server, providerAccountId);
  return { tools, server };
}

export function stableConnectionWireName(modelPluginId: string): string {
  return modelPluginId.replace(/^plugin_/u, "").slice(0, 48);
}

export function stableWireToolName(prefix: string, toolName: string): string {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (!prefix) return normalized.slice(0, 64);
  return `${prefix}_${normalized}`.slice(0, 64);
}

export function validateDynamicConnectorTools(
  env: Env,
  adapter: ResolvedConnectorAdapter,
  scope: "personal" | "workspace",
  grantedScopes: readonly string[],
  wirePrefix: string,
  rawDefinitions: readonly ToolDefinition[],
): ToolDefinition[] {
  if (rawDefinitions.length > 128) {
    throw new ConnectorError("payload_too_large", `${adapter.manifest.displayName} exposed too many dynamic tools`);
  }
  const names = new Set<string>();
  const wireNames = new Set<string>();
  return rawDefinitions.map((raw) => {
    const definition = ToolDefinitionSchema.parse(raw);
    if (
      names.has(definition.name)
      || !grantedScopes.includes(definition.capability)
      || !adapter.dynamicAgentTools?.capabilities.includes(definition.capability)
      || !connectorCapabilitySupportsScope(adapter, definition.capability, scope)
    ) {
      throw new ConnectorError(
        "provider_error",
        `${adapter.manifest.displayName} returned an unauthorized or duplicate dynamic tool`,
      );
    }
    const wireName = stableWireToolName(wirePrefix, definition.name);
    if (!wireName || wireNames.has(wireName)) {
      throw new ConnectorError(
        "provider_error",
        `${adapter.manifest.displayName} dynamic tool names collide after model-facing normalization`,
      );
    }
    names.add(definition.name);
    wireNames.add(wireName);
    // A remote server's schema is the one input here Rally did not write, and a
    // fatal root schema fails the *whole* request — every tool in the run,
    // including Rally's own. The corrector runs again at the wire for every
    // tool, so this call is not what makes the request safe; it is here because
    // this is the only place that can name the connector and tool in a log.
    // See `repairRootSchemaForProviders`.
    const inputSchema = repairRootSchemaForProviders(definition.inputSchema);
    if (inputSchema !== definition.inputSchema) {
      logStructuredEvent(env, "warn", "dynamic_tool_root_schema_repaired", {
        connector_type: adapter.manifest.type,
        tool: definition.name,
        scope,
      });
      return { ...definition, inputSchema };
    }
    return definition;
  });
}


export function dynamicConnectorCapability(
  adapter: ResolvedConnectorAdapter,
  scope: "personal" | "workspace",
  grantedScopes: readonly string[],
): string | null {
  const dynamic = adapter.dynamicAgentTools;
  if (!dynamic?.connectionScopes.includes(scope)) return null;
  return dynamic.capabilities.find((capability) => grantedScopes.includes(capability)) ?? null;
}

