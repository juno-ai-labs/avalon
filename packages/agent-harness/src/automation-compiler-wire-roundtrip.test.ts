import { describe, expect, it } from "vitest";
import { AutomationDraftStreamEventSchema } from "@rally/contracts";
import { compileAutomation } from "./index";

/**
 * `apps/api/src/routes/automations.ts` validates the compiler's `completed`
 * event with this same schema before writing it to the SSE stream, and
 * `apps/desktop/src/renderer/lib/api.ts` validates the bytes that arrive with
 * its own copy of it. Both copies come from `@rally/contracts`, so they only
 * diverge across a rollout — but when they do, the desktop build's rejection
 * surfaces as a generic "unexpected response" with no hint of why. This suite
 * pins the one property that keeps that gap from opening on this path: a
 * draft this compiler can actually produce always satisfies the schema both
 * sides parse it with.
 */

function streamResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function toolDeltaWithArguments(index: number, id: string, name: string, argumentsJson: string) {
  return {
    index,
    id,
    type: "function" as const,
    function: { name, arguments: argumentsJson },
  };
}

function submitResponse(draft: unknown): Response {
  return streamResponse([{
    choices: [{
      delta: { tool_calls: [toolDeltaWithArguments(0, "creator-submit", "automation_submit_draft", JSON.stringify(draft))] },
      finish_reason: "tool_calls",
    }],
  }]);
}

const STOP_RESPONSE = streamResponse([{ choices: [{ delta: { content: "" }, finish_reason: "stop" }] }]);

function fullTrigger(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    type: null,
    rrule: null,
    timezone: null,
    summary: null,
    intervalSeconds: null,
    connectorType: null,
    sourceBindingKey: null,
    suggestedSourcePluginId: null,
    eventTypes: null,
    deterministicFilters: null,
    deterministicPrefilter: null,
    condition: null,
    resourceId: null,
    ...partial,
  };
}

const USER_MESSAGE = "check my slack for anything i left unresolved or unanswered (DMs/mentions/threads/etc) and if i did suggest a response for each correspondence. run this at 9am, 2pm, and 7pm each day";

function baseDraft(triggers: Record<string, unknown>[]): Record<string, unknown> {
  return {
    name: "Slack Unresolved Items & Suggested Replies",
    description: "Checks Slack for unresolved DMs, mentions, and threads three times a day and drafts a suggested reply for each.",
    overview: "Three times a day, this automation scans your Slack DMs, mentions, and threads for anything left unresolved or unanswered, and prepares a suggested reply for each pending item.",
    instructions: "Use Slack search and conversation-history tools to find direct messages, mentions, and threads where you have not yet replied. For each unresolved item, draft a suggested response. Summarize the findings and the suggested replies.",
    triggers,
    expectedOutputs: ["A suggested reply for each unresolved Slack DM, mention, or thread"],
    requestedDelivery: ["slack_agent_dm"],
    defaultBehavior: "{}",
    recommendedPlugins: [],
    memoryTables: [],
    suggestedScope: "personal",
    followUpQuestion: null,
    elicitation: null,
    ready: true,
  };
}

/** A completed compile answers with a draft that neither the route's own
 * validation nor the desktop client's copy of the same schema rejects. */
async function expectDraftSurvivesTheWire(draft: Record<string, unknown>): Promise<void> {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return calls === 1 ? submitResponse(draft) : STOP_RESPONSE;
  }) as typeof fetch;

  const result = await compileAutomation({
    apiKey: "test-key",
    model: "test/model",
    messages: [{ role: "user", content: USER_MESSAGE }],
    defaultTimezones: { personal: "America/Los_Angeles", workspace: "America/Los_Angeles" },
    fetch: fetcher,
  });
  expect(result.ready).toBe(true);

  const completedEvent = AutomationDraftStreamEventSchema.parse({
    type: "completed",
    draftId: "018f0000-0000-7000-8000-000000000000",
    elicitationId: null,
    elicitationPresentedAt: null,
    draft: result,
    assistantMessage: "Here is the automation.",
  });
  const roundTripped: unknown = JSON.parse(JSON.stringify(completedEvent));
  expect(AutomationDraftStreamEventSchema.safeParse(roundTripped).success).toBe(true);
}

describe("a Slack correspondence-check automation with an unnamed multi-time-daily schedule", () => {
  it("survives the wire as three separate calendar triggers, one per time of day", async () => {
    await expectDraftSurvivesTheWire(baseDraft([
      fullTrigger({ type: "calendar", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", timezone: null, summary: "Every day at 9:00 AM" }),
      fullTrigger({ type: "calendar", rrule: "FREQ=DAILY;BYHOUR=14;BYMINUTE=0;BYSECOND=0", timezone: null, summary: "Every day at 2:00 PM" }),
      fullTrigger({ type: "calendar", rrule: "FREQ=DAILY;BYHOUR=19;BYMINUTE=0;BYSECOND=0", timezone: null, summary: "Every day at 7:00 PM" }),
    ]));
  });

  it("survives the wire as one calendar trigger with three BYHOUR values", async () => {
    await expectDraftSurvivesTheWire(baseDraft([
      fullTrigger({ type: "calendar", rrule: "FREQ=DAILY;BYHOUR=9,14,19;BYMINUTE=0;BYSECOND=0", timezone: null, summary: "Every day at 9:00 AM, 2:00 PM, and 7:00 PM" }),
    ]));
  });
});
