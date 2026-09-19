import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { asWorkspaceId } from "@rally/contracts";
import { sha256Hex } from "@rally/db";
import { defineLinkPayload, issueLinkPayload, openLinkPayload } from "@rally/db/link-payloads";
import { issueScopeInvitationLink, openScopeInvitationCredential, scopeInvitationLinkUrl } from "../src/services/scope-invitation-link";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const address = {
  workspaceId: asWorkspaceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  parentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  invitationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  token: "invitation-proof",
};

let db: DatabaseSync;
const bindings = () => createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error", DB: sqliteD1(db) });
const rows = () => db.prepare("SELECT token_hash, type, payload, expires_at FROM link_payloads").all() as Array<Record<string, string | null>>;

beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close(); });

it("hands back a short token and keeps everything it addresses in the row", async () => {
  const env = bindings();
  const token = await issueScopeInvitationLink(env, address, null);
  // Prefix, separator and 256 bits: the token is what guards the row.
  expect(token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/u);
  expect(scopeInvitationLinkUrl(new URL("https://app.example.test"), token).toString())
    .toBe(`https://app.example.test/invite#${token}`);
  expect(await openScopeInvitationCredential(env, { link: token })).toEqual(address);

  const [row] = rows();
  expect(rows()).toHaveLength(1);
  expect(row).toMatchObject({ type: "inv", expires_at: null, token_hash: await sha256Hex(token) });
  // A copy of the table is a list of what exists, not a set of working links.
  expect(JSON.stringify(row)).not.toContain(token.slice(4));
  expect(JSON.parse(String(row!.payload))).toEqual(address);
});

it("refuses a token this deployment never issued, or issued as something else", async () => {
  const env = bindings();
  const token = await issueScopeInvitationLink(env, address, null);
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
  const expiring = await issueScopeInvitationLink(env, address, deadline);
  expect(rows()[0]).toMatchObject({ expires_at: new Date(deadline).toISOString() });
  expect(await openScopeInvitationCredential(env, { link: expiring })).toEqual(address);

  db.prepare("UPDATE link_payloads SET expires_at = ?").run(new Date(Date.now() - 1_000).toISOString());
  expect(await openScopeInvitationCredential(env, { link: expiring })).toBeNull();
  // Issuing is what clears them: no schedule, and nothing to remember.
  expect(rows()).toHaveLength(1);
  await issueScopeInvitationLink(env, address, null);
  expect(rows().map((row) => row.expires_at)).toEqual([null]);
});

it("names the field when a payload no longer matches the shape its prefix promises", async () => {
  const env = bindings();
  const store = sqliteD1(db);
  const kind = defineLinkPayload("inv", z.strictObject({
    workspaceId: z.string(), parentId: z.string(), invitationId: z.string(), token: z.number(),
  }));
  await expect(issueLinkPayload(store, kind, address as never))
    .rejects.toThrow("link_payload_invalid:inv:token:invalid_type");

  const token = await issueScopeInvitationLink(env, address, null);
  db.prepare("UPDATE link_payloads SET payload = ?").run(JSON.stringify({ ...address, token: 7 }));
  // The row exists, so this deployment wrote it: a deploy that stopped
  // honouring every link of this kind, not one more unreadable token.
  await expect(openScopeInvitationCredential(env, { link: token }))
    .rejects.toThrow("link_payload_drifted:inv:token:invalid_type");
});

it("passes an addressed credential through for links sent before tokens", async () => {
  expect(await openScopeInvitationCredential(bindings(), address)).toEqual(address);
});
