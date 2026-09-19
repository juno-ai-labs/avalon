import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { asWorkspaceId } from "@rally/contracts";
import { sha256Hex } from "@rally/db";
import { defineLinkPayload, issueLinkPayload, openLinkPayload, purgeExpiredLinkPayloads } from "@rally/db/link-payloads";
import { issueScopeInvitationLink, openScopeInvitationCredential, scopeInvitationLinkUrl } from "../src/services/scope-invitation-link";
import { diagnosticErrorCode } from "../src/observability/logger";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const target = {
  workspaceId: asWorkspaceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  parentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  invitationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const address = { ...target, token: "invitation-proof" };

let db: DatabaseSync;
const bindings = () => createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error", DB: sqliteD1(db) });
const rows = () => db.prepare("SELECT token_hash, type, payload, expires_at FROM link_payloads").all() as Array<Record<string, string | null>>;

beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close(); });

it("hands back a short token, and stores where it points without what opens it", async () => {
  const env = bindings();
  const token = await issueScopeInvitationLink(env, target, null);
  // Prefix, separator and 256 bits: the token is what guards the row.
  expect(token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/u);
  expect(scopeInvitationLinkUrl(new URL("https://app.example.test"), token).toString())
    .toBe(`https://app.example.test/invite#${token}`);
  // The secret an owner checks is the token the holder presented, not a second
  // one kept beside the address.
  expect(await openScopeInvitationCredential(env, { link: token })).toEqual({ ...target, token });

  const [row] = rows();
  expect(rows()).toHaveLength(1);
  expect(row).toMatchObject({ type: "inv", expires_at: null, token_hash: await sha256Hex(token) });
  // A dump of this table is a list of what exists, not a set of working links:
  // no token, and nothing that could be replayed as one through the addressed
  // request body that is still accepted.
  expect(JSON.stringify(row)).not.toContain(token.slice(4));
  expect(JSON.parse(String(row!.payload))).toEqual(target);
  expect(Object.keys(JSON.parse(String(row!.payload)))).not.toContain("token");
});

it("refuses a token this deployment never issued, or issued as something else", async () => {
  const env = bindings();
  const token = await issueScopeInvitationLink(env, target, null);
  expect(await openScopeInvitationCredential(env, { link: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}` })).toBeNull();
  expect(await openScopeInvitationCredential(env, { link: `inv_${"A".repeat(43)}` })).toBeNull();

  // Another kind's token, and the same random half wearing this kind's prefix.
  const other = defineLinkPayload("tst", z.strictObject({ note: z.string() }));
  const foreign = await issueLinkPayload(sqliteD1(db), other, { note: "not an invitation" });
  expect(await openScopeInvitationCredential(env, { link: foreign })).toBeNull();
  expect(await openScopeInvitationCredential(env, { link: `inv_${foreign.slice(4)}` })).toBeNull();
  // The kind that issued it still reads it: refusal is about the prefix, not the row.
  expect(await openLinkPayload(sqliteD1(db), other, foreign)).toEqual({ note: "not an invitation" });
});

it("dies with the invitation it addresses, and sweeps the rows that have", async () => {
  const env = bindings();
  const deadline = Date.now() + 600_000;
  const expiring = await issueScopeInvitationLink(env, target, deadline);
  expect(rows()[0]).toMatchObject({ expires_at: new Date(deadline).toISOString() });
  expect(await openScopeInvitationCredential(env, { link: expiring })).toEqual({ ...target, token: expiring });

  db.prepare("UPDATE link_payloads SET expires_at = ?").run(new Date(Date.now() - 1_000).toISOString());
  expect(await openScopeInvitationCredential(env, { link: expiring })).toBeNull();
  // Issuing is what clears them: no schedule, and nothing to remember.
  expect(rows()).toHaveLength(1);
  await issueScopeInvitationLink(env, target, null);
  expect(rows().map((row) => row.expires_at)).toEqual([null]);
});

it("names the field when a payload no longer matches the shape its prefix promises", async () => {
  const env = bindings();
  const store = sqliteD1(db);
  const kind = defineLinkPayload("inv", z.strictObject({
    workspaceId: z.string(), parentId: z.string(), invitationId: z.number(),
  }));
  await expect(issueLinkPayload(store, kind, target as never))
    .rejects.toThrow("link_payload_invalid:inv:invitationId:invalid_type");

  const token = await issueScopeInvitationLink(env, target, null);
  db.prepare("UPDATE link_payloads SET payload = ?").run(JSON.stringify({ ...target, invitationId: 7 }));
  // The row exists, so this deployment wrote it: a deploy that stopped
  // honouring every link of this kind, not one more unreadable token.
  await expect(openScopeInvitationCredential(env, { link: token }))
    .rejects.toThrow("link_payload_drift_invalid:inv:invitationId:invalid_type");

  // A payload that is no longer JSON is the same kind of drift, and says so
  // rather than surfacing a parse error the route reports as an internal one.
  db.prepare("UPDATE link_payloads SET payload = ?").run("{not json");
  await expect(openScopeInvitationCredential(env, { link: token }))
    .rejects.toThrow("link_payload_drift_invalid:inv:-root-:invalid_json");

  // And the code has to survive the boundary that reports it. `_invalid:` is
  // what `isDiagnosticCode` matches; anything else reaches an operator as the
  // caller's generic fallback, which is the one thing this code exists not to
  // be.
  const thrown = await openScopeInvitationCredential(env, { link: token }).catch((error: unknown) => error);
  expect(diagnosticErrorCode(thrown, "internal_error")).toBe("link_payload_drift_invalid:inv:-root-:invalid_json");
});

it("sweeps an expired row on the schedule, not only on the next write", async () => {
  const env = bindings();
  const store = sqliteD1(db);
  await issueScopeInvitationLink(env, target, Date.now() + 600_000);
  const kept = await issueScopeInvitationLink(env, target, null);
  db.prepare("UPDATE link_payloads SET expires_at = ? WHERE expires_at IS NOT NULL")
    .run(new Date(Date.now() - 1_000).toISOString());

  // A table nobody is minting into is swept by nothing otherwise, and an
  // expired link should stop resolving whether or not another was issued since.
  await purgeExpiredLinkPayloads(store);
  expect(rows().map((row) => row.expires_at)).toEqual([null]);
  expect(await openScopeInvitationCredential(env, { link: kept })).toEqual({ ...target, token: kept });
});

it("passes an addressed credential through for links sent before tokens", async () => {
  expect(await openScopeInvitationCredential(bindings(), address)).toEqual(address);
});
