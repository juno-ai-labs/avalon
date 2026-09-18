import { describe, expect, it } from "vitest";

import {
  AVALON_CORE_PLUGIN_ID,
  AVALON_MEMORY_PLUGIN_ID,
  AVALON_TABLES_PLUGIN_ID,
  type HarnessPlugin,
} from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { __integrationTesting } from "../src/services/integrations";
import { AgentCommunicationService } from "../src/services/agent-communication-service";
import { createAgentCommunicationPlugin } from "../src/services/agent-communication-plugin";
import { createAvalonMultimodalGenerationPlugin } from "../src/services/multimodal-generation/plugin";
import { createTerminalPlugin } from "../src/services/terminal/contract";
import type { TerminalToolExecutors } from "../src/services/terminal/contract";
import { createTestEnv } from "./helpers/cloudflare-test";

/**
 * A wire prefix is a namespace. The plugins below declare none, so their
 * canonical names are claimed globally and nothing is left to tell two of them
 * apart — and Bind's duplicate-wire-name check runs over core plugins only, so
 * two *loadable* unprefixed plugins claiming one name resolve to whichever
 * sorts first by canonical id, silently.
 *
 * This file is that missing check, written down. It fails when a plugin drops
 * its prefix onto a name another plugin already holds, and when the set of bare
 * names changes without somebody saying so.
 */
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

const automationRun = () => ({
  automationId: "00000000-0000-4000-8000-00000000000a",
  automationRunId: "00000000-0000-4000-8000-00000000000b",
  generation: 1,
}) as never;

const terminalExecutor = async () => ({ output: {}, summary: "test" });
const terminalExecutors = {
  read_file: terminalExecutor, edit_file: terminalExecutor, write_file: terminalExecutor,
  apply_patch: terminalExecutor, run_command: terminalExecutor,
  checkout_repository: terminalExecutor, import_resource: terminalExecutor,
  publish_resource: terminalExecutor, publish_branch_and_pr: terminalExecutor,
} satisfies TerminalToolExecutors;

/**
 * Every plugin a run can register that is buildable without a live Durable
 * Object. The connector plugins are deliberately absent: their prefix is per
 * *connection* (`google_1`, `google_2`) and can never be dropped.
 */
function allPlugins(): HarnessPlugin[] {
  // Several plugins build only when their provider is configured, so the keys
  // are supplied here: without them `allPlugins` silently returns a shorter
  // list and this file stops checking the names it exists to check.
  const env = createTestEnv({
    AZURE_INFERENCE_ENDPOINT: "https://example.invalid",
    AZURE_INFERENCE_API_KEY: "test-key",
    FIRECRAWL_API_KEY: "test-key",
  });
  const input = workflowInput();
  const tools = __integrationTesting.createAvalonTools(env, input);
  return [
    ...__integrationTesting.createWorkstreamCorePlugins(tools),
    __integrationTesting.createAvalonWorkstreamPlugin(tools),
    __integrationTesting.createAvalonWebPlugin(tools),
    createAgentCommunicationPlugin(new AgentCommunicationService(env, input), "role guidance"),
    createAvalonMultimodalGenerationPlugin(env, input),
    createTerminalPlugin(terminalExecutors),
    __integrationTesting.createAutomationPostResultPlugin(
      env,
      { ...input, automationRun: automationRun() },
      { owningWorkstreamId: "00000000-0000-4000-8000-000000000009" } as never,
    ),
  ].filter((plugin): plugin is HarnessPlugin => plugin !== null);
}

function plugin(canonicalId: string): HarnessPlugin {
  const found = allPlugins().find((candidate) => candidate.canonicalId === canonicalId);
  if (!found) throw new Error(`${canonicalId} is not registered`);
  return found;
}

function wireNames(target: HarnessPlugin): string[] {
  return target.tools
    .map((tool) => __integrationTesting.stableWireToolName(target.shortWireName ?? "", tool.definition.name))
    .sort();
}

describe("plugin wire names", () => {
  it("builds every plugin this file claims to cover", () => {
    // The collision check below is only as good as this list. A plugin that
    // returns null for a missing provider key would drop out of it silently.
    expect(allPlugins().map((target) => target.canonicalId).sort()).toEqual([
      "avalon:agents",
      "rally:core",
      "rally:memory",
      "rally:multimodal-generation",
      "rally:sidekick-result",
      "rally:tables",
      "rally:terminal",
      "rally:web",
      "rally:workstream",
    ]);
  });

  it("lets no two plugins claim the same bare name", () => {
    const claims = new Map<string, string[]>();
    for (const target of allPlugins()) {
      if ((target.shortWireName ?? "") !== "") continue;
      for (const name of wireNames(target)) {
        claims.set(name, [...(claims.get(name) ?? []), target.canonicalId]);
      }
    }
    const contested = [...claims.entries()].filter(([, owners]) => owners.length > 1);
    expect(contested, "two unprefixed plugins claim one wire name").toEqual([]);
  });

  it("pins the bare names the unprefixed plugins hold", () => {
    // Changing this list is the point at which somebody has to think about the
    // collision above, because nothing else will stop them.
    const bare = allPlugins()
      .filter((target) => (target.shortWireName ?? "") === "")
      .flatMap(wireNames)
      .sort();
    expect(bare).toEqual([
      "apply_patch",
      "cancel_wakeup",
      "checkout_repository",
      "create_sidekick",
      "current_time",
      "describe_artifact_data",
      "edit_file",
      "edit_image",
      "generate_audio",
      "generate_image",
      "get_connector_connection_state",
      "import_resource",
      "list_agents",
      "list_resources",
      "list_wakeups",
      "post_result",
      "publish_branch_and_pr",
      "publish_resource",
      "query_artifact_data",
      "read_file",
      "read_resource",
      "reply_to_message",
      "request_elicitation",
      "run_command",
      "schedule_wakeup",
      "search_resource",
      "send_message",
      "show_connector_connection",
      "sidekicks_list",
      "start_agent",
      "stop_agent",
      "summarize_resource",
      "view_resource",
      "write_file",
    ]);
  });

  it("names each tool in its own instructions by the wire name the model will call", () => {
    for (const target of allPlugins()) {
      const retired = target.canonicalId === AVALON_CORE_PLUGIN_ID ? "core_"
        : target.canonicalId === "avalon:agents" ? "agents_"
        : null;
      if (!retired) continue;
      for (const name of wireNames(target)) {
        expect(target.systemMessage ?? "", `${target.canonicalId} still says ${retired}${name}`)
          .not.toContain(`${retired}${name}`);
      }
    }
  });

  it("keeps the prefix where the canonical names are local verbs that collide", () => {
    const memory = plugin(AVALON_MEMORY_PLUGIN_ID);
    const tables = plugin(AVALON_TABLES_PLUGIN_ID);
    expect(memory.shortWireName).toBe("memory");
    expect(tables.shortWireName).toBe("table");

    // Why they keep it: unprefixed, both plugins advertise `search`, and Bind
    // rejects a duplicate always-active wire name outright. The rest reach the
    // model as bare verbs — `add`, `create`, `update` — which is the naming
    // `docs/agent-tools.md` exists to prevent.
    const canonical = [memory, tables].flatMap((target) =>
      target.tools.map((tool) => tool.definition.name));
    expect(new Set(canonical).size).toBeLessThan(canonical.length);
  });
});
