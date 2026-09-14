import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import {
  isAllowedSlackIngressRoute,
  isSharedSlackIngress,
  serializeSlackRpcResult,
  SlackRoutingService,
} from "../src/services/slack-routing-service";
import { createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

interface Route {
  teamId: string;
  region: string;
  workspaceId: string;
  connectionId: string;
  status: "active" | "disabled";
}

class FakeStatement {
  private values: unknown[] = [];
  constructor(private readonly database: FakeDatabase, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  first<T>() { return this.database.first(this.sql, this.values) as Promise<T | null>; }
  run<T>() { return this.database.run(this.sql, this.values) as Promise<D1Result<T>>; }
}

class FakeDatabase {
  readonly routes: Route[] = [];
  prepare(sql: string) { return new FakeStatement(this, sql); }
  async first(sql: string, values: unknown[]) {
    if (sql.includes("INSERT INTO slack_installation_routes")) {
      const [teamId, region, workspaceId, connectionId] = values.map(String);
      const existing = this.routes.find((candidate) => candidate.teamId === teamId);
      if (existing?.status === "active" && existing.workspaceId !== workspaceId) return null;
      if (existing) Object.assign(existing, { region, workspaceId, connectionId, status: "active" });
      else this.routes.push({ teamId: teamId!, region: region as Route["region"], workspaceId: workspaceId!, connectionId: connectionId!, status: "active" });
      return { team_id: teamId };
    }
    if (sql.includes("FROM slack_installation_routes WHERE team_id")) {
      const route = this.routes.find((candidate) => candidate.teamId === values[0]);
      return route ? { workspace_id: route.workspaceId, connection_id: route.connectionId, status: route.status } : null;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }
  async run(sql: string, values: unknown[]) {
    if (sql.includes("UPDATE slack_installation_routes")) {
      const route = this.routes.find((candidate) => candidate.teamId === values[3] && candidate.region === values[4] && candidate.workspaceId === values[5] && candidate.connectionId === values[6]);
      if (!route) return result(0);
      route.status = String(values[0]) as Route["status"];
      return result(1);
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

describe("shared Slack app routing", () => {
  it("gates the dedicated hostname to Slack ingress and health", () => {
    const env = environment(new FakeDatabase());
    expect(isSharedSlackIngress(env, "https://slack.with-avalon.com/slack/events")).toBe(true);
    expect(isSharedSlackIngress(env, "https://api.with-avalon.com/slack/events")).toBe(false);
    expect(isAllowedSlackIngressRoute("POST", "/slack/events")).toBe(true);
    expect(isAllowedSlackIngressRoute("POST", "/slack/interactivity")).toBe(true);
    expect(isAllowedSlackIngressRoute("POST", "/slack/commands")).toBe(true);
    expect(isAllowedSlackIngressRoute("GET", "/workspace")).toBe(false);
  });

  it("allows many Slack teams per Avalon workspace but one Avalon workspace per team", async () => {
    const database = new FakeDatabase();
    const service = new SlackRoutingService(environment(database));
    await service.registerConnection(route("TONE", "workspace-a", "connection-1"));
    await service.registerConnection(route("TTWO", "workspace-a", "connection-2"));
    expect(database.routes).toHaveLength(2);
    await expect(service.registerConnection(route("TONE", "workspace-b", "connection-3"))).rejects.toMatchObject({
      status: 409,
      code: "slack_workspace_already_connected",
    });
    await service.setConnectionStatus({ ...route("TONE", "workspace-a", "connection-1"), status: "disabled" });
    await expect(service.registerConnection(route("TONE", "workspace-b", "connection-3"))).resolves.toBeUndefined();
  });

  it("atomically rejects competing registrations for the same Slack team", async () => {
    const database = new FakeDatabase();
    const service = new SlackRoutingService(environment(database));
    const attempts = await Promise.allSettled([
      service.registerConnection(route("TRACE", "workspace-a", "connection-a")),
      service.registerConnection(route("TRACE", "workspace-b", "connection-b")),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(database.routes).toHaveLength(1);
  });

  it("serializes routing errors for service bindings", async () => {
    await expect(serializeSlackRpcResult(async () => {
      throw new ApiError(409, "route_conflict", "Route conflict");
    })).resolves.toEqual({ ok: false, error: { status: 409, code: "route_conflict", message: "Route conflict" } });
  });
});

function route(teamId: string, workspaceId: string, connectionId: string) {
  return { teamId, region: "global" as const, workspaceId, connectionId };
}

function environment(database: FakeDatabase): Env {
  return createTestEnv({ DB: createTestD1Database(database), AVALON_REGION: "global", SLACK_INGRESS_BASE_URL: "https://slack.with-avalon.com" });
}

function result<T = unknown>(changes: number): D1Result<T> {
  return { success: true, results: [], meta: { changes } as D1Meta & Record<string, unknown> };
}
