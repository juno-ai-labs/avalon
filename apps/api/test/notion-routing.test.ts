import "../../../tests/isolated-region";
import type { Region } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  isAllowedNotionIngressRoute,
  isSharedNotionIngress,
  notionCallbackUrl,
  notionIngressIsElsewhere,
} from "../src/lib/notion-ingress";
import {
  NotionRoutingService,
  serializeNotionRpcResult,
} from "../src/services/notion-routing-service";
import { ApiError } from "../src/lib/api-error";
import {
  createRegionRoutedState,
  regionFromRoutedState,
} from "../src/lib/region-routed-state";
import { connectorRegistryForEnv, notionConnectorConfig } from "../src/lib/connector-registry";
import { createApp } from "../src/app";
import { createTestD1Database, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const NOW = Date.parse("2026-08-11T18:00:00.000Z");
const SECRET = "notion-verification-token";
const INTEGRATION_ID = "00000000-0000-4000-8000-0000000000a1";
const NOTION_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a2";
const EVENT_ID = "00000000-0000-4000-8000-0000000000a3";
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-0000000000a4";
const BOT_ID = "00000000-0000-4000-8000-0000000000a5";
const ENTROPY = "a".repeat(32);

interface RouteRow {
  notionWorkspaceId: string;
  region: Region;
  workspaceId: string;
  connectionId: string;
  status: "active" | "disabled";
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(private readonly database: FakeDatabase, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.all(this.sql, this.values));
  }

  async run<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.run(this.sql, this.values));
  }
}

class FakeDatabase {
  readonly routes: RouteRow[] = [];
  prepareCalls = 0;

  prepare(sql: string): FakeStatement {
    this.prepareCalls += 1;
    return new FakeStatement(this, sql);
  }

  all(sql: string, values: unknown[]): D1Result<Record<string, unknown>> {
    if (!sql.includes("SELECT DISTINCT region, status FROM notion_workspace_routes")) {
      throw new Error(`Unexpected all query: ${sql}`);
    }
    // Statuses come back unfiltered on purpose: the service has to tell a
    // retired route from one that was never registered.
    const rows = [...new Map(this.routes
      .filter((row) => row.notionWorkspaceId === values[0])
      .map((row) => [`${row.region}:${row.status}`, { region: row.region, status: row.status }]))
      .values()].sort((left, right) => left.region.localeCompare(right.region));
    return result(0, rows);
  }

  run(sql: string, values: unknown[]): D1Result {
    if (sql.includes("INSERT INTO notion_workspace_routes")) {
      const [notionWorkspaceId, region, workspaceId, connectionId] = values.map(String);
      const existing = this.routes.find((row) => row.connectionId === connectionId);
      if (existing) existing.status = "active";
      else this.routes.push({
        notionWorkspaceId: notionWorkspaceId!,
        region: region as Region,
        workspaceId: workspaceId!,
        connectionId: connectionId!,
        status: "active",
      });
      return result(1);
    }
    if (sql.includes("UPDATE notion_workspace_routes")) {
      const row = this.routes.find((candidate) =>
        candidate.notionWorkspaceId === values[3]
        && candidate.region === values[4]
        && candidate.workspaceId === values[5]
        && candidate.connectionId === values[6]);
      if (!row) return result(0);
      row.status = String(values[0]) as RouteRow["status"];
      return result(1);
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

describe("shared Notion connection routing", () => {
  it("gates the dedicated hostname to the callback, webhook, and health only", () => {
    const env = environment(new FakeDatabase());
    expect(isSharedNotionIngress(env, "https://notion.with-avalon.com/ingest/notion")).toBe(true);
    expect(isSharedNotionIngress(env, "https://api.with-avalon.com/ingest/notion")).toBe(false);
    expect(isAllowedNotionIngressRoute("GET", "/connections/notion/callback")).toBe(true);
    expect(isAllowedNotionIngressRoute("POST", "/ingest/notion")).toBe(true);
    expect(isAllowedNotionIngressRoute("GET", "/health")).toBe(true);
    expect(isAllowedNotionIngressRoute("GET", "/workspace")).toBe(false);
    expect(isAllowedNotionIngressRoute("POST", "/connections/notion/start")).toBe(false);
  });

  it("separates local regional Workers that share a hostname but not a port", () => {
    const env = createTestEnv({
      ...environment(new FakeDatabase()),
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      NOTION_INGRESS_BASE_URL: "http://127.0.0.1:8787",
    });
    expect(isSharedNotionIngress(env, "http://127.0.0.1:8787/connections/notion/callback")).toBe(true);
    expect(isSharedNotionIngress(env, "http://127.0.0.1:8788/connections/notion/callback")).toBe(false);
  });

  it("never treats the Worker's own regional API as the shared ingress", () => {
    // Development points the ingress at the Worker itself. Were that the shared
    // host, the three-route gate would apply to the whole local API.
    const env = createTestEnv({
      ...environment(new FakeDatabase()),
      PUBLIC_API_BASE_URL: "http://127.0.0.1:8787",
      NOTION_INGRESS_BASE_URL: "http://127.0.0.1:8787",
    });
    expect(isSharedNotionIngress(env, "http://127.0.0.1:8787/connections/notion/callback")).toBe(false);
    expect(isSharedNotionIngress(env, "http://127.0.0.1:8787/workspace")).toBe(false);
  });

  it("keeps the local API reachable when development points the ingress at itself", async () => {
    const app = createApp();
    const root = await app.request("http://127.0.0.1:8787/", undefined, developmentEnv());
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toMatchObject({ service: "avalon-api", region: "global" });

    // A protected route must be refused by authentication, not swallowed by the
    // ingress route gate.
    const workspace = await app.request("http://127.0.0.1:8787/workspace", undefined, developmentEnv());
    expect(workspace.status).not.toBe(404);
  });

  it("gives both regions the one redirect URI the connection was registered with", () => {
    const shared = "https://notion.with-avalon.com/connections/notion/callback";
    for (const region of ["global", "enterprise"] as const) {
      const env = createTestEnv({
        AVALON_REGION: region,
        PUBLIC_API_BASE_URL: region === "enterprise" ? "https://enterprise.api.with-avalon.com" : "https://api.with-avalon.com",
        NOTION_INGRESS_BASE_URL: "https://notion.with-avalon.com",
        NOTION_OAUTH_CLIENT_ID: "client",
        NOTION_OAUTH_CLIENT_SECRET: "secret",
      });
      expect(notionCallbackUrl(env)).toBe(shared);
      expect(notionConnectorConfig(env)?.redirectUri).toBe(shared);
    }
  });

  it("registers personal Notion MCP without public-integration credentials", () => {
    const env = createTestEnv({
      AVALON_REGION: "global",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      NOTION_INGRESS_BASE_URL: "https://notion.with-avalon.com",
    });
    expect(notionConnectorConfig(env)).toEqual({
      redirectUri: "https://notion.with-avalon.com/connections/notion/callback",
    });
    expect(connectorRegistryForEnv(env).list().map((manifest) => manifest.type)).toContain("notion");
  });

  it("routes a callback to the region its state names", async () => {
    const completed: Array<{ region: Region; code: string }> = [];
    const service = new NotionRoutingService(environment(new FakeDatabase()), {
      now: () => NOW,
      completeInRegion: async (region, code) => {
        completed.push({ region, code });
        return `avalon://auth/complete?region=${region}`;
      },
    });

    await expect(service.completeNotion("code-enterprise", createRegionRoutedState("enterprise", ENTROPY)))
      .resolves.toBe("avalon://auth/complete?region=enterprise");
    await expect(service.completeNotion("code-global", createRegionRoutedState("global", ENTROPY)))
      .resolves.toBe("avalon://auth/complete?region=global");
    expect(completed).toEqual([
      { region: "enterprise", code: "code-enterprise" },
      { region: "global", code: "code-global" },
    ]);
  });

  it("refuses a callback whose state carries no region", async () => {
    const service = new NotionRoutingService(environment(new FakeDatabase()), { now: () => NOW });
    await expect(service.completeNotion("code", "opaque-state-without-a-region"))
      .rejects.toMatchObject({ status: 401, code: "invalid_oauth_state" });
    await expect(service.denyNotion("mars.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
      .rejects.toMatchObject({ status: 401, code: "invalid_oauth_state" });
  });

  it("registers one Notion workspace in multiple regions and forwards exact bytes", async () => {
    const database = new FakeDatabase();
    const dispatches: Array<{ region: Region; bytes: Uint8Array }> = [];
    const service = new NotionRoutingService(environment(database), {
      now: () => NOW,
      verificationToken: async () => SECRET,
      ingestInRegion: async (region, rawBody) => {
        dispatches.push({ region, bytes: new Uint8Array(rawBody) });
        return { accepted: true, duplicate: false, activityCount: 1 };
      },
    });
    await service.registerConnection(route("global", "workspace-global", "connection-global"));
    await service.registerConnection(route("enterprise", "workspace-enterprise", "connection-enterprise"));

    const delivery = await signedDelivery();
    await expect(service.ingestNotion(delivery.bytes, delivery.headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 2,
    });
    expect(dispatches.map((entry) => entry.region)).toEqual(["enterprise", "global"]);
    expect(dispatches.every((entry) => bytesEqual(entry.bytes, delivery.bytes))).toBe(true);
  });

  it("stops asking Notion to retry once every route for a workspace is retired", async () => {
    const database = new FakeDatabase();
    const dispatched: Region[] = [];
    const service = new NotionRoutingService(environment(database), {
      now: () => NOW,
      verificationToken: async () => SECRET,
      ingestInRegion: async (region) => {
        dispatched.push(region);
        return { accepted: true, duplicate: false, activityCount: 1 };
      },
    });
    await service.registerConnection(route("enterprise", "workspace-enterprise", "connection-enterprise"));
    await service.setConnectionStatus({ ...route("enterprise", "workspace-enterprise", "connection-enterprise"), status: "disabled" });

    // Disabling an Avalon connection does not uninstall the integration at
    // Notion, so this workspace keeps delivering. A retired route is answered,
    // not retried — the retry budget is shared by every customer.
    const delivery = await signedDelivery();
    await expect(service.ingestNotion(delivery.bytes, delivery.headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 0,
    });
    expect(dispatched).toEqual([]);
  });

  it("verifies before routing and asks Notion to retry an installation race", async () => {
    const database = new FakeDatabase();
    const service = new NotionRoutingService(environment(database), {
      now: () => NOW,
      verificationToken: async () => SECRET,
    });
    const delivery = await signedDelivery();

    await expect(service.ingestNotion(delivery.bytes, {
      "x-notion-signature": `sha256=${"0".repeat(64)}`,
    })).rejects.toMatchObject({ code: "invalid_signature" });
    expect(database.prepareCalls).toBe(0);

    await expect(service.ingestNotion(delivery.bytes, delivery.headers)).rejects.toMatchObject({
      status: 503,
      code: "notion_route_pending",
    });
  });

  it("refuses a delivery signed for a different public integration", async () => {
    const service = new NotionRoutingService(environment(new FakeDatabase()), {
      now: () => NOW,
      verificationToken: async () => SECRET,
    });
    const delivery = await signedDelivery({ integrationId: "00000000-0000-4000-8000-0000000000ff" });
    await expect(service.ingestNotion(delivery.bytes, delivery.headers))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("replicates the one-time verification token to the region that never receives it", async () => {
    const replicated: Array<{ region: Region; token: string; setupGeneration: number }> = [];
    const captured: Array<string | null> = [];
    const service = new NotionRoutingService(environment(new FakeDatabase()), {
      now: () => NOW,
      storeChallengeInRegion: async (region, token, setupGeneration) => {
        replicated.push({ region, token, setupGeneration });
      },
      setupGenerationForToken: async () => 17,
      captureChallenge: async (token, setupNonce) => {
        captured.push(setupNonce);
        expect(token).toBe(SECRET);
        return { accepted: true, duplicate: false, activityCount: 0 };
      },
    });

    const bytes = new TextEncoder().encode(JSON.stringify({ verification_token: SECRET }));
    await expect(service.ingestNotion(bytes, {}, "setup-token")).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 0,
    });
    expect(captured).toEqual(["setup-token"]);
    expect(replicated).toEqual([{ region: "enterprise", token: SECRET, setupGeneration: 17 }]);
  });

  it("keeps the ingress in the Global control plane", async () => {
    const service = new NotionRoutingService(
      createTestEnv({ ...environment(new FakeDatabase()), AVALON_REGION: "enterprise" }),
      { now: () => NOW },
    );
    await expect(service.completeNotion("code", createRegionRoutedState("enterprise", ENTROPY)))
      .rejects.toMatchObject({ status: 503, code: "notion_ingress_misconfigured" });
  });

  it("serializes internal routing failures without losing status", async () => {
    await expect(serializeNotionRpcResult(async () => {
      throw new ApiError(409, "route_conflict", "Route conflict");
    })).resolves.toEqual({
      ok: false,
      error: { status: 409, code: "route_conflict", message: "Route conflict" },
    });
  });

  it("serves only the ingress routes on the shared hostname", async () => {
    const response = await createApp().request(
      "https://notion.with-avalon.com/workspace",
      undefined,
      ingressEnv(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("always returns to the hosted handoff when a shared-host callback cannot be routed", async () => {
    const response = await createApp().request(
      `https://notion.with-avalon.com/connections/notion/callback?code=abc&state=${"x".repeat(24)}`,
      undefined,
      ingressEnv(),
    );

    expect(response.status).toBe(302);
    const handoff = new URL(response.headers.get("location")!);
    const target = new URL(new URLSearchParams(handoff.hash.slice(1)).get("target")!);
    expect(handoff.pathname).toBe("/auth/desktop/");
    expect(target.searchParams.get("provider")).toBe("notion");
    expect(target.searchParams.get("status")).toBe("failed");
    expect(target.searchParams.get("error")).toBe("invalid_oauth_state");
  });

  it("refuses a setup challenge posted to a regional host", async () => {
    // The regional handler would store the token and answer 200 without ever
    // replicating it, and the omission would only surface as a total delivery
    // failure for the other region much later.
    const app = createApp();
    const response = await app.request(
      "https://api.with-avalon.com/ingest/notion?setup=setup-token",
      { method: "POST", body: JSON.stringify({ verification_token: SECRET }) },
      ingressEnv(),
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("notion_setup_wrong_host");
    expect(body.error?.message).toContain("https://notion.with-avalon.com/ingest/notion");
  });

  it("still accepts a setup challenge where the ingress and the API are one host", async () => {
    // Development is that configuration, and the refusal above must not reach it.
    expect(notionIngressIsElsewhere(developmentEnv(), "http://127.0.0.1:8787/ingest/notion")).toBe(false);
    expect(notionIngressIsElsewhere(ingressEnv(), "https://api.with-avalon.com/ingest/notion")).toBe(true);
  });

  it("round-trips a region-routed state and rejects a forged prefix", () => {
    expect(createRegionRoutedState("enterprise", ENTROPY)).toBe(`enterprise.${ENTROPY}`);
    expect(regionFromRoutedState(`global.${ENTROPY}`, "Notion authorization")).toBe("global");
    expect(() => regionFromRoutedState(`enterprise.short`, "Notion authorization")).toThrow(/state/iu);
    expect(() => createRegionRoutedState("enterprise", "too-short")).toThrow(/entropy/iu);
  });
});

function developmentEnv(): Env {
  return createTestEnv({
    ...ingressEnv(),
    PUBLIC_API_BASE_URL: "http://127.0.0.1:8787",
    NOTION_INGRESS_BASE_URL: "http://127.0.0.1:8787",
  });
}

function ingressEnv(): Env {
  return createTestEnv({
    ALLOWED_ORIGINS: "app://avalon",
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    NOTION_INGRESS_BASE_URL: "https://notion.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
    LOG_LEVEL: "error",
  });
}

function route(region: Region, workspaceId: string, connectionId: string) {
  return { notionWorkspaceId: NOTION_WORKSPACE_ID, region, workspaceId, connectionId };
}

function environment(database: FakeDatabase): Env {
  return createTestEnv({
    DB: createTestD1Database(database),
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    NOTION_INGRESS_BASE_URL: "https://notion.with-avalon.com",
    NOTION_INTEGRATION_ID: INTEGRATION_ID,
    PROVIDER_WEBHOOK_MAX_BYTES: "2000000",
  });
}

async function signedDelivery(overrides: { integrationId?: string } = {}) {
  const body = JSON.stringify({
    id: EVENT_ID,
    timestamp: new Date(NOW).toISOString(),
    workspace_id: NOTION_WORKSPACE_ID,
    workspace_name: "Avalon",
    subscription_id: SUBSCRIPTION_ID,
    integration_id: overrides.integrationId ?? INTEGRATION_ID,
    type: "page.created",
    attempt_number: 1,
    api_version: "2026-03-11",
    accessible_by: [{ id: BOT_ID, type: "bot" }],
    entity: { id: "00000000-0000-4000-8000-0000000000b1", type: "page" },
    data: { parent: { id: "00000000-0000-4000-8000-0000000000b2", type: "page" } },
  });
  const bytes = new TextEncoder().encode(body);
  return {
    bytes,
    headers: { "x-notion-signature": `sha256=${await hmacHex(SECRET, bytes)}` },
  };
}

async function hmacHex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, copy));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function result<T>(changes: number, results: T[] = []): D1Result<T> {
  return createTestD1Result<T>({
    success: true,
    results,
    meta: { changes } as D1Result["meta"],
  });
}
