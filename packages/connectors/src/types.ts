import { ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY } from "@avalon/contracts";
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

/** Marks one polled activity as withheld from digests by its own stream. */
function withheldFromDigest(
  activity: Omit<NormalizedActivity, "id">,
): Omit<NormalizedActivity, "id"> {
  return {
    ...activity,
    metadata: { ...activity.metadata, [ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY]: true },
  };
}

function humanizeActivityEventType(eventType: string): string {
  const parts = eventType.split(".");
  if (parts.length > 2) parts.shift();
  const text = parts.join(" ").replaceAll("_", " ").trim();
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : eventType;
}

/**
 * Every activity type a connector emits, split by whether a person should hear
 * about it in a scheduled digest.
 *
 * Two lists rather than one list and a flag, because the shape of the
 * declaration is what forces the decision. A connector author adding an event
 * type has to put it in a list, and there is no list that means "I did not
 * think about this" — which is the whole point, since the cost of not thinking
 * lands on somebody's inbox weeks later rather than on the author.
 *
 * `operational` is not a rejected event. It is ingested, routed, matched
 * against automations and watches, and written to the activity log exactly like
 * a digestible one. It simply is not news: a check run finishing, a label
 * moving, a reaction landing, an upload completing. Ask which list an event
 * belongs in this way — **would a person who was away for a day want this read
 * back to them?** A pull request opened, yes. The eleven check runs it started,
 * no.
 */
export interface ConnectorActivityTypePartition {
  /** Read back to a person in their digest. */
  digestible: readonly string[];
  /** Available to every other surface, never in a digest. */
  operational: readonly string[];
}

export function defineConnectorActivityTriggers(
  connectorName: string,
  eventTypes: ConnectorActivityTypePartition,
  overrides: Readonly<Record<string, Partial<Omit<ConnectorActivityTriggerDescriptor, "eventType">>>> = {},
  commonFilterFields: readonly ConnectorActivityFilterField[] = [],
): ConnectorActivityTriggerDescriptor[] {
  const digestible = new Set(eventTypes.digestible);
  const contradictions = eventTypes.operational.filter((eventType) => digestible.has(eventType));
  // An event type in both lists is an unanswered question wearing the costume
  // of an answer, and the manifest's own duplicate check would not see it —
  // the descriptors it produces would be duplicates, but the second one's
  // digestibility would silently win. Refuse it where it is written.
  if (contradictions.length > 0) {
    throw new ConnectorError(
      "invalid_configuration",
      `${connectorName} declares activity types as both digestible and operational: ${contradictions.join(", ")}`,
    );
  }
  return [...eventTypes.digestible, ...eventTypes.operational].map((eventType) => {
    const override = overrides[eventType] ?? {};
    const filterFields = new Map(commonFilterFields.map((field) => [field.key, field]));
    for (const field of override.filterFields ?? []) filterFields.set(field.key, field);
    return {
      eventType,
      label: override.label ?? humanizeActivityEventType(eventType),
      description: override.description ?? `${connectorName} activity normalized as ${eventType}.`,
      filterFields: [...filterFields.values()] as ConnectorActivityFilterField[],
      digestible: digestible.has(eventType),
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

// Declared, never exported, and with no runtime value: an object literal
// written anywhere else cannot carry this key, so the branded type below has
// exactly one producer.
declare const credentialFreshness: unique symbol;

/**
 * A connection whose credentials the host refreshed immediately before use.
 *
 * Every adapter entry point that calls a provider takes this type rather than
 * `ConnectorConnectionContext`, which makes "refresh before you call out" a
 * property of the value instead of a step each caller has to remember. The
 * brand cannot be forged by a structural literal; `authorizedConnection` is
 * its only producer, and the host confines that to its single credential door.
 */
export interface AuthorizedConnectorConnection extends ConnectorConnectionContext {
  readonly [credentialFreshness]: true;
}

/**
 * Host-serialized credential rotation, per connection.
 *
 * A rotating refresh token is single-use, so two calls in flight together must
 * not each redeem the stored one. The host serializes rotation behind the same
 * lease its expiry-driven refresh uses and registers it here.
 *
 * It is deliberately not a property of the connection. The connection is handed
 * to adapters as `ConnectorToolContext.connection`, and a rotation hanging off
 * it would be an escape hatch every adapter could reach — guarded by a doc
 * comment asking them not to, which is exactly the remembered step this brand
 * exists to remove. `withProviderReauthorization` reads it here instead.
 */
export type ConnectorCredentialRotation = (
  refused: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

const credentialRotations = new WeakMap<ConnectorConnectionContext, ConnectorCredentialRotation>();

/** The host's serialized rotation for this connection, when it registered one. */
export function connectorCredentialRotation(
  connection: ConnectorConnectionContext,
): ConnectorCredentialRotation | undefined {
  return credentialRotations.get(connection);
}

/**
 * Mints the freshness brand.
 *
 * Production code must reach this only through the host's credential door
 * (`withAuthorizedConnection`), which is the one caller that has actually
 * refreshed the credentials; ESLint pins the import to that module. Tests
 * calling an adapter directly are the other legitimate caller.
 */
export function authorizedConnection(
  connection: ConnectorConnectionContext,
  rotateCredentials?: ConnectorCredentialRotation,
): AuthorizedConnectorConnection {
  if (rotateCredentials) credentialRotations.set(connection, rotateCredentials);
  return connection as AuthorizedConnectorConnection;
}

export interface ConnectorToolContext {
  connection: AuthorizedConnectorConnection;
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
  /**
   * Whether this whole feed may reach a digest. Required, for the same reason
   * the manifest's per-type flag is: a stream is the granularity a connector
   * author actually thinks in — Gmail is news, Drive's change feed is a file
   * watcher — and a stream added later must state which it is.
   *
   * The manifest still decides. A stream can only ever **withhold**: an
   * activity is digestible when its event type says so *and* the stream that
   * produced it agrees, so the two can never contradict each other into a
   * digest. A stream that says no needs no matching edit to the manifest, and a
   * stream that says yes grants nothing on its own.
   */
  digestible: boolean;
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
    connection: AuthorizedConnectorConnection,
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
  connection: AuthorizedConnectorConnection,
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
      // Stamped here rather than left to each `pollStream` implementation:
      // this is the one place every polled activity passes through, so a
      // stream cannot forget to mark what it produced, and an adapter cannot
      // grant its own output a digest it was not given.
      activities.push(...(item.stream.digestible
        ? item.result.activities
        : item.result.activities.map((activity) => withheldFromDigest(activity))));
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
  revoke?(connection: AuthorizedConnectorConnection, signal: AbortSignal): Promise<void>;
  webhookActivity?: ConnectorWebhookActivitySource;
  pollingActivity?: ConnectorPollingActivitySource;
  /** @deprecated Implement pollingActivity for new connectors. */
  poll?(connection: AuthorizedConnectorConnection, signal: AbortSignal): Promise<ConnectorPollResult>;
  hydrateResource?(connection: AuthorizedConnectorConnection, resource: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  executeTool(name: string, args: unknown, context: ConnectorToolContext): Promise<ConnectorToolResult>;
  /**
   * Restores provider-side state a connection needs but that has drifted —
   * a disabled webhook endpoint, a lapsed subscription.
   *
   * Separate from `healthCheck` because it writes. A health check runs on every
   * plugin activation, and a read-shaped call that quietly mutates provider
   * state on that cadence is a surprise; this runs only when someone explicitly
   * tests a connection.
   */
  repair?(
    connection: AuthorizedConnectorConnection,
    signal: AbortSignal,
  ): Promise<{ repaired: boolean; message?: string }>;
  /**
   * `reconnectRequired` separates the two ways a check fails: the provider
   * refused this authorization, or the check could not be completed at all.
   * A caller deciding whether authority was withdrawn must not read an
   * unreachable provider as a revoked grant — the host maps the first to a
   * denial that marks the connection, and the second to an indeterminate
   * verdict that leaves it alone.
   *
   * `signal` is threaded from the caller rather than timed internally.
   * Reauthorization runs inside a Workflow step, and an `AbortSignal.timeout`
   * created here is not disposable — it keeps the invocation alive until it
   * fires, long after the check returned. An adapter falls back to its own
   * timeout only when a caller supplies none.
   *
   * A health check must not write. State that needs restoring belongs in
   * `repair`.
   */
  healthCheck(
    connection?: AuthorizedConnectorConnection,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    message: string;
    reconnectRequired?: boolean;
  }>;
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
