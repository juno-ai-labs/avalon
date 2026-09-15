import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RetirementRefusedError } from "../src/durable-objects/object-retirement";
import { consumeAccessRevocationQueue } from "../src/queues/access-revocation-consumer";
import { consumeProductFeatureFlagQueue } from "../src/queues/product-feature-flag-consumer";
import { reconcileDigestDefaults } from "../src/services/digest-service";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * What a background caller does when the object it reaches has been retired.
 *
 * Retirement leaves every D1 row in place, so the enumerators that drive the
 * Queue consumers, the connector Workflow and the digest cron keep naming a
 * retired workspace, and its objects refuse them the same way on every
 * delivery. A consumer that retried that refusal dead-lettered one message
 * per retired object forever — the signal this repository treats as its
 * monitoring, spent on a state somebody designed. So a refusal is terminal
 * for background work: the message is acknowledged, the cron pass moves on,
 * and this file is where that decision is pinned for each caller.
 */

const NOW = "2026-09-08T12:00:00.000Z";
const OWNER = "00000000-0000-7000-8000-00000000c001";
const MEMBER = "00000000-0000-7000-8000-00000000c002";
const OPEN_WORKSPACE = "00000000-0000-7000-8000-00000000c101";
const CLOSED_WORKSPACE = "00000000-0000-7000-8000-00000000c102";
const AUTOMATION = "00000000-0000-7000-8000-00000000c201";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seeded(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  // The open workspace's owner has no address, so the reconciler skips them
  // after the settings read without deriving anything; the closed workspace's
  // member has one, so only the refusal keeps the pass from writing for them.
  for (const [id, email] of [[OWNER, ""], [MEMBER, "member@example.test"]] as const) {
    database.prepare(
      `INSERT INTO users(id, google_subject, email, name, timezone, created_at, updated_at)
       VALUES (?, ?, ?, 'Test Person', 'UTC', ?, ?)`,
    ).run(id, `google-${id}`, email, NOW, NOW);
  }
  for (const [id, slug, abandonedAt, memberId] of [
    [OPEN_WORKSPACE, "open", null, OWNER],
    [CLOSED_WORKSPACE, "closed", NOW, MEMBER],
  ] as const) {
    database.prepare(
      `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, abandoned_at, created_at, updated_at)
       VALUES (?, ?, ?, 'global', ?, ?, ?, ?)`,
    ).run(id, slug, slug, OWNER, abandonedAt, NOW, NOW);
    database.prepare(
      `INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'owner', 'active', ?)`,
    ).run(id, memberId, NOW);
  }
  return database;
}

function refusing(methods: Record<string, (workspaceName: string) => unknown>): DurableObjectNamespace {
  const binding: DurableObjectNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: (id: DurableObjectId) => Object.fromEntries(
      Object.entries(methods).map(([method, answer]) => [method, async () => answer(id.toString())]),
    ),
    jurisdiction: (): DurableObjectNamespace => binding,
  });
  return binding;
}

function queued(id: string, body: unknown, outcomes: { acked: string[]; retried: string[] }): Message<unknown> {
  return {
    id,
    timestamp: new Date(NOW),
    body,
    attempts: 1,
    ack: () => { outcomes.acked.push(id); },
    retry: () => { outcomes.retried.push(id); },
  };
}

function batch(queue: string, messages: Message<unknown>[]): MessageBatch<unknown> {
  return { queue, messages, metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, retryAll: vi.fn(), ackAll: vi.fn() };
}

describe("background callers meeting a retired object", () => {
  it("is decided in every background caller that reaches a gated object", () => {
    // Structural, like the initialization wiring test: each of these reaches a
    // gated object from a transport that retries a throw, and each has to
    // have made the terminal decision explicitly. A new consumer that does
    // not is the dead-letter loop again.
    for (const file of [
      "src/queues/access-revocation-consumer.ts",
      "src/queues/product-feature-flag-consumer.ts",
      "src/queues/activity-consumer.ts",
      "src/workflows/connector-event.ts",
      "src/services/digest-service.ts",
    ]) {
      expect(readFileSync(`${process.cwd()}/${file}`, "utf8"), file).toContain("isRetirementRefusal(");
    }
  });

  it("acknowledges a feature-flag fan-out message the retired workspace refuses", async () => {
    const outcomes = { acked: [] as string[], retried: [] as string[] };
    const env = createTestEnv({
      DB: sqliteD1(seeded()),
      AVALON_REGION: "global",
      WORKSPACE_DOS: refusing({
        notifyProductFeatureFlagChanged: () => { throw new RetirementRefusedError("notifyProductFeatureFlagChanged"); },
      }),
    });
    await consumeProductFeatureFlagQueue(batch("avalon-global-product-feature-flags", [
      queued("flag", { kind: "product_feature_flag_changed", flagKey: "suggested-work-enabled", workspaceId: OPEN_WORKSPACE }, outcomes),
    ]), env);
    expect(outcomes).toEqual({ acked: ["flag"], retried: [] });
  });

  it("acknowledges a revocation hop whose enumeration the retired object refuses", async () => {
    // The automation hop asks `listChildren`, which stays a refused product
    // read. Retirement closed every socket beneath the object when it wrote
    // the tombstone, so the hop has nothing left to find.
    const outcomes = { acked: [] as string[], retried: [] as string[] };
    const env = createTestEnv({
      DB: sqliteD1(seeded()),
      AVALON_REGION: "global",
      AUTOMATION_DOS: refusing({
        listChildren: () => { throw new RetirementRefusedError("listChildren"); },
      }),
      ACCESS_REVOCATION_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
    });
    await consumeAccessRevocationQueue(batch("avalon-global-access-revocations", [
      queued("hop", {
        kind: "access_revoked",
        reason: "workspace_membership_removed",
        workspaceId: OPEN_WORKSPACE,
        userId: MEMBER,
        sessionId: null,
        target: { scope: "automation", automationId: AUTOMATION },
        occurredAt: NOW,
      }, outcomes),
    ]), env);
    expect(outcomes).toEqual({ acked: ["hop"], retried: [] });
  });

  it("skips a retired workspace's members in the digest pass rather than aborting it", async () => {
    // A retired workspace's members stay active in D1, so the page names them
    // on every cycle and the object refuses them every time. The pass has to
    // move on: the cursor advances only after the loop, so an abort here
    // re-read the same page and met the same refusal on every tick, and every
    // member sorted after it stopped getting a digest default, region-wide.
    const asked: string[] = [];
    const database = seeded();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      WORKSPACE_DOS: refusing({
        digestSettings: (name) => {
          asked.push(name);
          if (name.includes(CLOSED_WORKSPACE)) throw new RetirementRefusedError("digestSettings");
          return { schedule: null, times: [], nextRunAt: null, lastDeliveredAt: null };
        },
      }),
    });
    await expect(reconcileDigestDefaults(env)).resolves.toEqual({ created: 0, derived: 0 });
    // Both members were reached, in cursor order, and the refusal on the
    // first did not stop the second.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(OPEN_WORKSPACE);
    expect(asked[1]).toContain(CLOSED_WORKSPACE);
    // And the pass finished: the cursor was written, which an abort skips.
    const control = database.prepare("SELECT updated_at FROM digest_reconciliation_control WHERE id = 1").get() as { updated_at: string };
    expect(control.updated_at).toBeTruthy();
  });
});
