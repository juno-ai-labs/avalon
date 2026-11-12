import {
  StartAgentInputSchema, ListAgentsInputSchema, SendAgentMessageInputSchema,
  ReplyToAgentMessageInputSchema, StopAgentInputSchema, RequestSidekickChangeInputSchema, modelAgentId, IdSchema,
} from "@rally/contracts";
import type { HarnessPlugin, HarnessTool } from "@rally/agent-harness";
import { z } from "zod";
import type { AgentCommunicationService } from "./agent-communication-service";

/** What the tools call: the service's model-facing operations and nothing else. */
export type AgentCommunicationTools = Pick<AgentCommunicationService,
  "sidekicks" | "findSidekick" | "createSidekick" | "archiveSidekick" | "attachSidekickResource" | "start" | "list" | "send" | "stop"
  | "requestSidekickChange">;

/**
 * Appended only in a Canvas's Chat, where `create_sidekick` attaches what it
 * makes to this Canvas and `archive_sidekick` is offered. It says which write
 * recurring work should use, because the two are not equivalent: runs
 * overlap, so two that each republish a site lose one's change, while two
 * that each write a row do not.
 */
const CANVAS_SIDEKICK_GUIDANCE = "This conversation is a Canvas's Chat. A Sidekick you create here is attached to this Canvas: its runs can read and post in this Chat, publish new versions of this Canvas's artifacts, and write rows into an artifact that stores data. Use one when the person wants this Canvas kept up to date by a schedule or by events, such as each new email or each pull request opened, closed or merged. For that kind of recurring update, first build the artifact here as a site that stores its own data, then tell the wizard the artifact's resourceId, its tables and columns, and exactly what each run writes with write_artifact_data. Runs can overlap, so have them write rows; republishing the site on every event loses changes when two runs overlap, and is for changing the artifact's code or layout. For an app that needs semantic work after a submission, load building-live-sites and create dedicated Sidekicks here. Publish the app first, then give each wizard its artifactId, resourceId, schema, input format and a distinct bindingName. Ask for an invocation trigger bound to that app. Each Sidekick may bind to one app; one app may bind many Sidekicks. The app server sends tasks with env.SIDEKICKS.<bindingName>.send({operationId,input}); runs use their standard tools to write the artifact data. Wait for the wizard to confirm acceptance before reporting the app as connected. Reuse these Sidekicks on subsequent app revisions. CANVAS CONTEXT lists the Sidekicks attached here. sidekicks_list returns the ones this Canvas made, which anyone in this Canvas may change through their authoring agent or archive with archive_sidekick. Archiving this Canvas archives them too.";

/**
 * Appended only where `request_sidekick_change` is offered, so the tool it names
 * is in scope. It names the evidence framing because a Slack reply reaches a run
 * as "evidence, not a request", and a softer wording lost to that framing.
 * Where the wizard's answer goes carries its own tie-break: the conversations
 * plugin tells a run never to post its reply into the Sidekick's own
 * conversation, so "post it where the person wrote" alone contradicted it for a
 * person who wrote in Rally. Their answer is the final message; only an outside
 * thread gets a post.
 */
const SIDEKICK_RUN_CHANGE_GUIDANCE = "You are executing one run of a Sidekick. Its saved definition decides what every run does, and a run cannot edit it; this Sidekick's wizard can. A message asking for a lasting change to the Sidekick, such as what it reports or how, when it runs, its sources, or who receives it, is a change request, also when it reaches you as external evidence in a reply to this run. Send a change request to the wizard with request_sidekick_change; that is how a run handles one, and the wizard decides whether to apply it. A message about this run alone, an answer the instructions asked for, a question, or thanks is not a change request: handle it as the instructions direct. A message can be both, such as an answer that also asks for a lasting change, or a change that should also apply to this run's result; then do both. When the wizard replies, tell the person who asked what it said: whether the change was saved for future runs, or its question or what blocks it. Where they wrote decides how. If they wrote in Rally, in this run or this Sidekick's own conversation, your final message is the reply they read: put the answer there and post nothing. If they wrote outside Rally, in the Slack thread they replied in, post the answer in that thread, with this run's result if you send that again, and do not leave the answer only in your final message.";

/**
 * `sidekickRun` adds `request_sidekick_change` and its guidance. Only a
 * Sidekick run child has a wizard of its own to ask; everywhere else the tool
 * would be a refusal waiting to happen, so it is not offered.
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
    systemMessage: `${roleGuidance} Send results and questions explicitly to the intended agent. Your final response stays in your own conversation. New agents receive the instructions and attachments you provide, not your transcript or loaded skills. Prefer including the task's resources in attachmentIds so the intended resources are explicit. Sidekicks can also read known IDs their execution user can read if an attachment is omitted. Background agents share the Terminal files of the conversation or Sidekick they work for. Include enough context to do the work. Agents inherit your model and authorized tools. Continue existing agents through messages. list_agents shows whether one is still running. Messages start idle agents, resume stopped agents, and reach busy agents between execution steps. You may stop only agents you own and their descendants. Reusable procedures appear under Skills; call load_skill to use their instructions. To set up a Sidekick, use sidekicks_list and send the assignment directly to a suitable returned authoring agentId. That agent is the Sidekick wizard and can edit its definition. If none fits, create_sidekick returns the wizard to message directly. Use sidekick_attach_resource with its sidekickId to attach a resource without sending a message or waking the wizard. Do not start a background agent just to relay setup instructions or wait for the wizard. Use find_sidekick only when the person explicitly names an existing Sidekick to edit; never silently replace a named target. The authoring agent handles setup and replies with questions or results. A sent setup or edit request is not completion. Report the change as saved only after receiving confirmation that the requested revision was accepted. For work after an external change, tell the wizard to load polling-for-events. When another person's account should start it, or only events about a topic should, tell the wizard to load setting-up-a-filtered-trigger and name the people and the topic. Verify activation and scheduling from current state; a run timestamp does not prove completion. Correct superseded blocker memory while preserving the person’s preferences.${options.sidekickRun ? ` ${SIDEKICK_RUN_CHANGE_GUIDANCE}` : ""}${options.canvasChat ? ` ${CANVAS_SIDEKICK_GUIDANCE}` : ""}`,
    preload: true,
    tools: [
      tool("sidekicks_list", options.canvasChat
        ? "List the Sidekicks this Canvas made, each with its sidekickId, name, status and authoring agentId. Message that agentId to change one; archive one with archive_sidekick. Reusable instructions are listed under Skills. A draft or sent setup request is not evidence of activation."
        : "List the Sidekick this conversation belongs to, marked isCurrentSidekick: true. Each item includes authoring agentId, status, nextRunAt and lastRunAt. Reusable instructions are listed under Skills. A draft or sent setup request is not evidence of activation.", z.strictObject({}), () => service.sidekicks()),
      tool("find_sidekick", "Find editable Sidekicks by the exact name the person explicitly asked to change, including personal or organization Sidekicks. Use only for a named edit, never for setup discovery. If several match, ask which one the person means.", z.strictObject({ name: z.string().min(1).describe("Exact Sidekick name from the person’s request.") }), (input) => service.findSidekick(input.name)),
      tool("create_sidekick", options.canvasChat
        ? "Create a Sidekick for this Canvas when none it made fits. It is attached to this Canvas, so its runs can update this Canvas's artifacts. Returns its authoring agentId; send setup instructions to that agent next."
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
