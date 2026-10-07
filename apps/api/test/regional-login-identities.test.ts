import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { RegionalOnboardingService, type PlatformIdentity } from "../src/services/platform-onboarding-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// A deployment links a person by whichever sign-in methods Global verified,
// whatever their provider; these run against the checked-in migrations.
let db: DatabaseSync;
const at = "2026-10-06T00:00:00.000Z";
const service = () => new RegionalOnboardingService(createTestEnv({ DB:sqliteD1(db),AVALON_REGION:"enterprise",LOG_LEVEL:"error" }));
const identity = (platformUserId: string, loginIdentities: PlatformIdentity["loginIdentities"], email = "person@example.test"): PlatformIdentity => ({
  platformUserId,loginIdentities,email,name:"Person",avatarUrl:null,timezone:"UTC",createdAt:at,
});
const identities = (userId: string) => db.prepare("SELECT provider,subject FROM user_login_identities WHERE user_id=? ORDER BY provider")
  .all(userId).map((row) => ({ ...row }));
beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close(); });

it("records every sign-in method of a person new to the deployment, Google or not",async () => {
  const platformUserId = crypto.randomUUID();
  await service().discover(identity(platformUserId,[{ provider:"email",subject:"person@example.test" },{ provider:"apple",subject:"apple-1" }]));
  const user = db.prepare("SELECT id,google_subject FROM users WHERE platform_user_id=?").get(platformUserId) as { id:string; google_subject:string | null };
  expect(user.google_subject).toBeNull();
  expect(identities(user.id)).toEqual([{ provider:"apple",subject:"apple-1" },{ provider:"email",subject:"person@example.test" }]);
});

it("links an existing regional user through a provider other than Google",async () => {
  const existing = crypto.randomUUID();
  db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES (?,'person@example.test','Person',?,?)").run(existing,at,at);
  db.prepare("INSERT INTO user_login_identities(provider,subject,user_id,verified_at) VALUES ('github','gh-1',?,?)").run(existing,at);
  const platformUserId = crypto.randomUUID();
  await service().discover(identity(platformUserId,[{ provider:"github",subject:"gh-1" }]));
  expect(db.prepare("SELECT platform_user_id FROM users WHERE id=?").get(existing)).toEqual({ platform_user_id:platformUserId });
  expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n:1 });
});

it("refuses an account whose sign-in methods belong to two different regional users",async () => {
  for (const [provider,subject,email] of [["github","gh-1","one@example.test"],["apple","apple-1","two@example.test"]] as const) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES (?,?,'Person',?,?)").run(id,email,at,at);
    db.prepare("INSERT INTO user_login_identities(provider,subject,user_id,verified_at) VALUES (?,?,?,?)").run(provider,subject,id,at);
  }
  await expect(service().discover(identity(crypto.randomUUID(),[{ provider:"github",subject:"gh-1" },{ provider:"apple",subject:"apple-1" }])))
    .rejects.toMatchObject({ status:409,code:"regional_identity_conflict" });
});

it("drops an email address Global no longer sends, so its next owner can link here",async () => {
  const first = crypto.randomUUID();
  await service().discover(identity(first,[{ provider:"google",subject:"g-1" },{ provider:"email",subject:"old@example.test" }],"old@example.test"));
  await service().discover(identity(first,[{ provider:"google",subject:"g-1" },{ provider:"email",subject:"new@example.test" }],"new@example.test"));
  const user = db.prepare("SELECT id FROM users WHERE platform_user_id=?").get(first) as { id:string };
  expect(identities(user.id)).toEqual([{ provider:"email",subject:"new@example.test" },{ provider:"google",subject:"g-1" }]);
  const next = crypto.randomUUID();
  await service().discover(identity(next,[{ provider:"email",subject:"old@example.test" }],"old@example.test"));
  expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE platform_user_id=?").get(next)).toEqual({ n:1 });
});

it("refuses a returning user's profile whose verified email another regional user holds, by name",async () => {
  const platformUserId = crypto.randomUUID();
  await service().discover(identity(platformUserId,[{ provider:"google",subject:"google-returning" }],"first@example.test"));
  db.prepare("INSERT INTO users(id,email,name,created_at,updated_at) VALUES (?,'taken@example.test','Other',?,?)").run(crypto.randomUUID(),at,at);

  await expect(service().discover(identity(platformUserId,[{ provider:"google",subject:"google-returning" }],"taken@example.test")))
    .rejects.toMatchObject({ status:409, code:"regional_identity_conflict" });
});
