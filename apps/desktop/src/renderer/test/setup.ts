import '@testing-library/jest-dom/vitest';
// jsdom ships no IndexedDB, and the composer's draft cache lives in one.
import 'fake-indexeddb/auto';
