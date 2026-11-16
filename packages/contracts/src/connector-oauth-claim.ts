import { z } from "zod";

import {
  ConnectorOAuthProviders,
  type ConnectorOAuthProviderValue as ConnectorOAuthProvider,
} from "./connector-oauth-providers";
import { ConnectorCompletionUrlSchema } from "./url-schemas";

/**
 * A connector authorization completes in two requests (`docs/connectors.md`,
 * "Claiming a connector authorization"). The provider's callback holds its
 * result and returns a one-time ticket to the browser that consented; the
 * signed-in client that started the authorization claims it. The ticket alone
 * completes nothing, and neither does the session alone: an authorization link
 * one person started can no longer attach another person's account.
 */
export const CONNECTOR_CLAIM_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Where a connector authorization started in the mobile app returns. */
export const MOBILE_CONNECTOR_CALLBACK = "rally-mobile://connections/complete";

export const ConnectorOAuthClaimRequestSchema = z.strictObject({
  ticket: z.string().regex(CONNECTOR_CLAIM_TICKET_PATTERN),
});

/**
 * The handoff target the callback used to redirect to before claiming
 * existed: the client reads it exactly as it reads a completion link.
 */
export const ConnectorOAuthClaimSchema = z.strictObject({ target: ConnectorCompletionUrlSchema });

export type ConnectorOAuthClaimRequest = z.infer<typeof ConnectorOAuthClaimRequestSchema>;
export type ConnectorOAuthClaim = z.infer<typeof ConnectorOAuthClaimSchema>;

/** A held authorization's completion link, as the browser page and the mobile shell receive it. */
export interface ConnectorClaimLink {
  provider: ConnectorOAuthProvider;
  ticket: string;
  region: string;
  workspaceId: string;
  attemptId: string | null;
}

const REGION_PATTERN = /^[a-z][a-z0-9-]*$/u;
const WORKSPACE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Read the claim a browser completion page or a mobile completion link
 * carries, or null when it carries none. The browser keeps the ticket in the
 * fragment, so it never reaches a server log; the mobile link is handed
 * straight to the app, so it travels in the query like a desktop deep link.
 */
export function parseConnectorClaimLink(raw: string | URL): ConnectorClaimLink | null {
  let url: URL;
  try { url = new URL(raw.toString()); } catch { return null; }
  if (url.searchParams.get("status") !== "authorized") return null;
  const ticket = url.searchParams.get("ticket") ?? new URLSearchParams(url.hash.slice(1)).get("ticket");
  const provider = ConnectorOAuthProviders.find((candidate) => candidate === url.searchParams.get("provider"));
  const region = url.searchParams.get("region");
  const workspaceId = url.searchParams.get("workspace");
  const attemptId = url.searchParams.get("attempt");
  if (
    !ticket || !CONNECTOR_CLAIM_TICKET_PATTERN.test(ticket)
    || !provider
    || !region || !REGION_PATTERN.test(region)
    || !workspaceId || !WORKSPACE_PATTERN.test(workspaceId)
    || (attemptId !== null && !ATTEMPT_PATTERN.test(attemptId))
  ) return null;
  return { provider, ticket, region, workspaceId, attemptId };
}
