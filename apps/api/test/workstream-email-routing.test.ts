import "../../../tests/isolated-region";
import { describe, expect, it, vi } from "vitest";
import type { Region } from "@rally/contracts";
import type { Env } from "../src/env";
import type { ApiError } from "../src/lib/api-error";
import { allocateWorkstreamEmailAddressCandidate } from "../src/lib/workstream-email-address";
import {
  WorkstreamEmailRoutingService,
  type GlobalWorkstreamEmailRouterRpcBinding,
  type AutomationEmailRoute,
  type AutomationEmailRouteInput,
  type WorkstreamEmailRouterRpcResult,
} from "../src/services/workstream-email-routing-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const ADDRESS_KEY = "avalon-workstream-routing-test-key-v1";
const DOMAIN = "automation.with-avalon.com";
const CURRENT_DOMAIN = "automation.rallywith.ai";

interface RouteRow {
  email_address: string;
  address_source: "migration" | "allocator" | "owner";
  region: Region;
  workspace_id: string;
  workstream_id: string | null;
  automation_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalAutomationRow {
  id: string;
  workspace_id: string;
  email_address: string | null;
  status: "active" | "paused";
  lifecycle_state: "visible" | "archived" | "deleted";
  updated_at: string;
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: FakeDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.sql, this.values) as T | null;
  }

  async run<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.run(this.sql, this.values));
  }
}

class FakeDatabase {
  readonly routes: RouteRow[] = [];
  fullAddressRegistry = true;
  readonly automations: LocalAutomationRow[] = [];
  routeInsertAttempts = 0;
  registrySchemaProbes = 0;

  prepare(sql: string): D1PreparedStatement {
    return createTestD1PreparedStatement(new FakeStatement(this, sql));
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  first(sql: string, values: unknown[]): RouteRow | LocalAutomationRow | null {
    if (sql.includes("pragma_table_info('workstream_email_routes')")) {
      this.registrySchemaProbes += 1;
      return this.fullAddressRegistry ? { name: "email_address" } as unknown as RouteRow : null;
    }
    if (sql.includes("FROM automation_subscriptions WHERE id = ? AND workspace_id = ?")) {
      const [automationId, workspaceId] = values.map(String);
      return this.automations.find((row) =>
        row.id === automationId && row.workspace_id === workspaceId) ?? null;
    }
    if (sql.includes("FROM workstream_email_routes") && sql.includes("LIMIT 1")) {
      return this.routes[0] ?? null;
    }
    if (sql.includes("FROM workstream_email_routes") && sql.includes("WHERE region = ?")) {
      if (sql.includes("automation_subscription_id = ?")) {
        const [region, workspaceId, automationSubscriptionId] = values.map(String);
        const row = this.routes.find((candidate) =>
          candidate.region === region
          && candidate.workspace_id === workspaceId
          && candidate.workstream_id === null
          && candidate.automation_subscription_id === automationSubscriptionId) ?? null;
        return row && !this.fullAddressRegistry
          ? { ...row, local_part: row.email_address.slice(0, row.email_address.lastIndexOf("@")) } as unknown as RouteRow
          : row;
      }
      const [region, workspaceId, workstreamId] = values.map(String);
      const row = this.routes.find((candidate) =>
        candidate.region === region
        && candidate.workspace_id === workspaceId
        && candidate.workstream_id === workstreamId) ?? null;
      return row && !this.fullAddressRegistry
        ? { ...row, local_part: row.email_address.slice(0, row.email_address.lastIndexOf("@")) } as unknown as RouteRow
        : row;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  run(sql: string, values: unknown[]): D1Result {
    if (sql.includes("INSERT INTO workstream_email_routes")) {
      this.routeInsertAttempts += 1;
      const [storedIdentity, region, workspaceId, ownerId, createdAt, updatedAt] = values.map(String);
      const emailAddress = this.fullAddressRegistry ? storedIdentity : `${storedIdentity}@${DOMAIN}`;
      const automation = sql.includes("automation_subscription_id") && sql.includes("NULL, ?");
      const workstreamId = automation ? null : ownerId!;
      const automationSubscriptionId = automation ? ownerId! : null;
      const addressTaken = this.routes.some((row) =>
        row.email_address.toLowerCase() === emailAddress!.toLowerCase());
      const destinationTaken = this.routes.some((row) =>
        row.region === region
        && row.workspace_id === workspaceId
        && row.workstream_id === workstreamId
        && row.automation_subscription_id === automationSubscriptionId);
      if (addressTaken || destinationTaken) return result(0);
      this.routes.push({
        email_address: emailAddress!,
        address_source: sql.includes("'owner'") ? "owner" : "allocator",
        region: region as Region,
        workspace_id: workspaceId!,
        workstream_id: workstreamId!,
        automation_subscription_id: automationSubscriptionId,
        created_at: createdAt!,
        updated_at: updatedAt!,
      });
      return result(1);
    }
    if (sql.includes("UPDATE OR IGNORE workstream_email_routes")) {
      const [emailAddress, updatedAt, region, workspaceId, ownerId] = values.map(String);
      const automation = sql.includes("automation_subscription_id = ?");
      const row = this.routes.find((candidate) =>
        candidate.region === region
        && candidate.workspace_id === workspaceId
        && candidate.address_source === "migration"
        && (automation
          ? candidate.automation_subscription_id === ownerId
          : candidate.workstream_id === ownerId));
      if (!row || this.routes.some((candidate) =>
        candidate !== row && candidate.email_address.toLowerCase() === emailAddress!.toLowerCase())) return result(0);
      row.email_address = emailAddress!;
      row.address_source = "owner";
      row.updated_at = updatedAt!;
      return result(1);
    }
    if (sql.includes("UPDATE automation_subscriptions") && sql.includes("SET email_address = ?")) {
      const [emailAddress, updatedAt, automationId, workspaceId] = values.map(String);
      const automation = this.automations.find((row) =>
        row.id === automationId && row.workspace_id === workspaceId && row.email_address == null);
      if (!automation) return result(0);
      automation.email_address = emailAddress!;
      automation.updated_at = updatedAt!;
      return result(1);
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

describe("WorkstreamEmailRoutingService", () => {
  it("reserves one stable four-segment address idempotently", async () => {
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database, {
      WORKSTREAM_EMAIL_DOMAIN: `  ${DOMAIN.toUpperCase()}  `,
    }));
    const input = routeInput("sidekick-stable");

    const first = await service.reserveAutomation(input);
    const second = await service.reserveAutomation(input);

    expect(second).toEqual(first);
    expect(first.emailAddress).toBe(`${first.localPart}@${DOMAIN}`);
    expect(first.localPart).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u);
    expect(first.localPart.split("-")).toHaveLength(4);
    // The row is the claim and nothing else. Anything resembling a lifecycle
    // here would be a second copy of what the owner's own row already says.
    expect(Object.keys(database.routes[0]!)).toEqual([
      "email_address",
      "address_source",
      "region",
      "workspace_id",
      "workstream_id",
      "automation_subscription_id",
      "created_at",
      "updated_at",
    ]);
    expect(database.routes).toHaveLength(1);
    expect(database.routeInsertAttempts).toBe(1);
  });

  it("preserves an automation's stored legacy domain and verifies the migrated Global claim", async () => {
    const database = new FakeDatabase();
    const input = {
      region: "global" as const,
      workspaceId: "workspace-legacy-automation",
      automationSubscriptionId: "automation-legacy-address",
    };
    const legacyAddress = `crisp-calibrated-arctic-kuiper@${DOMAIN}`;
    database.routes.push({
      email_address: legacyAddress,
      address_source: "migration",
      region: "global",
      workspace_id: input.workspaceId,
      workstream_id: null,
      automation_subscription_id: input.automationSubscriptionId,
      created_at: "2026-08-06T04:46:44.006Z",
      updated_at: "2026-08-06T04:46:44.006Z",
    });
    database.automations.push({
      id: input.automationSubscriptionId,
      workspace_id: input.workspaceId,
      email_address: legacyAddress,
      status: "active",
      lifecycle_state: "visible",
      updated_at: "2026-08-06T04:46:44.006Z",
    });
    const service = new WorkstreamEmailRoutingService(environment(database, {
      WORKSTREAM_EMAIL_DOMAIN: CURRENT_DOMAIN,
    }));

    await expect(service.claimAutomation({ ...input, emailAddress: legacyAddress })).resolves.toEqual({
      ...input,
      localPart: "crisp-calibrated-arctic-kuiper",
      emailAddress: legacyAddress,
    });
    expect(database.routes[0]).toMatchObject({
      email_address: legacyAddress,
      address_source: "owner",
    });
    expect(database.routeInsertAttempts).toBe(0);
  });

  it("preserves the owner's full address while the Worker-first migration is still pending", async () => {
    const database = new FakeDatabase();
    database.fullAddressRegistry = false;
    const input = {
      region: "global" as const,
      workspaceId: "workspace-worker-first",
      automationSubscriptionId: "automation-worker-first",
    };
    const legacyAddress = `crisp-calibrated-arctic-kuiper@${DOMAIN}`;
    database.routes.push({
      email_address: legacyAddress,
      address_source: "allocator",
      region: "global",
      workspace_id: input.workspaceId,
      workstream_id: null,
      automation_subscription_id: input.automationSubscriptionId,
      created_at: "2026-08-06T04:46:44.006Z",
      updated_at: "2026-08-06T04:46:44.006Z",
    });
    database.automations.push({
      id: input.automationSubscriptionId,
      workspace_id: input.workspaceId,
      email_address: legacyAddress,
      status: "active",
      lifecycle_state: "visible",
      updated_at: "2026-08-06T04:46:44.006Z",
    });
    const service = new WorkstreamEmailRoutingService(environment(database, {
      WORKSTREAM_EMAIL_DOMAIN: CURRENT_DOMAIN,
    }));

    await expect(service.claimAutomation({ ...input, emailAddress: legacyAddress })).resolves.toMatchObject({
      emailAddress: legacyAddress,
    });
  });

  it("uses owner-claim RPCs after the new Global Worker deploys but before migration 0097", async () => {
    const globalDatabase = new FakeDatabase();
    globalDatabase.fullAddressRegistry = false;
    const globalService = new WorkstreamEmailRoutingService(environment(globalDatabase, {
      WORKSTREAM_EMAIL_DOMAIN: CURRENT_DOMAIN,
    }));
    const reserveAutomation = vi.fn(async (input) => success(
      await globalService.reserveAutomationInGlobalRegistry(input),
    ));
    const claimAutomation = vi.fn(async (input) => success(
      await globalService.claimAutomationInGlobalRegistry(input),
    ));
    const binding: GlobalWorkstreamEmailRouterRpcBinding = {
      ping: async () => success(await globalService.pingGlobalRegistry()),
      reserveAutomation,
      claimAutomation,
    };
    const enterpriseService = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "enterprise",
      APP_ENV: "production",
      GLOBAL_EMAIL_ROUTER: binding,
    }));
    const input = {
      region: "enterprise" as const,
      workspaceId: "workspace-enterprise-worker-first",
      automationSubscriptionId: "automation-enterprise-worker-first",
      emailAddress: `crisp-calibrated-arctic-kuiper@${DOMAIN}`,
    };

    await expect(enterpriseService.claimAutomation(input)).resolves.toMatchObject({
      ...input,
      localPart: "crisp-calibrated-arctic-kuiper",
    });
    expect(claimAutomation).toHaveBeenCalledExactlyOnceWith(input);
    expect(reserveAutomation).not.toHaveBeenCalled();
    expect(globalDatabase.routes).toEqual([
      expect.objectContaining({
        email_address: input.emailAddress,
        region: "enterprise",
        automation_subscription_id: input.automationSubscriptionId,
      }),
    ]);
  });

  it("allows the same local part on another domain without advancing the allocator", async () => {
    const database = new FakeDatabase();
    const input = routeInput("sidekick-domain-scoped-collision");
    const firstCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: `${input.region}:${input.workspaceId}:automation:${input.automationSubscriptionId}`,
      attempt: 0,
    });
    database.routes.push({
      ...existingRoute(firstCandidate, "custom-workspace", "custom-workstream"),
      email_address: `${firstCandidate}@customer.example`,
    });
    const service = new WorkstreamEmailRoutingService(environment(database, {
      WORKSTREAM_EMAIL_DOMAIN: CURRENT_DOMAIN,
    }));

    await expect(service.reserveAutomation(input)).resolves.toMatchObject({
      localPart: firstCandidate,
      emailAddress: `${firstCandidate}@${CURRENT_DOMAIN}`,
    });
    expect(database.routeInsertAttempts).toBe(1);
    expect(database.routes).toHaveLength(2);
  });

  it("retries the deterministic candidate sequence after a global collision", async () => {
    const database = new FakeDatabase();
    const input = routeInput("sidekick-collision");
    const allocatorId = `${input.region}:${input.workspaceId}:automation:${input.automationSubscriptionId}`;
    const firstCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: allocatorId,
      attempt: 0,
    });
    const secondCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: allocatorId,
      attempt: 1,
    });
    database.routes.push(existingRoute(firstCandidate, "other-workspace", "other-workstream"));

    const reserved = await new WorkstreamEmailRoutingService(environment(database)).reserveAutomation(input);

    expect(reserved.localPart).toBe(secondCandidate);
    expect(reserved.localPart).not.toBe(firstCandidate);
    expect(database.routeInsertAttempts).toBe(2);
    expect(database.routes).toHaveLength(2);
  });

  it("uses the one Global namespace when an enterprise candidate collides with a Global route", async () => {
    const globalDatabase = new FakeDatabase();
    const globalService = new WorkstreamEmailRoutingService(environment(globalDatabase));
    const enterpriseInput = routeInput("sidekick-cross-region-collision", "enterprise");
    const allocatorId = `${enterpriseInput.region}:${enterpriseInput.workspaceId}:automation:${enterpriseInput.automationSubscriptionId}`;
    const firstCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: allocatorId,
      attempt: 0,
    });
    const secondCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: allocatorId,
      attempt: 1,
    });
    globalDatabase.routes.push(existingRoute(
      firstCandidate,
      "global-workspace",
      "global-workstream",
    ));
    const binding: GlobalWorkstreamEmailRouterRpcBinding = {
      ping: async () => success(await globalService.pingGlobalRegistry()),
      reserveAutomation: async (input) => success(await globalService.reserveAutomationInGlobalRegistry(input)),
      reserveAutomations: async (inputs) => success(await globalService.reserveAutomationsInGlobalRegistry(inputs)),
      claimAutomation: async (input) => success(await globalService.claimAutomationInGlobalRegistry(input)),
    };
    const enterpriseDatabase = new FakeDatabase();
    const enterpriseService = new WorkstreamEmailRoutingService(environment(enterpriseDatabase, {
      AVALON_REGION: "enterprise",
      APP_ENV: "production",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    const reserved = await enterpriseService.reserveAutomation(enterpriseInput);

    expect(reserved).toMatchObject({
      region: "enterprise",
      localPart: secondCandidate,
      emailAddress: `${secondCandidate}@${DOMAIN}`,
    });
    expect(reserved.localPart).not.toBe(firstCandidate);
    expect(globalDatabase.routes).toHaveLength(2);
    expect(globalDatabase.routeInsertAttempts).toBe(2);
    expect(enterpriseDatabase.routes).toHaveLength(0);
    expect(enterpriseDatabase.routeInsertAttempts).toBe(0);
  });

  it("keeps a retired Thread's stored address out of a Sidekick's allocation on one domain", async () => {
    const database = new FakeDatabase();
    const input = {
      region: "global" as const,
      workspaceId: "workspace-automation",
      automationSubscriptionId: "automation-cross-kind-collision",
    };
    const allocatorId = `${input.region}:${input.workspaceId}:automation:${input.automationSubscriptionId}`;
    const firstCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: allocatorId,
      attempt: 0,
    });
    const secondCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: allocatorId,
      attempt: 1,
    });
    database.routes.push(existingRoute(firstCandidate, "existing-workspace", "existing-workstream"));

    const route = await new WorkstreamEmailRoutingService(environment(database))
      .reserveAutomation(input);

    expect(route).toMatchObject({
      ...input,
      localPart: secondCandidate,
    });
    expect(route.localPart).not.toBe(firstCandidate);
    expect(database.routes).toHaveLength(2);
    expect(database.routes[1]).toMatchObject({
      workstream_id: null,
      automation_subscription_id: input.automationSubscriptionId,
    });
  });

  it("keeps a claimed address after its owner stops using it", async () => {
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database));
    const input = routeInput("sidekick-tombstone");
    const reserved = await service.reserveAutomation(input);

    // Nothing releases a claim — there is no call that could. Asking again for
    // the same destination returns the same name rather than minting another.
    await expect(service.reserveAutomation(input)).resolves.toMatchObject({
      localPart: reserved.localPart,
      emailAddress: reserved.emailAddress,
    });
    expect(database.routes).toHaveLength(1);
  });

  it("never recycles a claimed full address for a different destination", async () => {
    const database = new FakeDatabase();
    const input = routeInput("sidekick-after-tombstone");
    const allocatorId = `${input.region}:${input.workspaceId}:automation:${input.automationSubscriptionId}`;
    const tombstonedCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: allocatorId,
      attempt: 0,
    });
    const nextCandidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: ADDRESS_KEY,
      workstreamId: allocatorId,
      attempt: 1,
    });
    database.routes.push(existingRoute(
      tombstonedCandidate,
      "retired-workspace",
      "retired-workstream",
    ));
    const service = new WorkstreamEmailRoutingService(environment(database));

    const reserved = await service.reserveAutomation(input);

    expect(reserved.localPart).toBe(nextCandidate);
    expect(database.routes).toHaveLength(2);
    expect(database.routes[0]).toMatchObject({
      email_address: `${tombstonedCandidate}@${DOMAIN}`,
      workspace_id: "retired-workspace",
      workstream_id: "retired-workstream",
    });
  });

  it("delegates enterprise reservations and status changes to the Global RPC binding", async () => {
    const input = routeInput("sidekick-enterprise", "enterprise");
    const route = {
      ...input,
      localPart: "bright-steady-clear-otter",
      emailAddress: `bright-steady-clear-otter@${DOMAIN}`,
    };
    const ping = vi.fn(async () => success({ region: "global" as const, domain: DOMAIN }));
    const reserve = vi.fn(async () => success(route));
    const reserveMany = vi.fn(async () => success([route]));
    const binding: GlobalWorkstreamEmailRouterRpcBinding = { ping, reserveAutomation: reserve, reserveAutomations: reserveMany };
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database, {
      AVALON_REGION: "enterprise",
      APP_ENV: "production",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    await expect(service.reserveAutomation(input)).resolves.toEqual(route);
    expect(reserve).toHaveBeenCalledExactlyOnceWith(input);
    expect(database.routeInsertAttempts).toBe(0);
  });

  it("uses one Global RPC invocation for an enterprise bulk reservation", async () => {
    const inputs = [
      routeInput("sidekick-enterprise-bulk-1", "enterprise"),
      routeInput("sidekick-enterprise-bulk-2", "enterprise"),
      routeInput("sidekick-enterprise-bulk-3", "enterprise"),
    ];
    const routes = inputs.map((input, index): AutomationEmailRoute => ({
      ...input,
      localPart: `bright-steady-clear-animal${index}`,
      emailAddress: `bright-steady-clear-animal${index}@${DOMAIN}`,
    }));
    const reserve = vi.fn(async () => success(routes[0]!));
    const reserveMany = vi.fn(async () => success(routes));
    const binding = {
      ping: vi.fn(async () => success({ region: "global" as const, domain: DOMAIN })),
      reserveAutomation: reserve,
      reserveAutomations: reserveMany,
    } satisfies GlobalWorkstreamEmailRouterRpcBinding;
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database, {
      AVALON_REGION: "enterprise",
      APP_ENV: "production",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    await expect(service.reserveAutomations(inputs)).resolves.toEqual(routes);

    expect(reserveMany).toHaveBeenCalledExactlyOnceWith(inputs);
    expect(reserve).not.toHaveBeenCalled();
    expect(database.routeInsertAttempts).toBe(0);
  });

  it("probes the registry schema once per Global bulk reservation", async () => {
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database));
    const sidekicks = [
      routeInput("sidekick-global-bulk-1"),
      routeInput("sidekick-global-bulk-2"),
      routeInput("sidekick-global-bulk-3"),
    ];

    await expect(service.reserveAutomationsInGlobalRegistry(sidekicks)).resolves.toHaveLength(3);
    expect(database.registrySchemaProbes).toBe(1);

    await expect(service.reserveAutomationsInGlobalRegistry([
      { region: "global", workspaceId: "workspace-1", automationSubscriptionId: "automation-bulk-1" },
      { region: "global", workspaceId: "workspace-1", automationSubscriptionId: "automation-bulk-2" },
    ])).resolves.toHaveLength(2);
    expect(database.registrySchemaProbes).toBe(2);
  });

  it("reconstructs expected Global RPC errors as ApiError instances", async () => {
    const input = routeInput("sidekick-enterprise-rpc-error", "enterprise");
    const binding = {
      ping: vi.fn(async () => success({ region: "global" as const, domain: DOMAIN })),
      reserveAutomation: vi.fn(async () => failure(503, "workstream_email_key_unavailable", "The registry key is unavailable")),
      reserveAutomations: vi.fn(async () => failure(503, "workstream_email_key_unavailable", "The registry key is unavailable")),
    } satisfies GlobalWorkstreamEmailRouterRpcBinding;
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "enterprise",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    await expect(service.reserveAutomation(input)).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "workstream_email_key_unavailable",
      message: "The registry key is unavailable",
    });
    await expect(service.reserveAutomations([input])).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "workstream_email_key_unavailable",
    });
  });

  it("pings the live Global registry through the named RPC binding", async () => {
    const ping = vi.fn(async () => success({ region: "global" as const, domain: DOMAIN }));
    const binding = {
      ping,
      reserveAutomation: vi.fn(),
      reserveAutomations: vi.fn(),
    } satisfies GlobalWorkstreamEmailRouterRpcBinding;
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "enterprise",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    await expect(service.ping()).resolves.toEqual({ region: "global", domain: DOMAIN });
    expect(ping).toHaveBeenCalledOnce();
  });

  it("rejects an undersized Global allocator key during readiness", async () => {
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      APP_ENV: "production",
      WORKSTREAM_EMAIL_ADDRESS_KEY: "too-short",
    }));

    await expect(service.ping()).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_key_invalid",
    } satisfies Partial<ApiError>);
  });

  it.each(["development", "test", "staging", "production"] as const)(
    "fails closed when an enterprise Worker in %s has no Global registry binding",
    async (appEnv) => {
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "enterprise",
      APP_ENV: appEnv,
    }));

    await expect(service.reserveAutomation(routeInput("sidekick-unrouted", "enterprise"))).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_router_unavailable",
    } satisfies Partial<ApiError>);
    await expect(service.reserveAutomations([
      routeInput("sidekick-unrouted-bulk", "enterprise"),
    ])).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_router_unavailable",
    } satisfies Partial<ApiError>);
    },
  );

  it("rejects direct registry allocation outside the Global Worker", async () => {
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "enterprise",
    }));

    await expect(service.reserveAutomationInGlobalRegistry(
      routeInput("sidekick-regional-registry", "enterprise"),
    )).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_registry_region_invalid",
    } satisfies Partial<ApiError>);
    await expect(service.reserveAutomationsInGlobalRegistry([
      routeInput("sidekick-regional-registry-bulk", "enterprise"),
    ])).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_registry_region_invalid",
    } satisfies Partial<ApiError>);
  });

  it("rejects reservations for a Sidekick from another regional data plane", async () => {
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase()));

    await expect(service.reserveAutomation(routeInput("sidekick-wrong-region", "enterprise"))).rejects.toMatchObject({
      status: 422,
      code: "sidekick_email_region_mismatch",
    } satisfies Partial<ApiError>);
  });
});

/**
 * Real UUIDs, keyed by a readable label, so the assertions read by the label
 * while the wire form stays a valid id.
 */
const routeIds = new Map<string, string>();
function routeId(label: string): string {
  const existing = routeIds.get(label);
  if (existing) return existing;
  const id = `00000000-0000-7000-8000-${String(routeIds.size + 1).padStart(12, "0")}`;
  routeIds.set(label, id);
  return id;
}

const WORKSPACE_UUID = "00000000-0000-7000-8000-0000000000ff";

function routeInput(automationId: string, region: Region = "global"): AutomationEmailRouteInput {
  return {
    region,
    workspaceId: WORKSPACE_UUID,
    automationSubscriptionId: routeId(automationId),
  };
}

function existingRoute(
  localPart: string,
  workspaceId: string,
  workstreamId: string,
): RouteRow {
  return {
    email_address: `${localPart}@${DOMAIN}`,
    address_source: "allocator",
    region: "global",
    workspace_id: workspaceId,
    workstream_id: workstreamId,
    automation_subscription_id: null,
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
  };
}

function environment(database: FakeDatabase, overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: createTestD1Database(database),
    SESSION_SIGNING_KEY: "s".repeat(32),
    WORKSTREAM_EMAIL_ADDRESS_KEY: ADDRESS_KEY,
    WORKSTREAM_EMAIL_DOMAIN: DOMAIN,
    ...overrides,
  });
}

function result<T>(changes: number, results: T[] = []): D1Result<T> {
  return createTestD1Result<T>({
    success: true,
    results,
    meta: { changes },
  });
}

function success<T>(value: T): WorkstreamEmailRouterRpcResult<T> {
  return { ok: true, value };
}

function failure(
  status: ApiError["status"],
  code: string,
  message: string,
): WorkstreamEmailRouterRpcResult<never> {
  return { ok: false, error: { status, code, message } };
}
