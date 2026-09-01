import type { ConnectorOAuthProvider } from "@rally/contracts";
import {
  COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL,
  isDesktopDeepLinkProtocol,
} from "@rally/contracts/desktop-deep-link";
import {
  parseWorkspaceAddressedDeepLink,
  workspaceTargetsEqual,
} from "@rally/contracts/workspace-target";
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

type ConnectorAttemptTargetResult =
  | { status: "succeeded"; connectionId: string; errorCode?: never }
  | { status: "denied" | "failed"; errorCode: string; connectionId?: never };

export type ConnectorAttemptTargetInput = {
  provider: ConnectorOAuthProvider;
  attemptId?: string;
  workspaceId: string;
  returnUri: string;
} & ConnectorAttemptTargetResult;

export function connectorAttemptTarget(
  env: Pick<Env, "AVALON_REGION" | "DESKTOP_DEEP_LINK_URI">,
  input: ConnectorAttemptTargetInput,
): string {
  if (
    (input.status === "succeeded" && !input.connectionId)
    || (input.status !== "succeeded" && (!input.errorCode || input.connectionId !== undefined))
  ) {
    throw new Error("The connector callback result is invalid");
  }
  const target = new URL(input.returnUri);
  const addressed = parseWorkspaceAddressedDeepLink(target);
  const exactLegacy = isDesktopDeepLinkProtocol(target.protocol)
    && target.hostname === "auth"
    && target.pathname === "/complete"
    && !target.search
    && !target.hash
    && !target.username
    && !target.password
    && !target.port;
  const exactAddressed = addressed !== null
    && workspaceTargetsEqual(addressed.target, {
      region: env.AVALON_REGION,
      workspaceId: input.workspaceId,
    })
    && addressed.destination.hostname === "auth"
    && addressed.destination.pathname === "/complete"
    && !addressed.destination.search
    && !addressed.destination.hash;
  if (!exactLegacy && !exactAddressed) throw new Error("The connector return URI is invalid");
  target.searchParams.set("provider", input.provider);
  if (exactLegacy) target.searchParams.set("region", env.AVALON_REGION);
  if (input.attemptId) target.searchParams.set("attempt", input.attemptId);
  if (input.status === "succeeded") {
    target.searchParams.set("connection", input.connectionId);
    target.searchParams.set("status", "connected");
  } else {
    target.searchParams.set("status", input.status);
    target.searchParams.set("error", normalizeConnectorOAuthErrorCode(input.errorCode));
  }
  return target.toString();
}

/** Fail closed when no persisted OAuth start can identify an initiating build. */
export function unknownConnectorAttemptFailureTarget(
  env: Pick<Env, "AVALON_REGION" | "DESKTOP_DEEP_LINK_URI">,
  input: { provider: ConnectorOAuthProvider; errorCode: string },
): string {
  const target = compatibleDesktopDeepLink(env);
  target.searchParams.set("provider", input.provider);
  target.searchParams.set("region", env.AVALON_REGION);
  target.searchParams.set("status", "failed");
  target.searchParams.set("error", normalizeConnectorOAuthErrorCode(input.errorCode));
  return target.toString();
}
