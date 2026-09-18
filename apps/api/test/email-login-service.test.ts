import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app";
import { AuthService, verifyAccessToken } from "../src/services/auth-service";
import { configuredEmailLoginPolicy, startEmailLogin, redeemEmailLogin, openEmailLoginSecret, deliverEmailLogin } from "../src/services/email-login-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

let db: DatabaseSync;
function bindings() {
  return createTestEnv({ DB:sqliteD1(db),APP_ENV:"development",RALLY_DEV_AUTH:"false",AVALON_REGION:"global",
    ALLOWED_ORIGINS:"https://app.example.test",PUBLIC_API_BASE_URL:"https://api.example.test",LOG_LEVEL:"error",
    SESSION_SIGNING_KEY:"email-login-test-signing-key",OAUTH_STATE_ENCRYPTION_KEY:"email-login-test-encryption-key",
    BROWSER_APP_ORIGIN:"https://app.example.test",RESEND_FROM_EMAIL:"Rally <login@example.test>",
    EMAIL_LOGIN_POLICY_JSON:JSON.stringify({ otpDigits:6,ttlSeconds:600,maxFailedAttempts:3 }) });
}
beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close();vi.restoreAllMocks(); });
async function challenge() {
  const env = bindings();
  const challengeId = crypto.randomUUID();
  const started = await startEmailLogin(env,{ challengeId,email:"Guest@Example.test" });
  const row = db.prepare("SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?").get(challengeId)!;
  const payload = await openEmailLoginSecret(env,challengeId,String(row.delivery_payload_encrypted)) as { text:string };
  const otp = /code is (\d+)\./u.exec(payload.text)![1]!;
  const link = /https:\/\/[^\s]+/u.exec(payload.text)![0];
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
  return { env,started,challengeId,otp,token,link };
}
const attempt = (challengeId:string,credential:string,method:"magic"|"otp" = "otp") =>
  ({ challengeId,redemptionId:crypto.randomUUID(),credential,method });

describe("passwordless email login", () => {
  it("keeps issuance idempotent and stores neither credential in plaintext", async () => {
    const { env,challengeId,started,otp,token } = await challenge();
    const before = db.prepare("SELECT * FROM email_login_challenges").get()!;
    expect(await startEmailLogin(env,{ challengeId,email:"guest@example.test" })).toEqual(started);
    expect(db.prepare("SELECT * FROM email_login_challenges").get()).toEqual(before);
    expect(JSON.stringify(before)).not.toContain(token);
    expect(before.otp_hash).not.toBe(otp);
    await expect(startEmailLogin(env,{ challengeId,email:"other@example.test" })).rejects.toMatchObject({ code:"email_login_request_conflict" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n:0 });
  });

  it("lets link and OTP race for exactly one identity session and resumes the winner", async () => {
    const { env,challengeId,otp,token } = await challenge();
    const requests = [attempt(challengeId,otp),attempt(challengeId,token,"magic")];
    const results = await Promise.allSettled(requests.map((request) => redeemEmailLogin(env,request)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const receipt = await redeemEmailLogin(env,requests[winner]!);
    // The proof is already consumed here, but no session was inserted yet.
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n:0 });
    const service = new AuthService(env);
    const [first,retry] = await Promise.all([service.resumeEmailLogin(receipt),service.resumeEmailLogin(receipt)]);
    expect(first.refreshToken).toBe(retry.refreshToken);
    expect(first.user.id).toBe(retry.user.id);
    expect(first.workspace).toBeNull();
    expect((await verifyAccessToken(env,first.accessToken)).sessionId).toBe((await verifyAccessToken(env,retry.accessToken)).sessionId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n:1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n:1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM workspace_members").get()).toEqual({ n:0 });
  });

  it("enforces stored expiry and attempt policy without accepting another proof type after consumption", async () => {
    const first = await challenge();
    for (let index=0;index<3;index++) await expect(redeemEmailLogin(first.env,attempt(first.challengeId,"wrong")))
      .rejects.toMatchObject({ code:"email_login_invalid" });
    await expect(redeemEmailLogin(first.env,attempt(first.challengeId,first.token,"magic"))).rejects.toMatchObject({ code:"email_login_invalid" });
    const second = await challenge();
    db.prepare("UPDATE email_login_challenges SET expires_at=0 WHERE id=?").run(second.challengeId);
    await expect(redeemEmailLogin(second.env,attempt(second.challengeId,second.otp))).rejects.toMatchObject({ code:"email_login_invalid" });
    const third = await challenge();
    await redeemEmailLogin(third.env,attempt(third.challengeId,third.otp));
    await expect(redeemEmailLogin(third.env,attempt(third.challengeId,third.token,"magic"))).rejects.toMatchObject({ code:"email_login_invalid" });
  });

  it("does not recreate a revoked or rotated session on redemption retry", async () => {
    const { env,challengeId,otp } = await challenge();
    const request = attempt(challengeId,otp);
    const receipt = await redeemEmailLogin(env,request);
    const service = new AuthService(env);
    const session = await service.resumeEmailLogin(receipt);
    await service.refresh(session.refreshToken);
    await expect(service.resumeEmailLogin(await redeemEmailLogin(env,request))).rejects.toMatchObject({ code:"email_login_session_unavailable" });
    db.exec("UPDATE sessions SET revoked_at='revoked'");
    await expect(service.resumeEmailLogin(receipt)).rejects.toMatchObject({ code:"email_login_session_unavailable" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n:1 });
  });

  it("does not consume proofs on scanner GETs and redeems by POST through the application router", async () => {
    const { env,challengeId,otp,token } = await challenge();
    const app = createApp();
    const request = attempt(challengeId,token,"magic");
    expect((await app.request(`/auth/email/redeem?${new URLSearchParams(request)}`,{},env)).status).toBe(405);
    expect(db.prepare("SELECT redeemed_at FROM email_login_challenges WHERE id=?").get(challengeId)).toEqual({ redeemed_at:null });
    const response = await app.request("/auth/email/redeem",{ method:"POST",headers:{ "content-type":"application/json" },
      body:JSON.stringify({ ...request,method:"otp",credential:otp }) },env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ workspace:null,user:{ email:"guest@example.test" } });
  });

  it("retries an uncertain email with the same provider key and payload", async () => {
    const { env,challengeId } = await challenge();
    const production = { ...env,APP_ENV:"production" as const,RESEND_API_KEY:"test-provider-key" };
    const sent: Array<{ key:string;body:string }> = [];
    vi.spyOn(globalThis,"fetch").mockImplementation(async (_url,init) => {
      sent.push({ key:new Headers(init?.headers).get("idempotency-key")!,body:String(init?.body) });
      if (sent.length === 1) throw new Error("response lost");
      return Response.json({ id:"accepted-email" });
    });
    await expect(deliverEmailLogin(production,challengeId)).rejects.toMatchObject({ code:"email_login_delivery_failed" });
    expect(db.prepare("SELECT delivery_sent_at FROM email_login_challenges WHERE id=?").get(challengeId)).toEqual({ delivery_sent_at:null });
    await deliverEmailLogin(production,challengeId);
    await deliverEmailLogin(production,challengeId);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(db.prepare("SELECT delivery_sent_at FROM email_login_challenges WHERE id=?").get(challengeId)?.delivery_sent_at).toEqual(expect.any(Number));
  });
});


it("keeps email login disabled without explicit policy and bounds both public transports", async () => {
  const env = bindings();
  delete env.EMAIL_LOGIN_POLICY_JSON;
  expect(() => configuredEmailLoginPolicy(env)).toThrow("Email sign-in is not configured");
  const app = createApp();
  for (const prefix of ["/auth", "/browser"]) {
    for (const endpoint of ["start", "redeem"]) {
      const response = await app.request(`${prefix}/email/${endpoint}`, { method: "POST",
        headers: { "Content-Type": "application/json", origin: "https://app.example.test" },
        body: JSON.stringify({ data: "x".repeat(4096) }),
      }, env);
      expect(response.status).toBe(413);
    }
  }
});
