import { uuidV7 } from '../../desktop/src/renderer/lib/telemetry';
import { clearAllDrafts as clearAllDraftsOnly } from '../../desktop/src/renderer/lib/draft-cache';
import { clearAllLocalCache } from '../../desktop/src/renderer/lib/local-cache';
import { iosStandalone } from '../../desktop/src/renderer/lib/home-screen';
import { CreateOrganizationCard, type CreateOrganizationOperation } from '../../desktop/src/renderer/screens/create-organization';
import { Building2, ChevronRight, KeyRound, LoaderCircle, Mail } from "lucide-react";
import { ActivityCountBadge, Button, ConnectorMark, ErrorNotice, RallyMark, activityCountLabel } from "@rally/ui/components/primitives";
import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { z } from "zod";
import { configuredRegions, ConfiguredRegionSchema, IDENTITY_REGION } from "@rally/contracts/regions";
import { BrowserGoogleStartedSchema, BrowserSessionSchema, BrowserWorkspaceAttentionSchema, BrowserWorkspaceCreatedSchema, BrowserWorkspacesSchema, EmailLoginStartedSchema, EmailLoginRedeemSchema, type BrowserSession } from "@rally/contracts/browser-session";
import { browserRequest, BrowserApiError } from "./transport";
import { scheduleSessionDeadline } from "./session-timer";

import { isRetiredLinkPath, parseLinkPathTarget } from "@rally/contracts/links";

import { UuidV7Schema } from "@rally/contracts/telemetry";
import { OrganizationNameSuggestionSchema, WorkspaceIdSchema, parseArtifactSiteOpenPath } from "@rally/contracts";
import { SiteOpening } from "./site-open";

const initialRegion = configuredRegions[0]!;

/** What a failed Google sign-in says, by the code the callback returned with. */
function googleSignInError(code: string): string {
  if (code === "google_oauth_denied") return "Google sign-in was cancelled.";
  if (code === "google_state_mismatch" || code === "invalid_oauth_state") return "That Google sign-in expired. Try again.";
  return "Google sign-in did not complete. Try again or use your email.";
}

/** Older strict start schemas reject the new optional analytics field before
 * any proof is created. Only that validation rejection gets a legacy retry. */
async function signupStart<T>(path: '/google/start' | '/email/start', schema: z.ZodType<T>, body: Record<string, unknown>): Promise<T> {
  try { return await browserRequest(IDENTITY_REGION, path, schema, body); }
  catch (error) {
    if (!(error instanceof BrowserApiError) || error.status !== 400 || error.code !== 'invalid_request') throw error;
    const legacyBody = { ...body };
    delete legacyBody.signupFlowId;
    return browserRequest(IDENTITY_REGION, path, schema, legacyBody);
  }
}

/**
 * Opens a workspace in its own deployment. A deployment other than Global
 * that holds no cookie for this browser yet answers 401; Global then opens the
 * workspace there, setting that deployment's cookie, and the select is retried
 * once. See the full browser client PRD's design.md.
 */
async function openWorkspace(region: string, workspaceId: string): Promise<BrowserSession> {
  const select = () => browserRequest(region, "/workspace/select", BrowserSessionSchema, { workspaceId });
  try { return await select(); }
  catch (cause) {
    if (region === IDENTITY_REGION || !(cause instanceof BrowserApiError && cause.status === 401)) throw cause;
  }
  await browserRequest(IDENTITY_REGION, "/workspace/activate", z.undefined(), { region, workspaceId });
  return await select();
}

/** An account change wipes drafts and the transcript cache the shell keeps. */
async function clearAllDrafts(): Promise<void> {
  await Promise.all([clearAllDraftsOnly(), clearAllLocalCache()]);
}
type Proof = { region: string; challengeId: string; credential: string; redemptionId: string };

/**
 * The one screen the browser shows while Rally opens: restoring a session,
 * opening an organization, and downloading the signed-in shell. Each step
 * draws the same mark in the same place, so the hand-off between them is
 * invisible.
 */

/** What the entry screen says for a link to something deleted with Channels and Threads. */
const RETIRED_LINK_COPY = "This link is to something that no longer exists. Rally replaced Channels, Threads and Breakouts with Canvases.";

export function BrowserBoot(): React.JSX.Element {
  return <main className="onboarding-shell entry"><div className="boot-mark" role="status" aria-label="Opening Rally"><RallyMark /></div></main>;
}

const SIGNUP_FLOW_STORAGE_KEY = 'rally-browser-signup-flow';

function savedSignupFlow(): string | null {
  try {
    const parsed = UuidV7Schema.safeParse(sessionStorage.getItem(SIGNUP_FLOW_STORAGE_KEY));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function rememberSignupFlow(flowId: string | null): void {
  try {
    if (flowId) sessionStorage.setItem(SIGNUP_FLOW_STORAGE_KEY, flowId);
    else sessionStorage.removeItem(SIGNUP_FLOW_STORAGE_KEY);
  } catch { /* Storage may be disabled; sign-in still works. */ }
}

/** This entry has no account setup step. Collaboration mounts after authentication. */
export function BrowserEntry({ renderCollaboration }: { renderCollaboration?: (region: string, session: BrowserSession, onSignOut: () => void, onRevalidate: () => void) => ReactNode } = {}) {
  const signupFlow = useRef<string | null>(null);
  const signupViewed = useRef(false);
  if (signupFlow.current === null) {
    const entryUrl = new URL(location.href);
    const incoming = UuidV7Schema.safeParse(entryUrl.searchParams.get('signupFlowId'));
    signupFlow.current = incoming.success ? incoming.data : savedSignupFlow() ?? uuidV7();
  }
  useEffect(() => {
    rememberSignupFlow(signupFlow.current);
    const entryUrl = new URL(location.href);
    if (entryUrl.searchParams.has('signupFlowId')) {
      entryUrl.searchParams.delete('signupFlowId');
      history.replaceState(history.state, '', entryUrl.href);
    }
  }, []);
  const [destination, setDestination] = useState<{ region: string; workspaceId: string } | null>(null);
  // A Space, Channel, Breakout or Thread link, opened here directly rather
  // than through the site's handoff page: nothing it named is left to open.
  const [retiredLink] = useState(() => isRetiredLinkPath(location.pathname));
  // A protected site sent the person here to sign in and come back to it.
  const [siteTarget] = useState(() => {
    const target = parseArtifactSiteOpenPath(location.pathname);
    return target && ConfiguredRegionSchema.safeParse(target.region).success ? target : null;
  });
  // What the restore path opens: the address the page loaded with, or an
  // organization opened in place since, which a later focus then restores.
  const destinationRef = useRef<{ region: string; workspaceId: string } | null>(null);
  const [workspaceSession, setWorkspaceSession] = useState<BrowserSession | null>(null);
  const [region, setRegion] = useState(initialRegion);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; redemptionId: string } | null>(null);
  // The signed-out screen leads with Google and opens the email form on request.
  const [emailChosen, setEmailChosen] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const [session, setSession] = useState<BrowserSession | null>(null);
  // Null until the list has loaded, so a fresh sign-in never says nothing was
  // shared before the server has answered.
  // With the deployment it was read from, so its counts come from the same one.
  const [listed, setListed] = useState<{ region: string; workspaces: ReturnType<typeof BrowserWorkspacesSchema.parse>["workspaces"] } | null>(null);
  const workspaces = listed?.workspaces ?? null;
  // Each listed organization's activity count, by region and id, with the
  // account that read it, so another account's counts are never drawn.
  const [activity, setActivity] = useState<{ userId: string; counts: ReadonlyMap<string, number> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error`, which the session read clears when it finds no session.
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);
  // Whether the person asked to create an organization from the empty list.
  const [creating, setCreating] = useState(false);
  // Read from the email domain's homepage. The card opens without waiting for
  // it and fills the name only while the person has not typed one.
  const [suggestedName, setSuggestedName] = useState<string | null>(null);
  const suggestionUserId = session?.user.id ?? null;
  useEffect(() => {
    setSuggestedName(null);
    if (!creating || !suggestionUserId) return;
    let current = true;
    browserRequest(IDENTITY_REGION, "/api/_/onboarding/organization-suggestion", OrganizationNameSuggestionSchema)
      .then((suggestion) => { if (current) setSuggestedName(suggestion.name); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [creating, suggestionUserId]);
  // A create in flight keeps going if the card goes away, so Back waits for it,
  // and the operation id outlives the card so a retry returns the same one.
  const [createPending, setCreatePending] = useState(false);
  const createOperation = useRef<CreateOrganizationOperation>(null);
  const issuance = useRef<{ email: string; id: string; redemptionId: string } | null>(null);
  const sessionRead = useRef(0);
  const sessionUser = useRef<string | null>(null);
  const renewalAt = useRef(Number.POSITIVE_INFINITY);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const refreshSession = useRef<((renew: boolean) => void) | null>(null);
  // A later signed-out screen starts from the Google-first choice again.
  useEffect(() => { if (session) setEmailChosen(false); }, [session]);
  useEffect(() => {
    const userId = session?.user.id;
    if (!userId || !listed?.workspaces.length) return;
    let current = true;
    browserRequest(listed.region, "/workspaces/attention", BrowserWorkspaceAttentionSchema).then((result) => {
      if (current) setActivity({ userId, counts: new Map(result.attention.map((item) => [`${item.region}:${item.workspaceId}`, item.attention.readerAttentionCount])) });
    }, () => { if (current) setActivity(null); });
    return () => { current = false; };
  }, [session?.user.id, listed]);

  useEffect(() => {
    let active = true;
    const workspacePath = /^\/app\/workspaces\/([^/]+)\/([^/]+)\/?$/u.exec(location.pathname);
    const workspaceTarget = workspacePath ? z.object({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema })
      .safeParse({ region: workspacePath[1], workspaceId: workspacePath[2] }) : null;
    const target = parseLinkPathTarget(location.pathname) ?? (workspaceTarget?.success ? workspaceTarget.data : null);
    if (target?.region && ConfiguredRegionSchema.safeParse(target.region).success) setDestination(target);
    const fragment = new URLSearchParams(location.hash.slice(1));
    const googleError = fragment.get("google_error");
    if (googleError) {
      history.replaceState(null, "", location.pathname);
      setGoogleNotice(googleSignInError(googleError));
    }
    const selectedRegion = ConfiguredRegionSchema.safeParse(target?.region ?? fragment.get("region") ?? initialRegion);
    const selected = selectedRegion.success ? selectedRegion.data : initialRegion;
    if (target) destinationRef.current = { region: selected, workspaceId: target.workspaceId };
    setRegion(selected);
    // Invitation emails once linked here with a token. A share no longer needs
    // one: signing in with its address claims it, so this is a sign-in page.
    if (location.pathname === "/invite") history.replaceState(null, "", "/");
    // A sign-in started from a shared link is emailed back to that link's path.
    const hasMagicProof = (location.pathname === "/login/email" || location.pathname.startsWith("/app/")) && fragment.has("token");
    if (hasMagicProof) {
      const input = EmailLoginRedeemSchema.safeParse({ challengeId: fragment.get("challenge"),
        redemptionId: crypto.randomUUID(), method: "magic", credential: fragment.get("token") });
      // Keep the proof only in this document's memory, never in history or storage.
      history.replaceState(null, "", location.pathname);
      // The challenge lives where it was issued, which the link names, not
      // the region of the resource a shared path points at.
      const proofRegion = ConfiguredRegionSchema.safeParse(fragment.get("region"));
      if (input.success && proofRegion.success) {
        setProof({ region: proofRegion.data, ...input.data });
      } else setError("This sign-in link is invalid. Request another email.");
      setChecking(false);
    }
    let restoring: Promise<void> | null = null;
    let invalidated = false;
    let pendingRenewal = false;
    const restore = (renew = false) => {
      if (restoring) { pendingRenewal ||= renew; return; }
      const read = ++sessionRead.current;
      const opened = destinationRef.current;
      const openedRegion = opened?.region ?? selected;
      restoring = (async () => {
        // A deployment other than Global whose cookie has lapsed answers 401;
        // opening the workspace below activates it again through Global.
        if (renew) await browserRequest(openedRegion, "/session/renew", BrowserSessionSchema, {}).catch((cause: unknown) => {
          if (!(opened && openedRegion !== IDENTITY_REGION && cause instanceof BrowserApiError && cause.status === 401)) throw cause;
        });
        const current = opened
          ? await openWorkspace(openedRegion, opened.workspaceId)
          : await browserRequest(selected, "/session", BrowserSessionSchema);
        if (!active || read !== sessionRead.current) return;
        if (sessionUser.current && sessionUser.current !== current.user.id) {
          // Another account, from this tab or another, starts from its own list.
          setCreating(false); createOperation.current = null;
          await clearAllDrafts();
        }
        if (!active || read !== sessionRead.current) return;
        sessionUser.current = current.user.id;
        rememberSignupFlow(null);
        setSession(current);
        setError(null);
        if (!opened) {
          const result = await browserRequest(selected, "/workspaces", BrowserWorkspacesSchema);
          if (active && read === sessionRead.current) setListed({ region: selected, workspaces: result.workspaces });
        }
      })().catch((cause: unknown) => {
        if (!active || read !== sessionRead.current) return;
        if (cause instanceof BrowserApiError && (cause.status === 401 || cause.status === 403)) {
          void clearAllDrafts(); sessionUser.current = null;
          setSession(null); setWorkspaceSession(null); setListed(null);
          setError(cause.status === 403 ? cause.message : null);
        } else setError("Unable to restore your session. Try again.");
      }).finally(() => {
        restoring = null;
        if (active && (invalidated || pendingRenewal)) { const renewNext = pendingRenewal; invalidated = false; pendingRenewal = false; restore(renewNext); }
        else if (active && read === sessionRead.current) setChecking(false);
      });
    };
    if (!hasMagicProof) restore();
    // Magic links can sign in another tab. Returning here discovers the
    // same-origin HttpOnly session.
    const resume = () => restore(Date.now() >= renewalAt.current);
    const visible = () => { if (document.visibilityState === "visible") resume(); };
    refreshSession.current = restore;
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", visible);
    // Broadcast only an invalidation. Each tab reads the authoritative cookie
    // session; credentials and sign-in proofs never cross the channel. One
    // channel for every deployment, since sign-out reaches all of them.
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("rally-browser-session");
    sessionChannel.current = channel;
    if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "session-changed") {
        ++sessionRead.current;
        if (restoring) invalidated = true;
        else restore();
      }
    };
    return () => {
      active = false;
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", visible);
      refreshSession.current = null;
      channel?.close();
      if (sessionChannel.current === channel) sessionChannel.current = null;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const expiry = Date.parse(session.expiresAt);
    // Renew halfway through the remaining server-issued lifetime, leaving time
    // to recover via focus/online after a network failure. This is scheduling,
    // not a new lifetime policy. An unchanged expiry (the absolute ceiling)
    // does not rerun this effect or create a renewal loop.
    renewalAt.current = Date.now() + Math.max(0, expiry - Date.now()) / 2;
    const cancelRenewal = scheduleSessionDeadline(renewalAt.current, () => {
      if (document.visibilityState === "visible") refreshSession.current?.(true);
    });
    const cancelExpiry = scheduleSessionDeadline(expiry, () => {
      // The server decides expiry: another tab may have extended the cookie,
      // and this device's clock may differ from the server's clock.
      refreshSession.current?.(false);
    });
    return () => { cancelRenewal(); cancelExpiry(); };
  }, [session?.expiresAt, session?.user.id, region]);

  useEffect(() => {
    if (!session || !destination) { setWorkspaceSession(null); return; }
    if (session.workspace?.id === destination.workspaceId && session.workspace.region === destination.region) {
      setWorkspaceSession(session);
      return;
    }
    let active = true;
    void openWorkspace(destination.region, destination.workspaceId)
      .then((selected) => {
        if (selected.user.id !== session.user.id || selected.workspace?.id !== destination.workspaceId) throw new Error("The organization session changed. Reload this page.");
        if (active) setWorkspaceSession(selected);
      }).catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof BrowserApiError && (cause.status === 401 || cause.status === 403)) setWorkspaceSession(null);
        setError(cause instanceof Error ? cause.message : "Unable to open this organization.");
      });
    return () => { active = false; };
  // A root-session refresh must also revalidate the workspace relationship,
  // including promotion or removal of the same user. Keep the mounted feed
  // during the request so a routine focus does not discard an unsent draft.
  }, [destination, session]);

  useEffect(() => {
    if (checking || session || proof || challenge || signupViewed.current) return;
    signupViewed.current = true;
    void browserRequest(IDENTITY_REGION, '/signup/view', z.undefined(), { flowId: signupFlow.current }).catch(() => undefined);
  }, [checking, session, proof, challenge]);

  async function redeem(input: { challengeId: string; redemptionId: string; method: "otp" | "magic"; credential: string }) {
    const current = await browserRequest(proof?.region ?? IDENTITY_REGION, "/email/redeem", BrowserSessionSchema, input);
    const read = ++sessionRead.current;
    await clearAllDrafts();
    if (read !== sessionRead.current) return;
    setProof(null);
    sessionChannel.current?.postMessage("session-changed");
    // A destination in another deployment is opened from there, with its own
    // session and user id. Leave that to the restore path, which activates it
    // through Global, rather than showing this deployment's session first.
    if (destination && destination.region !== (proof?.region ?? IDENTITY_REGION)) {
      // The opening screen covers the restore; the spent code's card must not.
      setChecking(true);
      refreshSession.current?.(false);
      return;
    }
    sessionUser.current = current.user.id;
    rememberSignupFlow(null);
    setSession(current);
    if (!destination) {
      const listRegion = proof?.region ?? IDENTITY_REGION;
      const result = await browserRequest(listRegion, "/workspaces", BrowserWorkspacesSchema);
      if (read === sessionRead.current) setListed({ region: listRegion, workspaces: result.workspaces });
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setGoogleNotice(null);
    try {
      if (proof) await redeem({ challengeId: proof.challengeId, redemptionId: proof.redemptionId, credential: proof.credential, method: "magic" });
      else if (challenge) await redeem({ challengeId: challenge.id, redemptionId: challenge.redemptionId, method: "otp", credential: code.trim() });
      else {
        const normalizedEmail = email.trim().toLowerCase();
        const next = issuance.current?.email === normalizedEmail ? issuance.current
          : { email: normalizedEmail, id: crypto.randomUUID(), redemptionId: crypto.randomUUID() };
        issuance.current = next;
        const returnPath = location.pathname.startsWith("/app/") ? { returnPath: location.pathname } : {};
        await signupStart("/email/start", EmailLoginStartedSchema, { challengeId: next.id, email: normalizedEmail, signupFlowId: signupFlow.current, ...returnPath });
        setChallenge(next);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to continue. Please try again."); }
    finally { setBusy(false); }
  }

  /** The card owns the operation id, so a retry of the same name returns the same organization. */
  async function createOrganization(name: string, operationId: string): Promise<void> {
    setCreatePending(true);
    let created;
    try { created = await browserRequest(IDENTITY_REGION, "/workspace/create", BrowserWorkspaceCreatedSchema, { name: name.trim(), operationId }); }
    catch (cause) { setCreatePending(false); throw cause; }
    // The new organization opens as any other does, and its setup continues
    // there, but in this document: navigating to it downloaded and booted the
    // page again only to read back the session this one already holds. The
    // address is replaced rather than pushed because nothing here answers
    // Back, and the shell reads the organization's address before its router.
    const opened = { region: created.region, workspaceId: created.workspaceId };
    history.replaceState(null, "", `/app/workspaces/${opened.region}/${opened.workspaceId}`);
    destinationRef.current = opened;
    // The list read before the creation said "none". Left in place, a select
    // that then fails would offer Create again and make a second organization.
    setListed(null);
    createOperation.current = null;
    setCreatePending(false);
    setCreating(false);
    setDestination(opened);
  }

  async function continueWithGoogle() {
    if (busy) return;
    setBusy(true); setError(null); setGoogleNotice(null);
    try {
      const returnPath = location.pathname.startsWith("/app/") ? location.pathname : "/";
      const { url } = await signupStart("/google/start", BrowserGoogleStartedSchema, { returnPath, signupFlowId: signupFlow.current });
      location.assign(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start Google sign-in. Try again.");
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true); setError(null);
    try {
      // Each deployment holds its own cookie, and a past sign-in may have left
      // one in any of them. A deployment this host cannot reach (404) has none.
      const results = await Promise.allSettled(configuredRegions.map((target) => browserRequest(target, "/logout", z.undefined(), {})));
      const unreached = results.some((result) => result.status === "rejected"
        && !(result.reason instanceof BrowserApiError && result.reason.status === 404));
      const read = ++sessionRead.current;
      await clearAllDrafts();
      if (read !== sessionRead.current) return;
      sessionUser.current = null;
      signupFlow.current = uuidV7();
      rememberSignupFlow(signupFlow.current);
      signupViewed.current = false;
      setSession(null); setListed(null); setCreating(false); setChallenge(null); setCode(""); issuance.current = null;
      sessionChannel.current?.postMessage("session-changed");
      if (unreached) setError("Signed out here, but a Rally deployment did not respond. Sign out again to finish.");
    } catch { setError("Unable to sign out. Please try again."); }
    finally { setBusy(false); }
  }

  // The shell keys its session value, and so its sockets, on these.
  // Keep them stable across renders; each call reads the latest closure.
  const latestSignOut = useRef(signOut);
  useEffect(() => { latestSignOut.current = signOut; });
  const signOutStable = useCallback(() => { void latestSignOut.current(); }, []);
  const revalidate = useCallback(() => refreshSession.current?.(false), []);

  if (!proof && destination && workspaceSession && session && workspaceSession.user.id === session.user.id && renderCollaboration) {
    return <div className="browser-shell">
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="browser-conversation">{renderCollaboration(destination.region, workspaceSession, signOutStable, revalidate)}</div>
    </div>;
  }

  if (checking && !session && !proof) return <BrowserBoot />;
  if (!proof && siteTarget && session) {
    return <SiteOpening key={session.user.id} region={siteTarget.region} hostnameStub={siteTarget.hostnameStub} returnPath={siteTarget.returnPath}
      openWorkspace={openWorkspace} onSignOut={signOutStable} />;
  }
  // A signed-in link to an organization is still opening it; the signed-in
  // card would show an empty organization list until it does. `busy` is an
  // action on that card, such as sign-out, which also clears `error`. A
  // workspace session for another user is the old account's, still pending.
  if (!proof && destination && session && workspaceSession?.user.id !== session.user.id && !error && !busy && renderCollaboration) return <BrowserBoot />;

  if (creating && session && !proof) {
    return <main className="onboarding-shell workspace-setup-shell entry">
      <CreateOrganizationCard onCreate={createOrganization} operation={createOperation} suggestedName={suggestedName}>
        <p className="signed-in-identity">Signed in as {session.user.email}</p>
        <button className="text-button onboarding-signout" type="button" disabled={createPending} onClick={() => setCreating(false)}>Back</button>
      </CreateOrganizationCard>
    </main>;
  }

  const failure = error ?? (!session && !proof && !challenge ? googleNotice : null);
  return <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card" aria-busy={busy || checking}>
      <a className="entry-mark" href="/" aria-label="Rally"><RallyMark className="signin-mark" /></a>
      {session && !proof ? <>
        <h1>Your organizations</h1>
        <p className="signed-in-identity">Signed in as {session.user.email}</p>
        {retiredLink && <p className="entry-lead" role="status">{RETIRED_LINK_COPY}</p>}
        {workspaces === null ? <p className="entry-lead" role="status">{destination ? "Opening the link…" : "Loading your organizations…"}</p>
          : workspaces.length ? <nav className="signin-choice-list" aria-label="Organizations">{workspaces.map((workspace) => {
            const count = activity?.userId === session.user.id ? activity.counts.get(`${workspace.region}:${workspace.id}`) ?? 0 : 0;
            return <a aria-label={count > 0 ? `${workspace.name}, ${activityCountLabel(count)}` : undefined} className="signin-choice" key={workspace.id} href={`/app/workspaces/${workspace.region}/${workspace.id}`}><span aria-hidden="true" className="workspace-mark">{workspace.name.slice(0, 1).toLocaleUpperCase()}</span><span className="signin-choice-name">{workspace.name}</span><ActivityCountBadge count={count} /><ChevronRight aria-hidden="true" size={16} /></a>;
          })}</nav>
          : <>
            <p className="entry-lead">{session.user.email} is not part of an organization, and nothing has been shared with it yet.</p>
            <p className="entry-lead">Ask a teammate to share a Canvas or a Sidekick with you, or create a new organization.</p>
            <Button className="button-primary signin-button" type="button" disabled={busy} onClick={() => { setError(null); setCreating(true); }}><Building2 aria-hidden="true" size={16} />Create an organization</Button>
          </>}
        <button className="text-button onboarding-signout" disabled={busy} onClick={() => { void signOut(); }} type="button">Sign out</button>
      </> : <>
        <h1>{proof ? "Confirm your sign-in" : challenge ? "Check your email" : "Welcome to Rally"}</h1>
        <p>{proof ? "Continue to what was shared with you." : challenge ? iosStandalone() ? `Enter the code sent to ${email}.` : `Enter the code sent to ${email}, or open the sign-in link in that email.` : destination ? "Sign in with the email address the link was sent to." : siteTarget ? "Sign in to open this site." : retiredLink ? RETIRED_LINK_COPY : "Your team, your work, and Rally. All in one place."}</p>
        {!proof && !challenge && !emailChosen ? <>
          <Button className="button-primary signin-button" type="button" disabled={busy || checking} onClick={() => { void continueWithGoogle(); }}><ConnectorMark mark="google" />Continue with Google</Button>
          <Button className="button-secondary signin-button" type="button" disabled={busy || checking} onClick={() => setEmailChosen(true)}><Mail aria-hidden="true" size={16} />Continue with email</Button>
        </> : <form onSubmit={(event) => { void submit(event); }}>
          {!proof && (challenge ? <label className="onboarding-field"><span>Sign-in code</span><span className="onboarding-input-wrap"><KeyRound aria-hidden="true" size={16} /><input key="otp" autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={(event) => setCode(event.target.value)} /></span></label>
            : <label className="onboarding-field"><span>Email</span><span className="onboarding-input-wrap"><Mail aria-hidden="true" size={16} /><input key="email" type="email" autoComplete="email" placeholder="you@company.com" required value={email} onChange={(event) => setEmail(event.target.value)} /></span></label>)}
          <Button className="button-primary signin-button" disabled={busy || checking} type="submit">{busy && <LoaderCircle aria-hidden="true" className="spin" size={16} />}{busy ? "Please wait…" : proof || challenge ? "Continue" : "Email me a sign-in link"}</Button>
          {challenge && <button className="text-button onboarding-signout" type="button" disabled={busy} onClick={() => { issuance.current = null; setChallenge(null); setCode(""); setError(null); }}>Use another email or request a new code</button>}
          {!proof && !challenge && <button className="text-button onboarding-signout" type="button" disabled={busy} onClick={() => { setEmailChosen(false); setError(null); }}>Other sign-in options</button>}
        </form>}
      </>}
      {/* A Google failure belongs to the signed-out screen it returned to, not to a later one. */}
      {failure && <ErrorNotice>{failure}</ErrorNotice>}
    </section>
  </main>;
}
