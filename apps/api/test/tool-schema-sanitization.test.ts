import { describe, expect, it } from "vitest";

import {
  AVALON_DISCOVERY_TOOL_DEFINITIONS,
  AVALON_SKILL_TOOL_DEFINITIONS,
  emptiedCompositionBranches,
  nonObjectRootUnionBranches,
} from "@avalon/agent-harness";
import { createConnectorRegistry } from "@avalon/connectors";
import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import { __integrationTesting } from "../src/services/integrations";
import { TERMINAL_TOOL_DEFINITIONS } from "../src/services/terminal/contract";
import { createTestEnv } from "./helpers/cloudflare-test";

/**
 * Every authored tool schema, walked from the registries rather than listed by
 * hand, against the sanitizer that actually rewrites it on the way to the
 * provider.
 *
 * Two separate defects, both introduced by one line on `memory_search`:
 *
 *   oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }]
 *
 * **The fatal one.** A root-level union branch that xAI cannot read as an
 * object is a hard 400 covering the whole request, every tool — measured
 * against grok-4.3/4.5/4.6. For three days every x-ai call in the fleet failed:
 * default routes paid a dead round trip and fell back to Gemini, so the fleet
 * looked healthy, and a work stream pinned to Grok from the composer's model
 * picker had nowhere to fall back to and simply died. The sanitizer is not what
 * made it fatal — the *authored* branches fail identically, because a bare
 * `{ required: [...] }` is no more an object to xAI than the `{}` the sanitizer
 * leaves. Only the root matters; the same union nested under a property is
 * accepted by all nine models tested.
 *
 * **The silent one.** A tool schema is not what Avalon wrote — it is what Bind's
 * sanitizer emits. It prunes each branch's `required` against a `properties`
 * map those branches do not have, so what reached the wire was `oneOf: [{}, {}]`
 * and the constraint was gone on *every* provider, Gemini and OpenAI included.
 * They accept it without complaint and let the model send both parameters or
 * neither.
 *
 * Nothing caught either one, because the authored schema reads correctly and no
 * test had ever run one through the sanitizer. Walking the registries is what
 * makes this a standing guard rather than a snapshot: a tool added next year
 * fails here until its wire schema survives the trip, and it fails at
 * `pnpm test` rather than three days later in a payload log.
 */
const oauth = { clientId: "client", clientSecret: "secret", redirectUri: "https://api.example.com/callback" };
const registryConfig: Parameters<typeof createConnectorRegistry>[0] = {
  granola: { redirectUri: "https://api.example.com/callback" },
  google: oauth,
  github: {
    appId: "1",
    clientId: "Iv1.client-id",
    clientSecret: "secret",
    privateKey: `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\nAA==\n${["-----END", "PRIVATE KEY-----"].join(" ")}`,
    webhookSecret: "webhook",
    redirectUri: "https://api.example.com/callback",
  },
  linear: oauth,
  notion: oauth,
  slack: { ...oauth, signingSecret: "signing" },
  x: { apiKey: "key" },
};

const workflowInput = (): WorkstreamWorkflowInput => ({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  workstreamId: "00000000-0000-4000-8000-000000000002",
  harnessRunId: "00000000-0000-4000-8000-000000000003",
  region: "global",
  reason: "human_message",
  executionPrincipal: { type: "user", userId: "00000000-0000-4000-8000-000000000000" },
} as WorkstreamWorkflowInput);

/** Every tool schema this repository authors, as `<surface>.<tool>` → schema. */
function everyAuthoredToolSchema(): { name: string; schema: Record<string, unknown> }[] {
  const core = __integrationTesting.createAvalonTools(createTestEnv({}), workflowInput())
    .map((tool) => ({ name: `avalon.${tool.definition.name}`, schema: tool.definition.inputSchema }));
  const discovery = [...AVALON_DISCOVERY_TOOL_DEFINITIONS, ...AVALON_SKILL_TOOL_DEFINITIONS]
    .map((definition) => ({ name: `avalon.${definition.name}`, schema: definition.inputSchema }));
  const terminal = TERMINAL_TOOL_DEFINITIONS
    .map((definition) => ({ name: `terminal.${definition.name}`, schema: definition.inputSchema }));
  const registry = createConnectorRegistry(registryConfig);
  const connectors = registry.list().flatMap((manifest) =>
    registry.get(manifest.type).agentPlugin.tools.map((definition) => ({
      name: `${manifest.type}.${definition.name}`,
      schema: definition.inputSchema,
    })));
  return [...core, ...discovery, ...terminal, ...connectors]
    .map((entry) => ({ name: entry.name, schema: entry.schema as Record<string, unknown> }));
}

describe("tool schema sanitization", () => {
  it("leaves no tool whose root union has a branch xAI cannot read as an object", () => {
    const tools = everyAuthoredToolSchema();
    expect(tools.length).toBeGreaterThan(60);

    const rejected = tools.flatMap(({ name, schema }) =>
      nonObjectRootUnionBranches(schema).map((path) => `${name}: ${path}`));

    expect(rejected).toEqual([]);
  });

  it("leaves no tool with a composition branch the sanitizer empties", () => {
    const emptied = everyAuthoredToolSchema().flatMap(({ name, schema }) =>
      emptiedCompositionBranches(schema).map((path) => `${name}: ${path}`));

    expect(emptied).toEqual([]);
  });
});
