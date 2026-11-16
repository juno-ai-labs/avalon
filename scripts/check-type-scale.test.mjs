import assert from 'node:assert/strict';
import test from 'node:test';

import { typeLiterals } from './check-type-scale.mjs';

test('a literal font size is refused, with its line', () => {
  assert.deepEqual(typeLiterals('.a { color: red; }\n.b { font-size: 13px; }'), [{ line: 2, declaration: 'font-size: 13px' }]);
  assert.deepEqual(typeLiterals('.c{font-size:1.2rem}'), [{ line: 1, declaration: 'font-size: 1.2rem' }]);
});

test('a size in the font shorthand is refused, and its line height alone is not', () => {
  assert.deepEqual(typeLiterals('.a { font: 600 29px/1.15 Georgia, serif; }'), [{ line: 1, declaration: 'font: 600 29px/1.15 Georgia, serif' }]);
  assert.deepEqual(typeLiterals('.a { font: var(--av-sys-type-title-1)/32px Georgia; }'), []);
  assert.deepEqual(typeLiterals('.a { font: inherit; }'), []);
  // A token in the line height does not excuse a literal size.
  assert.deepEqual(typeLiterals('.a { font: 13px/var(--x) serif; }'), [{ line: 1, declaration: 'font: 13px/var(--x) serif' }]);
  // Nor does a token in the family.
  assert.deepEqual(typeLiterals('.a { font: 600 14px var(--av-sys-font-family-ui); }'), [{ line: 1, declaration: 'font: 600 14px var(--av-sys-font-family-ui)' }]);
  assert.deepEqual(typeLiterals('.a { font: var(--av-cmp-control-font-size)/1.5 var(--av-sys-font-family-ui); }'), []);
});

test('a role, a token built on one, and a relative size all pass', () => {
  const css = [
    '.a { font-size: var(--av-sys-type-body); }',
    '.b { font-size: calc(var(--av-sys-font-size-prose) - 0.5px); }',
    '.c { font-size: 0.9em; }',
    '.d { font-size: inherit; }',
    '.e { font-size: 0; }',
  ].join('\n');
  assert.deepEqual(typeLiterals(css), []);
});

test('a declaration marked as not reading text passes, and the mark covers that declaration only', () => {
  const css = '.tile { font-size: 6px /* type-scale: glyph */; }\n.next { font-size: 6px; }';
  assert.deepEqual(typeLiterals(css), [{ line: 2, declaration: 'font-size: 6px' }]);
  assert.deepEqual(typeLiterals('.a { font-size: 16px !important; /* type-scale: iOS focus-zoom floor */ }'), []);
  // One-line rules: a mark on one declaration does not excuse the next.
  assert.deepEqual(typeLiterals('.a{font-size:6px /* type-scale: glyph */} .b{font-size:13px}'), [{ line: 1, declaration: 'font-size: 13px' }]);
  // A mark needs a reason.
  assert.deepEqual(typeLiterals('.a { font-size: 6px /* type-scale: */; }'), [{ line: 1, declaration: 'font-size: 6px' }]);
});

test('a length inside a comment, an @supports condition, or a property that merely ends in font-size, is not a declaration', () => {
  assert.deepEqual(typeLiterals('/* was\n  font-size: 13px */\n.a { --label-font-size: 13px; }'), []);
  assert.deepEqual(typeLiterals('@supports (font-size: 1px) { .a { color: red; } }'), []);
});

test('a floor on a role passes, and a var() that names no token does not', () => {
  assert.deepEqual(typeLiterals('.a { font-size: max(16px, var(--av-sys-type-body)); }'), []);
  assert.deepEqual(typeLiterals('.a { font-size: var(--x, 13px); }'), [{ line: 1, declaration: 'font-size: var(--x, 13px)' }]);
  assert.deepEqual(typeLiterals('.a { font-size: var(--local); }'), [{ line: 1, declaration: 'font-size: var(--local)' }]);
});

test('a size split over lines, or in upper case, is still a size', () => {
  assert.deepEqual(typeLiterals('.a {\n  font-size:\n    14px;\n}'), [{ line: 2, declaration: 'font-size: 14px' }]);
  assert.deepEqual(typeLiterals('.a { font-size: 14PX; }'), [{ line: 1, declaration: 'font-size: 14PX' }]);
});

test('in the shorthand, a token for the family or weight does not excuse a literal size', () => {
  assert.deepEqual(typeLiterals('.a { font: 600 14px var(--av-sys-font-family-ui); }'), [{ line: 1, declaration: 'font: 600 14px var(--av-sys-font-family-ui)' }]);
  assert.deepEqual(typeLiterals('.a { font: var(--av-sys-font-weight-strong) 14px/1.4 serif; }'), [{ line: 1, declaration: 'font: var(--av-sys-font-weight-strong) 14px/1.4 serif' }]);
  assert.deepEqual(typeLiterals('.a { font: var(--av-cmp-control-font-size)/1.5 var(--av-sys-font-family-ui); }'), []);
  assert.deepEqual(typeLiterals('.a { font: 600 calc(var(--av-sys-type-body) + 2px)/1.2 serif; }'), []);
});
