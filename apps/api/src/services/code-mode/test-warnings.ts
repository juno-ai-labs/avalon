/**
 * What a saved tool's test run tells its author beyond pass or fail, measured
 * on the test itself, so the setup agent reads it where it acts rather than
 * recalling one sentence of a long guide.
 */
import { programCalls } from "./check";

export interface ProgramTestEvidence {
  /** The saved tool's code. */
  code: string;
  /** The program's calls, as `finishProgram` reports them (`<plugin>.<tool>`). */
  calls: ReadonlyArray<{ tool: string }>;
}

/**
 * A program that reads `current_time` more than once and never calls
 * `msLeft()` is most likely timing its share against a fixed number, which
 * the guide replaced with `msLeft()`. One read is right for working out which
 * dates the work covers, so only repeated reads are evidence.
 */
export function programTestWarnings(evidence: ProgramTestEvidence): string[] {
  const clockReads = evidence.calls.filter((call) => call.tool.endsWith(".current_time")).length;
  if (clockReads <= 1 || programCalls(evidence.code, "msLeft")) return [];
  return [`The program read current_time ${clockReads} times and never calls msLeft(). If those reads time its share, use msLeft() instead: it costs no call and follows the real deadline. current_time stays right for working out which dates the work covers.`];
}
