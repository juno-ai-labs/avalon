import { renderCanvasTitleMessages } from "@rally/agent-harness";
import { z } from "zod";

import type { Env } from "../env";
import { truncateUtf16Safe } from "../lib/text";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { runStructuredInference } from "./structured-inference";

/** A Canvas title's own bound (`canvas_directory.title`). */
const TITLE_MAX_CHARACTERS = 300;

const CanvasTitleSchema = z.strictObject({ title: z.string() });

const titleJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: { title: { type: "string" } },
} as const;

/**
 * A Canvas's title from the message that opened its Chat, on the
 * `canvas_naming` role with reasoning off, the way a Thread was named
 * from its opening message. `null` when there is no model or it answers
 * nothing usable: the Canvas then keeps the title it has. Never throws.
 */
export async function canvasTitleFromOpening(env: Env, input: {
  workspaceId: string;
  canvasId: string;
  userId: string | null;
  opening: string;
}): Promise<string | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  // The policy is the harness prompt (`prompts/canvas-title.ts`), with its
  // golden hash; the opening message is its user-role message.
  const messages = renderCanvasTitleMessages(input.opening);
  try {
    const { result } = await runStructuredInference(env, {
      role: "canvas_naming",
      activity: "channel_naming",
      context: { workspaceId: input.workspaceId, workstreamId: input.canvasId, ...(input.userId ? { userId: input.userId } : {}) },
      messages,
      schemaName: "canvas_title",
      jsonSchema: titleJsonSchema,
      parse: (value) => CanvasTitleSchema.parse(value),
      reasoningEffort: "none",
    });
    const title = truncateUtf16Safe(result.title.replace(/\s+/gu, " ").trim().replace(/^["'“”‘’]+|["'“”‘’.]+$/gu, "").trim(),
      TITLE_MAX_CHARACTERS);
    return title.length > 0 ? title : null;
  } catch (error) {
    logWarn(env, "canvas_naming_failed", {
      workspace_id: input.workspaceId,
      canvas_id: input.canvasId,
      // A code, never the message: a schema rejection quotes the model's
      // answer, which is drawn from the person's message.
      error_code: diagnosticErrorCode(error, "canvas_naming_failed"),
    });
    return null;
  }
}
