import type { Region } from "@avalon/contracts";
import { nowIso } from "@avalon/db";
import type { Env } from "../env";
import {
  WORKSTREAM_EMAIL_DOMAIN,
  allocateWorkstreamEmailAddressCandidate,
} from "../lib/workstream-email-address";
import { ApiError } from "../lib/api-error";
import { RPC_BATCH_LIMIT } from "../lib/rpc-contracts";
import { workstreamExecutionEnvironment } from "./workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { createIdentityObjectPort } from "../runtime/identity-port";

const MAX_ADDRESS_RESERVATION_ATTEMPTS = 1_024;
/** One bound for both sides of the bridge. See `RPC_BATCH_LIMIT`. */
const MAX_BULK_ADDRESS_RESERVATIONS = RPC_BATCH_LIMIT;

export interface WorkstreamEmailRouteInput {
  region: Region;
  workspaceId: string;
  workstreamId: string;
}

/**
 * One claimed address. Global records that the local part is taken and to whom;
 * whether mail is accepted today is the owner's own regional state, decided
 * again from that row on every delivery.
 */
export interface WorkstreamEmailRoute extends WorkstreamEmailRouteInput {
  localPart: string;
  emailAddress: string;
}

export interface AutomationEmailRouteInput {
  region: Region;
  workspaceId: string;
  automationSubscriptionId: string;
}

export interface AutomationEmailRoute extends AutomationEmailRouteInput {
  localPart: string;
  emailAddress: string;
}

export interface WorkstreamEmailRouterPing {
  region: "global";
  domain: string;
}

export type WorkstreamEmailRouterRpcResult<T> =
  | { ok: true; value: T }
  | {
    ok: false;
    error: {
      status: ApiError["status"];
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  };

/** Account-internal RPC surface exposed only by the Global Worker. */
export interface GlobalWorkstreamEmailRouterRpcBinding {
  ping(): Promise<WorkstreamEmailRouterRpcResult<WorkstreamEmailRouterPing>>;
  reserve(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRouterRpcResult<WorkstreamEmailRoute>>;
  reserveMany(inputs: WorkstreamEmailRouteInput[]): Promise<WorkstreamEmailRouterRpcResult<WorkstreamEmailRoute[]>>;
  reserveAutomation?(input: AutomationEmailRouteInput): Promise<WorkstreamEmailRouterRpcResult<AutomationEmailRoute>>;
  reserveAutomations?(inputs: AutomationEmailRouteInput[]): Promise<WorkstreamEmailRouterRpcResult<AutomationEmailRoute[]>>;
}

interface RouteRow {
  local_part: string;
  region: Region;
  workspace_id: string;
  workstream_id: string | null;
  automation_subscription_id: string | null;
}

interface LocalAutomationEmailRow {
  email_address: string | null;
}

export class WorkstreamEmailRoutingService {
  constructor(private readonly env: Env) {}

  async reserve(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
    if (input.region !== this.env.AVALON_REGION) {
      throw new ApiError(422, "workstream_email_region_mismatch", "The work stream belongs to a different data region");
    }
    if (this.env.AVALON_REGION !== "global") {
      if (this.env.GLOBAL_EMAIL_ROUTER) {
        return unwrapRpcResult(await this.env.GLOBAL_EMAIL_ROUTER.reserve(input));
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.reserveInGlobalRegistry(input);
  }

  async reserveMany(inputs: WorkstreamEmailRouteInput[]): Promise<WorkstreamEmailRoute[]> {
    this.assertBulkSize(inputs);
    if (inputs.length === 0) return [];
    for (const input of inputs) {
      if (input.region !== this.env.AVALON_REGION) {
        throw new ApiError(422, "workstream_email_region_mismatch", "The work stream belongs to a different data region");
      }
    }
    if (this.env.AVALON_REGION !== "global") {
      if (this.env.GLOBAL_EMAIL_ROUTER?.reserveMany) {
        return unwrapRpcResult(await this.env.GLOBAL_EMAIL_ROUTER.reserveMany(inputs));
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.reserveManyInGlobalRegistry(inputs);
  }

  async reserveAutomation(input: AutomationEmailRouteInput): Promise<AutomationEmailRoute> {
    this.assertAutomationRegionalOwner(input);
    if (this.env.AVALON_REGION !== "global") {
      if (this.env.GLOBAL_EMAIL_ROUTER?.reserveAutomation) {
        return unwrapRpcResult(await this.env.GLOBAL_EMAIL_ROUTER.reserveAutomation(input));
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.reserveAutomationInGlobalRegistry(input);
  }

  async reserveAutomations(inputs: AutomationEmailRouteInput[]): Promise<AutomationEmailRoute[]> {
    this.assertBulkSize(inputs);
    for (const input of inputs) this.assertAutomationRegionalOwner(input);
    if (inputs.length === 0) return [];
    if (this.env.AVALON_REGION !== "global") {
      if (this.env.GLOBAL_EMAIL_ROUTER?.reserveAutomations) {
        return unwrapRpcResult(await this.env.GLOBAL_EMAIL_ROUTER.reserveAutomations(inputs));
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.reserveAutomationsInGlobalRegistry(inputs);
  }

  async ensureAutomationAddress(input: AutomationEmailRouteInput): Promise<AutomationEmailRoute> {
    this.assertAutomationRegionalOwner(input);
    const workspaceDatabase = this.workspaceDatabase(input.workspaceId);
    const current = await this.loadLocalAutomationEmailRow(input);
    // Always consult the authoritative Global registry. This heals a missing
    // route after a registry restore instead of trusting only the regional
    // lifecycle marker and reporting an address that cannot receive mail.
    const route = await this.reserveAutomation(input);
    if (current.email_address && current.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "automation_email_address_conflict", "The automation already has a different email address");
    }
    if (!current.email_address) {
      await workspaceDatabase.prepare(
        `UPDATE automation_subscriptions
         SET email_address = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND email_address IS NULL`,
      ).bind(route.emailAddress, nowIso(), input.automationSubscriptionId, input.workspaceId).run();
    }
    const stored = await this.loadLocalAutomationEmailRow(input);
    if (!stored.email_address || stored.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "automation_email_address_conflict", "The automation already has a different email address");
    }
    return route;
  }

  /**
   * The address, refused if the automation cannot receive mail.
   *
   * The test is the automation's own row — the same one the inbound resolver
   * applies when a message arrives — so this answer cannot disagree with what
   * actually happens to the mail.
   */
  async activateAutomationRoute(input: AutomationEmailRouteInput): Promise<AutomationEmailRoute> {
    const route = await this.ensureAutomationAddress(input);
    const owner = await this.workspaceDatabase(input.workspaceId).prepare(
      `SELECT status, lifecycle_state FROM automation_subscriptions WHERE id = ? AND workspace_id = ?`,
    ).bind(input.automationSubscriptionId, input.workspaceId)
      .first<{ status: string; lifecycle_state: string }>();
    if (owner?.status !== "active" || owner.lifecycle_state !== "visible") {
      throw new ApiError(409, "automation_not_active", "A paused automation cannot receive email");
    }
    return route;
  }

  async ensureWorkstreamAddress(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
    this.assertRegionalOwner(input);
    const executionEnv = await workstreamExecutionEnvironment(
      this.env,
      input.workspaceId,
      input.workstreamId,
    );
    const identity = createIdentityObjectPort(this.env, input.workspaceId, input.workstreamId);
    const current = await identity.identity();
    if (!current) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    if (current.email_address) {
      const localPart = current.email_address.slice(0, current.email_address.lastIndexOf("@"));
      return { ...input, localPart, emailAddress: current.email_address };
    }

    const route = await this.reserve(input);
    if (current.email_address && current.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
    }
    if (!current.email_address) {
      await executionEnv.DB.prepare(
        `UPDATE workstreams
         SET email_address = ?, email_route_status = 'reserved', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND email_address IS NULL`,
      ).bind(route.emailAddress, nowIso(), input.workstreamId, input.workspaceId).run();
    }
    const stored = await identity.identity();
    if (!stored?.email_address || stored.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
    }
    return route;
  }

  /** The address, refused if the work stream is archived — the same test the
   * inbound resolver applies when a message actually arrives.
   *
   * Read through {@link workstreamExecutionEnvironment}, never
   * `workspaceDatabase`. `workstreams` is not a workspace-local table, so the
   * workspace facade sends the statement to regional D1 — where migration 0090
   * left only the identity anchor and dropped `archived_at`. The column lives
   * in the work-stream object now, and asking the wrong database for it fails
   * the gate with `no such column` after the address was already reserved. */
  async activateWorkstreamRoute(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
    const route = await this.ensureWorkstreamAddress(input);
    const owner = await createIdentityObjectPort(this.env, input.workspaceId, input.workstreamId)
      .identity();
    // A row that is not there refuses, like the automation twin below: this
    // gate answers "may mail reach this owner", and an owner it cannot read is
    // not an owner it can vouch for. `ensureWorkstreamAddress` has already
    // 404ed a genuinely missing work stream, so reaching this with no row means
    // the two reads disagreed — which is the case least worth failing open on.
    if (!owner || owner.archived_at) {
      throw new ApiError(409, "workstream_email_owner_archived", "An archived work stream cannot receive email");
    }
    return route;
  }

  /** Called directly by the Global named RPC entrypoint. */
  async reserveInGlobalRegistry(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
    this.assertGlobalRegistry();
    const existing = await this.loadDestination(input);
    if (existing) return this.mapRoute(existing);

    const secretKey = this.addressKey();
    const at = nowIso();
    for (let attempt = 0; attempt < MAX_ADDRESS_RESERVATION_ATTEMPTS; attempt += 1) {
      const localPart = await allocateWorkstreamEmailAddressCandidate({
        secretKey,
        workstreamId: `${input.region}:${input.workspaceId}:${input.workstreamId}`,
        attempt,
      });
      await this.env.DB.prepare(
        `INSERT INTO workstream_email_routes
         (local_part, region, workspace_id, workstream_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(localPart, input.region, input.workspaceId, input.workstreamId, at, at).run();

      const reserved = await this.loadDestination(input);
      if (reserved) return this.mapRoute(reserved);
    }
    throw new ApiError(503, "workstream_email_address_exhausted", "A unique work-stream email address could not be reserved");
  }

  /** Called directly by the Global named RPC entrypoint. */
  async reserveAutomationInGlobalRegistry(input: AutomationEmailRouteInput): Promise<AutomationEmailRoute> {
    this.assertGlobalRegistry();
    const existing = await this.loadAutomationDestination(input);
    if (existing) return this.mapAutomationRoute(existing);
    const secretKey = this.addressKey();
    const at = nowIso();
    for (let attempt = 0; attempt < MAX_ADDRESS_RESERVATION_ATTEMPTS; attempt += 1) {
      const localPart = await allocateWorkstreamEmailAddressCandidate({
        secretKey,
        workstreamId: `${input.region}:${input.workspaceId}:automation:${input.automationSubscriptionId}`,
        attempt,
      });
      await this.env.DB.prepare(
        `INSERT INTO workstream_email_routes
         (local_part, region, workspace_id, workstream_id, automation_subscription_id,
          created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(localPart, input.region, input.workspaceId, input.automationSubscriptionId, at, at).run();
      const reserved = await this.loadAutomationDestination(input);
      if (reserved) return this.mapAutomationRoute(reserved);
    }
    throw new ApiError(503, "workstream_email_address_exhausted", "A unique automation email address could not be reserved");
  }

  /** Called directly by the Global named RPC entrypoint. */
  async reserveAutomationsInGlobalRegistry(inputs: AutomationEmailRouteInput[]): Promise<AutomationEmailRoute[]> {
    this.assertGlobalRegistry();
    this.assertBulkSize(inputs);
    const routes: AutomationEmailRoute[] = [];
    for (const input of inputs) routes.push(await this.reserveAutomationInGlobalRegistry(input));
    return routes;
  }

  /** Called directly by the Global named RPC entrypoint. */
  async reserveManyInGlobalRegistry(inputs: WorkstreamEmailRouteInput[]): Promise<WorkstreamEmailRoute[]> {
    this.assertGlobalRegistry();
    this.assertBulkSize(inputs);
    const routes: WorkstreamEmailRoute[] = [];
    // Serial execution keeps D1 pressure bounded. The service-binding call itself
    // is still one bulk invocation from the owning regional Worker.
    for (const input of inputs) {
      routes.push(await this.reserveInGlobalRegistry(input));
    }
    return routes;
  }

  async ping(): Promise<WorkstreamEmailRouterPing> {
    if (this.env.AVALON_REGION !== "global") {
      if (this.env.GLOBAL_EMAIL_ROUTER?.ping) {
        return unwrapRpcResult(await this.env.GLOBAL_EMAIL_ROUTER.ping());
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.pingGlobalRegistry();
  }

  /** Called directly by the Global named RPC entrypoint. */
  async pingGlobalRegistry(): Promise<WorkstreamEmailRouterPing> {
    this.assertGlobalRegistry();
    this.addressKey();
    // Query the registry itself so readiness also proves that its migration is live.
    await this.env.DB.prepare(
      "SELECT local_part FROM workstream_email_routes LIMIT 1",
    ).first<{ local_part: string }>();
    return { region: "global", domain: this.emailDomain() };
  }

  private async loadDestination(input: WorkstreamEmailRouteInput): Promise<RouteRow | null> {
    return this.env.DB.prepare(
      `SELECT local_part, region, workspace_id, workstream_id, automation_subscription_id
       FROM workstream_email_routes
       WHERE region = ? AND workspace_id = ? AND workstream_id = ?
         AND automation_subscription_id IS NULL`,
    ).bind(input.region, input.workspaceId, input.workstreamId).first<RouteRow>();
  }

  private async loadAutomationDestination(input: AutomationEmailRouteInput): Promise<RouteRow | null> {
    return this.env.DB.prepare(
      `SELECT local_part, region, workspace_id, workstream_id, automation_subscription_id
       FROM workstream_email_routes
       WHERE region = ? AND workspace_id = ? AND workstream_id IS NULL
         AND automation_subscription_id = ?`,
    ).bind(input.region, input.workspaceId, input.automationSubscriptionId).first<RouteRow>();
  }

  private async loadLocalAutomationEmailRow(input: AutomationEmailRouteInput): Promise<LocalAutomationEmailRow> {
    const row = await this.workspaceDatabase(input.workspaceId).prepare(
      `SELECT email_address
       FROM automation_subscriptions WHERE id = ? AND workspace_id = ?`,
    ).bind(input.automationSubscriptionId, input.workspaceId).first<LocalAutomationEmailRow>();
    if (!row) throw new ApiError(404, "automation_not_found", "Automation not found");
    return row;
  }

  private workspaceDatabase(workspaceId: string): D1Database {
    return withWorkspaceRuntimeDatabase(this.env, workspaceId).DB;
  }

  private mapRoute(row: RouteRow): WorkstreamEmailRoute {
    if (!row.workstream_id || row.automation_subscription_id) {
      throw new ApiError(500, "workstream_email_route_invalid", "The work-stream email route is invalid");
    }
    const domain = this.emailDomain();
    return {
      localPart: row.local_part,
      emailAddress: `${row.local_part}@${domain}`,
      region: row.region,
      workspaceId: row.workspace_id,
      workstreamId: row.workstream_id,
    };
  }

  private mapAutomationRoute(row: RouteRow): AutomationEmailRoute {
    if (!row.automation_subscription_id || row.workstream_id) {
      throw new ApiError(500, "automation_email_route_invalid", "The automation email route is invalid");
    }
    return {
      localPart: row.local_part,
      emailAddress: `${row.local_part}@${this.emailDomain()}`,
      region: row.region,
      workspaceId: row.workspace_id,
      automationSubscriptionId: row.automation_subscription_id,
    };
  }

  private emailDomain(): string {
    const domain = this.env.WORKSTREAM_EMAIL_DOMAIN?.trim().toLowerCase() || WORKSTREAM_EMAIL_DOMAIN;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(domain)) {
      throw new ApiError(500, "workstream_email_domain_invalid", "The work-stream email domain is not configured correctly");
    }
    return domain;
  }

  private addressKey(): string {
    const key = this.env.WORKSTREAM_EMAIL_ADDRESS_KEY?.trim();
    if (key && new TextEncoder().encode(key).length >= 32) return key;
    if (key) {
      throw new ApiError(503, "workstream_email_key_invalid", "The work-stream email address key must be at least 32 bytes");
    }
    if (this.env.APP_ENV !== "production" && this.env.SESSION_SIGNING_KEY.length >= 32) {
      return `workstream-email:${this.env.SESSION_SIGNING_KEY}`;
    }
    throw new ApiError(503, "workstream_email_key_unavailable", "The work-stream email address key is unavailable");
  }

  private assertGlobalRegistry(): void {
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(503, "workstream_email_registry_region_invalid", "Email addresses may only be reserved in the Global registry");
    }
  }

  private assertRegionalOwner(input: WorkstreamEmailRouteInput): void {
    if (input.region !== this.env.AVALON_REGION) {
      throw new ApiError(422, "workstream_email_region_mismatch", "The work stream belongs to a different data region");
    }
  }

  private assertAutomationRegionalOwner(input: AutomationEmailRouteInput): void {
    if (input.region !== this.env.AVALON_REGION) {
      throw new ApiError(422, "automation_email_region_mismatch", "The automation belongs to a different data region");
    }
  }

  private assertBulkSize(inputs: Array<WorkstreamEmailRouteInput | AutomationEmailRouteInput>): void {
    if (inputs.length > MAX_BULK_ADDRESS_RESERVATIONS) {
      throw new ApiError(422, "workstream_email_bulk_limit_exceeded", `At most ${MAX_BULK_ADDRESS_RESERVATIONS} email addresses can be reserved at once`);
    }
  }
}

function unwrapRpcResult<T>(result: WorkstreamEmailRouterRpcResult<T>): T {
  if (result.ok) return result.value;
  throw new ApiError(
    result.error.status,
    result.error.code,
    result.error.message,
    result.error.details,
  );
}
