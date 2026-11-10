import { describe, expect, it } from "vitest";

import { sidekickTaskOutcomeFromReceipts } from "../src/services/sidekick-task-outcome";

describe("Sidekick task outcome receipts", () => {
  const success = { status: "completed" as const, inputJson: '{"outcome":"succeeded","summary":"Dashboard published."}' };

  it("uses the last declaration instead of retaining an earlier success", () => {
    expect(sidekickTaskOutcomeFromReceipts([success, { status: "completed",
      inputJson: '{"outcome":"blocked","summary":"Required notice was refused. Restore destination access."}' }]))
      .toEqual({ outcome: "blocked", summary: "Required notice was refused. Restore destination access." });
  });

  it("does not claim success when the latest declaration did not commit", () => {
    expect(sidekickTaskOutcomeFromReceipts([success, { status: "executing",
      inputJson: '{"outcome":"blocked","summary":"Publication could not proceed."}' }])).toBeNull();
    expect(sidekickTaskOutcomeFromReceipts([])).toBeNull();
  });

  it("names the rejected field if a stored outcome has an incompatible shape", () => {
    expect(() => sidekickTaskOutcomeFromReceipts([{ status: "completed", inputJson: '{"outcome":"blocked"}' }]))
      .toThrow("summary:invalid_type");
  });
});
