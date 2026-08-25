import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  clearFlagTargetingAttributeCache,
  loadFlagTargetingAttributes,
} from "../src/services/flag-targeting-attributes";
import {
  migratedSqliteDatabase,
  preRetirementProductSqliteDatabase,
  sqliteD1,
} from "./helpers/sqlite-d1";
import { createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_ID = "00000000-0000-4000-8000-000000000011";
const MEMBER_ID = "00000000-0000-4000-8000-000000000012";
const INVITED_ID = "00000000-0000-4000-8000-000000000013";
const AD_HOC_WORKSTREAM = "00000000-0000-4000-8000-000000000021";
const AUTOMATION_WORKSTREAM = "00000000-0000-4000-8000-000000000022";
const DIGEST_WORKSTREAM = "00000000-0000-4000-8000-000000000023";
const OPPORTUNITY_ID = "00000000-0000-4000-8000-000000000031";

const NOW = "2026-08-11T12:00:00.000Z";
const THIRTY_DAYS_AGO = "2026-07-12T12:00:00.000Z";

let database: DatabaseSync;
/**
 * One object store per work stream, not one regional table for all of them.
 *
 * A work-stream fact is read through `workstreamExecutionEnvironment`, which
 * routes at the object unconditionally, and an object holds exactly one work
 * stream. Seeding these rows regionally left the read finding nothing, which
 * the loader reports as a suppressed subject rather than an error — so the
 * fixture, not the assertion, is what has to move.
 */
let workstreamStores: Map<string, DatabaseSync>;

function workstreamStore(id: string): DatabaseSync {
  const existing = workstreamStores.get(id);
  if (existing) return existing;
  const store = testWorkstreamObjectStore();
  workstreamStores.set(id, store);
  return store;
}

function envWith(db: D1Database): Env {
  return createTestEnv({
    DB: db,
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores: workstreamStores }),
    AVALON_REGION: "global",
    APP_ENV: "production",
    LOG_LEVEL: "error",
  });
}

function seedUser(id: string, email: string, name: string): void {
  database
    .prepare(
      `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(id, `google-${id}`, email, name, THIRTY_DAYS_AGO, THIRTY_DAYS_AGO);
}

function seedWorkstream(
  id: string,
  values: {
    origin: "ad_hoc" | "automation";
    createdByUserId: string | null;
    scope?: "personal" | "workspace";
    systemKind?: string | null;
    opportunityId?: string | null;
  },
): void {
  const store = workstreamStore(id);
  seedWorkstreamObjectRoot(store, {
    workspaceId: WORKSPACE_ID,
    workstreamId: id,
    title: "Ship it",
    description: "",
    originType: values.origin,
    createdByUserId: values.createdByUserId,
    scope: values.scope ?? "workspace",
    systemKind: values.systemKind ?? null,
    createdFromOpportunityId: values.opportunityId ?? null,
  }, Date.parse(NOW));

}

beforeEach(() => {
  clearFlagTargetingAttributeCache();
  database = preRetirementProductSqliteDatabase();
  workstreamStores = new Map();
  seedUser(OWNER_ID, "ada@dogfood.example", "Ada Lovelace");
  seedUser(MEMBER_ID, "grace@customer.example", "Grace Hopper");
  seedUser(INVITED_ID, "alan@customer.example", "Alan Turing");
  for (const [id, slug, createdAt] of [
    [WORKSPACE_ID, "Dogfood", THIRTY_DAYS_AGO],
    [OTHER_WORKSPACE_ID, "elsewhere", NOW],
  ] as const) {
    database
      .prepare(
        `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
         VALUES (?, 'Workspace', ?, 'global', ?, ?, ?)`,
      )
      .run(id, slug, OWNER_ID, createdAt, createdAt);
  }
  for (const [workspaceId, userId, role, status] of [
    [WORKSPACE_ID, OWNER_ID, "owner", "active"],
    [WORKSPACE_ID, MEMBER_ID, "member", "active"],
    [WORKSPACE_ID, INVITED_ID, "member", "invited"],
    [OTHER_WORKSPACE_ID, MEMBER_ID, "admin", "active"],
  ] as const) {
    database
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(workspaceId, userId, role, status, NOW);
  }
  database
    .prepare(
      `INSERT INTO work_opportunities (
         id, workspace_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
         admission_reasoning, source_fingerprint, display_prompt_hash, execution_prompt_hash,
         expires_at, created_at, updated_at
       ) VALUES (?, ?, 'workspace', NULL, 'Follow up', 'Follow up on the thread', 'Because', 'fp', 'h1', 'h2', ?, ?, ?)`,
    )
    .run(OPPORTUNITY_ID, WORKSPACE_ID, NOW, NOW, NOW);
  seedWorkstream(AD_HOC_WORKSTREAM, { origin: "ad_hoc", createdByUserId: MEMBER_ID });
  seedWorkstream(AUTOMATION_WORKSTREAM, { origin: "automation", createdByUserId: null });
  seedWorkstream(DIGEST_WORKSTREAM, {
    origin: "ad_hoc",
    createdByUserId: OWNER_ID,
    scope: "personal",
    systemKind: "digest",
    opportunityId: OPPORTUNITY_ID,
  });
});

afterEach(() => {
  vi.useRealTimers();
  database.close();
  for (const store of workstreamStores.values()) store.close();
});

describe("flag targeting attributes", () => {
  it("describes a workspace by slug, size, age, and the domain that owns it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    await expect(
      loadFlagTargetingAttributes(envWith(sqliteD1(database)), { workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual({
      workspaceSlug: "Dogfood",
      // The invited member is not one yet, so a rule on team size does not count them.
      workspaceMemberCount: 2,
      workspaceAgeDays: 30,
      workspaceOwnerEmailDomain: "dogfood.example",
    });
  });

  it("reads a user's role from the workspace being evaluated, not from another of theirs", async () => {
    const env = envWith(sqliteD1(database));

    await expect(
      loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID, userId: MEMBER_ID }),
    ).resolves.toMatchObject({ userEmailDomain: "customer.example", userRole: "member" });
    await expect(
      loadFlagTargetingAttributes(env, { workspaceId: OTHER_WORKSPACE_ID, userId: MEMBER_ID }),
    ).resolves.toMatchObject({ userRole: "admin" });
  });

  it("carries the platform identity a per-person rollout must bucket on", async () => {
    const env = envWith(sqliteD1(database));
    database
      .prepare("UPDATE users SET platform_user_id = ? WHERE id = ?")
      .run("platform-member", MEMBER_ID);
    clearFlagTargetingAttributeCache();

    // `userId` is this region's row; the platform id is the same person in both,
    // so it is the one a percentage rollout may bucket on without splitting them.
    await expect(
      loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID, userId: MEMBER_ID }),
    ).resolves.toMatchObject({ userPlatformId: "platform-member" });
  });

  it("omits the platform identity for an account predating the control plane", async () => {
    const env = envWith(sqliteD1(database));

    // Substituting the regional id would bucket that person differently in each
    // region. An absent attribute matches nothing, which sits them out instead.
    await expect(
      loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID }),
    ).resolves.not.toHaveProperty("userPlatformId");
  });

  it("says who created a work stream and how, which is all a run-time evaluation knows", async () => {
    const env = envWith(sqliteD1(database));

    await expect(
      loadFlagTargetingAttributes(env, {
        workspaceId: WORKSPACE_ID,
        workstreamId: AD_HOC_WORKSTREAM,
      }),
    ).resolves.toMatchObject({
      workstreamOrigin: "ad_hoc",
      workstreamScope: "workspace",
      workstreamFromOpportunity: false,
      workstreamIsSystem: false,
      workstreamCreatedByUserId: MEMBER_ID,
      workstreamCreatorEmailDomain: "customer.example",
    });
  });

  it("omits the creator rather than inventing one for a work stream nobody created", async () => {
    const attributes = await loadFlagTargetingAttributes(envWith(sqliteD1(database)), {
      workspaceId: WORKSPACE_ID,
      workstreamId: AUTOMATION_WORKSTREAM,
    });

    expect(attributes.workstreamOrigin).toBe("automation");
    expect(attributes).not.toHaveProperty("workstreamCreatedByUserId");
    expect(attributes).not.toHaveProperty("workstreamCreatorEmailDomain");
  });

  it("distinguishes machinery and suggested work from an ordinary work stream", async () => {
    await expect(
      loadFlagTargetingAttributes(envWith(sqliteD1(database)), {
        workspaceId: WORKSPACE_ID,
        workstreamId: DIGEST_WORKSTREAM,
      }),
    ).resolves.toMatchObject({
      workstreamIsSystem: true,
      workstreamScope: "personal",
      workstreamFromOpportunity: true,
    });
  });

  it("loads product targeting facts from WorkstreamDO after D1 retirement", async () => {
    const regional = migratedSqliteDatabase();
    const object = testWorkstreamObjectStore();
    try {
      regional.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('${MEMBER_ID}', 'current-member', 'grace@customer.example', 'Grace', '${NOW}', '${NOW}');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('${WORKSPACE_ID}', 'Current', 'current', 'global', '${MEMBER_ID}', '${NOW}', '${NOW}');
        INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
        VALUES ('${WORKSPACE_ID}', '${MEMBER_ID}', 'owner', 'active', '${NOW}');
        UPDATE workstream_authority_control
           SET phase = 'maintenance_draining', generation = 1,
               serving_contract_version = required_serving_contract_version, updated_at = '${NOW}'
         WHERE id = 1;
        UPDATE workstream_authority_control SET phase = 'maintenance_importing', updated_at = '${NOW}' WHERE id = 1;
        UPDATE workstream_authority_control SET phase = 'maintenance_verified', updated_at = '${NOW}' WHERE id = 1;
        UPDATE workstream_authority_control SET phase = 'durable_object_open', updated_at = '${NOW}' WHERE id = 1;
        INSERT INTO workstreams (id, workspace_id, do_identity_anchor)
        VALUES ('${AD_HOC_WORKSTREAM}', '${WORKSPACE_ID}', 1);
      `);
      seedWorkstreamObjectRoot(object, {
        workspaceId: WORKSPACE_ID,
        workstreamId: AD_HOC_WORKSTREAM,
        title: "Ship it",
        description: "",
        originType: "ad_hoc",
        createdByUserId: MEMBER_ID,
        scope: "workspace",
      }, Date.parse(NOW));

      const env = createTestEnv({
        DB: sqliteD1(regional),
        SUBSTREAM_AGENTS: testSubstreamAgentsBinding(object),
        AVALON_REGION: "global",
        APP_ENV: "production",
        LOG_LEVEL: "error",
      });

      await expect(loadFlagTargetingAttributes(env, {
        workspaceId: WORKSPACE_ID,
        workstreamId: AD_HOC_WORKSTREAM,
      })).resolves.toMatchObject({
        workstreamOrigin: "ad_hoc",
        workstreamCreatedByUserId: MEMBER_ID,
        workstreamCreatorEmailDomain: "customer.example",
      });
      expect((regional.prepare("PRAGMA table_info(workstreams)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toEqual(["id", "workspace_id", "do_identity_anchor"]);
    } finally {
      object.close();
      regional.close();
    }
  });

  // The whole point of the boundary: a targeting rule gets the domain, which is
  // a cohort, and never the local part or the name, which are a person.
  //
  // Scoped to the fields the boundary actually covers. `workspaceSlug` is the
  // documented carve-out — it is slugified user-typed text and may itself name
  // a company or a person — so it is excluded here rather than left to pass by
  // accident on a fixture that happens not to be named after anybody.
  it("never sends a name, an address, or an address's local part", async () => {
    const { workspaceSlug, ...attributes } = await loadFlagTargetingAttributes(
      envWith(sqliteD1(database)),
      { workspaceId: WORKSPACE_ID, userId: MEMBER_ID, workstreamId: AD_HOC_WORKSTREAM },
    );

    expect(workspaceSlug).toBe("Dogfood");
    const serialized = JSON.stringify(attributes);
    for (const forbidden of ["@", "ada", "grace", "Lovelace", "Hopper"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("evaluates on identifiers alone when the subject's rows cannot be read", async () => {
    const failing = createTestD1Database({
      prepare: () => {
        throw new Error("D1_ERROR: no such table");
      },
    });

    await expect(
      loadFlagTargetingAttributes(envWith(failing), {
        workspaceId: WORKSPACE_ID,
        userId: MEMBER_ID,
        workstreamId: AD_HOC_WORKSTREAM,
      }),
    ).resolves.toEqual({});
  });

  // A miss is retried immediately by design; a failure is not. While D1 is
  // unhealthy every agent path would otherwise re-read and re-warn per run,
  // making an outage noisier than it already is.
  it("holds a failed read down briefly instead of retrying it every evaluation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const prepare = vi.fn(() => {
      throw new Error("D1_ERROR: storage unavailable");
    });
    const env = envWith(createTestD1Database({ prepare }));

    await loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID });
    await loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID });
    expect(prepare).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.parse(NOW) + 11_000));
    await loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("does not cache partial work-stream facts when creator enrichment fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const healthy = sqliteD1(database);
    let creatorReads = 0;
    const flaky = createTestD1Database({
      prepare: (sql: string) => {
        if (sql.includes("SELECT email FROM users")) {
          creatorReads += 1;
          if (creatorReads === 1) throw new Error("D1_ERROR: storage unavailable");
        }
        return healthy.prepare(sql);
      },
    });
    const env = envWith(flaky);

    await expect(loadFlagTargetingAttributes(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: AD_HOC_WORKSTREAM,
    })).resolves.not.toHaveProperty("workstreamOrigin");

    vi.setSystemTime(new Date(Date.parse(NOW) + 11_000));
    await expect(loadFlagTargetingAttributes(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: AD_HOC_WORKSTREAM,
    })).resolves.toMatchObject({
      workstreamOrigin: "ad_hoc",
      workstreamCreatorEmailDomain: "customer.example",
    });
    expect(creatorReads).toBe(2);
  });

  // The suppression is per entity and per subject: one workspace's failure must
  // not silence the reads a different subject would make.
  it("suppresses only the subject whose read failed", async () => {
    const healthy = sqliteD1(database);
    const prepare = vi.spyOn(healthy, "prepare");
    const flaky = createTestD1Database({
      prepare: (sql: string) => {
        // The workspace facts, not the placement read the object routing makes
        // against the same table on its way to the work stream's own store.
        if (sql.includes("FROM workspaces") && !sql.includes("placement_affinity")) {
          throw new Error("D1_ERROR: storage unavailable");
        }
        return healthy.prepare(sql);
      },
    });
    const env = envWith(flaky);

    await loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID });
    await expect(
      loadFlagTargetingAttributes(env, {
        workspaceId: WORKSPACE_ID,
        workstreamId: AD_HOC_WORKSTREAM,
      }),
    ).resolves.toMatchObject({ workstreamOrigin: "ad_hoc" });
    // The object-owned facts, then the regional creator identity. The work
    // stream's own row is the object's and never reaches this database.
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("reads each subject once and then serves the cached facts", async () => {
    const d1 = sqliteD1(database);
    const prepare = vi.spyOn(d1, "prepare");
    const env = envWith(d1);

    await loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID });
    await loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID });

    expect(prepare).toHaveBeenCalledTimes(2);
  });

  // One request resolves several flags at once — the model an agent runs on and
  // Control Tower's cadence are two evaluations of the same person — and the
  // cache is only written when a read resolves. Without sharing the pending
  // read, every cold isolate and every expiry would pay for the same rows twice.
  it("shares one read between evaluations that describe the same subject at once", async () => {
    const d1 = sqliteD1(database);
    const prepare = vi.spyOn(d1, "prepare");
    const env = envWith(d1);

    const [first, second] = await Promise.all([
      loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID }),
      loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID }),
    ]);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    // And the shared read is not left behind as a second cache: the next
    // evaluation is served by the real one.
    await loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  // "does not remember a row that did not exist yet" is gone with the window it
  // guarded. It asserted that a work-stream id resolved one statement before its
  // regional row was inserted did not cache the miss. There is no such miss now:
  // the object is bootstrapped before any product row lands, and a read against
  // a bootstrapped object answers from its identity root — a resolved read, so
  // the cache writes it by design. What that leaves is recorded in
  // `docs/potential-bugs.md`; nothing here can assert it.

  it("reloads facts once they are stale rather than pinning them for the isolate's life", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const env = envWith(sqliteD1(database));

    await expect(
      loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID }),
    ).resolves.toMatchObject({ workspaceMemberCount: 2 });

    database
      .prepare(`UPDATE workspace_members SET status = 'active' WHERE user_id = ?`)
      .run(INVITED_ID);
    vi.setSystemTime(new Date(Date.parse(NOW) + 6 * 60_000));

    await expect(
      loadFlagTargetingAttributes(env, { workspaceId: WORKSPACE_ID }),
    ).resolves.toMatchObject({ workspaceMemberCount: 3 });
  });

  it("asks for nothing when the subject has no identifiers", async () => {
    const d1 = sqliteD1(database);
    const prepare = vi.spyOn(d1, "prepare");

    await expect(loadFlagTargetingAttributes(envWith(d1), {})).resolves.toEqual({});
    expect(prepare).not.toHaveBeenCalled();
  });
});
