import type { ConnectorOAuthProvider } from "@avalon/contracts";
import type { Env } from "../env";

export function desktopHandoffUrl(
  env: Pick<Env, "PUBLIC_WEB_BASE_URL">,
  target: string | URL,
): string {
  const handoff = new URL("/auth/desktop/", env.PUBLIC_WEB_BASE_URL);
  handoff.hash = new URLSearchParams({ target: target.toString() }).toString();
  return handoff.toString();
}

export function normalizeConnectorOAuthErrorCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 100);
  return normalized || "connector_oauth_failed";
}

export function connectorAttemptTarget(
  env: Pick<Env, "AVALON_REGION" | "DESKTOP_DEEP_LINK_URI">,
  input: {
    provider: ConnectorOAuthProvider;
    status: "succeeded" | "denied" | "failed";
    attemptId?: string;
    connectionId?: string;
    errorCode?: string;
  },
): string {
  const target = new URL(env.DESKTOP_DEEP_LINK_URI);
  target.searchParams.set("provider", input.provider);
  target.searchParams.set("region", env.AVALON_REGION);
  if (input.attemptId) target.searchParams.set("attempt", input.attemptId);
  if (input.status === "succeeded" && input.connectionId) {
    target.searchParams.set("connection", input.connectionId);
    target.searchParams.set("status", "connected");
  } else {
    target.searchParams.set("status", input.status);
    target.searchParams.set("error", normalizeConnectorOAuthErrorCode(input.errorCode ?? "connector_oauth_failed"));
  }
  return target.toString();
}
