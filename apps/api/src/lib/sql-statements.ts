/**
 * Split a trusted SQLite script without treating semicolons inside literals,
 * quoted identifiers, or comments as statement boundaries.
 *
 * Runtime database adapters use this only to route already-trusted server SQL
 * to its owning authority. It is deliberately not a SQL parser or validator.
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;

  const push = (end: number): void => {
    const statement = script.slice(start, end).trim();
    if (statement.length > 0) statements.push(statement);
    start = end + 1;
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    const next = script[index + 1];

    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character !== quote) continue;
      if (next === quote) {
        index += 1;
        continue;
      }
      quote = null;
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character === ";") push(index);
  }

  if (quote || blockComment) throw new Error("sql_statement_unterminated");
  const remainder = script.slice(start).trim();
  if (remainder.length > 0) statements.push(remainder);
  return statements;
}
