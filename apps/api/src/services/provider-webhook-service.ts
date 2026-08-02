import {
  ActivityQueueMessageSchema,
  NormalizedActivitySchema,
  type NormalizedActivity,
  type Scope,
} from "@avalon/contracts";
import {
  canGitHubPersonalConnectionAccessRepository,
  ConnectorError,
  discoverGitHubWebhookResources,
  normalizeGitHubWebhook,
  normalizeLinearWebhook,
  normalizeNotionWebhook,
  readNotionWebhookVerificationToken,
  verifyGitHubWebhook,
  verifyLinearWebhook,
  verifyNotionWebhook,
  type ConnectorConnectionContext,
  type GitHubConnectorConfig,
  type GitHubWebhookDelivery,
  type GitHubWebhookResourceHint,
  type VerifiedLinearWebhook,
  type VerifiedNotionWebhook,
} from "@avalon/connectors";
import { newId, nowIso } from "@avalon/db";
import type { Env } from "../env";
import { numericEnv } from "../env";
import { decryptString, encryptString, timingSafeEqualText } from "../lib/crypto";

export type ProviderWebhookRawBody = string | Uint8Array | ArrayBuffer;
export type ProviderWebhookHeaders = Headers | HeadersInit;

export interface ProviderWebhookIngestionResult {
  accepted: true;
  duplicate: boolean;
  activityCount: number;
}

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
  includeRecoverableConnections?: boolean;
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
      const raw = this.exactRawBody(rawBody);
      const normalizedHeaders = new Headers(headers);
      const secret = requiredConfiguration(
        this.env.GITHUB_WEBHOOK_SECRET,
        "GitHub webhook signing secret",
      );
      const delivery = await verifyGitHubWebhook({
        secret,
        rawBody: raw.text,
        signatureHeader: normalizedHeaders.get("x-hub-signature-256"),
        eventHeader: normalizedHeaders.get("x-github-event"),
        deliveryHeader: normalizedHeaders.get("x-github-delivery"),
        receivedAt: new Date(this.now()).toISOString(),
        maxBytes: this.maxBytes(),
      });
      const lifecycle = githubLifecycle(delivery);
      const resourceDiscovery = discoverGitHubWebhookResources(delivery);
      const routingUserId = delivery.event === "github_app_authorization"
        ? githubSenderUserId(delivery)
        : null;
      return this.ingestVerified({
        provider: "github",
        deliveryId: delivery.deliveryId,
        eventType: delivery.event,
        accountId: delivery.installationId,
        ...(routingUserId ? { routingUserId } : {}),
        bodyHash: delivery.rawContentHash,
        raw,
        includeRecoverableConnections: lifecycle !== null,
        normalize: (connection, payloadRef) =>
          normalizeGitHubWebhook(connection, delivery, payloadRef),
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
    });
  }

  async ingestLinear(
    rawBody: ProviderWebhookRawBody,
    headers: ProviderWebhookHeaders,
  ): Promise<ProviderWebhookIngestionResult> {
    return this.stableProviderError("Linear", async () => {
      const raw = this.exactRawBody(rawBody);
      const normalizedHeaders = new Headers(headers);
      const verified = await verifyLinearWebhook({
        secret: requiredConfiguration(
          this.env.LINEAR_WEBHOOK_SECRET,
          "Linear webhook signing secret",
        ),
        rawBody: raw.text,
        signatureHeader: normalizedHeaders.get("linear-signature"),
        deliveryHeader: firstHeader(normalizedHeaders, [
          "linear-delivery",
          "linear-delivery-id",
          "x-linear-delivery",
        ]),
        eventHeader: firstHeader(normalizedHeaders, ["linear-event", "x-linear-event"]),
        timestampHeader: firstHeader(normalizedHeaders, [
          "linear-timestamp",
          "x-linear-timestamp",
        ]),
        now: this.now(),
        replayWindowMs:
          numericEnv(this.env, "WEBHOOK_REPLAY_WINDOW_SECONDS", 300) * 1_000,
        maxBytes: this.maxBytes(),
      });
      const lifecycle = linearLifecycle(verified);
      return this.ingestVerified({
        provider: "linear",
        deliveryId: verified.deliveryId,
        eventType: verified.eventName,
        accountId: verified.organizationId,
        includeRecoverableConnections: lifecycle !== null,
        bodyHash: verified.bodyHash,
        raw,
        normalize: (connection, payloadRef) =>
          normalizeLinearWebhook(connection, verified, payloadRef),
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
    setupToken: string | null = null,
  ): Promise<ProviderWebhookIngestionResult> {
    return this.stableProviderError("Notion", async () => {
      const raw = this.exactRawBody(rawBody);
      const normalizedHeaders = new Headers(headers);
      const verificationToken = readNotionWebhookVerificationToken(
        raw.text,
        this.maxBytes(),
      );
      if (verificationToken !== null) {
        return this.captureNotionChallenge(verificationToken, setupToken);
      }

      const challenge = await this.env.DB.prepare(
        `SELECT encrypted_token, token_iv
         FROM provider_webhook_challenges
         WHERE provider = 'notion' AND region = ?`,
      ).bind(this.env.AVALON_REGION).first<{
        encrypted_token: string;
        token_iv: string;
      }>();
      if (!challenge) {
        throw new ConnectorError(
          "invalid_configuration",
          "Notion webhook verification has not been completed for this region",
        );
      }
      const secret = await decryptString(
        challenge.encrypted_token,
        challenge.token_iv,
        this.env.CONNECTOR_CREDENTIALS_KEY,
        this.notionChallengeAad(),
      );
      const verified = await verifyNotionWebhook({
        secret,
        rawBody: raw.text,
        signatureHeader: normalizedHeaders.get("x-notion-signature"),
        expectedIntegrationId: requiredConfiguration(
          this.env.NOTION_INTEGRATION_ID ?? this.env.NOTION_OAUTH_CLIENT_ID,
          "Notion integration/client ID",
        ),
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
        normalize: (connection, payloadRef) =>
          normalizeNotionWebhook(connection, verified, payloadRef),
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
    suppliedSetupToken: string | null,
  ): Promise<ProviderWebhookIngestionResult> {
    const configuredSetupToken = requiredConfiguration(
      this.env.NOTION_WEBHOOK_SETUP_TOKEN,
      "Notion webhook setup token",
    );
    if (
      !suppliedSetupToken ||
      !timingSafeEqualText(configuredSetupToken, suppliedSetupToken)
    ) {
      throw new ConnectorError(
        "unauthorized",
        "The Notion webhook setup token is invalid",
      );
    }

    const existing = await this.env.DB.prepare(
      `SELECT encrypted_token, token_iv
       FROM provider_webhook_challenges
       WHERE provider = 'notion' AND region = ?`,
    ).bind(this.env.AVALON_REGION).first<{
      encrypted_token: string;
      token_iv: string;
    }>();
    if (existing) {
      const existingToken = await decryptString(
        existing.encrypted_token,
        existing.token_iv,
        this.env.CONNECTOR_CREDENTIALS_KEY,
        this.notionChallengeAad(),
      );
      if (timingSafeEqualText(existingToken, verificationToken)) {
        return { accepted: true, duplicate: true, activityCount: 0 };
      }
      throw new ConnectorError(
        "unauthorized",
        "Notion webhook verification is already configured and cannot be replaced through the setup endpoint",
      );
    }

    const encrypted = await encryptString(
      verificationToken,
      this.env.CONNECTOR_CREDENTIALS_KEY,
      this.notionChallengeAad(),
    );
    const inserted = await this.env.DB.prepare(
      `INSERT INTO provider_webhook_challenges
       (provider, region, encrypted_token, token_iv, credential_key_version,
        created_at, consumed_at)
       VALUES ('notion', ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(provider, region) DO NOTHING`,
    ).bind(
      this.env.AVALON_REGION,
      encrypted.ciphertext,
      encrypted.iv,
      Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
      nowIso(),
    ).run();
    if (resultChanges(inserted) === 0) {
      const winner = await this.env.DB.prepare(
        `SELECT encrypted_token, token_iv
         FROM provider_webhook_challenges
         WHERE provider = 'notion' AND region = ?`,
      ).bind(this.env.AVALON_REGION).first<{
        encrypted_token: string;
        token_iv: string;
      }>();
      if (!winner) {
        throw new ConnectorError(
          "provider_error",
          "The Notion webhook verification token could not be stored",
        );
      }
      const winnerToken = await decryptString(
        winner.encrypted_token,
        winner.token_iv,
        this.env.CONNECTOR_CREDENTIALS_KEY,
        this.notionChallengeAad(),
      );
      if (!timingSafeEqualText(winnerToken, verificationToken)) {
        throw new ConnectorError(
          "unauthorized",
          "Notion webhook verification is already configured and cannot be replaced through the setup endpoint",
        );
      }
      return { accepted: true, duplicate: true, activityCount: 0 };
    }
    return { accepted: true, duplicate: false, activityCount: 0 };
  }

  private async ingestVerified(
    input: VerifiedIngestion,
  ): Promise<ProviderWebhookIngestionResult> {
    const payloadRef = `${this.env.AVALON_REGION}/provider-webhooks/${input.provider}/${input.bodyHash}.json`;
    const priorReceipt = await this.loadReceipt(input.provider, input.deliveryId);
    if (priorReceipt) {
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
      input.includeRecoverableConnections ?? false,
      input.routingAccountIds,
      input.routingUserId,
    );
    if (input.filterConnections) {
      connections = await input.filterConnections(connections);
    }
    if (connections.length === 0) {
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

    const activityIds = normalized.map(() => newId());
    const activityStatements = normalized.map(({ activity }, index) =>
      this.activityInsertStatement(
        activityIds[index]!,
        activity,
        input.provider,
        input.deliveryId,
        payloadRef,
      ));
    const lifecycleStatements = lifecycleUpdates.map((update) =>
      this.lifecycleUpdateStatement(
        input.provider,
        input.deliveryId,
        payloadRef,
        update,
      ));
    const resourceStatements = discoveredResources.map(({ connection, resources }) =>
      this.resourceUpsertStatement(
        connection,
        resources,
        input.provider,
        input.deliveryId,
        input.eventType,
        payloadRef,
      ));
    const results = await this.env.DB.batch([
      receipt,
      ...activityStatements,
      ...lifecycleStatements,
      ...resourceStatements,
    ]);
    const duplicate = resultChanges(results[0]) === 0;
    const insertedActivityIds = activityIds.filter(
      (_id, index) => resultChanges(results[index + 1]) > 0,
    );

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
    return {
      accepted: true,
      duplicate,
      activityCount: duplicate ? 0 : insertedActivityIds.length,
    };
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
        processing_status, metadata_json)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              'pending', ?
       WHERE EXISTS (
         SELECT 1 FROM provider_webhook_receipts
         WHERE provider = ? AND delivery_id = ? AND payload_ref = ?
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
    );
  }

  private resourceUpsertStatement(
    connection: ConnectorConnectionContext,
    resources: GitHubWebhookResourceHint[],
    provider: Provider,
    deliveryId: string,
    eventType: string,
    payloadRef: string,
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
    return this.env.DB.prepare(
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
       WHERE EXISTS (
         SELECT 1 FROM provider_webhook_receipts
         WHERE provider = ? AND delivery_id = ? AND payload_ref = ?
           AND processed_at IS NULL
       )
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
      provider,
      deliveryId,
      payloadRef,
    );
  }

  private lifecycleUpdateStatement(
    provider: Provider,
    deliveryId: string,
    payloadRef: string,
    update: LifecycleUpdate,
  ): D1PreparedStatement {
    return this.env.DB.prepare(
      `UPDATE connector_connections
       SET status = ?, error_json = ?, updated_at = ?
       WHERE id = ? AND connector_type = ?
         AND EXISTS (
           SELECT 1 FROM provider_webhook_receipts
           WHERE provider = ? AND delivery_id = ? AND payload_ref = ?
             AND processed_at IS NULL
         )`,
    ).bind(
      update.status,
      update.error === null ? null : JSON.stringify(update.error),
      nowIso(),
      update.connectionId,
      provider,
      provider,
      deliveryId,
      payloadRef,
    );
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
    includeRecoverable: boolean,
    routingAccountIds: string[] | undefined,
    routingUserId: string | undefined,
  ): Promise<ConnectorConnectionContext[]> {
    if (provider === "github" && accountId === null && !routingUserId) return [];
    if (provider === "linear" && accountId === null) return [];
    if (provider === "notion" && (!routingAccountIds || routingAccountIds.length === 0)) {
      return [];
    }
    const statusClause = includeRecoverable
      ? "status IN ('healthy', 'error', 'needs_reconnect')"
      : "status = 'healthy'";
    const query = provider === "notion"
      ? `SELECT * FROM connector_connections
         WHERE connector_type = 'notion' AND scope = 'personal'
           AND provider_account_id IN (${routingAccountIds!.map(() => "?").join(", ")})
           AND ${statusClause}`
      : provider === "github" && accountId === null
        ? `SELECT * FROM connector_connections
           WHERE connector_type = 'github' AND scope = 'personal'
             AND CAST(json_extract(config_json, '$.githubUserId') AS TEXT) = ?
             AND ${statusClause}`
      : `SELECT * FROM connector_connections
         WHERE connector_type = ? AND provider_account_id = ?
           ${provider === "linear" ? "AND scope = 'workspace'" : ""}
           AND ${statusClause}`;
    const statement = this.env.DB.prepare(query);
    const rows = provider === "notion"
      ? await statement.bind(...routingAccountIds!).all<StoredProviderConnection>()
      : provider === "github" && accountId === null
        ? await statement.bind(routingUserId!).all<StoredProviderConnection>()
      : await statement.bind(provider, accountId).all<StoredProviderConnection>();
    return Promise.all((rows.results ?? []).map((row) => this.connectionContext(row)));
  }

  private async connectionContext(
    row: StoredProviderConnection,
  ): Promise<ConnectorConnectionContext> {
    let credentials: Record<string, unknown> = {};
    if (row.encrypted_credentials && row.credential_iv) {
      credentials = parseRecord(await decryptString(
        row.encrypted_credentials,
        row.credential_iv,
        this.env.CONNECTOR_CREDENTIALS_KEY,
        row.id,
      ));
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
      const before = JSON.stringify(connection.credentials);
      try {
        const hasAccess = await canGitHubPersonalConnectionAccessRepository(
          config,
          connection,
          repositoryFullName,
          AbortSignal.timeout(15_000),
        );
        if (JSON.stringify(connection.credentials) !== before) {
          await this.persistConnectionCredentials(connection);
        }
        if (hasAccess) accepted.push(connection);
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "unauthorized") throw error;
        await this.env.DB.prepare(
          `UPDATE connector_connections
           SET status = 'needs_reconnect', error_json = ?, updated_at = ?
           WHERE id = ? AND connector_type = 'github' AND status = 'healthy'`,
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

  private async persistConnectionCredentials(
    connection: ConnectorConnectionContext,
  ): Promise<void> {
    const encrypted = await encryptString(
      JSON.stringify(connection.credentials),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      connection.id,
    );
    await this.env.DB.prepare(
      `UPDATE connector_connections
       SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
           updated_at = ?
       WHERE id = ? AND status = 'healthy'`,
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

  private exactRawBody(rawBody: ProviderWebhookRawBody): ExactRawBody {
    const maxBytes = this.maxBytes();
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

  private notionChallengeAad(): string {
    return `${NOTION_CHALLENGE_AAD_PREFIX}:${this.env.AVALON_REGION}`;
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
      status: "error",
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
  if (verified.eventName === "PermissionChange" && action === "update") {
    return {
      status: "needs_reconnect",
      error: {
        code: "linear_permissions_changed",
        message: "Review and reconnect this Linear organization's permissions",
        reconnectRequired: true,
      },
    };
  }
  return null;
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
};
