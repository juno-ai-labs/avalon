import { drainWaitUntil } from './helpers/cloudflare-workers';
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createApp } from "../src/app";
import { sealString, sha256 } from "../src/lib/crypto";
import { BrowserSessionSchema } from "../src/services/browser-session-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedObservabilityFixture, sqliteD1 } from "./helpers/sqlite-d1";

let db: DatabaseSync;
const origin = "https://app.example.test";
const apiOrigin = "https://api.example.test";
const webOrigin = "https://web.example.test";
const clientId = "browser-test-client";
const encryptionKey = "browser-test-encryption-key";
function bindings() {
  return createTestEnv({ DB:sqliteD1(db),APP_ENV:"development",RALLY_DEV_AUTH:"false",AVALON_REGION:"global",
    ALLOWED_ORIGINS:origin,PUBLIC_API_BASE_URL:apiOrigin,PUBLIC_WEB_BASE_URL:webOrigin,LOG_LEVEL:"error",
    DESKTOP_DEEP_LINK_URI:"rallywithai://auth/complete",
    SESSION_SIGNING_KEY:"browser-test-signing-key",OAUTH_STATE_ENCRYPTION_KEY:encryptionKey,
    BROWSER_APP_ORIGIN:origin,GOOGLE_OAUTH_CLIENT_ID:clientId,GOOGLE_OAUTH_CLIENT_SECRET:"browser-test-secret",
    IDENTITY_HANDOFF_RETURN_URIS:"https://relay.example.test/rally/callback" });
}
function desktop(path:string, body?:unknown) {
  return createApp().request(`${apiOrigin}/auth/${path}`,{ method:body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers:{ "content-type":"application/json" },body:JSON.stringify(body) }) },bindings());
}
/** The desktop handoff page carries its deep link in the fragment. */
function handoffTarget(location:string | null) {
  const handoff = new URL(location!);
  expect(`${handoff.origin}${handoff.pathname}`).toBe(`${webOrigin}/auth/desktop/`);
  return new URL(new URLSearchParams(handoff.hash.slice(1)).get("target")!);
}
const sessionCookieSet = (response:Response) =>
  response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-rally-browser-global="));
const bindingCleared = (response:Response, state:string) =>
  response.headers.getSetCookie().some((cookie) => cookie.startsWith(`__Host-rally-browser-global-google-${state}=;`));
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
beforeEach(() => { db = migratedObservabilityFixture(); });
afterEach(async () => { await drainWaitUntil(); db.close();vi.restoreAllMocks(); });

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
  expect(sessionCookieSet(forged)).toBe(false);
  // The binding is left alone: the tab that owns it may still be on its way back.
  expect(bindingCleared(forged,state)).toBe(false);
  expect(db.prepare("SELECT consumed_at FROM oauth_states WHERE id=?").get(state)).toEqual({ consumed_at:null });
});

it("sends a callback with no state back to the browser with a reason",async () => {
  const callback = await browser("google/callback?code=google-code");
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${origin}/#google_error=google_state_mismatch`);
});

it("will not complete a desktop sign-in on the browser callback",async () => {
  const exchanges = await googleIssuing({ sub:"google-subject-3",email:"desktop@example.test",email_verified:true });
  const state = "d".repeat(43);
  db.prepare(`INSERT INTO oauth_states (id,region,provider,purpose,code_verifier_encrypted,desktop_attempt_id,desktop_code_challenge,return_uri,expires_at)
    VALUES (?,'global','google','identity',?,?,?,'rallywithai://auth/complete',?)`)
    .run(state,await sealString("v".repeat(64),encryptionKey),"a".repeat(43),"c".repeat(43),new Date(Date.now()+60_000).toISOString());
  const callback = await browser(`google/callback?code=google-code&state=${state}`,{ cookie:`__Host-rally-browser-global-google-${state}=${state}` });
  expect(callback.headers.get("location")).toBe(`${origin}/#google_error=invalid_oauth_state`);
  expect(sessionCookieSet(callback)).toBe(false);
  expect(bindingCleared(callback,state)).toBe(true);
  expect(exchanges).toHaveLength(0);
  // The desktop sign-in it belongs to can still complete.
  expect(db.prepare("SELECT consumed_at FROM oauth_states WHERE id=?").get(state)).toEqual({ consumed_at:null });
});

it("will not let the desktop callback consume a browser sign-in",async () => {
  const { authorize } = await start("/app/first");
  const state = authorize.searchParams.get("state")!;
  const callback = await desktop(`google/callback?error=access_denied&state=${state}`);
  expect(handoffTarget(callback.headers.get("location")).searchParams.get("error")).toBe("invalid_oauth_state");
  expect(db.prepare("SELECT consumed_at FROM oauth_states WHERE id=?").get(state)).toEqual({ consumed_at:null });
});

it("completes a desktop sign-in through the shared Google exchange",async () => {
  const exchanges = await googleIssuing({ sub:"google-subject-6",email:"desktop6@example.test",email_verified:true });
  const started = await desktop("google/start",{ desktopAttemptId:"a".repeat(43),desktopCodeChallenge:"c".repeat(43) });
  expect(started.status).toBe(200);
  const authorize = new URL((await started.json() as { url:string }).url);
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${apiOrigin}/auth/google/callback`);
  const callback = await desktop(`google/callback?code=desktop-code&state=${authorize.searchParams.get("state")}`);
  expect(callback.status).toBe(302);
  expect(exchanges.map((exchange) => exchange.get("redirect_uri"))).toEqual([`${apiOrigin}/auth/google/callback`]);
  const target = handoffTarget(callback.headers.get("location"));
  expect(`${target.protocol}//${target.host}${target.pathname}`).toBe("rallywithai://auth/complete");
  expect(target.searchParams.get("attempt")).toBe("a".repeat(43));
  expect(target.searchParams.get("region")).toBe("global");
  const ticket = target.searchParams.get("ticket")!;
  expect(db.prepare(`SELECT u.email,t.workspace_id,t.region,t.desktop_attempt_id,t.desktop_code_challenge,t.consumed_at
    FROM desktop_login_tickets t JOIN users u ON u.id=t.user_id WHERE t.ticket_hash=?`).get(await sha256(ticket))).toEqual({
    email:"desktop6@example.test",workspace_id:null,region:"global",desktop_attempt_id:"a".repeat(43),
    desktop_code_challenge:"c".repeat(43),consumed_at:null });
});

it("refuses a replayed callback after the first one signed in",async () => {
  const exchanges = await googleIssuing({ sub:"google-subject-7",email:"replay@example.test",email_verified:true });
  const { authorize,binding } = await start("/app/first");
  const state = authorize.searchParams.get("state")!;
  const first = await browser(`google/callback?code=google-code&state=${state}`,{ cookie:binding });
  expect(first.headers.get("location")).toBe(`${origin}/app/first`);
  const replay = await browser(`google/callback?code=google-code&state=${state}`,{ cookie:binding });
  expect(replay.headers.get("location")).toBe(`${origin}/#google_error=invalid_oauth_state`);
  expect(sessionCookieSet(replay)).toBe(false);
  expect(exchanges).toHaveLength(1);
});

it("refuses an identity Google has not verified",async () => {
  await googleIssuing({ sub:"google-subject-8",email:"unverified@example.test",email_verified:false });
  const { authorize,binding } = await start();
  const callback = await browser(`google/callback?code=google-code&state=${authorize.searchParams.get("state")}`,{ cookie:binding });
  expect(callback.headers.get("location")).toBe(`${origin}/#google_error=google_identity_invalid`);
  expect(sessionCookieSet(callback)).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS users FROM users WHERE email=?").get("unverified@example.test")).toEqual({ users:0 });
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

it("names an ID token that does not verify",async () => {
  vi.spyOn(globalThis,"fetch").mockImplementation(async () => Response.json({ id_token:"not-a-jwt" }));
  const { authorize,binding } = await start();
  const callback = await browser(`google/callback?code=google-code&state=${authorize.searchParams.get("state")}`,{ cookie:binding });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${origin}/#google_error=google_id_token_invalid`);
});

it("returns a declined sign-in to the requested path with the reason",async () => {
  const { authorize,binding } = await start("/invite");
  const state = authorize.searchParams.get("state")!;
  const callback = await browser(`google/callback?error=access_denied&state=${state}`,{ cookie:binding });
  expect(callback.headers.get("location")).toBe(`${origin}/invite#google_error=google_oauth_denied`);
  expect(bindingCleared(callback,state)).toBe(true);
});

it("reads a provider error other than a refusal as a failure, not a denial",async () => {
  const { authorize,binding } = await start("/invite");
  const callback = await browser(`google/callback?error=server_error&state=${authorize.searchParams.get("state")}`,{ cookie:binding });
  expect(callback.headers.get("location")).toBe(`${origin}/invite#google_error=google_oauth_failed`);
});

it.each(["//evil.example.test/steal","/\\evil.example.test/x","/.//evil.example.test/x"])("refuses a return path that leaves the browser host (%s)",async (returnPath) => {
  const response = await browser("google/start",{ body:{ returnPath } });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error:{ code:"invalid_return_uri" } });
  expect(db.prepare("SELECT COUNT(*) AS states FROM oauth_states").get()).toEqual({ states:0 });
});

it('correlates browser Google proof and account creation without claiming completed organization setup', async () => {
  await googleIssuing({ sub:'new-google-signup',email:'signup@example.test',email_verified:true,name:'Signup' });
  const { authorize,binding } = await start();
  const state = authorize.searchParams.get('state')!;
  expect((await browser(`google/callback?code=google-code&state=${state}`, { cookie:binding })).status).toBe(302);
  await drainWaitUntil();
  const events = db.prepare('SELECT envelope_json FROM telemetry_accepted_events ORDER BY rowid').all()
    .map(row => JSON.parse(String(row.envelope_json)) as { name:string;properties:{ flowId:string;clientPlatform:string;entryPlatform:string };identityScope:string });
  // One request per stage, so these come in order, except the two one sign-in
  // emits together: each is written by its own deferred, awaiting accept, so
  // either may land first.
  const names = events.map(event => event.name);
  expect(names.slice(0, 3)).toEqual(['signup_started','signup_verification_requested','signup_verification_completed']);
  expect(names.slice(3).sort()).toEqual(['authentication_completed','signup_account_created']);
  expect(new Set(events.map(event => event.properties.flowId)).size).toBe(1);
  expect(events.find(event => event.name === 'signup_account_created')).toMatchObject({ identityScope:'anonymous-epoch',properties:{ clientPlatform:'browser',entryPlatform:'browser',accountStatus:'new' } });
});

it('tracks desktop signup through verified ticket exchange, excluding OAuth-only handoffs from authenticated counts', async () => {
  const verifier = 'v'.repeat(43);
  await googleIssuing({ sub:'desktop-signup',email:'desktop-signup@example.test',email_verified:true });
  const started = await desktop('google/start', { desktopAttemptId:'a'.repeat(43),desktopCodeChallenge:await sha256(verifier) });
  const authorize = new URL((await started.json() as { url:string }).url);
  const callback = await desktop(`google/callback?code=desktop-code&state=${authorize.searchParams.get('state')}`);
  const target = handoffTarget(callback.headers.get('location'));
  await drainWaitUntil();
  const names = () => db.prepare('SELECT envelope_json FROM telemetry_accepted_events ORDER BY rowid').all()
    .map(row => (JSON.parse(String(row.envelope_json)) as { name:string }).name);
  expect(names()).toEqual(['signup_started','signup_verification_requested','signup_verification_completed']);
  const response = await desktop('desktop/exchange', { ticket:target.searchParams.get('ticket'),region:'global',attemptId:'a'.repeat(43),codeVerifier:verifier });
  expect(response.status,await response.clone().text()).toBe(200);
  await drainWaitUntil();
  expect(names()).toEqual(['signup_started','signup_verification_requested','signup_verification_completed','authentication_completed','signup_account_created']);
});

it("hands a sign-in to an allowed service, which swaps the ticket once for the person's identity",async () => {
  const verifier = "h".repeat(43);
  await googleIssuing({ sub:"handoff-subject",email:"handoff@example.test",name:"Hana Off",email_verified:true });
  const started = await desktop("google/start",{ returnUri:"https://relay.example.test/rally/callback?state=relay-state",
    desktopAttemptId:"r".repeat(43),desktopCodeChallenge:await sha256(verifier) });
  expect(started.status,await started.clone().text()).toBe(200);
  const authorize = new URL((await started.json() as { url:string }).url);
  const callback = await desktop(`google/callback?code=handoff-code&state=${authorize.searchParams.get("state")}`);
  expect(callback.status).toBe(302);
  const target = new URL(callback.headers.get("location")!);
  expect(`${target.origin}${target.pathname}`).toBe("https://relay.example.test/rally/callback");
  expect(target.searchParams.get("state")).toBe("relay-state");
  expect(target.searchParams.get("attempt")).toBe("r".repeat(43));
  const redeem = { ticket:target.searchParams.get("ticket"),region:"global",attemptId:"r".repeat(43),codeVerifier:verifier };
  const exchanged = await desktop("identity/exchange",redeem);
  expect(exchanged.status,await exchanged.clone().text()).toBe(200);
  expect(await exchanged.json()).toEqual({ userId:expect.any(String),email:"handoff@example.test",name:"Hana Off",signupCreated:true });
  const replayed = await desktop("identity/exchange",redeem);
  expect(replayed.status).toBe(401);
  expect(await replayed.json()).toMatchObject({ error:{ code:"invalid_login_ticket" } });
});

it("refuses a handoff ticket redeemed without the starter's proof, and burns it",async () => {
  await googleIssuing({ sub:"handoff-proof",email:"proof@example.test",email_verified:true });
  const started = await desktop("google/start",{ returnUri:"https://relay.example.test/rally/callback",
    desktopAttemptId:"p".repeat(43),desktopCodeChallenge:await sha256("q".repeat(43)) });
  const authorize = new URL((await started.json() as { url:string }).url);
  const callback = await desktop(`google/callback?code=proof-code&state=${authorize.searchParams.get("state")}`);
  const ticket = new URL(callback.headers.get("location")!).searchParams.get("ticket");
  const wrong = await desktop("identity/exchange",{ ticket,region:"global",attemptId:"p".repeat(43),codeVerifier:"w".repeat(43) });
  expect(wrong.status).toBe(401);
  const right = await desktop("identity/exchange",{ ticket,region:"global",attemptId:"p".repeat(43),codeVerifier:"q".repeat(43) });
  expect(right.status).toBe(401);
});

it("will not send a sign-in to a web address that is not an allowed service",async () => {
  for (const returnUri of ["https://evil.example.test/rally/callback","https://relay.example.test/other","http://relay.example.test/rally/callback"]) {
    const started = await desktop("google/start",{ returnUri,desktopAttemptId:"e".repeat(43),desktopCodeChallenge:"c".repeat(43) });
    expect(started.status,returnUri).toBe(422);
    expect(await started.json()).toMatchObject({ error:{ code:"invalid_return_uri" } });
  }
});
