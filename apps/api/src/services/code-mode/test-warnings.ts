/**
 * What a saved tool's test run tells its author beyond pass or fail: the two
 * shapes that cost a Sidekick at run time and that the custom-tools guide asks
 * the author to avoid, measured on the test itself, so the setup agent reads
 * them where it acts rather than recalling one sentence of a long guide.
 */
import { CODE_PROGRAM_DEADLINE_MS } from "./limits";

/**
 * How much of the program deadline a test may use before it is warned. Not a
 * limit: nothing is refused. It is the guide's own target for a share, "about
 * three quarters of" the deadline, so a test past it has no room left for a
 * slower day.
 */
export const TEST_WARNING_DEADLINE_SHARE = 0.75;

export interface ProgramTestEvidence {
  /** The saved tool's code. */
  code: string;
  /** The program's calls, as `finishProgram` reports them (`<plugin>.<tool>`). */
  calls: ReadonlyArray<{ tool: string }>;
  /** Wall time of the test, from the call to the answer. */
  elapsedMs: number;
}

export function programTestWarnings(evidence: ProgramTestEvidence): string[] {
  const warnings: string[] = [];
  const budgetMs = CODE_PROGRAM_DEADLINE_MS * TEST_WARNING_DEADLINE_SHARE;
  if (evidence.elapsedMs > budgetMs) {
    warnings.push(`The test took ${Math.round(evidence.elapsedMs / 1000)} s of the ${CODE_PROGRAM_DEADLINE_MS / 1000} s a program has, past the ${Math.round(budgetMs / 1000)} s a share should stop at; a slower day ends it at the deadline. Keep taking groups only while msLeft() exceeds the slowest group, with room for the last write.`);
  }
  const clockReads = evidence.calls.filter((call) => call.tool.endsWith(".current_time")).length;
  if (clockReads > 1 && !/\bmsLeft\s*\(/.test(evidence.code)) {
    warnings.push(`The program read current_time ${clockReads} times and never calls msLeft(). If those reads time its share, use msLeft() instead: it costs no call and follows the real deadline. current_time stays right for working out which dates the work covers.`);
  }
  return warnings;
}
