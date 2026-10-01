#!/usr/bin/env node
// Fetches the Electron binary when the `electron` package is installed without
// one, before `electron-vite dev` tries to launch it.
//
// The binary arrives through the package's own postinstall step, and pnpm runs
// that step once per package version: once `electron` is in the store, a later
// `pnpm install` reports nothing to do and `pnpm rebuild electron` exits 0
// without fetching. A checkout whose first install lost that download — a
// network drop, an interrupted install — keeps the package and loses the
// binary for good, and the only symptom is `Error: Electron uninstall` from
// `electron-vite dev`. Running the package's installer is idempotent: it
// returns at once when `path.txt` already names a binary that exists.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopPackage = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop", "package.json");
const electronDirectory = dirname(createRequire(desktopPackage).resolve("electron/package.json"));

execFileSync(process.execPath, [join(electronDirectory, "install.js")], { stdio: "inherit" });
