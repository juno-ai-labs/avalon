import { authBodyLimit } from "../middleware/auth-body-limit";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { WorkspaceIdSchema } from "@rally/contracts";
import { RALLY_HEADERS, rallyHeaderAliases } from "@rally/contracts/http-headers";
import type { Env, HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { zValidator } from "../middleware/validation";
import { AuthService, issueAccessToken } from "../services/auth-service";
import { BrowserSessionService, BrowserSessionSchema, BrowserWorkspacesSchema } from "../services/browser-session-service";
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

function cookieOptions(env: Env) {
  const secure = browserOrigin(env).protocol === "https:";
  return { name:`${secure ? "__Host-" : ""}rally-browser-${env.AVALON_REGION}`,
    attributes:{ secure,httpOnly:true,sameSite:"Lax" as const,path:"/" } };
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
  routes.get("/email/redeem",(c) => { c.header("Allow","POST");return c.body(null,405); });
  routes.post("/email/redeem",authBodyLimit,zValidator("json",EmailLoginRedeemSchema),async (c) => {
    const receipt = await redeemEmailLogin(c.env,c.req.valid("json"));
    const session = await new AuthService(c.env).resumeEmailLogin(receipt);
    const service = new BrowserSessionService(c.env);
    const cookie = await service.register(session);
    writeCookie(c,cookie.credential,cookie.expiresAt);
    return c.json(BrowserSessionSchema.parse(cookie.session));
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
    return c.json(BrowserWorkspacesSchema.parse({ workspaces:await new AuthService(c.env).listRegionalWorkspaces(auth.userId) }));
  });
  routes.post("/workspace/select",zValidator("json",z.strictObject({ workspaceId:WorkspaceIdSchema })),async (c) =>
    c.json(BrowserSessionSchema.parse(await new BrowserSessionService(c.env).select(credential(c),c.req.valid("json").workspaceId))));

  routes.all("/api/:workspaceId/*",async (c) => {
    const workspace = c.req.param("workspaceId");
    const workspaceId = workspace === "_" ? undefined : WorkspaceIdSchema.parse(workspace);
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/browser\/api\/[^/]+/u,"");
    // Keep auth/token minting, ingress and internal routes outside this adapter.
    // Business routes retain their ordinary role and scope authorization; lite
    // describes the UI, not an additional permission system.
    if (!/^\/(conversations|sharing|resources|feature-flags|telemetry|workspace|workstreams|sidekicks|automations|connections|favicons|search|speech|realtime)(\/|$)/u.test(url.pathname)) {
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
