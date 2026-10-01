import { describe, expect, it, vi } from "vitest";
import type { HarnessToolContext } from "@rally/agent-harness";
import { agentProfileFor } from "../src/services/agent-profiles";
import { createBrowserPlugin, DesktopActionToolError } from "../src/services/desktop-actions/browser-plugin";
import type { DesktopActionExecutor } from "../src/services/desktop-actions/executor";
import { createSessionImportPlugin } from "../src/services/desktop-actions/session-import-plugin";

const context: HarnessToolContext = {
  workspaceId: "w", workstreamId: "p", harnessRunId: "run-1", toolCallId: "call-1",
  executionPrincipal: { type: "user", userId: "u" }, signal: new AbortController().signal,
};

function tool(name: string, executor: DesktopActionExecutor | undefined) {
  const plugins = [createBrowserPlugin({ harnessRunId: "run-1" }, executor), createSessionImportPlugin({ harnessRunId: "run-1" }, executor)];
  const found = plugins.flatMap((plugin) => plugin.tools).find((candidate) => candidate.definition.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe("desktop action tools", () => {
  it("asks the desktop for exactly the action, under the call's own receipt", async () => {
    const executor = vi.fn<DesktopActionExecutor>(async () => ({ ok: true, result: { url: "https://claude.ai/chat/1", title: "Chat", value: 2, stored: [] } }));
    const result = await tool("browser_evaluate", executor).execute({ script: "return 2" }, context);
    expect(executor).toHaveBeenCalledWith({ runId: "run-1", toolCallId: "call-1", action: { kind: "browser.evaluate", script: "return 2" }, signal: context.signal });
    expect(result.output).toEqual({ url: "https://claude.ai/chat/1", title: "Chat", value: 2, stored: [] });
  });

  it("shows the model a screenshot as an image, never as text", async () => {
    const executor: DesktopActionExecutor = async () => ({ ok: true, result: {
      url: "https://claude.ai/chat/1", title: "Chat", mimeType: "image/jpeg", data: "AAAA", width: 800, height: 600,
    } });
    const result = await tool("browser_screenshot", executor).execute({}, context);
    expect(result.output).toEqual({ url: "https://claude.ai/chat/1", title: "Chat", width: 800, height: 600 });
    expect(result.contentParts).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", detail: "auto" } }]);
  });

  it("turns a desktop's failure into a typed error that says what to do next", async () => {
    const executor: DesktopActionExecutor = async () => ({ ok: false, code: "origin_not_allowed", message: "The tab is on https://example.com/." });
    const failure = await tool("browser_click", executor).execute({ x: 1, y: 2 }, context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DesktopActionToolError);
    expect(failure).toMatchObject({ code: "origin_not_allowed", message: "The tab is on https://example.com/.",
      details: { reason: expect.stringContaining("browser_navigate") } });
  });

  it("refuses a desktop answer that is not the kind it asked for, and a run with no desktop", async () => {
    const wrong: DesktopActionExecutor = async () => ({ ok: true, result: { outline: "x" } });
    await expect(tool("browser_screenshot", wrong).execute({}, context)).rejects.toMatchObject({ code: "invalid_desktop_result" });
    await expect(tool("browser_snapshot", undefined).execute({}, context)).rejects.toMatchObject({ code: "desktop_unavailable" });
  });

  it("ends the run once the import finishes or fails", async () => {
    const executor: DesktopActionExecutor = async (input) => ({ ok: true,
      result: input.action.kind === "session_import.finish" ? { workstreamId: "p", messages: 4 } : {} });
    await expect(tool("import_finish", executor).execute({ title: "Plan", messages: "h1" }, context))
      .resolves.toMatchObject({ output: { imported: true, messages: 4 }, halt: "completed" });
    await expect(tool("import_fail", executor).execute({ reason: "sign_in_required" }, context))
      .resolves.toMatchObject({ halt: "completed" });
  });
});

describe("agent profiles", () => {
  it("names an ordinary conversation null and refuses a profile this Worker does not have", () => {
    expect(agentProfileFor(null)).toBeNull();
    expect(agentProfileFor("session_import")?.role).toBe("session_import");
    expect(() => agentProfileFor("retired_profile")).toThrow(expect.objectContaining({ code: "agent_profile_unknown" }));
  });
});
