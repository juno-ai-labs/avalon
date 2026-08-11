import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import {
  noDirectModelEnvReadRule,
  noDirectOpenRouterClientRule,
  requireInferenceDiagnosticsRule,
  requireInferenceSignalRule,
  requireWebSocketTicketRule,
} from "./eslint-rules/inference-boundaries.mjs";
import { noBareZodUrlRule } from "./eslint-rules/no-bare-zod-url.mjs";

const rules = {
  "no-bare-zod-url": noBareZodUrlRule,
  "no-direct-model-env-read": noDirectModelEnvReadRule,
  "no-direct-openrouter-client": noDirectOpenRouterClientRule,
  "require-inference-diagnostics": requireInferenceDiagnosticsRule,
  "require-inference-signal": requireInferenceSignalRule,
  "require-websocket-ticket": requireWebSocketTicketRule,
};

function lint(source, enabled) {
  return new Linter({ configType: "flat" }).verify(source, {
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    plugins: { avalon: { rules } },
    rules: { [`avalon/${enabled}`]: "error" },
  });
}

test("rejects API-side OpenRouter client construction", () => {
  const messages = lint(`
    import { OpenRouterClient as Client } from "@avalon/agent-harness";
    const client = new Client(config);
  `, "no-direct-openrouter-client");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /runStructuredInference/u);
});

test("rejects model environment reads outside the resolver", () => {
  for (const source of [
    "const model = env.OPENROUTER_STRUCTURED_MODEL;",
    "const { OPENROUTER_STRUCTURED_MODEL } = env;",
    "const { OPENROUTER_STRUCTURED_MODEL: model } = env;",
  ]) {
    const messages = lint(source, "no-direct-model-env-read");
    assert.equal(messages.length, 1);
    assert.match(messages[0].message, /resolveAgentModelRouting/u);
  }
});

test("requires cancellation and diagnostics on inference calls", () => {
  assert.equal(lint("client.structured({ messages, signal, onDiagnostic });", "require-inference-signal").length, 0);
  assert.equal(lint("client.structured({ messages, signal, onDiagnostic });", "require-inference-diagnostics").length, 0);
  assert.equal(lint("client.structured({ messages, onDiagnostic });", "require-inference-signal").length, 1);
  assert.equal(lint("client.structured({ messages, signal });", "require-inference-diagnostics").length, 1);
  assert.equal(lint("client.stream({ messages });", "require-inference-signal").length, 1);
});

test("requires renderer WebSockets to consume an authenticated ticket URL", () => {
  assert.equal(lint(`
    const ticket = await api.getSocketTicket(id);
    const socket = new WebSocket(ticket.url);
  `, "require-websocket-ticket").length, 0);
  assert.equal(lint("const socket = new WebSocket(url);", "require-websocket-ticket").length, 1);
});

test("rejects bare Zod URL validators but permits imported explicit contracts", () => {
  assert.equal(lint(`
    import { z } from "zod";
    const schema = z.string().url();
  `, "no-bare-zod-url").length, 1);
  assert.equal(lint(`
    import { HttpUrlSchema } from "@avalon/contracts/url-schemas";
    const schema = HttpUrlSchema.optional();
  `, "no-bare-zod-url").length, 0);
});
