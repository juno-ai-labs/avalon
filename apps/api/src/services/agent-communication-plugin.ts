import {
  StartAgentInputSchema, ListAgentsInputSchema, SendAgentMessageInputSchema,
  ReplyToAgentMessageInputSchema, StopAgentInputSchema,
} from "@rally/contracts";
import type { HarnessPlugin, HarnessTool } from "@rally/agent-harness";
import { z } from "zod";
import type { AgentCommunicationService } from "./agent-communication-service";

export function createAgentCommunicationPlugin(service: AgentCommunicationService, roleGuidance: string): HarnessPlugin {
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
    systemMessage: `${roleGuidance} Send results and questions explicitly to the intended agent. Your final response stays in your own conversation. New agents receive only the instructions and attachments you provide, not your transcript. Include enough context to do the work. Agents inherit your model and authorized tools. Continue existing agents through messages; ask them for status when needed. Messages start idle agents, resume stopped agents, and reach busy agents between execution steps. You may stop only agents you own and their descendants. Before creating a Sidekick, look for a suitable one owned by this workstream. Reuse it by messaging its authoring agent. If none fits, create one in this workstream and send setup instructions. Choose personal or workspace scope only when requested or clearly appropriate. The Sidekick handles its own setup and sends back questions or results.`,
    preload: true,
    tools: [
      tool("sidekicks_list", "Find Sidekicks you can use. Returns authoring agentId values, with this workstream’s Sidekicks first.", z.strictObject({}), () => service.sidekicks("harness_command")),
      tool("create_sidekick", "Create a Sidekick only if no existing one fits. Returns its authoring agentId; send setup instructions to that agent next.", z.strictObject({ scope: z.enum(["workstream", "personal", "workspace"]).default("workstream").describe("Defaults to this workstream. Choose personal or workspace only when requested or clearly appropriate.") }), (input, context) => service.createSidekick(input.scope, context)),
      tool("start_agent", "Delegate work to a new background agent. Returns agentId after accepting the assignment; does not wait for completion. Include the full assignment and needed context.", StartAgentInputSchema, (input, context) => service.start(input, context)),
      tool("list_agents", "Find teammates and their agentId, name, description, and execution status. Message an agent to ask for details.", ListAgentsInputSchema, () => service.list()),
      tool("send_message", "Send instructions or an update to a teammate using agentId. Resumes idle or stopped agents; does not wait for a response.", SendAgentMessageInputSchema, (input, context) => service.send(input, context)),
      tool("reply_to_message", "Send a response to the sender of a received message. Use that messageId, not an agentId. Does not wait for a response.", ReplyToAgentMessageInputSchema, (input, context) => service.send(input, context)),
      tool("stop_agent", "Stop an agent you own and all agents it owns. Completed actions are not undone. A later message can resume the stopped agent.", StopAgentInputSchema, (input) => service.stop(input.agentId)),
    ],
  };
}
