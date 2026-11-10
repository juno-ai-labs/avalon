/**
 * The emailed Approve and Decline links of a Sidekick source request: what a
 * link carries, what its signature binds, and how the public route treats a
 * request that is not a signed POST from the browser host. The signed path
 * into the Organization object is proved on real workerd in
 * `test-workers/sidekick-source-notices.test.ts`.
 */
import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { sourceNoticeText } from "../src/durable-objects/sidekick-source-notices";
import { decideSourceRequestByLink, sourceDecisionActions, sourceDecisionUrl } from "../src/services/sidekick-source-decision-link";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const SIGNING_KEY = "source-decision-test-signing-key";
const CLAIM = {
  workspaceId: "00000000-0000-7000-8000-0000000d1c01", sidekickId: "00000000-0000-7000-8000-0000000d1c02",
  requestId: "00000000-0000-7000-8000-0000000d1c03", userId: "00000000-0000-7000-8000-0000000d1c04", decision: "approve" as const,
};

let db: DatabaseSync;
function bindings() {
  return createTestEnv({ DB: sqliteD1(db), APP_ENV: "development", RALLY_DEV_AUTH: "false", AVALON_REGION: "global",
    ALLOWED_ORIGINS: "https://app.example.test", PUBLIC_API_BASE_URL: "https://api.example.test", LOG_LEVEL: "error",
    SESSION_SIGNING_KEY: SIGNING_KEY, OAUTH_STATE_ENCRYPTION_KEY: "source-decision-test-encryption-key",
    BROWSER_APP_ORIGIN: "https://app.example.test" });
}
beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close(); });

/** The signature as an independent implementation computes it: HMAC-SHA256 over the labelled fields, base64url. */
function expectedToken(claim: typeof CLAIM | (Omit<typeof CLAIM, "decision"> & { decision: "decline" })): string {
  return createHmac("sha256", SIGNING_KEY).update(JSON.stringify(["sidekick-source-decision", claim.workspaceId, claim.sidekickId,
    claim.requestId, claim.userId, claim.decision])).digest("base64url");
}

function fragment(url: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(new URL(url).hash.slice(1)));
}

describe("a source request's emailed decision link", () => {
  it("opens the browser host's decision page with the request, the person and the decision in the fragment", async () => {
    const url = new URL(await sourceDecisionUrl(bindings(), CLAIM));
    expect(`${url.origin}${url.pathname}${url.search}`).toBe("https://app.example.test/app/source-requests/decision");
    expect(fragment(url.toString())).toEqual({
      region: "global", workspace: CLAIM.workspaceId, sidekick: CLAIM.sidekickId, request: CLAIM.requestId, person: CLAIM.userId,
      decision: "approve", token: expectedToken(CLAIM),
    });
  });

  it("signs each button for its own decision, so one cannot be edited into the other", async () => {
    const actions = await sourceDecisionActions(bindings(), { workspaceId: CLAIM.workspaceId, sidekickId: CLAIM.sidekickId,
      requestId: CLAIM.requestId, userId: CLAIM.userId });
    expect(actions.map((action) => [action.label, fragment(action.url).decision, fragment(action.url).token])).toEqual([
      ["Approve", "approve", expectedToken(CLAIM)],
      ["Decline", "decline", expectedToken({ ...CLAIM, decision: "decline" })],
    ]);
  });

  it("refuses a link whose signature does not match any one of its fields, before reading anything", async () => {
    // No Organization namespace is bound: a refusal that reached one would fail on that instead.
    const env = bindings();
    const token = expectedToken(CLAIM);
    for (const edited of [
      { ...CLAIM, decision: "decline" as const }, { ...CLAIM, userId: "00000000-0000-7000-8000-0000000d1c05" },
      { ...CLAIM, requestId: "00000000-0000-7000-8000-0000000d1c06" }, { ...CLAIM, sidekickId: "00000000-0000-7000-8000-0000000d1c07" },
      { ...CLAIM, workspaceId: "00000000-0000-7000-8000-0000000d1c08" },
    ]) {
      await expect(decideSourceRequestByLink(env, { ...edited, token })).rejects.toMatchObject({ status: 401, code: "sidekick_source_link_invalid" });
    }
  });
});

describe("POST /browser/source-requests/decision", () => {
  const post = (body: unknown, origin = "https://app.example.test") => createApp().request("/browser/source-requests/decision", {
    method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
  }, bindings());

  it("answers a loaded link with 405, so a mail scanner's GET decides nothing", async () => {
    const response = await createApp().request("/browser/source-requests/decision", { method: "GET" }, bindings());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses an unsigned decision by name, a post from another origin, and an oversized body", async () => {
    const unsigned = await post({ ...CLAIM, token: "not-the-signature" });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ error: { code: "sidekick_source_link_invalid" } });
    const elsewhere = await post({ ...CLAIM, token: expectedToken(CLAIM) }, "https://elsewhere.example.test");
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toMatchObject({ error: { code: "browser_origin_required" } });
    expect((await post({ ...CLAIM, token: "x".repeat(4096) })).status).toBe(413);
  });
});

describe("what a source request's notice says under its title", () => {
  it("names the events and the condition, and leaves out whichever is absent", () => {
    expect(sourceNoticeText({ eventLabels: ["Email received", "Calendar event changed"], condition: "it is about a pre-seed round" }))
      .toBe("Events: Email received, Calendar event changed. Only when: it is about a pre-seed round");
    expect(sourceNoticeText({ eventLabels: ["Email received"], condition: null })).toBe("Events: Email received");
    expect(sourceNoticeText({ eventLabels: [], condition: "it is from a customer" })).toBe("Only when: it is from a customer");
  });
});
