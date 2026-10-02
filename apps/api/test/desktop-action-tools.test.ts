import { describe, expect, it, vi } from "vitest";
import type { HarnessToolContext } from "@rally/agent-harness";
import { asHarnessRunId, asUserId } from "@rally/contracts";
import { agentProfileFor } from "../src/services/agent-profiles";
import { createBrowserPlugin, DesktopActionToolError } from "../src/services/desktop-actions/browser-plugin";
import type { DesktopActionExecutor } from "../src/services/desktop-actions/executor";
import { createSessionImportPlugin } from "../src/services/desktop-actions/session-import-plugin";

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
  it("asks the desktop for exactly the action, under the call's own receipt", async () => {
    const executor = vi.fn<DesktopActionExecutor>(async () => ({ ok: true, result: { url: "https://claude.ai/chat/1", title: "Chat", value: 2, stored: [] } }));
    const result = await tool("browser_evaluate", executor).execute({ script: "return 2" }, context);
    expect(executor).toHaveBeenCalledWith({ runId: RUN_ID, toolCallId: "call-1", action: { kind: "browser.evaluate", script: "return 2" }, signal: context.signal });
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

  it("returns to the model once the import finishes or fails, so the run ends on its reply", async () => {
    const executor: DesktopActionExecutor = async (input) => ({ ok: true,
      result: input.action.kind === "session_import.finish" ? { workstreamId: "p", messages: 4 } : {} });
    const finished = await tool("import_finish", executor).execute({ title: "Plan", messages: "h1" }, context);
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

  it("asks the desktop for the page's network responses and a body, and returns what it answered", async () => {
    const asked: unknown[] = [];
    const executor: DesktopActionExecutor = async (request) => {
      asked.push(request.action);
      return request.action.kind === "browser.network_list"
        ? { ok: true, result: { responses: [{ requestId: "r1", url: "https://chat.example/api/c/1", method: "GET", status: 200, mimeType: "application/json", resourceType: "Fetch", size: 40, cached: true }] } }
        : { ok: true, result: { variable: "window.__rallyNetwork[\"r1\"]", mimeType: "application/json", size: 40, json: true, keys: ["messages"], text: "{\"mess" } };
    };
    await expect(tool("browser_network_list", executor).execute({ urlContains: "/api/" }, context))
      .resolves.toMatchObject({ output: { responses: [{ requestId: "r1", cached: true }] }, summary: "Listed 1 network responses" });
    await expect(tool("browser_network_read", executor).execute({ requestId: "r1", length: 6 }, context))
      .resolves.toMatchObject({ output: { variable: "window.__rallyNetwork[\"r1\"]", keys: ["messages"], text: "{\"mess" } });
    expect(asked).toEqual([
      { kind: "browser.network_list", urlContains: "/api/" },
      { kind: "browser.network_read", requestId: "r1", length: 6 },
    ]);
  });
});