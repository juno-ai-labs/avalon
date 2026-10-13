import "../../../tests/isolated-region";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asUserId } from "@rally/contracts";
import type { HonoAppEnv } from "../src/env";
import { onboardingRoutes } from "../src/routes/onboarding";
import { organizationNameFromHtml, suggestOrganizationName } from "../src/services/organization-name-suggestion";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const userId = asUserId("00000000-0000-7000-8000-000000000042");

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /onboarding/organization-suggestion", () => {
  it("names the organization from the signed-in person's email domain homepage", async () => {
    const db = migratedSqliteDatabase();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users(id, google_subject, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, "suggestion-user", "pat@acme-robotics.test", "Pat", now, now);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return htmlResponse("<html><head><title>Acme Robotics | Machines that build machines</title></head><body></body></html>");
    });
    const app = new Hono<HonoAppEnv>();
    app.use("*", async (c, next) => {
      c.set("auth", { userId, sessionId: "test", workspaceId: null, region: "global", role: null });
      await next();
    });
    app.route("/onboarding", onboardingRoutes);
    const response = await app.request("/onboarding/organization-suggestion", {}, createTestEnv({ DB: sqliteD1(db), AVALON_REGION: "global" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "Acme Robotics" });
    expect(fetched).toEqual(["https://acme-robotics.test/"]);
    db.close();
  });
});

describe("suggestOrganizationName", () => {
  it("does not fetch for a personal mail provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await suggestOrganizationName("pat@gmail.com", fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("offers nothing when the homepage fails, is not HTML, or cannot be reached", async () => {
    expect(await suggestOrganizationName("pat@acme.test", async () => new Response("gone", { status: 404 }))).toBeNull();
    expect(await suggestOrganizationName("pat@acme.test", async () =>
      new Response("{}", { headers: { "content-type": "application/json" } }))).toBeNull();
    expect(await suggestOrganizationName("pat@acme.test", async () => { throw new TypeError("network"); })).toBeNull();
  });

  it("stops reading once the head has arrived", async () => {
    // The body never ends: reading past the head would never resolve.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html><head><title>Acme</title></head><body>"));
      },
    });
    const fetcher = async () => new Response(body, { headers: { "content-type": "text/html" } });
    expect(await suggestOrganizationName("pat@acme.test", fetcher)).toBe("Acme");
  });
});

describe("organizationNameFromHtml", () => {
  it("prefers og:site_name over the title", () => {
    expect(organizationNameFromHtml(
      `<head><meta property="og:site_name" content="Globex &amp; Co"><title>Pricing - Globex</title></head>`,
      "globex.test",
    )).toBe("Globex & Co");
  });

  it("picks the title segment that matches the domain", () => {
    expect(organizationNameFromHtml("<title>Tools for builders — Initech</title>", "initech.test")).toBe("Initech");
  });

  it("splits a title written as name, colon, tagline", () => {
    expect(organizationNameFromHtml("<title>Cloudflare: Build for the agent era</title>", "cloudflare.com")).toBe("Cloudflare");
  });

  it("skips a generic page label when no segment matches the domain", () => {
    expect(organizationNameFromHtml("<title>Home | Northwind Traders</title>", "nw.test")).toBe("Northwind Traders");
  });

  it("offers nothing for a page with no usable name", () => {
    expect(organizationNameFromHtml("<head></head>", "acme.test")).toBeNull();
    expect(organizationNameFromHtml("<title>Home</title>", "acme.test")).toBeNull();
  });
});
