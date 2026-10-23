/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The whole preparation, phase by phase, on real objects.
 *
 * This is the operation the Demos page drives, minus the Workflow that
 * schedules its steps: each phase is the function the Workflow's step calls,
 * run here in order against the real onboarding service, workspace object,
 * connection copy, seeder, room objects and readiness barrier. What is asserted
 * is what the operator and the presenter get: a workspace owned by the
 * presenter with the cast seated, the template's connection copied under its
 * own identity, every seed action confirmed, a wait that names what has not
 * arrived, and Ready published to the register only once it has — with every
 * phase's receipt where the Demos page reads it.
 *
 * The one deliberate duplicate: the seeding phase is run twice, so a retry
 * after a completed phase confirms nothing twice.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { ParentEffectEnvelope } from "@rally/contracts/conversation-effects";
import { asWorkspaceId } from "@rally/contracts";

import type { Env } from "../src/env";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { encryptString } from "../src/lib/crypto";
import { demoOperationStatus, demoPreparationInstanceId, runDemoPreparationPhase, startDemoOperation } from "../src/services/demo-preparation";
import { demoSeedReceipts } from "../src/services/demo-seeder";
import { DEMO_TEMPLATE_WORKSPACE_ID } from "../src/services/demo-workspace-visibility";
import { workspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import {
  consumeEffectBodies,
  deliverChildEffects,
  parentStubFor,
  pendingParentEffects,
} from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { ensureAuditSchema } from "./helpers/audit-fixture";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { useSidekickRunProvisionConsumer } from "./helpers/sidekick";

const PRESENTER_ID = "00000000-0000-7000-8000-00000000d6a1";
const PRIYA_ID = "00000000-0000-7000-8000-00000000d6a2";
const MARCUS_ID = "00000000-0000-7000-8000-00000000d6a3";
const DANA_ID = "00000000-0000-7000-8000-00000000d6a4";
/** The colleagues the operator casts, by account. */
const CAST = { priya: PRIYA_ID, marcus: MARCUS_ID, dana: DANA_ID };
const CAST_NAMES = { priya: "Priya Raman", marcus: "Michael Holliway", dana: "Max Bender" };
const OPERATION_ID = "00000000-0000-7000-8000-00000000d6b1";
const TEMPLATE_CONNECTION_ID = "00000000-0000-7000-8000-00000000d6c1";
const CREDENTIALS_KEY = "active-connector-credentials-key-for-tests";
const NOW = "2026-09-07T12:00:00.000Z";

useOpenRouterDouble(() => ({
  httpError: { status: 503, body: { error: { message: "a seeded run reached the provider" } } },
}));
useSelectedModel();
useSidekickRunProvisionConsumer();
useHeldEffectQueue();

/**
 * The real bindings with the credential key, the email address key, and the
 * placement fallback a sandbox has, spread rather than cast so a binding that
 * changes shape fails here rather than behind an assertion.
 */
function preparationEnv(workflow: Pick<Workflow, "create"> = { create: async () => ({} as WorkflowInstance) }): Env {
  return {
    ...env,
    CONNECTOR_CREDENTIALS_KEY: CREDENTIALS_KEY,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    WORKSTREAM_EMAIL_ADDRESS_KEY: "workerd-test-email-address-key-0123456789",
    // The driver is the one thing not under test here: the phases are called
    // directly, the way its steps call them.
    DEMO_PREPARATION_WORKFLOW: workflow as Workflow,
  };
}

function workspaceStub(workspaceId: string): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(
    env.WORKSPACE_DOS.idFromName(workspaceDOName("global", asWorkspaceId(workspaceId))),
  ) as DurableObjectStub<WorkspaceDO>;
}

/**
 * The regional control plane the preparation writes into, and the template it
 * copies from. Column lists follow the checked-in migrations; the foreign keys
 * are left out because nothing here turns on them — the Node suite proves
 * those against the real migrations.
 */
async function seedControlPlane(): Promise<void> {
  await ensureAuditSchema();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE sidekick_delegation_locations (
      user_id TEXT NOT NULL,workspace_id TEXT NOT NULL,region TEXT NOT NULL,PRIMARY KEY(user_id,workspace_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL, serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE users (
      id TEXT PRIMARY KEY, google_subject TEXT UNIQUE, platform_user_id TEXT, email TEXT UNIQUE, name TEXT,
      avatar_url TEXT, timezone TEXT, created_at TEXT, updated_at TEXT
    )`),
    // The company's directory: the presenter, and the colleagues a demo is
    // cast from. Everyone is on its own domain and has signed in, which is
    // what makes them castable at all.
    env.DB.prepare(`INSERT INTO users (id, google_subject, platform_user_id, email, name, avatar_url, timezone, created_at, updated_at)
      VALUES (?, 'sub-presenter', ?, 'adam@rallywith.ai', 'Adam', NULL, 'UTC', ?, ?),
             (?, 'sub-priya', ?, 'priya@rallywith.ai', ?, NULL, 'UTC', ?, ?),
             (?, 'sub-marcus', ?, 'kb@rallywith.ai', ?, NULL, 'UTC', ?, ?),
             (?, 'sub-dana', ?, 'max@rallywith.ai', ?, NULL, 'UTC', ?, ?)`)
      .bind(
        PRESENTER_ID, PRESENTER_ID, NOW, NOW,
        PRIYA_ID, PRIYA_ID, CAST_NAMES.priya, NOW, NOW,
        MARCUS_ID, MARCUS_ID, CAST_NAMES.marcus, NOW, NOW,
        DANA_ID, DANA_ID, CAST_NAMES.dana, NOW, NOW,
      ),
    env.DB.prepare(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, region TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles', placement_affinity TEXT NOT NULL DEFAULT 'wnam',
      created_by_user_id TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES (?, 'demo-template', 'demo-template', 'global', ?, ?, ?)`)
      .bind(DEMO_TEMPLATE_WORKSPACE_ID, PRESENTER_ID, NOW, NOW),
    env.DB.prepare(`CREATE TABLE workspace_members (revision INTEGER NOT NULL DEFAULT 1, access_class TEXT NOT NULL DEFAULT 'member', incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
      joined_at TEXT, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES (?, ?, 'owner', 'active', ?)`)
      .bind(DEMO_TEMPLATE_WORKSPACE_ID, PRESENTER_ID, NOW),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, region TEXT NOT NULL,
      revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE regional_onboarding_operations (
      operation_id TEXT PRIMARY KEY, platform_user_id TEXT NOT NULL, action TEXT NOT NULL,
      workspace_id TEXT NOT NULL, invitation_id TEXT, completed_at TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE demo_seed_receipts (
      operation_id TEXT NOT NULL, action_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL, room TEXT, workstream_id TEXT, substream TEXT, substream_id TEXT,
      sidekick_id TEXT, sidekick_run_id TEXT, turn_id TEXT,
      harness_run_id TEXT, run_outcome TEXT, elicitation_id TEXT, resource_id TEXT,
      completed_at TEXT NOT NULL, PRIMARY KEY (operation_id, action_id),
      CHECK (
        CASE kind
          WHEN 'sidekick' THEN room IS NULL AND workstream_id IS NULL
            AND substream IS NULL AND substream_id IS NULL AND sidekick_id IS NOT NULL
          ELSE room IS NOT NULL AND workstream_id IS NOT NULL
            AND substream_id IS NOT NULL AND sidekick_id IS NULL
        END
      )
    )`),
    // The same columns and constraints as `0100`, minus the references to
    // `users` and `workspaces` this suite does not need — and, as in
    // production, no foreign key on `workspace_id`: the creating phase writes
    // it before the workspace row exists.
    env.DB.prepare(`CREATE TABLE demo_operations (
      operation_id TEXT PRIMARY KEY, company_name TEXT NOT NULL, presenter_user_id TEXT NOT NULL,
      pack_version TEXT NOT NULL, cast_json TEXT NOT NULL, workspace_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed', 'abandoned')),
      attempt INTEGER NOT NULL CHECK (attempt > 0), failed_phase TEXT, error_code TEXT, error_message TEXT,
      ready_at TEXT, retired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE demo_operation_phases (
      operation_id TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}', error_code TEXT, error_message TEXT,
      started_at TEXT NOT NULL, finished_at TEXT, PRIMARY KEY (operation_id, phase)
    )`),
  ]);
  // The template's object, with one workspace-scoped connection to copy. A
  // Google connection, the shape a real template holds and the one provider
  // whose grant may be shared (`demo-connection-copy.ts`). The test Worker
  // registers Google with placeholder credentials (`wrangler.test.jsonc`)
  // because the run child's harness loads every connection in the workspace,
  // and a type the Worker is not configured for fails the run.
  await workspaceStub(DEMO_TEMPLATE_WORKSPACE_ID).initializeWorkspace(asWorkspaceId(DEMO_TEMPLATE_WORKSPACE_ID), "wnam");
  const sealed = await encryptString(JSON.stringify({ refreshToken: "demo-refresh-token" }), CREDENTIALS_KEY, TEMPLATE_CONNECTION_ID);
  await workspaceRuntimeDatabase(preparationEnv(), DEMO_TEMPLATE_WORKSPACE_ID).prepare(
    `INSERT INTO connector_connections (
       id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       granted_scopes_json, status, cursor_json, config_json, model_plugin_id,
       created_at, updated_at
     ) VALUES (?, ?, 'google', 'workspace', NULL, 'drive@alto.example',
               'Google Drive', ?, ?, 1, '[]', 'healthy', '{}', '{}', 'plugin_google', ?, ?)`,
  ).bind(TEMPLATE_CONNECTION_ID, DEMO_TEMPLATE_WORKSPACE_ID, sealed.ciphertext, sealed.iv, NOW, NOW).run();
}

function directoryRank(kind: ParentEffectEnvelope["effect"]["kind"]): number {
  return kind === "directory_common" ? 0 : 1;
}

/**
 * The directory effects of one seeded conversation parent, through the real
 * consumer; see demo-readiness.test.ts. `substreamId` names the child whose
 * effects report up to it: a room's own conversation, or a Sidekick's one
 * seeded run.
 */
async function deliverDirectoryEffects(
  workspaceId: string,
  parents: { parentKind: "workstream" | "automation"; parentId: string; substreamId?: string }[],
): Promise<void> {
  for (const { parentKind, parentId, substreamId } of parents) {
    const childStub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", asWorkspaceId(workspaceId), parentId, (substreamId ?? "0") as never),
    ));
    await deliverChildEffects(env, childStub);
    const parent = parentStubFor(env, "global", { workspaceId, parentKind, parentId });
    const directory = (await pendingParentEffects(parent))
      .filter((envelope) => envelope.effect.kind.startsWith("directory_"))
      .sort((left, right) => directoryRank(left.effect.kind) - directoryRank(right.effect.kind));
    for (const envelope of directory) {
      const result = await consumeEffectBodies(env, [envelope]);
      if (result.retried > 0) throw new Error(`directory effect retried: ${envelope.effect.kind}`);
    }
  }
}

beforeEach(async () => {
  await reset();
  await seedControlPlane();
}, 30_000);

describe("preparing a demo", () => {
  it("runs every phase to Ready, publishing only once the presenter's projection matches", async () => {
    const launched: unknown[] = [];
    const prepEnv = preparationEnv({ create: async (input) => { launched.push(input); return {} as WorkflowInstance; } });
    const started = await startDemoOperation(prepEnv, {
      operationId: OPERATION_ID,
      companyName: "Alto Capital",
      presenterUserId: PRESENTER_ID,
      cast: CAST,
    });
    expect(started.status).toBe("running");
    // The colleagues the operator cast, under the names the directory has.
    expect(started.cast).toEqual({ presenter: PRESENTER_ID, ...CAST });
    expect(started.castNames).toEqual({ presenter: "Adam", ...CAST_NAMES });
    const [priya, marcus, dana] = [started.cast.priya!, started.cast.marcus!, started.cast.dana!];
    expect(launched).toHaveLength(1);
    const options = { attempt: 1, deadlineAt: Date.now() + 120_000 };

    expect((await runDemoPreparationPhase(prepEnv, OPERATION_ID, "checking_template", options)).detail)
      .toMatchObject({ templateConnections: 1 });

    const created = await runDemoPreparationPhase(prepEnv, OPERATION_ID, "creating_workspace", options);
    const workspaceId = String(created.detail.workspaceId);
    // Owned by the presenter, with the cast seated; created through onboarding.
    const members = await env.DB.prepare(
      `SELECT user_id, role FROM workspace_members WHERE workspace_id = ? AND status = 'active' ORDER BY role, user_id`,
    ).bind(workspaceId).all<{ user_id: string; role: string }>();
    expect(members.results).toEqual(expect.arrayContaining([
      { user_id: priya, role: "member" },
      { user_id: marcus, role: "member" },
      { user_id: dana, role: "member" },
      { user_id: PRESENTER_ID, role: "owner" },
    ]));
    expect(members.results).toHaveLength(4);
    // Everyone seated is in General and owns a Personal Channel before seeding
    // starts, not when the relationship dispatch next runs.
    const everyone = [PRESENTER_ID, priya, marcus, dana].sort();
    await runInDurableObject(workspaceStub(workspaceId), (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT viewer.user_id FROM space_viewers viewer
          JOIN spaces space ON space.space_id = viewer.space_id
         WHERE space.system_role = 'general' AND viewer.is_participant = 1 ORDER BY viewer.user_id`)
        .toArray().map((row) => row.user_id)).toEqual(everyone);
      expect(state.storage.sql.exec(`SELECT created_by_user_id FROM spaces WHERE scope = 'individual' ORDER BY created_by_user_id`)
        .toArray().map((row) => row.created_by_user_id)).toEqual(everyone);
    });
    expect(await env.DB.prepare(`SELECT name FROM workspaces WHERE id = ?`).bind(workspaceId).first<{ name: string }>())
      .toEqual({ name: "Alto Capital-demo" });
    expect(await env.DB.prepare(`SELECT action FROM regional_onboarding_operations WHERE operation_id = ?`).bind(OPERATION_ID).first())
      .toEqual({ action: "create" });
    // Allocated onto the row, unpublished.
    expect(await env.DB.prepare(`SELECT ready_at FROM demo_operations WHERE workspace_id = ?`).bind(workspaceId).first())
      .toEqual({ ready_at: null });

    const copied = await runDemoPreparationPhase(prepEnv, OPERATION_ID, "copying_connections", options);
    expect(copied.detail).toMatchObject({ copied: [{ connectorType: "google", displayName: "Google Drive" }], skipped: [] });

    const seeded = await runDemoPreparationPhase(prepEnv, OPERATION_ID, "seeding_conversations", options);
    const receipts = await demoSeedReceipts(env.DB, OPERATION_ID);
    expect(seeded.detail).toMatchObject({ confirmed: receipts.length, total: receipts.length });
    // Running the phase again after it completed confirms nothing twice.
    await runDemoPreparationPhase(prepEnv, OPERATION_ID, "seeding_conversations", options);
    expect(await demoSeedReceipts(env.DB, OPERATION_ID)).toHaveLength(receipts.length);

    // The projection has not arrived: waiting, with the gaps named, and the
    // register still unpublished.
    const waiting = await runDemoPreparationPhase(prepEnv, OPERATION_ID, "waiting_for_workspace", options);
    expect(waiting.outcome).toBe("waiting");
    expect((waiting.detail.gaps as { code: string }[]).map((gap) => gap.code)).toContain("mentioned");
    expect((await demoOperationStatus(prepEnv, OPERATION_ID))!).toMatchObject({
      status: "running",
      readyAt: null,
      phases: expect.arrayContaining([
        expect.objectContaining({ phase: "seeding_conversations", status: "completed" }),
        expect.objectContaining({ phase: "waiting_for_workspace", status: "running" }),
      ]),
    });

    await deliverDirectoryEffects(workspaceId, [
      ...new Set(receipts.flatMap((receipt) => receipt.workstreamId ?? [])),
    ].map((parentId) => ({ parentKind: "workstream" as const, parentId })));
    // The pack's Sidekick reports up the same two legs: its seeded run to the
    // Sidekick, and the Sidekick to the workspace.
    await deliverDirectoryEffects(workspaceId, receipts
      .filter((receipt) => receipt.kind === "sidekick")
      .map((receipt) => ({
        parentKind: "automation" as const,
        parentId: receipt.sidekickId!,
        ...(receipt.sidekickRunId ? { substreamId: receipt.sidekickRunId } : {}),
      })));

    const ready = await runDemoPreparationPhase(prepEnv, OPERATION_ID, "waiting_for_workspace", options);
    expect(ready.outcome).toBe("ready");
    const status = (await demoOperationStatus(prepEnv, OPERATION_ID))!;
    expect(status).toMatchObject({ status: "ready", workspaceId, workspaceName: "Alto Capital-demo" });
    expect(status.readyAt).not.toBeNull();
    expect(status.phases.map((phase) => [phase.phase, phase.status])).toEqual([
      ["checking_template", "completed"],
      ["creating_workspace", "completed"],
      ["copying_connections", "completed"],
      ["seeding_conversations", "completed"],
      ["waiting_for_workspace", "completed"],
    ]);
    // The template's connection was copied, not moved.
    const template = await workspaceRuntimeDatabase(prepEnv, DEMO_TEMPLATE_WORKSPACE_ID).prepare(
      `SELECT COUNT(*) AS count FROM connector_connections WHERE id = ?`,
    ).bind(TEMPLATE_CONNECTION_ID).first<{ count: number }>();
    expect(Number(template?.count)).toBe(1);
  }, 120_000);

  it("records a failed phase on the operation, with its reason", async () => {
    const prepEnv = preparationEnv();
    await env.DB.prepare(`UPDATE workspaces SET abandoned_at = ? WHERE id = ?`).bind(NOW, DEMO_TEMPLATE_WORKSPACE_ID).run();
    await startDemoOperation(prepEnv, {
      operationId: OPERATION_ID,
      companyName: "Alto Capital",
      presenterUserId: PRESENTER_ID,
      cast: CAST,
    });
    await expect(runDemoPreparationPhase(prepEnv, OPERATION_ID, "checking_template", { attempt: 1 }))
      .rejects.toMatchObject({ code: "demo_template_missing" });
    expect(await demoOperationStatus(prepEnv, OPERATION_ID)).toMatchObject({
      status: "failed",
      failedPhase: "checking_template",
      error: { code: "demo_template_missing" },
      phases: [expect.objectContaining({ phase: "checking_template", status: "failed" })],
    });
  });
});

describe("the demo Workflow binding", () => {
  it("accepts the launch id, through the validator production applies", async () => {
    // The real binding, not the fake the tests above drive: Cloudflare refuses
    // an instance id outside `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, which is how the
    // colon-joined first version failed every production launch. The
    // instance created here points at an operation no row exists for, so its
    // run fails on first read and touches nothing; it is terminated anyway.
    const operationId = crypto.randomUUID();
    await expect(env.DEMO_PREPARATION_WORKFLOW!.create({ id: `demo-preparation:${operationId}:1`, params: { region: "global", operationId, attempt: 1 } }))
      .rejects.toThrow("Workflow instance has invalid id");
    const instance = await env.DEMO_PREPARATION_WORKFLOW!.create({
      id: demoPreparationInstanceId(operationId, 1),
      params: { region: "global", operationId, attempt: 1 },
    });
    expect(instance.id).toBe(demoPreparationInstanceId(operationId, 1));
    await instance.terminate().catch(() => undefined);
  });
});
