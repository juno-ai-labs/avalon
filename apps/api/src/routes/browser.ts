import { MobileAuthStartSchema, MobileAuthTicketSchema, MobileAuthExchangeSchema } from '@rally/contracts/mobile-auth';
import { PasswordLoginRequestSchema } from '@rally/contracts/password-login';
import { passwordLogin } from '../services/password-login-service';
import { UuidV7Schema } from '@rally/contracts/telemetry';
import { McpAuthorizationApprovalSchema, McpAuthorizationDescriptionSchema, McpAuthorizationRedirectSchema,
  McpAuthorizationRequestSchema } from "@rally/contracts/mcp-oauth";
import { McpOAuthError, McpOAuthService } from "../services/mcp-oauth-service";
import { observeSignup, observeSignupProgress } from '../telemetry/signup';
import { authBodyLimit } from "../middleware/auth-body-limit";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { StartSupportSessionRequestSchema, SupportPeopleSchema, SupportWorkspacesSchema, WorkspaceIdSchema } from "@rally/contracts";
import { SupportAccessService } from "../services/support-access";
import { RALLY_HEADERS, rallyHeaderAliases } from "@rally/contracts/http-headers";
import type { Env, HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { browserOrigin } from "../lib/browser-origin";
import { logEvent } from "../observability/logger";
import { codeShaped } from "@rally/contracts/zod-diagnostics";
import { zValidator } from "../middleware/validation";
import { AppleCallbackFormSchema } from "../services/apple-identity";
import { AuthService, issueAccessToken, verifyAccessToken, type IdentityCallbackExtras, type LoginProvider } from "../services/auth-service";
import { telemetryOperationId } from "../telemetry/api-emitter";
import { deferOnboardingOutcome, onboardingFailureResult } from "./onboarding";
import { PlatformOnboardingService } from "../services/platform-onboarding-service";
import { membershipAttention } from "../services/workspace-attention-service";
import { resolveSiteForViewer } from "../services/artifact-site-resolution";
import { IDENTITY_REGION, configuredRegions, type Region } from "@rally/contracts/regions";
import { BrowserSessionService, BrowserSessionSchema, BrowserWorkspacesSchema } from "../services/browser-session-service";
import { BrowserGoogleStartSchema, BrowserGoogleStartedSchema, BrowserSiteResolutionSchema, BrowserSiteResolveSchema, BrowserWorkspaceActivateSchema, BrowserWorkspaceAttentionSchema,
  BrowserWorkspaceCreateSchema, BrowserWorkspaceCreatedSchema, SourceDecisionLinkSchema, SourceDecisionResultSchema } from "@rally/contracts/browser-session";
import { decideSourceRequestByLink } from "../services/sidekick-source-decision-link";
import { startEmailLogin, deliverEmailLogin, redeemEmailLogin, EmailLoginStartSchema,
  EmailLoginRedeemSchema, EmailLoginStartedSchema } from "../services/email-login-service";

/** One cookie per deployment; Global also writes another deployment's after activating there. */
function cookieOptions(env: Env, region: Region = env.AVALON_REGION) {
  const secure = browserOrigin(env).protocol === "https:";
  return { name:`${secure ? "__Host-" : ""}rally-browser-${region}`,
    attributes:{ secure,httpOnly:true,sameSite:"Lax" as const,path:"/" } };
}

/**
 * Binds a provider sign-in to the browser that started it. The OAuth state is
 * also stored server-side; the callback requires this cookie to carry the same
 * value, so a link to someone else's callback cannot sign this browser in as
 * them. It is a session cookie: the stored state's own expiry bounds the
 * sign-in.
 *
 * Apple returns with a cross-site POST, which a `SameSite=Lax` cookie does not
 * ride, so Apple's binding is `SameSite=None`. It still names one state and
 * carries nothing but that state, so being sent cross-site gives it no power:
 * the callback only compares it.
 */
function stateCookie(env: Env, provider: LoginProvider, state: string) {
  const cookie = cookieOptions(env);
  const sameSite = provider === "apple" && cookie.attributes.secure ? "None" as const : cookie.attributes.sameSite;
  // One cookie per state, so two tabs signing in at once do not overwrite each
  // other. The state is base64url, which a cookie name may carry.
  return { name:`${cookie.name}-${provider}-${state}`,attributes:{ ...cookie.attributes,sameSite } };
}

/** The cross-site POST a provider returns with. The same-origin guard below lets only these through. */
const PROVIDER_POST_CALLBACKS = new Set(["/apple/callback"]);

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
 * needs Canvases, Sidekicks, account onboarding, push devices and workspace
 * membership as well as what guests use; `auth`,
 * `internal`, `ingest`, `access`, `slack` and `dev` stay outside.
 * Of onboarding, only `onboarding/account` and the read-only
 * `onboarding/organization-suggestion` cross: the other onboarding steps answer
 * with a bearer session, which browser JavaScript must never hold.
 */
const BROWSER_ROUTE_FAMILIES = /^\/(message-issues|conversations|sharing|resources|feature-flags|telemetry|workspace|workspaces|onboarding\/account|onboarding\/organization-suggestion|push-devices|canvases|sidekicks|automations|connections|favicons|search|speech|realtime)(\/|$)/u;

/** Same-origin cookie transport over the existing regional business API. */
function developmentAuthEnabled(env: Env): boolean {
  return env.APP_ENV === "development" && env.RALLY_DEV_AUTH === "true";
}

export function createBrowserRoutes(dispatch: (request:Request, context:Context<HonoAppEnv>) => Response | Promise<Response>) {
  const routes = new Hono<HonoAppEnv>();
  routes.use("*",async (c,next) => {
    const origin = browserOrigin(c.env).origin;
    c.header("Cache-Control","no-store");
    if (!["GET","HEAD","OPTIONS"].includes(c.req.method) && !PROVIDER_POST_CALLBACKS.has(c.req.path.replace(/^\/browser/u,"")) &&
      (c.req.header("origin") !== origin || c.req.header("sec-fetch-site") === "cross-site")) {
      throw new ApiError(403,"browser_origin_required","Reload Rally before trying again");
    }
    await next();
    c.header("Cache-Control","no-store");
  });
  // The system browser and native WebView have separate cookie stores. Only
  // a single-use, PKCE-bound ticket crosses that boundary; never the cookie.
  routes.post('/mobile/handoff', authBodyLimit, zValidator('json', MobileAuthStartSchema), async (c) => {
    const auth = await new BrowserSessionService(c.env).read(credential(c));
    if (auth.impersonatorUserId) throw new ApiError(403, 'mobile_identity_required', 'Sign in with your own account');
    const ticket = await new AuthService(c.env).issueLoginTicket({ userId: auth.userId, ...c.req.valid('json') });
    return c.json(MobileAuthTicketSchema.parse(ticket));
  });
  routes.post('/mobile/exchange', authBodyLimit, zValidator('json', MobileAuthExchangeSchema), async (c) => {
    const session = await new AuthService(c.env).exchangeDesktopTicket(c.req.valid('json'), 'browser');
    const cookie = await new BrowserSessionService(c.env).register(session);
    writeCookie(c, cookie.credential, cookie.expiresAt);
    return c.json(BrowserSessionSchema.parse(cookie.session));
  });
  routes.post('/password', authBodyLimit, zValidator('json', PasswordLoginRequestSchema), async (c) => {
    const session = await passwordLogin(c.env, c.req.valid('json'));
    const cookie = await new BrowserSessionService(c.env).register(session);
    writeCookie(c, cookie.credential, cookie.expiresAt);
    return c.json(BrowserSessionSchema.parse(cookie.session));
  });
  routes.post('/signup/view', authBodyLimit, zValidator('json', z.strictObject({ flowId: UuidV7Schema })), (c) => {
    observeSignup(c.env, { flowId: c.req.valid('json').flowId, clientPlatform: 'browser' }, 'signup_viewed', 'unknown');
    return c.body(null, 204);
  });
  routes.post("/email/start",authBodyLimit,zValidator("json",EmailLoginStartSchema),async (c) => {
    const started = await startEmailLogin(c.env,c.req.valid("json"));
    await deliverEmailLogin(c.env,started.challengeId);
    return c.json(EmailLoginStartedSchema.parse(started),202);
  });
  for (const provider of ["google","apple"] as const satisfies readonly LoginProvider[]) {
    routes.post(`/${provider}/start`,authBodyLimit,zValidator("json",BrowserGoogleStartSchema),async (c) => {
      const { url,state } = await new AuthService(c.env).beginBrowserIdentity(c.req.valid("json"),provider);
      const binding = stateCookie(c.env,provider,state);
      setCookie(c,binding.name,state,binding.attributes);
      return c.json(BrowserGoogleStartedSchema.parse({ url }));
    });
  }
  /**
   * Finishes a browser sign-in. Apple's callback is a POST and answers 303 so
   * the browser follows with a GET; Google's GET keeps its 302. A failure
   * returns with `#<provider>_error=<code>`.
   */
  async function completeBrowserIdentity(c: Context<HonoAppEnv>, provider: LoginProvider,
    query: { code?: string | undefined; state?: string | undefined; error?: string | undefined }, extras: IdentityCallbackExtras = {}) {
    const status = c.req.method === "POST" ? 303 : 302;
    const origin = browserOrigin(c.env).origin;
    const failed = (code: string) => c.redirect(`${origin}/#${provider}_error=${encodeURIComponent(code)}`,status);
    // A callback this browser cannot tie to a sign-in it started, including one
    // with no state at all, still lands on a page that says what happened.
    if (!query.state || !/^[A-Za-z0-9_-]+$/u.test(query.state)) return failed(`${provider}_state_mismatch`);
    const binding = stateCookie(c.env,provider,query.state);
    const bound = getCookie(c,binding.name);
    if (!bound || bound !== query.state) return failed(`${provider}_state_mismatch`);
    deleteCookie(c,binding.name,binding.attributes);
    const service = new AuthService(c.env);
    try {
      if (query.error || !query.code) {
        const returnUrl = await service.consumeBrowserIdentityDenial(query.state,provider);
        // Only a person declining is a denial; anything else the provider
        // reports is its own failure, named so the two read apart. Google and
        // Apple each have their own word for declining.
        const declined = query.error === "access_denied" || query.error === "user_cancelled_authorize";
        const code = declined ? `${provider}_oauth_denied` : `${provider}_oauth_failed`;
        if (!declined) logEvent(c,"warn",`browser_${provider}_sign_in_failed`,{ code,providerError:codeShaped(query.error ?? "missing_code") });
        return c.redirect(`${returnUrl}#${provider}_error=${code}`,status);
      }
      const { session,returnUrl } = await service.consumeBrowserIdentityCallback(query.code,query.state,provider,extras);
      const cookie = await new BrowserSessionService(c.env).register(session);
      writeCookie(c,cookie.credential,cookie.expiresAt);
      return c.redirect(returnUrl,status);
    } catch (error) {
      if (error instanceof ApiError) {
        logEvent(c,"warn",`browser_${provider}_sign_in_failed`,{ code:error.code,...(error.diagnosticCode ? { cause:error.diagnosticCode } : {}) });
        return failed(error.code);
      }
      // Anything else that threw, such as a fetch or D1 failure: name it in the
      // log and send the person back to a page that says sign-in failed.
      const code: unknown = error instanceof Error && "code" in error ? error.code : undefined;
      const cause = typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
      logEvent(c,"error",`browser_${provider}_sign_in_failed`,{ code:`${provider}_sign_in_failed`,cause:codeShaped(cause) });
      return failed(`${provider}_sign_in_failed`);
    }
  }
  routes.get("/google/callback",zValidator("query",z.object({ code:z.string().optional(),state:z.string().optional(),error:z.string().optional() })),
    (c) => completeBrowserIdentity(c,"google",c.req.valid("query")));
  routes.post("/apple/callback",authBodyLimit,zValidator("form",AppleCallbackFormSchema),(c) => {
    const form = c.req.valid("form");
    return completeBrowserIdentity(c,"apple",form,{ appleUser:form.user });
  });
  // The desktop's "Use local development account", as this browser's cookie
  // session: development with RALLY_DEV_AUTH only, which the GET answers so
  // the signed-out page knows whether to offer it. Elsewhere both are 404.
  routes.get("/dev/session",(c) => c.body(null,developmentAuthEnabled(c.env) ? 204 : 404));
  routes.post("/dev/session",authBodyLimit,async (c) => {
    const session = await new AuthService(c.env).createDevelopmentIdentitySession();
    const cookie = await new BrowserSessionService(c.env).register(session);
    writeCookie(c,cookie.credential,cookie.expiresAt);
    return c.json(BrowserSessionSchema.parse(cookie.session),201);
  });
  routes.get("/email/redeem",(c) => { c.header("Allow","POST");return c.body(null,405); });
  routes.post("/email/redeem",authBodyLimit,zValidator("json",EmailLoginRedeemSchema),async (c) => {
    const receipt = await redeemEmailLogin(c.env,c.req.valid("json"), 'browser');
    const session = await new AuthService(c.env).resumeEmailLogin(receipt, 'browser');
    const service = new BrowserSessionService(c.env);
    const cookie = await service.register(session);
    writeCookie(c,cookie.credential,cookie.expiresAt);
    return c.json(BrowserSessionSchema.parse(cookie.session));
  });
  // An emailed Approve or Decline for a Sidekick source request
  // (docs/sidekick-sources.md). It reads no cookie: the signed link sent to the
  // asked person's own mailbox is the proof, and one POST records the answer.
  // A GET of this path answers nothing. The emailed link opens the browser
  // client's page, which sends the POST when it loads: something that only
  // fetches the link does not answer, and something that runs the page, as
  // some mail scanners do, does.
  routes.get("/source-requests/decision",(c) => { c.header("Allow","POST");return c.body(null,405); });
  routes.post("/source-requests/decision",authBodyLimit,zValidator("json",SourceDecisionLinkSchema),async (c) =>
    c.json(SourceDecisionResultSchema.parse(await decideSourceRequestByLink(c.env,c.req.valid("json")))));
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
   * Attention for each organization `/workspaces` lists, read apart from it so
   * the list paints without waiting on any Durable Object. Global answers for
   * every deployment, as it does for the list.
   */
  routes.get("/workspaces/attention",async (c) => {
    const auth = await new BrowserSessionService(c.env).read(credential(c));
    const local = await membershipAttention(c.env,auth.userId,await new AuthService(c.env).listRegionalWorkspaces(auth.userId));
    const remote = c.env.AVALON_REGION !== IDENTITY_REGION || configuredRegions.length < 2
      ? { attention:[],failed:[] }
      : await new PlatformOnboardingService(c.env,auth).otherDeploymentAttention();
    // Workspace ids are not user data; they find the one bad workspace.
    const failed = [...local.failed.map((item) => ({ region:c.env.AVALON_REGION,...item })),...remote.failed]
      .map((item) => [item.region,item.workspaceId,item.code].filter(Boolean).join(":"));
    if (failed.length > 0) logEvent(c,"warn","browser_workspace_attention_failed",{ failed:failed.join(",") });
    return c.json(BrowserWorkspaceAttentionSchema.parse({ attention:[...local.attention,...remote.attention] }));
  });
  /**
   * The organization and resource behind a site's hostname, for the
   * site-opening page a protected site sends people to. Answered only to
   * someone who can read the site: 404 when there is no such site, 403 when
   * this account cannot read it.
   */
  routes.post("/sites/resolve",zValidator("json",BrowserSiteResolveSchema),async (c) => {
    const auth = await new BrowserSessionService(c.env).read(credential(c));
    const resolved = await resolveSiteForViewer(c.env,auth.userId,c.req.valid("json").hostnameStub);
    return c.json(BrowserSiteResolutionSchema.parse(resolved));
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
    observeSignupProgress(c.env, auth.userId, 'signup_organization_requested', 'existing_organization', 'browser');
    const registration = await new PlatformOnboardingService(c.env,auth).activateBrowser(region,workspaceId);
    observeSignupProgress(c.env, auth.userId, 'signup_organization_ready', 'existing_organization', 'browser');
    const target = cookieOptions(c.env,region);
    setCookie(c,target.name,registration.credential,{ ...target.attributes,expires:new Date(registration.expiresAt) });
    return c.body(null,204);
  });
  /**
   * Creates an organization for this browser through the same idempotent path
   * the Mac app takes. That path ends in a bearer session, which a browser must
   * never hold: it is revoked here, unread, and the browser opens the new
   * organization with `/workspace/select` like any other. Creation is on Global,
   * as it is on the Mac.
   */
  routes.post("/workspace/create",zValidator("json",BrowserWorkspaceCreateSchema),async (c) => {
    const { name,operationId } = c.req.valid("json");
    const region = c.env.AVALON_REGION;
    if (region !== IDENTITY_REGION) throw new ApiError(409,"global_identity_required","Create an organization through Rally's identity deployment");
    const auth = await new BrowserSessionService(c.env).read(credential(c));
    observeSignupProgress(c.env, auth.userId, 'signup_organization_requested', 'new_organization', 'browser');
    const telemetryId = telemetryOperationId(operationId);
    try {
      const session = await new PlatformOnboardingService(c.env,auth).createWorkspace(name,region,c.req.raw.cf,operationId);
      await new AuthService(c.env).logout({ sessionId:(await verifyAccessToken(c.env,session.accessToken)).sessionId });
      observeSignupProgress(c.env, auth.userId, 'signup_organization_ready', 'new_organization', 'browser');
      deferOnboardingOutcome(c,auth,session,"workspace_create_completed",region,telemetryId,"success");
      return c.json(BrowserWorkspaceCreatedSchema.parse({ region,workspaceId:session.workspace?.id }),201);
    } catch (error) {
      deferOnboardingOutcome(c,auth,null,"workspace_create_completed",region,telemetryId,onboardingFailureResult(error));
      throw error;
    }
  });
  routes.post("/workspace/select",zValidator("json",z.strictObject({ workspaceId:WorkspaceIdSchema })),async (c) => {
    const service = new BrowserSessionService(c.env);
    const auth = await service.read(credential(c));
    observeSignupProgress(c.env, auth.userId, 'signup_organization_requested', 'existing_organization', 'browser');
    const session = BrowserSessionSchema.parse(await service.select(credential(c),c.req.valid("json").workspaceId));
    observeSignupProgress(c.env, session.user.id, 'signup_organization_ready', 'existing_organization', 'browser');
    return c.json(BrowserSessionSchema.parse(session));
  });

  // The consent half of Rally's MCP authorization server (`docs/rally-mcp.md`):
  // the page at `/oauth/authorize` reads who is asking, then approves for one
  // Organization or declines. The signed-in person is this browser's.
  const mcpConsent = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) {
      if (error instanceof McpOAuthError) throw new ApiError(400,`mcp_oauth_${error.error}`,error.description);
      throw error;
    }
  };
  routes.get("/oauth/authorization",zValidator("query",McpAuthorizationRequestSchema),async (c) => {
    await new BrowserSessionService(c.env).read(credential(c));
    return c.json(McpAuthorizationDescriptionSchema.parse(await mcpConsent(() => new McpOAuthService(c.env).describe(c.req.valid("query")))));
  });
  routes.post("/oauth/approve",authBodyLimit,zValidator("json",McpAuthorizationApprovalSchema),async (c) => {
    const identity = await new BrowserSessionService(c.env).read(credential(c));
    const redirectUrl = await mcpConsent(() => new McpOAuthService(c.env).approve(identity,c.req.valid("json")));
    return c.json(McpAuthorizationRedirectSchema.parse({ redirectUrl }));
  });
  routes.post("/oauth/deny",authBodyLimit,zValidator("json",McpAuthorizationRequestSchema),async (c) => {
    await new BrowserSessionService(c.env).read(credential(c));
    const redirectUrl = await mcpConsent(() => new McpOAuthService(c.env).deny(c.req.valid("json")));
    return c.json(McpAuthorizationRedirectSchema.parse({ redirectUrl }));
  });

  // Rally staff acting in an Organization that granted Rally access
  // (`docs/impersonation.md`): the same service the Mac app reaches through
  // `/auth/support`, authorized by this browser's identity session.
  routes.get("/support/workspaces",async (c) => {
    const auth = await new BrowserSessionService(c.env).read(credential(c));
    return c.json(SupportWorkspacesSchema.parse(await new SupportAccessService(c.env,auth).workspaces()));
  });
  routes.get("/support/workspaces/:workspaceId/people",zValidator("param",z.object({ workspaceId:WorkspaceIdSchema })),async (c) => {
    const auth = await new BrowserSessionService(c.env).read(credential(c));
    return c.json(SupportPeopleSchema.parse(await new SupportAccessService(c.env,auth).people(c.req.valid("param").workspaceId)));
  });
  routes.post("/support/session",authBodyLimit,zValidator("json",StartSupportSessionRequestSchema),async (c) =>
    c.json(BrowserSessionSchema.parse(await new BrowserSessionService(c.env).selectSupport(credential(c),c.req.valid("json")))));
  routes.post("/support/end",zValidator("json",z.strictObject({ workspaceId:WorkspaceIdSchema })),async (c) => {
    await new BrowserSessionService(c.env).endSupport(credential(c),c.req.valid("json").workspaceId);
    return c.body(null,204);
  });

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
