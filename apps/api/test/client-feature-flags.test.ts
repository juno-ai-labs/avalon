import { asUserId, type ClientFeatureFlags } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClientFeatureFlags, resolveClientFeatureFlagsForSubject, resolvePushNotificationsEnabled } from "../src/services/client-feature-flags";
import { createTestEnv } from "./helpers/cloudflare-test";

const subject = { userId: asUserId("00000000-0000-4000-8000-000000000001") };
const auth = { ...subject, sessionId: "session", workspaceId: null, region: "global" as const, role: "member" as const };
const defaults: ClientFeatureFlags = {
  developerSettings: false, multipleWorkspacesEnabled: true,
  pushNotificationsEnabled: true,
};

describe("local client feature flags", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the provisioned defaults without a database or remote service", async () => {
    await expect(resolveClientFeatureFlags(createTestEnv({}), auth)).resolves.toEqual(defaults);
  });

  it("applies each environment override in HTTP and socket resolution", async () => {
    const env = createTestEnv({
      FEATURE_FLAG_DEVELOPER_SETTINGS: "true",
      FEATURE_FLAG_MULTIPLE_WORKSPACES_ENABLED: " FALSE ",
      FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED: "false",
    });
    const expected = { developerSettings: true, multipleWorkspacesEnabled: false, pushNotificationsEnabled: false };
    await expect(resolveClientFeatureFlags(env, auth)).resolves.toEqual(expected);
    await expect(resolveClientFeatureFlagsForSubject(env, { userId: "someone-else", workspaceId: "another-org" })).resolves.toEqual(expected);
    await expect(resolvePushNotificationsEnabled(env, subject)).resolves.toBe(false);
  });

  it.each(["false", "0", " FALSE ", false, 0])("accepts explicit off overrides: %s", async (value) => {
    await expect(resolvePushNotificationsEnabled(createTestEnv({ FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED: value }), subject)).resolves.toBe(false);
  });

  it.each([undefined, "", "   "])("uses the default for an unset or empty override: %s", async (value) => {
    await expect(resolvePushNotificationsEnabled(createTestEnv({ FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED: value }), subject)).resolves.toBe(true);
  });

  it.each([true, 1])("accepts native on overrides: %s", async (value) => {
    await expect(resolveClientFeatureFlags(createTestEnv({ FEATURE_FLAG_DEVELOPER_SETTINGS: value }), auth))
      .resolves.toMatchObject({ developerSettings: true });
  });

  it.each([{}, [], 2])("defaults safely for unsupported typed overrides: %s", async (value) => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(resolvePushNotificationsEnabled(createTestEnv({ LOG_LEVEL: "warn", FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED: value }), subject))
      .resolves.toBe(true);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ event: "feature_flag_override_invalid", variable: "FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED" }));
  });

  it("reports a malformed override by variable name and retains its default", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(resolvePushNotificationsEnabled(createTestEnv({ LOG_LEVEL: "warn", FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED: "secret-typo" }), subject)).resolves.toBe(true);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ event: "feature_flag_override_invalid", variable: "FEATURE_FLAG_PUSH_NOTIFICATIONS_ENABLED" }));
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-typo");
  });
});
