import type { HarnessTool } from "@rally/agent-harness";
import { ApiError } from "../lib/api-error";

/**
 * Every refusal a refusing tool gives, in one place so that the routes they
 * name stay true together. Each says why this turn may not, and how to reach
 * a turn that may with tools this one has.
 */
export const TOOL_REFUSALS = {
  sidekick_source_request_from_run: "A Sidekick run cannot ask people for a source: it works from the event that started it, and nothing a run reads may send a request in a person's name. Say in your result who should be asked, for which connector and event types, and with what filter, so a person who manages this Sidekick can ask.",
  sidekick_source_request_from_background_agent: "A background agent cannot ask people for a source: it works from content no person wrote here. Send the agent you work for who should be asked, for which connector and event types, and with what filter, with send_message; it can ask its person.",
  sidekick_source_request_from_agent_message: "This turn was started by another agent's message, not by a person, so it cannot ask people for a source. Reply to that agent with who should be asked, for which connector and event types, and with what filter, so a person can ask.",
  question_from_background_agent: "A background agent cannot ask a person a question: nobody is reading this conversation, so it would wait on nobody. Send the question to the agent you work for with send_message; it can ask its person and send you the answer.",
  question_from_agent_message: "This turn was started by another agent's message, and nobody is reading this conversation, so a question here would wait on nobody. Reply to that agent with the question; it can ask its person.",
  sidekick_tools_need_a_person: "This turn acts for the Organization, not for a person, so it cannot use the tools that read or change Sidekicks in a person's name. Say in your result or reply what is needed and for whom, so a person who manages the Sidekick can do it.",
} as const;
export type ToolRefusalCode = keyof typeof TOOL_REFUSALS;

/** One entry of `TOOL_REFUSALS`, as `refusingTool` takes it. */
export function toolRefusal(code: ToolRefusalCode): ToolRefusal {
  return { code, message: TOOL_REFUSALS[code] };
}

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
