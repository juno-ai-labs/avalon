import { regionalBindings } from "../lib/regional-bindings";
import { isConfiguredRegion, configuredRegions } from "@rally/contracts/regions";
import {
  ConnectorError,
  connectorRetryAfterMs,
  isDiscardedGitHubDelivery,
  parseGitHubWebhook,
  type GitHubWebhookDelivery,
} from "@rally/connectors";
import type { Region } from "@rally/contracts";
import { z } from "zod";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { githubRegionFromInstallState } from "../lib/github-install-state";
import {
  GitHubDeliveryIdentitySchema,
  type GitHubVerifiedDeliveryInput,
} from "../lib/rpc-contracts";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import {
  ConnectionService,
  type GitHubSetupResult,
} from "./connection-service";
import {
  GITHUB_WEBHOOK_MAX_BYTES,
  ProviderWebhookService,
  type ProviderWebhookIngestionResult,
} from "./provider-webhook-service";
import { MAX_CONNECTOR_EVENT_QUEUE_BYTES } from "./workspace-connector-event-ingress";

export const DEFAULT_GITHUB_INGRESS_BASE_URL = "https://github.rallywith.ai";

export interface GitHubRegionalSetupInput {
  installationId: string;
  state: string;
}

export interface GitHubRegionalSetupFailureInput {
  state: string;
  errorCode: string;
}

export interface GitHubRouteStatusInput {
  installationId: string;
  region: Region;
  workspaceId: string;
  status: "active" | "disabled";
}

export interface GlobalGitHubRouterRpcBinding {
  setGitHubRouteStatus(input: GitHubRouteStatusInput): Promise<GitHubRegionalRpcResult<{ updated: true }>>;
}

export interface GitHubRegionalBridgeRpcBinding {
  setupGitHub(input: GitHubRegionalSetupInput): Promise<GitHubRegionalRpcResult<GitHubSetupResult>>;
  failGitHubSetup(input: GitHubRegionalSetupFailureInput): Promise<GitHubRegionalRpcResult<string>>;
  ingestVerifiedGitHub(
    input: GitHubVerifiedDeliveryInput,
  ): Promise<GitHubRegionalRpcResult<ProviderWebhookIngestionResult>>;
}

type GitHubRegionalErrorStatus = ApiError["status"];

export type GitHubRegionalRpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        status: GitHubRegionalErrorStatus;
        code: string;
        message: string;
        /** A provider's Retry-After, carried so the Global consumer can honour it. */
        retryAfterMs?: number;
      };
    };

export async function serializeGitHubRegionalRpcResult<T>(
  operation: () => Promise<T>,
): Promise<GitHubRegionalRpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ok: false,
        error: { status: error.status, code: error.code, message: error.message },
      };
    }
    if (error instanceof ConnectorError) {
      const retryAfterMs = connectorRetryAfterMs(error);
      return {
        ok: false,
        error: {
          status: connectorErrorStatus(error),
          code: error.code,
          message: error.message,
          ...(retryAfterMs === null ? {} : { retryAfterMs }),
        },
      };
    }
    throw error;
  }
}

const GITHUB_DELIVERY_QUEUE_KIND = "github_webhook_delivery_v1";

/**
 * One verified GitHub delivery on its way from the Global receiver to the
 * consumer that routes it. It rides the Global `ACTIVITY_QUEUE`, the queue
 * connector ingest already uses.
 *
 * The body travels inline when it fits the Queue's 128 KB message limit and is
 * staged in `PAYLOADS` otherwise: GitHub sends payloads of up to 25 MB. The
 * staged key names the delivery and its content, so a GitHub redelivery of the
 * same delivery writes the same object rather than a second one.
 *
 * There is no signature on it. The receiver verified the bytes before sending
 * this, and nothing after the receiver verifies them again.
 */
export const GitHubDeliveryQueueMessageSchema = z.strictObject({
  kind: z.literal(GITHUB_DELIVERY_QUEUE_KIND),
  ...GitHubDeliveryIdentitySchema.shape,
  body: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("inline"),
      bytes: z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer, { message: "must be an ArrayBuffer" }),
    }),
    z.strictObject({
      kind: z.literal("staged"),
      payloadRef: z.string().min(1).max(1_024),
    }),
  ]),
});

export type GitHubDeliveryQueueMessage = z.infer<typeof GitHubDeliveryQueueMessageSchema>;

const GitHubDeliveryQueueKindSchema = z.object({ kind: z.literal(GITHUB_DELIVERY_QUEUE_KIND) });

/** True for a message the GitHub delivery consumer owns, well-formed or not. */
export function isGitHubDeliveryQueueMessage(body: unknown): boolean {
  return GitHubDeliveryQueueKindSchema.safeParse(body).success;
}

/** What the consumer did with one delivery; the log names it. */
export type GitHubDeliveryOutcome = "dispatched" | "unrouted" | "already_processed";

interface GitHubRoutingServiceOptions {
  now?: () => number;
  setupInRegion?: (
    region: Region,
    installationId: string,
    state: string,
  ) => Promise<GitHubSetupResult>;
  failSetupInRegion?: (
    region: Region,
    state: string,
    errorCode: string,
  ) => Promise<string>;
  ingestInRegion?: (
    region: Region,
    delivery: GitHubVerifiedDeliveryInput,
  ) => Promise<ProviderWebhookIngestionResult>;
}

/**
 * Coordinates the one public GitHub App without moving canonical connector
 * state out of its workspace region. This service is used only by the Global
 * `github.rallywith.ai` ingress.
 *
 * A delivery takes two steps. {@link ingestGitHub} runs while GitHub waits: it
 * verifies the signature, drops what is discarded, and enqueues the rest.
 * {@link consumeDelivery} runs from the Queue: it finds the installation's
 * regions and hands each one the verified bytes.
 */
export class GitHubRoutingService {
  private readonly now: () => number;
  private readonly setupInRegion: NonNullable<GitHubRoutingServiceOptions["setupInRegion"]>;
  private readonly failSetupInRegion: NonNullable<GitHubRoutingServiceOptions["failSetupInRegion"]>;
  private readonly ingestInRegion: NonNullable<GitHubRoutingServiceOptions["ingestInRegion"]>;

  constructor(
    private readonly env: Env,
    options: GitHubRoutingServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setupInRegion = options.setupInRegion ?? ((region, installationId, state) =>
      this.defaultSetupInRegion(region, installationId, state));
    this.failSetupInRegion = options.failSetupInRegion ?? ((region, state, errorCode) =>
      this.defaultFailSetupInRegion(region, state, errorCode));
    this.ingestInRegion = options.ingestInRegion ?? ((region, delivery) =>
      this.defaultIngestInRegion(region, delivery));
  }

  async setupGitHub(installationId: string, state: string): Promise<string> {
    this.assertGlobalIngress();
    const region = githubRegionFromInstallState(state);
    const setup = await this.setupInRegion(region, installationId, state);
    const at = new Date(this.now()).toISOString();
    await this.env.DB.prepare(
      `INSERT INTO github_installation_routes
       (installation_id, region, workspace_id, status, created_at, updated_at, disabled_at)
       VALUES (?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(installation_id, region, workspace_id) DO UPDATE SET
         status = 'active', updated_at = excluded.updated_at, disabled_at = NULL`,
    ).bind(installationId, region, setup.workspaceId, at, at).run();
    return setup.url;
  }

  async failGitHubSetup(state: string, errorCode: string): Promise<string> {
    this.assertGlobalIngress();
    const region = githubRegionFromInstallState(state);
    return this.failSetupInRegion(region, state, errorCode);
  }

  async setInstallationRouteStatus(input: GitHubRouteStatusInput): Promise<void> {
    validateGitHubRouteStatus(input);
    if (this.env.AVALON_REGION === "global") {
      await this.setStatusInGlobal(input);
      return;
    }
    if (!this.env.GLOBAL_GITHUB_ROUTER) {
      throw new ApiError(503, "github_router_unavailable", "The shared GitHub router is unavailable");
    }
    unwrapRegionalResult(await this.env.GLOBAL_GITHUB_ROUTER.setGitHubRouteStatus(input));
  }

  async setStatusInGlobal(input: GitHubRouteStatusInput): Promise<{ updated: true }> {
    this.assertGlobalIngress();
    validateGitHubRouteStatus(input);
    const at = new Date(this.now()).toISOString();
    const result = await this.env.DB.prepare(
      `UPDATE github_installation_routes
       SET status = ?, updated_at = ?, disabled_at = ?
       WHERE installation_id = ? AND region = ? AND workspace_id = ?`,
    ).bind(
      input.status,
      at,
      input.status === "disabled" ? at : null,
      input.installationId,
      input.region,
      input.workspaceId,
    ).run();
    if (Number(result.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, "github_route_not_found", "The GitHub installation route could not be updated");
    }
    return { updated: true };
  }

  /**
   * The part of a delivery GitHub waits for: verify the signature once over
   * the exact bytes, drop what is discarded, enqueue the rest, and answer.
   * Nothing here reads D1 or calls GitHub; the routing and every regional
   * write happen in {@link consumeDelivery}.
   */
  async ingestGitHub(
    rawBody: Uint8Array | ArrayBuffer,
    inputHeaders: Headers | HeadersInit,
  ): Promise<ProviderWebhookIngestionResult> {
    this.assertGlobalIngress();
    const bytes = copyBytes(rawBody);
    const headers = relevantGitHubHeaders(inputHeaders);
    const delivery = await this.verifyIngress(bytes, headers);

    if (delivery.event === "ping" || isDiscardedGitHubDelivery(delivery)) {
      return { accepted: true, duplicate: false, activityCount: 0 };
    }
    if (delivery.installationId === null && delivery.event !== "github_app_authorization") {
      throw new ConnectorError(
        "provider_error",
        "The GitHub delivery cannot be routed without an installation identity",
      );
    }

    await this.enqueueDelivery(bytes, delivery);
    return { accepted: true, duplicate: false, activityCount: 0 };
  }

  /**
   * Routes one verified delivery from the Queue: find the regions the
   * installation is connected in, hand each the verified bytes, and disable
   * the routes when the installation was deleted.
   *
   * Idempotent on the delivery id. A redelivery — from the Queue, or GitHub
   * sending the same delivery again — reaches each region's
   * `provider_webhook_receipts` row for that id and is answered as a duplicate
   * there. A throw is the consumer's cue to retry the message, and after
   * `max_retries` the dead-letter queue has it.
   */
  async consumeDelivery(message: GitHubDeliveryQueueMessage): Promise<GitHubDeliveryOutcome> {
    this.assertGlobalIngress();
    const rawBody = await this.loadBody(message);
    if (rawBody === null) {
      // Staged bodies are deleted only after every region has taken the
      // delivery, so a missing one is a sibling copy of this delivery that
      // already finished.
      return "already_processed";
    }
    const delivery = await parseGitHubWebhook({
      rawBody: decodeUtf8(new Uint8Array(rawBody)),
      eventHeader: message.event,
      deliveryHeader: message.deliveryId,
      receivedAt: message.receivedAt,
    });
    const verified: GitHubVerifiedDeliveryInput = {
      rawBody,
      deliveryId: message.deliveryId,
      event: message.event,
      receivedAt: message.receivedAt,
    };

    let regions: Region[];
    if (delivery.installationId === null) {
      // User authorization revocation is user-scoped rather than
      // installation-scoped. Each regional data plane matches the sender
      // against its own encrypted personal connections.
      regions = [...configuredRegions];
    } else {
      regions = await this.activeRegions(delivery.installationId);
    }
    if (regions.length === 0) {
      // No region has connected this installation, so there is nothing to
      // hand it to — the Global counterpart of a region matching no
      // connection. `installation.created` lands here whenever it beats the
      // setup redirect, which is every new installation, so this is not a
      // failure and is not retried into the dead-letter queue.
      await this.deleteStagedBody(message);
      return "unrouted";
    }

    await Promise.all(regions.map((region) => this.ingestInRegion(region, verified)));
    if (delivery.installationId !== null && isInstallationDeleted(delivery)) {
      await this.disableInstallationRoutes(delivery.installationId);
    }
    await this.deleteStagedBody(message);
    return "dispatched";
  }

  private async enqueueDelivery(bytes: Uint8Array, delivery: GitHubWebhookDelivery): Promise<void> {
    const body: GitHubDeliveryQueueMessage["body"] = bytes.byteLength <= MAX_CONNECTOR_EVENT_QUEUE_BYTES
      ? { kind: "inline", bytes: exactArrayBuffer(bytes) }
      : { kind: "staged", payloadRef: stagedPayloadRef(this.env.AVALON_REGION, delivery) };
    if (body.kind === "staged") {
      await this.env.PAYLOADS.put(body.payloadRef, exactArrayBuffer(bytes), {
        httpMetadata: { contentType: "application/json" },
      });
    }
    const message: GitHubDeliveryQueueMessage = {
      kind: GITHUB_DELIVERY_QUEUE_KIND,
      deliveryId: delivery.deliveryId,
      event: delivery.event,
      receivedAt: delivery.receivedAt,
      body,
    };
    try {
      // `v8`, not the Queue's default `json`: JSON turns the inline body's
      // ArrayBuffer into `{}`, and the consumer rejects every such message.
      await this.env.ACTIVITY_QUEUE.send(GitHubDeliveryQueueMessageSchema.parse(message), { contentType: "v8" });
    } catch (error) {
      // GitHub is answered with a failure and nothing will consume this
      // message, so a staged body would otherwise sit in Global's bucket.
      await this.deleteStagedBody(message);
      throw error;
    }
  }

  private async loadBody(message: GitHubDeliveryQueueMessage): Promise<ArrayBuffer | null> {
    if (message.body.kind === "inline") return message.body.bytes;
    const object = await this.env.PAYLOADS.get(message.body.payloadRef);
    return object ? object.arrayBuffer() : null;
  }

  private async deleteStagedBody(message: GitHubDeliveryQueueMessage): Promise<void> {
    if (message.body.kind !== "staged") return;
    try {
      await this.env.PAYLOADS.delete(message.body.payloadRef);
    } catch (error) {
      // The delivery is done; an object left behind costs storage, not
      // correctness, and retrying the message would re-run every region.
      logWarn(this.env, "github_delivery_staged_body_cleanup_failed", {
        delivery_id: message.deliveryId,
        error_code: diagnosticErrorCode(error, "github_delivery_staged_body_cleanup_failed"),
      });
    }
  }

  private async defaultSetupInRegion(
    region: Region,
    installationId: string,
    state: string,
  ): Promise<GitHubSetupResult> {
    if (region === this.env.AVALON_REGION) {
      return new ConnectionService(this.env).setupGitHub(installationId, state);
    }
    const bridge = regionalBindings(this.env, region).github;
    if (this.env.AVALON_REGION === "global" && bridge) {
      return unwrapRegionalResult(
        await bridge.setupGitHub({ installationId, state }),
      );
    }
    throw new ApiError(503, "github_region_unavailable", `The ${region} GitHub connector service is unavailable`);
  }

  private async defaultFailSetupInRegion(
    region: Region,
    state: string,
    errorCode: string,
  ): Promise<string> {
    if (region === this.env.AVALON_REGION) {
      return new ConnectionService(this.env).failProviderAttempt("github", state, errorCode);
    }
    const bridge = regionalBindings(this.env, region).github;
    if (this.env.AVALON_REGION === "global" && bridge) {
      return unwrapRegionalResult(
        await bridge.failGitHubSetup({ state, errorCode }),
      );
    }
    throw new ApiError(503, "github_region_unavailable", `The ${region} GitHub connector service is unavailable`);
  }

  private async defaultIngestInRegion(
    region: Region,
    delivery: GitHubVerifiedDeliveryInput,
  ): Promise<ProviderWebhookIngestionResult> {
    if (region === this.env.AVALON_REGION) {
      return new ProviderWebhookService(this.env).ingestVerifiedGitHub(delivery);
    }
    const bridge = regionalBindings(this.env, region).github;
    if (this.env.AVALON_REGION === "global" && bridge) {
      return unwrapRegionalResult(await bridge.ingestVerifiedGitHub(delivery));
    }
    throw new ApiError(503, "github_region_unavailable", `The ${region} GitHub webhook service is unavailable`);
  }

  private async activeRegions(installationId: string): Promise<Region[]> {
    const result = await this.env.DB.prepare(
      `SELECT DISTINCT region FROM github_installation_routes
       WHERE installation_id = ? AND status = 'active'
       ORDER BY region`,
    ).bind(installationId).all<{ region: Region }>();
    return (result.results ?? []).map((row) => row.region);
  }

  private async disableInstallationRoutes(installationId: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    await this.env.DB.prepare(
      `UPDATE github_installation_routes
       SET status = 'disabled', updated_at = ?, disabled_at = ?
       WHERE installation_id = ? AND status = 'active'`,
    ).bind(at, at, installationId).run();
  }

  /**
   * The one signature check a delivery gets: an HMAC over the exact request
   * bytes, before anything is parsed. The parse that follows does not check
   * it again, and neither does anything downstream.
   */
  private async verifyIngress(
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ): Promise<GitHubWebhookDelivery> {
    if (rawBody.byteLength > GITHUB_WEBHOOK_MAX_BYTES) {
      throw new ConnectorError("payload_too_large", "The GitHub webhook exceeded the configured size limit");
    }
    const secret = this.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new ConnectorError("invalid_configuration", "GitHub webhook signing secret is not configured");
    }
    await verifyExactGitHubHmac(secret, rawBody, headers["x-hub-signature-256"] ?? null);
    return parseGitHubWebhook({
      rawBody: decodeUtf8(rawBody),
      eventHeader: headers["x-github-event"] ?? null,
      deliveryHeader: headers["x-github-delivery"] ?? null,
      receivedAt: new Date(this.now()).toISOString(),
    });
  }

  private assertGlobalIngress(): void {
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(503, "github_ingress_misconfigured", "The shared GitHub ingress must run in the Global control plane");
    }
  }
}

/**
 * The Queue side of the Global GitHub receiver: parse, route, then ack or
 * retry. A malformed message throws before anything is routed, and its code
 * names the field.
 */
export async function consumeGitHubDeliveryMessage(
  message: Message<unknown>,
  env: Env,
  service: GitHubRoutingService = new GitHubRoutingService(env),
): Promise<void> {
  const parsed = GitHubDeliveryQueueMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    logWarn(env, "github_delivery_message_invalid", {
      queue_attempts: message.attempts,
      error_code: diagnosticErrorCode(parsed.error, "github_delivery_message"),
    });
    message.retry({ delaySeconds: githubDeliveryRetryDelaySeconds(message.attempts) });
    return;
  }
  try {
    const outcome = await service.consumeDelivery(parsed.data);
    logInfo(env, "github_delivery_consumed", {
      delivery_id: parsed.data.deliveryId,
      event_type: parsed.data.event,
      outcome,
      queue_attempts: message.attempts,
    });
    message.ack();
  } catch (error) {
    logWarn(env, "github_delivery_retry", {
      delivery_id: parsed.data.deliveryId,
      event_type: parsed.data.event,
      queue_attempts: message.attempts,
      error_code: error instanceof ConnectorError
        ? error.code
        : diagnosticErrorCode(error, "github_delivery_failed"),
    });
    message.retry({ delaySeconds: githubDeliveryRetryDelaySeconds(message.attempts, error) });
  }
}

/**
 * The backoff every lane of the activity consumer uses
 * (`queues/activity-consumer.ts`), with a GitHub rate limit's Retry-After
 * honoured the way its Slack ingress lane honours a provider's. The outer
 * bound is the Queue's own ceiling on a retry delay.
 */
function githubDeliveryRetryDelaySeconds(queueAttempts: number, error?: unknown): number {
  const attempts = Math.max(1, queueAttempts);
  const exponentialDelay = Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6));
  const providerDelay = Math.ceil((connectorRetryAfterMs(error) ?? 0) / 1_000);
  return Math.min(43_200, Math.max(exponentialDelay, providerDelay));
}

function stagedPayloadRef(region: string, delivery: GitHubWebhookDelivery): string {
  return `${region}/github-ingress/${delivery.deliveryId}/${delivery.rawContentHash}.json`;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ConnectorError("provider_error", "The GitHub webhook body is not valid UTF-8", error);
  }
}

function validateGitHubRouteStatus(input: GitHubRouteStatusInput): void {
  if (!/^\d{1,32}$/u.test(input.installationId)
    || !isConfiguredRegion(input.region)
    || !input.workspaceId) {
    throw new ApiError(422, "invalid_github_route", "The GitHub installation route is invalid");
  }
}

export function isSharedGitHubIngress(env: Env, requestUrl: string | URL): boolean {
  const configured = new URL(env.GITHUB_INGRESS_BASE_URL || DEFAULT_GITHUB_INGRESS_BASE_URL);
  const request = new URL(requestUrl);
  return request.hostname.toLowerCase() === configured.hostname.toLowerCase();
}

export function isAllowedGitHubIngressRoute(method: string, pathname: string): boolean {
  return (method === "GET" && pathname === "/connections/github/setup")
    || (method === "GET" && (pathname === "/health" || pathname === "/health/"))
    || (method === "POST" && pathname === "/ingest/github");
}

function relevantGitHubHeaders(input: Headers | HeadersInit): Record<string, string> {
  const headers = new Headers(input);
  return {
    "x-github-delivery": headers.get("x-github-delivery") ?? "",
    "x-github-event": headers.get("x-github-event") ?? "",
    "x-hub-signature-256": headers.get("x-hub-signature-256") ?? "",
  };
}

async function verifyExactGitHubHmac(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | null,
): Promise<void> {
  if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/iu.test(signatureHeader)) {
    throw new ConnectorError("invalid_signature", "The GitHub webhook signature is missing or malformed");
  }
  const signature = hexBytes(signatureHeader.slice("sha256=".length));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    exactArrayBuffer(signature),
    exactArrayBuffer(rawBody),
  );
  if (!valid) throw new ConnectorError("invalid_signature", "The GitHub webhook signature is invalid");
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function isInstallationDeleted(delivery: GitHubWebhookDelivery): boolean {
  return delivery.event === "installation" && delivery.action === "deleted";
}

function unwrapRegionalResult<T>(result: GitHubRegionalRpcResult<T>): T {
  if (result.ok) return result.value;
  throw new ApiError(
    result.error.status,
    result.error.code,
    result.error.message,
    result.error.retryAfterMs === undefined ? undefined : { retryAfterMs: result.error.retryAfterMs },
  );
}

function connectorErrorStatus(error: ConnectorError): GitHubRegionalErrorStatus {
  if (error.code === "invalid_configuration") return 503;
  if (error.code === "unauthorized" || error.code === "invalid_signature") return 401;
  if (error.code === "payload_too_large") return 413;
  if (error.code === "provider_error") return 502;
  return 422;
}

export const __githubRoutingTesting = {
  verifyExactGitHubHmac,
  relevantGitHubHeaders,
  isInstallationDeleted,
  exactArrayBuffer,
};
