import { clearAllDrafts as clearAllDraftsOnly } from '../../desktop/src/renderer/lib/draft-cache';
import { clearAllLocalCache } from '../../desktop/src/renderer/lib/local-cache';
import { ChevronRight, KeyRound, LoaderCircle, Mail } from "lucide-react";
import { Button, ConnectorMark, InlineError, RallyMark } from "@rally/ui/components/primitives";
import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { z } from "zod";
import { configuredRegions, ConfiguredRegionSchema, IDENTITY_REGION } from "@rally/contracts/regions";
import { BrowserGoogleStartedSchema, BrowserSessionSchema, BrowserWorkspacesSchema, EmailLoginStartedSchema, EmailLoginRedeemSchema, type BrowserSession } from "@rally/contracts/browser-session";
import { browserRequest, BrowserApiError } from "./transport";
import { scheduleSessionDeadline } from "./session-timer";
import { ScopeInvitationResultSchema, ScopeInvitationPreviewSchema, SharedNavigationDirectorySchema, type ScopeInvitationSummary } from "@rally/contracts/scope-grants";
import { invitationFromFragment, invitationTargetPath, type BrowserInvitation } from "./invitation";

import { parseSpaceLinkPathTarget, parseWorkstreamLinkPathTarget } from "@rally/contracts/workstream-links";

import { WorkspaceIdSchema } from "@rally/contracts";

const initialRegion = configuredRegions[0]!;

/** What a failed Google sign-in says, by the code the callback returned with. */
function googleSignInError(code: string): string {
  if (code === "google_oauth_denied") return "Google sign-in was cancelled.";
  if (code === "google_state_mismatch" || code === "invalid_oauth_state") return "That Google sign-in expired. Try again.";
  return "Google sign-in did not complete. Try again or use your email.";
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

/** An account change wipes drafts and, for the member shell, the transcript cache. */
async function clearAllDrafts(): Promise<void> {
  await Promise.all([clearAllDraftsOnly(), clearAllLocalCache()]);
}
type Proof = { region: string; challengeId: string; credential: string; redemptionId: string };

/** This entry has no account setup step. Collaboration mounts after authentication. */
export function BrowserEntry({ renderCollaboration }: { renderCollaboration?: (region: string, session: BrowserSession, onSignOut: () => void, onRevalidate: () => void) => ReactNode } = {}) {
  const [destination, setDestination] = useState<{ region: string; workspaceId: string } | null>(null);
  const [workspaceSession, setWorkspaceSession] = useState<BrowserSession | null>(null);
  const [region, setRegion] = useState(initialRegion);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; redemptionId: string } | null>(null);
  const [proof, setProof] = useState<Proof | null>(null);
  // Region resolved at parse time: the page opens an opaque link against the
  // deployment serving it, and an addressed link against the one it names.
  const [invitation, setInvitation] = useState<{ region: string; credential: BrowserInvitation["credential"] } | null>(null);
  // Sign-in belongs to Global, which holds the identity. An invitation names
  // the deployment it was issued by, and its sign-in stays there.
  const signInRegion = invitation?.region ?? IDENTITY_REGION;
  const [accepted, setAccepted] = useState<ScopeInvitationSummary | null>(null);
  const [acceptedSpaceIds, setAcceptedSpaceIds] = useState<Record<string, string>>({});
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [workspaces, setWorkspaces] = useState<ReturnType<typeof BrowserWorkspacesSchema.parse>["workspaces"]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error`, which the session read clears when it finds no session.
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);
  const issuance = useRef<{ email: string; id: string; redemptionId: string } | null>(null);
  const sessionRead = useRef(0);
  const sessionUser = useRef<string | null>(null);
  const renewalAt = useRef(Number.POSITIVE_INFINITY);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const refreshSession = useRef<((renew: boolean) => void) | null>(null);

  useEffect(() => {
    let active = true;
    const workspacePath = /^\/app\/workspaces\/([^/]+)\/([^/]+)\/?$/u.exec(location.pathname);
    const workspaceTarget = workspacePath ? z.object({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema })
      .safeParse({ region: workspacePath[1], workspaceId: workspacePath[2] }) : null;
    const parsedTarget = parseWorkstreamLinkPathTarget(location.pathname) ?? parseSpaceLinkPathTarget(location.pathname);
    const target = parsedTarget?.region && parsedTarget.workspaceId ? parsedTarget
      : workspaceTarget?.success ? workspaceTarget.data : null;
    if (target?.region && ConfiguredRegionSchema.safeParse(target.region).success) setDestination(target);
    const fragment = new URLSearchParams(location.hash.slice(1));
    const googleError = fragment.get("google_error");
    if (googleError) {
      history.replaceState(null, "", location.pathname);
      setGoogleNotice(googleSignInError(googleError));
    }
    const selectedRegion = ConfiguredRegionSchema.safeParse(target?.region ?? fragment.get("region") ?? initialRegion);
    const selected = selectedRegion.success ? selectedRegion.data : initialRegion;
    setRegion(selected);
    if (location.pathname === "/invite") {
      const incoming = invitationFromFragment(location.hash.slice(1));
      history.replaceState(null, "", location.pathname);
      if (incoming) {
        const addressed = { region: incoming.region ?? selected, credential: incoming.credential };
        setInvitation(addressed);
        // An opaque link names nobody, and the form under it has to. Asking for
        // the invited mailbox needs no session: the link is the same authority
        // acceptance will check, and this releases only the address it was sent to.
        void browserRequest(addressed.region, "/invitation", ScopeInvitationPreviewSchema, addressed.credential)
          .then((preview) => { if (active) setEmail((current) => current || preview.email); })
          // Only the server's own sentence about the invitation; a transport
          // failure is not evidence that the link is unusable.
          .catch((cause: unknown) => { if (active) setError(cause instanceof BrowserApiError ? cause.message : "Unable to open this invitation. Reload and try again."); });
      }
      else setError("This invitation link is incomplete. Reopen the link from your invitation email.");
    }
    const hasMagicProof = location.pathname === "/login/email" && fragment.has("token");
    if (hasMagicProof) {
      const input = EmailLoginRedeemSchema.safeParse({ challengeId: fragment.get("challenge"),
        redemptionId: crypto.randomUUID(), method: "magic", credential: fragment.get("token") });
      // Keep the proof only in this document's memory, never in history or storage.
      history.replaceState(null, "", location.pathname);
      if (input.success && selectedRegion.success) {
        setProof({ region: selected, ...input.data });
      } else setError("This sign-in link is invalid. Request another email.");
      setChecking(false);
    }
    let restoring: Promise<void> | null = null;
    let invalidated = false;
    let pendingRenewal = false;
    const restore = (renew = false) => {
      if (restoring) { pendingRenewal ||= renew; return; }
      const read = ++sessionRead.current;
      restoring = (async () => {
        // A deployment other than Global whose cookie has lapsed answers 401;
        // opening the workspace below activates it again through Global.
        if (renew) await browserRequest(selected, "/session/renew", BrowserSessionSchema, {}).catch((cause: unknown) => {
          if (!(target && selected !== IDENTITY_REGION && cause instanceof BrowserApiError && cause.status === 401)) throw cause;
        });
        const current = target
          ? await openWorkspace(selected, target.workspaceId)
          : await browserRequest(selected, "/session", BrowserSessionSchema);
        if (!active || read !== sessionRead.current) return;
        if (sessionUser.current && sessionUser.current !== current.user.id) await clearAllDrafts();
        if (!active || read !== sessionRead.current) return;
        sessionUser.current = current.user.id;
        setSession(current);
        setError(null);
        setAccepted((previous) => previous?.acceptedByUserId === current.user.id ? previous : null);
        if (!target) {
          const result = await browserRequest(selected, "/workspaces", BrowserWorkspacesSchema);
          if (active && read === sessionRead.current) setWorkspaces(result.workspaces);
        }
      })().catch((cause: unknown) => {
        if (!active || read !== sessionRead.current) return;
        if (cause instanceof BrowserApiError && (cause.status === 401 || cause.status === 403)) {
          void clearAllDrafts(); sessionUser.current = null;
          setSession(null); setWorkspaceSession(null); setWorkspaces([]); setAccepted(null);
          setError(cause.status === 403 ? cause.message : null);
        } else setError("Unable to restore your session. Try again.");
      }).finally(() => {
        restoring = null;
        if (active && (invalidated || pendingRenewal)) { const renewNext = pendingRenewal; invalidated = false; pendingRenewal = false; restore(renewNext); }
        else if (active && read === sessionRead.current) setChecking(false);
      });
    };
    if (!hasMagicProof) restore();
    // Magic links can sign in another tab. Returning to this invitation keeps
    // its in-memory proof and discovers the same-origin HttpOnly session.
    const resume = () => restore(Date.now() >= renewalAt.current);
    const visible = () => { if (document.visibilityState === "visible") resume(); };
    refreshSession.current = restore;
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", visible);
    // Broadcast only an invalidation. Each tab reads the authoritative cookie
    // session; credentials and invitation proofs never cross the channel. One
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

  async function redeem(input: { challengeId: string; redemptionId: string; method: "otp" | "magic"; credential: string }) {
    const current = await browserRequest(proof?.region ?? signInRegion, "/email/redeem", BrowserSessionSchema, input);
    const read = ++sessionRead.current;
    await clearAllDrafts();
    if (read !== sessionRead.current) return;
    setProof(null);
    sessionChannel.current?.postMessage("session-changed");
    // A destination in another deployment is opened from there, with its own
    // session and user id. Leave that to the restore path, which activates it
    // through Global, rather than showing this deployment's session first.
    if (destination && destination.region !== (proof?.region ?? signInRegion)) {
      refreshSession.current?.(false);
      return;
    }
    sessionUser.current = current.user.id;
    setSession(current);
    if (!destination) {
      const result = await browserRequest(proof?.region ?? signInRegion, "/workspaces", BrowserWorkspacesSchema);
      if (read === sessionRead.current) setWorkspaces(result.workspaces);
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
        await browserRequest(signInRegion, "/email/start", EmailLoginStartedSchema, { challengeId: next.id, email: normalizedEmail });
        setChallenge(next);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to continue. Please try again."); }
    finally { setBusy(false); }
  }

  async function continueWithGoogle() {
    if (busy) return;
    setBusy(true); setError(null); setGoogleNotice(null);
    try {
      const returnPath = location.pathname.startsWith("/app/") ? location.pathname : "/";
      const { url } = await browserRequest(IDENTITY_REGION, "/google/start", BrowserGoogleStartedSchema, { returnPath });
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
      setSession(null); setWorkspaces([]); setChallenge(null); setAccepted(null); setCode(""); issuance.current = null;
      sessionChannel.current?.postMessage("session-changed");
      if (unreached) setError("Signed out here, but a Rally deployment did not respond. Sign out again to finish.");
    } catch { setError("Unable to sign out. Please try again."); }
    finally { setBusy(false); }
  }

  // The member shell keys its session value, and so its sockets, on these.
  // Keep them stable across renders; each call reads the latest closure.
  const latestSignOut = useRef(signOut);
  useEffect(() => { latestSignOut.current = signOut; });
  const signOutStable = useCallback(() => { void latestSignOut.current(); }, []);
  const revalidate = useCallback(() => refreshSession.current?.(false), []);

  async function acceptInvitation() {
    if (!invitation || busy) return;
    const read = sessionRead.current;
    setBusy(true); setError(null);
    try {
      const result = await browserRequest(invitation.region, "/api/_/sharing/accept", ScopeInvitationResultSchema, invitation.credential);
      if (read !== sessionRead.current) return;
      const [target] = result.status === "accepted" ? result.invitation.targets : [];
      // The credential said nothing about where it pointed; acceptance is the
      // first answer, and the workspace to open comes from it rather than from
      // anything the recipient's link carried.
      if (result.status !== "accepted" || !target) throw new Error("This invitation is unavailable. Ask the sender for a new invitation.");
      await browserRequest(invitation.region, "/workspace/select", BrowserSessionSchema, { workspaceId: target.workspaceId });
      if (read !== sessionRead.current) return;
      const navigation = await browserRequest(invitation.region, `/api/${target.workspaceId}/sharing/navigation`, SharedNavigationDirectorySchema);
      const spaceIds = Object.fromEntries(result.invitation.targets.flatMap((entry) => {
        const space = navigation.spaces.filter((item) => item.workstreamIds.includes(entry.parentId))
          .sort((left, right) => Number(left.scope === 'personal') - Number(right.scope === 'personal') || left.id.localeCompare(right.id))[0];
        return space ? [[entry.parentId, space.id]] : [];
      }));
      setAcceptedSpaceIds(spaceIds);
      setAccepted(result.invitation);
      if (result.invitation.targets.length === 1) {
        location.assign(invitationTargetPath(location.origin, invitation.region, target, spaceIds[target.parentId]));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to accept this invitation. Please try again."); }
    finally { setBusy(false); }
  }

  if (!proof && destination && workspaceSession && session && workspaceSession.user.id === session.user.id && renderCollaboration) {
    return <div className="browser-shell">
      {error && <p role="alert">{error}</p>}
      <div className="browser-conversation">{renderCollaboration(destination.region, workspaceSession, signOutStable, revalidate)}</div>
    </div>;
  }

  if (checking && !session && !proof) return <main className="onboarding-shell entry"><div className="boot-mark" role="status" aria-label="Opening Rally"><RallyMark /></div></main>;

  const failure = error ?? (!session && !proof && !challenge ? googleNotice : null);
  return <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card" aria-busy={busy || checking}>
      <a className="entry-mark" href="/" aria-label="Rally"><RallyMark className="signin-mark" /></a>
      {session && !proof ? <>
        <h1>{accepted ? "You’re ready to collaborate" : invitation ? "Join the shared work" : "Your shared work"}</h1>
        <p className="signed-in-identity">Signed in as {session.user.email}</p>
        {accepted ? <nav className="signin-choice-list" aria-label="Shared conversations">{accepted.targets.map((target, index) =>
          <a className="signin-choice" key={`${target.parentId}:${target.kind}:${target.kind === "conversation" ? target.substreamId : ""}`} href={invitationTargetPath(location.origin, region, target, acceptedSpaceIds[target.parentId])}><span className="signin-choice-name">{target.kind === "workstream" ? "Open channel" : target.substreamId === "0" ? "Open main conversation" : `Open shared breakout${accepted.targets.length > 1 ? ` ${index + 1}` : ""}`}</span><ChevronRight aria-hidden="true" size={16} /></a>)}</nav>
          : invitation ? <><p className="entry-lead">Accept this invitation using the email address it was sent to.</p><Button className="button-primary signin-button" disabled={busy} onClick={() => { void acceptInvitation(); }}>{busy && <LoaderCircle aria-hidden="true" className="spin" size={16} />}{busy ? "Joining…" : "Accept invitation"}</Button></>
          : workspaces.length ? <nav className="signin-choice-list" aria-label="Organizations">{workspaces.map((workspace) =>
          <a className="signin-choice" key={workspace.id} href={`/app/workspaces/${workspace.region}/${workspace.id}`}><span aria-hidden="true" className="workspace-mark">{workspace.name.slice(0, 1).toLocaleUpperCase()}</span><span className="signin-choice-name">{workspace.name}</span><ChevronRight aria-hidden="true" size={16} /></a>)}</nav>
          : <p className="entry-lead">Open the invitation you received to join a shared conversation.</p>}
        <button className="text-button onboarding-signout" disabled={busy} onClick={() => { void signOut(); }} type="button">Sign out</button>
      </> : <>
        <h1>{proof ? "Confirm your sign-in" : challenge ? "Check your email" : "Welcome to Rally"}</h1>
        <p>{proof ? "Continue to your shared conversations." : challenge ? `Enter the code sent to ${email}, or open the sign-in link in that email.` : invitation ? "Sign in with the email address that received this invitation." : "Your team, your work, and Rally. All in one place."}</p>
        <form onSubmit={(event) => { void submit(event); }}>
          {!proof && (challenge ? <label className="onboarding-field"><span>Sign-in code</span><span className="onboarding-input-wrap"><KeyRound aria-hidden="true" size={16} /><input key="otp" autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={(event) => setCode(event.target.value)} /></span></label>
            : <label className="onboarding-field"><span>Email</span><span className="onboarding-input-wrap"><Mail aria-hidden="true" size={16} /><input key="email" type="email" autoComplete="email" placeholder="you@company.com" required value={email} onChange={(event) => setEmail(event.target.value)} /></span></label>)}
          <Button className="button-primary signin-button" disabled={busy || checking} type="submit">{busy && <LoaderCircle aria-hidden="true" className="spin" size={16} />}{busy ? "Please wait…" : proof || challenge ? "Continue" : "Email me a sign-in link"}</Button>
          {challenge && <button className="text-button onboarding-signout" type="button" disabled={busy} onClick={() => { issuance.current = null; setChallenge(null); setCode(""); setError(null); }}>Use another email or request a new code</button>}
        </form>
        {/* Leaving for Google would drop an invitation held only in this page's memory. */}
        {!proof && !challenge && !invitation && <Button className="button-secondary signin-button" type="button" disabled={busy || checking} onClick={() => { void continueWithGoogle(); }}><ConnectorMark mark="google" />Continue with Google</Button>}
      </>}
      {/* A Google failure belongs to the signed-out screen it returned to, not to a later one. */}
      {failure && <InlineError>{failure}</InlineError>}
    </section>
  </main>;
}
