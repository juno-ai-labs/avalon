import { regionalBindings } from "../lib/regional-bindings";
import { isConfiguredRegion, configuredRegions } from "@rally/contracts/regions";
import {
  ConnectorError,
  readNotionWebhookVerificationToken,
  verifyNotionWebhook,
  type VerifiedNotionWebhook,
} from "@rally/connectors";
import type { Region } from "@rally/contracts";
import type { Env } from "../env";
import { numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { regionFromRoutedState } from "../lib/region-routed-state";
import { ConnectionService } from "./connection-service";
import {
  ProviderWebhookService,
  type ProviderWebhookIngestionResult,
} from "./provider-webhook-service";

export interface NotionRegionalWebhookInput {
  rawBody: ArrayBuffer;
  headers: Record<string, string>;
}

export interface NotionCallbackInput {
  code: string;
  state: string;
}

export interface NotionCallbackStateInput {
  state: string;
}

export interface NotionCallbackFailureInput {
  state: string;
  errorCode: string;
}

export interface NotionChallengeInput {
  verificationToken: string;
  setupGeneration: number;
}

export interface NotionRouteInput {
  notionWorkspaceId: string;
  region: Region;
  workspaceId: string;
  connectionId: string;
}

export interface NotionRouteStatusInput extends NotionRouteInput {
  status: "active" | "disabled";
}

export type NotionRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { status: ApiError["status"]; code: string; message: string } };

export interface NotionRegionalBridgeRpcBinding {
  completeNotion(input: NotionCallbackInput): Promise<NotionRpcResult<string>>;
  denyNotion(input: NotionCallbackStateInput): Promise<NotionRpcResult<string>>;
  failNotionAttempt(input: NotionCallbackFailureInput): Promise<NotionRpcResult<string>>;
  ingestNotion(input: NotionRegionalWebhookInput): Promise<NotionRpcResult<ProviderWebhookIngestionResult>>;
  storeNotionChallenge(input: NotionChallengeInput): Promise<NotionRpcResult<{ stored: true }>>;
}

export interface GlobalNotionRouterRpcBinding {
  registerNotionRoute(input: NotionRouteInput): Promise<NotionRpcResult<{ registered: true }>>;
  setNotionRouteStatus(input: NotionRouteStatusInput): Promise<NotionRpcResult<{ updated: true }>>;
}

export async function serializeNotionRpcResult<T>(operation: () => Promise<T>): Promise<NotionRpcResult<T>> {
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

interface NotionRoutingServiceOptions {
  now?: () => number;
  completeInRegion?: (region: Region, code: string, state: string) => Promise<string>;
  denyInRegion?: (region: Region, state: string) => Promise<string>;
  failInRegion?: (region: Region, state: string, errorCode: string) => Promise<string>;
  ingestInRegion?: (
    region: Region,
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ) => Promise<ProviderWebhookIngestionResult>;
  storeChallengeInRegion?: (
    region: Region,
    verificationToken: string,
    setupGeneration: number,
  ) => Promise<void>;
  verificationToken?: () => Promise<string>;
  setupGenerationForToken?: (verificationToken: string) => Promise<number>;
  captureChallenge?: (
    verificationToken: string,
    setupNonce: string | null,
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ) => Promise<ProviderWebhookIngestionResult>;
}

/**
 * Control-plane router for Avalon's single public Notion connection.
 *
 * A Notion connection carries one redirect URI and one webhook subscription for
 * every workspace that installs it, so Global answers both and hands the work to
 * the region that owns the connection. Only the opaque Notion-workspace-to-region
 * directory lives in Global; the authorization code and the exact signed webhook
 * bytes pass through it and are persisted only regionally.
 */
export class NotionRoutingService {
  private readonly now: () => number;
  private readonly completeInRegion: NonNullable<NotionRoutingServiceOptions["completeInRegion"]>;
  private readonly denyInRegion: NonNullable<NotionRoutingServiceOptions["denyInRegion"]>;
  private readonly failInRegion: NonNullable<NotionRoutingServiceOptions["failInRegion"]>;
  private readonly ingestInRegion: NonNullable<NotionRoutingServiceOptions["ingestInRegion"]>;
  private readonly storeChallengeInRegion: NonNullable<NotionRoutingServiceOptions["storeChallengeInRegion"]>;
  private readonly verificationToken: NonNullable<NotionRoutingServiceOptions["verificationToken"]>;
  private readonly setupGenerationForToken: NonNullable<
    NotionRoutingServiceOptions["setupGenerationForToken"]
  >;
  private readonly captureChallenge: NonNullable<NotionRoutingServiceOptions["captureChallenge"]>;

  constructor(
    private readonly env: Env,
    options: NotionRoutingServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.completeInRegion = options.completeInRegion
      ?? ((region, code, state) => this.defaultCompleteInRegion(region, code, state));
    this.denyInRegion = options.denyInRegion
      ?? ((region, state) => this.defaultDenyInRegion(region, state));
    this.failInRegion = options.failInRegion
      ?? ((region, state, errorCode) => this.defaultFailInRegion(region, state, errorCode));
    this.ingestInRegion = options.ingestInRegion
      ?? ((region, rawBody, headers) => this.defaultIngestInRegion(region, rawBody, headers));
    this.storeChallengeInRegion = options.storeChallengeInRegion
      ?? ((region, verificationToken, setupGeneration) =>
        this.defaultStoreChallengeInRegion(region, verificationToken, setupGeneration));
    this.verificationToken = options.verificationToken
      ?? (() => new ProviderWebhookService(this.env).notionVerificationToken());
    this.setupGenerationForToken = options.setupGenerationForToken
      ?? ((verificationToken) =>
        new ProviderWebhookService(this.env).notionSetupGenerationForToken(verificationToken));
    this.captureChallenge = options.captureChallenge
      ?? ((_token, setupNonce, rawBody, headers) =>
        new ProviderWebhookService(this.env).ingestNotion(rawBody, headers, setupNonce));
  }

  /** Completes an authorization that began in whichever region the state names. */
  async completeNotion(code: string, state: string): Promise<string> {
    this.assertGlobalControlPlane();
    return this.completeInRegion(this.regionFor(state), code, state);
  }

  async denyNotion(state: string): Promise<string> {
    this.assertGlobalControlPlane();
    return this.denyInRegion(this.regionFor(state), state);
  }

  async failNotionAttempt(state: string, errorCode: string): Promise<string> {
    this.assertGlobalControlPlane();
    return this.failInRegion(this.regionFor(state), state, errorCode);
  }

  async registerConnection(input: NotionRouteInput): Promise<void> {
    validateRoute(input);
    if (this.env.AVALON_REGION === "global") {
      await this.registerInGlobal(input);
      return;
    }
    if (!this.env.GLOBAL_NOTION_ROUTER) {
      throw new ApiError(503, "notion_router_unavailable", "The shared Notion router is unavailable");
    }
    unwrapNotionRpcResult(await this.env.GLOBAL_NOTION_ROUTER.registerNotionRoute(input));
  }

  async setConnectionStatus(input: NotionRouteStatusInput): Promise<void> {
    validateRoute(input);
    if (this.env.AVALON_REGION === "global") {
      await this.setStatusInGlobal(input);
      return;
    }
    if (!this.env.GLOBAL_NOTION_ROUTER) {
      throw new ApiError(503, "notion_router_unavailable", "The shared Notion router is unavailable");
    }
    unwrapNotionRpcResult(await this.env.GLOBAL_NOTION_ROUTER.setNotionRouteStatus(input));
  }

  async registerInGlobal(input: NotionRouteInput): Promise<{ registered: true }> {
    this.assertGlobalControlPlane();
    validateRoute(input);
    const at = new Date(this.now()).toISOString();
    await this.env.DB.prepare(
      `INSERT INTO notion_workspace_routes
       (notion_workspace_id, region, workspace_id, connection_id, status, created_at, updated_at, disabled_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(notion_workspace_id, region, workspace_id, connection_id) DO UPDATE SET
         status = 'active', updated_at = excluded.updated_at, disabled_at = NULL`,
    ).bind(
      input.notionWorkspaceId,
      input.region,
      input.workspaceId,
      input.connectionId,
      at,
      at,
    ).run();
    return { registered: true };
  }

  async setStatusInGlobal(input: NotionRouteStatusInput): Promise<{ updated: true }> {
    this.assertGlobalControlPlane();
    validateRoute(input);
    const at = new Date(this.now()).toISOString();
    const result = await this.env.DB.prepare(
      `UPDATE notion_workspace_routes
       SET status = ?, updated_at = ?, disabled_at = ?
       WHERE notion_workspace_id = ? AND region = ? AND workspace_id = ? AND connection_id = ?`,
    ).bind(
      input.status,
      at,
      input.status === "disabled" ? at : null,
      input.notionWorkspaceId,
      input.region,
      input.workspaceId,
      input.connectionId,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new ApiError(409, "notion_route_not_found", "The Notion connection route could not be updated");
    }
    return { updated: true };
  }

  async ingestNotion(
    rawBody: Uint8Array | ArrayBuffer,
    inputHeaders: Headers | HeadersInit,
    setupNonce: string | null = null,
  ): Promise<ProviderWebhookIngestionResult> {
    this.assertGlobalControlPlane();
    const bytes = copyBytes(rawBody);
    const headers = relevantNotionHeaders(inputHeaders);
    const rawText = decodeUtf8(bytes);

    // The one subscription verifies once, against the one ingress. regional never
    // receives that request, so the token is replicated to it here rather than
    // left to an operator step that would fail silently much later.
    const verificationToken = readNotionWebhookVerificationToken(rawText, this.maxBytes());
    if (verificationToken !== null) {
      const captured = await this.captureChallenge(verificationToken, setupNonce, bytes, headers);
      const setupGeneration = await this.setupGenerationForToken(verificationToken);
      await Promise.all(configuredRegions.filter((region) => region !== this.env.AVALON_REGION)
        .map((region) => this.storeChallengeInRegion(region, verificationToken, setupGeneration)));
      return captured;
    }

    const verified = await this.verifyIngress(rawText, headers);
    const routes = await this.routeStatuses(verified.workspaceId);
    const regions = routes.filter((route) => route.status === "active").map((route) => route.region);
    if (regions.length === 0) {
      // A retired connection is not a race. Disabling an Avalon connection does
      // not uninstall the integration at Notion, so that workspace keeps
      // delivering forever; answering it with the retry-me 503 would spend the
      // full retry budget on every one, against the single subscription every
      // customer shares. Only an unrouted workspace is asked to come back.
      if (routes.length > 0) return { accepted: true, duplicate: false, activityCount: 0 };
      // Do not retain possibly regional-resident payloads in Global. A non-200 asks
      // Notion to retry after the regional OAuth callback records its route.
      throw new ApiError(503, "notion_route_pending", "The Notion workspace route is not ready yet");
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

  private regionFor(state: string): Region {
    return regionFromRoutedState(state, "Notion authorization");
  }

  /**
   * Every route for a Notion workspace with its status, rather than only the
   * active ones: "retired" and "not registered yet" need different answers.
   */
  private async routeStatuses(
    notionWorkspaceId: string,
  ): Promise<Array<{ region: Region; status: "active" | "disabled" }>> {
    const result = await this.env.DB.prepare(
      `SELECT DISTINCT region, status FROM notion_workspace_routes
       WHERE notion_workspace_id = ?
       ORDER BY region`,
    ).bind(notionWorkspaceId).all<{ region: Region; status: "active" | "disabled" }>();
    return result.results ?? [];
  }

  private async defaultCompleteInRegion(region: Region, code: string, state: string): Promise<string> {
    if (region === this.env.AVALON_REGION) {
      return new ConnectionService(this.env).completeProvider("notion", code, state);
    }
    const bridge = regionalBindings(this.env, region).notion;
    if (this.env.AVALON_REGION === "global" && bridge) {
      return unwrapNotionRpcResult(await bridge.completeNotion({ code, state }));
    }
    throw this.regionUnavailable(region);
  }

  private async defaultDenyInRegion(region: Region, state: string): Promise<string> {
    if (region === this.env.AVALON_REGION) {
      return new ConnectionService(this.env).completeProviderDenial("notion", state);
    }
    const bridge = regionalBindings(this.env, region).notion;
    if (this.env.AVALON_REGION === "global" && bridge) {
      return unwrapNotionRpcResult(await bridge.denyNotion({ state }));
    }
    throw this.regionUnavailable(region);
  }

  private async defaultFailInRegion(region: Region, state: string, errorCode: string): Promise<string> {
    if (region === this.env.AVALON_REGION) {
      return new ConnectionService(this.env).failProviderAttempt("notion", state, errorCode);
    }
    const bridge = regionalBindings(this.env, region).notion;
    if (this.env.AVALON_REGION === "global" && bridge) {
      return unwrapNotionRpcResult(await bridge.failNotionAttempt({ state, errorCode }));
    }
    throw this.regionUnavailable(region);
  }

  private async defaultIngestInRegion(
    region: Region,
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ): Promise<ProviderWebhookIngestionResult> {
    if (region === this.env.AVALON_REGION) {
      return new ProviderWebhookService(this.env).ingestNotion(rawBody, headers);
    }
    const bridge = regionalBindings(this.env, region).notion;
    if (this.env.AVALON_REGION === "global" && bridge) {
      return unwrapNotionRpcResult(await bridge.ingestNotion({
        rawBody: exactArrayBuffer(rawBody),
        headers,
      }));
    }
    throw this.regionUnavailable(region);
  }

  private async defaultStoreChallengeInRegion(
    region: Region,
    verificationToken: string,
    setupGeneration: number,
  ): Promise<void> {
    if (region === this.env.AVALON_REGION) {
      await new ProviderWebhookService(this.env).storeNotionChallengeToken(
        verificationToken,
        null,
        setupGeneration,
      );
      return;
    }
    const bridge = regionalBindings(this.env, region).notion;
    if (this.env.AVALON_REGION === "global" && bridge) {
      unwrapNotionRpcResult(await bridge.storeNotionChallenge({
        verificationToken,
        setupGeneration,
      }));
      return;
    }
    throw this.regionUnavailable(region);
  }

  private async verifyIngress(rawText: string, headers: Record<string, string>): Promise<VerifiedNotionWebhook> {
    const secret = await this.verificationToken();
    const expectedIntegrationId = this.env.NOTION_INTEGRATION_ID ?? this.env.NOTION_OAUTH_CLIENT_ID;
    if (!expectedIntegrationId) {
      throw new ConnectorError("invalid_configuration", "Notion integration/client ID is not configured");
    }
    return verifyNotionWebhook({
      secret,
      rawBody: rawText,
      signatureHeader: headers["x-notion-signature"] || null,
      expectedIntegrationId,
      maxBytes: this.maxBytes(),
    });
  }

  private maxBytes(): number {
    return numericEnv(this.env, "PROVIDER_WEBHOOK_MAX_BYTES", 2_000_000);
  }

  private regionUnavailable(region: Region): ApiError {
    return new ApiError(503, "notion_region_unavailable", `The ${region} Notion connector service is unavailable`);
  }

  private assertGlobalControlPlane(): void {
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(503, "notion_ingress_misconfigured", "The shared Notion ingress must run in the Global control plane");
    }
  }
}

function validateRoute(input: NotionRouteInput): void {
  if (
    !input.notionWorkspaceId
    || input.notionWorkspaceId.length > 200
    || !isConfiguredRegion(input.region)
    || !input.workspaceId
    || !input.connectionId
  ) {
    throw new ApiError(422, "invalid_notion_route", "The Notion connection route is invalid");
  }
}

function relevantNotionHeaders(input: Headers | HeadersInit): Record<string, string> {
  const headers = new Headers(input);
  return { "x-notion-signature": headers.get("x-notion-signature") ?? "" };
}

function decodeUtf8(rawBody: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch (error) {
    throw new ConnectorError("provider_error", "The Notion webhook body is not valid UTF-8", error);
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

function unwrapNotionRpcResult<T>(result: NotionRpcResult<T>): T {
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
