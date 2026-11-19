import {
  StartAgentInputSchema, ListAgentsInputSchema, SendAgentMessageInputSchema,
  ReplyToAgentMessageInputSchema, StopAgentInputSchema, RequestSidekickChangeInputSchema, modelAgentId, IdSchema,
} from "@rally/contracts";
import type { HarnessPlugin, HarnessTool } from "@rally/agent-harness";
import { z } from "zod";
import type { AgentCommunicationService } from "./agent-communication-service";
import { renderAgentCommunicationSystemMessage } from "@rally/prompts/api/agent-communication-plugin";

/** What the tools call: the service's model-facing operations and nothing else. */
export type AgentCommunicationTools = Pick<AgentCommunicationService,
  "sidekicks" | "findSidekick" | "createSidekick" | "archiveSidekick" | "attachSidekickResource" | "start" | "list" | "send" | "stop"
  | "requestSidekickChange">;

/**
 * Appended only in a Canvas's Chat and its agents, where `create_sidekick` attaches what it
 * makes to this Canvas and `archive_sidekick` is offered. It says which write
 * recurring work should use, because the two are not equivalent: runs
 * overlap, so two that each republish a site lose one's change, while two
 * that each write a row do not.
 */
/**
 * `sidekickRun` adds `request_sidekick_change` and its guidance: a Sidekick
 * run child and the workers it started, which act with its authority
 * (`loopAuthority`), have a wizard of their own to ask.
 */
export function createAgentCommunicationPlugin(service: AgentCommunicationTools, roleGuidance: string,
  options: { sidekickRun?: boolean; canvasChat?: boolean } = {}): HarnessPlugin {
  function tool<T>(name: string, description: string, schema: z.ZodType<T>,
    execute: (input: T, context: Parameters<HarnessTool["execute"]>[1]) => Promise<unknown>): HarnessTool {
    return {
      definition: {
        name, description, inputSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
        capability: `agents.${name}`, mode: (name === "list_agents" || name === "sidekicks_list" || name === "find_sidekick") ? "read" : "write",
        idempotency: name === "list_agents" || name === "sidekicks_list" || name === "find_sidekick" ? "safe"
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
    displayName: "Background agents", description: "Delegate tasks to background agents, check their progress, and exchange messages with other agents. Find or create a Sidekick for scheduled or event-triggered work. Attach resources to a Sidekick without starting a run.",
    searchAliases: ["background", "delegate", "teammate", "send message", "reply", "subagent", "attach resource"],
    systemMessage: renderAgentCommunicationSystemMessage(roleGuidance, options),
    preload: true,
    tools: [
      tool("sidekicks_list", options.canvasChat
        ? "List the Sidekicks attached to this Canvas, each with its sidekickId, name, status, authoring agentId and whether this Canvas made it (madeHere). Everyone in this Canvas manages them: message that agentId to change one. Archive one this Canvas made with archive_sidekick. Reusable instructions are listed under Skills. A draft or sent setup request is not evidence of activation."
        : "List the Sidekick this conversation belongs to, marked isCurrentSidekick: true. Each item includes authoring agentId, status, nextRunAt and lastRunAt. Reusable instructions are listed under Skills. A draft or sent setup request is not evidence of activation.", z.strictObject({}), () => service.sidekicks()),
      tool("find_sidekick", "Find editable Sidekicks by the exact name the person explicitly asked to change, including personal or organization Sidekicks. Use only for a named edit, never for setup discovery. If several match, ask which one the person means.", z.strictObject({ name: z.string().min(1).describe("Exact Sidekick name from the person’s request.") }), (input) => service.findSidekick(input.name)),
      tool("create_sidekick", options.canvasChat
        ? "Create a Sidekick for this Canvas when none attached to it fits. It is attached to this Canvas, so its runs can update this Canvas's artifact. Returns its authoring agentId; send setup instructions to that agent next."
        : "Create a Sidekick when none you can edit fits. Returns its authoring agentId; send setup instructions to that agent next.", z.strictObject({ scope: z.enum(["personal", "workspace"]).default("personal").describe("personal (the default) belongs to the person asking. Choose workspace (organization) only when the person asks.") }), (input, context) => service.createSidekick(input.scope, context)),
      ...(options.canvasChat ? [tool("archive_sidekick", "Archive a Sidekick this Canvas made, so it stops running. Its conversation and run history stay stored. It cannot be undone from here.", z.strictObject({
        sidekick: z.string().min(1).max(300).describe("The sidekickId from sidekicks_list, or the Sidekick's exact name."),
      }), (input) => service.archiveSidekick(input.sidekick))] : []),
      tool("sidekick_attach_resource", "Attach one visible Rally resource so the Sidekick's wizard and future runs know which resource to use. Prefer this when adding context without sending instructions. Returns whether it was already attached. Sends no message and starts no run.", z.strictObject({
        sidekickId: IdSchema.describe("Copy sidekickId from sidekicks_list, find_sidekick or create_sidekick. Use the Sidekick UUID, not its agentId."),
        resourceId: IdSchema.describe("Copy a Rally resource UUID from list_resources. Forwarding requires a resource already attached or inherited here; a provider ID or URL is not accepted."),
      }), (input) => service.attachSidekickResource(input.sidekickId, input.resourceId)),
      tool("start_agent", "Delegate work to a new background agent. Returns its agentId at once. Include the full assignment and needed context.", StartAgentInputSchema, (input, context) => service.start(input, context)),
      tool("list_agents", "Find teammates: their agentId, name, description and execution status. Use it to choose whom to message or stop. To get a teammate's reply, wait for its message.", ListAgentsInputSchema, () => service.list()),
      tool("send_message", "Send instructions or an update to a teammate using agentId. Returns at once and resumes idle or stopped agents.", SendAgentMessageInputSchema, (input, context) => service.send(input, context)),
      tool("reply_to_message", "Send a response to the sender of a received message. Use that messageId, not an agentId. Returns at once.", ReplyToAgentMessageInputSchema, (input, context) => service.send(input, context)),
      tool("stop_agent", "Stop an agent you own and all agents it owns. Completed actions are not undone. A later message can resume the stopped agent.", StopAgentInputSchema, (input) => service.stop(input.agentId)),
      ...(options.sidekickRun ? [tool("request_sidekick_change", "Ask this Sidekick's wizard for a lasting change to the Sidekick, such as what it reports or how, when it runs, its sources, or who receives it. The wizard decides whether to apply it. Returns at once; its reply arrives as a message. Sending is not saving.", RequestSidekickChangeInputSchema, (input, context) => service.requestSidekickChange(input.changes, context))] : []),
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
