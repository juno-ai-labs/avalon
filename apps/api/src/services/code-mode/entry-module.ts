/**
 * The host-authored module a program's isolate starts from.
 *
 * It is plain JavaScript as a string because it runs inside the Dynamic Worker,
 * not in this Worker. `run(gateway, api, options)` is an RPC method the host
 * calls on the isolate's default entrypoint: `gateway` is an `RpcTarget` the
 * host passes as an argument (its stub lives for the call), `api` names the
 * callable tools by plugin, and the program itself is imported from
 * `program.js`, which the host writes from the model's code with `wrapProgram`.
 *
 * Everything the program can reach is built here: `tools`, whose functions
 * forward to the gateway and throw a coded Error on refusal or failure;
 * `console`, captured and bounded; and the deadline race. `fetch` and
 * `connect` are blocked by the loader (`globalOutbound: null`), not by this
 * module.
 */
export const ENTRY_MODULE = "entry.js";
export const PROGRAM_MODULE = "program.js";

export const ENTRY_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import run from "./program.js";

function textBytes(text) {
  return new TextEncoder().encode(text).byteLength;
}

export default class extends WorkerEntrypoint {
  async run(gateway, api, options) {
    const logs = [];
    let logBytes = 0;
    let logsTruncated = false;
    const push = (level, args) => {
      if (logsTruncated) return;
      const text = args.map((part) => {
        if (typeof part === "string") return part;
        try { return JSON.stringify(part); } catch { return String(part); }
      }).join(" ");
      const bytes = textBytes(text);
      if (logBytes + bytes > options.logMaxBytes) {
        logsTruncated = true;
        logs.push({ level, text: "[log output truncated]" });
        return;
      }
      logBytes += bytes;
      logs.push({ level, text });
    };
    const programConsole = {
      log: (...args) => push("log", args),
      info: (...args) => push("log", args),
      debug: (...args) => push("log", args),
      warn: (...args) => push("warn", args),
      error: (...args) => push("error", args),
    };
    const tools = {};
    for (const [plugin, names] of Object.entries(api)) {
      tools[plugin] = {};
      for (const name of names) {
        tools[plugin][name] = async (input) => {
          const answer = await gateway.call(plugin, name, input === undefined ? {} : input);
          if (answer.ok) return answer.output;
          const error = new Error(answer.error);
          error.code = answer.code;
          error.callIndex = answer.index;
          throw error;
        };
      }
    }
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("deadline");
        error.code = "deadline";
        reject(error);
      }, options.deadlineMs);
    });
    try {
      const value = await Promise.race([run(tools, programConsole, options.input), deadline]);
      let valueJson;
      try {
        valueJson = JSON.stringify(value === undefined ? null : value, (_, part) => typeof part === "bigint" ? part.toString() : part) ?? "null";
      } catch (error) {
        return { ok: false, error: { code: "unserializable", message: String(error && error.message || error) }, logs, logsTruncated };
      }
      return { ok: true, valueJson, logs, logsTruncated };
    } catch (error) {
      const message = error && typeof error.message === "string" ? error.message : String(error);
      return {
        ok: false,
        error: {
          code: error && typeof error.code === "string" ? error.code : null,
          message,
          callIndex: error && typeof error.callIndex === "number" ? error.callIndex : null,
          stack: error && typeof error.stack === "string" ? error.stack.split("\\n").slice(0, 6).join("\\n") : null,
        },
        logs,
        logsTruncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
`;

/**
 * The program as a module. A model that writes a bare function body gets it
 * wrapped; one that already wrote `export default async function` is taken as
 * written, so both the shape the prompt teaches and the shape a model falls
 * into on its own run.
 */
export function wrapProgram(code: string): string {
  if (/^\s*export\s+default\b/m.test(code)) return code;
  return `export default async function run(tools, console, input) {\n${code}\n}`;
}
