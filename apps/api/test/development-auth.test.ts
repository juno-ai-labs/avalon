import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceService } from "../src/services/workspace-service";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { readOrganizationSettings, updateOrganizationSettings } from "../src/services/organization-settings";
import { AuthService, DEVELOPMENT_USER_ID } from "../src/services/auth-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

describe("development authentication", () => {
  const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it.each([false, true])("seeds visibility once and retains operator changes across new defaults: %s", async (initial) => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    const env = createTestEnv({ APP_ENV: "development", RALLY_DEV_AUTH: "true", AVALON_REGION: "global",
      DB: sqliteD1(database), PUBLIC_API_BASE_URL: "http://127.0.0.1:8787", FEATURE_FLAG_MODEL_SELECTOR_VISIBLE_FOR_NEW_ORGS: initial });
    const service = new AuthService(env);
    const session = await service.createDevelopmentSession();
    const orgId = asWorkspaceId(session.workspace!.id);
    expect(await readOrganizationSettings(env, orgId)).toMatchObject({ modelSelectorVisible: initial });
    await updateOrganizationSettings(env, orgId, !initial);
    const profile = new WorkspaceService(env, { sessionId: "test", userId: asUserId(session.user.id), workspaceId: orgId, region: "global", role: "owner" });
    expect(await profile.getWorkspace()).toMatchObject({ modelSelectorVisible: !initial });
    expect(await readOrganizationSettings(env, orgId)).toMatchObject({ modelSelectorVisible: !initial });
    await service.createDevelopmentSession();
    expect(await readOrganizationSettings(env, orgId)).toMatchObject({ modelSelectorVisible: !initial });
    env.FEATURE_FLAG_MODEL_SELECTOR_VISIBLE_FOR_NEW_ORGS = !initial;
    await updateOrganizationSettings(env, orgId, initial);
    await service.createDevelopmentSession();
    expect(await readOrganizationSettings(env, orgId)).toMatchObject({ modelSelectorVisible: initial });
    env.AVALON_REGION = "enterprise";
    await expect(updateOrganizationSettings(env, orgId, !initial)).rejects.toThrow("engineering_organization_not_found");
    expect(database.prepare("SELECT model_selector_visible FROM workspaces WHERE id = ?").get(orgId))
      .toEqual({ model_selector_visible: Number(initial) });
  });

  it("retains an identity session beside the seeded workspace session", async () => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    const service = new AuthService(createTestEnv({
      APP_ENV: "development",
      RALLY_DEV_AUTH: "true",
      AVALON_REGION: "global",
      DB: sqliteD1(database),
      PUBLIC_API_BASE_URL: "http://127.0.0.1:8787",
    }));

    const workspace = await service.createDevelopmentSession("Rally Development");
    const identity = await service.createDevelopmentIdentitySession();

    expect(workspace).toMatchObject({
      user: { id: DEVELOPMENT_USER_ID },
      workspace: { name: "Rally Development", region: "global" },
    });
    expect(identity).toMatchObject({
      user: { id: DEVELOPMENT_USER_ID },
      workspace: null,
      apiBaseUrl: "http://127.0.0.1:8787",
    });
  });

  it("keeps the Organization's stored name when the development account signs in again with another", async () => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    const service = new AuthService(createTestEnv({
      APP_ENV: "development",
      RALLY_DEV_AUTH: "true",
      AVALON_REGION: "global",
      DB: sqliteD1(database),
      PUBLIC_API_BASE_URL: "http://127.0.0.1:8787",
    }));
    const first = await service.createDevelopmentSession();
    // The desktop's sign-in sends its onboarding name; a bare POST /auth/dev/session takes the default.
    await expect(service.createDevelopmentSession("Rally Development"))
      .resolves.toMatchObject({ workspace: { id: first.workspace!.id, name: "Avalon Development" } });
    expect(database.prepare("SELECT name FROM workspaces WHERE id = ?").get(first.workspace!.id))
      .toEqual({ name: "Avalon Development" });
  });

  it("reopens the fixed development authority after its final member closes it", async () => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    const service = new AuthService(createTestEnv({
      APP_ENV: "development",
      RALLY_DEV_AUTH: "true",
      AVALON_REGION: "global",
      DB: sqliteD1(database),
      PUBLIC_API_BASE_URL: "http://127.0.0.1:8787",
    }));
    // Both membership transitions occur in one SQLite second, reproducing the
    // duplicate qualification that an outer UPSERT must not turn into a failure.
    database.function("unixepoch", () => 1794441600);
    const first = await service.createDevelopmentSession("Rally Development");
    database.prepare("UPDATE workspaces SET abandoned_at = ? WHERE id = ?")
      .run("2026-09-01T00:00:00.000Z", first.workspace!.id);
    database.prepare("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = ?")
      .run(first.workspace!.id);

    await expect(service.createDevelopmentSession("Rally Development"))
      .resolves.toMatchObject({ workspace: { id: first.workspace!.id } });
    expect(database.prepare("SELECT abandoned_at FROM workspaces WHERE id = ?").get(first.workspace!.id))
      .toEqual({ abandoned_at: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM billing_team_qualifications WHERE workspace_id = ?").get(first.workspace!.id))
      .toEqual({ count: 1 });
  });
});
