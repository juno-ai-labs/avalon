import {
  ConnectorError,
  verifyGitHubWebhook,
  type GitHubWebhookDelivery,
} from "@avalon/connectors";
import type { Region } from "@avalon/contracts";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { githubRegionFromInstallState } from "../lib/github-install-state";
import { logWarn } from "../observability/logger";
import {
  ConnectionService,
  type GitHubSetupResult,
} from "./connection-service";
import {
  ProviderWebhookService,
  type ProviderWebhookIngestionResult,
} from "./provider-webhook-service";

export const DEFAULT_GITHUB_INGRESS_BASE_URL = "https://github.rallywith.ai";

export interface GitHubRegionalWebhookInput {
  rawBody: ArrayBuffer;
  headers: Record<string, string>;
}

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
  ingestGitHub(input: GitHubRegionalWebhookInput): Promise<GitHubRegionalRpcResult<ProviderWebhookIngestionResult>>;
}

type GitHubRegionalErrorStatus = ApiError["status"];

export type GitHubRegionalRpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { status: GitHubRegionalErrorStatus; code: string; message: string };
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
      return {
        ok: false,
        error: {
          status: connectorErrorStatus(error),
          code: error.code,
          message: error.message,
        },
      };
    }
    throw error;
  }
}

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
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ) => Promise<ProviderWebhookIngestionResult>;
}

interface PendingDeliveryRow {
  delivery_id: string;
  installation_id: string;
  event_type: string;
  action: string | null;
  signature_header: string;
  payload_ref: string;
}

interface ExpiredPendingDeliveryRow {
  delivery_id: string;
  payload_ref: string;
}

/**
 * Coordinates the one public GitHub App without moving canonical connector
 * state out of its workspace region. This service is used only by the Global
 * `github.rallywith.ai` ingress.
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
    this.ingestInRegion = options.ingestInRegion ?? ((region, rawBody, headers) =>
      this.defaultIngestInRegion(region, rawBody, headers));
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
    await this.replayPendingBestEffort(installationId);
    await this.cleanupExpiredPending();
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

  async ingestGitHub(
    rawBody: Uint8Array | ArrayBuffer,
    inputHeaders: Headers | HeadersInit,
  ): Promise<ProviderWebhookIngestionResult> {
    this.assertGlobalIngress();
    const bytes = copyBytes(rawBody);
    const headers = relevantGitHubHeaders(inputHeaders);
    const delivery = await this.verifyIngress(bytes, headers);
    await this.cleanupExpiredPending();

    if (delivery.event === "ping") {
      return { accepted: true, duplicate: false, activityCount: 0 };
    }
    if (delivery.event === "github_app_authorization" && delivery.installationId === null) {
      // User authorization revocation is user-scoped rather than installation-
      // scoped. Each regional data plane must match the sender against its own
      // encrypted personal connections.
      return this.dispatch(bytes, headers, delivery, ["global", "eu"]);
    }
    if (delivery.installationId === null) {
      throw new ConnectorError(
        "provider_error",
        "The GitHub delivery cannot be routed without an installation identity",
      );
    }

    await this.replayPendingBestEffort(delivery.installationId);
    const regions = await this.activeRegions(delivery.installationId);
    if (regions.length === 0) {
      // The Global control plane may route opaque bytes, but it must never
      // retain workspace content before a regional route exists.
      throw new ApiError(503, "github_route_pending", "The GitHub installation route is not ready; retry this delivery");
    }

    const result = await this.dispatch(bytes, headers, delivery, regions);
    if (isInstallationDeleted(delivery)) {
      await this.disableInstallationRoutes(delivery.installationId);
    }
    return result;
  }

  private async defaultSetupInRegion(
    region: Region,
    installationId: string,
    state: string,
  ): Promise<GitHubSetupResult> {
    if (region === this.env.AVALON_REGION) {
      return new ConnectionService(this.env).setupGitHub(installationId, state);
    }
    if (region === "eu" && this.env.AVALON_REGION === "global" && this.env.EU_GITHUB_BRIDGE) {
      return unwrapRegionalResult(
        await this.env.EU_GITHUB_BRIDGE.setupGitHub({ installationId, state }),
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
    if (region === "eu" && this.env.AVALON_REGION === "global" && this.env.EU_GITHUB_BRIDGE) {
      return unwrapRegionalResult(
        await this.env.EU_GITHUB_BRIDGE.failGitHubSetup({ state, errorCode }),
      );
    }
    throw new ApiError(503, "github_region_unavailable", `The ${region} GitHub connector service is unavailable`);
  }

  private async defaultIngestInRegion(
    region: Region,
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ): Promise<ProviderWebhookIngestionResult> {
    if (region === this.env.AVALON_REGION) {
      return new ProviderWebhookService(this.env).ingestGitHub(rawBody, headers);
    }
    if (region === "eu" && this.env.AVALON_REGION === "global" && this.env.EU_GITHUB_BRIDGE) {
      return unwrapRegionalResult(await this.env.EU_GITHUB_BRIDGE.ingestGitHub({
          rawBody: exactArrayBuffer(rawBody),
          headers,
        }));
    }
    throw new ApiError(503, "github_region_unavailable", `The ${region} GitHub webhook service is unavailable`);
  }

  private async dispatch(
    rawBody: Uint8Array,
    headers: Record<string, string>,
    delivery: GitHubWebhookDelivery,
    regions: Region[],
  ): Promise<ProviderWebhookIngestionResult> {
    const results = await Promise.all(
      regions.map((region) => this.ingestInRegion(region, rawBody, headers)),
    );
    await this.markPendingDispatched(delivery.deliveryId);
    return {
      accepted: true,
      duplicate: results.length > 0 && results.every((result) => result.duplicate),
      activityCount: results.reduce((total, result) => total + result.activityCount, 0),
    };
  }

  private async activeRegions(installationId: string): Promise<Region[]> {
    const result = await this.env.DB.prepare(
      `SELECT DISTINCT region FROM github_installation_routes
       WHERE installation_id = ? AND status = 'active'
       ORDER BY region`,
    ).bind(installationId).all<{ region: Region }>();
    return (result.results ?? []).map((row) => row.region);
  }

  private async replayPending(installationId: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    const pending = await this.env.DB.prepare(
      `SELECT delivery_id, installation_id, event_type, action, signature_header, payload_ref
       FROM github_ingress_pending_deliveries
       WHERE installation_id = ? AND dispatched_at IS NULL AND expires_at > ?
       ORDER BY received_at`,
    ).bind(installationId, at).all<PendingDeliveryRow>();
    if (!pending.results?.length) return;

    const regions = await this.activeRegions(installationId);
    for (const row of pending.results) {
      const object = await this.env.PAYLOADS.get(row.payload_ref);
      if (!object) continue;
      const rawBody = new Uint8Array(await object.arrayBuffer());
      const headers = {
        "x-github-delivery": row.delivery_id,
        "x-github-event": row.event_type,
        "x-hub-signature-256": row.signature_header,
      };
      const delivery = await this.verifyIngress(rawBody, headers);
      await this.dispatch(rawBody, headers, delivery, regions);
      if (isInstallationDeleted(delivery)) {
        await this.disableInstallationRoutes(installationId);
      }
      await this.deletePendingPayloadBestEffort(row.payload_ref);
    }
  }

  private async markPendingDispatched(deliveryId: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE github_ingress_pending_deliveries
       SET dispatched_at = COALESCE(dispatched_at, ?)
       WHERE delivery_id = ?`,
    ).bind(new Date(this.now()).toISOString(), deliveryId).run();
  }

  private async cleanupExpiredPending(limit = 25): Promise<void> {
    try {
      const expired = await this.env.DB.prepare(
        `SELECT delivery_id, payload_ref FROM github_ingress_pending_deliveries
         WHERE expires_at <= ?
         ORDER BY expires_at
         LIMIT ?`,
      ).bind(new Date(this.now()).toISOString(), limit).all<ExpiredPendingDeliveryRow>();
      for (const row of expired.results ?? []) {
        if (!await this.deletePendingPayloadBestEffort(row.payload_ref)) continue;
        await this.env.DB.prepare(
          `DELETE FROM github_ingress_pending_deliveries
           WHERE delivery_id = ? AND expires_at <= ?`,
        ).bind(row.delivery_id, new Date(this.now()).toISOString()).run();
      }
    } catch (error) {
      logWarn(this.env, "github_pending_delivery_cleanup_failed", {
        reason: error instanceof Error ? error.message : "unknown cleanup error",
      });
    }
  }

  private async replayPendingBestEffort(installationId: string): Promise<void> {
    try {
      await this.replayPending(installationId);
    } catch (error) {
      logWarn(this.env, "github_pending_delivery_replay_failed", {
        installation_id: installationId,
        reason: error instanceof Error ? error.message : "unknown replay error",
      });
    }
  }

  private async deletePendingPayloadBestEffort(payloadRef: string): Promise<boolean> {
    try {
      await this.env.PAYLOADS.delete(payloadRef);
      return true;
    } catch (error) {
      logWarn(this.env, "github_pending_payload_cleanup_failed", {
        reason: error instanceof Error ? error.message : "unknown R2 cleanup error",
      });
      return false;
    }
  }

  private async disableInstallationRoutes(installationId: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    await this.env.DB.prepare(
      `UPDATE github_installation_routes
       SET status = 'disabled', updated_at = ?, disabled_at = ?
       WHERE installation_id = ? AND status = 'active'`,
    ).bind(at, at, installationId).run();
  }

  private async verifyIngress(
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ): Promise<GitHubWebhookDelivery> {
    const maxBytes = 25 * 1024 * 1024;
    if (rawBody.byteLength > maxBytes) {
      throw new ConnectorError("payload_too_large", "The GitHub webhook exceeded the configured size limit");
    }
    const secret = this.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new ConnectorError("invalid_configuration", "GitHub webhook signing secret is not configured");
    }
    await verifyExactGitHubHmac(secret, rawBody, headers["x-hub-signature-256"] ?? null);

    let rawText: string;
    try {
      rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    } catch (error) {
      throw new ConnectorError("provider_error", "The GitHub webhook body is not valid UTF-8", error);
    }
    // This shared parser also performs a second signature check before JSON
    // parsing. The first check above is over the untouched byte array.
    return verifyGitHubWebhook({
      secret,
      rawBody: rawText,
      signatureHeader: headers["x-hub-signature-256"] ?? null,
      eventHeader: headers["x-github-event"] ?? null,
      deliveryHeader: headers["x-github-delivery"] ?? null,
      receivedAt: new Date(this.now()).toISOString(),
      maxBytes,
    });
  }

  private assertGlobalIngress(): void {
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(503, "github_ingress_misconfigured", "The shared GitHub ingress must run in the Global control plane");
    }
  }
}

function validateGitHubRouteStatus(input: GitHubRouteStatusInput): void {
  if (!/^\d{1,32}$/u.test(input.installationId)
    || !["global", "eu"].includes(input.region)
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
