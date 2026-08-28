import { describe, expect, it } from "vitest";

import {
  AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS,
  AVALON_DISCOVERY_TOOL_DEFINITIONS,
  AVALON_SKILL_TOOL_DEFINITIONS,
  nonObjectRootUnionBranches,
  weakenedCompositionBranches,
} from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { __integrationTesting } from "../src/services/integrations";
import { TERMINAL_TOOL_DEFINITIONS } from "../src/services/terminal/contract";
import { createTestEnv } from "./helpers/cloudflare-test";
import { createTestConnectorRegistry, unconfiguredConnectorTypes } from "./helpers/connector-registry";

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
const workflowInput = (): WorkstreamWorkflowInput => ({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  workstreamId: "00000000-0000-4000-8000-000000000002",
  loopId: "workstream:00000000-0000-4000-8000-000000000002:substream:0:loop",
  harnessRunId: "00000000-0000-4000-8000-000000000003",
  region: "global",
  reason: "human_message",
  executionPrincipal: { type: "user", userId: "00000000-0000-4000-8000-000000000000" },
} as WorkstreamWorkflowInput);

/**
 * Every tool schema this repository authors, as `<surface>.<tool>` → schema.
 *
 * `FIRECRAWL_API_KEY` is set because `createFirecrawlWebTools` returns `[]`
 * without one, so an empty environment silently drops `web_search`/`web_fetch`
 * from a walk that claims to cover everything. The automation creator's four
 * tools and the HyperSight submission tool are added by hand for the same
 * reason: both are built against run state rather than registered, so nothing
 * that walks a registry can see them. `EXPECTED_TOOLS` below fails loudly if
 * any of these stop arriving, because a shrinking surface is exactly how this
 * guard would go quietly green while a tool regressed.
 */
const label = (definition: { capability: string; name: string }): string =>
  `${definition.capability}:${definition.name}`;

function everyAuthoredToolSchema(): { name: string; schema: Record<string, unknown> }[] {
  const env = createTestEnv({ FIRECRAWL_API_KEY: "test-firecrawl-key" });
  // Labelled `capability:name`, because neither alone is unique: the memory and
  // web plugins both export a tool called `search`, and `memory.write` covers
  // three. A failure has to name one tool unambiguously to be worth reading.
  const core = __integrationTesting.createAvalonTools(env, workflowInput())
    .map((tool) => ({ name: label(tool.definition), schema: tool.definition.inputSchema }));
  const discovery = [
    ...AVALON_DISCOVERY_TOOL_DEFINITIONS,
    ...AVALON_SKILL_TOOL_DEFINITIONS,
    ...AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS,
  ].map((definition) => ({ name: label(definition), schema: definition.inputSchema }));
  const blockDashboard = __integrationTesting
    .blockDashboardSubmissionPlugin({ markdown: null }, async () => undefined)
    .tools.map((tool) => ({ name: label(tool.definition), schema: tool.definition.inputSchema }));
  const terminal = TERMINAL_TOOL_DEFINITIONS
    .map((definition) => ({ name: `terminal.${definition.name}`, schema: definition.inputSchema }));
  const registry = createTestConnectorRegistry();
  const connectors = registry.list().flatMap((manifest) =>
    registry.get(manifest.type).agentPlugin.tools.map((definition) => ({
      name: `${manifest.type}.${definition.name}`,
      schema: definition.inputSchema,
    })));
  const walked = [...core, ...discovery, ...blockDashboard, ...terminal, ...connectors]
    .map((entry) => ({ name: entry.name, schema: entry.schema as Record<string, unknown> }));

  // Asserted here rather than in one `it`, so no check can run against a set
  // that quietly shrank. A conditional surface that stops being built fails
  // every assertion below it instead of passing all of them vacuously.
  const names = new Set(walked.map((entry) => entry.name));
  expect(EXPECTED_TOOLS.filter((name) => !names.has(name))).toEqual([]);
  expect(unconfiguredConnectorTypes(registry)).toEqual([]);
  expect(walked.length).toBeGreaterThan(60);
  return walked;
}

/**
 * Surfaces that are conditional, hand-assembled, or otherwise easy to drop out
 * of the walk without anyone noticing. A lower-bound count cannot catch that: a
 * missing conditional tool still leaves 60-odd others behind it.
 */
const EXPECTED_TOOLS = [
  "memory.search:search",
  "rally.plugins.list:list_plugins",
  "rally.skills.load:load_skill",
  "web.search:search",
  "web.fetch:fetch",
  "rally.automation.plugins.list:plugins_list",
  "rally.automation.submit:submit_draft",
  "rally.block-dashboard.submit:submit_block",
  "terminal.import_resource",
  "notion.create_comment",
  "x.get_user_timeline",
];

describe("tool schema sanitization", () => {
  it("walks every authored surface, including the conditional and hand-assembled ones", () => {
    // The completeness assertions live in `everyAuthoredToolSchema`; this names
    // the guarantee so a failure there reads as coverage rather than schema.
    expect(everyAuthoredToolSchema().length).toBeGreaterThan(60);
  });

  it("leaves no tool whose root union has a branch xAI cannot read as an object", () => {
    const rejected = everyAuthoredToolSchema().flatMap(({ name, schema }) =>
      nonObjectRootUnionBranches(schema).map((path) => `${name}: ${path}`));

    expect(rejected).toEqual([]);
  });

  it("leaves no tool with a composition branch the sanitizer strips a constraint from", () => {
    const weakened = everyAuthoredToolSchema().flatMap(({ name, schema }) =>
      weakenedCompositionBranches(schema).map((path) => `${name}: ${path}`));

    expect(weakened).toEqual([]);
  });
});

/**
 * The schemas Avalon does not author, and the only ones a build-time guard can
 * never see: a hosted MCP server's `inputSchema` arrives at run time and reaches
 * the model verbatim. The blast radius is worse than a first-party mistake,
 * because xAI rejects the whole request — one bad schema from one remote server
 * takes down a run's every other tool, Avalon's core tools included — and the
 * person who connected that server did nothing wrong.
 *
 * So the rule the guard above reports on is applied here as a repair, at
 * Avalon's own host-side gate over dynamic tools rather than inside a connector
 * adapter, and every dynamic source (Slack, Granola, Notion) funnels through it.
 */
describe("dynamic connector tool schemas", () => {
  const dynamicAdapter = () => {
    const registry = createTestConnectorRegistry();
    const adapter = registry.get("notion");
    const capability = adapter.dynamicAgentTools?.capabilities[0];
    if (!capability) throw new Error("expected Notion to declare a dynamic capability");
    return { adapter, capability };
  };

  const validate = (inputSchema: Record<string, unknown>) => {
    const { adapter, capability } = dynamicAdapter();
    return __integrationTesting.validateDynamicConnectorTools(
      createTestEnv({}),
      adapter,
      "personal",
      [capability],
      "notion",
      [{
        name: "remote_tool",
        description: "A tool served by a third-party MCP server.",
        capability,
        mode: "write",
        idempotency: "record_before_execute",
        inputSchema,
      }],
    )[0]!.inputSchema as Record<string, unknown>;
  };

  it("lets nothing a remote server serves reach the wire in a shape Grok rejects", () => {
    // Asserted as an outcome rather than a mechanism, because the mechanism has
    // already moved once. Under bind 11 and 12 this gate had to drop the
    // composition itself; under bind 13 it defers, because the sanitizer
    // repairs the shape into readable branches and *keeps* the constraint,
    // which dropping it would have thrown away. What must hold either way is
    // that the schema reaching the provider has no unreadable root branch.
    for (const remote of [
      // The ordinary "exactly one of these" idiom.
      {
        type: "object",
        properties: { pageId: { type: "string" }, discussionId: { type: "string" } },
        oneOf: [{ required: ["pageId"] }, { required: ["discussionId"] }],
      },
      // Annotation-only branches.
      {
        type: "object",
        properties: { a: { type: "string" } },
        anyOf: [{ description: "choose a" }, { description: "or not" }],
      },
      // A branch whose own `type` contradicts its `properties`.
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        oneOf: [
          { type: "string", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      },
      // A branch carrying its own composition.
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        oneOf: [
          { type: "object", anyOf: [{ properties: { a: { type: "string" } } }] },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      },
    ]) {
      expect(nonObjectRootUnionBranches(validate(remote))).toEqual([]);
    }
  });

  it("leaves a remote schema alone when its root union is already object-branched", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
        { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
      ],
    };

    expect(validate(schema)).toEqual(schema);
  });

  it("leaves an ordinary remote object schema untouched", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };

    expect(validate(schema)).toEqual(schema);
  });
});
