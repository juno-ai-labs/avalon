#!/usr/bin/env node
// Holds a desktop release until no API deployment is in flight.
//
// The API and the desktop app are one release train in a fixed order: the
// Workers deploy first, the signed app ships against them second. A merge that
// changes both triggers the two workflows at the same moment, and nothing in
// GitHub's concurrency model orders runs of *different* workflows — a shared
// group would serialize them, but in whichever order they happened to queue.
//
// The dependency is deliberately one-directional: the desktop release waits for
// API deployments, and an API deployment never waits for a desktop release.
// That asymmetry is what makes this deadlock-free, and it is also the ordering
// the runbook requires, since a failed regional health check blocks desktop
// distribution.
//
// Usage (inside a workflow step, with `actions: read` permission):
//   GITHUB_TOKEN=... node scripts/await-api-deployment.mjs deploy-api.yml

import { fileURLToPath } from "node:url";

const POLL_INTERVAL_MS = Number(process.env.AWAIT_API_DEPLOYMENT_POLL_MS ?? "20000");
const TIMEOUT_MS = Number(process.env.AWAIT_API_DEPLOYMENT_TIMEOUT_MS ?? String(45 * 60 * 1000));
// A transient API failure must not be read as "nothing is deploying", but it
// must not hang the release either.
const MAX_CONSECUTIVE_ERRORS = 5;
const BLOCKING_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

// A queued API deployment blocks too: it is about to deploy, and letting the
// app publish first would ship it against the older Workers.
export function selectBlockingRuns(runs) {
  return runs.filter((run) => BLOCKING_STATUSES.has(run.status));
}

export function describeRun(run) {
  return `${run.name ?? "deploy"} #${run.run_number ?? run.id} [${run.status}] (${run.html_url ?? run.id})`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGitHubClient({ apiUrl, repository, token }) {
  return {
    listRecentRuns: async (workflowFile) => {
      const response = await fetch(
        `${apiUrl}/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=20`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      return (await response.json()).workflow_runs ?? [];
    },
  };
}

export async function awaitApiDeployment({
  client,
  workflowFile,
  now = () => Date.now(),
  wait = sleep,
  log = console.log,
}) {
  const deadline = now() + TIMEOUT_MS;
  let consecutiveErrors = 0;

  for (;;) {
    let blocking;
    try {
      blocking = selectBlockingRuns(await client.listRecentRuns(workflowFile));
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      const reason = error instanceof Error ? error.message : "unknown error";
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new Error(`Could not read ${workflowFile} runs after ${consecutiveErrors} attempts: ${reason}`, {
          cause: error,
        });
      }
      log(`API deployment check failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${reason}`);
      await wait(POLL_INTERVAL_MS);
      continue;
    }

    if (blocking.length === 0) {
      log("No API deployment in flight; the desktop release may proceed.");
      return;
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(TIMEOUT_MS / 60000)} minutes waiting for: ${blocking.map(describeRun).join(", ")}`,
      );
    }
    log(`Waiting for ${blocking.length} API deployment(s): ${blocking.map(describeRun).join(", ")}`);
    await wait(POLL_INTERVAL_MS);
  }
}

async function main() {
  const workflowFile = process.argv[2] ?? "deploy-api.yml";
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token) throw new Error("GITHUB_TOKEN is required (grant the job `actions: read`).");
  if (!repository) throw new Error("GITHUB_REPOSITORY is required.");

  const client = createGitHubClient({
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    repository,
    token,
  });
  await awaitApiDeployment({ client, workflowFile });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Waiting for the API deployment failed");
    process.exitCode = 1;
  });
}
