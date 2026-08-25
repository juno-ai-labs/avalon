import { describe, expect, it } from "vitest";
import { AutomationDraftStreamEventSchema } from "@rally/contracts";
import { compileAutomation } from "./index";

/**
 * A regression pin, not a two-version-skew detector — this file imports one
 * `@rally/contracts` build for both the route's and the client's side of the
 * schema, so it structurally cannot observe the two diverging the way a real
 * rollout can. What it does prove: the normalizer's own trigger handling
 * (`normalizeAutomationTrigger` in `./index`) for an unnamed, multi-time-daily
 * calendar schedule — three separate triggers, or one with several `BYHOUR`
 * values — produces a draft that survives `AutomationDraftStreamEventSchema`,
 * a `JSON.stringify`/`parse` round trip, and the same schema again. That is
 * exactly the mechanism the route (`apps/api/src/routes/automations.ts`) and
 * the desktop client (`apps/desktop/src/renderer/lib/api.ts`) each apply to
 * the same bytes, so a transport-losable value (`undefined`-vs-absent, a
 * non-JSON type) here would be a transport-losable value there too.
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
    defaultTimezones: { personal: "America/Los_Angeles", workspace: "UTC" },
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
