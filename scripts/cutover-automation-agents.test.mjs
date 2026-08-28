import assert from "node:assert/strict";
import test from "node:test";

import { cutoverAutomationAgents } from "./cutover-automation-agents.mjs";

const environment = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };
const workspaces = {
  eu: ["00000000-0000-7000-8000-0000000000e1"],
  global: ["00000000-0000-7000-8000-0000000000f1", "00000000-0000-7000-8000-0000000000f2"],
};

function fixture() {
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
      result = [{ success: true, results: workspaces[region].map((id) => ({ id })) }];
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
      result = { backlog_count: 0 };
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
