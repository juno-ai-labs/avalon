import type { SidekickReviewNoticeV1 } from "@rally/contracts";

/**
 * How an admitted review notice reads to the model that receives it: the
 * row's sentence, then the runs to read. It does not name `announceTo`: the
 * review runs in the Sidekick's shared conversation, which is where a change
 * is announced, so naming it invited a second post beside the wizard's report.
 */
export function renderSidekickReviewNotice(notice: SidekickReviewNoticeV1, text: string): string {
  const list = (ids: readonly string[]) => (ids.length === 0 ? "none" : ids.join(", "));
  return [
    "Notice from Rally, not from a person or an agent: a scheduled self-review of this Sidekick is due.",
    text,
    `Every count and run above is from definition revision ${notice.definitionRevision}, between ${notice.since ?? "creation"} and ${notice.until}.`,
    "Read exactly these runs, by id, and no others:",
    `- failed or stopped: ${list(notice.sample.failed)}`,
    `- waiting for input: ${list(notice.sample.needsInput)}`,
    `- completed, spread evenly across the window: ${list(notice.sample.completed)}`,
  ].join("\n");
}
