import type { HarnessTool } from "@rally/agent-harness";
import { ApiError } from "../lib/api-error";

/**
 * Every refusal a refusing tool gives, in one place so that the routes they
 * name stay true together. Each says why this turn may not, and how to reach
 * a turn that may with tools this one has.
 */
export const TOOL_REFUSALS = {
  sidekick_source_request_from_run: "A Sidekick run cannot ask people for a source: it works from the event that started it, and nothing a run reads may send a request in a person's name. Say in your result who should be asked, for which connector and event types, and with what filter, so a person who manages this Sidekick can ask.",
  sidekick_source_request_from_background_agent: "This background agent was started before agents recorded who they work for, so it acts for nobody and cannot ask people for a source. Send the agent you work for who should be asked, for which connector and event types, and with what filter, with send_message; it can ask.",
  sidekick_source_request_from_review: "A Sidekick's scheduled self-review cannot ask people for a source: no person started it, and it reads runs, which hold content no person wrote. Name in your review who should be asked, for which connector and event types, and with what filter, so a person who manages this Sidekick can ask.",
  question_from_background_agent: "A background agent cannot ask a person a question: nobody is reading this conversation, so it would wait on nobody. Send the question to the agent you work for with send_message; it can ask its person and send you the answer.",
  question_from_agent_message: "This turn was started by another agent's message, and nobody is reading this conversation, so a question here would wait on nobody. Reply to that agent with the question; it can ask its person.",
  notifications_register_from_run: "A Sidekick run cannot turn on a Canvas's notices: it works from the event that started it, and turning them on changes the Canvas for everyone in it. Call notifications_send; if it says notices are off, say in your result (a background agent: tell the agent you work for with send_message) that a person who manages this Sidekick should turn them on from its wizard.",
  notifications_not_for_self_review: "A Sidekick's scheduled self-review does not send notices or turn them on: no person started it, and it reads runs, which hold content no person wrote. If you are a background agent, tell the agent you work for with send_message what the Canvas's people should hear; otherwise name it in your review, so a person who manages this Sidekick can decide.",
  member_offer_from_guest: "A guest's turn cannot look up or offer to add Organization members. Tell the person you work for who needs to be added, so a member of this Organization can ask an administrator to add them.",
  connections_need_a_person: "This turn acts for the Organization, not for a person, so there is nobody whose connections to check, list or ask to connect: it uses only the connections bound to this Sidekick. If one is missing, say in your result which connector and what it would do, so a person who manages this Sidekick can connect it and bind it.",
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
  const refusing: HarnessTool = {
    definition: { ...tool.definition, ...overrides, mode: "read", idempotency: "safe" },
    ...(tool.validateInput ? { validateInput: tool.validateInput } : {}),
    execute: async () => {
      throw new ApiError(403, refusal.code, refusal.message);
    },
  };
  REFUSING.add(refusing);
  return refusing;
}

const REFUSING = new WeakSet<HarnessTool>();

/** Whether a tool is a refusing copy: offered, but unable to do the work. */
export function isRefusingTool(tool: HarnessTool): boolean {
  return REFUSING.has(tool);
}
