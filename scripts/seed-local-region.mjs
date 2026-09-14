import { configuredRegions } from "./regions.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const region = process.argv[2];
if (!configuredRegions.includes(region)) {
  throw new Error("Usage: node scripts/seed-local-region.mjs <region>");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = join(repositoryRoot, "apps", "api");
const sourcePath = join(repositoryRoot, "packages", "db", "seed.sql");
const source = await readFile(sourcePath, "utf8");
const regionalized = source.replace(
  /('Avalon Studio', 'avalon-studio', )'global'(, '00000000-0000-7000-8000-000000000001')/,
  `$1'${region}'$2`,
);

if (regionalized === source && region !== "global") {
  throw new Error("The development seed's workspace region marker was not found");
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), `avalon-${region}-seed-`));
const regionalSeedPath = join(temporaryDirectory, "seed.sql");

try {
  await writeFile(regionalSeedPath, regionalized, { encoding: "utf8", mode: 0o600 });
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      `.wrangler/state/${region}`,
      "--config",
      `wrangler.${region}.jsonc`,
      "--env-file",
      `.dev.vars.${region}`,
      "--file",
      regionalSeedPath,
    ],
    { cwd: apiDirectory, stdio: "inherit" },
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Regional seed was interrupted by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
