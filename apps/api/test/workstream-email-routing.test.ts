import { describe, expect, it, vi } from "vitest";
import type { Region } from "@avalon/contracts";
import type { Env } from "../src/env";
import type { ApiError } from "../src/lib/api-error";
import { allocateWorkstreamEmailAddressCandidate } from "../src/lib/workstream-email-address";
import {
  WorkstreamEmailRoutingService,
  type GlobalWorkstreamEmailRouterRpcBinding,
  type WorkstreamEmailRoute,
  type WorkstreamEmailRouteInput,
  type WorkstreamEmailRouterRpcResult,
} from "../src/services/workstream-email-routing-service";

const ADDRESS_KEY = "avalon-workstream-routing-test-key-v1";
const DOMAIN = "automation.with-avalon.com";

interface RouteRow {
  local_part: string;
  region: Region;
  workspace_id: string;
  workstream_id: string | null;
  automation_subscription_id: string | null;
  status: "reserved" | "active" | "disabled";
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

interface LocalWorkstreamRow {
  id: string;
  workspace_id: string;
  email_address: string | null;
  email_route_status: RouteRow["status"];
  archived_at: string | null;
  updated_at: string;
}

interface LocalAutomationRow {
  id: string;
  workspace_id: string;
  email_address: string | null;
  email_route_status: RouteRow["status"];
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
    return this.database.run(this.sql, this.values) as D1Result<T>;
  }
}

class FakeDatabase {
  readonly routes: RouteRow[] = [];
  readonly workstreams: LocalWorkstreamRow[] = [];
  readonly automations: LocalAutomationRow[] = [];
  routeInsertAttempts = 0;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<D1Result[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  first(sql: string, values: unknown[]): RouteRow | LocalWorkstreamRow | LocalAutomationRow | null {
    if (sql.includes("FROM workstreams WHERE id = ? AND workspace_id = ?")) {
      const [workstreamId, workspaceId] = values.map(String);
      return this.workstreams.find((row) =>
        row.id === workstreamId && row.workspace_id === workspaceId) ?? null;
    }
    if (sql.includes("FROM automation_subscriptions WHERE id = ? AND workspace_id = ?")) {
      const [automationId, workspaceId] = values.map(String);
      return this.automations.find((row) =>
        row.id === automationId && row.workspace_id === workspaceId) ?? null;
    }
    if (sql.includes("FROM workstream_email_routes") && sql.includes("LIMIT 1")) {
      return this.routes[0] ?? null;
    }
    if (sql.includes("FROM workstream_email_routes") && sql.includes("WHERE local_part = ?")) {
      const localPart = String(values[0]).toLowerCase();
      return this.routes.find((row) =>
        row.local_part.toLowerCase() === localPart && row.status === "active") ?? null;
    }
    if (sql.includes("FROM workstream_email_routes") && sql.includes("WHERE region = ?")) {
      if (sql.includes("automation_subscription_id = ?")) {
        const [region, workspaceId, automationSubscriptionId] = values.map(String);
        return this.routes.find((row) =>
          row.region === region
          && row.workspace_id === workspaceId
          && row.workstream_id === null
          && row.automation_subscription_id === automationSubscriptionId) ?? null;
      }
      const [region, workspaceId, workstreamId] = values.map(String);
      return this.routes.find((row) =>
        row.region === region
        && row.workspace_id === workspaceId
        && row.workstream_id === workstreamId) ?? null;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  run(sql: string, values: unknown[]): D1Result {
    if (sql.includes("INSERT INTO workstream_email_routes")) {
      this.routeInsertAttempts += 1;
      const [localPart, region, workspaceId, ownerId, createdAt, updatedAt] = values.map(String);
      const automation = sql.includes("automation_subscription_id") && sql.includes("NULL, ?");
      const workstreamId = automation ? null : ownerId!;
      const automationSubscriptionId = automation ? ownerId! : null;
      const localPartTaken = this.routes.some((row) =>
        row.local_part.toLowerCase() === localPart!.toLowerCase());
      const destinationTaken = this.routes.some((row) =>
        row.region === region
        && row.workspace_id === workspaceId
        && row.workstream_id === workstreamId
        && row.automation_subscription_id === automationSubscriptionId);
      if (localPartTaken || destinationTaken) return result(0);
      this.routes.push({
        local_part: localPart!,
        region: region as Region,
        workspace_id: workspaceId!,
        workstream_id: workstreamId!,
        automation_subscription_id: automationSubscriptionId,
        status: "reserved",
        created_at: createdAt!,
        updated_at: updatedAt!,
        disabled_at: null,
      });
      return result(1);
    }
    if (sql.includes("UPDATE workstream_email_routes")) {
      if (sql.includes("SET status = 'active'")) {
        const [updatedAt, region, workspaceId, workstreamId] = values;
        const route = this.routes.find((row) =>
          row.region === region
          && row.workspace_id === workspaceId
          && row.workstream_id === workstreamId);
        if (!route) return result(0);
        route.status = "active";
        route.updated_at = String(updatedAt);
        route.disabled_at = null;
        return result(1);
      }
      if (sql.includes("workstream_id IS NULL") && sql.includes("automation_subscription_id = ?")) {
        const [status, updatedAt, , disabledAt, region, workspaceId, automationSubscriptionId] = values;
        const route = this.routes.find((row) =>
          row.region === region
          && row.workspace_id === workspaceId
          && row.workstream_id === null
          && row.automation_subscription_id === automationSubscriptionId);
        if (!route) return result(0);
        route.status = String(status) as RouteRow["status"];
        route.updated_at = String(updatedAt);
        route.disabled_at = status === "disabled" ? String(disabledAt) : null;
        return result(1);
      }
      const [status, updatedAt, , disabledAt, region, workspaceId, workstreamId] = values;
      const route = this.routes.find((row) =>
        row.region === region
        && row.workspace_id === workspaceId
        && row.workstream_id === workstreamId);
      if (!route) return result(0);
      route.status = String(status) as RouteRow["status"];
      route.updated_at = String(updatedAt);
      route.disabled_at = status === "disabled" ? String(disabledAt) : null;
      return result(1);
    }
    if (sql.includes("UPDATE workstreams") && sql.includes("SET email_address = ?")) {
      const [emailAddress, updatedAt, workstreamId, workspaceId] = values.map(String);
      const workstream = this.workstreams.find((row) =>
        row.id === workstreamId && row.workspace_id === workspaceId && row.email_address == null);
      if (!workstream) return result(0);
      workstream.email_address = emailAddress!;
      workstream.email_route_status = "reserved";
      workstream.updated_at = updatedAt!;
      return result(1);
    }
    if (sql.includes("UPDATE automation_subscriptions") && sql.includes("SET email_address = ?")) {
      const [emailAddress, updatedAt, automationId, workspaceId] = values.map(String);
      const automation = this.automations.find((row) =>
        row.id === automationId && row.workspace_id === workspaceId && row.email_address == null);
      if (!automation) return result(0);
      automation.email_address = emailAddress!;
      automation.email_route_status = "reserved";
      automation.updated_at = updatedAt!;
      return result(1);
    }
    if (sql.includes("UPDATE automation_subscriptions SET email_route_status = ?")) {
      const [status, updatedAt, automationId, workspaceId, emailAddress] = values.map(String);
      const automation = this.automations.find((row) =>
        row.id === automationId
        && row.workspace_id === workspaceId
        && row.email_address?.toLowerCase() === emailAddress?.toLowerCase());
      if (!automation) return result(0);
      automation.email_route_status = status as RouteRow["status"];
      automation.updated_at = updatedAt!;
      return result(1);
    }
    if (sql.includes("UPDATE workstreams SET email_route_status = ?")) {
      const [status, updatedAt, workstreamId, workspaceId, emailAddress] = values.map(String);
      const workstream = this.workstreams.find((row) =>
        row.id === workstreamId
        && row.workspace_id === workspaceId
        && row.email_address?.toLowerCase() === emailAddress?.toLowerCase());
      if (!workstream) return result(0);
      workstream.email_route_status = status as RouteRow["status"];
      workstream.updated_at = updatedAt!;
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
    const input = routeInput("workstream-stable");

    const first = await service.reserve(input);
    const second = await service.reserve(input);

    expect(second).toEqual(first);
    expect(first.emailAddress).toBe(`${first.localPart}@${DOMAIN}`);
    expect(first.localPart).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u);
    expect(first.localPart.split("-")).toHaveLength(4);
    expect(first.status).toBe("reserved");
    await expect(service.resolveActive(first.localPart)).resolves.toBeNull();
    expect(database.routes).toHaveLength(1);
    expect(database.routeInsertAttempts).toBe(1);
  });

  it("activates only after the owning regional work stream durably exists", async () => {
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database));
    const input = routeInput("workstream-owner-gate");
    const reservation = await service.reserve(input);

    await expect(service.activateWorkstreamRoute(input)).rejects.toMatchObject({
      status: 404,
      code: "workstream_not_found",
    } satisfies Partial<ApiError>);
    expect(database.routes[0]?.status).toBe("reserved");
    await expect(service.resolveActive(reservation.localPart)).resolves.toBeNull();

    database.workstreams.push(localWorkstream(input, reservation.emailAddress));
    await expect(service.activateWorkstreamRoute(input)).resolves.toMatchObject({
      ...input,
      emailAddress: reservation.emailAddress,
      status: "active",
    });
    expect(database.routes[0]?.status).toBe("active");
    expect(database.workstreams[0]?.email_route_status).toBe("active");
    await expect(service.resolveActive(reservation.localPart)).resolves.toMatchObject({
      ...input,
      status: "active",
    });
  });

  it("reconciles EU activation through Global only after the EU owner exists", async () => {
    const globalDatabase = new FakeDatabase();
    const globalService = new WorkstreamEmailRoutingService(environment(globalDatabase));
    const binding: GlobalWorkstreamEmailRouterRpcBinding = {
      ping: async () => success(await globalService.pingGlobalRegistry()),
      reserve: async (input) => success(await globalService.reserveInGlobalRegistry(input)),
      reserveMany: async (inputs) => success(await globalService.reserveManyInGlobalRegistry(inputs)),
      activateMany: async (inputs) => success(await globalService.activateManyInGlobalRegistry(inputs)),
      setStatus: async (input) => success(await globalService.setStatus(input)),
    };
    const euDatabase = new FakeDatabase();
    const euService = new WorkstreamEmailRoutingService(environment(euDatabase, {
      AVALON_REGION: "eu",
      APP_ENV: "production",
      GLOBAL_EMAIL_ROUTER: binding,
    }));
    const input = routeInput("workstream-eu-owner-gate", "eu");
    const reservation = await euService.reserve(input);

    await expect(euService.activateWorkstreamRoute(input)).rejects.toMatchObject({
      status: 404,
      code: "workstream_not_found",
    } satisfies Partial<ApiError>);
    expect(globalDatabase.routes[0]?.status).toBe("reserved");

    euDatabase.workstreams.push(localWorkstream(input, reservation.emailAddress));
    await euService.activateWorkstreamRoute(input);

    expect(globalDatabase.routes[0]?.status).toBe("active");
    expect(euDatabase.workstreams[0]?.email_route_status).toBe("active");
  });

  it("retries the deterministic candidate sequence after a global collision", async () => {
    const database = new FakeDatabase();
    const input = routeInput("workstream-collision");
    const allocatorId = `${input.region}:${input.workspaceId}:${input.workstreamId}`;
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

    const reserved = await new WorkstreamEmailRoutingService(environment(database)).reserve(input);

    expect(reserved.localPart).toBe(secondCandidate);
    expect(reserved.localPart).not.toBe(firstCandidate);
    expect(database.routeInsertAttempts).toBe(2);
    expect(database.routes).toHaveLength(2);
  });

  it("uses the one Global namespace when an EU candidate collides with a Global route", async () => {
    const globalDatabase = new FakeDatabase();
    const globalService = new WorkstreamEmailRoutingService(environment(globalDatabase));
    const euInput = routeInput("workstream-cross-region-collision", "eu");
    const allocatorId = `${euInput.region}:${euInput.workspaceId}:${euInput.workstreamId}`;
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
      reserve: async (input) => success(await globalService.reserveInGlobalRegistry(input)),
      reserveMany: async (inputs) => success(await globalService.reserveManyInGlobalRegistry(inputs)),
      activateMany: async (inputs) => success(await globalService.activateManyInGlobalRegistry(inputs)),
      setStatus: async (input) => success(await globalService.setStatus(input)),
    };
    const euDatabase = new FakeDatabase();
    const euService = new WorkstreamEmailRoutingService(environment(euDatabase, {
      AVALON_REGION: "eu",
      APP_ENV: "production",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    const reserved = await euService.reserve(euInput);

    expect(reserved).toMatchObject({
      region: "eu",
      localPart: secondCandidate,
      emailAddress: `${secondCandidate}@${DOMAIN}`,
    });
    expect(reserved.localPart).not.toBe(firstCandidate);
    expect(globalDatabase.routes).toHaveLength(2);
    expect(globalDatabase.routeInsertAttempts).toBe(2);
    expect(euDatabase.routes).toHaveLength(0);
    expect(euDatabase.routeInsertAttempts).toBe(0);
  });

  it("uses the same Global local-part namespace for automations and work streams", async () => {
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
      status: "reserved",
    });
    expect(route.localPart).not.toBe(firstCandidate);
    expect(database.routes).toHaveLength(2);
    expect(database.routes[1]).toMatchObject({
      workstream_id: null,
      automation_subscription_id: input.automationSubscriptionId,
    });
  });

  it("disables a paused automation route and reactivates the same address on resume", async () => {
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database));
    const input = {
      region: "global" as const,
      workspaceId: "workspace-1",
      automationSubscriptionId: "automation-lifecycle",
    };
    const reservation = await service.reserveAutomation(input);
    const automation: LocalAutomationRow = {
      id: input.automationSubscriptionId,
      workspace_id: input.workspaceId,
      email_address: reservation.emailAddress,
      email_route_status: "reserved",
      status: "active",
      lifecycle_state: "visible",
      updated_at: "2026-08-02T00:00:00.000Z",
    };
    database.automations.push(automation);

    await expect(service.ensureAutomationAddress(input)).resolves.toMatchObject({
      emailAddress: reservation.emailAddress,
      status: "active",
    });
    expect(database.routes[0]).toMatchObject({ status: "active" });

    automation.status = "paused";
    automation.email_route_status = "reserved";
    await expect(service.ensureAutomationAddress(input)).resolves.toMatchObject({
      emailAddress: reservation.emailAddress,
      status: "disabled",
    });
    expect(database.routes[0]).toMatchObject({
      local_part: reservation.localPart,
      status: "disabled",
    });
    expect(database.routes[0]?.disabled_at).not.toBeNull();

    automation.status = "active";
    automation.email_route_status = "reserved";
    await expect(service.ensureAutomationAddress(input)).resolves.toMatchObject({
      emailAddress: reservation.emailAddress,
      status: "active",
    });
    expect(database.routes[0]).toMatchObject({
      local_part: reservation.localPart,
      status: "active",
    });
    expect(database.routes[0]?.disabled_at).toBeNull();
    expect(database.routes).toHaveLength(1);
  });

  it("keeps disabled routes as tombstones and can explicitly reactivate them", async () => {
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database));
    const input = routeInput("workstream-tombstone");
    const reserved = await service.reserve(input);

    await expect(service.setStatus({ ...input, status: "disabled" })).resolves.toEqual({ ok: true });
    await expect(service.resolveActive(reserved.localPart)).resolves.toBeNull();
    expect(database.routes).toHaveLength(1);
    expect(database.routes[0]).toMatchObject({
      local_part: reserved.localPart,
      status: "disabled",
    });
    expect(database.routes[0]?.disabled_at).not.toBeNull();

    // Reserving the same destination does not mint or recycle a different name.
    await expect(service.reserve(input)).resolves.toMatchObject({
      localPart: reserved.localPart,
      emailAddress: reserved.emailAddress,
      status: "disabled",
    });
    expect(database.routes).toHaveLength(1);

    await service.setStatus({ ...input, status: "active" });
    await expect(service.resolveActive(reserved.localPart)).resolves.toMatchObject({
      localPart: reserved.localPart,
      emailAddress: reserved.emailAddress,
      status: "active",
    });
    expect(database.routes[0]?.disabled_at).toBeNull();
  });

  it("reconciles archive and reactivation from the durable regional marker", async () => {
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database));
    const input = routeInput("workstream-archive-lifecycle");
    const reservation = await service.reserve(input);
    const workstream = localWorkstream(input, reservation.emailAddress);
    database.workstreams.push(workstream);
    await service.activateWorkstreamRoute(input);

    workstream.archived_at = "2026-08-02T12:00:00.000Z";
    workstream.email_route_status = "reserved";
    await expect(service.ensureWorkstreamAddress(input)).resolves.toMatchObject({ status: "disabled" });
    expect(database.routes[0]?.status).toBe("disabled");
    expect(workstream.email_route_status).toBe("disabled");
    await expect(service.resolveActive(reservation.localPart)).resolves.toBeNull();

    workstream.archived_at = null;
    workstream.email_route_status = "reserved";
    await expect(service.ensureWorkstreamAddress(input)).resolves.toMatchObject({ status: "active" });
    expect(database.routes[0]?.status).toBe("active");
    expect(workstream.email_route_status).toBe("active");
  });

  it("fails when asked to change the status of a missing route", async () => {
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase()));

    await expect(service.setStatus({
      ...routeInput("workstream-missing-route"),
      status: "active",
    })).rejects.toMatchObject({
      status: 404,
      code: "workstream_email_route_not_found",
    } satisfies Partial<ApiError>);
  });

  it("never recycles a disabled local part for a different destination", async () => {
    const database = new FakeDatabase();
    const input = routeInput("workstream-after-tombstone");
    const allocatorId = `${input.region}:${input.workspaceId}:${input.workstreamId}`;
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
      "disabled",
    ));
    const service = new WorkstreamEmailRoutingService(environment(database));

    const reserved = await service.reserve(input);

    expect(reserved.localPart).toBe(nextCandidate);
    expect(database.routes).toHaveLength(2);
    expect(database.routes[0]).toMatchObject({
      local_part: tombstonedCandidate,
      status: "disabled",
      workspace_id: "retired-workspace",
      workstream_id: "retired-workstream",
    });
  });

  it("delegates EU reservations and status changes to the Global RPC binding", async () => {
    const input = routeInput("workstream-eu", "eu");
    const route = {
      ...input,
      localPart: "bright-steady-clear-otter",
      emailAddress: `bright-steady-clear-otter@${DOMAIN}`,
      status: "reserved" as const,
    };
    const ping = vi.fn(async () => success({ region: "global" as const, domain: DOMAIN }));
    const reserve = vi.fn(async () => success(route));
    const reserveMany = vi.fn(async () => success([route]));
    const setStatus = vi.fn(async () => success({ ok: true as const }));
    const activateMany = vi.fn(async () => success({ ok: true as const }));
    const binding: GlobalWorkstreamEmailRouterRpcBinding = { ping, reserve, reserveMany, activateMany, setStatus };
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database, {
      AVALON_REGION: "eu",
      APP_ENV: "production",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    await expect(service.reserve(input)).resolves.toEqual(route);
    await expect(service.setStatus({ ...input, status: "disabled" })).resolves.toEqual({ ok: true });
    expect(reserve).toHaveBeenCalledExactlyOnceWith(input);
    expect(setStatus).toHaveBeenCalledExactlyOnceWith({ ...input, status: "disabled" });
    expect(database.routeInsertAttempts).toBe(0);
  });

  it("uses one Global RPC invocation for an EU bulk reservation", async () => {
    const inputs = [
      routeInput("workstream-eu-bulk-1", "eu"),
      routeInput("workstream-eu-bulk-2", "eu"),
      routeInput("workstream-eu-bulk-3", "eu"),
    ];
    const routes = inputs.map((input, index): WorkstreamEmailRoute => ({
      ...input,
      localPart: `bright-steady-clear-animal${index}`,
      emailAddress: `bright-steady-clear-animal${index}@${DOMAIN}`,
      status: "reserved",
    }));
    const reserve = vi.fn(async () => success(routes[0]!));
    const reserveMany = vi.fn(async () => success(routes));
    const activateMany = vi.fn(async () => success({ ok: true as const }));
    const binding = {
      ping: vi.fn(async () => success({ region: "global" as const, domain: DOMAIN })),
      reserve,
      reserveMany,
      activateMany,
      setStatus: vi.fn(async () => success({ ok: true as const })),
    } satisfies GlobalWorkstreamEmailRouterRpcBinding;
    const database = new FakeDatabase();
    const service = new WorkstreamEmailRoutingService(environment(database, {
      AVALON_REGION: "eu",
      APP_ENV: "production",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    await expect(service.reserveMany(inputs)).resolves.toEqual(routes);
    await expect(service.activateMany(inputs)).resolves.toEqual({ ok: true });

    expect(reserveMany).toHaveBeenCalledExactlyOnceWith(inputs);
    expect(activateMany).toHaveBeenCalledExactlyOnceWith(inputs);
    expect(reserve).not.toHaveBeenCalled();
    expect(database.routeInsertAttempts).toBe(0);
  });

  it("reconstructs expected Global RPC errors as ApiError instances", async () => {
    const input = routeInput("workstream-eu-rpc-error", "eu");
    const binding = {
      ping: vi.fn(async () => success({ region: "global" as const, domain: DOMAIN })),
      reserve: vi.fn(async () => failure(503, "workstream_email_key_unavailable", "The registry key is unavailable")),
      reserveMany: vi.fn(async () => failure(503, "workstream_email_key_unavailable", "The registry key is unavailable")),
      activateMany: vi.fn(async () => failure(503, "workstream_email_key_unavailable", "The registry key is unavailable")),
      setStatus: vi.fn(async () => success({ ok: true as const })),
    } satisfies GlobalWorkstreamEmailRouterRpcBinding;
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "eu",
      GLOBAL_EMAIL_ROUTER: binding,
    }));

    await expect(service.reserve(input)).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "workstream_email_key_unavailable",
      message: "The registry key is unavailable",
    });
    await expect(service.reserveMany([input])).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "workstream_email_key_unavailable",
    });
  });

  it("pings the live Global registry through the named RPC binding", async () => {
    const ping = vi.fn(async () => success({ region: "global" as const, domain: DOMAIN }));
    const binding = {
      ping,
      reserve: vi.fn(),
      reserveMany: vi.fn(),
      activateMany: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as GlobalWorkstreamEmailRouterRpcBinding;
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "eu",
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
    "fails closed when an EU Worker in %s has no Global registry binding",
    async (appEnv) => {
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "eu",
      APP_ENV: appEnv,
    }));

    await expect(service.reserve(routeInput("workstream-unrouted", "eu"))).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_router_unavailable",
    } satisfies Partial<ApiError>);
    await expect(service.reserveMany([
      routeInput("workstream-unrouted-bulk", "eu"),
    ])).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_router_unavailable",
    } satisfies Partial<ApiError>);
    await expect(service.activateMany([
      routeInput("workstream-unrouted-activation", "eu"),
    ])).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_router_unavailable",
    } satisfies Partial<ApiError>);
    await expect(service.setStatus({
      ...routeInput("workstream-unrouted", "eu"),
      status: "disabled",
    })).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_router_unavailable",
    } satisfies Partial<ApiError>);
    },
  );

  it("rejects direct registry allocation outside the Global Worker", async () => {
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase(), {
      AVALON_REGION: "eu",
    }));

    await expect(service.reserveInGlobalRegistry(
      routeInput("workstream-regional-registry", "eu"),
    )).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_registry_region_invalid",
    } satisfies Partial<ApiError>);
    await expect(service.reserveManyInGlobalRegistry([
      routeInput("workstream-regional-registry-bulk", "eu"),
    ])).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_registry_region_invalid",
    } satisfies Partial<ApiError>);
    await expect(service.activateManyInGlobalRegistry([
      routeInput("workstream-regional-activation", "eu"),
    ])).rejects.toMatchObject({
      status: 503,
      code: "workstream_email_registry_region_invalid",
    } satisfies Partial<ApiError>);
  });

  it("rejects reservations for a work stream from another regional data plane", async () => {
    const service = new WorkstreamEmailRoutingService(environment(new FakeDatabase()));

    await expect(service.reserve(routeInput("workstream-wrong-region", "eu"))).rejects.toMatchObject({
      status: 422,
      code: "workstream_email_region_mismatch",
    } satisfies Partial<ApiError>);
  });
});

function routeInput(workstreamId: string, region: Region = "global"): WorkstreamEmailRouteInput {
  return {
    region,
    workspaceId: "workspace-1",
    workstreamId,
  };
}

function localWorkstream(
  input: WorkstreamEmailRouteInput,
  emailAddress: string | null,
): LocalWorkstreamRow {
  return {
    id: input.workstreamId,
    workspace_id: input.workspaceId,
    email_address: emailAddress,
    email_route_status: "reserved",
    archived_at: null,
    updated_at: "2026-08-02T00:00:00.000Z",
  };
}

function existingRoute(
  localPart: string,
  workspaceId: string,
  workstreamId: string,
  status: RouteRow["status"] = "active",
): RouteRow {
  return {
    local_part: localPart,
    region: "global",
    workspace_id: workspaceId,
    workstream_id: workstreamId,
    automation_subscription_id: null,
    status,
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    disabled_at: status === "disabled" ? "2026-08-02T00:00:01.000Z" : null,
  };
}

function environment(database: FakeDatabase, overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: database as unknown as D1Database,
    SESSION_SIGNING_KEY: "s".repeat(32),
    WORKSTREAM_EMAIL_ADDRESS_KEY: ADDRESS_KEY,
    WORKSTREAM_EMAIL_DOMAIN: DOMAIN,
    ...overrides,
  } as Env;
}

function result<T>(changes: number, results: T[] = []): D1Result<T> {
  return {
    success: true,
    results,
    meta: { changes },
  } as D1Result<T>;
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
