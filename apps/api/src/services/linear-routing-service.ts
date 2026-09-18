import { regionalBindings } from "../lib/regional-bindings";
import { isConfiguredRegion } from "@rally/contracts/regions";
import {
  ConnectorError,
  verifyLinearWebhook,
} from "@rally/connectors";
import type { Region } from "@rally/contracts";
import type { Env } from "../env";
import { numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import {
  ProviderWebhookService,
  type ProviderWebhookIngestionResult,
} from "./provider-webhook-service";

export const DEFAULT_LINEAR_INGRESS_BASE_URL = "https://linear.rallywith.ai";

export interface LinearRegionalWebhookInput {
  rawBody: ArrayBuffer;
  headers: Record<string, string>;
}

export interface LinearRouteInput {
  organizationId: string;
  region: Region;
  workspaceId: string;
  connectionId: string;
}

export interface LinearRouteStatusInput extends LinearRouteInput {
  status: "active" | "disabled";
}

export type LinearRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { status: ApiError["status"]; code: string; message: string } };

export interface LinearRegionalBridgeRpcBinding {
  ingestLinear(input: LinearRegionalWebhookInput): Promise<LinearRpcResult<ProviderWebhookIngestionResult>>;
}

export interface GlobalLinearRouterRpcBinding {
  registerLinearRoute(input: LinearRouteInput): Promise<LinearRpcResult<{ registered: true }>>;
  setLinearRouteStatus(input: LinearRouteStatusInput): Promise<LinearRpcResult<{ updated: true }>>;
}

export async function serializeLinearRpcResult<T>(operation: () => Promise<T>): Promise<LinearRpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
    }
    if (error instanceof ConnectorError) {
      return {
        ok: false,
        error: { status: connectorErrorStatus(error), code: error.code, message: error.message },
      };
    }
    throw error;
  }
}

interface LinearRoutingServiceOptions {
  now?: () => number;
  ingestInRegion?: (
    region: Region,
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ) => Promise<ProviderWebhookIngestionResult>;
}

/**
 * Control-plane router for Avalon's single public Linear app. Only opaque
 * organization/workspace routing metadata lives in Global; exact signed
 * webhook bytes are forwarded directly to the owning regional data plane.
 */
export class LinearRoutingService {
  private readonly now: () => number;
  private readonly ingestInRegion: NonNullable<LinearRoutingServiceOptions["ingestInRegion"]>;

  constructor(
    private readonly env: Env,
    options: LinearRoutingServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ingestInRegion = options.ingestInRegion ?? ((region, rawBody, headers) =>
      this.defaultIngestInRegion(region, rawBody, headers));
  }

  async registerConnection(input: LinearRouteInput): Promise<void> {
    validateRoute(input);
    if (this.env.AVALON_REGION === "global") {
      await this.registerInGlobal(input);
      return;
    }
    if (!this.env.GLOBAL_LINEAR_ROUTER) {
      throw new ApiError(503, "linear_router_unavailable", "The shared Linear router is unavailable");
    }
    unwrapLinearRpcResult(await this.env.GLOBAL_LINEAR_ROUTER.registerLinearRoute(input));
  }

  async setConnectionStatus(input: LinearRouteStatusInput): Promise<void> {
    validateRoute(input);
    if (this.env.AVALON_REGION === "global") {
      await this.setStatusInGlobal(input);
      return;
    }
    if (!this.env.GLOBAL_LINEAR_ROUTER) {
      throw new ApiError(503, "linear_router_unavailable", "The shared Linear router is unavailable");
    }
    unwrapLinearRpcResult(await this.env.GLOBAL_LINEAR_ROUTER.setLinearRouteStatus(input));
  }

  async registerInGlobal(input: LinearRouteInput): Promise<{ registered: true }> {
    this.assertGlobalControlPlane();
    validateRoute(input);
    const at = new Date(this.now()).toISOString();
    await this.env.DB.prepare(
      `INSERT INTO linear_organization_routes
       (organization_id, region, workspace_id, connection_id, status, created_at, updated_at, disabled_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(organization_id, region, workspace_id, connection_id) DO UPDATE SET
         status = 'active', updated_at = excluded.updated_at, disabled_at = NULL`,
    ).bind(
      input.organizationId,
      input.region,
      input.workspaceId,
      input.connectionId,
      at,
      at,
    ).run();
    return { registered: true };
  }

  async setStatusInGlobal(input: LinearRouteStatusInput): Promise<{ updated: true }> {
    this.assertGlobalControlPlane();
    validateRoute(input);
    const at = new Date(this.now()).toISOString();
    const result = await this.env.DB.prepare(
      `UPDATE linear_organization_routes
       SET status = ?, updated_at = ?, disabled_at = ?
       WHERE organization_id = ? AND region = ? AND workspace_id = ? AND connection_id = ?`,
    ).bind(
      input.status,
      at,
      input.status === "disabled" ? at : null,
      input.organizationId,
      input.region,
      input.workspaceId,
      input.connectionId,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new ApiError(409, "linear_route_not_found", "The Linear connection route could not be updated");
    }
    return { updated: true };
  }

  async ingestLinear(
    rawBody: Uint8Array | ArrayBuffer,
    inputHeaders: Headers | HeadersInit,
  ): Promise<ProviderWebhookIngestionResult> {
    this.assertGlobalControlPlane();
    const bytes = copyBytes(rawBody);
    const headers = relevantLinearHeaders(inputHeaders);
    const verified = await this.verifyIngress(bytes, headers);
    const regions = await this.activeRegions(verified.organizationId);
    if (regions.length === 0) {
      // Do not retain possibly regional-resident payloads in Global. A non-200 asks
      // Linear to retry after the regional OAuth callback records its route.
      throw new ApiError(503, "linear_route_pending", "The Linear organization route is not ready yet");
    }
    const results = await Promise.all(
      regions.map((region) => this.ingestInRegion(region, bytes, headers)),
    );
    return {
      accepted: true,
      duplicate: results.every((result) => result.duplicate),
      activityCount: results.reduce((sum, result) => sum + result.activityCount, 0),
    };
  }

  private async activeRegions(organizationId: string): Promise<Region[]> {
    const result = await this.env.DB.prepare(
      `SELECT DISTINCT region FROM linear_organization_routes
       WHERE organization_id = ? AND status = 'active'
       ORDER BY region`,
    ).bind(organizationId).all<{ region: Region }>();
    return (result.results ?? []).map((row) => row.region);
  }

  private async defaultIngestInRegion(
    region: Region,
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ): Promise<ProviderWebhookIngestionResult> {
    if (region === this.env.AVALON_REGION) {
      return new ProviderWebhookService(this.env).ingestLinear(rawBody, headers);
    }
    const bridge = regionalBindings(this.env, region).linear;
    if (this.env.AVALON_REGION === "global" && bridge) {
      return unwrapLinearRpcResult(await bridge.ingestLinear({
        rawBody: exactArrayBuffer(rawBody),
        headers,
      }));
    }
    throw new ApiError(503, "linear_region_unavailable", `The ${region} Linear connector service is unavailable`);
  }

  private async verifyIngress(rawBody: Uint8Array, headers: Record<string, string>) {
    const maxBytes = numericEnv(this.env, "PROVIDER_WEBHOOK_MAX_BYTES", 2_000_000);
    if (rawBody.byteLength > maxBytes) {
      throw new ConnectorError("payload_too_large", "The Linear webhook exceeded the configured size limit");
    }
    const secret = this.env.LINEAR_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new ConnectorError("invalid_configuration", "Linear webhook signing secret is not configured");
    }
    let rawText: string;
    try {
      rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    } catch (error) {
      throw new ConnectorError("provider_error", "The Linear webhook body is not valid UTF-8", error);
    }
    return verifyLinearWebhook({
      secret,
      rawBody: rawText,
      signatureHeader: headers["linear-signature"] || null,
      deliveryHeader: headers["linear-delivery"] || null,
      eventHeader: headers["linear-event"] || null,
      timestampHeader: headers["linear-timestamp"] || null,
      now: this.now(),
      replayWindowMs: numericEnv(this.env, "WEBHOOK_REPLAY_WINDOW_SECONDS", 60) * 1_000,
      maxBytes,
    });
  }

  private assertGlobalControlPlane(): void {
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(503, "linear_ingress_misconfigured", "The shared Linear ingress must run in the Global control plane");
    }
  }
}

export function isSharedLinearIngress(env: Env, requestUrl: string | URL): boolean {
  const configured = new URL(env.LINEAR_INGRESS_BASE_URL || DEFAULT_LINEAR_INGRESS_BASE_URL);
  const request = new URL(requestUrl);
  return request.hostname.toLowerCase() === configured.hostname.toLowerCase();
}

export function isAllowedLinearIngressRoute(method: string, pathname: string): boolean {
  return (method === "GET" && (pathname === "/health" || pathname === "/health/"))
    || (method === "POST" && pathname === "/ingest/linear");
}

function relevantLinearHeaders(input: Headers | HeadersInit): Record<string, string> {
  const headers = new Headers(input);
  return {
    "linear-delivery": firstHeader(headers, ["linear-delivery", "linear-delivery-id", "x-linear-delivery"]),
    "linear-event": firstHeader(headers, ["linear-event", "x-linear-event"]),
    "linear-signature": firstHeader(headers, ["linear-signature", "x-linear-signature"]),
    "linear-timestamp": firstHeader(headers, ["linear-timestamp", "x-linear-timestamp"]),
  };
}

function firstHeader(headers: Headers, names: string[]): string {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return "";
}

function validateRoute(input: LinearRouteInput): void {
  if (!input.organizationId || input.organizationId.length > 200) {
    throw new ApiError(422, "invalid_linear_organization", "The Linear organization identity is invalid");
  }
  if (!input.workspaceId || !input.connectionId || !isConfiguredRegion(input.region)) {
    throw new ApiError(422, "invalid_linear_route", "The Linear connection route is invalid");
  }
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

function unwrapLinearRpcResult<T>(result: LinearRpcResult<T>): T {
  if (result.ok) return result.value;
  throw new ApiError(result.error.status, result.error.code, result.error.message);
}

function connectorErrorStatus(error: ConnectorError): ApiError["status"] {
  if (error.code === "invalid_configuration") return 503;
  if (error.code === "unauthorized" || error.code === "invalid_signature") return 401;
  if (error.code === "payload_too_large") return 413;
  if (error.code === "provider_error") return 502;
  return 422;
}

export const __linearRoutingTesting = {
  relevantLinearHeaders,
  exactArrayBuffer,
};
