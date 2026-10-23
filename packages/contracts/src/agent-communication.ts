import { z } from "zod";
import { ConversationParentKindSchema } from "./conversation-parent";
import { IdSchema, SubstreamIdSchema } from "./identifiers";
import { MESSAGE_MAX_CHARACTERS } from "./message-limits";
import { SidekickAccountReferenceSchema } from "./sidekick-delegation";

/** A conversation address within the host's workspace, not a separately allocated agent identity. */
export const AgentAddressSchema = z.strictObject({
  parentKind: ConversationParentKindSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
});
export type AgentAddress = z.infer<typeof AgentAddressSchema>;

function parseAddress(value: string) {
  const parts = value.split("/");
  if (parts.length !== 3) return null;
  const parsed = AgentAddressSchema.safeParse({ parentKind: parts[0], parentId: parts[1], substreamId: parts[2] });
  return parsed.success ? parsed.data : null;
}

export const AgentIdSchema = z.string().refine((value) => parseAddress(value) !== null, {
  message: "Use an exact agentId returned by agent or Sidekick discovery.",
}).brand<"AgentId">();
export type AgentId = z.infer<typeof AgentIdSchema>;

/**
 * The two messages the host writes on a run's behalf, rather than a model
 * deciding to send one.
 *
 * They travel the ordinary delivery path, so without this the recipient cannot
 * tell them from a teammate's own message: both arrive as an agent exchange
 * carrying the worker's id. That difference is the whole content of the
 * notice — "this worker is done and said nothing" is not a message, it is an
 * outcome the owner may need to act on — and the feed draws it as one.
 */
export const AgentExchangeNoticeSchema = z.enum(["failed", "finished_without_reply"]);
export type AgentExchangeNotice = z.infer<typeof AgentExchangeNoticeSchema>;

/** Host routing context for the message that activated an execution. */
export const AgentExchangeSchema = z.strictObject({
  teamId: AgentIdSchema,
  messageId: IdSchema,
  senderAgentId: AgentIdSchema,
  /** Host-derived completed references within one Sidekick; absent on older messages. */
  sidekickAccountReferences: z.array(SidekickAccountReferenceSchema).optional(),
  /** Absent on a model-authored message, which is every message but two. */
  notice: AgentExchangeNoticeSchema.optional(),
  /**
   * The terminal diagnostic behind a `failed` notice.
   *
   * Carried as a field rather than left in the prose because the feed's row is
   * now the reader's whole record of the failure: it does not show the message
   * body, so a row reading only "1 background agent failed" would name no
   * reason and no worker — the generic code `CLAUDE.md` calls a defect rather
   * than a fallback. Absent on every other message, the `finished_without_reply`
   * notice included, which has no reason to give.
   */
  noticeReason: z.string().min(1).max(200).optional(),
});
export type AgentExchange = z.infer<typeof AgentExchangeSchema>;

export function agentIdForAddress(address: AgentAddress): AgentId {
  const parsed = AgentAddressSchema.parse(address);
  return AgentIdSchema.parse(`${parsed.parentKind}/${parsed.parentId}/${parsed.substreamId}`);
}

export function agentAddressForId(agentId: AgentId): AgentAddress {
  return AgentAddressSchema.parse(parseAddress(agentId));
}

/**
 * How a model reads and writes an agent id. A Sidekick's conversations are
 * stored under the parent kind `automation`, a word left over from before the
 * rename that a model has no reason to connect to a Sidekick; it reads
 * `sidekick/…` instead. Storage keeps `automation/…`: the id keys the team
 * tables and seeds delivery ids, so only the model's side of the tool boundary
 * is translated.
 */
export function modelAgentId(agentId: string): string {
  return agentId.startsWith("automation/") ? `sidekick/${agentId.slice("automation/".length)}` : agentId;
}

/**
 * An agent id a model wrote, back in stored form. Both spellings are accepted
 * because tool results from before the translation still show `automation/…`.
 */
export const ModelAgentIdSchema = z.string()
  .transform((value) => value.startsWith("sidekick/") ? `automation/${value.slice("sidekick/".length)}` : value)
  .pipe(AgentIdSchema);

const MessageFields = {
  message: z.string().max(MESSAGE_MAX_CHARACTERS).describe("Tell the recipient what to do or provide your response. Include the context it needs."),
  // Same identifiers, default and bound as SubstreamOpeningMessageSchema.
  attachmentIds: z.array(IdSchema).max(10).default([])
    .describe("Prefer including the task's resources so the recipient knows which ones to use. Use Rally resource IDs already attached or inherited in this conversation. This forwards actual attachments; mentioning an ID in message text does not share it. Omit when no resources need forwarding."),
};
const hasContent = (value: { message: string; attachmentIds: string[] }) =>
  value.message.trim().length > 0 || value.attachmentIds.length > 0;
const contentError = { message: "Include a message or at least one attachment." };

export const StartAgentInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(500).describe("Give the agent a short name so teammates can recognize it."),
  description: z.string().trim().min(1).max(4_000).describe("Describe the agent’s job for teammates. Put the full assignment in message."),
  ...MessageFields,
}).refine(hasContent, contentError);
// `next` is where the delivery contract lives: the reply arrives as a message
// whether the model keeps working or finishes, and there is no tool to fetch
// it. It is result text because a result is read at the moment the model
// decides its next step.
export const StartAgentResultSchema = z.strictObject({ agentId: AgentIdSchema, name: z.string(), next: z.string() });
export const ListAgentsInputSchema = z.strictObject({});
export const SendAgentMessageInputSchema = z.strictObject({
  agentId: ModelAgentIdSchema.describe("Copy the recipient’s agentId from creation or discovery. Do not use a Sidekick ID."),
  ...MessageFields,
}).refine(hasContent, contentError);
export const ReplyToAgentMessageInputSchema = z.strictObject({
  messageId: IdSchema.describe("Copy Message ID from the message you received. The response goes to its sender."),
  ...MessageFields,
}).refine(hasContent, contentError);
export const AgentMessageResultSchema = z.strictObject({ messageId: IdSchema, next: z.string() });
export const StopAgentInputSchema = z.strictObject({
  agentId: ModelAgentIdSchema.describe("Copy the agentId of an agent you own. Its owned descendants also stop."),
});

export type StartAgentInput = z.infer<typeof StartAgentInputSchema>;
export type StartAgentResult = z.infer<typeof StartAgentResultSchema>;
export type AgentMessageResult = z.infer<typeof AgentMessageResultSchema>;
export type SendAgentMessageInput = z.infer<typeof SendAgentMessageInputSchema>;
export type ReplyToAgentMessageInput = z.infer<typeof ReplyToAgentMessageInputSchema>;

/**
 * The structured-content kind an admitted agent-to-agent message carries.
 *
 * The API writes it onto the message it admits and the client reads it to
 * decide the row that message gets, so the literal lives here rather than in
 * either of them: a rename that reached only one side would quietly turn every
 * agent message back into an anonymous system note, which is the state this
 * constant exists to stop returning to.
 */
// `as const` rather than a bare `const`: the latter produces a widening
// literal, so an object literal built with it gets `kind: string` and stops
// satisfying the schema this constant exists to be the single spelling for.
export const AGENT_MESSAGE_CONTENT_KIND = "agent_message" as const;

/**
 * The tools whose subject is something other than the plugin carrying them, by
 * the name the transcript stores.
 *
 * `createAgentCommunicationPlugin` declares `shortWireName: ""`, so these are
 * its tool names unprefixed. Three of that plugin's seven are about a message
 * or a worker rather than about Rally reaching for a tool; `list_agents`,
 * `stop_agent`, `sidekicks_list` and `create_sidekick` are the reader using
 * the plugin and stay on its own row.
 *
 * They are named here rather than beside either consumer because both need
 * them: the API asks whether a run handed off before telling its owner the run
 * said nothing, and the client asks which row a call belongs to. The API held
 * the only copy until the client needed it, and briefly there were two; this
 * is the one. The caveat is the one `isConnectorConnectionCardWireName`
 * carries: a client older than a rename reads the new spelling as ordinary
 * Background agents activity, losing the row rather than the work.
 */
export const AGENT_MESSAGE_TOOL_NAMES = ["send_message", "reply_to_message"] as const;

/** The tool that starts a worker. Its own row, for the same reason. */
export const AGENT_START_TOOL_NAME = "start_agent";

/**
 * What the same three tools were called before the plugin dropped its wire
 * prefix, and before `reply_to_message` was renamed from `reply`.
 *
 * A stored row keeps the name it was written under — `tool_activity.ts` keeps
 * the retired spellings registered for exactly this reason, so an old row and
 * a new one for the same action still read alike — so a predicate that knows
 * only the current names silently drops every historical call back onto the
 * generic plugin row.
 *
 * It matters more than presentation on `tool_effects`, which the hand-off
 * query reads: a run that spans the rename can settle with an old completed
 * spelling, and a query blind to it reports a worker that did reply as having
 * finished without replying. That was already true before these names moved
 * here; recognizing the aliases fixes it in the one place both callers read.
 *
 * `agents_reply` rather than `agents_reply_to_message`: the prefix was dropped
 * and the tool renamed in separate changes, so no row was ever written under
 * the combination. The derived spelling is listed anyway — it costs a string
 * and removes the need to be right about that ordering.
 */
const AGENT_MESSAGE_TOOL_NAME_ALIASES = [
  "agents_send_message",
  "agents_reply",
  "agents_reply_to_message",
] as const;
const AGENT_START_TOOL_NAME_ALIASES = ["agents_start_agent"] as const;

/**
 * The tools whose completed use means a run handed work or findings to another
 * agent, so its owner is not told it finished without replying: a message, or
 * a delegation the run then ends its turn to wait on. Retired spellings
 * included, because this list is matched against stored effects.
 */
export const AGENT_HANDOFF_TOOL_NAMES = [
  ...AGENT_MESSAGE_TOOL_NAMES,
  ...AGENT_MESSAGE_TOOL_NAME_ALIASES,
  AGENT_START_TOOL_NAME,
  ...AGENT_START_TOOL_NAME_ALIASES,
] as const;

const AGENT_MESSAGE_TOOL_NAME_SET: ReadonlySet<string> = new Set([
  ...AGENT_MESSAGE_TOOL_NAMES,
  ...AGENT_MESSAGE_TOOL_NAME_ALIASES,
]);
const AGENT_START_TOOL_NAME_SET: ReadonlySet<string> = new Set([
  AGENT_START_TOOL_NAME,
  ...AGENT_START_TOOL_NAME_ALIASES,
]);

/** True for a tool call whose subject is a message to a teammate. */
export function isAgentMessageSendWireName(name: string | undefined): boolean {
  return name !== undefined && AGENT_MESSAGE_TOOL_NAME_SET.has(name);
}

/** True for a tool call whose subject is a worker being started. */
export function isAgentStartWireName(name: string | undefined): boolean {
  return name !== undefined && AGENT_START_TOOL_NAME_SET.has(name);
}

/** True for the structured content an admitted agent-to-agent message carries. */
export function isAgentMessageContent(
  structuredContent: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  return structuredContent?.["kind"] === AGENT_MESSAGE_CONTENT_KIND;
}

/**
 * Which host notice an admitted message is, or null for the model-authored
 * majority.
 *
 * Read through here rather than off the key, so the one place that spells
 * `notice` is the schema's own file. A message stored before the field existed
 * reads as null, which is the right answer for it: nothing distinguished the
 * two notices then, and that is what this closes.
 */
export function agentMessageNotice(
  structuredContent: Readonly<Record<string, unknown>> | null | undefined,
): AgentExchangeNotice | null {
  if (!isAgentMessageContent(structuredContent)) return null;
  const parsed = AgentExchangeNoticeSchema.safeParse(structuredContent?.["notice"]);
  return parsed.success ? parsed.data : null;
}

/**
 * The diagnostic behind a `failed` notice, or null.
 *
 * Sanitized to the character class a code is written in rather than passed
 * through: the value reaches a row in the feed, and an adapter's own text can
 * end up in a terminal diagnostic. Formatting, not redaction — the reason is
 * the host's own computed code, which is exactly what the reader needs named.
 */
export function agentMessageNoticeReason(
  structuredContent: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (agentMessageNotice(structuredContent) !== "failed") return null;
  const raw = structuredContent?.["noticeReason"];
  if (typeof raw !== "string") return null;
  const code = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
  return code.length === 0 ? null : code.slice(0, 80);
}
