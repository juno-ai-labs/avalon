import { asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __testing, processConnectorEvent } from "../src/queues/activity-consumer";
import type { WorkspaceConnectorEvent } from "../src/durable-objects/workspace-connector-event-protocol";
import type { ActivityEventInput } from "../src/services/activity-event-service";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import { testSubstreamAgentsBinding } from "./helpers/durable-authority";

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

/**
 * Capture what the projection decides, at the boundary where it decides it.
 *
 * These tests used to write through `recordActivityEventOrThrow`'s D1 arm and
 * read the rows back. That arm is gone — the authority is open everywhere, so
 * the open branch was the only live one and it delegates to WorkspaceDO. What
 * `projectActivityEvent` is actually responsible for is the *input* it hands
 * that object: who the audience is, whether anyone should be told, and how the
 * actor and link resolve. Asserting on that is a closer test of this code than
 * reading rows back was, and it does not depend on the object's read filter.
 *
 * What the read-back also covered — the object's audience filtering and its
 * dedupe on `dedupeKey` — is WorkspaceDO's behavior and belongs on real
 * workerd. That gap is recorded in `docs/potential-bugs.md`.
 */
function envFor(database: DatabaseSync): { env: Env; recorded: ActivityEventInput[] } {
  const recorded: ActivityEventInput[] = [];
  // The Slack credentials are what put Slack in this env's connector registry,
  // and the registry is what answers whether an event type is digestible.
  // Without them every projection here would be withheld for the uninteresting
  // reason that the connector is unregistered in this region.
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_API_BASE_URL: "https://api.example.com",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        recordActivityEvent: (input: ActivityEventInput) => {
          recorded.push(input);
          return input.eventId ?? `event-${recorded.length}`;
        },
      },
    }),
  });
  return { env, recorded };
}

/** Whether the projection decided this person is in the audience. */
function audienceIncludes(input: ActivityEventInput | undefined, userId: string): boolean {
  if (!input) return false;
  if (input.audience.kind === "workspace") return true;
  return input.audience.kind === "user" && input.audience.userId === userId;
}

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
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

function connectorEvent(): WorkspaceConnectorEvent {
  return {
    connectorType: "slack",
    activity: {
      id: "00000000-0000-7000-8000-0000000000a1",
      workspaceId: WORKSPACE,
      region: "global",
      connectionId: CONNECTION,
      connectionScope: "workspace",
      connectionOwnerUserId: null,
      provider: "slack",
      providerEventId: "ev-1",
      eventType: "slack.message.posted",
      resourceType: "message",
      providerResourceId: "C1/1",
      actor: { displayName: "Dana Okafor" },
      subject: {},
      occurredAt: "2026-08-11T09:00:00.000Z",
      receivedAt: "2026-08-11T09:00:01.000Z",
      title: "Dana posted in #launch",
      summary: "Shipped the installer",
      textSnippet: "Shipped the installer",
      payloadRef: null,
      visibility: { kind: "workspace" },
      targetUserIds: [],
      entityKeys: [],
      dedupeKey: "slack:ev-1",
      rawContentHash: null,
      metadata: {},
      externalPeople: [],
    },
  };
}

function processingEnv(matched: boolean): { env: Env; recorded: ActivityEventInput[] } {
  const database = seededDatabase();
  const recorded: ActivityEventInput[] = [];
  const event = connectorEvent();
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_API_BASE_URL: "https://api.example.com",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        matchExternalEventDestinations: () => ({ matched, deliveries: [] }),
        connectorEvent: () => event,
        recordActivityEvent: (input: ActivityEventInput) => {
          recorded.push(input);
          return input.eventId ?? `event-${recorded.length}`;
        },
      },
    }),
  });
  return { env, recorded };
}

describe("processing connector activity", () => {
  it.each([true, false])("projects the event once and logs whether a route claimed it (claimed: %s)", async (matched) => {
    const { env, recorded } = processingEnv(matched);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await processConnectorEvent(env, connectorEvent());

    expect(recorded).toHaveLength(1);
    expect(completionLog(info)).toMatchObject({ deterministic_route_claimed: matched, outcome: "processed" });
  });
});

/** The consumer's terminal log entry, as the structured logger handed it to the console. */
function completionLog(info: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const entries = info.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry?.event === "connector_event_processing_completed");
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

describe("projecting connector activity into the activity log", () => {
  it("shares a public workspace activity with every member", async () => {
    const { env, recorded } = envFor(seededDatabase());

    await projectActivityEvent(env, activity());

    expect(recorded[0]?.audience).toEqual({ kind: "workspace" });
  });

  it("keeps a restricted workspace activity to the people it names", async () => {
    const { env, recorded } = envFor(seededDatabase());

    // A Slack private channel or DM arrives on the workspace-wide installation
    // but is readable only by its participants, so `connection_scope` alone is
    // not the audience.
    await projectActivityEvent(env, activity({
      visibility_json: JSON.stringify({ workspaceAutomationAllowed: false, allowedUserIds: [MEMBER_B] }),
    }));

    expect(audienceIncludes(recorded[0], MEMBER_A)).toBe(false);
    expect(audienceIncludes(recorded[0], MEMBER_B)).toBe(true);
  });

  it("records nothing at all when an activity names nobody", async () => {
    const { env, recorded } = envFor(seededDatabase());

    await projectActivityEvent(env, activity({
      visibility_json: JSON.stringify({ workspaceAutomationAllowed: false }),
    }));

    expect(recorded).toEqual([]);
  });

  it("keeps a personal connection's activity to its owner", async () => {
    const { env, recorded } = envFor(seededDatabase());

    await projectActivityEvent(env, activity({
      connection_scope: "personal",
      connection_owner_user_id: MEMBER_A,
    }));

    expect(recorded[0]?.audience).toEqual({ kind: "user", userId: MEMBER_A });
  });

  it("carries the provider's actor name and link rather than falling back", async () => {
    const { env, recorded } = envFor(seededDatabase());

    await projectActivityEvent(env, activity());

    expect(recorded[0]?.actorLabel).toBe("Dana Okafor");
    expect(recorded[0]?.canonicalUrl).toBe("https://slack.example/archives/C1/p1");
  });

  it("falls back to the provider name when the actor is unknown", async () => {
    const { env, recorded } = envFor(seededDatabase());

    await projectActivityEvent(env, activity({ actor_json: "{}", metadata_json: "{}" }));

    expect(recorded[0]?.actorLabel).toBe("slack");
    expect(recorded[0]?.canonicalUrl).toBeNull();
  });

  it("gives a re-processed activity the same dedupe key both times", async () => {
    const { env, recorded } = envFor(seededDatabase());

    await projectActivityEvent(env, activity());
    await projectActivityEvent(env, activity());

    // Collapsing the two is WorkspaceDO's `ON CONFLICT`; what this side owes is
    // a key that is stable across re-processing, which is what makes that work.
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.dedupeKey).toBe(recorded[1]?.dedupeKey);
  });
});

describe("deciding what a digest may read back", () => {
  it("carries the connector manifest's answer onto the event", async () => {
    const { env, recorded } = envFor(seededDatabase());

    await projectActivityEvent(env, activity());
    await projectActivityEvent(env, activity({
      id: "00000000-0000-7000-8000-0000000000a2",
      provider_event_id: "ev-2",
      event_type: "slack.reaction.added",
      title: "Dana reacted",
    }));

    // Both happened and both are readable; only the one Slack declared
    // digestible is something to interrupt somebody with.
    expect(recorded.map((event) => [event.eventType, event.digestible])).toEqual([
      ["connector.slack.slack.message.posted", true],
      ["connector.slack.slack.reaction.added", false],
    ]);
  });

  it("withholds an activity whose polling stream withheld itself", async () => {
    const { env, recorded } = envFor(seededDatabase());

    // Stamped by the poll host when a stream declares itself non-digestible.
    // The event type still says digestible; a stream may only ever subtract.
    await projectActivityEvent(env, activity({
      metadata_json: JSON.stringify({ _streamNotDigestible: true }),
    }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.digestible).toBe(false);
  });

  it("says so when the registry itself could not be built", async () => {
    const { env, recorded } = envFor(seededDatabase());
    // One malformed credential fails every adapter, so this withholds every
    // connector's activity region-wide rather than one connector's. Silent, it
    // is indistinguishable from a quiet week: every digest would settle empty
    // and advance its cursor over the discarded window.
    (env as unknown as Record<string, unknown>).SLACK_SIGNING_SECRET = "signing";
    (env as unknown as Record<string, unknown>).PUBLIC_API_BASE_URL = "not a url";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await projectActivityEvent(env, activity());

    expect(recorded[0]?.digestible).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "connector_registry_unavailable_for_digestibility",
      connector_type: "slack",
    }));
  });

  it("stays quiet about a connector this region simply does not register", async () => {
    const { env, recorded } = envFor(seededDatabase());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await projectActivityEvent(env, activity({ connector_type: "unregistered_provider" }));

    // Expected, and withholding is the whole point of failing closed.
    expect(recorded[0]?.digestible).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("withholds an event type no registered connector declares", async () => {
    const { env, recorded } = envFor(seededDatabase());

    // A connector unregistered in this region, or an event type dropped from a
    // manifest, is nobody confirming anything. It still reaches the log.
    await projectActivityEvent(env, activity({ connector_type: "unregistered_provider" }));
    await projectActivityEvent(env, activity({
      id: "00000000-0000-7000-8000-0000000000a3",
      provider_event_id: "ev-3",
      event_type: "slack.invented.event",
    }));

    expect(recorded).toHaveLength(2);
    expect(recorded.map((event) => event.digestible)).toEqual([false, false]);
  });
});

// The "activity log retention" suite is gone with the reaper it covered.
// `reapExpiredActivityEvents` scanned D1's `activity_events`, returned 0
// immediately once the authority was open, and named a table migration 0090
// dropped — so it did nothing in any supported deployment. Retention for the
// object-owned log belongs to WorkspaceDO, which owns those rows now.
