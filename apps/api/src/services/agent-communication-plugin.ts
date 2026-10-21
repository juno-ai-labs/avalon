import {
  StartAgentInputSchema, ListAgentsInputSchema, SendAgentMessageInputSchema,
  ReplyToAgentMessageInputSchema, StopAgentInputSchema, modelAgentId,
} from "@rally/contracts";
import type { HarnessPlugin, HarnessTool } from "@rally/agent-harness";
import { z } from "zod";
import type { AgentCommunicationService } from "./agent-communication-service";

/** What the tools call: the service's model-facing operations and nothing else. */
export type AgentCommunicationTools = Pick<AgentCommunicationService,
  "sidekicks" | "createSidekick" | "start" | "list" | "send" | "stop">;

export function createAgentCommunicationPlugin(service: AgentCommunicationTools, roleGuidance: string): HarnessPlugin {
  function tool<T>(name: string, description: string, schema: z.ZodType<T>,
    execute: (input: T, context: Parameters<HarnessTool["execute"]>[1]) => Promise<unknown>): HarnessTool {
    return {
      definition: {
        name, description, inputSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
        capability: `agents.${name}`, mode: (name === "list_agents" || name === "sidekicks_list") ? "read" : "write",
        idempotency: name === "list_agents" || name === "sidekicks_list" ? "safe"
          : name === "stop_agent" ? "record_before_execute" : "provider_key",
      },
      async execute(input, context) {
        const output = forModel(await execute(schema.parse(input), context));
        return { output, summary: description };
      },
    };
  }
  return {
    canonicalId: "avalon:agents", modelId: "rally_agents",
    // No wire prefix. `start_agent`, `list_agents` and `stop_agent` carry their
    // own subject, and the prefix was a second copy of it. `reply_to_message`
    // is named for the thing it answers rather than the bare `reply` it was,
    // which left the object to the prefix. `send_message` still has that
    // problem — bare, it reads as messaging a person rather than an agent —
    // which is why the instructions below name the addressee in every sentence
    // that reaches for one. See the changelog in `docs/agent-communication.md`.
    shortWireName: "",
    displayName: "Background agents", description: "Delegate work to background agents and communicate with teammates.",
    searchAliases: ["background", "delegate", "teammate", "send message", "reply", "subagent"],
    systemMessage: `${roleGuidance} Send results and questions explicitly to the intended agent. Your final response stays in your own conversation. New agents receive only the instructions and attachments you provide, not your transcript. Include enough context to do the work. Agents inherit your model and authorized tools. Continue existing agents through messages. list_agents shows whether one is still running. Messages start idle agents, resume stopped agents, and reach busy agents between execution steps. You may stop only agents you own and their descendants. Reusable procedures and reference knowledge appear under Skills; call load_skill to use their instructions in this run. Sidekick setup configures saved agents that can run on a schedule or when an event arrives. One thread, one person, or the organization owns it, and its authoring agent changes its setup when you message it. To set up a Sidekick, first look in sidekicks_list, which returns only editable Sidekicks owned by this thread, and send a suitable one’s authoring agent the changes. An empty list means create one here with create_sidekick using scope=workstream, then send its authoring agent setup instructions. Change a personal or organization Sidekick only when the person names it and asks you to. If none fits, create one in this thread and send its authoring agent setup instructions. The Sidekick handles its own setup and sends back questions or results. After an access or ownership refusal, the message was not delivered: rediscover Sidekicks. For setup in this thread, select an editable one this thread owns or create one here and continue the task. If the user explicitly named the refused Sidekick, report its refusal instead of silently replacing it. Do not keep retrying the refused recipient or treat its old blocker claims as verified. Use current sidekicks_list status, nextRunAt and lastRunAt to verify activation, scheduling and previous runs before reporting them; a sent setup request or a remembered claim proves none of these. Once verified state supersedes a saved blocker or pending status, correct or retract that stale memory while preserving the user’s preferences.`,
    preload: true,
    tools: [
      tool("sidekicks_list", "List only editable Sidekicks owned by this thread for setup, each with its authoring agentId and current status, nextRunAt and lastRunAt. If empty, create one here with create_sidekick (scope=workstream), then send its authoring agent setup instructions. Reusable instructions are listed separately under Skills; call load_skill to use them. Rediscover after an access or ownership refusal. A draft is not active; a null nextRunAt is not evidence of a scheduled run.", z.strictObject({}), () => service.sidekicks()),
      tool("create_sidekick", "Create a Sidekick when none you can edit fits. Returns its authoring agentId; send setup instructions to that agent next.", z.strictObject({ scope: z.enum(["workstream", "personal", "workspace"]).default("workstream").describe("workstream (the default) makes this thread its owner. Choose personal or workspace (organization) only when the person asks.") }), (input, context) => service.createSidekick(input.scope, context)),
      tool("start_agent", "Delegate work to a new background agent. Returns its agentId at once. Include the full assignment and needed context.", StartAgentInputSchema, (input, context) => service.start(input, context)),
      tool("list_agents", "Find teammates: their agentId, name, description and execution status. Use it to choose whom to message or stop. To get a teammate's reply, wait for its message.", ListAgentsInputSchema, () => service.list()),
      tool("send_message", "Send instructions or an update to a teammate using agentId. Returns at once and resumes idle or stopped agents.", SendAgentMessageInputSchema, (input, context) => service.send(input, context)),
      tool("reply_to_message", "Send a response to the sender of a received message. Use that messageId, not an agentId. Returns at once.", ReplyToAgentMessageInputSchema, (input, context) => service.send(input, context)),
      tool("stop_agent", "Stop an agent you own and all agents it owns. Completed actions are not undone. A later message can resume the stopped agent.", StopAgentInputSchema, (input) => service.stop(input.agentId)),
    ],
  };
}

/** Every `agentId` in a result, in the spelling the model reads (`modelAgentId`). */
function forModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(forModel);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) =>
    [key, key === "agentId" && typeof field === "string" ? modelAgentId(field) : forModel(field)]));
}
