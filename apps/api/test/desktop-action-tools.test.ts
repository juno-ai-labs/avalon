import { describe, expect, it, vi } from "vitest";
import {
  AVALON_SKILL_TOOL_DEFINITIONS, createSkillRuntime, hasAvalonToolProse, toolActivityName, type HarnessToolContext,
} from "@rally/agent-harness";
import { asHarnessRunId, asUserId } from "@rally/contracts";
import { agentProfileFor } from "../src/services/agent-profiles";
import { createBrowserPlugin, DesktopActionToolError } from "../src/services/desktop-actions/browser-plugin";
import type { DesktopActionExecutor } from "../src/services/desktop-actions/executor";
import { createSessionImportPlugin } from "../src/services/desktop-actions/session-import-plugin";

const verification = {
  branch: { complete: true as const, basis: 'Selected leaf reaches the root.' },
  page: { messageCount: 4, firstSourceMessageId: 'm0', lastSourceMessageId: 'm1', sampledSourceMessageIds: ['m1'], basis: 'Both rendered turns compared.' },
  fileCount: 0,
};

const RUN_ID = asHarnessRunId("00000000-0000-7000-8000-0000000000e1");
const context: HarnessToolContext = {
  workspaceId: "w", workstreamId: "p", harnessRunId: "run-1", toolCallId: "call-1",
  executionPrincipal: { type: "user", userId: asUserId("00000000-0000-7000-8000-0000000000e2") }, signal: new AbortController().signal,
};

function tool(name: string, executor: DesktopActionExecutor | undefined) {
  const plugins = [createBrowserPlugin({ harnessRunId: RUN_ID }, executor), createSessionImportPlugin({ harnessRunId: RUN_ID }, executor)];
  const found = plugins.flatMap((plugin) => plugin.tools).find((candidate) => candidate.definition.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe("desktop action tools", () => {
  it("keeps the browser call's title in its settled summary", async () => {
    const executor: DesktopActionExecutor = async () => ({ ok: true, result: { output: [] } });
    const result = await tool("browser_js", executor).execute({ code: "await rally.network.list()", title: "Find conversation data" }, context);
    expect(result.summary).toBe("Find conversation data");
  });
  it("asks the desktop for exactly the action, under the call's own receipt", async () => {
    const executor = vi.fn<DesktopActionExecutor>(async () => ({ ok: true, result: { output: [{ type: "text", text: "2" }] } }));
    const result = await tool("browser_js", executor).execute({ code: "nodeRepl.write(2)" }, context);
    expect(executor).toHaveBeenCalledWith({ runId: RUN_ID, toolCallId: "call-1", action: { kind: "browser.script", code: "nodeRepl.write(2)" }, signal: context.signal });
    expect(result.output).toEqual({ output: ["2"] });
  });

  it("shows the model a screenshot as an image, never as text", async () => {
    const executor: DesktopActionExecutor = async () => ({ ok: true, result: {
      output: [{ type: "image", mimeType: "image/jpeg", data: "AAAA", width: 800, height: 600 }],
    } });
    const result = await tool("browser_js", executor).execute({ code: "await tab.getScreenshot()" }, context);
    expect(result.output).toEqual({ output: [] });
    expect(result.contentParts).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", detail: "auto" } }]);
  });

  it("turns a desktop's failure into a typed error that says what to do next", async () => {
    const executor: DesktopActionExecutor = async () => ({ ok: false, code: "origin_not_allowed", message: "The tab is on https://example.com/." });
    const failure = await tool("browser_js", executor).execute({ code: "await tab.click([1,2])" }, context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DesktopActionToolError);
    expect(failure).toMatchObject({ code: "origin_not_allowed", message: "The tab is on https://example.com/.",
      details: { reason: expect.stringContaining("tab.goto") } });
  });

  it("refuses a desktop answer that is not the kind it asked for, and a run with no desktop", async () => {
    const wrong: DesktopActionExecutor = async () => ({ ok: true, result: { outline: "x" } });
    await expect(tool("browser_js", wrong).execute({ code: "await tab.getScreenshot()" }, context)).rejects.toMatchObject({ code: "invalid_desktop_result" });
    await expect(tool("browser_js", undefined).execute({ code: "await cua.getState()" }, context)).rejects.toMatchObject({ code: "desktop_unavailable" });
  });

  it("returns to the model once the import finishes or fails, so the run ends on its reply", async () => {
    const executor: DesktopActionExecutor = async (input) => ({ ok: true,
      result: input.action.kind === "session_import.finish" ? { workstreamId: "p", messages: 4 } : {} });
    const finished = await tool("import_finish", executor).execute({ title: "Plan", messages: "h1", verification }, context);
    expect(finished).toMatchObject({ output: { imported: true, messages: 4 }, summary: "Imported 4 messages" });
    expect(finished).not.toHaveProperty("halt");
    const failed = await tool("import_fail", executor).execute({ reason: "sign_in_required" }, context);
    expect(failed).toMatchObject({ output: { stopped: true } });
    expect(failed).not.toHaveProperty("halt");
  });
});

describe("agent profiles", () => {
  it("names an ordinary conversation null and refuses a profile this Worker does not have", () => {
    expect(agentProfileFor(null)).toBeNull();
    expect(agentProfileFor("session_import")?.role).toBe("session_import");
    expect(() => agentProfileFor("retired_profile")).toThrow(expect.objectContaining({ code: "agent_profile_unknown" }));
  });

  it("lists every step an import can take in plain words, not its tool name", () => {
    const profile = agentProfileFor("session_import")!;
    const names = [
      ...profile.plugins({ harnessRunId: RUN_ID } as never, undefined).flatMap((plugin) => plugin.tools.map((entry) => entry.definition.name)),
      ...AVALON_SKILL_TOOL_DEFINITIONS.map((definition) => definition.name),
    ];
    expect(names.filter((name) => !hasAvalonToolProse(name))).toEqual([]);
    expect(toolActivityName({ toolName: "browser_network_read", status: "started" })).toBe("Reading data the page loaded");
  });

  it("offers its run every skill it names, because each skill's owner is one of its plugins", async () => {
    const profile = agentProfileFor("session_import")!;
    const runtime = await createSkillRuntime({
      skills: profile.skills,
      eligiblePlugins: profile.plugins({ harnessRunId: RUN_ID } as never, undefined).map((plugin) => plugin.canonicalId),
    });
    expect(runtime.summaries.map((summary) => summary.name).sort())
      .toEqual(["reading-an-ai-chat", "reading-chatgpt-conversations", "reading-claude-conversations"]);
  });

  it("exposes only the script and reset tools, with no model-family-specific naming", async () => {
    const executor = vi.fn<DesktopActionExecutor>(async () => ({ ok: true, result: {} }));
    const plugin = createBrowserPlugin({ harnessRunId: RUN_ID }, executor);
    expect(plugin.tools.map(entry => entry.definition.name)).toEqual(["browser_js", "browser_js_reset"]);
    expect(plugin.tools.map(entry => entry.definition.idempotency)).toEqual(["record_before_execute", "record_before_execute"]);
    await tool("browser_js_reset", executor).execute({}, context);
    expect(executor).toHaveBeenCalledWith({ runId: RUN_ID, toolCallId: "call-1", action: { kind: "browser.script_reset" }, signal: context.signal });
  });

  it("keeps partial observations when a script reports an error, so the model can repair it", async () => {
    const executor: DesktopActionExecutor = async () => ({ ok: true, result: { output: [{ type: "text", text: "Loaded 2 messages" }], error: "Unknown variable: messages" } });
    const result = await tool("browser_js", executor).execute({ code: "nodeRepl.write(messages)" }, context);
    expect(result.output).toEqual({ output: ["Loaded 2 messages"], error: "Unknown variable: messages" });
  });
});
