import { describe, expect, it, vi } from "vitest";
import {
  type HarnessToolContext,
} from "@rally/agent-harness";
import { asHarnessRunId, asUserId } from "@rally/contracts";
import { agentProfileFor } from "../src/services/agent-profiles";
import { createBrowserPlugin, DesktopActionToolError } from "../src/services/desktop-actions/browser-plugin";
import type { DesktopActionExecutor } from "../src/services/desktop-actions/executor";

const RUN_ID = asHarnessRunId("00000000-0000-7000-8000-0000000000e1");
const context: HarnessToolContext = {
  workspaceId: "w", workstreamId: "p", harnessRunId: "run-1", toolCallId: "call-1",
  executionPrincipal: { type: "user", userId: asUserId("00000000-0000-7000-8000-0000000000e2") }, signal: new AbortController().signal,
};

function tool(name: string, executor: DesktopActionExecutor | undefined) {
  const plugins = [createBrowserPlugin({ harnessRunId: RUN_ID }, executor)];
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

});

describe("agent profiles", () => {
  it("names an ordinary conversation null and refuses a profile this Worker does not have", () => {
    expect(agentProfileFor(null)).toBeNull();
    // The conversation importer's profile went with Threads.
    expect(() => agentProfileFor("session_import")).toThrow(expect.objectContaining({ code: "agent_profile_unknown" }));
    expect(() => agentProfileFor("retired_profile")).toThrow(expect.objectContaining({ code: "agent_profile_unknown" }));
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
