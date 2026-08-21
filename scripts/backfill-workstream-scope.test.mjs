import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecord,
  CONSECUTIVE_FAILURE_LIMIT,
  flip,
  parseArguments,
  refusesScopeChange,
  revert,
  setScope,
} from "./backfill-workstream-scope.mjs";

const workstream = (overrides = {}) => ({
  id: "00000000-0000-7000-8000-000000000001",
  title: "A work stream",
  scope: "workspace",
  systemKind: null,
  automationSubscriptionId: null,
  originType: "ad_hoc",
  ...overrides,
});

/** A fetch double that answers from a route table and records every call. */
function stubFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes.find(([match, verb]) => url.includes(match) && (verb ?? "GET") === method);
    if (!handler) throw new Error(`No stub for ${method} ${url}`);
    const [, , status, body] = handler;
    return { status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

/** The four routes a full `--apply` walks, in the shape the API answers them. */
function applyRoutes({ participants = [], members = ["member-a", "member-b"] } = {}) {
  return [
    ["/workspace/members", "GET", 200, {
      items: members.map((id) => ({ user: { id }, role: "member", status: "active", joinedAt: null })),
    }],
    ["/workstreams?", "GET", 200, { items: [workstream()], nextCursor: null }],
    ["/participants", "POST", 201, {}],
    ["/workstreams/", "PATCH", 200, workstream({ scope: "personal" })],
    ["/workstreams/", "GET", 200, {
      ...workstream(),
      participants: participants.map((id) => ({ user: { id } })),
    }],
  ];
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
    recordExists: (path) => path in written,
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
    workstream({ id: "a-digest", scope: "workspace", systemKind: "digest" }),
    workstream({ id: "an-automation", scope: "workspace", automationSubscriptionId: "sub-1" }),
  ]);
  // The two that would answer `scope_change_unsupported` are knowable from the
  // listing, so they never reach the record — the count is the blast radius.
  assert.deepEqual(record.entries.map((entry) => entry.workstreamId), ["public-one"]);
  // The scope each row held, which is the whole value of the file.
  assert.deepEqual([...new Set(record.entries.map((entry) => entry.priorScope))], ["workspace"]);
});

test("a dry run writes the record and changes nothing", async () => {
  const { fetch, calls } = stubFetch([
    ["/workstreams?", "GET", 200, { items: [workstream()], nextCursor: null }],
  ]);
  const ctx = context({ fetch });
  const totals = await flip(ctx);

  assert.deepEqual(totals, { changed: 0, unsupported: 0, failed: 0, seated: 0 });
  assert.equal(ctx.written["/tmp/record.json"].entries.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("the record is written before the first change, so an interrupted run is reversible", async () => {
  const order = [];
  const { fetch } = stubFetch(applyRoutes({ participants: ["someone"] }));
  const ctx = context({
    apply: true,
    fetch: async (url, init = {}) => {
      if (String(url).includes("/workstreams/0") && init.method === "PATCH") order.push("patch");
      return fetch(url, init);
    },
    writeRecord: () => order.push("record"),
    readRecord: () => ({ entries: [] }),
  });
  await flip(ctx);

  assert.equal(order[0], "record");
  assert.ok(order.includes("patch"));
  assert.ok(order.indexOf("record") < order.indexOf("patch"));
});

test("a work stream whose scope is not what decides who reads it is left alone, not failed", async () => {
  const { fetch } = stubFetch([
    ["/workstreams/", "PATCH", 422, { error: "scope_change_unsupported" }],
  ]);
  const result = await setScope(context({ fetch }), "automation-one", "personal");
  assert.deepEqual(result, { outcome: "unsupported" });
});

test("a revert puts back the scope the file recorded, not a guess", async () => {
  const patched = [];
  const { fetch } = stubFetch([["/workstreams/", "PATCH", 200, workstream()]]);
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

test("the workspace is seated before the work stream is narrowed", async () => {
  // The access-preserving half, and the ordering that matters: a work stream is
  // never private with a smaller room than it started with.
  const order = [];
  const { fetch } = stubFetch(applyRoutes({ participants: [] }));
  const ctx = context({
    apply: true,
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "POST") order.push(`seat:${JSON.parse(init.body).userId}`);
      if (method === "PATCH") order.push("narrow");
      return fetch(url, init);
    },
  });

  const totals = await flip(ctx);

  // Seated first, every active member, and only then narrowed.
  assert.deepEqual(order, ["seat:member-a", "seat:member-b", "narrow"]);
  assert.equal(totals.seated, 1);
  assert.deepEqual(ctx.written["/tmp/record.json"].entries[0].seatedUserIds, ["member-a", "member-b"]);
});

test("a populated room is seated too, and members already in it are not re-posted", async () => {
  // The population that actually exists: a room of one, its creator. Narrowing
  // it without seating is what takes the work stream away from everyone else.
  const seatedUsers = [];
  const { fetch } = stubFetch(applyRoutes({
    participants: ["member-a"],
    members: ["member-a", "member-b"],
  }));
  const ctx = context({
    apply: true,
    fetch: async (url, init = {}) => {
      if ((init.method ?? "GET") === "POST") seatedUsers.push(JSON.parse(init.body).userId);
      return fetch(url, init);
    },
  });

  const totals = await flip(ctx);

  // `member-a` was already there; only the missing one costs a request.
  assert.deepEqual(seatedUsers, ["member-b"]);
  assert.equal(totals.seated, 1);
  assert.equal(totals.changed, 1);
});

test("a retry after an interrupted apply keeps the rollback data it already had", async () => {
  // The failure three reviewers found: a retry re-lists, the rows already
  // flipped now read `personal`, `buildRecord` drops them, and the file loses
  // the only copy of the scope they used to hold.
  const ctx = context({
    apply: true,
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (url.includes("/workspace/members")) {
        return { status: 200, text: async () => JSON.stringify({ items: [] }) };
      }
      // The listing a retry would see: the first work stream is already private.
      if (url.includes("/workstreams?")) {
        return {
          status: 200,
          text: async () => JSON.stringify({
            items: [workstream({ id: "already-done", scope: "personal" })],
            nextCursor: null,
          }),
        };
      }
      if (method === "PATCH") return { status: 200, text: async () => JSON.stringify(workstream()) };
      return { status: 200, text: async () => JSON.stringify({ ...workstream(), participants: [{ user: { id: "x" } }] }) };
    },
  });
  // What the interrupted run had already written.
  ctx.written["/tmp/record.json"] = {
    baseUrl: "https://api.test",
    entries: [{ workstreamId: "already-done", title: "Done", priorScope: "workspace" }],
  };

  await flip(ctx);

  // The entry survived, with the scope that makes it revertible.
  assert.deepEqual(
    ctx.written["/tmp/record.json"].entries.map((entry) => entry.workstreamId),
    ["already-done"],
  );
  assert.equal(ctx.written["/tmp/record.json"].entries[0].priorScope, "workspace");
});

test("a record aimed at another region is refused rather than half-applied", async () => {
  const ctx = context({ apply: true });
  ctx.written["/tmp/record.json"] = { baseUrl: "https://eu.api.test", entries: [] };
  await assert.rejects(() => flip(ctx), /recorded against https:\/\/eu\.api\.test/u);

  const reverting = context({ revert: "/tmp/record.json" });
  reverting.written["/tmp/record.json"] = { baseUrl: "https://eu.api.test", entries: [] };
  await assert.rejects(() => revert(reverting), /recorded against https:\/\/eu\.api\.test/u);
});

test("--record alongside --revert is refused rather than quietly dropped", () => {
  assert.throws(
    () => parseArguments(["--base-url", "https://api.test", "--revert", "./flip.json", "--record", "./x.json"]),
    /--record belongs to a flip/u,
  );
});

test("a network failure costs one row, not the sweep", async () => {
  const ctx = context({
    fetch: async (url) => {
      if (url.includes("/workstreams/")) throw new TypeError("fetch failed");
      throw new Error(`No stub for ${url}`);
    },
  });
  const result = await setScope(ctx, "unreachable", "personal");
  assert.equal(result.outcome, "failed");
  assert.equal(result.status, 0);
  assert.match(result.error, /fetch failed/u);
});

test("a broken precondition stops the sweep instead of burning the whole list", async () => {
  // An expired token fails every row. Grinding through hundreds of them buys
  // nothing and buries the cause.
  const entries = Array.from({ length: 40 }, (_, index) => ({
    workstreamId: `ws-${index}`, title: `W${index}`, priorScope: "workspace",
  }));
  let patches = 0;
  const ctx = context({
    revert: "/tmp/record.json",
    fetch: async (url, init = {}) => {
      if ((init.method ?? "GET") === "PATCH") patches += 1;
      return { status: 401, text: async () => JSON.stringify({ error: "unauthorized" }) };
    },
  });
  ctx.written["/tmp/record.json"] = { baseUrl: "https://api.test", entries };

  const totals = await revert(ctx);

  assert.equal(totals.failed, CONSECUTIVE_FAILURE_LIMIT);
  assert.equal(patches, CONSECUTIVE_FAILURE_LIMIT);
});

test("rows the object will refuse are known from the listing, not discovered by asking", () => {
  assert.equal(refusesScopeChange(workstream()), false);
  assert.equal(refusesScopeChange(workstream({ systemKind: "digest" })), true);
  assert.equal(refusesScopeChange(workstream({ automationSubscriptionId: "sub-1" })), true);
});
