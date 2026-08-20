import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // The renderer's performance traces print at the trace level on every
    // build, which is what makes a slow work stream diagnosable from a user's
    // DevTools without a preference nobody had enabled at the time. In a suite
    // that would be a hundred lines of noise per run, so console output is
    // buffered and printed only for the tests that fail — where it is the
    // context a reader wants anyway.
    silent: 'passed-only',
    setupFiles: ['./src/renderer/test/setup.ts'],
    // `common` is in the list because the code both processes share lives there
    // and a test that never runs is worse than no test: it reads as coverage.
    // `src/common/application-icons.test.ts` had been dark since it was written.
    include: ['./src/{renderer,main,common}/**/*.test.{ts,tsx}'],
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
  },
});
