import { describe, expect, it } from "vitest";
import { rememberSidekickDelegationLocation } from "../src/services/sidekick-delegation-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";

describe("Sidekick delegation recovery routing on real migrations", () => {
  it("retains one regional authority reference after repeated opt-ins without storing consent or private labels in D1", async () => {
    const db = migratedSqliteDatabase();
    try {
      const env = createTestEnv({ DB: sqliteD1(db), AVALON_REGION: "global" });
      const userId = "00000000-0000-7000-8000-00000000dc01";
      const workspaceId = "00000000-0000-7000-8000-00000000dc02";
      await rememberSidekickDelegationLocation(env, workspaceId, userId);
      await rememberSidekickDelegationLocation(env, workspaceId, userId);
      expect(db.prepare("SELECT * FROM sidekick_delegation_locations WHERE user_id=?").all(userId)).toEqual([
        { user_id: userId, workspace_id: workspaceId, region: "global" },
      ]);
    } finally {
      db.close();
    }
  });
});
