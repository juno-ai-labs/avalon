import { UuidV7Schema } from '@rally/contracts/telemetry';
import { observeSignup, observeSignupProgress } from '../telemetry/signup';
import { requireIdentityAuth, getIdentityAuth, refuseSupportSession } from "../middleware/auth";
import { startEmailLogin, redeemEmailLogin, deliverEmailLogin, EmailLoginStartSchema, EmailLoginRedeemSchema, EmailLoginStartedSchema } from "../services/email-login-service";
import { Hono } from "hono";
import { authBodyLimit } from "../middleware/auth-body-limit";
import { zValidator } from "../middleware/validation";
import {
  DesktopExchangeRequestSchema,
  RefreshRequestSchema,
  RefreshTokenSchema,
  SessionSchema,
  StartSupportSessionRequestSchema,
  SupportPeopleSchema,
  SupportWorkspacesSchema,
  WorkspaceSchema,
  WorkspaceIdSchema,
  WorkspaceInvitationPreviewSchema,
} from "@rally/contracts";
import { HttpOrDesktopDeepLinkUrlSchema } from "@rally/contracts/url-schemas";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { compatibleDesktopDeepLink, desktopHandoffUrl } from "../lib/desktop-handoff";
import { AuthService, verifyAccessToken } from "../services/auth-service";
import { previewInvitation } from "../services/workspace-service";
import { SupportAccessService } from "../services/support-access";

const startBody = z.object({
  returnUri: HttpOrDesktopDeepLinkUrlSchema.optional(),
  signupFlowId: UuidV7Schema.optional(),
  desktopAttemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  desktopCodeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
const invitationPreviewQuery = z.object({ token: z.string().min(20).max(500) });
const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(20),
  error: z.string().min(1).optional(),
}).refine((value) => Boolean(value.code || value.error), { message: "Google returned neither a code nor an error" });
const logoutBody = z.object({ refreshToken: RefreshTokenSchema.optional() }).default({});
const developmentSessionBody = z.object({ workspaceName: z.string().trim().min(2).max(120).optional() }).default({});


/** The opaque provider URL the desktop opens; the route owns this shape. */
const IdentityStartResponseSchema = z.object({ url: z.string().min(1) });

export const authRoutes = new Hono<HonoAppEnv>();
authRoutes.post('/signup/view', authBodyLimit, zValidator('json', z.strictObject({ flowId: UuidV7Schema })), (c) => {
  observeSignup(c.env, { flowId: c.req.valid('json').flowId, clientPlatform: 'desktop' }, 'signup_viewed', 'unknown');
  return c.body(null, 204);
});

const RegionalWorkspacesSchema = z.object({ workspaces:z.array(WorkspaceSchema) });
const SelectRegionalWorkspaceSchema = z.strictObject({ workspaceId:WorkspaceIdSchema });

authRoutes.get("/workspaces",requireIdentityAuth,refuseSupportSession,async (c) => {
  c.header("Cache-Control","no-store");
  const workspaces = await new AuthService(c.env).listRegionalWorkspaces(getIdentityAuth(c).userId);
  return c.json(RegionalWorkspacesSchema.parse({ workspaces }));
});
authRoutes.post("/workspace/select",requireIdentityAuth,refuseSupportSession,authBodyLimit,zValidator("json",SelectRegionalWorkspaceSchema),async (c) => {
  c.header("Cache-Control","no-store");
  const auth = getIdentityAuth(c);
  observeSignupProgress(c.env, auth.userId, 'signup_organization_requested', 'existing_organization', 'desktop');
  const session = await new AuthService(c.env).createRegionalSession(auth.userId,c.req.valid("json").workspaceId);
  observeSignupProgress(c.env, auth.userId, 'signup_organization_ready', 'existing_organization', 'desktop');
  return c.json(SessionSchema.parse(session));
});

// Rally staff acting in an Organization that granted Rally access
// (`docs/impersonation.md`). Each call re-checks staff membership and the grant.
const supportWorkspaceParam = z.object({ workspaceId: WorkspaceIdSchema });
authRoutes.get("/support/workspaces", requireIdentityAuth, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(SupportWorkspacesSchema.parse(await new SupportAccessService(c.env, getIdentityAuth(c)).workspaces()));
});
authRoutes.get("/support/workspaces/:workspaceId/people", requireIdentityAuth, zValidator("param", supportWorkspaceParam), async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(SupportPeopleSchema.parse(
    await new SupportAccessService(c.env, getIdentityAuth(c)).people(c.req.valid("param").workspaceId)));
});
authRoutes.post("/support/session", requireIdentityAuth, authBodyLimit, zValidator("json", StartSupportSessionRequestSchema), async (c) => {
  c.header("Cache-Control", "no-store");
  const { session } = await new SupportAccessService(c.env, getIdentityAuth(c)).start(c.req.valid("json"));
  return c.json(SessionSchema.parse(session));
});

// Both entrypoints are POST-only. Loading a link never consumes a challenge.
authRoutes.post("/email/start", authBodyLimit, zValidator("json",EmailLoginStartSchema), async (c) => {
  c.header("Cache-Control","no-store");
  const started = await startEmailLogin(c.env,c.req.valid("json"), 'desktop');
  await deliverEmailLogin(c.env,started.challengeId);
  return c.json(EmailLoginStartedSchema.parse(started),202);
});
authRoutes.get("/email/redeem", (c) => {
  c.header("Allow","POST");
  c.header("Cache-Control","no-store");
  return c.body(null,405);
});
authRoutes.post("/email/redeem", authBodyLimit, zValidator("json",EmailLoginRedeemSchema), async (c) => {
  c.header("Cache-Control","no-store");
  const receipt = await redeemEmailLogin(c.env,c.req.valid("json"), 'desktop');
  return c.json(SessionSchema.parse(await new AuthService(c.env).resumeEmailLogin(receipt, 'desktop')));
});

authRoutes.post("/dev/session", zValidator("json", developmentSessionBody), async (c) =>
  c.json(SessionSchema.parse(
    await new AuthService(c.env).createDevelopmentSession(c.req.valid("json").workspaceName)), 201),
);

authRoutes.post("/dev/identity", async (c) =>
  c.json(SessionSchema.parse(await new AuthService(c.env).createDevelopmentIdentitySession()), 201),
);

authRoutes.get("/invitations/preview", zValidator("query", invitationPreviewQuery), async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(WorkspaceInvitationPreviewSchema.parse(await previewInvitation(c.env, c.req.valid("query").token)));
});

// Desktop uses POST so organization names and invitation tokens never enter
// browser history. Only the opaque Google OAuth state is opened externally.
authRoutes.post("/google/start", zValidator("json", startBody), async (c) => {
  const body = c.req.valid("json");
  const url = await new AuthService(c.env).beginIdentity({
    ...(body.returnUri ? { returnUri: body.returnUri } : {}),
    signupFlowId: body.signupFlowId,
    desktopAttemptId: body.desktopAttemptId,
    desktopCodeChallenge: body.desktopCodeChallenge,
  });
  c.header("Cache-Control", "no-store");
  return c.json(IdentityStartResponseSchema.parse({ url }));
});

authRoutes.get("/google/callback", zValidator("query", callbackQuery), async (c) => {
  const query = c.req.valid("query");
  // Reached when no stored return URI can be consumed, so there is no caller
  // scheme to answer in — the scheme every live build registers is the one that
  // gets the error in front of somebody rather than dead-ending.
  const desktopTarget = (code?: string): URL => {
    const target = compatibleDesktopDeepLink(c.env);
    if (code) target.searchParams.set("error", code);
    target.searchParams.set("region", c.env.AVALON_REGION);
    return target;
  };
  c.header("Cache-Control", "no-store");
  if (query.error) {
    try {
      const denied = new URL(await new AuthService(c.env).consumeIdentityDenial(query.state));
      return c.redirect(desktopHandoffUrl(c.env, denied), 302);
    } catch (error) {
      if (error instanceof ApiError) return c.redirect(desktopHandoffUrl(c.env, desktopTarget(error.code)), 302);
      throw error;
    }
  }
  try {
    const redirect = new URL(await new AuthService(c.env).consumeIdentityCallback(query.code!, query.state));
    return c.redirect(desktopHandoffUrl(c.env, redirect), 302);
  } catch (error) {
    if (error instanceof ApiError) return c.redirect(desktopHandoffUrl(c.env, desktopTarget(error.code)), 302);
    throw error;
  }
});

authRoutes.post("/desktop/exchange", zValidator("json", DesktopExchangeRequestSchema), async (c) => {
  const body = c.req.valid("json");
  return c.json(SessionSchema.parse(await new AuthService(c.env).exchangeDesktopTicket(body)));
});

authRoutes.post("/refresh", authBodyLimit, zValidator("json", RefreshRequestSchema), async (c) => {
  return c.json(SessionSchema.parse(await new AuthService(c.env).refresh(c.req.valid("json").refreshToken)));
});

authRoutes.post("/logout", authBodyLimit, zValidator("json", logoutBody), async (c) => {
  const body = c.req.valid("json");
  const authorization = c.req.header("authorization");
  let sessionId: string | undefined;
  if (authorization?.startsWith("Bearer ")) {
    try {
      sessionId = (await verifyAccessToken(c.env, authorization.slice(7))).sessionId;
    } catch {
      // Logout remains idempotent for expired access tokens.
    }
  }
  await new AuthService(c.env).logout({
    ...(body.refreshToken ? { refreshToken: body.refreshToken } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
  return c.body(null, 204);
});
