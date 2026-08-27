#!/usr/bin/env node
// Checks that the landing site is about to advertise the release that is
// actually live.
//
// apps/site/release.config.json is the site's source of truth for the version
// it shows. A desktop release rewrites that file on its own runner when it
// promotes the channel, commits it back to main, and only then deploys the
// site from a worktree of main's tip — so both that deploy and every later
// standalone one build from a committed copy. Between the promotion and the
// record commit, a standalone site deploy would still rebuild from the older
// committed copy and advertise a superseded version; both deploy workflows
// run this check immediately before publishing to catch exactly that. The
// download link is the canonical Avalon.dmg either way, so this is a wrong
// version string rather than a broken download, which is exactly the kind of
// thing to catch in CI.
//
// A network failure is not a mismatch: the check reports and passes, because
// blocking a copy fix on a CDN blip is worse than shipping a version string
// that is probably already correct.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./entry-point.mjs";

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Resolved from this script's own location, never the working directory: the
// desktop release invokes this file by absolute path inside a worktree of
// main's tip while the shell stays in the release checkout, and it must read
// the worktree's committed config — the one about to be deployed.
export const configPath = resolve(repositoryDirectory, "apps/site/release.config.json");

export function channelVersionFrom(manifestText) {
  const version = /^version:\s*["']?([^"'\s]+)["']?\s*$/mu.exec(manifestText)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("Live release manifest does not declare a semantic version");
  }
  return version;
}

export function compareToChannel(configVersion, manifestText) {
  const channelVersion = channelVersionFrom(manifestText);
  return { ok: channelVersion === configVersion, channelVersion, configVersion };
}

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.published !== true) {
    console.log("Site release config is unpublished; the build discovers the live release itself.");
    return;
  }

  const manifestUrl = new URL(config.objects.latest, `${config.downloadBaseUrl}/`);
  let manifestText;
  try {
    const response = await fetch(manifestUrl, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifestText = await response.text();
  } catch (error) {
    console.warn(
      `Could not read the live release manifest (${error instanceof Error ? error.message : "unknown error"}); `
        + `deploying ${config.version} unverified.`,
    );
    return;
  }

  const { ok, channelVersion, configVersion } = compareToChannel(config.version, manifestText);
  if (ok) {
    console.log(`Site release config matches the live channel at ${channelVersion}.`);
    return;
  }
  throw new Error(
    `apps/site/release.config.json says ${configVersion} but the live channel serves ${channelVersion}. `
      + "Commit the release config written by the desktop release before deploying the site.",
  );
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Site release config check failed");
    process.exitCode = 1;
  });
}
