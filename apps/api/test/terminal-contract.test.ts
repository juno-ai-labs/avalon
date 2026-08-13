import { describe, expect, it } from "vitest";

import {
  TERMINAL_PLUGIN_SYSTEM_MESSAGE,
  TERMINAL_TOOL_NAMES,
  createTerminalPlugin,
  parseTerminalRegionConfiguration,
  type TerminalToolExecutors,
} from "../src/services/terminal/contract";

const expectedSystemMessage = "You have a Daytona terminal workspace with Bash, Python, JavaScript (Node.js), TypeScript, and SQLite. Use these tools when code is the clearest reliable way to calculate, transform data, analyze files, validate a repository, or create a graph, image, dataset, report, or archive. Prefer Bash for simple CLI/file pipelines, Python for analysis and generated artifacts, JavaScript/TypeScript for Node and web-shaped data, and SQLite for relational transforms. Supported installers are apt/dpkg, pip/uv, and npm/pnpm. Use `sudo apt-get` for system packages; do not install another runtime or manager, and report an unsupported requirement. Use `terminal_run_command` with `ls`, `find`, `rg --files`, and `rg` for discovery and search. For deliberate text changes, read first with `terminal_read_file` and use `terminal_edit_file` or `terminal_apply_patch`; use `terminal_write_file` only for intentional complete replacement. To create a durable artifact, write the final stable file beneath `$AVALON_RESOURCE_DIR`, then call `terminal_publish_resource` with a path relative to that directory. A nonzero command exit, timeout, cancellation, or output limit is a successful tool response whose `state` and `terminationReason` must be inspected; never infer success from the tool call alone. Tool availability does not require you to start a sandbox unless the task benefits from it.";

const executor = async () => ({ output: {}, summary: "test" });
const executors = {
  read_file: executor,
  edit_file: executor,
  write_file: executor,
  apply_patch: executor,
  run_command: executor,
  import_resource: executor,
  publish_resource: executor,
  publish_branch_and_pr: executor,
} satisfies TerminalToolExecutors;

describe("Terminal plugin contract", () => {
  it("freezes the approved identity, prompt, complete tool family, and policy", () => {
    const plugin = createTerminalPlugin(executors);

    expect(plugin).toMatchObject({
      canonicalId: "avalon:terminal",
      modelId: "avalon_terminal",
      shortWireName: "terminal",
      displayName: "Terminal",
      preload: false,
      explicit: false,
      systemMessage: expectedSystemMessage,
    });
    expect(TERMINAL_PLUGIN_SYSTEM_MESSAGE).toBe(expectedSystemMessage);
    expect(TERMINAL_TOOL_NAMES).toEqual([
      "read_file",
      "edit_file",
      "write_file",
      "apply_patch",
      "run_command",
      "import_resource",
      "publish_resource",
      "publish_branch_and_pr",
    ]);
    expect(plugin.tools.map((tool) => ({
      name: tool.definition.name,
      capability: tool.definition.capability,
      mode: tool.definition.mode,
      idempotency: tool.definition.idempotency,
      timeoutMs: tool.definition.timeoutMs,
      serial: tool.serial,
      additionalProperties: tool.definition.inputSchema.additionalProperties,
    }))).toEqual([
      { name: "read_file", capability: "terminal.file.read", mode: "read", idempotency: "safe", timeoutMs: 30_000, serial: true, additionalProperties: false },
      { name: "edit_file", capability: "terminal.file.write", mode: "write", idempotency: "record_before_execute", timeoutMs: 60_000, serial: true, additionalProperties: false },
      { name: "write_file", capability: "terminal.file.write", mode: "write", idempotency: "record_before_execute", timeoutMs: 60_000, serial: true, additionalProperties: false },
      { name: "apply_patch", capability: "terminal.file.write", mode: "write", idempotency: "record_before_execute", timeoutMs: 60_000, serial: true, additionalProperties: false },
      { name: "run_command", capability: "terminal.command.run", mode: "write", idempotency: "record_before_execute", timeoutMs: 930_000, serial: true, additionalProperties: false },
      { name: "import_resource", capability: "terminal.resource.import", mode: "write", idempotency: "record_before_execute", timeoutMs: 120_000, serial: true, additionalProperties: false },
      { name: "publish_resource", capability: "terminal.resource.publish", mode: "write", idempotency: "provider_key", timeoutMs: 120_000, serial: true, additionalProperties: false },
      { name: "publish_branch_and_pr", capability: "terminal.repository.publish", mode: "write", idempotency: "record_before_execute", timeoutMs: 180_000, serial: true, additionalProperties: false },
    ]);
  });

  it("degrades to unsupported unless the region is explicitly and fully configured", () => {
    expect(parseTerminalRegionConfiguration({})).toEqual({ capability: "unsupported" });
    expect(parseTerminalRegionConfiguration({
      TERMINAL_REGION_CAPABILITY: "supported",
    })).toEqual({ capability: "unsupported" });
    expect(parseTerminalRegionConfiguration({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-test-key",
      DAYTONA_API_URL: "not-a-url",
    })).toEqual({ capability: "unsupported" });
    expect(() => parseTerminalRegionConfiguration({
      TERMINAL_REGION_CAPABILITY: "sometimes",
    })).toThrow(/TERMINAL_REGION_CAPABILITY/u);
    expect(() => parseTerminalRegionConfiguration({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-test-key",
      DAYTONA_API_URL: "http://daytona.example.com/api",
      DAYTONA_TARGET: "us",
      DAYTONA_TERMINAL_SNAPSHOT: "snapshot",
    })).toThrow(/valid HTTPS URL/u);
    expect(parseTerminalRegionConfiguration({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-test-key",
      DAYTONA_API_URL: "https://app.daytona.io/api",
      DAYTONA_TARGET: "us",
      DAYTONA_TERMINAL_SNAPSHOT: "daytona-small",
      TERMINAL_EMERGENCY_DISABLED: "false",
    })).toEqual({
      capability: "supported",
      apiKey: "daytona-test-key",
      apiUrl: "https://app.daytona.io/api",
      target: "us",
      snapshot: "daytona-small",
      emergencyDisabled: false,
    });
  });
});
