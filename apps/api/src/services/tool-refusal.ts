import type { HarnessTool } from "@rally/agent-harness";
import { ApiError } from "../lib/api-error";

/** Why a turn may not use a tool, and what it can do instead. */
export interface ToolRefusal {
  /** A named code a log, a test and the model can all read. */
  code: string;
  /** Why this turn may not, which turn may, and how to reach that turn with tools this one has. */
  message: string;
}

/**
 * A tool as a turn that may not use it is offered it: the same name and
 * arguments, and a call that changes nothing and refuses with `refusal`.
 * A tool is never withheld for who or what started a turn, so the model can
 * tell "not mine to do here" from "does not exist" and hand the work on
 * (`docs/agent-tools.md`, rule 14). `description` and `capability` replace
 * the tool's own where a caller tells the model up front, or tells a reader
 * of capabilities, that this one refuses.
 */
export function refusingTool(tool: HarnessTool, refusal: ToolRefusal,
  overrides: { description?: string; capability?: string } = {}): HarnessTool {
  return {
    definition: { ...tool.definition, ...overrides, mode: "read", idempotency: "safe" },
    ...(tool.validateInput ? { validateInput: tool.validateInput } : {}),
    execute: async () => {
      throw new ApiError(403, refusal.code, refusal.message);
    },
  };
}
