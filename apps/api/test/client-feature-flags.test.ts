import { describe, expect, it, vi } from "vitest";
import type { Env, IdentityAuthContext } from "../src/env";
import {
  DEVELOPER_SETTINGS_FLAG_KEY,
  resolveClientFeatureFlags,
  resolveDeveloperSettingsEnabled,
} from "../src/services/client-feature-flags";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const staffUserId = "00000000-0000-4000-8000-0000000000a1";
const customerUserId = "00000000-0000-4000-8000-0000000000a2";
const workspaceId = "00000000-0000-4000-8000-0000000000a3";
const staffPlatformUserId = "00000000-0000-4000-8000-0000000000b1";
const accountCreatedAt = "2026-01-02T03:04:05.000Z";

// APP_ENV production so the unreachable-binding path warns rather than staying
// quiet the way it does in development.
const baseEnv = {
  AVALON_REGION: "global",
  APP_ENV: "production",
  LOG_LEVEL: "error",
} as unknown as Env;

function envWithAccounts(flags?: Partial<Flagship>, platformUserId: string | null = staffPlatformUserId): Env {
  const database = migratedSqliteDatabase();
  const accounts: Array<[string, string, string | null]> = [
    [staffUserId, "Adam@Juno-Labs.com", platformUserId],
    [customerUserId, "adam@example.com", "platform-user-customer"],
  ];
  for (const [id, email, platformId] of accounts) {
    database
      .prepare(
        `INSERT INTO users (id, google_subject, email, name, platform_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, `google-${id}`, email, "Adam", platformId, accountCreatedAt, accountCreatedAt);
  }
  return {
    ...baseEnv,
    DB: sqliteD1(database),
    ...(flags ? { FLAGS: flags as unknown as Flagship } : {}),
  } as Env;
}

function auth(userId: string, workspace: string | null = workspaceId): IdentityAuthContext {
  return {
    sessionId: "session-1",
    userId,
    workspaceId: workspace,
    region: "global",
    role: workspace ? "member" : null,
  };
}

/**
 * A stub standing in for Flagship, serving `on` only where `rule` matches the
 * evaluation context — which is how a real targeting rule decides, and the only
 * way a test can tell an attribute was actually sent.
 */
function servingWhen(rule: (context: FlagshipEvaluationContext) => boolean): Partial<Flagship> {
  return {
    getBooleanDetails: vi.fn(async (flagKey: string, defaultValue: boolean, context = {}) => {
      const matched = rule(context);
      return {
        flagKey,
        value: matched ? true : defaultValue,
        variant: matched ? "on" : "off",
        reason: matched ? "TARGETING_MATCH" : "DEFAULT",
      };
    }),
  };
}

/** A stub that serves `value` to everyone, the way a flag with no rules would. */
function serving(value: unknown): Partial<Flagship> {
  return {
    getBooleanDetails: vi.fn(async (flagKey: string) => ({
      flagKey,
      value: value as boolean,
      variant: "on",
      reason: "STATIC",
    })),
  };
}

describe("client feature flags", () => {
  it("describes the signed-in person with every attribute a rule may target", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await resolveClientFeatureFlags(env, auth(staffUserId));

    expect(flags.getBooleanDetails).toHaveBeenCalledWith(DEVELOPER_SETTINGS_FLAG_KEY, false, {
      // The stable identity a percentage rollout is bucketed by, kept distinct
      // from the regional row id, which differs per region for one person.
      platformUserId: staffPlatformUserId,
      regionalUserId: staffUserId,
      region: "global",
      appEnv: "production",
      // Normalized, so a rule can be written in one spelling of the address.
      email: "adam@juno-labs.com",
      emailDomain: "juno-labs.com",
      regionalAccountJoinedAt: accountCreatedAt,
      workspaceId,
      workspaceRole: "member",
    });
  });

  it("never passes a regional id off as the person's stable identity", async () => {
    // An account that predates the platform control plane carries no
    // `platform_user_id`. Substituting the regional row id would bucket the
    // same person differently per region; the attribute is omitted instead, so
    // a rule keyed on it does not match rather than matching the wrong person.
    const flags = serving(true);
    const env = envWithAccounts(flags, null);

    await resolveDeveloperSettingsEnabled(env, auth(staffUserId));

    const context = (flags.getBooleanDetails as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
    expect(context).not.toHaveProperty("platformUserId");
    expect(context).toMatchObject({ regionalUserId: staffUserId });
  });

  it("lets a Flagship rule decide the cohort rather than deciding it here", async () => {
    // The staff rollout as it is actually provisioned: one rule on emailDomain.
    const staffOnly = servingWhen((context) => context.emailDomain === "juno-labs.com");

    await expect(resolveDeveloperSettingsEnabled(envWithAccounts(staffOnly), auth(staffUserId)))
      .resolves.toBe(true);
    await expect(resolveDeveloperSettingsEnabled(envWithAccounts(staffOnly), auth(customerUserId)))
      .resolves.toBe(false);
  });

  it("serves whatever the flag says, with no cohort of its own to override it", async () => {
    // A flag with no rules reaches everyone it is served to. Nothing in the
    // resolver may narrow that; only Flagship decides who is in.
    await expect(resolveDeveloperSettingsEnabled(envWithAccounts(serving(true)), auth(customerUserId)))
      .resolves.toBe(true);
    await expect(resolveDeveloperSettingsEnabled(envWithAccounts(serving(false)), auth(staffUserId)))
      .resolves.toBe(false);
  });

  it("omits the organization attributes before one is chosen, rather than sending them empty", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await expect(resolveDeveloperSettingsEnabled(env, auth(staffUserId, null))).resolves.toBe(true);
    const context = (flags.getBooleanDetails as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
    expect(context).not.toHaveProperty("workspaceId");
    expect(context).not.toHaveProperty("workspaceRole");
    expect(context).toMatchObject({ regionalUserId: staffUserId, emailDomain: "juno-labs.com" });
  });

  it("sends no address attributes for an account it cannot read, so a cohort rule cannot match", async () => {
    const staffOnly = servingWhen((context) => context.emailDomain === "juno-labs.com");
    const env = envWithAccounts(staffOnly);

    // A session whose user row is gone still evaluates, on identity alone.
    await expect(resolveDeveloperSettingsEnabled(env, auth("00000000-0000-4000-8000-0000000000ff")))
      .resolves.toBe(false);
    const context = (staffOnly.getBooleanDetails as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
    expect(context).not.toHaveProperty("email");
    expect(context).not.toHaveProperty("emailDomain");
  });

  it("evaluates, without throwing, when the account store is unavailable", async () => {
    const flags = servingWhen((context) => context.regionalUserId === staffUserId);
    const env = {
      ...baseEnv,
      DB: { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database,
      FLAGS: flags as unknown as Flagship,
    } as Env;

    await expect(resolveDeveloperSettingsEnabled(env, auth(staffUserId))).resolves.toBe(true);
  });

  it("stays off when no binding is attached", async () => {
    await expect(resolveClientFeatureFlags(envWithAccounts(), auth(staffUserId)))
      .resolves.toEqual({ developerSettings: false });
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

  it("evaluates every client flag against one description of the person", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await resolveClientFeatureFlags(env, auth(staffUserId));

    const contexts = (flags.getBooleanDetails as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) expect(context).toEqual(contexts[0]);
  });
});
