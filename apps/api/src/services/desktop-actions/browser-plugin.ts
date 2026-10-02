import type { HarnessPlugin, HarnessTool, HarnessToolContext, HarnessToolResult } from "@rally/agent-harness";
import { truncateTextWithMarker } from "@rally/connectors";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import {
  DesktopActionResultSchemas,
  type DesktopAction,
  type DesktopActionKind,
  type DesktopActionResult,
} from "@rally/contracts/desktop-actions";
import { z } from "zod";

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
  origin_not_allowed: "Navigate back to the conversation with browser_navigate before continuing.",
  script_error: "Fix the script and run it again. The page's own error is in the message.",
  value_not_serializable: "Return only JSON values: strings, numbers, booleans, null, arrays and plain objects.",
  browser_command_failed: "Check the page with browser_screenshot, then try again or take another approach.",
  file_too_large: "Record that file as unavailable, with this reason, and continue.",
  unknown_handle: "Use a handle a previous rally.store or browser_load returned.",
  invalid_conversation: "Fix what the message names in the stored messages, store them again, and call import_finish with the new handle.",
  import_rejected: "Fix what the message names and call import_finish again.",
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
      `The desktop answered ${action.kind} with a result that does not match it.`,
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

const EvaluateArgumentsSchema = z.strictObject({
  script: z.string().min(1).describe("The body of an async JavaScript function, run in the page. Use await, and return a JSON value. rally.store(value, { name, mimeType }) keeps a Blob, Response, string or JSON value with the browser and returns its reference."),
});
const NoArgumentsSchema = z.strictObject({});
const PointSchema = {
  x: z.number().finite().describe("Horizontal position in screenshot pixels, from the left."),
  y: z.number().finite().describe("Vertical position in screenshot pixels, from the top."),
};
const ClickArgumentsSchema = z.strictObject(PointSchema);
const ScrollArgumentsSchema = z.strictObject({
  ...PointSchema,
  deltaX: z.number().finite().default(0).describe("Pixels to scroll right; negative scrolls left."),
  deltaY: z.number().finite().describe("Pixels to scroll down; negative scrolls up."),
});
const TypeArgumentsSchema = z.strictObject({
  text: z.string().describe("Text to insert at the focused element."),
});
const KeyArgumentsSchema = z.strictObject({
  key: z.string().min(1).describe("One key name, such as Enter, Escape, Tab, PageDown or ArrowDown."),
});
const NavigateArgumentsSchema = z.strictObject({
  url: z.string().min(1).describe("An https URL on the same site as the conversation."),
});
const LoadArgumentsSchema = z.strictObject({
  url: z.string().min(1).describe("The https URL of the file."),
  name: z.string().min(1).optional().describe("File name to keep it under; defaults to the URL's last path segment."),
  mimeType: z.string().min(1).optional().describe("Media type; defaults to what the server reports."),
});

const NetworkListArgumentsSchema = z.strictObject({
  urlContains: z.string().min(1).optional().describe("Only responses whose URL contains this text, such as part of a path or the conversation's id."),
  resourceType: z.string().min(1).optional().describe("Only responses of this kind: Fetch, XHR, Document, Script, Image, …"),
});
const NetworkReadArgumentsSchema = z.strictObject({
  requestId: z.string().min(1).describe("A requestId from browser_network_list."),
  offset: z.number().int().nonnegative().optional().describe("Where the returned text starts, in characters. Defaults to 0."),
  length: z.number().int().positive().optional().describe("How many characters of the body to return. Leave it out to only place the body in the page."),
});

/**
 * The person's Rally browser, as tools: run page script, read the page's
 * outline, look at it, and give it input.
 *
 * Every tool is a desktop action, executed on the tab the work is pinned to;
 * the desktop decides which tab and which sites, not the model. Generic on
 * purpose — the conversation importer is its first user, and nothing here
 * knows about conversations.
 */
export function createBrowserPlugin(
  input: Pick<WorkstreamWorkflowInput, "harnessRunId">,
  executor: DesktopActionExecutor | undefined,
): HarnessPlugin {
  const page = (result: { url: string; title: string }) => ({ url: result.url, title: result.title });

  const evaluate: HarnessTool = {
    definition: {
      name: "browser_evaluate",
      description: "Run JavaScript in the page and return its result as JSON. The script is the body of an async function, so it can await fetch. Also returns any references rally.store made during the call.",
      capability: "browser.page.evaluate",
      mode: "write",
      idempotency: "record_before_execute",
      inputSchema: inputSchema(EvaluateArgumentsSchema),
    },
    reenterable: true,
    execute: async (raw, context): Promise<HarnessToolResult> => {
      const args = EvaluateArgumentsSchema.parse(raw);
      const result = await runDesktopAction(executor, input, context, { kind: "browser.evaluate", script: args.script });
      const value = result.value === undefined ? null : result.value;
      const serialized = JSON.stringify(value);
      return {
        output: {
          ...page(result),
          ...(serialized.length > BROWSER_TOOL_TEXT_MAX_CHARS ? { valueText: text(serialized) } : { value }),
          stored: result.stored,
        },
        summary: "Ran a script in the page",
      };
    },
  };

  const snapshot: HarnessTool = {
    definition: {
      name: "browser_snapshot",
      description: "Read the page's accessibility outline: each element's role and name, indented by nesting.",
      capability: "browser.page.read",
      mode: "read",
      idempotency: "safe",
      inputSchema: inputSchema(NoArgumentsSchema),
    },
    reenterable: true,
    execute: async (_raw, context) => {
      const result = await runDesktopAction(executor, input, context, { kind: "browser.snapshot" });
      return { output: { ...page(result), outline: text(result.outline) }, summary: "Read the page outline" };
    },
  };

  const screenshot: HarnessTool = {
    definition: {
      name: "browser_screenshot",
      description: "See the visible part of the page as an image. Coordinates for browser_click and browser_scroll are pixels in this image.",
      capability: "browser.page.read",
      mode: "read",
      idempotency: "safe",
      inputSchema: inputSchema(NoArgumentsSchema),
    },
    reenterable: true,
    execute: async (_raw, context) => {
      const result = await runDesktopAction(executor, input, context, { kind: "browser.screenshot" });
      return {
        output: { ...page(result), width: result.width, height: result.height },
        summary: "Looked at the page",
        contentParts: [{
          type: "image_url",
          image_url: { url: `data:${result.mimeType};base64,${result.data}`, detail: "auto" },
        }],
      };
    },
  };

  const input_ = <S extends z.ZodType, K extends "browser.click" | "browser.scroll" | "browser.type" | "browser.key" | "browser.navigate">(
    name: string,
    description: string,
    schema: S,
    action: (args: z.output<S>) => Extract<DesktopAction, { kind: K }>,
    summary: string,
  ): HarnessTool => ({
    definition: {
      name,
      description,
      capability: "browser.page.input",
      mode: "write",
      idempotency: "record_before_execute",
      inputSchema: inputSchema(schema),
    },
    reenterable: true,
    execute: async (raw, context) => {
      const result = await runDesktopAction(executor, input, context, action(schema.parse(raw)));
      return { output: page(result), summary };
    },
  });

  const load: HarnessTool = {
    definition: {
      name: "browser_load",
      description: "Load a file the page's own script may not fetch (one on another site), with the tab's signed-in session, and keep it with the browser. Returns its reference.",
      capability: "browser.page.load",
      mode: "write",
      idempotency: "record_before_execute",
      inputSchema: inputSchema(LoadArgumentsSchema),
    },
    reenterable: true,
    execute: async (raw, context) => {
      const args = LoadArgumentsSchema.parse(raw);
      const result = await runDesktopAction(executor, input, context, {
        kind: "browser.load",
        url: args.url,
        ...(args.name ? { name: args.name } : {}),
        ...(args.mimeType ? { mimeType: args.mimeType } : {}),
      });
      return { output: { stored: result.stored }, summary: `Loaded ${result.stored.name}` };
    },
  };

  const networkList: HarnessTool = {
    definition: {
      name: "browser_network_list",
      description: "List the responses the page has received since it last navigated — URL, method, status, type, size — as a browser's network panel shows them. A web app's data usually arrives in a Fetch or XHR response.",
      capability: "browser.page.read",
      mode: "read",
      idempotency: "safe",
      inputSchema: inputSchema(NetworkListArgumentsSchema),
    },
    reenterable: true,
    execute: async (raw, context) => {
      const args = NetworkListArgumentsSchema.parse(raw);
      const result = await runDesktopAction(executor, input, context, {
        kind: "browser.network_list",
        ...(args.urlContains ? { urlContains: args.urlContains } : {}),
        ...(args.resourceType ? { resourceType: args.resourceType } : {}),
      });
      return { output: { responses: result.responses }, summary: `Listed ${result.responses.length} network responses` };
    },
  };

  const networkRead: HarnessTool = {
    definition: {
      name: "browser_network_read",
      description: "Read one response the page received. Its body is placed in the page as window.__rallyNetwork[requestId] — parsed when it is JSON — for browser_evaluate to work on; pass length to also get that many characters of it back here. Bodies of Fetch and XHR responses are kept, so they can be read again at any time.",
      capability: "browser.page.read",
      mode: "read",
      idempotency: "safe",
      inputSchema: inputSchema(NetworkReadArgumentsSchema),
    },
    reenterable: true,
    execute: async (raw, context) => {
      const args = NetworkReadArgumentsSchema.parse(raw);
      const result = await runDesktopAction(executor, input, context, {
        kind: "browser.network_read",
        requestId: args.requestId,
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.length !== undefined ? { length: args.length } : {}),
      });
      return {
        output: { ...result, ...(result.text !== undefined ? { text: text(result.text) } : {}) },
        summary: "Read a network response",
      };
    },
  };

  return {
    canonicalId: BROWSER_PLUGIN_ID,
    modelId: "rally_browser",
    // No wire prefix: these tools are always active and already named
    // unambiguously, and the prompt that owns their protocol names them as-is.
    shortWireName: "",
    displayName: "Browser",
    activityDisplayName: "Browser",
    description: "Read, look at and operate the page open in the person's Rally browser.",
    preload: true,
    tools: [
      evaluate,
      snapshot,
      screenshot,
      input_("browser_click", "Click at a point in the page.", ClickArgumentsSchema,
        (args) => ({ kind: "browser.click", x: args.x, y: args.y }), "Clicked in the page"),
      input_("browser_scroll", "Scroll the page, or the element under a point.", ScrollArgumentsSchema,
        (args) => ({ kind: "browser.scroll", x: args.x, y: args.y, deltaX: args.deltaX, deltaY: args.deltaY }),
        "Scrolled the page"),
      input_("browser_type", "Type text into the focused element.", TypeArgumentsSchema,
        (args) => ({ kind: "browser.type", text: args.text }), "Typed in the page"),
      input_("browser_press_key", "Press one key in the page.", KeyArgumentsSchema,
        (args) => ({ kind: "browser.key", key: args.key }), "Pressed a key"),
      input_("browser_navigate", "Open a URL in the tab. Only pages on the conversation's own site open.", NavigateArgumentsSchema,
        (args) => ({ kind: "browser.navigate", url: args.url }), "Opened a page"),
      load,
      networkList,
      networkRead,
    ],
  };
}
