import { asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __testing } from "../src/queues/activity-consumer";
import {
  latestActivityEventCursor,
  listActivityEventsForUser,
  reapExpiredActivityEvents,
} from "../src/services/activity-event-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";

const { projectActivityEvent } = __testing;

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const MEMBER_A = "00000000-0000-7000-8000-000000000002";
const MEMBER_B = "00000000-0000-7000-8000-000000000003";
const CONNECTION = "00000000-0000-7000-8000-000000000004";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  // Restored here rather than at the end of the test that installs it: a
  // failing assertion would skip an inline restore, and `vi.spyOn` on an
  // already-spied method returns the same spy, so the next test would inherit
  // this one's call history.
  vi.restoreAllMocks();
});

function envFor(database: DatabaseSync): Env {
  // The Slack credentials are what put Slack in this env's connector registry,
  // and the registry is what answers whether an event type is digestible.
  // Without them every projection here would be withheld for the uninteresting
  // reason that the connector is unregistered in this region.
  return createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_API_BASE_URL: "https://api.example.com",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  });
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
    // Deliberately widened: the row type carries a plain string column.
    workspace_id: WORKSPACE as string,
    workspace_region: "global",
    connection_id: CONNECTION,
    connector_type: "slack",
    connection_scope: "workspace",
    connection_owner_user_id: null,
    provider: "slack",
    provider_event_id: "ev-1",
    event_type: "slack.message.posted",
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

/** Everything this person may see, digestible or not — an audience question. */
async function readFor(env: Env, userId: string) {
  const through = await latestActivityEventCursor(env, WORKSPACE);
  return await listActivityEventsForUser(env, {
    workspaceId: WORKSPACE, userId, through, digestibleOnly: false, limit: 50,
  });
}

/** Only what a connector confirmed is worth telling this person about. */
async function digestReadFor(env: Env, userId: string) {
  const through = await latestActivityEventCursor(env, WORKSPACE);
  return await listActivityEventsForUser(env, {
    workspaceId: WORKSPACE, userId, through, digestibleOnly: true, limit: 50,
  });
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

describe("deciding what a digest may read back", () => {
  it("carries the connector manifest's answer onto the event", async () => {
    const env = envFor(seededDatabase());

    await projectActivityEvent(env, activity());
    await projectActivityEvent(env, activity({
      id: "00000000-0000-7000-8000-0000000000a2",
      provider_event_id: "ev-2",
      event_type: "slack.reaction.added",
      title: "Dana reacted",
    }));

    // Both happened and both are readable; only the one Slack declared
    // digestible is something to interrupt somebody with.
    expect(await readFor(env, MEMBER_A)).toHaveLength(2);
    expect((await digestReadFor(env, MEMBER_A)).map((event) => event.event_type))
      .toEqual(["connector.slack.slack.message.posted"]);
  });

  it("withholds an activity whose polling stream withheld itself", async () => {
    const env = envFor(seededDatabase());

    // Stamped by the poll host when a stream declares itself non-digestible.
    // The event type still says digestible; a stream may only ever subtract.
    await projectActivityEvent(env, activity({
      metadata_json: JSON.stringify({ _streamNotDigestible: true }),
    }));

    expect(await readFor(env, MEMBER_A)).toHaveLength(1);
    expect(await digestReadFor(env, MEMBER_A)).toEqual([]);
  });

  it("says so when the registry itself could not be built", async () => {
    const env = envFor(seededDatabase());
    // One malformed credential fails every adapter, so this withholds every
    // connector's activity region-wide rather than one connector's. Silent, it
    // is indistinguishable from a quiet week: every digest would settle empty
    // and advance its cursor over the discarded window.
    (env as unknown as Record<string, unknown>).SLACK_SIGNING_SECRET = "signing";
    (env as unknown as Record<string, unknown>).PUBLIC_API_BASE_URL = "not a url";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await projectActivityEvent(env, activity());

    expect(await digestReadFor(env, MEMBER_A)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "connector_registry_unavailable_for_digestibility",
      connector_type: "slack",
    }));
  });

  it("stays quiet about a connector this region simply does not register", async () => {
    const env = envFor(seededDatabase());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await projectActivityEvent(env, activity({ connector_type: "unregistered_provider" }));

    // Expected, and withholding is the whole point of failing closed.
    expect(await digestReadFor(env, MEMBER_A)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("withholds an event type no registered connector declares", async () => {
    const env = envFor(seededDatabase());

    // A connector unregistered in this region, or an event type dropped from a
    // manifest, is nobody confirming anything. It still reaches the log.
    await projectActivityEvent(env, activity({ connector_type: "unregistered_provider" }));
    await projectActivityEvent(env, activity({
      id: "00000000-0000-7000-8000-0000000000a3",
      provider_event_id: "ev-3",
      event_type: "slack.invented.event",
    }));

    expect(await readFor(env, MEMBER_A)).toHaveLength(2);
    expect(await digestReadFor(env, MEMBER_A)).toEqual([]);
  });
});

describe("activity log retention", () => {
  function writeEvent(database: DatabaseSync, id: string, createdAt: string): void {
    database.exec(`
      INSERT INTO activity_events
        (id, workspace_id, event_type, subject_type, actor_type, actor_label, title,
         audience_kind, occurred_at, created_at, source_kind, dedupe_key)
      VALUES ('${id}', '${WORKSPACE}', 'workstream.message.posted', 'message', 'user', 'A', 'Posted',
              'workspace', '${createdAt}', '${createdAt}', 'workstream', 'dedupe-${id}');
      INSERT INTO activity_event_targets (event_id, workspace_id, user_id, relation, created_at)
      VALUES ('${id}', '${WORKSPACE}', '${MEMBER_A}', 'mentioned', '${createdAt}');
    `);
  }

  function daysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  }

  it("drops events past the window and takes their targets with them", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    writeEvent(database, "00000000-0000-7000-8000-0000000000e1", daysAgo(120));
    writeEvent(database, "00000000-0000-7000-8000-0000000000e2", daysAgo(1));

    expect(await reapExpiredActivityEvents(env)).toBe(1);

    expect(database.prepare("SELECT id FROM activity_events").all())
      .toEqual([{ id: "00000000-0000-7000-8000-0000000000e2" }]);
    expect(database.prepare("SELECT event_id FROM activity_event_targets").all())
      .toEqual([{ event_id: "00000000-0000-7000-8000-0000000000e2" }]);
  });

  // Reaping must not move a cursor: an expired sequence sits below every live
  // one, so a window that has lost its rows reads as empty rather than as new.
  it("leaves the cursor where it was", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    writeEvent(database, "00000000-0000-7000-8000-0000000000e1", daysAgo(120));
    writeEvent(database, "00000000-0000-7000-8000-0000000000e2", daysAgo(1));
    const before = await latestActivityEventCursor(env, WORKSPACE);

    await reapExpiredActivityEvents(env);

    expect(await latestActivityEventCursor(env, WORKSPACE)).toBe(before);
  });

  it("does nothing when everything is still inside the window", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    writeEvent(database, "00000000-0000-7000-8000-0000000000e1", daysAgo(89));

    expect(await reapExpiredActivityEvents(env)).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_events").get()).toEqual({ count: 1 });
  });
});
