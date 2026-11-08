/**
 * WorkspaceDO migration 106 (`member_preferences.push_json`), upgraded the way
 * a deployed Organization is: populated at 105 and committed in its own event,
 * then woken with every migration. A member who already chose to hide agent
 * work keeps that choice, and every push switch reads as on.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { DEFAULT_NOTIFICATION_CHANNELS, DEFAULT_PUSH_PREFERENCES } from "@rally/contracts";
import { storedMemberPreferences, storedPushPreferences } from "../src/durable-objects/member-preferences";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const MEMBER = "00000000-0000-7000-8000-0000000000d1";

describe("migration 106", () => {
  it("upgrades a populated Organization at 105, keeping each display choice and starting every push switch on", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("member-push-preferences-v105");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 105);
      expect(before.at(-1)?.version).toBe(105);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-push-preferences", now: 1,
      });
      state.storage.sql.exec(
        `INSERT INTO member_preferences (user_id, show_agent_work, updated_at) VALUES (?, 0, 42)`, MEMBER,
      );
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-push-preferences", now: 2,
      });
      const row = state.storage.sql.exec<{ show_agent_work: number; updated_at: number; push_json: string }>(
        `SELECT show_agent_work, updated_at, push_json FROM member_preferences WHERE user_id = ?`, MEMBER,
      ).one();
      expect({ showAgentWork: row.show_agent_work, updatedAt: row.updated_at }).toEqual({ showAgentWork: 0, updatedAt: 42 });
      expect(storedPushPreferences(row.push_json)).toEqual(DEFAULT_PUSH_PREFERENCES);
    });
  });
});

describe("migration 107", () => {
  it("upgrades a populated Organization at 106, carrying each push switch someone turned off into that kind's channels", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("member-notify-preferences-v106");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 106),
        component: "workspace_do", workerVersionId: "before-notify-preferences", now: 1,
      });
      state.storage.sql.exec(
        `INSERT INTO member_preferences (user_id, show_agent_work, push_json, updated_at) VALUES (?, 1, ?, 42)`,
        MEMBER, JSON.stringify({ mentions: false, runFinishedOthers: false }),
      );
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-notify-preferences", now: 2,
      });
      const row = state.storage.sql.exec<{ show_agent_work: number; push_json: string; notify_json: string }>(
        `SELECT show_agent_work, push_json, notify_json FROM member_preferences WHERE user_id = ?`, MEMBER,
      ).one();
      expect(storedMemberPreferences(row).notify).toEqual({ ...DEFAULT_NOTIFICATION_CHANNELS, mentions: ["slack_agent_dm"] });
    });
  });
});
