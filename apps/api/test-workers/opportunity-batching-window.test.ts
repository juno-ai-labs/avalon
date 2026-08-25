/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * How long Avalon waits before turning a burst of activity into one suggestion.
 *
 * A 10-minute debounce that each new event pushes out, capped at an hour from
 * the first event so a workspace that never goes quiet still gets a suggestion.
 * That arithmetic used to live in `work-opportunity-batching.ts` and had two
 * tests, both of which ran a D1 arm migration 0090 made unreachable; the arm and
 * its tests are gone and `docs/potential-bugs.md` has carried the gap since.
 * This closes it.
 *
 * Elapsed time is simulated by rewriting the window's own timestamps rather than
 * by passing a clock: `enqueueOpportunitySource` takes `now` as a default
 * parameter and the RPC does not forward one, so a test that supplied one would
 * be exercising a signature production never uses.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000006a0");
const PARTITION = "workspace";
const MINUTE = 60_000;
const DEBOUNCE_MS = 10 * MINUTE;
const MAX_DELAY_MS = 60 * MINUTE;

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

/** Per test, for the reason `workspace-directory-reads.test.ts` explains. */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(WORKSPACE_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM opportunity_batch_events`);
    state.storage.sql.exec(`DELETE FROM opportunity_batch_windows`);
  });
}, 30_000);

let sourceSeq = 0;

async function enqueue(): Promise<{ windowId: string; processAfter: number; inserted: boolean }> {
  sourceSeq += 1;
  const result = await workspace().enqueueOpportunitySource({
    workspaceId: WORKSPACE_ID,
    partitionKey: PARTITION,
    audience: { scope: "workspace", userId: null },
    sourceKind: "activity",
    sourceId: `source-${sourceSeq}`,
    occurredAt: new Date().toISOString(),
    inputCharacters: 100,
  });
  return {
    windowId: result.windowId,
    processAfter: Date.parse(result.processAfter),
    inserted: result.inserted,
  };
}

/**
 * Move the open window's first event into the past, as if it had been waiting.
 *
 * Only `first_event_at` — the cap is measured from it, and the debounce from
 * the event that just arrived, so ageing the first event is exactly the state a
 * long-running burst reaches.
 */
async function ageFirstEventBy(elapsedMs: number): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE opportunity_batch_windows
          SET first_event_at = first_event_at - ?
        WHERE partition_key = ? AND status = 'pending'`,
      elapsedMs,
      PARTITION,
    );
  });
}

async function openWindows(): Promise<Array<{ window_id: string; process_after: number }>> {
  return runInDurableObject(workspace(), (_instance, state) => (
    state.storage.sql.exec<{ window_id: string; process_after: number }>(
      `SELECT window_id, process_after FROM opportunity_batch_windows
        WHERE partition_key = ? AND status = 'pending'`,
      PARTITION,
    ).toArray()
  ));
}

async function eventCount(): Promise<number> {
  return runInDurableObject(workspace(), (_instance, state) => (
    state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM opportunity_batch_events WHERE partition_key = ?`,
      PARTITION,
    ).one().count
  ));
}

describe("the window a burst of activity is aggregated into", () => {
  it("waits ten minutes from the event that opened it", async () => {
    const before = Date.now();
    const first = await enqueue();
    const after = Date.now();

    expect(first.inserted).toBe(true);
    // Bracketed rather than exact: the object reads its own clock, so the only
    // honest assertion is that the answer is ten minutes from *somewhere*
    // inside this call.
    expect(first.processAfter).toBeGreaterThanOrEqual(before + DEBOUNCE_MS);
    expect(first.processAfter).toBeLessThanOrEqual(after + DEBOUNCE_MS);
  });

  it("pushes the wait out for a second event rather than opening a second window", async () => {
    const first = await enqueue();
    await ageFirstEventBy(9 * MINUTE);

    const second = await enqueue();

    // The whole point of the debounce: activity that is still arriving has not
    // finished being activity. A second window would split one conversation
    // into two suggestions.
    expect(second.windowId).toBe(first.windowId);
    expect(await openWindows()).toHaveLength(1);
    expect(second.processAfter).toBeGreaterThan(first.processAfter);
    await expect(eventCount()).resolves.toBe(2);
  });

  it("stops pushing an hour after the first event, however long the burst runs", async () => {
    await enqueue();
    await ageFirstEventBy(55 * MINUTE);

    const late = await enqueue();

    // Without the cap a workspace that never goes quiet never gets a
    // suggestion — the debounce would keep renewing itself for as long as
    // anyone kept talking.
    const now = Date.now();
    expect(late.processAfter).toBeLessThan(now + DEBOUNCE_MS);
    expect(late.processAfter).toBeLessThanOrEqual(now - 55 * MINUTE + MAX_DELAY_MS + 1_000);
    expect(await openWindows()).toHaveLength(1);
  });

  it("counts a repeated source once, and says so", async () => {
    const repeated = {
      workspaceId: WORKSPACE_ID,
      partitionKey: PARTITION,
      audience: { scope: "workspace" as const, userId: null },
      sourceKind: "activity" as const,
      sourceId: "delivered-twice",
      occurredAt: new Date().toISOString(),
      inputCharacters: 100,
    };

    const first = await workspace().enqueueOpportunitySource(repeated);
    const replay = await workspace().enqueueOpportunitySource(repeated);

    // A Queue redelivery is ordinary. Admitting the same activity twice would
    // let one event count twice toward a batch's size, and `inserted` is what
    // the caller reads to tell a new event from a replay.
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.windowId).toBe(first.windowId);
    await expect(eventCount()).resolves.toBe(1);
  });

  it("keeps a personal audience's window apart from the workspace's", async () => {
    const shared = await enqueue();

    const personal = await workspace().enqueueOpportunitySource({
      workspaceId: WORKSPACE_ID,
      partitionKey: "personal:00000000-0000-7000-8000-0000000006a1",
      audience: { scope: "personal", userId: "00000000-0000-7000-8000-0000000006a1" },
      sourceKind: "activity",
      sourceId: "personal-source",
      occurredAt: new Date().toISOString(),
      inputCharacters: 100,
    });

    // The partition is the audience. Merging them would put one person's
    // private activity into a suggestion the whole workspace can read.
    expect(personal.windowId).not.toBe(shared.windowId);
  });

  it("admits the same public source once in each member's personal partition", async () => {
    const sourceId = "workspace-source-for-every-member";
    const enqueueFor = (userId: string) => workspace().enqueueOpportunitySource({
      workspaceId: WORKSPACE_ID,
      partitionKey: `workspace:${userId}`,
      audience: { scope: "personal" as const, userId },
      sourceKind: "activity" as const,
      sourceId,
      occurredAt: new Date().toISOString(),
      inputCharacters: 100,
    });

    const first = await enqueueFor("00000000-0000-7000-8000-0000000006a1");
    const second = await enqueueFor("00000000-0000-7000-8000-0000000006a2");

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.windowId).not.toBe(first.windowId);
  });
});
