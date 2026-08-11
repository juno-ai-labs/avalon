import { describe, expect, it, vi } from "vitest";
import type { Env, IdentityAuthContext } from "../src/env";
import {
  DEVELOPER_SETTINGS_EMAIL_DOMAIN,
  DEVELOPER_SETTINGS_FLAG_KEY,
  developerSettingsEligibleEmail,
  resolveClientFeatureFlags,
  resolveDeveloperSettingsEnabled,
} from "../src/services/client-feature-flags";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const staffUserId = "00000000-0000-4000-8000-0000000000a1";
const customerUserId = "00000000-0000-4000-8000-0000000000a2";
const workspaceId = "00000000-0000-4000-8000-0000000000a3";

// APP_ENV production so the unreachable-binding path warns rather than staying
// quiet the way it does in development.
const baseEnv = {
  AVALON_REGION: "global",
  APP_ENV: "production",
  LOG_LEVEL: "error",
} as unknown as Env;

function envWithAccounts(flags?: Partial<Flagship>): Env {
  const database = migratedSqliteDatabase();
  const now = new Date().toISOString();
  const accounts: Array<[string, string]> = [
    [staffUserId, `Adam@${DEVELOPER_SETTINGS_EMAIL_DOMAIN}`],
    [customerUserId, "adam@example.com"],
  ];
  for (const [id, email] of accounts) {
    database
      .prepare("INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, `google-${id}`, email, "Adam", now, now);
  }
  return {
    ...baseEnv,
    DB: sqliteD1(database),
    ...(flags ? { FLAGS: flags as unknown as Flagship } : {}),
  } as Env;
}

function auth(userId: string, workspace: string | null = workspaceId): IdentityAuthContext {
  return { sessionId: "session-1", userId, workspaceId: workspace, region: "global", role: "member" };
}

/** A stub that serves `value` the way a provisioned, matching flag would. */
function serving(value: unknown, variant = "on"): Partial<Flagship> {
  return {
    getBooleanDetails: vi.fn(async (flagKey: string) => ({
      flagKey,
      value: value as boolean,
      variant,
      reason: "STATIC",
    })),
  };
}

describe("client feature flags", () => {
  it("recognizes only the staff email domain, case- and whitespace-insensitively", () => {
    expect(developerSettingsEligibleEmail("adam@juno-labs.com")).toBe(true);
    expect(developerSettingsEligibleEmail("  ADAM@Juno-Labs.COM  ")).toBe(true);
    expect(developerSettingsEligibleEmail("adam@example.com")).toBe(false);
    // A domain the staff one is only a suffix or prefix of is a different domain.
    expect(developerSettingsEligibleEmail("adam@notjuno-labs.com")).toBe(false);
    expect(developerSettingsEligibleEmail("adam@juno-labs.com.example.com")).toBe(false);
    expect(developerSettingsEligibleEmail("adam@juno-labs.com@example.com")).toBe(false);
    expect(developerSettingsEligibleEmail("juno-labs.com")).toBe(false);
    expect(developerSettingsEligibleEmail(null)).toBe(false);
  });

  it("enables the section for a staff account whose flag is on", async () => {
    const env = envWithAccounts(serving(true));

    await expect(resolveDeveloperSettingsEnabled(env, auth(staffUserId))).resolves.toBe(true);
    await expect(resolveClientFeatureFlags(env, auth(staffUserId))).resolves.toEqual({ developerSettings: true });
  });

  it("evaluates the flag with a default of off and the account in its context", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await resolveDeveloperSettingsEnabled(env, auth(staffUserId));

    expect(flags.getBooleanDetails).toHaveBeenCalledWith(DEVELOPER_SETTINGS_FLAG_KEY, false, {
      region: "global",
      appEnv: "production",
      userId: staffUserId,
      emailDomain: DEVELOPER_SETTINGS_EMAIL_DOMAIN,
      workspaceId,
    });
  });

  it("evaluates for a staff account that has not chosen an organization yet", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await expect(resolveDeveloperSettingsEnabled(env, auth(staffUserId, null))).resolves.toBe(true);
    expect(flags.getBooleanDetails).toHaveBeenCalledWith(
      DEVELOPER_SETTINGS_FLAG_KEY,
      false,
      expect.not.objectContaining({ workspaceId: expect.anything() }),
    );
  });

  it("never asks the flag about an account outside the staff domain", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await expect(resolveDeveloperSettingsEnabled(env, auth(customerUserId))).resolves.toBe(false);
    expect(flags.getBooleanDetails).not.toHaveBeenCalled();
  });

  it("stays off for a staff account whose flag is off", async () => {
    await expect(resolveDeveloperSettingsEnabled(envWithAccounts(serving(false)), auth(staffUserId)))
      .resolves.toBe(false);
  });

  it("stays off when no binding is attached", async () => {
    await expect(resolveDeveloperSettingsEnabled(envWithAccounts(), auth(staffUserId))).resolves.toBe(false);
  });

  it("stays off when the binding throws, as it does under wrangler dev --local", async () => {
    const env = envWithAccounts({
      getBooleanDetails: vi.fn(async () => {
        throw new Error("Binding FLAGS needs to be run remotely");
      }),
    });

    await expect(resolveDeveloperSettingsEnabled(env, auth(staffUserId))).resolves.toBe(false);
  });

  it("stays off when the flag does not resolve", async () => {
    // Flagship reports a missing, disabled, or mistyped flag by serving the
    // default with an error code rather than throwing.
    const env = envWithAccounts({
      getBooleanDetails: vi.fn(async (flagKey: string) => ({
        flagKey,
        value: false,
        errorCode: "FLAG_NOT_FOUND",
        errorMessage: "flag not found",
        reason: "ERROR",
      })),
    });

    await expect(resolveDeveloperSettingsEnabled(env, auth(staffUserId))).resolves.toBe(false);
  });

  it("stays off when the served value is not a boolean true", async () => {
    await expect(resolveDeveloperSettingsEnabled(envWithAccounts(serving("true")), auth(staffUserId)))
      .resolves.toBe(false);
  });

  it("stays off, without throwing, when the account cannot be read", async () => {
    const env = {
      ...baseEnv,
      DB: { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database,
      FLAGS: serving(true) as unknown as Flagship,
    } as Env;

    await expect(resolveDeveloperSettingsEnabled(env, auth(staffUserId))).resolves.toBe(false);
  });

  it("stays off for a session whose user row is gone", async () => {
    const env = envWithAccounts(serving(true));

    await expect(resolveDeveloperSettingsEnabled(env, auth("00000000-0000-4000-8000-0000000000ff")))
      .resolves.toBe(false);
  });
});
