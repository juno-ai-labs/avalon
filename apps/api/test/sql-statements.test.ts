import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../src/lib/sql-statements";

describe("splitSqlStatements", () => {
  it("keeps semicolons inside SQLite literals and quoted identifiers", () => {
    expect(splitSqlStatements(`
      INSERT INTO messages(content) VALUES ('first;second');
      SELECT "semi;colon", \`another;identifier\`, [bracket;identifier]
        FROM messages;
    `)).toEqual([
      "INSERT INTO messages(content) VALUES ('first;second')",
      "SELECT \"semi;colon\", `another;identifier`, [bracket;identifier]\n        FROM messages",
    ]);
  });

  it("keeps semicolons inside comments and doubled quote escapes", () => {
    expect(splitSqlStatements(`
      -- this semicolon is not a boundary ;
      SELECT 'it''s;valid'; /* neither is this ; */ SELECT 2;
    `)).toEqual([
      "-- this semicolon is not a boundary ;\n      SELECT 'it''s;valid'",
      "/* neither is this ; */ SELECT 2",
    ]);
  });

  it("rejects unterminated quoted or block-commented SQL", () => {
    expect(() => splitSqlStatements("SELECT 'unfinished"))
      .toThrow("sql_statement_unterminated");
    expect(() => splitSqlStatements("SELECT 1 /* unfinished"))
      .toThrow("sql_statement_unterminated");
  });
});
