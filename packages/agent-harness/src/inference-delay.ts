/** Team-selected thresholds: allow slow reasoning while explaining the wait. */
export const INFERENCE_TTFT_TIMEOUT_MS = 180_000;
export const INFERENCE_DELAY_NOTICE_MS = 30_000;

/** One stream's wait; notification delivery is serialized with its clear. */
export function createInferenceDelayObserver(
  onChange: ((active: boolean) => void | Promise<void>) | undefined,
  signal?: AbortSignal,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = true;
  let announced = false;
  let delivery = Promise.resolve();
  let releaseDelivery!: () => void;
  const aborted = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  const deliver = (active: boolean) => Promise.race([
    Promise.resolve().then(() => onChange?.(active)).catch(() => undefined),
    aborted,
  ]);
  const stop = () => {
    waiting = false;
    clearTimeout(timer);
    releaseDelivery();
    if (announced) {
      announced = false;
      const clear = () => deliver(false);
      delivery = delivery.then(clear, clear).catch(() => undefined);
    }
  };
  const abort = () => { releaseDelivery(); stop(); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    open() {
      if (!onChange || !waiting || signal?.aborted) return;
      timer = setTimeout(() => {
        if (!waiting || signal?.aborted) return;
        delivery = delivery.then(() => {
          if (!waiting || signal?.aborted) return;
          announced = true;
          return deliver(true);
        }).catch(() => undefined);
      }, INFERENCE_DELAY_NOTICE_MS);
    },
    observedOutput: stop,
    // Status transport must never hold up reading the next provider chunk.
    flush: () => Promise.resolve(),
    async finish() {
      stop();
      signal?.removeEventListener('abort', abort);
      releaseDelivery();
      await delivery;
    },
  };
}
