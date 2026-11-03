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

/** Whose rows a read may return: every row, or one viewer's in per-viewer tables. */
export type ArtifactRowScope = { rows: "all" } | { rows: "viewer"; viewerId: string };

interface SqlToken {
  /**
   * A bare word, a quoted identifier, a single-quoted string, or a single
   * punctuation character. Strings are kept because SQLite also reads a
   * single-quoted string as an identifier where only an identifier fits:
   * \`main.'entries'\` and \`'main'.entries\` both name the real table.
   */
  kind: "word" | "quoted" | "string" | "punct";
  /** The identifier as SQLite reads it: unquoted, escapes undone. */
  value: string;
  start: number;
  end: number;
}

/**
 * Split a statement into the tokens that can name something.
 *
 * Comments are skipped. Quoted identifiers and single-quoted strings are
 * **kept** and unquoted, which is the difference from
 * `blankLiteralsAndComments`: `"main"."notes"` and `main.'notes'` name the
 * real table exactly as `main.notes` does, and a scanner that blanked them
 * would miss the bypass.
 */
function identifierTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
      continue;
    }
    const closer = character === "'" ? "'" : character === '"' ? '"' : character === "`" ? "`" : character === "[" ? "]" : null;
    if (closer) {
      const start = index;
      let value = "";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === closer && closer !== "]" && sql[index + 1] === closer) { value += closer; index += 2; continue; }
        if (sql[index] === closer) { index += 1; break; }
        value += sql[index];
        index += 1;
      }
      tokens.push({ kind: closer === "'" ? "string" : "quoted", value, start, end: index });
      continue;
    }
    const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(sql.slice(index));
    if (word) {
      tokens.push({ kind: "word", value: word[0], start: index, end: index + word[0].length });
      index += word[0].length;
      continue;
    }
    tokens.push({ kind: "punct", value: character, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

/** A SQL string literal. The value is Rally's own user id, quoted all the same. */
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Remove the `main.` or `temp.` qualifier in front of every shadowed name.
 *
 * A qualified name resolves against the schema and never against a CTE, so
 * `main.entries` would read past the shadow. Dropping the qualifier makes it
 * the same reference as `entries`, which is what the caller meant. Names that
 * are not shadowed keep their qualifier and read the real table, as before.
 */
function unqualifyShadowed(sql: string, shadowed: ReadonlySet<string>): string {
  const tokens = identifierTokens(sql);
  let out = "";
  let copied = 0;
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const [schema, dot, name] = [tokens[index]!, tokens[index + 1]!, tokens[index + 2]!];
    if (schema.kind === "punct" || name.kind === "punct" || dot.kind !== "punct" || dot.value !== ".") continue;
    const qualifier = schema.value.toLowerCase();
    if ((qualifier === "main" || qualifier === "temp") && shadowed.has(name.value.toLowerCase())) {
      out += sql.slice(copied, schema.start);
      copied = name.start;
    }
  }
  return out + sql.slice(copied);
}

/**
 * A view's definition as a CTE: `name(columns) AS (select)`.
 *
 * Read from the `CREATE VIEW` text SQLite keeps in `sqlite_master`. The select
 * starts after the first `AS` that follows the name, and an optional column
 * list sits between the two. SQLite would not have accepted text without that
 * shape, so its absence throws rather than leaving the view unshadowed: a view
 * read past the shadow would return every viewer's rows.
 */
function viewAsCte(view: { name: string; sql: string }): string {
  // CREATE [TEMP | TEMPORARY] VIEW [IF NOT EXISTS] [schema .] name [(columns)] AS select.
  // The name is found by position: a column may repeat it, so the last match
  // before AS can be a column.
  const tokens = identifierTokens(view.sql);
  const keyword = (index: number, word: string) =>
    tokens[index]?.kind === "word" && tokens[index]!.value.toLowerCase() === word;
  let nameEnd = tokens.findIndex((_token, index) => keyword(index, "view")) + 1;
  if (keyword(nameEnd, "if")) nameEnd += 3;
  if (tokens[nameEnd + 1]?.kind === "punct" && tokens[nameEnd + 1]!.value === ".") nameEnd += 2;
  const as = tokens.findIndex((_token, index) => index > nameEnd && keyword(index, "as"));
  if (nameEnd === 0 || as === -1 || tokens[nameEnd]?.value.toLowerCase() !== view.name.toLowerCase()) {
    throw new Error("artifact_view_definition_unreadable");
  }
  const columns = view.sql.slice(tokens[nameEnd]!.end, tokens[as]!.start).trim();
  const body = view.sql.slice(tokens[as]!.end).trim().replace(/;\s*$/u, "");
  return `${quoteIdentifier(view.name)}${columns ? columns : ""} AS (${body})`;
}

/**
 * Limit an already-admitted read to one viewer's rows in per-viewer tables.
 *
 * **Each per-viewer table is shadowed by a common table expression of the same
 * name**, filtered to the viewer. SQLite resolves an unqualified table name to
 * a CTE before the schema, through every subquery and every other CTE in the
 * statement, so the caller's query runs as written against a database that
 * holds only this viewer's rows. Nothing the caller may write is refused here:
 * the site's model designs its own schema and the reader designs its own
 * query, and neither should have to know scoping exists.
 *
 * Two references would otherwise read past the shadow, and both are rewritten:
 *
 * - a **schema-qualified** name (`main.entries`) resolves against the schema,
 *   so its qualifier is dropped; and
 * - a **view** was compiled against the schema, so every view is shadowed too,
 *   by a CTE built from its own definition. Its body then reads the shadowed
 *   tables like any other reference.
 *
 * A caller CTE that reuses a shadowed name is a SQLite error (`duplicate WITH
 * table name`), not a leak.
 */
export function scopeStatementToViewer(
  sql: string,
  input: {
    viewerTables: readonly string[];
    views: readonly { name: string; sql: string }[];
    viewerId: string;
  },
): string {
  if (input.viewerTables.length === 0) return sql;
  const shadowed = new Set([...input.viewerTables, ...input.views.map((view) => view.name)].map((name) => name.toLowerCase()));
  const shadows = [
    ...input.viewerTables.map((table) =>
      `${quoteIdentifier(table)} AS (SELECT * FROM main.${quoteIdentifier(table)} WHERE ${quoteIdentifier(VIEWER_COLUMN)} = ${sqlString(input.viewerId)})`),
    ...input.views.map((view) => viewAsCte({ name: view.name, sql: unqualifyShadowed(view.sql, shadowed) })),
  ].join(", ");
  const statement = unqualifyShadowed(sql, shadowed);
  const [first, second] = identifierTokens(statement);
  if (first?.kind === "word" && first.value.toLowerCase() === "with") {
    // Merge into the caller's WITH: a statement has one, and RECURSIVE has to
    // lead it. The shadows come first so the caller's CTEs can read them.
    const recursive = second?.kind === "word" && second.value.toLowerCase() === "recursive";
    const resume = recursive ? second.end : first.end;
    return `${statement.slice(0, first.start)}WITH ${recursive ? "RECURSIVE " : ""}${shadows}, ${statement.slice(resume)}`;
  }
  return `WITH ${shadows} ${statement}`;
}
