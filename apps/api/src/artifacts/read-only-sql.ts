/**
 * What `query_artifact_data` is allowed to run against an artifact's database.
 *
 * **Read-only is enforced on the statement, not by the transaction.** An
 * always-rollback transaction is not an authorization boundary: caller-supplied
 * SQL can end or subvert the very transaction meant to contain it — a payload
 * that commits mid-statement leaves the writes behind — and SQLite's exec
 * surface accepts more than one statement at a time, so "wrap it and roll back"
 * protects nothing a determined statement cannot step around. The rollback
 * stays as the *second* line of defence. This is the first.
 *
 * Admission is therefore **positive rather than subtractive**: exactly one
 * statement, which must parse as a `SELECT`, and everything else refused. A
 * denylist of dangerous keywords is the shape that fails here, because it has
 * to be complete and SQLite's surface is not something this file can enumerate
 * correctly forever.
 *
 * Where the platform offers a storage-level read-only authorizer, that is
 * strictly better than this and should replace it — the workerd proof that
 * gates the artifact deploy exists to answer exactly that question. Until then
 * this is the boundary, so it is written to be over-strict: a legitimate query
 * this refuses costs the model one rewrite, and the error says how.
 *
 * See `docs/live-web-artifacts.md`.
 */

export type SqlAdmission =
  | { admitted: true; sql: string }
  | { admitted: false; reason: string };

/**
 * Strip comments and string literals, so structure can be read without them.
 *
 * Every refusal below reasons about *structure* — how many statements, what the
 * first keyword is — and both comments and string literals can contain anything
 * that looks like structure. `'; DROP TABLE x; --'` is one string literal in
 * one statement, and a scanner that did not understand quoting would see three
 * statements and refuse it; the same scanner would miss a real semicolon hidden
 * after a comment marker. So they are replaced by placeholders of the same
 * length rather than removed, keeping every offset aligned with the original.
 *
 * SQLite's own quoting rules, all of them: `'…'` with `''` escapes, `"…"` and
 * `[…]` and backtick identifiers, `--` to end of line, and `/* … *\/` blocks.
 */
function blankLiteralsAndComments(sql: string): string {
  const out = new Array<string>(sql.length);
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (character === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") out[index++] = " ";
      continue;
    }
    if (character === "/" && next === "*") {
      out[index++] = " ";
      out[index++] = " ";
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) out[index++] = " ";
      if (index < sql.length) { out[index++] = " "; out[index++] = " "; }
      continue;
    }
    const closer = character === "'" ? "'" : character === '"' ? '"' : character === "`" ? "`" : character === "[" ? "]" : null;
    if (closer) {
      out[index++] = " ";
      while (index < sql.length) {
        if (sql[index] === closer) {
          // A doubled quote is an escaped quote inside the literal, not its end.
          if (closer !== "]" && sql[index + 1] === closer) { out[index++] = " "; out[index++] = " "; continue; }
          out[index++] = " ";
          break;
        }
        out[index++] = " ";
      }
      continue;
    }
    out[index] = character;
    index += 1;
  }
  return out.join("");
}

/**
 * Keywords that may legitimately open a read.
 *
 * `WITH` is admitted because a common table expression is ordinary in a real
 * query — but only when its *body* is a `SELECT`. `WITH x AS (…) DELETE FROM y`
 * is valid SQLite and is exactly the shape a denylist on the first keyword
 * would wave through, so the check below looks past the CTE rather than at it.
 */
const SELECT = /^\s*select\b/iu;
const WITH = /^\s*with\b/iu;

/**
 * Decide whether one caller-supplied statement may run.
 *
 * The returned `sql` is the caller's original text, not the blanked copy: the
 * blanking exists to read structure, and running it would run a query with its
 * literals replaced by spaces.
 */
export function admitReadOnlyStatement(sql: string): SqlAdmission {
  const structure = blankLiteralsAndComments(sql);
  const trimmed = structure.trim();
  if (trimmed.length === 0) {
    return { admitted: false, reason: "The query is empty. Describe the data first, then write one SELECT." };
  }
  // One statement. A trailing semicolon is ordinary and is not a second
  // statement; anything after it is.
  const withoutTrailing = trimmed.replace(/;\s*$/u, "");
  if (withoutTrailing.includes(";")) {
    return {
      admitted: false,
      reason: "Only one statement is allowed. Send a single SELECT, without a second statement after it.",
    };
  }
  if (SELECT.test(withoutTrailing)) return { admitted: true, sql };
  if (WITH.test(withoutTrailing)) {
    // A CTE's body is what actually runs. Find the keyword that follows the
    // last closing parenthesis of the definitions — anything but SELECT is a
    // write wearing a read's opening keyword.
    const body = cteBody(withoutTrailing);
    if (body !== null && SELECT.test(body)) return { admitted: true, sql };
    return {
      admitted: false,
      reason: "A WITH clause is allowed only when it ends in a SELECT. Rewrite the query as a read.",
    };
  }
  return {
    admitted: false,
    reason: "Only SELECT statements are allowed here. Describe the data first, then rebuild the statement as a read.",
  };
}

/**
 * The statement a `WITH` clause actually executes, or `null` if it is unbalanced.
 *
 * Walks parenthesis depth rather than matching a pattern, because a CTE
 * definition can contain any number of nested parentheses and a regex that
 * tried to skip them would be skipping the wrong ones.
 */
function cteBody(statement: string): string | null {
  let depth = 0;
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) {
        // After a definition closes, either a comma introduces another or the
        // body begins.
        const rest = statement.slice(index + 1);
        const nextToken = /^\s*,/u.test(rest) ? null : rest;
        if (nextToken !== null) return nextToken;
      }
    }
  }
  return depth === 0 ? null : null;
}

/**
 * Quote a table or column name the *database itself* reported.
 *
 * `durable-object-sqlite.md` requires every dynamic identifier to come from a
 * closed, code-owned allowlist, and here the names are the model's — so no
 * code-owned list can exist and the rule cannot be met as written. What meets
 * its intent instead: the allowlist is built at request time from the facet's
 * own `sqlite_master`, the caller's name is admitted only by exact match
 * against that list, and the matched name is quoted rather than interpolated.
 *
 * The doubling of `"` is what makes the quoting total: a table whose name
 * contains a quote is legal in SQLite, and it came from the database rather
 * than from the caller, so refusing it would break a legitimate artifact.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Admit a caller-named table only if the live schema has it.
 *
 * The list is the database's, not the caller's, so a name that is not a real
 * table in this facet never reaches SQL at all.
 */
export function admitTableName(
  requested: string,
  liveTables: readonly string[],
): { admitted: true; quoted: string } | { admitted: false; reason: string } {
  if (!liveTables.includes(requested)) {
    return {
      admitted: false,
      reason: `This artifact has no table named ${requested}. Describe the data first to see its tables.`,
    };
  }
  return { admitted: true, quoted: quoteIdentifier(requested) };
}

/**
 * The column that makes a table **per-viewer**.
 *
 * A convention rather than a declaration because a stateful site has no
 * manifest field for its schema: the model writes `CREATE TABLE` in its own
 * class. The name states its effect rather than its content, so a model
 * choosing it knows it is making rows private, and a model that never read
 * the rule does not type it by accident; a generic name like `viewer_id`
 * failed both ways. A table without it is shared, and every reader sees all
 * its rows.
 */
export const VIEWER_COLUMN = "private_to_viewer";

/** Whose rows a read may return: every row, or one viewer's in private tables. */
export type ArtifactRowScope = { rows: "all" } | { rows: "viewer"; viewerId: string };

/** A site's schema as scoping needs it: names, definitions and every column. */
export interface ArtifactSchema {
  /**
   * Every table, ordinary or virtual, with the SQL that created it and every
   * column, generated ones included (`pragma_table_xinfo`, not `table_info`,
   * which leaves them out and would let a generated private column pass).
   */
  tables: readonly { name: string; sql: string; columns: readonly string[] }[];
  views: readonly { name: string; sql: string }[];
}

/** What scoping does to each table a scoped reader might name. */
export interface ViewerTables {
  /** Private tables, filtered to the viewer. `rowid` says whether to carry it. */
  filtered: readonly { name: string; rowid: boolean }[];
  /**
   * Tables a scoped reader sees as empty: the backing tables SQLite keeps for
   * a private virtual table (an FTS5 index's `<name>_content` and kin), which
   * hold the private text with no viewer column to filter on.
   */
  hidden: readonly string[];
}

/** Which tables are private, which carry a rowid, and which are hidden. */
export function viewerTables(schema: ArtifactSchema): ViewerTables {
  const isPrivate = (table: ArtifactSchema["tables"][number]) =>
    table.columns.some((column) => column.toLowerCase() === VIEWER_COLUMN);
  const privateVirtual = schema.tables
    .filter((table) => /^\s*create\s+virtual\s+table\b/iu.test(table.sql) && isPrivate(table))
    .map((table) => `${table.name.toLowerCase()}_`);
  const filtered = schema.tables.filter(isPrivate).map((table) => ({
    name: table.name,
    // Only an ordinary rowid table is sure to have one; a virtual table may
    // not, and a reference to a missing rowid would fail every scoped read.
    rowid: /^\s*create\s+table\b/iu.test(table.sql)
      && !/\bwithout\s+rowid\b/iu.test(table.sql)
      && !table.columns.some((column) => ["rowid", "oid", "_rowid_"].includes(column.toLowerCase())),
  }));
  const hidden = schema.tables
    .filter((table) => !isPrivate(table) && privateVirtual.some((prefix) => table.name.toLowerCase().startsWith(prefix)))
    .map((table) => table.name);
  return { filtered, hidden };
}
