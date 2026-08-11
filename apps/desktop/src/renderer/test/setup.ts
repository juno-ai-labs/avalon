import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// `waitFor` and every helper built on it default to a one-second budget, which
// bets on the machine rather than on the code: a loaded CI runner can leave the
// continuation of an already-resolved promise waiting longer than that, and the
// test then fails as an assertion that never came true — indistinguishable from
// a real defect, and only ever on CI. Five seconds costs a passing run nothing
// and only slows one that was going to fail anyway.
configure({ asyncUtilTimeout: 5_000 });
