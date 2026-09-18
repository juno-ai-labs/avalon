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

function port(plan: Awaited<ReturnType<SemanticTriggerAdmissionPort["externalEventAdmissionPlan"]>>) {
  const admissions: unknown[] = [];
  return {
    admissions,
    port: {
      externalEventAdmissionPlan: vi.fn(async () => plan),
      admitExternalEvent: vi.fn(async (input: unknown) => {
        admissions.push(input);
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
  it("returns the plan's refusal without asking the object to admit or the classifier to judge", async () => {
    const fetcher = answering("condition_met", 0.99);
    const { port: sidekick } = port({ kind: "refuse", outcomeCode: "sidekick_paused" });

    expect(await admitExternalEventWithSemanticGate(testEnv(), {
      sidekick,
      admission: ADMISSION,
      workspaceId: ADMISSION.workspaceId,
      defer: () => undefined,
      fetch: fetcher,
    })).toEqual({ admitted: false, outcomeCode: "sidekick_paused" });
    expect(sidekick.admitExternalEvent).not.toHaveBeenCalled();
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
    expect(admissions[0]).toMatchObject({
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

    expect(admissions[0]).toMatchObject({
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
    expect(admissions[0]).toMatchObject({
      conditionVerdict: { admit: false, code: "classifier_unavailable" },
    });
  });
});
