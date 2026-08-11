import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: ['./src/{renderer,main}/**/*.test.{ts,tsx}'],
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
