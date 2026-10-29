import type { SidekickReviewNoticeV1 } from "@rally/contracts";

/**
 * The host's scheduled self-review notice: the sentence people see on the
 * row, and the request the wizard reads.
 *
 * The model-facing first line attributes it to Rally, which is the whole
 * defence against a teammate or a run's content dressing itself up as a
 * review: every notice arrives through this one renderer and no agent message
 * does. The row's own text is facts only, because it is what a person opening
 * the authoring conversation reads; what to do with the facts is the wizard's
 * standing guidance. `docs/automation-lifecycle.md` owns the review.
 */

/** What the authoring conversation shows people: what Rally asked for, in plain words. */
export function sidekickReviewText(notice: SidekickReviewNoticeV1): string {
  const { finished, sample } = notice;
  const total = finished.completed + finished.failed + finished.stopped;
  const outcomes = [
    `${finished.completed} completed`,
    ...(finished.failed > 0 ? [`${finished.failed} failed`] : []),
    ...(finished.stopped > 0 ? [`${finished.stopped} stopped`] : []),
  ].join(", ");
  const waiting = finished.needsInput > 0
    ? `, and ${finished.needsInput} ${finished.needsInput === 1 ? "is" : "are"} waiting for input`
    : "";
  const sampled = sample.failed.length + sample.needsInput.length + sample.completed.length;
  const window = notice.since === null ? "since it was created" : "since the last review";
  return `Rally asked this Sidekick's wizard for a scheduled self-review: ${total} run${total === 1 ? "" : "s"} finished ${window}`
    + ` (${outcomes})${waiting}. The wizard reads ${sampled} of them and reports here.`;
}

/** How an admitted review notice reads to the model that receives it: the row's sentence, then the runs to read. */
export function renderSidekickReviewNotice(notice: SidekickReviewNoticeV1, text: string): string {
  const list = (ids: readonly string[]) => (ids.length === 0 ? "none" : ids.join(", "));
  return [
    "Notice from Rally, not from a person or an agent: a scheduled self-review of this Sidekick is due.",
    text,
    `Every count and run above is from definition revision ${notice.definitionRevision}, between ${notice.since ?? "creation"} and ${notice.until}.`,
    `Home conversation to tell about a change: ${notice.home ?? "none"}.`,
    "Read exactly these runs, by id, and no others:",
    `- failed or stopped: ${list(notice.sample.failed)}`,
    `- waiting for input: ${list(notice.sample.needsInput)}`,
    `- completed, spread evenly across the window: ${list(notice.sample.completed)}`,
  ].join("\n");
}
