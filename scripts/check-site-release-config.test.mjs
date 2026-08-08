import assert from "node:assert/strict";
import test from "node:test";

import { channelVersionFrom, compareToChannel } from "./check-site-release-config.mjs";

const manifest = (version) => `version: ${version}\nfiles:\n  - url: Avalon-${version}-mac-arm64.zip\n`;

test("the live channel version is read from the update manifest", () => {
  assert.equal(channelVersionFrom(manifest("1.34.0")), "1.34.0");
  assert.equal(channelVersionFrom("version: '1.34.0'\n"), "1.34.0");
});

test("a manifest without a usable version is rejected rather than assumed", () => {
  assert.throws(() => channelVersionFrom("files:\n  - url: Avalon.zip\n"), /semantic version/u);
  assert.throws(() => channelVersionFrom("version: latest\n"), /semantic version/u);
});

test("a config matching the live channel passes", () => {
  const result = compareToChannel("1.34.0", manifest("1.34.0"));
  assert.equal(result.ok, true);
  assert.equal(result.channelVersion, "1.34.0");
});

test("a config left behind by an uncommitted release is caught", () => {
  // The desktop release rewrote release.config.json on its runner and deployed
  // the site correctly; this copy is the older committed one.
  const result = compareToChannel("1.32.0", manifest("1.34.0"));
  assert.equal(result.ok, false);
  assert.equal(result.channelVersion, "1.34.0");
  assert.equal(result.configVersion, "1.32.0");
});
