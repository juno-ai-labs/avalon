/**
 * One deadline for every wait a test makes, so its waits add up to less than
 * the test's own timeout.
 *
 * A file that gives each `expect.poll` its own fixed timeout chains them: three
 * 15-second polls in one test can need 45 seconds against the 30-second
 * `testTimeout` in `vitest.workers.config.ts`, and when the run is slow the
 * test dies as a bare "timed out" in the middle of a wait instead of failing on
 * the assertion that was not met. A poll left on Vitest's one-second default is
 * the opposite failure: under a contended run a frame or an alarm takes longer
 * than that, and the test fails though nothing is wrong.
 *
 * `startWaitBudget()` is called at the end of a file's `beforeEach`, when the
 * test's own clock starts; `waitBudget()` is each poll's timeout, the time
 * left before the deadline. A slow wait therefore gets everything the test has
 * left, and the one that runs out fails with its own assertion. The budget is
 * the suite's timeout (`WORKERS_TEST_TIMEOUT_MS`, which the config also reads)
 * less a margin for the work between the waits.
 */
import { WORKERS_TEST_TIMEOUT_MS } from "./test-timeout";

/**
 * Time kept back for the work between a test's waits (setup reads, closing
 * sockets). A test-harness setting, not a product limit; the team may change it.
 */
const MARGIN_MS = 5_000;

let deadline = 0;

export function startWaitBudget(): void {
  deadline = Date.now() + WORKERS_TEST_TIMEOUT_MS - MARGIN_MS;
}

/** The time left for this test's waits, for an `expect.poll` timeout. */
export function waitBudget(): number {
  return Math.max(1, deadline - Date.now());
}
