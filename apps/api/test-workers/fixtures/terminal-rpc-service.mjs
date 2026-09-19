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
 * Mirrors the real session's start/recover arity so the deadline's argument
 * position is proved against the real Worker boundary rather than an
 * in-process double. A wrong position on either side returns `undefined`
 * rather than failing, which is silent everywhere else.
 */
class EchoSession extends RpcTarget {
  startSandbox(idOrName, options) {
    return { ok: true, value: { idOrName, options: options ?? null } };
  }

  recoverSandbox(idOrName, options) {
    return { ok: true, value: { idOrName, options: options ?? null } };
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

  createSession() {
    return new EchoSession();
  }
}
