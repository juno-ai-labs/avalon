/** Node-test stand-in for the runtime-only `cloudflare:workers` base class. */
let nextWaitUntilError: Error | undefined;
const pendingWaitUntil = new Set<Promise<unknown>>();

export function waitUntil(promise: Promise<unknown>): void {
  if (nextWaitUntilError) {
    const error = nextWaitUntilError;
    nextWaitUntilError = undefined;
    throw error;
  }
  // Production keeps the invocation alive. Node already remains alive for its
  // own pending I/O; attach a rejection handler so a best-effort background
  // task cannot become an unrelated unhandled-rejection failure.
  const settled = promise.catch(() => undefined);
  pendingWaitUntil.add(settled);
  void settled.finally(() => pendingWaitUntil.delete(settled));
}

/**
 * Wait for every task handed to `waitUntil` so far, and any those schedule,
 * to settle — so a test can assert on what background work did (or that none
 * ran) causally rather than by sleeping.
 */
export async function drainWaitUntil(): Promise<void> {
  while (pendingWaitUntil.size > 0) await Promise.all([...pendingWaitUntil]);
}

/** Make the next Node-test waitUntil registration fail synchronously. */
export function failNextWaitUntil(error: Error): void {
  nextWaitUntilError = error;
}

export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** Ace's index exports a named entrypoint, and API tests import that index. */
export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * The RPC-capability base class a `code_execute` gateway extends. Off workerd
 * nothing serializes it; the stand-in only lets the module load.
 */
export class RpcTarget {}

/**
 * Node-test stand-in for the runtime's custom-span API.
 *
 * The real one nests by async context and hands the span to the OTLP exporter;
 * neither exists off workerd. This keeps the *contract* a call site depends on
 * — the callback runs, its result is returned, a throw propagates, and the
 * attributes a caller sets are recorded — so a Node test can assert on what a
 * path names its spans and what it puts on them. Anything that depends on
 * real nesting or on export belongs in `apps/api/test-workers/` instead, per
 * `docs/testing.md`.
 */
export interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  ended: boolean;
  /** Whether an error crossed the runtime span callback boundary. */
  callbackFailed: boolean;
}

const recorded: RecordedSpan[] = [];

/** The spans opened since the last `resetRecordedSpans()`, in start order. */
export function recordedSpans(): readonly RecordedSpan[] {
  return recorded;
}

export function resetRecordedSpans(): void {
  recorded.length = 0;
}

function makeSpan(name: string): { span: RecordedSpan; handle: SpanHandle } {
  const span: RecordedSpan = { name, attributes: {}, ended: false, callbackFailed: false };
  recorded.push(span);
  return {
    span,
    handle: {
      setAttribute(key: string, value: string | number | boolean | undefined): void {
        if (value === undefined) return;
        span.attributes[key] = value;
      },
      end(): void {
        span.ended = true;
      },
      isTraced: true,
    },
  };
}

interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean | undefined): void;
  end(): void;
  readonly isTraced: boolean;
}

export const tracing = {
  enterSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: SpanHandle, ...args: A) => T,
    ...args: A
  ): T {
    const { span, handle } = makeSpan(name);
    const finish = (): void => { span.ended = true; };
    let result: T;
    try {
      result = callback(handle, ...args);
    } catch (error) {
      span.callbackFailed = true;
      finish();
      throw error;
    }
    // The runtime ends the span when an async callback settles, not when it
    // returns the promise; a stand-in that ended it early would let a test pass
    // over a span the runtime would still have open.
    if (result instanceof Promise) {
      return result.then(
        (value) => value,
        (error: unknown) => {
          span.callbackFailed = true;
          throw error;
        },
      ).finally(finish) as T;
    }
    finish();
    return result;
  },
  startActiveSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: SpanHandle, ...args: A) => T,
    ...args: A
  ): T {
    const { handle } = makeSpan(name);
    return callback(handle, ...args);
  },
};
