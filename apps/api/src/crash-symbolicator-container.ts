import { Container } from "@cloudflare/containers";
import type { Env } from "./env";
import {
  symbolicateNativeCrash,
  type CrashSymbolicationResult,
  type CrashSymbolicatorExecutor,
} from "./crash-symbolicator";

function stream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/**
 * Region-local native compute for minidumps. The Worker supplies exact object
 * bytes over RPC, so the image has neither R2 credentials nor network egress.
 * One Durable Object name is allocated per work item to keep its fixed
 * workspace private even when several reports are processed concurrently.
 */
export class CrashSymbolicatorContainer extends Container<Env> {
  override entrypoint = ["sleep", "infinity"];
  override enableInternet = false;
  override sleepAfter = "30s";

  async symbolicate(dump: ArrayBuffer, symbols: ArrayBuffer): Promise<{
    parserState: CrashSymbolicationResult['parserState'];
    reportJson: string;
  }> {
    const container = this.ctx.container;
    if (!container) throw new Error("crash_symbolicator_container_unavailable");
    const executor: CrashSymbolicatorExecutor = {
      get running() {
        return container.running;
      },
      start: async () => {
        await this.start({ enableInternet: false });
      },
      exec: (command, options) => container.exec(command, options),
    };
    const result = await symbolicateNativeCrash(executor, {
      dump: stream(dump),
      symbols: stream(symbols),
    });
    return { parserState: result.parserState, reportJson: JSON.stringify(result.report) };
  }
}
