/**
 * The Rally-authored code that runs *inside* a stateful artifact's facet,
 * alongside the model's own storage class.
 *
 * **It composes the model's class rather than extending it, and that is a
 * correctness decision, not a style preference.** A Rally subclass of `SiteData`
 * would put Rally's method names into the model's own namespace and win every
 * collision: the model's `fetch`, running as inherited code on the same
 * instance, would resolve `this.query(...)` to Rally's implementation with a
 * different signature — and `query`, `describe`, `page`, `csv`, and `size` are
 * precisely the names a model reaches for when it factors a SQL helper out of a
 * handler. That failure is invisible at publish, because publish never executes
 * artifact code, and surfaces at serve time as a broken site in code that reads
 * correctly. Composition removes the hazard outright: separate objects,
 * separate prototype chains, no reserved names for the skill to teach and none
 * for a model to trip over.
 *
 * Both objects address the same `ctx.storage` — the same database — so the host
 * answers supervisor RPCs the model's code never defined, over the same rows the
 * page reads and writes. That is what makes a poll's tally answerable in chat:
 * one read path, three consumers (the two agent tools, the rail's Data view,
 * and the CSV export), so they can never disagree.
 *
 * The source below is a **string** because it is not compiled with this Worker:
 * Rally assembles the dynamic worker's `modules` map, and this module is loaded
 * into the artifact's own isolate beside the model's `index.js`, which it
 * imports. It is written in plain JavaScript for that reason.
 *
 * See `docs/live-web-artifacts.md`.
 */

/** The module name Rally's host class is loaded under, beside the model's. */
export const FACET_HOST_MODULE = "__rally_host.js";

/** The class name the facet actually runs. */
export const FACET_HOST_CLASS = "RallyArtifactHost";

/** The facet's fixed name, so a republish reloads rather than forks storage. */
export const FACET_NAME = "data";

/**
 * A page of rows is bounded so one read cannot return a whole database.
 *
 * A display and transport bound rather than a defensive one — the rail shows a
 * page a person scrolls, and a tool result rides an inference payload — so it
 * is set here rather than handed back as an open limit.
 */
export const DATA_PAGE_ROWS = 200;

/**
 * The source of the module Rally loads into a stateful artifact's facet.
 *
 * Every method here is Rally's and reachable only from the supervisor. The
 * model's class holds no reference to this object at all, so a hostile
 * `SiteData` cannot override, shadow, or call any of it — what it can still do
 * is write misleading rows, which no artifact-owned store could prevent and
 * which is why the *contents* of these rows are treated as untrusted content
 * everywhere they surface.
 */
export const FACET_HOST_MODULE_SOURCE = `
import { DurableObject } from "cloudflare:workers";
import { SiteData } from "./index.js";
import { wrapAssets } from "./__rally_assets.js";

/**
 * The tables Rally will never report or export.
 *
 * SQLite's own bookkeeping is not artifact data, and a Data view that listed
 * \`sqlite_sequence\` beside a poll's votes would be showing a participant
 * something that is not theirs to reason about.
 */
const INTERNAL_TABLE = /^(sqlite_|_cf_)/;

function quoteIdentifier(name) {
  return '"' + String(name).replaceAll('"', '""') + '"';
}

export class ${FACET_HOST_CLASS} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The model's class is *instantiated and held*, never inherited from. It
    // receives the same ctx, so both objects address one database while living
    // on separate prototype chains — and an env of Rally's construction that
    // carries the wrapped asset reader and nothing else. The loopback stub the
    // supervisor injected stays in this module's scope, which \`SiteData\`
    // holds no reference to.
    this.site = new SiteData(ctx, { ASSETS: wrapAssets(env.RALLY_ASSETS) });
  }

  /** Every request for this artifact, served by the model's own handler. */
  fetch(request) {
    return this.site.fetch(request);
  }

  /**
   * The shape of what the artifact has stored.
   *
   * Discovery first, per the tool family's rule: the run answering a data
   * question may be post-compaction, a different run, or a smaller routed model
   * that never saw the schema it is about to query.
   */
  rallyDescribe() {
    const tables = [];
    for (const row of this.ctx.storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )) {
      if (INTERNAL_TABLE.test(row.name)) continue;
      const columns = [];
      for (const column of this.ctx.storage.sql.exec(
        "SELECT name, type FROM pragma_table_info(?)",
        row.name,
      )) {
        columns.push({ name: column.name, type: column.type || "ANY" });
      }
      const counted = this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS n FROM " + quoteIdentifier(row.name))
        .one();
      tables.push({ name: row.name, columns, rowCount: Number(counted.n) });
    }
    return { tables };
  }

  /**
   * The schema scoping reads: every table and view with its definition, and
   * every column of each table, generated ones included. No rows are counted,
   * so a scoped read pays for a schema lookup and nothing more.
   */
  rallySchema() {
    const tables = [];
    const views = [];
    for (const row of this.ctx.storage.sql.exec(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
    )) {
      if (INTERNAL_TABLE.test(row.name)) continue;
      if (row.type === "view") { views.push({ name: row.name, sql: row.sql ?? "" }); continue; }
      const columns = [];
      for (const column of this.ctx.storage.sql.exec("SELECT name FROM pragma_table_xinfo(?)", row.name)) {
        columns.push(column.name);
      }
      tables.push({ name: row.name, sql: row.sql ?? "", columns });
    }
    return { tables, views };
  }

  /** The table names the live schema actually has, for identifier admission. */
  rallyTableNames() {
    const names = [];
    for (const row of this.ctx.storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )) {
      if (!INTERNAL_TABLE.test(row.name)) names.push(row.name);
    }
    return names;
  }

  /**
   * Run one already-admitted read.
   *
   * The statement reached here only after the supervisor admitted it as a
   * single SELECT. The rollback below is the *second* line of defence, not the
   * first: it cannot contain a payload that ends the transaction itself, which
   * is exactly why admission is positive rather than subtractive.
   */
  rallyQuery(sql, params, maxRows) {
    let result = { columns: [], rows: [], rowCount: 0, truncated: false };
    try {
      this.ctx.storage.transactionSync(() => {
        const cursor = this.ctx.storage.sql.exec(sql, ...(params ?? []));
        const rows = [];
        let truncated = false;
        for (const row of cursor) {
          if (rows.length >= maxRows) { truncated = true; break; }
          rows.push(row);
        }
        result = {
          columns: cursor.columnNames ?? Object.keys(rows[0] ?? {}),
          rows,
          rowCount: rows.length,
          truncated,
        };
        // Always. A read has nothing to commit, and a statement that managed to
        // write despite admission leaves nothing behind.
        throw new RallyRollback();
      });
    } catch (error) {
      if (!(error instanceof RallyRollback)) throw error;
    }
    return result;
  }

  /** One page of one table, for the rail's Data view and the CSV export. */
  rallyPage(quotedTable, offset, limit) {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT * FROM " + quotedTable + " LIMIT ? OFFSET ?",
        Math.min(limit, ${DATA_PAGE_ROWS}),
        Math.max(0, offset),
      )
      .toArray();
    return { rows };
  }
}

/** Thrown to force the rollback; never surfaced to a caller. */
class RallyRollback extends Error {}
`;
