import type { Session, SidelineCatalog, SidelineSendRequest, SidelineSendResponse } from "@rally/contracts";

export interface SidelineSession {
  user: Session["user"];
  workspace: NonNullable<Session["workspace"]>;
}

export type SidelineSendResult =
  | { ok: true; response: SidelineSendResponse }
  | { ok: false; outcome: "rejected" | "unknown"; message: string };

/** Only responses that prove admission never succeeded may start a new logical retry. */
export function sidelineHttpOutcome(status: number): "rejected" | "unknown" {
  return status >= 400 && status < 500 && status !== 408 ? "rejected" : "unknown";
}

export interface SidelineBridge {
  getSession(): Promise<SidelineSession | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  catalog(): Promise<SidelineCatalog>;
  send(input: SidelineSendRequest): Promise<SidelineSendResult>;
  openInRally(input: { workstreamId: string; substreamId: string }): Promise<void>;
  onSessionChanged(listener: (session: SidelineSession | null) => void): () => void;
  /** Somebody in the catalog joined or left a Channel or Breakout, or the socket reconnected. */
  onCatalogStale(listener: () => void): () => void;
}

declare global {
  interface Window { sideline: SidelineBridge; }
}
