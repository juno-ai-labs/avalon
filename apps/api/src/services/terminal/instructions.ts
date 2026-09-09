import type { ResidentContextObjectPort } from "../../durable-objects/workstream-resident-context-protocol";
import type { ResidentContextLoadedBlock } from "../../durable-objects/workstream-resident-context-storage";
import {
  instructionFileCandidates,
  instructionProbeFragment,
  splitInstructionProbeTrailer,
  type InstructionProbeMode,
} from "./instruction-files";
import { TERMINAL_WORKSPACE_ROOT } from "./contract";
import { sanitizeTerminalOutput, TerminalToolError } from "./tools";

/**
 * The Terminal plugin's side of the context-residency ledger.
 *
 * The runtime asks for a probe fragment before it builds a sandbox command and
 * hands the command's stdout back afterwards; this module reads what is already
 * resident, splits the trailer off, sanitizes the content the way every other
 * Terminal byte projected to the model is sanitized, and records the blocks.
 * It never throws into a tool: a probe that fails leaves the tool's own outcome
 * alone and reports through `onFailure`, and the next touch retries discovery.
 */
export interface TerminalInstructionFiles {
  fragment(input: { mode: InstructionProbeMode; touched: readonly string[] }): Promise<string>;
  record(input: { stdout: string; sourceGeneration: number }): Promise<{
    stdout: string;
    pending: boolean;
    /** Paths whose instructions were recorded with a pending delivery by this call. */
    recordedPaths: string[];
  }>;
  /** A replaced work space: every block of the kind leaves context at once. */
  invalidate(): Promise<void>;
}

const KIND = "repository_instructions" as const;

export function createTerminalInstructionFiles(
  port: ResidentContextObjectPort,
  onFailure: (error: unknown, stage: "resident" | "record" | "invalidate") => void,
): TerminalInstructionFiles {
  return {
    async fragment({ mode, touched }) {
      let knownResident: string[] = [];
      try {
        knownResident = await port.residentBlocks({ kind: KIND });
      } catch (error) {
        // Without the known set every candidate looks new: a resident block is
        // then recorded again as already resident and nothing is delivered
        // twice, so the cost of this failure is one probe that read more.
        onFailure(error, "resident");
      }
      return instructionProbeFragment({
        root: TERMINAL_WORKSPACE_ROOT,
        mode,
        candidates: instructionFileCandidates(touched),
        knownResident,
      });
    },
    async record({ stdout, sourceGeneration }) {
      const split = splitInstructionProbeTrailer(stdout);
      if (!split.probe) return { stdout: split.stdout, pending: false, recordedPaths: [] };
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
      if (blocks.length === 0) return { stdout: split.stdout, pending: false, recordedPaths: [] };
      try {
        const outcome = await port.recordLoaded({ kind: KIND, sourceGeneration, blocks, now: Date.now() });
        return { stdout: split.stdout, pending: outcome.recorded.length > 0, recordedPaths: outcome.recorded };
      } catch (error) {
        onFailure(error, "record");
        return { stdout: split.stdout, pending: false, recordedPaths: [] };
      }
    },
    async invalidate() {
      try {
        await port.invalidateKind({ kind: KIND });
      } catch (error) {
        onFailure(error, "invalidate");
      }
    },
  };
}

/**
 * The refusal a mutating tool returns when a governing instruction file was
 * not yet in context. A normal domain outcome, not a transport failure: the
 * instructions are recorded and arrive with this batch, and the retry finds
 * them resident.
 */
export function instructionsPendingError(recordedPaths: readonly string[]): TerminalToolError {
  const directories = [...new Set(recordedPaths.map((path) => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "./" : `./${path.slice(0, slash)}/`;
  }))].map((directory) => `\`${directory}\``).join(", ");
  return new TerminalToolError(
    "instructions_pending",
    `Repository instructions for ${directories || "this work space"} were loaded with this call and nothing was changed. Read the \`Instructions added from\` message that follows, then retry the same call.`,
    { reason: "Read the repository instructions message that follows this result, then retry the same call unchanged." },
  );
}
