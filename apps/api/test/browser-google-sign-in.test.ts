import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createApp } from "../src/app";
import { BrowserSessionSchema } from "../src/services/browser-session-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

let db: DatabaseSync;
const origin = "https://app.example.test";
const apiOrigin = "https://api.example.test";
const clientId = "browser-test-client";
function bindings() {
  return createTestEnv({ DB:sqliteD1(db),APP_ENV:"development",RALLY_DEV_AUTH:"false",AVALON_REGION:"global",
    ALLOWED_ORIGINS:origin,PUBLIC_API_BASE_URL:apiOrigin,LOG_LEVEL:"error",
    SESSION_SIGNING_KEY:"browser-test-signing-key",OAUTH_STATE_ENCRYPTION_KEY:"browser-test-encryption-key",
    BROWSER_APP_ORIGIN:origin,GOOGLE_OAUTH_CLIENT_ID:clientId,GOOGLE_OAUTH_CLIENT_SECRET:"browser-test-secret" });
}
function browser(path:string, init:{ method?:string; cookie?:string; body?:unknown } = {}) {
  return createApp().request(`${apiOrigin}/browser/${path}`,{ method:init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers:{ origin,...(init.cookie ? { cookie:init.cookie } : {}),...(init.body === undefined ? {} : { "content-type":"application/json" }) },
    ...(init.body === undefined ? {} : { body:JSON.stringify(init.body) }) },bindings());
}
// One key for the file: the API caches Google's key set across requests, as it should.
const signing = generateKeyPair("RS256");
/** Stands in for Google, which cannot run here: its token endpoint and signing keys. */
async function googleIssuing(claims:Record<string,unknown>) {
  const { publicKey,privateKey } = await signing;
  const jwk = { ...await exportJWK(publicKey),kid:"test-key",alg:"RS256",use:"sig" };
  const idToken = await new SignJWT(claims).setProtectedHeader({ alg:"RS256",kid:"test-key" })
    .setIssuer("https://accounts.google.com").setAudience(clientId).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const exchanges:URLSearchParams[] = [];
  vi.spyOn(globalThis,"fetch").mockImplementation(async (input,init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://oauth2.googleapis.com/token") {
      exchanges.push(new URLSearchParams(String(init?.body)));
      return Response.json({ id_token:idToken });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return Response.json({ keys:[jwk] });
    throw new Error(`Unexpected request ${url}`);
  });
  return exchanges;
}
async function start(returnPath?:string) {
  const response = await browser("google/start",{ body:returnPath === undefined ? {} : { returnPath } });
  expect(response.status).toBe(200);
  const { url } = await response.json() as { url:string };
  const binding = response.headers.get("set-cookie")!.split(";")[0]!;
  return { authorize:new URL(url),binding };
}
beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close();vi.restoreAllMocks(); });

it("starts Google with a callback on the browser host and binds the state to this browser",async () => {
  const { authorize,binding } = await start("/app/workspaces/global/abc");
  expect(authorize.origin).toBe("https://accounts.google.com");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/regional/global/browser/google/callback`);
  const state = authorize.searchParams.get("state")!;
  expect(binding).toBe(`__Host-rally-browser-global-google-${state}=${state}`);
});

it("signs a browser in with Google, sets the session cookie and returns to the requested path",async () => {
  const exchanges = await googleIssuing({ sub:"google-subject-1",email:"member@example.test",email_verified:true,name:"Member" });
  const { authorize,binding } = await start("/app/workspaces/global/abc");
  const state = authorize.searchParams.get("state")!;
  const callback = await browser(`google/callback?code=google-code&state=${state}`,{ cookie:binding });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${origin}/app/workspaces/global/abc`);
  expect(exchanges[0]!.get("redirect_uri")).toBe(`${origin}/regional/global/browser/google/callback`);
  const cookies = callback.headers.getSetCookie();
  const session = cookies.find((cookie) => cookie.startsWith("__Host-rally-browser-global="))!;
  for (const attribute of ["HttpOnly","Secure","SameSite=Lax","Path=/"]) expect(session).toContain(attribute);
  expect(cookies.some((cookie) => cookie.startsWith(`__Host-rally-browser-global-google-${state}=;`))).toBe(true);
  const described = await browser("session",{ cookie:session.split(";")[0]! });
  expect(described.status).toBe(200);
  expect(BrowserSessionSchema.parse(await described.json())).toMatchObject({ user:{ email:"member@example.test" },workspace:null });
});

it("refuses a callback this browser did not start, without consuming the state",async () => {
  await googleIssuing({ sub:"google-subject-2",email:"victim@example.test",email_verified:true });
  const { authorize } = await start();
  const state = authorize.searchParams.get("state")!;
  const forged = await browser(`google/callback?code=attacker-code&state=${state}`,{ cookie:`__Host-rally-browser-global-google-${state}=other` });
  expect(forged.status).toBe(302);
  expect(forged.headers.get("location")).toBe(`${origin}/#google_error=google_state_mismatch`);
  expect(forged.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-rally-browser-global="))).toBe(false);
  expect(db.prepare("SELECT consumed_at FROM oauth_states WHERE id=?").get(state)).toEqual({ consumed_at:null });
});

it("will not complete a desktop sign-in on the browser callback",async () => {
  await googleIssuing({ sub:"google-subject-3",email:"desktop@example.test",email_verified:true });
  const state = "d".repeat(43);
  db.prepare(`INSERT INTO oauth_states (id,region,provider,purpose,code_verifier_encrypted,desktop_attempt_id,desktop_code_challenge,return_uri,expires_at)
    VALUES (?,'global','google','identity','sealed',?,?,'rallywithai://auth/complete',?)`)
    .run(state,"a".repeat(43),"c".repeat(43),new Date(Date.now()+60_000).toISOString());
  const callback = await browser(`google/callback?code=google-code&state=${state}`,{ cookie:`__Host-rally-browser-global-google-${state}=${state}` });
  expect(callback.headers.get("location")).toBe(`${origin}/#google_error=invalid_oauth_state`);
  expect(callback.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-rally-browser-global="))).toBe(false);
  // The desktop sign-in it belongs to can still complete.
  expect(db.prepare("SELECT consumed_at FROM oauth_states WHERE id=?").get(state)).toEqual({ consumed_at:null });
});

it("lets two tabs sign in at once without one clobbering the other's binding",async () => {
  await googleIssuing({ sub:"google-subject-5",email:"tabs@example.test",email_verified:true });
  const first = await start("/app/first");
  const second = await start("/app/second");
  const state = first.authorize.searchParams.get("state")!;
  const callback = await browser(`google/callback?code=google-code&state=${state}`,{ cookie:`${first.binding}; ${second.binding}` });
  expect(callback.headers.get("location")).toBe(`${origin}/app/first`);
  const cleared = callback.headers.getSetCookie().filter((cookie) => /^__Host-rally-browser-global-google-[^=]+=;/u.test(cookie));
  expect(cleared.map((cookie) => cookie.split("=")[0])).toEqual([`__Host-rally-browser-global-google-${state}`]);
});

it("sends a sign-in Google could not verify back with a generic reason",async () => {
  vi.spyOn(globalThis,"fetch").mockImplementation(async () => Response.json({ id_token:"not-a-jwt" }));
  const { authorize,binding } = await start();
  const callback = await browser(`google/callback?code=google-code&state=${authorize.searchParams.get("state")}`,{ cookie:binding });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${origin}/#google_error=google_sign_in_failed`);
});

it("returns a declined sign-in to the requested path with the reason",async () => {
  const { authorize,binding } = await start("/invite");
  const state = authorize.searchParams.get("state")!;
  const callback = await browser(`google/callback?error=access_denied&state=${state}`,{ cookie:binding });
  expect(callback.headers.get("location")).toBe(`${origin}/invite#google_error=google_oauth_denied`);
});

it("reads a provider error other than a refusal as a failure, not a denial",async () => {
  const { authorize,binding } = await start("/invite");
  const callback = await browser(`google/callback?error=server_error&state=${authorize.searchParams.get("state")}`,{ cookie:binding });
  expect(callback.headers.get("location")).toBe(`${origin}/invite#google_error=google_oauth_failed`);
});

it("keeps the return path on the browser host",async () => {
  const { authorize,binding } = await start("//evil.example.test/steal");
  await googleIssuing({ sub:"google-subject-4",email:"member4@example.test",email_verified:true });
  const callback = await browser(`google/callback?code=google-code&state=${authorize.searchParams.get("state")}`,{ cookie:binding });
  expect(callback.headers.get("location")).toBe(`${origin}/`);
});
