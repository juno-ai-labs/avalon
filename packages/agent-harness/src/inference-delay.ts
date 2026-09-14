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
  const stop = () => {
    waiting = false;
    clearTimeout(timer);
    if (announced) {
      announced = false;
      const clear = () => onChange?.(false);
      delivery = delivery.then(clear, clear);
      void delivery.catch(() => undefined);
    }
  };
  signal?.addEventListener('abort', stop, { once: true });
  return {
    open() {
      if (!onChange || !waiting || signal?.aborted) return;
      timer = setTimeout(() => {
        if (!waiting || signal?.aborted) return;
        delivery = delivery.then(() => {
          if (!waiting || signal?.aborted) return;
          announced = true;
          return onChange(true);
        });
        void delivery.catch(() => undefined);
      }, INFERENCE_DELAY_NOTICE_MS);
    },
    observedOutput: stop,
    flush: () => delivery,
    async finish() {
      stop();
      signal?.removeEventListener('abort', stop);
      await delivery;
    },
  };
}
