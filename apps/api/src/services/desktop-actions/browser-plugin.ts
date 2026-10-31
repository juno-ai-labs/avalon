import { toolActivityName, type HarnessPlugin, type HarnessTool, type HarnessToolContext, type HarnessToolResult } from "@rally/agent-harness";
import { truncateTextWithMarker } from "@rally/connectors";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { describeZodIssues } from "@rally/contracts/zod-diagnostics";
import {
  DesktopActionResultSchemas,
  type DesktopAction,
  type DesktopActionKind,
  type DesktopActionResult,
} from "@rally/contracts/desktop-actions";
import { z } from "zod";
import { BROWSER_RUNTIME_ENTRY_INSTRUCTIONS } from "@rally/contracts/browser-runtime";

import type { DesktopActionExecutor } from "./executor";

export const BROWSER_PLUGIN_ID = "avalon:browser";

/**
 * The characters of page text (a script's returned value, a page outline) one
 * tool result carries before it is cut with a visible marker.
 *
 * Open on purpose: the guard is written, the number is the team's to set (see
 * `docs/adding-security-defensive-and-other-limits.md`). The arithmetic to set
 * it from is the routed model's context window divided by the steps an import
 * takes; a ChatGPT conversation's JSON runs from 0.2 to 5 MB, which the prompt
 * already keeps out of results by storing it in the page.
 */
export const BROWSER_TOOL_TEXT_MAX_CHARS = Number.POSITIVE_INFINITY;

/** A refusal the model can act on: a stable code and the shortest next step. */
export class DesktopActionToolError extends Error {
  readonly details: { reason: string };

  constructor(readonly code: string, message: string, reason: string) {
    super(message);
    this.name = "DesktopActionToolError";
    this.details = { reason };
  }
}

/** What each desktop failure code tells the model to do next. */
const NEXT_STEP: Record<string, string> = {
  invalid_action: "Check the arguments against the tool's schema and call it again.",
  tab_closed: "The conversation's tab was closed; there is nothing left to read. Stop.",
  origin_not_allowed: "Navigate back to the conversation with tab.goto before continuing.",
  script_error: "Fix the script and run it again. The page's own error is in the message.",
  value_not_serializable: "Return only JSON values: strings, numbers, booleans, null, arrays and plain objects.",
  browser_command_failed: "Check the page with tab.getScreenshot(), then try again or take another approach.",
  file_too_large: "Record that file as unavailable, with this reason, and continue.",
  unknown_handle: "Use a handle a previous rally.store or rally.load returned.",
  invalid_conversation: "Fix what the message names in the stored messages, store them again, and call import_finish with the new handle.",
  import_rejected: "Fix what the message names and call import_finish again. If nothing in the stored messages can fix it, call import_fail with unreadable.",
  result_too_large: "Return less: keep large values in the page with rally.store and return only what you need.",
};

/**
 * Run one desktop action for a tool call and return its typed result.
 *
 * Shared by every plugin whose tools are desktop actions, so each one fails
 * the same way: a desktop that answered with a failure becomes a typed tool
 * error naming its code, and a run that cannot reach a desktop at all says so.
 */
export async function runDesktopAction<K extends DesktopActionKind>(
  executor: DesktopActionExecutor | undefined,
  input: Pick<WorkstreamWorkflowInput, "harnessRunId">,
  context: HarnessToolContext,
  action: Extract<DesktopAction, { kind: K }>,
): Promise<DesktopActionResult<K>> {
  if (!executor) {
    throw new DesktopActionToolError(
      "desktop_unavailable",
      "This run cannot reach the person's desktop.",
      "Stop; this tool cannot work in this run.",
    );
  }
  const outcome = await executor({
    runId: input.harnessRunId,
    toolCallId: context.toolCallId,
    action,
    signal: context.signal,
  });
  if (!outcome.ok) {
    throw new DesktopActionToolError(outcome.code, outcome.message || outcome.code,
      NEXT_STEP[outcome.code] ?? "Try another approach.");
  }
  // The desktop is the person's own client, but its answer is still input to
  // this run: a result that does not match the kind asked for is refused here
  // rather than handed to the model as if it had.
  const parsed = (DesktopActionResultSchemas[action.kind] as z.ZodType).safeParse(outcome.result);
  if (!parsed.success) {
    throw new DesktopActionToolError(
      "invalid_desktop_result",
      `The desktop answered ${action.kind} with a result that does not match it: ${describeZodIssues(parsed.error)}.`,
      "Try the call again.",
    );
  }
  return parsed.data as DesktopActionResult<K>;
}

function text(value: string): string {
  return Number.isFinite(BROWSER_TOOL_TEXT_MAX_CHARS)
    ? truncateTextWithMarker(value, BROWSER_TOOL_TEXT_MAX_CHARS)
    : value;
}

function inputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

const ScriptArgumentsSchema = z.strictObject({
  code: z.string().min(1).describe("JavaScript in the persistent browser session. Supports top-level await. Emit results using nodeRepl.write and nodeRepl.emitImage."),
  title: z.string().optional().describe("Short description of the browser work."),
});
const NoArgumentsSchema = z.strictObject({});

/** A model-neutral persistent browser session; the desktop pins its tab and owns its lifetime. */
export function createBrowserPlugin(
  input: Pick<WorkstreamWorkflowInput, "harnessRunId">,
  executor: DesktopActionExecutor | undefined,
): HarnessPlugin {
  const script: HarnessTool = {
    definition: {
      name: "browser_js",
      description: BROWSER_RUNTIME_ENTRY_INSTRUCTIONS,
      capability: "browser.page.input",
      mode: "write",
      idempotency: "record_before_execute",
      inputSchema: inputSchema(ScriptArgumentsSchema),
    },
    reenterable: true,
    yieldsContentParts: true,
    execute: async (raw, context): Promise<HarnessToolResult> => {
      const args = ScriptArgumentsSchema.parse(raw);
      const result = await runDesktopAction(executor, input, context, { kind: "browser.script", ...args });
      return {
        output: { output: result.output.filter(part => part.type === "text").map(part => text(part.text)), ...(result.error !== undefined ? { error: result.error } : {}) },
        summary: toolActivityName({ toolName: "browser_js", status: result.error === undefined ? "completed" : "failed", arguments: args }),
        contentParts: result.output.filter(part => part.type === "image").map(part => ({
          type: "image_url" as const,
          image_url: { url: `data:${part.mimeType};base64,${part.data}`, detail: "auto" as const },
        })),
      };
    },
  };
  const reset: HarnessTool = {
    definition: {
      name: "browser_js_reset",
      description: "Reset the browser JavaScript session and its bindings. The pinned tab, signed-in browser and stored file handles remain available. Start again with one entry-point call and read the returned documentation.",
      capability: "browser.page.input",
      mode: "write",
      idempotency: "record_before_execute",
      inputSchema: inputSchema(NoArgumentsSchema),
    },
    reenterable: true,
    execute: async (raw, context) => {
      NoArgumentsSchema.parse(raw);
      await runDesktopAction(executor, input, context, { kind: "browser.script_reset" });
      return { output: {}, summary: "Reset the browser session" };
    },
  };
  return {
    canonicalId: BROWSER_PLUGIN_ID,
    modelId: "rally_browser",
    shortWireName: "",
    displayName: "Browser",
    activityDisplayName: "Browser",
    description: "Read and operate the pinned page through a persistent JavaScript session.",
    preload: true,
    tools: [script, reset],
  };
}
