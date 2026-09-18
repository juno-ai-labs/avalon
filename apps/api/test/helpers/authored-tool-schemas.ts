import {
  AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS,
  AVALON_DISCOVERY_TOOL_DEFINITIONS,
  AVALON_SKILL_TOOL_DEFINITIONS,
} from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { __integrationTesting } from "../../src/services/integrations";
import { createAvalonMultimodalGenerationPlugin } from "../../src/services/multimodal-generation/plugin";
import { TERMINAL_TOOL_DEFINITIONS } from "../../src/services/terminal/contract";
import { createTestEnv } from "./cloudflare-test";
import { createTestConnectorRegistry, unconfiguredConnectorTypes } from "./connector-registry";

/**
 * The one enumeration of every tool schema this repository authors.
 *
 * Two suites walk this surface from different angles —
 * `tool-schema-sanitization.test.ts` asks what survives the trip to a provider,
 * `tool-schema-descriptions.test.ts` asks whether a model can tell what a
 * parameter is for — and a walk that quietly stops covering a surface passes
 * every assertion built on it. Keeping one reader is what stops the two from
 * drifting apart the way the cursor readers next door did.
 *
 * The completeness checks throw rather than assert, so a caller cannot forget
 * to make them: any suite that walks this gets them, in the same call that
 * hands over the schemas.
 *
 * **What it does not reach, said plainly rather than claimed away.** Two tools
 * are built against live run state rather than registered, and neither can be
 * constructed from a schema walk's fixtures: `run_subagent` needs an attempt
 * lease, an abort signal, and a run-authority snapshot, and `post_result` needs
 * a Sidekick run definition with an owning room. Standing those up here would
 * buy two schemas at the price of a guard that breaks whenever the run
 * machinery moves, which is a bad trade for a walk whose whole value is that it
 * keeps working untended. They are the boundary of "every authored tool", and
 * anything else missing from this walk is a defect in it — the multimodal
 * plugin was exactly that, and reached this list only after a review noticed.
 */
export interface AuthoredToolSchema {
  name: string;
  schema: Record<string, unknown>;
}

const workflowInput = (): WorkstreamWorkflowInput => ({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  parentKind: "workstream",
  parentId: "00000000-0000-4000-8000-000000000002",
  loopId: "workstream:00000000-0000-4000-8000-000000000002:substream:0:loop",
  harnessRunId: "00000000-0000-4000-8000-000000000003",
  region: "global",
  reason: "human_message",
  executionPrincipal: { type: "user", userId: "00000000-0000-4000-8000-000000000000" },
} as WorkstreamWorkflowInput);

/**
 * Surfaces that are conditional, hand-assembled, or otherwise easy to drop out
 * of the walk without anyone noticing. A lower-bound count cannot catch that: a
 * missing conditional tool still leaves 130-odd others behind it.
 */
export const EXPECTED_TOOLS = [
  "memory.search:search",
  "multimodal.generate:generate_image",
  "rally.plugins.list:list_plugins",
  "rally.skills.load:load_skill",
  "web.search:search",
  "web.fetch:fetch",
  "rally.sidekick.plugins.list:plugins_list",
  "rally.sidekick.submit:submit_draft",
  "terminal.import_resource",
  "notion.create_comment",
  "x.get_user_timeline",
];

/** The surface a tool belongs to, as the reports group them. */
export function toolSurface(name: string): string {
  return name.includes(".") ? name.slice(0, name.indexOf(".")) : name.slice(0, name.indexOf(":"));
}

const label = (definition: { capability: string; name: string }): string =>
  `${definition.capability}:${definition.name}`;

export function everyAuthoredToolSchema(): AuthoredToolSchema[] {
  // `FIRECRAWL_API_KEY` is set because `createFirecrawlWebTools` returns `[]`
  // without one, so an empty environment silently drops `web_search`/`web_fetch`
  // from a walk that claims to cover everything.
  const env = createTestEnv({
    FIRECRAWL_API_KEY: "test-firecrawl-key",
    CANVA_CONNECTOR_ENABLED: "true",
  });
  // Labelled `capability:name`, because neither alone is unique: the memory and
  // web plugins both export a tool called `search`, and `memory.write` covers
  // three. A failure has to name one tool unambiguously to be worth reading.
  const core = __integrationTesting.createAvalonTools(env, workflowInput())
    .map((tool) => ({ name: label(tool.definition), schema: tool.definition.inputSchema }));
  // The Sidekick creator's four tools are added by hand because they are
  // built against run state rather than registered, so nothing that walks a
  // registry can see them.
  const discovery = [
    ...AVALON_DISCOVERY_TOOL_DEFINITIONS,
    ...AVALON_SKILL_TOOL_DEFINITIONS,
    ...AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS,
  ].map((definition) => ({ name: label(definition), schema: definition.inputSchema }));
  const terminal = TERMINAL_TOOL_DEFINITIONS
    .map((definition) => ({ name: `terminal.${definition.name}`, schema: definition.inputSchema }));
  // Built by hand and with its credentials supplied, because the factory
  // returns `null` without the Azure inference pair — so an environment that
  // does not carry one drops three served tools out of a walk claiming to cover
  // everything, which is how they went unchecked until a review noticed. It is
  // the same conditional-surface trap `FIRECRAWL_API_KEY` is set for above, and
  // the `EXPECTED_TOOLS` sentinel is what stops it recurring quietly.
  const multimodalEnv = createTestEnv({
    AZURE_INFERENCE_ENDPOINT: "https://azure.test/inference",
    AZURE_INFERENCE_API_KEY: "test-azure-key",
  });
  const multimodal = (createAvalonMultimodalGenerationPlugin(multimodalEnv, workflowInput())?.tools ?? [])
    .map((tool) => ({ name: label(tool.definition), schema: tool.definition.inputSchema }));
  const registry = createTestConnectorRegistry();
  const connectors = registry.list().flatMap((manifest) =>
    registry.get(manifest.type).agentPlugin.tools.map((definition) => ({
      name: `${manifest.type}.${definition.name}`,
      schema: definition.inputSchema,
    })));
  const walked = [...core, ...discovery, ...terminal, ...multimodal, ...connectors]
    .map((entry) => ({ name: entry.name, schema: entry.schema as Record<string, unknown> }));

  // Thrown here rather than asserted in one `it`, so no check can run against a
  // set that quietly shrank. A conditional surface that stops being built fails
  // every assertion below it instead of passing all of them vacuously.
  const names = new Set(walked.map((entry) => entry.name));
  const missing = EXPECTED_TOOLS.filter((name) => !names.has(name));
  if (missing.length) throw new Error(`the tool walk no longer reaches: ${missing.join(", ")}`);
  const unconfigured = unconfiguredConnectorTypes(registry);
  if (unconfigured.length) throw new Error(`connectors missing test credentials: ${unconfigured.join(", ")}`);
  if (walked.length <= 60) throw new Error(`the tool walk reached only ${walked.length} tools`);
  return walked;
}
