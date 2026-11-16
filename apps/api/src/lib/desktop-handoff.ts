import type { ConnectorOAuthProvider } from "@rally/contracts";
import { MOBILE_CONNECTOR_CALLBACK } from "@rally/contracts/connector-oauth-claim";
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

/**
 * How a connector authorization returns to the client that started it: a
 * desktop deep link (version 1 or the workspace-addressed version 2), the
 * browser's completion page, or the mobile app's auth-session callback.
 */
export type ConnectorHandoff = 1 | 2 | "browser" | "mobile";

/** The one page a browser connector authorization may return to. */
export function browserConnectorCompletionUrl(env: Pick<Env, "BROWSER_APP_ORIGIN">): string | null {
  if (!env.BROWSER_APP_ORIGIN) return null;
  return new URL("/connections/complete", new URL(env.BROWSER_APP_ORIGIN).origin).toString();
}

export function desktopHandoffUrl(
  env: Pick<Env, "PUBLIC_WEB_BASE_URL" | "BROWSER_APP_ORIGIN">,
  target: string | URL,
): string {
  // The browser's completion page is already on the browser host and goes
  // straight there. Every other target is a desktop deep link, which needs the
  // site's handoff page to open the app; no other web URL passes through.
  const parsed = new URL(target.toString());
  const completion = browserConnectorCompletionUrl(env);
  if (completion && `${parsed.origin}${parsed.pathname}` === completion) return parsed.toString();
  // The mobile app's auth session waits for exactly this scheme; a page in
  // between would leave it waiting.
  if (`${parsed.protocol}//${parsed.host}${parsed.pathname}` === MOBILE_CONNECTOR_CALLBACK) return parsed.toString();
  const handoff = new URL("/auth/desktop/", env.PUBLIC_WEB_BASE_URL);
  handoff.hash = new URLSearchParams({ target: target.toString() }).toString();
  return handoff.toString();
}

export function normalizeConnectorOAuthErrorCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 100);
  return normalized || "connector_oauth_failed";
}

type ConnectorAttemptTargetResult =
  | { status: "succeeded"; connectionId: string; errorCode?: never; ticket?: never }
  | { status: "denied" | "failed"; errorCode: string; connectionId?: never; ticket?: never }
  /** Held for the starting client to claim (`docs/connectors.md`, "Claiming a connector authorization"). */
  | { status: "authorized"; ticket: string; connectionId?: never; errorCode?: never };

export type ConnectorAttemptTargetInput = {
  provider: ConnectorOAuthProvider;
  attemptId?: string;
  workspaceId: string;
  returnUri: string;
} & ConnectorAttemptTargetResult;

export function connectorAttemptTarget(
  env: Pick<Env, "AVALON_REGION" | "DESKTOP_DEEP_LINK_URI" | "BROWSER_APP_ORIGIN">,
  input: ConnectorAttemptTargetInput,
): string {
  if (
    (input.status === "succeeded" && !input.connectionId)
    || (input.status === "authorized" && !input.ticket)
    || ((input.status === "denied" || input.status === "failed") && (!input.errorCode || input.connectionId !== undefined))
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
  const exactBrowser = target.toString() === browserConnectorCompletionUrl(env);
  const exactMobile = target.toString() === MOBILE_CONNECTOR_CALLBACK;
  if (!exactLegacy && !exactAddressed && !exactBrowser && !exactMobile) throw new Error("The connector return URI is invalid");
  target.searchParams.set("provider", input.provider);
  if (exactLegacy || exactBrowser || exactMobile) target.searchParams.set("region", env.AVALON_REGION);
  // The browser page and the mobile app claim through the Organization's own
  // API, so they are told which one; a desktop link is already addressed.
  if ((exactBrowser || exactMobile) && input.status === "authorized") target.searchParams.set("workspace", input.workspaceId);
  if (input.attemptId) target.searchParams.set("attempt", input.attemptId);
  if (input.status === "authorized") {
    target.searchParams.set("status", "authorized");
    // A browser page's query reaches the server that serves it; its fragment
    // does not. Deep links go straight to the app, like a sign-in ticket.
    if (exactBrowser) target.hash = new URLSearchParams({ ticket: input.ticket }).toString();
    else target.searchParams.set("ticket", input.ticket);
  } else if (input.status === "succeeded") {
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
