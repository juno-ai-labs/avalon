import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  McpClientRegistrationRequestSchema,
  McpClientRegistrationSchema,
  McpOAuthErrorBodySchema,
  McpTokenRequestSchema,
  McpTokenResponseSchema,
} from "@rally/contracts/mcp-oauth";
import { describeZodIssues } from "@rally/contracts/zod-diagnostics";

import type { HonoAppEnv } from "../env";
import { authBodyLimit } from "../middleware/auth-body-limit";
import { logEvent } from "../observability/logger";
import { McpOAuthError, McpOAuthService } from "../services/mcp-oauth-service";

/**
 * The server-to-server half of Rally's MCP authorization server: dynamic
 * client registration, the token endpoint and revocation. The MCP Worker
 * publishes them under its own host and forwards here; the consent half is
 * the browser's (`/browser/oauth/*`). `docs/rally-mcp.md`.
 *
 * These answer OAuth's own error shape (RFC 6749 §5.2, RFC 7591 §3.2.2),
 * since MCP clients read that rather than Rally's error envelope, and name
 * the field a malformed request got wrong.
 */
export const mcpOAuthRoutes = new Hono<HonoAppEnv>();
mcpOAuthRoutes.use("*", authBodyLimit, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

/** A form (as RFC 6749 requires of the token endpoint) or, as some clients send, JSON. */
async function body(c: Context<HonoAppEnv>): Promise<unknown> {
  if ((c.req.header("content-type") ?? "").includes("application/json")) return c.req.json<unknown>().catch(() => null);
  return Object.fromEntries(Object.entries(await c.req.parseBody()).filter(([, value]) => typeof value === "string"));
}

function oauthError(c: Context<HonoAppEnv>, error: McpOAuthError) {
  logEvent(c, "warn", "mcp_oauth_refused", { error: error.error });
  return c.json(McpOAuthErrorBodySchema.parse({ error: error.error, error_description: error.description }), error.status);
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, error: McpOAuthError["error"]): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new McpOAuthError(error, `Invalid request: ${describeZodIssues(result.error)}`);
  return result.data;
}

/** A handler whose OAuth refusals answer in OAuth's shape; anything else reaches the app's error handler. */
function oauth(handler: (c: Context<HonoAppEnv>) => Promise<Response>) {
  return async (c: Context<HonoAppEnv>) => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof McpOAuthError) return oauthError(c, error);
      throw error;
    }
  };
}

mcpOAuthRoutes.post("/register", oauth(async (c) => {
  const request = parsed(McpClientRegistrationRequestSchema, await c.req.json<unknown>().catch(() => null), "invalid_client_metadata");
  return c.json(McpClientRegistrationSchema.parse(await new McpOAuthService(c.env).register(request)), 201);
}));

mcpOAuthRoutes.post("/token", oauth(async (c) => {
  const raw = await body(c);
  const grantType = typeof raw === "object" && raw !== null && "grant_type" in raw ? raw.grant_type : undefined;
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    throw new McpOAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }
  const request = parsed(McpTokenRequestSchema, raw, "invalid_request");
  return c.json(McpTokenResponseSchema.parse(await new McpOAuthService(c.env).token(request)));
}));

mcpOAuthRoutes.post("/revoke", oauth(async (c) => {
  const request = parsed(z.object({ token: z.string().min(1), client_id: z.string().min(1) }), await body(c), "invalid_request");
  await new McpOAuthService(c.env).revoke(request.token, request.client_id);
  return c.body(null, 200);
}));
