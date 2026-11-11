import { describe, expect, it, vi } from "vitest";

import { asAutomationId, asWorkspaceId } from "@rally/contracts";

import type { Env } from "../src/env";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  admitExternalEventWithSemanticGate,
  type SemanticTriggerAdmissionPort,
} from "../src/services/semantic-trigger-admission";

/**
 * The delivery half of a `semantic_activity` trigger: plan, judge, admit.
 *
 * The object's own enforcement is proved against real workerd in
 * `test-workers/semantic-trigger-gate.test.ts`. What this covers is the order
 * the delivery does things in, which is where the cost lives: a Sidekick that
 * is paused, whose trigger is gone, or whose event predates activation must be
 * refused by the plan without a model call, and a gated one must reach the
 * object with the verdict the classifier produced rather than without it.
 */

const EVENT = {
  id: "00000000-0000-7000-8000-000000000b01",
  eventSequence: 12,
  eventType: "github.pull_request.opened",
  title: "Add the onboarding screen",
  summary: "A pull request was opened",
  textSnippet: "Please review the design before I wire it up.",
  metadata: {},
  occurredAt: Date.parse("2026-09-18T09:00:00.000Z"),
  audienceUserIds: [],
  audienceKind: "workspace" as const,
};

const ADMISSION = {
  workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000b02"),
  automationId: asAutomationId("00000000-0000-7000-8000-000000000b03"),
  registrationId: "00000000-0000-7000-8000-000000000b04",
  payloadHash: "sha256:b0",
  event: EVENT,
};

function testEnv(overrides: { TYPESAFE_API_KEY?: string | undefined } = {}): Env {
  return createTestEnv({
    AVALON_REGION: "global",
    APP_ENV: "test",
    TYPESAFE_API_KEY: "typesafe-key",
    ...overrides,
  });
}

type Plan =
  | { kind: "refuse"; outcomeCode: string }
  | { kind: "admit" }
  | { kind: "judge"; conditions: string[]; connectorType: string | null };

/**
 * The object's side of one admission, decided by a fixed plan: a refusal, an
 * admission, or, for a gated plan asked without a verdict, the conditions to
 * judge. Every call is recorded, so a test can count the Organization calls.
 */
function port(plan: Plan) {
  const admissions: { conditionVerdict?: unknown }[] = [];
  return {
    admissions,
    port: {
      admitExternalEvent: vi.fn(async (input: { conditionVerdict?: unknown }) => {
        admissions.push(input);
        if (plan.kind === "refuse") return { admitted: false, outcomeCode: plan.outcomeCode };
        if (plan.kind === "judge" && input.conditionVerdict === undefined) {
          return { admitted: false, outcomeCode: "sidekick_semantic_condition_unjudged",
            judge: { conditions: plan.conditions, connectorType: plan.connectorType } };
        }
        return { admitted: true, outcomeCode: "sidekick_occurrence_admitted" };
      }),
    } satisfies SemanticTriggerAdmissionPort,
  };
}

function answering(choice: string, confidence: number) {
  return vi.fn(async () => new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: { condition: { type: "choice", choice, confidence } },
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("admitExternalEventWithSemanticGate", () => {
  it("returns the object's refusal from one call, without asking the classifier to judge", async () => {
    const fetcher = answering("condition_met", 0.99);
    const { port: sidekick } = port({ kind: "refuse", outcomeCode: "sidekick_paused" });

    expect(await admitExternalEventWithSemanticGate(testEnv(), {
      sidekick,
      admission: ADMISSION,
      workspaceId: ADMISSION.workspaceId,
      defer: () => undefined,
      fetch: fetcher,
    })).toEqual({ admitted: false, outcomeCode: "sidekick_paused" });
    expect(sidekick.admitExternalEvent).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("admits an ungated delivery with no verdict and no model call", async () => {
    const fetcher = answering("condition_met", 0.99);
    const { port: sidekick, admissions } = port({ kind: "admit" });

    expect(await admitExternalEventWithSemanticGate(testEnv(), {
      sidekick,
      admission: ADMISSION,
      workspaceId: ADMISSION.workspaceId,
      defer: () => undefined,
      fetch: fetcher,
    })).toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).not.toHaveProperty("conditionVerdict");
  });

  it("judges a gated delivery and carries the verdict to the object", async () => {
    const fetcher = answering("condition_met", 0.94);
    const { port: sidekick, admissions } = port({
      kind: "judge",
      conditions: ["The pull request asks for a design review."],
      connectorType: "github",
    });

    const result = await admitExternalEventWithSemanticGate(testEnv(), {
      sidekick,
      admission: ADMISSION,
      workspaceId: ADMISSION.workspaceId,
      defer: () => undefined,
      fetch: fetcher,
    });

    expect(result.admitted).toBe(true);
    expect(result.gate).toMatchObject({ code: "condition_met", confidence: 0.94, conditionCount: 1 });
    expect(admissions[1]).toMatchObject({
      conditionVerdict: { admit: true, code: "condition_met", confidence: 0.94, model: "jev-1.13.0" },
    });
  });

  it("sends a refusing verdict rather than silently skipping admission", async () => {
    const fetcher = answering("condition_not_met", 0.9);
    const { port: sidekick, admissions } = port({
      kind: "judge",
      conditions: ["The pull request asks for a design review."],
      connectorType: "github",
    });

    await admitExternalEventWithSemanticGate(testEnv(), {
      sidekick,
      admission: ADMISSION,
      workspaceId: ADMISSION.workspaceId,
      defer: () => undefined,
      fetch: fetcher,
    });

    expect(admissions[1]).toMatchObject({
      conditionVerdict: { admit: false, code: "condition_not_met" },
    });
  });

  it("reports a gated delivery as unavailable, not admitted, without a TypeSafe credential", async () => {
    const fetcher = answering("condition_met", 0.99);
    const { port: sidekick, admissions } = port({
      kind: "judge",
      conditions: ["The pull request asks for a design review."],
      connectorType: "github",
    });

    const result = await admitExternalEventWithSemanticGate(testEnv({ TYPESAFE_API_KEY: undefined }), {
      sidekick,
      admission: ADMISSION,
      workspaceId: ADMISSION.workspaceId,
      defer: () => undefined,
      fetch: fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.gate).toMatchObject({ code: "classifier_unavailable", confidence: null });
    expect(admissions[1]).toMatchObject({
      conditionVerdict: { admit: false, code: "classifier_unavailable" },
    });
  });

  describe("with a source's filter beside the trigger's condition", () => {
    const SOURCE_FILTER = "The email is about a pre-seed investment round.";
    const TRIGGER_CONDITION = "The pull request asks for a design review.";

    /** The object's side when the event's source holds a filter: both sentences to judge until both verdicts arrive. */
    function filtered(conditions: string[]) {
      const admissions: { sourceVerdict?: unknown; conditionVerdict?: unknown }[] = [];
      const sidekick = {
        admitExternalEvent: vi.fn(async (input: { sourceVerdict?: unknown; conditionVerdict?: unknown }) => {
          admissions.push(input);
          if (input.sourceVerdict === undefined) {
            return { admitted: false, outcomeCode: "sidekick_source_condition_unjudged",
              judge: { conditions, sourceConditions: [SOURCE_FILTER], connectorType: "google" } };
          }
          return { admitted: true, outcomeCode: "sidekick_occurrence_admitted" };
        }),
      } satisfies SemanticTriggerAdmissionPort;
      return { admissions, sidekick };
    }

    /** The classifier answering each call in turn, keeping the sentence each call was asked about. */
    function answeringInTurn(...answers: [choice: string, confidence: number][]) {
      const asked: string[] = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : await new Request(input, init).text();
        asked.push([SOURCE_FILTER, TRIGGER_CONDITION].filter((sentence) => body.includes(sentence)).join(" + "));
        const [choice, confidence] = answers[asked.length - 1]!;
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { condition: { type: "choice", choice, confidence } } }),
          { status: 200, headers: { "content-type": "application/json" } });
      });
      return { asked, fetcher: fetcher as unknown as typeof fetch };
    }

    const admit = (env: Env, sidekick: SemanticTriggerAdmissionPort, fetcher: typeof fetch) => admitExternalEventWithSemanticGate(env, {
      sidekick, admission: ADMISSION, workspaceId: ADMISSION.workspaceId, defer: () => undefined, fetch: fetcher });

    it("does not ask the trigger's question of an event the person's filter kept out", async () => {
      const { asked, fetcher } = answeringInTurn(["condition_not_met", 0.9], ["condition_met", 0.99]);
      const { admissions, sidekick } = filtered([TRIGGER_CONDITION]);

      const result = await admit(testEnv(), sidekick, fetcher);

      expect(asked).toEqual([SOURCE_FILTER]);
      expect(admissions).toHaveLength(2);
      expect(admissions[1]).toMatchObject({
        sourceVerdict: { admit: false, code: "condition_not_met", confidence: 0.9, model: "jev-1.13.0", conditions: [SOURCE_FILTER] },
        // Not judged: sent as unavailable so the object's two checks both have an answer, and neither admits.
        conditionVerdict: { admit: false, code: "classifier_unavailable", confidence: null, model: null },
      });
      expect(result.sourceGate).toMatchObject({ code: "condition_not_met", confidence: 0.9, conditionCount: 1 });
      expect(result).not.toHaveProperty("gate");
    });

    it("judges the person's filter, then the trigger's condition, and sends both verdicts", async () => {
      const { asked, fetcher } = answeringInTurn(["condition_met", 0.91], ["condition_met", 0.72]);
      const { admissions, sidekick } = filtered([TRIGGER_CONDITION]);

      const result = await admit(testEnv(), sidekick, fetcher);

      expect(asked).toEqual([SOURCE_FILTER, TRIGGER_CONDITION]);
      expect(admissions[1]).toMatchObject({
        sourceVerdict: { admit: true, code: "condition_met", confidence: 0.91, model: "jev-1.13.0", conditions: [SOURCE_FILTER] },
        conditionVerdict: { admit: true, code: "condition_met", confidence: 0.72, model: "jev-1.13.0" },
      });
      // The filter the verdict answered for rides only the source's verdict.
      expect(admissions[1]!.conditionVerdict).not.toHaveProperty("conditions");
      expect(result).toMatchObject({ admitted: true, sourceGate: { code: "condition_met", confidence: 0.91 }, gate: { code: "condition_met", confidence: 0.72 } });
    });

    it("sends the source's verdict alone when the trigger has no condition of its own", async () => {
      const { asked, fetcher } = answeringInTurn(["condition_met", 0.91]);
      const { admissions, sidekick } = filtered([]);

      const result = await admit(testEnv(), sidekick, fetcher);

      expect(asked).toEqual([SOURCE_FILTER]);
      expect(admissions[1]).toMatchObject({ sourceVerdict: { admit: true, code: "condition_met", conditions: [SOURCE_FILTER] } });
      expect(admissions[1]).not.toHaveProperty("conditionVerdict");
      expect(result).not.toHaveProperty("gate");
    });

    it("reports both filters unavailable, and asks nothing, without a TypeSafe credential", async () => {
      const { asked, fetcher } = answeringInTurn(["condition_met", 0.99], ["condition_met", 0.99]);
      const { admissions, sidekick } = filtered([TRIGGER_CONDITION]);

      const result = await admit(testEnv({ TYPESAFE_API_KEY: undefined }), sidekick, fetcher);

      expect(asked).toEqual([]);
      expect(admissions[1]).toMatchObject({
        sourceVerdict: { admit: false, code: "classifier_unavailable", confidence: null, model: null, conditions: [SOURCE_FILTER] },
        conditionVerdict: { admit: false, code: "classifier_unavailable", confidence: null, model: null },
      });
      expect(result.sourceGate).toMatchObject({ code: "classifier_unavailable", confidence: null });
    });
  });
});
