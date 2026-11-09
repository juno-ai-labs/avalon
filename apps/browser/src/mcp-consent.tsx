import { ChevronRight, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";

import { Button, ErrorNotice, RallyMark } from "@rally/ui/components/primitives";
import { BrowserSessionSchema, BrowserWorkspacesSchema, type BrowserSession } from "@rally/contracts/browser-session";
import {
  McpAuthorizationDescriptionSchema,
  McpAuthorizationRedirectSchema,
  McpAuthorizationRequestSchema,
  type McpAuthorizationDescription,
  type McpAuthorizationRequest,
} from "@rally/contracts/mcp-oauth";
import { IDENTITY_REGION } from "@rally/contracts/regions";

import { BrowserEntry } from "./entry";
import { BrowserApiError, browserRequest } from "./transport";

/** The consent page's path; the MCP server's metadata names it as the authorization endpoint. */
export const MCP_CONSENT_PATH = "/app/oauth/authorize";

/**
 * Where the authorization request waits while the person signs in. Sign-in
 * returns to this path but drops its query (a Google return keeps only the
 * path, and an emailed link opens in a new tab), so the request is kept here
 * and read back. It holds nothing secret: the client id, its redirect, the
 * PKCE challenge and the client's state, all of which were in the URL.
 */
const PENDING_KEY = "rally-mcp-authorization";

/**
 * The authorization request this page was opened with: none, one it can act
 * on, or one it cannot (a `plain` PKCE challenge, a missing redirect).
 */
type PendingRequest =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; request: McpAuthorizationRequest };

function readQuery(): McpAuthorizationRequest | "invalid" | null {
  const query = new URLSearchParams(location.search);
  if (!query.has("client_id")) return null;
  const parsed = McpAuthorizationRequestSchema.safeParse({
    clientId: query.get("client_id"), redirectUri: query.get("redirect_uri"),
    codeChallenge: query.get("code_challenge"), codeChallengeMethod: query.get("code_challenge_method"),
    ...(query.get("state") !== null ? { state: query.get("state") } : {}),
    ...(query.get("resource") !== null ? { resource: query.get("resource") } : {}),
    ...(query.get("scope") !== null ? { scope: query.get("scope") } : {}),
  });
  return parsed.success && query.get("response_type") === "code" ? parsed.data : "invalid";
}

/**
 * The request in the URL, or, only when the URL names no client at all (the
 * return from sign-in), the one kept before sign-in. A URL that names a
 * client but cannot be read never falls back to the kept one: that would ask
 * the person to approve a different client than the one that sent them here.
 */
function pendingRequest(): PendingRequest {
  const fromQuery = readQuery();
  if (fromQuery === "invalid") {
    forgetRequest();
    return { kind: "invalid" };
  }
  try {
    if (fromQuery) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(fromQuery));
      return { kind: "valid", request: fromQuery };
    }
    const stored = McpAuthorizationRequestSchema.safeParse(JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null"));
    return stored.success ? { kind: "valid", request: stored.data } : { kind: "none" };
  } catch {
    return fromQuery ? { kind: "valid", request: fromQuery } : { kind: "none" };
  }
}

function forgetRequest() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* nothing kept */ }
}

type Workspaces = z.infer<typeof BrowserWorkspacesSchema>["workspaces"];

/**
 * The name the API registers a client under when it gave none
 * (`McpOAuthService.register` in `apps/api/src/services/mcp-oauth-service.ts`),
 * which this page shows as "An app" rather than as if it were a name.
 */
const UNNAMED_CLIENT = "MCP client";

/** The name a client gave itself when it registered, or null when it gave none. Rally has not verified it. */
function declaredName(clientName: string): string | null {
  const name = clientName.trim();
  return name === "" || name === UNNAMED_CLIENT ? null : name;
}

/**
 * Rally's MCP consent page: an MCP client (Claude, ChatGPT) asked to act in
 * Rally as this person. Signed out, it is the ordinary sign-in; signed in, it
 * names the client and where it will return, asks which Organization it may
 * use, and approves or declines. `docs/rally-mcp.md#consent`.
 */
export function McpConsent(): React.JSX.Element {
  const [pending] = useState(pendingRequest);
  const request = pending.kind === "valid" ? pending.request : null;
  const [session, setSession] = useState<BrowserSession | null | undefined>(undefined);
  const [client, setClient] = useState<McpAuthorizationDescription | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspaces | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readSession = useCallback(() => {
    browserRequest(IDENTITY_REGION, "/session", BrowserSessionSchema).then(setSession, (failure: unknown) => {
      if (failure instanceof BrowserApiError && failure.status === 401) setSession(null);
      else setError(failure instanceof Error ? failure.message : "Unable to continue. Please try again.");
    });
  }, []);

  useEffect(() => {
    readSession();
    // The sign-in below announces a session change on this channel.
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("rally-browser-session");
    if (channel) channel.onmessage = () => readSession();
    return () => channel?.close();
  }, [readSession]);

  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId || !request) return;
    let current = true;
    const query = new URLSearchParams(Object.entries(request).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    Promise.all([
      browserRequest(IDENTITY_REGION, `/oauth/authorization?${query}`, McpAuthorizationDescriptionSchema),
      browserRequest(IDENTITY_REGION, "/workspaces", BrowserWorkspacesSchema),
    ]).then(([described, listed]) => {
      if (!current) return;
      // A grant is a session in the identity deployment, so only its
      // Organizations can be chosen here.
      const local = listed.workspaces.filter((workspace) => workspace.region === IDENTITY_REGION);
      setClient(described);
      setWorkspaces(local);
      setWorkspaceId(local[0]?.id ?? null);
    }, (failure: unknown) => {
      if (!current) return;
      // Rally refused the request itself (an unknown client, a redirect it
      // never registered): it will not become approvable, so it is not kept
      // for the next visit.
      if (failure instanceof BrowserApiError && failure.status >= 400 && failure.status < 500) forgetRequest();
      setError(failure instanceof Error ? failure.message : "This request could not be read.");
    });
    return () => { current = false; };
  }, [userId, request]);

  async function decide(approve: boolean) {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const { redirectUrl } = approve && workspaceId
        ? await browserRequest(IDENTITY_REGION, "/oauth/approve", McpAuthorizationRedirectSchema, { ...request, workspaceId })
        : await browserRequest(IDENTITY_REGION, "/oauth/deny", McpAuthorizationRedirectSchema, request);
      forgetRequest();
      location.assign(redirectUrl);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to continue. Please try again.");
      setBusy(false);
    }
  }

  if (pending.kind === "invalid") {
    return <ConsentCard title="This connection request is not valid">
      <p className="entry-lead">The app that sent you here asked in a way Rally does not accept, so there is nothing to approve. Start the connection from that app again, or ask its maker to update it.</p>
      <div className="signin-choice-list"><a className="signin-choice" href="/"><span className="signin-choice-name">Return to Rally</span><ChevronRight aria-hidden="true" size={16} /></a></div>
    </ConsentCard>;
  }
  if (session === null) return <BrowserEntry />;
  if (session === undefined && error) {
    return <ConsentCard title="Connect to Rally">
      <p className="entry-lead">Rally could not check whether you are signed in, so this connection cannot continue yet.</p>
      <ErrorNotice>{error}</ErrorNotice>
      <Button className="button-primary signin-button" type="button" onClick={() => { setError(null); readSession(); }}>Try again</Button>
    </ConsentCard>;
  }
  if (!request) {
    return <ConsentCard title="Nothing to approve">
      <p className="entry-lead">This page opens when an app such as Claude or ChatGPT asks to connect to Rally. Start the connection from that app again.</p>
      <div className="signin-choice-list"><a className="signin-choice" href="/"><span className="signin-choice-name">Return to Rally</span><ChevronRight aria-hidden="true" size={16} /></a></div>
    </ConsentCard>;
  }
  if (session === undefined || (!client && !error)) {
    return <ConsentCard title="Connect to Rally"><p className="entry-lead" role="status">Loading…</p></ConsentCard>;
  }
  const name = client ? declaredName(client.clientName) : null;
  const title = !client ? "Connect to Rally"
    : name ? `Allow an app that calls itself \u201c${name}\u201d to use Rally?` : "Allow an app to use Rally?";
  return <ConsentCard title={title}>
    {client && session && <>
      <p className="entry-lead">The app will be able to read, create, change and share the Canvases you can open in the Organization you choose, acting as {session.user.email}. It can do only what you can.</p>
      <p className="signed-in-identity">{name ? "Rally has not verified the name the app gave itself. " : ""}You will return to {client.redirectOrigin}</p>
      {workspaces && workspaces.length > 0 ? <fieldset className="signin-choice-list">
        <legend className="mb-2 text-[length:var(--av-sys-font-size-meta)] text-[color:var(--av-sys-color-text-subtle)]">Organization</legend>
        {workspaces.map((workspace) => <label className="signin-choice" key={workspace.id}>
          <input type="radio" name="workspace" checked={workspaceId === workspace.id} onChange={() => setWorkspaceId(workspace.id)} />
          <span aria-hidden="true" className="workspace-mark">{workspace.name.slice(0, 1).toLocaleUpperCase()}</span>
          <span className="signin-choice-name">{workspace.name}</span>
        </label>)}
      </fieldset> : <p className="entry-lead">{session.user.email} is not part of an Organization in Rally yet, so there is nothing to connect.</p>}
      <Button className="button-primary signin-button" type="button" disabled={busy || !workspaceId} onClick={() => { void decide(true); }}>
        {busy && <LoaderCircle aria-hidden="true" className="spin" size={16} />}Allow
      </Button>
      <Button className="button-secondary signin-button" type="button" disabled={busy} onClick={() => { void decide(false); }}>Deny</Button>
    </>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
  </ConsentCard>;
}

function ConsentCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card">
      <a className="entry-mark" href="/" aria-label="Rally"><RallyMark className="signin-mark" /></a>
      <h1>{title}</h1>
      {children}
    </section>
  </main>;
}
