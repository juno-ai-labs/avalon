import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HYPERSIGHT_MODEL, type Env } from "../src/env";
import type { AgentModelRouting } from "../src/services/agent-model-flags";
import {
  AGENT_MODEL_FLAG_KEYS,
  AGENT_MODEL_ROLES,
  defaultAgentModelRouting,
  resolveAgentModelRouting,
  scheduledWorkstreamModel,
} from "../src/services/agent-model-flags";

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

describe("agent model flags", () => {
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
