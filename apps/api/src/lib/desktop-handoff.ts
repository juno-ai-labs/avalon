import type { ConnectorOAuthProvider } from "@rally/contracts";
import { COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL } from "@rally/contracts/desktop-deep-link";
import { addWorkspaceTarget } from "@rally/contracts/workspace-target";
import type { Env } from "../env";

/**
 * The configured desktop deep link, rewritten into the scheme every live build
 * answers to.
 *
 * Use this wherever the server mints a deep link it cannot attribute to a
 * calling build. Host and path stay exactly as configured; only the scheme
 * moves. See `COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL` for why it is the legacy
 * one, and `docs/domain-migration.md` for when it stops being.
 */
export function compatibleDesktopDeepLink(
  env: Pick<Env, "DESKTOP_DEEP_LINK_URI">,
): URL {
  const target = new URL(env.DESKTOP_DEEP_LINK_URI);
  target.protocol = COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL;
  return target;
}

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
    workspaceId?: string;
  },
): string {
  const target = compatibleDesktopDeepLink(env);
  target.searchParams.set("provider", input.provider);
  target.searchParams.set("region", env.AVALON_REGION);
  if (input.attemptId) target.searchParams.set("attempt", input.attemptId);
  const addressedTarget = input.workspaceId
    ? addWorkspaceTarget(target, { region: env.AVALON_REGION, workspaceId: input.workspaceId })
    : target;
  if (input.status === "succeeded" && input.connectionId) {
    addressedTarget.searchParams.set("connection", input.connectionId);
    addressedTarget.searchParams.set("status", "connected");
  } else {
    addressedTarget.searchParams.set("status", input.status);
    addressedTarget.searchParams.set("error", normalizeConnectorOAuthErrorCode(input.errorCode ?? "connector_oauth_failed"));
  }
  return addressedTarget.toString();
}
