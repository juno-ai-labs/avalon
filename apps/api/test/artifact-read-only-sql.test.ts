import { describe, expect, it } from "vitest";

import {
  admitReadOnlyStatement,
  admitTableName,
  quoteIdentifier,
  scopeStatementToViewer,
} from "../src/artifacts/read-only-sql";

function admitted(sql: string): boolean {
  return admitReadOnlyStatement(sql).admitted;
}

function reason(sql: string): string {
  const verdict = admitReadOnlyStatement(sql);
  if (verdict.admitted) throw new Error(`expected a refusal for: ${sql}`);
  return verdict.reason;
}

describe("what an artifact data query may run", () => {
  it("admits an ordinary read", () => {
    expect(admitted("SELECT * FROM votes")).toBe(true);
    expect(admitted("  select choice, count(*) from votes group by choice  ")).toBe(true);
    expect(admitted("SELECT * FROM votes;")).toBe(true);
  });

  it("admits a CTE whose body is a read", () => {
    expect(admitted("WITH tally AS (SELECT choice FROM votes) SELECT * FROM tally")).toBe(true);
    expect(admitted("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b")).toBe(true);
  });

  it("returns the caller's original text, not the scanned copy", () => {
    // The blanking exists to read structure; running it would run a query with
    // its string literals replaced by spaces.
    const sql = "SELECT * FROM votes WHERE choice = 'yes; no'";
    const verdict = admitReadOnlyStatement(sql);
    expect(verdict.admitted && verdict.sql).toBe(sql);
  });
});

describe("what it refuses, and why a denylist would not have", () => {
  it("refuses plain writes", () => {
    for (const sql of [
      "INSERT INTO votes (choice) VALUES ('yes')",
      "UPDATE votes SET choice = 'no'",
      "DELETE FROM votes",
      "DROP TABLE votes",
      "CREATE TABLE x (a TEXT)",
      "ALTER TABLE votes ADD COLUMN x TEXT",
    ]) {
      expect(admitted(sql), sql).toBe(false);
    }
  });

  it("refuses a statement sequence that would commit a write mid-payload", () => {
    // The escape an always-rollback transaction cannot stop: the write commits
    // before the rollback the wrapper was counting on ever runs.
    expect(admitted("SELECT 1; INSERT INTO votes (choice) VALUES ('yes')")).toBe(false);
    expect(admitted("SELECT 1; COMMIT; DELETE FROM votes")).toBe(false);
    expect(reason("SELECT 1; INSERT INTO votes (choice) VALUES ('x')")).toContain("one statement");
  });

  it("refuses transaction control, which would subvert the containing rollback", () => {
    for (const sql of ["COMMIT", "ROLLBACK", "BEGIN", "SAVEPOINT s", "RELEASE s", "END"]) {
      expect(admitted(sql), sql).toBe(false);
    }
  });

  it("refuses PRAGMA and ATTACH", () => {
    expect(admitted("PRAGMA writable_schema = 1")).toBe(false);
    expect(admitted("ATTACH DATABASE 'x' AS other")).toBe(false);
  });

  it("refuses a CTE that wraps a write, which a first-keyword denylist would admit", () => {
    // `WITH x AS (…) DELETE FROM y` is valid SQLite and opens with a keyword
    // that reads as harmless.
    expect(admitted("WITH doomed AS (SELECT id FROM votes) DELETE FROM votes")).toBe(false);
    expect(admitted("WITH x AS (SELECT 1) INSERT INTO votes SELECT * FROM x")).toBe(false);
    expect(admitted("WITH x AS (SELECT 1) UPDATE votes SET choice = 'no'")).toBe(false);
    expect(reason("WITH x AS (SELECT 1) DELETE FROM votes")).toContain("SELECT");
  });

  it("refuses a nested CTE that wraps a write", () => {
    expect(admitted("WITH a AS (SELECT (SELECT 1) FROM votes) DELETE FROM votes")).toBe(false);
  });

  it("is not fooled by a semicolon inside a string literal", () => {
    // A scanner that did not understand quoting would call this two statements
    // and refuse a perfectly ordinary query.
    expect(admitted("SELECT * FROM votes WHERE note = 'a; b'")).toBe(true);
    expect(admitted("SELECT * FROM votes WHERE note = 'it''s; fine'")).toBe(true);
  });

  it("is not fooled by a write hidden behind a comment", () => {
    expect(admitted("SELECT 1 -- ; INSERT INTO votes VALUES ('x')")).toBe(true);
    expect(admitted("SELECT 1 /* ; DELETE FROM votes */")).toBe(true);
    // And a comment must not be able to *hide* the real opening keyword.
    expect(admitted("/* SELECT */ DELETE FROM votes")).toBe(false);
    expect(admitted("-- SELECT\nDELETE FROM votes")).toBe(false);
  });

  it("is not fooled by a quoted identifier that looks like a keyword", () => {
    expect(admitted('SELECT "delete from" FROM votes')).toBe(true);
    expect(admitted("SELECT [insert into] FROM votes")).toBe(true);
  });

  it("refuses an empty or whitespace-only query with a repair instruction", () => {
    expect(reason("")).toContain("Describe the data first");
    expect(reason("   \n  ")).toContain("Describe the data first");
    expect(reason("-- nothing here")).toContain("Describe the data first");
  });

  it("tells the model what to do next in every refusal", () => {
    for (const sql of ["INSERT INTO votes VALUES ('x')", "SELECT 1; SELECT 2", "WITH x AS (SELECT 1) DELETE FROM y"]) {
      expect(reason(sql).length, sql).toBeGreaterThan(20);
      expect(/rewrite|single|one statement|describe|read/iu.test(reason(sql)), sql).toBe(true);
    }
  });
});

describe("dynamic table names", () => {
  const live = ["votes", "rsvps", 'odd"name'];

  it("admits only a table the live schema reports", () => {
    // The allowlist is the database's, not the caller's, so a name that is not
    // a real table never reaches SQL.
    expect(admitTableName("votes", live)).toEqual({ admitted: true, quoted: '"votes"' });
    const refused = admitTableName("sqlite_master", live);
    expect(refused.admitted).toBe(false);
  });

  it("refuses an injection attempt outright rather than quoting it into safety", () => {
    const refused = admitTableName('votes"; DROP TABLE votes; --', live);
    expect(refused.admitted).toBe(false);
  });

  it("quotes a legitimate name that itself contains a quote", () => {
    // Legal in SQLite and it came from the database, so refusing it would break
    // a real artifact.
    expect(admitTableName('odd"name', live)).toEqual({ admitted: true, quoted: '"odd""name"' });
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });

  it("names the repair in its refusal", () => {
    const refused = admitTableName("nope", live);
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) expect(refused.reason).toContain("Describe the data first");
  });
});

describe("limiting a read to one viewer's rows", () => {
  const scope = { viewerTables: ["entries"], views: [], viewerId: "v-1" };
  const shadow = `"entries" AS (SELECT * FROM main."entries" WHERE "private_to_viewer" = 'v-1')`;

  it("shadows each per-viewer table with a CTE of the same name", () => {
    expect(scopeStatementToViewer("SELECT body FROM entries", scope))
      .toBe(`WITH ${shadow} SELECT body FROM entries`);
  });

  it("merges into the caller's own WITH, keeping RECURSIVE first", () => {
    expect(scopeStatementToViewer("WITH x AS (SELECT 1) SELECT * FROM x", scope))
      .toBe(`WITH ${shadow},  x AS (SELECT 1) SELECT * FROM x`);
    expect(scopeStatementToViewer("with recursive r(n) AS (SELECT 1) SELECT * FROM r", scope))
      .toBe(`WITH RECURSIVE ${shadow},  r(n) AS (SELECT 1) SELECT * FROM r`);
  });

  it("quotes the viewer id, so it can only ever be a value", () => {
    expect(scopeStatementToViewer("SELECT 1", { ...scope, viewerId: "x' OR '1'='1" }))
      .toContain(`"private_to_viewer" = 'x'' OR ''1''=''1')`);
  });

  it("drops a schema qualifier in any quoting from a shadowed name, and only from one", () => {
    expect(scopeStatementToViewer('SELECT * FROM main.entries, "main"."entries", [temp] . entries, main.prompts', scope))
      .toBe(`WITH ${shadow} SELECT * FROM entries, "entries", entries, main.prompts`);
  });

  it("leaves a schema name inside a string or a comment alone", () => {
    expect(scopeStatementToViewer("SELECT 'main.entries' -- main.entries\nFROM entries", scope))
      .toBe(`WITH ${shadow} SELECT 'main.entries' -- main.entries\nFROM entries`);
  });

  it("shadows a view with its own definition, so it reads the shadowed tables", () => {
    const views = [
      { name: "recent", sql: "CREATE VIEW recent AS SELECT body FROM main.entries" },
      { name: "Labelled", sql: 'CREATE VIEW IF NOT EXISTS "Labelled"(text) AS SELECT body FROM recent' },
    ];
    expect(scopeStatementToViewer("SELECT * FROM labelled", { ...scope, views })).toBe(
      `WITH ${shadow}, "recent" AS (SELECT body FROM entries), "Labelled"(text) AS (SELECT body FROM recent) SELECT * FROM labelled`,
    );
  });

  it("leaves a statement alone when the site has no per-viewer table", () => {
    expect(scopeStatementToViewer("SELECT * FROM main.prompts", { ...scope, viewerTables: [] }))
      .toBe("SELECT * FROM main.prompts");
  });
});
