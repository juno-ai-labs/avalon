import type { HarnessPlugin, HarnessTool } from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { SessionImportFailureReasonSchema } from "@rally/contracts/desktop-actions";
import { z } from "zod";

import { runDesktopAction } from "./browser-plugin";
import type { DesktopActionExecutor } from "./executor";

export const SESSION_IMPORT_PLUGIN_ID = "avalon:session-import";

function inputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

const FinishArgumentsSchema = z.strictObject({
  title: z.string().trim().min(1).max(180).describe("The conversation's title as the provider shows it, or a short one you write when it has none."),
  messages: z.string().min(1).describe("The handle rally.store returned for the stored messages array."),
});
const FailArgumentsSchema = z.strictObject({
  reason: SessionImportFailureReasonSchema.describe("sign_in_required: the page asks the person to sign in. not_a_conversation: the tab does not show a conversation. page_unavailable: the page will not load or refuses access."),
});

/**
 * The importer's two ways to end: hand the conversation over, or say why it
 * cannot be read.
 *
 * Both are desktop actions. The desktop that started the import holds the
 * stored messages and files, so it is the one that checks them, uploads the
 * files and creates or updates the Channel; Rally's API validates that request
 * exactly as it validates any import. The model sends a handle, never the
 * conversation, so no message text passes through its output. A failure reason
 * is a closed set, and the words the person reads for each are Rally's.
 */
export function createSessionImportPlugin(
  input: Pick<WorkstreamWorkflowInput, "harnessRunId">,
  executor: DesktopActionExecutor | undefined,
): HarnessPlugin {
  const finish: HarnessTool = {
    definition: {
      name: "import_finish",
      description: "Hand the stored conversation to Rally. Succeeds once; on a problem it names what to fix.",
      capability: "rally.session_import.finish",
      mode: "write",
      idempotency: "record_before_execute",
      inputSchema: inputSchema(FinishArgumentsSchema),
    },
    reenterable: true,
    execute: async (raw, context) => {
      const args = FinishArgumentsSchema.parse(raw);
      const result = await runDesktopAction(executor, input, context, {
        kind: "session_import.finish", title: args.title, messages: args.messages,
      });
      return {
        output: { imported: true, messages: result.messages },
        summary: `Imported ${result.messages} messages`,
        halt: "completed",
      };
    },
  };
  const fail: HarnessTool = {
    definition: {
      name: "import_fail",
      description: "End the import because the conversation cannot be read at all.",
      capability: "rally.session_import.fail",
      mode: "write",
      idempotency: "record_before_execute",
      inputSchema: inputSchema(FailArgumentsSchema),
    },
    reenterable: true,
    execute: async (raw, context) => {
      const args = FailArgumentsSchema.parse(raw);
      await runDesktopAction(executor, input, context, { kind: "session_import.fail", reason: args.reason });
      return { output: { stopped: true }, summary: "Stopped the import", halt: "completed" };
    },
  };
  return {
    canonicalId: SESSION_IMPORT_PLUGIN_ID,
    modelId: "rally_import",
    // No wire prefix: these tools are always active and already named
    // unambiguously, and the prompt that owns their protocol names them as-is.
    shortWireName: "",
    displayName: "Conversation import",
    activityDisplayName: "Import",
    description: "Finish or end the conversation import.",
    preload: true,
    tools: [finish, fail],
  };
}
