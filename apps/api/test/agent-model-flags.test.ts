import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { AgentModelRouting } from "../src/services/agent-model-flags";
import {
  AGENT_MODEL_FLAG_KEYS,
  AGENT_MODEL_ROLES,
  agentModelOverride,
  conversationModelRole,
  defaultAgentModelRouting,
  resolveAgentModelRouting,
  resolveNewWorkstreamModelRouting,
  conversationModelContext,
  resolveWorkstreamModelRouting,
  scheduledWorkstreamModel,
} from "../src/services/agent-model-flags";
import type * as FlagTargetingModule from "../src/services/flag-targeting-attributes";
import type { FlagTargetingAttributes } from "../src/services/flag-targeting-attributes";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

/**
 * Lets one case serve attributes the real loader would never produce — a key
 * that collides with the run's identity — while every other case keeps the
 * loader that reads the seeded database.
 */
const servedAttributes = vi.hoisted(() => ({
  value: null as FlagTargetingAttributes | null,
  subjects: [] as Array<Record<string, string | undefined>>,
}));
vi.mock("../src/services/flag-targeting-attributes", async (importOriginal) => {
  const actual = await importOriginal<typeof FlagTargetingModule>();
  return {
    ...actual,
    loadFlagTargetingAttributes: async (env: Env, subject: Parameters<typeof actual.loadFlagTargetingAttributes>[1]) => {
      servedAttributes.subjects.push({ ...subject });
      return servedAttributes.value ?? actual.loadFlagTargetingAttributes(env, subject);
    },
  };
});

// APP_ENV production so the unreachable-binding path warns rather than staying
// quiet the way it does in development.
const baseEnv = createTestEnv({
  AVALON_REGION: "global",
  APP_ENV: "production",
  LOG_LEVEL: "error",
  OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
  OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash, anthropic/claude-sonnet-4.5",
  OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
  OPENROUTER_STRUCTURED_MODEL: "google/gemini-2.5-flash-lite",
});

type DetailsStub = (
  flagKey: string,
  defaultValue: AgentModelRouting,
  context?: FlagshipEvaluationContext,
) => Promise<Partial<FlagshipEvaluationDetails<unknown>>>;

/** Binds a `getObjectDetails` stub, the only Flagship method the resolver calls. */
function envWithFlags(getObjectDetails: DetailsStub): Env {
  return { ...baseEnv, FLAGS: createCloudflareTestBinding<Flagship>({ getObjectDetails }) };
}

/** A stub that serves `value` the way a provisioned, matching flag would. */
function serving(value: unknown, variant = "current"): DetailsStub {
  return async (flagKey) => ({ flagKey, value, variant, reason: "STATIC" });
}

const SEEDED_WORKSPACE_ID = "00000000-0000-4000-8000-000000000051";
const SEEDED_WORKSTREAM_ID = "00000000-0000-4000-8000-000000000052";

/**
 * A workspace, its owner, and one work stream — enough for every attribute the
 * resolver adds to the evaluation context to have a fact behind it.
 */
const openDatabases: DatabaseSync[] = [];

function seededEnv(env: Env, modelOverride: string | null = null): Env {
  const database = preRetirementProductSqliteDatabase();
  // Closed by `afterEach` rather than by the caller: a failing assertion throws
  // past any close at the end of a case and leaks the handle into the rest of
  // the file.
  openDatabases.push(database);
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
    .run(SEEDED_WORKSPACE_ID, "00000000-0000-4000-8000-000000000011", at);
  database
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       VALUES (?1, ?2, 'owner', 'active', ?3)`,
    )
    .run(SEEDED_WORKSPACE_ID, "00000000-0000-4000-8000-000000000011", at);
  // The work stream is its object's, not the region's: a targeting attribute
  // about it is read through its typed object authority. Seeded regionally,
  // the read finds nothing and the resolver reports a suppressed subject
  // rather than the facts this file is about.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workspaceId: SEEDED_WORKSPACE_ID,
    workstreamId: SEEDED_WORKSTREAM_ID,
    title: "Ship it",
    description: "",
    originType: "ad_hoc",
    createdByUserId: "00000000-0000-4000-8000-000000000011",
    scope: "workspace",
    modelOverride,
  }, Date.parse(at));
  return createTestEnv({
    ...env,
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, {
      objectStores: new Map([[SEEDED_WORKSTREAM_ID, objectStore]]),
    }),
  });
}

/**
 * The seeded work stream, pinned to `modelOverride`.
 *
 * Built on `seededEnv` rather than on a hand-written `prepare` stub so the
 * lookup runs against a real migrated schema: a query that lost its
 * `workspace_id` predicate, or bound its two identifiers in the wrong order,
 * fails here instead of being answered by a stub that ignores both.
 */
async function envWithOverride(env: Env, modelOverride: string | null): Promise<Env> {
  // Stated when the object is seeded, for the reason the doc comment gives:
  // the pin is the work stream object's column now, so a write that went
  // regional would be answered by a table the resolver no longer reads.
  return seededEnv(env, modelOverride);
}

describe("agent model flags", () => {
  beforeEach(() => {
    clearFlagTargetingAttributeCache();
    servedAttributes.value = null;
    servedAttributes.subjects = [];
  });

  afterEach(() => {
    while (openDatabases.length > 0) openDatabases.pop()?.close();
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
    expect(defaultAgentModelRouting(baseEnv, "workstream").model).toBe("x-ai/grok-4.3");
    expect(defaultAgentModelRouting(baseEnv, "workstream_naming").model).toBe("google/gemini-2.5-flash-lite");
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

    await resolveAgentModelRouting(env, "workstream_naming", {
      workspaceId: SEEDED_WORKSPACE_ID,
      workstreamId: SEEDED_WORKSTREAM_ID,
      userId: "usr-1",
    });

    expect(getObjectDetails).toHaveBeenCalledWith(
      "agent-model-workstream-naming",
      { model: "google/gemini-2.5-flash-lite", fallbackModels: ["google/gemini-3.6-flash", "anthropic/claude-sonnet-4.5"] },
      {
        agent: "workstream_naming",
        region: "global",
        appEnv: "production",
        workspaceId: SEEDED_WORKSPACE_ID,
        workstreamId: SEEDED_WORKSTREAM_ID,
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
    const env = seededEnv(envWithFlags(getObjectDetails));

    await resolveAgentModelRouting(env, "workstream", {
      workspaceId: SEEDED_WORKSPACE_ID,
      workstreamId: SEEDED_WORKSTREAM_ID,
      userId: "00000000-0000-4000-8000-000000000011",
    });

    expect(getObjectDetails.mock.calls[0]?.[2]).toEqual({
      agent: "workstream",
      region: "global",
      appEnv: "production",
      workspaceId: SEEDED_WORKSPACE_ID,
      workstreamId: SEEDED_WORKSTREAM_ID,
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
  });

  it("keeps a new work-stream id for bucketing without reading its preparing object", async () => {
    const getObjectDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    const env = seededEnv(envWithFlags(getObjectDetails));

    await resolveNewWorkstreamModelRouting(env, {
      workspaceId: SEEDED_WORKSPACE_ID,
      workstreamId: "wst-preparing",
    });

    expect(servedAttributes.subjects).toEqual([{ workspaceId: SEEDED_WORKSPACE_ID }]);
    expect(getObjectDetails.mock.calls[0]?.[2]).toEqual({
      agent: "workstream",
      region: "global",
      appEnv: "production",
      workspaceId: SEEDED_WORKSPACE_ID,
      workstreamId: "wst-preparing",
      workspaceSlug: "dogfood",
      workspaceMemberCount: 1,
      workspaceAgeDays: 0,
      workspaceOwnerEmailDomain: "dogfood.example",
    });
  });

  // An attribute is a fact about the subject, never a redefinition of it: the
  // ids and the region are what bucketing and per-region staging depend on.
  // Served deliberately colliding keys, because no attribute the real loader
  // emits is named like an identity field — without a collision this asserts
  // nothing about the spread order it exists to pin down.
  it("keeps an attribute from shadowing the identity the evaluation buckets on", async () => {
    const getObjectDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    servedAttributes.value = {
      workspaceId: "spoofed-workspace",
      workstreamId: "spoofed-workstream",
      userId: "spoofed-user",
      region: "enterprise",
      appEnv: "development",
      agent: "spoofed-agent",
    };

    await resolveAgentModelRouting(envWithFlags(getObjectDetails), "workstream", {
      workspaceId: SEEDED_WORKSPACE_ID,
      workstreamId: SEEDED_WORKSTREAM_ID,
      userId: "usr-1",
    });

    expect(getObjectDetails.mock.calls[0]?.[2]).toEqual({
      agent: "workstream",
      region: "global",
      appEnv: "production",
      workspaceId: SEEDED_WORKSPACE_ID,
      workstreamId: SEEDED_WORKSTREAM_ID,
      userId: "usr-1",
    });
  });

  // The field answers "which facts did this evaluation actually have?", so the
  // identity keys — present on every evaluation — would only bury the answer.
  it("logs the loaded attributes it resolved on, not the identity every run sends", async () => {
    const debugged: string[] = [];
    const debug = vi.spyOn(console, "debug").mockImplementation((entry: unknown) => {
      debugged.push(JSON.stringify(entry));
    });
    const env = seededEnv(createTestEnv({
      ...envWithFlags(serving({ model: "anthropic/claude-opus-4.6", fallbackModels: [] })),
      LOG_LEVEL: "debug",
    }));

    await resolveAgentModelRouting(env, "workstream", { workspaceId: SEEDED_WORKSPACE_ID });

    const resolved = debugged.find((entry) => entry.includes("agent_model_flag_resolved"));
    const attributes = (JSON.parse(resolved ?? "{}") as { attributes?: string }).attributes ?? "";
    expect(attributes.split(",")).toEqual([
      "workspaceAgeDays",
      "workspaceMemberCount",
      "workspaceOwnerEmailDomain",
      "workspaceSlug",
    ]);
    debug.mockRestore();
  });

  it("uses the flag's OpenRouter model ids when the flag is served", async () => {
    const env = envWithFlags(serving({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    }));

    await expect(resolveAgentModelRouting(env, "workstream", { workspaceId: SEEDED_WORKSPACE_ID })).resolves.toEqual({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    });
  });

  // Deliberately a role whose default fallbacks are non-empty: this would pass
  // even if the default's fallbacks were merged over the served
  // value, which is the half-applied plan the whole design exists to prevent.
  it("treats an omitted fallback list as no fallbacks rather than the variable's list", async () => {
    const env = envWithFlags(serving({ model: "anthropic/claude-opus-4.6" }));

    await expect(resolveAgentModelRouting(env, "workstream")).resolves.toEqual({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: [],
    });
    expect(defaultAgentModelRouting(env, "workstream").fallbackModels).not.toHaveLength(0);
  });

  it("keeps the flag's fallbacks for every role", async () => {
    const env = envWithFlags(serving({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    }));

    for (const role of AGENT_MODEL_ROLES) {
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
    const env = createTestEnv({ ...envWithFlags(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
      errorMessage: `flag ${flagKey} does not exist`,
    })), LOG_LEVEL: "warn" });

    await expect(resolveAgentModelRouting(env, "workstream", { workspaceId: SEEDED_WORKSPACE_ID })).resolves.toEqual(
      defaultAgentModelRouting(baseEnv, "workstream"),
    );
    expect(warnings.join()).toContain("agent_model_flag_unresolved");
    expect(warnings.join()).toContain("FLAG_NOT_FOUND");
    warn.mockRestore();
  });

  it("preserves reasoning effort from a model flag", async () => {
    const env = envWithFlags(serving({ model: "openai/gpt-6.1-sol", fallbackModels: [], reasoningEffort: "medium" }));
    await expect(resolveAgentModelRouting(env, "sidekick_authoring")).resolves.toEqual({
      model: "openai/gpt-6.1-sol", fallbackModels: [], reasoningEffort: "medium",
    });
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

    await expect(resolveAgentModelRouting(env, "workstream")).resolves.toEqual(
      defaultAgentModelRouting(baseEnv, "workstream"),
    );
  });

  it("records a scheduled new work stream's model without reading its uncommitted facts", async () => {
    const env = envWithFlags(serving({ model: "anthropic/claude-opus-4.6", fallbackModels: [] }));

    await expect(scheduledWorkstreamModel(env, {
      workspaceId: SEEDED_WORKSPACE_ID,
      workstreamId: "wst-scheduled",
    })).resolves.toBe(
      "anthropic/claude-opus-4.6",
    );
    expect(servedAttributes.subjects).toEqual([{ workspaceId: SEEDED_WORKSPACE_ID }]);
  });

  it("admits only the model ids a creator may choose from", () => {
    expect(agentModelOverride("openai/gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
    expect(agentModelOverride(null)).toBeNull();
    expect(agentModelOverride("")).toBeNull();
    // Not on the list: a model that has been retired from it, or anything a
    // direct database write could have put there.
    expect(agentModelOverride("anthropic/claude-opus-4.6")).toBeNull();
  });

  // A rollout reaching the workspace must not take a pinned work stream with it.
  it("runs a pinned work stream on its own model rather than the flag's", async () => {
    const flagged = envWithFlags(serving({
      model: "x-ai/grok-4.5",
      fallbackModels: ["google/gemini-3.6-flash"],
    }));
    const env = await envWithOverride(flagged, "deepseek/deepseek-v4-pro");

    // Routed by the caller, as production routes it: `resolveWorkstreamModelRouting`
    // reads `env.DB`, and the pin lives in the work stream's own object.
    await expect(resolveWorkstreamModelRouting(
      env,
      { workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID },
    ))
      .resolves.toEqual({ model: "deepseek/deepseek-v4-pro", fallbackModels: [] });
  });

  it("leaves an unpinned work stream to the flag", async () => {
    const flagged = envWithFlags(serving({
      model: "x-ai/grok-4.5",
      fallbackModels: ["google/gemini-3.6-flash"],
    }));
    const env = await envWithOverride(flagged, null);

    // Routed by the caller, as production routes it: `resolveWorkstreamModelRouting`
    // reads `env.DB`, and the pin lives in the work stream's own object.
    await expect(resolveWorkstreamModelRouting(
      env,
      { workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID },
    ))
      .resolves.toEqual({ model: "x-ai/grok-4.5", fallbackModels: ["google/gemini-3.6-flash"] });
  });

  it("gives the Sidekick wizard and the agents it starts the authoring role", () => {
    expect(conversationModelRole({ parentKind: "automation" })).toBe("sidekick_authoring");
    expect(conversationModelRole({ parentKind: "automation", substreamId: "0" })).toBe("sidekick_authoring");
    expect(conversationModelRole({ parentKind: "automation", substreamId: "agent", backgroundAgent: true })).toBe("sidekick_authoring");
    expect(conversationModelRole({ parentKind: "automation", substreamId: "activation" })).toBe("workstream");
    expect(conversationModelRole({ parentKind: "automation", substreamId: "worker", backgroundAgent: true,
      automationDelegation: { runId: "00000000-0000-7000-8000-000000000001", stopGeneration: 0 } })).toBe("workstream");
    expect(conversationModelRole({ parentKind: "canvas", substreamId: "0" })).toBe("workstream");
  });

  it("routes an unpinned wizard to Sol independently of the live thread flag", async () => {
    const env = await envWithOverride(envWithFlags(async (flagKey, defaultValue) => ({
      flagKey,
      value: flagKey === "agent-model-workstream"
        ? { model: "openai/gpt-5.6-terra", fallbackModels: [] }
        : defaultValue,
      reason: "STATIC",
    })), null);
    env.OPENROUTER_PRIMARY_MODEL = "openai/gpt-6.1-sol";
    env.OPENROUTER_FALLBACK_MODELS = "google/gemini-3.8-flash";
    const context = { workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID };

    await expect(resolveWorkstreamModelRouting(env, {
      ...context, parentKind: "automation", substreamId: "0",
    })).resolves.toEqual({ model: "openai/gpt-6.1-sol", fallbackModels: ["google/gemini-3.8-flash"] });
    // Routed as the harness routes it: the context is picked off the activation
    // by the one helper both the logged role and the resolved route read.
    const agent = { parentKind: "automation" as const, backgroundAgent: true as const };
    await expect(resolveWorkstreamModelRouting(env, { ...context, ...conversationModelContext(agent, "agent") }))
      .resolves.toEqual({ model: "openai/gpt-6.1-sol", fallbackModels: ["google/gemini-3.8-flash"] });
    const worker = { ...agent, automationDelegation: { runId: "00000000-0000-7000-8000-000000000001", stopGeneration: 0 } };
    await expect(resolveWorkstreamModelRouting(env, { ...context, ...conversationModelContext(worker, "worker") }))
      .resolves.toEqual({ model: "openai/gpt-5.6-terra", fallbackModels: [] });
    await expect(resolveWorkstreamModelRouting(env, {
      ...context, parentKind: "automation", substreamId: "activation",
    })).resolves.toEqual({ model: "openai/gpt-5.6-terra", fallbackModels: [] });
    await expect(resolveWorkstreamModelRouting(env, context)).resolves.toEqual({
      model: "openai/gpt-5.6-terra", fallbackModels: [],
    });
  });

  it("preserves an explicitly pinned wizard model over the authoring flag", async () => {
    const env = await envWithOverride(envWithFlags(serving({
      model: "openai/gpt-6.1-sol", fallbackModels: ["google/gemini-3.8-flash"],
    })), "openai/gpt-5.6-terra");

    await expect(resolveWorkstreamModelRouting(env, {
      workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID,
      parentKind: "automation", substreamId: "0",
    })).resolves.toEqual({ model: "openai/gpt-5.6-terra", fallbackModels: [] });
  });

  // Retiring a model from the list is a code change, not a migration, so the
  // rows still naming it have to resolve somewhere sensible.
  it("returns a work stream pinned to a model that has left the list to the flag", async () => {
    const flagged = envWithFlags(serving({ model: "x-ai/grok-4.5", fallbackModels: [] }));
    const env = await envWithOverride(flagged, "anthropic/claude-opus-4.6");

    // Routed by the caller, as production routes it: `resolveWorkstreamModelRouting`
    // reads `env.DB`, and the pin lives in the work stream's own object.
    await expect(resolveWorkstreamModelRouting(
      env,
      { workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID },
    ))
      .resolves.toEqual({ model: "x-ai/grok-4.5", fallbackModels: [] });
  });
});
