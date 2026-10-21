import { asHarnessRunId, asUserId, asWorkspaceId } from "@rally/contracts";
import { TELEMETRY_EVENTS } from "@rally/contracts/telemetry";
import { describe, expect, it } from "vitest";
import { emitCompletionRepromptTelemetry, type CompletionRepromptObservation } from "../src/telemetry/completion-verification";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const userId = asUserId("018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1");
const workspaceId = asWorkspaceId("018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2");
const input = { workspaceId, parentId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3",
  harnessRunId: asHarnessRunId("018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4"), executionPrincipal: { type: "user" as const, userId } };
const observation: CompletionRepromptObservation = { contextStatus: "resolved",
  decision: { reprompt: true, answer: { type: "choice", choice: "answer_or_result", confidence: 0.7 }, model: "jev-1.14.0", failureKind: null } };

function workDeferral() {
  const pending: Promise<unknown>[] = [];
  return {
    defer(promise: Promise<unknown>) {
      pending.push(promise);
    },
    async settle() {
      for (let index = 0; index < pending.length; index += 1) {
        await pending[index];
      }
    },
  };
}

function fixture() {
  const database = preRetirementProductSqliteDatabase();
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${userId}', 'subject', 'member@example.com', 'Member',
            '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
    INSERT INTO workspaces
      (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', 'UTC', '${userId}',
            '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
  `);
  return {
    database,
    env: createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: 'global',
      APP_ENV: 'production',
      APP_VERSION: '1.96.0',
      BUILD_SHA: 'build-1',
    }),
  };
}

describe("completion reprompt telemetry", () => {
  it.each(["user", "workspace"] as const)("accepts one content-free event per execution for %s ownership", async (owner) => {
    const { database, env } = fixture();
    const pending = workDeferral();
    try {
      const owned = { ...input, executionPrincipal: owner === "user" ? input.executionPrincipal : { type: "workspace" as const, workspaceId } };
      emitCompletionRepromptTelemetry(env, owned, observation, pending.defer);
      expect(database.prepare("SELECT event_id FROM telemetry_accepted_events").all()).toEqual([]);
      await pending.settle();
      emitCompletionRepromptTelemetry(env, owned, observation, pending.defer);
      await pending.settle();
      const rows = database.prepare("SELECT envelope_json, subject_user_id, route FROM telemetry_accepted_events").all() as
        Array<{ envelope_json: string; subject_user_id: string | null; route: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subject_user_id: owner === "user" ? userId : null, route: "global" });
      expect(JSON.parse(rows[0]!.envelope_json)).toMatchObject({ name: "agent_completion_reprompted", source: "api",
        eventId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d7", identityScope: owner === "user" ? "workspace-user" : "workspace",
        context: { operationId: input.harnessRunId }, properties: {
          workstreamId: input.parentId, harnessRunId: input.harnessRunId, reason: "low_confidence",
          choice: "answer_or_result", confidence: 0.7, stopConfidenceThreshold: 0.7, judgeModel: "jev-1.14.0",
        } });
    } finally { database.close(); }
  });

  it.each([
    ["credential_missing", "credential_missing"],
    ["typesafe_request_timed_out", "judge_timeout"],
    ["typesafe_response_invalid_json", "judge_failure"],
  ])("records %s without copying failure payloads", async (failureKind, reason) => {
    const { database, env } = fixture();
    const pending = workDeferral();
    try {
      emitCompletionRepromptTelemetry(env, input, { contextStatus: "resolved",
        decision: { reprompt: true, answer: null, model: null, failureKind } }, pending.defer);
      await pending.settle();
      const row = database.prepare("SELECT envelope_json FROM telemetry_accepted_events").get() as { envelope_json: string };
      expect(JSON.parse(row.envelope_json).properties).toMatchObject({ reason, choice: null, confidence: null });
    } finally { database.close(); }
  });

  it.each([
    { choice: "announces_unfinished_work" as const, contextStatus: "resolved" as const, reason: "unfinished_work" },
    { choice: "unclear" as const, contextStatus: "resolved" as const, reason: "unclear" },
    { choice: "answer_or_result" as const, contextStatus: "unresolved" as const, reason: "context_missing" },
  ])("records $reason for a successful judgment", async ({ choice, contextStatus, reason }) => {
    const { database, env } = fixture();
    const pending = workDeferral();
    try {
      emitCompletionRepromptTelemetry(env, input, { contextStatus, decision: { reprompt: true,
        answer: { type: "choice", choice, confidence: 0.99 }, model: "jev-1.14.0", failureKind: null } }, pending.defer);
      await pending.settle();
      const row = database.prepare("SELECT envelope_json FROM telemetry_accepted_events").get() as { envelope_json: string };
      expect(JSON.parse(row.envelope_json).properties).toMatchObject({ reason, choice, confidence: 0.99 });
    } finally { database.close(); }
  });

  it("respects user product analytics opt-out", async () => {
    const { database, env } = fixture();
    const pending = workDeferral();
    try {
      database.prepare("UPDATE users SET product_analytics_enabled = 0 WHERE id = ?").run(userId);
      emitCompletionRepromptTelemetry(env, input, observation, pending.defer);
      await pending.settle();
      expect(database.prepare("SELECT event_id FROM telemetry_accepted_events").all()).toEqual([]);
    } finally { database.close(); }
  });

  it("does not fail continuation when telemetry acceptance or deferral fails", async () => {
    const { database, env } = fixture();
    const pending = workDeferral();
    database.close();
    expect(() => emitCompletionRepromptTelemetry(env, input, observation, pending.defer)).not.toThrow();
    await expect(pending.settle()).resolves.toBeUndefined();
    expect(() => emitCompletionRepromptTelemetry(env, input, observation, () => { throw new Error("deferral_unavailable"); })).not.toThrow();
  });

  it("rejects conversation content and invalid confidence in the closed event schema", () => {
    const properties = { workstreamId: input.parentId, harnessRunId: input.harnessRunId,
      reason: "low_confidence", choice: "answer_or_result", confidence: 0.7, stopConfidenceThreshold: 0.7, judgeModel: "jev-1.14.0" };
    const schema = TELEMETRY_EVENTS.agent_completion_reprompted.properties;
    expect(schema.safeParse(properties).success).toBe(true);
    expect(schema.safeParse({ ...properties, prompt: "private conversation" }).success).toBe(false);
    expect(schema.safeParse({ ...properties, confidence: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...properties, reason: "arbitrary error contents" }).success).toBe(false);
  });
});
