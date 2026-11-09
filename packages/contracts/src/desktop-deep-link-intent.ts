import {
  ConnectorOAuthProviders,
  type ConnectorOAuthProviderValue as ConnectorOAuthProvider,
} from "./connector-oauth-providers";
import { isDesktopDeepLinkProtocol } from "./desktop-deep-link";
import { parseMessageSearch } from "./links";
import {
  parseWorkspaceAddressedDeepLink,
  type WorkspaceTarget,
  type WorkspaceTargetRegion,
} from "./workspace-target";
import { uuidFromBase58 } from "./uuid-base58";

const UUID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,500}$/u;
const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ERROR_PATTERN = /^[a-z0-9_-]{1,100}$/u;

type Targeted = { target: WorkspaceTarget | null };

export type DesktopDeepLinkIntent =
  /**
   * A Canvas, opened onto one of its artifacts when the link names one, or
   * at one message of its Chat (`turnId` and `sequence`, from
   * `?turn=<turn>&sequence=<n>`) when it names that.
   */
  | { kind: "canvas"; canvasId: string; artifactId?: string; turnId?: string; sequence?: number; target: WorkspaceTarget }
  /** The menu bar's request row: open the main window on this request's approve-or-decline dialog. */
  | ({ kind: "access-request"; requestId: string } & Targeted)
  | ({ kind: "settings"; section: "workspace" | "members" | "connections" | "digest" } & Targeted)
  /** The main window with the sidebar showing Activity: where the digest's button lands. */
  | ({ kind: "activity" } & Targeted)
  | ({ kind: "new-automation" } & Targeted)
  /**
   * An Organization's own landing, as its web app URL with no hash opens it:
   * the main window at `#/`, where the last route this device had open is
   * restored. Addressed only; it is what that URL names.
   */
  | { kind: "home"; target: WorkspaceTarget }
  | { kind: "sidekick"; sidekickId: string; target: WorkspaceTarget }
  | ({ kind: "slack-link"; token: string } & Targeted)
  | { kind: "invitation"; token: string; region: WorkspaceTargetRegion }
  | ({
      kind: "connector-result";
      provider: ConnectorOAuthProvider | null;
      status: "connected" | "denied" | "failed";
      connectionId: string | null;
      attemptId: string | null;
      errorCode: string | null;
      callbackRegion: WorkspaceTargetRegion | null;
    } & Targeted)
  | {
      kind: "identity-result";
      status: "ticket" | "failed";
      ticket: string | null;
      attemptId: string | null;
      errorCode: string | null;
      region: WorkspaceTargetRegion | null;
    };

function exactKeys(parameters: URLSearchParams, required: readonly string[], optional: readonly string[] = []): boolean {
  const entries = [...parameters.keys()];
  return required.every((key) => parameters.getAll(key).length === 1)
    && optional.every((key) => parameters.getAll(key).length <= 1)
    && entries.length >= required.length
    && entries.length <= required.length + optional.length
    && entries.every((key) => required.includes(key) || optional.includes(key));
}

function connectorProvider(value: string | null): ConnectorOAuthProvider | null {
  return ConnectorOAuthProviders.find((candidate) => candidate === value) ?? null;
}

function parseConnectorResult(
  url: URL,
  target: WorkspaceTarget | null,
): DesktopDeepLinkIntent | null {
  const connectionId = url.searchParams.get("connection");
  const providerValue = url.searchParams.get("provider");
  const status = url.searchParams.get("status");
  if (connectionId && providerValue === null && status === "connected") {
    return target === null
      && UUID_PATTERN.test(connectionId)
      && exactKeys(url.searchParams, ["connection", "status"])
      ? {
          kind: "connector-result",
          provider: null,
          status,
          connectionId,
          attemptId: null,
          errorCode: null,
          callbackRegion: null,
          target: null,
        }
      : null;
  }

  const provider = connectorProvider(providerValue);
  if (!provider || (status !== "connected" && status !== "denied" && status !== "failed")) return null;
  const callbackRegion = target?.region ?? url.searchParams.get("region");
  if (!callbackRegion || !/^[a-z][a-z0-9-]*$/u.test(callbackRegion)) return null;
  const attemptId = url.searchParams.get("attempt");
  if (attemptId !== null && !ATTEMPT_PATTERN.test(attemptId)) return null;
  const routingKeys = target ? [] : ["region"];
  if (status === "connected") {
    if (
      !connectionId
      || !UUID_PATTERN.test(connectionId)
      || !exactKeys(url.searchParams, ["connection", "status", "provider", ...routingKeys], ["attempt"])
    ) return null;
    return {
      kind: "connector-result",
      provider,
      status,
      connectionId,
      attemptId,
      errorCode: null,
      callbackRegion,
      target,
    };
  }
  const errorCode = url.searchParams.get("error");
  if (
    connectionId !== null
    || !errorCode
    || !ERROR_PATTERN.test(errorCode)
    || !exactKeys(url.searchParams, ["status", "error", "provider", ...routingKeys], ["attempt"])
  ) return null;
  return {
    kind: "connector-result",
    provider,
    status,
    connectionId: null,
    attemptId,
    errorCode,
    callbackRegion,
    target,
  };
}

function parseIdentityResult(url: URL, target: WorkspaceTarget | null): DesktopDeepLinkIntent | null {
  if (target) return null;
  const ticket = url.searchParams.get("ticket");
  const errorCode = url.searchParams.get("error");
  const region = url.searchParams.get("region");
  const attemptId = url.searchParams.get("attempt");
  if (ticket !== null) {
    return TOKEN_PATTERN.test(ticket)
      && region === "global"
      && attemptId !== null
      && ATTEMPT_PATTERN.test(attemptId)
      && exactKeys(url.searchParams, ["ticket", "region", "attempt"])
      ? { kind: "identity-result", status: "ticket", ticket, attemptId, errorCode: null, region }
      : null;
  }
  if (
    !errorCode
    || !ERROR_PATTERN.test(errorCode)
    || (region !== null && region !== "global")
    || (attemptId !== null && (!region || !ATTEMPT_PATTERN.test(attemptId)))
    || !exactKeys(url.searchParams, ["error"], ["region", "attempt"])
  ) return null;
  return { kind: "identity-result", status: "failed", ticket: null, attemptId, errorCode, region };
}

/** Parse the one shared grammar admitted by main, the public site, and renderer. */
export function parseDesktopDeepLinkIntent(raw: string | URL): DesktopDeepLinkIntent | null {
  let outer: URL;
  try {
    outer = typeof raw === "string" ? new URL(raw) : new URL(raw.toString());
  } catch {
    return null;
  }
  if (!isDesktopDeepLinkProtocol(outer.protocol)) return null;
  const addressed = parseWorkspaceAddressedDeepLink(outer);
  const url = addressed?.destination ?? outer;
  const target = addressed?.target ?? null;
  if (url.hash || url.username || url.password || url.port) return null;

  if (url.hostname === "canvases") {
    const [encodedCanvasId = "", childKind, encodedArtifactId, ...extra] = url.pathname.slice(1).split("/");
    const canvasId = uuidFromBase58(encodedCanvasId);
    if (!target || !canvasId || extra.length) return null;
    if (childKind === undefined) {
      const message = parseMessageSearch(url.searchParams);
      return message ? { kind: "canvas", canvasId, ...message, target } : null;
    }
    if (url.search) return null;
    const artifactId = childKind === "artifacts" && encodedArtifactId ? uuidFromBase58(encodedArtifactId) : null;
    return artifactId ? { kind: "canvas", canvasId, artifactId, target } : null;
  }
  if (url.hostname === "access-requests") {
    const [requestId = "", ...extra] = url.pathname.slice(1).split("/");
    return UUID_PATTERN.test(requestId) && !extra.length && !url.search
      ? { kind: "access-request", requestId, target }
      : null;
  }
  if (url.hostname === "settings") {
    const section = url.pathname.slice(1);
    return (section === "workspace" || section === "members" || section === "connections" || section === "digest") && !url.search
      ? { kind: "settings", section, target }
      : null;
  }
  if (url.hostname === "activity") {
    return (url.pathname === "" || url.pathname === "/") && !url.search ? { kind: "activity", target } : null;
  }
  if (url.hostname === "home") {
    return target && (url.pathname === "" || url.pathname === "/") && !url.search ? { kind: "home", target } : null;
  }
  if (url.hostname === "automations" && url.pathname === "/new") {
    return !url.search ? { kind: "new-automation", target } : null;
  }
  if (url.hostname === "sidekicks") {
    const [encodedSidekickId = "", ...extra] = url.pathname.slice(1).split("/");
    const sidekickId = uuidFromBase58(encodedSidekickId);
    return target && sidekickId && !extra.length && !url.search ? { kind: "sidekick", sidekickId, target } : null;
  }
  if (url.hostname === "slack" && url.pathname === "/link") {
    const token = url.searchParams.get("token");
    return token && TOKEN_PATTERN.test(token) && exactKeys(url.searchParams, ["token"])
      ? { kind: "slack-link", token, target }
      : null;
  }
  if (url.hostname === "invitations" && url.pathname === "/accept" && !target) {
    const token = url.searchParams.get("token");
    const region = url.searchParams.get("region");
    return token && TOKEN_PATTERN.test(token) && (region !== null && /^[a-z][a-z0-9-]*$/u.test(region))
      && exactKeys(url.searchParams, ["token", "region"])
      ? { kind: "invitation", token, region }
      : null;
  }
  if (url.hostname !== "auth" || url.pathname !== "/complete") return null;
  if (
    url.searchParams.has("connection")
    || url.searchParams.has("provider")
    || url.searchParams.has("status")
  ) return parseConnectorResult(url, target);
  return parseIdentityResult(url, target);
}
