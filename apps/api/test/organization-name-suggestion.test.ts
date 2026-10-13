import "../../../tests/isolated-region";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asUserId } from "@rally/contracts";
import type { HonoAppEnv } from "../src/env";
import { onboardingRoutes } from "../src/routes/onboarding";
import { openEmailLoginSecret, redeemEmailLogin, startEmailLogin } from "../src/services/email-login-service";
import { MAX_HOMEPAGE_HEAD_BYTES, organizationNameFromHtml, readHead, suggestOrganizationName } from "../src/services/organization-name-suggestion";
import { createTestEnv } from "./helpers/cloudflare-test";
import { drainWaitUntil } from "./helpers/cloudflare-workers";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const userId = asUserId("00000000-0000-7000-8000-000000000042");
const DAY_MS = 24 * 60 * 60 * 1000;

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function homepage(title: string): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return htmlResponse(`<html><head><title>${title}</title></head><body></body></html>`);
  };
  return Object.assign(fetcher, { calls }) as typeof fetch & { calls: string[] };
}

let db: DatabaseSync;
beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(async () => {
  await drainWaitUntil();
  vi.unstubAllGlobals();
  db.close();
});

function cachedRow(domain: string) {
  return db.prepare("SELECT outcome, name, fetched_at FROM organization_name_suggestions WHERE domain = ?").get(domain);
}

describe("GET /onboarding/organization-suggestion", () => {
  it("names the organization from the signed-in person's email domain homepage, then answers from the cache", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users(id, google_subject, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, "suggestion-user", "pat@acme-robotics.com", "Pat", now, now);
    const fetcher = homepage("Acme Robotics | Machines that build machines");
    vi.stubGlobal("fetch", fetcher);
    const app = new Hono<HonoAppEnv>();
    app.use("*", async (c, next) => {
      c.set("auth", { userId, sessionId: "test", workspaceId: null, region: "global", role: null });
      await next();
    });
    app.route("/onboarding", onboardingRoutes);
    const env = createTestEnv({ DB: sqliteD1(db), AVALON_REGION: "global" });
    for (let request = 0; request < 2; request += 1) {
      const response = await app.request("/onboarding/organization-suggestion", {}, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ name: "Acme Robotics" });
    }
    expect(fetcher.calls).toEqual(["https://acme-robotics.com/"]);
  });
});

describe("account creation", () => {
  it("reads a new account's suggestion into the cache before anyone asks for it", async () => {
    const fetcher = homepage("Initech: Software that works");
    vi.stubGlobal("fetch", fetcher);
    const env = createTestEnv({
      DB: sqliteD1(db), AVALON_REGION: "global", LOG_LEVEL: "error",
      SESSION_SIGNING_KEY: "suggestion-test-signing-key", OAUTH_STATE_ENCRYPTION_KEY: "suggestion-test-encryption-key",
      BROWSER_APP_ORIGIN: "https://app.rally.test", PUBLIC_API_BASE_URL: "https://api.rally.test",
      RESEND_FROM_EMAIL: "Rally <login@rally.test>",
      EMAIL_LOGIN_POLICY_JSON: '{"otpDigits":6,"ttlSeconds":600,"maxFailedAttempts":3}',
    });
    const challengeId = crypto.randomUUID();
    await startEmailLogin(env, { challengeId, email: "milton@initech.com" }, "browser");
    const row = db.prepare("SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?").get(challengeId)!;
    const payload = await openEmailLoginSecret(env, challengeId, String(row.delivery_payload_encrypted)) as { text: string };
    const credential = /code is (\d+)\./u.exec(payload.text)![1]!;
    await redeemEmailLogin(env, { challengeId, redemptionId: crypto.randomUUID(), credential, method: "otp" }, "browser");
    await drainWaitUntil();
    expect(cachedRow("initech.com")).toMatchObject({ outcome: "named", name: "Initech" });
    expect(fetcher.calls.filter((url) => url === "https://initech.com/")).toHaveLength(1);
  });
});

describe("suggestOrganizationName", () => {
  const start = new Date("2026-10-01T00:00:00.000Z");

  it("reuses a domain's answer for thirty days, then reads the homepage again", async () => {
    const d1 = sqliteD1(db);
    expect(await suggestOrganizationName(d1, "a@globex.com", homepage("Globex"), start)).toBe("Globex");
    const unused = homepage("Globex Corporation");
    expect(await suggestOrganizationName(d1, "b@globex.com", unused, new Date(start.getTime() + 29 * DAY_MS))).toBe("Globex");
    expect(unused.calls).toEqual([]);
    const later = new Date(start.getTime() + 30 * DAY_MS);
    expect(await suggestOrganizationName(d1, "c@globex.com", homepage("Globex Corporation"), later)).toBe("Globex Corporation");
    expect(cachedRow("globex.com")).toEqual({ outcome: "named", name: "Globex Corporation", fetched_at: later.toISOString() });
  });

  it("caches a homepage that names nothing, but not one that cannot be reached", async () => {
    const d1 = sqliteD1(db);
    expect(await suggestOrganizationName(d1, "a@umbrella.com", async () => { throw new TypeError("network"); }, start)).toBeNull();
    expect(await suggestOrganizationName(d1, "a@umbrella.com", async () => new Response("down", { status: 503 }), start)).toBeNull();
    expect(cachedRow("umbrella.com")).toBeUndefined();
    expect(await suggestOrganizationName(d1, "a@umbrella.com", homepage("Home"), start)).toBeNull();
    expect(cachedRow("umbrella.com")).toEqual({ outcome: "unnamed", name: null, fetched_at: start.toISOString() });
  });

  it("does not fetch for a personal mail provider or a reserved test domain", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await suggestOrganizationName(sqliteD1(db), "pat@gmail.com", fetcher)).toBeNull();
    expect(await suggestOrganizationName(sqliteD1(db), "pat@acme.test", fetcher)).toBeNull();
    expect(await suggestOrganizationName(sqliteD1(db), "pat@example.com", fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("offers nothing when the homepage is missing or not HTML, and remembers why", async () => {
    const d1 = sqliteD1(db);
    expect(await suggestOrganizationName(d1, "pat@hooli.com", async () => new Response("gone", { status: 404 }), start)).toBeNull();
    expect(cachedRow("hooli.com")).toEqual({ outcome: "missing", name: null, fetched_at: start.toISOString() });
    expect(await suggestOrganizationName(d1, "pat@soylent.com", async () =>
      new Response("{}", { headers: { "content-type": "application/json" } }), start)).toBeNull();
    expect(cachedRow("soylent.com")).toEqual({ outcome: "not_html", name: null, fetched_at: start.toISOString() });
    // A media type that merely contains "html" is not HTML.
    expect(await suggestOrganizationName(d1, "pat@vandelay.com", async () =>
      new Response("<title>Vandelay</title>", { headers: { "content-type": "application/x-html-fragment" } }), start)).toBeNull();
    expect(cachedRow("vandelay.com")).toMatchObject({ outcome: "not_html" });
  });

  it("follows redirects, checking every hop", async () => {
    const d1 = sqliteD1(db);
    const calls: string[] = [];
    const redirecting = (target: string) => async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return String(input) === "https://acme.com/"
        ? new Response(null, { status: 301, headers: { location: target } })
        : htmlResponse("<title>Acme</title>");
    };
    expect(await suggestOrganizationName(d1, "pat@acme.com", redirecting("https://www.acme.com/"), start)).toBe("Acme");
    expect(calls).toEqual(["https://acme.com/", "https://www.acme.com/"]);
    calls.length = 0;
    db.prepare("DELETE FROM organization_name_suggestions").run();
    expect(await suggestOrganizationName(d1, "pat@acme.com", redirecting("http://169.254.169.254/latest/meta-data"), start)).toBeNull();
    expect(calls).toEqual(["https://acme.com/"]);
    expect(cachedRow("acme.com")).toMatchObject({ outcome: "refused", name: null });
  });

  it("gives up on a redirect loop without caching it", async () => {
    let calls = 0;
    const looping = async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "/again" } });
    };
    expect(await suggestOrganizationName(sqliteD1(db), "pat@loop.com", looping, start)).toBeNull();
    expect(calls).toBe(21);
    expect(cachedRow("loop.com")).toBeUndefined();
  });

  it("stops reading once the head has arrived", async () => {
    // The body never ends: reading past the head would never resolve.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html><head><title>Acme</title></head><body>"));
      },
    });
    const fetcher = async () => new Response(body, { headers: { "content-type": "text/html" } });
    expect(await suggestOrganizationName(sqliteD1(db), "pat@acme.com", fetcher)).toBe("Acme");
  });
});

describe("readHead", () => {
  function chunked(...parts: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
  }

  it("gives up once more than the limit arrives before the head ends", async () => {
    expect(await readHead(chunked("<head><title>Acme</title>", "<script>".padEnd(64, "x")), 32)).toBeNull();
    expect(await readHead(chunked("<head><title>Acme</title></head>"), 64)).toBe("<head><title>Acme</title></head>");
  });

  it("finds the end of the head when its marker is split across chunks", async () => {
    // Never closed: the read ends only by finding `</head>`.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of ["<head><title>Acme</title></he", "ad>"]) controller.enqueue(new TextEncoder().encode(part));
      },
    });
    expect(await readHead(body, MAX_HOMEPAGE_HEAD_BYTES)).toBe("<head><title>Acme</title></head>");
  }, 2_000);

  it("reads a heavy but legitimate head whole at the shipped limit", async () => {
    // A head with a few hundred KB of inlined CSS and JS, as heavy real homepages have.
    const script = `<script>${"x".repeat(400_000)}</script>`;
    const head = await readHead(chunked("<head>", script, "<title>Acme</title></head><body>"), MAX_HOMEPAGE_HEAD_BYTES);
    expect(head).toBe(`<head>${script}<title>Acme</title></head><body>`);
  });

  it("stops a head that never ends at the shipped limit", async () => {
    let enqueued = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(120));
      },
    });
    expect(await readHead(endless, MAX_HOMEPAGE_HEAD_BYTES)).toBeNull();
    expect(enqueued).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("organization_name_suggestions", () => {
  it("stores only cacheable outcomes, with a name exactly when the outcome is named", () => {
    const insert = db.prepare("INSERT INTO organization_name_suggestions (domain, outcome, name, fetched_at) VALUES (?, ?, ?, ?)");
    expect(() => insert.run("a.com", "named", null, "2026-10-01T00:00:00.000Z")).toThrow(/CHECK/u);
    expect(() => insert.run("b.com", "unnamed", "Bee", "2026-10-01T00:00:00.000Z")).toThrow(/CHECK/u);
    expect(() => insert.run("c.com", "unreachable", null, "2026-10-01T00:00:00.000Z")).toThrow(/CHECK/u);
    insert.run("d.com", "named", "Dee", "2026-10-01T00:00:00.000Z");
    insert.run("e.com", "missing", null, "2026-10-01T00:00:00.000Z");
  });
});

describe("organizationNameFromHtml", () => {
  it("prefers og:site_name over the title", () => {
    expect(organizationNameFromHtml(
      `<head><meta property="og:site_name" content="Globex &amp; Co"><title>Pricing - Globex</title></head>`,
      "globex.com",
    )).toBe("Globex & Co");
  });

  it("picks the title segment that matches the domain", () => {
    expect(organizationNameFromHtml("<title>Tools for builders — Initech</title>", "initech.com")).toBe("Initech");
  });

  it("splits a title written as name, colon, tagline", () => {
    expect(organizationNameFromHtml("<title>Cloudflare: Build for the agent era</title>", "cloudflare.com")).toBe("Cloudflare");
  });

  it("never picks a generic page label, even one inside the domain", () => {
    expect(organizationNameFromHtml("<title>Home | The Home Depot</title>", "homedepot.com")).toBe("The Home Depot");
  });

  it("skips a generic page label when no segment matches the domain", () => {
    expect(organizationNameFromHtml("<title>Home | Northwind Traders</title>", "nw.com")).toBe("Northwind Traders");
  });

  it("offers nothing for a page with no usable name", () => {
    expect(organizationNameFromHtml("<head></head>", "acme.com")).toBeNull();
    expect(organizationNameFromHtml("<title>Home</title>", "acme.com")).toBeNull();
  });
});
