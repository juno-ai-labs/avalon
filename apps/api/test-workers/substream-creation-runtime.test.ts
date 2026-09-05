/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workstreamDOName } from "../src/durable-objects/names";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { SubstreamCreationService } from "../src/services/substream-creation-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { deliverEffectsToWorkspace } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { seedParticipantMessage, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ce10");
const CREATOR_ID = asUserId("00000000-0000-7000-8000-00000000ce11");
const OTHER_ID = asUserId("00000000-0000-7000-8000-00000000ce12");
let WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ce13");
let fixtureOrdinal = 0;
const SESSION_ID = "00000000-0000-7000-8000-00000000ce14";
const TEST_ENV: Env = env;

const creatorAuth: AuthContext = {
  sessionId: SESSION_ID,
  userId: CREATOR_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};
const otherAuth: AuthContext = { ...creatorAuth, userId: OTHER_ID };

useHeldEffectQueue();
const provider = useOpenRouterDouble((call) => ({ say: call.stream
  ? "The child used its frozen context."
  : JSON.stringify({ summary: "A frozen source summary." }) }));

function parent() {
  return env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
  ));
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
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-09-04T00:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'other@example.com', 'Other', NULL, 'UTC', '2026-09-04T00:00:00.000Z')`).bind(OTHER_ID),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
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
    scope: "workspace", createdByUserId: CREATOR_ID, participantUserIds: [CREATOR_ID, OTHER_ID],
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
  it("executes the first child instruction against its frozen seed without reading later Main messages", async () => {
    const service = new SubstreamCreationService(TEST_ENV, creatorAuth);
    const operationId = "00000000-0000-7000-8000-00000000ce22";
    await service.prepare(WORKSTREAM_ID, { operationId, title: "Executing child", throughTurnId: "source-turn-1" });
    const child = conversation((await service.confirm(WORKSTREAM_ID, operationId)).substreamId);
    await runInDurableObject(child, (instance, state) => {
      const target = instance as unknown as { env: Env };
      target.env = new Proxy(target.env, { get: (env, key) => key === "OPENROUTER_PRIMARY_MODEL"
        ? "google/gemini-2.5-flash-lite" : Reflect.get(env, key) });
      state.storage.sql.exec(`UPDATE workstream SET model_override = 'google/gemini-2.5-flash-lite' WHERE id = 1`);
    });
    await runInDurableObject(conversation(), async (_instance, state) => seedParticipantMessage(state, {
      id: "later-main-turn", sequence: 2, text: "MAIN_ONLY_AFTER_FORK", authorUserId: CREATOR_ID,
      attentionOrdinal: 2, now: Date.now(),
    }));
    const response = await child.fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "create_message", auth: creatorAuth, input: {
        text: "CHILD_ONLY_INSTRUCTION", clientMessageId: "first-child-instruction",
        mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
      } }),
    });
    expect(response.status).toBe(200);
    await runDurableObjectAlarm(child);
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
