import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { afterEach } from 'vitest';
// jsdom ships no IndexedDB, and the composer's draft cache lives in one.
import 'fake-indexeddb/auto';
import { closeLocalCache } from '../lib/local-cache';

// An eviction forgets a conversation on disk from wherever it runs, so a test
// that evicts under fake timers leaves the local cache holding a database open
// that lands on the fake clock and never settles; the next test in the same
// worker that touches the cache would then hang on it. Dropping the connection
// after every test makes the cache an environment fact rather than a hazard
// each file has to know about.
afterEach(() => {
  closeLocalCache();
});

// `waitFor` and every helper built on it default to a one-second budget, which
// bets on the machine rather than on the code: a loaded CI runner can leave the
// continuation of an already-resolved promise waiting longer than that, and the
// test then fails as an assertion that never came true — indistinguishable from
// a real defect, and only ever on CI. Five seconds costs a passing run nothing
// and only slows one that was going to fail anyway.
configure({
  asyncUtilTimeout: 5_000,
  // An SVG `<title>` is the mark's metadata, not the page's text. The company
  // marks carry one — `<title>Notion</title>` inside the Notion glyph — so a
  // text query for a connector's name matched both the label a person reads and
  // the glyph beside it. `script, style` is the library's own default for the
  // same reason; this adds the third element whose text is not page text.
  defaultIgnore: 'script, style, title',
});

/**
 * jsdom implements no `ResizeObserver`, and several components construct one on
 * mount. Individual tests used to install their own inside an `it()`, which made
 * every later test in the same file depend on that one having run first: the
 * stub outlived the test that created it, so the file passed as a unit and its
 * tests failed the moment anything reset globals between them.
 *
 * Defining it here makes it part of the environment rather than something a test
 * leaks. It is assigned directly instead of through `vi.stubGlobal` because
 * `unstubGlobals` reverts stubs before each test, which would take this with it.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

// Like Element geometry, text-range geometry has no layout in jsdom. Real
// text fitting is verified in Electron; DOM tests only need the API to exist.
Range.prototype.getBoundingClientRect ??= function getBoundingClientRect(): DOMRect {
  return new DOMRect();
};

/**
 * jsdom implements no `scrollIntoView` either, and a component that keeps a
 * highlighted row under the reader calls it. Left undefined, the call throws
 * rather than doing nothing, so a test covering that component fails on the
 * environment instead of on the behaviour. Assigned here for the same reason as
 * the observer above; jsdom lays nothing out, so a test asserts that the call
 * was made, never where it landed.
 */
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
