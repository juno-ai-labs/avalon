import { useCallback, useEffect, useState } from "react";
import { SidelineSendRequestSchema, type SidelineCatalog } from "@rally/contracts";
import {
  SidelineComposer,
  type SidelineCardModel,
} from "@rally/ui/components/sideline-composer";

import type { SidelineSession } from "../common/bridge";

function newCard(): SidelineCardModel {
  return {
    id: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    representedUserId: "",
    workstreamId: "",
    substreamId: "0",
    message: "",
    state: "idle",
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Sideline could not complete the request";
}

function isOffline(error: unknown): boolean {
  return !navigator.onLine || (error instanceof Error && error.message.includes("SIDELINE_OFFLINE"));
}

export default function App(): React.JSX.Element {
  const [session, setSession] = useState<SidelineSession | null>(null);
  const [catalog, setCatalog] = useState<SidelineCatalog | null>(null);
  const [cards, setCards] = useState<SidelineCardModel[]>([newCard()]);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "denied" | "offline" | "error">("loading");
  const [statusMessage, setStatusMessage] = useState<string>();

  const load = useCallback(async () => {
    if (!session) return;
    setStatus("loading");
    try {
      const next = await window.sideline.catalog();
      setCatalog(next);
      setStatus(next.participants.length ? "ready" : "empty");
      setStatusMessage(next.participants.length ? undefined : "This Organization has no eligible participant.");
    } catch (error) {
      const offline = isOffline(error);
      setStatus(offline ? "offline" : "error");
      setStatusMessage(offline ? "Sideline is offline. Drafts remain available." : messageOf(error));
    }
  }, [session]);

  useEffect(() => {
    void window.sideline.getSession().then(setSession);
    return window.sideline.onSessionChanged((next) => {
      setSession(next);
      setCatalog(null);
      setCards([newCard()]);
    });
  }, []);
  useEffect(() => { if (session) void load(); else setStatus("denied"); }, [load, session]);
  useEffect(() => {
    const offline = (): void => setStatus("offline");
    const online = (): void => { if (session) void load(); };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); };
  }, [load, session]);

  if (!session) {
    return (
      <main className="sideline-shell">
        <header className="sideline-header"><div><div className="sideline-kicker">Sideline</div><h1>Represented messaging</h1><p>Sign in with your Rally identity to continue.</p></div></header>
        <section className="sideline-notice sideline-notice-denied">
          <span>Sideline requires an active internal operator session.</span>
          <button className="button button-primary" type="button" onClick={() => void window.sideline.signIn()}>Sign in with Google</button>
        </section>
      </main>
    );
  }

  const change = (cardId: string, patch: Partial<SidelineCardModel>): void => {
    setCards((current) => current.map((card) => {
      if (card.id !== cardId) return card;
      const changesLogicalSend = (
        (patch.message !== undefined && patch.message !== card.message)
        || (patch.representedUserId !== undefined && patch.representedUserId !== card.representedUserId)
        || (patch.workstreamId !== undefined && patch.workstreamId !== card.workstreamId)
        || (patch.substreamId !== undefined && patch.substreamId !== card.substreamId)
      );
      return { ...card, ...patch, ...(changesLogicalSend ? { idempotencyKey: crypto.randomUUID() } : {}) };
    }));
  };

  const send = async (cardId: string): Promise<void> => {
    const card = cards.find((item) => item.id === cardId);
    if (!card || card.state === "sending") return;
    const idempotencyKey = card.state === "failed" ? crypto.randomUUID() : card.idempotencyKey;
    change(cardId, { state: "sending", result: undefined, idempotencyKey });
    const request = SidelineSendRequestSchema.parse({
      representedUserId: card.representedUserId,
      workstreamId: card.workstreamId,
      substreamId: card.substreamId,
      message: card.message,
      idempotencyKey,
      app: { name: "Sideline", version: "0.1.0", authMechanism: "rally_session" },
    });
    try {
      const result = await window.sideline.send(request);
      if (result.ok) {
        change(cardId, { state: "sent", result: `Sent · ${result.response.messageId}` });
      } else {
        change(cardId, {
          state: result.outcome === "unknown" ? "unknown" : "failed",
          result: result.message,
        });
      }
    } catch {
      change(cardId, {
        state: "unknown",
        result: "Send outcome unknown. Retry uses the same send key.",
      });
    }
  };

  return (
    <SidelineComposer
      catalog={catalog}
      workspaceName={session.workspace.name}
      operatorName={session.user.name}
      cards={cards}
      status={status}
      statusMessage={statusMessage}
      onAdd={() => setCards((current) => [...current, newCard()])}
      onRemove={(cardId) => setCards((current) => current.filter((card) => card.id !== cardId))}
      onChange={change}
      onSend={(cardId) => void send(cardId)}
      onRetryCatalog={() => void load()}
      onOpenInRally={(cardId) => {
        const card = cards.find((item) => item.id === cardId);
        if (card) void window.sideline.openInRally({ workstreamId: card.workstreamId, substreamId: card.substreamId });
      }}
      onSignOut={() => void window.sideline.signOut()}
    />
  );
}
