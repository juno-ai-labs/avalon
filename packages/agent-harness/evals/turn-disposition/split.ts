import type { TurnDispositionCase } from "../../src/turn-disposition-evaluation";

/**
 * The development/holdout split, fixed by the conversation id's last hex
 * digit so it is the same for every report, every optimization run, and
 * every re-export of the same conversations. A Thread is identified by its
 * workstream id and a Breakout by its substream id, so a Thread and its
 * Breakouts can land on different sides; what matters is that nothing tuned
 * on one side has seen the other.
 */
export function isDevelopmentCase(evaluationCase: Pick<TurnDispositionCase, "workstreamId" | "substreamId">): boolean {
  const conversation = evaluationCase.substreamId === "0" ? evaluationCase.workstreamId : evaluationCase.substreamId;
  const digit = Number.parseInt(conversation.slice(-1), 16);
  return Number.isNaN(digit) ? true : digit < 8;
}
