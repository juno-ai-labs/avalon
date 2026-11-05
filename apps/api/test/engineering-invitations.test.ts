import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acceptEngineeringInvitation, listEngineeringInvitations } from "../src/services/engineering-creation";
import { drainWaitUntil } from "./helpers/cloudflare-workers";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const OWNER = "00000000-0000-7000-8000-00000000aa01";
const INVITEE = "00000000-0000-7000-8000-00000000aa02";
const ORG = "00000000-0000-7000-8000-00000000aa03";
const INVITATION = "00000000-0000-7000-8000-00000000aa04";
const OPERATION = "00000000-0000-7000-8000-00000000aa05";

let db: DatabaseSync;
const env = () => createTestEnv({ DB: sqliteD1(db), AVALON_REGION: "global", LOG_LEVEL: "error" });

beforeEach(() => {
  db = migratedSqliteDatabase();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  db.prepare(`INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
    VALUES (?, 'g-owner', 'owner@example.test', 'Olu Owner', ?, ?), (?, 'g-invitee', 'Ivy@Example.test', 'Ivy', ?, ?)`)
    .run(OWNER, now, now, INVITEE, now, now);
  db.prepare(`INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Acme', 'acme', 'global', ?, ?, ?)`).run(ORG, OWNER, now, now);
  db.prepare(`INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at) VALUES (?, ?, 'owner', 'active', ?)`)
    .run(ORG, OWNER, now);
  db.prepare(`INSERT INTO workspace_invitations(id, workspace_id, email, invited_by_user_id, token_hash, role, expires_at, created_at)
    VALUES (?, ?, 'ivy@example.test', ?, 'invite-hash', 'member', ?, ?)`).run(INVITATION, ORG, OWNER, later, now);
});
afterEach(async () => { await drainWaitUntil(); db.close(); });

it("lists the Organization invitations addressed to a user's email and accepts one as that user", async () => {
  expect(await listEngineeringInvitations(env(), { userId: INVITEE as never })).toEqual({
    region: "global",
    items: [{ invitationId: INVITATION, orgId: ORG, orgName: "Acme", invitedByName: "Olu Owner" }],
  });
  expect(await listEngineeringInvitations(env(), { userId: OWNER as never })).toEqual({ region: "global", items: [] });

  expect(await acceptEngineeringInvitation(env(), { operationId: OPERATION, userId: INVITEE as never, invitationId: INVITATION }))
    .toEqual({ region: "global", orgId: ORG });
  expect(db.prepare("SELECT role, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ORG, INVITEE))
    .toEqual({ role: "member", status: "active" });
  expect(await listEngineeringInvitations(env(), { userId: INVITEE as never })).toEqual({ region: "global", items: [] });
});

it("will not accept an invitation for someone it was not addressed to", async () => {
  await expect(acceptEngineeringInvitation(env(), { operationId: OPERATION, userId: OWNER as never, invitationId: INVITATION }))
    .rejects.toMatchObject({ code: "invitation_email_mismatch" });
  expect(db.prepare("SELECT 1 AS present FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ORG, INVITEE)).toBeUndefined();
});
