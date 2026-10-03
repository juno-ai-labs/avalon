import { authBodyLimit } from "../middleware/auth-body-limit";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { WorkspaceIdSchema } from "@rally/contracts";
import { ScopeInvitationLinkCredentialSchema, ScopeInvitationPreviewSchema } from "@rally/contracts/scope-grants";
import { RALLY_HEADERS, rallyHeaderAliases } from "@rally/contracts/http-headers";
import type { Env, HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { logEvent } from "../observability/logger";
import { codeShaped } from "@rally/contracts/zod-diagnostics";
import { zValidator } from "../middleware/validation";
import { AuthService, issueAccessToken } from "../services/auth-service";
import { PlatformOnboardingService } from "../services/platform-onboarding-service";
import { IDENTITY_REGION, configuredRegions, type Region } from "@rally/contracts/regions";
import { BrowserSessionService, BrowserSessionSchema, BrowserWorkspacesSchema } from "../services/browser-session-service";
import { BrowserGoogleStartSchema, BrowserGoogleStartedSchema, BrowserWorkspaceActivateSchema } from "@rally/contracts/browser-session";
import { UNAVAILABLE_INVITATION, describeScopeInvitation } from "../services/scope-invitation-link";
import { startEmailLogin, deliverEmailLogin, redeemEmailLogin, EmailLoginStartSchema,
  EmailLoginRedeemSchema, EmailLoginStartedSchema } from "../services/email-login-service";

function browserOrigin(env: Env): URL {
  let origin: URL;
  try { origin = new URL(env.BROWSER_APP_ORIGIN ?? ""); }
  catch { throw new ApiError(503,"browser_configuration_required","Browser access is not configured"); }
  if (origin.origin !== env.BROWSER_APP_ORIGIN ||
    !(origin.protocol === "https:" || (env.APP_ENV === "development" && origin.protocol === "http:"))) {
    throw new ApiError(503,"browser_configuration_required","Browser access is not configured");
  }
  return origin;
}

/** One cookie per deployment; Global also writes another deployment's after activating there. */
function cookieOptions(env: Env, region: Region = env.AVALON_REGION) {
  const secure = browserOrigin(env).protocol === "https:";
  return { name:`${secure ? "__Host-" : ""}rally-browser-${region}`,
    attributes:{ secure,httpOnly:true,sameSite:"Lax" as const,path:"/" } };
}

/**
 * Binds a Google sign-in to the tab that started it. The OAuth state is also
 * stored server-side; the callback requires this cookie to carry the same
 * value, so a link to someone else's callback cannot sign this browser in as
 * them.
 */
function googleStateCookie(env: Env, state: string) {
  const cookie = cookieOptions(env);
  // One cookie per state, so two tabs signing in at once do not overwrite each
  // other. The state is base64url, which a cookie name may carry.
  return { name:`${cookie.name}-google-${state}`,attributes:{ ...cookie.attributes,maxAge:600 } };
}

function credential(c: Context<HonoAppEnv>): string {
  const value = getCookie(c,cookieOptions(c.env).name);
  if (!value) throw new ApiError(401,"browser_session_required","Sign in to continue");
  return value;
}

function writeCookie(c: Context<HonoAppEnv>, value: string, expiresAt: string) {
  const cookie = cookieOptions(c.env);
  setCookie(c,cookie.name,value,{ ...cookie.attributes,expires:new Date(expiresAt) });
}

/**
 * The business route families a browser cookie may reach. The member shell
 * needs the Space directory, account onboarding, Suggested Work, digests, push
 * devices and workspace membership as well as what guests use; `auth`,
 * `internal`, `ingest`, `access`, `slack`, `sideline` and `dev` stay outside.
 * Only `onboarding/account` crosses: the other onboarding steps answer with a
 * bearer session, which browser JavaScript must never hold.
 */
const BROWSER_ROUTE_FAMILIES = /^\/(conversations|sharing|resources|feature-flags|telemetry|workspace|workspaces|workstreams|spaces|projects|onboarding\/account|work-opportunities|digest|push-devices|sidekicks|automations|connections|favicons|search|speech|realtime)(\/|$)/u;

/** Same-origin cookie transport over the existing regional business API. */
export function createBrowserRoutes(dispatch: (request:Request, context:Context<HonoAppEnv>) => Response | Promise<Response>) {
  const routes = new Hono<HonoAppEnv>();
  routes.use("*",async (c,next) => {
    const origin = browserOrigin(c.env).origin;
    c.header("Cache-Control","no-store");
    if (!["GET","HEAD","OPTIONS"].includes(c.req.method) &&
      (c.req.header("origin") !== origin || c.req.header("sec-fetch-site") === "cross-site")) {
      throw new ApiError(403,"browser_origin_required","Reload Rally before trying again");
    }
    await next();
    c.header("Cache-Control","no-store");
  });
  routes.post("/email/start",authBodyLimit,zValidator("json",EmailLoginStartSchema),async (c) => {
    const started = await startEmailLogin(c.env,c.req.valid("json"));
    await deliverEmailLogin(c.env,started.challengeId);
    return c.json(EmailLoginStartedSchema.parse(started),202);
  });
  routes.post("/google/start",authBodyLimit,zValidator("json",BrowserGoogleStartSchema),async (c) => {
    const { url,state } = await new AuthService(c.env).beginBrowserIdentity({ returnPath:c.req.valid("json").returnPath });
    const binding = googleStateCookie(c.env,state);
    setCookie(c,binding.name,state,binding.attributes);
    return c.json(BrowserGoogleStartedSchema.parse({ url }));
  });
  routes.get("/google/callback",zValidator("query",z.object({ code:z.string().optional(),state:z.string().min(1),error:z.string().optional() })),async (c) => {
    const query = c.req.valid("query");
    const origin = browserOrigin(c.env).origin;
    const failed = (code: string) => c.redirect(`${origin}/#google_error=${encodeURIComponent(code)}`,302);
    if (!/^[A-Za-z0-9_-]+$/u.test(query.state)) return failed("google_state_mismatch");
    const binding = googleStateCookie(c.env,query.state);
    const bound = getCookie(c,binding.name);
    if (!bound || bound !== query.state) return failed("google_state_mismatch");
    deleteCookie(c,binding.name,binding.attributes);
    const service = new AuthService(c.env);
    try {
      if (query.error || !query.code) {
        const returnUrl = await service.consumeBrowserIdentityDenial(query.state);
        // Only a person declining is a denial; anything else Google reports is
        // its own failure, named so the two read apart.
        const code = query.error === "access_denied" ? "google_oauth_denied" : "google_oauth_failed";
        if (code !== "google_oauth_denied") logEvent(c,"warn","browser_google_sign_in_failed",{ code,providerError:codeShaped(query.error ?? "missing_code") });
        return c.redirect(`${returnUrl}#google_error=${code}`,302);
      }
      const { session,returnUrl } = await service.consumeBrowserIdentityCallback(query.code,query.state);
      const cookie = await new BrowserSessionService(c.env).register(session);
      writeCookie(c,cookie.credential,cookie.expiresAt);
      return c.redirect(returnUrl,302);
    } catch (error) {
      if (error instanceof ApiError) {
        logEvent(c,"warn","browser_google_sign_in_failed",{ code:error.code });
        return failed(error.code);
      }
      // A token exchange or ID token check that threw: name it in the log and
      // send the person back to a page that says sign-in failed.
      const code: unknown = error instanceof Error && "code" in error ? error.code : undefined;
      const cause = typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
      logEvent(c,"error","browser_google_sign_in_failed",{ code:"google_sign_in_failed",cause:codeShaped(cause) });
      return failed("google_sign_in_failed");
    }
  });
  routes.get("/email/redeem",(c) => { c.header("Allow","POST");return c.body(null,405); });
  routes.post("/email/redeem",authBodyLimit,zValidator("json",EmailLoginRedeemSchema),async (c) => {
    const receipt = await redeemEmailLogin(c.env,c.req.valid("json"));
    const session = await new AuthService(c.env).resumeEmailLogin(receipt);
    const service = new BrowserSessionService(c.env);
    const cookie = await service.register(session);
    writeCookie(c,cookie.credential,cookie.expiresAt);
    return c.json(BrowserSessionSchema.parse(cookie.session));
  });
  // Before any session exists: an invitation link no longer says who it was
  // addressed to, and the sign-in form below it has to. Holding the link is the
  // whole of the authority, exactly as it is for accepting with it, and what it
  // releases is one mailbox — never the workspace or work stream behind it.
  //
  // The opaque token only, though acceptance still takes the addressed body. On
  // that branch nothing is looked up: the caller's own identifiers reach a
  // Durable Object stub, which would let anyone with no session at all
  // instantiate one per workspace and parent id they can name, and turn a
  // missing work stream into a 500 where every other answer here is one 403.
  // Links minted in the addressed format never carried a mailbox to fill in,
  // so refusing them here regresses nothing.
  routes.post("/invitation",authBodyLimit,zValidator("json",ScopeInvitationLinkCredentialSchema),async (c) => {
    const description = await describeScopeInvitation(c.env,c.req.valid("json"));
    if (!description) throw new ApiError(403,"scope_invitation_unavailable",UNAVAILABLE_INVITATION);
    return c.json(ScopeInvitationPreviewSchema.parse(description));
  });
  routes.get("/session",async (c) => {
    const service = new BrowserSessionService(c.env);
    return c.json(BrowserSessionSchema.parse(await service.describe(await service.read(credential(c)))));
  });
  routes.post("/session/renew",async (c) => {
    const value = credential(c);
    const session = await new BrowserSessionService(c.env).renew(value);
    writeCookie(c,value,session.expiresAt);
    return c.json(BrowserSessionSchema.parse(session));
  });
  routes.post("/logout",async (c) => {
    const cookie = cookieOptions(c.env);
    const value = getCookie(c,cookie.name);
    if (value) await new BrowserSessionService(c.env).logout(value);
    deleteCookie(c,cookie.name,cookie.attributes);
    return c.body(null,204);
  });
  routes.get("/workspaces",async (c) => {
    const auth = await new BrowserSessionService(c.env).read(credential(c));
    const local = await new AuthService(c.env).listRegionalWorkspaces(auth.userId);
    // Global holds the identity, so it also lists memberships in every other
    // deployment, as desktop onboarding does. With one deployment there is
    // nothing to discover and the list stays a single local read.
    if (c.env.AVALON_REGION !== IDENTITY_REGION || configuredRegions.length < 2) return c.json(BrowserWorkspacesSchema.parse({ workspaces:local }));
    // Each other deployment answers on its own; one that is down is logged by
    // name and does not hide the rest.
    const remote = await new PlatformOnboardingService(c.env,auth).otherDeploymentWorkspaces();
    if (remote.failed.length > 0) logEvent(c,"warn","browser_workspace_discovery_failed",{ failed:remote.failed.map((item) => `${item.region}:${item.code}`).join(",") });
    return c.json(BrowserWorkspacesSchema.parse({ workspaces:[...local,...remote.workspaces] }));
  });
  /**
   * Opens a workspace in another deployment for this browser. Global admits it
   * through discovery, the target registers its own browser session over the
   * identity bridge, and only its cookie comes back, on the browser host.
   * See the full browser client PRD's design.md.
   */
  routes.post("/workspace/activate",zValidator("json",BrowserWorkspaceActivateSchema),async (c) => {
    const { region,workspaceId } = c.req.valid("json");
    if (c.env.AVALON_REGION !== IDENTITY_REGION) throw new ApiError(409,"global_identity_required","Open this organization through Rally's identity deployment");
    if (region === c.env.AVALON_REGION) throw new ApiError(400,"browser_workspace_local","Select a workspace in this deployment directly");
    const auth = await new BrowserSessionService(c.env).read(credential(c));
    const registration = await new PlatformOnboardingService(c.env,auth).activateBrowser(region,workspaceId);
    const target = cookieOptions(c.env,region);
    setCookie(c,target.name,registration.credential,{ ...target.attributes,expires:new Date(registration.expiresAt) });
    return c.body(null,204);
  });
  routes.post("/workspace/select",zValidator("json",z.strictObject({ workspaceId:WorkspaceIdSchema })),async (c) =>
    c.json(BrowserSessionSchema.parse(await new BrowserSessionService(c.env).select(credential(c),c.req.valid("json").workspaceId))));

  routes.all("/api/:workspaceId/*",async (c) => {
    const workspace = c.req.param("workspaceId");
    const workspaceId = workspace === "_" ? undefined : WorkspaceIdSchema.parse(workspace);
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/browser\/api\/[^/]+/u,"");
    // Keep auth/token minting, ingress and internal routes outside this adapter.
    // Business routes retain their ordinary role and scope authorization; the
    // browser's guest and member shells describe the UI, not an additional
    // permission system.
    if (!BROWSER_ROUTE_FAMILIES.test(url.pathname)) {
      throw new ApiError(404,"not_found","This browser operation is unavailable");
    }
    if (c.req.header("upgrade")) throw new ApiError(400,"browser_socket_route_required","Use the socket ticket endpoint");
    const auth = await new BrowserSessionService(c.env).resolve(credential(c),workspaceId);
    const headers = new Headers(c.req.raw.headers);
    headers.delete("cookie");
    for (const key of [RALLY_HEADERS.DEV_USER_ID,RALLY_HEADERS.DEV_WORKSPACE_ID]) {
      for (const name of rallyHeaderAliases(key)) headers.delete(name);
    }
    headers.set("authorization",`Bearer ${await issueAccessToken(c.env,auth)}`);
    const forwarded = new Request(url,c.req.raw);
    return dispatch(new Request(forwarded,{ headers }),c);
  });
  return routes;
}
