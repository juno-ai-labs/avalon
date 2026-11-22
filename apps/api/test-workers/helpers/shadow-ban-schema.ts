import shadowBanMigration from "../../../../packages/db/migrations/0137_shadow_ban.sql?raw";

/**
 * The shadow-ban migration, statement by statement, for the runtime suite's
 * schemaless D1: the `users` column and the membership guard
 * (`docs/shadow-ban.md`). The checked-in file rather than a copy, so the guard
 * a case runs against is the one production runs. Declare `users` and
 * `workspace_members` first: these statements alter them.
 *
 * A statement ends at a semicolon that ends its line, which keeps a trigger's
 * body whole.
 */
export const SHADOW_BAN_SCHEMA = shadowBanMigration
  .split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n")
  .split(/;[ \t]*$/mu).map((sql) => sql.trim()).filter((sql) => sql.length > 0);
