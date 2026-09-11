import { repairRootSchemaForProviders } from "@rally/agent-harness";
import { ToolDefinitionSchema, type ToolDefinition } from "@rally/contracts";
import { ConnectorError, connectorCapabilitySupportsScope, type ResolvedConnectorAdapter } from "@rally/connectors";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";

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

