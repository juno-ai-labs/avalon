import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __testing } from "../src/queues/activity-consumer";
import {
  latestActivityEventCursor,
  listActivityEventsForUser,
} from "../src/services/activity-event-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const { projectActivityEvent } = __testing;

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const MEMBER_A = "00000000-0000-7000-8000-000000000002";
const MEMBER_B = "00000000-0000-7000-8000-000000000003";
const CONNECTION = "00000000-0000-7000-8000-000000000004";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function envFor(database: DatabaseSync): Env {
  return { DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" } as unknown as Env;
}

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${MEMBER_A}', 'g-a', 'a@example.com', 'A', '2026-01-01', '2026-01-01'),
           ('${MEMBER_B}', 'g-b', 'b@example.com', 'B', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${MEMBER_A}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${MEMBER_A}', 'owner', 'active', '2026-01-01'),
           ('${WORKSPACE}', '${MEMBER_B}', 'member', 'active', '2026-01-01');
  `);
  return database;
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-7000-8000-0000000000a1",
    workspace_id: WORKSPACE,
    workspace_region: "global",
    connection_id: CONNECTION,
    connector_type: "slack",
    connection_scope: "workspace",
    connection_owner_user_id: null,
    provider: "slack",
    provider_event_id: "ev-1",
    event_type: "message.posted",
    resource_type: "message",
    provider_resource_id: "C1/1",
    actor_json: JSON.stringify({ displayName: "Dana Okafor" }),
    occurred_at: "2026-08-11T09:00:00.000Z",
    received_at: "2026-08-11T09:00:01.000Z",
    title: "Dana posted in #launch",
    summary: "Shipped the installer",
    text_snippet: "Shipped the installer",
    visibility_json: "{}",
    target_user_ids_json: "[]",
    entity_keys_json: "[]",
    metadata_json: JSON.stringify({ url: "https://slack.example/archives/C1/p1" }),
    processing_status: "processed",
    ...overrides,
  } as Parameters<typeof projectActivityEvent>[1];
}

async function readFor(env: Env, userId: string) {
  const through = await latestActivityEventCursor(env, WORKSPACE);
  return await listActivityEventsForUser(env, { workspaceId: WORKSPACE, userId, through, limit: 50 });
}

describe("projecting connector activity into the activity log", () => {
  it("shares a public workspace activity with every member", async () => {
    const env = envFor(seededDatabase());

    await projectActivityEvent(env, activity());

    expect(await readFor(env, MEMBER_A)).toHaveLength(1);
    expect(await readFor(env, MEMBER_B)).toHaveLength(1);
  });

  it("keeps a restricted workspace activity to the people it names", async () => {
    const env = envFor(seededDatabase());

    // A Slack private channel or DM arrives on the workspace-wide installation
    // but is readable only by its participants, so `connection_scope` alone is
    // not the audience.
    await projectActivityEvent(env, activity({
      visibility_json: JSON.stringify({ workspaceAutomationAllowed: false, allowedUserIds: [MEMBER_B] }),
    }));

    expect(await readFor(env, MEMBER_A)).toEqual([]);
    expect(await readFor(env, MEMBER_B)).toHaveLength(1);
  });

  it("records nothing at all when an activity names nobody", async () => {
    const database = seededDatabase();
    const env = envFor(database);

    await projectActivityEvent(env, activity({
      visibility_json: JSON.stringify({ workspaceAutomationAllowed: false }),
    }));

    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_events").get()).toEqual({ count: 0 });
  });

  it("keeps a personal connection's activity to its owner", async () => {
    const env = envFor(seededDatabase());

    await projectActivityEvent(env, activity({
      connection_scope: "personal",
      connection_owner_user_id: MEMBER_A,
    }));

    expect(await readFor(env, MEMBER_A)).toHaveLength(1);
    expect(await readFor(env, MEMBER_B)).toEqual([]);
  });

  it("carries the provider's actor name and link rather than falling back", async () => {
    const env = envFor(seededDatabase());

    await projectActivityEvent(env, activity());

    const [event] = await readFor(env, MEMBER_A);
    expect(event?.actor_label).toBe("Dana Okafor");
    expect(event?.canonical_url).toBe("https://slack.example/archives/C1/p1");
  });

  it("falls back to the provider name when the actor is unknown", async () => {
    const env = envFor(seededDatabase());

    await projectActivityEvent(env, activity({ actor_json: "{}", metadata_json: "{}" }));

    const [event] = await readFor(env, MEMBER_A);
    expect(event?.actor_label).toBe("slack");
    expect(event?.canonical_url).toBeNull();
  });

  it("writes one row for a re-processed activity", async () => {
    const database = seededDatabase();
    const env = envFor(database);

    await projectActivityEvent(env, activity());
    await projectActivityEvent(env, activity());

    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_events").get()).toEqual({ count: 1 });
  });
});
