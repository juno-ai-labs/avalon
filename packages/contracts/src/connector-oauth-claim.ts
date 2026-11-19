import { z } from "zod";

import { ConnectorCompletionUrlSchema } from "./url-schemas";
import { deferredZodSchema } from "./deferred-zod-schema";

/** A connector authorization's one-time claim ticket (`docs/connectors.md`, "Claiming a connector authorization"). */
export const CONNECTOR_CLAIM_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Where a connector authorization started in the mobile app returns. */
export const MOBILE_CONNECTOR_CALLBACK = "rally-mobile://connections/complete";

export const ConnectorOAuthClaimRequestSchema = deferredZodSchema(() => z.strictObject({
  ticket: z.string().regex(CONNECTOR_CLAIM_TICKET_PATTERN),
}));

/**
 * The handoff target the callback used to redirect to before claiming
 * existed: the client reads it exactly as it reads a completion link.
 */
export const ConnectorOAuthClaimSchema = deferredZodSchema(() => z.strictObject({ target: ConnectorCompletionUrlSchema }));

export type ConnectorOAuthClaimRequest = z.infer<typeof ConnectorOAuthClaimRequestSchema>;
export type ConnectorOAuthClaim = z.infer<typeof ConnectorOAuthClaimSchema>;

/** A held authorization's completion link, as the browser page and the mobile shell receive it. */
export interface ConnectorClaimLink {
  ticket: string;
  region: string;
  workspaceId: string;
}

/**
 * The claim a browser completion page or a mobile completion link carries, or
 * null. The browser keeps the ticket in the fragment, out of server logs; the
 * mobile link goes straight to the app, so it travels in the query.
 */
export function parseConnectorClaimLink(raw: string | URL): ConnectorClaimLink | null {
  let url: URL;
  try { url = new URL(raw.toString()); } catch { return null; }
  if (url.searchParams.get("status") !== "authorized") return null;
  const ticket = url.searchParams.get("ticket") ?? new URLSearchParams(url.hash.slice(1)).get("ticket");
  const region = url.searchParams.get("region");
  const workspaceId = url.searchParams.get("workspace");
  return ticket && CONNECTOR_CLAIM_TICKET_PATTERN.test(ticket) && region && workspaceId
    ? { ticket, region, workspaceId }
    : null;
}
