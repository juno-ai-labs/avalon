/** Provider idle deadlines; the harness owns any total run deadline. */
export function createInferenceStreamWatchdog(options: {
  timeToFirstTokenMs: number;
  interChunkMs: number;
  external: AbortSignal | null;
}) {
  for (const limitMs of [options.timeToFirstTokenMs, options.interChunkMs]) {
    // setTimeout uses a signed 32-bit delay; invalid values otherwise fire immediately.
    if (!Number.isFinite(limitMs) || limitMs <= 0 || limitMs > 2_147_483_647) {
      throw new RangeError('Inference deadline must be a positive representable timer delay');
    }
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answered = false;
  let disposed = false;
  let failure: { kind: 'time_to_first_token' | 'inter_chunk'; limitMs: number } | null = null;
  const arm = () => {
    clearTimeout(timer);
    const limitMs = answered ? options.interChunkMs : options.timeToFirstTokenMs;
    timer = setTimeout(() => {
      failure = { kind: answered ? 'inter_chunk' : 'time_to_first_token', limitMs };
      controller.abort();
    }, limitMs);
  };
  const signal = options.external
    ? AbortSignal.any([controller.signal, options.external])
    : controller.signal;
  return {
    signal,
    open() { if (!disposed) arm(); },
    observedChunk(output: 'answer' | 'none') {
      if (disposed) return;
      if (output === 'answer') answered = true;
      // Empty frames cannot extend the first-output deadline.
      if (answered) arm();
    },
    stall() { return options.external?.aborted ? null : failure; },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      failure = null;
      controller.abort();
    },
  };
}
