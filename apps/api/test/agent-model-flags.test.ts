import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HYPERSIGHT_MODEL, type Env } from "../src/env";
import type { AgentModelRouting } from "../src/services/agent-model-flags";
import {
  AGENT_MODEL_FLAG_KEYS,
  AGENT_MODEL_ROLES,
  defaultAgentModelRouting,
  resolveAgentModelRouting,
  scheduledWorkstreamModel,
} from "../src/services/agent-model-flags";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// APP_ENV production so the unreachable-binding path warns rather than staying
// quiet the way it does in development.
const baseEnv = {
  AVALON_REGION: "global",
  APP_ENV: "production",
  LOG_LEVEL: "error",
  OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
  OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash, anthropic/claude-sonnet-4.5",
  OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
  OPENROUTER_STRUCTURED_MODEL: "google/gemini-2.5-flash-lite",
  OPENROUTER_AUTOMATION_MODEL: "x-ai/grok-4.5",
} as unknown as Env;

type DetailsStub = (
  flagKey: string,
  defaultValue: AgentModelRouting,
  context?: FlagshipEvaluationContext,
) => Promise<Partial<FlagshipEvaluationDetails<unknown>>>;

/** Binds a `getObjectDetails` stub, the only Flagship method the resolver calls. */
function envWithFlags(getObjectDetails: DetailsStub): Env {
  return { ...baseEnv, FLAGS: { getObjectDetails } as unknown as Flagship };
}

/** A stub that serves `value` the way a provisioned, matching flag would. */
function serving(value: unknown, variant = "current"): DetailsStub {
  return async (flagKey) => ({ flagKey, value, variant, reason: "STATIC" });
}

/**
 * A workspace, its owner, and one work stream — enough for every attribute the
 * resolver adds to the evaluation context to have a fact behind it.
 */
function seededEnv(env: Env): { env: Env; close: () => void } {
  const database = migratedSqliteDatabase();
  const at = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
       VALUES (?1, 'google-1', 'ada@dogfood.example', 'Ada Lovelace', NULL, ?2, ?2)`,
    )
    .run("00000000-0000-4000-8000-000000000011", at);
  database
    .prepare(
      `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
       VALUES (?1, 'Dogfood', 'dogfood', 'global', ?2, ?3, ?3)`,
    )
    .run("ws-1", "00000000-0000-4000-8000-000000000011", at);
  database
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       VALUES (?1, ?2, 'owner', 'active', ?3)`,
    )
    .run("ws-1", "00000000-0000-4000-8000-000000000011", at);
  database
    .prepare(
      `INSERT INTO workstreams (
         id, workspace_id, title, objective, origin_type, created_by_user_id,
         automation_subscription_id, automation_run_id, planned_for, harness_status,
         next_sequence_number, last_activity_at, created_at, updated_at, archived_at
       ) VALUES (?1, ?2, 'Ship it', '', 'ad_hoc', ?3, NULL, NULL, NULL, 'idle', 1, ?4, ?4, ?4, NULL)`,
    )
    .run("wst-1", "ws-1", "00000000-0000-4000-8000-000000000011", at);
  return { env: { ...env, DB: sqliteD1(database) }, close: () => { database.close(); } };
}

describe("agent model flags", () => {
  beforeEach(() => {
    clearFlagTargetingAttributeCache();
  });

  it("gives every agent its own flag key", () => {
    const keys = AGENT_MODEL_ROLES.map((role) => AGENT_MODEL_FLAG_KEYS[role]);
    expect(new Set(keys).size).toBe(AGENT_MODEL_ROLES.length);
    expect(keys.every((key) => /^agent-model-[a-z-]+$/.test(key))).toBe(true);
  });

  it("defaults each agent to the OpenRouter models its Worker variables select", () => {
    expect(defaultAgentModelRouting(baseEnv, "workstream")).toEqual({
      model: "x-ai/grok-4.3",
      fallbackModels: ["google/gemini-3.6-flash", "anthropic/claude-sonnet-4.5"],
    });
    expect(defaultAgentModelRouting(baseEnv, "inline_child").model).toBe("x-ai/grok-4.3");
    expect(defaultAgentModelRouting(baseEnv, "meeting_notes").model).toBe("x-ai/grok-4.3");
    expect(defaultAgentModelRouting(baseEnv, "automation_compiler").model).toBe("x-ai/grok-4.5");
    expect(defaultAgentModelRouting(baseEnv, "addressing_classifier").model).toBe("google/gemini-2.5-flash-lite");
    expect(defaultAgentModelRouting(baseEnv, "activity_structured").model).toBe("google/gemini-2.5-flash-lite");
    expect(defaultAgentModelRouting(baseEnv, "hypersight")).toEqual({
      model: HYPERSIGHT_MODEL,
      fallbackModels: [],
    });
  });

  it("falls back to the Worker variables when no binding is attached", async () => {
    await expect(resolveAgentModelRouting(baseEnv, "workstream")).resolves.toEqual(
      defaultAgentModelRouting(baseEnv, "workstream"),
    );
  });

  it("evaluates each agent's own flag with the default as the evaluation fallback", async () => {
    const getObjectDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    const env = envWithFlags(getObjectDetails);

    await resolveAgentModelRouting(env, "automation_compiler", {
      workspaceId: "ws-1",
      workstreamId: "wst-1",
      userId: "usr-1",
    });

    expect(getObjectDetails).toHaveBeenCalledWith(
      "agent-model-automation-compiler",
      { model: "x-ai/grok-4.5", fallbackModels: ["google/gemini-3.6-flash", "anthropic/claude-sonnet-4.5"] },
      {
        agent: "automation_compiler",
        region: "global",
        appEnv: "production",
        workspaceId: "ws-1",
        workstreamId: "wst-1",
        userId: "usr-1",
      },
    );
  });

  // Identifiers alone target nothing a human can reason about: a rule has to be
  // able to say "the dogfooding workspace", "teams", "work streams a person
  // started" without anybody pasting a uuid into Flagship.
  it("describes the workspace, the person, and the work stream to targeting rules", async () => {
    const getObjectDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    const seeded = seededEnv(envWithFlags(getObjectDetails));

    await resolveAgentModelRouting(seeded.env, "workstream", {
      workspaceId: "ws-1",
      workstreamId: "wst-1",
      userId: "00000000-0000-4000-8000-000000000011",
    });

    expect(getObjectDetails.mock.calls[0]?.[2]).toEqual({
      agent: "workstream",
      region: "global",
      appEnv: "production",
      workspaceId: "ws-1",
      workstreamId: "wst-1",
      userId: "00000000-0000-4000-8000-000000000011",
      workspaceSlug: "dogfood",
      workspaceMemberCount: 1,
      workspaceAgeDays: 0,
      workspaceOwnerEmailDomain: "dogfood.example",
      userEmailDomain: "dogfood.example",
      userRole: "owner",
      workstreamOrigin: "ad_hoc",
      workstreamScope: "workspace",
      workstreamFromOpportunity: false,
      workstreamIsSystem: false,
      workstreamCreatedByUserId: "00000000-0000-4000-8000-000000000011",
      workstreamCreatorEmailDomain: "dogfood.example",
    });
    seeded.close();
  });

  // An attribute is a fact about the subject, never a redefinition of it: the
  // ids and the region are what bucketing and per-region staging depend on.
  it("keeps an attribute from shadowing the identity the evaluation buckets on", async () => {
    const getObjectDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    const seeded = seededEnv(envWithFlags(getObjectDetails));

    await resolveAgentModelRouting(seeded.env, "workstream", { workspaceId: "ws-1" });

    const sent = getObjectDetails.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(sent.workspaceId).toBe("ws-1");
    expect(sent.region).toBe("global");
    expect(sent.agent).toBe("workstream");
    seeded.close();
  });

  // The field answers "which facts did this evaluation actually have?", so the
  // identity keys — present on every evaluation — would only bury the answer.
  it("logs the loaded attributes it resolved on, not the identity every run sends", async () => {
    const debugged: string[] = [];
    const debug = vi.spyOn(console, "debug").mockImplementation((entry: unknown) => {
      debugged.push(JSON.stringify(entry));
    });
    const seeded = seededEnv({
      ...envWithFlags(serving({ model: "anthropic/claude-opus-4.6", fallbackModels: [] })),
      LOG_LEVEL: "debug",
    } as Env);

    await resolveAgentModelRouting(seeded.env, "workstream", { workspaceId: "ws-1" });

    const resolved = debugged.find((entry) => entry.includes("agent_model_flag_resolved"));
    const attributes = (JSON.parse(resolved ?? "{}") as { attributes?: string }).attributes ?? "";
    expect(attributes.split(",")).toEqual([
      "workspaceAgeDays",
      "workspaceMemberCount",
      "workspaceOwnerEmailDomain",
      "workspaceSlug",
    ]);
    debug.mockRestore();
    seeded.close();
  });

  it("uses the flag's OpenRouter model ids when the flag is served", async () => {
    const env = envWithFlags(serving({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    }));

    await expect(resolveAgentModelRouting(env, "workstream", { workspaceId: "ws-1" })).resolves.toEqual({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    });
  });

  // Deliberately a role whose default fallbacks are non-empty: on `hypersight`
  // this would pass even if the default's fallbacks were merged over the served
  // value, which is the half-applied plan the whole design exists to prevent.
  it("treats an omitted fallback list as no fallbacks rather than the variable's list", async () => {
    const env = envWithFlags(serving({ model: "anthropic/claude-opus-4.6" }));

    await expect(resolveAgentModelRouting(env, "workstream")).resolves.toEqual({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: [],
    });
    expect(defaultAgentModelRouting(env, "workstream").fallbackModels).not.toHaveLength(0);
  });

  it("drops fallbacks a flag tries to give HyperSight, keeping the retargeted model", async () => {
    const env = envWithFlags(serving({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    }));

    await expect(resolveAgentModelRouting(env, "hypersight")).resolves.toEqual({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: [],
    });
  });

  it("keeps the flag's fallbacks for every role that is allowed to route onward", async () => {
    const env = envWithFlags(serving({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    }));

    for (const role of AGENT_MODEL_ROLES.filter((candidate) => candidate !== "hypersight")) {
      await expect(resolveAgentModelRouting(env, role)).resolves.toEqual({
        model: "anthropic/claude-opus-4.6",
        fallbackModels: ["x-ai/grok-4.3"],
      });
    }
  });

  // A missing or mistyped key resolves the default rather than throwing, so
  // without reading `errorCode` a typo in AGENT_MODEL_FLAG_KEYS is
  // indistinguishable from a correctly provisioned flag.
  it("falls back and reports an error code rather than resolving a missing flag silently", async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((entry: unknown) => {
      warnings.push(JSON.stringify(entry));
    });
    // The shared fixture pins LOG_LEVEL to error to keep other cases silent.
    const env = { ...envWithFlags(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
      errorMessage: `flag ${flagKey} does not exist`,
    })), LOG_LEVEL: "warn" } as Env;

    await expect(resolveAgentModelRouting(env, "workstream", { workspaceId: "ws-1" })).resolves.toEqual(
      defaultAgentModelRouting(baseEnv, "workstream"),
    );
    expect(warnings.join()).toContain("agent_model_flag_unresolved");
    expect(warnings.join()).toContain("FLAG_NOT_FOUND");
    warn.mockRestore();
  });

  it("rejects a malformed flag value whole instead of applying half of it", async () => {
    const env = envWithFlags(serving({ model: "", fallbackModels: ["x-ai/grok-4.3"] }));

    await expect(resolveAgentModelRouting(env, "workstream")).resolves.toEqual(
      defaultAgentModelRouting(baseEnv, "workstream"),
    );
  });

  it("keeps the agent running on its Worker variables when evaluation throws", async () => {
    const env = envWithFlags(async () => {
      throw new Error("Binding FLAGS needs to be run remotely");
    });

    await expect(resolveAgentModelRouting(env, "meeting_notes")).resolves.toEqual(
      defaultAgentModelRouting(baseEnv, "meeting_notes"),
    );
  });

  // `wrangler deploy` rejects a flagship binding with no `app_id`, but a
  // dry-run build substitutes an inherit placeholder and passes — so neither CI
  // gate catches the omission and the failure would land mid-release, after the
  // remote D1 migrations have already applied.
  it.each(["wrangler.global.jsonc", "wrangler.eu.jsonc"])(
    "%s binds FLAGS to a Flagship app id",
    (fileName) => {
      const raw = readFileSync(new URL(`../${fileName}`, import.meta.url), "utf8");
      const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gmu, "")) as {
        flagship?: Array<{ binding: string; app_id?: string }>;
      };
      const binding = config.flagship?.find((entry) => entry.binding === "FLAGS");
      expect(binding).toBeDefined();
      expect(binding?.app_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    },
  );

  it("records the work-stream agent's flagged model on scheduled runs", async () => {
    const env = envWithFlags(serving({ model: "anthropic/claude-opus-4.6", fallbackModels: [] }));

    await expect(scheduledWorkstreamModel(env, { workspaceId: "ws-1" })).resolves.toBe(
      "anthropic/claude-opus-4.6",
    );
  });
});
