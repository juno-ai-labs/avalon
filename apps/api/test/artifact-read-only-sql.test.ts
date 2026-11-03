import { describe, expect, it } from "vitest";

import {
  admitReadOnlyStatement,
  admitTableName,
  quoteIdentifier,
  viewerTables,
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

describe("which tables are private to a viewer", () => {
  it("counts a table private by its column, generated or not, and shared otherwise", () => {
    const tables = viewerTables({ views: [], tables: [
      { name: "entries", sql: "CREATE TABLE entries (private_to_viewer TEXT, body TEXT)", columns: ["private_to_viewer", "body"] },
      { name: "g", sql: "CREATE TABLE g (owner TEXT, private_to_viewer TEXT GENERATED ALWAYS AS (owner))", columns: ["owner", "private_to_viewer"] },
      { name: "prompts", sql: "CREATE TABLE prompts (body TEXT)", columns: ["body"] },
    ] });
    expect(tables.filtered.map((table) => table.name)).toEqual(["entries", "g"]);
    expect(tables.hidden).toEqual([]);
  });

  it("hides a private search index's backing tables", () => {
    const tables = viewerTables({ views: [], tables: [
      { name: "notes_fts", sql: "CREATE VIRTUAL TABLE notes_fts USING fts5(body, private_to_viewer)", columns: ["body", "private_to_viewer"] },
      { name: "notes_fts_content", sql: "CREATE TABLE 'notes_fts_content'(id INTEGER PRIMARY KEY, c0, c1)", columns: ["id", "c0", "c1"] },
    ] });
    expect(tables.hidden).toEqual(["notes_fts_content"]);
  });
});
