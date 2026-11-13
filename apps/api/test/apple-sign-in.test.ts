import { drainWaitUntil } from './helpers/cloudflare-workers';
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair, jwtVerify, decodeProtectedHeader } from "jose";
import { createApp } from "../src/app";
import { sha256 } from "../src/lib/crypto";
import { BrowserSessionSchema } from "../src/services/browser-session-service";
import { persistVerifiedGoogleIdentity } from "../src/services/login-identity-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedObservabilityFixture, sqliteD1 } from "./helpers/sqlite-d1";

let db: DatabaseSync;
const origin = "https://app.example.test";
const apiOrigin = "https://api.example.test";
const webOrigin = "https://web.example.test";
const clientId = "test.rally.signin";
const teamId = "TEAM123456";
const keyId = "KEY1234567";
// The deployment's own `.p8` key, which signs the client secret it sends Apple.
const clientKey = generateKeyPair("ES256", { extractable:true });
// Apple's ID-token key. One per file: the API caches Apple's key set across requests, as it should.
const appleSigning = generateKeyPair("RS256");

async function bindings(overrides: Record<string, string | undefined> = {}) {
  return createTestEnv({ DB:sqliteD1(db),APP_ENV:"development",RALLY_DEV_AUTH:"false",AVALON_REGION:"global",
    ALLOWED_ORIGINS:origin,PUBLIC_API_BASE_URL:apiOrigin,PUBLIC_WEB_BASE_URL:webOrigin,LOG_LEVEL:"error",
    DESKTOP_DEEP_LINK_URI:"rallywithai://auth/complete",
    SESSION_SIGNING_KEY:"apple-test-signing-key",OAUTH_STATE_ENCRYPTION_KEY:"apple-test-encryption-key",
    BROWSER_APP_ORIGIN:origin,GOOGLE_OAUTH_CLIENT_ID:"google-client",GOOGLE_OAUTH_CLIENT_SECRET:"google-secret",
    APPLE_OAUTH_CLIENT_ID:clientId,APPLE_OAUTH_TEAM_ID:teamId,APPLE_OAUTH_KEY_ID:keyId,
    // Stored the way a one-line secret form keeps it, with its newlines escaped.
    APPLE_OAUTH_PRIVATE_KEY:(await exportPKCS8((await clientKey).privateKey)).replace(/\n/gu, "\\n"),
    ...overrides });
}
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
/** Apple returns with a cross-site form POST. */
async function applePost(url: string, fields: Record<string, string>, cookie?: string) {
  return createApp().request(url,{ method:"POST",body:form(fields),headers:{ "content-type":"application/x-www-form-urlencoded",
    origin:"https://appleid.apple.com","sec-fetch-site":"cross-site",...(cookie ? { cookie } : {}) } },await bindings());
}
async function desktop(path: string, body: unknown) {
  return createApp().request(`${apiOrigin}/auth/${path}`,{ method:"POST",headers:{ "content-type":"application/json" },
    body:JSON.stringify(body) },await bindings());
}
async function browserStart(returnPath?: string) {
  const response = await createApp().request(`${apiOrigin}/browser/apple/start`,{ method:"POST",
    headers:{ origin,"content-type":"application/json" },body:JSON.stringify(returnPath === undefined ? {} : { returnPath }) },await bindings());
  expect(response.status).toBe(200);
  const { url } = await response.json() as { url: string };
  const setCookie = response.headers.get("set-cookie")!;
  return { authorize:new URL(url),binding:setCookie.split(";")[0]!,setCookie };
}
function handoffTarget(location: string | null) {
  const handoff = new URL(location!);
  expect(`${handoff.origin}${handoff.pathname}`).toBe(`${webOrigin}/auth/desktop/`);
  return new URL(new URLSearchParams(handoff.hash.slice(1)).get("target")!);
}

/**
 * Stands in for Apple, which cannot run here: its token endpoint and keys.
 * The ID token carries `nonce` from the authorization URL unless told otherwise.
 */
async function appleIssuing(claims: (authorize: URL) => Record<string, unknown>, authorize: URL) {
  const { publicKey,privateKey } = await appleSigning;
  const jwk = { ...await exportJWK(publicKey),kid:"apple-key",alg:"RS256",use:"sig" };
  const idToken = await new SignJWT({ nonce:authorize.searchParams.get("nonce"),...claims(authorize) })
    .setProtectedHeader({ alg:"RS256",kid:"apple-key" })
    .setIssuer("https://appleid.apple.com").setAudience(clientId).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const exchanges: URLSearchParams[] = [];
  vi.spyOn(globalThis,"fetch").mockImplementation(async (input,init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://appleid.apple.com/auth/token") {
      exchanges.push(new URLSearchParams(String(init?.body)));
      return Response.json({ id_token:idToken });
    }
    if (url.startsWith("https://appleid.apple.com/auth/keys")) return Response.json({ keys:[jwk] });
    throw new Error(`Unexpected request ${url}`);
  });
  return exchanges;
}

beforeEach(() => { db = migratedObservabilityFixture(); });
afterEach(async () => { await drainWaitUntil(); db.close(); vi.restoreAllMocks(); });

it("completes a desktop Apple sign-in and names Apple when the ticket is exchanged",async () => {
  const verifier = "v".repeat(43);
  const started = await desktop("apple/start",{ desktopAttemptId:"a".repeat(43),desktopCodeChallenge:await sha256(verifier) });
  expect(started.status).toBe(200);
  const authorize = new URL((await started.json() as { url: string }).url);
  expect(`${authorize.origin}${authorize.pathname}`).toBe("https://appleid.apple.com/auth/authorize");
  expect(authorize.searchParams.get("response_mode")).toBe("form_post");
  expect(authorize.searchParams.get("scope")).toBe("name email");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${apiOrigin}/auth/apple/callback`);
  const exchanges = await appleIssuing(() => ({ sub:"apple-subject-1",email:"person@example.test",email_verified:"true" }),authorize);

  const callback = await applePost(`${apiOrigin}/auth/apple/callback`,{ code:"apple-code",state:authorize.searchParams.get("state")!,
    user:JSON.stringify({ name:{ firstName:"Ada",lastName:"Lovelace" },email:"person@example.test" }) });
  expect(callback.status).toBe(303);
  const target = handoffTarget(callback.headers.get("location"));
  expect(`${target.protocol}//${target.host}${target.pathname}`).toBe("rallywithai://auth/complete");

  // The client secret is an ES256 token from this deployment's key, naming its team, key and Services ID.
  const secret = exchanges[0]!.get("client_secret")!;
  expect(decodeProtectedHeader(secret)).toMatchObject({ alg:"ES256",kid:keyId });
  await jwtVerify(secret,(await clientKey).publicKey,{ issuer:teamId,subject:clientId,audience:"https://appleid.apple.com" });
  expect(exchanges[0]!.get("redirect_uri")).toBe(`${apiOrigin}/auth/apple/callback`);

  const exchanged = await desktop("desktop/exchange",{ ticket:target.searchParams.get("ticket"),region:"global",attemptId:"a".repeat(43),codeVerifier:verifier });
  expect(exchanged.status,await exchanged.clone().text()).toBe(200);
  expect(await exchanged.json()).toMatchObject({ user:{ email:"person@example.test",name:"Ada Lovelace" },workspace:null });
  expect(db.prepare("SELECT provider,subject FROM user_login_identities ORDER BY provider").all())
    .toEqual([{ provider:"apple",subject:"apple-subject-1" }]);
  await drainWaitUntil();
  const completed = db.prepare("SELECT envelope_json FROM telemetry_accepted_events").all()
    .map((row) => JSON.parse(String(row.envelope_json)) as { name: string; properties: { method: string } })
    .find((event) => event.name === "authentication_completed");
  expect(completed?.properties.method).toBe("apple");
});

it("refuses an ID token issued for another sign-in's nonce, and creates no one",async () => {
  const started = await desktop("apple/start",{ desktopAttemptId:"b".repeat(43),desktopCodeChallenge:"c".repeat(43) });
  const authorize = new URL((await started.json() as { url: string }).url);
  await appleIssuing(() => ({ sub:"apple-subject-2",email:"other@example.test",email_verified:true,nonce:"someone-elses" }),authorize);
  const callback = await applePost(`${apiOrigin}/auth/apple/callback`,{ code:"apple-code",state:authorize.searchParams.get("state")! });
  expect(handoffTarget(callback.headers.get("location")).searchParams.get("error")).toBe("apple_nonce_mismatch");
  expect(db.prepare("SELECT COUNT(*) AS users FROM users").get()).toEqual({ users:0 });
});

it("signs a browser in from Apple's cross-site POST and returns to the requested path",async () => {
  const { authorize,binding,setCookie } = await browserStart("/app/workspaces/global/abc");
  const state = authorize.searchParams.get("state")!;
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/regional/global/browser/apple/callback`);
  expect(binding).toBe(`__Host-rally-browser-global-apple-${state}=${state}`);
  // A Lax cookie would not ride Apple's cross-site POST back.
  expect(setCookie).toContain("SameSite=None");
  await appleIssuing(() => ({ sub:"apple-subject-3",email:"browser@example.test",email_verified:true }),authorize);

  const callback = await applePost(`${apiOrigin}/browser/apple/callback`,{ code:"apple-code",state },binding);
  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe(`${origin}/app/workspaces/global/abc`);
  const session = callback.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-rally-browser-global="))!;
  const described = await createApp().request(`${apiOrigin}/browser/session`,{ headers:{ origin,cookie:session.split(";")[0]! } },await bindings());
  expect(BrowserSessionSchema.parse(await described.json())).toMatchObject({ user:{ email:"browser@example.test",name:"browser" } });
});

it("refuses a browser callback this browser did not start, without consuming the state",async () => {
  const { authorize } = await browserStart();
  const state = authorize.searchParams.get("state")!;
  const forged = await applePost(`${apiOrigin}/browser/apple/callback`,{ code:"attacker-code",state },`__Host-rally-browser-global-apple-${state}=other`);
  expect(forged.headers.get("location")).toBe(`${origin}/#apple_error=apple_state_mismatch`);
  expect(db.prepare("SELECT consumed_at FROM oauth_states WHERE id=?").get(state)).toEqual({ consumed_at:null });
});

it("will not finish a Google sign-in on Apple's callback",async () => {
  const started = await desktop("google/start",{ desktopAttemptId:"d".repeat(43),desktopCodeChallenge:"c".repeat(43) });
  const state = new URL((await started.json() as { url: string }).url).searchParams.get("state")!;
  const callback = await applePost(`${apiOrigin}/auth/apple/callback`,{ code:"apple-code",state });
  expect(handoffTarget(callback.headers.get("location")).searchParams.get("error")).toBe("invalid_oauth_state");
  // The Google sign-in it belongs to can still complete.
  expect(db.prepare("SELECT consumed_at FROM oauth_states WHERE id=?").get(state)).toEqual({ consumed_at:null });
});

it("returns a cancelled browser sign-in as a denial",async () => {
  const { authorize,binding } = await browserStart("/invite");
  const callback = await applePost(`${apiOrigin}/browser/apple/callback`,{ error:"user_cancelled_authorize",state:authorize.searchParams.get("state")! },binding);
  expect(callback.headers.get("location")).toBe(`${origin}/invite#apple_error=apple_oauth_denied`);
});

it("links Apple to the person who already holds that address verified",async () => {
  const google = await persistVerifiedGoogleIdentity(sqliteD1(db),{ subject:"google-1",email:"shared@example.test",name:"Shared",avatarUrl:null });
  const started = await desktop("apple/start",{ desktopAttemptId:"e".repeat(43),desktopCodeChallenge:"c".repeat(43) });
  const authorize = new URL((await started.json() as { url: string }).url);
  await appleIssuing(() => ({ sub:"apple-subject-4",email:"Shared@Example.test",email_verified:true }),authorize);
  await applePost(`${apiOrigin}/auth/apple/callback`,{ code:"apple-code",state:authorize.searchParams.get("state")! });
  expect(db.prepare("SELECT provider,user_id FROM user_login_identities ORDER BY provider").all())
    .toEqual([{ provider:"apple",user_id:google.id },{ provider:"google",user_id:google.id }]);
  expect(db.prepare("SELECT COUNT(*) AS users FROM users").get()).toEqual({ users:1 });
});

it("names Apple as unconfigured until all four values are set",async () => {
  const response = await createApp().request(`${apiOrigin}/auth/apple/start`,{ method:"POST",headers:{ "content-type":"application/json" },
    body:JSON.stringify({ desktopAttemptId:"f".repeat(43),desktopCodeChallenge:"c".repeat(43) }) },await bindings({ APPLE_OAUTH_KEY_ID:undefined }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error:{ code:"apple_oauth_not_configured" } });
});
