import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { z } from "zod";
import { codeShaped } from "@rally/contracts/zod-diagnostics";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import type { VerifiedLoginIdentity } from "./login-identity-service";

/**
 * Sign in with Apple, as a web OAuth client (a Services ID), for the desktop
 * and the browser alike. `docs/apple-login.md` owns the design.
 */
const APPLE_ISSUER = "https://appleid.apple.com";
const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
/**
 * The client secret is minted per exchange, so it only has to outlive one
 * token request. Apple accepts up to six months; a short life means a leaked
 * secret is useless almost at once, and minting one costs a signature.
 */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

export interface AppleCredentials {
  /** The Services ID, which Apple uses as the OAuth `client_id` and the ID token's audience. */
  clientId: string;
  teamId: string;
  keyId: string;
  /** The `.p8` key Apple issued, PKCS #8 PEM. */
  privateKey: string;
}

/** The four values, or null while any is unset: the deployment then refuses Apple sign-in by name. */
export function appleCredentials(env: Env): AppleCredentials | null {
  const clientId = env.APPLE_OAUTH_CLIENT_ID?.trim();
  const teamId = env.APPLE_OAUTH_TEAM_ID?.trim();
  const keyId = env.APPLE_OAUTH_KEY_ID?.trim();
  // A secret pasted from a one-line form arrives with its newlines escaped.
  const privateKey = env.APPLE_OAUTH_PRIVATE_KEY?.trim().replace(/\\n/gu, "\n");
  return clientId && teamId && keyId && privateKey ? { clientId, teamId, keyId, privateKey } : null;
}

/**
 * Apple's authorization URL. Asking for `name email` obliges `form_post`: the
 * callback is a cross-site POST, not a GET. Apple documents no PKCE, so the
 * ID token's `nonce` binds the exchange to the stored state instead.
 */
export function appleAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; nonce: string }): string {
  const authorize = new URL(`${APPLE_ISSUER}/auth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    response_mode: "form_post",
    scope: "name email",
    state: input.state,
    nonce: input.nonce,
  }).toString();
  return authorize.toString();
}

async function clientSecret(credentials: AppleCredentials): Promise<string> {
  let key: CryptoKey;
  try {
    key = await importPKCS8(credentials.privateKey, "ES256");
  } catch {
    throw new ApiError(503, "apple_oauth_key_invalid", "Apple authentication is not configured correctly");
  }
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: credentials.keyId })
    .setIssuer(credentials.teamId)
    .setSubject(credentials.clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
}

/**
 * The `user` field Apple posts with the first authorization only. It is the
 * one place Apple ever gives a name, and nothing verifies it, so it names a
 * new account and is never used to find one.
 */
const AppleUserSchema = z.object({
  name: z.object({ firstName: z.string().optional(), lastName: z.string().optional() }).optional(),
});

/**
 * Apple's `form_post` callback body. `user` arrives on the first
 * authorization only. Apple also posts an `id_token`, which is left
 * undeclared and so dropped: the token endpoint's own copy is the one verified.
 */
export const AppleCallbackFormSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().optional(),
  error: z.string().min(1).optional(),
  user: z.string().optional(),
});

function nameFromUserField(user: string | undefined): string | null {
  if (!user) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(user); } catch { return null; }
  const result = AppleUserSchema.safeParse(parsed);
  if (!result.success) return null;
  const name = [result.data.name?.firstName, result.data.name?.lastName].map((part) => part?.trim()).filter(Boolean).join(" ");
  return name || null;
}

/**
 * A relay address's local part is random letters, which reads worse as a name
 * than a plain placeholder does.
 */
function fallbackName(email: string): string {
  if (email.endsWith("@privaterelay.appleid.com")) return "Rally user";
  return email.split("@")[0] || "Rally user";
}

/**
 * Exchanges an authorization code and verifies the ID token Apple returns:
 * its signature, issuer, audience, the nonce this sign-in sent, and a verified
 * email. The token endpoint's own ID token is the one trusted; the copy Apple
 * also posts to the callback is ignored.
 */
export async function exchangeAppleIdentity(input: {
  credentials: AppleCredentials;
  code: string;
  redirectUri: string;
  expectedNonce: string;
  user?: string | undefined;
}): Promise<VerifiedLoginIdentity> {
  const tokenResponse = await fetch(`${APPLE_ISSUER}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.credentials.clientId,
      client_secret: await clientSecret(input.credentials),
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
  });
  if (!tokenResponse.ok) {
    // Apple answers an OAuth error code such as `invalid_grant` or
    // `invalid_client`; the log keeps it, the response does not.
    const body = await tokenResponse.json().catch(() => null) as { error?: unknown } | null;
    const reason = typeof body?.error === "string" ? body.error : `http_${tokenResponse.status}`;
    throw new ApiError(502, "apple_token_exchange_failed", "Apple did not complete sign-in", undefined, codeShaped(reason));
  }
  const tokens = (await tokenResponse.json()) as { id_token?: string };
  if (!tokens.id_token) throw new ApiError(502, "apple_identity_missing", "Apple did not return an identity token");
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(tokens.id_token, appleKeys, {
      audience: input.credentials.clientId,
      issuer: APPLE_ISSUER,
    }));
  } catch (error) {
    const cause = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
    throw new ApiError(401, "apple_id_token_invalid", "Apple's identity token could not be verified", undefined,
      cause === undefined ? undefined : codeShaped(cause));
  }
  if (claims.nonce !== input.expectedNonce) {
    throw new ApiError(401, "apple_nonce_mismatch", "Apple's identity token belongs to another sign-in");
  }
  // Apple has sent `email_verified` both as a boolean and as the string "true".
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (typeof claims.sub !== "string" || typeof claims.email !== "string" || !verified) {
    throw new ApiError(401, "apple_identity_invalid", "Apple identity information is incomplete");
  }
  return {
    subject: claims.sub,
    email: claims.email,
    name: nameFromUserField(input.user) ?? fallbackName(claims.email.toLowerCase()),
    avatarUrl: null,
  };
}
