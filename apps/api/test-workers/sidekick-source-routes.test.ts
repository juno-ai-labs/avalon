/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Sidekick source routes over HTTP, on the real Worker app and the real
 * Organization object: a signed-in person reads, asks, answers, reads a
 * request's card and takes a source back, and the emailed link answers with
 * no session. Every other suite calls the object directly; this one proves
 * what the routes add: who is acting comes from the session and never from
 * the body, a refusal keeps its status and code across the object's RPC hop,
 * and a body the schema does not declare is refused before anything is read.
 * `docs/sidekick-sources.md` owns the feature.
 *
 * `test/sidekick-source-decision-link.test.ts` already holds the emailed
 * route's `GET` 405, unsigned 401, wrong origin 403 and oversized 413, so
 * none of those is repeated here.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { createApp } from "../src/app";
import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { issueAccessToken } from "../src/services/auth-service";
import { sourceDecisionUrl } from "../src/services/sidekick-source-decision-link";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { changeRelationships } from "./helpers/workspace-relationship-events";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000005c7000");
let SIDEKICK_ID = "00000000-0000-7000-8000-0000005c70a1";
let CANVAS_ID = "00000000-0000-7000-8000-0000005c70c1";
/** Avery made the Sidekick, so Avery manages it. Robin is asked. Pat is in the Organization and nothing else. */
const MANAGER = asUserId("00000000-0000-7000-8000-0000005c7001");
const PERSON = asUserId("00000000-0000-7000-8000-0000005c7002");
const OTHER = asUserId("00000000-0000-7000-8000-0000005c7003");
const NOW = "2026-11-11T10:00:00.000Z";
const CONDITION = "it is about a pre-seed round";
const UNKNOWN_ID = "00000000-0000-7000-8000-0000005c7fff";

const app = createApp();

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

type Answer = { status: number; body: unknown; headers: Headers };

/** One request to the Worker app, drained, with its deferred work settled before the next assertion. */
async function send(path: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: unknown }): Promise<Answer> {
  const ctx = createExecutionContext();
  const response = await app.request(path, {
    method: init.method,
    headers: { ...init.headers, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }, env, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null, headers: response.headers };
}

/** A member route as this person's desktop session, or with no session at all for `null`. */
async function as(userId: string | null, method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
  const headers: Record<string, string> = userId === null ? {} : { authorization: `Bearer ${await issueAccessToken(env, {
    sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global" })}` };
  return send(path, { method, headers, ...(body === undefined ? {} : { body }) });
}

/** The emailed link's route, as the browser host's page posts it: its own origin and no credential. */
const postLink = (body: unknown) => send("/browser/source-requests/decision", { method: "POST", headers: { origin: "https://app.test" }, body });

/** The fields a link signed for this person and decision carries, as the email holds them. */
async function link(requestId: string, decision: "approve" | "decline", userId: string = PERSON) {
  const claim = { workspaceId: WORKSPACE_ID, sidekickId: SIDEKICK_ID, requestId, userId, decision };
  const fragment = new URLSearchParams(new URL(await sourceDecisionUrl(env, claim)).hash.slice(1));
  return { ...claim, token: fragment.get("token")! };
}

const sources = () => `/automations/${SIDEKICK_ID}/sources`;
const requests = () => `/automations/${SIDEKICK_ID}/source-requests`;
const decision = (requestId: string) => `/automations/${SIDEKICK_ID}/source-requests/${requestId}/decision`;
const withdraw = () => `/automations/${SIDEKICK_ID}/sources/withdraw`;
const READ = "/automations/source-requests/read";

const mail = (userIds: string[], more: Record<string, unknown> = {}) => ({
  userIds, connectorType: "google", eventTypes: ["email.received"], condition: CONDITION, ...more });

/** The manager asks one person over HTTP; the request's id. */
async function asked(userId: string = PERSON, more: Record<string, unknown> = {}): Promise<string> {
  const answer = await as(MANAGER, "POST", requests(), mail([userId], more));
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return (answer.body as { requests: Array<{ requestId: string }> }).requests[0]!.requestId;
}

const storedRequests = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
  user_id: string; state: string; requested_by_user_id: string;
}>(`SELECT user_id, state, requested_by_user_id FROM sidekick_source_requests ORDER BY created_at, request_id`).toArray());

const storedSources = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
  user_id: string; connection_id: string; condition: string | null; origin: string;
}>(`SELECT user_id, connection_id, condition, origin FROM sidekick_sources WHERE sidekick_id = ? ORDER BY user_id`, SIDEKICK_ID).toArray());

/** A person's own Google connection, held by the Organization object as production holds it. */
async function connectGoogle(userId: string, displayName: string): Promise<string> {
  const connectionId = crypto.randomUUID();
  await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
    `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name, granted_scopes_json, status,
        cursor_json, config_json, created_at, updated_at, model_plugin_id)
     VALUES (?, ?, 'google', 'personal', ?, ?, ?, '[]', 'healthy', '{}', '{}', ?, ?, ?)`,
    connectionId, WORKSPACE_ID, userId, `account-${userId}`, displayName, NOW, NOW, `plugin_google_${connectionId}`));
  return connectionId;
}

let PERSON_MAIL = "";

beforeEach(async () => {
  await reset();

  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  SIDEKICK_ID = crypto.randomUUID();
  CANVAS_ID = crypto.randomUUID();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: MANAGER, sessionId: `session-${MANAGER}` });
  await env.DB.batch([
    // This suite's D1 starts with no schema: what authentication, the object's placement and a request's view read.
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    env.DB.prepare(`ALTER TABLE users ADD COLUMN presentation_json TEXT`),
    env.DB.prepare(`ALTER TABLE users ADD COLUMN analytics_person_id TEXT`),
    env.DB.prepare(`UPDATE users SET name = 'Avery' WHERE id = ?`).bind(MANAGER),
    ...([[PERSON, "Robin"], [OTHER, "Pat"]] as const).flatMap(([userId, name]) => [
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at) VALUES (?, ?, ?, NULL, 'UTC', ?)`)
        .bind(userId, `${name.toLowerCase()}@example.com`, name, NOW),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at) VALUES (?, ?, 'active', 'member', 'member', ?)`)
        .bind(WORKSPACE_ID, userId, NOW),
      env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, WORKSPACE_ID),
    ]),
  ]);
  // A personal Sidekick: only its author opens or manages it. And a Canvas only its creator opens, where requests are asked.
  await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID, authorUserId: MANAGER, scope: "personal", authorityGeneration: 1 });
  await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
    `UPDATE automation_directory SET title = 'Deals' WHERE automation_id = ?`, SIDEKICK_ID));
  await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, title: "Pipeline", createdByUserId: MANAGER, authorityGeneration: 1 });
  PERSON_MAIL = await connectGoogle(PERSON, "robin@example.com");
});

describe("the Sidekick source routes, for a signed-in person", () => {
  it("answers every one of them 401 without a session, and asks nobody", async () => {
    for (const [method, path, body] of [
      ["GET", sources(), undefined],
      ["POST", requests(), mail([PERSON])],
      ["POST", decision(UNKNOWN_ID), { decision: "approve" }],
      ["POST", withdraw(), { connectionId: PERSON_MAIL }],
      ["POST", READ, { requestIds: [UNKNOWN_ID] }],
    ] as const) {
      const answer = await as(null, method, path, body);
      expect([path, answer.status, answer.body]).toEqual([path, 401, { error: expect.objectContaining({ code: "authentication_required" }) }]);
    }
    expect(await storedRequests()).toEqual([]);
  });

  it("asks another member with 201 and one pending request for them, approves an ask for the asker's own account, and lists both", async () => {
    const forRobin = await as(MANAGER, "POST", requests(), mail([PERSON]));
    expect(forRobin.status, JSON.stringify(forRobin.body)).toBe(201);
    expect(forRobin.body).toEqual({ sidekickId: SIDEKICK_ID, requests: [{
      requestId: expect.any(String), sidekickId: SIDEKICK_ID, sidekickName: "Deals",
      person: { userId: PERSON, displayName: "Robin", avatarUrl: null, presentation: null },
      connectorType: "google", eventTypes: ["email.received"], condition: CONDITION, state: "pending",
      // The asker and their name are the session's, read by the route: the body names neither.
      requestedByName: "Avery", yours: false, createdAt: expect.any(Number), decidedAt: null,
    }] });
    expect(await storedRequests()).toEqual([{ user_id: PERSON, state: "pending", requested_by_user_id: MANAGER }]);
    expect(await storedSources()).toEqual([]);

    const ownMail = await connectGoogle(MANAGER, "avery@example.com");
    const own = await as(MANAGER, "POST", requests(), mail([MANAGER], { condition: null }));
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body).toMatchObject({ sidekickId: SIDEKICK_ID, requests: [{
      person: { userId: MANAGER, displayName: "Avery" }, state: "approved", yours: true, condition: null, decidedAt: expect.any(Number) }] });
    expect((own.body as { requests: unknown[] }).requests).toHaveLength(1);

    const listed = await as(MANAGER, "GET", sources());
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toEqual({ sidekickId: SIDEKICK_ID,
      sources: [{ person: { userId: MANAGER, displayName: "Avery", avatarUrl: null, presentation: null }, connectionId: ownMail,
        connectionName: "avery@example.com", connectorType: "google", eventTypes: ["email.received"], condition: null, available: true, yours: true }],
      requests: [expect.objectContaining({ person: expect.objectContaining({ userId: PERSON }), state: "pending", yours: false })] });
  });

  it("refuses an ask, and a read of the sources, from a member who neither manages nor reads the Sidekick", async () => {
    const ask = await as(OTHER, "POST", requests(), mail([PERSON]));
    expect([ask.status, ask.body]).toEqual([403, { error: expect.objectContaining({ code: "sidekick_source_request_requires_manager" }) }]);
    const read = await as(OTHER, "GET", sources());
    expect([read.status, read.body]).toEqual([403, { error: expect.objectContaining({ code: "sidekick_forbidden" }) }]);
    expect(await storedRequests()).toEqual([]);
  });

  it("refuses with 400 a body that names who is acting, or anything else its schema does not declare", async () => {
    const requestId = await asked();
    for (const [userId, path, body] of [
      // The manager names the person asked as the one asking, and as the one answering.
      [MANAGER, requests(), mail([OTHER], { userId: PERSON })],
      [MANAGER, requests(), mail([OTHER], { requestedByUserId: PERSON })],
      [MANAGER, requests(), mail([OTHER], { actorRole: "owner" })],
      [MANAGER, decision(requestId), { decision: "approve", userId: PERSON }],
      [PERSON, decision(requestId), { decision: "approve", sourceVerdict: { admit: true } }],
      [MANAGER, withdraw(), { connectionId: PERSON_MAIL, userId: PERSON }],
      [OTHER, READ, { requestIds: [requestId], userId: PERSON }],
    ] as const) {
      const answer = await as(userId, "POST", path, body);
      expect([path, Object.keys(body), answer.status, answer.body])
        .toEqual([path, Object.keys(body), 400, { error: expect.objectContaining({ code: "invalid_request" }) }]);
    }
    // Nobody else was asked and nothing was answered.
    expect(await storedRequests()).toEqual([{ user_id: PERSON, state: "pending", requested_by_user_id: MANAGER }]);
    expect(await storedSources()).toEqual([]);
  });

  it("refuses an answer from anybody but the person asked with 403, and leaves the request waiting", async () => {
    const requestId = await asked();
    for (const [userId, choice] of [[MANAGER, "approve"], [OTHER, "approve"], [MANAGER, "decline"]] as const) {
      const answer = await as(userId, "POST", decision(requestId), { decision: choice });
      expect([userId, answer.status, answer.body])
        .toEqual([userId, 403, { error: expect.objectContaining({ code: "sidekick_source_request_not_yours" }) }]);
    }
    const missing = await as(PERSON, "POST", decision(UNKNOWN_ID), { decision: "approve" });
    expect([missing.status, missing.body]).toEqual([404, { error: expect.objectContaining({ code: "sidekick_source_request_not_found" }) }]);
    expect(await storedRequests()).toEqual([{ user_id: PERSON, state: "pending", requested_by_user_id: MANAGER }]);
    expect(await storedSources()).toEqual([]);
  });

  it("records the asked person's approval as their source, and their decline as none", async () => {
    const first = await asked();
    const approved = await as(PERSON, "POST", decision(first), { decision: "approve" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ requestId: first, sidekickId: SIDEKICK_ID, state: "approved", yours: true,
      person: { userId: PERSON, displayName: "Robin" }, requestedByName: "Avery", decidedAt: expect.any(Number) });
    // Approving let the person in: they read the sources they could not before, and theirs is among them.
    const theirs = await as(PERSON, "GET", sources());
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    expect(theirs.body).toEqual({ sidekickId: SIDEKICK_ID, requests: [],
      sources: [{ person: { userId: PERSON, displayName: "Robin", avatarUrl: null, presentation: null }, connectionId: PERSON_MAIL,
        connectionName: "robin@example.com", connectorType: "google", eventTypes: ["email.received"], condition: CONDITION,
        available: true, yours: true }] });

    // A second ask, under its own operation id, which the person declines.
    const operationId = crypto.randomUUID();
    const second = await asked(PERSON, { condition: "it is about a seed round", operationId });
    const declined = await as(PERSON, "POST", decision(second), { decision: "decline" });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body).toMatchObject({ requestId: second, state: "declined", yours: true, condition: "it is about a seed round" });
    // The same operation asked again answers with the request it made, as it now stands, and asks nobody twice.
    const replayed = await as(MANAGER, "POST", requests(), mail([PERSON], { condition: "it is about a seed round", operationId }));
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);
    expect((replayed.body as { requests: Array<{ requestId: string; state: string }> }).requests
      .map((entry) => ({ requestId: entry.requestId, state: entry.state }))).toEqual([{ requestId: second, state: "declined" }]);
    expect((await storedRequests()).map((entry) => entry.state)).toEqual(["approved", "declined"]);
    // The decline wrote nothing: the one source is still the one the approval gave.
    expect(await storedSources()).toEqual([{ user_id: PERSON, connection_id: PERSON_MAIL, condition: CONDITION, origin: "request" }]);
  });

  it("reads a request's card for whoever asked and for the person asked, and as an empty list for a member it does not concern", async () => {
    // Asked in a Canvas only the manager opens, about a Sidekick only the manager opens.
    const requestId = await asked(PERSON, { place: { parentKind: "canvas", parentId: CANVAS_ID } });
    const read = (userId: string, requestIds: string[] = [requestId]) => as(userId, "POST", READ, { requestIds });

    const uninvolved = await read(OTHER);
    expect([uninvolved.status, uninvolved.body]).toEqual([200, { requests: [] }]);

    const asker = await read(MANAGER);
    expect(asker.status, JSON.stringify(asker.body)).toBe(200);
    expect(asker.body).toEqual({ requests: [{
      requestId, sidekickId: SIDEKICK_ID, sidekickName: "Deals", person: { userId: PERSON, displayName: "Robin", avatarUrl: null, presentation: null },
      connectorType: "google", eventTypes: ["email.received"], condition: CONDITION, state: "pending", requestedByName: "Avery",
      yours: false, createdAt: expect.any(Number), decidedAt: null }] });

    const person = await read(PERSON);
    expect(person.status, JSON.stringify(person.body)).toBe(200);
    expect(person.body).toMatchObject({ requests: [{ requestId, state: "pending", yours: true }] });
    expect((person.body as { requests: unknown[] }).requests).toHaveLength(1);

    // An id no request has reads as nothing for anybody, beside one that exists.
    const mixed = await read(MANAGER, [UNKNOWN_ID, requestId]);
    expect((mixed.body as { requests: Array<{ requestId: string }> }).requests.map((entry) => entry.requestId)).toEqual([requestId]);
  });

  it("takes a person's own source back once, says so when there is nothing left to take, and takes back nobody else's", async () => {
    const requestId = await asked();
    expect((await as(PERSON, "POST", decision(requestId), { decision: "approve" })).status).toBe(200);
    expect(await storedSources()).toEqual([{ user_id: PERSON, connection_id: PERSON_MAIL, condition: CONDITION, origin: "request" }]);

    // The manager names the person's connection: whose source it is comes from the session, so nothing is theirs to take.
    const byManager = await as(MANAGER, "POST", withdraw(), { connectionId: PERSON_MAIL });
    expect([byManager.status, byManager.body]).toEqual([200, { withdrawn: false }]);
    expect(await storedSources()).toHaveLength(1);

    const once = await as(PERSON, "POST", withdraw(), { connectionId: PERSON_MAIL });
    expect([once.status, once.body]).toEqual([200, { withdrawn: true }]);
    expect(await storedSources()).toEqual([]);
    const again = await as(PERSON, "POST", withdraw(), { connectionId: PERSON_MAIL });
    expect([again.status, again.body]).toEqual([200, { withdrawn: false }]);
    // What the manager now reads: nobody lets events in, and the answered request is not waiting.
    expect((await as(MANAGER, "GET", sources())).body).toEqual({ sidekickId: SIDEKICK_ID, sources: [], requests: [] });
  });
});

describe("POST /browser/source-requests/decision, the emailed link", () => {
  it("refuses with 400 a body that is not exactly a link's fields, signed or not", async () => {
    const requestId = await asked();
    const signed = await link(requestId, "approve");
    for (const body of [
      // Every field of a link but its signature.
      { workspaceId: signed.workspaceId, sidekickId: signed.sidekickId, requestId, userId: signed.userId, decision: signed.decision },
      { ...signed, decision: "maybe" },
      { ...signed, requestId: "not-an-id" },
      // A correctly signed link carrying one more field is still not a link.
      { ...signed, region: "global" },
      [signed],
    ]) {
      const answer = await postLink(body);
      expect([JSON.stringify(body), answer.status, answer.body])
        .toEqual([JSON.stringify(body), 400, { error: expect.objectContaining({ code: "invalid_request" }) }]);
    }
    expect(await storedRequests()).toEqual([{ user_id: PERSON, state: "pending", requested_by_user_id: MANAGER }]);
  });

  it("records the answer of a signed link posted with no session, as the person it was signed for", async () => {
    const requestId = await asked();
    const answer = await postLink(await link(requestId, "approve"));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toEqual({ state: "approved", applied: true, sidekickName: "Deals", requestedByName: "Avery", connectorName: "Gmail",
      eventLabels: ["Email received"], condition: CONDITION });
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await storedSources()).toEqual([{ user_id: PERSON, connection_id: PERSON_MAIL, condition: CONDITION, origin: "request" }]);
  });

  it("answers a signed link for a person who has since left the Organization as a request that does not exist, and decides nothing", async () => {
    const requestId = await asked();
    const decline = await link(requestId, "decline");
    const approve = await link(requestId, "approve");
    await changeRelationships(env, WORKSPACE_ID, [PERSON],
      env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).bind(WORKSPACE_ID, PERSON));
    for (const signed of [decline, approve]) {
      const answer = await postLink(signed);
      expect([signed.decision, answer.status, answer.body])
        .toEqual([signed.decision, 404, { error: expect.objectContaining({ code: "sidekick_source_request_not_found" }) }]);
    }
    expect(await storedRequests()).toEqual([{ user_id: PERSON, state: "pending", requested_by_user_id: MANAGER }]);
    expect(await storedSources()).toEqual([]);
  });
});
