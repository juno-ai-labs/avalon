import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  // The desktop release rewrote release.config.json on its runner and promoted
  // the channel, but has not yet committed the rewrite back to main; this copy
  // is the older committed one.
  const result = compareToChannel("1.32.0", manifest("1.34.0"));
  assert.equal(result.ok, false);
  assert.equal(result.channelVersion, "1.34.0");
  assert.equal(result.configVersion, "1.32.0");
});

test("the config path resolves from the script's own repository, not the caller's directory", () => {
  // The desktop release invokes this script by absolute path inside a worktree
  // of main's tip while the shell stays in the release checkout. Resolving
  // from the working directory instead would compare the stale release
  // checkout's config against the live channel and pass for the wrong reason.
  // A fresh child process from a foreign directory is the only honest probe:
  // this test file's own import already froze the module with the repository
  // as its working directory.
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "check-site-release-config.mjs");
  const probe = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { configPath } from ${JSON.stringify(pathToFileURL(scriptPath).href)}; console.log(configPath);`,
  ], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), resolve(dirname(scriptPath), "../apps/site/release.config.json"));
});
