import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { DIGESTS_ENABLED_FLAG_KEY, resolveDigestsEnabled } from "../src/services/digest-flags";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import type * as FlagTargetingModule from "../src/services/flag-targeting-attributes";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * Lets one case serve an attribute the real loader would never produce — a key
 * that collides with the run's identity — while every other case keeps the
 * loader that reads the seeded (or absent) database. Mirrors
 * `agent-model-flags.test.ts`'s identical scaffolding.
 */
const servedAttributes = vi.hoisted(() => ({
  value: null as Record<string, string | number | boolean> | null,
}));
vi.mock("../src/services/flag-targeting-attributes", async (importOriginal) => {
  const actual = await importOriginal<typeof FlagTargetingModule>();
  return {
    ...actual,
    loadFlagTargetingAttributes: async (
      env: Env,
      subject: Parameters<typeof actual.loadFlagTargetingAttributes>[1],
    ) => servedAttributes.value ?? actual.loadFlagTargetingAttributes(env, subject),
  };
});

// APP_ENV production so the unreachable-binding path warns rather than staying
// quiet the way it does in development.
const baseEnv = createTestEnv({
  AVALON_REGION: "global",
  APP_ENV: "production",
  LOG_LEVEL: "error",
});

const SUBJECT = { userId: "usr-1", workspaceId: "wsp-1" };
const OWNER_ID = "usr-owner";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  // Attributes are cached in the isolate; a test must not inherit another's rows.
  clearFlagTargetingAttributeCache();
  servedAttributes.value = null;
});

type DetailsStub = (
  flagKey: string,
  defaultValue: boolean,
  context?: FlagshipEvaluationContext,
) => Promise<Partial<FlagshipEvaluationDetails<unknown>>>;

/** Binds a `getBooleanDetails` stub, the only Flagship method the resolver calls. */
function envWithFlags(getBooleanDetails: DetailsStub): Env {
  return { ...baseEnv, FLAGS: createCloudflareTestBinding<Flagship>({ getBooleanDetails }) };
}

/**
 * A workspace `SUBJECT` belongs to, owned by someone else, with a deterministic
 * age — real rows, because the point of this fixture is proving the attribute
 * loader's actual queries reach Flagship, not stubbing around them the way the
 * fail-open cases below deliberately do.
 */
function envWithSeededWorkspace(getBooleanDetails: DetailsStub): Env {
  const database = migratedSqliteDatabase();
  const workspaceCreatedAt = new Date(Date.now() - 45 * 86_400_000).toISOString();
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, platform_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(OWNER_ID, "google-owner", "owner@dogfood.example", "Owner", null, CREATED_AT, CREATED_AT);
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, platform_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SUBJECT.userId, "google-subject", "member@customer.example", "Member", "platform-member-1", CREATED_AT, CREATED_AT);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Acme Widgets', 'acme-widgets', 'global', ?, ?, ?)`,
  ).run(SUBJECT.workspaceId, OWNER_ID, workspaceCreatedAt, workspaceCreatedAt);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(SUBJECT.workspaceId, OWNER_ID, CREATED_AT);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'admin', 'active', ?)`,
  ).run(SUBJECT.workspaceId, SUBJECT.userId, CREATED_AT);
  return { ...baseEnv, DB: sqliteD1(database), FLAGS: createCloudflareTestBinding<Flagship>({ getBooleanDetails }) };
}

describe("digests-enabled flag", () => {
  it("keeps digests enabled when no binding is attached", async () => {
    await expect(resolveDigestsEnabled(baseEnv, SUBJECT)).resolves.toBe(true);
  });

  it("keeps digests enabled when evaluation throws", async () => {
    // `wrangler dev --local` binds this always-remote binding as an object
    // whose every call throws, which is the normal local state this mirrors.
    const env = envWithFlags(async () => {
      throw new Error("Binding FLAGS needs to be run remotely");
    });
    await expect(resolveDigestsEnabled(env, SUBJECT)).resolves.toBe(true);
  });

  it("keeps digests enabled when the flag does not resolve", async () => {
    const env = envWithFlags(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
      errorCode: "FLAG_NOT_FOUND",
    }));
    await expect(resolveDigestsEnabled(env, SUBJECT)).resolves.toBe(true);
  });

  it("treats anything but an explicit false as enabled", async () => {
    const env = envWithFlags(async (flagKey) => ({
      flagKey,
      // A malformed value from a corrupted or mistyped variation must not
      // silently stop delivery — only an explicit `false` may.
      value: "not-a-boolean" as unknown as boolean,
      variant: "on",
      reason: "STATIC",
    }));
    await expect(resolveDigestsEnabled(env, SUBJECT)).resolves.toBe(true);
  });

  it("turns digests off on an explicit false variation", async () => {
    const env = envWithFlags(async (flagKey) => ({
      flagKey,
      value: false,
      variant: "off",
      reason: "TARGETING_MATCH",
    }));
    await expect(resolveDigestsEnabled(env, SUBJECT)).resolves.toBe(false);
  });

  it("sends only identity when no attributes are available", async () => {
    const getBooleanDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    const env = envWithFlags(getBooleanDetails);

    await resolveDigestsEnabled(env, SUBJECT);

    // The default handed to Flagship is `true`, not `false` — the opposite of
    // every client-visible flag — which is what makes an unresolved flag serve
    // enabled rather than disabled.
    expect(getBooleanDetails).toHaveBeenCalledWith(
      DIGESTS_ENABLED_FLAG_KEY,
      true,
      {
        region: "global",
        appEnv: "production",
        userId: SUBJECT.userId,
        workspaceId: SUBJECT.workspaceId,
      },
    );
  });

  // A digest subject always carries both a `userId` and a `workspaceId` — the
  // richest identity pair any resolver evaluates with — so it is the one flag
  // whose evaluation context should carry the fullest attribute set. This is
  // also the PR's headline capability: "turn digests off for a targeted
  // cohort" only works if these facts actually reach Flagship, which a stub
  // returning `{}` (the previous version of this file, with no seeded rows)
  // cannot demonstrate — deleting the `...attributes` spread in the resolver
  // left every case here green.
  it("loads and sends real workspace and person attributes, which is what makes cohort targeting reachable", async () => {
    const getBooleanDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    const env = envWithSeededWorkspace(getBooleanDetails);

    await resolveDigestsEnabled(env, SUBJECT);

    expect(getBooleanDetails).toHaveBeenCalledWith(
      DIGESTS_ENABLED_FLAG_KEY,
      true,
      {
        // Loaded facts, matching the seeded rows exactly.
        workspaceSlug: "acme-widgets",
        workspaceMemberCount: 2,
        workspaceAgeDays: 45,
        workspaceOwnerEmailDomain: "dogfood.example",
        userEmailDomain: "customer.example",
        userRole: "admin",
        userPlatformId: "platform-member-1",
        // Identity, unchanged.
        region: "global",
        appEnv: "production",
        userId: SUBJECT.userId,
        workspaceId: SUBJECT.workspaceId,
      },
    );
  });

  // Pins the comment above the spread in `digest-flags.ts` ("attributes
  // first, so a loaded fact cannot shadow the ids a percentage rollout
  // buckets on"). No real attribute is ever named `userId`, so this can only
  // be exercised by injecting one.
  it("keeps a loaded attribute from shadowing the identity the evaluation buckets on", async () => {
    servedAttributes.value = { userId: "poisoned-value", workspaceSlug: "acme-widgets" };
    const getBooleanDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    const env = envWithFlags(getBooleanDetails);

    await resolveDigestsEnabled(env, SUBJECT);

    expect(getBooleanDetails.mock.calls[0]?.[2]).toEqual({
      workspaceSlug: "acme-widgets",
      region: "global",
      appEnv: "production",
      userId: SUBJECT.userId,
      workspaceId: SUBJECT.workspaceId,
    });
  });
});
