import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "../middleware/validation";
import {
  DesktopExchangeRequestSchema,
  RefreshRequestSchema,
  RefreshTokenSchema,
  SessionSchema,
  WorkspaceInvitationPreviewSchema,
} from "@avalon/contracts";
import { HttpOrDesktopDeepLinkUrlSchema } from "@avalon/contracts/url-schemas";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { compatibleDesktopDeepLink, desktopHandoffUrl } from "../lib/desktop-handoff";
import { AuthService, verifyAccessToken } from "../services/auth-service";
import { previewInvitation } from "../services/workspace-service";

const startBody = z.object({
  returnUri: HttpOrDesktopDeepLinkUrlSchema.optional(),
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
const refreshBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: () => {
    throw new ApiError(413, "payload_too_large", "The authentication request body is too large");
  },
});

/** The opaque provider URL the desktop opens; the route owns this shape. */
const IdentityStartResponseSchema = z.object({ url: z.string().min(1) });

export const authRoutes = new Hono<HonoAppEnv>();

authRoutes.post("/dev/session", zValidator("json", developmentSessionBody), async (c) =>
  c.json(SessionSchema.parse(
    await new AuthService(c.env).createDevelopmentSession(c.req.valid("json").workspaceName)), 201),
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

authRoutes.post("/refresh", refreshBodyLimit, zValidator("json", RefreshRequestSchema), async (c) => {
  return c.json(SessionSchema.parse(await new AuthService(c.env).refresh(c.req.valid("json").refreshToken)));
});

authRoutes.post("/logout", refreshBodyLimit, zValidator("json", logoutBody), async (c) => {
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
