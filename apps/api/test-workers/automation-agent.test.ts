/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import {
  asAutomationId,
  asUserId,
  asWorkspaceId,
} from "@rally/contracts";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AutomationAgent } from "../src/durable-objects/automation-agent";
import {
  importLegacyAutomationMemory,
  materializeAutomationMemoryDefinitions,
} from "../src/durable-objects/automation-agent-memory";
import { canonicalTranscriptJson } from "../src/durable-objects/ordered-transcript-sqlite/canonical-payload-store";
import { automationAgentName, workspaceDOName } from "../src/durable-objects/names";
import { sha256 } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { AutomationAgentService } from "../src/services/automation-agent-service";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000b1");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-0000000000b2");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000000b3");
const CLIENT_MESSAGE_ID = "00000000-0000-7000-8000-0000000000b4";

function automationStub() {
  return env.AUTOMATION_AGENTS.get(env.AUTOMATION_AGENTS.idFromName(
    automationAgentName("global", WORKSPACE_ID, AUTOMATION_ID),
  ));
}

beforeEach(async () => {
  await reset();
  await env.DB.prepare(`CREATE TABLE workstream_email_routes (
    local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
    workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (region, workspace_id, workstream_id),
    UNIQUE (region, workspace_id, automation_subscription_id))`).run();
  await env.DB.prepare(
    `INSERT INTO workstream_email_routes
       (local_part, region, workspace_id, workstream_id, automation_subscription_id, created_at, updated_at)
     VALUES ('amber-cobalt-jade-river', 'global', ?, NULL, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`,
  ).bind(WORKSPACE_ID, AUTOMATION_ID).run();
});

/** The compiled definition a create test submits, in the shape the object stores. */
function readyDefinition(name: string) {
  return {
    name,
    description: "Summarize unread email every weekday morning.",
    overview: "Each weekday at 9:00 AM, write a short digest.",
    instructions: "Summarize the unread email, most important first.",
    triggers: [{ type: "manual" as const }],
    requiredCapabilities: [],
    expectedOutputs: [],
    requestedDelivery: [],
    defaultBehavior: {},
    recommendedPlugins: [],
    memoryTables: [],
    suggestedScope: "personal" as const,
    followUpQuestion: null,
    elicitation: null,
    ready: true,
  };
}

/**
 * An automation whose first turn is admitted and whose compiler run settled on
 * one ready definition — the state a person is in when they press Create.
 *
 * The compiler run is marked `completed` inside the same invocation that admits
 * it. `admitDraftTurn` arms a dispatch alarm for `now`, and the tests below go
 * on asserting from outside this callback: the patched `executeCompilerRun`
 * covers the window before the update lands, and the settled row is what makes
 * a drain on a fresh instance after eviction a no-op rather than a real
 * compiler run against the placeholder provider key.
 */
async function seedReadyDraft(definition: ReturnType<typeof readyDefinition>): Promise<void> {
  await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
    (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
    const admission = await instance.admitDraftTurn({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      authorUserId: AUTHOR_ID,
      region: "global",
      clientMessageId: CLIENT_MESSAGE_ID,
      content: "Summarize my unread email every weekday at 9am",
      attachmentIds: [],
      inputMode: "typed",
    });
    state.storage.sql.exec(
      `UPDATE automation_compiler_runs SET state = 'completed', settled_at = 1 WHERE run_id = ?`,
      admission.compilerRunId,
    );
    state.storage.sql.exec(
      `INSERT INTO automation_definition_revisions
         (definition_revision, compiler_run_id, definition_json, definition_hash, ready, created_at)
       VALUES (1, ?, ?, 'sha256:definition', 1, 1)`,
      admission.compilerRunId,
      JSON.stringify(definition),
    );
    state.storage.sql.exec(
      `UPDATE automation_state SET definition_revision = 1, title = ? WHERE id = 1`,
      definition.name,
    );
  });
}

/** The REST boundary, as the author of the seeded draft. */
function authorService(): AutomationAgentService {
  const testEnv: Env = env;
  return new AutomationAgentService(testEnv, {
    sessionId: "session-1",
    userId: AUTHOR_ID,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role: "member",
  });
}

/** Acceptance registers evaluators on WorkspaceDO, and an object that has never
 * been addressed refuses every caller with `workspace_object_identity_mismatch`.
 * Pinning the identity through the method that exists for it keeps an
 * acceptance assertion a real round trip rather than a patched `workspace()`. */
async function pinWorkspaceIdentity(): Promise<void> {
  await env.WORKSPACE_DOS
    .get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
}

describe("AutomationAgent", () => {
  it("persists identity, the first human turn, and one compiler admission before dispatch", async () => {
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
      const request = {
        schemaVersion: 1 as const,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global" as const,
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Tell me when a Slack message contains foobar",
        attachmentIds: [],
        inputMode: "typed" as const,
      };

      const first = await instance.admitDraftTurn(request);
      const retry = await instance.admitDraftTurn(request);

      expect(first.admitted).toBe(true);
      expect(retry).toEqual({ ...first, admitted: false });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM transcript_payloads`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_compiler_runs`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ author_user_id: string }>(
        `SELECT author_user_id FROM automation_identity WHERE id = 1`,
      ).one().author_user_id).toBe(AUTHOR_ID);
      expect(await state.storage.getAlarm()).not.toBeNull();

      await expect(instance.admitDraftTurn({
        ...request,
        clientMessageId: "00000000-0000-7000-8000-0000000000b5",
        content: "A second concurrent turn",
      })).rejects.toThrow("automation_compiler_busy");
    });
  });

  it("records evaluator replacement and receipt in the same object transaction", async () => {
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
      const admission = await instance.admitDraftTurn({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Watch Slack",
        attachmentIds: [],
        inputMode: "typed",
      });
      state.storage.sql.exec(
        `UPDATE automation_compiler_runs SET state = 'running' WHERE run_id = ?`,
        admission.compilerRunId,
      );
      const mutation = {
        schemaVersion: 1 as const,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        compilerRunId: admission.compilerRunId,
        providerCallId: "call-1",
        inputHash: "sha256:rules",
        evaluatorRules: { schemaVersion: 1, evaluators: [] },
      };

      expect(await instance.setEvaluatorRules(mutation)).toEqual({ accepted: true });
      expect(await instance.setEvaluatorRules(mutation)).toEqual({ accepted: true });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_tool_receipts`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ evaluator_rules_json: string }>(
        `SELECT evaluator_rules_json FROM automation_draft_evaluator_sets`,
      ).one().evaluator_rules_json).toBe('{"schemaVersion":1,"evaluators":[]}');
    });
  });

  it("accepts the canonical revision in place and deletes only the draft conversation", async () => {
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
      (instance as unknown as { workspace(): unknown }).workspace = async () => ({
        applyExternalEventRegistrations: async () => ({
          applied: true,
          effectiveAfterEventSequence: 7,
        }),
        applyAutomationProjection: async () => ({ applied: true }),
      });
      const admission = await instance.admitDraftTurn({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Run when I ask",
        attachmentIds: [],
        inputMode: "typed",
      });
      const definition = {
        name: "Manual helper",
        description: "Runs on request",
        overview: "A manual automation",
        instructions: "Do the requested work.",
        triggers: [{ type: "manual" as const }],
        requiredCapabilities: [],
        expectedOutputs: [],
        requestedDelivery: [],
        defaultBehavior: {},
        recommendedPlugins: [],
        memoryTables: [],
        suggestedScope: "personal" as const,
        followUpQuestion: null,
        elicitation: null,
        ready: true,
      };
      state.storage.sql.exec(
        `UPDATE automation_compiler_runs SET state = 'completed', settled_at = 1 WHERE run_id = ?`,
        admission.compilerRunId,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_definition_revisions
           (definition_revision, compiler_run_id, definition_json, definition_hash, ready, created_at)
         VALUES (1, ?, ?, 'sha256:definition', 1, 1)`,
        admission.compilerRunId,
        JSON.stringify(definition),
      );
      state.storage.sql.exec(
        `UPDATE automation_state SET definition_revision = 1, title = ? WHERE id = 1`,
        definition.name,
      );

      const detail = await instance.acceptDraft({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        definitionRevision: 1,
        scope: "personal",
        defaultPluginIds: [],
        activitySourcePluginIds: {},
        deliveryTargets: [],
        modelOverride: null,
      });

      expect(detail).toMatchObject({ id: AUTOMATION_ID, name: "Manual helper", status: "active" });
      expect(state.storage.sql.exec<{ lifecycle: string }>(
        `SELECT lifecycle FROM automation_state WHERE id = 1`,
      ).one().lifecycle).toBe("active");
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_definition_revisions`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ effective_after_event_sequence: number }>(
        `SELECT effective_after_event_sequence FROM automation_acceptance WHERE id = 1`,
      ).one().effective_after_event_sequence).toBe(7);

      const started = await instance.runNow({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
        idempotencyKey: "manual-overview-run",
      });
      const afterRun = await instance.readDetail({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
      });
      expect(afterRun.recentRuns).toEqual([expect.objectContaining({
        id: started.runId,
        workstreamId: started.workstreamId,
        triggerType: "manual",
        status: "scheduled",
      })]);
      await expect(instance.listRuns({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
      })).resolves.toEqual({ items: afterRun.recentRuns });
    });
  });

  it("owns generated-run memory behind a generation fence and replays write receipts", async () => {
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      const now = Date.now();
      const runId = "00000000-0000-7000-8000-0000000000c1";
      const harnessRunId = "00000000-0000-7000-8000-0000000000c2";
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region,
            authority_generation, created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID,
        WORKSPACE_ID,
        AUTHOR_ID,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Memory owner', 1, 1, 0, ?, ?)`,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, harness_run_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, created_at, updated_at)
         VALUES (?, 'manual:memory-test', 'manual', ?, ?, 'provisioned', 'running',
                 'pending', '{}', 1, ?, ?)`,
        runId,
        "00000000-0000-7000-8000-0000000000c3",
        harnessRunId,
        now,
        now,
      );
      const fence = {
        schemaVersion: 1 as const,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        harnessRunId,
        authorityGeneration: 1,
      };
      const add = {
        ...fence,
        operation: "add" as const,
        providerIdempotencyKey: "memory-call-1",
        args: {
          scopeKind: "automation",
          text: "The release channel is #shipping.",
          rationale: "Remember the canonical release destination.",
        },
      };

      const first = await instance.executeMemoryTool(add);
      const replay = await instance.executeMemoryTool(add);
      expect(replay).toEqual(first);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_items`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_mutations`,
      ).one().count).toBe(1);

      await expect(instance.executeMemoryTool({
        ...fence,
        operation: "search",
        args: { query: "release channel" },
      })).resolves.toMatchObject({
        output: { results: [{ text: "The release channel is #shipping." }] },
      });
      await expect(instance.executeMemoryTool({
        ...fence,
        authorityGeneration: 2,
        operation: "search",
        args: { query: "release" },
      })).rejects.toThrow("automation_memory_authority_fenced");
    });
  });

  it("answers a refusal from a real stub as the API's own error, not a 500", async () => {
    // Against a real Durable Object stub, deliberately. The mapping used to be
    // a `Proxy` around the stub, which every plain-object double in the tree
    // accepted and workerd did not: the trap handed the stub's own method the
    // proxy as its receiver, and an RPC's return value is a pipelining thenable
    // rather than a native `Promise`, so the branch attaching the mapping never
    // ran. Only a real stub can tell those apart.
    const testEnv: Env = env;
    const service = new AutomationAgentService(testEnv, {
      sessionId: "session-1",
      userId: AUTHOR_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "member",
    });

    // Nobody has opened this automation, so the object has no identity and
    // refuses with `automation_identity_missing` — a 404, not a server fault.
    await expect(service.detail(AUTOMATION_ID)).rejects.toMatchObject({
      status: 404,
      code: "automation_identity_missing",
    });
  });

  it("refuses a submitted draft that is not the definition the object stored", async () => {
    // Decided in `AutomationAgentService` before `acceptDraft` is called, so it
    // never reached `withAutomationErrors` and answered `500 internal_error` /
    // "An unexpected error occurred" — no next step for the person, at error
    // severity, under the one status a client backing off on 5xx retries.
    // A compiler turn settling while somebody reviews the summary is the
    // ordinary way in.
    const definition = readyDefinition("Weekday digest");
    await seedReadyDraft(definition);

    await expect(authorService().accept({
      draftId: AUTOMATION_ID,
      draft: { ...definition, description: "Summarize unread email every weekday, with links." },
      scope: "personal",
    })).rejects.toMatchObject({
      status: 409,
      code: "automation_definition_revision_stale",
      message: "This draft changed while you were reviewing it. Review the updated draft, then create it again.",
    });
  });

  it("refuses a create that names no draft", async () => {
    // The other refusal `accept` decides for itself, and the other bare throw.
    // Its own test because the assertion above aborts this file's `it` on
    // failure, so a single test would only ever prove whichever came first.
    const definition = readyDefinition("Weekday digest");
    await seedReadyDraft(definition);

    await expect(authorService().accept({ draft: definition, scope: "personal" }))
      .rejects.toMatchObject({
        status: 422,
        code: "automation_draft_id_required",
        message: "This automation has no draft to create from.",
      });
  });

  it("still accepts the draft the object actually holds", async () => {
    // The refusals are the boundary's, not a blanket rejection. Without this,
    // a comparison that refused everything would pass both tests above.
    const definition = readyDefinition("Weekday digest");
    await seedReadyDraft(definition);
    await pinWorkspaceIdentity();

    await expect(authorService().accept({
      draftId: AUTOMATION_ID,
      draft: definition,
      scope: "personal",
    })).resolves.toMatchObject({ id: AUTOMATION_ID, name: "Weekday digest", status: "active" });
  });

  it("answers a directory membership refusal as 403, not a 500 and not a conflict", async () => {
    // `list` reached WorkspaceDO outside `withAutomationErrors` for the same
    // reason `accept` did, so a member removed from the workspace between
    // `requireAuth`'s membership read and this one got 500. 403 rather than the
    // `SAFE_CODE` fallback's 409 is the point of the table row: 409 is the
    // status a client retries, and retrying is the one thing that never turns a
    // non-member into a member.
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id))`).run();
    // An active row for the author, so the refusal below is the membership
    // predicate deciding rather than an empty table. Without it the test
    // survives `if (true) throw new Error("automation_directory_access_denied")`.
    await env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status) VALUES (?, ?, 'active')`,
    ).bind(WORKSPACE_ID, AUTHOR_ID).run();
    await pinWorkspaceIdentity();

    const testEnv: Env = env;
    const member = {
      sessionId: "session-2",
      userId: AUTHOR_ID,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      role: "member" as const,
    };

    await expect(new AutomationAgentService(testEnv, member).list()).resolves.toEqual({ items: [] });
    await expect(new AutomationAgentService(testEnv, {
      ...member,
      userId: asUserId("00000000-0000-7000-8000-0000000000b9"),
    }).list()).rejects.toMatchObject({
      status: 403,
      code: "automation_directory_access_denied",
      message: "You do not have access to this workspace's automations.",
    });
  });

  it("answers an ApiError raised inside the object with its own status, not a 500", async () => {
    // The premise `withAutomationErrors` was built on — "a failure inside the
    // object is a bare `Error` whose message is a stable snake_case code" — is
    // true of the object's own refusals and false of the collaborators it calls
    // inside a request. `acceptDraft` reaches `WorkstreamEmailRoutingService`,
    // which throws `ApiError`; the live case is the 503 an EU region raises when
    // the Global address registry is unreachable, on every create.
    //
    // What this asserts is the outcome — the member gets the author's status and
    // code, never `500 internal_error`. It does not discriminate the mechanism:
    // this pool preserves the class across the hop, so it passes with
    // `apiErrorAcrossRpc` removed. That rebuild is for the boundary where the
    // class is lost, which nothing here can reproduce; the comment on it says
    // so rather than letting this test imply a proof it does not carry.
    const key = env.WORKSTREAM_EMAIL_ADDRESS_KEY;
    const signing = env.SESSION_SIGNING_KEY;
    // Short rather than absent: absent falls back to the signing key in a
    // non-production environment, and this has to reach the throw.
    (env as { WORKSTREAM_EMAIL_ADDRESS_KEY?: string }).WORKSTREAM_EMAIL_ADDRESS_KEY = "too-short";
    (env as { SESSION_SIGNING_KEY?: string }).SESSION_SIGNING_KEY = "";
    try {
      const definition = readyDefinition("Address-less automation");
      await seedReadyDraft(definition);
      await pinWorkspaceIdentity();
      // The seeded route row short-circuits the reservation before it reads the
      // key, so this test needs the automation to have no address yet.
      await env.DB.prepare(
        `DELETE FROM workstream_email_routes WHERE automation_subscription_id = ?`,
      ).bind(AUTOMATION_ID).run();

      await expect(authorService().accept({
        draftId: AUTOMATION_ID,
        draft: definition,
        scope: "personal",
      })).rejects.toMatchObject({
        status: 503,
        code: "workstream_email_key_invalid",
      });
    } finally {
      const restore = env as { WORKSTREAM_EMAIL_ADDRESS_KEY?: string | undefined; SESSION_SIGNING_KEY: string };
      restore.WORKSTREAM_EMAIL_ADDRESS_KEY = key;
      restore.SESSION_SIGNING_KEY = signing;
    }
  });

  it("refuses a create against a draft the compiler has not compiled yet", async () => {
    // `admitFirstTurn` answers with the automation's id as soon as the turn is
    // durable, so a caller can reach `accept` before any definition revision
    // exists. `AutomationDraftSchema.parse(null)` threw a `ZodError` from
    // between the two refusals this change fixed, which is the same 500 by
    // another route.
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent) => {
      (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
      await instance.admitDraftTurn({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Watch the release channel",
        attachmentIds: [],
        inputMode: "typed",
      });
    });

    await expect(authorService().accept({
      draftId: AUTOMATION_ID,
      draft: {
        name: "Not compiled yet",
        description: "Nothing has been compiled for this draft.",
        overview: "Nothing has been compiled for this draft.",
        instructions: "Nothing has been compiled for this draft.",
        triggers: [{ type: "manual" as const }],
        suggestedScope: "personal" as const,
        followUpQuestion: null,
        ready: true,
      },
      scope: "personal",
    })).rejects.toMatchObject({
      status: 409,
      code: "automation_definition_not_ready",
    });
  });

  it("tells a reader why an imported automation with an unrunnable trigger is stopped", async () => {
    // The one thing a person has to be told after the cutover: this automation
    // is not waiting for its next run, it has none. The reason travels on the
    // detail the screen reads and on every projection the sidebar reads, or the
    // person is left with a red dot and no sentence.
    const source = {
      definition: {
        name: "Release watcher",
        description: "Summarizes a watched release document when it changes",
        overview: "Watches one document",
        instructions: "Summarize what changed.",
        triggers: [{ type: "resource_watch" as const, resourceId: "00000000-0000-7000-8000-0000000000d1" }],
        requiredCapabilities: [],
        expectedOutputs: [],
        requestedDelivery: [],
        defaultBehavior: {},
        recommendedPlugins: [],
        memoryTables: [],
        suggestedScope: "personal" as const,
        followUpQuestion: null,
        elicitation: null,
        ready: true,
      },
      status: "active" as const,
      scope: "personal" as const,
      unsupportedTrigger: true,
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      connectorBindings: {},
      deliveryTargets: [],
      emailAddress: null,
      modelOverride: null,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_001,
      schedules: [],
      runs: [],
      memoryRecords: [],
    };
    const sourceHash = await sha256(canonicalTranscriptJson(source));

    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      (instance as unknown as { workspace(): unknown }).workspace = async () => ({
        applyExternalEventRegistrations: async () => ({ applied: true, effectiveAfterEventSequence: 0 }),
        applyAutomationProjection: async () => ({ applied: true }),
      });

      await instance.importAcceptedAutomation({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        sourceHash,
        source,
      });

      const detail = await instance.readDetail({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
      });
      expect(detail).toMatchObject({ status: "paused", attention: "unsupported_trigger" });

      // Resuming does not make the trigger expressible, and it is the moment
      // the directory's copy of the reason used to be overwritten with "nothing
      // is wrong" — leaving the sidebar marker to disappear off a button press
      // while this object still says the automation cannot run.
      await instance.resume({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
      });
      const projected = state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM automation_outbox
          WHERE effect_kind = 'workspace_projection' ORDER BY created_at DESC LIMIT 1`,
      ).one();
      expect(JSON.parse(projected.payload_json)).toMatchObject({
        lifecycle: "active",
        attentionCode: "unsupported_trigger",
      });
    });
  });

  it("records a durable-table write instead of failing its own constraint", async () => {
    const now = 1_800_000_000_000;
    const runId = "00000000-0000-7000-8000-0000000000d1";
    const harnessRunId = "00000000-0000-7000-8000-0000000000d2";
    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      (instance as unknown as {
        ensureIdentity(input: unknown): void;
      }).ensureIdentity = () => {};
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Table owner', 1, 1, 0, ?, ?)`,
        now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, harness_run_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, created_at, updated_at)
         VALUES (?, 'manual:table-test', 'manual', ?, ?, 'provisioned', 'running',
                 'pending', '{}', 1, ?, ?)`,
        runId, "00000000-0000-7000-8000-0000000000d3", harnessRunId, now, now,
      );

      // `table_create` — not `create`. The mutation ledger's own CHECK used to
      // list the unprefixed names, so this write rolled its transaction back
      // and took the table the model had just created with it.
      const created = await instance.executeMemoryTool({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        harnessRunId,
        authorityGeneration: 1,
        operation: "table_create",
        providerIdempotencyKey: "table-call-1",
        args: {
          scopeKind: "automation",
          rationale: "Track what has shipped.",
          name: "Releases",
          description: "One row per shipped release.",
          usageInstructions: "Look a release up by its tag.",
          columns: [{ name: "tag", description: "The release tag.", type: "string", required: true, searchable: false }],
          keyColumns: ["tag"],
        },
      });

      expect(created).toBeTruthy();
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_tables`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ operation: string }>(
        `SELECT operation FROM automation_memory_mutations ORDER BY settled_at DESC LIMIT 1`,
      ).one().operation).toBe("table_create");
    });
  });

  it("answers a follow-up question so the draft can still be accepted", async () => {
    const now = 1_800_000_000_000;
    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
      const first = await instance.admitDraftTurn({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Watch the release channel",
        attachmentIds: [],
        inputMode: "typed",
      });
      // Stand in for a compiler run that asked a question rather than
      // finishing: one revision, one pending elicitation against it.
      state.storage.sql.exec(
        `INSERT INTO automation_definition_revisions
           (definition_revision, compiler_run_id, definition_json, definition_hash, ready, created_at)
         VALUES (1, ?, '{}', 'sha256:draft', 0, ?)`,
        first.compilerRunId, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_pending_elicitations
           (elicitation_id, definition_revision, payload_json, state, created_at)
         VALUES ('00000000-0000-7000-8000-0000000000e1', 1, '{"question":"Which channel?"}', 'pending', ?)`,
        now,
      );
      state.storage.sql.exec(
        `UPDATE automation_compiler_runs SET state = 'needs_input', settled_at = ? WHERE run_id = ?`,
        now, first.compilerRunId,
      );

      await instance.admitDraftTurn({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        clientMessageId: "00000000-0000-7000-8000-0000000000e2",
        content: "#shipping",
        attachmentIds: [],
        inputMode: "elicitation_response",
      });

      // The person answered, so nothing is outstanding — which is what
      // `acceptDraft` reads before it will create the automation at all.
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_pending_elicitations WHERE state = 'pending'`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ state: string }>(
        `SELECT state FROM automation_pending_elicitations`,
      ).one().state).toBe("answered");
    });
  });

  it("does not let a later work-stream state reopen a finished run", async () => {
    const now = 1_800_000_000_000;
    const runId = "00000000-0000-7000-8000-000000000a01";
    const workstreamId = "00000000-0000-7000-8000-000000000a02";
    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Run owner', 1, 1, 0, ?, ?)`,
        now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, workstream_generation,
            harness_run_id, admission_state, execution_state, delivery_state, context_json,
            source_version, created_at, updated_at)
         VALUES (?, 'manual:terminal', 'manual', ?, 1, ?, 'provisioned', 'completed',
                 'pending', '{}', 5, ?, ?)`,
        runId, workstreamId, "00000000-0000-7000-8000-000000000a03", now, now,
      );

      const project = (sourceVersion: number, projectedState: string) => instance.applyRunProjection({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        workstreamId,
        workstreamGeneration: 1,
        sourceVersion,
        payloadHash: `sha256:${projectedState}`,
        state: projectedState,
        completedAt: null,
      });

      // A stop settles the work stream as `idle`, and a member replying on the
      // same stream starts another loop whose first envelope is `scheduled`.
      // Both arrive after the run finished and both used to map to `running`.
      await project(6, "idle");
      expect(state.storage.sql.exec<{ execution_state: string }>(
        `SELECT execution_state FROM automation_runs WHERE run_id = ?`, runId,
      ).one().execution_state).toBe("completed");

      await project(7, "scheduled");
      const settled = state.storage.sql.exec<{ execution_state: string; source_version: number }>(
        `SELECT execution_state, source_version FROM automation_runs WHERE run_id = ?`, runId,
      ).one();
      expect(settled.execution_state).toBe("completed");
      // Still acknowledged: the sender has nothing to retry.
      expect(settled.source_version).toBe(7);
    });
  });

  it("recognises a memory row carried through the cutover instead of duplicating it", async () => {
    const now = 1_800_000_000_000;
    const runId = "00000000-0000-7000-8000-0000000000f1";
    const harnessRunId = "00000000-0000-7000-8000-0000000000f2";
    const legacyTableId = "00000000-0000-7000-8000-0000000000f4";
    const legacyColumnId = "00000000-0000-7000-8000-0000000000f5";
    // What the legacy memory-table service stored: `[name, value]` pairs.
    const naturalKeyHash = await sha256(canonicalTranscriptJson([["tag", "v1.0.0"]]));

    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Imported memory', 1, 1, 0, ?, ?)`,
        now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, harness_run_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, created_at, updated_at)
         VALUES (?, 'manual:import', 'manual', ?, ?, 'provisioned', 'running',
                 'pending', '{}', 1, ?, ?)`,
        runId, "00000000-0000-7000-8000-0000000000f3", harnessRunId, now, now,
      );

      importLegacyAutomationMemory(state.storage, AUTOMATION_ID, [], [
        {
          kind: "table",
          recordId: legacyTableId,
          payload: {
            memory_table_id: legacyTableId,
            name: "Releases",
            description: "One row per shipped release.",
            usage_instructions: "Look a release up by its tag.",
            key_column_ids_json: JSON.stringify([legacyColumnId]),
            schema_revision: 1,
            data_revision: 1,
          },
        },
        {
          kind: "table_column",
          recordId: legacyColumnId,
          payload: {
            memory_table_column_id: legacyColumnId,
            memory_table_id: legacyTableId,
            name: "tag",
            description: "The release tag.",
            value_type: "string",
            is_required: 1,
            is_searchable: 0,
            position: 0,
          },
        },
        {
          kind: "table_row",
          recordId: "00000000-0000-7000-8000-0000000000f6",
          payload: {
            memory_table_row_id: "00000000-0000-7000-8000-0000000000f6",
            memory_table_id: legacyTableId,
            natural_key_hash: naturalKeyHash,
            data_json: JSON.stringify({ tag: "v1.0.0" }),
            revision: 1,
          },
        },
      ], now);

      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_rows`,
      ).one().count).toBe(1);

      // The same natural key the legacy runtime already recorded. Before the
      // imported row carried its natural-key identity this wrote a second row,
      // because the write path looks for `${table}:row:${hash}` and the import
      // had kept the legacy UUID.
      await instance.executeMemoryTool({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        harnessRunId,
        authorityGeneration: 1,
        operation: "table_insert_rows",
        providerIdempotencyKey: "insert-call-1",
        args: {
          rationale: "Record the release again.",
          memoryTableId: legacyTableId,
          rows: [{ tag: "v1.0.0" }],
        },
      });

      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_rows`,
      ).one().count).toBe(1);
    });
  });

  it("keeps a memory table's identity when a later revision adds one ahead of it", async () => {
    const table = (name: string) => ({
      name,
      description: `Rows about ${name}.`,
      usageInstructions: `Look up ${name} by key.`,
      columns: [{ name: "key", description: "The natural key.", type: "string", required: true, searchable: false }],
      keyColumns: ["key"],
    });
    await runInDurableObject(automationStub(), async (_instance: AutomationAgent, state) => {
      const materialize = (definitions: unknown): void =>
        materializeAutomationMemoryDefinitions(state.storage, AUTOMATION_ID, definitions, 1_800_000_000_000);

      materialize([table("Releases")]);
      const before = state.storage.sql.exec<{ table_id: string; name: string }>(
        `SELECT table_id, name FROM automation_memory_tables`,
      ).toArray();

      // The compiler is free to emit the set in any order, and a later
      // revision that puts a new table first used to be handed the id the
      // surviving table already holds.
      materialize([table("Incidents"), table("Releases")]);

      const after = state.storage.sql.exec<{ table_id: string; name: string }>(
        `SELECT table_id, name FROM automation_memory_tables ORDER BY name`,
      ).toArray();
      expect(after.map((row) => row.name)).toEqual(["Incidents", "Releases"]);
      expect(new Set(after.map((row) => row.table_id)).size).toBe(2);
      expect(after.find((row) => row.name === "Releases")?.table_id)
        .toBe(before[0]?.table_id);
    });
  });

  describe("run disposition", () => {
    const now = 1_800_000_000_000;

    /** A settled occurrence with a frozen context, ready to be judged. */
    function seedRun(
      state: DurableObjectState,
      runId: string,
      options: { deliveryTargets?: unknown[]; disposition?: string } = {},
    ): void {
      const context = {
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        authorityGeneration: 1,
        definitionRevision: 1,
        definition: {
          name: "Pipeline watch",
          description: "Watches the pipeline sheet.",
          overview: "Watches the pipeline sheet and reports movement.",
          instructions: "Report what moved in the pipeline since the last run.",
          requiredCapabilities: [],
          expectedOutputs: [],
          defaultBehavior: {},
          recommendedPlugins: [],
          memoryTables: [],
        },
        defaultPluginIds: [],
        activitySourcePluginIds: {},
        connectorBindings: {},
        deliveryTargets: options.deliveryTargets ?? [
          { type: "email", emailAddress: "recruiter@example.com" },
        ],
        modelOverride: null,
        executionPrincipal: { type: "user", userId: AUTHOR_ID },
        trigger: { kind: "manual", requestedByUserId: AUTHOR_ID },
        opening: null,
        memoryScope: { automationId: AUTOMATION_ID, authorityGeneration: 1 },
      };
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, harness_run_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, disposition, disposition_source, disposition_reason,
            created_at, updated_at)
         VALUES (?, ?, 'manual', ?, ?, 'provisioned', 'completed', 'pending', ?, 1, ?, ?, ?, ?, ?)`,
        runId,
        `manual:${runId}`,
        `00000000-0000-7000-8000-0000000000${runId.slice(-2)}`,
        `00000000-0000-7000-8000-0000000001${runId.slice(-2)}`,
        JSON.stringify(context),
        options.disposition ?? null,
        options.disposition ? "classified" : null,
        options.disposition ? "An earlier judgement." : null,
        now,
        now,
      );
    }

    function seedIdentity(state: DurableObjectState): void {
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Pipeline watch', 1, 1, 0, ?, ?)`,
        now, now,
      );
    }

    it("keeps the first answer, so a delivery retry cannot judge one run twice", async () => {
      const runId = "00000000-0000-7000-8000-0000000000e1";
      await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
        seedIdentity(state);
        seedRun(state, runId, { disposition: "done" });

        const decision = await instance.resolveRunDisposition({
          schemaVersion: 1,
          automationId: AUTOMATION_ID,
          workspaceId: WORKSPACE_ID,
          runId,
          result: "The pipeline moved: two candidates reached final round.",
        });

        // Stored, not recomputed — the result text here would plainly be
        // delivered if this were a fresh judgement.
        expect(decision).toEqual({
          disposition: "done",
          reason: "An earlier judgement.",
          source: "classified",
        });
      });
    });

    it("delivers rather than withholding when the classifier cannot be reached", async () => {
      const runId = "00000000-0000-7000-8000-0000000000e2";
      await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
        seedIdentity(state);
        seedRun(state, runId);

        const decision = await instance.resolveRunDisposition({
          schemaVersion: 1,
          automationId: AUTOMATION_ID,
          workspaceId: WORKSPACE_ID,
          runId,
          result: "Two candidates reached final round.",
        });

        // No provider credentials in workerd here, so the inference fails and
        // the failure direction is what this proves: a result nobody can judge
        // is sent, not swallowed.
        expect(decision.disposition).toBe("deliver");
        expect(decision.source).toBe("default");
        expect(state.storage.sql.exec<{ disposition: string; disposition_source: string }>(
          `SELECT disposition, disposition_source FROM automation_runs WHERE run_id = ?`,
          runId,
        ).one()).toEqual({ disposition: "deliver", disposition_source: "default" });
      });
    });

    it("has nothing to decide, and spends nothing deciding it, with no destination", async () => {
      const runId = "00000000-0000-7000-8000-0000000000e3";
      await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
        seedIdentity(state);
        seedRun(state, runId, { deliveryTargets: [] });

        const decision = await instance.resolveRunDisposition({
          schemaVersion: 1,
          automationId: AUTOMATION_ID,
          workspaceId: WORKSPACE_ID,
          runId,
          result: "Two candidates reached final round.",
        });

        expect(decision.disposition).toBe("done");
        expect(decision.reason).toContain("no destination");
      });
    });

    it("refuses a run that is not this automation's", async () => {
      const runId = "00000000-0000-7000-8000-0000000000e4";
      await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
        seedIdentity(state);
        seedRun(state, runId);

        await expect(instance.resolveRunDisposition({
          schemaVersion: 1,
          automationId: AUTOMATION_ID,
          workspaceId: WORKSPACE_ID,
          runId: "00000000-0000-7000-8000-0000000000ff",
          result: "anything",
        })).rejects.toThrow("automation_run_not_found");
      });
    });
  });
});
