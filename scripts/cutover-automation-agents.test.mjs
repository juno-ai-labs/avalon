import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATION_CUTOVER_DRAIN_TIMEOUT_MS,
  cutoverAutomationAgents,
} from "./cutover-automation-agents.mjs";

const environment = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };
const workspaces = {
  eu: ["00000000-0000-7000-8000-0000000000e1"],
  global: ["00000000-0000-7000-8000-0000000000f1", "00000000-0000-7000-8000-0000000000f2"],
};

function fixture({ inventory = workspaces, metrics = { backlog_count: 0 } } = {}) {
  const requests = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    let result;
    if (url.pathname.endsWith("/queues")) {
      result = ["eu", "global"].flatMap((region) => [
        { queue_id: `${region}-commands`, queue_name: `avalon-${region}-migration-commands` },
        { queue_id: `${region}-dead`, queue_name: `avalon-${region}-migration-commands-dead-letter` },
      ]);
    } else if (url.pathname.includes("/d1/database/")) {
      const region = url.pathname.includes("099eb3bf") ? "eu" : "global";
      // Two query shapes: the keyset page, and the single-workspace lookup
      // `--workspace=` sends. Honouring both is what lets a test prove the
      // script walks its pages, and that a targeted run reads one row.
      const params = JSON.parse(init.body).params;
      const matched = params.length === 2
        ? inventory[region].filter((id) => id === params[1])
        : inventory[region].filter((id) => id > params[1]).slice(0, params[2]);
      result = [{ success: true, results: matched.map((id) => ({ id })) }];
    } else if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
      result = ["eu", "global"].map((region) => ({
        id: `${region}-workspace-namespace`,
        class: "WorkspaceDO",
        script: `avalon-api-${region}`,
      }));
    } else if (url.pathname.includes("/workers/durable_objects/namespaces/")) {
      const region = url.pathname.includes("eu-workspace-namespace") ? "eu" : "global";
      result = workspaces[region].map((_workspaceId, index) => ({
        id: `${region}-object-${index}`,
        hasStoredData: true,
      }));
    } else if (url.pathname.endsWith("/metrics")) {
      result = typeof metrics === "function" ? metrics(url) : metrics;
    } else if (url.pathname.endsWith("/messages/batch")) {
      result = {};
    } else {
      throw new Error(`Unexpected request ${url.pathname}`);
    }
    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const read = async (url) => String(url).includes("wrangler.eu")
    ? '{ "database_id": "099eb3bf-4291-4a0f-a051-645e5c338881" }'
    : '{ "database_id": "3802fdab-e21c-4313-beb2-c1defb37f253" }';
  return { requests, fetcher, read };
}

test("dry-run inventories regional workspaces without queueing cutover", async () => {
  const subject = fixture();
  const result = await cutoverAutomationAgents({
    argv: [], environment, fetcher: subject.fetcher, read: subject.read, logger: { log() {} },
  });
  assert.equal(result.dispatched, 0);
  assert.equal(result.regions.eu.workspaces, 1);
  assert.equal(result.regions.global.workspaces, 2);
  assert.equal(subject.requests.some(({ url }) => url.pathname.endsWith("/messages/batch")), false);
});

test("apply sends one typed named-WorkspaceDO command per workspace and waits for both queues", async () => {
  const subject = fixture();
  const result = await cutoverAutomationAgents({
    argv: ["--apply"], environment, fetcher: subject.fetcher, read: subject.read,
    wait: async () => {}, logger: { log() {} },
  });
  const messages = subject.requests
    .filter(({ url }) => url.pathname.endsWith("/messages/batch"))
    .flatMap(({ init }) => JSON.parse(init.body).messages.map((message) => message.body));
  assert.equal(result.dispatched, 3);
  assert.equal(messages.every((message) => message.className === "WorkspaceDO"), true);
  assert.equal(messages.every((message) => message.objectId === null), true);
  assert.deepEqual(messages.map((message) => message.objectName), [
    "eu:00000000-0000-7000-8000-0000000000e1",
    "global:00000000-0000-7000-8000-0000000000f1",
    "global:00000000-0000-7000-8000-0000000000f2",
  ]);
  assert.equal(messages.every((message) => message.automationCutover.workspaceId), true);
});

test("targets one workspace instead of waking the whole region", async () => {
  const subject = fixture();
  const target = workspaces.global[1];
  const result = await cutoverAutomationAgents({
    argv: ["--apply", `--workspace=${target}`], environment,
    fetcher: subject.fetcher, read: subject.read, wait: async () => {}, logger: { log() {} },
  });

  // The point of the flag: one message, not one per workspace in the region.
  // A fleet-wide fan-out to re-cut a single workspace shares a queue with the
  // migration tracker and has an unbounded drain wait.
  const messages = subject.requests
    .filter(({ url }) => url.pathname.endsWith("/messages/batch"))
    .flatMap(({ init }) => JSON.parse(init.body).messages.map((message) => message.body));
  assert.equal(result.dispatched, 1);
  assert.deepEqual(messages.map((message) => message.automationCutover.workspaceId), [target]);
  assert.deepEqual(messages.map((message) => message.objectName), [`global:${target}`]);
  // EU does not hold it, so EU sends nothing rather than failing.
  assert.equal(result.regions.eu.workspaces, 0);
});

test("refuses a workspace target for the fleet-wide preflight", async () => {
  const subject = fixture();
  await assert.rejects(
    cutoverAutomationAgents({
      argv: ["--preflight", `--workspace=${workspaces.global[0]}`], environment,
      fetcher: subject.fetcher, read: subject.read, wait: async () => {}, logger: { log() {} },
    }),
    /--workspace and --preflight are mutually exclusive/u,
  );
});

test("refuses a workspace target that is not an identifier", async () => {
  const subject = fixture();
  await assert.rejects(
    cutoverAutomationAgents({
      argv: ["--apply", "--workspace=all"], environment,
      fetcher: subject.fetcher, read: subject.read, wait: async () => {}, logger: { log() {} },
    }),
    /Unsupported workspace all/u,
  );
});

test("reads the whole regional inventory when it spans more than one keyset page", async () => {
  const many = Array.from({ length: 1001 }, (_value, index) =>
    `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`);
  const subject = fixture({ inventory: { ...workspaces, global: many } });
  const result = await cutoverAutomationAgents({
    argv: [], environment, fetcher: subject.fetcher, read: subject.read, logger: { log() {} },
  });
  assert.equal(result.regions.global.workspaces, 1001);
  const keysets = subject.requests
    .filter(({ url }) => url.pathname.includes("/d1/database/") && !url.pathname.includes("099eb3bf"))
    .map(({ init }) => JSON.parse(init.body).params[1]);
  assert.deepEqual(keysets, ["", many[999]]);
});

test("fails the cutover rather than reading an unusable backlog metric as drained", async () => {
  const subject = fixture({ metrics: {} });
  await assert.rejects(
    cutoverAutomationAgents({
      argv: ["--apply"], environment, fetcher: subject.fetcher, read: subject.read,
      wait: async () => {}, logger: { log() {} },
    }),
    /cloudflare_queue_metrics_invalid/u,
  );
});

test("waits before reading a backlog, so an eventually-consistent zero cannot end the drain", async () => {
  const subject = fixture();
  const order = [];
  await cutoverAutomationAgents({
    argv: ["--apply"], environment, logger: { log() {} }, read: subject.read,
    fetcher: async (input, init) => {
      if (new URL(input).pathname.endsWith("/metrics")) order.push("metrics");
      return subject.fetcher(input, init);
    },
    wait: async () => { order.push("wait"); },
  });
  // The dead-letter baseline is read before dispatch; what must not happen is a
  // backlog read taken between the dispatch and the first sleep.
  assert.equal(order.indexOf("wait") < order.lastIndexOf("metrics"), true);
  assert.equal(order.slice(order.indexOf("wait")).includes("metrics"), true);
  assert.equal(order[order.indexOf("wait") - 1], "metrics");
  assert.equal(order.filter((step) => step === "wait").length, 1);
});

test("trips a finite drain deadline naming the region still holding a backlog", async () => {
  const subject = fixture({
    metrics: (url) => ({ backlog_count: url.pathname.includes("-dead") ? 0 : 3 }),
  });
  await assert.rejects(
    cutoverAutomationAgents({
      argv: ["--apply"], environment, fetcher: subject.fetcher, read: subject.read,
      wait: async () => {}, drainTimeoutMs: 0, logger: { log() {} },
    }),
    /automation_cutover_drain_timeout:eu=3,global=3/u,
  );
});

test("enforces no deadline at the shipped drain value, however long the queues stay backed up", async () => {
  let reads = 0;
  const subject = fixture({
    metrics: (url) => {
      if (url.pathname.includes("-dead")) return { backlog_count: 0 };
      reads += 1;
      return { backlog_count: reads > 6 ? 0 : 4 };
    },
  });
  const result = await cutoverAutomationAgents({
    argv: ["--apply"], environment, fetcher: subject.fetcher, read: subject.read,
    wait: async () => {}, drainTimeoutMs: AUTOMATION_CUTOVER_DRAIN_TIMEOUT_MS, logger: { log() {} },
  });
  assert.equal(result.dispatched, 3);
  assert.equal(reads > 6, true);
});

test("preflight wakes every stored WorkspaceDO by opaque ID before either Worker is replaced", async () => {
  const subject = fixture();
  const result = await cutoverAutomationAgents({
    argv: ["--preflight"], environment, fetcher: subject.fetcher, read: subject.read,
    wait: async () => {}, logger: { log() {} },
  });
  const messages = subject.requests
    .filter(({ url }) => url.pathname.endsWith("/messages/batch"))
    .flatMap(({ init }) => JSON.parse(init.body).messages.map((message) => message.body));
  assert.equal(result.mode, "preflight");
  assert.equal(result.dispatched, 3);
  assert.deepEqual(messages.map((message) => message.objectId), [
    "eu-object-0",
    "global-object-0",
    "global-object-1",
  ]);
  assert.equal(messages.every((message) => message.objectName === null), true);
  assert.equal(messages.every((message) => message.automationCutover === undefined), true);
});
