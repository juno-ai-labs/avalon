import { z } from "zod";

import { WorkspaceIdSchema } from "./identifiers";
import { HttpUrlSchema } from "./url-schemas";

/**
 * The OAuth 2.1 vocabulary Rally's user MCP server speaks: dynamic client
 * registration (RFC 7591), the authorization request a consent page reads,
 * its approval, and the token request (RFC 6749 with PKCE, RFC 7636).
 * `docs/rally-mcp.md` owns the flow.
 */

/**
 * Where a hosted MCP client may send a person back after consent. A client
 * registering itself names any redirect it likes, so this list is what stops
 * a registration from turning Rally's consent page into a phishing hop:
 * Claude (claude.ai and claude.com) and ChatGPT, by exact origin, any path.
 * Installed clients (Claude Code, Claude Desktop's local bridge, the MCP
 * Inspector) use a loopback redirect instead; see `isAllowedMcpRedirectUri`.
 */
export const MCP_HOSTED_REDIRECT_ORIGINS = [
  "https://claude.ai",
  "https://claude.com",
  "https://chatgpt.com",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A redirect URI a registered client may use: an exact hosted origin above,
 * or a loopback address on any port (RFC 8252 §7.3), over http or https.
 * Never a fragment, which OAuth forbids in a redirect URI (RFC 6749 §3.1.2).
 */
export function isAllowedMcpRedirectUri(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (LOOPBACK_HOSTS.has(url.hostname)) return url.protocol === "http:" || url.protocol === "https:";
  return (MCP_HOSTED_REDIRECT_ORIGINS as readonly string[]).includes(url.origin);
}

export const McpRedirectUriSchema = z.string().refine(isAllowedMcpRedirectUri, {
  message: "must be a loopback address or a Claude or ChatGPT callback",
});

/** `POST /register`. Unknown metadata is accepted and ignored, as RFC 7591 §2 allows. */
export const McpClientRegistrationRequestSchema = z.object({
  redirect_uris: z.array(McpRedirectUriSchema).min(1),
  client_name: z.string().trim().min(1).max(200).optional(),
});
export type McpClientRegistrationRequest = z.infer<typeof McpClientRegistrationRequestSchema>;

/**
 * What registration answers. Every client is public: it proves possession
 * with PKCE rather than a secret, so `token_endpoint_auth_method` is `none`
 * whatever the request asked for (RFC 7591 §3.2.1 lets the server replace a
 * requested value).
 */
export const McpClientRegistrationSchema = z.object({
  client_id: z.string(),
  client_id_issued_at: z.number().int(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.literal("none"),
  grant_types: z.tuple([z.literal("authorization_code"), z.literal("refresh_token")]),
  response_types: z.tuple([z.literal("code")]),
});
export type McpClientRegistration = z.infer<typeof McpClientRegistrationSchema>;

/**
 * The authorization request as the consent page received it in its query,
 * and as it sends it back on approval. Only S256 PKCE is accepted: OAuth 2.1
 * requires PKCE and `plain` gives no protection against a stolen code.
 */
export const McpAuthorizationRequestSchema = z.strictObject({
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "must be an S256 code challenge"),
  codeChallengeMethod: z.literal("S256"),
  state: z.string().optional(),
  resource: z.string().optional(),
  scope: z.string().optional(),
});
export type McpAuthorizationRequest = z.infer<typeof McpAuthorizationRequestSchema>;

/** What the consent page shows: who is asking, and where it will return. */
export const McpAuthorizationDescriptionSchema = z.strictObject({
  clientName: z.string(),
  redirectOrigin: z.string(),
});
export type McpAuthorizationDescription = z.infer<typeof McpAuthorizationDescriptionSchema>;

export const McpAuthorizationApprovalSchema = McpAuthorizationRequestSchema.extend({
  workspaceId: WorkspaceIdSchema,
});
export type McpAuthorizationApproval = z.infer<typeof McpAuthorizationApprovalSchema>;

/** Where the consent page sends the browser next: the client's redirect with a code, or with an error. */
export const McpAuthorizationRedirectSchema = z.strictObject({ redirectUrl: HttpUrlSchema });

/** `POST /token`, form-encoded. */
export const McpTokenRequestSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1),
    redirect_uri: z.string().min(1),
    client_id: z.string().min(1),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
    resource: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1),
    resource: z.string().optional(),
    scope: z.string().optional(),
  }),
]);
export type McpTokenRequest = z.infer<typeof McpTokenRequestSchema>;

export const McpTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string(),
  scope: z.string(),
});
export type McpTokenResponse = z.infer<typeof McpTokenResponseSchema>;

/** An OAuth error response (RFC 6749 §5.2, RFC 7591 §3.2.2). */
export const McpOAuthErrorBodySchema = z.strictObject({ error: z.string(), error_description: z.string() });

/** The one scope a grant carries: act in one Organization's Canvases as the person who approved. */
export const MCP_SCOPE = "canvases";
