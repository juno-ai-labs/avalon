import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { sha256Hex } from "@rally/db";
import { defineLinkPayload, issueLinkPayload, openLinkPayload, purgeExpiredLinkPayloads } from "@rally/db/link-payloads";
import { diagnosticErrorCode } from "../src/observability/logger";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The store has no production kind today; scoped invitations, its first, no
 * longer carry a token. A kind of this test's own exercises it exactly as one
 * would, against the real migrations.
 */
const KIND = defineLinkPayload("tsk", z.strictObject({ workspaceId: z.string(), itemId: z.string() }));
const target = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", itemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };

let db: DatabaseSync;
const store = () => sqliteD1(db);
const issue = (expiresAt: number | null) => issueLinkPayload(store(), KIND, target,
  { expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() });
const rows = () => db.prepare("SELECT token_hash, type, payload, expires_at FROM link_payloads").all() as Array<Record<string, string | null>>;

beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close(); });

it("hands back a short token, and stores where it points without the token", async () => {
  const token = await issue(null);
  // Prefix, separator and 256 bits: the token is what guards the row.
  expect(token).toMatch(/^tsk_[A-Za-z0-9_-]{43}$/u);
  expect(await openLinkPayload(store(), KIND, token)).toEqual(target);
  const [row] = rows();
  expect(rows()).toHaveLength(1);
  expect(row).toMatchObject({ type: "tsk", expires_at: null, token_hash: await sha256Hex(token) });
  // A dump of this table is a list of what exists, not a set of working links.
  expect(JSON.stringify(row)).not.toContain(token.slice(4));
  expect(JSON.parse(String(row!.payload))).toEqual(target);
});

it("refuses a token this deployment never issued, or issued as something else", async () => {
  const token = await issue(null);
  expect(await openLinkPayload(store(), KIND, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
  expect(await openLinkPayload(store(), KIND, `tsk_${"A".repeat(43)}`)).toBeNull();

  // Another kind's token, and the same random half wearing this kind's prefix.
  const other = defineLinkPayload("oth", z.strictObject({ note: z.string() }));
  const foreign = await issueLinkPayload(store(), other, { note: "not this kind" });
  expect(await openLinkPayload(store(), KIND, foreign)).toBeNull();
  expect(await openLinkPayload(store(), KIND, `tsk_${foreign.slice(4)}`)).toBeNull();
  // The kind that issued it still reads it: refusal is about the prefix, not the row.
  expect(await openLinkPayload(store(), other, foreign)).toEqual({ note: "not this kind" });
});

it("dies at its deadline, and issuing sweeps the rows that have", async () => {
  const deadline = Date.now() + 600_000;
  const expiring = await issue(deadline);
  expect(rows()[0]).toMatchObject({ expires_at: new Date(deadline).toISOString() });
  expect(await openLinkPayload(store(), KIND, expiring)).toEqual(target);

  db.prepare("UPDATE link_payloads SET expires_at = ?").run(new Date(Date.now() - 1_000).toISOString());
  expect(await openLinkPayload(store(), KIND, expiring)).toBeNull();
  expect(rows()).toHaveLength(1);
  await issue(null);
  expect(rows().map((row) => row.expires_at)).toEqual([null]);
});

it("names the field when a payload no longer matches the shape its prefix promises", async () => {
  const mismatched = defineLinkPayload("tsk", z.strictObject({ workspaceId: z.string(), itemId: z.number() }));
  await expect(issueLinkPayload(store(), mismatched, target as never))
    .rejects.toThrow("link_payload_invalid:tsk:itemId:invalid_type");

  const token = await issue(null);
  db.prepare("UPDATE link_payloads SET payload = ?").run(JSON.stringify({ ...target, itemId: 7 }));
  // The row exists, so this deployment wrote it: a deploy that stopped
  // honouring every link of this kind, not one more unreadable token.
  await expect(openLinkPayload(store(), KIND, token))
    .rejects.toThrow("link_payload_drift_invalid:tsk:itemId:invalid_type");

  // A payload that is no longer JSON is the same kind of drift, and says so.
  db.prepare("UPDATE link_payloads SET payload = ?").run("{not json");
  const thrown = await openLinkPayload(store(), KIND, token).catch((error: unknown) => error);
  // And the code survives the boundary that reports it, rather than reaching
  // an operator as the caller's generic fallback.
  expect(diagnosticErrorCode(thrown, "internal_error")).toBe("link_payload_drift_invalid:tsk:-root-:invalid_json");
});

it("sweeps an expired row on the schedule, not only on the next write", async () => {
  await issue(Date.now() + 600_000);
  const kept = await issue(null);
  db.prepare("UPDATE link_payloads SET expires_at = ? WHERE expires_at IS NOT NULL")
    .run(new Date(Date.now() - 1_000).toISOString());
  await purgeExpiredLinkPayloads(store());
  expect(rows().map((row) => row.expires_at)).toEqual([null]);
  expect(await openLinkPayload(store(), KIND, kept)).toEqual(target);
});
