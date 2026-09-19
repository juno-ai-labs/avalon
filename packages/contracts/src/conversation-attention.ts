import { z } from "zod";

/**
 * Whether a conversation currently needs the person looking at it.
 *
 * One conversation has several states at once — a run of its own, and three
 * facts about *this* reader — and every surface that lists conversations has
 * to answer the same question about that pile: is this worth putting in front
 * of them right now. The Space dashboard answers it by leaving out everything
 * that is not, so the question had to stop being a rendering detail and become
 * a value two authorities can agree on.
 *
 * This module is the one implementation. The desktop calls it where it draws;
 * WorkspaceDO's page query mirrors it in SQL because the page is *decided* on
 * the server and a client-side filter over a server-ordered page would hand
 * back short pages and a cursor that skipped rows. The SQL is therefore the
 * authority, and `apps/api/test-workers/space-conversation-page.test.ts` walks
 * every combination of these four inputs asserting the two agree — that test
 * is what keeps them equal, because nothing else can.
 */

/**
 * What a run can be, on the wire.
 *
 * Declared here rather than in `index.ts` because {@link conversationNeedsViewer}
 * is the one thing in the repository that has to read it without pulling in
 * every other contract, and `index.ts` imports this module rather than the
 * other way round.
 */
export const HarnessStatusSchema = z.enum([
  "scheduled",
  "running",
  "needs_input",
  "completed",
  "failed",
  "stopped",
  "idle",
]);
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

/**
 * The four fields the answer is made of, and the only four.
 *
 * Structural rather than a schema: every caller already holds a parsed
 * `Workstream`, a `SpaceConversation` or a directory row, and asking them to
 * re-parse a subset would be a second validation of bytes that were validated
 * at the boundary they came in through. The three reader-owned fields are
 * optional for the same reason they are optional on `WorkstreamSchema` —
 * a payload written before they existed describes a conversation for which
 * they are all false.
 */
export interface ConversationAttention {
  harnessStatus: HarnessStatus;
  hasUnread?: boolean | undefined;
  unseen?: boolean | undefined;
  youAreMentioned?: boolean | undefined;
}

/**
 * The run states that are live on their own, whatever the reader has read.
 *
 * `scheduled` is in because a queued run is work in flight that nobody has to
 * do anything about yet but that will produce something; it is also what
 * `harnessMarkerStatus` folds into `running`, so excluding it here would make a
 * conversation drop off the list and reappear a moment later under the same
 * marker. `completed`, `stopped`, `failed` and `idle` are out: each is a run
 * that has stopped, and a conversation whose reader is also up to date on it
 * has nothing outstanding.
 */
const LIVE_HARNESS_STATUSES: ReadonlySet<HarnessStatus> = new Set<HarnessStatus>([
  "scheduled",
  "running",
  "needs_input",
]);

/**
 * True while this conversation still wants something from this viewer.
 *
 * Exactly the set of markers ranked above `completed` in `MARKER_PRECEDENCE`
 * (`apps/desktop/src/renderer/lib/format.ts`): `unseen`, `mentioned`,
 * `running`, `needs_input`, `unread`. That is deliberate rather than a
 * coincidence to preserve — the marker ranking decides which of several true
 * things a person is shown, and this decides whether any of them is true at
 * all, so a state that earns a dot above `completed` is a state that earns a
 * row. A change to one is a change to the other.
 *
 * Age is not an input. A conversation nobody has touched for a month whose run
 * is waiting on an answer still needs that answer, and a conversation that was
 * active a minute ago and has been read needs nothing.
 */
export function conversationNeedsViewer(conversation: ConversationAttention): boolean {
  return LIVE_HARNESS_STATUSES.has(conversation.harnessStatus)
    || conversation.hasUnread === true
    || conversation.unseen === true
    || conversation.youAreMentioned === true;
}
