/**
 * Run `step` over `items` a batch of `size` at a time, yielding each batch's
 * settled results once every step in it has finished.
 *
 * `allSettled` is the point: a step that fails must not leave its siblings'
 * writes floating after the caller stops, so a batch is only handed back when
 * all of it is done, and the next batch starts only after the caller has read
 * this one and asked for more.
 */
export async function* settledBatches<T, R>(
  items: readonly T[],
  size: number,
  step: (item: T) => Promise<R>,
): AsyncGenerator<PromiseSettledResult<R>[]> {
  for (let offset = 0; offset < items.length; offset += size) {
    yield await Promise.allSettled(items.slice(offset, offset + size).map(step));
  }
}
