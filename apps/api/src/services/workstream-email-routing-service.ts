import type { Region } from "@rally/contracts";
import { nowIso } from "@rally/db";
import type { Env } from "../env";
import {
  WORKSTREAM_EMAIL_DOMAIN,
  allocateWorkstreamEmailAddressCandidate,
} from "../lib/workstream-email-address";
import { ApiError } from "../lib/api-error";
import { RPC_BATCH_LIMIT } from "../lib/rpc-contracts";
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
 * One claimed address. Global records that the full address is taken and to whom;
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

export interface WorkstreamEmailAddressClaim extends WorkstreamEmailRouteInput {
  emailAddress: string;
}

export interface AutomationEmailAddressClaim extends AutomationEmailRouteInput {
  emailAddress: string;
}

export interface WorkstreamEmailRouterPing {
  region: "global";
  domain: string;
  addressIdentity?: "local_part" | "full_address";
  ownerAddressClaim?: "full_email_address";
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
  claim?(input: WorkstreamEmailAddressClaim): Promise<WorkstreamEmailRouterRpcResult<WorkstreamEmailRoute>>;
  reserveAutomation?(input: AutomationEmailRouteInput): Promise<WorkstreamEmailRouterRpcResult<AutomationEmailRoute>>;
  reserveAutomations?(inputs: AutomationEmailRouteInput[]): Promise<WorkstreamEmailRouterRpcResult<AutomationEmailRoute[]>>;
  claimAutomation?(input: AutomationEmailAddressClaim): Promise<WorkstreamEmailRouterRpcResult<AutomationEmailRoute>>;
}

interface RouteRow {
  email_address: string;
  address_source: "migration" | "allocator" | "owner";
  region: Region;
  workspace_id: string;
  workstream_id: string | null;
  automation_subscription_id: string | null;
}

interface LegacyRouteRow {
  local_part: string;
  region: Region;
  workspace_id: string;
  workstream_id: string | null;
  automation_subscription_id: string | null;
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

  async claim(input: WorkstreamEmailAddressClaim): Promise<WorkstreamEmailRoute> {
    this.assertRegionalOwner(input);
    if (this.env.AVALON_REGION !== "global") {
      const router = this.env.GLOBAL_EMAIL_ROUTER;
      if (router) {
        const capability = unwrapRpcResult(await router.ping()).ownerAddressClaim;
        if (capability === "full_email_address" && router.claim) {
          return unwrapRpcResult(await router.claim(input));
        }
        const legacy = unwrapRpcResult(await router.reserve(input));
        const claimed = this.parseStoredAddress(input.emailAddress);
        if (legacy.localPart.toLowerCase() === claimed.localPart) {
          // Rolling-deploy compatibility: the previous Global entrypoint has
          // no full-address claim method because its D1 key is still the local
          // part. regional deploys first, so preserve the regional owner's exact
          // address until Global and migration 0097 catch up.
          return { ...input, localPart: claimed.localPart, emailAddress: claimed.emailAddress };
        }
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.claimInGlobalRegistry(input);
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

  async claimAutomation(input: AutomationEmailAddressClaim): Promise<AutomationEmailRoute> {
    this.assertAutomationRegionalOwner(input);
    if (this.env.AVALON_REGION !== "global") {
      const router = this.env.GLOBAL_EMAIL_ROUTER;
      if (router) {
        const capability = unwrapRpcResult(await router.ping()).ownerAddressClaim;
        if (capability === "full_email_address" && router.claimAutomation) {
          return unwrapRpcResult(await router.claimAutomation(input));
        }
        if (!router.reserveAutomation) {
          throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
        }
        const legacy = unwrapRpcResult(await router.reserveAutomation(input));
        const claimed = this.parseStoredAddress(input.emailAddress);
        if (legacy.localPart.toLowerCase() === claimed.localPart) {
          return { ...input, localPart: claimed.localPart, emailAddress: claimed.emailAddress };
        }
      }
      throw new ApiError(503, "workstream_email_router_unavailable", "The Global email address registry is unavailable");
    }
    return this.claimAutomationInGlobalRegistry(input);
  }

  async ensureWorkstreamAddress(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
    this.assertRegionalOwner(input);
    const identity = createIdentityObjectPort(this.env, input.workspaceId, input.workstreamId);
    const current = await identity.identity();
    if (!current) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    const route = current.email_address
      ? await this.claim({ ...input, emailAddress: current.email_address })
      : await this.reserve(input);
    if (current.email_address && current.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
    }
    if (!current.email_address) {
      await identity.adoptEmailAddress({ emailAddress: route.emailAddress, now: Date.now() });
    }
    const stored = await identity.identity();
    if (!stored?.email_address || stored.email_address.toLowerCase() !== route.emailAddress.toLowerCase()) {
      throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
    }
    return route;
  }

  /**
   * The address, refused if the work stream is archived — the same test the
   * inbound resolver applies when a message actually arrives.
   *
   * The gate reads the work stream's own authority, which is what makes the
   * question answerable at all: `archived_at` left regional D1 with migration
   * 0090, and the statement this replaced had to be routed to the object to
   * find it. A statement sent to the wrong database failed with `no such
   * column` — after the address had already been reserved.
   */
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
    if (!await this.registryUsesFullAddresses()) {
      return this.reserveInLegacyGlobalRegistry(input);
    }
    return this.reserveInFullAddressGlobalRegistry(input);
  }

  private async reserveInFullAddressGlobalRegistry(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
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
      const emailAddress = `${localPart}@${this.emailDomain()}`;
      await this.env.DB.prepare(
        `INSERT INTO workstream_email_routes
         (email_address, address_source, region, workspace_id, workstream_id, created_at, updated_at)
         VALUES (?, 'allocator', ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(emailAddress, input.region, input.workspaceId, input.workstreamId, at, at).run();

      const reserved = await this.loadDestination(input);
      if (reserved) return this.mapRoute(reserved);
    }
    throw new ApiError(503, "workstream_email_address_exhausted", "A unique work-stream email address could not be reserved");
  }

  /** Called directly by the Global named RPC entrypoint. */
  async claimInGlobalRegistry(input: WorkstreamEmailAddressClaim): Promise<WorkstreamEmailRoute> {
    this.assertGlobalRegistry();
    if (!await this.registryUsesFullAddresses()) {
      return this.claimInLegacyGlobalRegistry(input);
    }
    return this.claimAddressInGlobalRegistry(input, "workstream");
  }

  /** Called directly by the Global named RPC entrypoint. */
  async reserveAutomationInGlobalRegistry(input: AutomationEmailRouteInput): Promise<AutomationEmailRoute> {
    this.assertGlobalRegistry();
    if (!await this.registryUsesFullAddresses()) {
      return this.reserveAutomationInLegacyGlobalRegistry(input);
    }
    return this.reserveAutomationInFullAddressGlobalRegistry(input);
  }

  private async reserveAutomationInFullAddressGlobalRegistry(
    input: AutomationEmailRouteInput,
  ): Promise<AutomationEmailRoute> {
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
      const emailAddress = `${localPart}@${this.emailDomain()}`;
      await this.env.DB.prepare(
        `INSERT INTO workstream_email_routes
         (email_address, address_source, region, workspace_id, workstream_id, automation_subscription_id,
          created_at, updated_at)
         VALUES (?, 'allocator', ?, ?, NULL, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(emailAddress, input.region, input.workspaceId, input.automationSubscriptionId, at, at).run();
      const reserved = await this.loadAutomationDestination(input);
      if (reserved) return this.mapAutomationRoute(reserved);
    }
    throw new ApiError(503, "workstream_email_address_exhausted", "A unique automation email address could not be reserved");
  }

  /** Called directly by the Global named RPC entrypoint. */
  async claimAutomationInGlobalRegistry(input: AutomationEmailAddressClaim): Promise<AutomationEmailRoute> {
    this.assertGlobalRegistry();
    if (!await this.registryUsesFullAddresses()) {
      return this.claimAutomationInLegacyGlobalRegistry(input);
    }
    return this.claimAddressInGlobalRegistry(input, "automation");
  }

  /** Called directly by the Global named RPC entrypoint. */
  async reserveAutomationsInGlobalRegistry(inputs: AutomationEmailRouteInput[]): Promise<AutomationEmailRoute[]> {
    this.assertGlobalRegistry();
    this.assertBulkSize(inputs);
    if (inputs.length === 0) return [];
    const fullAddressRegistry = await this.registryUsesFullAddresses();
    const routes: AutomationEmailRoute[] = [];
    for (const input of inputs) {
      routes.push(fullAddressRegistry
        ? await this.reserveAutomationInFullAddressGlobalRegistry(input)
        : await this.reserveAutomationInLegacyGlobalRegistry(input));
    }
    return routes;
  }

  /** Called directly by the Global named RPC entrypoint. */
  async reserveManyInGlobalRegistry(inputs: WorkstreamEmailRouteInput[]): Promise<WorkstreamEmailRoute[]> {
    this.assertGlobalRegistry();
    this.assertBulkSize(inputs);
    if (inputs.length === 0) return [];
    const fullAddressRegistry = await this.registryUsesFullAddresses();
    const routes: WorkstreamEmailRoute[] = [];
    // Serial execution keeps D1 pressure bounded. The service-binding call itself
    // is still one bulk invocation from the owning regional Worker, and the
    // rollout-era schema probe is shared by every item in that invocation.
    for (const input of inputs) {
      routes.push(fullAddressRegistry
        ? await this.reserveInFullAddressGlobalRegistry(input)
        : await this.reserveInLegacyGlobalRegistry(input));
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
    const fullAddressRegistry = await this.registryUsesFullAddresses();
    if (fullAddressRegistry) {
      await this.env.DB.prepare(
        "SELECT email_address FROM workstream_email_routes LIMIT 1",
      ).first<{ email_address: string }>();
    } else {
      await this.env.DB.prepare(
        "SELECT local_part FROM workstream_email_routes LIMIT 1",
      ).first<{ local_part: string }>();
    }
    return {
      region: "global",
      domain: this.emailDomain(),
      addressIdentity: fullAddressRegistry ? "full_address" : "local_part",
      // This describes the deployed RPC surface, independently of which side
      // of the Worker-first schema migration the Global database is on. A new
      // Global Worker can claim an owner's address against either schema.
      ownerAddressClaim: "full_email_address",
    };
  }

  private async registryUsesFullAddresses(): Promise<boolean> {
    const column = await this.env.DB.prepare(
      `SELECT name FROM pragma_table_info('workstream_email_routes')
       WHERE name = 'email_address'`,
    ).first<{ name: string }>();
    return column?.name === "email_address";
  }

  private async reserveInLegacyGlobalRegistry(input: WorkstreamEmailRouteInput): Promise<WorkstreamEmailRoute> {
    const existing = await this.loadLegacyDestination(input);
    if (existing) return this.mapLegacyRoute(existing);
    const at = nowIso();
    for (let attempt = 0; attempt < MAX_ADDRESS_RESERVATION_ATTEMPTS; attempt += 1) {
      const localPart = await allocateWorkstreamEmailAddressCandidate({
        secretKey: this.addressKey(),
        workstreamId: `${input.region}:${input.workspaceId}:${input.workstreamId}`,
        attempt,
      });
      await this.env.DB.prepare(
        `INSERT INTO workstream_email_routes
         (local_part, region, workspace_id, workstream_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(localPart, input.region, input.workspaceId, input.workstreamId, at, at).run();
      const reserved = await this.loadLegacyDestination(input);
      if (reserved) return this.mapLegacyRoute(reserved);
    }
    throw new ApiError(503, "workstream_email_address_exhausted", "A unique work-stream email address could not be reserved");
  }

  private async reserveAutomationInLegacyGlobalRegistry(
    input: AutomationEmailRouteInput,
  ): Promise<AutomationEmailRoute> {
    const existing = await this.loadLegacyAutomationDestination(input);
    if (existing) return this.mapLegacyAutomationRoute(existing);
    const at = nowIso();
    for (let attempt = 0; attempt < MAX_ADDRESS_RESERVATION_ATTEMPTS; attempt += 1) {
      const localPart = await allocateWorkstreamEmailAddressCandidate({
        secretKey: this.addressKey(),
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
      const reserved = await this.loadLegacyAutomationDestination(input);
      if (reserved) return this.mapLegacyAutomationRoute(reserved);
    }
    throw new ApiError(503, "workstream_email_address_exhausted", "A unique automation email address could not be reserved");
  }

  private async claimInLegacyGlobalRegistry(input: WorkstreamEmailAddressClaim): Promise<WorkstreamEmailRoute> {
    const claimed = this.parseStoredAddress(input.emailAddress);
    const existing = await this.loadLegacyDestination(input);
    if (existing) {
      if (existing.local_part.toLowerCase() !== claimed.localPart) {
        throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
      }
      return { ...input, localPart: claimed.localPart, emailAddress: claimed.emailAddress };
    }
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO workstream_email_routes
       (local_part, region, workspace_id, workstream_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(claimed.localPart, input.region, input.workspaceId, input.workstreamId, at, at).run();
    const reserved = await this.loadLegacyDestination(input);
    if (!reserved || reserved.local_part.toLowerCase() !== claimed.localPart) {
      throw new ApiError(409, "workstream_email_address_conflict", "The work stream already has a different email address");
    }
    return { ...input, localPart: claimed.localPart, emailAddress: claimed.emailAddress };
  }

  private async claimAutomationInLegacyGlobalRegistry(
    input: AutomationEmailAddressClaim,
  ): Promise<AutomationEmailRoute> {
    const claimed = this.parseStoredAddress(input.emailAddress);
    const existing = await this.loadLegacyAutomationDestination(input);
    if (existing) {
      if (existing.local_part.toLowerCase() !== claimed.localPart) {
        throw new ApiError(409, "sidekick_email_address_conflict", "The Sidekick already has a different email address");
      }
      return { ...input, localPart: claimed.localPart, emailAddress: claimed.emailAddress };
    }
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO workstream_email_routes
       (local_part, region, workspace_id, workstream_id, automation_subscription_id,
        created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(claimed.localPart, input.region, input.workspaceId, input.automationSubscriptionId, at, at).run();
    const reserved = await this.loadLegacyAutomationDestination(input);
    if (!reserved || reserved.local_part.toLowerCase() !== claimed.localPart) {
      throw new ApiError(409, "sidekick_email_address_conflict", "The Sidekick already has a different email address");
    }
    return { ...input, localPart: claimed.localPart, emailAddress: claimed.emailAddress };
  }

  private async loadLegacyDestination(input: WorkstreamEmailRouteInput): Promise<LegacyRouteRow | null> {
    return this.env.DB.prepare(
      `SELECT local_part, region, workspace_id, workstream_id, automation_subscription_id
       FROM workstream_email_routes
       WHERE region = ? AND workspace_id = ? AND workstream_id = ?
         AND automation_subscription_id IS NULL`,
    ).bind(input.region, input.workspaceId, input.workstreamId).first<LegacyRouteRow>();
  }

  private async loadLegacyAutomationDestination(input: AutomationEmailRouteInput): Promise<LegacyRouteRow | null> {
    return this.env.DB.prepare(
      `SELECT local_part, region, workspace_id, workstream_id, automation_subscription_id
       FROM workstream_email_routes
       WHERE region = ? AND workspace_id = ? AND workstream_id IS NULL
         AND automation_subscription_id = ?`,
    ).bind(input.region, input.workspaceId, input.automationSubscriptionId).first<LegacyRouteRow>();
  }

  private mapLegacyRoute(row: LegacyRouteRow): WorkstreamEmailRoute {
    if (!row.workstream_id || row.automation_subscription_id) {
      throw new ApiError(500, "workstream_email_route_invalid", "The work-stream email route is invalid");
    }
    return {
      localPart: row.local_part,
      emailAddress: `${row.local_part}@${this.emailDomain()}`,
      region: row.region,
      workspaceId: row.workspace_id,
      workstreamId: row.workstream_id,
    };
  }

  private mapLegacyAutomationRoute(row: LegacyRouteRow): AutomationEmailRoute {
    if (!row.automation_subscription_id || row.workstream_id) {
      throw new ApiError(500, "sidekick_email_route_invalid", "The Sidekick email route is invalid");
    }
    return {
      localPart: row.local_part,
      emailAddress: `${row.local_part}@${this.emailDomain()}`,
      region: row.region,
      workspaceId: row.workspace_id,
      automationSubscriptionId: row.automation_subscription_id,
    };
  }

  private async claimAddressInGlobalRegistry(
    input: WorkstreamEmailAddressClaim,
    kind: "workstream",
  ): Promise<WorkstreamEmailRoute>;
  private async claimAddressInGlobalRegistry(
    input: AutomationEmailAddressClaim,
    kind: "automation",
  ): Promise<AutomationEmailRoute>;
  private async claimAddressInGlobalRegistry(
    input: WorkstreamEmailAddressClaim | AutomationEmailAddressClaim,
    kind: "workstream" | "automation",
  ): Promise<WorkstreamEmailRoute | AutomationEmailRoute> {
    const emailAddress = this.normalizeClaimedAddress(input.emailAddress);
    const load = () => kind === "workstream"
      ? this.loadDestination(input as WorkstreamEmailAddressClaim)
      : this.loadAutomationDestination(input as AutomationEmailAddressClaim);
    let existing = await load();
    if (existing?.address_source === "migration") {
      await this.env.DB.prepare(
        `UPDATE OR IGNORE workstream_email_routes
         SET email_address = ?, address_source = 'owner', updated_at = ?
         WHERE region = ? AND workspace_id = ?
           AND ${kind === "workstream"
            ? "workstream_id = ? AND automation_subscription_id IS NULL"
            : "workstream_id IS NULL AND automation_subscription_id = ?"}
           AND address_source = 'migration'`,
      ).bind(
        emailAddress,
        nowIso(),
        input.region,
        input.workspaceId,
        kind === "workstream"
          ? (input as WorkstreamEmailAddressClaim).workstreamId
          : (input as AutomationEmailAddressClaim).automationSubscriptionId,
      ).run();
      existing = await load();
    }

    if (!existing) {
      const at = nowIso();
      if (kind === "workstream") {
        const workstream = input as WorkstreamEmailAddressClaim;
        await this.env.DB.prepare(
          `INSERT INTO workstream_email_routes
           (email_address, address_source, region, workspace_id, workstream_id, created_at, updated_at)
           VALUES (?, 'owner', ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).bind(emailAddress, workstream.region, workstream.workspaceId, workstream.workstreamId, at, at).run();
      } else {
        const automation = input as AutomationEmailAddressClaim;
        await this.env.DB.prepare(
          `INSERT INTO workstream_email_routes
           (email_address, address_source, region, workspace_id, workstream_id,
            automation_subscription_id, created_at, updated_at)
           VALUES (?, 'owner', ?, ?, NULL, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).bind(
          emailAddress,
          automation.region,
          automation.workspaceId,
          automation.automationSubscriptionId,
          at,
          at,
        ).run();
      }
      existing = await load();
    }

    if (!existing || existing.email_address.toLowerCase() !== emailAddress) {
      throw new ApiError(
        409,
        kind === "workstream" ? "workstream_email_address_conflict" : "sidekick_email_address_conflict",
        kind === "workstream"
          ? "The work stream already has a different email address"
          : "The automation already has a different email address",
      );
    }
    return kind === "workstream" ? this.mapRoute(existing) : this.mapAutomationRoute(existing);
  }

  private async loadDestination(input: WorkstreamEmailRouteInput): Promise<RouteRow | null> {
    return this.env.DB.prepare(
      `SELECT email_address, address_source, region, workspace_id, workstream_id, automation_subscription_id
       FROM workstream_email_routes
       WHERE region = ? AND workspace_id = ? AND workstream_id = ?
         AND automation_subscription_id IS NULL`,
    ).bind(input.region, input.workspaceId, input.workstreamId).first<RouteRow>();
  }

  private async loadAutomationDestination(input: AutomationEmailRouteInput): Promise<RouteRow | null> {
    return this.env.DB.prepare(
      `SELECT email_address, address_source, region, workspace_id, workstream_id, automation_subscription_id
       FROM workstream_email_routes
       WHERE region = ? AND workspace_id = ? AND workstream_id IS NULL
         AND automation_subscription_id = ?`,
    ).bind(input.region, input.workspaceId, input.automationSubscriptionId).first<RouteRow>();
  }

  private mapRoute(row: RouteRow): WorkstreamEmailRoute {
    if (!row.workstream_id || row.automation_subscription_id) {
      throw new ApiError(500, "workstream_email_route_invalid", "The work-stream email route is invalid");
    }
    const { emailAddress, localPart } = this.parseStoredAddress(row.email_address);
    return {
      localPart,
      emailAddress,
      region: row.region,
      workspaceId: row.workspace_id,
      workstreamId: row.workstream_id,
    };
  }

  private mapAutomationRoute(row: RouteRow): AutomationEmailRoute {
    if (!row.automation_subscription_id || row.workstream_id) {
      throw new ApiError(500, "sidekick_email_route_invalid", "The Sidekick email route is invalid");
    }
    const { emailAddress, localPart } = this.parseStoredAddress(row.email_address);
    return {
      localPart,
      emailAddress,
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

  private normalizeClaimedAddress(value: string): string {
    return this.parseStoredAddress(value.trim().toLowerCase()).emailAddress;
  }

  private parseStoredAddress(value: string): { emailAddress: string; localPart: string } {
    const emailAddress = value.trim().toLowerCase();
    const separator = emailAddress.lastIndexOf("@");
    const localPart = emailAddress.slice(0, separator);
    const domain = emailAddress.slice(separator + 1);
    if (
      emailAddress.length > 254
      || !/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u.test(localPart)
      || !/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(domain)
    ) {
      throw new ApiError(500, "workstream_email_route_invalid", "The stored email route is invalid");
    }
    return { emailAddress, localPart };
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
      throw new ApiError(422, "sidekick_email_region_mismatch", "The Sidekick belongs to a different data region");
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
