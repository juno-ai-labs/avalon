import type {
  ConnectorActivityFilterField,
  ConnectorActivityTriggerDescriptor,
  ConnectorManifest,
  ConnectorManifestInput,
  ExecutionPrincipal,
  NormalizedActivity,
  Scope,
  ToolDefinition,
} from "@avalon/contracts";

function humanizeActivityEventType(eventType: string): string {
  const parts = eventType.split(".");
  if (parts.length > 2) parts.shift();
  const text = parts.join(" ").replaceAll("_", " ").trim();
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : eventType;
}

export function defineConnectorActivityTriggers(
  connectorName: string,
  eventTypes: readonly string[],
  overrides: Readonly<Record<string, Partial<Omit<ConnectorActivityTriggerDescriptor, "eventType">>>> = {},
): ConnectorActivityTriggerDescriptor[] {
  return eventTypes.map((eventType) => {
    const override = overrides[eventType] ?? {};
    return {
      eventType,
      label: override.label ?? humanizeActivityEventType(eventType),
      description: override.description ?? `${connectorName} activity normalized as ${eventType}.`,
      filterFields: [...(override.filterFields ?? [])] as ConnectorActivityFilterField[],
    };
  });
}

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
  /** Stable host receipt key when the provider supports idempotent writes. */
  providerIdempotencyKey?: string;
  /**
   * Provider invocation credentials captured by the trusted ingress host.
   * These values are never model-visible and must not be accepted in a tool
   * input schema or returned from a tool result.
   */
  invocationAuthorization?: {
    slackActionToken?: string;
  };
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
  streamErrors?: ConnectorActivityStreamError[];
}

/** One independently checkpointed provider activity feed. */
export interface ConnectorPollingActivityStream {
  /** Stable within a connector type and suitable for persistence keys. */
  id: string;
  /** Optional legacy connection-cursor key retained during cursor migrations. */
  legacyCursorKey?: string;
  idlePollIntervalSeconds: number;
  backlogPollIntervalSeconds?: number;
  failurePollIntervalSeconds?: number;
}

export interface ConnectorPollingActivityResult {
  activities: Omit<NormalizedActivity, "id">[];
  /**
   * Provider-native next checkpoint. It may be a sequence, date, cursor, or
   * composite object; the source's normalization hook canonicalizes it before
   * the host persists it.
   */
  highWatermark: unknown;
  hasMore: boolean;
}

/**
 * Activity interface for providers whose canonical feed must be pulled.
 * The host owns checkpoint persistence, retry scheduling, and deduplication;
 * providers only enumerate streams and translate one bounded page.
 */
export interface ConnectorPollingActivitySource {
  streams(connection: ConnectorConnectionContext): readonly ConnectorPollingActivityStream[];
  /**
   * Canonicalize provider-native and legacy checkpoints into a durable record.
   * This hook must be deterministic and idempotent, accept `undefined` for a
   * first poll, and accept its own prior output when a checkpoint is reloaded.
   */
  normalizeHighWatermark(
    connection: ConnectorConnectionContext,
    stream: ConnectorPollingActivityStream,
    highWatermark: unknown,
  ): Record<string, unknown>;
  pollStream(
    connection: ConnectorConnectionContext,
    stream: ConnectorPollingActivityStream,
    highWatermark: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ConnectorPollingActivityResult>;
}

export interface ConnectorWebhookVerificationInput {
  rawBody: string;
  /** Exact request bytes when signature verification must not re-encode text. */
  rawBodyBytes?: Uint8Array;
  headers: Headers;
  receivedAt: string;
  maxBytes: number;
  now: number;
  /** Host-managed secret for providers whose verification material rotates outside OAuth. */
  verificationSecret?: string;
  expectedProviderAccountId?: string;
  replayWindowMs?: number;
}

export interface ConnectorVerifiedActivityWebhook {
  deliveryId: string;
  eventType: string;
  providerAccountId: string | null;
  routingAccountIds?: string[];
  routingUserId?: string;
  bodyHash: string;
  /** Provider receipt identity when it differs from the canonical event ID. */
  receiptKey?: string;
  event: unknown;
}

/**
 * Activity interface for providers that push signed events to Avalon. The host
 * still owns connection routing, raw-payload storage, receipts, and queueing.
 */
export interface ConnectorWebhookActivitySource {
  verify(input: ConnectorWebhookVerificationInput): Promise<ConnectorVerifiedActivityWebhook>;
  normalize(
    connection: ConnectorConnectionContext,
    event: ConnectorVerifiedActivityWebhook,
    payloadRef: string | null,
  ): Omit<NormalizedActivity, "id"> | null;
}

export interface ConnectorActivityStreamError {
  streamId: string;
  code: string;
  message: string;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function streamFailure(error: unknown, streamId: string): ConnectorActivityStreamError {
  return {
    streamId,
    code: error instanceof ConnectorError ? error.code : "poll_failed",
    message: (error instanceof Error ? error.message : "Connector activity stream failed").slice(0, 500),
  };
}

/** Shared bounded orchestration for every checkpointed polling provider. */
export async function pollCheckpointedActivityStreams(
  source: ConnectorPollingActivitySource,
  connection: ConnectorConnectionContext,
  signal: AbortSignal,
): Promise<ConnectorPollResult> {
  const streams = [...source.streams(connection)];
  if (new Set(streams.map((stream) => stream.id)).size !== streams.length) {
    throw new ConnectorError("invalid_configuration", "Connector activity stream IDs must be unique");
  }
  const storedStreams = recordValue(connection.cursor.activityStreams);
  const results = await Promise.all(streams.map(async (stream) => {
    const stored = recordValue(storedStreams[stream.id]);
    try {
      const hasStoredHighWatermark = Object.prototype.hasOwnProperty.call(stored, "highWatermark");
      const rawHighWatermark = hasStoredHighWatermark
        ? stored.highWatermark
        : stream.legacyCursorKey
          ? connection.cursor[stream.legacyCursorKey]
          : undefined;
      const highWatermark = source.normalizeHighWatermark(connection, stream, rawHighWatermark);
      return {
        stream,
        result: await source.pollStream(
          connection,
          stream,
          highWatermark,
          signal,
        ),
        error: null,
      };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ConnectorError && error.code === "unauthorized") throw error;
      return { stream, result: null, error: streamFailure(error, stream.id) };
    }
  }));

  const nextStreams: Record<string, unknown> = { ...storedStreams };
  const cursor: Record<string, unknown> = { ...connection.cursor };
  const activities: Omit<NormalizedActivity, "id">[] = [];
  const streamErrors: ConnectorActivityStreamError[] = [];
  let nextDelaySeconds = Number.POSITIVE_INFINITY;
  for (const item of results) {
    if (item.result) {
      const highWatermark = source.normalizeHighWatermark(
        connection,
        item.stream,
        item.result.highWatermark,
      );
      activities.push(...item.result.activities);
      nextStreams[item.stream.id] = {
        highWatermark,
        checkpointedAt: new Date().toISOString(),
      };
      if (item.stream.legacyCursorKey) cursor[item.stream.legacyCursorKey] = highWatermark;
      nextDelaySeconds = Math.min(
        nextDelaySeconds,
        item.result.hasMore
          ? item.stream.backlogPollIntervalSeconds ?? 5
          : item.stream.idlePollIntervalSeconds,
      );
    } else if (item.error) {
      streamErrors.push(item.error);
      nextDelaySeconds = Math.min(
        nextDelaySeconds,
        item.stream.failurePollIntervalSeconds ?? 60,
      );
    }
  }
  cursor.activityStreams = nextStreams;
  if (!Number.isFinite(nextDelaySeconds)) nextDelaySeconds = 300;
  return {
    activities,
    cursor,
    nextPollAt: new Date(Date.now() + nextDelaySeconds * 1_000).toISOString(),
    ...(streamErrors.length > 0 ? { streamErrors } : {}),
  };
}

export interface ConnectorAgentExecutionContext {
  connection: ConnectorConnectionContext;
  signal: AbortSignal;
}

/**
 * Provider-hosted agent operations live in the connector control plane. They
 * are intentionally separate from model-callable tools. The activation hook
 * produces a deterministic provider command which the host dispatches after
 * durable admission and before model or tool processing.
 */
export interface ConnectorAgentAdapter<
  Invocation = unknown,
  Command = unknown,
  Result = unknown,
> {
  capability: string;
  parseInvocation(payload: unknown): Invocation;
  activationAcknowledgement?(invocation: Invocation): Command | null;
  execute(
    command: Command,
    context: ConnectorAgentExecutionContext,
  ): Promise<Result>;
}

/** Provider-hosted conversational ingress parsed only after request verification. */
export type ConnectorMessagingAgentAdapter<
  Invocation = unknown,
  Command = unknown,
  Result = unknown,
> = ConnectorAgentAdapter<Invocation, Command, Result>;

/** Provider-native session ingress such as Linear Agent Sessions. */
export type ConnectorNativeAgentAdapter<
  Invocation = unknown,
  Command = unknown,
  Result = unknown,
> = ConnectorAgentAdapter<Invocation, Command, Result>;

/** Backward-compatible name for native-agent call sites. */
export type ConnectorNativeAgentExecutionContext = ConnectorAgentExecutionContext;

export async function acknowledgeConnectorAgentActivation<Invocation, Command, Result>(
  adapter: ConnectorAgentAdapter<Invocation, Command, Result>,
  invocation: Invocation,
  context: ConnectorAgentExecutionContext,
): Promise<Result | null> {
  const command = adapter.activationAcknowledgement?.(invocation) ?? null;
  return command === null ? null : adapter.execute(command, context);
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

/**
 * Trusted, provider-level metadata used to construct one model plugin for each
 * installed credential. Every field in this descriptor must be a static,
 * code-authored value. Connection labels, account names, provider resources,
 * credential values, and other remotely controlled content must never be
 * interpolated into it.
 *
 * The runtime owns credential-specific identity. The opaque
 * `connection:<uuid>` ID remains the authorization identity, while the
 * database assigns a stable workspace-local model ID such as `plugin_google`.
 * This descriptor intentionally contains no installed-connection metadata.
 */
export interface ConnectorAgentPluginDescriptor {
  /** Stable provider type. Must equal `manifest.type`. */
  readonly providerType: string;
  /** Stable, identifier-safe provider prefix used by model-facing tool names. */
  readonly wireNamePrefix: string;
  /** Compact trusted description shown in the progressive plugin catalog. */
  readonly description: string;
  /** Static provider guidance included only while this plugin is active. */
  readonly systemMessage: string;
  /** Provider tool definitions. Runtime capability grants may narrow this set. */
  readonly tools: readonly ToolDefinition[];
}

/**
 * Freeze a code-authored connector plugin descriptor at its trust boundary.
 * This helper deliberately accepts no connection context.
 */
export function defineConnectorAgentPlugin(
  descriptor: ConnectorAgentPluginDescriptor,
): ConnectorAgentPluginDescriptor {
  return Object.freeze({
    ...descriptor,
    tools: Object.freeze([...descriptor.tools]),
  });
}

export interface ConnectorAdapter {
  manifest: ConnectorManifestInput;
  agentPlugin: ConnectorAgentPluginDescriptor;
  /**
   * Optional per-capability narrowing of the connector-wide supported scopes.
   * Omitted capabilities inherit `manifest.supportedScopes`.
   */
  capabilityConnectionScopes?: Readonly<Record<string, readonly Scope[]>>;
  nativeAgent?: ConnectorNativeAgentAdapter;
  messagingAgent?: ConnectorMessagingAgentAdapter;
  beginAuthorization?(input: ConnectorAuthorizationInput): Promise<{ url: string; state?: Record<string, unknown> }>;
  handleAuthorizationCallback?(input: ConnectorAuthorizationCallbackInput): Promise<Record<string, unknown>>;
  refreshCredentials?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<Record<string, unknown>>;
  revoke?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<void>;
  webhookActivity?: ConnectorWebhookActivitySource;
  pollingActivity?: ConnectorPollingActivitySource;
  /** @deprecated Implement pollingActivity for new connectors. */
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
      | "invalid_payload"
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

/** Provider-directed retry delay carried across queue and Workflow boundaries. */
export function connectorRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const value = (details as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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
