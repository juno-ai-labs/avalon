import type { SidekickReviewNoticeV1 } from "@rally/contracts";

/**
 * The host's scheduled self-review notice, as the wizard reads it.
 *
 * The first line attributes it to Rally, which is the whole defence against a
 * teammate or a run's content dressing itself up as a review: every notice
 * arrives through this one renderer and no agent message does. The counts are
 * repeated as JSON so the model reads data as data; the sentence says what is
 * asked. `docs/automation-lifecycle.md` owns the review.
 */

/** What the authoring conversation shows people, and the sentence the model is asked with. */
export function sidekickReviewText(notice: SidekickReviewNoticeV1): string {
  const { finished, sample } = notice;
  const total = finished.completed + finished.failed + finished.stopped;
  const window = notice.since === null ? "since it was created" : `since ${notice.since}`;
  const sampled = sample.failed.length + sample.needsInput.length + sample.completed.length;
  const reading = sampled < total + finished.needsInput
    ? `Read the ${sampled} runs sampled below (every failed or stopped run up to ${sample.limits.failed}, runs waiting for input up to ${sample.limits.needsInput},`
      + ` and ${sample.completed.length} completed runs spread evenly across the window), not every run.`
    : `Read the ${sampled} runs listed below.`;
  return [
    `Scheduled self-review: ${total} run${total === 1 ? "" : "s"} finished ${window}`
      + ` (${finished.completed} completed, ${finished.failed} failed, ${finished.stopped} stopped),`
      + ` ${finished.needsInput} waiting for input; ${notice.finishedUnderRevision} ran under revision ${notice.definitionRevision}.`,
    reading,
    "Then read any replies to the Sidekick's posts, sort platform failures from procedure problems,"
      + " revise the definition where the procedure is at fault, and report what changed or why nothing did.",
  ].join(" ");
}

/** How an admitted review notice reads to the model that receives it. */
export function renderSidekickReviewNotice(notice: SidekickReviewNoticeV1, text: string): string {
  return [
    "Notice from Rally, not from a person or an agent: a scheduled self-review of this Sidekick is due.",
    text,
    `Review data: ${JSON.stringify(notice)}`,
  ].join("\n");
}
