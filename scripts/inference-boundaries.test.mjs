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
import { requireValidatedResponseRule } from "./eslint-rules/require-validated-response.mjs";

const rules = {
  "no-bare-zod-url": noBareZodUrlRule,
  "no-direct-model-env-read": noDirectModelEnvReadRule,
  "no-direct-openrouter-client": noDirectOpenRouterClientRule,
  "require-inference-diagnostics": requireInferenceDiagnosticsRule,
  "require-inference-signal": requireInferenceSignalRule,
  "require-validated-response": requireValidatedResponseRule,
  "require-websocket-ticket": requireWebSocketTicketRule,
};

function lint(source, enabled) {
  return new Linter({ configType: "flat" }).verify(source, {
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    plugins: { rally: { rules } },
    rules: { [`rally/${enabled}`]: "error" },
  });
}

test("rejects API-side OpenRouter client construction", () => {
  const messages = lint(`
    import { OpenRouterClient as Client } from "@rally/agent-harness";
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
  assert.equal(lint("client.embed({ input, signal, onDiagnostic });", "require-inference-signal").length, 0);
  assert.equal(lint("client.embed({ input, onDiagnostic });", "require-inference-signal").length, 1);
  assert.equal(lint("client.embed({ input, signal });", "require-inference-diagnostics").length, 1);
});

test("requires renderer WebSockets to consume an authenticated ticket URL", () => {
  assert.equal(lint(`
    const ticket = await api.getSocketTicket(id);
    const socket = new WebSocket(ticket.url);
  `, "require-websocket-ticket").length, 0);
  assert.equal(lint(`
    const workspaceTicket = await api.getWorkspaceSocketTicket();
    const commandSocket = new WebSocket(workspaceTicket.url, workspaceTicket.protocols);
  `, "require-websocket-ticket").length, 0);
  assert.equal(lint(`
    const workstreamTicket = await api.getWorkstreamControlSocketTicket(workstreamId);
    const metadataSocket = createRealtimeSocket('workstream_control', workstreamTicket.url, workstreamTicket.protocols);
  `, "require-websocket-ticket").length, 0);
  assert.equal(lint("const socket = new WebSocket(url);", "require-websocket-ticket").length, 1);
  assert.equal(lint(
    "const socket = createRealtimeSocket('substream_feed', url, protocols);",
    "require-websocket-ticket",
  ).length, 1);
  assert.equal(lint(`
    import { createRealtimeSocket as dial } from './realtime-socket';
    const socket = dial('substream_feed', url, protocols);
  `, "require-websocket-ticket").length, 1);
  assert.equal(lint(`
    import * as realtime from './realtime-socket';
    const socket = realtime.createRealtimeSocket('substream_feed', url, protocols);
  `, "require-websocket-ticket").length, 1);
  assert.equal(lint(`
    import { createRealtimeSocket as dial } from './realtime-socket';
    function safe(createRealtimeSocket) {
      return createRealtimeSocket('substream_feed', url, protocols);
    }
  `, "require-websocket-ticket").length, 0);
  assert.equal(lint(`
    const ticket = await api.getSocketTicket(id);
    function unsafe(ticket) {
      return new WebSocket(ticket.url);
    }
  `, "require-websocket-ticket").length, 1);
  assert.equal(lint(`
    const [ticket] = await Promise.all([api.getSocketTicket(id)]);
    function unsafe(ticket) {
      return createRealtimeSocket('substream_feed', ticket.url, protocols);
    }
  `, "require-websocket-ticket").length, 1);
});

test("follows immutable awaited ticket aliases without trusting shadowed or reassigned values", () => {
  assert.equal(lint(`
    const pending = api.getTranscriptionSocketTicket(signal);
    const ticket = await pending;
    new WebSocket(ticket.url, ticket.protocols);
  `, "require-websocket-ticket").length, 0);
  assert.equal(lint(`
    const pending = api.getTranscriptionSocketTicket();
    function unsafe(pending) {
      const ticket = pending;
      return new WebSocket(ticket.url);
    }
  `, "require-websocket-ticket").length, 1);
  assert.equal(lint(`
    let pending = api.getTranscriptionSocketTicket();
    pending = attackerControlled;
    const ticket = await pending;
    new WebSocket(ticket.url);
  `, "require-websocket-ticket").length, 1);
  assert.equal(lint(`
    const pending = api.getTranscriptionSocketTicket();
    let ticket = await pending;
    ticket = attackerControlled;
    new WebSocket(ticket.url);
  `, "require-websocket-ticket").length, 1);
});

test("rejects bare Zod URL validators but permits imported explicit contracts", () => {
  assert.equal(lint(`
    import { z } from "zod";
    const schema = z.string().url();
  `, "no-bare-zod-url").length, 1);
  assert.equal(lint(`
    import { HttpUrlSchema } from "@rally/contracts/url-schemas";
    const schema = HttpUrlSchema.optional();
  `, "no-bare-zod-url").length, 0);
});

test("rejects a route response that never meets its contract", () => {
  // The shape the desktop client would reject on arrival as `invalid_response`,
  // with nothing on the server naming the field or recording that it happened.
  const messages = lint(`
    routes.get("/", async (c) => c.json(await service.list()));
  `, "require-validated-response");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /contract schema/u);
});

test("rejects a parse that is not a contract's", () => {
  // `.parse` alone is not evidence of a contract — the chain has to be rooted
  // at a schema, or the rule passes on exactly the response it exists to catch.
  for (const source of [
    'routes.get("/", async (c) => c.json(JSON.parse(await service.raw())));',
    'routes.get("/", async (c) => c.json(parser.parse(await service.raw())));',
    // The context is named `context` in several handlers; a rule that only knew
    // `c` would hold by naming convention rather than by checking anything.
    'routes.get("/", async (context) => context.json(await service.list()));',
  ]) {
    assert.equal(lint(source, "require-validated-response").length, 1, source);
  }
});

test("accepts a parsed response and a body the route owns", () => {
  for (const source of [
    'routes.get("/", async (c) => c.json(PageSchema.parse(await service.list())));',
    'routes.get("/", async (c) => c.json(WorkstreamSchema.shape.scope.parse(value)));',
    'routes.get("/", async (c) => c.json(await AsyncPageSchema.parseAsync(value)));',
    'routes.post("/", async (c) => c.json({ ok: true }));',
    'routes.post("/", async (c) => c.json({ challenge: "" }, 200));',
    'routes.delete("/", async (c) => c.body(null, 204));',
    // Reading a body takes no argument, so it is not a response.
    'routes.get("/", async (c) => { const body = await response.json(); return c.json(PageSchema.parse(body)); });',
  ]) {
    assert.deepEqual(lint(source, "require-validated-response"), [], source);
  }
});

test("sees through an envelope built around unvalidated service output", () => {
  // `items` is the service's, not the route's, so the literal exemption must
  // not cover it.
  const messages = lint(`
    routes.get("/", async (c) => c.json({ items: await service.list() }));
  `, "require-validated-response");
  assert.equal(messages.length, 1);
});
