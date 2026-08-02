import type {
  ConnectorManifest,
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

export interface ConnectorAdapter {
  manifest: ConnectorManifest;
  beginAuthorization?(input: Record<string, unknown>): Promise<{ url: string; state?: Record<string, unknown> }>;
  handleAuthorizationCallback?(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  refreshCredentials?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<Record<string, unknown>>;
  revoke?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<void>;
  poll?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<ConnectorPollResult>;
  hydrateResource?(connection: ConnectorConnectionContext, resource: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  executeTool(name: string, args: unknown, context: ConnectorToolContext): Promise<ConnectorToolResult>;
  healthCheck(connection?: ConnectorConnectionContext): Promise<{ ok: boolean; message: string }>;
}

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
