#!/usr/bin/env node
// Returns a workstation's local Rally stack to the state a fresh checkout
// starts from: empty Worker state, migrated and seeded, and a desktop client
// that holds no session or cache from the database it replaces.
//
// Local state drifts in two halves that nothing reconciles. D1 is migrated and
// re-seeded by script, but each Durable Object keeps whatever an earlier
// checkout's code wrote into it, so a months-old `apps/api/.wrangler/state`
// serves channels whose parent conversation no longer exists
// (`conversation_parent_missing`, `conversation_not_found`) and the sidebar
// stays on "Rally is opening this organization". The desktop half drifts with
// it: its stored session names an account in the old database
// (`account_reconnect_required`) and its renderer caches still list the old
// channels. Both halves have to go together, or the half left behind is the
// one that looks broken.
//
// Kept on purpose: the desktop's `Partitions/` (the sign-ins to claude.ai,
// ChatGPT and other sites made inside Rally's browser, which take a person to
// redo and hold nothing from the local database) and its window and
// application settings.
//
// Refuses while a local Worker or the development desktop client is running:
// both hold these files open, and wiping under them leaves exactly the
// half-reset state this exists to remove.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "./entry-point.mjs";
import { configuredRegions, regions } from "./regions.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Desktop userData entries a reset leaves in place; see the header. */
export const KEPT_DESKTOP_ENTRIES = Object.freeze([
  "Partitions",
  "application-settings.json",
  "main-window-state.json",
]);

/**
 * Electron's `appData` for this platform, where the development client keeps
 * `Rally Development` (see `apps/desktop/src/main/user-data-path.ts`).
 */
function desktopAppDataDirectory(platform, env, home) {
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || join(home, ".config");
}

/** Every path the reset deletes, given what is on disk now. */
export function localResetTargets({ repositoryRoot, desktopUserDataDirectory, desktopEntries }) {
  return [
    join(repositoryRoot, "apps", "api", ".wrangler", "state"),
    ...desktopEntries
      .filter((entry) => !KEPT_DESKTOP_ENTRIES.includes(entry))
      .map((entry) => join(desktopUserDataDirectory, entry)),
  ];
}

/**
 * What holds Chromium's single-instance lock, if anything live does: a PID on
 * macOS and Linux, `true` on Windows, where no PID is recorded.
 *
 * On macOS and Linux the lock is a symlink whose target is `<hostname>-<pid>`,
 * and it outlives a crashed client, so the PID is checked rather than the
 * link's presence. On Windows the client holds `lockfile` open with no
 * sharing for as long as it runs, so the file being openable is what proves
 * nothing does.
 */
export function liveDesktopLockHolder(desktopUserDataDirectory, platform = process.platform) {
  if (platform === "win32") return windowsLockHeld(join(desktopUserDataDirectory, "lockfile"));
  let target;
  try {
    target = readlinkSync(join(desktopUserDataDirectory, "SingletonLock"));
  } catch {
    return null;
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return error?.code === "EPERM" ? pid : null;
  }
}

function windowsLockHeld(lockfile) {
  if (!existsSync(lockfile)) return null;
  try {
    closeSync(openSync(lockfile, "r+"));
    return null;
  } catch (error) {
    // EBUSY or EPERM: a sharing violation, which only a live holder causes.
    // Anything else is not proof the client is gone, so it blocks too.
    return error?.code === "ENOENT" ? null : true;
  }
}

/**
 * Whether a local Worker may be using its SQLite files: `free` only on a
 * refused connection. A timeout is a Worker still starting or busy, not an
 * absent one, so it blocks like an answer does.
 */
export async function probeLocalWorker(url, fetchImpl = fetch) {
  try {
    await fetchImpl(url, { signal: AbortSignal.timeout(1000) });
    return "running";
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (code === "ECONNREFUSED") return "free";
    return error?.name === "TimeoutError" ? "not_answering" : "unknown";
  }
}

async function runningWorkers() {
  const running = [];
  for (const region of configuredRegions) {
    const url = regions[region].localApiUrl;
    const state = await probeLocalWorker(url);
    if (state === "running") running.push(`${region} at ${url}`);
    else if (state === "not_answering") running.push(`${region} at ${url} (listening but not answering; it may still be starting)`);
    else if (state === "unknown") running.push(`${region} at ${url} (could not tell whether it is running)`);
  }
  return running;
}

async function main() {
  const desktopUserDataDirectory = join(
    desktopAppDataDirectory(process.platform, process.env, homedir()),
    "Rally Development",
  );

  const workers = await runningWorkers();
  const desktopPid = liveDesktopLockHolder(desktopUserDataDirectory);
  if (workers.length > 0 || desktopPid !== null) {
    if (workers.length > 0) console.error(`A local Worker is running (${workers.join(", ")}).`);
    if (desktopPid !== null) {
      console.error(`The development desktop client is running${desktopPid === true ? "" : ` (pid ${desktopPid})`}.`);
    }
    console.error("Stop `pnpm dev` and quit Rally Development, then run `pnpm dev:reset` again.");
    process.exit(1);
  }

  const desktopEntries = existsSync(desktopUserDataDirectory) ? readdirSync(desktopUserDataDirectory) : [];
  for (const target of localResetTargets({ repositoryRoot, desktopUserDataDirectory, desktopEntries })) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      // Windows refuses to delete a file another process holds open, and
      // stops partway; name the file so the person can find what holds it.
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      console.error(`Could not remove ${error.path ?? target}: another process has it open (${error.code}).`);
      console.error("Quit whatever holds it (a Worker, Rally Development, an editor), then run `pnpm dev:reset` again.");
      process.exit(1);
    }
  }
  console.log("Removed local Worker state and the desktop client's Rally session and caches.");
  console.log(`Kept ${KEPT_DESKTOP_ENTRIES.join(", ")} in ${desktopUserDataDirectory}.`);

  for (const script of ["db:migrate", "db:seed"]) {
    execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [script], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  }

  console.log("\nLocal stack reset. Next: `pnpm dev`, then `pnpm db:open-authority` once the API is up.");
}

if (isEntryPoint(import.meta.url)) await main();
