import { availableParallelism } from 'node:os';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Settings that describe how a test behaves rather than what it runs against,
// so both projects below take them verbatim.
const shared = {
  globals: true,
  // The renderer's performance traces print at the trace level on every
  // build, which is what makes a slow work stream diagnosable from a user's
  // DevTools without a preference nobody had enabled at the time. In a suite
  // that would be a hundred lines of noise per run, so console output is
  // buffered and printed only for the tests that fail — where it is the
  // context a reader wants anyway.
  silent: 'passed-only' as const,
  // Must stay above the `asyncUtilTimeout` configured in the setup file, so a
  // condition that never settles is reported as the assertion that failed
  // rather than as a bare test timeout.
  testTimeout: 15_000,
  // A test that stubs a global, an env var, or a mock must not hand it to
  // whichever test runs next. Vitest restores spies by default but leaves
  // `vi.stubGlobal` and `vi.stubEnv` in place, which is the leak most likely
  // to make one file's failure depend on another file having run.
  restoreMocks: true,
  unstubGlobals: true,
  unstubEnvs: true,
};

// Split by process, not by convenience. Building a jsdom window costs about a
// second per file and it was being paid by all of them — 114s of a 120s run,
// most of it for main-process tests that never touch a DOM. The renderer keeps
// jsdom and the setup file that patches its gaps; everything else runs on node,
// which is also the honest environment for it: a main-process module that
// reaches for `document` should fail here rather than find a window that
// Electron's main process does not have.
//
// A main or common test that genuinely needs a DOM opts back in with a
// `// @vitest-environment jsdom` docblock, which overrides the project.
export default defineConfig({
  test: {
    // Vitest keeps one core free by default (`availableParallelism() - 1`),
    // which is the right hedge for a watch run sharing a machine with an editor
    // and a dev server. A one-shot `vitest run` — what CI and the quality gates
    // do — has nothing to share with, and these files spend enough of their time
    // off-CPU (module resolution, SQLite, reading fixtures) that the freed core
    // is idle rather than held in reserve. Measured on a 4-core sandbox: api
    // 98s -> 84s, desktop 84s -> 78s.
    maxWorkers: availableParallelism(),
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['./src/renderer/test/setup.ts'],
          include: ['./src/renderer/**/*.test.{ts,tsx}'],
          ...shared,
        },
      },
      {
        test: {
          name: 'main',
          environment: 'node',
          // `common` is here because the code both processes share lives there
          // and a test that never runs is worse than no test: it reads as
          // coverage. `src/common/application-icons.test.ts` had been dark
          // since it was written.
          include: ['./src/{main,common}/**/*.test.{ts,tsx}'],
          ...shared,
        },
      },
    ],
  },
});
