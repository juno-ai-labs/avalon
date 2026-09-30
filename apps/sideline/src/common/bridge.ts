import type { Session, SidelineCatalog, SidelineSendRequest, SidelineSendResponse } from "@rally/contracts";

export interface SidelineSession {
  user: Session["user"];
  workspace: NonNullable<Session["workspace"]>;
}

export interface SidelineOrganization {
  id: string;
  name: string;
}

/** How a switch ended: moved, refused by the Organization, or overtaken by a sign-out or another switch. */
export type SidelineOrganizationSwitch = "switched" | "not_admitted" | "superseded";

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
  /** Every Organization the signed-in person belongs to. */
  organizations(): Promise<SidelineOrganization[]>;
  /** Rejects only when the switch could not be attempted (offline, a server failure). */
  switchOrganization(workspaceId: string): Promise<SidelineOrganizationSwitch>;
  /** The update version waiting to install on restart, or null. */
  getDownloadedUpdate(): Promise<string | null>;
  onUpdateDownloaded(listener: (version: string) => void): () => void;
  installDownloadedUpdate(): Promise<void>;
  /** Somebody in the catalog joined or left a Channel or Breakout, or the socket reconnected. */
  onCatalogStale(listener: () => void): () => void;
}

declare global {
  interface Window { sideline: SidelineBridge; }
}
