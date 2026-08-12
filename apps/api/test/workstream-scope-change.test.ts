import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import type * as Integrations from "../src/services/integrations";
import { WorkstreamService } from "../src/services/workstream-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async ensureWorkstreamAddress() { return { emailAddress: null }; }
    async backfillWorkstreamAddresses() { return []; }
  },
}));

const published = vi.hoisted(() => [] as { workstreamId: string; event: Record<string, unknown> }[]);
vi.mock("../src/services/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof Integrations>()),
  publishWorkstreamEvent: async (
    _env: unknown,
    _workspaceId: string,
    workstreamId: string,
    event: Record<string, unknown>,
  ) => {
    published.push({ workstreamId, event });
  },
}));

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const OWNER = "00000000-0000-7000-8000-000000000002";
const COLLEAGUE = "00000000-0000-7000-8000-000000000003";
const BYSTANDER = "00000000-0000-7000-8000-000000000004";
const SHARED = "00000000-0000-7000-8000-000000000010";
const GENERATED = "00000000-0000-7000-8000-000000000011";
const MACHINERY = "00000000-0000-7000-8000-000000000012";
const SUBSCRIPTION = "00000000-0000-7000-8000-000000000020";
const TEMPLATE = "00000000-0000-7000-8000-000000000021";
const TEMPLATE_VERSION = "00000000-0000-7000-8000-000000000022";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
beforeEach(() => published.splice(0));

function serviceFor(database: DatabaseSync, userId: string): WorkstreamService {
  const auth: AuthContext = {
    sessionId: "session-1", userId, workspaceId: WORKSPACE, region: "global", role: "member",
  };
  return new WorkstreamService(
    createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" }),
    auth,
  );
}

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  const at = "2026-01-01T00:00:00.000Z";
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Owner', '${at}', '${at}'),
           ('${COLLEAGUE}', 'g-colleague', 'colleague@example.com', 'Colleague', '${at}', '${at}'),
           ('${BYSTANDER}', 'g-bystander', 'bystander@example.com', 'Bystander', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '${at}'),
           ('${WORKSPACE}', '${COLLEAGUE}', 'member', 'active', '${at}'),
           ('${WORKSPACE}', '${BYSTANDER}', 'member', 'active', '${at}');
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state, created_at, updated_at)
    VALUES ('${TEMPLATE}', '${WORKSPACE}', '${OWNER}', 'Daily brief', '', 'private', '${at}', '${at}');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json,
       created_by_user_id, created_at)
    VALUES ('${TEMPLATE_VERSION}', '${TEMPLATE}', 1, 'Write the brief', '[]', '${OWNER}', '${at}');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, status, created_at, updated_at)
    VALUES ('${SUBSCRIPTION}', '${WORKSPACE}', '${TEMPLATE}', '${TEMPLATE_VERSION}', 'personal',
            '${OWNER}', '{}', 'active', '${at}', '${at}');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
       created_by_user_id, automation_subscription_id, harness_status, next_sequence_number,
       last_activity_at, created_at, updated_at, system_kind, scope)
    VALUES
      ('${SHARED}', '${WORKSPACE}', 'Compensation review', '', 'shared@automation.example', 'active',
       'ad_hoc', '${OWNER}', NULL, 'idle', 1, '2026-01-04T00:00:00.000Z', '${at}', '${at}', NULL, 'workspace'),
      ('${GENERATED}', '${WORKSPACE}', 'Daily brief', '', 'brief@automation.example', 'active',
       'automation', NULL, '${SUBSCRIPTION}', 'idle', 1, '2026-01-03T00:00:00.000Z', '${at}', '${at}', NULL, 'workspace'),
      ('${MACHINERY}', '${WORKSPACE}', 'Digest · Owner', '', 'digest@automation.example', 'active',
       'ad_hoc', '${OWNER}', NULL, 'idle', 1, '2026-01-02T00:00:00.000Z', '${at}', '${at}', 'digest', 'personal');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${SHARED}', '${OWNER}', '${OWNER}', 'creator', '${at}'),
           ('${MACHINERY}', '${OWNER}', '${OWNER}', 'creator', '${at}');
  `);
  return database;
}

async function participantIds(database: DatabaseSync, workstreamId: string): Promise<string[]> {
  const rows = await sqliteD1(database)
    .prepare(`SELECT user_id FROM workstream_participants
              WHERE workstream_id = ? AND removed_at IS NULL ORDER BY user_id`)
    .bind(workstreamId)
    .all<{ user_id: string }>();
  return (rows.results ?? []).map((row) => row.user_id);
}

describe("changing who may read a work stream", () => {
  it("closes it to the people in it, and to nobody else", async () => {
    const database = seededDatabase();
    expect((await serviceFor(database, BYSTANDER).get(SHARED)).id).toBe(SHARED);

    const updated = await serviceFor(database, OWNER).update(SHARED, { scope: "personal" });

    expect(updated.scope).toBe("personal");
    await expect(serviceFor(database, BYSTANDER).get(SHARED)).rejects.toMatchObject({ status: 404 });
    // Nothing is left for them: the other row belongs to a personal automation
    // that is not theirs, which is the separate rule this one does not touch.
    expect((await serviceFor(database, BYSTANDER).list(20)).items).toEqual([]);
  });

  it("lets anyone still in it bring somebody else in", async () => {
    const database = seededDatabase();
    await serviceFor(database, OWNER).update(SHARED, { scope: "personal" });

    // Being in a private work stream is the authority — not owning it, and not
    // an administrator's role.
    await serviceFor(database, OWNER).addParticipant(SHARED, COLLEAGUE);
    expect((await serviceFor(database, COLLEAGUE).get(SHARED)).id).toBe(SHARED);

    await serviceFor(database, COLLEAGUE).addParticipant(SHARED, BYSTANDER);
    expect((await serviceFor(database, BYSTANDER).get(SHARED)).id).toBe(SHARED);
  });

  it("keeps whoever made it private inside it", async () => {
    const database = seededDatabase();
    // A member who was only reading it — nothing has made them a participant.
    expect(await participantIds(database, SHARED)).toEqual([OWNER]);

    const updated = await serviceFor(database, COLLEAGUE).update(SHARED, { scope: "personal" });

    expect(updated.scope).toBe("personal");
    // Otherwise the one action that closes a work stream would be the one that
    // locks its author out of it.
    expect(await participantIds(database, SHARED)).toEqual([OWNER, COLLEAGUE].sort());
    expect((await serviceFor(database, COLLEAGUE).get(SHARED)).id).toBe(SHARED);
    // And they are announced, or they would be a participant in D1 and absent
    // from every open right rail — their own included — until a reload.
    expect(published.map((entry) => entry.event.type))
      .toEqual(["participant_added", "workstream_scope_changed"]);
  });

  it("does not announce a join by somebody who was already in it", async () => {
    const database = seededDatabase();

    // The owner has been a participant since it was created. Closing the work
    // stream does not make them a new arrival, and saying so would refresh
    // every reader's participant list and HyperSight for nothing.
    await serviceFor(database, OWNER).update(SHARED, { scope: "personal" });

    expect(published.map((entry) => entry.event.type)).toEqual(["workstream_scope_changed"]);
  });

  it("keeps the participant and the scope together when the write fails", async () => {
    const database = seededDatabase();
    const service = serviceFor(database, COLLEAGUE);
    // A batch, so the pair is all-or-nothing: the alternative leaves a stray
    // `explicit` participant on a work stream that stayed public, which nothing
    // ever cleans up and a retry cannot undo.
    database.exec("DROP TABLE workstream_description_refreshes");
    await expect(service.update(SHARED, { scope: "personal", objective: "Closed-door review" }))
      .rejects.toThrow();

    expect(await participantIds(database, SHARED)).toEqual([OWNER]);
    expect((await serviceFor(database, OWNER).get(SHARED)).scope).toBe("workspace");
  });

  it("opens it back up to the workspace", async () => {
    const database = seededDatabase();
    await serviceFor(database, OWNER).update(SHARED, { scope: "personal" });

    const updated = await serviceFor(database, OWNER).update(SHARED, { scope: "workspace" });

    expect(updated.scope).toBe("workspace");
    expect((await serviceFor(database, BYSTANDER).get(SHARED)).id).toBe(SHARED);
    // Nobody is removed by opening it: the people in it are still in it.
    expect(await participantIds(database, SHARED)).toEqual([OWNER]);
  });

  it("tells the room, so the people reading it learn the new state", async () => {
    const database = seededDatabase();

    await serviceFor(database, OWNER).update(SHARED, { scope: "personal" });

    expect(published).toEqual([
      { workstreamId: SHARED, event: { type: "workstream_scope_changed", scope: "personal" } },
    ]);
  });

  it("says nothing when a request restates the scope it already has", async () => {
    const database = seededDatabase();

    const updated = await serviceFor(database, OWNER).update(SHARED, { scope: "workspace" });

    expect(updated.scope).toBe("workspace");
    expect(published).toEqual([]);
    expect(await participantIds(database, SHARED)).toEqual([OWNER]);
  });

  it("refuses a work stream whose audience an automation decides", async () => {
    const database = seededDatabase();

    // Closing it would hide it from the automation's owner, who reads it by
    // owning the automation rather than by being a participant; opening it
    // would broaden nothing, because that same rule still applies.
    await expect(serviceFor(database, OWNER).update(GENERATED, { scope: "personal" }))
      .rejects.toMatchObject({ status: 422, code: "scope_change_unsupported" });
  });

  it("refuses a work stream that belongs to Avalon itself", async () => {
    const database = seededDatabase();

    // A digest is assembled from one person's private activity.
    await expect(serviceFor(database, OWNER).update(MACHINERY, { scope: "workspace" }))
      .rejects.toMatchObject({ status: 422, code: "scope_change_unsupported" });
    expect((await serviceFor(database, OWNER).get(MACHINERY)).scope).toBe("personal");
  });

  it("leaves the title and description alone", async () => {
    const database = seededDatabase();

    const updated = await serviceFor(database, OWNER).update(SHARED, { scope: "personal" });

    expect(updated).toMatchObject({ title: "Compensation review", objective: "" });
  });
});
