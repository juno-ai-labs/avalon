import { asUserId, asWorkspaceId, type UserId, type WorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env, IdentityAuthContext } from "../src/env";
import { resolveClientFeatureFlags } from "../src/services/client-feature-flags";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createCloudflareTestBinding, createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

const staffUserId = asUserId("00000000-0000-4000-8000-0000000000a1");
const customerUserId = asUserId("00000000-0000-4000-8000-0000000000a2");
const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000000a3");
const staffPlatformUserId = "00000000-0000-4000-8000-0000000000b1";
const createdAt = "2026-01-02T03:04:05.000Z";

// APP_ENV production so the unreachable-binding path warns rather than staying
// quiet the way it does in development.
const baseEnv = createTestEnv({
  AVALON_REGION: "global",
  APP_ENV: "production",
  LOG_LEVEL: "error",
});

afterEach(() => {
  // Attributes are cached in the isolate; a test must not inherit another's rows.
  clearFlagTargetingAttributeCache();
});

function envWithAccounts(
  flags?: Partial<Flagship>,
  platformUserId: string | null = staffPlatformUserId,
): Env {
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
      .run(id, `google-${id}`, email, "Adam", platformId, createdAt, createdAt);
  }
  database
    .prepare(
      `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
       VALUES (?, 'Juno', 'juno', 'global', ?, ?, ?)`,
    )
    .run(workspaceId, staffUserId, createdAt, createdAt);
  for (const id of [staffUserId, customerUserId]) {
    database
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
         VALUES (?, ?, 'member', 'active', ?)`,
      )
      .run(workspaceId, id, createdAt);
  }
  return createTestEnv({
    ...baseEnv,
    DB: sqliteD1(database),
    ...(flags ? { FLAGS: createCloudflareTestBinding<Flagship>(flags) } : {}),
  });
}

function auth(userId: UserId, workspace: WorkspaceId | null = workspaceId): IdentityAuthContext {
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

/**
 * The same, for the one number flag in the response. Composed with `serving`
 * wherever a test needs both, because the two are resolved by different modules
 * and a stub that answers only one of them is how a test stops noticing.
 */
function servingNumber(value: unknown): Partial<Flagship> {
  return {
    getNumberDetails: vi.fn(async (flagKey: string) => ({
      flagKey,
      value: value as number,
      variant: "served",
      reason: "STATIC",
    })),
  };
}

function contextOf(flags: Partial<Flagship>): FlagshipEvaluationContext {
  return (flags.getBooleanDetails as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] ?? {};
}

/** The Developer section's answer, read through the entry point the route calls. */
async function developerSettings(env: Env, auth: IdentityAuthContext): Promise<boolean> {
  return (await resolveClientFeatureFlags(env, auth)).developerSettings;
}

describe("client feature flags", () => {
  it("describes the person in the same vocabulary an agent evaluation uses", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await resolveClientFeatureFlags(env, auth(staffUserId));

    // The shared loader's attributes, plus the caller's identity over the top.
    expect(contextOf(flags)).toMatchObject({
      userId: staffUserId,
      workspaceId,
      region: "global",
      appEnv: "production",
      userEmailDomain: "juno-labs.com",
      userRole: "member",
      userPlatformId: staffPlatformUserId,
      workspaceSlug: "juno",
    });
  });

  it("never sends an address, only its domain", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await resolveClientFeatureFlags(env, auth(staffUserId));

    // The boundary `flag-targeting-attributes.ts` owns: a domain is a cohort, a
    // local part is a person, and a flag-targeting system gets only the first.
    const values = Object.values(contextOf(flags)).map(String);
    expect(values.some((value) => value.includes("@"))).toBe(false);
  });

  it("lets a Flagship rule decide the cohort rather than deciding it here", async () => {
    // The staff rollout as it is actually provisioned: one rule on the domain.
    const staffOnly = servingWhen((context) => context.userEmailDomain === "juno-labs.com");

    await expect(developerSettings(envWithAccounts(staffOnly), auth(staffUserId)))
      .resolves.toBe(true);
    clearFlagTargetingAttributeCache();
    await expect(developerSettings(envWithAccounts(staffOnly), auth(customerUserId)))
      .resolves.toBe(false);
  });

  it("can be staged per person on an identity that is stable across regions", async () => {
    const chosen = servingWhen((context) => context.userPlatformId === staffPlatformUserId);

    await expect(developerSettings(envWithAccounts(chosen), auth(staffUserId)))
      .resolves.toBe(true);
    clearFlagTargetingAttributeCache();
    await expect(developerSettings(envWithAccounts(chosen), auth(customerUserId)))
      .resolves.toBe(false);
  });

  it("serves whatever the flag says, with no cohort of its own to override it", async () => {
    // A flag with no rules reaches everyone it is served to. Nothing in the
    // resolver may narrow that; only Flagship decides who is in.
    await expect(developerSettings(envWithAccounts(serving(true)), auth(customerUserId)))
      .resolves.toBe(true);
    clearFlagTargetingAttributeCache();
    await expect(developerSettings(envWithAccounts(serving(false)), auth(staffUserId)))
      .resolves.toBe(false);
  });

  it("omits the organization attributes before one is chosen", async () => {
    const flags = serving(true);
    const env = envWithAccounts(flags);

    await expect(developerSettings(env, auth(staffUserId, null))).resolves.toBe(true);
    const context = contextOf(flags);
    expect(context).not.toHaveProperty("workspaceId");
    expect(context).not.toHaveProperty("workspaceSlug");
    // The role is a property of a membership, so it goes with the workspace…
    expect(context).not.toHaveProperty("userRole");
    // …while who they are does not.
    expect(context).toMatchObject({ userEmailDomain: "juno-labs.com", userId: staffUserId });
  });

  it("sends no account attributes for a session whose user row is gone", async () => {
    const staffOnly = servingWhen((context) => context.userEmailDomain === "juno-labs.com");
    const env = envWithAccounts(staffOnly);

    await expect(developerSettings(env, auth(asUserId("00000000-0000-4000-8000-0000000000ff"))))
      .resolves.toBe(false);
    expect(contextOf(staffOnly)).not.toHaveProperty("userEmailDomain");
  });

  it("evaluates, without throwing, when the account store is unavailable", async () => {
    const flags = servingWhen((context) => context.userId === staffUserId);
    const env = createTestEnv({
      ...baseEnv,
      DB: createTestD1Database({ prepare: () => { throw new Error("D1 unavailable"); } }),
      FLAGS: createCloudflareTestBinding<Flagship>(flags),
    });

    // Attributes are an enrichment, never a precondition: the identity still
    // reaches the flag, so a rule written on it still decides.
    await expect(developerSettings(env, auth(staffUserId))).resolves.toBe(true);
  });

  it("stays off when no binding is attached", async () => {
    await expect(resolveClientFeatureFlags(envWithAccounts(), auth(staffUserId)))
      .resolves.toEqual({
        developerSettings: false,
        suggestedWorkEnabled: false,
        multipleWorkspacesEnabled: false,
        pushNotificationsEnabled: false,
      });
  });

  it("stays off when the binding throws, as it does under wrangler dev --local", async () => {
    const env = envWithAccounts({
      getBooleanDetails: vi.fn(async () => {
        throw new Error("Binding FLAGS needs to be run remotely");
      }),
    });

    await expect(developerSettings(env, auth(staffUserId))).resolves.toBe(false);
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

    await expect(developerSettings(env, auth(staffUserId))).resolves.toBe(false);
  });

  it("stays off when the served value is not a boolean true", async () => {
    await expect(developerSettings(envWithAccounts(serving("true")), auth(staffUserId)))
      .resolves.toBe(false);
  });

  it("evaluates every client flag against one description of the person", async () => {
    const flags = { ...serving(true), ...servingNumber(60) };
    const env = envWithAccounts(flags);

    await resolveClientFeatureFlags(env, auth(staffUserId));

    // Including the cadence, which a separate module resolves: two modules
    // describing one person differently would mean a rule that reaches somebody
    // for one flag and silently misses them for the other.
    const contexts = [
      ...(flags.getBooleanDetails as ReturnType<typeof vi.fn>).mock.calls,
      ...(flags.getNumberDetails as ReturnType<typeof vi.fn>).mock.calls,
    ].map((call) => call[2]);
    expect(contexts.length).toBeGreaterThan(1);
    for (const context of contexts) expect(context).toEqual(contexts[0]);
  });

  it("evaluates application booleans under enabled-named Flagship keys", async () => {
    const flags = { ...serving(true), ...servingNumber(60) };

    await resolveClientFeatureFlags(envWithAccounts(flags), auth(staffUserId));

    // Order-independent: what this test cares about — every enabled-named key
    // queried exactly once — does not depend on which order they arrived in.
    expect((flags.getBooleanDetails as ReturnType<typeof vi.fn>).mock.calls.map(([key]) => key).sort())
      .toEqual([
        "developer-settings",
        "multiple-workspaces-enabled",
        "push-notifications-enabled",
        "suggested-work-enabled",
      ]);
  });
});

describe("GET /feature-flags", () => {
  function routeEnv(flags?: Partial<Flagship>): Env {
    return createTestEnv({
      ...envWithAccounts(flags),
      ALLOWED_ORIGINS: "app://avalon",
      APP_ENV: "development",
      RALLY_DEV_AUTH: "true",
    });
  }

  function asStaff(): HeadersInit {
    return {
      "x-rally-dev-user-id": staffUserId,
      "x-rally-dev-workspace-id": workspaceId,
    };
  }

  it("requires a session", async () => {
    const response = await createApp().request("/feature-flags", {}, routeEnv(serving(true)));

    expect(response.status).toBe(401);
  });

  it("serves every flag as one object for the signed-in person", async () => {
    const response = await createApp().request(
      "/feature-flags",
      { headers: asStaff() },
      routeEnv(serving(true)),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      developerSettings: true,
      suggestedWorkEnabled: true,
      multipleWorkspacesEnabled: true,
      pushNotificationsEnabled: true,
    });
  });

  it("forbids caching, because the answer is one person's and the client polls it", async () => {
    const response = await createApp().request(
      "/feature-flags",
      { headers: asStaff() },
      routeEnv(serving(true)),
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers off rather than failing when the flag cannot be resolved", async () => {
    const response = await createApp().request("/feature-flags", { headers: asStaff() }, routeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      developerSettings: false,
      suggestedWorkEnabled: false,
      multipleWorkspacesEnabled: false,
      pushNotificationsEnabled: false,
    });
  });
});
