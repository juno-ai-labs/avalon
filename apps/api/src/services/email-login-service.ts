import { describeZodIssues } from "@rally/contracts/zod-diagnostics";
import { logWarn } from "../observability/logger";
import { z } from "zod";
import { EmailLoginStartSchema, EmailLoginRedeemSchema, EmailLoginStartedSchema } from "@rally/contracts/browser-session";
export { EmailLoginStartSchema, EmailLoginRedeemSchema, EmailLoginStartedSchema } from "@rally/contracts/browser-session";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { decryptString, encryptString, hmacSha256, randomToken, timingSafeEqualText } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";
import { resolveVerifiedEmailIdentity } from "./login-identity-service";
import { sendResendEmail } from "./resend";

export const EmailLoginPolicySchema = z.strictObject({
  otpDigits: z.number().int().positive(),
  ttlSeconds: z.number().int().positive(),
  maxFailedAttempts: z.number().int().positive().nullable(),
});
export type EmailLoginPolicy = z.infer<typeof EmailLoginPolicySchema>;
const EncryptedSchema = z.strictObject({ ciphertext:z.string(),iv:z.string() });
const DeliverySchema = z.strictObject({ email:z.string().email(),from:z.string(),text:z.string(),subject:z.string() });
interface ChallengeRow {
  id:string; email:string; magic_hash:string; otp_hash:string; expires_at:number;
  max_failed_attempts:number|null; failed_attempts:number; redeemed_at:number|null;
  redemption_id:string|null; user_id:string|null; session_id:string|null;
  session_secret_encrypted:string|null;
}
const refused = () => new ApiError(401,"email_login_invalid","This sign-in link or code is invalid or expired");

/** Policy is a team decision, not an implicit authentication default. */
export function configuredEmailLoginPolicy(env: Env): EmailLoginPolicy {
  try {
    if (!env.RESEND_FROM_EMAIL?.trim() || !env.EMAIL_LOGIN_POLICY_JSON || !env.BROWSER_APP_ORIGIN || !env.SESSION_SIGNING_KEY || !env.OAUTH_STATE_ENCRYPTION_KEY) throw new Error("missing");
    const origin = new URL(env.BROWSER_APP_ORIGIN);
    if (origin.origin !== env.BROWSER_APP_ORIGIN || (origin.protocol !== "https:" && env.APP_ENV !== "development")) throw new Error("origin");
    return EmailLoginPolicySchema.parse(JSON.parse(env.EMAIL_LOGIN_POLICY_JSON));
  } catch (error) {
    logWarn(env, "email_login_configuration_invalid", {
      reason: error instanceof z.ZodError ? describeZodIssues(error)
        : error instanceof SyntaxError ? "EMAIL_LOGIN_POLICY_JSON:invalid_json" : "required_configuration_missing_or_invalid",
    });
    throw new ApiError(503,"email_login_unavailable","Email sign-in is not configured");
  }
}

function otpCode(digits: number): string {
  let code = "";
  while (code.length < digits) {
    // Rejection sampling avoids modulo bias. This batch size is allocation
    // granularity, not the entropy or attempt policy of the code.
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 250) code += String(byte % 10);
      if (code.length === digits) break;
    }
  }
  return code;
}
function digest(env: Env, id: string, method: "magic"|"otp", credential: string) {
  return hmacSha256(env.SESSION_SIGNING_KEY,JSON.stringify(["email-login",id,method,credential]));
}
async function seal(env: Env, id: string, value: unknown) {
  return JSON.stringify(await encryptString(JSON.stringify(value),env.OAUTH_STATE_ENCRYPTION_KEY,`email-login:${id}`));
}
export async function openEmailLoginSecret(env: Env, id: string, value: string): Promise<unknown> {
  const sealed = EncryptedSchema.parse(JSON.parse(value));
  return JSON.parse(await decryptString(sealed.ciphertext,sealed.iv,env.OAUTH_STATE_ENCRYPTION_KEY,`email-login:${id}`));
}

export async function startEmailLogin(env: Env, input: z.infer<typeof EmailLoginStartSchema>) {
  const request = EmailLoginStartSchema.parse(input);
  const policy = configuredEmailLoginPolicy(env);
  const token = randomToken();
  const code = otpCode(policy.otpDigits);
  const url = new URL("/login/email",env.BROWSER_APP_ORIGIN);
  // Fragments do not reach the HTTP server, proxy logs or scanner GETs.
  url.hash = new URLSearchParams({ region:env.AVALON_REGION,challenge:request.challengeId,token }).toString();
  const now = Date.now();
  const expiresAt = now + policy.ttlSeconds * 1000;
  const payload = DeliverySchema.parse({ email:request.email,from:env.RESEND_FROM_EMAIL!.trim(),subject:"Sign in to Rally",
    text:`Your Rally sign-in code is ${code}.\n\nOr open this link and confirm sign-in:\n${url}\n\nThis link and code can be used for one sign-in. If you did not request this email, you can ignore it.` });
  const [magicHash,otpHash,encrypted] = await Promise.all([
    digest(env,request.challengeId,"magic",token),digest(env,request.challengeId,"otp",code),seal(env,request.challengeId,payload),
  ]);
  // The encrypted email is the durable delivery intent. Retrying issuance with
  // the same challenge ID preserves its credentials and provider request body.
  await env.DB.prepare(`INSERT INTO email_login_challenges
    (id,email,magic_hash,otp_hash,expires_at,max_failed_attempts,delivery_payload_encrypted,created_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(request.challengeId,request.email,magicHash,otpHash,expiresAt,policy.maxFailedAttempts,encrypted,now).run();
  const row = await env.DB.prepare("SELECT email,expires_at FROM email_login_challenges WHERE id=?")
    .bind(request.challengeId).first<{ email:string;expires_at:number }>();
  if (!row || row.email !== request.email) throw new ApiError(409,"email_login_request_conflict","Start a new sign-in request");
  return EmailLoginStartedSchema.parse({ challengeId:request.challengeId,expiresAt:row.expires_at });
}

/** No GET calls this function. Both proof types consume the same challenge. */
export async function redeemEmailLogin(env: Env, input: z.infer<typeof EmailLoginRedeemSchema>) {
  configuredEmailLoginPolicy(env);
  const request = EmailLoginRedeemSchema.parse(input);
  const row = await env.DB.prepare("SELECT * FROM email_login_challenges WHERE id=?").bind(request.challengeId).first<ChallengeRow>();
  if (!row) throw refused();
  const proof = await digest(env,row.id,request.method,request.credential);
  const expected = request.method === "magic" ? row.magic_hash : row.otp_hash;
  if (!timingSafeEqualText(proof,expected)) {
    await env.DB.prepare(`UPDATE email_login_challenges SET failed_attempts=failed_attempts+1
      WHERE id=? AND redeemed_at IS NULL AND expires_at>?
        AND (max_failed_attempts IS NULL OR failed_attempts<max_failed_attempts)`)
      .bind(row.id,Date.now()).run();
    throw refused();
  }
  if (row.redeemed_at !== null) {
    if (row.redemption_id !== request.redemptionId) throw refused();
    return { challengeId:row.id,redemptionId:request.redemptionId };
  }
  if (row.expires_at <= Date.now() || (row.max_failed_attempts !== null && row.failed_attempts >= row.max_failed_attempts)) throw refused();
  const userId = await resolveVerifiedEmailIdentity(env.DB,row.email);
  const sessionId = uuidV7();
  const encrypted = await seal(env,row.id,{ refreshToken:randomToken(48) });
  // Persist the winning identity and session credentials with proof consumption.
  // A crash before session insertion resumes this same session, never a second.
  const won = await env.DB.prepare(`UPDATE email_login_challenges
    SET redeemed_at=?,redemption_id=?,user_id=?,session_id=?,session_secret_encrypted=?
    WHERE id=? AND redeemed_at IS NULL AND expires_at>?
      AND (max_failed_attempts IS NULL OR failed_attempts<max_failed_attempts)
    RETURNING id`).bind(Date.now(),request.redemptionId,userId,sessionId,encrypted,row.id,Date.now()).first();
  if (!won) {
    const current = await env.DB.prepare("SELECT redemption_id FROM email_login_challenges WHERE id=?").bind(row.id).first<{ redemption_id:string|null }>();
    if (current?.redemption_id !== request.redemptionId) throw refused();
  }
  return { challengeId:row.id,redemptionId:request.redemptionId };
}

export async function deliverEmailLogin(env: Env, challengeId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT delivery_payload_encrypted FROM email_login_challenges
    WHERE id=? AND delivery_sent_at IS NULL AND redeemed_at IS NULL AND expires_at>?`)
    .bind(challengeId,Date.now()).first<{ delivery_payload_encrypted:string }>();
  if (!row) return;
  const payload = DeliverySchema.parse(await openEmailLoginSecret(env,challengeId,row.delivery_payload_encrypted));
  const outcome = await sendResendEmail(env,{ recipientEmail:payload.email,from:payload.from,text:payload.text,subject:payload.subject,
    sender:"transactional",idempotencyKey:`email-login:${challengeId}`,category:"email-login",region:env.AVALON_REGION,
    errors:{ unavailable:{ code:"email_login_delivery_unavailable",message:"Sign-in email delivery is unavailable" },
      failed:{ code:"email_login_delivery_failed",message:"Sign-in email delivery failed" } } });
  if (outcome === "sent") await env.DB.prepare("UPDATE email_login_challenges SET delivery_sent_at=? WHERE id=?")
    .bind(Date.now(),challengeId).run();
}

export async function recoverEmailLoginDeliveries(env: Env): Promise<void> {
  if (!env.EMAIL_LOGIN_POLICY_JSON) return;
  const rows = await env.DB.prepare(`SELECT id FROM email_login_challenges
    WHERE delivery_sent_at IS NULL AND redeemed_at IS NULL AND expires_at>? ORDER BY created_at,id`)
    .bind(Date.now()).all<{ id:string }>();
  for (const row of rows.results) {
    try { await deliverEmailLogin(env,row.id); }
    catch { logWarn(env,"email_login_delivery_pending",{ challenge_id:row.id }); }
  }
}
