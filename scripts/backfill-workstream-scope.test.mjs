import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecord,
  flip,
  parseArguments,
  revert,
  setScope,
} from "./backfill-workstream-scope.mjs";

const workstream = (overrides = {}) => ({
  id: "00000000-0000-7000-8000-000000000001",
  title: "A work stream",
  scope: "workspace",
  systemKind: null,
  originType: "ad_hoc",
  ...overrides,
});

/** A fetch double that answers from a route table and records every call. */
function stubFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const handler = routes.find(([match]) => url.includes(match));
    if (!handler) throw new Error(`No stub for ${url}`);
    const [, status, body] = handler;
    return { status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

function context(overrides = {}) {
  const written = {};
  return {
    baseUrl: "https://api.test",
    token: "token",
    apply: false,
    record: "/tmp/record.json",
    revert: null,
    now: () => "2026-08-21T20:00:00.000Z",
    log: () => {},
    written,
    writeRecord: (path, value) => {
      written[path] = value;
    },
    readRecord: (path) => written[path],
    ...overrides,
  };
}

test("--record is required, because it is the only way back", () => {
  assert.throws(
    () => parseArguments(["--base-url", "https://api.test", "--apply"]),
    /--record <path> is required/u,
  );
  // A revert reads its targets from the file, so it needs no new one.
  assert.deepEqual(
    parseArguments(["--base-url", "https://api.test", "--revert", "./flip.json"]),
    { apply: false, baseUrl: "https://api.test", record: null, revert: "./flip.json" },
  );
});

test("only workspace-scoped work streams are recorded as targets", () => {
  const record = buildRecord(context(), [
    workstream({ id: "public-one", scope: "workspace" }),
    workstream({ id: "already-private", scope: "personal" }),
    workstream({ id: "public-two", scope: "workspace", systemKind: "digest" }),
  ]);
  assert.deepEqual(record.entries.map((entry) => entry.workstreamId), ["public-one", "public-two"]);
  // The scope each row held, which is the whole value of the file.
  assert.deepEqual([...new Set(record.entries.map((entry) => entry.priorScope))], ["workspace"]);
});

test("a dry run writes the record and changes nothing", async () => {
  const { fetch, calls } = stubFetch([
    ["/workstreams?", 200, { items: [workstream()], nextCursor: null }],
  ]);
  const ctx = context({ fetch });
  const totals = await flip(ctx);

  assert.deepEqual(totals, { changed: 0, unsupported: 0, failed: 0 });
  assert.equal(ctx.written["/tmp/record.json"].entries.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("the record is written before the first change, so an interrupted run is reversible", async () => {
  const order = [];
  const { fetch } = stubFetch([
    ["/workstreams?", 200, { items: [workstream()], nextCursor: null }],
    ["/workstreams/", 200, workstream({ scope: "personal" })],
  ]);
  const ctx = context({
    apply: true,
    fetch: async (...args) => {
      if (String(args[0]).includes("/workstreams/0")) order.push("patch");
      return fetch(...args);
    },
    writeRecord: () => order.push("record"),
    readRecord: () => ({ entries: [] }),
  });
  await flip(ctx);

  assert.deepEqual(order, ["record", "patch"]);
});

test("a work stream whose scope is not what decides who reads it is left alone, not failed", async () => {
  const { fetch } = stubFetch([
    ["/workstreams/", 409, { error: "scope_change_unsupported" }],
  ]);
  const result = await setScope(context({ fetch }), "automation-one", "personal");
  assert.deepEqual(result, { outcome: "unsupported" });
});

test("a revert puts back the scope the file recorded, not a guess", async () => {
  const patched = [];
  const { fetch } = stubFetch([["/workstreams/", 200, workstream()]]);
  const ctx = context({
    revert: "/tmp/record.json",
    fetch: async (url, init) => {
      patched.push({ url, scope: JSON.parse(init.body).scope });
      return fetch(url, init);
    },
  });
  ctx.written["/tmp/record.json"] = {
    entries: [
      { workstreamId: "one", title: "One", priorScope: "workspace" },
      { workstreamId: "two", title: "Two", priorScope: "personal" },
    ],
  };

  const totals = await revert(ctx);

  assert.equal(totals.changed, 2);
  assert.deepEqual(patched.map((call) => call.scope), ["workspace", "personal"]);
});

test("every page of the listing is walked", async () => {
  let page = 0;
  const ctx = context({
    fetch: async (url) => {
      if (!url.includes("/workstreams?")) throw new Error(`No stub for ${url}`);
      page += 1;
      const body = page === 1
        ? { items: [workstream({ id: "first" })], nextCursor: "cursor-1" }
        : { items: [workstream({ id: "second" })], nextCursor: null };
      return { status: 200, text: async () => JSON.stringify(body) };
    },
  });
  await flip(ctx);
  assert.deepEqual(
    ctx.written["/tmp/record.json"].entries.map((entry) => entry.workstreamId),
    ["first", "second"],
  );
});
