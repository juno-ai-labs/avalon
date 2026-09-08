/// <reference types="node" />

/**
 * Builds the Rally-owned Terminal snapshot.
 *
 * Every new work-stream sandbox currently pays to install `sqlite3`, `gh`,
 * `pnpm`, and `tsx`, because Daytona's managed default image ships none of
 * them. That install sits inside `prepareSandbox`, which sits inside the
 * blocking `load_plugin` activation, which sits in front of the participant's
 * first Terminal tool. Measured on the pinned command text in a Linux
 * container: ~14.4s when the four capabilities are missing against 117ms when
 * they are already present, because the bootstrap's `command -v` guards then
 * skip every install. Production telemetry agrees on where that lands — no
 * recorded `start` acquisition has ever completed in under 5s, while every
 * `restore`, which skips this phase entirely, completes in 1–5s.
 *
 * The image is built by running the very bootstrap the runtime would otherwise
 * run on each new sandbox, rather than a second list of packages maintained
 * beside it. One source of truth, so the snapshot and the runtime cannot drift,
 * and so the runtime bootstrap degrades to its no-op path against the result
 * instead of needing to know a snapshot was prebuilt.
 *
 * This does not adopt the snapshot. Build it, point
 * `DAYTONA_TERMINAL_SNAPSHOT` at it, and run
 * `pnpm --filter @rally/api terminal:verify-provider` — the existing
 * real-provider acceptance gate — before any region serves traffic from it.
 * A snapshot that has not passed that probe is not a supported configuration.
 */

import { Daytona, Image } from "@daytona/sdk";

import { parseTerminalRegionConfiguration } from "../src/services/terminal/contract";
import {
  TERMINAL_SNAPSHOT_BASE_IMAGE,
  terminalSnapshotImageBuildCommand,
} from "../src/services/terminal/snapshot-manifest";

const configuration = parseTerminalRegionConfiguration(process.env);
if (configuration.capability !== "supported") {
  throw new Error(
    "Set DAYTONA_API_KEY, DAYTONA_API_URL, DAYTONA_TARGET, and DAYTONA_TERMINAL_SNAPSHOT "
    + "(the name to build) before building the Terminal snapshot",
  );
}

// The base is pinned in the manifest so a change to it is a reviewed diff; the
// environment overrides it for a one-off build. Either way the acceptance gate
// is what proves the result carries every capability the model is told it has.
const baseImage = process.env.TERMINAL_SNAPSHOT_BASE_IMAGE?.trim() || TERMINAL_SNAPSHOT_BASE_IMAGE;

const daytona = new Daytona({
  apiKey: configuration.apiKey,
  apiUrl: configuration.apiUrl,
  target: configuration.target,
});

// Daytona keys built images by Dockerfile content: a build whose Dockerfile
// matches an earlier one hands that image back in about a second, with no build
// log — the image reference is the SHA-256 of the Dockerfile, which is how this
// was noticed on 2026-09-07. The weekly rebuild exists to pick up the base
// image's fixes, so every build has to be a real build. A build-time stamp makes
// each Dockerfile unique; it also reaches every sandbox as an environment
// variable, so a sandbox can say which build it came from.
const builtAt = new Date().toISOString();
const image = Image.base(baseImage)
  .env({ RALLY_TERMINAL_SNAPSHOT_BUILT_AT: builtAt })
  .runCommands(terminalSnapshotImageBuildCommand());

process.stdout.write(`Building Terminal snapshot ${configuration.snapshot} from ${baseImage} (built-at ${builtAt})\n`);

const created = await daytona.snapshot.create(
  { name: configuration.snapshot, image },
  { onLogs: (line: string) => process.stdout.write(`${line}\n`) },
);

process.stdout.write(
  `\nBuilt Terminal snapshot ${created.name} (id ${created.id}, state ${created.state}, created ${created.createdAt}, base ${baseImage}).\n`
  + "It is not adopted yet. Run the real-provider acceptance gate against it first:\n"
  + "  pnpm --filter @rally/api terminal:verify-provider\n",
);
