import assert from "node:assert/strict";
import test from "node:test";

import { awaitApiDeployment, selectBlockingRuns } from "./await-api-deployment.mjs";

const run = (id, status) => ({ id, status, name: "Deploy Avalon API", run_number: id });

test("finished API deployments do not block the release", () => {
  const runs = [run(1, "completed"), run(2, "completed")];
  assert.deepEqual(selectBlockingRuns(runs), []);
});

test("an in-progress or queued API deployment blocks the release", () => {
  // A queued run is about to deploy; publishing the app first would ship it
  // against the older Workers.
  const runs = [run(1, "completed"), run(2, "in_progress"), run(3, "queued")];
  assert.deepEqual(selectBlockingRuns(runs).map((entry) => entry.id), [2, 3]);
});

test("a run held by a concurrency queue still blocks", () => {
  assert.deepEqual(selectBlockingRuns([run(4, "pending"), run(5, "waiting")]).map((entry) => entry.id), [4, 5]);
});

test("the release proceeds once the deployment finishes", async () => {
  let poll = 0;
  const client = {
    listRecentRuns: async () => {
      poll += 1;
      return poll < 3 ? [run(1, "in_progress")] : [run(1, "completed")];
    },
  };

  let waits = 0;
  await awaitApiDeployment({
    client,
    workflowFile: "deploy-api.yml",
    wait: async () => {
      waits += 1;
    },
    log: () => {},
  });
  assert.equal(poll, 3);
  assert.equal(waits, 2);
});

test("the release fails rather than publishing ahead of a stuck deployment", async () => {
  const client = { listRecentRuns: async () => [run(1, "in_progress")] };
  let elapsed = 0;

  await assert.rejects(
    awaitApiDeployment({
      client,
      workflowFile: "deploy-api.yml",
      wait: async () => {},
      log: () => {},
      now: () => {
        elapsed += 46 * 60 * 1000;
        return elapsed;
      },
    }),
    /Timed out after 45 minutes waiting for: Deploy Avalon API #1 \[in_progress\]/u,
  );
});

test("a transient API error is retried rather than read as an idle deployment", async () => {
  let poll = 0;
  const client = {
    listRecentRuns: async () => {
      poll += 1;
      if (poll < 3) throw new Error("GitHub API 502");
      return [run(1, "completed")];
    },
  };

  await awaitApiDeployment({ client, workflowFile: "deploy-api.yml", wait: async () => {}, log: () => {} });
  assert.equal(poll, 3);
});

test("a persistently unreadable run list fails the release", async () => {
  const client = {
    listRecentRuns: async () => {
      throw new Error("GitHub API 403");
    },
  };

  await assert.rejects(
    awaitApiDeployment({ client, workflowFile: "deploy-api.yml", wait: async () => {}, log: () => {} }),
    /Could not read deploy-api\.yml runs after 5 attempts/u,
  );
});
