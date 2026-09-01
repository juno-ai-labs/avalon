import { describe, expect, it } from "vitest";

import {
  AUTOMATION_DISPOSITION_CORPUS,
  type AutomationDispositionCase,
} from "./automation-result-disposition-corpus";
import {
  automationResultDispositionJsonSchema,
  renderAutomationResultDispositionMessages,
} from "./automation-result-disposition";

function armsFor(reach: AutomationDispositionCase["reach"]): string[] {
  const schema = automationResultDispositionJsonSchema(reach) as {
    properties: { disposition: { enum: string[] } };
  };
  return schema.properties.disposition.enum;
}

describe("the disposition corpus", () => {
  it("expects only answers the case's own reach allows", () => {
    // A case expecting `deliver` from an automation with nowhere to deliver is
    // a broken case, not a model failure — the schema never offers that arm.
    // Scoring such a case would count a fixture bug as a regression forever.
    for (const entry of AUTOMATION_DISPOSITION_CORPUS) {
      expect(armsFor(entry.reach), entry.id).toContain(entry.expected);
    }
  });

  it("has no two cases sharing an id", () => {
    const ids = AUTOMATION_DISPOSITION_CORPUS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers the two failures that matter more than the rest", () => {
    const byId = new Map(AUTOMATION_DISPOSITION_CORPUS.map((entry) => [entry.id, entry]));

    // `done` on something that mattered is the invisible failure: nobody knows
    // to look for a result that never arrived. The pair here is one automation
    // whose quiet weeks must not train the answer for the week it matters.
    expect(byId.get("fourth-identical-digest")?.expected).toBe("done");
    expect(byId.get("digest-with-a-real-change")?.expected).toBe("deliver");
    expect(byId.get("digest-with-a-real-change")?.recentDispositions)
      .toEqual(["done", "done", "done"]);

    // `expose_workstream` on the fourth identical digest is the other: it fills
    // a sidebar with rooms nobody opens.
    expect(byId.get("fourth-identical-digest")?.recentDispositions)
      .toEqual(["done", "done", "done"]);
  });

  it("keeps every arm represented, so a collapsed classifier cannot score well", () => {
    const expected = new Set(AUTOMATION_DISPOSITION_CORPUS.map((entry) => entry.expected));
    // A model answering `done` to everything would pass a corpus of nothing but
    // `done`, and that model is precisely the broken one this gate exists for.
    expect([...expected].sort()).toEqual(["deliver", "done", "expose_workstream"]);
  });

  it("renders each case into a prompt that carries its result and its history", () => {
    for (const entry of AUTOMATION_DISPOSITION_CORPUS) {
      const [, user] = renderAutomationResultDispositionMessages(entry);
      expect(user?.content, entry.id).toContain(entry.result);
      expect(user?.content, entry.id).toContain(entry.automationName);
      // Repetition is the strongest evidence of `done`, and it is only visible
      // to the model if the history reaches it.
      if (entry.recentDispositions.length > 0) {
        expect(user?.content, entry.id).toContain(entry.recentDispositions.join(", "));
      }
    }
  });

  it("records why every case decides the way it does", () => {
    // When a case starts failing, the question is whether the model drifted or
    // the case was wrong. Only a recorded reason lets somebody answer that
    // later without re-arguing the corpus.
    for (const entry of AUTOMATION_DISPOSITION_CORPUS) {
      expect(entry.why.length, entry.id).toBeGreaterThan(40);
    }
  });
});
