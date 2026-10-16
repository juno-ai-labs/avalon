import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";

import { hiddenInputControlLabelRule } from "./eslint-rules/hidden-input-control-label.mjs";

const config = {
  languageOptions: { ecmaVersion: 2024, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
  plugins: { rally: { rules: { "hidden-input-control-label": hiddenInputControlLabelRule } } },
  rules: { "rally/hidden-input-control-label": ["error", { classNames: ["settings-toggle"] }] },
};

function lint(source) {
  return new Linter({ configType: "flat" }).verify(source, config);
}

// The digest slots shipped this way: the drawn switch could not be clicked.
test("rejects a listed control drawn on a span with no label around it", () => {
  const messages = lint(`<div><span className="settings-toggle"><input type="checkbox" /><span /></span></div>;`);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /settings-toggle/u);
});

test("finds the class inside a template literal or a conditional", () => {
  assert.equal(lint("<span className={`row ${on ? 'settings-toggle' : 'other'}`} />;").length, 1);
  assert.equal(lint("<span className={wide && 'settings-toggle'} />;").length, 1);
});

test("reads a template's classes across interpolations, not its fragments", () => {
  assert.deepEqual(lint("<span className={`settings-toggle${'-hint'}`} />;"), []);
  assert.deepEqual(lint("<span className={`${hint ? 'settings-toggle' : 'watch-toggle'}-hint`} />;"), []);
  assert.equal(lint("<span className={`settings-toggle ${extra}`} />;").length, 1);
});

test("finds the class passed through clsx, as a string, an array item, or an object key", () => {
  assert.equal(lint("<span className={clsx('row', on && 'settings-toggle')} />;").length, 1);
  assert.equal(lint("<span className={clsx(['settings-toggle'])} />;").length, 1);
  assert.equal(lint("<span className={clsx({ 'settings-toggle': on })} />;").length, 1);
  assert.deepEqual(lint("<label className={clsx('settings-toggle', on && 'is-on')} />;"), []);
});

test("accepts the control as a label", () => {
  assert.deepEqual(lint(`<label className="settings-toggle"><input type="checkbox" /><span /></label>;`), []);
});

test("accepts the control inside a label, as SettingToggle draws it", () => {
  assert.deepEqual(lint(`<label className="row"><span className="settings-toggle"><input /><span /></span></label>;`), []);
});

test("ignores classes not in the list, and a class that only contains a listed name", () => {
  assert.deepEqual(lint(`<span className="digest-slot settings-toggle-hint" />;`), []);
});
