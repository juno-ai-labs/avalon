// Mint, list and revoke API tokens. See docs/api-tokens.md.
//
//   node scripts/api-token.mjs mint --email bot@example.com --label nightly-e2e [--expires-at 2027-01-01T00:00:00Z] [--remote]
//   node scripts/api-token.mjs list [--remote]
//   node scripts/api-token.mjs revoke --id <token id> [--sign-out-everywhere] [--remote]
//
// Minting is an operator act on purpose: it runs with the Cloudflare credentials
// that already live only in the local deployment environment, so no HTTP route
// can create a token. The token is generated here, printed once, and only its
// SHA-256 reaches the database. `--region` picks a deployment; Global is the
// identity deployment and the default.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWranglerJson } from "./d1-baseline.mjs";
import { isEntryPoint } from "./entry-point.mjs";
import { discoverRegions, pnpmExecutable, resolveTargets, wranglerArguments } from "./migrate-d1.mjs";

const API_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "api");

/** A new token and the hash the API compares it against (`sha256` in apps/api/src/lib/crypto.ts). */
export function newApiToken(random = randomBytes(32)) {
  const token = `rally_at_${Buffer.from(random).toString("base64url")}`;
  return { token, tokenHash: createHash("sha256").update(token).digest("base64url") };
}

/** A SQL string literal. Wrangler's `--command` takes no bound parameters. */
export function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["mint", "list", "revoke"].includes(command)) throw new Error("Usage: api-token.mjs mint|list|revoke [options]");
  const options = { command, remote: false, region: "global", signOutEverywhere: false };
  const valued = { "--email": "email", "--label": "label", "--expires-at": "expiresAt", "--id": "id", "--region": "region" };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--remote") options.remote = true;
    else if (argument === "--sign-out-everywhere") options.signOutEverywhere = true;
    else if (valued[argument]) {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      options[valued[argument]] = value;
      index += 1;
    } else throw new Error(`Unrecognized argument ${argument}`);
  }
  if (command === "mint") {
    if (!options.email) throw new Error("mint needs --email");
    if (!options.label) throw new Error("mint needs --label");
    if (options.expiresAt !== undefined) {
      const parsed = Date.parse(options.expiresAt);
      if (Number.isNaN(parsed)) throw new Error("--expires-at must be an ISO 8601 time");
      options.expiresAt = new Date(parsed).toISOString();
    }
  }
  if (command === "revoke" && !options.id) throw new Error("revoke needs --id");
  return options;
}

/** Inserts the token for the user with that address, or nothing when there is no such user. */
export function mintSql({ id, email, label, tokenHash, createdAt, expiresAt }) {
  return `INSERT INTO api_tokens (id, user_id, token_hash, label, created_at, expires_at)
    SELECT ${sqlText(id)}, id, ${sqlText(tokenHash)}, ${sqlText(label)}, ${sqlText(createdAt)}, ${expiresAt ? sqlText(expiresAt) : "NULL"}
    FROM users WHERE email = ${sqlText(email)}
    RETURNING id`;
}

/**
 * Stops the token minting sessions. With `signOutEverywhere`, also revokes every
 * session its user holds, which is the answer to a leaked token: a session
 * already minted from it otherwise lives on under the ordinary renewal rules.
 * Revoking rows here cuts HTTP at the next request; a socket already open stays
 * open until it closes, because only the API can publish a revocation.
 */
export function revokeSql({ id, signOutEverywhere, revokedAt }) {
  const statements = [
    `UPDATE api_tokens SET revoked_at = ${sqlText(revokedAt)} WHERE id = ${sqlText(id)} AND revoked_at IS NULL RETURNING id`,
  ];
  if (signOutEverywhere) {
    statements.push(`UPDATE sessions SET revoked_at = ${sqlText(revokedAt)}
      WHERE revoked_at IS NULL AND user_id = (SELECT user_id FROM api_tokens WHERE id = ${sqlText(id)})
      RETURNING id`);
  }
  return statements.join(";\n");
}

export const LIST_SQL = `SELECT t.id, u.email, t.label, t.created_at, t.expires_at, t.revoked_at, t.last_used_at
  FROM api_tokens t JOIN users u ON u.id = t.user_id ORDER BY t.created_at`;

function execute(target, sql) {
  const stdout = execFileSync(
    pnpmExecutable(),
    wranglerArguments(target, ["execute"], ["--json", "--command", sql]),
    { cwd: API_DIRECTORY, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  return parseWranglerJson(stdout, target.region);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const [target] = resolveTargets(discoverRegions(), [options.region]).map((entry) => ({ ...entry, remote: options.remote }));
  const now = new Date().toISOString();
  if (options.command === "list") {
    console.table(execute(target, LIST_SQL)[0]?.results ?? []);
    return;
  }
  if (options.command === "revoke") {
    const results = execute(target, revokeSql({ id: options.id, signOutEverywhere: options.signOutEverywhere, revokedAt: now }));
    // Counted from RETURNING rows: local Wrangler reports no `meta.changes`.
    if ((results[0]?.results ?? []).length === 0) throw new Error(`No live token with id ${options.id}`);
    console.log(`Revoked ${options.id}.`);
    if (options.signOutEverywhere) console.log(`Revoked ${(results[1]?.results ?? []).length} session(s) for its user.`);
    return;
  }
  const id = randomUUID();
  const { token, tokenHash } = newApiToken();
  const results = execute(target, mintSql({
    id, email: options.email, label: options.label, tokenHash, createdAt: now, expiresAt: options.expiresAt,
  }));
  if ((results[0]?.results ?? []).length === 0) {
    throw new Error(`No user with email ${options.email} in ${target.region}. The user signs in once before a token is minted.`);
  }
  console.error(`Minted token ${id} (${options.label}) for ${options.email} in ${target.region}. It is shown once:`);
  console.log(token);
}

if (isEntryPoint(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
