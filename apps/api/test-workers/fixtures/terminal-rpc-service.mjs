import { WorkerEntrypoint } from "cloudflare:workers";

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
}
