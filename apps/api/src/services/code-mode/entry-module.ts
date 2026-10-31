/**
 * The host-authored module a program's isolate starts from.
 *
 * It is plain JavaScript as a string because it runs inside the Dynamic Worker,
 * not in this Worker. `run(gateway, api, options)` is an RPC method the host
 * calls on the isolate's default entrypoint: `gateway` is an `RpcTarget` the
 * host passes as an argument (its stub lives for the call), `api` names the
 * callable tools by plugin so the program can enumerate them, and the program
 * itself is imported from `program.js`, which the host writes from the model's
 * code with `wrapProgram`.
 *
 * Everything the program can reach is built here: `tools`, a proxy whose
 * functions forward to the gateway and throw a coded Error on refusal or
 * failure (an unknown name is forwarded too, so the gateway refuses it by
 * name); `console`, captured; and the deadline race. `fetch` and `connect`
 * are blocked by the loader (`globalOutbound: null`), not by this module.
 *
 * Nothing the isolate answers is trusted on its own: the host parses the
 * answer with a schema and reads the outcome of every tool call from its own
 * records, not from the error the program chose to throw.
 */
export const ENTRY_MODULE = "entry.js";
export const PROGRAM_MODULE = "program.js";

/** Property names a program's own machinery probes; never a tool call. */
const PROBED_NAMES = ["then", "catch", "finally", "toJSON", "constructor", "valueOf", "toString", "inspect", "nodejs.util.inspect.custom"];

export const ENTRY_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import run from "./program.js";

const PROBED = new Set(${JSON.stringify(PROBED_NAMES)});

function toolProxy(gateway, plugin, names) {
  const known = {};
  const call = (name) => async (input) => {
    const answer = await gateway.call(plugin, name, input === undefined ? {} : input);
    if (answer.ok) return answer.output;
    const error = new Error(answer.error);
    error.code = answer.code;
    error.callIndex = answer.index;
    throw error;
  };
  for (const name of names) known[name] = call(name);
  return new Proxy(known, {
    get(target, property) {
      if (typeof property !== "string" || PROBED.has(property)) return Reflect.get(target, property);
      return property in target ? target[property] : call(property);
    },
  });
}

function toolsProxy(gateway, api) {
  const known = {};
  for (const [plugin, names] of Object.entries(api)) known[plugin] = toolProxy(gateway, plugin, names);
  return new Proxy(known, {
    get(target, property) {
      if (typeof property !== "string" || PROBED.has(property)) return Reflect.get(target, property);
      return property in target ? target[property] : toolProxy(gateway, property, []);
    },
  });
}

export default class extends WorkerEntrypoint {
  async run(gateway, api, options) {
    const logs = [];
    const push = (level, args) => {
      const text = args.map((part) => {
        if (typeof part === "string") return part;
        try { return JSON.stringify(part); } catch { return String(part); }
      }).join(" ");
      logs.push({ level, text });
    };
    const programConsole = {
      log: (...args) => push("log", args),
      info: (...args) => push("log", args),
      debug: (...args) => push("log", args),
      warn: (...args) => push("warn", args),
      error: (...args) => push("error", args),
    };
    const tools = toolsProxy(gateway, api);
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
        return { ok: false, error: { code: "unserializable", message: String(error && error.message || error), callIndex: null }, logs };
      }
      return { ok: true, valueJson, logs };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error && typeof error.code === "string" ? error.code : null,
          message: error && typeof error.message === "string" ? error.message : String(error),
          callIndex: error && typeof error.callIndex === "number" ? error.callIndex : null,
        },
        logs,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
`;

/**
 * The program as a module: the model's function body, always wrapped, with
 * `tools`, `console` and `input` in scope. The wrapping is unconditional so
 * the module's shape is the host's, never the program's. A body that uses
 * module syntax, or escapes its braces, fails to compile or runs at module
 * level in an isolate that holds nothing to reach: no bindings, no network,
 * and the loader's own error is the program's failure.
 */
export function wrapProgram(code: string): string {
  return `export default async function run(tools, console, input) {\n${code}\n}`;
}
