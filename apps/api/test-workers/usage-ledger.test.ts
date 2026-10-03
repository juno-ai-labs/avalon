import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import type { UsageEvent } from "@rally/contracts/usage";
import usageLedgerMigration from "../../../packages/db/usage-migrations/0001_usage_ledger.sql?raw";
import { applyUsageBatch } from "../src/services/usage-metering";

/**
 * The usage ledger on real D1. The Node suite proves the arithmetic; this
 * proves what only D1 can: that `changes()` inside one `batch()` reads the
 * statement before it, which is what stops two overlapping batches counting
 * one event twice.
 */
const WORKSPACE = "00000000-0000-7000-8000-0000000000a1";
const CREATED = "2026-10-01T09:00:00.000Z";

function event(eventId: string): UsageEvent {
  return {
    v: 1, eventId, workspaceId: WORKSPACE, region: "global", activity: "agent_run",
    occurredAt: "2026-10-02T12:00:00.000Z", costMicrousd: 1_000_000, model: "test/model", refs: {},
  };
}

beforeEach(async () => {
  await reset();
  await env.USAGE_DB.exec(usageLedgerMigration.replace(/--[^\n]*\n/g, "").replace(/\s*\n\s*/g, " "));
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'starter', created_at TEXT NOT NULL)"),
    env.DB.prepare("INSERT INTO workspaces (id, created_at) VALUES (?, ?)").bind(WORKSPACE, CREATED),
  ]);
});

it("counts an event once when two batches carrying it overlap", async () => {
  await Promise.all([
    applyUsageBatch(env, [event("inf:shared"), event("inf:own-a")], CREATED),
    applyUsageBatch(env, [event("inf:shared"), event("inf:own-b")], CREATED),
  ]);

  const rows = await env.USAGE_DB.prepare("SELECT quota_microusd, organization_microusd FROM usage_rollups").all();
  expect(rows.results).toEqual([{ quota_microusd: 50_000_000, organization_microusd: 3_000_000 }]);
});
