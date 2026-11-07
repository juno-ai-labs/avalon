import {
  ActivityQueueMessageSchema,
  asWorkspaceId,
  NormalizedActivitySchema,
  type NormalizedActivity,
  type Scope,
} from "@rally/contracts";
import {
  canGitHubPersonalConnectionAccessRepository,
  canPersonalLinearConnectionAccessWebhook,
  ConnectorError,
  discoverGitHubWebhookResources,
  isDiscardedGitHubDelivery,
  LinearNativeAgentProtocolDescriptor,
  normalizeGitHubWebhook,
  normalizeLinearWebhook,
  normalizeNotionWebhook,
  parseGitHubWebhook,
  readNotionWebhookVerificationToken,
  verifyGitHubWebhook,
  verifyLinearWebhook,
  verifyNotionWebhook,
  type ConnectorConnectionContext,
  type ConnectorVerifiedActivityWebhook,
  type ConnectorWebhookActivitySource,
  type GitHubConnectorConfig,
  type GitHubWebhookDelivery,
  type GitHubWebhookResourceHint,
  type VerifiedLinearWebhook,
  type VerifiedNotionWebhook,
} from "@rally/connectors";
import { newId, nowIso } from "@rally/db";
import type { Env } from "../env";
import { linearNativeAgentEnabled, numericEnv } from "../env";
import { encryptString, sha256, timingSafeEqualText } from "../lib/crypto";
import { withAuthorizedConnection } from "./connector-connection-access";
import { connectorRegistryForEnv, linearConnectorConfig } from "../lib/connector-registry";
import { decryptVersionedConnectorCredentials, decryptVersionedCredentialValue } from "./connector-credential-envelope";
import { workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import type { GitHubVerifiedDeliveryInput } from "../lib/rpc-contracts";
import { stableUuid } from "../lib/stable-uuid";
import { logInfo, logWarn } from "../observability/logger";
import { publishWorkspaceSync } from "./workspace-realtime-service";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { enqueueWorkspaceConnectorEvent } from "./workspace-connector-event-ingress";

export type ProviderWebhookRawBody = string | Uint8Array | ArrayBuffer;
export type ProviderWebhookHeaders = Headers | HeadersInit;

export interface ProviderWebhookIngestionResult {
  accepted: true;
  duplicate: boolean;
  activityCount: number;
}

/**
 * GitHub's own ceiling on a webhook payload (25 MB), not a number of ours:
 * GitHub drops a larger payload before sending it.
 */
export const GITHUB_WEBHOOK_MAX_BYTES = 25 * 1024 * 1024;

export interface ProviderWebhookServiceOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

type Provider = "github" | "linear" | "notion";

interface StoredProviderConnection extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  connector_type: Provider;
  scope: Scope;
  owner_user_id: string | null;
  provider_account_id: string | null;
  encrypted_credentials: string | null;
  credential_iv: string | null;
  credential_key_version: number;
  granted_scopes_json: string;
  status: "healthy" | "needs_reconnect" | "error" | "disabled";
  cursor_json: string;
  config_json: string;
}

interface ExactRawBody {
  text: string;
  byteLength: number;
  storageValue: string | ArrayBuffer;
}

interface LifecycleUpdate {
  connectionId: string;
  status: "healthy" | "needs_reconnect" | "error" | "disabled";
  error: Record<string, unknown> | null;
  /**
   * When the delivery carrying this update was received, as an ISO timestamp.
   * When present, the update applies only if no later-received lifecycle
   * update has already applied to the connection (see
   * {@link ProviderWebhookService.claimLifecycleWatermark}).
   */
  at?: string;
}

interface VerifiedIngestion {
  provider: Provider;
  deliveryId: string;
  eventType: string;
  accountId: string | null;
  routingAccountIds?: string[];
  routingUserId?: string;
  bodyHash: string;
  raw: ExactRawBody;
  normalize: (
    connection: ConnectorConnectionContext,
    payloadRef: string,
  ) => Omit<NormalizedActivity, "id"> | null;
  filterConnections?: (
    connections: ConnectorConnectionContext[],
  ) => Promise<ConnectorConnectionContext[]>;
  lifecycle?: (
    connection: ConnectorConnectionContext,
  ) => LifecycleUpdate | null;
  resources?: (
    connection: ConnectorConnectionContext,
  ) => GitHubWebhookResourceHint[];
}

const DEFAULT_PROVIDER_WEBHOOK_MAX_BYTES = 2_000_000;
const NOTION_CHALLENGE_AAD_PREFIX = "provider-webhook:notion";
const NormalizedWebhookActivitySchema = NormalizedActivitySchema.omit({ id: true });

/**
 * Verifies and ingests provider-wide webhooks. Routes must pass the untouched
 * request body; parsing and re-stringifying it would invalidate provider HMACs.
 */
export class ProviderWebhookService {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(
    private readonly env: Env,
    options: ProviderWebhookServiceOptions = {},
  ) {
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async ingestGitHub(
    rawBody: ProviderWebhookRawBody,
    headers: ProviderWebhookHeaders,
  ): Promise<ProviderWebhookIngestionResult> {
    return this.stableProviderError("GitHub", async () => {
      const raw = this.exactRawBody(rawBody, GITHUB_WEBHOOK_MAX_BYTES);
      const normalizedHeaders = new Headers(headers);
      const delivery = await verifyGitHubWebhook({
        secret: requiredConfiguration(this.env.GITHUB_WEBHOOK_SECRET, "GitHub webhook signing secret"),
        rawBody: raw.text,
        signatureHeader: normalizedHeaders.get("x-hub-signature-256"),
        eventHeader: normalizedHeaders.get("x-github-event"),
        deliveryHeader: normalizedHeaders.get("x-github-delivery"),
        receivedAt: new Date(this.now()).toISOString(),
        maxBytes: GITHUB_WEBHOOK_MAX_BYTES,
      });
      return this.ingestParsedGitHub(delivery, raw);
    });
  }

  /**
   * Ingests a GitHub delivery whose signature the Global receiver already
   * verified, handed on by its Queue consumer (in this region) or over the
   * account-internal regional bridge. It parses the same bytes and does not
   * verify them again: the signature is checked once, at the edge.
   */
  async ingestVerifiedGitHub(
    input: GitHubVerifiedDeliveryInput,
  ): Promise<ProviderWebhookIngestionResult> {
    return this.stableProviderError("GitHub", async () => {
      const raw = this.exactRawBody(input.rawBody, GITHUB_WEBHOOK_MAX_BYTES);
      const delivery = await parseGitHubWebhook({
        rawBody: raw.text,
        eventHeader: input.event,
        deliveryHeader: input.deliveryId,
        receivedAt: input.receivedAt,
      });
      return this.ingestParsedGitHub(delivery, raw);
    });
  }

  private async ingestParsedGitHub(
    delivery: GitHubWebhookDelivery,
    raw: ExactRawBody,
  ): Promise<ProviderWebhookIngestionResult> {
    if (isDiscardedGitHubDelivery(delivery)) {
      return { accepted: true, duplicate: false, activityCount: 0 };
    }
    const source = this.webhookActivity("github");
    const lifecycleState = githubLifecycle(delivery);
    // A retried delivery can land after a later one; its receipt time is what
    // orders the two.
    const lifecycle = lifecycleState ? { ...lifecycleState, at: delivery.receivedAt } : null;
    const resourceDiscovery = discoverGitHubWebhookResources(delivery);
    const routingUserId = delivery.event === "github_app_authorization"
      ? githubSenderUserId(delivery)
      : null;
    const verifiedEnvelope: ConnectorVerifiedActivityWebhook = {
      deliveryId: delivery.deliveryId,
      eventType: delivery.event,
      providerAccountId: delivery.installationId,
      ...(routingUserId ? { routingUserId } : {}),
      bodyHash: delivery.rawContentHash,
      event: delivery,
    };
    return this.ingestVerified({
      provider: "github",
      deliveryId: delivery.deliveryId,
      eventType: delivery.event,
      accountId: delivery.installationId,
      ...(routingUserId ? { routingUserId } : {}),
      bodyHash: delivery.rawContentHash,
      raw,
      normalize: (connection, payloadRef) => source
        ? source.normalize(connection, verifiedEnvelope, payloadRef)
        : normalizeGitHubWebhook(connection, delivery, payloadRef),
      resources: () => resourceDiscovery.resources,
      filterConnections: (connections) =>
        this.filterGitHubPersonalConnections(connections, delivery),
      ...(lifecycle
        ? {
            lifecycle: (connection: ConnectorConnectionContext) => ({
              ...lifecycle,
              connectionId: connection.id,
            }),
          }
        : {}),
    });
  }

  async ingestLinear(
    rawBody: ProviderWebhookRawBody,
    headers: ProviderWebhookHeaders,
  ): Promise<ProviderWebhookIngestionResult> {
    return this.stableProviderError("Linear", async () => {
      const raw = this.exactRawBody(rawBody);
      const normalizedHeaders = new Headers(headers);
      const source = this.webhookActivity("linear");
      const envelope = source
        ? await source.verify({
            rawBody: raw.text,
            headers: normalizedHeaders,
            receivedAt: new Date(this.now()).toISOString(),
            maxBytes: this.maxBytes(),
            now: this.now(),
            verificationSecret: requiredConfiguration(this.env.LINEAR_WEBHOOK_SECRET, "Linear webhook signing secret"),
            replayWindowMs: numericEnv(this.env, "WEBHOOK_REPLAY_WINDOW_SECONDS", 60) * 1_000,
          })
        : null;
      const verified = envelope
        ? envelope.event as VerifiedLinearWebhook
        : await verifyLinearWebhook({
            secret: requiredConfiguration(this.env.LINEAR_WEBHOOK_SECRET, "Linear webhook signing secret"),
            rawBody: raw.text,
            signatureHeader: normalizedHeaders.get("linear-signature"),
            deliveryHeader: firstHeader(normalizedHeaders, ["linear-delivery", "linear-delivery-id", "x-linear-delivery"]),
            eventHeader: firstHeader(normalizedHeaders, ["linear-event", "x-linear-event"]),
            timestampHeader: firstHeader(normalizedHeaders, ["linear-timestamp", "x-linear-timestamp"]),
            now: this.now(),
            replayWindowMs: numericEnv(this.env, "WEBHOOK_REPLAY_WINDOW_SECONDS", 60) * 1_000,
            maxBytes: this.maxBytes(),
          });
      const verifiedEnvelope: ConnectorVerifiedActivityWebhook = envelope ?? {
        deliveryId: verified.deliveryId,
        eventType: verified.eventName,
        providerAccountId: verified.organizationId,
        bodyHash: verified.bodyHash,
        event: verified,
      };
      if (
        verified.eventName === "AgentSessionEvent"
        && (
          !linearNativeAgentEnabled(this.env)
          || LinearNativeAgentProtocolDescriptor.runtimeStatus !== "operational"
        )
      ) {
        // Linear exposes its Agent Session UI as soon as this event type is
        // subscribed. A stale preview subscription must still receive an exact
        // success response without starting work until the regional runtime is
        // explicitly enabled.
        return { accepted: true, duplicate: false, activityCount: 0 };
      }
      const lifecycle = linearLifecycle(verified);
      const linearAuthorizationUserId = verified.eventName === "OAuthAuthorization"
        ? linearOAuthAuthorizationUserId(verified)
        : null;
      const linearAgentAppUserId = verified.eventName === "AgentSessionEvent"
        ? stringValue(verified.event, "appUserId")
        : null;
      return this.ingestVerified({
        provider: "linear",
        deliveryId: verified.deliveryId,
        eventType: verified.eventName,
        accountId: verified.organizationId,
        ...(linearAuthorizationUserId ? { routingUserId: linearAuthorizationUserId } : {}),
        bodyHash: verified.bodyHash,
        raw,
        normalize: (connection, payloadRef) => source
          ? source.normalize(connection, verifiedEnvelope, payloadRef)
          : normalizeLinearWebhook(connection, verified, payloadRef),
        filterConnections: async (connections: ConnectorConnectionContext[]) => {
          const agentMatched = linearAgentAppUserId
            ? connections.filter((connection) =>
                linearAgentConnectionMatches(connection, linearAgentAppUserId))
            : connections;
          return this.filterLinearPersonalConnections(agentMatched, verified);
        },
        ...(lifecycle
          ? {
              lifecycle: (connection: ConnectorConnectionContext) => ({
                ...lifecycle,
                connectionId: connection.id,
              }),
            }
          : {}),
      });
    });
  }

  async ingestNotion(
    rawBody: ProviderWebhookRawBody,
    headers: ProviderWebhookHeaders,
    setupNonce: string | null = null,
  ): Promise<ProviderWebhookIngestionResult> {
    return this.stableProviderError("Notion", async () => {
      const raw = this.exactRawBody(rawBody);
      const normalizedHeaders = new Headers(headers);
      const verificationToken = readNotionWebhookVerificationToken(
        raw.text,
        this.maxBytes(),
      );
      if (verificationToken !== null) {
        return this.captureNotionChallenge(verificationToken, setupNonce);
      }

      const challenge = await this.loadNotionChallenge();
      if (!challenge) {
        throw new ConnectorError(
          "invalid_configuration",
          "Notion webhook verification has not been completed for this region",
        );
      }
      const secret = await this.decryptNotionChallenge(challenge);
      const expectedIntegrationId = requiredConfiguration(
        this.env.NOTION_INTEGRATION_ID ?? this.env.NOTION_OAUTH_CLIENT_ID,
        "Notion integration/client ID",
      );
      const source = this.webhookActivity("notion");
      const envelope = source
        ? await source.verify({
            rawBody: raw.text,
            headers: normalizedHeaders,
            receivedAt: new Date(this.now()).toISOString(),
            maxBytes: this.maxBytes(),
            now: this.now(),
            verificationSecret: secret,
            expectedProviderAccountId: expectedIntegrationId,
          })
        : null;
      const verified = envelope
        ? envelope.event as VerifiedNotionWebhook
        : await verifyNotionWebhook({
            secret,
            rawBody: raw.text,
            signatureHeader: normalizedHeaders.get("x-notion-signature"),
            expectedIntegrationId,
            maxBytes: this.maxBytes(),
          });
      const result = await this.ingestVerified({
        provider: "notion",
        deliveryId: verified.eventId,
        eventType: verified.eventType,
        accountId: verified.workspaceId,
        routingAccountIds: verified.accessibleBotIds,
        bodyHash: verified.bodyHash,
        raw,
        normalize: (connection, payloadRef) => {
          return source
            ? source.normalize(connection, envelope ?? {
                deliveryId: verified.eventId,
                eventType: verified.eventType,
                providerAccountId: verified.workspaceId,
                routingAccountIds: verified.accessibleBotIds,
                bodyHash: verified.bodyHash,
                event: verified,
              }, payloadRef)
            : normalizeNotionWebhook(connection, verified, payloadRef);
        },
        filterConnections: async (connections) =>
          connections.filter((connection) => notionConnectionMatches(connection, verified)),
      });
      await this.env.DB.prepare(
        `UPDATE provider_webhook_challenges
         SET consumed_at = COALESCE(consumed_at, ?)
         WHERE provider = 'notion' AND region = ?`,
      ).bind(nowIso(), this.env.AVALON_REGION).run();
      return result;
    });
  }

  private async captureNotionChallenge(
    verificationToken: string,
    suppliedSetupNonce: string | null,
  ): Promise<ProviderWebhookIngestionResult> {
    const setupNonceHash = await this.authorizeNotionSetupNonce(
      verificationToken,
      suppliedSetupNonce,
    );

    const existing = await this.loadNotionChallenge();
    if (existing) {
      const existingToken = await this.decryptNotionChallenge(existing);
      const duplicate = timingSafeEqualText(existingToken, verificationToken);
      if (
        duplicate
        && existing.setup_nonce_hash
        && timingSafeEqualText(existing.setup_nonce_hash, setupNonceHash)
      ) {
        return { accepted: true, duplicate: true, activityCount: 0 };
      }
      await this.storeNotionChallengeToken(verificationToken, setupNonceHash);
      return { accepted: true, duplicate, activityCount: 0 };
    }

    await this.storeNotionChallengeToken(verificationToken, setupNonceHash);
    return { accepted: true, duplicate: false, activityCount: 0 };
  }

  /**
   * Claims an unexpired setup nonce for the first verification token that uses
   * it. A consumed nonce may retry only that same token, and only while it is
   * still the current setup generation. Encrypted storage checks that same
   * generation again in its write statement, closing the claim-to-store race.
   */
  private async authorizeNotionSetupNonce(
    verificationToken: string,
    suppliedSetupNonce: string | null,
  ): Promise<string> {
    if (!suppliedSetupNonce || suppliedSetupNonce.length > 200) {
      throw new ConnectorError("unauthorized", "The Notion webhook setup nonce is invalid");
    }
    const nonceHash = await sha256(suppliedSetupNonce);
    const verificationTokenHash = await sha256(verificationToken);
    const at = new Date(this.now()).toISOString();
    const claimed = await this.env.DB.prepare(
      `UPDATE notion_webhook_setup_nonces
       SET verification_token_hash = ?, consumed_at = ?
       WHERE nonce_hash = ? AND is_current = 1
         AND consumed_at IS NULL AND expires_at > ?`,
    ).bind(verificationTokenHash, at, nonceHash, at).run();
    if (resultChanges(claimed) === 1) return nonceHash;

    const nonce = await this.env.DB.prepare(
      `SELECT verification_token_hash, consumed_at, is_current
       FROM notion_webhook_setup_nonces
       WHERE nonce_hash = ?`,
    ).bind(nonceHash).first<{
      verification_token_hash: string | null;
      consumed_at: string | null;
      is_current: number;
    }>();
    if (
      !nonce?.consumed_at
      || !nonce.verification_token_hash
      || nonce.is_current !== 1
      || !timingSafeEqualText(nonce.verification_token_hash, verificationTokenHash)
    ) {
      throw new ConnectorError("unauthorized", "The Notion webhook setup nonce is invalid or expired");
    }
    return nonceHash;
  }

  private async ingestVerified(
    input: VerifiedIngestion,
  ): Promise<ProviderWebhookIngestionResult> {
    const payloadRef = `${this.env.AVALON_REGION}/provider-webhooks/${input.provider}/${input.bodyHash}.json`;
    const priorReceipt = await this.loadReceipt(input.provider, input.deliveryId);
    const legacyRegionalAuthority = !this.env.WORKSPACE_DOS;
    // With WorkspaceDO authority a pending receipt is a delivery whose effects
    // did not finish — the Queue consumer threw after the receipt committed —
    // so it falls through and re-applies them below; every one is keyed to the
    // delivery. Only a processed receipt is answered here.
    if (priorReceipt && (legacyRegionalAuthority || priorReceipt.processed_at !== null)) {
      this.assertMatchingReceipt(priorReceipt, input.eventType, payloadRef);
      if (
        priorReceipt.processed_at === null
      ) {
        await this.finishReceipt(
          input.provider,
          input.deliveryId,
          payloadRef,
          await this.findPendingReceiptActivities(
            input.provider,
            input.deliveryId,
            payloadRef,
          ),
        );
      }
      return { accepted: true, duplicate: true, activityCount: 0 };
    }

    let connections = await this.loadMatchingConnections(
      input.provider,
      input.accountId,
      input.routingAccountIds,
      input.routingUserId,
    );
    const matchedConnections = connections;
    if (input.filterConnections) {
      connections = await input.filterConnections(connections);
    }
    if (connections.length === 0) {
      await this.publishConnectionChanges(matchedConnections, ["connector_connections"]);
      return { accepted: true, duplicate: false, activityCount: 0 };
    }

    await this.env.PAYLOADS.put(payloadRef, input.raw.storageValue, {
      httpMetadata: { contentType: "application/json" },
    });

    const discoveredResources = input.resources
      ? connections
          .map((connection) => ({
            connection,
            resources: input.resources!(connection),
          }))
          .filter((entry) => entry.resources.length > 0)
      : [];
    const normalized = connections
      .map((connection) => {
        const candidate = input.normalize(connection, payloadRef);
        return {
          connection,
          activity: candidate === null
            ? null
            : this.authoritativeActivity(
                connection,
                candidate,
                input,
                payloadRef,
              ),
        };
      })
      .filter((entry): entry is {
        connection: ConnectorConnectionContext;
        activity: Omit<NormalizedActivity, "id">;
      } => entry.activity !== null);
    const lifecycleUpdates = input.lifecycle
      ? connections
          .map((connection) => input.lifecycle!(connection))
          .filter((update): update is LifecycleUpdate => update !== null)
      : [];
    const receivedAt = new Date(this.now()).toISOString();
    const receipt = this.env.DB.prepare(
      `INSERT INTO provider_webhook_receipts
       (provider, delivery_id, event_type, payload_ref, received_at,
        processed_at, error_json)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(provider, delivery_id) DO NOTHING`,
    ).bind(
      input.provider,
      input.deliveryId,
      input.eventType,
      payloadRef,
      receivedAt,
    );

    // Keyed to the delivery and connection rather than drawn fresh, so an
    // event re-enqueued by a retry carries the id WorkspaceDO already
    // receipted and is answered there as the same event.
    const activityIds = await Promise.all(normalized.map(({ connection }) => stableUuid([
      "provider_webhook_activity",
      input.provider,
      input.deliveryId,
      connection.id,
    ])));
    const activityStatements = legacyRegionalAuthority ? normalized.map(({ activity }, index) =>
      this.activityInsertStatement(
        activityIds[index]!,
        activity,
        input.provider,
        input.deliveryId,
        payloadRef,
      )) : [];
    const legacyLifecycleStatements = legacyRegionalAuthority
      ? lifecycleUpdates.map((update) => this.lifecycleUpdateStatement(
          this.env.DB,
          input.provider,
          update,
          input.deliveryId,
          payloadRef,
        ))
      : [];
    const legacyResourceStatements = legacyRegionalAuthority
      ? discoveredResources.map(({ connection, resources }) => this.resourceUpsertStatement(
          this.env.DB,
          connection,
          resources,
          input.provider,
          input.deliveryId,
          input.eventType,
          payloadRef,
        ))
      : [];
    const results = await this.env.DB.batch([
      receipt,
      ...activityStatements,
      ...legacyLifecycleStatements,
      ...legacyResourceStatements,
    ]);
    const duplicate = resultChanges(results[0]) === 0;
    const existingWorkspaceReceipt = !legacyRegionalAuthority && duplicate
      ? await this.loadReceipt(input.provider, input.deliveryId)
      : null;
    if (existingWorkspaceReceipt) {
      this.assertMatchingReceipt(existingWorkspaceReceipt, input.eventType, payloadRef);
    }
    const insertedActivityIds = activityIds.filter(
      (_id, index) => resultChanges(results[index + 1]) > 0,
    );
    if (!legacyRegionalAuthority) {
      // A null receipt is new; a pending duplicate repairs a crash after the
      // global receipt commit. An already processed duplicate must not replay
      // an older lifecycle update over a newer connector state.
      const shouldApplyWorkspaceEffects = !duplicate
        || existingWorkspaceReceipt?.processed_at === null;
      if (shouldApplyWorkspaceEffects) {
        for (const { connection, resources } of discoveredResources) {
          // The typed upsert reaches the object that owns `resources`
          // directly; only the legacy no-namespace path below still builds
          // the receipt-fenced regional statement.
          const workspace = await durableObjectStubForWorkspace(
            this.env,
            this.env.WORKSPACE_DOS,
            asWorkspaceId(connection.workspaceId),
            workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(connection.workspaceId)),
          );
          const at = nowIso();
          await workspace.upsertDiscoveredResources({
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            provider: input.provider,
            resources: resources.map((resource) => ({
              id: newId(),
              resourceType: resource.resourceType,
              providerResourceId: resource.providerResourceId,
              title: resource.title,
              canonicalUrl: resource.canonicalUrl ?? null,
              metadataJson: JSON.stringify({
                ...resource.metadata,
                discoveredEventType: input.eventType,
                discoveredDeliveryId: input.deliveryId,
              }),
            })),
            at,
          });
        }
        const connectionWorkspace = new Map(connections.map((connection) => [
          connection.id,
          connection.workspaceId,
        ]));
        for (const update of lifecycleUpdates) {
          const workspaceId = connectionWorkspace.get(update.connectionId);
          if (!workspaceId) continue;
          if (!await this.claimLifecycleWatermark(update, input)) continue;
          await this.lifecycleUpdateStatement(
            withWorkspaceRuntimeDatabase(this.env, workspaceId).DB,
            input.provider,
            update,
          ).run();
        }
      }
    }

    if (!legacyRegionalAuthority) {
      const queueActivities = existingWorkspaceReceipt?.processed_at
        ? []
        : normalized.map(({ activity }, index) => ({
            connectorType: input.provider,
            activity: { id: activityIds[index]!, ...activity },
          }));
      await this.finishWorkspaceReceipt(
        input.provider,
        input.deliveryId,
        payloadRef,
        queueActivities,
      );
      await this.publishConnectionChanges(matchedConnections, ["connector_connections", "resources"]);
      return {
        accepted: true,
        duplicate,
        activityCount: duplicate ? 0 : normalized.length,
      };
    }

    let queueActivities = insertedActivityIds.map((activityId) => ({
      activityId,
      workspaceId: normalized[activityIds.indexOf(activityId)]!.activity.workspaceId,
    }));
    if (duplicate) {
      const existingReceipt = await this.loadReceipt(input.provider, input.deliveryId);
      if (existingReceipt) {
        this.assertMatchingReceipt(existingReceipt, input.eventType, payloadRef);
      }
      if (
        existingReceipt?.processed_at === null
      ) {
        queueActivities = await this.findPendingReceiptActivities(
          input.provider,
          input.deliveryId,
          payloadRef,
        );
      } else {
        queueActivities = [];
      }
    }

    await this.finishReceipt(
      input.provider,
      input.deliveryId,
      payloadRef,
      queueActivities,
    );
    await this.publishConnectionChanges(matchedConnections, ["connector_connections", "resources"]);
    return {
      accepted: true,
      duplicate,
      activityCount: duplicate ? 0 : insertedActivityIds.length,
    };
  }

  /**
   * Tell the people who can see these connections that their rows and
   * resources moved. A personal connection's resources are its owner's alone
   * (`resource-service.ts` lists them only for the owner), so a workspace
   * whose matched connections are all personal tells only their owners; one
   * with an Organization connection tells everybody.
   */
  private async publishConnectionChanges(
    connections: readonly ConnectorConnectionContext[],
    topics: Parameters<typeof publishWorkspaceSync>[2],
  ): Promise<void> {
    const byWorkspace = new Map<string, ConnectorConnectionContext[]>();
    for (const connection of connections) {
      byWorkspace.set(connection.workspaceId, [...(byWorkspace.get(connection.workspaceId) ?? []), connection]);
    }
    await Promise.all([...byWorkspace].map(async ([workspaceId, matched]) => {
      const owners = matched.some((connection) => connection.scope === "workspace" || !connection.ownerUserId)
        ? null
        : [...new Set(matched.flatMap((connection) => (connection.ownerUserId ? [connection.ownerUserId] : [])))];
      try {
        await publishWorkspaceSync(this.env, workspaceId, topics, owners ? { audienceUserIds: owners } : undefined);
      } catch (error) {
        logWarn(this.env, "provider_webhook_workspace_sync_publish_failed", {
          workspace_id: workspaceId,
          topics,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }));
  }

  private async finishReceipt(
    provider: Provider,
    deliveryId: string,
    payloadRef: string,
    queueActivities: Array<{ activityId: string; workspaceId: string }>,
  ): Promise<void> {
    try {
      for (const { activityId, workspaceId } of queueActivities) {
        await this.env.ACTIVITY_QUEUE.send(ActivityQueueMessageSchema.parse({
          region: this.env.AVALON_REGION,
          workspaceId,
          activityId,
          attempt: 0,
        }));
      }
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE provider_webhook_receipts SET error_json = ?
         WHERE provider = ? AND delivery_id = ? AND payload_ref = ?`,
      ).bind(
        JSON.stringify({
          code: "activity_enqueue_failed",
          message: "Canonical webhook activities could not be enqueued",
        }),
        provider,
        deliveryId,
        payloadRef,
      ).run();
      throw new ConnectorError(
        "provider_error",
        "The webhook was stored but could not be queued for processing",
        error,
      );
    }

    await this.env.DB.prepare(
      `UPDATE provider_webhook_receipts
       SET processed_at = COALESCE(processed_at, ?), error_json = NULL
       WHERE provider = ? AND delivery_id = ? AND payload_ref = ?`,
    ).bind(nowIso(), provider, deliveryId, payloadRef).run();
  }

  private async finishWorkspaceReceipt(
    provider: Provider,
    deliveryId: string,
    payloadRef: string,
    queueActivities: Array<{
      connectorType: string;
      activity: NormalizedActivity;
    }>,
  ): Promise<void> {
    try {
      for (const activity of queueActivities) {
        await enqueueWorkspaceConnectorEvent(this.env, activity);
      }
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE provider_webhook_receipts SET error_json = ?
         WHERE provider = ? AND delivery_id = ? AND payload_ref = ?`,
      ).bind(
        JSON.stringify({
          code: "activity_enqueue_failed",
          message: "Workspace connector events could not be enqueued",
        }),
        provider,
        deliveryId,
        payloadRef,
      ).run();
      throw new ConnectorError(
        "provider_error",
        "The webhook was stored but could not be queued for processing",
        error,
      );
    }

    await this.env.DB.prepare(
      `UPDATE provider_webhook_receipts
       SET processed_at = COALESCE(processed_at, ?), error_json = NULL
       WHERE provider = ? AND delivery_id = ? AND payload_ref = ?`,
    ).bind(nowIso(), provider, deliveryId, payloadRef).run();
  }

  private async loadReceipt(
    provider: Provider,
    deliveryId: string,
  ): Promise<{
    event_type: string;
    payload_ref: string;
    processed_at: string | null;
  } | null> {
    return this.env.DB.prepare(
      `SELECT event_type, payload_ref, processed_at
       FROM provider_webhook_receipts
       WHERE provider = ? AND delivery_id = ?`,
    ).bind(provider, deliveryId).first<{
      event_type: string;
      payload_ref: string;
      processed_at: string | null;
    }>();
  }

  private assertMatchingReceipt(
    receipt: { event_type: string; payload_ref: string },
    eventType: string,
    payloadRef: string,
  ): void {
    if (receipt.event_type === eventType && receipt.payload_ref === payloadRef) return;
    throw new ConnectorError(
      "provider_error",
      "The provider reused a webhook delivery ID with different event content",
    );
  }

  private authoritativeActivity(
    connection: ConnectorConnectionContext,
    candidate: Omit<NormalizedActivity, "id">,
    input: VerifiedIngestion,
    payloadRef: string,
  ): Omit<NormalizedActivity, "id"> {
    return NormalizedWebhookActivitySchema.parse({
      ...candidate,
      workspaceId: connection.workspaceId,
      region: this.env.AVALON_REGION,
      connectionId: connection.id,
      connectionScope: connection.scope,
      connectionOwnerUserId: connection.ownerUserId,
      provider: input.provider,
      providerEventId: input.deliveryId,
      payloadRef,
      rawContentHash: input.bodyHash,
    });
  }

  private activityInsertStatement(
    activityId: string,
    activity: Omit<NormalizedActivity, "id">,
    provider: Provider,
    deliveryId: string,
    payloadRef: string,
  ): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO activities
       (id, workspace_id, connection_id, connection_scope,
        connection_owner_user_id, provider, provider_event_id, event_type,
        resource_type, provider_resource_id, actor_json, subject_json,
        occurred_at, received_at, title, summary, text_snippet, payload_ref,
        visibility_json, entity_keys_json, dedupe_key, raw_content_hash,
        target_user_ids_json, external_people_json,
        processing_status, metadata_json)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
              ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?28, ?27, 'pending', ?23
       WHERE EXISTS (
         SELECT 1 FROM provider_webhook_receipts
         WHERE provider = ?24 AND delivery_id = ?25 AND payload_ref = ?26
           AND processed_at IS NULL
       )
       ON CONFLICT DO NOTHING`,
    ).bind(
      activityId,
      activity.workspaceId,
      activity.connectionId,
      activity.connectionScope,
      activity.connectionOwnerUserId,
      activity.provider,
      activity.providerEventId,
      activity.eventType,
      activity.resourceType,
      activity.providerResourceId,
      JSON.stringify(activity.actor),
      JSON.stringify(activity.subject),
      activity.occurredAt,
      activity.receivedAt,
      activity.title,
      activity.summary,
      activity.textSnippet,
      activity.payloadRef,
      JSON.stringify(activity.visibility),
      JSON.stringify(activity.entityKeys),
      activity.dedupeKey,
      activity.rawContentHash,
      JSON.stringify(activity.metadata),
      provider,
      deliveryId,
      payloadRef,
      JSON.stringify(activity.externalPeople ?? []),
      JSON.stringify(activity.targetUserIds),
    );
  }

  // Historical no-namespace D1 path: retain its receipt-fenced write behavior.
  // Deployed WorkspaceDO discovery owns no-op suppression in workspace-resources-storage.ts.
  private resourceUpsertStatement(
    database: D1Database,
    connection: ConnectorConnectionContext,
    resources: GitHubWebhookResourceHint[],
    provider: Provider,
    deliveryId: string,
    eventType: string,
    receiptPayloadRef?: string,
  ): D1PreparedStatement {
    const at = nowIso();
    const rows = resources.map((resource) => ({
      id: newId(),
      resourceType: resource.resourceType,
      providerResourceId: resource.providerResourceId,
      title: resource.title,
      canonicalUrl: resource.canonicalUrl,
      metadataJson: JSON.stringify({
        ...resource.metadata,
        discoveredEventType: eventType,
        discoveredDeliveryId: deliveryId,
      }),
    }));
    const receiptFence = receiptPayloadRef === undefined ? "" : `WHERE EXISTS (
         SELECT 1 FROM provider_webhook_receipts
          WHERE provider = ? AND delivery_id = ? AND payload_ref = ?
            AND processed_at IS NULL
       )`;
    return database.prepare(
      `INSERT INTO resources
       (id, workspace_id, connection_id, resource_type, provider,
        provider_resource_id, title, canonical_url, metadata_json,
        created_at, updated_at)
       SELECT
         json_extract(value, '$.id'), ?, ?,
         json_extract(value, '$.resourceType'), ?,
         json_extract(value, '$.providerResourceId'),
         json_extract(value, '$.title'),
         json_extract(value, '$.canonicalUrl'),
         json_extract(value, '$.metadataJson'), ?, ?
       FROM json_each(?)
       ${receiptFence}
       ON CONFLICT(workspace_id, connection_id, provider, provider_resource_id)
       WHERE connection_id IS NOT NULL AND provider_resource_id IS NOT NULL
       DO UPDATE SET
         resource_type = excluded.resource_type,
         title = excluded.title,
         canonical_url = COALESCE(excluded.canonical_url, resources.canonical_url),
         metadata_json = json_patch(resources.metadata_json, excluded.metadata_json),
         updated_at = excluded.updated_at`,
    ).bind(
      connection.workspaceId,
      connection.id,
      provider,
      at,
      at,
      JSON.stringify(rows),
      ...(receiptPayloadRef === undefined ? [] : [provider, deliveryId, receiptPayloadRef]),
    );
  }

  private lifecycleUpdateStatement(
    database: D1Database,
    provider: Provider,
    update: LifecycleUpdate,
    deliveryId?: string,
    receiptPayloadRef?: string,
  ): D1PreparedStatement {
    const receiptFence = deliveryId === undefined || receiptPayloadRef === undefined
      ? ""
      : `AND EXISTS (
           SELECT 1 FROM provider_webhook_receipts
            WHERE provider = ? AND delivery_id = ? AND payload_ref = ?
              AND processed_at IS NULL
         )`;
    return database.prepare(
      `UPDATE connector_connections
       SET status = ?, error_json = ?, updated_at = ?
       WHERE id = ? AND connector_type = ?
       ${receiptFence}`,
    ).bind(
      update.status,
      update.error === null ? null : JSON.stringify(update.error),
      nowIso(),
      update.connectionId,
      provider,
      ...(deliveryId === undefined || receiptPayloadRef === undefined
        ? []
        : [provider, deliveryId, receiptPayloadRef]),
    );
  }

  /**
   * Orders lifecycle updates for one connection by when their deliveries were
   * received. A Queue retry can deliver an older `installation.unsuspend`
   * after a newer `installation.suspend` was applied; without this the older
   * one would win. The watermark is `connector_ingress_routes.lifecycle_at` in
   * the regional database, advanced only forward. An equal timestamp claims
   * again, so a retry of the delivery that holds the watermark re-applies.
   *
   * The claim and the WorkspaceDO write are separate stores, so two updates
   * for one connection processed at the same moment can still interleave; the
   * watermark closes the retry case, which is the one backoff makes common.
   */
  private async claimLifecycleWatermark(
    update: LifecycleUpdate,
    input: Pick<VerifiedIngestion, "provider" | "deliveryId">,
  ): Promise<boolean> {
    if (update.at === undefined) return true;
    const claimed = await this.env.DB.prepare(
      `UPDATE connector_ingress_routes SET lifecycle_at = ?
        WHERE connection_id = ? AND (lifecycle_at IS NULL OR lifecycle_at <= ?)`,
    ).bind(update.at, update.connectionId, update.at).run();
    if (resultChanges(claimed) > 0) return true;
    logInfo(this.env, "provider_webhook_lifecycle_superseded", {
      provider: input.provider,
      delivery_id: input.deliveryId,
      connection_id: update.connectionId,
      status: update.status,
    });
    return false;
  }

  private async findPendingReceiptActivities(
    provider: Provider,
    deliveryId: string,
    payloadRef: string,
  ): Promise<Array<{ activityId: string; workspaceId: string }>> {
    const canonical = await this.env.DB.prepare(
      `SELECT id, workspace_id FROM activities
       WHERE provider = ? AND provider_event_id = ? AND payload_ref = ?
         AND processing_status IN ('pending', 'failed')
       ORDER BY received_at`,
    ).bind(
      provider,
      deliveryId,
      payloadRef,
    ).all<{ id: string; workspace_id: string }>();
    return [...new Map((canonical.results ?? []).map((row) => [
      row.id,
      { activityId: row.id, workspaceId: row.workspace_id },
    ])).values()];
  }

  private async loadMatchingConnections(
    provider: Provider,
    accountId: string | null,
    routingAccountIds: string[] | undefined,
    routingUserId: string | undefined,
  ): Promise<ConnectorConnectionContext[]> {
    if (provider === "github" && accountId === null && !routingUserId) return [];
    if (provider === "linear" && accountId === null) return [];
    if (provider === "notion" && (!routingAccountIds || routingAccountIds.length === 0)) {
      return [];
    }
    if (!this.env.WORKSPACE_DOS) {
      return this.loadLegacyMatchingConnections(
        provider,
        accountId,
        routingAccountIds,
        routingUserId,
      );
    }
    const routeQuery = provider === "notion"
      ? `SELECT connection_id, workspace_id FROM connector_ingress_routes
          WHERE region = ? AND connector_type = 'notion' AND scope = 'workspace'
            AND status = 'active'
            AND provider_account_id IN (${routingAccountIds!.map(() => "?").join(", ")})`
      : provider === "github" && accountId === null
        ? `SELECT connection_id, workspace_id FROM connector_ingress_routes
            WHERE region = ? AND connector_type = 'github' AND scope = 'personal'
              AND status = 'active' AND provider_user_id = ?`
      : provider === "linear" && routingUserId
        ? `SELECT connection_id, workspace_id FROM connector_ingress_routes
            WHERE region = ? AND connector_type = 'linear' AND scope = 'personal'
              AND status = 'active' AND provider_account_id = ? AND provider_user_id = ?`
      : `SELECT connection_id, workspace_id FROM connector_ingress_routes
          WHERE region = ? AND connector_type = ? AND provider_account_id = ?
            AND status = 'active'`;
    const routeStatement = this.env.DB.prepare(routeQuery);
    const routes = provider === "notion"
      ? await routeStatement.bind(this.env.AVALON_REGION, ...routingAccountIds!).all<{
          connection_id: string; workspace_id: string;
        }>()
      : provider === "github" && accountId === null
        ? await routeStatement.bind(this.env.AVALON_REGION, routingUserId!).all<{
            connection_id: string; workspace_id: string;
          }>()
      : provider === "linear" && routingUserId
        ? await routeStatement.bind(this.env.AVALON_REGION, accountId, routingUserId).all<{
            connection_id: string; workspace_id: string;
          }>()
      : await routeStatement.bind(this.env.AVALON_REGION, provider, accountId).all<{
          connection_id: string; workspace_id: string;
        }>();
    const byWorkspace = new Map<string, string[]>();
    for (const route of routes.results) {
      byWorkspace.set(route.workspace_id, [
        ...(byWorkspace.get(route.workspace_id) ?? []),
        route.connection_id,
      ]);
    }
    const rows = (await Promise.all([...byWorkspace].map(async ([workspaceId, connectionIds]) => {
      const workspaceEnv = withWorkspaceRuntimeDatabase(this.env, workspaceId);
      return (await workspaceEnv.DB.prepare(
        `SELECT * FROM connector_connections
          WHERE workspace_id = ? AND connector_type = ? AND status <> 'disabled'
            AND id IN (${connectionIds.map(() => "?").join(",")})`,
      ).bind(workspaceId, provider, ...connectionIds).all<StoredProviderConnection>()).results;
    }))).flat();
    return Promise.all(rows.map((row) => this.connectionContext(row)));
  }

  /** Pre-cutover/test path while connector rows still share the regional database. */
  private async loadLegacyMatchingConnections(
    provider: Provider,
    accountId: string | null,
    routingAccountIds: string[] | undefined,
    routingUserId: string | undefined,
  ): Promise<ConnectorConnectionContext[]> {
    const query = provider === "notion"
      ? `SELECT * FROM connector_connections
          WHERE connector_type = 'notion' AND scope = 'workspace'
            AND provider_account_id IN (${routingAccountIds!.map(() => "?").join(", ")})
            AND status <> 'disabled'`
      : provider === "github" && accountId === null
        ? `SELECT * FROM connector_connections
            WHERE connector_type = 'github' AND scope = 'personal'
              AND CAST(json_extract(config_json, '$.githubUserId') AS TEXT) = ?
              AND status <> 'disabled'`
      : provider === "linear" && routingUserId
        ? `SELECT * FROM connector_connections
            WHERE connector_type = 'linear' AND scope = 'personal'
              AND provider_account_id = ?
              AND CAST(json_extract(config_json, '$.providerUserId') AS TEXT) = ?
              AND status <> 'disabled'`
      : `SELECT * FROM connector_connections
          WHERE connector_type = ? AND provider_account_id = ?
            AND status <> 'disabled'`;
    const statement = this.env.DB.prepare(query);
    const rows = provider === "notion"
      ? await statement.bind(...routingAccountIds!).all<StoredProviderConnection>()
      : provider === "github" && accountId === null
        ? await statement.bind(routingUserId!).all<StoredProviderConnection>()
      : provider === "linear" && routingUserId
        ? await statement.bind(accountId, routingUserId).all<StoredProviderConnection>()
      : await statement.bind(provider, accountId).all<StoredProviderConnection>();
    return Promise.all(rows.results.map((row) => this.connectionContext(row)));
  }

  private async connectionContext(
    row: StoredProviderConnection,
  ): Promise<ConnectorConnectionContext> {
    let credentials: Record<string, unknown> = {};
    if (row.encrypted_credentials && row.credential_iv) {
      credentials = parseRecord(await decryptVersionedConnectorCredentials(this.env, {
        id: row.id,
        encrypted_credentials: row.encrypted_credentials,
        credential_iv: row.credential_iv,
        credential_key_version: row.credential_key_version,
      }));
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      scope: row.scope,
      ownerUserId: row.owner_user_id,
      grantedScopes: parseStringArray(row.granted_scopes_json),
      credentials,
      cursor: parseRecord(row.cursor_json),
      config: parseRecord(row.config_json),
    };
  }

  private async filterGitHubPersonalConnections(
    connections: ConnectorConnectionContext[],
    delivery: GitHubWebhookDelivery,
  ): Promise<ConnectorConnectionContext[]> {
    if (["ping", "installation", "github_app_authorization"].includes(delivery.event)) {
      return connections;
    }
    if (delivery.event === "installation_repositories") {
      return connections.filter((connection) => connection.scope === "workspace");
    }
    const repositoryFullName = nestedString(delivery.payload, "repository", "full_name");
    const config = this.githubConfig();
    const accepted: ConnectorConnectionContext[] = [];
    for (const connection of connections) {
      if (connection.scope === "workspace") {
        accepted.push(connection);
        continue;
      }
      // Repository activity must never fan out solely because two users share
      // an installation. Prove access with the personal user token first.
      if (!repositoryFullName || !config) continue;
      try {
        // Through the credential door: this probe refreshes a near-expiry
        // token, and several deliveries for one connection can be in flight at
        // once. Without the door's serialized rotation each would redeem the
        // same single-use refresh token privately. The door also persists what
        // it rotated, which is what the manual write here used to do.
        const signal = AbortSignal.timeout(15_000);
        const hasAccess = await withAuthorizedConnection(
          this.env,
          { connection, adapter: connectorRegistryForEnv(this.env).get("github"), signal },
          (authorized) => canGitHubPersonalConnectionAccessRepository(
            config,
            authorized,
            repositoryFullName,
            signal,
          ),
        );
        if (hasAccess) accepted.push(connection);
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "unauthorized") throw error;
        await withWorkspaceRuntimeDatabase(this.env, connection.workspaceId).DB.prepare(
          `UPDATE connector_connections
           SET status = 'needs_reconnect', error_json = ?, updated_at = ?
           WHERE id = ? AND connector_type = 'github' AND status IN ('healthy', 'error')`,
        ).bind(
          JSON.stringify({
            code: "github_user_authorization_expired",
            message: "Reconnect this personal GitHub connection",
          }),
          nowIso(),
          connection.id,
        ).run();
      }
    }
    return accepted;
  }

  private async filterLinearPersonalConnections(
    connections: ConnectorConnectionContext[],
    verified: VerifiedLinearWebhook,
  ): Promise<ConnectorConnectionContext[]> {
    if (["AgentSessionEvent", "OAuthApp", "Organization"].includes(verified.eventName)) {
      return connections.filter((connection) => connection.scope === "workspace");
    }
    if (verified.eventName === "OAuthAuthorization") {
      const userId = linearOAuthAuthorizationUserId(verified);
      if (!userId) return [];
      return connections.filter((connection) => connection.scope === "personal"
        && stringValue(connection.credentials, "authorizedUserId") === userId);
    }
    const config = linearConnectorConfig(this.env);
    const accepted: ConnectorConnectionContext[] = [];
    const personal = connections.filter((connection) => connection.scope === "personal");
    accepted.push(...connections.filter((connection) => connection.scope === "workspace"));
    if (!config) return accepted;
    const concurrency = 4;
    for (let index = 0; index < personal.length; index += concurrency) {
      const authorized = await Promise.all(personal.slice(index, index + concurrency).map(async (connection) => {
        const credentialsBefore = JSON.stringify(connection.credentials);
        try {
          const hasAccess = await canPersonalLinearConnectionAccessWebhook({
            config: { ...config, fetch: this.fetcher, now: this.now },
            connection,
            verified,
            signal: AbortSignal.timeout(15_000),
          });
          if (JSON.stringify(connection.credentials) !== credentialsBefore) {
            await this.persistConnectionCredentials(connection);
          }
          return hasAccess ? connection : null;
        } catch (error) {
          if (!(error instanceof ConnectorError) || error.code !== "unauthorized") throw error;
          await withWorkspaceRuntimeDatabase(this.env, connection.workspaceId).DB.prepare(
            `UPDATE connector_connections
             SET status = 'needs_reconnect', error_json = ?, updated_at = ?
             WHERE id = ? AND connector_type = 'linear' AND status IN ('healthy', 'error')`,
          ).bind(
            JSON.stringify({
              code: "linear_user_authorization_expired",
              message: "Reconnect this personal Linear connection",
            }),
            nowIso(),
            connection.id,
          ).run();
          return null;
        }
      }));
      accepted.push(...authorized.filter((connection): connection is ConnectorConnectionContext => connection !== null));
    }
    return accepted;
  }

  private async persistConnectionCredentials(
    connection: ConnectorConnectionContext,
  ): Promise<void> {
    const encrypted = await encryptString(
      JSON.stringify(connection.credentials),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      connection.id,
    );
    await withWorkspaceRuntimeDatabase(this.env, connection.workspaceId).DB.prepare(
      `UPDATE connector_connections
       SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
           updated_at = ?
       WHERE id = ? AND status <> 'disabled'`,
    ).bind(
      encrypted.ciphertext,
      encrypted.iv,
      Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
      nowIso(),
      connection.id,
    ).run();
  }

  private githubConfig(): GitHubConnectorConfig | null {
    const appId = this.env.GITHUB_APP_ID?.trim();
    const clientId = this.env.GITHUB_APP_CLIENT_ID?.trim();
    const clientSecret = this.env.GITHUB_APP_CLIENT_SECRET?.trim();
    const privateKey = this.env.GITHUB_APP_PRIVATE_KEY?.trim();
    const webhookSecret = this.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!appId || !clientId || !clientSecret || !privateKey || !webhookSecret) return null;
    return {
      appId,
      clientId,
      clientSecret,
      privateKey: privateKey.replaceAll("\\n", "\n"),
      webhookSecret,
      redirectUri: new URL(
        "/connections/github/callback",
        this.env.PUBLIC_API_BASE_URL,
      ).toString(),
      ...(this.env.GITHUB_APP_SLUG ? { appSlug: this.env.GITHUB_APP_SLUG } : {}),
      fetch: this.fetcher,
      now: this.now,
    };
  }

  private webhookActivity(provider: Provider): ConnectorWebhookActivitySource | null {
    try {
      return connectorRegistryForEnv(this.env).get(provider).webhookActivity ?? null;
    } catch {
      // A provider-wide route can still use its host-managed verification
      // configuration when connector OAuth is unavailable in this region.
      return null;
    }
  }

  private exactRawBody(rawBody: ProviderWebhookRawBody, maxBytes = this.maxBytes()): ExactRawBody {
    let text: string;
    let byteLength: number;
    let storageValue: string | ArrayBuffer;
    if (typeof rawBody === "string") {
      if (rawBody.length > maxBytes) {
        throw providerWebhookTooLarge();
      }
      text = rawBody;
      byteLength = new TextEncoder().encode(rawBody).byteLength;
      storageValue = rawBody;
    } else {
      const source = rawBody instanceof Uint8Array
        ? rawBody
        : new Uint8Array(rawBody);
      if (source.byteLength > maxBytes) {
        throw providerWebhookTooLarge();
      }
      const copy = new Uint8Array(source.byteLength);
      copy.set(source);
      byteLength = copy.byteLength;
      storageValue = copy.buffer;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy);
      } catch (error) {
        throw new ConnectorError(
          "provider_error",
          "The webhook body is not valid UTF-8",
          error,
        );
      }
    }
    if (byteLength > maxBytes) throw providerWebhookTooLarge();
    return { text, byteLength, storageValue };
  }

  private maxBytes(): number {
    return numericEnv(
      this.env,
      "PROVIDER_WEBHOOK_MAX_BYTES",
      DEFAULT_PROVIDER_WEBHOOK_MAX_BYTES,
    );
  }

  /**
   * The stored regional verification token.
   *
   * The shared Global ingress has to verify a delivery's signature before it can
   * read which Notion workspace — and so which region — the delivery belongs to.
   */
  async notionVerificationToken(): Promise<string> {
    const challenge = await this.loadNotionChallenge();
    if (!challenge) {
      throw new ConnectorError(
        "invalid_configuration",
        "Notion webhook verification has not been completed for this region",
      );
    }
    return this.decryptNotionChallenge(challenge);
  }

  /**
   * Records the verification token the shared ingress captured.
   *
   * One public Notion connection means one subscription and one challenge, sent
   * to whichever host is registered. regional never receives that request and could
   * not otherwise verify a forwarded delivery for itself — so Global replicates
   * the token rather than have regional trust the hop. The one-time setup nonce was
   * consumed where the challenge arrived; this is reachable only over the
   * account-internal bridge and has no URL of its own.
   */
  async storeNotionChallengeToken(
    verificationToken: string,
    setupNonceHash: string | null = null,
    setupGeneration: number | null = null,
  ): Promise<void> {
    const encrypted = await encryptString(
      verificationToken,
      this.env.CONNECTOR_CREDENTIALS_KEY,
      this.notionChallengeAad(),
    );
    const createdAt = new Date(this.now()).toISOString();
    const upsert = `INSERT INTO provider_webhook_challenges
       (provider, region, encrypted_token, token_iv, credential_key_version,
        setup_nonce_hash, setup_generation, created_at, consumed_at)
       VALUES ('notion', ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(provider, region) DO UPDATE SET
         encrypted_token = excluded.encrypted_token,
         token_iv = excluded.token_iv,
         credential_key_version = excluded.credential_key_version,
         setup_nonce_hash = excluded.setup_nonce_hash,
         setup_generation = excluded.setup_generation,
         created_at = excluded.created_at,
         consumed_at = NULL
       WHERE provider_webhook_challenges.setup_generation IS NULL
          OR excluded.setup_generation >= provider_webhook_challenges.setup_generation`;
    if (setupNonceHash === null) {
      if (!setupGeneration || !Number.isSafeInteger(setupGeneration)) {
        throw new ConnectorError(
          "invalid_configuration",
          "The Notion webhook setup generation is required for regional replication",
        );
      }
      const replicated = await this.env.DB.prepare(upsert).bind(
        this.env.AVALON_REGION,
        encrypted.ciphertext,
        encrypted.iv,
        Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        null,
        setupGeneration,
        createdAt,
      ).run();
      if (resultChanges(replicated) !== 1) {
        throw new ConnectorError(
          "unauthorized",
          "The Notion webhook setup generation has been superseded",
        );
      }
      return;
    }

    const verificationTokenHash = await sha256(verificationToken);
    const stored = await this.env.DB.prepare(
       `INSERT INTO provider_webhook_challenges
       (provider, region, encrypted_token, token_iv, credential_key_version,
        setup_nonce_hash, setup_generation, created_at, consumed_at)
       SELECT 'notion', ?, ?, ?, ?, ?, nonce.rowid, ?, NULL
       FROM notion_webhook_setup_nonces AS nonce
       WHERE nonce.nonce_hash = ? AND nonce.is_current = 1
         AND nonce.consumed_at IS NOT NULL AND nonce.verification_token_hash = ?
       ON CONFLICT(provider, region) DO UPDATE SET
         encrypted_token = excluded.encrypted_token,
         token_iv = excluded.token_iv,
         credential_key_version = excluded.credential_key_version,
         setup_nonce_hash = excluded.setup_nonce_hash,
         setup_generation = excluded.setup_generation,
         created_at = excluded.created_at,
         consumed_at = NULL`,
    ).bind(
      this.env.AVALON_REGION,
      encrypted.ciphertext,
      encrypted.iv,
      Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
      setupNonceHash,
      createdAt,
      setupNonceHash,
      verificationTokenHash,
    ).run();
    if (resultChanges(stored) !== 1) {
      throw new ConnectorError(
        "unauthorized",
        "The Notion webhook setup nonce has been superseded",
      );
    }
  }

  async notionSetupGenerationForToken(verificationToken: string): Promise<number> {
    const verificationTokenHash = await sha256(verificationToken);
    const row = await this.env.DB.prepare(
      `SELECT nonce.rowid AS setup_generation
       FROM provider_webhook_challenges AS challenge
       INNER JOIN notion_webhook_setup_nonces AS nonce
         ON nonce.nonce_hash = challenge.setup_nonce_hash
       WHERE challenge.provider = 'notion' AND challenge.region = ?
         AND nonce.is_current = 1 AND nonce.consumed_at IS NOT NULL
         AND nonce.verification_token_hash = ?
         AND challenge.setup_generation = nonce.rowid`,
    ).bind(this.env.AVALON_REGION, verificationTokenHash).first<{ setup_generation: number }>();
    if (!row?.setup_generation) {
      throw new ConnectorError(
        "unauthorized",
        "The Notion webhook setup generation has been superseded",
      );
    }
    return row.setup_generation;
  }

  private async loadNotionChallenge(): Promise<{
    encrypted_token: string;
    token_iv: string;
    credential_key_version: number;
    setup_nonce_hash: string | null;
    setup_generation: number | null;
  } | null> {
    return this.env.DB.prepare(
      `SELECT encrypted_token, token_iv, credential_key_version,
              setup_nonce_hash, setup_generation
       FROM provider_webhook_challenges
       WHERE provider = 'notion' AND region = ?`,
    ).bind(this.env.AVALON_REGION).first<{
      encrypted_token: string;
      token_iv: string;
      credential_key_version: number;
      setup_nonce_hash: string | null;
      setup_generation: number | null;
    }>();
  }

  private notionChallengeAad(): string {
    return `${NOTION_CHALLENGE_AAD_PREFIX}:${this.env.AVALON_REGION}`;
  }

  private async decryptNotionChallenge(challenge: {
    encrypted_token: string;
    token_iv: string;
    credential_key_version?: number | null;
  }): Promise<string> {
    const activeVersion = Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1);
    const storedVersion = Number(challenge.credential_key_version || activeVersion);
    const plaintext = await decryptVersionedCredentialValue(this.env, {
      encrypted_credentials: challenge.encrypted_token,
      credential_iv: challenge.token_iv,
      credential_key_version: storedVersion,
    }, this.notionChallengeAad());
    if (storedVersion !== activeVersion) {
      const replacement = await encryptString(
        plaintext,
        this.env.CONNECTOR_CREDENTIALS_KEY,
        this.notionChallengeAad(),
      );
      await this.env.DB.prepare(
        `UPDATE provider_webhook_challenges
         SET encrypted_token = ?, token_iv = ?, credential_key_version = ?, created_at = ?
         WHERE provider = 'notion' AND region = ?
           AND encrypted_token = ? AND token_iv = ? AND credential_key_version = ?`,
      ).bind(
        replacement.ciphertext,
        replacement.iv,
        activeVersion,
        nowIso(),
        this.env.AVALON_REGION,
        challenge.encrypted_token,
        challenge.token_iv,
        storedVersion,
      ).run();
    }
    return plaintext;
  }

  private async stableProviderError<T>(
    provider: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        "provider_error",
        `${provider} webhook ingestion failed`,
        error,
      );
    }
  }
}

function requiredConfiguration(value: string | null | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new ConnectorError("invalid_configuration", `${label} is not configured`);
  }
  return normalized;
}

function providerWebhookTooLarge(): ConnectorError {
  return new ConnectorError(
    "payload_too_large",
    "The provider webhook exceeded the configured size limit",
  );
}

function firstHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

function githubLifecycle(
  delivery: GitHubWebhookDelivery,
): Omit<LifecycleUpdate, "connectionId"> | null {
  if (delivery.event === "github_app_authorization" && delivery.action === "revoked") {
    return {
      status: "needs_reconnect",
      error: {
        code: "github_user_authorization_revoked",
        message: "Reconnect this personal GitHub connection",
        reconnectRequired: true,
      },
    };
  }
  if (
    delivery.event === "installation_repositories" &&
    ["added", "removed"].includes(delivery.action ?? "")
  ) {
    return { status: "healthy", error: null };
  }
  if (delivery.event !== "installation") return null;
  if (delivery.action === "deleted") {
    return {
      status: "disabled",
      error: {
        code: "github_installation_deleted",
        message: "The GitHub App installation was deleted",
      },
    };
  }
  if (delivery.action === "suspend") {
    return {
      status: "needs_reconnect",
      error: {
        code: "github_installation_suspended",
        message: "The GitHub App installation is suspended",
      },
    };
  }
  if (["created", "unsuspend", "new_permissions_accepted"].includes(delivery.action ?? "")) {
    return { status: "healthy", error: null };
  }
  return null;
}

function githubSenderUserId(delivery: GitHubWebhookDelivery): string | null {
  const sender = delivery.payload.sender;
  if (!sender || typeof sender !== "object" || Array.isArray(sender)) return null;
  const id = (sender as Record<string, unknown>).id;
  if (typeof id === "string" && /^\d+$/u.test(id)) return id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? String(id)
    : null;
}

function linearLifecycle(
  verified: VerifiedLinearWebhook,
): Omit<LifecycleUpdate, "connectionId"> | null {
  const action = stringValue(verified.event, "action")?.toLowerCase();
  if (verified.eventName === "OAuthApp" && action === "revoked") {
    return {
      status: "needs_reconnect",
      error: {
        code: "linear_oauth_app_revoked",
        message: "Reconnect this Linear organization",
        reconnectRequired: true,
      },
    };
  }
  if (verified.eventName === "OAuthAuthorization" && action === "revoked") {
    return {
      status: "needs_reconnect",
      error: {
        code: "linear_oauth_authorization_revoked",
        message: "Reconnect this personal Linear account",
        reconnectRequired: true,
      },
    };
  }
  if (verified.eventName === "PermissionChange" && action === "teamaccesschanged") {
    return {
      // Linear team-access changes do not revoke the OAuth grant. Keep the
      // connection live so the next provider read reconciles the accessible
      // catalog instead of forcing an unnecessary reauthorization.
      status: "healthy",
      error: null,
    };
  }
  return null;
}

function linearOAuthAuthorizationUserId(verified: VerifiedLinearWebhook): string | null {
  const data = recordValue(verified.event, "data") ?? {};
  const authorization = recordValue(verified.event, "oauthAuthorization")
    ?? recordValue(data, "oauthAuthorization")
    ?? {};
  for (const [record, key] of [
    [verified.event, "userId"],
    [data, "userId"],
    [authorization, "userId"],
  ] as const) {
    const value = stringValue(record, key);
    if (value) return value;
  }
  return stringValue(recordValue(verified.event, "user") ?? {}, "id")
    ?? stringValue(recordValue(data, "user") ?? {}, "id")
    ?? stringValue(recordValue(authorization, "user") ?? {}, "id");
}

function notionConnectionMatches(
  connection: ConnectorConnectionContext,
  verified: VerifiedNotionWebhook,
): boolean {
  const workspaceId = stringValue(connection.credentials, "notionWorkspaceId")
    ?? stringValue(connection.config, "notionWorkspaceId");
  const botId = stringValue(connection.credentials, "botId")
    ?? stringValue(connection.config, "botId");
  const integrationId = stringValue(connection.credentials, "integrationId")
    ?? stringValue(connection.config, "integrationId");
  return workspaceId === verified.workspaceId
    && botId !== null
    && verified.accessibleBotIds.includes(botId)
    && integrationId === verified.integrationId;
}

function linearAgentConnectionMatches(
  connection: ConnectorConnectionContext,
  appUserId: string,
): boolean {
  return connection.scope === "workspace"
    && connection.grantedScopes.includes("linear.agent")
    && stringValue(connection.credentials, "appUserId") === appUserId;
}

function resultChanges(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function nestedString(
  record: Record<string, unknown>,
  parent: string,
  key: string,
): string | null {
  const value = record[parent];
  return isRecord(value) ? stringValue(value, key) : null;
}

function recordValue(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" && record[key] ? record[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const __providerWebhookTesting = {
  githubLifecycle,
  linearLifecycle,
  notionConnectionMatches,
  linearAgentConnectionMatches,
};
