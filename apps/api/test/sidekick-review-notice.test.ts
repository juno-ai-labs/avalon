import type { SidekickReviewNoticeV1 } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { renderSidekickReviewNotice, sidekickReviewText } from "../src/services/sidekick-review-notice";

const NOTICE: SidekickReviewNoticeV1 = {
  kind: "sidekick_review_due",
  schemaVersion: 1,
  reviewId: "00000000-0000-7000-8000-00000000ad00",
  automationId: "00000000-0000-7000-8000-0000000000aa",
  definitionRevision: 3,
  since: "2026-10-23T10:00:00.000Z",
  until: "2026-10-26T10:00:00.000Z",
  finished: { completed: 10, failed: 2, needsInput: 1, stopped: 0 },
  sample: {
    failed: ["00000000-0000-7000-8000-0000000000f1", "00000000-0000-7000-8000-0000000000f0"],
    needsInput: ["00000000-0000-7000-8000-0000000000e0"],
    completed: ["00000000-0000-7000-8000-0000000000c9", "00000000-0000-7000-8000-0000000000c4"],
  },
} as SidekickReviewNoticeV1;

describe("the self-review notice", () => {
  it("tells people what Rally asked for, with no id, instant or revision number", () => {
    expect(sidekickReviewText(NOTICE)).toBe(
      "Rally asked this Sidekick's wizard for a scheduled self-review: 12 runs finished since the last review (10 completed, 2 failed),"
      + " and 1 is waiting for input. The wizard reads 5 of them and reports here.",
    );
    expect(sidekickReviewText({
      ...NOTICE, since: null, finished: { completed: 1, failed: 0, needsInput: 0, stopped: 0 },
      sample: { failed: [], needsInput: [], completed: [NOTICE.sample.completed[0]!] },
    })).toBe(
      "Rally asked this Sidekick's wizard for a scheduled self-review: 1 run finished since it was created (1 completed)."
      + " The wizard reads 1 of them and reports here.",
    );
  });

  it("hands the model Rally's line first, then the row's sentence, then exactly the runs to read", () => {
    expect(renderSidekickReviewNotice(NOTICE, "The row's sentence.")).toBe([
      "Notice from Rally, not from a person or an agent: a scheduled self-review of this Sidekick is due.",
      "The row's sentence.",
      "Every count and run above is from definition revision 3, between 2026-10-23T10:00:00.000Z and 2026-10-26T10:00:00.000Z.",
      "Read exactly these runs, by id, and no others:",
      "- failed or stopped: 00000000-0000-7000-8000-0000000000f1, 00000000-0000-7000-8000-0000000000f0",
      "- waiting for input: 00000000-0000-7000-8000-0000000000e0",
      "- completed, spread evenly across the window: 00000000-0000-7000-8000-0000000000c9, 00000000-0000-7000-8000-0000000000c4",
    ].join("\n"));
    expect(renderSidekickReviewNotice({ ...NOTICE, since: null, sample: { failed: [], needsInput: [], completed: [] } }, "First.").split("\n").slice(2))
      .toEqual([
        "Every count and run above is from definition revision 3, between creation and 2026-10-26T10:00:00.000Z.",
        "Read exactly these runs, by id, and no others:",
        "- failed or stopped: none",
        "- waiting for input: none",
        "- completed, spread evenly across the window: none",
      ]);
  });
});
