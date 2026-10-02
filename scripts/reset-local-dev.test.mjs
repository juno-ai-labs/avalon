import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import {
  desktopAppDataDirectory,
  liveDesktopLockHolder,
  localResetTargets,
  probeLocalWorker,
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

test("on Windows a lockfile nothing holds does not block the reset, and one that cannot be opened does", () => {
  const directory = mkdtempSync(join(tmpdir(), "reset-local-dev-"));
  try {
    assert.equal(liveDesktopLockHolder(directory, "win32"), null);
    const lockfile = join(directory, "lockfile");
    writeFileSync(lockfile, "");
    assert.equal(liveDesktopLockHolder(directory, "win32"), null);
    // A running client's sharing violation, as far as a POSIX host can stage
    // one: the file is there and cannot be opened.
    chmodSync(lockfile, 0o000);
    assert.equal(liveDesktopLockHolder(directory, "win32"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only a refused connection counts as no local Worker; a timeout blocks", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const timedOut = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.equal(await probeLocalWorker("http://127.0.0.1:1", async () => { throw refused; }), "free");
  assert.equal(await probeLocalWorker("http://127.0.0.1:1", async () => { throw timedOut; }), "not_answering");
  assert.equal(await probeLocalWorker("http://127.0.0.1:1", async () => { throw new TypeError("fetch failed"); }), "unknown");
  assert.equal(await probeLocalWorker("http://127.0.0.1:1", async () => new Response("ok")), "running");
});

test("a port with nothing on it reads as free", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probeLocalWorker(`http://127.0.0.1:${port}`), "free");
});
