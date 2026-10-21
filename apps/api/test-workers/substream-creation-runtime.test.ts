import { workstreamImportHash } from "../src/durable-objects/workstream-import-hash";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId, type UserId } from "@rally/contracts";
import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { participantMigrationAlarmKey } from "../src/durable-objects/scope-grant-storage";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { SubstreamCreationService } from "../src/services/substream-creation-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { consumeEffectBodies, deliverEffectsToWorkspace, deliverChildEffects, pendingChildEffects, pendingParentEffects, deliverParentEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { hostedParentStub, listVisiblePrivateChildren, withHostedParent } from "./helpers/hosted-parent";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { post, seedParticipantMessage, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ce10");
const CREATOR_ID = asUserId("00000000-0000-7000-8000-00000000ce11");
const OTHER_ID = asUserId("00000000-0000-7000-8000-00000000ce12");
let WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ce13");
let fixtureOrdinal = 0;
const SESSION_ID = "00000000-0000-7000-8000-00000000ce14";
const TEST_ENV: Env = env;
const classifierEnv: { OPENROUTER_CLASSIFIER_MODEL?: string } = env;
const originalClassifierModel = classifierEnv.OPENROUTER_CLASSIFIER_MODEL;
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClassifierModel === undefined) delete classifierEnv.OPENROUTER_CLASSIFIER_MODEL;
  else classifierEnv.OPENROUTER_CLASSIFIER_MODEL = originalClassifierModel;
});

const creatorAuth: AuthContext = {
  sessionId: SESSION_ID,
  userId: CREATOR_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};
const otherAuth: AuthContext = { ...creatorAuth, userId: OTHER_ID, sessionId: "other-session" };

useHeldEffectQueue();
const provider = useOpenRouterDouble((call) => ({ say: call.stream
  ? "The child used its frozen context."
  : JSON.stringify(call.body.response_format ?? {}).includes('message_addressing')
    ? JSON.stringify({ classification: "both", confidence: 1, rationaleCode: "imperative" })
    : JSON.stringify({ summary: "A frozen source summary." }) }));

/** The Channel's parent, hosted by its Organization object. */
function parent() {
  return hostedParentStub(env, WORKSPACE_ID);
}

function conversation(substreamId = "0") {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, asSubstreamId(substreamId)),
  ));
}

beforeEach(async () => {
  // An old object's deferred effects can outlive reset(). Give each fixture
  // distinct named authorities so those drains cannot write into its successor.
  fixtureOrdinal += 1;
  const suffix = String(fixtureOrdinal).padStart(4, "0");
  WORKSPACE_ID = asWorkspaceId(`00000000-0000-7000-8000-${suffix}0000ce10`);
  WORKSTREAM_ID = asWorkstreamId(`00000000-0000-7000-8000-${suffix}0000ce13`);
  creatorAuth.workspaceId = WORKSPACE_ID;
  otherAuth.workspaceId = WORKSPACE_ID;
  await reset();
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: CREATOR_ID,
    sessionId: SESSION_ID,
  });
  await env.DB.prepare("ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'").run();
  await env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT DEFAULT 'Test workspace'`),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(otherAuth.sessionId, OTHER_ID, WORKSPACE_ID),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-09-04T00:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'other@example.com', 'Other', NULL, 'UTC', '2026-09-04T00:00:00.000Z')`).bind(OTHER_ID),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    // Bootstrap reads it to refuse a Space or Sidekick id a Channel create claimed.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
  ]);
  await parent().reserveChild({
    workspaceId: WORKSPACE_ID,
    parentId: WORKSTREAM_ID,
    substreamId: asSubstreamId("0"),
    kind: "main",
    createdByUserId: CREATOR_ID,
    authorityGeneration: 1,
    directory: {
      title: "Source", description: "", scope: "workspace", systemKind: null,
      emailAddress: null, titleStatus: "settled", createdAt: "2026-09-04T00:00:00.000Z",
    },
  });
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, WORKSTREAM_ID, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, title: "Source", objective: "",
    scope: "workspace", createdByUserId: CREATOR_ID, participantUserIds: [CREATOR_ID],
    harnessStatus: "idle", titleStatus: "settled", emailAddress: null, emailRouteStatus: null,
    systemKind: null, modelOverride: null, now: Date.now(),
  });
  await deliverEffectsToWorkspace(TEST_ENV, conversation());
  await runInDurableObject(conversation(), async (_instance, state) => seedParticipantMessage(state, {
    id: "source-turn-1", sequence: 1, text: "The source decision", authorUserId: CREATOR_ID,
    attentionOrdinal: 1, now: Date.now(),
  }));
}, 30_000);

describe("substream preparation on workerd", () => {
  it("warms the reserved child before confirmation without claiming authority or publishing it", async () => {
    const service = new SubstreamCreationService({ ...TEST_ENV, LOG_LEVEL: "info" }, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000cf90";
    const steps: string[] = [];
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const prepared = await service.prepare(WORKSTREAM_ID, {
        operationId,
        title: "Warm child",
        throughTurnId: "source-turn-1",
      }, {
        isTraced: false,
        setAttributes() {},
        setError() {},
        mark() {},
        async step<T>(name: string, run: () => Promise<T>): Promise<T> {
          steps.push(name);
          return run();
        },
      });

    expect(steps).toContain("substream.prepare.child.warm");
    const warmRow = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "substream_child_warmed");
    expect(warmRow).toMatchObject({
      substream_id: prepared.substreamId,
      object_id: env.SUBSTREAM_AGENTS.idFromName(conversationObjectName(
        "global", WORKSPACE_ID, WORKSTREAM_ID, prepared.substreamId,
      )).toString(),
      authority_mode: "unclaimed",
    });
    expect((await listVisiblePrivateChildren(parent(), {
      workspaceId: WORKSPACE_ID,
      parentId: WORKSTREAM_ID,
      userId: CREATOR_ID,
    })).children).toEqual([]);
    logged.mockRestore();
  });

  it("lets a Main-only guest create a child before participant directory delivery", async () => {
    await parent().beginMainParticipantMigration({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID });
    await runDurableObjectAlarm(parent());
    await expect.poll(() => parent().beginMainParticipantMigration({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID }), { timeout: 10_000 })
      .toMatchObject({ status: "complete" });
    await env.DB.prepare("UPDATE workspace_members SET access_class='guest',role=NULL WHERE user_id=?")
      .bind(OTHER_ID).run();
    await runInDurableObject(parent(), (_instance, state) => {
      state.storage.sql.exec("UPDATE channels SET scope='personal' WHERE workstream_id = ?", WORKSTREAM_ID);
    });
    expect(await parent().mutateParticipantGrant({ actorUserId: CREATOR_ID, userId: OTHER_ID,
      target: { kind: "conversation", workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0") },
      operationId: crypto.randomUUID(), active: true })).toMatchObject({ status: "committed" });
    // The held effect queue leaves participant directory delivery pending.
    // Admission reads the Channel's scope from its directory row and its
    // participants from the parent's own rows, so it need not wait for that.
    expect(await withHostedParent(parent(), WORKSTREAM_ID, (hosted) => hosted.canRead(OTHER_ID))).toBe(false);
    const service = new SubstreamCreationService(TEST_ENV, { ...otherAuth, role: null });
    const prepared = await service.prepare(WORKSTREAM_ID, {
      operationId: crypto.randomUUID(), title: "Guest-created child", throughTurnId: "source-turn-1",
    });
    const created = await service.confirm(WORKSTREAM_ID, prepared.operationId);
    expect(created.substreamId).toBe(prepared.substreamId);
    const boot = await new WorkstreamObjectClient(TEST_ENV, { ...otherAuth, role: null }, WORKSTREAM_ID, created.substreamId).boot();
    expect(boot.workstream.title).toBe("Guest-created child");
  });

  it.each([
    { audience: "inherits_workstream", interrupted: false },
    { audience: "restricted", interrupted: false },
    { audience: "inherits_workstream", interrupted: true },
  ] as const)("hands new $audience children to existing grant authority (interrupted=$interrupted)", async ({ audience, interrupted }) => {
    await parent().beginMainParticipantMigration({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID });
    await runDurableObjectAlarm(parent());
    await expect.poll(() => parent().beginMainParticipantMigration({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID }), { timeout: 10_000 })
      .toMatchObject({ status: "complete" });
    expect(await parent().mutateScopeGrant({ actorUserId: CREATOR_ID, userId: OTHER_ID,
      target: { kind: "workstream", workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID },
      operationId: crypto.randomUUID(), expectedRevision: 0, active: true })).toMatchObject({ status: "committed" });
    await env.DB.prepare("UPDATE workspace_members SET access_class='guest' WHERE user_id=?").bind(OTHER_ID).run();
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = crypto.randomUUID();
    const prepared = await service.prepare(WORKSTREAM_ID, { operationId, title: "Future child", throughTurnId: "source-turn-1" });
    await runInDurableObject(parent(), (_instance, state) => {
      // The product currently creates restricted children. Exercise both stored
      // audience policies through the same real publication and handoff path.
      state.storage.sql.exec("UPDATE parent_children SET audience=? WHERE parent_id=? AND substream_id=?", audience, WORKSTREAM_ID, prepared.substreamId);
    });
    if (interrupted) {
      await runInDurableObject(parent(), (_instance, state) => {
        state.storage.sql.exec(`CREATE TRIGGER fail_child_handoff BEFORE UPDATE OF phase ON parent_participant_migrations
          WHEN NEW.phase='complete' BEGIN SELECT RAISE(ABORT, 'child handoff unavailable'); END`);
      });
      await expect(service.confirm(WORKSTREAM_ID, operationId)).rejects.toThrow("child handoff unavailable");
      await runInDurableObject(parent(), async (_instance, state) => {
        expect(state.storage.sql.exec("SELECT status FROM parent_children WHERE parent_id=? AND substream_id=?", WORKSTREAM_ID, prepared.substreamId)
          .one()).toEqual({ status: "ready" });
        expect(state.storage.sql.exec("SELECT phase FROM parent_participant_migrations WHERE parent_id=? AND substream_id=?", WORKSTREAM_ID, prepared.substreamId)
          .one()).toEqual({ phase: "pending" });
        expect(state.storage.sql.exec("SELECT 1 FROM _internal_durable_alarms WHERE kind='parent_participant_migration' AND alarm_key=?",
          participantMigrationAlarmKey(WORKSTREAM_ID, prepared.substreamId)).toArray()).toHaveLength(1);
        state.storage.sql.exec("DROP TRIGGER fail_child_handoff");
        state.storage.sql.exec("UPDATE _internal_durable_alarms SET retry_at=0 WHERE kind='parent_participant_migration'");
        await state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(parent());
      await expect.poll(() => runInDurableObject(parent(), (_instance, state) =>
        state.storage.sql.exec<{ phase: string }>("SELECT phase FROM parent_participant_migrations WHERE parent_id=? AND substream_id=?", WORKSTREAM_ID, prepared.substreamId)
          .one().phase), { timeout: 10_000 }).toBe("complete");
    }
    const created = await service.confirm(WORKSTREAM_ID, operationId);
    await runInDurableObject(parent(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT phase FROM parent_participant_migrations WHERE parent_id=? AND substream_id=?", WORKSTREAM_ID, created.substreamId)
        .toArray()).toEqual([{ phase: "complete" }]);
    });
    expect(await parent().readScopeAccess({ userId: OTHER_ID, target: { kind: "conversation",
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: created.substreamId } }))
      .toMatchObject({ allowed: audience === "inherits_workstream" });
    await runInDurableObject(conversation(created.substreamId), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT phase FROM participant_authority_transfer").one()).toEqual({ phase: "projection" });
    });
    expect(await service.confirm(WORKSTREAM_ID, operationId)).toMatchObject({ substreamId: created.substreamId });
  });

  it("refuses first history installation after publishing an empty child", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000cf91";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "Empty child", throughTurnId: "source-turn-1" });
    const created = await service.confirm(WORKSTREAM_ID, operationId);
    const content = { messages: [{ role: "user" as const, text: "Late history" }] };
    await expect(service.confirm(WORKSTREAM_ID, operationId, null, null, content)).rejects.toThrow("different content");
    await expect((async () => await conversation(created.substreamId).installPreparedConversation({
      workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, substreamId: created.substreamId,
      operationId, conversation: content,
    }))()).rejects.toThrow("private_child_initialization_conflict");
    const boot = await new WorkstreamObjectClient(TEST_ENV, creatorAuth, WORKSTREAM_ID, created.substreamId).boot();
    expect(boot.transcript.ranges.flatMap((range) => range.turns)).toEqual([]);
  });

  it("freezes history intent before another confirmation can publish without it", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000cf92";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "History child", throughTurnId: "source-turn-1" });
    const content = { messages: [{ role: "user" as const, text: "Required history" }] };
    const claimed = await parent().claimPrivateChildConfirmation({ workspaceId: WORKSPACE_ID,
      parentId: WORKSTREAM_ID, operationId, actorUserId: CREATOR_ID,
      preparedConversationHash: workstreamImportHash(content) });
    await expect(service.confirm(WORKSTREAM_ID, operationId)).rejects.toThrow("different content");
    expect((await parent().readPrivateChildPreparation({ workspaceId: WORKSPACE_ID,
      parentId: WORKSTREAM_ID, operationId }))?.status).toBe("confirming");
    const created = await service.confirm(WORKSTREAM_ID, operationId, null, null, content);
    expect(created.substreamId).toBe(claimed.substreamId);
    const boot = await new WorkstreamObjectClient(TEST_ENV, creatorAuth, WORKSTREAM_ID, created.substreamId).boot();
    expect(JSON.stringify(boot.transcript)).toContain("Required history");
  });

  it("materializes prepared history before publishing a private child and rejects changed replay", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce99";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "Prepared child", throughTurnId: "source-turn-1" });
    const content = { messages: [{ role: "user" as const, text: "Prepared question" }, { role: "assistant" as const, text: "Prepared answer" }] };
    const created = await service.confirm(WORKSTREAM_ID, operationId, null, null, content);
    const boot = await new WorkstreamObjectClient(TEST_ENV, creatorAuth, WORKSTREAM_ID, created.substreamId).boot();
    expect(boot.transcript.ranges.flatMap((range) => range.turns).map((turn) => turn.actor)).toEqual(["human", "assistant"]);
    expect(JSON.stringify(boot.transcript)).toContain("Prepared answer");
    expect(await service.confirm(WORKSTREAM_ID, operationId, null, null, content)).toMatchObject({ substreamId: created.substreamId });
    await expect(service.confirm(WORKSTREAM_ID, operationId, null, null, { messages: [{ role: "user", text: "Changed" }] })).rejects.toThrow("different content");
    expect(await runInDurableObject(conversation(created.substreamId), (_instance, ctx) => ctx.storage.sql.exec(`SELECT run_id FROM runs`).toArray())).toEqual([]);
  });

  it("receipts private-child directory effects for a member absent from Main", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce22";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "Private branch", throughTurnId: "source-turn-1" });
    const { substreamId } = await service.confirm(WORKSTREAM_ID, operationId);
    await service.changeParticipant(WORKSTREAM_ID, substreamId, { userId: OTHER_ID, operationId: "add-other" }, true);
    const result = await post(conversation(substreamId), "/internal/product", {
      operation: "update", auth: otherAuth, input: { title: "Private update" },
    });
    expect(result.status).toBe(200);
    await deliverChildEffects(TEST_ENV, conversation(substreamId));
    await runInDurableObject(parent(), (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT 1 FROM parent_child_viewer_projections WHERE parent_id = ? AND substream_id = '0' AND user_id = ?`, WORKSTREAM_ID, OTHER_ID).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT 1 FROM parent_child_viewer_projections WHERE parent_id = ? AND substream_id = ? AND user_id = ?`, WORKSTREAM_ID, substreamId, OTHER_ID).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec(`SELECT 1 FROM parent_child_receipts WHERE parent_id = ? AND substream_id = ?`, WORKSTREAM_ID, substreamId).toArray().length).toBeGreaterThan(0);
      expect(state.storage.sql.exec<{ title: string }>(`SELECT title FROM channels WHERE workstream_id = ?`, WORKSTREAM_ID).one().title).toBe("Source");
    });
  });

  it("does not publish readiness while a membership delivery is deferred", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce23";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "Pending membership", throughTurnId: "source-turn-1" });
    await runInDurableObject(parent(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE parent_breakout_member_effects SET not_before = ? WHERE parent_id = ?`, Date.now() + 60_000, WORKSTREAM_ID);
    });
    await expect(service.confirm(WORKSTREAM_ID, operationId)).rejects.toThrow("private_child_membership_delivery_pending");
    expect((await listVisiblePrivateChildren(parent(), { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: CREATOR_ID })).children).toEqual([]);
    await runInDurableObject(parent(), (_instance, state) => { state.storage.sql.exec(`UPDATE parent_breakout_member_effects SET not_before = 0 WHERE parent_id = ?`, WORKSTREAM_ID); });
    await expect(service.confirm(WORKSTREAM_ID, operationId)).resolves.toHaveProperty("substreamId");
  });

  it("rechecks parent authority at the prepared-context commit", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce24";
    const prepared = await service.prepare(WORKSTREAM_ID, { operationId, title: "Revoked preparation", throughTurnId: "source-turn-1" });
    const result = await post(conversation(), "/internal/product", { operation: "update", auth: creatorAuth, input: { archived: true } });
    expect(result.status).toBe(200);
    await deliverChildEffects(TEST_ENV, conversation());
    await expect(Promise.resolve(parent().savePreparedPrivateChildContext({
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, operationId, preparedContext: prepared.preparedContext!,
    }))).rejects.toThrow("private_child_preparation_forbidden");
  });

  it.each(["active", "active-main", "removed", "archived"] as const)("delivers a child mention only to a currently active recipient (%s), without changing parent attention or participation", async (recipientState) => {
    // The defect this covers: `forwardsChildEffect` answered
    // `substreamId === "0"` for every kind, so a mention written in a
    // substream reached the parent's outbox and stopped there. Nobody was ever
    // told they had been tagged in a substream, by Slack or by mail.
    const mainParticipant = recipientState === "active-main";
    if (mainParticipant) {
      expect((await post(conversation(), "/internal/product", {
        operation: "add_participant", auth: creatorAuth, userId: OTHER_ID,
      })).status).toBe(200);
      await deliverChildEffects(TEST_ENV, conversation());
      await deliverParentEffects(TEST_ENV, parent());
    }
    const originalMain = await runInDurableObject(parent(), (_instance, state) =>
      state.storage.sql.exec(`SELECT effect_json FROM parent_child_viewer_projections WHERE parent_id = ? AND substream_id = '0' AND user_id = ?`, WORKSTREAM_ID, OTHER_ID).toArray());
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce31";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "Mentioning child", throughTurnId: "source-turn-1" });
    const substreamId = (await service.confirm(WORKSTREAM_ID, operationId)).substreamId;
    await service.changeParticipant(WORKSTREAM_ID, substreamId, {
      userId: OTHER_ID, operationId: "00000000-0000-7000-8000-00000000ce32",
    }, true);
    const child = conversation(substreamId);
    // Everything the seating produced, out of the way: what follows must be
    // the mention's own effects.
    await deliverChildEffects(TEST_ENV, child);
    await deliverParentEffects(TEST_ENV, parent());
    const childWaterline = () => runInDurableObject(parent(), (_instance, state) =>
      state.storage.sql.exec<{ waterline: number }>(
        `SELECT MAX(waterline) AS waterline FROM parent_state_changes WHERE parent_id = ? AND state_key = ?`,
        WORKSTREAM_ID,
        `children:${OTHER_ID}`,
      ).one().waterline);
    const childWaterlineBeforeMention = await childWaterline();

    const text = "@Other take a look at this";
    const sent = await post(child, "/internal/product", {
      operation: "create_message", auth: creatorAuth, input: {
        text, clientMessageId: "substream-mention", attachmentIds: [], confirmedParticipantUserIds: [],
        mentions: [{ type: "person", userId: OTHER_ID, connectorType: null, startOffset: 0, endOffset: "@Other".length }],
        // Skips the addressing classifier, whose own model routing is not what
        // this test is about; the delivery effects it stands in front of are
        // identical either way.
        forcedHarnessOrigin: "test_mention",
      },
    });
    expect(sent.status).toBe(200);
    // A submitted message is pending until the transcript promotes it, and
    // the delivery effects — the viewer rows and the mention — are written in
    // that same transaction.
    await expect.poll(async () => {
      await runDurableObjectAlarm(child);
      await deliverChildEffects(TEST_ENV, child);
      return (await pendingParentEffects(parent())).some((envelope) => envelope.effect.kind === "mention_notification");
    }, { timeout: 10_000 }).toBe(true);

    const forwarded = await pendingParentEffects(parent());
    const mention = forwarded.find((envelope) => envelope.effect.kind === "mention_notification");
    expect(mention?.effect).toMatchObject({
      kind: "mention_notification",
      recipientUserId: OTHER_ID,
      substreamId,
      authorUserId: CREATOR_ID,
      // Canonicalised on the way in, which is what the mail and the Slack DM
      // then render; the assertion follows the payload rather than the input.
      messageText: expect.stringContaining("take a look at this"),
      // The substream's own name, not its parent's: an inbox that says where
      // this happened has to name the conversation the reader can open.
      workstreamTitleSnapshot: "Mentioning child",
    });
    // Delivery is gated on the recipient's own directory row having reached
    // the workspace, and for a private child nothing else advances that key.
    // Forwarding the notification without it is a poison retry, not a missing
    // badge, so the row has to be queued *ahead* of it rather than merely
    // queued.
    expect(mention?.requiredProjectionVersion).toBeGreaterThan(0);
    expect(await childWaterline()).toBeGreaterThan(childWaterlineBeforeMention);
    expect((await listVisiblePrivateChildren(parent(), {
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: OTHER_ID,
    })).children).toContainEqual(expect.objectContaining({
      substreamId,
      youAreMentioned: true,
      unreadCount: 1,
      harnessStatus: expect.any(String),
    }));
    const childWaterlineBeforeRead = await childWaterline();
    expect((await post(child, "/internal/product", {
      operation: "acknowledge_read", auth: otherAuth,
      input: { readThroughSequenceNumber: 1, observedManualUnreadGeneration: 0 },
    })).status).toBe(200);
    const readUserEffect = (await pendingChildEffects(child)).find((envelope) =>
      envelope.effect.kind === "directory_user" && envelope.effect.userId === OTHER_ID,
    );
    expect(readUserEffect).toBeDefined();
    expect(await consumeEffectBodies(TEST_ENV, [readUserEffect])).toMatchObject({ acked: 1, retried: 0 });
    expect(await childWaterline()).toBeGreaterThan(childWaterlineBeforeRead);
    await deliverChildEffects(TEST_ENV, child);
    const outbound: { text: string; to: string[] }[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.resend.com/emails") {
        outbound.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "provider-message" });
      }
      return originalFetch(input, init);
    });
    // Miniflare cannot implement jurisdiction selection; retain real objects
    // and replace only that unsupported namespace operation.
    const localJurisdiction = <T extends Env["WORKSPACE_DOS"]>(namespace: T): T => new Proxy(namespace, {
      get(target, property) {
        if (property === "jurisdiction") return () => target;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    if (recipientState === "removed") {
      await service.changeParticipant(WORKSTREAM_ID, substreamId, { userId: OTHER_ID, operationId: "remove-before-delivery" }, false);
    } else if (recipientState === "archived") {
      await service.archive(WORKSTREAM_ID, substreamId, true);
    }
    // Email is the one transport this test can read, so the recipient chooses it.
    await TEST_ENV.WORKSPACE_DOS.get(TEST_ENV.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
      .saveMemberPreferences({ workspaceId: WORKSPACE_ID, userId: OTHER_ID, preferences: { notify: { mentions: ["email"] } } });
    await deliverParentEffects({ ...TEST_ENV,
      WORKSPACE_DOS: localJurisdiction(TEST_ENV.WORKSPACE_DOS),
      APP_ENV: "production", RESEND_API_KEY: "test-only",
      RESEND_NOTIFICATION_FROM_EMAIL: "Rally <test@example.test>",
    }, parent());
    expect(outbound).toHaveLength(recipientState.startsWith("active") ? 1 : 0);
    if (recipientState.startsWith("active")) {
      expect(outbound[0]?.to).toEqual(["other@example.com"]);
      expect(outbound[0]?.text).toContain(`/substreams/${substreamId}`);
      expect(outbound[0]?.text).toContain("take a look at this");
    }
    const workspace = TEST_ENV.WORKSPACE_DOS.get(TEST_ENV.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
    expect(await workspace.notificationDirectoryState({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, userId: OTHER_ID }))
      .toMatchObject({ listable: mainParticipant, title: "Source" });
    expect(await runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec(
      `SELECT is_participant, unread_count, you_are_mentioned FROM channel_viewers
        WHERE workstream_id = ? AND user_id = ?`, WORKSTREAM_ID, OTHER_ID,
    ).one())).toEqual({ is_participant: Number(mainParticipant), unread_count: 0, you_are_mentioned: 0 });
    expect(await runInDurableObject(parent(), (_instance, state) =>
      state.storage.sql.exec(`SELECT effect_json FROM parent_child_viewer_projections WHERE parent_id = ? AND substream_id = '0' AND user_id = ?`, WORKSTREAM_ID, OTHER_ID).toArray())).toEqual(originalMain);

    // Everything addressed to the Channel's own surface rather than a person
    // stays here: a private child is in no feed, no digest and no Channel
    // sidebar aggregate. Its own tagged projection does reach the directory,
    // because the Space dashboard lists Breakouts beside their Channel without
    // merging a Breakout's title or activity into the Channel row. Directory
    // effects are applied inside the Organization object rather than queued,
    // so what is asserted is the rows they left: the Breakout's own, and the
    // Channel's, still carrying the Channel's title.
    expect(forwarded.some((envelope) => envelope.effect.kind === "activity_event")).toBe(false);
    expect(await runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec(
      "SELECT title FROM channels WHERE workstream_id = ?", WORKSTREAM_ID,
    ).toArray())).toEqual([{ title: "Source" }]);
    expect(await runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec(
      "SELECT title FROM breakouts WHERE workstream_id = ? AND substream_id = ?", WORKSTREAM_ID, substreamId,
    ).toArray())).toEqual([{ title: "Mentioning child" }]);


  });

  it("tells somebody they were added to a substream, under an identity the main room cannot collide with", async () => {
    // Seat the same person in the main room first. Both seatings are that
    // person's first, so both carry epoch 0 — which is what made the two
    // identities collide while the parent id alone scoped them, and a
    // collision here is a hash conflict the parent retries forever.
    const seated = await post(conversation(), "/internal/product", {
      operation: "add_participant", auth: creatorAuth, userId: OTHER_ID,
    });
    expect(seated.status).toBe(200);
    const roomAdd = (await deliverChildEffects(TEST_ENV, conversation()))
      .find((envelope) => envelope.effect.kind === "participant_notification");
    expect(roomAdd).toBeDefined();

    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce33";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "Seating child", throughTurnId: "source-turn-1" });
    const substreamId = (await service.confirm(WORKSTREAM_ID, operationId)).substreamId;
    await service.changeParticipant(WORKSTREAM_ID, substreamId, {
      userId: OTHER_ID, operationId: "00000000-0000-7000-8000-00000000ce34",
    }, true);
    const childAdd = (await deliverChildEffects(TEST_ENV, conversation(substreamId)))
      .find((envelope) => envelope.effect.kind === "participant_notification");
    expect(childAdd?.effect).toMatchObject({
      kind: "participant_notification",
      recipientUserId: OTHER_ID,
      actorUserId: CREATOR_ID,
      workstreamTitleSnapshot: "Seating child",
    });
    const roomIntent = roomAdd?.effect.kind === "participant_notification" ? roomAdd.effect.intentId : null;
    const childIntent = childAdd?.effect.kind === "participant_notification" ? childAdd.effect.intentId : null;
    expect(childIntent).not.toBe(roomIntent);
    expect(childIntent).toContain(substreamId);
    // And it leaves the parent, which is the point of telling them at all.
    // Matched on the substream's own intent id, not just the recipient: the
    // main room's add is queued here too and would answer for it.
    expect((await pendingParentEffects(parent())).some((envelope) =>
      envelope.effect.kind === "participant_notification"
      && envelope.effect.intentId === childIntent)).toBe(true);
  });

  it("persists a member mention in the first child instruction and uses its frozen seed", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce22";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "Executing child", throughTurnId: "source-turn-1" });
    const { substreamId } = await service.confirm(WORKSTREAM_ID, operationId);
    await service.changeParticipant(WORKSTREAM_ID, substreamId, { userId: OTHER_ID, operationId: "mention-admission" }, true);
    const child = conversation(substreamId);
    await runInDurableObject(child, (instance, state) => {
      const target = instance as unknown as { env: Env };
      target.env = new Proxy(target.env, { get: (env, key) => key === "OPENROUTER_PRIMARY_MODEL"
        ? "google/gemini-2.5-flash-lite" : Reflect.get(env, key) });
      // Suppress alarm execution, not activation itself, so a provider call can
      // only come from the current invocation's eager drain. The durable alarm
      // remains armed as the recovery authority.
      const wakeups = instance as unknown as {
        runDueAlarmWork: () => Promise<void>;
      };
      wakeups.runDueAlarmWork = async () => {};
      state.storage.sql.exec(`UPDATE workstream SET model_override = 'google/gemini-2.5-flash-lite' WHERE id = 1`);
    });
    await runInDurableObject(conversation(), async (_instance, state) => seedParticipantMessage(state, {
      id: "later-main-turn", sequence: 2, text: "MAIN_ONLY_AFTER_FORK", authorUserId: CREATOR_ID,
      attentionOrdinal: 2, now: Date.now(),
    }));
    TEST_ENV.OPENROUTER_CLASSIFIER_MODEL = "double/classifier";
    const response = await child.fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "create_message", auth: creatorAuth, input: {
        text: "@Other CHILD_ONLY_INSTRUCTION", clientMessageId: "first-child-instruction",
        mentions: [{ type: "person", userId: OTHER_ID, connectorType: null, startOffset: 0, endOffset: 6 }], confirmedParticipantUserIds: [], attachmentIds: [],
      } }),
    });
    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    // Admission commits an alarm for recovery, but the healthy path starts the
    // durable loop in this same invocation instead of waiting for it to fire.
    await expect.poll(async () => {
      if (provider.calls.some((call) => call.stream)) return "inference";
      return runInDurableObject(child, (_instance, state) => JSON.stringify(
        state.storage.sql.exec(`SELECT status, error_json FROM runs`).toArray(),
      ));
    }, { timeout: 10_000 }).toBe("inference");
    const prompt = JSON.stringify(provider.calls.find((call) => call.stream)?.messages);
    expect(prompt).toContain("A frozen source summary.");
    expect(prompt).toContain("CHILD_ONLY_INSTRUCTION");
    expect(prompt).not.toContain("MAIN_ONLY_AFTER_FORK");
    await expect.poll(() => runInDurableObject(child, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM substream_loops WHERE status = 'executing'`,
      ).one().count), { timeout: 10_000 }).toBe(0);
    await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec<{ target_user_id: string }>(
        `SELECT target_user_id FROM participant_transcript_mentions WHERE mention_kind = 'person'`,
      ).toArray()).toEqual([{ target_user_id: OTHER_ID }]);
      expect(state.storage.sql.exec<{ substream_id: string }>(`SELECT substream_id FROM runs`).one().substream_id).toBe("0");
      const context = state.storage.sql.exec<{ execution_context_json: string }>(
        `SELECT execution_context_json FROM runs`,
      ).one();
      expect(JSON.parse(context.execution_context_json).substreamId).not.toBe("0");
    });
  });

  it("prepares and confirms one creator-only idle child idempotently", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce20";
    const prepared = await service.prepare(WORKSTREAM_ID, {
      operationId, title: "Private branch", throughTurnId: "source-turn-1",
    });
    const first = await service.confirm(WORKSTREAM_ID, operationId);
    const replay = await service.confirm(WORKSTREAM_ID, operationId);

    expect(replay).toEqual(first);
    expect(prepared.preparedContext?.capture?.messages[0]?.blocks[0]?.text).toBe("The source decision");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.model).toBe("google/gemini-2.5-flash-lite");
    expect(await parent().authorizeViewer({
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: CREATOR_ID,
      substreamId: asSubstreamId(first.substreamId),
    })).toMatchObject({ authorized: true });
    expect(await parent().authorizeViewer({
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: OTHER_ID,
      substreamId: asSubstreamId(first.substreamId),
    })).toMatchObject({ authorized: false });
    await runInDurableObject(conversation(first.substreamId), (_instance, state) => {
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      expect(transcript.initialContext()).toMatchObject({
        source: { substreamId: "0" }, throughTurnId: "source-turn-1",
      });
      expect(transcript.transcriptThrough()).toBe(0);
      expect(transcript.pendingTranscriptInputs()).toEqual([]);
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM runs`).one().count).toBe(0);
    });
  });

  it("lists each breakout with the Main turn it was branched through, and null for one branched through none", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    await service.prepare(WORKSTREAM_ID, {
      operationId: "00000000-0000-7000-8000-00000000ce50", title: "Through a turn", throughTurnId: "source-turn-1",
    });
    const throughTurn = await service.confirm(WORKSTREAM_ID, "00000000-0000-7000-8000-00000000ce50");
    await service.prepare(WORKSTREAM_ID, {
      operationId: "00000000-0000-7000-8000-00000000ce51", title: "Through nothing", throughTurnId: null,
    });
    const throughNothing = await service.confirm(WORKSTREAM_ID, "00000000-0000-7000-8000-00000000ce51");

    const listed = (await listVisiblePrivateChildren(parent(), {
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: CREATOR_ID,
    })).children;
    expect(listed.find((child) => child.substreamId === throughTurn.substreamId)?.originTurnId).toBe("source-turn-1");
    expect(listed.find((child) => child.substreamId === throughNothing.substreamId)?.originTurnId).toBeNull();
  });

  it("creates the child with the message that started it, named from it and waiting on nothing else", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce40";
    // No title: the launch surface has no field for one, and this is the whole
    // of what the desktop sends.
    await service.prepare(WORKSTREAM_ID, { operationId, throughTurnId: "source-turn-1" });
    const created = await service.confirm(WORKSTREAM_ID, operationId, {
      clientMessageId: "opening-instruction",
      text: "Compare the pricing page\nwith last quarter",
      mentions: [],
      attachmentIds: [],
      confirmedParticipantUserIds: [],
    });

    expect(created.opening?.turnId).toEqual(expect.any(String));
    // The first line of the message, not the placeholder preparation reserved
    // the child under, and in `naming` so its header shows a skeleton rather
    // than a name nobody chose.
    expect(created.title).toBe("Compare the pricing page");
    await runInDurableObject(conversation(created.substreamId), (_instance, state) => {
      // `automatic` rather than `naming` because this caller has no deferral,
      // so the first naming pass is awaited inside the confirmation. Reaching
      // it at all is the assertion: the pass advances `naming` -> `automatic`
      // with a compare-and-set, so a child provisioned settled, or a pass
      // addressed at the parent as it used to be, both leave this untouched.
      expect(state.storage.sql.exec<{ title: string; title_status: string; description: string }>(
        `SELECT title, title_status, description FROM workstream WHERE id = 1`,
      ).one()).toMatchObject({
        title: "Compare the pricing page",
        title_status: "automatic",
        // The opening line, not the whole message: a description is what a
        // sidebar shows and what every run starts from.
        description: "Compare the pricing page",
      });
      // The turn is durable and the child's loop has been asked to run: an
      // opening message that reached the transcript without waking the loop
      // would sit there with nobody working on it.
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE client_message_id = 'opening-instruction'`,
      ).one().count).toBe(1);
    });
    // And the work stream it branched out of keeps its own name: naming a child
    // is addressed at the child.
    await runInDurableObject(conversation(), (_instance, state) => {
      expect(state.storage.sql.exec<{ title: string }>(
        `SELECT title FROM workstream WHERE id = 1`,
      ).one().title).toBe("Source");
    });
    // The row every member's sidebar reads carries the same title as the child
    // itself, in the write that made it visible.
    expect((await listVisiblePrivateChildren(parent(), {
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: CREATOR_ID,
    })).children.find((child) => child.substreamId === created.substreamId))
      .toMatchObject({ title: "Compare the pricing page" });

    // A retry of the same confirmation replays the turn rather than saying it
    // twice: the response is lost far more often than the write is.
    const replay = await service.confirm(WORKSTREAM_ID, operationId, {
      clientMessageId: "opening-instruction",
      text: "Compare the pricing page\nwith last quarter",
      mentions: [],
      attachmentIds: [],
      confirmedParticipantUserIds: [],
    });
    expect(replay.opening?.turnId).toBe(created.opening?.turnId);
    await runInDurableObject(conversation(created.substreamId), (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details`,
      ).one().count).toBe(1);
    });
  });

  it("names a pin older builds do not know only in pinnedModel", async () => {
    // Builds released before `pinnedModel` parse `modelOverride` as a closed
    // enum and reject the whole conversation for an id outside it, so a model
    // added to the pin list since must reach them as unpinned.
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce47";
    await service.prepare(WORKSTREAM_ID, { operationId, throughTurnId: "source-turn-1" });
    const created = await service.confirm(WORKSTREAM_ID, operationId, {
      clientMessageId: "newer-pin-opening",
      text: "Check the enterprise tier claims",
      mentions: [],
      attachmentIds: [],
      confirmedParticipantUserIds: [],
    }, "x-ai/grok-4.7");

    const detail = await conversation(created.substreamId).fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "get", auth: creatorAuth }),
    });
    expect(await detail.json()).toMatchObject({ pinnedModel: "x-ai/grok-4.7", modelOverride: null });
  });

  it("pins the child to the model its creator chose, and runs it there", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce43";
    await service.prepare(WORKSTREAM_ID, { operationId, throughTurnId: "source-turn-1" });
    const created = await service.confirm(WORKSTREAM_ID, operationId, {
      clientMessageId: "pinned-opening",
      text: "Check the enterprise tier claims",
      mentions: [],
      attachmentIds: [],
      confirmedParticipantUserIds: [],
    }, "x-ai/grok-4.6");

    const child = conversation(created.substreamId);
    await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec<{ model_override: string | null }>(
        `SELECT model_override FROM workstream WHERE id = 1`,
      ).one().model_override).toBe("x-ai/grok-4.6");
    });
    // On the child's row and nowhere else. A pin written onto the parent would
    // look right in the composer that set it and take every other conversation
    // in the work stream with it.
    await runInDurableObject(conversation(), (_instance, state) => {
      expect(state.storage.sql.exec<{ model_override: string | null }>(
        `SELECT model_override FROM workstream WHERE id = 1`,
      ).one().model_override).toBeNull();
    });

    // And on the wire, because that is where the composer's locked pill reads
    // it: a pinned conversation whose run failed before it streamed a token
    // records no model, and the pill would otherwise describe it as following
    // a flag it never consults.
    const detail = await child.fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "get", auth: creatorAuth }),
    });
    expect(await detail.json()).toMatchObject({ pinnedModel: "x-ai/grok-4.6", modelOverride: "x-ai/grok-4.6" });

    // And the column is what the child's own run resolves its route from, which
    // is the whole point of writing it: a pin the composer records but routing
    // never reads would leave the work running on the flag's model while the
    // pill named another one.
    await runDurableObjectAlarm(child);
    await expect.poll(async () => {
      const streamed = provider.calls.find((call) => call.stream);
      if (streamed) return streamed.model;
      return runInDurableObject(child, (_instance, state) => JSON.stringify(
        state.storage.sql.exec(`SELECT status, error_json FROM runs`).toArray(),
      ));
    }, { timeout: 10_000 }).toBe("x-ai/grok-4.6");
  });

  it("refuses a mention of somebody outside the workspace before creating anything", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce42";
    await service.prepare(WORKSTREAM_ID, { operationId, throughTurnId: "source-turn-1" });
    // Somebody who is not in the workspace at all. A workspace member need not
    // be able to read the work stream: a substream seats them on its own.
    const stranger = "00000000-0000-7000-8000-0000000000ff";
    const opening = (userId: UserId) => ({
      clientMessageId: "opening-with-a-stranger",
      text: "@Somebody take a look",
      mentions: [{ type: "person" as const, userId, connectorType: null, startOffset: 0, endOffset: 9 }],
      attachmentIds: [],
      confirmedParticipantUserIds: [userId],
    });
    await expect(service.confirm(WORKSTREAM_ID, operationId, opening(asUserId(stranger))))
      .rejects.toMatchObject({ code: "workspace_member_not_found" });
    // The refusal costs nothing: it lands before the child is provisioned, so
    // there is no substream, no turn and no summary spent on one.
    expect((await listVisiblePrivateChildren(parent(), {
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: CREATOR_ID,
    })).children).toEqual([]);
    await runInDurableObject(conversation(), (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE client_message_id = 'opening-with-a-stranger'`,
      ).one().count).toBe(0);
    });
  });

  it("publishes no child until its opening turn is durable, and completes that child on retry", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce41";
    await service.prepare(WORKSTREAM_ID, { operationId, throughTurnId: "source-turn-1" });
    // A message the child's own product refuses: no text and no attachment.
    // Provisioning and the context install have already happened by the time
    // it is admitted, which is exactly the window this test is about.
    await expect(service.confirm(WORKSTREAM_ID, operationId, {
      clientMessageId: "opening-that-failed",
      text: "",
      mentions: [],
      attachmentIds: [],
      confirmedParticipantUserIds: [],
    })).rejects.toThrow();

    // Nothing in anybody's sidebar: readiness is the publication fence, so a
    // creation that failed to write its message leaves no empty substream
    // behind for somebody to find and wonder about.
    expect((await listVisiblePrivateChildren(parent(), {
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: CREATOR_ID,
    })).children).toEqual([]);

    // And the operation is still the same operation: retrying it — which is
    // what the composer invites, with the words still in it — completes the
    // child that was already provisioned rather than reserving another.
    const created = await service.confirm(WORKSTREAM_ID, operationId, {
      clientMessageId: "opening-that-failed",
      text: "Compare the retry budget",
      mentions: [],
      attachmentIds: [],
      confirmedParticipantUserIds: [],
    });
    expect((await listVisiblePrivateChildren(parent(), {
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, userId: CREATOR_ID,
    })).children.map((child) => child.substreamId)).toEqual([created.substreamId]);
    await runInDurableObject(conversation(created.substreamId), (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details`,
      ).one().count).toBe(1);
    });
  });

  it("does not let another parent member confirm or a cancelled preparation become ready", async () => {
    const operationId = "00000000-0000-7000-8000-00000000ce21";
    const creator = new SubstreamCreationService(TEST_ENV, creatorAuth);
    await creator.prepare(WORKSTREAM_ID, {
      operationId, title: "Cancelled branch", throughTurnId: "source-turn-1",
    });
    await expect(new SubstreamCreationService(TEST_ENV, otherAuth).confirm(WORKSTREAM_ID, operationId))
      .rejects.toMatchObject({ code: "substream_preparation_not_found" });
    await creator.cancel(WORKSTREAM_ID, operationId);
    await expect(creator.prepare(WORKSTREAM_ID, {
      operationId, title: "Cancelled branch", throughTurnId: "source-turn-1",
    })).rejects.toMatchObject({ code: "substream_creation_cancelled" });
    await expect(creator.confirm(WORKSTREAM_ID, operationId))
      .rejects.toMatchObject({ code: "substream_creation_cancelled" });
  });
});
