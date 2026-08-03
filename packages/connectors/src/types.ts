import type {
  ConnectorManifest,
  ConnectorManifestInput,
  ExecutionPrincipal,
  NormalizedActivity,
  Scope,
} from "@avalon/contracts";

export interface ConnectorConnectionContext {
  id: string;
  workspaceId: string;
  scope: Scope;
  ownerUserId: string | null;
  grantedScopes: string[];
  credentials: Record<string, unknown>;
  cursor: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface ConnectorToolContext {
  connection: ConnectorConnectionContext;
  principal: ExecutionPrincipal;
  signal: AbortSignal;
}

export interface ConnectorToolResult {
  output: unknown;
  summary: string;
  providerOperationId?: string;
}

export interface ConnectorPollResult {
  activities: Omit<NormalizedActivity, "id">[];
  cursor: Record<string, unknown>;
  nextPollAt?: string;
}

export interface ConnectorNativeAgentExecutionContext {
  connection: ConnectorConnectionContext;
  signal: AbortSignal;
}

/**
 * Provider-native agent operations live in the connector control plane. They
 * are intentionally separate from model-callable tools and are dispatched by
 * a session coordinator only after provider routing and authorization checks.
 */
export interface ConnectorNativeAgentAdapter<
  Invocation = unknown,
  Command = unknown,
  Result = unknown,
> {
  capability: string;
  parseInvocation(payload: unknown): Invocation;
  execute(
    command: Command,
    context: ConnectorNativeAgentExecutionContext,
  ): Promise<Result>;
}

export interface ConnectorAuthorizationInput extends Record<string, unknown> {
  /**
   * The Avalon connection scope selected before leaving for the provider.
   * Providers with multiple OAuth actor types must use this trusted value rather
   * than inferring identity or ownership from requested provider scopes.
   */
  connectionScope?: Scope;
}

export interface ConnectorAuthorizationCallbackInput extends Record<string, unknown> {
  /** The connection scope recovered from Avalon's sealed OAuth state. */
  connectionScope?: Scope;
}

export interface ConnectorAdapter {
  manifest: ConnectorManifestInput;
  /**
   * Optional per-capability narrowing of the connector-wide supported scopes.
   * Omitted capabilities inherit `manifest.supportedScopes`.
   */
  capabilityConnectionScopes?: Readonly<Record<string, readonly Scope[]>>;
  nativeAgent?: ConnectorNativeAgentAdapter;
  beginAuthorization?(input: ConnectorAuthorizationInput): Promise<{ url: string; state?: Record<string, unknown> }>;
  handleAuthorizationCallback?(input: ConnectorAuthorizationCallbackInput): Promise<Record<string, unknown>>;
  refreshCredentials?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<Record<string, unknown>>;
  revoke?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<void>;
  poll?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<ConnectorPollResult>;
  hydrateResource?(connection: ConnectorConnectionContext, resource: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  executeTool(name: string, args: unknown, context: ConnectorToolContext): Promise<ConnectorToolResult>;
  healthCheck(connection?: ConnectorConnectionContext): Promise<{ ok: boolean; message: string }>;
}

export function connectorCapabilitySupportsScope(
  adapter: Pick<ConnectorAdapter, "manifest" | "capabilityConnectionScopes">,
  capability: string,
  scope: Scope,
): boolean {
  const declared = (adapter.manifest.capabilities ?? []).some((candidate) => candidate.id === capability)
    || adapter.manifest.tools.some((tool) => tool.capability === capability);
  if (!declared) return false;
  const supportedScopes = adapter.capabilityConnectionScopes?.[capability]
    ?? adapter.manifest.supportedScopes;
  return supportedScopes.includes(scope);
}

/** An adapter whose compatibility defaults and cross-field invariants were validated. */
export type ResolvedConnectorAdapter = Omit<ConnectorAdapter, "manifest"> & {
  manifest: ConnectorManifest;
};

export class ConnectorError extends Error {
  constructor(
    readonly code:
      | "invalid_configuration"
      | "unauthorized"
      | "invalid_signature"
      | "provider_error"
      | "unsupported_capability"
      | "payload_too_large"
      | "unsafe_url",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export function assertPrincipalAccess(
  connection: ConnectorConnectionContext,
  principal: ExecutionPrincipal,
): void {
  if (connection.scope === "workspace") {
    if (principal.type !== "workspace" || principal.workspaceId !== connection.workspaceId) {
      throw new ConnectorError("unauthorized", "The workspace connection is not available to this execution principal");
    }
    return;
  }
  if (principal.type !== "user" || principal.userId !== connection.ownerUserId) {
    throw new ConnectorError("unauthorized", "A personal connection cannot be used by another principal");
  }
}
