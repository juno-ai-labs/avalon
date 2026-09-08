import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  TERMINAL_PLUGIN_SYSTEM_MESSAGE,
  TERMINAL_TOOL_NAMES,
  createTerminalPlugin,
  parseTerminalRegionConfiguration,
  type TerminalToolExecutors,
} from "../src/services/terminal/contract";

const expectedSystemMessage = "You have a Linux sandbox with Bash, Python, JavaScript (Node.js), TypeScript, and SQLite. Use these tools when code is the clearest reliable way to calculate, transform data, analyze files, validate a repository, or create a graph, image, dataset, report, archive, or artifact. Prefer Bash for simple CLI/file pipelines, Python for analysis and generated artifacts, JavaScript/TypeScript for Node and web-shaped data, and SQLite for relational transforms. Supported installers are apt/dpkg, pip/uv, and npm/pnpm. Use `sudo apt-get` for system packages; do not install another runtime or manager, and report an unsupported requirement. Use `terminal_run_command` with `ls`, `find`, `rg --files`, and `rg` for discovery and search. To work in an authorized GitHub repository, choose the exact owner/name yourself and call `terminal_checkout_repository`; use GitHub repository search first when needed, and set `requiredRemoteAccess` to `full_access` when the task needs a git push or to open a pull request. Permissions are a durable ceiling: choosing `read_only` keeps the sandbox credential read-only even when connector policy permits full access. The checkout result's `remoteAccess` is the remote boundary: `read_only` allows local edits and commits but its credential cannot push with git or mutate GitHub; `full_access` provides a repository-scoped credential for ordinary `git` and `gh` commands. Before initial repository access Rally creates or restores `$AVALON_GIT_BRANCH` and switches to it. Later tools attempt to restore that branch; if an in-progress merge, rebase, bisect, or local edit prevents the switch, inspect and repair Git state before pushing. Stay on the prepared branch, commit normally, push only that branch, and create or update its pull request against `$AVALON_GIT_BASE_BRANCH`; do not push the default branch or another ref. For deliberate text changes, read the file first with `terminal_read_file` and use `terminal_edit_file` or `terminal_apply_patch` to edit the file; use `terminal_write_file` only for intentional complete replacement or for writing a new file. To create a durable artifact/file/document visible and readable to the user, write the final stable file beneath `$AVALON_RESOURCE_DIR`, then call `terminal_publish_resource` with a path relative to that directory. Publishing the same path again updates that same artifact rather than creating a second one, so revise an artifact by editing its file and republishing its path. A nonzero command exit, timeout, cancellation, or output limit is a failed tool response whose `state` and `terminationReason` must be inspected; never infer success from the tool call alone.";

const executor = async () => ({ output: {}, summary: "test" });
const executors = {
  read_file: executor,
  edit_file: executor,
  write_file: executor,
  apply_patch: executor,
  run_command: executor,
  checkout_repository: executor,
  import_resource: executor,
  publish_resource: executor,
  publish_branch_and_pr: executor,
} satisfies TerminalToolExecutors;

describe("Terminal plugin contract", () => {
  it("freezes the approved identity, prompt, complete tool family, and policy", () => {
    const plugin = createTerminalPlugin(executors);

    expect(plugin).toMatchObject({
      canonicalId: "rally:terminal",
      modelId: "rally_terminal",
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
      "checkout_repository",
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
      { name: "read_file", capability: "terminal.file.read", mode: "read", idempotency: "safe", timeoutMs: 150_000, serial: true, additionalProperties: false },
      { name: "edit_file", capability: "terminal.file.write", mode: "write", idempotency: "record_before_execute", timeoutMs: 180_000, serial: true, additionalProperties: false },
      { name: "write_file", capability: "terminal.file.write", mode: "write", idempotency: "record_before_execute", timeoutMs: 180_000, serial: true, additionalProperties: false },
      { name: "apply_patch", capability: "terminal.file.write", mode: "write", idempotency: "record_before_execute", timeoutMs: 180_000, serial: true, additionalProperties: false },
      { name: "run_command", capability: "terminal.command.run", mode: "write", idempotency: "record_before_execute", timeoutMs: 1_050_000, serial: true, additionalProperties: false },
      { name: "checkout_repository", capability: "terminal.repository.checkout", mode: "write", idempotency: "record_before_execute", timeoutMs: 300_000, serial: true, additionalProperties: false },
      { name: "import_resource", capability: "terminal.resource.import", mode: "write", idempotency: "record_before_execute", timeoutMs: 240_000, serial: true, additionalProperties: false },
      { name: "publish_resource", capability: "terminal.resource.publish", mode: "write", idempotency: "provider_key", timeoutMs: 240_000, serial: true, additionalProperties: false },
      { name: "publish_branch_and_pr", capability: "terminal.repository.publish", mode: "write", idempotency: "record_before_execute", timeoutMs: 300_000, serial: true, additionalProperties: false },
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

  it("deploys Terminal in both regions against the same Daytona us environment", () => {
    const stripJsoncComments = (raw: string): string => raw.replace(/^\s*\/\/.*$/gmu, "");
    const vars = (fileName: string): Record<string, string> => {
      const raw = readFileSync(new URL(`../${fileName}`, import.meta.url), "utf8");
      return (JSON.parse(stripJsoncComments(raw)) as { vars?: Record<string, string> }).vars ?? {};
    };
    const globalVars = vars("wrangler.global.jsonc");
    const euVars = vars("wrangler.eu.jsonc");

    expect(globalVars.TERMINAL_REGION_CAPABILITY).toBe("supported");
    expect(euVars.TERMINAL_REGION_CAPABILITY).toBe("supported");
    expect(globalVars.DAYTONA_TARGET).toBe("us");
    expect(euVars.DAYTONA_TARGET).toBe("us");
    // The invariant is that the two regions agree, not which snapshot they name.
    // Pinning the literal made every snapshot roll a test edit -- and a snapshot
    // is expected to roll: adopting a Rally-owned one, and rebuilding it to stay
    // current with Daytona's base, both change this value. A region drifting onto
    // a different snapshot is the thing worth failing on, because the two would
    // then run different toolchains while sharing one acceptance gate.
    expect(globalVars.DAYTONA_TERMINAL_SNAPSHOT).toMatch(/^[a-z0-9][a-z0-9._-]*$/u);
    expect(euVars.DAYTONA_TERMINAL_SNAPSHOT).toBe(globalVars.DAYTONA_TERMINAL_SNAPSHOT);
  });
});
