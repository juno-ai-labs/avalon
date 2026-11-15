import { requireUsageAllowance } from "./usage-admission";
import { z } from "zod";
import { judgeSemanticTriggerCondition, type HarnessTool } from "@rally/agent-harness";
import {
  IdSchema, UserIdSchema, asWorkspaceId, type UserId, type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { Env } from "../env";
import { runtimeDeferral } from "../lib/defer";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { createClassifierDiagnosticSink } from "./classifier-diagnostics";
import { SidekickSourceService } from "./sidekick-source-service";
import { postWizardCard, wizardTurnCanvasId } from "./wizard-canvas-cards";

/**
 * The agent's side of a Sidekick's sources: see who lets events in, ask
 * people to, and try a filter on real events before asking.
 * `docs/sidekick-sources.md` owns the mechanism; the
 * `setting-up-a-filtered-trigger` skill is the procedure.
 *
 * Asking is all an agent can do. Only the person asked answers, in their own
 * session or from their own email, so no tool takes an answer.
 */
const SourcesListInputSchema = z.strictObject({
  sidekickId: IdSchema.describe("The Sidekick's id."),
});
const RequestSourceInputSchema = z.strictObject({
  sidekickId: IdSchema.describe("The Sidekick whose trigger these people's events should start."),
  userIds: z.array(UserIdSchema).min(1)
    .describe("The Organization users to ask, by userId. Include the person you are working for to ask for their own account; they approve theirs on the request, as everyone does."),
  connectorType: z.string().min(1)
    .describe("The connector whose events are asked for, as the Sidekick's trigger names it, for example google."),
  eventTypes: z.array(z.string().min(1)).min(1)
    .describe("The event types asked for, as the connector declares them, for example email.received."),
  condition: z.string().trim().min(1).optional()
    .describe("The filter each person's events must meet, written as a claim about one event. Omit to ask for every event of these types. The person sees this text and approves exactly it."),
});
const TestConditionInputSchema = z.strictObject({
  connectorType: z.string().min(1).describe("The connector, as request_source takes it."),
  eventType: z.string().min(1).describe("One event type, as request_source takes it."),
  condition: z.string().trim().min(1).describe("The draft filter to try."),
});

/**
 * What a completed ask leaves in the transcript for everyone who reads the
 * conversation: which requests it made, and nothing about them. The card
 * reads each request's state as its own reader may see it, so the asker's
 * view (names, the filter, who it is "yours" for) never rides the transcript.
 * Null for any other tool, whose block keeps its summary.
 */
export function sidekickSourceRequestCard(event: { pluginId?: string | undefined; canonicalToolName: string; output: unknown }):
  { sidekickId: string; requests: { requestId: string }[] } | null {
  // A recovered receipt may name the tool by its wire name.
  if (event.pluginId !== "rally:sidekicks" || !["request_source", "sidekick_request_source"].includes(event.canonicalToolName)) return null;
  const asked = z.object({ sidekickId: IdSchema, requests: z.array(z.object({ requestId: IdSchema })).min(1) }).safeParse(event.output);
  return asked.success
    ? { sidekickId: asked.data.sidekickId, requests: asked.data.requests.map(({ requestId }) => ({ requestId })) }
    : null;
}

/** How many of the person's own recent events one test judges. A product choice: one screenful to read. */
const TEST_SAMPLE_EVENTS = 10;

export function sidekickSourceTools(env: Env, input: WorkstreamWorkflowInput, userId: UserId, room: boolean): HarnessTool[] {
  const service = new SidekickSourceService(env, input.workspaceId, userId);
  const name = (local: string) => room ? `sidekick_${local}` : local;
  // The request's card is drawn in the conversation it was asked from: a
  // Canvas's Chat or a Sidekick's shared conversation, never a run. A wizard
  // turn a Canvas's Chat started was asked from that Chat, so its card is
  // drawn there too (`askedFromCanvasId`).
  const askedFromCanvasId = wizardTurnCanvasId(input);
  const place = (input.substreamId ?? "0") !== "0" ? null
    : askedFromCanvasId !== null ? { parentKind: "canvas" as const, parentId: askedFromCanvasId }
    : input.parentKind === "canvas" ? { parentKind: "canvas" as const, parentId: input.parentId }
    : input.parentKind === "automation" ? { parentKind: "automation" as const, parentId: input.parentId } : null;
  return [{
    definition: {
      name: name("sources_list"),
      description: "List whose events may start a Sidekick: each person's account, the event types and their filter, and the requests still waiting or declined.",
      capability: "rally.sidekick.sources.list", mode: "read" as const, idempotency: "safe" as const,
      inputSchema: z.toJSONSchema(SourcesListInputSchema),
    },
    validateInput: (raw) => SourcesListInputSchema.safeParse(raw).error ?? null,
    execute: async (raw) => {
      const listed = await service.list(SourcesListInputSchema.parse(raw).sidekickId);
      return {
        output: {
          sidekickId: listed.sidekickId,
          sources: listed.sources.map((source) => ({
            userId: source.person.userId, name: source.person.displayName, account: source.connectionName,
            connectorType: source.connectorType, eventTypes: source.eventTypes, condition: source.condition, available: source.available,
          })),
          requests: listed.requests.map(requestOutput),
        },
        summary: "Listed the Sidekick's sources",
      };
    },
  }, {
    definition: {
      name: name("request_source"),
      description: "Ask Organization users to let events from one of their accounts start a Sidekick, optionally only events meeting a written filter. Each person gets a request only they can approve or decline, in Rally and by email; this returns each request's state and never waits for an answer. Nobody is approved by asking, the person you work for included. To change a filter, ask again with the new one.",
      capability: "rally.sidekick.sources.request", mode: "write" as const, idempotency: "record_before_execute" as const,
      inputSchema: z.toJSONSchema(RequestSourceInputSchema),
    },
    // The ask is keyed on the receipt: re-entering it answers with the
    // requests that receipt already made.
    serial: true, reenterable: true,
    validateInput: (raw) => RequestSourceInputSchema.safeParse(raw).error ?? null,
    execute: async (raw, context) => {
      const args = RequestSourceInputSchema.parse(raw);
      const operationId = IdSchema.parse(context.effectIntentId);
      const asked = await service.ask(args.sidekickId, {
        userIds: args.userIds, connectorType: args.connectorType, eventTypes: args.eventTypes,
        condition: args.condition ?? null, place, operationId,
      });
      // The wizard's own block draws the card here; the Chat that asked gets
      // a post of the Sidekick's that draws the same requests. Keyed on the
      // receipt, so a retried call posts once.
      if (askedFromCanvasId !== null) {
        const requestIds = asked.requests.map((request) => request.requestId);
        await postWizardCard(env, input, askedFromCanvasId, `sidekick-source-card:${operationId}`, {
          text: `Asked ${requestIds.length === 1 ? "one person" : `${requestIds.length} people`} to let their events start this Sidekick. Each person approves or declines their own request.`,
          card: { sourceRequests: { requestIds } }, sidekickId: asked.sidekickId,
        });
      }
      // The whole result is the card's input: the client reads each request's
      // id from it and draws its live state.
      return { output: asked, summary: `Asked ${asked.requests.length === 1 ? "one person" : `${asked.requests.length} people`} for a source` };
    },
  }, {
    definition: {
      name: name("test_source_condition"),
      description: `Try a draft filter on the ${TEST_SAMPLE_EVENTS} most recent events of one type from your own account, and see which it lets in. Use it to revise a filter before asking anyone. It reads only the account of the person you are working for.`,
      capability: "rally.sidekick.sources.test", mode: "read" as const, idempotency: "safe" as const,
      inputSchema: z.toJSONSchema(TestConditionInputSchema),
    },
    validateInput: (raw) => TestConditionInputSchema.safeParse(raw).error ?? null,
    execute: async (raw, context) => {
      const args = TestConditionInputSchema.parse(raw);
      const workspaceId = asWorkspaceId(input.workspaceId);
      const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
      const { events } = await workspace.sidekickSourceSampleEvents({
        workspaceId, userId, connectorType: args.connectorType, eventType: args.eventType, limit: TEST_SAMPLE_EVENTS,
      });
      if (!env.TYPESAFE_API_KEY) {
        return { output: { judged: false, reason: "The filter's classifier is not configured here.", events: [] }, summary: "Could not test the filter" };
      }
      // Nothing to judge is not a filter that refuses everything: say which it is.
      if (events.length === 0) {
        return { output: { judged: false, events: [],
          reason: `Your own ${args.connectorType} account has no recent ${args.eventType} events to try the filter on. Check the event type against the connector's declared events; if it is right, rely on the filter's wording.` },
        summary: "No recent events to test the filter on" };
      }
      const traceId = crypto.randomUUID();
      await requireUsageAllowance(env, input.workspaceId);
      const results = await Promise.all(events.map(async (event) => {
        const decision = await judgeSemanticTriggerCondition({
          typesafeApiKey: env.TYPESAFE_API_KEY!, condition: args.condition,
          event: { connectorType: args.connectorType, eventType: args.eventType, title: event.title, summary: event.summary, textSnippet: event.textSnippet },
          signal: context.signal,
          traceContext: {
            source: "semantic_trigger_gate", feature: "sidekick-source-gate-test", workspaceId: input.workspaceId, requestId: traceId,
            region: env.AVALON_REGION, environment: env.APP_ENV, ...(env.BUILD_SHA ? { buildSha: env.BUILD_SHA } : {}),
          },
          onDiagnostic: createClassifierDiagnosticSink(env, {
            role: "semantic_trigger_gate", workspaceId: input.workspaceId, traceId, defer: runtimeDeferral,
          }).record,
        });
        return { title: event.title, summary: event.summary, snippet: event.textSnippet, occurredAt: new Date(event.occurredAt).toISOString(),
          letIn: decision.admit, verdict: decision.code, confidence: decision.confidence };
      }));
      return {
        output: { judged: true, condition: args.condition, letIn: results.filter((result) => result.letIn).length, total: results.length, events: results },
        summary: `Tried the filter on ${results.length} recent events`,
      };
    },
  }];
}

function requestOutput(request: { requestId: string; person: { userId: string; displayName: string }; connectorType: string;
  eventTypes: string[]; condition: string | null; state: string; requestedByName: string }) {
  return { requestId: request.requestId, userId: request.person.userId, name: request.person.displayName,
    connectorType: request.connectorType, eventTypes: request.eventTypes, condition: request.condition,
    state: request.state, requestedByName: request.requestedByName };
}
