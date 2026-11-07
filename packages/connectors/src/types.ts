import type { ConnectorInstallationManagement } from "./installation";
import type { ToolPaginationResult } from "@rally/contracts/tool-pagination";
import {
  ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY,
  ConnectorActivityTriggerDescriptorSchema,
} from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type {
  ConnectorActivityFilterField,
  ConnectorActivityTriggerDescriptor,
  ConnectorActivityTriggerDescriptorInput,
  ConnectorManifest,
  ConnectorManifestInput,
  ExecutionPrincipal,
  NormalizedActivity,
  Scope,
  ToolDefinition,
} from "@rally/contracts";
import type { ZodError, ZodType } from "zod";

/** Levels understood by a connector host's structured-log sink. */
export type ConnectorLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Optional host-owned sink for content-free connector lifecycle diagnostics.
 *
 * Adapters do not depend on a logging implementation. The host supplies this
 * callback and the shared connector layer guarantees that a broken sink never
 * changes provider behavior.
 */
export type ConnectorObserver = (
  level: ConnectorLogLevel,
  event: string,
  fields: Record<string, unknown>,
) => void;

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
 *
 * The paused contextual-routing surface retains this as a prior for a future
 * re-enable: an operational type starts at a higher confidence bar before it
 * can be offered as context (`docs/contextual-routing.md`). A workspace's own
 * acceptances overrule it, and a connector that classifies nothing as
 * digestible is read as having drawn no line rather than as having said no —
 * so answer the digest question here and nothing else.
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
  overrides: Readonly<Record<string, Partial<Omit<ConnectorActivityTriggerDescriptorInput, "eventType">>>> = {},
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
    return ConnectorActivityTriggerDescriptorSchema.parse({
      eventType,
      label: override.label ?? humanizeActivityEventType(eventType),
      description: override.description ?? `${connectorName} activity normalized as ${eventType}.`,
      eventFamilies: override.eventFamilies ?? [],
      filterFields: [...filterFields.values()],
      resourceRelationships: override.resourceRelationships ?? [],
      digestible: digestible.has(eventType),
    });
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
  /** Receipt-scoped, immutable text snapshots. Only the authorized host supplies this store. */
  textPages?: ConnectorTextPages;
  /** Host-authorized original bytes. Never supplied by the model or exposed in results. */
  readAttachment?: (resourceId: string) => Promise<{ fileName: string; mimeType: string; bytes: Uint8Array }>;
  connection: AuthorizedConnectorConnection;
  principal: ExecutionPrincipal;
  /** Stable host receipt key when the provider supports idempotent writes. */
  providerIdempotencyKey?: string;
  /** Re-entering an interrupted receipt, with its original provider key. */
  replaying?: boolean;
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

export interface ConnectorTextPages {
  /** The existing source-file allowance, separate from the model's page budget. */
  maxSourceBytes: number;
  write(text: Uint8Array): Promise<string>;
  read(id: string, offset: number, length: number): Promise<{ bytes: Uint8Array; totalBytes: number }>;
}

export interface ConnectorToolResult {
  pagination?: ToolPaginationResult;
  output: unknown;
  summary: string;
  providerOperationId?: string;
  /**
   * The external conversation path whose replies can reach Rally's ingress,
   * when this call sent a message there (a Slack workspace-bot send). The host
   * binds it to the run that sent it; an adapter sets it only for a send whose
   * replies its ingress actually receives. Not model-visible.
   */
  externalConversation?: { installationId: string; path: string[] };
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
  /**
   * Activities a verified delivery implies but cannot decide on its own.
   *
   * Runs after `normalize` accepted the delivery and before any activity row
   * exists, with an authorized connection, because the decision needs a
   * provider read: Granola reports a note shared into the workspace as
   * `note.access_granted` whether or not its summary exists yet, and only
   * the note says which. Answers with whole activities to store beside the
   * one the delivery named, or none when the delivery meant exactly what it
   * said, and always with the outcome by name. Every webhook ingress that
   * persists through the workspace object calls it, so an adapter's answer
   * is honoured wherever its deliveries arrive. Absent for every connector
   * whose deliveries always mean what they say.
   */
  derive?(
    connection: AuthorizedConnectorConnection,
    activity: Omit<NormalizedActivity, "id">,
    event: ConnectorVerifiedActivityWebhook,
    signal: AbortSignal,
  ): Promise<ConnectorDerivedActivities>;
}

/** What `derive` decided, for the wrapper's log and the host's. */
export interface ConnectorDerivedActivities {
  /** Whole activities to store beside the one the delivery named. */
  activities: Array<Omit<NormalizedActivity, "id">>;
  /**
   * Why, in one short code: what the provider read found, or why there was
   * none. Every outcome that stored nothing is a different word from every
   * other, so an unreadable note and a summary not yet written can be told
   * apart afterwards.
   */
  outcome: string;
  /** The provider failure behind an outcome the adapter could not verify, when there was one. */
  failure?: { code: string; status?: number };
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
    // A provider answering a poll with a body the stream's schema does not
    // model is a schema rejection, and its failing path is the diagnosis; it
    // used to be `poll_failed`, which is what a network fault also says. The
    // label is the one `connectorObservationErrorCode` uses for the same
    // failure when it is thrown rather than returned: the boundary, not the
    // side that was wrong.
    code: error instanceof ConnectorError ? error.code : zodDiagnosticCode(error, "schema") ?? "poll_failed",
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

export interface ConnectorResourceAuthorizationResource {
  id: string;
  type: string;
  name: string;
}

export interface ConnectorResourceAuthorizationAdapter {
  begin(input: {
    state: string;
    codeChallenge: string;
    capability: string;
    operation: "edit";
    resource: ConnectorResourceAuthorizationResource;
  }): Promise<{ url: string }>;
  complete(input: {
    code: string;
    codeVerifier: string;
    pickedResourceIds: readonly string[];
    capability: string;
    operation: "edit";
    resource: ConnectorResourceAuthorizationResource;
    connection: AuthorizedConnectorConnection;
    signal: AbortSignal;
  }): Promise<ConnectorResourceAuthorizationResource>;
  inspect(input: {
    capability: string;
    operation: "edit";
    resource: ConnectorResourceAuthorizationResource;
    connection: AuthorizedConnectorConnection;
    signal: AbortSignal;
  }): Promise<{ authorized: boolean; resource: ConnectorResourceAuthorizationResource }>;
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
  /**
   * Words a request would use for this provider's work, matched by plugin
   * search. Without them a connector is reachable only by its own product name,
   * so "file a ticket" finds nothing and the run concludes the capability is
   * absent — the recorded failure mode that catalog wording exists to prevent.
   * The provider type and wire prefix are added by the host; list the task
   * vocabulary here, not the brand.
   */
  readonly searchAliases?: readonly string[];
  /** Static provider guidance included only while this plugin is active. */
  readonly systemMessage: string;
  /** Provider tool definitions. Runtime capability grants may narrow this set. */
  readonly tools: readonly ToolDefinition[];
}

/**
 * A connection-specific agent tool surface discovered from a provider at
 * plugin activation time.
 *
 * Hosted MCP servers are the motivating case: `tools/list` is the authority on
 * what exists, so copying one observed response into a static connector
 * manifest guarantees drift. The provider adapter owns safety policy and
 * credential lifecycle. Configured servers can also supply a catalog
 * description and usage instructions beside their tool definitions. Provider
 * annotations remain untrusted transport metadata and cannot select mode or
 * idempotency.
 */
export interface ConnectorServerMetadata {
  description: string;
  instructions?: string;
}

export interface ConnectorDynamicAgentCatalog {
  tools: readonly ToolDefinition[];
  server: ConnectorServerMetadata;
}

export interface ConnectorDynamicAgentTools {
  /** Capabilities which may authorize discovery for an existing connection. */
  readonly capabilities: readonly string[];
  /** Connection scopes on which this dynamic surface replaces static tools. */
  readonly connectionScopes: readonly Scope[];
  /**
   * Discover one frozen activation's tool definitions. The host validates the
   * returned definitions, grants, and model-facing wire-name uniqueness before
   * exposing them.
   */
  discover(
    connection: AuthorizedConnectorConnection,
    signal: AbortSignal,
  ): Promise<readonly ToolDefinition[]>;
  /** Tools and provider-supplied plugin guidance from the same discovery. */
  discoverCatalog?(
    connection: AuthorizedConnectorConnection,
    signal: AbortSignal,
  ): Promise<ConnectorDynamicAgentCatalog>;
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
  installationManagement?: ConnectorInstallationManagement;
  manifest: ConnectorManifestInput;
  agentPlugin: ConnectorAgentPluginDescriptor;
  /** Live provider-authored tools, resolved only when this plugin activates. */
  dynamicAgentTools?: ConnectorDynamicAgentTools;
  /**
   * Optional per-capability narrowing of the connector-wide supported scopes.
   * Omitted capabilities inherit `manifest.supportedScopes`.
   */
  capabilityConnectionScopes?: Readonly<Record<string, readonly Scope[]>>;
  /**
   * The connection scopes this connector's *activity* can arrive in, where
   * that is narrower than the connector itself.
   *
   * Separate from `capabilityConnectionScopes` because events are not a
   * capability: a provider that lends its tools to a personal token can still
   * deliver its events only to an administrator's install, which is exactly
   * Granola's, Fireflies' and Ashby's shape. Their `normalize` refuses a
   * personal connection outright, so a trigger advertised on one is an event
   * that can never be received. Omitted means the connector's own
   * `manifest.supportedScopes`.
   */
  activityConnectionScopes?: readonly Scope[];
  /**
   * The connection scopes a connector will still take a *credential* for,
   * where that is narrower than the connector itself.
   *
   * Separate from `manifest.supportedScopes` because the two answer different
   * questions. `supportedScopes` is what this adapter can serve: narrowing it
   * would take the tools, the events and the webhook ingress away from
   * connections a workspace already made, which is a data migration rather
   * than a product decision. This one closes the door and leaves the
   * connections behind it working.
   *
   * The line it draws is **a new grant, not a new request**. Refused: creating
   * a connection, completing an authorization that has none, and replacing an
   * installation's provider API key — that last one because a replacement key
   * is a different administrator's account as easily as the same one's, so it
   * is a creation wearing an existing connection's clothes. Allowed:
   * reauthorizing a connection that already exists, and every path that reads,
   * repairs with the credential already stored, or disconnects. All three
   * refusals answer with `connector_scope_not_connectable`.
   *
   * It exists because a workspace connection is one credential every member
   * reads through, and for a provider whose product is other people's
   * recordings that is the whole company's transcripts behind one key. Rally
   * is not taking new ones of those until the authorization model says who may
   * read what; see `fireflies.ts`, which is the first to declare it. Omitted
   * means the connector's own `manifest.supportedScopes`.
   */
  connectableScopes?: readonly Scope[];
  nativeAgent?: ConnectorNativeAgentAdapter;
  messagingAgent?: ConnectorMessagingAgentAdapter;
  beginAuthorization?(input: ConnectorAuthorizationInput): Promise<{ url: string; state?: Record<string, unknown> }>;
  handleAuthorizationCallback?(input: ConnectorAuthorizationCallbackInput): Promise<Record<string, unknown>>;
  /** Optional provider flow for granting this existing connection one named resource. */
  resourceAuthorization?: ConnectorResourceAuthorizationAdapter;
  refreshCredentials?(connection: ConnectorConnectionContext, signal: AbortSignal): Promise<Record<string, unknown>>;
  revoke?(connection: AuthorizedConnectorConnection, signal: AbortSignal): Promise<void>;
  webhookActivity?: ConnectorWebhookActivitySource;
  pollingActivity?: ConnectorPollingActivitySource;
  /** @deprecated Implement pollingActivity for new connectors. */
  poll?(connection: AuthorizedConnectorConnection, signal: AbortSignal): Promise<ConnectorPollResult>;
  hydrateResource?(connection: AuthorizedConnectorConnection, resource: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /**
   * How far this connection reaches one resource named by a URL or provider
   * id. Must not write.
   *
   * A person can hold a personal connection while the Organization holds a
   * workspace one, each a different provider account, and only one of them
   * may see the file in front of them. This is what lets the host answer
   * "which connection can open this" without trying a write.
   *
   * Implementing it is also the adapter's promise that every refusal it
   * builds with `connectorResourceAccessRefused` is raised before the
   * provider was asked to change anything, which is what lets the host retry
   * that call on another connection.
   */
  /** Read capability needed to register a source for this connector's events. */
  resourceRegistrationCapability?: string;
  /** Whether a configured source has the same provider ID across connections. */
  isPortableActivityResource?(activity: Pick<NormalizedActivity, "provider" | "resourceType" | "providerResourceId">): boolean;
  probeResourceAccess?(
    connection: AuthorizedConnectorConnection,
    reference: string,
    signal: AbortSignal,
  ): Promise<ConnectorResourceAccess>;
  /**
   * Re-run code-authored tool-input refinements that cannot be represented in
   * the provider-facing JSON Schema. The harness uses the result only to
   * classify an escaped Zod error; execution still parses its own arguments.
   */
  validateToolInput?(name: string, args: unknown): ZodError | null;
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
    /**
     * Why the check failed, or why an `ok` result carries a `warning`, in the
     * adapter's own fixed vocabulary, for the log.
     *
     * `message` cannot serve: an adapter is free to return a caught provider
     * error's text there — X returns the body's own `message` field — and that
     * text is shown to a person, not written to an indexed field. Logging it
     * would put provider prose, and whatever a provider chose to include in it,
     * into structured observability.
     *
     * So this is a separate, deliberately small thing: a literal the adapter
     * writes, naming a condition it already distinguishes. Omit it and the log
     * says only that the check failed, which is where every adapter started.
     */
    reasonCode?: string;
    reconnectRequired?: boolean;
    /**
     * A condition worth acting on that does not make the connection unusable —
     * provider-side state that has drifted, delivery that has stopped. The
     * host logs it on the healthy path, so a connector that removes a repair
     * from its health check still leaves a trail; without one, a degraded
     * connection is indistinguishable from a well one until somebody thinks to
     * press Test.
     */
    warning?: string;
  }>;
}

export function zodToolInputValidationError(
  schema: ZodType | undefined,
  input: unknown,
): ZodError | null {
  if (!schema) return null;
  const result = schema.safeParse(input);
  return result.success ? null : result.error;
}

/** What the two helpers below read: an adapter, or a narrower view of one. */
export interface ConnectorActivityScopeSource {
  manifest: { supportedScopes: readonly Scope[] };
  activityConnectionScopes?: readonly Scope[] | undefined;
}

/**
 * The connection scopes this connector's events can arrive in.
 *
 * The one place the default is applied, so a caller that wants to *name* the
 * scope a connection is missing and one that only asks whether it has it
 * cannot answer differently.
 */
export function connectorActivityScopes(
  adapter: ConnectorActivityScopeSource,
): readonly Scope[] {
  return adapter.activityConnectionScopes ?? adapter.manifest.supportedScopes;
}

/**
 * Whether a connection in this scope can receive this connector's events.
 *
 * The one place the question is answered, so the drafting catalog, the accept
 * path and any later event surface cannot disagree about it.
 */
export function connectorActivitySupportsScope(
  adapter: ConnectorActivityScopeSource,
  scope: Scope,
): boolean {
  return connectorActivityScopes(adapter).includes(scope);
}

/**
 * The connection scopes this connector will still take a credential for.
 *
 * The one place the default is applied, so the four places that refuse a scope
 * and the surface that offers it cannot answer differently.
 */
export function connectorConnectableScopes(
  adapter: Pick<ConnectorAdapter, "manifest" | "connectableScopes">,
): readonly Scope[] {
  return adapter.connectableScopes ?? adapter.manifest.supportedScopes;
}

/** Whether this connector will still take a credential in this scope. */
export function connectorScopeIsConnectable(
  adapter: Pick<ConnectorAdapter, "manifest" | "connectableScopes">,
  scope: Scope,
): boolean {
  return connectorConnectableScopes(adapter).includes(scope);
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

/**
 * The refusal every connector gives when a run reaches for a tool this
 * credential does not carry.
 *
 * It used to name only the missing capability, which is the one thing the model
 * cannot act on: it already asked for that tool, and a bare "not granted"
 * leaves it guessing whether to retry, rephrase, or give up. Naming what the
 * connection *does* hold turns a dead end into a one-step correction, and
 * `available` is forwarded to the model with the failure.
 *
 * `available` is the capabilities of the connector's **tools**, intersected
 * with the grant — not the raw grant. A connection carries capabilities that
 * back no tool at all: `slack.agent` and `slack.notifications.write` are
 * control-plane grants with nothing model-callable behind them, and listing
 * them would answer "what can I do instead?" with things the model cannot do,
 * which is worse than the bare refusal it replaced. Restricted this way it also
 * discloses nothing beyond the run's own tool list.
 */
export function connectorCapabilityRefused(
  providerLabel: string,
  requested: string,
  tools: readonly ToolDefinition[],
  grantedCapabilities: readonly string[],
): ConnectorError {
  const granted = new Set(grantedCapabilities);
  const available = [...new Set(
    tools.map((tool) => tool.capability).filter((capability) => granted.has(capability)),
  )].sort();
  return new ConnectorError(
    "unsupported_capability",
    available.length
      ? `The ${providerLabel} connection has not granted ${requested}. Its usable capabilities on this run are: ${available.join(", ")}.`
      : `The ${providerLabel} connection has not granted ${requested}, and has no usable tool capabilities on this run.`,
    { reason: "capability_not_granted", field: requested, available },
  );
}

/** What `probeResourceAccess` found for one connection. */
export type ConnectorResourceAccess =
  /** The reference is not a resource this connector names. */
  | { access: "unrecognized" }
  /**
   * This connection cannot open it: not shared with its account, deleted, or
   * the connection lacks the capability. `reason` is a fixed code.
   */
  | { access: "none"; resourceId: string; reason: string }
  | {
    access: "read" | "edit";
    resourceId: string;
    name: string;
    /** Provider-verified identity usable to register this resource in Rally. */
    registration?: { resourceType: string; canonicalUrl: string | null };
    /** Editable by the account, but Rally needs a one-resource grant first. */
    editNeedsGrant?: boolean;
  };

/**
 * A refusal raised because this connection cannot reach the resource, before
 * the provider was asked to change anything.
 *
 * Only an adapter that implements `probeResourceAccess` may build one, and
 * only at a point where no effect can have happened: the host reads it as
 * leave to retry the same call on another connection, and a refusal raised
 * after a write began would let that write land twice.
 */
export function connectorResourceAccessRefused(
  message: string,
  details: Record<string, unknown>,
  code: ConnectorError["code"] = "unsupported_capability",
): ConnectorError {
  return new ConnectorError(code, message, { ...details, resourceAccessRefused: true });
}

export function isConnectorResourceAccessRefusal(error: unknown): error is ConnectorError {
  if (!(error instanceof ConnectorError)) return false;
  const details = error.details;
  return Boolean(details && typeof details === "object"
    && (details as { resourceAccessRefused?: unknown }).resourceAccessRefused === true);
}

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
