/**
 * Encoding a tool result as the message that answers its call.
 *
 * Deliberately its own module with **type-only** imports: the tool loop uses
 * this encoder, and `./dispatch` imports zod at runtime for schema conversion.
 * Folding the two together would pull zod into the module graph of every host
 * that imports only `@juno-ai/bind/loop`, which today needs none of it.
 */
import type OpenAI from "openai";
import type { ToolResult } from "./tool";

/**
 * Encode a {@link ToolResult} as the `role:"tool"` message that answers a call.
 *
 * This is the encoding the loop itself synthesizes for a failed or refused
 * call, exported so a host's own results are shaped identically — a model that
 * sees `{"success":false,"kind":…,"error":…}` from the harness and something
 * else from the host has to learn two error formats in one transcript.
 *
 * `contentParts` and `suspend` are deliberately omitted: both are control
 * signals for the host, not text for the model. A host relaying multimodal
 * parts attaches them alongside this message.
 */
export function toolResultMessage(
  toolCallId: string,
  result: ToolResult<unknown>,
): OpenAI.ChatCompletionToolMessageParam {
  const body = result.success
    ? { success: true, data: result.data }
    : {
        success: false,
        // `success` and `kind` lead so a model skimming a batch of results
        // reads the verdict before the prose, and the order is fixed —
        // `success`, `kind`, `error`, then `data` when present — so the same
        // result always serializes to the same bytes.
        ...(result.kind === undefined ? {} : { kind: result.kind }),
        error: result.error,
        ...(result.data === undefined ? {} : { data: result.data }),
      };
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(body),
  };
}
