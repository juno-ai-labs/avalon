/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The durable record behind every desktop action, on real Durable Object
 * SQLite: what a re-entered tool call finds, which answer wins, what a
 * subscriber is offered, and what happens to an answer its row cannot hold.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WorkstreamDesktopActionStorage } from "../src/durable-objects/workstream-desktop-action-storage";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";

async function withStorage(name: string, test: (actions: WorkstreamDesktopActionStorage, sql: SqlStorage) => void) {
  const stub = env.MIGRATION_PROBE_DO!.getByName(name);
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
      component: "substream_agent_do",
      workerVersionId: "worker-test",
      now: 1_000,
    });
    test(new WorkstreamDesktopActionStorage(state.storage), state.storage.sql);
  });
}

const snapshot = { kind: "browser.snapshot" } as const;

describe("desktop action storage", () => {
  it("hands a re-entered call the answer already recorded, and keeps the first answer", async () => {
    await withStorage("desktop-action-storage-replay", (actions) => {
      const asked = actions.request({ id: "a1", runId: "r1", toolCallId: "c1", action: snapshot, now: 1 });
      expect(asked).toEqual({ status: "pending", request: { id: "a1", action: snapshot } });
      const outcome = { ok: true, result: { url: "https://claude.ai/chat/1", title: "t", outline: "x" } } as const;
      expect(actions.answer({ id: "a1", outcome, answeredByUserId: "u1", now: 2 })).toEqual({ status: "answered", outcome });
      expect(actions.answer({ id: "a1", outcome: { ok: false, code: "tab_closed", message: "gone" }, answeredByUserId: "u1", now: 3 }))
        .toEqual({ status: "duplicate" });
      expect(actions.answer({ id: "nope", outcome, answeredByUserId: "u1", now: 3 })).toEqual({ status: "unknown" });
      // The same call re-entered under a new action id finds the first row and its answer.
      expect(actions.request({ id: "a2", runId: "r1", toolCallId: "c1", action: snapshot, now: 4 }))
        .toEqual({ status: "answered", outcome });
      expect(actions.pending()).toEqual([]);
    });
  });

  it("stops offering an abandoned action, offers it again when its call re-enters, and lets that answer land", async () => {
    await withStorage("desktop-action-storage-abandon", (actions) => {
      actions.request({ id: "a1", runId: "r1", toolCallId: "c1", action: snapshot, now: 1 });
      actions.abandon("a1");
      expect(actions.pending()).toEqual([]);
      expect(actions.request({ id: "a9", runId: "r1", toolCallId: "c1", action: snapshot, now: 2 }))
        .toEqual({ status: "pending", request: { id: "a1", action: snapshot } });
      expect(actions.pending()).toEqual([{ id: "a1", action: snapshot }]);
    });
  });

  it("records an answer its row cannot hold as too large, and skips a row it can no longer read", async () => {
    await withStorage("desktop-action-storage-limits", (actions, sql) => {
      // A large action leaves less room for its answer than the row limit alone.
      const script = "x".repeat(1_500_000);
      actions.request({ id: "a1", runId: "r1", toolCallId: "c1", action: { kind: "browser.evaluate", script }, now: 1 });
      const answered = actions.answer({
        id: "a1",
        outcome: { ok: true, result: { url: "u", title: "t", value: "y".repeat(600_000), stored: [] } },
        answeredByUserId: "u1",
        now: 2,
      });
      expect(answered).toMatchObject({ status: "answered", outcome: { ok: false, code: "result_too_large" } });
      expect(actions.request({ id: "a2", runId: "r1", toolCallId: "c1", action: { kind: "browser.evaluate", script }, now: 3 }))
        .toMatchObject({ status: "answered", outcome: { ok: false, code: "result_too_large" } });

      sql.exec(`INSERT INTO desktop_actions (action_id, run_id, tool_call_id, action_json, status, created_at)
                VALUES ('old', 'r0', 'c0', '{"kind":"browser.retired"}', 'pending', 0)`);
      actions.request({ id: "a3", runId: "r1", toolCallId: "c3", action: snapshot, now: 4 });
      expect(actions.pending()).toEqual([{ id: "a3", action: snapshot }]);
    });
  });
});
