import type { ConnectorSurfaceRuntimeStatus } from "@rally/contracts";
import { httpsUrlSchema } from "@rally/contracts/url-schemas";
import { z } from "zod";
import {
  booleanValue,
  isRecord,
  jsonHeaders,
  providerJson,
  recordValue,
  stringValue,
  type FetchLike,
} from "./provider-utils";
import { ConnectorError } from "./types";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_AGENT_RESPONSE_BYTES = 512_000;
const LINEAR_AGENT_BODY_CHARS = 40_000;
const LINEAR_AGENT_ID_CHARS = 200;
const LINEAR_AGENT_URL_CHARS = 2_048;

export const LINEAR_AGENT_ACKNOWLEDGEMENT_EMOJI = "👀" as const;

const idSchema = z.string().min(1).max(LINEAR_AGENT_ID_CHARS);
const dateTimeSchema = z.string().min(1).max(100);
const markdownSchema = z.string().min(1).max(LINEAR_AGENT_BODY_CHARS);
const jsonObjectSchema = z.record(z.string(), z.unknown());

const userSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(500),
  email: z.string().email().max(500),
  url: httpsUrlSchema(LINEAR_AGENT_URL_CHARS),
  avatarUrl: httpsUrlSchema(LINEAR_AGENT_URL_CHARS).nullable().optional(),
}).passthrough();

const commentSchema = z.object({
  id: idSchema,
  body: z.string().max(LINEAR_AGENT_BODY_CHARS),
  documentContentId: idSchema.nullable().optional(),
  initiativeId: idSchema.nullable().optional(),
  initiativeUpdateId: idSchema.nullable().optional(),
  issueId: idSchema.nullable().optional(),
  projectId: idSchema.nullable().optional(),
  projectUpdateId: idSchema.nullable().optional(),
  userId: idSchema.nullable().optional(),
}).passthrough();

const issueSchema = z.object({
  id: idSchema,
  identifier: z.string().min(1).max(100),
  teamId: idSchema,
  title: z.string().min(1).max(1_000),
  description: z.string().max(LINEAR_AGENT_BODY_CHARS).nullable().optional(),
  url: httpsUrlSchema(LINEAR_AGENT_URL_CHARS),
  team: z.object({ id: idSchema }).passthrough(),
}).passthrough();

const sessionSchema = z.object({
  id: idSchema,
  appUserId: idSchema,
  organizationId: idSchema,
  status: z.enum(["pending", "active", "error", "awaitingInput", "complete", "stale"]),
  type: z.string().min(1).max(100),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  archivedAt: dateTimeSchema.nullable().optional(),
  commentId: idSchema.nullable().optional(),
  comment: commentSchema.nullable().optional(),
  creatorId: idSchema.nullable().optional(),
  creator: userSchema.nullable().optional(),
  endedAt: dateTimeSchema.nullable().optional(),
  issueId: idSchema.nullable().optional(),
  issue: issueSchema.nullable().optional(),
  sourceCommentId: idSchema.nullable().optional(),
  sourceMetadata: jsonObjectSchema.nullable().optional(),
  startedAt: dateTimeSchema.nullable().optional(),
  summary: z.string().max(LINEAR_AGENT_BODY_CHARS).nullable().optional(),
  url: httpsUrlSchema(LINEAR_AGENT_URL_CHARS).nullable().optional(),
}).passthrough();

const promptContentSchema = z.object({
  type: z.literal("prompt"),
  body: markdownSchema,
  title: z.string().max(500).nullable().optional(),
}).passthrough();

const agentActivityWebhookSchema = z.object({
  id: idSchema,
  agentSessionId: idSchema,
  content: jsonObjectSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  archivedAt: dateTimeSchema.nullable().optional(),
  signal: z.enum(["stop", "continue", "auth", "select"]).nullable().optional(),
  signalMetadata: jsonObjectSchema.nullable().optional(),
  sourceCommentId: idSchema.nullable().optional(),
  userId: idSchema,
  user: userSchema,
}).passthrough();

const guidanceSchema = z.object({
  body: z.string().max(LINEAR_AGENT_BODY_CHARS),
  origin: jsonObjectSchema,
}).passthrough();

/**
 * The signed payload Linear sends when its native agent UI starts or resumes a
 * session. Unknown fields are retained so Developer Preview additions do not
 * silently disappear before the regional runtime persists the source payload.
 */
export const LinearAgentSessionEventSchema = z.object({
  type: z.literal("AgentSessionEvent"),
  action: z.enum(["created", "prompted"]),
  appUserId: idSchema,
  oauthClientId: idSchema,
  organizationId: idSchema,
  webhookId: idSchema,
  webhookTimestamp: z.number().int().nonnegative(),
  createdAt: dateTimeSchema,
  agentSession: sessionSchema,
  agentActivity: agentActivityWebhookSchema.nullable().optional(),
  guidance: z.array(guidanceSchema).max(200).nullable().optional(),
  previousComments: z.array(commentSchema).max(500).nullable().optional(),
  promptContext: z.string().max(200_000).nullable().optional(),
}).passthrough().superRefine((event, context) => {
  if (event.agentSession.organizationId !== event.organizationId) {
    context.addIssue({ code: "custom", message: "The agent session organization does not match the webhook organization", path: ["agentSession", "organizationId"] });
  }
  if (event.agentSession.appUserId !== event.appUserId) {
    context.addIssue({ code: "custom", message: "The agent session app user does not match the webhook app user", path: ["agentSession", "appUserId"] });
  }
  if (event.agentActivity && event.agentActivity.agentSessionId !== event.agentSession.id) {
    context.addIssue({ code: "custom", message: "The prompt activity belongs to a different agent session", path: ["agentActivity", "agentSessionId"] });
  }
  if (event.action === "created" && !event.promptContext?.trim()) {
    context.addIssue({ code: "custom", message: "A created agent session must include prompt context", path: ["promptContext"] });
  }
  if (event.action === "prompted") {
    if (!event.agentActivity) {
      context.addIssue({ code: "custom", message: "A prompted agent session must include the prompt activity", path: ["agentActivity"] });
      return;
    }
    const prompt = promptContentSchema.safeParse(event.agentActivity.content);
    if (!prompt.success) {
      context.addIssue({ code: "custom", message: "A prompted agent session must contain a prompt activity body", path: ["agentActivity", "content"] });
    }
  }
});

export type LinearAgentSessionEvent = z.infer<typeof LinearAgentSessionEventSchema>;

/** Structural bridge from verifyLinearWebhook without coupling this module to linear.ts. */
export const VerifiedLinearAgentSessionEventSchema = z.object({
  deliveryId: z.string().uuid(),
  eventName: z.literal("AgentSessionEvent"),
  organizationId: idSchema,
  webhookId: idSchema,
  webhookTimestamp: z.number().int().nonnegative(),
  bodyHash: z.string().regex(/^[0-9a-f]{64}$/iu),
  event: LinearAgentSessionEventSchema,
}).superRefine((verified, context) => {
  for (const [field, expected, actual] of [
    ["organizationId", verified.organizationId, verified.event.organizationId],
    ["webhookId", verified.webhookId, verified.event.webhookId],
    ["webhookTimestamp", verified.webhookTimestamp, verified.event.webhookTimestamp],
  ] as const) {
    if (expected !== actual) {
      context.addIssue({ code: "custom", message: `Verified ${field} does not match the agent event`, path: ["event", field] });
    }
  }
});

export type VerifiedLinearAgentSessionEvent = z.infer<typeof VerifiedLinearAgentSessionEventSchema>;

export function parseLinearAgentSessionEvent(payload: unknown): LinearAgentSessionEvent {
  return LinearAgentSessionEventSchema.parse(payload);
}

export function parseVerifiedLinearAgentSessionEvent(payload: unknown): VerifiedLinearAgentSessionEvent {
  return VerifiedLinearAgentSessionEventSchema.parse(payload);
}

export type LinearAgentInvocation =
  | {
      kind: "start";
      sessionId: string;
      organizationId: string;
      appUserId: string;
      prompt: string;
      issueId: string | null;
      commentId: string | null;
      acknowledgement: LinearAgentAcknowledgement | null;
      event: LinearAgentSessionEvent;
    }
  | {
      kind: "prompt";
      sessionId: string;
      organizationId: string;
      appUserId: string;
      prompt: string;
      promptActivityId: string;
      stopRequested: boolean;
      acknowledgement: LinearAgentAcknowledgement | null;
      event: LinearAgentSessionEvent;
    };

export const LinearAgentAcknowledgementSchema = z.object({
  commentId: idSchema,
  emoji: z.literal(LINEAR_AGENT_ACKNOWLEDGEMENT_EMOJI),
}).strict();

export type LinearAgentAcknowledgement = z.infer<typeof LinearAgentAcknowledgementSchema>;

/** Converts a provider webhook into the two commands Rally's run coordinator handles. */
export function linearAgentInvocation(eventInput: unknown): LinearAgentInvocation {
  const event = parseLinearAgentSessionEvent(eventInput);
  if (event.action === "created") {
    return {
      kind: "start",
      sessionId: event.agentSession.id,
      organizationId: event.organizationId,
      appUserId: event.appUserId,
      prompt: event.promptContext!.trim(),
      issueId: event.agentSession.issueId ?? null,
      commentId: event.agentSession.commentId ?? null,
      acknowledgement: acknowledgementForComment(
        event.agentSession.sourceCommentId ?? event.agentSession.commentId,
      ),
      event,
    };
  }
  const activity = event.agentActivity!;
  const content = promptContentSchema.parse(activity.content);
  return {
    kind: "prompt",
    sessionId: event.agentSession.id,
    organizationId: event.organizationId,
    appUserId: event.appUserId,
    prompt: content.body,
    promptActivityId: activity.id,
    stopRequested: activity.signal === "stop",
    acknowledgement: activity.signal === "stop"
      ? null
      : acknowledgementForComment(activity.sourceCommentId),
    event,
  };
}

function acknowledgementForComment(commentId: string | null | undefined): LinearAgentAcknowledgement | null {
  return commentId
    ? { commentId, emoji: LINEAR_AGENT_ACKNOWLEDGEMENT_EMOJI }
    : null;
}

export function linearAgentActivationAcknowledgement(
  invocation: LinearAgentInvocation,
): LinearAgentProtocolCommand | null {
  return invocation.acknowledgement
    ? { kind: "acknowledge", acknowledgement: invocation.acknowledgement }
    : null;
}

export function isLinearAgentStopRequest(eventInput: unknown): boolean {
  const invocation = linearAgentInvocation(eventInput);
  return invocation.kind === "prompt" && invocation.stopRequested;
}

export const LinearAgentThoughtContentSchema = z.object({
  type: z.literal("thought"),
  body: markdownSchema,
}).strict();

export const LinearAgentActionContentSchema = z.object({
  type: z.literal("action"),
  action: z.string().min(1).max(500),
  parameter: z.string().min(1).max(2_000),
  result: z.string().max(LINEAR_AGENT_BODY_CHARS).optional(),
}).strict();

export const LinearAgentElicitationContentSchema = z.object({
  type: z.literal("elicitation"),
  body: markdownSchema,
}).strict();

export const LinearAgentResponseContentSchema = z.object({
  type: z.literal("response"),
  body: markdownSchema,
}).strict();

export const LinearAgentErrorContentSchema = z.object({
  type: z.literal("error"),
  body: markdownSchema,
  reasonCode: z.string().min(1).max(200).optional(),
}).strict();

export const LinearAgentActivityContentSchema = z.discriminatedUnion("type", [
  LinearAgentThoughtContentSchema,
  LinearAgentActionContentSchema,
  LinearAgentElicitationContentSchema,
  LinearAgentResponseContentSchema,
  LinearAgentErrorContentSchema,
]);

export type LinearAgentActivityContent = z.infer<typeof LinearAgentActivityContentSchema>;

const authSignalMetadataSchema = z.object({
  url: httpsUrlSchema(LINEAR_AGENT_URL_CHARS),
  userId: idSchema.optional(),
  providerName: z.string().min(1).max(200).optional(),
}).strict();

const selectSignalMetadataSchema = z.object({
  options: z.array(z.object({
    label: z.string().min(1).max(500).optional(),
    value: z.string().min(1).max(2_000),
  }).strict().refine((option) => Boolean(option.label || option.value), "A select option must have a label or value")).min(1).max(100),
}).strict();

export const LinearAgentActivityCreateInputSchema = z.object({
  agentSessionId: idSchema,
  id: z.string().uuid().optional(),
  content: LinearAgentActivityContentSchema,
  ephemeral: z.boolean().optional(),
  signal: z.enum(["auth", "select"]).optional(),
  signalMetadata: jsonObjectSchema.optional(),
}).strict().superRefine((activity, context) => {
  if (activity.ephemeral && activity.content.type !== "thought" && activity.content.type !== "action") {
    context.addIssue({ code: "custom", message: "Only thought and action activities may be ephemeral", path: ["ephemeral"] });
  }
  if (activity.signal && activity.content.type !== "elicitation") {
    context.addIssue({ code: "custom", message: "Agent-to-human signals require an elicitation activity", path: ["signal"] });
  }
  if (!activity.signal && activity.signalMetadata) {
    context.addIssue({ code: "custom", message: "Signal metadata requires a signal", path: ["signalMetadata"] });
  }
  if (activity.signal === "auth" && !authSignalMetadataSchema.safeParse(activity.signalMetadata).success) {
    context.addIssue({ code: "custom", message: "The auth signal requires a valid account-linking URL", path: ["signalMetadata"] });
  }
  if (activity.signal === "select" && !selectSignalMetadataSchema.safeParse(activity.signalMetadata).success) {
    context.addIssue({ code: "custom", message: "The select signal requires at least one valid option", path: ["signalMetadata"] });
  }
});

export type LinearAgentActivityCreateInput = z.infer<typeof LinearAgentActivityCreateInputSchema>;

export const LinearAgentExternalUrlSchema = z.object({
  label: z.string().min(1).max(200),
  url: httpsUrlSchema(LINEAR_AGENT_URL_CHARS),
}).strict();

export const LinearAgentPlanStepSchema = z.object({
  content: z.string().min(1).max(2_000),
  status: z.enum(["pending", "inProgress", "completed", "canceled"]),
}).strict();

export type LinearAgentExternalUrl = z.infer<typeof LinearAgentExternalUrlSchema>;
export type LinearAgentPlanStep = z.infer<typeof LinearAgentPlanStepSchema>;

export type LinearAgentProtocolCommand =
  | { kind: "acknowledge"; acknowledgement: LinearAgentAcknowledgement }
  | { kind: "publish_activity"; activity: LinearAgentActivityCreateInput }
  | { kind: "replace_external_urls"; agentSessionId: string; externalUrls: LinearAgentExternalUrl[] }
  | { kind: "patch_external_urls"; agentSessionId: string; addedExternalUrls: LinearAgentExternalUrl[]; removedExternalUrls: string[] }
  | { kind: "replace_plan"; agentSessionId: string; plan: LinearAgentPlanStep[] }
  | { kind: "create_session_on_issue"; issueId: string; externalUrls?: LinearAgentExternalUrl[] }
  | { kind: "create_session_on_comment"; commentId: string; externalUrls?: LinearAgentExternalUrl[] };

export interface LinearAgentActivityResult {
  success: true;
  agentActivityId: string;
}

export interface LinearAgentAcknowledgementResult {
  success: true;
  reactionId: string;
}

export interface LinearAgentSessionResult {
  success: true;
  agentSessionId: string;
  status: string;
}

export type LinearAgentProtocolResult =
  | LinearAgentAcknowledgementResult
  | LinearAgentActivityResult
  | LinearAgentSessionResult;

export type LinearAgentGraphqlExecutor = (
  document: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

/**
 * First-class connector protocol metadata. These operations belong to the
 * runtime control plane and must not be exposed as unrestricted model tools.
 */
export const LinearNativeAgentProtocolDescriptor = {
  kind: "native_agent",
  provider: "linear",
  capability: "linear.agent",
  maturity: "preview",
  runtimeStatus: "protocol_only" as ConnectorSurfaceRuntimeStatus,
  sessionOwnership: "single_connection_per_provider_account",
  oauthScopes: ["app:assignable", "app:mentionable", "write"],
  webhookResourceTypes: ["AgentSessionEvent"],
  inboundActions: ["created", "prompted"],
  outboundActivityTypes: ["thought", "action", "elicitation", "response", "error"],
  inboundSignals: ["stop"],
  outboundSignals: ["auth", "select"],
  acknowledgementEmoji: LINEAR_AGENT_ACKNOWLEDGEMENT_EMOJI,
  supportsProactiveSessions: true,
  webhookResponseDeadlineMs: 5_000,
  sessionAcknowledgementDeadlineMs: 10_000,
} as const;

export interface LinearNativeAgentProtocol {
  readonly descriptor: typeof LinearNativeAgentProtocolDescriptor;
  parseEvent(payload: unknown): LinearAgentSessionEvent;
  toInvocation(payload: unknown): LinearAgentInvocation;
  execute(command: LinearAgentProtocolCommand, signal?: AbortSignal): Promise<LinearAgentProtocolResult>;
}

export function createLinearNativeAgentProtocol(executeGraphql: LinearAgentGraphqlExecutor): LinearNativeAgentProtocol {
  return {
    descriptor: LinearNativeAgentProtocolDescriptor,
    parseEvent: parseLinearAgentSessionEvent,
    toInvocation: linearAgentInvocation,
    async execute(command, signal) {
      if (command.kind === "acknowledge") {
        return createLinearAgentAcknowledgement(executeGraphql, command.acknowledgement, signal);
      }
      if (command.kind === "publish_activity") {
        return createLinearAgentActivity(executeGraphql, command.activity, signal);
      }
      if (command.kind === "replace_external_urls") {
        return updateLinearAgentSession(executeGraphql, command.agentSessionId, {
          externalUrls: validateExternalUrls(command.externalUrls),
        }, signal);
      }
      if (command.kind === "patch_external_urls") {
        const removedExternalUrls = z.array(httpsUrlSchema(LINEAR_AGENT_URL_CHARS)).max(100).parse(command.removedExternalUrls);
        return updateLinearAgentSession(executeGraphql, command.agentSessionId, {
          addedExternalUrls: validateExternalUrls(command.addedExternalUrls),
          removedExternalUrls,
        }, signal);
      }
      if (command.kind === "replace_plan") {
        const plan = z.array(LinearAgentPlanStepSchema).max(100).parse(command.plan);
        return updateLinearAgentSession(executeGraphql, command.agentSessionId, { plan }, signal);
      }
      if (command.kind === "create_session_on_issue") {
        return createLinearAgentSession(executeGraphql, "issue", command.issueId, command.externalUrls, signal);
      }
      return createLinearAgentSession(executeGraphql, "comment", command.commentId, command.externalUrls, signal);
    },
  };
}

export async function executeLinearAgentGraphql(
  fetcher: FetchLike,
  accessToken: string,
  document: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!accessToken) throw new ConnectorError("unauthorized", "A Linear access token is required");
  const payload = await providerJson(fetcher, LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({ query: document, variables }),
    ...(signal ? { signal } : {}),
  }, LINEAR_AGENT_RESPONSE_BYTES);
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors.find(isRecord);
    throw new ConnectorError("provider_error", first ? stringValue(first, "message") ?? "Linear rejected the agent operation" : "Linear rejected the agent operation", {
      errors,
    });
  }
  const data = recordValue(payload, "data");
  if (!data) throw new ConnectorError("provider_error", "Linear did not return GraphQL data");
  return data;
}

export async function createLinearAgentActivity(
  executeGraphql: LinearAgentGraphqlExecutor,
  rawInput: LinearAgentActivityCreateInput,
  signal?: AbortSignal,
): Promise<LinearAgentActivityResult> {
  const input = LinearAgentActivityCreateInputSchema.parse(rawInput);
  const data = await executeGraphql(`
    mutation RallyLinearAgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
        agentActivity { id }
      }
    }
  `, { input }, signal);
  const payload = successfulMutation(data, "agentActivityCreate", "agent activity");
  const activity = requiredRecord(payload, "agentActivity", "Linear did not return the created agent activity");
  return { success: true, agentActivityId: requiredString(activity, "id", "Linear did not return the agent activity ID") };
}

/**
 * Host-owned activation acknowledgement. The coordinating runtime dispatches
 * this before model or tool work so recognition never depends on agent output.
 */
export async function createLinearAgentAcknowledgement(
  executeGraphql: LinearAgentGraphqlExecutor,
  rawInput: LinearAgentAcknowledgement,
  signal?: AbortSignal,
): Promise<LinearAgentAcknowledgementResult> {
  const input = LinearAgentAcknowledgementSchema.parse(rawInput);
  const data = await executeGraphql(`
    mutation RallyLinearAgentAcknowledge($input: ReactionCreateInput!) {
      reactionCreate(input: $input) {
        success
        reaction { id }
      }
    }
  `, { input }, signal);
  const payload = successfulMutation(data, "reactionCreate", "agent acknowledgement");
  const reaction = requiredRecord(payload, "reaction", "Linear did not return the created reaction");
  return {
    success: true,
    reactionId: requiredString(reaction, "id", "Linear did not return the reaction ID"),
  };
}

export async function updateLinearAgentSession(
  executeGraphql: LinearAgentGraphqlExecutor,
  agentSessionId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LinearAgentSessionResult> {
  const id = idSchema.parse(agentSessionId);
  const data = await executeGraphql(`
    mutation RallyLinearAgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) {
        success
        agentSession { id status }
      }
    }
  `, { id, input }, signal);
  return sessionMutationResult(data, "agentSessionUpdate");
}

export const linearAgentActivity = {
  thought(agentSessionId: string, body: string, options: { id?: string; ephemeral?: boolean } = {}): LinearAgentActivityCreateInput {
    return activityInput({
      agentSessionId,
      content: { type: "thought", body },
      ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
      ...(options.id ? { id: options.id } : {}),
    });
  },
  action(agentSessionId: string, action: string, parameter: string, options: { id?: string; result?: string; ephemeral?: boolean } = {}): LinearAgentActivityCreateInput {
    return activityInput({
      agentSessionId,
      content: { type: "action", action, parameter, ...(options.result === undefined ? {} : { result: options.result }) },
      ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
      ...(options.id ? { id: options.id } : {}),
    });
  },
  elicitation(agentSessionId: string, body: string, options: { id?: string } = {}): LinearAgentActivityCreateInput {
    return activityInput({ agentSessionId, content: { type: "elicitation", body }, ...(options.id ? { id: options.id } : {}) });
  },
  auth(agentSessionId: string, body: string, metadata: z.input<typeof authSignalMetadataSchema>, options: { id?: string } = {}): LinearAgentActivityCreateInput {
    return activityInput({ agentSessionId, content: { type: "elicitation", body }, signal: "auth", signalMetadata: metadata, ...(options.id ? { id: options.id } : {}) });
  },
  select(agentSessionId: string, body: string, optionsList: z.input<typeof selectSignalMetadataSchema>["options"], options: { id?: string } = {}): LinearAgentActivityCreateInput {
    return activityInput({ agentSessionId, content: { type: "elicitation", body }, signal: "select", signalMetadata: { options: optionsList }, ...(options.id ? { id: options.id } : {}) });
  },
  response(agentSessionId: string, body: string, options: { id?: string } = {}): LinearAgentActivityCreateInput {
    return activityInput({ agentSessionId, content: { type: "response", body }, ...(options.id ? { id: options.id } : {}) });
  },
  error(agentSessionId: string, body: string, options: { id?: string; reasonCode?: string } = {}): LinearAgentActivityCreateInput {
    return activityInput({
      agentSessionId,
      content: { type: "error", body, ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}) },
      ...(options.id ? { id: options.id } : {}),
    });
  },
  stopped(agentSessionId: string, body = "Stopped as requested.", options: { id?: string } = {}): LinearAgentActivityCreateInput {
    return activityInput({ agentSessionId, content: { type: "response", body }, ...(options.id ? { id: options.id } : {}) });
  },
};

function activityInput(input: {
  agentSessionId: string;
  content: LinearAgentActivityContent;
  id?: string;
  ephemeral?: boolean;
  signal?: "auth" | "select";
  signalMetadata?: Record<string, unknown>;
}): LinearAgentActivityCreateInput {
  return LinearAgentActivityCreateInputSchema.parse({
    agentSessionId: input.agentSessionId,
    id: input.id ?? crypto.randomUUID(),
    content: input.content,
    ...(input.ephemeral === undefined ? {} : { ephemeral: input.ephemeral }),
    ...(input.signal ? { signal: input.signal, signalMetadata: input.signalMetadata } : {}),
  });
}

function validateExternalUrls(input: LinearAgentExternalUrl[]): LinearAgentExternalUrl[] {
  const urls = z.array(LinearAgentExternalUrlSchema).max(100).parse(input);
  if (new Set(urls.map((entry) => entry.url)).size !== urls.length) {
    throw new ConnectorError("invalid_configuration", "Linear agent session URLs must be unique");
  }
  return urls;
}

async function createLinearAgentSession(
  executeGraphql: LinearAgentGraphqlExecutor,
  target: "issue" | "comment",
  targetId: string,
  externalUrls: LinearAgentExternalUrl[] | undefined,
  signal?: AbortSignal,
): Promise<LinearAgentSessionResult> {
  const input = {
    [target === "issue" ? "issueId" : "commentId"]: idSchema.parse(targetId),
    ...(externalUrls ? { externalUrls: validateExternalUrls(externalUrls) } : {}),
  };
  const field = target === "issue" ? "agentSessionCreateOnIssue" : "agentSessionCreateOnComment";
  const inputType = target === "issue" ? "AgentSessionCreateOnIssue" : "AgentSessionCreateOnComment";
  const data = await executeGraphql(`
    mutation RallyLinearAgentSessionCreate($input: ${inputType}!) {
      ${field}(input: $input) {
        success
        agentSession { id status }
      }
    }
  `, { input }, signal);
  return sessionMutationResult(data, field);
}

function sessionMutationResult(data: Record<string, unknown>, field: string): LinearAgentSessionResult {
  const payload = successfulMutation(data, field, "agent session");
  const session = requiredRecord(payload, "agentSession", "Linear did not return the agent session");
  return {
    success: true,
    agentSessionId: requiredString(session, "id", "Linear did not return the agent session ID"),
    status: requiredString(session, "status", "Linear did not return the agent session status"),
  };
}

function successfulMutation(data: Record<string, unknown>, field: string, label: string): Record<string, unknown> {
  const payload = requiredRecord(data, field, `Linear did not return the ${label} mutation result`);
  if (booleanValue(payload, "success") !== true) {
    throw new ConnectorError("provider_error", `Linear did not complete the ${label} mutation`);
  }
  return payload;
}

function requiredRecord(record: Record<string, unknown>, key: string, message: string): Record<string, unknown> {
  const value = recordValue(record, key);
  if (!value) throw new ConnectorError("provider_error", message);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, message: string): string {
  const value = stringValue(record, key);
  if (!value) throw new ConnectorError("provider_error", message);
  return value;
}
