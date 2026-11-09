/**
 * The workers suite's per-test timeout, in one place: `vitest.workers.config.ts`
 * sets `testTimeout` from it, and `wait-budget.ts` derives each test's wait
 * deadline from it, so the two cannot drift apart.
 */
export const WORKERS_TEST_TIMEOUT_MS = 30_000;
