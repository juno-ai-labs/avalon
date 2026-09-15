import {
  StartAgentInputSchema, ListAgentsInputSchema, SendAgentMessageInputSchema,
  ReplyToAgentMessageInputSchema, StopAgentInputSchema,
} from "@rally/contracts";
import type { HarnessPlugin, HarnessTool } from "@rally/agent-harness";
import { z } from "zod";
import type { AgentCommunicationService } from "./agent-communication-service";

export function createAgentCommunicationPlugin(service: AgentCommunicationService): HarnessPlugin {
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
        const output = await execute(schema.parse(input), context);
        return { output, summary: description };
      },
    };
  }
  return {
    canonicalId: "avalon:agents", modelId: "rally_agents", shortWireName: "agents",
    displayName: "Background agents", description: "Delegate work to background agents and communicate with teammates.",
    searchAliases: ["background", "delegate", "teammate", "send message", "reply", "subagent"],
    systemMessage: "Keep the participant conversation available. Delegate substantial research, blocking tools, and independent work with start_agent, then return to the conversation. Give explicit context and attachments: a new agent does not receive your transcript. Agents use the same model and eligible tools and may delegate recursively when useful. Communicate using send_message or reply; ask for status through an ordinary message. A sent message wakes an idle agent and reaches a running agent at a safe boundary. Stop only owned agents with stop_agent. Finish delegated work by replying to the originating message with your result or question. Do not send acknowledgments that invite endless reply loops. Names and descriptions identify teammates without inspecting their transcripts. Before Sidekick setup, use sidekicks_list and prefer a suitable Sidekick owned by the current workstream. Reuse it by sending instructions to its authoring agent. Otherwise use create_sidekick, which defaults to workstream ownership, and send it setup instructions. Use personal or workspace scope when explicitly requested or clearly appropriate. The Sidekick drafts its own configuration and replies with questions or the saved result.",
    preload: false,
    tools: [
      tool("sidekicks_list", "Find accessible Sidekicks, with current-workstream Sidekicks first, and their authoring agent IDs.", z.strictObject({}), () => service.sidekicks()),
      tool("create_sidekick", "Create a minimal Sidekick, then send its authoring agent setup instructions. Prefer reusing an existing workstream Sidekick.", z.strictObject({ scope: z.enum(["workstream", "personal", "workspace"]).default("workstream") }), (input, context) => service.createSidekick(input.scope, context)),
      tool("start_agent", "Start an independent background agent; returns immediately after durable admission.", StartAgentInputSchema, (input, context) => service.start(input, context)),
      tool("list_agents", "List teammates with their names, descriptions and current execution status.", ListAgentsInputSchema, () => service.list()),
      tool("send_message", "Send a message and optional attachments to a teammate.", SendAgentMessageInputSchema, (input, context) => service.send(input, context)),
      tool("reply", "Reply to a received message using its messageId.", ReplyToAgentMessageInputSchema, (input, context) => service.send(input, context)),
      tool("stop_agent", "Stop an owned agent and its owned descendants.", StopAgentInputSchema, (input) => service.stop(input.agentId)),
    ],
  };
}
