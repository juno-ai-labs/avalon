import { describe, expect, it, vi } from "vitest";
import { HYPERSIGHT_MODEL, type Env } from "../src/env";
import {
  AGENT_MODEL_FLAG_KEYS,
  AGENT_MODEL_ROLES,
  defaultAgentModelRouting,
  resolveAgentModelRouting,
  scheduledWorkstreamModel,
} from "../src/services/agent-model-flags";

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

function envWithFlags(getObjectValue: Flagship["getObjectValue"]): Env {
  return { ...baseEnv, FLAGS: { getObjectValue } as unknown as Flagship };
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
    const getObjectValue = vi.fn(async (_key: string, defaultValue: object) => defaultValue);
    const env = envWithFlags(getObjectValue as unknown as Flagship["getObjectValue"]);

    await resolveAgentModelRouting(env, "automation_compiler", {
      workspaceId: "ws-1",
      workstreamId: "wst-1",
      userId: "usr-1",
    });

    expect(getObjectValue).toHaveBeenCalledWith(
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
    const env = envWithFlags((async () => ({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    })) as unknown as Flagship["getObjectValue"]);

    await expect(resolveAgentModelRouting(env, "workstream", { workspaceId: "ws-1" })).resolves.toEqual({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: ["x-ai/grok-4.3"],
    });
  });

  it("treats an omitted fallback list as no fallbacks rather than the variable's list", async () => {
    const env = envWithFlags((async () => ({
      model: "anthropic/claude-opus-4.6",
    })) as unknown as Flagship["getObjectValue"]);

    await expect(resolveAgentModelRouting(env, "hypersight")).resolves.toEqual({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: [],
    });
  });

  it("rejects a malformed flag value whole instead of applying half of it", async () => {
    const env = envWithFlags((async () => ({
      model: "",
      fallbackModels: ["x-ai/grok-4.3"],
    })) as unknown as Flagship["getObjectValue"]);

    await expect(resolveAgentModelRouting(env, "workstream")).resolves.toEqual(
      defaultAgentModelRouting(baseEnv, "workstream"),
    );
  });

  it("keeps the agent running on its Worker variables when evaluation throws", async () => {
    const env = envWithFlags((async () => {
      throw new Error("flagship unavailable");
    }) as unknown as Flagship["getObjectValue"]);

    await expect(resolveAgentModelRouting(env, "meeting_notes")).resolves.toEqual(
      defaultAgentModelRouting(baseEnv, "meeting_notes"),
    );
  });

  it("records the work-stream agent's flagged model on scheduled runs", async () => {
    const env = envWithFlags((async () => ({
      model: "anthropic/claude-opus-4.6",
      fallbackModels: [],
    })) as unknown as Flagship["getObjectValue"]);

    await expect(scheduledWorkstreamModel(env, { workspaceId: "ws-1" })).resolves.toBe(
      "anthropic/claude-opus-4.6",
    );
  });
});
