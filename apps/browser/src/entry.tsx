import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { z } from "zod";
import { configuredRegions, ConfiguredRegionSchema } from "@rally/contracts/regions";
import { BrowserSessionSchema, BrowserWorkspacesSchema, EmailLoginStartedSchema, EmailLoginRedeemSchema, type BrowserSession } from "@rally/contracts/browser-session";
import { browserRequest, BrowserApiError } from "./transport";
import { scheduleSessionDeadline } from "./session-timer";
import { ScopeInvitationResultSchema, type ScopeInvitationSummary } from "@rally/contracts/scope-grants";
import { invitationFromFragment, invitationTargetPath, type BrowserInvitation } from "./invitation";

import { parseWorkstreamLinkPathTarget } from "@rally/contracts/workstream-links";

import { WorkspaceIdSchema } from "@rally/contracts";

const initialRegion = configuredRegions[0]!;
type Proof = { region: string; challengeId: string; credential: string; redemptionId: string };

/** This entry has no account setup step. Collaboration mounts after authentication. */
export function BrowserEntry({ renderCollaboration }: { renderCollaboration?: (region: string, session: BrowserSession, onSignOut: () => void) => ReactNode } = {}) {
  const [destination, setDestination] = useState<{ region: string; workspaceId: string } | null>(null);
  const [workspaceSession, setWorkspaceSession] = useState<BrowserSession | null>(null);
  const [region, setRegion] = useState(initialRegion);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; redemptionId: string } | null>(null);
  const [proof, setProof] = useState<Proof | null>(null);
  const [invitation, setInvitation] = useState<BrowserInvitation | null>(null);
  const [accepted, setAccepted] = useState<ScopeInvitationSummary | null>(null);
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [workspaces, setWorkspaces] = useState<ReturnType<typeof BrowserWorkspacesSchema.parse>["workspaces"]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const issuance = useRef<{ email: string; id: string; redemptionId: string } | null>(null);
  const sessionRead = useRef(0);
  const renewalAt = useRef(Number.POSITIVE_INFINITY);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const refreshSession = useRef<((renew: boolean) => void) | null>(null);

  useEffect(() => {
    let active = true;
    const workspacePath = /^\/app\/workspaces\/([^/]+)\/([^/]+)\/?$/u.exec(location.pathname);
    const workspaceTarget = workspacePath ? z.object({ region: ConfiguredRegionSchema, workspaceId: WorkspaceIdSchema })
      .safeParse({ region: workspacePath[1], workspaceId: workspacePath[2] }) : null;
    const target = parseWorkstreamLinkPathTarget(location.pathname)
      ?? (workspaceTarget?.success ? workspaceTarget.data : null);
    if (target?.region && ConfiguredRegionSchema.safeParse(target.region).success) setDestination(target);
    const fragment = new URLSearchParams(location.hash.slice(1));
    const selectedRegion = ConfiguredRegionSchema.safeParse(target?.region ?? fragment.get("region") ?? initialRegion);
    const selected = selectedRegion.success ? selectedRegion.data : initialRegion;
    setRegion(selected);
    if (location.pathname === "/invite") {
      const incoming = invitationFromFragment(fragment);
      history.replaceState(null, "", location.pathname);
      if (incoming) setInvitation(incoming);
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
    const restore = (renew = false) => {
      if (restoring) return;
      const read = ++sessionRead.current;
      restoring = (async () => {
        if (renew) await browserRequest(selected, "/session/renew", BrowserSessionSchema, {});
        const current = target
          ? await browserRequest(selected, "/workspace/select", BrowserSessionSchema, { workspaceId: target.workspaceId })
          : await browserRequest(selected, "/session", BrowserSessionSchema);
        if (!active || read !== sessionRead.current) return;
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
          setSession(null); setWorkspaceSession(null); setWorkspaces([]); setAccepted(null);
          setError(cause.status === 403 ? cause.message : null);
        } else setError("Unable to restore your session. Try again.");
      }).finally(() => {
        restoring = null;
        if (active && invalidated) { invalidated = false; restore(); }
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
    // session; credentials and invitation proofs never cross the channel.
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`rally-browser-session:${selected}`);
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
    void browserRequest(destination.region, "/workspace/select", BrowserSessionSchema, { workspaceId: destination.workspaceId })
      .then((selected) => {
        if (selected.user.id !== session.user.id || selected.workspace?.id !== destination.workspaceId) throw new Error("The workspace session changed. Reload this page.");
        if (active) setWorkspaceSession(selected);
      }).catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof BrowserApiError && (cause.status === 401 || cause.status === 403)) setWorkspaceSession(null);
        setError(cause instanceof Error ? cause.message : "Unable to open this workspace.");
      });
    return () => { active = false; };
  // A root-session refresh must also revalidate the workspace relationship,
  // including promotion or removal of the same user. Keep the mounted feed
  // during the request so a routine focus does not discard an unsent draft.
  }, [destination, session]);

  async function redeem(input: { challengeId: string; redemptionId: string; method: "otp" | "magic"; credential: string }) {
    const current = await browserRequest(region, "/email/redeem", BrowserSessionSchema, input);
    ++sessionRead.current;
    setSession(current);
    setProof(null);
    sessionChannel.current?.postMessage("session-changed");
    if (!destination) {
      const result = await browserRequest(region, "/workspaces", BrowserWorkspacesSchema);
      setWorkspaces(result.workspaces);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (proof) await redeem({ challengeId: proof.challengeId, redemptionId: proof.redemptionId, credential: proof.credential, method: "magic" });
      else if (challenge) await redeem({ challengeId: challenge.id, redemptionId: challenge.redemptionId, method: "otp", credential: code.trim() });
      else {
        const normalizedEmail = email.trim().toLowerCase();
        const next = issuance.current?.email === normalizedEmail ? issuance.current
          : { email: normalizedEmail, id: crypto.randomUUID(), redemptionId: crypto.randomUUID() };
        issuance.current = next;
        await browserRequest(region, "/email/start", EmailLoginStartedSchema, { challengeId: next.id, email: normalizedEmail });
        setChallenge(next);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to continue. Please try again."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setError(null);
    try {
      await browserRequest(region, "/logout", z.undefined(), {});
      ++sessionRead.current;
      setSession(null); setWorkspaces([]); setChallenge(null); setAccepted(null); setCode(""); issuance.current = null;
      sessionChannel.current?.postMessage("session-changed");
    } catch { setError("Unable to sign out. Please try again."); }
    finally { setBusy(false); }
  }

  async function acceptInvitation() {
    if (!invitation || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await browserRequest(invitation.region, "/api/_/sharing/accept", ScopeInvitationResultSchema, invitation.request);
      if (result.status !== "accepted") throw new Error("This invitation is unavailable. Ask the sender for a new invitation.");
      await browserRequest(invitation.region, "/workspace/select", BrowserSessionSchema, { workspaceId: invitation.request.workspaceId });
      setAccepted(result.invitation);
      const [target] = result.invitation.targets;
      if (result.invitation.targets.length === 1 && target) {
        location.assign(invitationTargetPath(location.origin, invitation.region, target));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to accept this invitation. Please try again."); }
    finally { setBusy(false); }
  }

  if (destination && workspaceSession && session && workspaceSession.user.id === session.user.id && renderCollaboration) {
    return <div className="browser-shell">
      {error && <p role="alert">{error}</p>}
      <div className="browser-conversation">{renderCollaboration(destination.region, workspaceSession, () => { void signOut(); })}</div>
    </div>;
  }

  if (checking && !session && !proof) return <main className="entry" aria-busy="true"><p role="status">Opening Rally…</p></main>;

  return <main className="entry"><a className="wordmark" href="/">Rally</a>
    <section className="entry-card" aria-busy={busy || checking}>
      {session ? <>
        <h1>{accepted ? "You’re ready to collaborate" : invitation ? "Join the shared work" : "Your shared work"}</h1><p>Signed in as {session.user.email}</p>
        {accepted ? <nav aria-label="Shared conversations">{accepted.targets.map((target, index) =>
          <a className="workspace-link" key={`${target.parentId}:${target.kind}:${target.kind === "conversation" ? target.substreamId : ""}`} href={invitationTargetPath(location.origin, region, target)}>{target.kind === "workstream" ? "Open work stream" : target.substreamId === "0" ? "Open main conversation" : `Open shared substream${accepted.targets.length > 1 ? ` ${index + 1}` : ""}`}<span aria-hidden="true">→</span></a>)}</nav>
          : invitation ? <><p>Accept this invitation using the email address it was sent to.</p><button disabled={busy} onClick={() => { void acceptInvitation(); }}>{busy ? "Joining…" : "Accept invitation"}</button></>
          : workspaces.length ? <nav aria-label="Workspaces">{workspaces.map((workspace) =>
          <a className="workspace-link" key={workspace.id} href={`/app/workspaces/${region}/${workspace.id}`}>{workspace.name}<span aria-hidden="true">→</span></a>)}</nav>
          : <p>Open the invitation you received to join a shared conversation.</p>}
        <button className="secondary" disabled={busy} onClick={() => { void signOut(); }}>Sign out</button>
      </> : <>
        <h1>{proof ? "Confirm your sign-in" : challenge ? "Check your email" : "Welcome to Rally"}</h1>
        <p>{proof ? "Continue to your shared conversations." : challenge ? `Enter the code sent to ${email}, or open the sign-in link in that email.` : invitation ? "Sign in with the email address that received this invitation." : "Sign in to collaborate with your team."}</p>
        <form onSubmit={(event) => { void submit(event); }}>
          {!proof && (challenge ? <label>Sign-in code<input key="otp" autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={(event) => setCode(event.target.value)} /></label>
            : <label>Email<input key="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>)}
          <button disabled={busy || checking} type="submit">{busy ? "Please wait…" : proof || challenge ? "Continue" : "Email me a sign-in link"}</button>
          {challenge && <button className="secondary" type="button" disabled={busy} onClick={() => { issuance.current = null; setChallenge(null); setCode(""); setError(null); }}>Use another email or request a new code</button>}
        </form>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  </main>;
}
