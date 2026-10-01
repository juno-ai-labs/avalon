import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  desktopAppDataDirectory,
  liveDesktopLockHolder,
  localResetTargets,
} from "./reset-local-dev.mjs";

test("the reset clears Worker state and the desktop session but keeps browser sign-ins", () => {
  assert.deepEqual(
    localResetTargets({
      repositoryRoot: "/repo",
      desktopUserDataDirectory: "/data/Rally Development",
      desktopEntries: [
        "Partitions",
        "rally-data",
        "IndexedDB",
        "Local Storage",
        "application-settings.json",
        "main-window-state.json",
        "Cookies",
      ],
    }),
    [
      "/repo/apps/api/.wrangler/state",
      "/data/Rally Development/rally-data",
      "/data/Rally Development/IndexedDB",
      "/data/Rally Development/Local Storage",
      "/data/Rally Development/Cookies",
    ],
  );
});

test("the desktop data directory follows Electron's appData on each platform", () => {
  assert.equal(desktopAppDataDirectory("darwin", {}, "/Users/a"), "/Users/a/Library/Application Support");
  assert.equal(desktopAppDataDirectory("linux", {}, "/home/a"), "/home/a/.config");
  assert.equal(desktopAppDataDirectory("linux", { XDG_CONFIG_HOME: "/x" }, "/home/a"), "/x");
  assert.equal(desktopAppDataDirectory("win32", { APPDATA: "C:\\R" }, "C:\\Users\\a"), "C:\\R");
});

test("a lock left by a client that has exited does not block the reset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reset-local-dev-"));
  try {
    assert.equal(liveDesktopLockHolder(directory), null);

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    symlinkSync(`host-${child.pid}`, join(directory, "SingletonLock"));
    assert.equal(liveDesktopLockHolder(directory), child.pid);

    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(liveDesktopLockHolder(directory), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
