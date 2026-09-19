import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

class CounterSession extends RpcTarget {
  #value = 0;

  next() {
    this.#value += 1;
    return this.#value;
  }
}

class CallbackSession extends RpcTarget {
  #callback;

  constructor(callback) {
    super();
    this.#callback = callback.dup();
  }

  [Symbol.dispose]() {
    this.#callback[Symbol.dispose]();
  }

  call(value) {
    return this.#callback(value);
  }
}

/**
 * Stands in for the Terminal provider Worker, and deliberately not for the
 * Daytona provider: what is under test is the Worker boundary itself, and the
 * only way to have a real one is to have a real second Worker.
 *
 * `startSandbox` and `recoverSandbox` mirror the real session's arity and echo
 * what they were handed, so an argument-position skew is visible instead of
 * arriving as `undefined` and falling back to a default. `getSandbox` reports
 * its provider requests the way `terminalProviderRpcCall` and `measureRequest`
 * do — through the callbacks handed to that one call, awaited before the
 * call's own result is allowed to return.
 */
class ProviderSession extends RpcTarget {
  #sessionObserve;
  #sessionObservations = 0;

  constructor(instrumentation) {
    super();
    // Retained only to prove it is never supplied: a caller that puts request
    // measurement back on the session instrumentation is the regression this
    // whole change is against, and it would look like working code.
    this.#sessionObserve = instrumentation?.observeRequest?.dup();
  }

  [Symbol.dispose]() {
    this.#sessionObserve?.[Symbol.dispose]();
  }

  /** How many measurements a session-scoped observer received, if any. */
  sessionObservations() {
    return { installed: this.#sessionObserve !== undefined, delivered: this.#sessionObservations };
  }

  startSandbox(idOrName, options) {
    return { ok: true, value: { idOrName, options: options ?? null } };
  }

  recoverSandbox(idOrName, options) {
    return { ok: true, value: { idOrName, options: options ?? null } };
  }

  async getSandbox(idOrName, callbacks) {
    for (const durationMs of [11, 13]) {
      const measurement = {
        operation: "sandbox.get",
        detail: null,
        outcome: "completed",
        durationMs,
        requestCount: 1,
        pollCount: 0,
        bytes: 0,
      };
      await callbacks?.observeRequest?.(measurement);
      if (this.#sessionObserve) {
        this.#sessionObservations += 1;
        await this.#sessionObserve(measurement);
      }
    }
    return { ok: true, value: { id: idOrName, name: idOrName, state: "started" } };
  }
}

export default class TerminalRpcTestService extends WorkerEntrypoint {
  throwNotFound() {
    throw Object.assign(new Error("sandbox missing"), { status: 404 });
  }

  returnNotFound() {
    return {
      ok: false,
      error: { kind: "not_found", message: "sandbox missing" },
    };
  }

  invokeCallback(callback) {
    return callback();
  }

  createCounterSession() {
    return new CounterSession();
  }

  createCallbackSession(callback) {
    return new CallbackSession(callback);
  }

  createSession(_configuration, instrumentation) {
    return new ProviderSession(instrumentation);
  }
}
