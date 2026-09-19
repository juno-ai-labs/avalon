/**
 * Publish one bounded set of fenced delivery targets onto a Queue.
 *
 * The shape every staged fan-out in WorkspaceDO has: rows are claimed with
 * their durable retry gate advanced *before* the external await, one batch is
 * sent, and the accepted rows are marked. A rejected or ambiguous send
 * therefore stays recoverable without spinning the alarm, and a duplicate
 * accepted send is harmless because the consumer rechecks the target's
 * generations before it applies anything.
 *
 * Written over `claim`, `accept` and `message` rather than over a table so the
 * Project default publisher and the Space default publisher are one
 * implementation. They differ in exactly three ways — which rows, which message
 * body, and which Queue — and all three are arguments.
 */
export interface FencedTargetPublicationInput<TPublication, TMessage> {
  /** Take up to one batch of due rows, advancing each row's retry gate. */
  claim: (now: number, retryAt: (attempt: number) => number) => TPublication[];
  /** Mark the rows the Queue accepted. */
  accept: (publications: readonly TPublication[], now: number) => void;
  /** Build one Queue body from one claimed row. */
  message: (publication: TPublication) => TMessage;
  queue: { sendBatch(messages: Array<{ body: TMessage }>): Promise<unknown> };
  now: number;
  retryAt: (attempt: number) => number;
}

export async function publishFencedTargets<TPublication, TMessage>(
  input: FencedTargetPublicationInput<TPublication, TMessage>,
): Promise<number> {
  const publications = input.claim(input.now, input.retryAt);
  if (publications.length === 0) return 0;
  await input.queue.sendBatch(publications.map((publication) => ({
    body: input.message(publication),
  })));
  input.accept(publications, input.now);
  return publications.length;
}
