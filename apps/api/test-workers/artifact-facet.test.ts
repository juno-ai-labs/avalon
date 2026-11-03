import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { artifactHostDOName } from "../src/durable-objects/names";
import type { ArtifactHostDO } from "../src/durable-objects/artifact-host-do";
import { artifactAssetKey, asArtifactId, asWorkspaceId } from "@rally/contracts";

/**
 * The facet data plane, on real workerd.
 *
 * These are the proofs the artifact deploy is gated on, and they are here
 * rather than in the Node suite because **a double would prove nothing about
 * the mechanism the whole stateful design rests on**. What is under test is the
 * platform's own behavior: that a model's class loaded through the Worker
 * Loader can run as a facet with its own SQLite, that Rally's host class can
 * read the same rows without the model's class being able to reach Rally's, and
 * that aborting the facet on a republish reloads the code while keeping the
 * storage.
 *
 * `ctx.facets` is reachable only from inside the object, so every assertion
 * goes through `runInDurableObject` or an RPC, per the reference platform's own
 * test layout.
 */
const WORKSPACE = "00000000-0000-7000-8000-0000000000e1";
const WORKSTREAM = "00000000-0000-7000-8000-0000000000e2";
const RESOURCE = "00000000-0000-7000-8000-0000000000e3";
const ARTIFACT = "00000000-0000-7000-8000-0000000000e4";
const VIEWER = "00000000-0000-7000-8000-0000000000e5";
const OTHER_VIEWER = "00000000-0000-7000-8000-0000000000e6";

/** Every row, as the site's author and a Sidekick read. */
const ALL_ROWS = { rows: "all" } as const;
/** One viewer's rows in per-viewer tables, as any other member reads. */
const VIEWER_ROWS = { rows: "viewer", viewerId: VIEWER } as const;

/**
 * A site with one per-viewer table, one shared table, and a view over the
 * per-viewer one: the shape whose isolation the scoped reads must hold.
 */
const JOURNAL_MODULE = `
import { DurableObject } from "cloudflare:workers";
export class SiteData extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS entries (private_to_viewer TEXT NOT NULL, body TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS prompts (body TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS generated_notes (owner TEXT, body TEXT, private_to_viewer TEXT GENERATED ALWAYS AS (owner) VIRTUAL)");
    ctx.storage.sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(body, private_to_viewer)");
    ctx.storage.sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS entries_search USING fts5(body, content='entries')");
    // An index fed by a trigger, and a word list over it: neither names the
    // private table, and both hold its text.
    ctx.storage.sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS idx USING fts5(body)");
    ctx.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS entries_to_idx AFTER INSERT ON entries BEGIN INSERT INTO idx (body) VALUES (new.body); END");
    ctx.storage.sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5vocab('idx', 'row')");
  }
  async fetch(request) {
    const url = new URL(request.url);
    const viewer = request.headers.get("x-rally-viewer-id");
    if (url.pathname === "/write" && viewer) {
      this.ctx.storage.sql.exec("INSERT INTO entries (private_to_viewer, body) VALUES (?, ?)", viewer, url.searchParams.get("body"));
      this.ctx.storage.sql.exec("INSERT INTO generated_notes (owner, body) VALUES (?, ?)", viewer, url.searchParams.get("body"));
      this.ctx.storage.sql.exec("INSERT INTO notes_fts (body, private_to_viewer) VALUES (?, ?)", url.searchParams.get("body"), viewer);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/prompt") {
      this.ctx.storage.sql.exec("INSERT INTO prompts (body) VALUES (?)", url.searchParams.get("body"));
      return Response.json({ ok: true });
    }
    return this.env.ASSETS.fetch(request);
  }
}
`;

/** The site's own published page, reached through the facet's ASSETS binding. */
const PAGE_HTML = "<!doctype html><title>Votes</title><p>Cast your vote.";

/** A published data file, read server-side the way the skill teaches. */
const SEED_JSON = '{"quorum":3}';

/** A stateful artifact that counts votes, as a model would write one. */
const VOTING_MODULE = `
import { DurableObject } from "cloudflare:workers";
export class SiteData extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS votes (member TEXT PRIMARY KEY, choice TEXT NOT NULL)",
    );
  }
  async fetch(request) {
    const url = new URL(request.url);
    const viewer = request.headers.get("x-rally-viewer-id");
    // In-memory, not stored: it counts requests this *instance* has served, so
    // it distinguishes a warm facet from a freshly constructed one.
    this.hits = (this.hits ?? 0) + 1;
    if (url.pathname === "/hits") return Response.json({ hits: this.hits });
    if (url.pathname === "/vote" && viewer) {
      const choice = url.searchParams.get("choice") ?? "yes";
      this.ctx.storage.sql.exec(
        "INSERT INTO votes (member, choice) VALUES (?, ?) ON CONFLICT(member) DO UPDATE SET choice = excluded.choice",
        viewer,
        choice,
      );
      return Response.json({ ok: true });
    }
    if (url.pathname === "/tally") {
      const rows = this.ctx.storage.sql.exec("SELECT member, choice FROM votes ORDER BY member").toArray();
      return Response.json({ votes: rows });
    }
    if (url.pathname === "/quorum") {
      // The string form the skill teaches for reading a published data file.
      const seed = await (await this.env.ASSETS.fetch("/seed.json")).json();
      return Response.json(seed);
    }
    // The asset fallback exactly as the skill teaches it. Written this way on
    // purpose: a hand-written Response here proves the routing and hides
    // whether the facet has an ASSETS binding at all, which is how every
    // stateful site came to throw on its own index.html.
    return this.env.ASSETS.fetch(request);
  }
}
`;

/** The same site after a revision: a new route, the same schema and rows. */
const VOTING_MODULE_V2 = VOTING_MODULE.replace(
  '    return this.env.ASSETS.fetch(request);',
  '    if (url.pathname === "/added") return Response.json({ added: true });\n    return this.env.ASSETS.fetch(request);',
);

function manifest(version: number) {
  return {
    version: 1 as const,
    artifactId: asArtifactId(ARTIFACT),
    artifactVersion: version,
    mode: "active" as const,
    stateful: true,
    serverModuleSha256: "a".repeat(64),
    assets: [
      { path: "index.html", contentType: "text/html; charset=utf-8", sizeBytes: PAGE_HTML.length, sha256: "b".repeat(64) },
      { path: "seed.json", contentType: "application/json; charset=utf-8", sizeBytes: SEED_JSON.length, sha256: "c".repeat(64) },
    ],
    totalBytes: PAGE_HTML.length + SEED_JSON.length,
    publishedAt: "2026-08-29T12:00:00.000Z",
  };
}

function hostStub(): DurableObjectStub<ArtifactHostDO> {
  return env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(
    artifactHostDOName("global", ARTIFACT as never),
  )) as DurableObjectStub<ArtifactHostDO>;
}

/**
 * A version number that never repeats within this file.
 *
 * **The loader caches an isolate by its id, and the id is version-scoped**, so
 * publishing *different* source at the same version reuses the warm isolate and
 * silently runs the old code. Production never does that — a republish always
 * advances the version — but a test that reuses a number does, and the failure
 * reads as "my route is missing" rather than "I got a cached module". Handing
 * out a fresh number per publish keeps every scenario honest about which code
 * it is exercising, and the caching behavior itself is asserted separately.
 */
let nextVersion = 0;

/**
 * Publish one version of the artifact, always at a number nothing has used.
 *
 * The version is allocated here rather than passed in, because a caller that
 * picks its own will eventually pick one another test already published
 * different source at — and the resulting failure reads as a missing route
 * rather than as a cache hit.
 */
async function publish(source: string): Promise<number> {
  nextVersion += 1;
  const version = nextVersion;
  await env.PAYLOADS.put(artifactAssetKey(ARTIFACT, version, "index.js"), source);
  await env.PAYLOADS.put(artifactAssetKey(ARTIFACT, version, "index.html"), PAGE_HTML);
  await env.PAYLOADS.put(artifactAssetKey(ARTIFACT, version, "seed.json"), SEED_JSON);
  await hostStub().recordPublish({
    artifactId: ARTIFACT,
    workspaceId: WORKSPACE,
    workstreamId: WORKSTREAM,
    resourceId: RESOURCE,
    region: "global",
    manifest: manifest(version),
  });
  return version;
}

/** A request as the serving path forwards it: viewer identity, no cookie. */
function viewerRequest(path: string, viewer = VIEWER): Request {
  return new Request(`https://artifact.test${path}`, {
    headers: { "x-rally-viewer-id": viewer, "x-rally-viewer-name": "Ada" },
  });
}

beforeEach(async () => {
  await reset();
});

describe("a stateful artifact's facet", () => {
  it("serves its own published page through the ASSETS binding", async () => {
    // The flagship shape: a poll whose API routes the model wrote and whose
    // index.html Rally serves. With an empty facet env there was no ASSETS at
    // all, so this line threw and every request that was not a hand-written
    // route took the artifact's error page instead of the page.
    await publish(VOTING_MODULE);
    const response = await hostStub().fetchThroughFacet(viewerRequest("/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE_HTML);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("accepts the relative string the skill teaches for a server-side read", async () => {
    // A stub's own `fetch` is the runtime's Fetcher and throws
    // `Invalid URL: /seed.json` on this. Rally's shim inside the isolate is
    // what makes the declared `Request | string` contract true.
    await publish(VOTING_MODULE);
    const response = await hostStub().fetchThroughFacet(viewerRequest("/quorum"));
    expect(await response.json()).toEqual({ quorum: 3 });
  });

  it("answers a path the manifest does not name with a 404, not the page", async () => {
    await publish(VOTING_MODULE);
    expect((await hostStub().fetchThroughFacet(viewerRequest("/nope.css"))).status).toBe(404);
  });

  it("runs the model's class with its own database and remembers between requests", async () => {
    await publish(VOTING_MODULE);
    const host = hostStub();
    expect((await host.fetchThroughFacet(viewerRequest("/vote?choice=yes"))).status).toBe(200);
    const tally = await (await host.fetchThroughFacet(viewerRequest("/tally"))).json();
    expect(tally).toEqual({ votes: [{ member: VIEWER, choice: "yes" }] });
  });

  it("attributes each vote to its viewer and deduplicates on the member id", async () => {
    // No name field and no seat picker: the vote is this member's because they
    // sent it, and voting again updates rather than duplicating.
    await publish(VOTING_MODULE);
    const host = hostStub();
    const second = "00000000-0000-7000-8000-0000000000e6";
    await host.fetchThroughFacet(viewerRequest("/vote?choice=yes"));
    await host.fetchThroughFacet(viewerRequest("/vote?choice=no"));
    await host.fetchThroughFacet(viewerRequest("/vote?choice=yes", second));
    const tally = await (await host.fetchThroughFacet(viewerRequest("/tally"))).json() as {
      votes: { member: string; choice: string }[];
    };
    expect(tally.votes).toHaveLength(2);
    expect(tally.votes.find((vote) => vote.member === VIEWER)?.choice).toBe("no");
  });

  it("lets Rally's host class read the same rows the page wrote", async () => {
    // One read path, three consumers — the agent tools, the Data view, and the
    // export — so what the page shows and what the rail shows cannot disagree.
    await publish(VOTING_MODULE);
    const host = hostStub();
    await host.fetchThroughFacet(viewerRequest("/vote?choice=maybe"));
    const described = await host.describeData(ALL_ROWS);
    const votes = described.tables.find((table) => table.name === "votes");
    expect(votes?.rowCount).toBe(1);
    expect(votes?.columns.map((column) => column.name).sort()).toEqual(["choice", "member"]);
    expect(await host.queryData("SELECT choice FROM votes", [], 10, ALL_ROWS))
      .toMatchObject({ ok: true, rows: [{ choice: "maybe" }] });
    // A site with no private table keeps free SQL open to every member.
    expect(await host.queryData("SELECT choice FROM votes", [], 10, VIEWER_ROWS))
      .toMatchObject({ ok: true, rows: [{ choice: "maybe" }] });
  });

  it("pages a private table as one viewer's rows, and refuses that viewer free SQL on the site", async () => {
    await publish(JOURNAL_MODULE);
    const host = hostStub();
    await host.fetchThroughFacet(viewerRequest("/write?body=mine"));
    await host.fetchThroughFacet(viewerRequest("/write?body=theirs", OTHER_VIEWER));
    await host.fetchThroughFacet(viewerRequest("/prompt?body=shared"));
    expect(await host.pageData("entries", 0, 10, VIEWER_ROWS))
      .toMatchObject({ ok: true, rows: [{ private_to_viewer: VIEWER, body: "mine" }] });
    // A generated private column counts too.
    expect(await host.pageData("generated_notes", 0, 10, VIEWER_ROWS))
      .toMatchObject({ ok: true, rows: [{ body: "mine" }] });
    // A private search index's backing table reads as empty.
    expect(await host.pageData("notes_fts_content", 0, 10, VIEWER_ROWS)).toMatchObject({ ok: true, rows: [] });
    // So does a search index over a private table, which the author reads in full.
    expect(await host.pageData("entries_search", 0, 10, VIEWER_ROWS)).toMatchObject({ ok: true, rows: [] });
    expect((await host.pageData("entries_search", 0, 10, ALL_ROWS) as { rows: unknown[] }).rows).toHaveLength(2);
    // However an index is fed, it reads as empty to a viewer on this site.
    for (const index of ["idx", "idx_content", "terms"]) {
      expect(await host.pageData(index, 0, 10, VIEWER_ROWS)).toMatchObject({ ok: true, rows: [] });
    }
    expect((await host.pageData("terms", 0, 10, ALL_ROWS) as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    // A shared table pages in full.
    expect(await host.pageData("prompts", 0, 10, VIEWER_ROWS)).toMatchObject({ ok: true, rows: [{ body: "shared" }] });
    const described = await host.describeData(VIEWER_ROWS);
    expect(described.tables.find((table) => table.name === "entries")?.rowCount).toBe(1);
    expect(described.tables.find((table) => table.name === "entries_search")?.rowCount).toBe(0);
    // Every reader is told which tables are private, a generated column included.
    const authorView = await host.describeData(ALL_ROWS);
    expect(Object.fromEntries(authorView.tables
      .filter((table) => ["entries", "generated_notes", "prompts"].includes(table.name))
      .map((table) => [table.name, table.private])))
      .toEqual({ entries: true, generated_notes: true, prompts: false });
    // Free SQL is the author's and Sidekicks' on a site that keeps private rows.
    expect(await host.queryData("SELECT body FROM prompts", [], 10, VIEWER_ROWS))
      .toMatchObject({ ok: false, reason: "private_rows" });
    expect(await host.queryData("SELECT body FROM entries ORDER BY body", [], 10, ALL_ROWS))
      .toMatchObject({ ok: true, rows: [{ body: "mine" }, { body: "theirs" }] });
  });

  it("searches a private full-text table only within the reader's own rows", async () => {
    await publish(JOURNAL_MODULE);
    const host = hostStub();
    await host.fetchThroughFacet(viewerRequest("/write?body=mine"));
    await host.fetchThroughFacet(viewerRequest("/write?body=theirs", OTHER_VIEWER));
    // The other person's entry matches the words but is not this viewer's.
    expect(await host.pageData("notes_fts", 0, 10, VIEWER_ROWS, "theirs")).toEqual({ ok: true, rows: [] });
    expect(await host.pageData("notes_fts", 0, 10, VIEWER_ROWS, "mine"))
      .toMatchObject({ ok: true, rows: [{ body: "mine" }] });
    // The author searches every row.
    expect(await host.pageData("notes_fts", 0, 10, ALL_ROWS, "theirs"))
      .toMatchObject({ ok: true, rows: [{ body: "theirs" }] });
    // Only a full-text table searches, and bad syntax is the caller's to fix.
    expect(await host.pageData("entries", 0, 10, ALL_ROWS, "mine")).toMatchObject({ ok: false, reason: "table_refused" });
    expect(await host.pageData("notes_fts", 0, 10, VIEWER_ROWS, "\"unclosed"))
      .toMatchObject({ ok: false, reason: "table_refused", detail: expect.stringContaining("full-text search syntax") });
  });

  it("keeps one warm instance across requests rather than reconstructing per request", async () => {
    // Worth pinning on its own: it is what makes a stateful artifact cheap
    // between requests, and it is the premise the republish test reasons about.
    await publish(VOTING_MODULE);
    const host = hostStub();
    await host.fetchThroughFacet(viewerRequest("/vote?choice=yes"));
    const warm = await (await host.fetchThroughFacet(viewerRequest("/hits"))).json() as { hits: number };
    expect(warm.hits).toBeGreaterThan(1);
  });

  it("replaces the warm instance on a republish, runs the new code, and keeps every row", async () => {
    // A revision restarts the class and touches none of its rows. The
    // in-memory counter witnesses that the *instance* was replaced rather than
    // that new code merely became available.
    //
    // It does **not** prove the supervisor's defensive `facets.abort` is what
    // caused the replacement: removing that call leaves this test passing, so
    // workerd evidently reloads a facet whose class identity changed. The abort
    // stays because it is the reference platform's documented lifecycle and is
    // a no-op when unnecessary — but its necessity is not observable here, and
    // saying so is better than an assertion that would quietly pass either way.
    await publish(VOTING_MODULE);
    const host = hostStub();
    await host.fetchThroughFacet(viewerRequest("/vote?choice=yes"));
    const before = await (await host.fetchThroughFacet(viewerRequest("/hits"))).json() as { hits: number };
    expect(before.hits).toBeGreaterThan(1);

    await publish(VOTING_MODULE_V2);
    expect((await host.fetchThroughFacet(viewerRequest("/added"))).status).toBe(200);
    const after = await (await host.fetchThroughFacet(viewerRequest("/hits"))).json() as { hits: number };
    // A fresh instance has served only the two requests since the republish.
    expect(after.hits).toBeLessThan(before.hits + 3);
    const tally = await (await host.fetchThroughFacet(viewerRequest("/tally"))).json();
    expect(tally).toEqual({ votes: [{ member: VIEWER, choice: "yes" }] });
  });

  it("refuses a write through the query tool and leaves the rows alone", async () => {
    await publish(VOTING_MODULE);
    const host = hostStub();
    await host.fetchThroughFacet(viewerRequest("/vote?choice=yes"));
    // A refusal is a result the model repairs from, not an exception: throwing
    // would log an uncaught rejection inside the object on every wrong query.
    expect(await host.queryData("DELETE FROM votes", [], 10, ALL_ROWS))
      .toMatchObject({ ok: false, reason: "sql_refused" });
    expect(await host.queryData("SELECT 1; DELETE FROM votes", [], 10, ALL_ROWS))
      .toMatchObject({ ok: false, reason: "sql_refused" });
    const survived = await host.queryData("SELECT choice FROM votes", [], 10, ALL_ROWS);
    expect(survived).toMatchObject({ ok: true, rows: [{ choice: "yes" }] });
  });

  it("rolls back even a read, so nothing a statement did can persist", async () => {
    // The second line of defence, proven on the real runtime rather than
    // assumed: admission is what stops a write, and this is what stops one that
    // got past it.
    await publish(VOTING_MODULE);
    const host = hostStub();
    await host.queryData("SELECT count(*) AS n FROM votes", [], 10, ALL_ROWS);
    const described = await host.describeData(ALL_ROWS);
    expect(described.tables.find((table) => table.name === "votes")?.rowCount).toBe(0);
  });

  it("pages a table only by a name the live schema actually has", async () => {
    await publish(VOTING_MODULE);
    const host = hostStub();
    await host.fetchThroughFacet(viewerRequest("/vote?choice=yes"));
    expect(await host.pageData("votes", 0, 10, ALL_ROWS))
      .toMatchObject({ ok: true, rows: [{ member: VIEWER, choice: "yes" }] });
    expect(await host.pageData("sqlite_master", 0, 10, ALL_ROWS))
      .toMatchObject({ ok: false, reason: "table_refused" });
    expect(await host.pageData('votes"; DROP TABLE votes; --', 0, 10, ALL_ROWS))
      .toMatchObject({ ok: false, reason: "table_refused" });
  });

  it("hides SQLite's own bookkeeping from what a participant sees", async () => {
    await publish(VOTING_MODULE);
    const described = await hostStub().describeData(ALL_ROWS);
    expect(described.tables.every((table) => !table.name.startsWith("sqlite_"))).toBe(true);
  });

  it("deletes the facet's database with the artifact", async () => {
    await publish(VOTING_MODULE);
    const host = hostStub();
    await host.fetchThroughFacet(viewerRequest("/vote?choice=yes"));
    await host.purge();
    await publish(VOTING_MODULE);
    const described = await host.describeData(ALL_ROWS);
    expect(described.tables.find((table) => table.name === "votes")?.rowCount ?? 0).toBe(0);
  });

  it("gives the model's class no reference to Rally's, so it cannot shadow it", async () => {
    // Composition rather than subclassing: separate objects, separate prototype
    // chains. A model that defined its own `query` would be defining its own,
    // not overriding Rally's.
    const shadowing = VOTING_MODULE.replace(
      "async fetch(request) {",
      "rallyQuery() { return { hijacked: true }; }\n  async fetch(request) {",
    );
    await publish(shadowing);
    const host = hostStub();
    expect(await host.queryData("SELECT 1 AS n", [], 10, ALL_ROWS))
      .toMatchObject({ ok: true, rows: [{ n: 1 }] });
  });

  it("gives artifact code no network at all", async () => {
    const egress = VOTING_MODULE.replace(
      'if (url.pathname === "/tally")',
      'if (url.pathname === "/egress") { try { await fetch("https://example.com"); return Response.json({ reached: true }); } catch (error) { return Response.json({ threw: String(error.message ?? error) }); } }\n    if (url.pathname === "/tally")',
    );
    await publish(egress);
    const answered = await (await hostStub().fetchThroughFacet(viewerRequest("/egress"))).json() as {
      reached?: boolean;
      threw?: string;
    };
    expect(answered.reached).toBeUndefined();
    expect(typeof answered.threw).toBe("string");
  });

  it("keeps two artifacts' databases entirely separate", async () => {
    const other = "00000000-0000-7000-8000-0000000000e7";
    await publish(VOTING_MODULE);
    await hostStub().fetchThroughFacet(viewerRequest("/vote?choice=yes"));
    await env.PAYLOADS.put(artifactAssetKey(other, 1, "index.js"), VOTING_MODULE);
    const otherHost = env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(
      artifactHostDOName("global", other as never),
    )) as DurableObjectStub<ArtifactHostDO>;
    await otherHost.recordPublish({
      artifactId: other,
      workspaceId: WORKSPACE,
      workstreamId: WORKSTREAM,
      resourceId: "00000000-0000-7000-8000-0000000000e8",
      region: "global",
      manifest: { ...manifest(1), artifactId: asArtifactId(other) },
    });
    const described = await otherHost.describeData(ALL_ROWS);
    expect(described.tables.find((table) => table.name === "votes")?.rowCount ?? 0).toBe(0);
  });

  it("keeps the supervisor's own tables out of the facet's reach", async () => {
    // Facet isolation is symmetric: the model's class cannot read the
    // supervisor's tables, and the supervisor cannot read the facet's except
    // through the host class.
    const snooping = VOTING_MODULE.replace(
      'if (url.pathname === "/tally")',
      'if (url.pathname === "/snoop") { try { const rows = this.ctx.storage.sql.exec("SELECT * FROM viewer_sessions").toArray(); return Response.json({ read: rows.length }); } catch (error) { return Response.json({ threw: String(error.message ?? error) }); } }\n    if (url.pathname === "/tally")',
    );
    await publish(snooping);
    const answered = await (await hostStub().fetchThroughFacet(viewerRequest("/snoop"))).json() as {
      read?: number;
      threw?: string;
    };
    expect(answered.read).toBeUndefined();
    expect(answered.threw).toContain("viewer_sessions");
  });
});

describe("the supervisor around the facet", () => {
  it("drops a removed member's sessions and names no children", async () => {
    await publish(VOTING_MODULE);
    const host = hostStub();
    const { code } = await host.openForViewer({
      userId: VIEWER,
      appSessionId: "session-one",
      displayName: "Ada",
    });
    const redeemed = await host.redeemCode(code);
    expect(redeemed).not.toBeNull();
    // An artifact is a leaf on the revocation walk: it holds sessions rather
    // than sockets, and has no children of its own.
    const children = await host.revokeSocketAccess({
      reason: "workspace_membership_removed",
      workspaceId: asWorkspaceId(WORKSPACE),
      userId: VIEWER,
      sessionId: null,
    });
    expect(children).toEqual({});
    await runInDurableObject(host, (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM viewer_sessions`,
      ).one().n).toBe(0);
    });
  });

  it("preserves artifact sessions admitted after a removed membership rejoined", async () => {
    await env.DB.prepare(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT,
      workspace_incarnation TEXT,
      impersonator_user_id TEXT
    )`).run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, NULL)").bind("old-session", VIEWER, WORKSPACE, "old-membership"),
      env.DB.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, NULL)").bind("new-session", VIEWER, WORKSPACE, "new-membership"),
    ]);
    await publish(VOTING_MODULE);
    const host = hostStub();
    for (const appSessionId of ["old-session", "new-session"]) {
      const { code } = await host.openForViewer({ userId: VIEWER, appSessionId, displayName: "Ada" });
      expect(await host.redeemCode(code)).not.toBeNull();
    }
    await host.revokeSocketAccess({ reason: "workspace_membership_removed",
      workspaceId: asWorkspaceId(WORKSPACE), userId: VIEWER, sessionId: null,
      membershipIncarnation: "old-membership" });
    await runInDurableObject(host, (_instance, state) => {
      expect(state.storage.sql.exec<{ app_session_id: string }>(
        "SELECT app_session_id FROM viewer_sessions",
      ).toArray()).toEqual([{ app_session_id: "new-session" }]);
    });
  });

  it("redeems an open code exactly once", async () => {
    await publish(VOTING_MODULE);
    const host = hostStub();
    const { code } = await host.openForViewer({
      userId: VIEWER,
      appSessionId: null,
      displayName: "Ada",
    });
    expect(await host.redeemCode(code)).not.toBeNull();
    // Single-use bounds replay. It is deliberately not what keeps the code out
    // of a log — that is why it travels in a fragment and a request body.
    expect(await host.redeemCode(code)).toBeNull();
  });

  it("keeps a bounded error log a participant can read", async () => {
    await publish(VOTING_MODULE);
    const host = hostStub();
    for (let index = 0; index < 60; index += 1) {
      await host.recordError({
        version: 1,
        requestPath: `/boom/${index}`,
        message: `failure ${index}`,
        stack: null,
      });
    }
    const errors = await host.readErrors();
    expect(errors.length).toBeLessThanOrEqual(50);
    expect(errors[0]?.requestPath).toBe("/boom/59");
  });
});
