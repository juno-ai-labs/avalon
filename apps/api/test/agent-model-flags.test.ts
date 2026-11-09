import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { AgentModelRouting } from "../src/services/agent-model-flags";
import { agentModelOverride, conversationModelRole, defaultAgentModelRouting, resolveAgentModelRouting,
  resolveNewWorkstreamModelRouting, conversationModelContext, resolveWorkstreamModelRouting, scheduledWorkstreamModel,
} from "../src/services/agent-model-flags";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import { seedWorkstreamObjectRoot, testSubstreamAgentsBinding, testWorkstreamObjectStore } from "./helpers/durable-authority";

const baseEnv = createTestEnv({ APP_ENV: "production", AVALON_REGION: "global", LOG_LEVEL: "error",
  OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
  OPENROUTER_FALLBACK_MODEL: "google/gemini-3.6-flash, anthropic/claude-sonnet-4.5",
  OPENROUTER_FASTER_MODEL: "google/gemini-2.5-flash-lite",
});
function envWithRouting(routing: AgentModelRouting): Env {
  return { ...baseEnv, AGENT_MODEL_ROUTING_JSON: JSON.stringify({ workstream: routing, sidekick_wizard: routing, sidekick_run: routing }) };
}

const SEEDED_WORKSPACE_ID = "00000000-0000-4000-8000-000000000051";
const SEEDED_WORKSTREAM_ID = "00000000-0000-4000-8000-000000000052";

/**
 * A workspace, its owner, and one work stream for authoritative pin reads.
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
  // Pins live in the conversation's authoritative object store.
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

describe("local agent model configuration", () => {
  afterEach(() => { while (openDatabases.length) openDatabases.pop()?.close(); vi.restoreAllMocks(); });

  it.each([
    ["workstream", "openai/gpt-5.6-terra"], ["inline_child", "openai/gpt-5.6-terra"], ["memory_sweep", "openai/gpt-5.6-terra"],
    ["sidekick_wizard", "openai/gpt-6.1-sol"], ["sidekick_run", "openai/gpt-5.6-terra"], ["workstream_naming", "openai/gpt-5.6-terra"],
  ] as const)("uses the checked-in default for %s without environment setup", async (role, model) => {
    await expect(resolveAgentModelRouting(createTestEnv({}), role)).resolves.toEqual({ model, fallbackModels: ["google/gemini-3.8-flash"] });
  });

  it("supports the shared model environment variables and ordered fallbacks", () => {
    expect(defaultAgentModelRouting(baseEnv, "workstream")).toEqual({ model: "x-ai/grok-4.3", fallbackModels: ["google/gemini-3.6-flash", "anthropic/claude-sonnet-4.5"] });
    expect(defaultAgentModelRouting({ ...baseEnv, OPENROUTER_FALLBACK_MODEL: "" }, "workstream_naming")).toEqual({ model: "google/gemini-2.5-flash-lite", fallbackModels: [] });
  });

  it("overrides primary and smarter models independently", async () => {
    const env = createTestEnv({ OPENROUTER_PRIMARY_MODEL: "custom/primary", OPENROUTER_SMARTER_MODEL: "custom/smarter", OPENROUTER_FALLBACK_MODEL: "" });
    await expect(resolveAgentModelRouting(env, "workstream")).resolves.toEqual({ model: "custom/primary", fallbackModels: [] });
    await expect(resolveAgentModelRouting(env, "sidekick_run")).resolves.toEqual({ model: "custom/primary", fallbackModels: [] });
    await expect(resolveAgentModelRouting(env, "sidekick_wizard")).resolves.toEqual({ model: "custom/smarter", fallbackModels: [] });
  });

  it("selects the Sidekick run role before a scheduled conversation exists", async () => {
    const env = createTestEnv({ AGENT_MODEL_ROUTING_JSON: JSON.stringify({
      workstream: { model: "custom/canvas", fallbackModels: [] },
      sidekick_run: { model: "custom/sidekick", fallbackModels: [] },
    }) });
    await expect(scheduledWorkstreamModel(env, { workspaceId: "org", workstreamId: "sidekick" }, "sidekick_run"))
      .resolves.toBe("custom/sidekick");
  });

  it("applies a role's complete route including reasoning, without affecting other roles", async () => {
    const env = { ...baseEnv, AGENT_MODEL_ROUTING_JSON: JSON.stringify({ workstream: { model: "custom/model", reasoningEffort: "high" } }) };
    await expect(resolveAgentModelRouting(env, "workstream")).resolves.toEqual({ model: "custom/model", fallbackModels: [], reasoningEffort: "high" });
    await expect(resolveAgentModelRouting(env, "inline_child")).resolves.toEqual({ model: "x-ai/grok-4.3", fallbackModels: ["google/gemini-3.6-flash", "anthropic/claude-sonnet-4.5"] });
  });

  it.each(['{', '[]', 'null', '{"workstream":{"model":"custom/model","fallbackModels":"bad"}}'])("rejects malformed overrides atomically: %s", async (value) => {
    await expect(resolveAgentModelRouting({ ...baseEnv, AGENT_MODEL_ROUTING_JSON: value }, "workstream")).resolves.toEqual({ model: "x-ai/grok-4.3", fallbackModels: ["google/gemini-3.6-flash", "anthropic/claude-sonnet-4.5"] });
  });

  it("resolves a new or scheduled thread without reading an uncommitted object", async () => {
    const env = envWithRouting({ model: "custom/model", fallbackModels: [] });
    const context = { workspaceId: "org", workstreamId: "thread" };
    await expect(resolveNewWorkstreamModelRouting(env, context)).resolves.toEqual({ model: "custom/model", fallbackModels: [] });
    await expect(scheduledWorkstreamModel(env, context)).resolves.toBe("custom/model");
  });

  it("admits only the model ids a creator may choose from", () => {
    expect(agentModelOverride("openai/gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
    expect(agentModelOverride(null)).toBeNull();
    expect(agentModelOverride("")).toBeNull();
    // Not on the list: a model that has been retired from it, or anything a
    // direct database write could have put there.
    expect(agentModelOverride("anthropic/claude-opus-4.6")).toBeNull();
  });

  // A deployment configuration change must preserve conversation pins.
  it("runs a pinned work stream on its own model rather than the environment override", async () => {
    const flagged = envWithRouting({
      model: "x-ai/grok-4.5",
      fallbackModels: ["google/gemini-3.6-flash"],
    });
    const env = await envWithOverride(flagged, "deepseek/deepseek-v4-pro");

    // Routed by the caller, as production routes it: `resolveWorkstreamModelRouting`
    // reads the pin from the work stream's own object.
    await expect(resolveWorkstreamModelRouting(
      env,
      { workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID },
    ))
      .resolves.toEqual({ model: "deepseek/deepseek-v4-pro", fallbackModels: [] });
  });

  it("leaves an unpinned work stream to configuration", async () => {
    const flagged = envWithRouting({
      model: "x-ai/grok-4.5",
      fallbackModels: ["google/gemini-3.6-flash"],
    });
    const env = await envWithOverride(flagged, null);

    // Routed by the caller, as production routes it: `resolveWorkstreamModelRouting`
    // reads the pin from the work stream's own object.
    await expect(resolveWorkstreamModelRouting(
      env,
      { workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID },
    ))
      .resolves.toEqual({ model: "x-ai/grok-4.5", fallbackModels: ["google/gemini-3.6-flash"] });
  });

  it("separates wizard, Sidekick run, and Canvas roles", () => {
    expect(conversationModelRole({ parentKind: "automation" })).toBe("sidekick_wizard");
    expect(conversationModelRole({ parentKind: "automation", substreamId: "0" })).toBe("sidekick_wizard");
    expect(conversationModelRole({ parentKind: "automation", substreamId: "agent", backgroundAgent: true })).toBe("sidekick_wizard");
    expect(conversationModelRole({ parentKind: "automation", substreamId: "activation" })).toBe("sidekick_run");
    expect(conversationModelRole({ parentKind: "automation", substreamId: "worker", backgroundAgent: true,
      automationDelegation: { runId: "00000000-0000-7000-8000-000000000001", stopGeneration: 0 } })).toBe("sidekick_run");
    expect(conversationModelRole({ parentKind: "canvas", substreamId: "0" })).toBe("workstream");
  });

  it("routes the wizard and runs independently of the Canvas override", async () => {
    const env = await envWithOverride(createTestEnv({ ...baseEnv,
      AGENT_MODEL_ROUTING_JSON: JSON.stringify({
        workstream: { model: "x-ai/grok-4.5", fallbackModels: [] },
        sidekick_run: { model: "openai/gpt-5.6-terra", fallbackModels: [] },
      }),
    }), null);
    env.OPENROUTER_SMARTER_MODEL = "openai/gpt-6.1-sol";
    env.OPENROUTER_FALLBACK_MODEL = "google/gemini-3.8-flash";
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
      model: "x-ai/grok-4.5", fallbackModels: [],
    });
  });

  it("preserves an explicitly pinned wizard model over the wizard override", async () => {
    const env = await envWithOverride(envWithRouting({
      model: "openai/gpt-6.1-sol", fallbackModels: ["google/gemini-3.8-flash"],
    }), "openai/gpt-5.6-terra");

    await expect(resolveWorkstreamModelRouting(env, {
      workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID,
      parentKind: "automation", substreamId: "0",
    })).resolves.toEqual({ model: "openai/gpt-5.6-terra", fallbackModels: [] });
  });

  // Retiring a model from the list is a code change, not a migration, so the
  // rows still naming it have to resolve somewhere sensible.
  it("returns a work stream pinned to a model that has left the list to configuration", async () => {
    const flagged = envWithRouting({ model: "x-ai/grok-4.5", fallbackModels: [] });
    const env = await envWithOverride(flagged, "anthropic/claude-opus-4.6");

    // Routed by the caller, as production routes it: `resolveWorkstreamModelRouting`
    // reads the pin from the work stream's own object.
    await expect(resolveWorkstreamModelRouting(
      env,
      { workspaceId: SEEDED_WORKSPACE_ID, workstreamId: SEEDED_WORKSTREAM_ID },
    ))
      .resolves.toEqual({ model: "x-ai/grok-4.5", fallbackModels: [] });
  });
});
