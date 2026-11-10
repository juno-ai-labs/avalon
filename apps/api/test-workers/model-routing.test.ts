import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { runStructuredInference } from "../src/services/structured-inference";

afterEach(() => vi.unstubAllGlobals());

it("leaves inference disabled until a workerd test opts into a provider double", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"accepted":true}' } }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(runStructuredInference(env, {
    role: "resource_naming", activity: "channel_naming", context: {},
    messages: [{ role: "user", content: "Name this" }],
    schemaName: "disabled_inference_test", jsonSchema: { type: "object" }, parse: (value) => value,
  })).rejects.toMatchObject({ code: "agent_model_disabled:OPENROUTER_FASTER_MODEL" });
  expect(fetcher).not.toHaveBeenCalled();
});
