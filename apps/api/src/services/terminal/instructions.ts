import type { ResidentContextObjectPort } from "../../durable-objects/workstream-resident-context-protocol";
import type { ResidentContextLoadedBlock } from "../../durable-objects/workstream-resident-context-storage";
import {
  instructionFileCandidates,
  instructionProbeFragment,
  instructionProbeMarker,
  splitInstructionProbeTrailer,
} from "./instruction-files";
import { TERMINAL_WORKSPACE_ROOT } from "./contract";
import { sanitizeTerminalOutput } from "./tools";

/**
 * The Terminal plugin's side of the context-residency ledger.
 *
 * The runtime asks for a probe fragment before it builds a read's sandbox
 * command and hands the command's stdout back afterwards; this module reads
 * what is already resident, splits the trailer off, sanitizes the content the
 * way every other Terminal byte projected to the model is sanitized, and
 * records the blocks. It never throws into a tool: a probe that fails leaves
 * the tool's own outcome alone and reports through `onFailure`, and the next
 * read retries discovery.
 */
/** One probe invocation: the shell text a command carries and the marker its trailer starts with. */
export interface TerminalInstructionProbe {
  text: string;
  marker: string;
}

export interface TerminalInstructionFiles {
  fragment(input: { touched: readonly string[] }): Promise<TerminalInstructionProbe>;
  /** Record what the probe found and hand back the command's own stdout, trailer removed. */
  record(input: { stdout: string; marker: string; sourceGeneration: number }): Promise<{ stdout: string }>;
  /** A replaced work space: every block of the kind leaves context at once. */
  invalidate(): Promise<void>;
}

const KIND = "repository_instructions" as const;

export function createTerminalInstructionFiles(
  port: ResidentContextObjectPort,
  onFailure: (error: unknown, stage: "resident" | "record" | "invalidate") => void,
): TerminalInstructionFiles {
  const fail = onFailure;
  return {
    async fragment({ touched }) {
      let knownResident: string[] = [];
      try {
        knownResident = await port.residentBlocks({ kind: KIND });
      } catch (error) {
        // Without the known set every candidate looks new: a resident block is
        // then recorded again as already resident and nothing is delivered
        // twice, so the cost of this failure is one probe that read more.
        fail(error, "resident");
      }
      const marker = instructionProbeMarker();
      return {
        marker,
        text: instructionProbeFragment({
          root: TERMINAL_WORKSPACE_ROOT,
          candidates: instructionFileCandidates(touched),
          knownResident,
          marker,
        }),
      };
    },
    async record({ stdout, marker, sourceGeneration }) {
      const split = splitInstructionProbeTrailer(stdout, marker);
      // No trailer is a probe that never ran or failed; the command's own
      // output comes back whole and the next read retries discovery.
      if (!split.probe) return { stdout: split.stdout };
      const blocks: ResidentContextLoadedBlock[] = split.probe.entries
        .filter((entry) => !entry.resident)
        .map((entry) => ({
          blockId: entry.path,
          sha256: entry.sha256,
          content: entry.status
            ? `[Not read: ${entry.status}]`
            : sanitizeTerminalOutput(entry.content ?? ""),
          truncated: entry.truncated,
        }));
      if (blocks.length === 0) return { stdout: split.stdout };
      try {
        await port.recordLoaded({ kind: KIND, sourceGeneration, blocks, now: Date.now() });
      } catch (error) {
        fail(error, "record");
      }
      return { stdout: split.stdout };
    },
    async invalidate() {
      try {
        await port.invalidateKind({ kind: KIND });
      } catch (error) {
        fail(error, "invalidate");
      }
    },
  };
}
