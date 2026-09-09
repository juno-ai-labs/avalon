import type { ResidentContextObjectPort } from "../../durable-objects/workstream-resident-context-protocol";
import type { ResidentContextLoadedBlock } from "../../durable-objects/workstream-resident-context-storage";
import {
  INSTRUCTIONS_PENDING_EXIT_CODE,
  instructionFileCandidates,
  instructionProbeFragment,
  instructionProbeMarker,
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
 *
 * One failure has a lasting effect. Once the ledger could not be read or
 * written, an abort-mode probe would refuse a mutation for instructions that
 * never arrive, and the retry would refuse again, for the rest of the run. So
 * after the first ledger failure every probe runs in report mode: discovery
 * and recording keep being attempted, the gate before a mutation is off, and
 * the one refusal already issued tells the model its retry proceeds.
 */
/** One probe invocation: the shell text a command carries and the marker its trailer starts with. */
export interface TerminalInstructionProbe {
  text: string;
  marker: string;
}

export interface TerminalInstructionFiles {
  fragment(input: { mode: InstructionProbeMode; touched: readonly string[] }): Promise<TerminalInstructionProbe>;
  record(input: { stdout: string; marker: string; exitCode: number; sourceGeneration: number }): Promise<{
    stdout: string;
    /** Paths whose instructions were recorded with a pending delivery by this call. */
    recordedPaths: string[];
    /** Paths the probe reported as new that the ledger already had in context. */
    alreadyResidentPaths: string[];
    /** The trailer was missing or the ledger failed; nothing this call found is recorded. */
    failed: boolean;
  }>;
  /** A replaced work space: every block of the kind leaves context at once. */
  invalidate(): Promise<void>;
}

const KIND = "repository_instructions" as const;

export function createTerminalInstructionFiles(
  port: ResidentContextObjectPort,
  onFailure: (error: unknown, stage: "resident" | "record" | "invalidate") => void,
): TerminalInstructionFiles {
  let degraded = false;
  const fail = (error: unknown, stage: "resident" | "record" | "invalidate") => {
    degraded = true;
    onFailure(error, stage);
  };
  return {
    async fragment({ mode, touched }) {
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
          mode: degraded ? "report" : mode,
          candidates: instructionFileCandidates(touched),
          knownResident,
          marker,
        }),
      };
    },
    async record({ stdout, marker, exitCode, sourceGeneration }) {
      const split = splitInstructionProbeTrailer(stdout, marker);
      if (!split.probe) {
        // A command the probe stopped must have printed its trailer; a stop
        // without one is a probe that cannot be trusted to gate anything.
        if (exitCode === INSTRUCTIONS_PENDING_EXIT_CODE) fail(new Error("instruction_probe_trailer_missing"), "record");
        return { stdout: split.stdout, recordedPaths: [], alreadyResidentPaths: [], failed: exitCode === INSTRUCTIONS_PENDING_EXIT_CODE };
      }
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
      if (blocks.length === 0) return { stdout: split.stdout, recordedPaths: [], alreadyResidentPaths: [], failed: false };
      try {
        const outcome = await port.recordLoaded({ kind: KIND, sourceGeneration, blocks, now: Date.now() });
        return { stdout: split.stdout, recordedPaths: outcome.recorded, alreadyResidentPaths: outcome.alreadyResident, failed: false };
      } catch (error) {
        fail(error, "record");
        return { stdout: split.stdout, recordedPaths: [], alreadyResidentPaths: [], failed: true };
      }
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

function directoriesOf(paths: readonly string[]): string {
  return [...new Set(paths.map((path) => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "./" : `./${path.slice(0, slash)}/`;
  }))].map((directory) => `\`${directory}\``).join(", ");
}

/**
 * The refusal a mutating tool returns when the probe stopped it for a
 * governing instruction file that was not yet in context. A normal domain
 * outcome, not a transport failure. Which message the model is told to expect
 * depends on what the ledger did with the probe's findings:
 *
 * - recorded, or recorded by an earlier call in the same batch and not yet
 *   delivered: the instructions arrive with this batch; read them, then retry;
 * - failed, or nothing found: the ledger is unavailable, the probe has stopped
 *   gating for the rest of the run, and the retry proceeds without them.
 */
export function instructionsPendingError(outcome: {
  recordedPaths: readonly string[];
  alreadyResidentPaths: readonly string[];
  failed: boolean;
}): TerminalToolError {
  const loaded = [...outcome.recordedPaths, ...outcome.alreadyResidentPaths];
  if (loaded.length > 0 && !outcome.failed) {
    return new TerminalToolError(
      "instructions_pending",
      `Repository instructions for ${directoriesOf(loaded)} were loaded with this call and nothing was changed. Read the \`Instructions added from\` message that follows, then retry the same call.`,
      { reason: "Read the repository instructions message that follows this result, then retry the same call unchanged." },
    );
  }
  return new TerminalToolError(
    "instructions_unavailable",
    "The repository instructions governing this call could not be loaded and nothing was changed. Retry the same call; it proceeds without them.",
    { reason: "Retry the same call unchanged; it will proceed without repository instructions." },
  );
}
