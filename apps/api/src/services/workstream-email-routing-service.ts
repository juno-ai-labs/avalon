import type { Region } from "@avalon/contracts";
import { nowIso } from "@avalon/db";
import type { Env } from "../env";
import {
  WORKSTREAM_EMAIL_DOMAIN,
  allocateWorkstreamEmailAddressCandidate,
} from "../lib/workstream-email-address";
import { ApiError } from "../lib/api-error";

const MAX_ADDRESS_RESERVATION_ATTEMPTS = 1_024;
const MAX_BULK_ADDRESS_RESERVATIONS = 512;

export interface WorkstreamEmailRouteInput {
  region: Region;
  workspaceId: string;
  workstreamId: string;
}

export interface WorkstreamEmailRoute extends WorkstreamEmailRouteInput {
  localPart: string;
  emailAddress: string;
  status: "reserved" | "active" | "disabled";
}

export interface WorkstreamEmailRouteStatusInput extends WorkstreamEmailRouteInput {
  status: "active" | "disabled";
}

export interface AutomationEmailRouteInput {
  region: Region;
  workspaceId: string;
  automationSubscriptionId: string;
}

export interface AutomationEmailRoute extends AutomationEmailRouteInput {
  localPart: string;
  emailAddress: string;
  status: "reserved" | "active" | "disabled";
}

export interface AutomationEmailRouteStatusInput extends AutomationEmailRouteInput {
  status: "active" | "disabled";
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
  activateMany(inputs: WorkstreamEmailRouteInput[]): Promise<WorkstreamEmailRouterRpcResult<{ ok: true }>>;
  setStatus(input: WorkstreamEmailRouteStatusInput): Promise<WorkstreamEmailRouterRpcResult<{ ok: true }>>;
  reserveAutomation?(input: AutomationEmailRouteInput): Promise<WorkstreamEmailRouterRpcResult<AutomationEmailRoute>>;
  reserveAutomations?(inputs: AutomationEmailRouteInput[]): Promise<WorkstreamEmailRouterRpcResult<AutomationEmailRoute[]>>;
  activateAutomations?(inputs: AutomationEmailRouteInput[]): Promise<WorkstreamEmailRouterRpcResult<{ ok: true }>>;
  setAutomationStatuses?(inputs: AutomationEmailRouteStatusInput[]): Promise<WorkstreamEmailRouterRpcResult<{ ok: true }>>;
}

interface RouteRow {
  local_part: string;
  region: Region;
  workspace_id: string;
  workstream_id: string | null;
  automation_subscription_id: string | null;
  status: WorkstreamEmailRoute["status"];
}

interface LocalWorkstreamEmailRow {
  email_address: string | null;
  email_route_status: WorkstreamEmailRoute["status"];
  archived_at: string | null;
}

interface LocalAutomationEmailRow {
  email_address: string | null;
  email_route_status: AutomationEmailRoute["status"];
  status: string;
  lifecycle_state: string;
}

/** An address accepts mail only while its automation is both running and still
 * present: a paused, archived, or deleted automation has a disabled route. */
function automationRouteDesiredStatus(row: LocalAutomationEmailRow): AutomationEmailRouteStatusInput["status"] {
  return row.status === "active" && row.lifecycle_state === "visible" ? "active" : "disabled";
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
    const current = await this.loadLocalAutomationEmailRow(input);
    // Always consult the authoritative Global registry. This heals a missing
    // route after a registry restore instead of trusting only the regional
    // lifecycle marker and reporting an address that cannot receive mail.
    const route = await this.reserveAutomation(input);
    if (current.email_address && current.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "automation_email_address_conflict", "The automation already has a different email address");
    }
    if (!current.email_address) {
      await this.env.DB.prepare(
        `UPDATE automation_subscriptions
         SET email_address = ?, email_route_status = 'reserved', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND email_address IS NULL`,
      ).bind(route.emailAddress, nowIso(), input.automationSubscriptionId, input.workspaceId).run();
    }
    const stored = await this.loadLocalAutomationEmailRow(input);
    if (!stored.email_address || stored.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "automation_email_address_conflict", "The automation already has a different email address");
    }
    const storedDesiredStatus = automationRouteDesiredStatus(stored);
    if (route.status !== storedDesiredStatus) {
      await this.setAutomationStatuses([{ ...input, status: storedDesiredStatus }]);
    }
    if (stored.email_route_status !== storedDesiredStatus) {
      const updated = await this.env.DB.prepare(
        `UPDATE automation_subscriptions SET email_route_status = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND email_address = ? COLLATE NOCASE`,
      ).bind(storedDesiredStatus, nowIso(), input.automationSubscriptionId, input.workspaceId, route.emailAddress).run();
      if (resultChanges(updated) === 0) {
        throw new ApiError(409, "automation_email_address_conflict", "The automation email route could not be reconciled");
      }
    }
    return { ...route, status: storedDesiredStatus };
  }

  async activateAutomationRoute(input: AutomationEmailRouteInput): Promise<AutomationEmailRoute> {
    const route = await this.ensureAutomationAddress(input);
    if (route.status !== "active") {
      throw new ApiError(409, "automation_not_active", "A paused automation cannot receive email");
    }
    return route;
  }

  async backfillAutomationAddresses(inputs: AutomationEmailRouteInput[]): Promise<AutomationEmailRoute[]> {
    this.assertBulkSize(inputs);
    for (const input of inputs) this.assertAutomationRegionalOwner(input);
    if (inputs.length === 0) return [];
    const initial = await this.loadLocalAutomationEmailRows(inputs);
    // A single bulk Global call validates existing destinations and recreates a
    // missing registry row after restore. It is read-only for healthy routes.
    const reservations = await this.reserveAutomations(inputs);
    const byDestination = new Map(reservations.map((route) => [automationDestinationKey(route), route]));
    const at = nowIso();
    const missingReservations = reservations.filter((route, index) => !initial[index]!.email_address);
    if (missingReservations.length > 0) {
      await this.env.DB.batch(missingReservations.map((route) => this.env.DB.prepare(
        `UPDATE automation_subscriptions
         SET email_address = ?, email_route_status = 'reserved', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND email_address IS NULL`,
      ).bind(route.emailAddress, at, route.automationSubscriptionId, route.workspaceId)));
    }
    const stored = await this.loadLocalAutomationEmailRows(inputs);
    const routes = inputs.map((input, index) => {
      const row = stored[index]!;
      const reservation = byDestination.get(automationDestinationKey(input));
      if (!row.email_address || !reservation
        || row.email_address.toLowerCase() !== reservation.emailAddress.toLowerCase()) {
        throw new ApiError(409, "automation_email_address_conflict", "The automation already has a different email address");
      }
      return { ...reservation, status: row.email_route_status };
    });
    const statusChanges = inputs.flatMap((input, index): AutomationEmailRouteStatusInput[] => {
      const desiredStatus = automationRouteDesiredStatus(stored[index]!);
      return stored[index]!.email_route_status !== desiredStatus
        || reservations[index]!.status !== desiredStatus
        ? [{ ...input, status: desiredStatus }]
        : [];
    });
    if (statusChanges.length > 0) {
      await this.setAutomationStatuses(statusChanges);
      const desiredByDestination = new Map(statusChanges.map((item) => [automationDestinationKey(item), item.status]));
      await this.env.DB.batch(routes.flatMap((route) => {
        const desiredStatus = desiredByDestination.get(automationDestinationKey(route));
        return desiredStatus ? [this.env.DB.prepare(
          `UPDATE automation_subscriptions SET email_route_status = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND email_address = ? COLLATE NOCASE`,
        ).bind(desiredStatus, nowIso(), route.automationSubscriptionId, route.workspaceId, route.emailAddress)] : [];
      }));
    }
    return routes.map((route, index) => ({
      ...route,
      status: stored[index]!.status === "active" ? "active" : "disabled",
    }));
  }

  async ensureWorkstreamAddress(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
    this.assertRegionalOwner(input);
    const current = await this.env.DB.prepare(
      `SELECT email_address, email_route_status, archived_at
       FROM workstreams WHERE id = ? AND workspace_id = ?`,
    ).bind(input.workstreamId, input.workspaceId).first<LocalWorkstreamEmailRow>();
    if (!current) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    const desiredStatus: WorkstreamEmailRoute["status"] = current.archived_at ? "disabled" : "active";
    if (current.email_address && current.email_route_status === desiredStatus) {
      const localPart = current.email_address.slice(0, current.email_address.lastIndexOf("@"));
      return { ...input, localPart, emailAddress: current.email_address, status: desiredStatus };
    }

    const route = await this.reserve(input);
    if (current.email_address && current.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
    }
    if (!current.email_address) {
      await this.env.DB.prepare(
        `UPDATE workstreams
         SET email_address = ?, email_route_status = 'reserved', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND email_address IS NULL`,
      ).bind(route.emailAddress, nowIso(), input.workstreamId, input.workspaceId).run();
    }
    const stored = await this.env.DB.prepare(
      `SELECT email_address, email_route_status, archived_at
       FROM workstreams WHERE id = ? AND workspace_id = ?`,
    ).bind(input.workstreamId, input.workspaceId).first<LocalWorkstreamEmailRow>();
    if (!stored?.email_address || stored.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
    }
    const storedDesiredStatus: WorkstreamEmailRoute["status"] = stored.archived_at ? "disabled" : "active";
    if (route.status !== storedDesiredStatus) {
      await this.setStatus({ ...input, status: storedDesiredStatus });
    }
    const localUpdate = await this.env.DB.prepare(
      `UPDATE workstreams SET email_route_status = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND email_address = ? COLLATE NOCASE`,
    ).bind(storedDesiredStatus, nowIso(), input.workstreamId, input.workspaceId, route.emailAddress).run();
    if (resultChanges(localUpdate) === 0) {
      throw new ApiError(409, "workstream_email_address_conflict", "The work-stream email route could not be reconciled");
    }
    return { ...route, status: storedDesiredStatus };
  }

  async activateWorkstreamRoute(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
    const route = await this.ensureWorkstreamAddress(input);
    if (route.status !== "active") {
      throw new ApiError(409, "workstream_email_owner_archived", "An archived work stream cannot receive email");
    }
    return route;
  }

  /**
   * Backfills addresses already known to be missing from a regional work-stream
   * query. Non-Global callers cross the service-binding boundary exactly once.
   */
  async backfillWorkstreamAddresses(inputs: WorkstreamEmailRouteInput[]): Promise<WorkstreamEmailRoute[]> {
    if (inputs.length === 0) return [];
    this.assertBulkSize(inputs);
    for (const input of inputs) this.assertRegionalOwner(input);

    const initialRows = await this.loadLocalWorkstreamEmailRows(inputs);
    const missingInputs = inputs.filter((_, index) => !initialRows[index]!.email_address);
    const reservations = await this.reserveMany(missingInputs);
    const reservationsByDestination = new Map(
      reservations.map((route) => [routeDestinationKey(route), route]),
    );
    const at = nowIso();
    if (reservations.length > 0) {
      await this.env.DB.batch(reservations.map((route) => this.env.DB.prepare(
        `UPDATE workstreams
         SET email_address = ?, email_route_status = 'reserved', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND email_address IS NULL`,
      ).bind(route.emailAddress, at, route.workstreamId, route.workspaceId)));
    }

    const storedRows = await this.loadLocalWorkstreamEmailRows(inputs);
    const routes = inputs.map((input, index): WorkstreamEmailRoute => {
      const stored = storedRows[index]!;
      const reservation = reservationsByDestination.get(routeDestinationKey(input));
      if (!stored.email_address || (reservation
        && stored.email_address.toLowerCase() !== reservation.emailAddress.toLowerCase())) {
        throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
      }
      return {
        ...input,
        localPart: stored.email_address.slice(0, stored.email_address.lastIndexOf("@")),
        emailAddress: stored.email_address,
        status: stored.email_route_status,
      };
    });

    // The Global registry is activated only after every owning regional row has
    // durably stored and confirmed its immutable address.
    await this.activateMany(inputs);
    await this.env.DB.batch(routes.map((route) => this.env.DB.prepare(
      `UPDATE workstreams SET email_route_status = 'active', updated_at = ?
       WHERE id = ? AND workspace_id = ? AND email_address = ? COLLATE NOCASE
         AND archived_at IS NULL`,
    ).bind(nowIso(), route.workstreamId, route.workspaceId, route.emailAddress)));
    const activatedRows = await this.loadLocalWorkstreamEmailRows(inputs);
    for (const [index, route] of routes.entries()) {
      const activated = activatedRows[index]!;
      if (activated.email_route_status !== "active"
        || activated.email_address?.toLowerCase() !== route.emailAddress.toLowerCase()) {
        throw new ApiError(409, "workstream_email_address_conflict", "The work-stream email route could not be reconciled");
      }
    }
    return routes.map((route) => ({ ...route, status: "active" }));
  }

  async activateMany(inputs: WorkstreamEmailRouteInput[]): Promise<{ ok: true }> {
    this.assertBulkSize(inputs);
    if (inputs.length === 0) return { ok: true };
    for (const input of inputs) this.assertRegionalOwner(input);
    if (this.env.AVALON_REGION !== "global") {
      if (this.env.GLOBAL_EMAIL_ROUTER?.activateMany) {
        return unwrapRpcResult(await this.env.GLOBAL_EMAIL_ROUTER.activateMany(inputs));
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.activateManyInGlobalRegistry(inputs);
  }

  async setStatus(input: WorkstreamEmailRouteStatusInput): Promise<{ ok: true }> {
    if (this.env.AVALON_REGION !== "global") {
      this.assertRegionalOwner(input);
      if (this.env.GLOBAL_EMAIL_ROUTER) {
        return unwrapRpcResult(await this.env.GLOBAL_EMAIL_ROUTER.setStatus(input));
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    const at = nowIso();
    const updated = await this.env.DB.prepare(
      `UPDATE workstream_email_routes
       SET status = ?, updated_at = ?, disabled_at = CASE WHEN ? = 'disabled' THEN ? ELSE NULL END
       WHERE region = ? AND workspace_id = ? AND workstream_id = ?`,
    ).bind(input.status, at, input.status, at, input.region, input.workspaceId, input.workstreamId).run();
    if (resultChanges(updated) === 0) {
      throw new ApiError(404, "workstream_email_route_not_found", "The work-stream email route does not exist");
    }
    return { ok: true };
  }

  async setAutomationStatuses(inputs: AutomationEmailRouteStatusInput[]): Promise<{ ok: true }> {
    this.assertBulkSize(inputs);
    for (const input of inputs) this.assertAutomationRegionalOwner(input);
    if (inputs.length === 0) return { ok: true };
    if (this.env.AVALON_REGION !== "global") {
      if (this.env.GLOBAL_EMAIL_ROUTER?.setAutomationStatuses) {
        return unwrapRpcResult(await this.env.GLOBAL_EMAIL_ROUTER.setAutomationStatuses(inputs));
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.setAutomationStatusesInGlobalRegistry(inputs);
  }

  async resolveActive(localPart: string): Promise<WorkstreamEmailRoute | null> {
    const row = await this.env.DB.prepare(
      `SELECT local_part, region, workspace_id, workstream_id, automation_subscription_id, status
       FROM workstream_email_routes
       WHERE local_part = ? COLLATE NOCASE AND status = 'active'
         AND workstream_id IS NOT NULL`,
    ).bind(localPart).first<RouteRow>();
    return row ? this.mapRoute(row) : null;
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
         (local_part, region, workspace_id, workstream_id, status, created_at, updated_at, disabled_at)
         VALUES (?, ?, ?, ?, 'reserved', ?, ?, NULL)
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
          status, created_at, updated_at, disabled_at)
         VALUES (?, ?, ?, NULL, ?, 'reserved', ?, ?, NULL)
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
  async activateAutomationsInGlobalRegistry(inputs: AutomationEmailRouteInput[]): Promise<{ ok: true }> {
    return this.setAutomationStatusesInGlobalRegistry(inputs.map((input) => ({ ...input, status: "active" })));
  }

  /** Called directly by the Global named RPC entrypoint. */
  async setAutomationStatusesInGlobalRegistry(inputs: AutomationEmailRouteStatusInput[]): Promise<{ ok: true }> {
    this.assertGlobalRegistry();
    this.assertBulkSize(inputs);
    if (inputs.length === 0) return { ok: true };
    const at = nowIso();
    const results = await this.env.DB.batch(inputs.map((input) => this.env.DB.prepare(
      `UPDATE workstream_email_routes
       SET status = ?, updated_at = ?, disabled_at = CASE WHEN ? = 'disabled' THEN ? ELSE NULL END
       WHERE region = ? AND workspace_id = ? AND workstream_id IS NULL
         AND automation_subscription_id = ?`,
    ).bind(input.status, at, input.status, at, input.region, input.workspaceId, input.automationSubscriptionId)));
    if (results.some((result) => resultChanges(result) === 0)) {
      throw new ApiError(404, "automation_email_route_not_found", "An automation email route does not exist");
    }
    return { ok: true };
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

  /** Called directly by the Global named RPC entrypoint. */
  async activateManyInGlobalRegistry(inputs: WorkstreamEmailRouteInput[]): Promise<{ ok: true }> {
    this.assertGlobalRegistry();
    this.assertBulkSize(inputs);
    if (inputs.length === 0) return { ok: true };
    const at = nowIso();
    const results = await this.env.DB.batch(inputs.map((input) => this.env.DB.prepare(
      `UPDATE workstream_email_routes
       SET status = 'active', updated_at = ?, disabled_at = NULL
       WHERE region = ? AND workspace_id = ? AND workstream_id = ?`,
    ).bind(at, input.region, input.workspaceId, input.workstreamId)));
    if (results.some((result) => resultChanges(result) === 0)) {
      throw new ApiError(404, "workstream_email_route_not_found", "A work-stream email route does not exist");
    }
    return { ok: true };
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
      `SELECT local_part, region, workspace_id, workstream_id, automation_subscription_id, status
       FROM workstream_email_routes
       WHERE region = ? AND workspace_id = ? AND workstream_id = ?
         AND automation_subscription_id IS NULL`,
    ).bind(input.region, input.workspaceId, input.workstreamId).first<RouteRow>();
  }

  private async loadAutomationDestination(input: AutomationEmailRouteInput): Promise<RouteRow | null> {
    return this.env.DB.prepare(
      `SELECT local_part, region, workspace_id, workstream_id, automation_subscription_id, status
       FROM workstream_email_routes
       WHERE region = ? AND workspace_id = ? AND workstream_id IS NULL
         AND automation_subscription_id = ?`,
    ).bind(input.region, input.workspaceId, input.automationSubscriptionId).first<RouteRow>();
  }

  private async loadLocalWorkstreamEmailRows(inputs: WorkstreamEmailRouteInput[]): Promise<LocalWorkstreamEmailRow[]> {
    const results = await this.env.DB.batch(inputs.map((input) => this.env.DB.prepare(
      `SELECT email_address, email_route_status, archived_at
       FROM workstreams WHERE id = ? AND workspace_id = ?`,
    ).bind(input.workstreamId, input.workspaceId)));
    return results.map((result) => {
      const row = result.results[0] as LocalWorkstreamEmailRow | undefined;
      if (!row) throw new ApiError(404, "workstream_not_found", "Work stream not found");
      if (row.archived_at) {
        throw new ApiError(409, "workstream_email_owner_archived", "An archived work stream cannot receive email");
      }
      return row;
    });
  }

  private async loadLocalAutomationEmailRow(input: AutomationEmailRouteInput): Promise<LocalAutomationEmailRow> {
    const row = await this.env.DB.prepare(
      `SELECT email_address, email_route_status, status, lifecycle_state
       FROM automation_subscriptions WHERE id = ? AND workspace_id = ?`,
    ).bind(input.automationSubscriptionId, input.workspaceId).first<LocalAutomationEmailRow>();
    if (!row) throw new ApiError(404, "automation_not_found", "Automation not found");
    return row;
  }

  private async loadLocalAutomationEmailRows(inputs: AutomationEmailRouteInput[]): Promise<LocalAutomationEmailRow[]> {
    const results = await this.env.DB.batch(inputs.map((input) => this.env.DB.prepare(
      `SELECT email_address, email_route_status, status, lifecycle_state
       FROM automation_subscriptions WHERE id = ? AND workspace_id = ?`,
    ).bind(input.automationSubscriptionId, input.workspaceId)));
    return results.map((result) => {
      const row = result.results[0] as LocalAutomationEmailRow | undefined;
      if (!row) throw new ApiError(404, "automation_not_found", "Automation not found");
      return row;
    });
  }

  private mapRoute(row: RouteRow): WorkstreamEmailRoute {
    if (!row.workstream_id || row.automation_subscription_id) {
      throw new ApiError(500, "workstream_email_route_invalid", "The work-stream email route is invalid");
    }
    const domain = this.emailDomain();
    return {
      localPart: row.local_part,
      emailAddress: `${row.local_part}@${domain}`,
      status: row.status,
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
      status: row.status,
      region: row.region,
      workspaceId: row.workspace_id,
      automationSubscriptionId: row.automation_subscription_id,
    };
  }

  private localAutomationRoute(
    input: AutomationEmailRouteInput,
    emailAddress: string,
    status: AutomationEmailRoute["status"],
  ): AutomationEmailRoute {
    return {
      ...input,
      localPart: emailAddress.slice(0, emailAddress.lastIndexOf("@")),
      emailAddress,
      status,
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

  private assertBulkSize(inputs: Array<WorkstreamEmailRouteInput | AutomationEmailRouteInput | AutomationEmailRouteStatusInput>): void {
    if (inputs.length > MAX_BULK_ADDRESS_RESERVATIONS) {
      throw new ApiError(422, "workstream_email_bulk_limit_exceeded", `At most ${MAX_BULK_ADDRESS_RESERVATIONS} email addresses can be reserved at once`);
    }
  }
}

function resultChanges(result: D1Result<unknown>): number {
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : Number(changes ?? 0);
}

function routeDestinationKey(input: WorkstreamEmailRouteInput): string {
  return `${input.region}\u0000${input.workspaceId}\u0000${input.workstreamId}`;
}

function automationDestinationKey(input: AutomationEmailRouteInput): string {
  return `${input.region}\u0000${input.workspaceId}\u0000${input.automationSubscriptionId}`;
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
